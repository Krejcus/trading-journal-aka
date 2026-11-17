/**
 * Místní služba nad Rithmic adaptérem: validace příkazů z appky (nic se tiše nedomýšlí ani
 * nezaokrouhluje), stropy, idempotence přes restart, zastavení po kritickém incidentu.
 */
import { describe, expect, it } from 'vitest';
import {
  RithmicAccountRegistry,
  type RithmicAccountRegistryEntry,
  type RithmicAccountRegistryStore,
} from '../services/rithmic/rithmicAccountRegistry';
import { createRithmicBroker } from '../services/rithmic/rithmicBroker';
import { LocalExec, type LocalExecCommand, type LocalExecConfig } from '../services/rithmic/localExec';
import { memoryProtectionStore, type ProtectionStore } from '../services/rithmic/rithmicProtection';
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

async function setup(options: { server?: Server; registryStore?: RithmicAccountRegistryStore; config?: Partial<LocalExecConfig>; price?: number | null; protectionStore?: ProtectionStore; liveEnvironment?: boolean } = {}) {
  const server = options.server ?? createFakeRithmicServer();
  const registryStore = options.registryStore ?? memoryRegistryStore();
  const registry = new RithmicAccountRegistry(registryStore);
  await registry.load();
  let exec: LocalExec | null = null;
  const broker = createRithmicBroker({
    url: 'wss://fake', credentials, socketFactory: server.socketFactory, registry, protectionStore: options.protectionStore ?? memoryProtectionStore(),
    onIncident: (incident) => exec?.onIncident(incident),
    requestTimeoutMs: 150, confirmWaitMs: 60, fillWaitMs: 60, reconnectMinMs: 20, reconnectMaxMs: 40,
    legsWaitMs: 25, exitSettleMs: 100, flattenStepMs: 120, flattenCancelWaitMs: 80, flattenPostCheckMs: 40,
  });
  let price: number | null = options.price === undefined ? 7000 : options.price;
  exec = new LocalExec({
    // `liveEnvironment`: stejný adaptér, jen se hlásí jako skutečné prostředí (zkouška pojistek skutečného účtu).
    broker: options.liveEnvironment ? new Proxy(broker, { get: (target, key) => (key === 'environment' ? 'live' : Reflect.get(target, key)) }) : broker,
    symbols: { ESZ6: { tickSize: 0.25 } }, maxQuantity: 2, maxPosition: 2, systemName: 'Rithmic Test', allowedSystems: ['Rithmic Test'],
    serverPrice: () => price, serverQuote: () => (price === null ? null : { bid: price, ask: price + 0.25 }), ...options.config,
  });
  exec.attach();
  await broker.start();
  const run = (command: unknown) => exec!.execute(command as LocalExecCommand);
  const frames = () => server.newOrderFrames();
  return { server, broker, exec, run, frames, registryStore, setPrice: (next: number | null) => { price = next; } };
}

const entry = (extra: Record<string, unknown> = {}) => ({ op: 'entry', clientId: `c${Math.random().toString(36).slice(2, 10)}`, symbol: 'ESZ6', side: 'Buy', quantity: 1, orderType: 'Limit', limitPrice: 6990, stopPrice: 6980, targetPrice: 7010, ...extra });

describe('místní služba: validace vstupu', () => {
  it('platný Limit se SL/TP odejde jako vstup s ochranou ve správných tickách', async () => {
    const t = await setup();
    const reply = await t.run(entry());
    expect(reply).toMatchObject({ ok: true, result: { stopTicks: 40, targetTicks: 80 } });
    expect(t.frames()).toBe(1);
    await flush();
    // čekající vstup nese plánované SL/TP (od limitní ceny) pro zobrazení
    expect(t.exec.state().orders[0]).toMatchObject({ role: 'entry', price: 6990, plannedStop: 6980, plannedTarget: 7010 });
    t.broker.stop();
  });

  it('nic se nedomýšlí: špatná strana, null místo ceny, cena mimo krok, neznámý typ → neodesláno', async () => {
    const t = await setup();
    for (const bad of [
      entry({ side: 'buy' }), entry({ side: undefined }), entry({ side: 'buy', stopPrice: undefined, targetPrice: undefined }), entry({ stopPrice: null }), entry({ targetPrice: null }), entry({ limitPrice: '6990' }),
      entry({ stopPrice: 6979.6 }), entry({ orderType: 'Stop' }), entry({ quantity: 1.5 }), entry({ quantity: 3 }), entry({ symbol: 'NQZ6' }),
      entry({ clientId: 'x'.repeat(31) }), entry({ clientId: 'má mezeru' }), { op: 'nesmysl' }, null,
    ]) {
      const reply = await t.run(bad);
      expect(reply, JSON.stringify(bad)).toMatchObject({ ok: false, sent: false });
    }
    expect(t.frames()).toBe(0);
    t.broker.stop();
  });

  it('SL/TP na špatné straně nebo příliš daleko; Limit se SL/TP přes trh → neodesláno', async () => {
    const t = await setup();
    expect(await t.run(entry({ stopPrice: 6995 }))).toMatchObject({ ok: false, sent: false });
    expect(await t.run(entry({ stopPrice: 6800 }))).toMatchObject({ ok: false, sent: false }); // 760 ticků
    expect(await t.run(entry({ limitPrice: 7005, stopPrice: 6995, targetPrice: 7025 }))).toMatchObject({ ok: false, sent: false });
    expect(t.frames()).toBe(0);
    t.broker.stop();
  });

  it('Market: SL/TP se počítá od ceny služby; zastaralá cena z appky vstup zastaví', async () => {
    const t = await setup();
    // appka má cenu o 24 ticků jinde než služba; SL i TP by přitom vůči ceně služby dávaly smysl
    const stale = await t.run(entry({ orderType: 'Market', limitPrice: undefined, referencePrice: 7006, stopPrice: 6990, targetPrice: 7020 }));
    expect(stale).toMatchObject({ ok: false, sent: false });
    const ok = await t.run(entry({ orderType: 'Market', limitPrice: undefined, referencePrice: 7000.5, stopPrice: 6990, targetPrice: 7020 }));
    expect(ok).toMatchObject({ ok: true, result: { stopTicks: 40, targetTicks: 80 } }); // od 7000 (cena služby), ne od 7000,5
    t.broker.stop();
  });

  it('strop pozice počítá otevřenou pozici i čekající vstupy', async () => {
    const t = await setup({ config: { maxPosition: 2 } });
    expect((await t.run(entry({ quantity: 2 }))).ok).toBe(true);
    await flush();
    // čekající vstup: další nejde (jeden vlastní vstup najednou), ať už by se do stropu vešel nebo ne
    expect(await t.run(entry())).toMatchObject({ ok: false, sent: false });
    // ani Market s jinými SL/TP — později by se čekající vstup vyplnil do jeho pozice
    expect(await t.run(entry({ orderType: 'Market', limitPrice: undefined, referencePrice: 7000, stopPrice: 6985, targetPrice: 7025 }))).toMatchObject({ ok: false, sent: false });
    expect(t.frames()).toBe(1);
    t.broker.stop();
  });

  it('souběžné vstupy strop pozice neobejdou; chráněný Market bez ceny služby neodejde', async () => {
    const t = await setup({ config: { maxPosition: 2 } });
    const replies = await Promise.all([t.run(entry({ quantity: 2 })), t.run(entry({ quantity: 2 }))]);
    expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
    expect(t.frames()).toBe(1);
    t.broker.stop();
    const blind = await setup({ price: null });
    expect(await blind.run(entry({ orderType: 'Market', limitPrice: undefined, referencePrice: 7000, stopPrice: 6990, targetPrice: 7020 }))).toMatchObject({ ok: false, sent: false });
    expect(blind.frames()).toBe(0);
    blind.broker.stop();
  });

  it('vyplněný vstup se do stropu počítá i dřív, než přijde zpráva o pozici', async () => {
    const t = await setup({ config: { maxPosition: 2 } });
    const placed = await t.run(entry({ quantity: 2, stopPrice: undefined, targetPrice: undefined }));
    await flush();
    t.server.controls.muteLivePositions = true; // pozice z PnL spojení se opozdí
    t.server.fill((placed as { result: { orderId: string } }).result.orderId, 6990);
    await flush();
    expect(await t.run(entry({ quantity: 2 }))).toMatchObject({ ok: false, sent: false });
    // opožděná zpráva o nulové pozici (z doby před vyplněním) rezervu neuvolní
    t.server.controls.muteLivePositions = false;
    t.server.pushLivePosition('ACC1', 'ESZ6', 0);
    await flush();
    expect(await t.run(entry({ quantity: 2 }))).toMatchObject({ ok: false, sent: false });
    expect(t.frames()).toBe(1);
    t.broker.stop();
  });

  it('stejné clientId podruhé neodejde — ani po restartu služby (kniha zná dnešní značky)', async () => {
    const t = await setup();
    const command = entry({ clientId: 'same-1', stopPrice: undefined, targetPrice: undefined }); // obyčejný příkaz bez ochrany
    expect((await t.run(command)).ok).toBe(true);
    expect(await t.run(command)).toMatchObject({ ok: false, sent: false });
    await flush();
    t.broker.stop();
    const again = await setup({ server: t.server, registryStore: t.registryStore });
    expect(await again.run(command)).toMatchObject({ ok: false, sent: false });
    expect(again.frames()).toBe(1);
    again.broker.stop();
  });

  it('nepovolený systém: služba neodešle nic', async () => {
    const t = await setup({ config: { allowedSystems: ['Jiný systém'] } });
    expect(await t.run(entry())).toMatchObject({ ok: false, sent: false });
    expect(t.frames()).toBe(0);
    t.broker.stop();
  });
});

