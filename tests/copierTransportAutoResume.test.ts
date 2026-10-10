// Automatické pokračování po výpadku spojení (10. 10. 2026) — jádro.
// Controller sám nikdy nezapíná; `arm({ autoResume })` projde jen ve stavu
// `ready`, jen jednou a nikdy déle než původní zapnutí.
import { describe, expect, it } from 'vitest';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';

const symbol = 'MNQZ6';
const group = (): CopyGroupConfig => ({
  id: 'resume', name: 'Resume', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function harness(options: { brokerClock?: () => number; store?: ReturnType<typeof createMemoryCopierStore> } = {}) {
  const broker = createMockBroker({
    ...(options.brokerClock ? { clock: options.brokerClock } : {}),
    behavior: request => request.orderType === 'Market' ? { kind: 'fill', price: 30_000 } : { kind: 'working' },
  });
  const store = options.store ?? createMemoryCopierStore();
  const controller = await bootstrapCopierRuntime({ broker, store, group: group() });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) { await controller.waitForIdle(); await sleep(10); }
  };
  const armLive = async () => {
    await controller.prepareArm?.();
    controller.arm({ requirePreparation: true, ttlMs: 10 * 60_000 });
    await settle();
  };
  const outage = async () => {
    broker.setConnected(false);
    await settle();
    const disarmAt = controller.status().transportResume?.disarmAt ?? null;
    return disarmAt;
  };
  const reconnect = async () => {
    broker.setConnected(true);
    await settle();
    await controller.prepareArm?.().catch(() => undefined);
    await settle();
  };
  return { broker, store, controller, armLive, outage, reconnect, settle };
}

