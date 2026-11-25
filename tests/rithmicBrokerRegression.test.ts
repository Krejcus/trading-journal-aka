/**
 * Regresní testy adaptéru podle nálezů copier-design-critic a Codexu k prvnímu diffu
 * (16. 11. 2026): závody snímku s živými notifikacemi, chybějící exekuce, obnova spojení,
 * životní cyklus adaptéru. Každý test odpovídá chybě, kterou recenze reprodukovala.
 */
import { describe, expect, it, vi } from 'vitest';
import { BrokerRequestNotSentError, type BrokerEvent } from '../services/brokerPort';
import { CopierLeaderEventSource } from './helpers/copierLeaderEventSource';
import {
  RithmicAccountRegistry,
  type RithmicAccountRegistryEntry,
  type RithmicAccountRegistryStore,
} from '../services/rithmic/rithmicAccountRegistry';
import { createRithmicBroker, type RithmicBrokerConfig, type RithmicIncident } from '../services/rithmic/rithmicBroker';
import { createFakeRithmicServer, flush } from './_fakeRithmicServer';

const credentials = { user: 'u', password: 'secret', systemName: 'Rithmic Test', appName: 'AlphaTrade', appVersion: '0.1' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Server = ReturnType<typeof createFakeRithmicServer>;

function memoryRegistryStore(): RithmicAccountRegistryStore {
  let entries: RithmicAccountRegistryEntry[] = [];
  let revision = 0;
  return {
    load: async () => ({ entries: entries.map((e) => ({ ...e })), revision }),
    save: async (next, expected) => {
      if (expected !== revision) throw new Error('revision conflict');
      entries = next.map((e) => ({ ...e }));
      revision += 1;
    },
  };
}

async function setup(options: { server?: Server; config?: Partial<RithmicBrokerConfig>; start?: boolean } = {}) {
  const server = options.server ?? createFakeRithmicServer();
  const registry = new RithmicAccountRegistry(memoryRegistryStore());
  await registry.load();
  const events: BrokerEvent[] = [];
  const incidents: RithmicIncident[] = [];
  const leaderEvents: Array<{ kind: string; orderId: string }> = [];
  const source = new CopierLeaderEventSource();
  const broker = createRithmicBroker({
    url: 'wss://fake', credentials, socketFactory: server.socketFactory, registry,
    onIncident: (incident) => incidents.push(incident),
    requestTimeoutMs: 80, confirmWaitMs: 60, fillWaitMs: 60, reconnectMinMs: 20, reconnectMaxMs: 40, maxReconnectFailures: 4,
    ...options.config,
  });
  let sequence = 0;
  broker.subscribe((event) => {
    events.push(event);
    const leader = source.observe(event, broker.accountIds()[0], (sequence += 1), Date.now());
    if (leader) leaderEvents.push({ kind: leader.kind, orderId: leader.orderId });
  });
  if (options.start !== false) await broker.start();
  const account = () => broker.accountIds()[0];
  const orderEvents = (tag: string) => events.flatMap((e) => (e.type === 'order' && e.order.tag === tag ? [`${e.order.status}:${e.order.filledQuantity}`] : []));
  const connections = () => events.flatMap((e) => (e.type === 'connection' ? [e] : []));
  const kinds = () => incidents.map((i) => i.kind);
  return { server, broker, events, incidents, leaderEvents, account, orderEvents, connections, kinds, registry };
}

const limit = (account: number, tag: string, quantity = 1) => ({ tag, accountId: account, symbol: 'ESZ6', side: 'Buy' as const, quantity, orderType: 'Limit' as const, limitPrice: 7000 });
const orderSocket = (server: Server) => server.sockets.filter((s) => s.readyState === 1 && s.infra === 2)[0];
const pnlSocket = (server: Server) => server.sockets.filter((s) => s.readyState === 1 && s.infra === 4)[0];
const errors = (events: BrokerEvent[]) => events.filter((e) => e.type === 'error');

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('čekala se výjimka');
}

