import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { DEFAULT_COPY_GROUP_SAFETY } from '../services/liveCopyTrading';
import { createTradovateWireHarness } from './helpers/tradovateWireHarness';

const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

const setup = async (count: number, mode: 'on-submit' | 'on-fill' = 'on-submit') => {
  const followers = Array.from({ length: count }, (_, i) => 200 + i);
  const wire = createTradovateWireHarness([100, ...followers]);
  const store = createMemoryCopierStore();
  const controller = await bootstrapCopierRuntime({
    broker: wire.broker, store, clock: wire.clock,
    group: { id: 'wire-group', name: 'Offline wire integration', enabled: true, leaderAccountId: 100,
      followers: followers.map(accountId => ({ accountId, mode, multiplier: 1 })),
      safety: { ...DEFAULT_COPY_GROUP_SAFETY, autoCloseFollowerPositions: true } },
    leaderFlatGraceMs: 20, leaderFlatExitSettlementGraceMs: 10, leaderFlatInflightRetryMs: 20,
    followerTransitionCorrelationWindowMs: 5_000, flattenConfirmationPollMs: 0,
    flattenConfirmationAttempts: 2, wait: async () => {},
  });
  stops.push(() => { controller.stop(); wire.stop(); });
  wire.sync();
  await expect.poll(() => controller.status().connected).toBe(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  expect(controller.status()).toMatchObject({ armed: true, reconciliationRequired: false });
  return { wire, controller, store, followers };
};

describe('real Tradovate adapter through copier controller (offline wire)', () => {
  it('accepts a lone SL immediately after an already filled entry and uses its latest confirmed price', async () => {
    const { wire, controller, followers } = await setup(6);
    wire.place({ accountId: 100, action: 'Sell', orderType: 'Market', orderQty: 1 });
    await expect.poll(() => followers.map(id => wire.positions.get(id))).toEqual(followers.map(() => -1));
    await controller.waitForIdle();
    const id = wire.place({ accountId: 100, action: 'Buy', orderType: 'Stop', stopPrice: 28_941.25, orderQty: 1 });
    await wire.drain();
    await controller.waitForIdle();
    wire.replace(id, { stopPrice: 28_936 });
    await expect.poll(() => wire.requests.filter(request => request.path === '/order/placeorder' && request.body.orderType === 'Stop').length,
      { timeout: 3_000 }).toBe(6);
    await controller.waitForIdle();
    expect(wire.requests.filter(request => request.path === '/order/placeorder' && request.body.orderType === 'Stop')
      .every(request => request.body.stopPrice === 28_936)).toBe(true);
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    wire.replace(id, { stopPrice: 28_930.5 });
    await expect.poll(() => wire.requests.filter(request => request.path === '/order/modifyorder').length).toBe(6);
    await controller.waitForIdle();
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
  });

  it.each(['cancel', 'disarm'] as const)('never sends a queued lone SL after %s', async action => {
    const { wire, controller, followers } = await setup(1);
    wire.place({ accountId: 100, action: 'Sell', orderType: 'Market', orderQty: 1 });
    await expect.poll(() => followers.map(id => wire.positions.get(id))).toEqual([-1]);
    await controller.waitForIdle();
    const id = wire.place({ accountId: 100, action: 'Buy', orderType: 'Stop', stopPrice: 28_941.25, orderQty: 1 });
    await wire.drain();
    await controller.waitForIdle();
    if (action === 'cancel') await wire.broker.cancelOrder(100, String(id));
    else controller.disarm();
    await new Promise(resolve => setTimeout(resolve, 1_850));
    await controller.waitForIdle();
    expect(wire.requests.filter(request => request.path === '/order/placeorder' && request.body.orderType === 'Stop')).toHaveLength(0);
    expect(controller.status().armed).toBe(action === 'cancel');
  });

  it('handles partial 1+4+1 fills, duplicate fills and a partial/manual exit on 12 on-fill followers', async () => {
    const { wire, controller, followers } = await setup(12, 'on-fill');
    const entry = wire.place({ accountId: 100, action: 'Sell', orderType: 'Market', orderQty: 6 }, false);
    let total = 0;
    for (const qty of [1, 4, 1]) {
      wire.fill(entry, qty);
      total += qty;
      await expect.poll(() => followers.map(id => wire.positions.get(id))).toEqual(followers.map(() => -total));
      await controller.waitForIdle();
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    }
    const posts = wire.requests.length;
    for (const entity of wire.fills.values()) wire.props({ entityType: 'fill', entity });
    await wire.drain();
    await controller.waitForIdle();
    expect(wire.requests).toHaveLength(posts);
    wire.place({ accountId: 100, action: 'Buy', orderType: 'Market', orderQty: 2 });
    await expect.poll(() => followers.map(id => wire.positions.get(id))).toEqual(followers.map(() => -4));
    await controller.waitForIdle();
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    wire.place({ accountId: 100, action: 'Buy', orderType: 'Market', orderQty: 4 });
    await expect.poll(() => followers.map(id => wire.positions.get(id))).toEqual(followers.map(() => 0));
    await controller.waitForIdle();
    expect(wire.requests.filter(item => item.path === '/order/liquidateposition')).toHaveLength(0);
    expect(controller.status()).toMatchObject({ groupFlat: true, lastError: null });
  });

  it.each([1, 6, 12])('copies entry and confirmed rapid SL changes to %i followers, then closes standing stops', async count => {
    const { wire, controller, followers, store } = await setup(count);
    wire.place({ accountId: 100, action: 'Sell', orderType: 'Market', orderQty: 1 });
    await expect.poll(() => followers.map(id => wire.positions.get(id))).toEqual(followers.map(() => -1));
    await controller.waitForIdle();
    expect(controller.status()).toMatchObject({ armed: true, lastError: null });

    // Match the incident: the trader adds a standalone SL 28 s after entry.
    wire.advance(28_000);
    const leaderStop = wire.place({ accountId: 100, action: 'Buy', orderType: 'Stop', stopPrice: 28_941.25, orderQty: 1 });
    await expect.poll(() => wire.requests.filter(item => item.path === '/order/placeorder' && item.body.orderType === 'Stop').length,
      { timeout: 4_000 }).toBe(count);
    await controller.waitForIdle();
    const followerStops = [...wire.orders.values()].filter(row => row.accountId !== 100 && row.action === 'Buy');
    expect(followerStops).toHaveLength(count);
    for (const [index, stopPrice] of [28_936, 28_932, 28_930.5].entries()) {
      wire.replace(leaderStop, { stopPrice }, index % 2 === 0 ? 'version-first' : 'report-first');
      await expect.poll(() => wire.requests.filter(item => item.path === '/order/modifyorder').length).toBe(count * (index + 1));
      await controller.waitForIdle();
      expect(controller.status()).toMatchObject({ armed: true, lastError: null, stuckOutbox: false });
      for (const raw of followerStops) {
        expect((await wire.broker.findOrderById(Number(raw.accountId), String(raw.id))).order?.stopPrice).toBe(stopPrice);
      }
    }
    // The leader's stop filled while follower stops still stand. The guard
    // must cancel+liquidate owned orphan positions, never wait forever.
    wire.fill(leaderStop, 1, 28_931);
    await expect.poll(() => followers.map(id => wire.positions.get(id)), { timeout: 3_000 }).toEqual(followers.map(() => 0));
    await controller.waitForIdle();
    expect(wire.requests.filter(item => item.path === '/order/liquidateposition')).toHaveLength(count);
    for (const raw of followerStops) expect(wire.orders.get(raw.id)?.ordStatus).toBe('Canceled');
    expect(controller.status()).toMatchObject({ armed: false, groupFlat: true, reconciliationRequired: true, stuckOutbox: false });
    expect((await store.load()).safety?.leaderExposureEpochs?.at(-1)?.phase).toBe('resolved');
    const posts = wire.requests.length;
    await new Promise(resolve => setTimeout(resolve, 60));
    await controller.waitForIdle();
    expect(wire.requests).toHaveLength(posts);
  });
});