describe('automatické pokračování po výpadku — jádro', () => {
  it('flat skupina: po reconnectu ready, jeden pokus zapne a TTL se neprodlouží', async () => {
    const h = await harness();
    await h.armLive();
    const originalExpiry = h.controller.status().armExpiresAt ?? 0;
    const disarmAt = await h.outage();
    expect(disarmAt).not.toBeNull();
    expect(h.controller.status()).toMatchObject({
      armed: false,
      transportResume: { phase: 'waiting', reason: 'čeká na obnovu spojení s brokerem' },
    });
    await h.reconnect();
    expect(h.controller.status().transportResume).toMatchObject({ phase: 'ready', reason: null });
    expect(h.controller.status().armed).toBe(false);
    const writes = h.broker.placedRequests().length;
    h.controller.arm({ requirePreparation: true, ttlMs: 60 * 60_000, autoResume: { disarmAt: disarmAt! } });
    expect(h.controller.status()).toMatchObject({ armed: true, transportResume: { phase: 'resumed' } });
    expect(h.controller.status().armExpiresAt ?? 0).toBeLessThanOrEqual(originalExpiry);
    expect(h.broker.placedRequests()).toHaveLength(writes);
    // Druhý pokus ve stejné epizodě neprojde.
    h.controller.disarm();
    expect(() => h.controller.arm({ requirePreparation: true, autoResume: { disarmAt: disarmAt! } }))
      .toThrow('Automatické pokračování odmítnuto');
    h.controller.stop();
  });

  it('bez živého ARM žádná epizoda; shadow také ne', async () => {
    const h = await harness();
    await h.outage();
    expect(h.controller.status().transportResume ?? null).toBeNull();
    h.controller.stop();
    const shadow = await harness();
    shadow.controller.arm({ shadowMode: true });
    await shadow.outage();
    expect(shadow.controller.status().transportResume ?? null).toBeNull();
    shadow.controller.stop();
  });

  it('otevřený obchod při výpadku = drží kopie a čeká na konec obchodu (detail v copierOutageMidTrade)', async () => {
    const h = await harness();
    await h.armLive();
    h.broker.setPosition(100, symbol, 1);
    h.broker.emitEvent({ type: 'position', position: { accountId: 100, symbol, netQuantity: 1 } });
    h.broker.setPosition(200, symbol, 1);
    h.broker.emitEvent({ type: 'position', position: { accountId: 200, symbol, netQuantity: 1 } });
    h.broker.setPosition(300, symbol, 1);
    h.broker.emitEvent({ type: 'position', position: { accountId: 300, symbol, netQuantity: 1 } });
    await h.settle();
    await h.outage();
    expect(h.controller.status().transportResume).toMatchObject({
      phase: 'waiting', reason: expect.stringContaining('uprostřed obchodu'),
    });
    h.controller.stop();
  });

  it('ruční vypnutí, kill switch i uspání Macu během výpadku epizodu zruší', async () => {
    for (const brake of ['disarm', 'kill', 'sleep'] as const) {
      const h = await harness();
      await h.armLive();
      const disarmAt = await h.outage();
      if (brake === 'disarm') h.controller.disarm();
      if (brake === 'kill') h.controller.engageKillSwitch();
      if (brake === 'sleep') {
        const now = Date.now();
        h.controller.reportHostSleep({ unresponsiveSince: now - 120_000, detectedAt: now, sleepDurationMs: 120_000 });
      }
      await h.reconnect();
      expect(h.controller.status().transportResume?.phase).toBe('declined');
      expect(() => h.controller.arm({ requirePreparation: true, autoResume: { disarmAt: disarmAt! } })).toThrow();
      expect(h.controller.status().armed).toBe(false);
      h.controller.stop();
    }
  });

  it('leader během výpadku obchodoval (příkaz z mezery) = nepokračuje', async () => {
    // Mock za odpojení příkazy nepřijímá; „příkaz z mezery“ je proto příkaz,
    // jehož čas brokera leží po výpadku (zadaný předem za vypnuté kopírky).
    let offsetMs = 10 * 60_000;
    const h = await harness({ brokerClock: () => Date.now() + offsetMs });
    await h.broker.placeOrder({ tag: 'manual-in', accountId: 100, symbol, side: 'Buy', orderType: 'Market', quantity: 1 } as never);
    await h.broker.placeOrder({ tag: 'manual-out', accountId: 100, symbol, side: 'Sell', orderType: 'Market', quantity: 1 } as never);
    await h.settle();
    offsetMs = 0;
    await h.controller.reconcile();
    await h.armLive();
    expect(h.controller.status().armed).toBe(true);
    await h.outage();
    await h.reconnect();
    const resume = h.controller.checkTransportResume?.();
    expect(resume?.kind).toBe('decline');
    expect(h.controller.status().transportResume).toMatchObject({
      phase: 'declined', reason: expect.stringContaining('leader během výpadku'),
    });
    expect(h.controller.status().armed).toBe(false);
    h.controller.stop();
  });

  it('autoResume s cizí epizodou nebo bez přípravy neprojde', async () => {
    const h = await harness();
    await h.armLive();
    const disarmAt = await h.outage();
    await h.reconnect();
    expect(() => h.controller.arm({ requirePreparation: true, autoResume: { disarmAt: disarmAt! + 1 } }))
      .toThrow('epizoda výpadku neodpovídá');
    expect(() => h.controller.arm({ autoResume: { disarmAt: disarmAt! } })).toThrow('Automatické pokračování odmítnuto');
    expect(h.controller.status().armed).toBe(false);
    h.controller.stop();
  });

  it('restart workeru epizodu zahodí — nic durable neautorizuje zapnutí', async () => {
    const h = await harness();
    await h.armLive();
    await h.outage();
    h.controller.stop();
    const restarted = await harness({ store: h.store });
    expect(restarted.controller.status().transportResume ?? null).toBeNull();
    restarted.controller.stop();
  });

  it('ruční ON epizodu ukončí', async () => {
    const h = await harness();
    await h.armLive();
    await h.outage();
    await h.reconnect();
    await h.controller.prepareArm?.();
    h.controller.arm({ requirePreparation: true, ttlMs: 60_000 });
    expect(h.controller.status().transportResume ?? null).toBeNull();
    h.controller.stop();
  });

  it('výpadek přes error event (failClosed transport) založí epizodu; druhý stejný výpadek po pokračování taky', async () => {
    const h = await harness();
    await h.armLive();
    for (let round = 0; round < 2; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
      h.broker.emitEvent({ type: 'error', error: new Error('Tradovate WebSocket heartbeat timeout [leader]') } as never);
      await h.settle();
      const resume = h.controller.status().transportResume;
      expect(resume?.phase).toBe('waiting');
      await h.reconnect();
      expect(h.controller.status().transportResume?.phase).toBe('ready');
      h.controller.arm({ requirePreparation: true, autoResume: { disarmAt: resume!.disarmAt } });
      expect(h.controller.status().armed).toBe(true);
    }
    h.controller.stop();
  });

  it('slepé okno: příkaz leadera těsně před zjištěním výpadku = nepokračuje', async () => {
    let offsetMs = -10_000;
    const h = await harness({ brokerClock: () => Date.now() + offsetMs });
    await h.broker.placeOrder({ tag: 'manual-in', accountId: 100, symbol, side: 'Buy', orderType: 'Market', quantity: 1 } as never);
    await h.broker.placeOrder({ tag: 'manual-out', accountId: 100, symbol, side: 'Sell', orderType: 'Market', quantity: 1 } as never);
    await h.settle();
    offsetMs = 0;
    await h.controller.reconcile();
    await h.armLive();
    await h.outage();
    await h.reconnect();
    expect(h.controller.status().transportResume).toMatchObject({
      phase: 'declined', reason: expect.stringContaining('těsně před jeho zjištěním'),
    });
    h.controller.stop();
  });

  it('fill leadera v mezeře (resync snapshot) = nepokračuje', async () => {
    const h = await harness();
    await h.armLive();
    await h.outage();
    h.broker.emitEvent({ type: 'connection', connected: true, at: Date.now(), resync: {
      complete: true, accountIds: [100, 200, 300], positions: [], orders: [],
      gapFills: [{ fillId: 'gap-1', brokerOrderId: 'o-gap', accountId: 100, symbol, side: 'Buy', quantity: 1, price: 1, filledAt: Date.now(), tag: '' }],
    } } as never);
    await h.settle();
    expect(h.controller.status().transportResume?.phase).toBe('declined');
    h.controller.stop();
  });

  it('zámek dne během výpadku = nepokračuje; cooldown jen čeká', async () => {
    const h = await harness();
    await h.armLive();
    await h.outage();
    await h.controller.lockUntil(Date.now() + 60 * 60_000, 'test zámek');
    await h.reconnect();
    expect(h.controller.status().transportResume?.phase).toBe('declined');
    h.controller.stop();
  });

  it('„pokračuje“ zmizí, jakmile se kopírka znovu vypne', async () => {
    const h = await harness();
    await h.armLive();
    const disarmAt = await h.outage();
    await h.reconnect();
    h.controller.arm({ requirePreparation: true, autoResume: { disarmAt: disarmAt! } });
    expect(h.controller.status().transportResume?.phase).toBe('resumed');
    h.controller.cancelTransportResume?.('zapnutí nebylo durable potvrzeno');
    expect(h.controller.status().transportResume?.phase).toBe('resumed');
    h.controller.disarm();
    expect(h.controller.status().transportResume ?? null).toBeNull();
    h.controller.stop();
  });

  it('nový příkaz leadera podle ID (hodiny Macu a Tradovate se rozcházejí) = nepokračuje', async () => {
    for (const newOrder of [false, true]) {
      const h = await harness();
      let leaderExtra = [{ brokerOrderId: '1000', status: 'filled' }];
      const originalList = h.broker.listOrders.bind(h.broker);
      (h.broker as { listOrders: typeof h.broker.listOrders }).listOrders = (async (accountId: number, ...rest: unknown[]) => {
        const base = await (originalList as (...args: unknown[]) => Promise<unknown[]>)(accountId, ...rest);
        if (accountId !== 100) return base;
        // Čas příkazu leží „před výpadkem“ (hodiny Tradovate pozadu) — rozhodne ID.
        return [...base, ...leaderExtra.map(order => ({
          tag: '', accountId: 100, symbol, side: 'Buy', orderType: 'Market', quantity: 1, filledQuantity: 1,
          updatedAt: 1, ...order,
        }))];
      }) as never;
      await h.controller.reconcile();
      await h.armLive();
      const disarmAt = await h.outage();
      if (newOrder) leaderExtra = [...leaderExtra, { brokerOrderId: '1001', status: 'filled' }];
      await h.reconnect();
      if (newOrder) {
        expect(h.controller.status().transportResume).toMatchObject({ phase: 'declined', reason: expect.stringContaining('nový příkaz') });
      } else {
        expect(h.controller.status().transportResume?.phase).toBe('ready');
        h.controller.arm({ requirePreparation: true, autoResume: { disarmAt: disarmAt! } });
        expect(h.controller.status().armed).toBe(true);
      }
      h.controller.stop();
    }
  });

  it('po hodině čekání už sama nepokračuje', async () => {
    let now = Date.now();
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const { bootstrapCopierRuntime: boot } = await import('../services/copierRuntimeController');
    const controller = await boot({ broker, store: createMemoryCopierStore(), group: group(), clock: () => now } as never);
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    await controller.prepareArm?.();
    controller.arm({ requirePreparation: true, ttlMs: 5 * 3_600_000 });
    broker.setConnected(false);
    await controller.waitForIdle();
    now += 61 * 60_000;
    expect(controller.checkTransportResume?.()).toMatchObject({ kind: 'decline', reason: 'výpadek trval přes hodinu' });
    controller.stop();
  });

  it('jen čekající vstup leadera bez pozice při výpadku = hned nepokračuje (nic se nedrží)', async () => {
    const h = await harness();
    await h.armLive();
    h.broker.emitEvent({ type: 'order', order: {
      tag: '', brokerOrderId: 'resting', accountId: 100, symbol, side: 'Buy', orderType: 'Limit', quantity: 1,
      filledQuantity: 0, limitPrice: 1, status: 'working', sourceVersion: '1', updatedAt: 1,
    } });
    await h.settle();
    await h.outage();
    expect(h.controller.status().transportResume).toMatchObject({ phase: 'declined', reason: expect.stringContaining('bez otevřené pozice') });
    h.controller.stop();
  });
});
