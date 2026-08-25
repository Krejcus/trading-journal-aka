import { describe, expect, it, vi } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

/**
 * Incident TDFYG50621860230: pátý follower dosáhl Daily Loss Limitu.
 * Broker jeho příkaz nejdřív REST ackl (orderId) a odmítl až asynchronním
 * eventem — copier ale vykazoval `dispatched` a po zrušení leader příkazu
 * dokonce `canceled`. Skutečnost: 4 working · 1 rejected.
 *
 * Testy kryjí account-eligibility systém: async reject → dll-locked,
 * zdraví followeři pokračují, další vstup DLL účet přeskočí s auditem,
 * a DLL se NIKDY neodemyká pouhým časem — jen autoritativním ověřením.
 */

const FOLLOWERS = [201, 202, 203, 204, 205] as const;

const group: CopyGroupConfig = {
  id: 'g-dll', name: 'DLL skupina', enabled: true, leaderAccountId: 100,
  followers: FOLLOWERS.map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
};

const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-entry-1', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Limit', quantity: 1, filledQuantity: 0, limitPrice: 20_900,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...partial,
});

const harness = async () => {
  let now = 1_000;
  const clock = () => ++now;
  const broker = createMockBroker({ clock, behavior: () => ({ kind: 'working' }) });
  const store = createMemoryCopierStore();
  const audit: { kind: string; accountId?: number; reason?: string }[] = [];
  const controller = await bootstrapCopierRuntime({
    broker, store, group, clock,
    wait: async () => undefined,
    onAudit: entries => audit.push(...entries.map(entry => ({
      kind: entry.kind, accountId: entry.accountId, reason: entry.reason,
    }))),
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  return { broker, store, controller, audit, clock, setNow: (value: number) => { now = value; } };
};

const emitLeaderEntry = async (
  harnessed: Awaited<ReturnType<typeof harness>>,
  brokerOrderId: string,
  sourceVersion: string,
) => {
  harnessed.broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId, sourceVersion }) });
  await harnessed.controller.waitForIdle();
};

const followerOrdersFor = (broker: ReturnType<typeof createMockBroker>, accountId: number) =>
  broker.orders().filter(order => order.accountId === accountId);

const asyncDllReject = async (harnessed: Awaited<ReturnType<typeof harness>>, accountId: number) => {
  const [order] = followerOrdersFor(harnessed.broker, accountId);
  if (!order) throw new Error(`Test setup: follower ${accountId} nemá objednávku`);
  order.status = 'rejected';
  order.rejectReason = 'Violation: daily loss limit reached';
  order.sourceVersion = 'async-dll-reject';
  harnessed.broker.emitEvent({ type: 'order', order: { ...order } });
  await harnessed.controller.waitForIdle();
};

describe('account eligibility — DLL incident', () => {
  it('async DLL reject: 4 aktivní / 1 dll-locked, audit rejected (ne canceled), skupina jede dál', async () => {
    const h = await harness();
    await emitLeaderEntry(h, 'leader-entry-1', '1:Working');

    for (const accountId of FOLLOWERS) {
      expect(followerOrdersFor(h.broker, accountId).length, `follower ${accountId}`).toBe(1);
    }

    await asyncDllReject(h, 205);

    const status = h.controller.status();
    const dll = status.accountEligibility?.find(entry => entry.accountId === 205);
    expect(dll?.state).toBe('dll-locked');
    expect(dll?.reason).toContain('daily loss limit');
    expect(dll?.lastExecution?.kind).toBe('rejected');
    expect(status.accountEligibility?.filter(entry => entry.state !== 'active') ?? []).toHaveLength(1);

    // Audit říká pravdu: rejected s broker důvodem, žádný dispatched-mrtvola.
    expect(h.audit.some(entry => entry.kind === 'rejected' && entry.accountId === 205
      && entry.reason?.includes('daily loss limit'))).toBe(true);

    // Vysvětlený reject nesmí zastavit zdravé followery.
    expect(status.armed).toBe(true);
    expect(status.stuckOutbox).toBe(false);

    // Další leader vstup: 4 zdraví dostanou příkaz, DLL účet je přeskočen s auditem.
    await emitLeaderEntry(h, 'leader-entry-2', '1:Working');
    for (const accountId of [201, 202, 203, 204]) {
      expect(followerOrdersFor(h.broker, accountId).length, `follower ${accountId}`).toBe(2);
    }
    expect(followerOrdersFor(h.broker, 205).length).toBe(1);
    expect(h.audit.some(entry => entry.accountId === 205
      && entry.reason?.includes('account-ineligible'))).toBe(true);

    // DLL účet zůstává členem skupiny — jen se neúčastní nových vstupů.
    expect(group.followers.some(follower => follower.accountId === 205)).toBe(true);

    h.controller.stop();
  });

  it('leader cancel nad rejected followerem se vykáže jako rejected, ne canceled', async () => {
    const h = await harness();
    await emitLeaderEntry(h, 'leader-entry-1', '1:Working');
    await asyncDllReject(h, 205);

    h.broker.emitEvent({ type: 'order', order: leaderOrder({ status: 'canceled', sourceVersion: '2:Canceled' }) });
    await h.controller.waitForIdle();

    const forRejected = h.audit.filter(entry => entry.accountId === 205);
    expect(forRejected.some(entry => entry.kind === 'canceled')).toBe(false);

    h.controller.stop();
  });

  it('DLL se neodemkne pouhým časem — reaktivaci smí provést jen autoritativní ověření', async () => {
    const h = await harness();
    await emitLeaderEntry(h, 'leader-entry-1', '1:Working');
    await asyncDllReject(h, 205);

    const lock = h.controller.status().accountEligibility?.find(entry => entry.accountId === 205);
    expect(lock?.state).toBe('dll-locked');

    // Posun času za konec obchodní session: stav se smí jen ZPŘÍSNIT na
    // unverifiable (čeká na ověření) — nikdy sám od sebe na active.
    const sessionEnd = h.controller.status().dailyStats?.sessionEndAt ?? 0;
    h.setNow(Math.max(sessionEnd, lock?.lockSessionEndAt ?? 0) + 60_000);
    const afterTime = h.controller.status().accountEligibility?.find(entry => entry.accountId === 205);
    expect(afterTime?.state === 'active').toBe(false);

    // Další vstup DLL účet pořád přeskakuje.
    await emitLeaderEntry(h, 'leader-entry-3', '1:Working');
    expect(followerOrdersFor(h.broker, 205).length).toBe(1);

    // Autoritativní ověření (reconciliation po nové session) reaktivuje.
    await h.controller.reconcile();
    const afterReconcile = h.controller.status().accountEligibility?.find(entry => entry.accountId === 205);
    expect(afterReconcile?.state).toBe('active');

    h.controller.stop();
  });
});
