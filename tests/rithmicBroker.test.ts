import { describe, expect, it } from 'vitest';
import { BrokerRequestNotSentError, type BrokerEvent } from '../services/brokerPort';
import { CopierLeaderEventSource } from '../services/copierLeaderEventSource';
import {
  RithmicAccountRegistry,
  type RithmicAccountRegistryEntry,
  type RithmicAccountRegistryStore,
} from '../services/rithmic/rithmicAccountRegistry';
import { createRithmicBroker, type RithmicBrokerConfig, type RithmicIncident } from '../services/rithmic/rithmicBroker';
import { createFakeRithmicServer, flush } from './_fakeRithmicServer';

const credentials = { user: 'u', password: 'secret', systemName: 'Rithmic Test', appName: 'AlphaTrade', appVersion: '0.1' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function setup(options: { server?: Parameters<typeof createFakeRithmicServer>[0]; config?: Partial<RithmicBrokerConfig>; start?: boolean } = {}) {
  const server = createFakeRithmicServer(options.server);
  const registry = new RithmicAccountRegistry(memoryRegistryStore());
  await registry.load();
  const events: BrokerEvent[] = [];
  const incidents: RithmicIncident[] = [];
  const broker = createRithmicBroker({
    url: 'wss://fake', credentials, socketFactory: server.socketFactory, registry,
    onIncident: (incident) => incidents.push(incident),
    requestTimeoutMs: 80, confirmWaitMs: 60, fillWaitMs: 60, reconnectMinMs: 20, reconnectMaxMs: 40,
    ...options.config,
  });
  broker.subscribe((event) => events.push(event));
  if (options.start !== false) await broker.start();
  const account = broker.accountIds()[0];
  const kinds = () => events.map((e) => (e.type === 'order' ? `order:${e.order.tag}:${e.order.status}` : e.type === 'connection' ? `connection:${e.connected}` : e.type));
  return { server, broker, events, incidents, account, kinds, registry };
}

const limit = (account: number, tag: string) => ({ tag, accountId: account, symbol: 'ESZ6', side: 'Buy' as const, quantity: 1, orderType: 'Limit' as const, limitPrice: 7000 });
const errors = (events: BrokerEvent[]) => events.filter((e) => e.type === 'error');

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('čekala se výjimka');
}

