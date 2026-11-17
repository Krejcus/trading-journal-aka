import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createFakeRithmicServer, type FakeOrder } from '../_fakeRithmicServer';
import { RithmicAccountRegistry, type RithmicAccountRegistryEntry } from '../../services/rithmic/rithmicAccountRegistry';
import { createRithmicBroker } from '../../services/rithmic/rithmicBroker';
import { memoryProtectionStore } from '../../services/rithmic/rithmicProtection';
import { LocalExec } from '../../services/rithmic/localExec';
import { RithmicCandleBuilder } from '../../services/rithmic/rithmicCandleBuilder';

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
  const market = createFakeRithmicServer({ accounts: ['LOCAL-SIM'], exitPrice: () => price });
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
  const exec = new LocalExec({
    broker, symbols: { [symbol]: { tickSize: 0.25 } }, systemName: 'Rithmic Test', allowedSystems: ['Rithmic Test'],
    maxQuantity: 2, maxPosition: 2, serverPrice: () => price, serverQuote: () => ({ bid: price - 0.25, ask: price + 0.25 }),
  });
  exec.attach();
  await broker.start();
  const ws = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const send = (client: WebSocket, data: unknown) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  };
  const broadcast = (message: unknown) => { for (const client of ws.clients) send(client, message); };
  http.on('upgrade', (req, socket, head) => {
    if (req.url !== path) return;
    if (req.headers.origin !== `http://127.0.0.1:${port}` && req.headers.origin !== `http://localhost:${port}`) { socket.destroy(); return; }
    ws.handleUpgrade(req, socket, head, client => ws.emit('connection', client));
  });
  function record(at: number) {
    price = priceAt(at);
    candles.onTick({ symbol, exchange: 'CME', kind: 'trade', tradePrice: price, tradeSize: 1, bidPrice: null, askPrice: null,
      exchangeAt: at, gatewayAt: at, receivedAt: at, isSnapshot: false });
  }
  const now = Date.now();
  for (let at = Math.floor(now / minute) * minute - 360 * minute; at < now; at += 10_000) record(at);
  record(now);
  ws.on('connection', client => {
    const current = candles.current(symbol, Date.now());
    send(client, { type: 'hello', system: 'Rithmic Test', readOnly: false, live: false, symbol, tickSize: 0.25, pointValue: 2, feed: true, price, bars: [...candles.finished(symbol), ...(current ? [current] : [])] });
    send(client, { type: 'state', state: exec.state() });
    client.on('message', async raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message?.command || typeof message.id !== 'string') return;
      const reply = await exec.execute(message.command);
      send(client, { type: 'reply', id: message.id, ...reply });
    });
    client.on('error', () => client.terminate());
  });
  const unsubscribe = exec.subscribe(state => broadcast({ type: 'state', state }));
  const ticks = setInterval(() => {
    const at = Date.now();
    record(at);
    for (const order of [...market.orders.values()]) {
      if (order.status === 'open' && executable(order, price)) market.fill(order.basketId, price);
    }
    broadcast({ type: 'tick', symbol, price, bar: candles.current(symbol, at), at });
  }, 250);
  const beats = setInterval(() => broadcast({ type: 'beat', feed: true, at: Date.now() }), 1000);
  http.once('close', () => {
    clearInterval(ticks); clearInterval(beats); unsubscribe(); exec.detach(); broker.stop(); ws.close();
  });
}