describe('snímek × živé notifikace', () => {
  it('snímek uvidí zrušení dřív než živý CANCEL: jádro dostane canceled právě jednou', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-x'));
    await flush();
    t.server.orders.get(ack.brokerOrderId)!.status = 'cancelled'; // server zrušil, notifikace ještě nedorazila
    expect((await t.broker.listOrders(t.account())).find((o) => o.tag === 'tag-x')?.status).toBe('canceled');
    t.server.notifyLive(ack.brokerOrderId, 3); // opožděný živý CANCEL
    await flush();
    expect(t.orderEvents('tag-x')).toEqual(['pending:0', 'working:0', 'canceled:0']);
    expect(t.leaderEvents).toEqual([{ kind: 'submitted', orderId: ack.brokerOrderId }, { kind: 'canceled', orderId: ack.brokerOrderId }]);
    t.broker.stop();
  });

  it('živá změna během čtení: snímek ji nepřepíše a oba souběžné výsledky ji nesou', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-m'));
    await flush();
    let fired = false;
    t.server.hooks.onRequest = (templateId) => {
      if (templateId !== 320 || fired) return;
      fired = true;
      // snímek se složí se starou cenou, živá změna dorazí těsně po něm
      queueMicrotask(() => {
        t.server.orders.get(ack.brokerOrderId)!.price = 6990;
        t.server.notifyLive(ack.brokerOrderId, 2, { price: 6990 });
      });
    };
    const [first, second] = await Promise.all([t.broker.listOrders(t.account()), t.broker.listOrders(t.account())]);
    await flush();
    expect(second.find((o) => o.tag === 'tag-m')?.limitPrice).toBe(6990);
    expect(first.find((o) => o.tag === 'tag-m')).toBeDefined();
    expect((await t.broker.findOrderById(t.account(), ack.brokerOrderId)).order?.limitPrice).toBe(6990);
    t.broker.stop();
  });

  it('opožděný řádek snímku: incident, žádná smyčka, novější živou cenu nepřepíše', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-late'));
    await flush();
    await t.broker.listOrders(t.account());
    t.server.orders.get(ack.brokerOrderId)!.price = 6999.75;
    t.server.notifyLive(ack.brokerOrderId, 2, { price: 6999.75 });
    await flush();
    orderSocket(t.server).push(352, {
      is_snapshot: true, account_id: 'ACC1', basket_id: ack.brokerOrderId, user_tag: 'tag-late', symbol: 'ESZ6', exchange: 'CME',
      quantity: 1, price: 7000, transaction_type: 1, price_type: 1, notify_type: 1, status: 'open',
    });
    await flush();
    expect(t.kinds()).toContain('late-snapshot-row');
    expect(t.broker.isConnected()).toBe(true);
    expect(t.connections()).toHaveLength(1);
    // starý řádek nesmí přepsat knihu ani vyslat starou cenu (ověřeno dřív, než další čtení knihu opraví)
    expect(t.events.flatMap((e) => (e.type === 'order' && e.order.tag === 'tag-late' ? [e.order.limitPrice] : [])).at(-1)).toBe(6999.75);
    t.server.notifyLive(ack.brokerOrderId, 3);
    await flush();
    expect(t.events.flatMap((e) => (e.type === 'order' && e.order.tag === 'tag-late' ? [`${e.order.status}:${e.order.limitPrice}`] : [])).at(-1)).toBe('canceled:6999.75');
    t.broker.stop();
  });

  it('dohledání a seznam jdou jen z obsahu snímku: příkaz, který snímek už nevrací, není „nalezen" z paměti', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-mem'));
    await flush();
    await t.broker.cancelOrder(t.account(), ack.brokerOrderId);
    expect((await t.broker.findOrderById(t.account(), ack.brokerOrderId)).completeness).toBe('authoritative');
    t.server.orders.delete(ack.brokerOrderId); // např. po přelomu obchodního dne
    expect(await t.broker.findOrderById(t.account(), ack.brokerOrderId)).toMatchObject({ order: null, completeness: 'eventual' });
    expect(await t.broker.findOrdersByTag(t.account(), 'tag-mem')).toMatchObject({ orders: [], completeness: 'eventual' });
    expect(await t.broker.listOrders(t.account())).toEqual([]);
    t.broker.stop();
  });

  it('neúplná první notifikace během čtení: cizí pracující příkaz ve výsledku nechybí', async () => {
    const t = await setup();
    t.server.orders.set('900', {
      basketId: '900', accountId: 'ACC1', userTag: 'cizi', symbol: 'ESZ6', exchange: 'CME', side: 1, priceType: 1, quantity: 1, price: 6900, status: 'open', filled: 0,
    });
    let fired = false;
    t.server.hooks.onRequest = (templateId, _fields, socket) => {
      if (templateId !== 320 || fired) return;
      fired = true;
      socket.push(351, { account_id: 'ACC1', basket_id: '900', notify_type: 4, status: 'open pending' }); // bez strany, množství, symbolu
    };
    // čtení, které odhalí neznámý příkaz, neplatí: adaptér se odpojí
    expect((await thrown(t.broker.listOrders(t.account()))).message).toMatch(/výsledek neplatí/);
    // příkaz poznaný až ze snímku se jádru nevyšle jako nový vstup: odpojení a čistá obnova
    expect(t.kinds()).toContain('unknown-order-in-snapshot');
    await sleep(140);
    expect(t.broker.isHalted()).toBe(false);
    expect(t.broker.isConnected()).toBe(true);
    expect(t.leaderEvents).toEqual([]);
    expect(t.connections().at(-1)).toMatchObject({ connected: true, reconnected: true });
    t.broker.stop();
  });

  it('čtení pozic: živá změna během snímku → přečte se znovu, starší stav se nevrátí', async () => {
    const t = await setup();
    let fired = false;
    t.server.hooks.onRequest = (templateId, _fields, socket) => {
      if (templateId !== 402 || fired) return;
      fired = true;
      t.server.positions.set('ACC1|ESZ6', 1);
      queueMicrotask(() => socket.push(450, { account_id: 'ACC1', symbol: 'ESZ6', exchange: 'CME', net_quantity: 1 }));
    };
    expect(await t.broker.listPositions(t.account())).toEqual([{ accountId: t.account(), symbol: 'ESZ6', netQuantity: 1 }]);
    expect(t.server.received.filter((r) => r.templateId === 402).length).toBeGreaterThan(2);
    t.broker.stop();
  });

  it('nezdařené připojení po sobě nenechá živé pozice: další relace nevrátí starší stav', async () => {
    const t = await setup({ config: { requestTimeoutMs: 40 } });
    t.server.controls.ignoreShowOrders = true; // pokus o obnovu spadne při skládání výchozího stavu
    let pushed = false;
    t.server.hooks.onRequest = (templateId) => {
      if (templateId !== 320 || pushed) return;
      pushed = true;
      t.server.pushLivePosition('ACC1', 'ESZ6', 1); // živá pozice dorazí do relace, která se nedokončí
    };
    orderSocket(t.server).drop();
    for (let i = 0; i < 40 && !pushed; i += 1) await sleep(10);
    expect(pushed).toBe(true);
    await sleep(60);
    t.server.controls.ignoreShowOrders = false;
    t.server.hooks.onRequest = undefined;
    for (let i = 0; i < 60 && !t.broker.isConnected(); i += 1) await sleep(10);
    expect(t.broker.isConnected()).toBe(true);
    // snímek ještě ukazuje 0, živě přijde 1: musí se počítat jako změna a přečíst znovu
    let fired = false;
    t.server.hooks.onRequest = (templateId) => {
      if (templateId !== 402 || fired) return;
      fired = true;
      queueMicrotask(() => {
        t.server.positions.set('ACC1|ESZ6', 1);
        t.server.pushLivePosition('ACC1', 'ESZ6', 1);
      });
    };
    expect(await t.broker.listPositions(t.account())).toEqual([{ accountId: t.account(), symbol: 'ESZ6', netQuantity: 1 }]);
    t.broker.stop();
  });

  it('průběžné zprávy o pozici beze změny množství ani změny jiného účtu čtení pozic neruší', async () => {
    const t = await setup({ server: createFakeRithmicServer({ accounts: ['ACC1', 'ACC2'] }) });
    const [first] = t.broker.accountIds();
    t.server.positions.set('ACC1|ESZ6', 1);
    t.server.pushLivePosition('ACC1', 'ESZ6', 1);
    await flush();
    t.server.hooks.onRequest = (templateId) => {
      if (templateId !== 402) return;
      queueMicrotask(() => {
        t.server.pushLivePosition('ACC1', 'ESZ6', 1); // stejné množství = jen průběžný P&L
        t.server.pushLivePosition('ACC2', 'ESZ6', 5); // změna na jiném účtu
        t.server.positions.set('ACC2|ESZ6', (t.server.positions.get('ACC2|ESZ6') ?? 0) + 1);
        t.server.pushLivePosition('ACC2', 'ESZ6', t.server.positions.get('ACC2|ESZ6')!);
      });
    };
    const before = t.server.received.filter((r) => r.templateId === 402).length;
    expect(await t.broker.listPositions(first)).toEqual([{ accountId: first, symbol: 'ESZ6', netQuantity: 1 }]);
    expect(t.server.received.filter((r) => r.templateId === 402).length - before).toBe(1);
    t.broker.stop();
  });

  it('ochranu novější živé ceny nezruší další čtení ve frontě', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-q'));
    await flush();
    let reads = 0;
    t.server.hooks.onRequest = (templateId, _fields, socket) => {
      if (templateId !== 320) return;
      reads += 1;
      if (reads === 1) {
        // po prvním snímku přijde živá změna ceny; druhé čtení už čeká ve frontě
        queueMicrotask(() => {
          t.server.orders.get(ack.brokerOrderId)!.price = 6990;
          t.server.notifyLive(ack.brokerOrderId, 2, { price: 6990 });
        });
      }
      if (reads === 2) {
        // opožděný řádek prvního čtení se starou cenou dorazí během druhého
        queueMicrotask(() => socket.push(352, {
          is_snapshot: true, account_id: 'ACC1', basket_id: ack.brokerOrderId, user_tag: 'tag-q', symbol: 'ESZ6', exchange: 'CME',
          quantity: 1, price: 7000, transaction_type: 1, price_type: 1, notify_type: 1, status: 'open',
        }));
      }
    };
    await Promise.all([t.broker.listOrders(t.account()), t.broker.listOrders(t.account())]);
    await flush();
    const prices = t.events.flatMap((e) => (e.type === 'order' && e.order.tag === 'tag-q' ? [e.order.limitPrice] : []));
    expect(prices.at(-1)).toBe(6990);
    expect(prices.filter((p) => p === 7000 && prices.indexOf(6990) >= 0 && prices.lastIndexOf(7000) > prices.indexOf(6990))).toEqual([]);
    expect(t.leaderEvents.filter((e) => e.kind === 'replaced')).toHaveLength(1);
    t.broker.stop();
  });

  it('timeout snímku příkazů je chyba čtení a další čtení nezdrží', async () => {
    const t = await setup();
    await t.broker.placeOrder(limit(t.account(), 'tag-t'));
    await flush();
    t.server.controls.ignoreShowOrders = true;
    const started = Date.now();
    expect(await thrown(t.broker.listOrders(t.account()))).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(400);
    t.server.controls.ignoreShowOrders = false;
    expect((await t.broker.listOrders(t.account())).map((o) => o.tag)).toEqual(['tag-t']);
    t.broker.stop();
  });
});

