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
import { memoryProtectionStore } from '../services/rithmic/rithmicProtection';
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

async function setup(options: { server?: Server; registryStore?: RithmicAccountRegistryStore; config?: Partial<LocalExecConfig>; price?: number | null } = {}) {
  const server = options.server ?? createFakeRithmicServer();
  const registryStore = options.registryStore ?? memoryRegistryStore();
  const registry = new RithmicAccountRegistry(registryStore);
  await registry.load();
  let exec: LocalExec | null = null;
  const broker = createRithmicBroker({
    url: 'wss://fake', credentials, socketFactory: server.socketFactory, registry, protectionStore: memoryProtectionStore(),
    onIncident: (incident) => exec?.onIncident(incident),
    requestTimeoutMs: 150, confirmWaitMs: 60, fillWaitMs: 60, reconnectMinMs: 20, reconnectMaxMs: 40,
    legsWaitMs: 25, exitSettleMs: 100, flattenStepMs: 120, flattenCancelWaitMs: 80, flattenPostCheckMs: 40,
  });
  let price: number | null = options.price === undefined ? 7000 : options.price;
  exec = new LocalExec({
    broker, symbols: { ESZ6: { tickSize: 0.25 } }, maxQuantity: 2, maxPosition: 2, systemName: 'Rithmic Test', allowedSystems: ['Rithmic Test'],
    serverPrice: () => price, ...options.config,
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
    expect((await t.run(entry())).ok).toBe(true);
    expect((await t.run(entry())).ok).toBe(true);
    await flush();
    expect(await t.run(entry())).toMatchObject({ ok: false, sent: false });
    expect(t.frames()).toBe(2);
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