describe('RithmicBroker — výchozí stav a spojení', () => {
  it('výchozí stav vyšle jako order události před connected:true, bez fillů; jádro z něj nic nekopíruje', async () => {
    // první běh založí na serveru příkazy: pracující, vyplněný, zrušený
    const first = await setup();
    const open = await first.broker.placeOrder(limit(first.account, 'tag-open'));
    const done = await first.broker.placeOrder({ ...limit(first.account, 'tag-done'), orderType: 'Market', limitPrice: undefined });
    first.server.fill(done.brokerOrderId, 7001);
    await flush();
    first.broker.stop();

    // druhý adaptér nad týmž serverem = restart
    const registry = new RithmicAccountRegistry(memoryRegistryStore());
    await registry.load();
    const events: BrokerEvent[] = [];
    const source = new CopierLeaderEventSource();
    const leaderEvents: unknown[] = [];
    const broker = createRithmicBroker({ url: 'wss://fake', credentials, socketFactory: first.server.socketFactory, registry, requestTimeoutMs: 80 });
    let sequence = 0;
    broker.subscribe((event) => {
      events.push(event);
      const leader = source.observe(event, broker.accountIds()[0], (sequence += 1), Date.now());
      if (leader) leaderEvents.push(leader);
    });
    await broker.start();
    const connectedAt = events.findIndex((e) => e.type === 'connection' && e.connected);
    const baseline = events.slice(0, connectedAt);
    expect(baseline.filter((e) => e.type === 'order').map((e) => (e.type === 'order' ? `${e.order.tag}:${e.order.status}` : '')).sort())
      .toEqual(['tag-done:filled', 'tag-open:working']);
    expect(events.filter((e) => e.type === 'fill')).toEqual([]);
    expect(leaderEvents).toEqual([]);
    const connection = events[connectedAt];
    expect(connection).toMatchObject({ type: 'connection', connected: true, resync: { complete: true, gapFills: [] } });
    expect(connection.type === 'connection' && connection.reconnected).toBeUndefined();
    // živá změna po připojení už leader událost je
    await broker.cancelOrder(broker.accountIds()[0], open.brokerOrderId);
    await flush();
    expect(leaderEvents).toHaveLength(1);
    expect(leaderEvents[0]).toMatchObject({ kind: 'canceled', orderId: open.brokerOrderId });
    expect(errors(events)).toEqual([]);
    broker.stop();
  });

  it('číslo účtu je z trvalé tabulky, prostředí Rithmic Test je demo', async () => {
    const { broker, account, registry } = await setup();
    expect(account).toBeGreaterThan(9_000_000_000_000);
    expect(registry.resolve(account)).toEqual({ system: 'Rithmic Test', fcmId: 'FCM', ibId: 'IB', accountId: 'ACC1' });
    expect(broker.environment).toBe('demo');
    expect(createRithmicBroker({ url: 'x', credentials: { ...credentials, systemName: 'Rithmic 01' }, socketFactory: () => { throw new Error('x'); }, registry }).environment).toBe('live');
    broker.stop();
  });

  it('odběr změn účtu: zpráva 358 pro účet relace (nebo bez účtu) dá signál, pro cizí účet ne', async () => {
    let signals = 0;
    const { server, broker } = await setup({ config: { onAccountUpdate: () => { signals += 1; } } });
    const order = server.sockets.filter((s) => s.readyState === 1 && s.infra === 2)[0];
    const own = server.sockets.length ? [...broker.accountIds()].map((id) => broker.accountName(id))[0]! : '';
    order.push(358, { account_id: own });
    order.push(358, {});
    order.push(358, { account_id: 'CIZI-UCET' });
    await flush();
    expect(signals).toBe(2);
    expect(broker.isConnected()).toBe(true);
    broker.stop();
  });

  // 18. 11. 2026: Rithmic vypnul uživatele po 2000 dotazech na účty. Každé přihlášení k příkazům jeden posílá.
  it('rozpočet přihlášení: po vyčerpání se adaptér po pádu spojení sám nepřihlásí a zastaví se s incidentem', async () => {
    let logins = 0;
    const { server, broker, incidents } = await setup({ config: { loginAllowed: () => (logins += 1) <= 1 } });
    expect(broker.isConnected()).toBe(true);
    const socketsBefore = server.sockets.length;
    server.sockets.filter((s) => s.readyState === 1)[0].drop();
    await sleep(150);
    expect(broker.isConnected()).toBe(false);
    expect(broker.isHalted()).toBe(true);
    expect(server.sockets.length).toBe(socketsBefore); // žádné nové spojení, tedy ani dotaz na účty
    expect(incidents.some((i) => i.kind === 'state-undetermined' && /rozpočet přihlášení/.test(i.message))).toBe(true);
    await sleep(150);
    expect(logins).toBe(2); // po zastavení už se ani neptá
    broker.stop();
  });

  it('spojení, které se přihlásí a hned spadne, zkouší čím dál řidčeji (prodleva se vrací až po stabilní relaci)', async () => {
    const drop = (server: ReturnType<typeof createFakeRithmicServer>) => server.sockets.filter((s) => s.readyState === 1)[0].drop();
    const flaky = await setup({ config: { reconnectMinMs: 40, reconnectMaxMs: 4_000 } });
    drop(flaky.server); await sleep(120); expect(flaky.broker.isConnected()).toBe(true); // 40 ms
    drop(flaky.server); await sleep(200); expect(flaky.broker.isConnected()).toBe(true); // 80 ms
    drop(flaky.server); await sleep(90); expect(flaky.broker.isConnected()).toBe(false); // teď už 160 ms
    await sleep(250); expect(flaky.broker.isConnected()).toBe(true);
    flaky.broker.stop();
    // Relace, která vydržela, vrací prodlevu na minimum.
    const stable = await setup({ config: { reconnectMinMs: 40, reconnectMaxMs: 4_000, stableSessionMs: 0 } });
    for (let i = 0; i < 3; i += 1) { drop(stable.server); await sleep(120); expect(stable.broker.isConnected()).toBe(true); }
    stable.broker.stop();
  });

  it('pád spojení: connected:false, vyšší routeEpoch, obnova s resynced a shodným stavem', async () => {
    const { server, broker, events, account } = await setup();
    await broker.placeOrder(limit(account, 'tag-keep'));
    await flush();
    const epoch = broker.routeEpoch!(account);
    server.sockets.filter((s) => s.readyState === 1)[0].drop();
    await flush();
    expect(broker.isConnected()).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'connection', connected: false });
    expect(broker.routeEpoch!(account)).toBeGreaterThan(epoch);
    expect(await thrown(broker.placeOrder(limit(account, 'tag-down')))).toBeInstanceOf(BrokerRequestNotSentError);
    await sleep(120);
    expect(broker.isConnected()).toBe(true);
    const reconnect = events.filter((e) => e.type === 'connection' && e.connected).at(-1);
    expect(reconnect).toMatchObject({ reconnected: true, resynced: true, resync: { complete: true } });
    expect(errors(events)).toEqual([]);
    broker.stop();
  });

  it('změna příkazu během výpadku: resync.complete je false s důvodem', async () => {
    const { server, broker, events, account } = await setup();
    const ack = await broker.placeOrder(limit(account, 'tag-gap'));
    await flush();
    server.sockets.filter((s) => s.readyState === 1)[0].drop();
    await flush();
    server.orders.get(ack.brokerOrderId)!.status = 'cancelled';
    await sleep(120);
    const reconnect = events.filter((e) => e.type === 'connection' && e.connected).at(-1);
    expect(reconnect && reconnect.type === 'connection' && reconnect.resync).toMatchObject({ complete: false });
    expect(reconnect && reconnect.type === 'connection' && reconnect.resync?.failureReason).toMatch(/gap-fills-unverified/);
    broker.stop();
  });

  it('vynucené odhlášení: zastaví se bez obnovy, incident, žádná událost error', async () => {
    const { server, broker, events, incidents } = await setup();
    server.forceLogout();
    await flush();
    await sleep(120);
    expect(broker.isConnected()).toBe(false);
    expect(broker.isHalted()).toBe(true);
    expect(incidents.map((i) => i.kind)).toContain('forced-logout');
    expect(events.filter((e) => e.type === 'connection' && e.connected)).toHaveLength(1);
    expect(errors(events)).toEqual([]);
  });

  it('heartbeat jen ze zprávy serveru a jen když žijí oba planty', async () => {
    const { broker, events, account } = await setup({ config: { heartbeatWindowMs: 60 } });
    const beats = () => events.filter((e) => e.type === 'heartbeat').length;
    await sleep(90);
    const before = beats();
    await broker.listOrders(account); // jen order plant; pnl plant mlčí déle než okno
    expect(beats()).toBe(before);
    await broker.listPositions(account); // pnl plant žije, order plant žil před chvílí
    expect(beats()).toBeGreaterThan(before);
    broker.stop();
  });
});