describe('chybějící exekuce', () => {
  const fillExtra = (id: string, size: number, total: number) => ({ fill_id: id, fill_size: size, fill_price: 7000, total_fill_size: total });

  it('Rithmic ohlásí vyplnění s plným množstvím, exekuce z burzy nepřijde → fill-missing a odpojení', async () => {
    const t = await setup({ config: { reconnectMinMs: 5_000 } });
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-f', 2));
    await flush();
    orderSocket(t.server).push(351, { account_id: 'ACC1', basket_id: ack.brokerOrderId, notify_type: 15, status: 'complete', completion_reason: 'F', quantity: 2, total_fill_size: 2 });
    await sleep(140);
    expect(t.kinds()).toContain('fill-missing');
    expect(t.broker.isConnected()).toBe(false);
    expect(t.events.filter((e) => e.type === 'fill')).toEqual([]);
    expect(errors(t.events)).toEqual([]);
    t.broker.stop();
  });

  it('záznam notifikací: každá zpráva s výsledkem knihy; stejné ID vyplnění u JINÉHO příkazu je vidět jako duplikát s chybějícím kusem', async () => {
    const journal: Array<{ basket: string; notify: string; fill: boolean; duplicateFill: boolean; gap: number | null }> = [];
    const t = await setup({ config: { reconnectMinMs: 5_000, onOrderJournal: (entry) => journal.push({ basket: entry.update.basketId, notify: entry.update.notifyType, fill: entry.fill, duplicateFill: entry.duplicateFill, gap: entry.gap }) } });
    const first = await t.broker.placeOrder(limit(t.account(), 'tag-j1', 1));
    await flush();
    t.server.notifyLive(first.brokerOrderId, 5, fillExtra('SAME', 1, 1));
    const second = await t.broker.placeOrder(limit(t.account(), 'tag-j2', 1));
    await flush();
    t.server.notifyLive(second.brokerOrderId, 5, fillExtra('SAME', 1, 1));
    await sleep(140);
    const fills = journal.filter((row) => row.notify === 'FILL');
    expect(fills.map((row) => [row.basket, row.fill, row.duplicateFill])).toEqual([[first.brokerOrderId, true, false], [second.brokerOrderId, false, true]]);
    expect(fills[1].gap).toBe(1);
    // Dnešní chování (zdokumentované, ne žádoucí): kolize ID končí jako fill-missing a odpojení.
    expect(t.kinds()).toContain('fill-missing');
    t.broker.stop();
  });

  it('výjimka v záznamu notifikací příjem neruší', async () => {
    const t = await setup({ config: { onOrderJournal: () => { throw new Error('disk plný'); } } });
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-jx', 1));
    await flush();
    t.server.notifyLive(ack.brokerOrderId, 5, fillExtra('FX', 1, 1));
    await sleep(100);
    expect(t.events.filter((e) => e.type === 'fill')).toHaveLength(1);
    expect(t.kinds()).not.toContain('fill-missing');
    expect(t.broker.isConnected()).toBe(true);
    t.broker.stop();
  });

  it('dílčí fill hlídání nezruší: chybí-li zbytek, je to fill-missing', async () => {
    const t = await setup({ config: { reconnectMinMs: 5_000 } });
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-p', 3));
    await flush();
    orderSocket(t.server).push(351, { account_id: 'ACC1', basket_id: ack.brokerOrderId, notify_type: 15, status: 'complete', completion_reason: 'F' });
    t.server.notifyLive(ack.brokerOrderId, 5, fillExtra('F1', 1, 1));
    await sleep(140);
    expect(t.events.filter((e) => e.type === 'fill')).toHaveLength(1);
    expect(t.kinds()).toContain('fill-missing');
    expect(t.broker.isConnected()).toBe(false);
    t.broker.stop();
  });

  it('dílčí fill, hlášení o vyplnění a poslední fill včas → žádný incident, zůstane připojený', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-ok', 3));
    await flush();
    t.server.notifyLive(ack.brokerOrderId, 5, fillExtra('F1', 1, 1));
    orderSocket(t.server).push(351, { account_id: 'ACC1', basket_id: ack.brokerOrderId, notify_type: 15, status: 'complete', completion_reason: 'F' });
    await sleep(20);
    t.server.notifyLive(ack.brokerOrderId, 5, fillExtra('F2', 2, 3));
    await sleep(140);
    expect(t.events.flatMap((e) => (e.type === 'fill' ? [e.fill.quantity] : []))).toEqual([1, 2]);
    expect(t.incidents).toEqual([]);
    expect(t.broker.isConnected()).toBe(true);
    t.broker.stop();
  });

  it('pozdní fill po zrušení: fill se vydá jednou a jádro nedostane druhé canceled', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-lf', 2));
    await flush();
    t.server.notifyLive(ack.brokerOrderId, 3);
    t.server.notifyLive(ack.brokerOrderId, 5, fillExtra('F1', 1, 1));
    t.server.notifyLive(ack.brokerOrderId, 5, fillExtra('F1', 1, 1)); // duplicita téže exekuce
    await flush();
    expect(t.events.filter((e) => e.type === 'fill')).toHaveLength(1);
    expect(t.leaderEvents.map((e) => e.kind)).toEqual(['submitted', 'canceled', 'filled']);
    expect(t.broker.executionNet(t.account(), 'ESZ6')).toBe(1);
    t.broker.stop();
  });

  it('FILL bez ID exekuce: pozice se změnila a jádro to neví → fill-missing a odpojení', async () => {
    const t = await setup({ config: { reconnectMinMs: 5_000 } });
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-noid', 1));
    await flush();
    t.server.notifyLive(ack.brokerOrderId, 5, { fill_size: 1, fill_price: 7000, total_fill_size: 1 });
    await sleep(140);
    expect(t.events.filter((e) => e.type === 'fill')).toEqual([]);
    expect(t.kinds()).toContain('fill-missing');
    expect(t.broker.isConnected()).toBe(false);
    t.broker.stop();
  });

  it('FILL bez ID a hned zrušení zbytku: ztracená exekuce se neztratí → fill-missing', async () => {
    for (const order of ['fill-then-cancel', 'cancel-then-fill'] as const) {
      const t = await setup({ config: { reconnectMinMs: 5_000 } });
      const ack = await t.broker.placeOrder(limit(t.account(), `tag-${order}`, 2));
      await flush();
      const fill = () => t.server.notifyLive(ack.brokerOrderId, 5, { fill_size: 1, fill_price: 7000, total_fill_size: 1 });
      const cancel = () => t.server.notifyLive(ack.brokerOrderId, 3);
      if (order === 'fill-then-cancel') { fill(); cancel(); } else { cancel(); fill(); }
      await sleep(140);
      expect(t.kinds(), order).toContain('fill-missing');
      expect(t.broker.isConnected(), order).toBe(false);
      t.broker.stop();
    }
  });

  it('opakované vlastní odpojení kvůli stavu: po několika pokusech zastaveno, žádné přihlašování dokola', async () => {
    const t = await setup({ config: { maxSelfDrops: 2 } });
    for (let i = 0; i < 4 && !t.broker.isHalted(); i += 1) {
      // cizí příkaz, který adaptér živě neviděl, se objeví ve snímku
      t.server.orders.set(`90${i}`, { basketId: `90${i}`, accountId: 'ACC1', userTag: 'cizi', symbol: 'ESZ6', exchange: 'CME', side: 1, priceType: 1, quantity: 1, price: 6900, status: 'open', filled: 0 });
      await thrown(t.broker.listOrders(t.account()));
      await sleep(120);
    }
    expect(t.broker.isHalted()).toBe(true);
    expect(t.kinds().filter((k) => k === 'unknown-order-in-snapshot')).toHaveLength(3);
    const logins = t.server.received.filter((r) => r.templateId === 10).length;
    await sleep(150);
    expect(t.server.received.filter((r) => r.templateId === 10).length).toBe(logins);
  });

  it('hlášení o vyplnění, pak zrušení s dílčím vyplněním a doručeným fillem → žádný incident', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-fc', 3));
    await flush();
    orderSocket(t.server).push(351, { account_id: 'ACC1', basket_id: ack.brokerOrderId, notify_type: 15, status: 'complete', completion_reason: 'F' });
    t.server.notifyLive(ack.brokerOrderId, 5, fillExtra('F1', 1, 1));
    t.server.notifyLive(ack.brokerOrderId, 3, { total_fill_size: 1 });
    await sleep(140);
    expect(t.incidents).toEqual([]);
    expect(t.broker.isConnected()).toBe(true);
    t.broker.stop();
  });

  it('dluh se neodhaduje ze staršího většího množství: hlášení o vyplnění 1 ks předběhne zmenšení příkazu', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-shrink', 3));
    await flush();
    orderSocket(t.server).push(351, { account_id: 'ACC1', basket_id: ack.brokerOrderId, notify_type: 15, status: 'complete', completion_reason: 'F', quantity: 1 });
    t.server.orders.get(ack.brokerOrderId)!.quantity = 1;
    t.server.notifyLive(ack.brokerOrderId, 2, { quantity: 1 });
    t.server.notifyLive(ack.brokerOrderId, 5, { fill_id: 'S1', fill_size: 1, fill_price: 7000, total_fill_size: 1, quantity: 1 });
    await sleep(140);
    expect(t.incidents).toEqual([]);
    expect(t.broker.isConnected()).toBe(true);
    t.broker.stop();
  });

  it('snímek ukáže vyplnění, které jádro jako fill nedostalo → fill-missing, ne tiché filled', async () => {
    const t = await setup({ config: { reconnectMinMs: 5_000 } });
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-s', 1));
    await flush();
    const order = t.server.orders.get(ack.brokerOrderId)!;
    order.status = 'complete';
    order.filled = 1;
    await t.broker.listOrders(t.account());
    await sleep(140);
    expect(t.kinds()).toContain('fill-missing');
    expect(t.broker.isConnected()).toBe(false);
    t.broker.stop();
  });
});

