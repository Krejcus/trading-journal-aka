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

  it('otevřený obchod při výpadku = nepokračuje (kopie drží SL/TP, ON ručně po flat)', async () => {
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
      phase: 'declined', reason: expect.stringContaining('otevřený obchod'),
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
});