describe('místní služba: Stop vstup', () => {
  it('Stop vstup jde jen se spouští za trhem a s cenou služby; SL/TP se počítají od spouště; posun zatím ne', async () => {
    const t = await setup();
    const stop = (extra: Record<string, unknown> = {}) => entry({ orderType: 'Stop', limitPrice: undefined, triggerPrice: 7010, stopPrice: 7000, targetPrice: 7030, ...extra });
    const frames = t.frames();
    // spoušť na špatné straně (cena služby 7000): nákup pod trhem, prodej nad trhem; bez spouště; mimo krok
    expect(await t.run(stop({ triggerPrice: 6995, stopPrice: 6985, targetPrice: 7015 }))).toMatchObject({ ok: false, sent: false });
    expect(await t.run(stop({ side: 'Sell', triggerPrice: 7010, stopPrice: 7020, targetPrice: 6990 }))).toMatchObject({ ok: false, sent: false });
    expect(await t.run(stop({ triggerPrice: undefined }))).toMatchObject({ ok: false, sent: false });
    expect(await t.run(stop({ triggerPrice: 7010.1 }))).toMatchObject({ ok: false, sent: false });
    t.setPrice(null);
    expect(await t.run(stop())).toMatchObject({ ok: false, sent: false });
    t.setPrice(7000);
    expect(t.frames()).toBe(frames);
    const placed = await t.run(stop());
    expect(placed.ok).toBe(true);
    await flush();
    const entryId = (placed as { result: { orderId: string; stopTicks: number; targetTicks: number } }).result.orderId;
    expect((placed as { result: { stopTicks: number; targetTicks: number } }).result).toMatchObject({ stopTicks: 40, targetTicks: 80 });
    expect(t.server.orders.get(entryId)).toMatchObject({ priceType: 4, triggerPrice: 7010, side: 1 });
    expect(t.exec.state().orders.find((o) => o.orderId === entryId)).toMatchObject({ role: 'entry', entryType: 'Stop', price: 7010, plannedStop: 7000, plannedTarget: 7030 });
    // burza později hlásí ochranný limit (spoušť + 15 b) ve zprávě bez typu ceny → vstup zůstává Stopem na spoušti
    t.server.notifyLive(entryId, 1, { price: 7025, price_type: undefined });
    await sleep(60);
    expect(t.exec.state().orders.find((o) => o.orderId === entryId)).toMatchObject({ role: 'entry', entryType: 'Stop', price: 7010, plannedStop: 7000, plannedTarget: 7030 });
    // posun Stop vstupu: jen spoušť, ochrana (vzdálenosti) jde s ním; spoušť nesmí přejít na druhou stranu trhu
    expect(await t.run({ op: 'move', orderId: entryId, price: 6999 })).toMatchObject({ ok: false, sent: false });
    expect(await t.run({ op: 'move', orderId: entryId, price: 7012.1 })).toMatchObject({ ok: false, sent: false });
    expect((await t.run({ op: 'move', orderId: entryId, price: 7012 })).ok).toBe(true);
    expect(t.server.orders.get(entryId)).toMatchObject({ priceType: 4, triggerPrice: 7012 });
    expect(t.exec.state().orders.find((o) => o.orderId === entryId)).toMatchObject({ role: 'entry', entryType: 'Stop', price: 7012, plannedStop: 7002, plannedTarget: 7032 });
    t.setPrice(null);
    expect(await t.run({ op: 'move', orderId: entryId, price: 7014 })).toMatchObject({ ok: false, sent: false });
    t.broker.stop();
  });

  it('Stop vstup bez SL/TP odejde jako obyčejný Stop', async () => {
    const t = await setup();
    const placed = await t.run(entry({ orderType: 'Stop', limitPrice: undefined, triggerPrice: 7010, stopPrice: undefined, targetPrice: undefined }));
    expect(placed.ok).toBe(true);
    await flush();
    const entryId = (placed as { result: { orderId: string } }).result.orderId;
    expect(t.server.orders.get(entryId)).toMatchObject({ priceType: 4, triggerPrice: 7010 });
    expect(t.exec.state().orders.find((o) => o.orderId === entryId)).toMatchObject({ role: 'entry', entryType: 'Stop', price: 7010 });
    // posun holého Stopu: jen spoušť, na správné straně trhu
    expect(await t.run({ op: 'move', orderId: entryId, price: 7000 })).toMatchObject({ ok: false, sent: false });
    expect((await t.run({ op: 'move', orderId: entryId, price: 7006 })).ok).toBe(true);
    expect(t.server.orders.get(entryId)).toMatchObject({ priceType: 4, triggerPrice: 7006 });
    t.broker.stop();
  });
});