describe('dokončení s neznámým důvodem', () => {
  const unknownComplete = (server: Server, basketId: string) =>
    orderSocket(server).push(351, { account_id: 'ACC1', basket_id: basketId, notify_type: 15, status: 'complete', completion_reason: 'XX' });

  it('snímek řekne zrušeno → jádro dostane canceled a adaptér zůstane připojený', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-u'));
    await flush();
    t.server.orders.get(ack.brokerOrderId)!.status = 'cancelled';
    unknownComplete(t.server, ack.brokerOrderId);
    await sleep(60);
    expect(t.orderEvents('tag-u').at(-1)).toBe('canceled:0');
    expect(t.broker.isConnected()).toBe(true);
    expect(t.kinds()).not.toContain('state-undetermined');
    t.broker.stop();
  });

  it('snímek ho dál ukazuje jako pracující → zastaveno s incidentem, bez obnovy', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-h'));
    await flush();
    unknownComplete(t.server, ack.brokerOrderId);
    await sleep(160);
    expect(t.kinds()).toContain('state-undetermined');
    expect(t.broker.isHalted()).toBe(true);
    expect(t.connections().filter((c) => c.connected)).toHaveLength(1);
    expect(errors(t.events)).toEqual([]);
  });

  it('čtení selže dvakrát → zastaveno (žádné tiché pending)', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-r'));
    await flush();
    t.server.controls.ignoreShowOrders = true;
    unknownComplete(t.server, ack.brokerOrderId);
    await sleep(300);
    expect(t.broker.isHalted()).toBe(true);
    expect(t.kinds()).toContain('state-undetermined');
  });
});

