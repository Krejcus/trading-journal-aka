/**
 * Vstup se serverovým SL/TP a zavírání pozice v Rithmic adaptéru. Napodobený server se
 * chová podle měření z 16. 11. 2026 (scénář H): nohy vznikají až po vyplnění vstupu, nenesou
 * značku, zrušení jedné nohy zruší i sestru, zavření pozice je samostatný Market bez značky.
 */
import { describe, expect, it } from 'vitest';
import { BrokerRequestNotSentError, type BrokerEvent, type BrokerOrder } from '../services/brokerPort';
import {
  RithmicAccountRegistry,
  type RithmicAccountRegistryEntry,
  type RithmicAccountRegistryStore,
} from '../services/rithmic/rithmicAccountRegistry';
import { createRithmicBroker, type RithmicBrokerConfig, type RithmicIncident } from '../services/rithmic/rithmicBroker';
import { RithmicProtection, memoryProtectionStore, type ProtectionState, type ProtectionStore } from '../services/rithmic/rithmicProtection';
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

async function setup(options: { server?: Server; registryStore?: RithmicAccountRegistryStore; store?: ProtectionStore & { saved?: () => ProtectionState | null }; config?: Partial<RithmicBrokerConfig> } = {}) {
  const server = options.server ?? createFakeRithmicServer();
  const registryStore = options.registryStore ?? memoryRegistryStore();
  const registry = new RithmicAccountRegistry(registryStore);
  await registry.load();
  const given = options.store ?? memoryProtectionStore();
  const store = { load: () => given.load(), save: (state: ProtectionState) => given.save(state), saved: () => given.saved?.() ?? null };
  const events: BrokerEvent[] = [];
  const incidents: RithmicIncident[] = [];
  const broker = createRithmicBroker({
    url: 'wss://fake', credentials, socketFactory: server.socketFactory, registry, protectionStore: store,
    onIncident: (incident) => incidents.push(incident),
    requestTimeoutMs: 150, confirmWaitMs: 60, fillWaitMs: 60, reconnectMinMs: 20, reconnectMaxMs: 40,
    legsWaitMs: 25, exitSettleMs: 100, flattenStepMs: 120, flattenCancelWaitMs: 80, flattenPostCheckMs: 40,
    ...options.config,
  });
  broker.subscribe((event) => events.push(event));
  await broker.start();
  const account = () => broker.accountIds()[0];
  const kinds = () => incidents.map((i) => i.kind);
  const sent = (templateId: number) => server.received.filter((r) => r.templateId === templateId).length;
  const working = () => [...server.orders.values()].filter((o) => o.status === 'open');
  const legsOf = (entryId: string) => [...server.orders.values()].filter((o) => o.parent === entryId);
  const net = () => server.positions.get('ACC1|ESZ6') ?? 0;
  return { server, broker, events, incidents, account, kinds, sent, working, legsOf, net, store, registryStore };
}

type T = Awaited<ReturnType<typeof setup>>;
const bracket = (t: T, tag: string, extra: Record<string, unknown> = {}) => ({
  tag, accountId: t.account(), symbol: 'ESZ6', side: 'Buy' as const, quantity: 1, orderType: 'Limit' as const, limitPrice: 7000, stopTicks: 40, targetTicks: 80, ...extra,
});
const flatten = (t: T, tag: string) => t.broker.liquidatePosition({ tag, accountId: t.account(), symbol: 'ESZ6' });

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('čekala se výjimka');
}

/** Vstup s ochranou vyplněný na 7000, obě nohy pracují. */
async function openProtected(t: T, tag = 'b1', quantity = 1): Promise<string> {
  const ack = await t.broker.placeBracket(bracket(t, tag, { quantity }));
  await flush();
  t.server.fill(ack.entryBrokerOrderId, 7000);
  await sleep(90);
  return ack.entryBrokerOrderId;
}

