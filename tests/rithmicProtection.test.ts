/**
 * Vstup se serverovým SL/TP a zavírání pozice v Rithmic adaptéru. Napodobený server se
 * chová podle měření z 16. 11. 2026 (scénář H): nohy vznikají až po vyplnění vstupu, nenesou
 * značku, zrušení jedné nohy zruší i sestru, zavření pozice je samostatný Market bez značky.
 */
import { describe, expect, it } from 'vitest';
import { BrokerRequestNotSentError, type BrokerEvent } from '../services/brokerPort';
import {
  RithmicAccountRegistry,
  type RithmicAccountRegistryEntry,
  type RithmicAccountRegistryStore,
} from '../services/rithmic/rithmicAccountRegistry';
import { createRithmicBroker, type RithmicBrokerConfig, type RithmicIncident } from '../services/rithmic/rithmicBroker';
import { memoryProtectionStore, type ProtectionState, type ProtectionStore } from '../services/rithmic/rithmicProtection';
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
    legsWaitMs: 50, flattenStepMs: 120, flattenCancelWaitMs: 80, flattenPostCheckMs: 40,
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