describe('obnova spojení', () => {
  it('po výpadku chybí dříve známý dokončený příkaz → resync.complete je false', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-gone'));
    await flush();
    await t.broker.cancelOrder(t.account(), ack.brokerOrderId);
    orderSocket(t.server).drop();
    await flush();
    t.server.orders.delete(ack.brokerOrderId);
    await sleep(140);
    const last = t.connections().filter((c) => c.connected).at(-1)!;
    expect(last.reconnected).toBe(true);
    expect(last.resync).toMatchObject({ complete: false });
    expect(last.resync?.orders.map((o) => o.brokerOrderId)).not.toContain(ack.brokerOrderId);
    t.broker.stop();
  });

  it('po výpadku chybí dříve pracující příkaz → zastaveno, žádné nekonečné přihlašování', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-day'));
    await flush();
    orderSocket(t.server).drop();
    await flush();
    t.server.orders.delete(ack.brokerOrderId);
    await sleep(400);
    expect(t.broker.isHalted()).toBe(true);
    expect(t.kinds()).toContain('state-undetermined');
    // přihlášení: 2 při startu + 2 při jediném pokusu o obnovu
    expect(t.server.received.filter((r) => r.templateId === 10).length).toBe(4);
    expect(t.connections().filter((c) => c.connected)).toHaveLength(1);
  });

  it('dlouhý výpadek spojení se do stropu nepočítá: nezastaví se a po návratu se připojí', async () => {
    const t = await setup();
    orderSocket(t.server).drop();
    await flush();
    t.server.controls.ignoreShowOrders = true; // server neodpovídá = selhání spojení, ne stavu
    await sleep(900);
    expect(t.broker.isHalted()).toBe(false);
    expect(t.server.received.filter((r) => r.templateId === 10).length).toBeGreaterThan(8);
    // incident jen při prvním selhání a pak po desítkách, ne při každém pokusu
    expect(t.kinds().filter((k) => k === 'reconnect-failed').length).toBeLessThanOrEqual(2);
    t.server.controls.ignoreShowOrders = false;
    await sleep(250);
    expect(t.broker.isConnected()).toBe(true);
    expect(t.connections().at(-1)).toMatchObject({ connected: true, reconnected: true });
    t.broker.stop();
  });

  it('opakované selhání na stavu (nevyložitelný řádek snímku): po stropu zastaveno, další přihlášení už ne', async () => {
    const t = await setup();
    await t.broker.placeOrder(limit(t.account(), 'tag-odd'));
    await flush();
    orderSocket(t.server).drop();
    await flush();
    t.server.controls.openStatusText = 'neznamy stav';
    await sleep(700);
    expect(t.broker.isHalted()).toBe(true);
    expect(t.kinds().filter((k) => k === 'reconnect-failed')).toHaveLength(4);
    const logins = t.server.received.filter((r) => r.templateId === 10).length;
    await sleep(200);
    expect(t.server.received.filter((r) => r.templateId === 10).length).toBe(logins);
  });

  it('po zastavení pro chybějící příkaz jde ručně spustit znovu (čistá kniha)', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-day2'));
    await flush();
    orderSocket(t.server).drop();
    await flush();
    t.server.orders.delete(ack.brokerOrderId);
    await sleep(200);
    expect(t.broker.isHalted()).toBe(true);
    await t.broker.start();
    expect(t.broker.isConnected()).toBe(true);
    // po ručním spuštění s čistou knihou adaptér netvrdí, že se v mezeře nic nestalo
    expect(t.connections().at(-1)?.resync).toMatchObject({ complete: false, failureReason: expect.stringMatching(/book-reset/) });
    expect(await t.broker.listOrders(t.account())).toEqual([]);
    t.broker.stop();
  });

  it('dílčí vyplnění během výpadku: po obnově další živý fill nevyvolá falešné fill-missing', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-gapfill', 3));
    await flush();
    orderSocket(t.server).drop();
    await flush();
    t.server.orders.get(ack.brokerOrderId)!.filled = 1; // vyplněno 1/3 v mezeře
    await sleep(140);
    expect(t.broker.isConnected()).toBe(true);
    t.server.orders.get(ack.brokerOrderId)!.filled = 2;
    t.server.notifyLive(ack.brokerOrderId, 5, { fill_id: 'G2', fill_size: 1, fill_price: 7000, total_fill_size: 2 });
    await sleep(140);
    expect(t.kinds()).not.toContain('fill-missing');
    expect(t.broker.isConnected()).toBe(true);
    expect(t.events.flatMap((e) => (e.type === 'fill' ? [e.fill.quantity] : []))).toEqual([1]);
    t.broker.stop();
  });

  it('oprávněné fill-missing → obnova → další fill už druhé odpojení nevyvolá', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-twice', 3));
    await flush();
    t.server.orders.get(ack.brokerOrderId)!.filled = 1;
    orderSocket(t.server).push(351, { account_id: 'ACC1', basket_id: ack.brokerOrderId, notify_type: 15, status: 'complete', completion_reason: 'F', quantity: 3, total_fill_size: 1 });
    await sleep(260);
    expect(t.kinds().filter((k) => k === 'fill-missing')).toHaveLength(1);
    expect(t.broker.isConnected()).toBe(true); // mezitím se sám znovu připojil
    t.server.orders.get(ack.brokerOrderId)!.filled = 2;
    t.server.notifyLive(ack.brokerOrderId, 5, { fill_id: 'T2', fill_size: 1, fill_price: 7000, total_fill_size: 2 });
    await sleep(140);
    expect(t.kinds().filter((k) => k === 'fill-missing')).toHaveLength(1);
    expect(t.broker.isConnected()).toBe(true);
    t.broker.stop();
  });

  it('dluh exekucí vzniklý během připojování nezůstane bez dozoru', async () => {
    const seed = await setup();
    const ack = await seed.broker.placeOrder(limit(seed.account(), 'tag-boot', 2));
    await flush();
    seed.broker.stop();
    let pushes = 0;
    seed.server.hooks.onRequest = (templateId, _fields, socket) => {
      // až při posledním čtení pozic výchozího stavu: Rithmic ohlásí vyplnění, exekuce nepřijde
      if (templateId !== 402 || pushes > 0) return;
      pushes += 1;
      queueMicrotask(() => {
        const order = seed.server.sockets.filter((s) => s.readyState === 1 && s.infra === 2)[0];
        void socket;
        order.push(351, { account_id: 'ACC1', basket_id: ack.brokerOrderId, notify_type: 15, status: 'complete', completion_reason: 'F', quantity: 2 });
      });
    };
    const t = await setup({ server: seed.server, config: { reconnectMinMs: 5_000 } });
    expect(t.broker.isConnected()).toBe(true);
    await sleep(160);
    expect(t.kinds()).toContain('fill-missing');
    expect(t.broker.isConnected()).toBe(false);
    t.broker.stop();
  });

  it('živá notifikace během skládání výchozího stavu: zopakuje se, vše je před connected a jádro nic nekopíruje', async () => {
    const seed = await setup();
    const ack = await seed.broker.placeOrder(limit(seed.account(), 'tag-base'));
    await flush();
    seed.broker.stop();
    let fired = false;
    seed.server.hooks.onRequest = (templateId) => {
      if (templateId !== 320 || fired) return;
      fired = true;
      queueMicrotask(() => {
        seed.server.orders.get(ack.brokerOrderId)!.price = 6990;
        seed.server.notifyLive(ack.brokerOrderId, 2, { price: 6990 });
      });
    };
    const before = seed.server.received.filter((r) => r.templateId === 320).length;
    const t = await setup({ server: seed.server });
    expect(seed.server.received.filter((r) => r.templateId === 320).length - before).toBeGreaterThanOrEqual(2);
    const connectedAt = t.events.findIndex((e) => e.type === 'connection' && e.connected);
    expect(t.events.slice(connectedAt + 1)).toEqual([]);
    const baseline = t.events.slice(0, connectedAt).flatMap((e) => (e.type === 'order' ? [e.order.limitPrice] : []));
    expect(baseline.at(-1)).toBe(6990);
    expect(t.leaderEvents).toEqual([]);
    t.broker.stop();
  });

  it('vynucené odhlášení během připojování: zastaveno, žádný další pokus', async () => {
    const server = createFakeRithmicServer();
    let fired = false;
    server.hooks.onRequest = (templateId) => {
      if (templateId !== 320 || fired) return;
      fired = true;
      server.forceLogout();
    };
    const t = await setup({ server, start: false });
    await thrown(t.broker.start());
    await sleep(150);
    expect(t.broker.isHalted()).toBe(true);
    expect(t.kinds()).toContain('forced-logout');
    expect(t.connections()).toEqual([]);
    expect(server.received.filter((r) => r.templateId === 10).length).toBe(2);
  });

  it('tiché spojení bez zavření: odpojení a obnova', async () => {
    vi.useFakeTimers();
    try {
      const t = await setup({ config: { reconnectMinMs: 1_000, reconnectMaxMs: 2_000 } });
      t.server.controls.silent = true;
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(t.connections().some((c) => !c.connected)).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.connections().at(-1)).toMatchObject({ connected: true, reconnected: true, resynced: true });
      expect(errors(t.events)).toEqual([]);
      t.broker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('životní cyklus a zápisy', () => {
  it('stop během čekání na obnovu: žádné další spojení; po zastavení jde znovu spustit', async () => {
    const t = await setup({ config: { reconnectMinMs: 60 } });
    orderSocket(t.server).drop();
    await flush();
    t.broker.stop();
    const sockets = t.server.sockets.length;
    await sleep(160);
    expect(t.server.sockets.length).toBe(sockets);
    await t.broker.start();
    expect(t.connections().at(-1)).toMatchObject({ connected: true, reconnected: true, resynced: true });
    t.broker.stop();
  });

  it('stop a nový start během připojování: stará relace do nové nezasáhne', async () => {
    const t = await setup({ start: false });
    const first = t.broker.start();
    t.broker.stop();
    expect(await thrown(first)).toBeInstanceOf(Error);
    await t.broker.start();
    expect(t.broker.isConnected()).toBe(true);
    expect(t.connections().filter((c) => c.connected)).toHaveLength(1);
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-new'));
    await flush();
    expect((await t.broker.findOrderById(t.account(), ack.brokerOrderId)).order?.status).toBe('working');
    t.broker.stop();
  });

  it('posluchač zastaví adaptér při výchozím stavu: connected:true se už nevyšle', async () => {
    const seed = await setup();
    await seed.broker.placeOrder(limit(seed.account(), 'tag-b'));
    await flush();
    seed.broker.stop();
    const registry = new RithmicAccountRegistry(memoryRegistryStore());
    await registry.load();
    const events: BrokerEvent[] = [];
    const broker = createRithmicBroker({ url: 'wss://fake', credentials, socketFactory: seed.server.socketFactory, registry, requestTimeoutMs: 80 });
    broker.subscribe((event) => {
      events.push(event);
      if (event.type === 'order') broker.stop();
    });
    await thrown(broker.start());
    await sleep(60);
    expect(events.filter((e) => e.type === 'connection')).toEqual([]);
    expect(broker.isConnected()).toBe(false);
  });

  it('text serveru se do výjimky nedostane (jádro podle slova „rejected" rozlišuje odmítnutí)', async () => {
    const t = await setup();
    t.server.controls.rejectNextOrder = 'rejected at RMS';
    const error = await thrown(t.broker.placeOrder(limit(t.account(), 'tag-txt')));
    expect(error).not.toBeInstanceOf(BrokerRequestNotSentError);
    expect(error.message).not.toMatch(/rejected|odm[ií]t|RMS/i);
    expect(error.message).toMatch(/kód 6/);
    t.broker.stop();
  });

  it('pád spojení uprostřed zrušení: neznámý výsledek, žádné opakování', async () => {
    const t = await setup({ config: { reconnectMinMs: 5_000 } });
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-c'));
    await flush();
    t.server.hooks.onRequest = (templateId, _fields, socket) => {
      if (templateId === 316) socket.drop();
    };
    const error = await thrown(t.broker.cancelOrder(t.account(), ack.brokerOrderId));
    expect(error).not.toBeInstanceOf(BrokerRequestNotSentError);
    expect(t.server.received.filter((r) => r.templateId === 316)).toHaveLength(1);
    t.broker.stop();
  });

  it('zrušení, které předběhlo vyplnění: potvrzení konečným stavem filled', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder(limit(t.account(), 'tag-race'));
    await flush();
    t.server.hooks.onRequest = (templateId) => {
      if (templateId === 316) t.server.fill(ack.brokerOrderId, 7000);
    };
    expect(await t.broker.cancelOrder(t.account(), ack.brokerOrderId)).toMatchObject({ confirmedBy: 'stream-terminal', order: { status: 'filled', filledQuantity: 1 } });
    expect(t.events.filter((e) => e.type === 'fill')).toHaveLength(1);
    t.broker.stop();
  });

  it('způsobilost: změna identity účtu (FCM) → incident, výjimka a nové přihlášení; selhání RMS = výjimka', async () => {
    const t = await setup();
    t.server.controls.rmsFails = true;
    expect(await thrown(t.broker.listAccountCapabilities([t.account()]))).toBeInstanceOf(Error);
    expect(t.broker.isConnected()).toBe(true);
    t.server.controls.rmsFails = false;
    const original = t.account();
    t.server.controls.accountFcm = 'FCM2';
    expect((await thrown(t.broker.listAccountCapabilities([original]))).message).toMatch(/seznam účtů se změnil/);
    expect(t.kinds()).toContain('accounts-changed');
    expect(t.broker.isConnected()).toBe(false);
    await sleep(140);
    expect(t.broker.isConnected()).toBe(true);
    // jiná identita = jiné číslo účtu; staré číslo už aktivní není
    expect(t.account()).not.toBe(original);
    expect(await t.broker.listAccountCapabilities([original])).toEqual([{ accountId: original, active: false, canTrade: false }]);
    t.broker.stop();
  });

  it('risk snapshot bez čerstvého P&L je chyba, ne samé null s čerstvým časem', async () => {
    // záporná lhůta = žádný snímek není dost čerstvý
    const t = await setup({ config: { riskSnapshotMaxAgeMs: -1 } });
    expect((await thrown(t.broker.listAccountRiskSnapshots([t.account()]))).message).toMatch(/čerstvý snímek P&L/);
    t.broker.stop();
  });
});
