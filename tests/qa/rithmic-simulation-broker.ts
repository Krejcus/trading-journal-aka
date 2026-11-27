import { commandStatus } from '../../services/rithmic/rithmicCommandStatus';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createFakeRithmicServer, type FakeOrder } from '../_fakeRithmicServer';
import { RithmicAccountRegistry, type RithmicAccountRegistryEntry } from '../../services/rithmic/rithmicAccountRegistry';
import { createRithmicBroker } from '../../services/rithmic/rithmicBroker';
import { memoryProtectionStore } from '../../services/rithmic/rithmicProtection';
import { LocalExec } from '../../services/rithmic/localExec';
import { RithmicCandleBuilder } from '../../services/rithmic/rithmicCandleBuilder';
import { createOrderFlowFeed } from '../../services/rithmic/orderFlowFeed';
import { createDeviceGateway, type DeviceStore } from '../../services/rithmic/deviceGateway';
import { scopeProblem, type DeviceRegistryState, type DeviceScope } from '../../services/rithmic/devicePairing';

const symbol = 'MNQZ6';
const path = '/local-simulation';
const minute = 60_000;

// Synthetic, repeatable prices. The only broker socket factory below is the in-memory test server.
function priceAt(at: number) {
  const seconds = at / 1000;
  return Math.round((25_000 + 20 * Math.sin(seconds / 55) + 4 * Math.sin(seconds / 9)) * 4) / 4;
}
function executable(order: FakeOrder, mark: number) {
  if (order.priceType === 2) return true;
  if (order.priceType === 4 && order.triggerPrice !== undefined) return order.side === 1 ? mark >= order.triggerPrice : mark <= order.triggerPrice;
  return order.priceType === 1 && order.price !== undefined && (order.side === 1 ? mark <= order.price : mark >= order.price);
}
export async function attachSimulation(http: Server, port: number) {
  let price = priceAt(Date.now());
  const market = createFakeRithmicServer({ accounts: ['LOCAL-SIM'], exitPrice: () => price, nowSeconds: () => Math.floor(Date.now() / 1000) });
  let entries: RithmicAccountRegistryEntry[] = [];
  let revision = 0;
  const registry = new RithmicAccountRegistry({
    load: async () => ({ entries, revision }),
    save: async (next, expected) => {
      if (expected !== revision) throw new Error('Account registry changed');
      entries = next;
      revision++;
    },
  });
  await registry.load();
  const broker = createRithmicBroker({
    url: 'wss://simulation.invalid', credentials: { user: 'simulation', password: 'secret', systemName: 'Rithmic Test', appName: 'AlphaTrade Simulation', appVersion: '1' },
    socketFactory: market.socketFactory, registry, protectionStore: memoryProtectionStore(),
    onIncident: incident => exec.onIncident(incident),
  });
  const candles = new RithmicCandleBuilder();
  let limits: Awaited<ReturnType<typeof broker.readQuantityLimits>> = null;
  const exec = new LocalExec({
    broker, symbols: { [symbol]: { tickSize: 0.25 } }, systemName: 'Rithmic Test', allowedSystems: ['Rithmic Test'],
    maxQuantity: 2_147_483_647, quantityLimits: () => limits, serverPrice: () => price, serverQuote: () => ({ bid: price - 0.25, ask: price + 0.25 }),
    // RITHMIC_SIM_TEST_FEATURES=1 zapne i to, co skutečný spouštěč povoluje jen na Rithmic Test.
    ...(process.env.RITHMIC_SIM_TEST_FEATURES === '1' ? { pendingAdd: true, entrySplit: true, multiPairSwap: true, maxProtectedParts: 20, bareAdd: true, multiEntry: true } : { multiManage: true }),
  });
  exec.attach();
  // Samočinné zápisy (zrušení čekajícího přikoupení po zavření pozice) — stejně jako skutečný spouštěč mimo režim jen pro čtení.
  exec.enableAutomation();
  await broker.start();
  limits = await broker.readQuantityLimits(broker.accountIds()[0], 'MNQ');
  const ws = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const send = (client: WebSocket, data: unknown) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  };
  const served = new Set<WebSocket>();
  const broadcast = (message: unknown) => { for (const client of served) send(client, message); };
  http.on('upgrade', (req, socket, head) => {
    if (![path, path + '?drop=1', path + '?drop=cancel'].includes(req.url ?? '')) return;
    if (req.headers.origin !== `http://127.0.0.1:${port}` && req.headers.origin !== `http://localhost:${port}`) { socket.destroy(); return; }
    ws.handleUpgrade(req, socket, head, client => ws.emit('connection', client, req));
  });
  // Order flow jako ve skutečné službě (stejný modul), s umělými obchody pro NQ i MNQ: opakovatelná „náhoda“
  // z času, občas velký příkaz rozdělený do dílčích obchodů se stejným číslem příkazu agresora.
  const orderFlow = createOrderFlowFeed({ sources: { NQ: 'NQZ6', MNQ: symbol }, tickSize: 0.25, log: (line) => console.log(`[simulace] ${line}`) });
  let flowOrder = 0;
  const noise = (seed: number) => { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); };
  function flow(at: number, previous: number) {
    for (const [contract, base, bigFrom] of [['NQZ6', 4, 25], [symbol, 8, 120]] as const) {
      const seed = Math.floor(at / 250) + (contract === symbol ? 7_919 : 0);
      const drift = price - previous;
      const count = 1 + Math.floor(noise(seed) * 4);
      for (let i = 0; i < count; i += 1) {
        const r = noise(seed * 3.1 + i * 17.3);
        const buy = noise(seed * 5.7 + i) < 0.5 + Math.max(-0.3, Math.min(0.3, drift * 0.4));
        const big = noise(seed * 9.1 + i * 3) > 0.985;
        const total = big ? Math.round(bigFrom * (1 + noise(seed + i) * 5)) : 1 + Math.floor(r * r * base);
        const fills = big ? 2 + Math.floor(noise(seed * 2 + i) * 5) : 1;
        const id = `sim-${flowOrder += 1}`;
        const tradePrice = price + (buy ? 0.25 : 0) + Math.round((noise(seed * 1.3 + i) - 0.5) * 6) * 0.25;
        let left = total;
        for (let fill = 0; fill < fills && left > 0; fill += 1) {
          const size = fill === fills - 1 ? left : Math.max(1, Math.floor(left / (fills - fill)));
          left -= size;
          orderFlow.onTick({ symbol: contract, exchange: 'CME', kind: 'trade', tradePrice: tradePrice + (buy ? fill : -fill) * 0.25, tradeSize: size, bidPrice: null, askPrice: null,
            exchangeAt: at, gatewayAt: at, receivedAt: at, isSnapshot: false, aggressor: buy ? 'buy' : 'sell', aggressorOrderId: id });
        }
      }
    }
  }
  function record(at: number) {
    const previous = price;
    price = priceAt(at);
    candles.onTick({ symbol, exchange: 'CME', kind: 'trade', tradePrice: price, tradeSize: 1, bidPrice: null, askPrice: null,
      exchangeAt: at, gatewayAt: at, receivedAt: at, isSnapshot: false });
    flow(at, previous);
  }
  const now = Date.now();
  orderFlow.feedOpened(Math.floor(now / minute) * minute - 361 * minute);
  for (let at = Math.floor(now / minute) * minute - 360 * minute; at < now; at += 10_000) record(at);
  record(now);
  // Brána pro spárovaná zařízení jako ve skutečné službě (stejný modul), na vlastním portu vedle stránky:
  // tak jde v prohlížeči vyzkoušet párování kódem, přihlášení klíčem i rozsah oprávnění — bez brokera.
  let devices: DeviceRegistryState = { devices: [] };
  const deviceStore: DeviceStore = { load: () => devices, save: (next) => { devices = structuredClone(next); } };
  const devicePort = port + 1;
  const gateway = createDeviceGateway<WebSocket>({
    store: deviceStore, origins: new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'capacitor://localhost']),
    serve: (client, device) => serve(client, { scope: device.scope, local: false, dropOp: null }),
    log: (text) => console.log(`[simulace · zařízení] ${text}`),
  });
  const deviceServer = new WebSocketServer({ host: '127.0.0.1', port: devicePort, maxPayload: 16 * 1024, verifyClient: (info: { origin?: string }) => gateway.verify(info.origin) });
  deviceServer.on('connection', (client) => gateway.accept(client));
  ws.on('connection', (client, request) => {
    serve(client, { scope: 'full', local: true, dropOp: request.url === path + '?drop=1' ? 'entry' : request.url === path + '?drop=cancel' ? 'cancel' : null });
  });
  function serve(client: WebSocket, access: { scope: DeviceScope; local: boolean; dropOp: string | null }) {
    let dropOp = access.dropOp;
    served.add(client);
    client.on('close', () => { served.delete(client); orderFlow.drop(client); });
    const current = candles.current(symbol, Date.now());
    send(client, { type: 'hello', orderFlow: orderFlow.capability(), system: 'Rithmic Test', account: 'LOCAL-SIM', limits, readOnly: false, live: false, symbol, tickSize: 0.25, pointValue: 2, feed: true, price, bars: [...candles.finished(symbol), ...(current ? [current] : [])] });
    send(client, { type: 'state', state: exec.state() });
    client.on('message', async raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.orderFlow !== undefined && !message.command) {
        const problem = orderFlow.handle(client, message.orderFlow);
        if (problem) send(client, { type: 'of-error', message: problem });
        return;
      }
      if (!message?.command || typeof message.id !== 'string') return;
      if (message.command.op === 'lookup') {
        const result = await commandStatus(broker, message.command, symbol).catch(() => null);
        send(client, { type: 'reply', id: message.id, ok: true, result });
        return;
      }
      // Stejná pravidla jako skutečná služba: správa zařízení jen místně, rozsah zařízení, incident jen z Macu.
      try {
        if (['pair-start', 'devices', 'revoke-device'].includes(message.command.op)) {
          if (!access.local) throw new Error('správa zařízení jde jen z Macu, kde služba běží');
          send(client, { type: 'reply', id: message.id, ok: true, result: gateway.manage(message.command) });
          return;
        }
        const denied = scopeProblem(access.scope, message.command.op);
        if (denied) throw new Error(denied);
        if (message.command.op === 'ack' && !access.local) throw new Error('incident jde potvrdit jen na Macu, kde služba běží — z telefonu jde pozici zavřít');
      } catch (error) {
        send(client, { type: 'reply', id: message.id, ok: false, sent: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const reply = await exec.execute(message.command);
      if (dropOp === message.command.op && reply.ok) { dropOp = null; client.terminate(); return; }
      send(client, { type: 'reply', id: message.id, ...reply });
    });
    client.on('error', () => client.terminate());
  }
  const unsubscribe = exec.subscribe(state => broadcast({ type: 'state', state }));
  const ticks = setInterval(() => {
    const at = Date.now();
    record(at);
    for (const order of [...market.orders.values()]) {
      if (order.status === 'open' && executable(order, price)) market.fill(order.basketId, price);
    }
    broadcast({ type: 'tick', symbol, price, bar: candles.current(symbol, at), at });
  }, 250);
  // Realizovaný P&L simulace: součet zavřených obchodů z posledního stavu (jen zobrazení v liště). Ne `exec.state()`:
  // to zvyšuje pořadové číslo stavu.
  let lastCloses: ReadonlyArray<{ pointsTotal: number }> = [];
  const unsubscribeCloses = exec.subscribe(state => { lastCloses = state.closes; });
  const simClosed = () => Math.round(lastCloses.reduce((sum, close) => sum + close.pointsTotal * 2, 0) * 100) / 100;
  const beats = setInterval(() => broadcast({ type: 'beat', feed: true, at: Date.now(), pnl: { closed: simClosed(), at: Date.now() } }), 1000);
  http.once('close', () => {
    clearInterval(ticks); clearInterval(beats); orderFlow.stop(); unsubscribe(); unsubscribeCloses(); exec.detach(); broker.stop(); ws.close(); deviceServer.close();
  });
}