describe('místní služba: skutečný účet je vypnutý, dokud ho nezapne platný souhlas', () => {
  it('bez nastavení skutečného obchodování služba mimo demo odmítne všechno', async () => {
    const t = await setup({ liveEnvironment: true });
    const frames = t.frames();
    expect(await t.run(entry())).toMatchObject({ ok: false, sent: false });
    expect(await t.run({ op: 'flatten', clientId: 'f1', symbol: 'ESZ6' })).toMatchObject({ ok: false, sent: false });
    expect(t.frames()).toBe(frames);
    t.broker.stop();
  });

  it('s platným souhlasem jde vstup jen se SL; bez souhlasu nevznikne nová expozice, ale zavření a rušení jdou dál', async () => {
    let problem: string | null = null;
    const t = await setup({ liveEnvironment: true, config: { liveTrading: { problem: () => problem, requireStop: true }, positionSettleMs: 20 } });
    // vstup bez SL ne
    expect(await t.run(entry({ stopPrice: undefined, targetPrice: undefined }))).toMatchObject({ ok: false, sent: false, error: expect.stringMatching(/SL/) });
    const placed = await t.run(entry());
    expect(placed.ok).toBe(true);
    await flush();
    const entryId = (placed as { result: { orderId: string } }).result.orderId;
    // souhlas vypršel / byl smazán: další vstup ne, zrušení čekajícího ano
    problem = 'souhlas vypršel';
    const frames = t.frames();
    expect(await t.run(entry({ limitPrice: 6985 }))).toMatchObject({ ok: false, sent: false, error: expect.stringMatching(/vypnuté: souhlas vypršel/) });
    expect(t.frames()).toBe(frames);
    expect((await t.run({ op: 'cancel', orderId: entryId })).ok).toBe(true);
    t.broker.stop();
  });

  it('Rithmic Paper Trading (pro adaptér demo) je skutečný účet: bez souhlasu nic, s vypršelým souhlasem žádný vstup', async () => {
    const paper = { systemName: 'Rithmic Paper Trading', allowedSystems: ['Rithmic Paper Trading'] };
    const none = await setup({ config: paper });
    expect(await none.run(entry())).toMatchObject({ ok: false, sent: false, error: expect.stringMatching(/testovací prostředí/) });
    none.broker.stop();
    const expired = await setup({ config: { ...paper, liveTrading: { problem: () => 'souhlas vypršel', requireStop: true } } });
    const frames = expired.frames();
    expect(await expired.run(entry())).toMatchObject({ ok: false, sent: false, error: expect.stringMatching(/souhlas vypršel/) });
    expect(expired.frames()).toBe(frames);
    expired.broker.stop();
  });

  it('po skončení souhlasu: čekající vstup nejde posunout (jen zrušit), ohlásí se incidentem; ochrana a zavření jdou dál', async () => {
    let problem: string | null = null;
    const t = await setup({ liveEnvironment: true, config: { liveTrading: { problem: () => problem, requireStop: true }, positionSettleMs: 20, protectiveGraceMs: 40 } });
    const placed = await t.run(entry());
    await flush();
    const entryId = (placed as { result: { orderId: string } }).result.orderId;
    expect((await t.run({ op: 'move', orderId: entryId, price: 6985 })).ok).toBe(true);
    problem = 'souhlas vypršel';
    expect(await t.run({ op: 'move', orderId: entryId, price: 6999 })).toMatchObject({ ok: false, sent: false, error: expect.stringMatching(/jen zrušit/) });
    expect(t.server.orders.get(entryId)!.price).toBe(6985);
    t.exec.checkConsent();
    t.exec.checkConsent();
    expect(t.exec.state().incidents.filter((incident) => incident.kind === 'consent-ended-entries-working')).toHaveLength(1);
    // vstup se vyplní → správa ochrany a zavření fungují i bez souhlasu
    t.server.fill(entryId, 6985);
    await sleep(120);
    const stop = t.exec.state().orders.find((o) => o.role === 'stop')!;
    expect((await t.run({ op: 'move', orderId: stop.orderId, price: 6978 })).ok).toBe(true);
    expect((await t.run({ op: 'flatten', clientId: 'f1', symbol: 'ESZ6' })).ok).toBe(true);
    t.broker.stop();
  });

  it('souhlas odvolaný během ukládání záměru vstup zastaví; chyba při čtení souhlasu nezablokuje zavření', async () => {
    const base = memoryProtectionStore();
    let delay = 0;
    const slow: ProtectionStore = { load: () => base.load(), save: async (state) => { if (delay) await sleep(delay); await base.save(state); } };
    let problem: (() => string | null) = () => null;
    const t = await setup({ liveEnvironment: true, protectionStore: slow, config: { liveTrading: { problem: () => problem(), requireStop: true } } });
    const frames = t.frames();
    delay = 150;
    const pending = t.run(entry());
    await sleep(40);
    problem = () => 'souhlas odvolán';
    expect(await pending).toMatchObject({ ok: false, sent: false, error: expect.stringMatching(/souhlas odvolán/) });
    delay = 0;
    expect(t.frames()).toBe(frames);
    // čtení souhlasu vyhodí chybu → vstup ne, zavření ano
    problem = () => { throw new Error('soubor zmizel'); };
    expect(await t.run(entry({ limitPrice: 6985 }))).toMatchObject({ ok: false, sent: false, error: expect.stringMatching(/nejde ověřit/) });
    expect((await t.run({ op: 'flatten', clientId: 'f2', symbol: 'ESZ6' })).ok).toBe(true);
    t.broker.stop();
  });

  it('se souhlasem bez povinného SL projde i holý vstup', async () => {
    const t = await setup({ liveEnvironment: true, config: { liveTrading: { problem: () => null, requireStop: false } } });
    expect((await t.run(entry({ stopPrice: undefined, targetPrice: undefined }))).ok).toBe(true);
    t.broker.stop();
  });
});