describe('RithmicBroker — zápisy', () => {
  it('nový příkaz: přijato s číslem příkazu a živé stavy', async () => {
    const { broker, account, kinds } = await setup();
    const ack = await broker.placeOrder(limit(account, 'tag-1'));
    await flush();
    expect(ack).toMatchObject({ accepted: true, definitive: true });
    expect(ack.brokerOrderId).not.toBe('');
    expect(kinds().filter((k) => k.startsWith('order:tag-1'))).toEqual(['order:tag-1:pending', 'order:tag-1:working']);
    broker.stop();
  });

  it('neodesláno: neznámý účet, symbol, chybějící značka — k serveru nic nejde', async () => {
    const { server, broker, account } = await setup();
    expect(await thrown(broker.placeOrder(limit(account + 99, 'x')))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(await thrown(broker.placeOrder({ ...limit(account, 'x'), symbol: 'FDAXZ6' }))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(await thrown(broker.placeOrder(limit(account, '')))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(await thrown(broker.placeOrder({ ...limit(account, 'x'), quantity: 0 }))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(server.newOrderFrames()).toBe(0);
    broker.stop();
  });

  it('chybový kód, timeout i pád po odeslání = neznámý výsledek, žádné opakování, text bez „odmít"', async () => {
    const { server, broker, account } = await setup();
    server.controls.rejectNextOrder = 'price out of range';
    const coded = await thrown(broker.placeOrder(limit(account, 'tag-code')));
    server.controls.ignoreNextOrder = true;
    const timeout = await thrown(broker.placeOrder(limit(account, 'tag-timeout')));
    server.controls.dropNextOrderBeforeAck = true;
    const dropped = await thrown(broker.placeOrder(limit(account, 'tag-drop')));
    for (const error of [coded, timeout, dropped]) {
      expect(error).not.toBeInstanceOf(BrokerRequestNotSentError);
      expect(error.message).not.toMatch(/rejected|odm[ií]t/i);
    }
    expect(server.newOrderFrames()).toBe(3);
    broker.stop();
  });

  it('přijato a vzápětí odmítnuto na RMS: událost rejected s důvodem, žádná událost error', async () => {
    const { server, broker, account, events, kinds } = await setup();
    server.controls.rmsRejectNextOrder = 'Rejected at RMS - limit';
    const ack = await broker.placeOrder({ ...limit(account, 'tag-rms'), quantity: 500 });
    await flush();
    expect(ack.accepted).toBe(true);
    expect(kinds().filter((k) => k.startsWith('order:tag-rms'))).toEqual(['order:tag-rms:pending', 'order:tag-rms:rejected']);
    const rejected = events.find((e) => e.type === 'order' && e.order.status === 'rejected');
    expect(rejected && rejected.type === 'order' && rejected.order.rejectReason).toBe('Rejected at RMS - limit');
    expect(errors(events)).toEqual([]);
    // po restartu je odmítnutý příkaz ve výchozím stavu také jako rejected
    expect((await broker.findOrdersByTag(account, 'tag-rms')).orders[0]).toMatchObject({ status: 'rejected' });
    broker.stop();
  });

  it('zrušení: potvrzení jen z konečného stavu; „ok" pro neexistující příkaz nic nepotvrdí', async () => {
    const { server, broker, account } = await setup();
    const ack = await broker.placeOrder(limit(account, 'tag-c'));
    await flush();
    expect(await broker.cancelOrder(account, ack.brokerOrderId)).toMatchObject({ confirmedBy: 'stream-terminal', order: { status: 'canceled' } });
    expect(await broker.cancelOrder(account, '999999')).toBeUndefined();
    server.controls.cancelUnknownOk = false;
    const error = await thrown(broker.cancelOrder(account, '999999'));
    expect(error).not.toBeInstanceOf(BrokerRequestNotSentError);
    expect(error.message).not.toMatch(/rejected|odm[ií]t/i);
    broker.stop();
  });

  it('změna: vždy bez potvrzení (ověřuje jádro čtením); neznámý a bracket příkaz se neodešle', async () => {
    const { server, broker, account } = await setup();
    const ack = await broker.placeOrder(limit(account, 'tag-m'));
    await flush();
    expect(await broker.modifyOrder(account, ack.brokerOrderId, { quantity: 1, orderType: 'Limit', limitPrice: 6999.75 })).toBeUndefined();
    await flush();
    expect((await broker.findOrderById(account, ack.brokerOrderId)).order).toMatchObject({ limitPrice: 6999.75, status: 'working' });
    expect(await thrown(broker.modifyOrder(account, '424242', { quantity: 1, orderType: 'Limit', limitPrice: 1 }))).toBeInstanceOf(BrokerRequestNotSentError);
    // cizí bracket příkaz
    const socket = server.sockets.filter((s) => s.readyState === 1 && s.infra === 2)[0];
    socket.push(352, { account_id: 'ACC1', basket_id: '777', user_tag: 'cizi', symbol: 'ESZ6', exchange: 'CME', quantity: 1, price: 7000, transaction_type: 1, price_type: 1, notify_type: 1, bracket_type: 6 });
    await flush();
    expect(await thrown(broker.modifyOrder(account, '777', { quantity: 1, orderType: 'Limit', limitPrice: 1 }))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(server.received.filter((r) => r.templateId === 314)).toHaveLength(1);
    broker.stop();
  });

  it('selhání zrušení od Rithmicu je incident, ne událost error', async () => {
    const { server, broker, events, incidents } = await setup();
    const socket = server.sockets.filter((s) => s.readyState === 1 && s.infra === 2)[0];
    socket.push(351, { account_id: 'ACC1', basket_id: '5', notify_type: 17, status: 'Cancellation Failed', text: 'too late' });
    await flush();
    expect(incidents.map((i) => i.kind)).toEqual(['cancel-failed']);
    expect(errors(events)).toEqual([]);
    expect(broker.isConnected()).toBe(true);
    broker.stop();
  });

  it('Rithmic ohlásí vyplnění, exekuce z burzy nepřijde: incident a odpojení k plné obnově', async () => {
    const { server, broker, events, incidents, account } = await setup({ config: { reconnectMinMs: 5_000 } });
    const ack = await broker.placeOrder(limit(account, 'tag-f'));
    await flush();
    const socket = server.sockets.filter((s) => s.readyState === 1 && s.infra === 2)[0];
    socket.push(351, { account_id: 'ACC1', basket_id: ack.brokerOrderId, notify_type: 15, status: 'complete', completion_reason: 'F' });
    await sleep(120);
    expect(incidents.map((i) => i.kind)).toContain('fill-missing');
    expect(broker.isConnected()).toBe(false);
    expect(broker.isHalted()).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'connection', connected: false });
    expect(errors(events)).toEqual([]);
    broker.stop();
  });
});

describe('RithmicBroker — čtení', () => {
  it('listOrders vrací pracující i dokončené; chybějící pracující příkaz je chyba, ne prázdno', async () => {
    const { server, broker, account } = await setup();
    const open = await broker.placeOrder(limit(account, 'tag-open'));
    const gone = await broker.placeOrder(limit(account, 'tag-gone'));
    await flush();
    await broker.cancelOrder(account, open.brokerOrderId);
    expect((await broker.listOrders(account)).map((o) => `${o.tag}:${o.status}`).sort()).toEqual(['tag-gone:working', 'tag-open:canceled']);
    server.orders.delete(gone.brokerOrderId);
    expect((await thrown(broker.listOrders(account))).message).toMatch(/neobsahuje pracující příkaz/);
    broker.stop();
  });

  it('dohledání: nalezený příkaz je autoritativní, nenalezený jen eventual', async () => {
    const { broker, account } = await setup();
    const ack = await broker.placeOrder(limit(account, 'tag-l'));
    await flush();
    expect(await broker.findOrdersByTag(account, 'tag-l')).toMatchObject({ completeness: 'authoritative', orders: [{ brokerOrderId: ack.brokerOrderId }] });
    expect(await broker.findOrdersByTag(account, 'neni')).toMatchObject({ completeness: 'eventual', orders: [] });
    expect(await broker.findOrderById(account, ack.brokerOrderId)).toMatchObject({ completeness: 'authoritative' });
    expect(await broker.findOrderById(account, '424242')).toMatchObject({ completeness: 'eventual', order: null });
    expect((await thrown(broker.listOrders(account + 5))).message).toMatch(/není v aktuálním přihlášení/);
    broker.stop();
  });

  it('pozice: po vyplnění množství; neúplný snímek nebo řádek bez množství je chyba, ne flat', async () => {
    const { server, broker, account } = await setup();
    expect(await broker.listPositions(account)).toEqual([]);
    const ack = await broker.placeOrder({ ...limit(account, 'tag-p'), orderType: 'Market', limitPrice: undefined });
    server.fill(ack.brokerOrderId, 7001);
    await flush();
    expect(await broker.listPositions(account)).toEqual([{ accountId: account, symbol: 'ESZ6', netQuantity: 1 }]);
    server.controls.positionWithoutQuantity = true;
    expect((await thrown(broker.listPositions(account))).message).toMatch(/bez množství/);
    server.controls.positionWithoutQuantity = false;
    // snímek bez řádku účtu není důkaz: prázdný výsledek by jinak znamenal „flat"
    server.controls.pnlWithoutAccountRow = true;
    expect((await thrown(broker.listPositions(account))).message).toMatch(/neúplný/);
    server.controls.pnlWithoutAccountRow = false;
    server.controls.pnlSnapshotFails = true;
    expect(await thrown(broker.listPositions(account))).toBeInstanceOf(Error);
    broker.stop();
  });

  it('způsobilost čte čerstvě: neaktivní RMS = nelze obchodovat; neznámý účet není aktivní', async () => {
    const { server, broker, account } = await setup();
    expect(await broker.listAccountCapabilities([account, account + 7])).toEqual([
      { accountId: account, active: true, canTrade: true },
      { accountId: account + 7, active: false, canTrade: false },
    ]);
    server.controls.rmsStatus = 'disabled';
    expect(await broker.listAccountCapabilities([account])).toEqual([{ accountId: account, active: true, canTrade: false }]);
    broker.stop();
  });

  it('risk snapshot: P&L z Rithmicu, neznámé hodnoty null (nikdy nula), den null', async () => {
    const { broker, account } = await setup({ config: { riskSnapshotMaxAgeMs: 0 } });
    const [snapshot] = await broker.listAccountRiskSnapshots([account]);
    expect(snapshot).toMatchObject({
      accountId: account, netLiq: null, minNetLiq: null, dailyLossAutoLiq: null, trailingMaxDrawdown: null, realizedTradeDate: null,
    });
    const fresh = createRithmicBroker; // jen aby čtenář viděl, že další test používá výchozí lhůtu
    expect(typeof fresh).toBe('function');
    broker.stop();
    const second = await setup();
    const [withValues] = await second.broker.listAccountRiskSnapshots([second.account]);
    expect(withValues).toMatchObject({ realizedPnlUsd: 125.5, openPnlUsd: -12.5, cashBalanceUsd: 50000, netLiq: null });
    second.broker.stop();
  });
});