describe('vstup se serverovou ochranou', () => {
  it('po vyplnění obě nohy pracují → stav „protected", žádný incident; celý bracket jde jádru jako Unsupported', async () => {
    const t = await setup();
    const entry = await openProtected(t);
    expect(t.broker.bracketState(t.account(), entry).state).toBe('protected');
    expect(t.kinds()).toEqual([]);
    const types = new Set(t.events.flatMap((e) => (e.type === 'order' ? [e.order.orderType] : [])));
    expect([...types]).toEqual(['Unsupported']);
    // nohy nenesou značku ani vazby v událostech — jádro je nesmí brát jako SL/TP známého tvaru
    for (const e of t.events) if (e.type === 'order') expect(e.order.parentOrderId).toBeUndefined();
    t.broker.stop();
  });

  it('dva kontrakty: každá noha se kontroluje zvlášť proti vyplněnému množství', async () => {
    const t = await setup();
    const entry = await openProtected(t, 'b2', 2);
    expect(t.broker.bracketState(t.account(), entry)).toEqual({ state: 'protected', detail: '' });
    expect(t.kinds()).toEqual([]);
    t.broker.stop();
  });

  it('nohy nevzniknou → incident bracket-legs-missing, nic se nedostavuje ani nezavírá', async () => {
    const t = await setup();
    t.server.controls.legsNeverAppear = true;
    const entry = await openProtected(t);
    expect(t.kinds()).toContain('bracket-legs-missing');
    expect(t.broker.bracketState(t.account(), entry).state).toBe('unprotected');
    expect(t.server.newOrderFrames()).toBe(1);
    expect(t.sent(3504)).toBe(0);
    expect(t.net()).toBe(1);
    // stav se hlásí jednou, dokud se nezmění
    await sleep(120);
    expect(t.kinds().filter((k) => k === 'bracket-legs-missing')).toHaveLength(1);
    t.broker.stop();
  });

  it('vznikne jen TP → ochrana není úplná → incident', async () => {
    const t = await setup();
    t.server.controls.onlyTargetLeg = true;
    await openProtected(t);
    expect(t.incidents.find((i) => i.kind === 'bracket-legs-missing')?.message).toMatch(/SL: pracuje 0 místo 1/);
    t.broker.stop();
  });

  it('nohu někdo zruší jinde (padnou obě) → incident, pozice trvá', async () => {
    const t = await setup();
    const entry = await openProtected(t);
    const [leg] = t.legsOf(entry);
    for (const other of t.legsOf(entry)) {
      other.status = 'cancelled';
      t.server.notifyLive(other.basketId, 3);
    }
    await sleep(100);
    expect(leg.status).toBe('cancelled');
    expect(t.kinds()).toContain('bracket-legs-missing');
    t.broker.stop();
  });

  it('zrušení nohy při otevřené pozici se neodešle; po zavření pozice jinou nohou jde osiřelá noha zrušit', async () => {
    const t = await setup();
    const entry = await openProtected(t);
    const stop = t.legsOf(entry).find((o) => o.priceType === 4)!;
    const target = t.legsOf(entry).find((o) => o.priceType === 1)!;
    const error = await thrown(t.broker.cancelOrder(t.account(), stop.basketId));
    expect(error).toBeInstanceOf(BrokerRequestNotSentError);
    expect(t.sent(316)).toBe(0);
    // TP se vyplní → pozice 0, SL dál pracuje (zda ho server ruší sám, není změřeno)
    t.server.fill(target.basketId, 7020);
    await sleep(100);
    expect(t.net()).toBe(0);
    expect(t.kinds()).toContain('bracket-orphan-legs');
    expect(t.broker.bracketState(t.account(), entry).state).toBe('orphan-legs');
    await t.broker.cancelOrder(t.account(), stop.basketId);
    expect(stop.status).toBe('cancelled');
    await sleep(100);
    expect(t.broker.bracketState(t.account(), entry).state).toBe('done');
    t.broker.stop();
  });

  it('posun SL a TP: mění se jen cena, vazba i ochrana zůstávají; množství, typ a cizí bracket se nemění', async () => {
    const t = await setup();
    const entry = await openProtected(t, 'mv');
    const stop = t.legsOf(entry).find((o) => o.priceType === 4)!;
    const target = t.legsOf(entry).find((o) => o.priceType === 1)!;
    await t.broker.modifyOrder(t.account(), stop.basketId, { quantity: 1, orderType: 'Stop', stopPrice: 6995 });
    await t.broker.modifyOrder(t.account(), target.basketId, { quantity: 1, orderType: 'Limit', limitPrice: 7030 });
    await sleep(120);
    expect(stop.triggerPrice).toBe(6995);
    expect(stop.priceType).toBe(4);
    expect(target.price).toBe(7030);
    expect(stop.parent).toBe(entry);
    expect(t.broker.bracketState(t.account(), entry).state).toBe('protected');
    expect(t.kinds()).toEqual([]);
    const frames = t.sent(314);
    expect(await thrown(t.broker.modifyOrder(t.account(), stop.basketId, { quantity: 2, orderType: 'Stop', stopPrice: 6990 }))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(await thrown(t.broker.modifyOrder(t.account(), stop.basketId, { quantity: 1, orderType: 'Limit', limitPrice: 6990 }))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(await thrown(t.broker.modifyOrder(t.account(), stop.basketId, { quantity: 1, orderType: 'Stop' }))).toBeInstanceOf(BrokerRequestNotSentError);
    // vstup bracketu (Unsupported, ne noha) se přes adaptér nemění
    const resting = await t.broker.placeBracket(bracket(t, 'mv2', { limitPrice: 6900 }));
    await flush();
    expect(await thrown(t.broker.modifyOrder(t.account(), resting.entryBrokerOrderId, { quantity: 1, orderType: 'Limit', limitPrice: 6890 }))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(t.sent(314)).toBe(frames);
    t.broker.stop();
  });

  it('stejná značka podruhé se neodešle; neplatné ticky a chybějící SL i TP také ne', async () => {
    const t = await setup();
    await t.broker.placeBracket(bracket(t, 'dup'));
    expect(await thrown(t.broker.placeBracket(bracket(t, 'dup')))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(await thrown(t.broker.placeBracket(bracket(t, 'x1', { stopTicks: 0 })))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(await thrown(t.broker.placeBracket(bracket(t, 'x2', { stopTicks: undefined, targetTicks: undefined })))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(t.server.newOrderFrames()).toBe(1);
    t.broker.stop();
  });

  it('záměr je uložený dřív, než vstup odejde; když uložit nejde, vstup se neodešle', async () => {
    const t = await setup();
    let savedAtSend = false;
    t.server.hooks.onRequest = (templateId) => {
      if (templateId === 330) savedAtSend = Boolean(t.store.saved()?.brackets.some((b) => b.tag === 'pre'));
    };
    await t.broker.placeBracket(bracket(t, 'pre'));
    expect(savedAtSend).toBe(true);
    t.broker.stop();

    const failing = { load: async () => null, save: async () => { throw new Error('disk plný'); } };
    const broken = await setup({ store: failing });
    expect(await thrown(broken.broker.placeBracket(bracket(broken, 'nosave')))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(broken.server.newOrderFrames()).toBe(0);
    broken.broker.stop();
  });

  it('odmítnutí RMS přijde jako událost; stav je „done" a incident ochrany nevznikne', async () => {
    const t = await setup();
    t.server.controls.rmsRejectNextOrder = 'Rejected at RMS';
    const ack = await t.broker.placeBracket(bracket(t, 'rms'));
    await sleep(100);
    expect(ack.accepted).toBe(true);
    expect(t.events.some((e) => e.type === 'order' && e.order.brokerOrderId === ack.entryBrokerOrderId && e.order.status === 'rejected')).toBe(true);
    expect(t.broker.bracketState(t.account(), ack.entryBrokerOrderId).state).toBe('done');
    expect(t.kinds()).not.toContain('bracket-legs-missing');
    t.broker.stop();
  });

  it('ztracená odpověď: výsledek neznámý, nic se neopakuje, vstup se dohledá podle značky a hlídá', async () => {
    const t = await setup();
    t.server.controls.legsNeverAppear = true;
    t.server.controls.dropNextOrderBeforeAck = true;
    await thrown(t.broker.placeBracket(bracket(t, 'lost')));
    for (let i = 0; i < 60 && !t.broker.isConnected(); i += 1) await sleep(10);
    expect(t.broker.isConnected()).toBe(true);
    expect(t.server.newOrderFrames()).toBe(1);
    const entry = [...t.server.orders.values()].find((o) => o.userTag === 'lost')!;
    // záměr přežil a po obnově se spároval se vstupem ze snímku
    expect(t.store.saved()?.brackets.find((b) => b.tag === 'lost')?.entryId).toBe(entry.basketId);
    t.server.fill(entry.basketId, 7000);
    await sleep(120);
    expect(t.kinds()).toContain('bracket-legs-missing');
    t.broker.stop();
  });

  it('po restartu: vyplněný vstup bez noh se ohlásí z výchozího stavu', async () => {
    const first = await setup();
    first.server.controls.legsNeverAppear = true;
    await openProtected(first);
    first.broker.stop();
    const second = await setup({ server: first.server, registryStore: first.registryStore, store: first.store });
    await sleep(150);
    expect(second.kinds()).toContain('bracket-legs-missing');
    second.broker.stop();
  });

  it('stop příkaz: ochranný limit hlášený burzou se nevydává jako limitní cena', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder({ tag: 'stp', accountId: t.account(), symbol: 'ESZ6', side: 'Sell', quantity: 1, orderType: 'Stop', stopPrice: 6990 });
    await flush();
    t.server.notifyLive(ack.brokerOrderId, 1, { price: 6985, trigger_price: 6990 });
    await flush();
    const seen = t.events.flatMap((e) => (e.type === 'order' && e.order.brokerOrderId === ack.brokerOrderId ? [e.order] : []));
    expect(seen.length).toBeGreaterThan(0);
    for (const order of seen) expect(order.limitPrice).toBeUndefined();
    expect(seen.at(-1)?.stopPrice).toBe(6990);
    t.broker.stop();
  });
});

describe('stav ochrany (výpočet)', () => {
  const ACC = 1;
  type Leg = { id: string; type: 'STOP_MARKET' | 'LIMIT'; quantity: number; filled: number; status: BrokerOrder['status'] };
  function build(entry: { filled: number; status: BrokerOrder['status'] }, legs: Leg[], intent: { stopTicks?: number; targetTicks?: number } = { stopTicks: 40, targetTicks: 80 }) {
    const protection = new RithmicProtection(memoryProtectionStore(), () => 1_000);
    protection.addBracket({ tag: 't', accountId: ACC, symbol: 'ESZ6', side: 'Buy', quantity: 2, ...intent, entryId: 'E', createdAt: 1 });
    const orders = new Map<string, BrokerOrder>();
    const order = (id: string, quantity: number, filled: number, status: BrokerOrder['status'], extra: Partial<BrokerOrder> = {}): BrokerOrder => ({
      brokerOrderId: id, accountId: ACC, symbol: 'ESZ6', side: 'Sell', orderType: 'Unsupported', quantity, filledQuantity: filled, status, sourceVersion: '', ...extra,
    } as BrokerOrder);
    orders.set('E', order('E', 2, entry.filled, entry.status));
    for (const leg of legs) {
      protection.observe(ACC, { basketId: leg.id, originalBasketId: 'E', priceType: leg.type, bracketType: 'TARGET_AND_STOP_STATIC', userTag: '' } as never);
      orders.set(leg.id, order(leg.id, leg.quantity, leg.filled, leg.status, leg.type === 'STOP_MARKET' ? { stopPrice: 6990 } : { limitPrice: 7020 }));
    }
    const orderOf = (id: string) => orders.get(id);
    return { protection, orderOf, state: (net: number | null) => protection.bracketState(ACC, 'E', orderOf, net) };
  }

  it('každá role proti expozici bracketu: po dílčím TP je SL na původní množství chyba', () => {
    const t = build({ filled: 2, status: 'filled' }, [
      { id: 'TP', type: 'LIMIT', quantity: 2, filled: 1, status: 'working' },
      { id: 'SL', type: 'STOP_MARKET', quantity: 2, filled: 0, status: 'working' },
    ]);
    const result = t.state(1);
    expect(result.state).toBe('unprotected');
    expect(result.detail).toMatch(/SL: 2 ks proti expozici 1/);
  });

  it('nohy expozici zavřely: cizí pozice na kontraktu není „bez ochrany"; po západce už vůbec', () => {
    const t = build({ filled: 2, status: 'filled' }, [
      { id: 'TP', type: 'LIMIT', quantity: 2, filled: 2, status: 'filled' },
      { id: 'SL', type: 'STOP_MARKET', quantity: 2, filled: 0, status: 'canceled' },
    ]);
    expect(t.state(3)).toMatchObject({ state: 'done', latch: true });
    const closed = build({ filled: 2, status: 'filled' }, [
      { id: 'TP', type: 'LIMIT', quantity: 2, filled: 0, status: 'canceled' },
      { id: 'SL', type: 'STOP_MARKET', quantity: 2, filled: 0, status: 'canceled' },
    ]);
    expect(closed.state(1).state).toBe('unprotected'); // nohy zrušené, expozice trvá
    closed.protection.closeBracket(ACC, 'E');
    expect(closed.state(1).state).toBe('done');
  });

  it('noha potvrzená jen Rithmicem (pending) ochrana není; pozice neznámá = unknown', () => {
    const t = build({ filled: 2, status: 'filled' }, [
      { id: 'TP', type: 'LIMIT', quantity: 2, filled: 0, status: 'working' },
      { id: 'SL', type: 'STOP_MARKET', quantity: 2, filled: 0, status: 'pending' },
    ]);
    expect(t.state(2).state).toBe('unprotected');
    expect(t.state(null).state).toBe('unknown');
    expect(t.protection.hasPendingLegs(ACC, 'E', () => ({ status: 'pending' } as BrokerOrder))).toBe(true);
  });

  it('nula z obyčejného čtení bracket natrvalo nezavře; důvěryhodná nula ano; přeplnění má přednost před západkou', () => {
    const legsGone: Leg[] = [
      { id: 'TP', type: 'LIMIT', quantity: 2, filled: 0, status: 'canceled' },
      { id: 'SL', type: 'STOP_MARKET', quantity: 2, filled: 0, status: 'canceled' },
    ];
    const t = build({ filled: 2, status: 'filled' }, legsGone);
    const stale = t.state(0); // dvě zastaralá čtení dají dvakrát tohle — a nic se nezavře
    expect(stale.state).toBe('done');
    expect(stale.latch).toBeUndefined();
    expect(t.state(2).state).toBe('unprotected'); // jakmile přijde skutečná pozice, hlásí se
    // důvěryhodná nula po vyplnění vstupu zavírá jen když je pozice nulová i TEĎ
    expect(t.protection.bracketState(ACC, 'E', t.orderOf, 0, true)).toMatchObject({ state: 'done', latch: true });
    expect(t.protection.bracketState(ACC, 'E', t.orderOf, 2, true).state).toBe('unprotected');
    // po západce: nohy vyplněné víc než vstup se pořád hlásí
    const over = build({ filled: 1, status: 'filled' }, [
      { id: 'TP', type: 'LIMIT', quantity: 1, filled: 1, status: 'filled' },
      { id: 'SL', type: 'STOP_MARKET', quantity: 1, filled: 1, status: 'filled' },
    ]);
    over.protection.closeBracket(ACC, 'E');
    expect(over.state(-1).state).toBe('unprotected');
  });

  it('nohy vyplnily víc než vstup: nikdy „hotovo", vždy hlášení', () => {
    const t = build({ filled: 1, status: 'filled' }, [
      { id: 'TP', type: 'LIMIT', quantity: 1, filled: 1, status: 'filled' },
      { id: 'SL', type: 'STOP_MARKET', quantity: 1, filled: 1, status: 'filled' },
    ]);
    const result = t.state(-1);
    expect(result.state).toBe('unprotected');
    expect(result.latch).toBeUndefined();
    expect(result.detail).toMatch(/obrácená/);
  });

  it('souběžné zápisy záznamu neskončí starším stavem', async () => {
    const written: number[] = [];
    let delay = 40;
    const store = { load: async () => null, save: async (state: ProtectionState) => { const mine = delay; delay = 0; const count = state.brackets.length; await sleep(mine); written.push(count); } };
    const protection = new RithmicProtection(store, () => 1);
    protection.addBracket({ tag: 'a', accountId: ACC, symbol: 'ESZ6', side: 'Buy', quantity: 1, stopTicks: 1, createdAt: 1 });
    const first = protection.save();
    protection.addBracket({ tag: 'b', accountId: ACC, symbol: 'ESZ6', side: 'Buy', quantity: 1, stopTicks: 1, createdAt: 1 });
    await Promise.all([first, protection.save()]);
    expect(written.at(-1)).toBe(2);
    expect(written).toHaveLength(2);
  });
});

describe('nálezy z review diffu', () => {
  it('ochranu nejde ověřit (pozici nejde přečíst): podezření se nezahodí — po omezeném opakování poplach', async () => {
    const t = await setup();
    t.server.controls.legsNeverAppear = true;
    t.server.controls.muteLivePositions = true; // živá pozice nepřijde → musí se číst
    t.server.controls.pnlSnapshotFails = true;  // a čtení selhává
    const ack = await t.broker.placeBracket(bracket(t, 'unv'));
    await flush();
    t.server.fill(ack.entryBrokerOrderId, 7000);
    await sleep(1_200);
    expect(t.incidents.some((i) => i.kind === 'bracket-legs-missing' && /nejde ověřit/.test(i.message))).toBe(true);
    t.broker.stop();
  });

  it('stará nula nezavře vstup vyplněný za výpadku spojení (scénář z review)', async () => {
    const t = await setup();
    await openProtected(t, 'o1');
    await flatten(t, 'fo1');
    await sleep(120); // důvěryhodná nula je zapsaná
    const ack = await t.broker.placeBracket(bracket(t, 'o2'));
    await flush();
    // spojení spadne, vstup se vyplní během výpadku a nohy nevzniknou
    t.server.controls.legsNeverAppear = true;
    t.server.sockets.filter((socket) => socket.readyState === 1 && socket.infra === 2)[0].drop();
    t.server.fill(ack.entryBrokerOrderId, 7000);
    for (let i = 0; i < 80 && !t.broker.isConnected(); i += 1) await sleep(10);
    expect(t.broker.isConnected()).toBe(true);
    await sleep(250);
    expect(t.kinds()).toContain('bracket-legs-missing');
    expect(t.store.saved()?.brackets.find((b) => b.tag === 'o2')?.closedAt).toBeUndefined();
    t.broker.stop();
  });

  it('zpožděná nula po vyplnění (odporuje součtu exekucí) nic nezavře ani neuvolní', async () => {
    const t = await setup();
    t.server.controls.legsNeverAppear = true;
    t.server.controls.muteLivePositions = true;
    const ack = await t.broker.placeBracket(bracket(t, 'sz'));
    await flush();
    t.server.fill(ack.entryBrokerOrderId, 7000);
    await flush();
    t.server.pushLivePosition('ACC1', 'ESZ6', 0); // stará zpráva z PnL spojení
    await flush();
    t.server.pushLivePosition('ACC1', 'ESZ6', 1);
    await sleep(250);
    expect(t.kinds()).toContain('bracket-legs-missing');
    expect(t.store.saved()?.brackets.find((b) => b.tag === 'sz')?.closedAt).toBeUndefined();
    t.broker.stop();
  });

  it('vstup vyplněný až po uzavření (zrušení × vyplnění): západka padne a ochrana se hlídá znovu', async () => {
    const t = await setup();
    const ack = await t.broker.placeBracket(bracket(t, 're'));
    await flush();
    const entry = t.server.orders.get(ack.entryBrokerOrderId)!;
    entry.status = 'cancelled';
    t.server.notifyLive(ack.entryBrokerOrderId, 3);
    await sleep(120);
    expect(t.store.saved()?.brackets.find((b) => b.tag === 're')?.closedAt).toBeDefined();
    // burza ale příkaz těsně předtím vyplnila — exekuce dorazí pozdě
    t.server.controls.legsNeverAppear = true;
    t.server.positions.set('ACC1|ESZ6', 1);
    t.server.notifyLive(ack.entryBrokerOrderId, 5, { fill_price: 7000, fill_size: 1, fill_id: 'late-1', total_fill_size: 1 });
    t.server.pushLivePosition('ACC1', 'ESZ6', 1);
    await sleep(250);
    expect(t.store.saved()?.brackets.find((b) => b.tag === 're')?.closedAt).toBeUndefined();
    expect(t.kinds()).toContain('bracket-legs-missing');
    t.broker.stop();
  });

  it('druhý obchod na stejném kontraktu: dokončený bracket nedostane falešný poplach', async () => {
    const t = await setup();
    await openProtected(t, 'a1');
    await flatten(t, 'fa');
    await sleep(120);
    await openProtected(t, 'a2');
    await sleep(120);
    await flatten(t, 'fb');
    await sleep(120);
    // a ještě holý příkaz, který otevře pozici bez bracketu
    const bare = await t.broker.placeOrder({ tag: 'bare', accountId: t.account(), symbol: 'ESZ6', side: 'Buy', quantity: 1, orderType: 'Limit', limitPrice: 7000 });
    await flush();
    t.server.fill(bare.brokerOrderId, 7000);
    await sleep(150);
    expect(t.kinds()).toEqual([]);
    expect(t.store.saved()?.brackets.every((b) => b.closedAt !== undefined)).toBe(true);
    t.broker.stop();
  });

  it('lhůta ochrany běží od POSLEDNÍ změny: vyplnění těsně před koncem první lhůty nevyvolá okamžitý poplach', async () => {
    const t = await setup({ config: { legsWaitMs: 90 } });
    t.server.controls.legsNeverAppear = true;
    const ack = await t.broker.placeBracket(bracket(t, 'late'));
    await sleep(70);
    t.server.fill(ack.entryBrokerOrderId, 7000);
    await sleep(45); // první lhůta (od přijetí vstupu) už uplynula
    expect(t.kinds()).toEqual([]);
    await sleep(220); // poplach až po druhé, potvrzující kontrole
    expect(t.kinds()).toContain('bracket-legs-missing');
    t.broker.stop();
  });

  it('živá pozice starší než vyplnění se nebere jako důkaz: zrušení nohy neprojde a stav není „orphan"', async () => {
    const t = await setup();
    await openProtected(t, 'z1');
    await flatten(t, 'fz');
    await sleep(120); // živá pozice je teď 0
    t.server.controls.muteLivePositions = true; // PnL spojení se opozdí za vyplněním
    const ack = await t.broker.placeBracket(bracket(t, 'z2'));
    await flush();
    t.server.fill(ack.entryBrokerOrderId, 7000);
    await flush();
    expect(t.broker.bracketState(t.account(), ack.entryBrokerOrderId).state).toBe('unknown');
    const leg = t.legsOf(ack.entryBrokerOrderId)[0];
    const before = t.sent(316);
    expect(await thrown(t.broker.cancelOrder(t.account(), leg.basketId))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(t.sent(316)).toBe(before);
    expect(t.legsOf(ack.entryBrokerOrderId).every((o) => o.status === 'open')).toBe(true);
    t.broker.stop();
  });

  it('pozice, která předběhla zprávu o vyplnění, je důvěryhodná, když sedí se součtem exekucí; jinak ne', async () => {
    const t = await setup();
    const ack = await t.broker.placeBracket(bracket(t, 'xc'));
    await flush();
    // zpráva o pozici dorazí DŘÍV než vyplnění (dvě různá spojení)
    t.server.controls.muteLivePositions = true;
    t.server.pushLivePosition('ACC1', 'ESZ6', 1);
    await flush();
    t.server.fill(ack.entryBrokerOrderId, 7000);
    await sleep(120);
    expect(t.broker.bracketState(t.account(), ack.entryBrokerOrderId).state).toBe('protected');
    // rychlá cesta zavírání se proto obejde bez čtení příkazů
    const reads = t.sent(320);
    t.server.controls.muteLivePositions = false;
    expect((await flatten(t, 'fxc')).status).toBe('submitted');
    expect(t.sent(320)).toBe(reads);
    await sleep(100);
    // nesouhlasná hodnota (pozice říká 2, exekuce dávají 1) důvěru nedostane
    const second = await t.broker.placeBracket(bracket(t, 'xc2'));
    await flush();
    t.server.controls.muteLivePositions = true;
    t.server.pushLivePosition('ACC1', 'ESZ6', 2);
    await flush();
    t.server.fill(second.entryBrokerOrderId, 7000);
    await flush();
    expect(t.broker.bracketState(t.account(), second.entryBrokerOrderId).state).toBe('unknown');
    t.broker.stop();
  });

  it('první zpráva nohy (ještě bez vazby): zrušení z posluchače události neprojde', async () => {
    const t = await setup();
    const ack = await t.broker.placeBracket(bracket(t, 'first'));
    await flush();
    const attempts: Array<Promise<Error>> = [];
    t.broker.subscribe((event) => {
      if (event.type !== 'order' || event.order.brokerOrderId === ack.entryBrokerOrderId || attempts.length) return;
      attempts.push(thrown(t.broker.cancelOrder(t.account(), event.order.brokerOrderId)));
    });
    t.server.fill(ack.entryBrokerOrderId, 7000);
    await sleep(250);
    expect(attempts).toHaveLength(1);
    expect(await attempts[0]).toBeInstanceOf(BrokerRequestNotSentError);
    expect(t.sent(316)).toBe(0);
    t.broker.stop();
  });

  it('vstup čekající na uložení neodejde, když mezitím začalo zavírání', async () => {
    const inner = memoryProtectionStore();
    let slow = false;
    const store = { load: () => inner.load(), saved: () => inner.saved(), save: async (state: ProtectionState) => { if (slow) await sleep(60); await inner.save(state); } };
    const t = await setup({ store });
    await openProtected(t, 'w1');
    const frames = t.server.newOrderFrames();
    slow = true;
    const placing = thrown(t.broker.placeBracket(bracket(t, 'w2')));
    await sleep(5);
    slow = false;
    const closing = flatten(t, 'fw');
    expect(await placing).toBeInstanceOf(BrokerRequestNotSentError);
    await closing;
    expect(t.server.newOrderFrames()).toBe(frames);
    expect(t.store.saved()?.brackets.some((b) => b.tag === 'w2')).toBe(false);
    t.broker.stop();
  });

  it('zavření bez odpovědi: dokud požadavek běží, jiná značka nic neodešle a nové příkazy neprojdou', async () => {
    const t = await setup({ config: { requestTimeoutMs: 500 } });
    await openProtected(t, 'u1');
    t.server.controls.exitPosition = 'ignore';
    expect((await flatten(t, 'fu1')).status).toBe('indeterminate');
    expect((await flatten(t, 'fu2')).status).toBe('indeterminate');
    expect(t.sent(3504)).toBe(1);
    const order = { tag: 'blocked', accountId: t.account(), symbol: 'ESZ6', side: 'Buy' as const, quantity: 1, orderType: 'Limit' as const, limitPrice: 6900 };
    expect(await thrown(t.broker.placeOrder(order))).toBeInstanceOf(BrokerRequestNotSentError);
    // požadavek doběhne bez odpovědi: příkazy stojí dál, ale nové zavírání (čte stav) už smí
    await sleep(350);
    expect(t.incidents.some((i) => i.kind === 'flatten-orders-remain' && /bez odpovědi/.test(i.message))).toBe(true);
    // nohy zrušené, pozice trvá → skutečně nechráněná pozice se ohlásí
    expect(t.kinds()).toContain('bracket-legs-missing');
    expect(await thrown(t.broker.placeOrder(order))).toBeInstanceOf(BrokerRequestNotSentError);
    t.server.controls.exitPosition = 'ok';
    expect((await flatten(t, 'fu3')).status).toBe('submitted');
    expect(t.sent(3504)).toBe(2);
    await sleep(50);
    await t.broker.placeOrder(order);
    t.broker.stop();
  });

  it('připojená značka má vlastní záznam: její opakování po nejistém výsledku nic neodešle', async () => {
    const t = await setup({ config: { requestTimeoutMs: 400 } });
    await openProtected(t, 'j1');
    t.server.controls.exitPosition = 'ignore';
    const [a, b] = await Promise.all([flatten(t, 'ja'), flatten(t, 'jb')]);
    expect([a.status, b.status]).toEqual(['indeterminate', 'indeterminate']);
    await sleep(350); // původní požadavek doběhl
    t.server.controls.exitPosition = 'ok';
    expect((await flatten(t, 'jb')).status).toBe('indeterminate');
    expect(t.sent(3504)).toBe(1);
    expect(t.store.saved()?.flattens.find((f) => f.tag === 'jb')?.phase).toBe('exit-sent');
    t.broker.stop();
  });

  it('vyplnění během důkazu „flat" důkaz ruší: žádné nepravdivé already-flat', async () => {
    const t = await setup();
    const ack = await t.broker.placeOrder({ tag: 'plain', accountId: t.account(), symbol: 'ESZ6', side: 'Buy', quantity: 1, orderType: 'Limit', limitPrice: 7000 });
    await flush();
    t.server.controls.cancelStuck = true; // zrušení „ok", příkaz pracuje dál
    t.server.controls.muteLivePositions = true;
    let reads = 0;
    t.server.hooks.onRequest = (templateId) => {
      if (templateId !== 402) return;
      reads += 1;
      if (reads !== 2) return;
      // vyplní se během čtení pozice; snímek PnL spojení je ještě pozadu a vrátí 0
      t.server.fill(ack.brokerOrderId, 7000);
      t.server.positions.set('ACC1|ESZ6', 0);
      queueMicrotask(() => t.server.positions.set('ACC1|ESZ6', 1));
    };
    const result = await flatten(t, 'fp');
    expect(result.status).toBe('indeterminate');
    expect(t.incidents.some((i) => i.kind === 'flatten-orders-remain' && /přišlo vyplnění/.test(i.message))).toBe(true);
    t.broker.stop();
  });

  it('dřívější zavření s neznámým výsledkem: bez přečtené pozice se další nepošle a ochrana zůstane; veto je časově omezené', async () => {
    const t = await setup({ config: { requestTimeoutMs: 300 } }); // veto = 2× timeout = 600 ms
    await openProtected(t, 'q1');
    t.server.controls.exitPosition = 'ignore';
    expect((await flatten(t, 'fq1')).status).toBe('indeterminate');
    // nový vstup s ochranou vznikne až po vyřešení → nasimulujeme přímo: pozice trvá, nohy fq1 zrušil
    t.server.controls.pnlSnapshotFails = true; // pozici teď nejde přečíst
    t.server.controls.exitPosition = 'ok';
    const cancelsBefore = t.sent(316);
    expect((await flatten(t, 'fq2')).status).toBe('indeterminate');
    expect(t.sent(3504)).toBe(1);
    expect(t.sent(316)).toBe(cancelsBefore); // rozhodnutí padlo dřív, než se sáhlo na příkazy
    // po vypršení veta brzda nestojí: zavře i bez přečtené pozice a ohlásí to
    await sleep(650);
    expect((await flatten(t, 'fq3')).status).toBe('submitted');
    expect(t.sent(3504)).toBe(2);
    expect(t.incidents.some((i) => i.kind === 'attention' && /zavírám znovu/.test(i.message))).toBe(true);
    t.broker.stop();
  });

  it('nevyřešené zavření po restartu: výchozí stav ho vyřeší; do té doby by nové vstupy neprošly', async () => {
    const first = await setup({ config: { requestTimeoutMs: 300 } });
    await openProtected(first, 'r1');
    first.server.controls.exitPosition = 'ignore';
    await flatten(first, 'fr1');
    expect(first.store.saved()?.flattens.find((f) => f.tag === 'fr1')?.phase).toBe('exit-sent');
    first.broker.stop();
    first.server.controls.exitPosition = 'ok';
    const second = await setup({ server: first.server, registryStore: first.registryStore, store: memoryProtectionStore(first.store.saved()), config: { requestTimeoutMs: 300 } });
    expect(second.kinds()).toContain('flatten-interrupted');
    // úplná obnova stavu záznam vyřešila → nové příkazy smějí, zavření proběhne normálně
    expect(second.store.saved()?.flattens.find((f) => f.tag === 'fr1')?.phase).toBe('done');
    expect((await flatten(second, 'fr2')).status).toBe('submitted');
    expect(second.net()).toBe(0);
    second.broker.stop();
  });

  it('přijaté zavření neuvolní kontrakt, dokud ho nepotvrdí stav: druhé volání hned po prvním nic neodešle', async () => {
    const t = await setup({ config: { exitSettleMs: 400 } });
    await openProtected(t, 'd1');
    // server zavření přijme, ale vyplní ho až za chvíli (odpověď ≠ zavřeno)
    t.server.controls.delayExitFill = true;
    expect((await flatten(t, 'fd1')).status).toBe('submitted');
    expect((await flatten(t, 'fd2')).status).toBe('indeterminate');
    expect(t.sent(3504)).toBe(1);
    const order = { tag: 'blk', accountId: t.account(), symbol: 'ESZ6', side: 'Buy' as const, quantity: 1, orderType: 'Limit' as const, limitPrice: 6900 };
    expect(await thrown(t.broker.placeOrder(order))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(t.store.saved()?.flattens.find((f) => f.tag === 'fd1')?.phase).toBe('exit-sent');
    // zavírací příkaz se vyplní → pozice 0 → kontrakt se uvolní
    t.server.releaseExit();
    await sleep(60);
    expect(t.net()).toBe(0);
    await t.broker.placeOrder(order);
    expect(t.store.saved()?.flattens.find((f) => f.tag === 'fd1')?.phase).toBe('done');
    t.broker.stop();
  });

  it('kontrola po zavření proběhne i při nejistém výsledku', async () => {
    const t = await setup({ config: { requestTimeoutMs: 2_000 } });
    await openProtected(t, 'pc');
    t.server.controls.cancelStuck = true;
    t.server.controls.exitPosition = 'ignore';
    expect((await flatten(t, 'fpc')).status).toBe('indeterminate');
    await sleep(120);
    expect(t.incidents.some((i) => i.kind === 'flatten-orders-remain' && /dál pracují/.test(i.message))).toBe(true);
    t.broker.stop();
  });

  it('záznam fáze nejde uložit: brzda pokračuje, ale hlásí, že operace není chráněná proti opakování', async () => {
    const inner = memoryProtectionStore();
    let broken = false;
    const store = { load: () => inner.load(), saved: () => inner.saved(), save: async (state: ProtectionState) => { if (broken) throw new Error('disk'); await inner.save(state); } };
    const t = await setup({ store });
    await openProtected(t, 'ns');
    broken = true;
    expect((await flatten(t, 'fns')).status).toBe('submitted');
    expect(t.incidents.some((i) => i.kind === 'attention' && /není uložená/.test(i.message))).toBe(true);
    expect(t.net()).toBe(0);
    t.broker.stop();
  });
});

describe('zavírání pozice', () => {
  it('šťastná cesta: zrušit nohy → zavřít; jedno zavření, nic nepracuje, žádný šum z CANCELLATION_FAILED', async () => {
    const t = await setup();
    await openProtected(t);
    const result = await flatten(t, 'f1');
    expect(result).toEqual({ status: 'submitted' });
    await sleep(120);
    expect(t.sent(3504)).toBe(1);
    expect(t.net()).toBe(0);
    expect(t.working()).toEqual([]);
    expect(t.kinds()).toEqual([]);
    expect(t.store.saved()?.flattens.find((f) => f.tag === 'f1')?.phase).toBe('done');
    t.broker.stop();
  });

  it('flat účet bez příkazů → already-flat, nic se neposílá', async () => {
    const t = await setup();
    expect(await flatten(t, 'f0')).toEqual({ status: 'already-flat' });
    expect(t.sent(316) + t.sent(3504)).toBe(0);
    t.broker.stop();
  });

  it('pracuje jen nevyplněný vstup: zruší se, pozice 0 → already-flat a žádné zavření', async () => {
    const t = await setup();
    await t.broker.placeBracket(bracket(t, 'rest'));
    await flush();
    expect(await flatten(t, 'f2')).toEqual({ status: 'already-flat' });
    expect(t.sent(3504)).toBe(0);
    expect(t.working()).toEqual([]);
    t.broker.stop();
  });

  it('zrušení nejde potvrdit → zavření se přesto pošle (brzda) a vzniknou incidenty', async () => {
    const t = await setup();
    await openProtected(t);
    t.server.controls.cancelStuck = true;
    expect(await flatten(t, 'f3')).toEqual({ status: 'submitted' });
    await sleep(150);
    expect(t.sent(3504)).toBe(1);
    expect(t.net()).toBe(0);
    expect(t.kinds()).toContain('flatten-cancel-unconfirmed');
    expect(t.kinds()).toContain('flatten-orders-remain');
    t.broker.stop();
  });

  it('čtení příkazů selže → zavření se přesto pošle; známé příkazy z knihy se zruší', async () => {
    const t = await setup();
    await openProtected(t);
    t.server.controls.ignoreShowOrders = true;
    expect(await flatten(t, 'f4')).toEqual({ status: 'submitted' });
    expect(t.sent(3504)).toBe(1);
    expect(t.net()).toBe(0);
    expect(t.working()).toEqual([]);
    t.broker.stop();
  });

  it('odpověď na zavření nepřijde → indeterminate; stejná značka podruhé nic neodešle', async () => {
    const t = await setup();
    await openProtected(t);
    t.server.controls.exitPosition = 'ignore';
    // fáze musí být na disku DŘÍV, než požadavek odejde (pád procesu hned po odeslání)
    let phaseAtSend: string | undefined;
    t.server.hooks.onRequest = (templateId) => {
      if (templateId === 3504) phaseAtSend = t.store.saved()?.flattens.find((f) => f.tag === 'f5')?.phase;
    };
    const first = await flatten(t, 'f5');
    expect(phaseAtSend).toBe('exit-sent');
    expect(first.status).toBe('indeterminate');
    expect(t.store.saved()?.flattens.find((f) => f.tag === 'f5')?.phase).toBe('exit-sent');
    t.server.controls.exitPosition = 'ok';
    const again = await flatten(t, 'f5');
    expect(again.status).toBe('indeterminate');
    expect(t.sent(3504)).toBe(1);
    t.broker.stop();
  });

  it('Rithmic zavření odmítne → rejected, bez textu serveru', async () => {
    const t = await setup();
    await openProtected(t);
    t.server.controls.exitPosition = 'position rejected by risk';
    const result = await flatten(t, 'f6');
    expect(result.status).toBe('rejected');
    expect(JSON.stringify(result)).not.toMatch(/risk/);
    t.broker.stop();
  });

  it('druhé volání během běhu se připojí; nový příkaz i změna na kontraktu se po dobu zavírání neodešlou', async () => {
    const t = await setup();
    await openProtected(t);
    const before = t.server.newOrderFrames();
    const a = flatten(t, 'f7');
    const b = flatten(t, 'f7-jiny');
    expect(await thrown(t.broker.placeOrder({ tag: 'during', accountId: t.account(), symbol: 'ESZ6', side: 'Buy', quantity: 1, orderType: 'Limit', limitPrice: 6900 }))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(await thrown(t.broker.placeBracket(bracket(t, 'during-b')))).toBeInstanceOf(BrokerRequestNotSentError);
    expect(await a).toEqual({ status: 'submitted' });
    expect(await b).toEqual({ status: 'submitted' });
    expect(t.sent(3504)).toBe(1);
    expect(t.server.newOrderFrames()).toBe(before);
    // po skončení už příkazy procházejí
    await t.broker.placeOrder({ tag: 'after', accountId: t.account(), symbol: 'ESZ6', side: 'Buy', quantity: 1, orderType: 'Limit', limitPrice: 6900 });
    t.broker.stop();
  });

  it('vstup se vyplní během rušení: nohy vzniklé pod rukama se zruší ve druhém kole, pak se zavře', async () => {
    const t = await setup();
    const ack = await t.broker.placeBracket(bracket(t, 'race'));
    await flush();
    let fired = false;
    t.server.hooks.onRequest = (templateId, fields) => {
      if (templateId !== 316 || fired || String(fields.basket_id) !== ack.entryBrokerOrderId) return;
      fired = true;
      t.server.fill(ack.entryBrokerOrderId, 7000); // zrušení dorazí po vyplnění
    };
    expect(await flatten(t, 'f8')).toEqual({ status: 'submitted' });
    await sleep(120);
    expect(fired).toBe(true);
    expect(t.sent(3504)).toBe(1);
    expect(t.net()).toBe(0);
    expect(t.working()).toEqual([]);
    expect(t.kinds().filter((k) => k.startsWith('flatten-'))).toEqual([]);
    t.broker.stop();
  });

  it('noha se vyplní během rušení (pozice už je 0) → nic se nezavírá a netvrdí se „odesláno"', async () => {
    const t = await setup();
    const entry = await openProtected(t);
    const target = t.legsOf(entry).find((o) => o.priceType === 1)!;
    let fired = false;
    t.server.hooks.onRequest = (templateId) => {
      if (templateId !== 316 || fired) return;
      fired = true;
      t.server.fill(target.basketId, 7020);
    };
    const result = await flatten(t, 'f9');
    expect(result.status).toBe('already-flat');
    expect(t.sent(3504)).toBe(0);
    expect(t.net()).toBe(0);
    t.broker.stop();
  });

  it('pád spojení během zavírání → indeterminate nebo výjimka, zavření se nepošle dvakrát', async () => {
    const t = await setup({ config: { reconnectMinMs: 5_000 } });
    await openProtected(t);
    t.server.hooks.onRequest = (templateId, _fields, socket) => {
      if (templateId === 3504) socket.drop();
    };
    const result = await flatten(t, 'f10');
    expect(result.status).toBe('indeterminate');
    expect(t.sent(3504)).toBe(1);
    t.broker.stop();
  });

  it('restart uprostřed zavírání: incident flatten-interrupted a tatáž značka se nepošle znovu', async () => {
    const first = await setup();
    await openProtected(first);
    first.server.controls.exitPosition = 'ignore';
    await flatten(first, 'f11');
    first.broker.stop();
    first.server.controls.exitPosition = 'ok';
    // nový proces: tentýž soubor se záznamem (fáze exit-sent)
    const second = await setup({ server: first.server, registryStore: first.registryStore, store: memoryProtectionStore(first.store.saved()) });
    expect(second.kinds()).toContain('flatten-interrupted');
    const before = second.sent(3504);
    const result = await flatten(second, 'f11');
    expect(result.status).toBe('indeterminate');
    expect(second.sent(3504)).toBe(before);
    second.broker.stop();
  });
});