describe('místní služba: výsledek zavřeného obchodu z vyplnění (jen zobrazení)', () => {
  it('SL: vstup 6990, výstup 6980 → −10 b, důvod sl', async () => {
    const t = await setup({ config: { positionSettleMs: 20 } });
    const placed = await t.run(entry({ limitPrice: 6990, stopPrice: 6980, targetPrice: 7030 }));
    await flush();
    t.server.fill((placed as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(120);
    expect(t.exec.state().closes).toEqual([]);
    const stop = t.exec.state().orders.find((o) => o.role === 'stop')!;
    t.server.fill(stop.orderId, 6980);
    await sleep(120);
    expect(t.exec.state().closes).toHaveLength(1);
    expect(t.exec.state().closes[0]).toMatchObject({ symbol: 'ESZ6', side: 'long', quantity: 1, entryAvg: 6990, exitAvg: 6980, pointsTotal: -10, reason: 'sl' });
    t.broker.stop();
  });
});

describe('místní služba: výsledek zavření jen s potvrzenou nulovou pozicí', () => {
  it('vyplnění, které nulovou pozici nepotvrdí, kartu nevyrobí (začátek obchodu služba neviděla)', async () => {
    const t = await setup({ config: { positionSettleMs: 20 } });
    // Zprávy o pozici nechodí: služba vidí jen vyplnění, nulu jí nikdo nepotvrdí.
    t.server.controls.muteLivePositions = true;
    const placed = await t.run(entry({ limitPrice: 6990, stopPrice: 6980, targetPrice: 7030 }));
    await flush();
    t.server.fill((placed as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(120);
    const stop = [...t.server.orders.values()].find((o) => o.priceType === 4 && o.status === 'open')!;
    await sleep(2_100); // poslední zpráva o pozici je starší než 2 s
    t.server.fill(stop.basketId, 6980);
    await sleep(150);
    expect(t.exec.state().closes).toEqual([]);
    t.broker.stop();
  });
});

describe('místní služba: druhá noha k pozici = svázaný pár SL+TP (OCO)', () => {
  const protect = (extra: Record<string, unknown> = {}) => ({ op: 'protect', clientId: `p${Math.random().toString(36).slice(2, 10)}`, symbol: 'ESZ6', kind: 'stop', price: 6980, ...extra });
  async function bareWithStop(config: Record<string, unknown> = {}) {
    const t = await setup({ config: { protectiveGraceMs: 40, positionSettleMs: 20, moveConfirmMs: 200, ...config } });
    const bare = await t.run(entry({ stopPrice: undefined, targetPrice: undefined }));
    await flush();
    t.server.fill((bare as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(80);
    const placed = await t.run(protect());
    expect(placed.ok).toBe(true);
    await sleep(60);
    return { t, stopId: (placed as { result: { orderId: string } }).result.orderId };
  }

  it('SL a potom TP: původní SL se zruší a obě nohy se zadají jedním zápisem jako svázaný pár; vyplnění TP zruší SL', async () => {
    const { t, stopId } = await bareWithStop();
    const frames = t.frames();
    const added = await t.run(protect({ kind: 'target', price: 7010 }));
    expect(added).toMatchObject({ ok: true, result: { paired: true } });
    expect(t.frames()).toBe(frames + 1); // právě jeden nový zápis (328)
    expect(t.server.orders.get(stopId)!.status).toBe('cancelled');
    await sleep(60);
    const open = [...t.server.orders.values()].filter((o) => o.status === 'open');
    expect(open).toHaveLength(2);
    expect(open.map((o) => o.priceType).sort()).toEqual([1, 4]);
    expect(open.every((o) => o.userTag.startsWith('uiprot-') && o.oco !== undefined && o.side === 2 && o.quantity === 1)).toBe(true);
    expect(open.find((o) => o.priceType === 4)!.triggerPrice).toBe(6980);
    expect(open.find((o) => o.priceType === 1)!.price).toBe(7010);
    const state = t.exec.state();
    expect(state.orders.map((o) => o.role).sort()).toEqual(['stop', 'target']);
    expect(state.blocked).toBeNull();
    // třetí ochrana ne; zrušení jedné nohy u otevřené pozice ne (zmizely by obě); posun ano
    expect(await t.run(protect({ kind: 'target', price: 7012 }))).toMatchObject({ ok: false, sent: false });
    const target = state.orders.find((o) => o.role === 'target')!;
    expect(await t.run({ op: 'cancel', orderId: target.orderId })).toMatchObject({ ok: false, sent: false, error: expect.stringMatching(/svázané/) });
    expect((await t.run({ op: 'move', orderId: target.orderId, price: 7008 })).ok).toBe(true);
    await sleep(60);
    // TP se vyplní → burza zruší SL, pozice 0, nic nezbylo a nic se nehlásí
    t.server.fill(target.orderId, 7008);
    await sleep(150);
    expect(t.exec.state().positions).toEqual([]);
    expect(t.exec.state().orders).toEqual([]);
    expect(t.exec.state().blocked).toBeNull();
    expect(t.exec.state().closes.at(-1)).toMatchObject({ reason: 'tp', pointsTotal: 18 });
    t.broker.stop();
  });

  it('SL i TP najednou k pozici bez příkazů: jeden zápis, svázaný pár; špatné ceny a pozice s příkazem ne', async () => {
    const t = await setup({ config: { protectiveGraceMs: 40, positionSettleMs: 20, moveConfirmMs: 200 } });
    const both = (extra: Record<string, unknown> = {}) => ({ op: 'protect-pair', clientId: `b${Math.random().toString(36).slice(2, 10)}`, symbol: 'ESZ6', stopPrice: 6980, targetPrice: 7010, ...extra });
    expect(await t.run(both())).toMatchObject({ ok: false, sent: false }); // bez pozice
    const bare = await t.run(entry({ stopPrice: undefined, targetPrice: undefined }));
    await flush();
    t.server.fill((bare as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(80);
    const frames = t.frames();
    expect(await t.run(both({ stopPrice: 7005 }))).toMatchObject({ ok: false, sent: false });
    expect(await t.run(both({ targetPrice: 6995 }))).toMatchObject({ ok: false, sent: false });
    expect(await t.run(both({ stopPrice: 6980.1 }))).toMatchObject({ ok: false, sent: false });
    expect(t.frames()).toBe(frames);
    expect(await t.run(both())).toMatchObject({ ok: true, result: { paired: true } });
    expect(t.frames()).toBe(frames + 1);
    await sleep(60);
    const open = [...t.server.orders.values()].filter((o) => o.status === 'open');
    expect(open).toHaveLength(2);
    expect(new Set(open.map((o) => o.oco)).size).toBe(1);
    expect(t.exec.state().orders.map((o) => o.role).sort()).toEqual(['stop', 'target']);
    // druhý pár ani další ochrana k pozici s párem ne
    expect(await t.run(both())).toMatchObject({ ok: false, sent: false });
    expect(await t.run(protect())).toMatchObject({ ok: false, sent: false });
    t.broker.stop();
  });

  it('TP a potom SL funguje stejně', async () => {
    const t = await setup({ config: { protectiveGraceMs: 40, positionSettleMs: 20, moveConfirmMs: 200 } });
    const bare = await t.run(entry({ stopPrice: undefined, targetPrice: undefined }));
    await flush();
    t.server.fill((bare as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(80);
    expect((await t.run(protect({ kind: 'target', price: 7010 }))).ok).toBe(true);
    await sleep(60);
    expect(await t.run(protect({ kind: 'stop', price: 6984 }))).toMatchObject({ ok: true, result: { paired: true } });
    await sleep(60);
    const open = [...t.server.orders.values()].filter((o) => o.status === 'open');
    expect(open.find((o) => o.priceType === 4)!.triggerPrice).toBe(6984);
    expect(open.find((o) => o.priceType === 1)!.price).toBe(7010);
    t.broker.stop();
  });

  it('zrušení původní nohy se nepotvrdí → pár se nezadá, vstupy stojí; nic se neopakuje', async () => {
    const { t, stopId } = await bareWithStop();
    t.server.controls.cancelStuck = true;
    const frames = t.frames();
    const reply = await t.run(protect({ kind: 'target', price: 7010 }));
    expect(reply).toMatchObject({ ok: false, sent: 'unknown', error: expect.stringMatching(/není potvrzené/) });
    expect(t.frames()).toBe(frames);
    expect(t.server.orders.get(stopId)!.status).toBe('open');
    expect(t.exec.state().blocked).toMatch(/^protect-replace-uncertain/);
    t.broker.stop();
  });

  it('burza nový pár odmítne → pozice je bez ochrany: incident, blokace vstupů, žádný další pokus', async () => {
    const { t } = await bareWithStop();
    t.server.controls.rejectNextOrder = 'outside bands';
    const frames = t.frames();
    const reply = await t.run(protect({ kind: 'target', price: 7010 }));
    expect(reply).toMatchObject({ ok: false, sent: 'unknown', error: expect.stringMatching(/BEZ ochrany|není znám/) });
    expect(t.frames()).toBe(frames + 1);
    await sleep(60);
    expect([...t.server.orders.values()].filter((o) => o.status === 'open')).toHaveLength(0);
    expect(t.exec.state().blocked).toMatch(/^protection-removed/);
    expect(t.exec.state().positions).toEqual([expect.objectContaining({ netQuantity: 1 })]);
    // bez potvrzení další ochrana ne (na burze může pracovat pár, o kterém služba neví)
    expect(await t.run(protect())).toMatchObject({ ok: false, sent: false, error: expect.stringMatching(/nejistě/) });
    // po potvrzení jde ochranu zadat znovu (jeden SL)
    await t.run({ op: 'ack' });
    expect((await t.run(protect())).ok).toBe(true);
    t.broker.stop();
  });

  it('dva požadavky na druhou nohu současně → právě jeden pár, žádný třetí výstup; vstup během výměny neprojde', async () => {
    const { t } = await bareWithStop();
    const [a, b, c] = await Promise.all([
      t.run(protect({ kind: 'target', price: 7010 })),
      t.run(protect({ kind: 'target', price: 7012 })),
      t.run(entry({ orderType: 'Market', limitPrice: undefined, referencePrice: 7000, stopPrice: 6980, targetPrice: 7030 })),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(c).toMatchObject({ ok: false, sent: false });
    await sleep(80);
    const open = [...t.server.orders.values()].filter((o) => o.status === 'open');
    expect(open).toHaveLength(2);
    expect(new Set(open.map((o) => o.oco)).size).toBe(1);
    t.broker.stop();
  });

  it('značka výměny: zapsaná před zrušením, smazaná po úspěchu; po pádu uprostřed ji nová služba ohlásí a drží ochranu do potvrzení', async () => {
    let marker: { symbol: string; at: number } | null = null;
    const writes: Array<string | null> = [];
    const replaceMarker = { read: () => marker, write: (value: { symbol: string; at: number } | null) => { marker = value; writes.push(value?.symbol ?? null); } };
    const { t } = await bareWithStop({ replaceMarker });
    expect((await t.run(protect({ kind: 'target', price: 7010 }))).ok).toBe(true);
    expect(writes).toEqual(['ESZ6', null]);
    t.broker.stop();
    // nová služba najde značku z minulého běhu (pád mezi zrušením a párem)
    marker = { symbol: 'ESZ6', at: 1 };
    const next = await setup({ config: { replaceMarker } });
    await sleep(40);
    expect(next.exec.state().blocked).toMatch(/^protect-replace-interrupted/);
    expect(await next.run(entry())).toMatchObject({ ok: false, sent: false });
    await next.run({ op: 'ack' });
    expect(marker).toBeNull();
    expect(next.exec.state().blocked).toBeNull();
    next.broker.stop();
  });

  it('cena mezitím u stávající ochrany → nic se neruší ani nezadává', async () => {
    const { t, stopId } = await bareWithStop();
    t.setPrice(6979);
    const frames = t.frames();
    expect(await t.run(protect({ kind: 'target', price: 7010 }))).toMatchObject({ ok: false, sent: false });
    expect(t.server.orders.get(stopId)!.status).toBe('open');
    expect(t.frames()).toBe(frames);
    t.broker.stop();
  });
});

describe('místní služba: částečné zavření přes vlastní TP jedné ochrany', () => {
  async function twoParts() {
    const t = await setup({ config: { positionSettleMs: 20, reduceConfirmMs: 300 } });
    const first = await t.run(entry({ limitPrice: 6990, stopPrice: 6980, targetPrice: 7030 }));
    await flush();
    t.server.fill((first as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(120);
    return t;
  }
  async function addOne(t: Awaited<ReturnType<typeof twoParts>>) {
    const added = await t.run(entry({ orderType: 'Market', limitPrice: undefined, referencePrice: 7000, stopPrice: 6980, targetPrice: 7030 }));
    expect(added.ok).toBe(true);
    await flush();
    t.server.fill((added as { result: { orderId: string } }).result.orderId, 7000);
    await sleep(160);
  }

  it('jedna ochrana → nejde; dvě ochrany → jeden zápis na TP za trh, úspěch až po zmenšení pozice', async () => {
    const t = await twoParts();
    expect(await t.run({ op: 'reduce', clientId: 'r0', symbol: 'ESZ6' })).toMatchObject({ ok: false, sent: false });
    await addOne(t);
    expect(t.exec.state().positions).toEqual([expect.objectContaining({ netQuantity: 2 })]);
    const targets = t.exec.state().orders.filter((o) => o.role === 'target');
    expect(targets).toHaveLength(2);
    const frames = t.frames();
    const pending = t.run({ op: 'reduce', clientId: 'r1', symbol: 'ESZ6' });
    await sleep(60);
    // právě jeden TP je teď za trhem (7000 − 8 ticků = 6998), druhý beze změny; žádný nový příkaz
    const moved = targets.map((o) => t.server.orders.get(o.orderId)!).filter((o) => o.price === 6998);
    expect(moved).toHaveLength(1);
    expect(t.frames()).toBe(frames);
    t.server.fill(moved[0].basketId, 6999.75);
    const reply = await pending;
    expect(reply).toMatchObject({ ok: true, result: { quantity: 1, price: 6998 } });
    await sleep(120);
    const state = t.exec.state();
    expect(state.positions).toEqual([expect.objectContaining({ netQuantity: 1 })]);
    expect(state.orders.filter((o) => o.role === 'stop')).toHaveLength(1);
    expect(state.orders.filter((o) => o.role === 'target')).toHaveLength(1);
    expect(state.blocked).toBeNull();
    t.broker.stop();
  });

  it('výstup se nevyplní do lhůty → výsledek není znám, nic se neopakuje ani nevrací', async () => {
    const t = await twoParts();
    await addOne(t);
    const reply = await t.run({ op: 'reduce', clientId: 'r2', symbol: 'ESZ6' });
    expect(reply).toMatchObject({ ok: false, sent: 'unknown', error: expect.stringMatching(/nevyplnil/) });
    expect(t.exec.state().positions).toEqual([expect.objectContaining({ netQuantity: 2 })]);
    expect([...t.server.orders.values()].filter((o) => o.status === 'open' && o.price === 6998)).toHaveLength(1);
    t.broker.stop();
  });

  it('cena výstupu jde od nabídky kupců, ne od posledního obchodu', async () => {
    const quote = { bid: 6997, ask: 7001 };
    const t = await setup({ config: { positionSettleMs: 20, reduceConfirmMs: 120, serverQuote: () => quote } });
    const first = await t.run(entry({ limitPrice: 6990, stopPrice: 6980, targetPrice: 7030 }));
    await flush();
    t.server.fill((first as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(120);
    await addOne(t);
    await t.run({ op: 'reduce', clientId: 'q1', symbol: 'ESZ6' });
    // 6997 − 8 ticků = 6995
    expect([...t.server.orders.values()].filter((o) => o.status === 'open' && o.price === 6995)).toHaveLength(1);
    t.broker.stop();
  });

  it('pozice klesne kvůli SL druhé části, výstup dál pracuje → žádný úspěch; nejistý krok zastaví další posuny do potvrzení', async () => {
    const t = await twoParts();
    await addOne(t);
    const stops = t.exec.state().orders.filter((o) => o.role === 'stop');
    const pending = t.run({ op: 'reduce', clientId: 'r5', symbol: 'ESZ6' });
    await sleep(60);
    const moved = [...t.server.orders.values()].find((o) => o.status === 'open' && o.price === 6998)!;
    const otherStop = stops.map((o) => t.server.orders.get(o.orderId)!).find((o) => o.parent !== moved.parent)!;
    t.server.fill(otherStop.basketId, 6980);
    expect(await pending).toMatchObject({ ok: false, sent: 'unknown' });
    // stejná zpráva podruhé nic neodešle; posun noh stojí do potvrzení
    expect(await t.run({ op: 'reduce', clientId: 'r5', symbol: 'ESZ6' })).toMatchObject({ ok: false, sent: false });
    const leftStop = t.exec.state().orders.find((o) => o.role === 'stop')!;
    expect(await t.run({ op: 'move', orderId: leftStop.orderId, price: 6978 })).toMatchObject({ ok: false, sent: false });
    t.broker.stop();
  });

  it('bez čerstvé nabídky a poptávky se částečné zavření neodešle', async () => {
    const t = await setup({ config: { positionSettleMs: 20, serverQuote: () => null } });
    const first = await t.run(entry({ limitPrice: 6990, stopPrice: 6980, targetPrice: 7030 }));
    await flush();
    t.server.fill((first as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(120);
    await addOne(t);
    const frames = t.frames();
    expect(await t.run({ op: 'reduce', clientId: 'r6', symbol: 'ESZ6' })).toMatchObject({ ok: false, sent: false, error: expect.stringMatching(/nabídku a poptávku/) });
    expect([...t.server.orders.values()].filter((o) => o.status === 'open' && o.priceType === 1 && o.price !== 7030)).toHaveLength(0);
    expect(t.frames()).toBe(frames);
    t.broker.stop();
  });

  it('bez ceny služby a s trhem u SL se nic neodešle', async () => {
    const t = await twoParts();
    await addOne(t);
    t.setPrice(null);
    expect(await t.run({ op: 'reduce', clientId: 'r3', symbol: 'ESZ6' })).toMatchObject({ ok: false, sent: false });
    t.setPrice(6981);
    expect(await t.run({ op: 'reduce', clientId: 'r4', symbol: 'ESZ6' })).toMatchObject({ ok: false, sent: false, error: expect.stringMatching(/blízko SL/) });
    t.broker.stop();
  });
});

describe('místní služba: přikoupení a posun dvou ochran', () => {
  const add = (extra: Record<string, unknown> = {}) => entry({ orderType: 'Market', limitPrice: undefined, referencePrice: 7000, stopPrice: 6980, targetPrice: 7030, ...extra });
  async function inPosition(config: Record<string, unknown> = {}) {
    const t = await setup({ config: { positionSettleMs: 20, ...config } });
    const first = await t.run(entry({ limitPrice: 6990, stopPrice: 6980, targetPrice: 7030 }));
    await flush();
    const firstId = (first as { result: { orderId: string } }).result.orderId;
    t.server.fill(firstId, 6990);
    await sleep(120);
    return { t, firstId };
  }

  it('přikoupení: jen Market na stranu pozice se stejnými SL/TP do pozice se SL i TP', async () => {
    const { t } = await inPosition();
    expect(t.exec.state().positions).toEqual([expect.objectContaining({ netQuantity: 1 })]);
    const frames = t.frames();
    // Limit, Stop, opačná strana, holý vstup, jiné SL nebo TP → nic neodejde
    expect(await t.run(entry({ limitPrice: 6985, stopPrice: 6980, targetPrice: 7030 }))).toMatchObject({ ok: false, sent: false });
    expect(await t.run(entry({ orderType: 'Stop', limitPrice: undefined, triggerPrice: 7010, stopPrice: 6980, targetPrice: 7030 }))).toMatchObject({ ok: false, sent: false });
    expect(await t.run(add({ side: 'Sell', stopPrice: 7030, targetPrice: 6980 }))).toMatchObject({ ok: false, sent: false });
    expect(await t.run(add({ stopPrice: undefined, targetPrice: undefined }))).toMatchObject({ ok: false, sent: false });
    expect(await t.run(add({ stopPrice: 6985 }))).toMatchObject({ ok: false, sent: false });
    expect(await t.run(add({ targetPrice: 7025 }))).toMatchObject({ ok: false, sent: false });
    expect(await t.run(add({ targetPrice: undefined }))).toMatchObject({ ok: false, sent: false });
    expect(t.frames()).toBe(frames);
    const placed = await t.run(add());
    expect(placed).toMatchObject({ ok: true, result: { stopTicks: 80, targetTicks: 120 } });
    expect(t.frames()).toBe(frames + 1);
    t.broker.stop();
  });

  it('SL pozici zavře během ukládání záměru přikoupení → nic neodejde a rezervace nezůstane', async () => {
    const base = memoryProtectionStore();
    let delay = 0;
    const slow: ProtectionStore = { load: () => base.load(), save: async (state) => { if (delay) await sleep(delay); await base.save(state); } };
    const t = await setup({ config: { positionSettleMs: 20 }, protectionStore: slow });
    const first = await t.run(entry({ limitPrice: 6990, stopPrice: 6980, targetPrice: 7030 }));
    await flush();
    t.server.fill((first as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(120);
    const stop = t.exec.state().orders.find((o) => o.role === 'stop')!;
    const frames = t.frames();
    delay = 150;
    const pending = t.run(add());
    await sleep(40);
    t.server.fill(stop.orderId, 6980); // SL se vyplní, zatímco adaptér ukládá záměr
    const reply = await pending;
    delay = 0;
    expect(reply).toMatchObject({ ok: false, sent: false });
    expect(t.frames()).toBe(frames);
    await sleep(150);
    expect(t.exec.state().positions).toEqual([]);
    // (falešný server po vyplnění SL nezruší sestru TP jako Rithmic → incident osiřelé nohy; potvrdit)
    await t.run({ op: 'ack' });
    // rezervace nezůstala: nový běžný vstup po usazení projde
    const next = await t.run(entry({ limitPrice: 6985, stopPrice: 6975, targetPrice: 7025 }));
    expect((next as { error?: string }).error ?? 'ok').toBe('ok');
    t.broker.stop();
  });

  it('přikoupení nejde do pozice bez ochrany, se samostatnou ochranou ani těsně po vyplnění', async () => {
    const bare = await setup({ config: { positionSettleMs: 20 } });
    const placed = await bare.run(entry({ stopPrice: undefined, targetPrice: undefined }));
    await flush();
    bare.server.fill((placed as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(120);
    expect(await bare.run(add())).toMatchObject({ ok: false, sent: false });
    bare.broker.stop();
    // výchozí usazení 1 s → hned po vyplnění ne
    const fresh = await setup();
    const first = await fresh.run(entry({ limitPrice: 6990, stopPrice: 6980, targetPrice: 7030 }));
    await flush();
    fresh.server.fill((first as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(120);
    const reply = await fresh.run(add());
    expect(reply).toMatchObject({ ok: false, sent: false });
    expect((reply as { error: string }).error).toMatch(/právě mění/);
    fresh.broker.stop();
  });

  it('dvě ochrany: posun jedné nohy ne, posun obou najednou ano; změněný stav a nejistota další posun zastaví', async () => {
    const { t } = await inPosition({ moveConfirmMs: 200 });
    const placed = await t.run(add());
    await flush();
    t.server.fill((placed as { result: { orderId: string } }).result.orderId, 7000);
    await sleep(160);
    const state = t.exec.state();
    expect(state.positions).toEqual([expect.objectContaining({ netQuantity: 2 })]);
    const stops = state.orders.filter((o) => o.role === 'stop');
    expect(stops).toHaveLength(2);
    const expect2 = stops.map((o) => ({ orderId: o.orderId, price: o.price! }));
    // jedna z více noh přes `move` ne
    expect(await t.run({ op: 'move', orderId: stops[0].orderId, price: 6985 })).toMatchObject({ ok: false, sent: false });
    // špatné „co jsem viděl" (jen jedna noha, nebo jiná cena) ne
    expect(await t.run({ op: 'move-legs', symbol: 'ESZ6', role: 'stop', price: 6985, expect: expect2.slice(0, 1) })).toMatchObject({ ok: false, sent: false });
    expect(await t.run({ op: 'move-legs', symbol: 'ESZ6', role: 'stop', price: 6985, expect: expect2.map((item) => ({ ...item, price: item.price + 1 })) })).toMatchObject({ ok: false, sent: false });
    // špatná strana trhu ne
    expect(await t.run({ op: 'move-legs', symbol: 'ESZ6', role: 'stop', price: 7005, expect: expect2 })).toMatchObject({ ok: false, sent: false });
    const moved = await t.run({ op: 'move-legs', symbol: 'ESZ6', role: 'stop', price: 6985, expect: expect2 });
    expect(moved.ok).toBe(true);
    await sleep(60);
    expect(t.exec.state().orders.filter((o) => o.role === 'stop').map((o) => o.price)).toEqual([6985, 6985]);
    expect(t.exec.state().blocked).toBeNull();
    t.broker.stop();
  });
});

describe('místní služba: posun, incidenty, stav', () => {
  it('posun jde jen u SL/TP vlastního vstupu a vlastního Limitu; cizí příkaz a cena mimo krok ne', async () => {
    const t = await setup();
    const placed = await t.run(entry());
    await flush();
    const entryId = (placed as { result: { orderId: string } }).result.orderId;
    // čekající vstup s ochranou: jde posunout jen cena (změřeno 17. 11. — 314 zachová vzdálenosti SL/TP)
    expect(await t.run({ op: 'move', orderId: entryId, price: 6985.1 })).toMatchObject({ ok: false, sent: false });
    const sentBefore = t.server.orders.get(entryId)!;
    expect((await t.run({ op: 'move', orderId: entryId, price: 6985 })).ok).toBe(true);
    await sleep(60);
    expect(t.server.orders.get(entryId)!.price).toBe(6985);
    expect(t.server.orders.get(entryId)!.priceType).toBe(sentBefore.priceType);
    expect(t.exec.state().orders.find((o) => o.orderId === entryId)).toMatchObject({ role: 'entry', price: 6985 });
    t.server.fill(entryId, 6990);
    await sleep(80);
    // po vyplnění už se cena vstupu nemění
    expect(await t.run({ op: 'move', orderId: entryId, price: 6980 })).toMatchObject({ ok: false, sent: false });
    const state = t.exec.state();
    const stop = state.orders.find((o) => o.role === 'stop')!;
    const target = state.orders.find((o) => o.role === 'target')!;
    expect(await t.run({ op: 'move', orderId: stop.orderId, price: 6975.1 })).toMatchObject({ ok: false, sent: false });
    expect((await t.run({ op: 'move', orderId: stop.orderId, price: 6975 })).ok).toBe(true);
    expect((await t.run({ op: 'move', orderId: target.orderId, price: 7015 })).ok).toBe(true);
    await sleep(60);
    const serverStop = t.server.orders.get(stop.orderId)!;
    expect(serverStop.priceType).toBe(4); // stále stop, žádná změna typu
    expect(serverStop.triggerPrice).toBe(6975);
    // cizí příkaz (bez naší značky)
    t.server.orders.set('900', { basketId: '900', accountId: 'ACC1', userTag: 'cizi', symbol: 'ESZ6', exchange: 'CME', side: 1, priceType: 3, quantity: 1, price: 6900, triggerPrice: 6905, status: 'open', filled: 0 });
    t.server.notifyLive('900', 1);
    await flush();
    expect(await t.run({ op: 'move', orderId: '900', price: 6895 })).toMatchObject({ ok: false, sent: false });
    // cizí příkaz služba ani neruší (to, že ho graf jen zobrazuje, není pojistka služby)
    expect(await t.run({ op: 'cancel', orderId: '900' })).toMatchObject({ ok: false, sent: false, error: expect.stringMatching(/cizí/) });
    expect(t.server.orders.get('900')!.status).toBe('open');
    // cizí příkaz se ve stavu NIKDY netváří jako vstup, SL nebo TP této appky
    expect(t.exec.state().orders.find((o) => o.orderId === '900')).toMatchObject({ role: 'other', limitPrice: 6900 });
    t.broker.stop();
  });

  it('posun čekajícího vstupu s ochranou: jen 1 kontrakt, jen s cenou služby, ne přes trh', async () => {
    const t = await setup();
    const two = await t.run(entry({ quantity: 2 }));
    await flush();
    const twoId = (two as { result: { orderId: string } }).result.orderId;
    const before = t.server.orders.get(twoId)!.price;
    expect(await t.run({ op: 'move', orderId: twoId, price: 6985 })).toMatchObject({ ok: false, sent: false });
    await t.run({ op: 'cancel', orderId: twoId });
    await sleep(60);
    const one = await t.run(entry());
    await flush();
    const oneId = (one as { result: { orderId: string } }).result.orderId;
    // přes trh (cena služby 7000, nákup nad ní)
    expect(await t.run({ op: 'move', orderId: oneId, price: 7001 })).toMatchObject({ ok: false, sent: false });
    // služba nemá cenu → neodesílá (ne „raději pustit")
    t.setPrice(null);
    expect(await t.run({ op: 'move', orderId: oneId, price: 6985 })).toMatchObject({ ok: false, sent: false });
    expect(t.server.orders.get(oneId)!.price).toBe(6990);
    expect(before).toBe(6990);
    t.broker.stop();
  });

  it('samostatná ochrana: jen jeden SL nebo jeden TP k pozici bez příkazů, na správné straně trhu; posun jen ceny', async () => {
    const t = await setup({ config: { protectiveGraceMs: 40, positionSettleMs: 20 } });
    const protect = (extra: Record<string, unknown> = {}) => ({ op: 'protect', clientId: `p${Math.random().toString(36).slice(2, 10)}`, symbol: 'ESZ6', kind: 'stop', price: 6980, ...extra });
    // bez pozice ne
    expect(await t.run(protect())).toMatchObject({ ok: false, sent: false });
    const bare = await t.run(entry({ stopPrice: undefined, targetPrice: undefined }));
    await flush();
    const entryId = (bare as { result: { orderId: string } }).result.orderId;
    // čekající vstup = pracující příkaz → ochrana ne (a pozice ještě není)
    expect(await t.run(protect())).toMatchObject({ ok: false, sent: false });
    t.server.fill(entryId, 6990);
    await sleep(80);
    expect(t.exec.state().positions).toEqual([expect.objectContaining({ symbol: 'ESZ6', netQuantity: 1 })]);
    // hned po vyplnění ne (pozice se usazuje) — s výchozí lhůtou 1 s by to teď odmítl; tady je zkrácená
    const frames = t.frames();
    // špatná strana trhu (cena služby 7000): SL nad trhem, TP pod trhem; mimo krok; bez ceny služby
    expect(await t.run(protect({ price: 7005 }))).toMatchObject({ ok: false, sent: false });
    expect(await t.run(protect({ kind: 'target', price: 6995 }))).toMatchObject({ ok: false, sent: false });
    expect(await t.run(protect({ price: 6980.1 }))).toMatchObject({ ok: false, sent: false });
    t.setPrice(null);
    expect(await t.run(protect())).toMatchObject({ ok: false, sent: false });
    t.setPrice(7000);
    expect(t.frames()).toBe(frames);
    const placed = await t.run(protect());
    expect(placed.ok).toBe(true);
    await sleep(60);
    const stopId = (placed as { result: { orderId: string } }).result.orderId;
    const sent = t.server.orders.get(stopId)!;
    expect(sent).toMatchObject({ side: 2, quantity: 1, priceType: 4, triggerPrice: 6980 });
    expect(sent.userTag.startsWith('uiprot-')).toBe(true);
    expect(t.exec.state().orders.find((o) => o.orderId === stopId)).toMatchObject({ role: 'stop', price: 6980 });
    // druhý SL k pozici se SL ne (TP jde — viz svázaný pár níže)
    expect(await t.run(protect({ price: 6975 }))).toMatchObject({ ok: false, sent: false, error: expect.stringMatching(/už SL má/) });
    expect(t.frames()).toBe(frames + 1);
    // při pracující ochraně další vstup ne (služba, nejen obrazovka)
    expect(await t.run(entry({ side: 'Sell', limitPrice: 7010, stopPrice: 7020, targetPrice: 6995 }))).toMatchObject({ ok: false, sent: false });
    // posun na špatnou stranu trhu nebo bez ceny služby ne
    expect(await t.run({ op: 'move', orderId: stopId, price: 7005 })).toMatchObject({ ok: false, sent: false });
    t.setPrice(null);
    expect(await t.run({ op: 'move', orderId: stopId, price: 6985 })).toMatchObject({ ok: false, sent: false });
    t.setPrice(7000);
    // posun: jen cena, typ zůstává stop
    expect((await t.run({ op: 'move', orderId: stopId, price: 6985 })).ok).toBe(true);
    await sleep(60);
    expect(t.server.orders.get(stopId)).toMatchObject({ priceType: 4, triggerPrice: 6985, quantity: 1 });
    expect(t.exec.state().blocked).toBeNull();
    t.broker.stop();
  });

  it('ochrana se nezadá těsně po vyplnění ani k pozici ze vstupu s ochranou', async () => {
    const t = await setup();
    const withLegs = await t.run(entry());
    await flush();
    t.server.fill((withLegs as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(80);
    // výchozí usazení 1 s + otevřený bracket → odmítnuto bez odeslání
    const frames = t.frames();
    expect(await t.run({ op: 'protect', clientId: 'late1', symbol: 'ESZ6', kind: 'stop', price: 6980 })).toMatchObject({ ok: false, sent: false });
    expect(t.frames()).toBe(frames);
    t.broker.stop();
    const bare = await setup();
    const placed = await bare.run(entry({ stopPrice: undefined, targetPrice: undefined }));
    await flush();
    bare.server.fill((placed as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(80);
    const reply = await bare.run({ op: 'protect', clientId: 'late2', symbol: 'ESZ6', kind: 'stop', price: 6980 });
    expect(reply).toMatchObject({ ok: false, sent: false });
    expect((reply as { error: string }).error).toMatch(/právě mění/);
    bare.broker.stop();
  });

  it('vyplnění samostatné ochrany není incident (pořadí zpráv o pozici a příkazu nerozhoduje)', async () => {
    const t = await setup({ config: { protectiveGraceMs: 60, positionSettleMs: 20 } });
    const bare = await t.run(entry({ stopPrice: undefined, targetPrice: undefined }));
    await flush();
    t.server.fill((bare as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(80);
    const placed = await t.run({ op: 'protect', clientId: 'fill1', symbol: 'ESZ6', kind: 'target', price: 7010 });
    const targetId = (placed as { result: { orderId: string } }).result.orderId;
    await sleep(100);
    t.server.fill(targetId, 7010);
    await sleep(200);
    const state = t.exec.state();
    expect(state.positions).toEqual([]);
    expect(state.blocked).toBeNull();
    expect(state.incidents.some((incident) => incident.kind === 'protective-order-mismatch')).toBe(false);
    t.broker.stop();
  });

  it('samostatná ochrana bez pozice zastaví nové vstupy a nic sama nemění', async () => {
    const t = await setup({ config: { protectiveGraceMs: 40, positionSettleMs: 20 } });
    const bare = await t.run(entry({ stopPrice: undefined, targetPrice: undefined }));
    await flush();
    t.server.fill((bare as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(80);
    const placed = await t.run({ op: 'protect', clientId: 'orph1', symbol: 'ESZ6', kind: 'target', price: 7010 });
    expect(placed.ok).toBe(true);
    await sleep(60);
    const targetId = (placed as { result: { orderId: string } }).result.orderId;
    expect(t.server.orders.get(targetId)).toMatchObject({ side: 2, priceType: 1, price: 7010 });
    // pozici zavře někdo jiný (cizí Market) → TP zůstane pracovat bez pozice
    t.server.orders.set('901', { basketId: '901', accountId: 'ACC1', userTag: 'cizi', symbol: 'ESZ6', exchange: 'CME', side: 2, priceType: 2, quantity: 1, price: 0, triggerPrice: 0, status: 'open', filled: 0 });
    t.server.notifyLive('901', 1);
    t.server.fill('901', 7000);
    // žádná další zpráva o příkazu nepřijde — nesoulad musí ohlásit časovač, ne příští událost
    await sleep(220);
    const state = t.exec.state();
    expect(state.blocked).toMatch(/protective-order-mismatch/);
    expect(t.server.orders.get(targetId)!.status).toBe('open');
    expect(await t.run(entry())).toMatchObject({ ok: false, sent: false });
    t.broker.stop();
  });

  it('kritický incident zastaví nové vstupy, dokud ho obsluha nepotvrdí; zavření jde dál', async () => {
    const t = await setup();
    t.server.controls.legsNeverAppear = true;
    const placed = await t.run(entry());
    await flush();
    t.server.fill((placed as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(150);
    expect(t.exec.state().blocked).toMatch(/bracket-legs-missing/);
    expect(await t.run(entry())).toMatchObject({ ok: false, sent: false });
    expect((await t.run({ op: 'flatten', clientId: 'f1', symbol: 'ESZ6' })).ok).toBe(true);
    expect((await t.run({ op: 'ack' })).ok).toBe(true);
    expect(t.exec.state().blocked).toBeNull();
    t.broker.stop();
  });

  it('stav pro appku: role čar, odmítnutí s důvodem, po obnově spojení nová pravda', async () => {
    const t = await setup();
    t.server.controls.rmsRejectNextOrder = 'Rejected at RMS - Loss limit';
    const rejected = await t.run(entry({ clientId: 'rej-1' }));
    await sleep(40);
    expect(rejected.ok).toBe(true); // „přijato" není důkaz — odmítnutí přijde jako událost
    expect(t.exec.state().rejections.at(-1)).toMatchObject({ tag: 'ui-rej-1' });
    expect(t.exec.state().orders).toEqual([]);
    const placed = await t.run(entry());
    await flush();
    t.server.fill((placed as { result: { orderId: string } }).result.orderId, 6990);
    await sleep(80);
    const roles = t.exec.state().orders.map((o) => o.role).sort();
    expect(roles).toEqual(['stop', 'target']);
    expect(t.exec.state().positions).toEqual([{ symbol: 'ESZ6', netQuantity: 1, averagePrice: 6990 }]);
    t.broker.stop();
  });
});
