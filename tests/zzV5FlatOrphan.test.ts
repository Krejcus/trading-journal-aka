import { describe, expect, it } from 'vitest';
import { createCopierState, type LeaderEvent } from '../services/copierEngine';
import { createRiskGateContext } from '../services/copierRiskGate';
import { createRuntime, processLeaderEvent } from '../services/copierRunner';
import { createMockBroker } from '../services/mockBroker';
import type { BrokerPort } from '../services/brokerPort';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const group: CopyGroupConfig = {
  id: 'g1', name: 'Group', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
};

const event = (partial: Partial<LeaderEvent>): LeaderEvent => ({
  id: 'sl-submit', orderId: 'leader-sl', kind: 'submitted', accountId: 100,
  symbol: 'MNQU6', side: 'Sell', quantity: 1, orderType: 'Stop', stopPrice: 29_400,
  sequence: 1, receivedAt: 0, ...partial,
});

const gate = (armed: boolean) => createRiskGateContext({
  armed, armedAt: 0, connected: true, lastHeartbeatAt: 100, now: 100, shadowMode: !armed,
});

const protectedState = () => createCopierState([], 0, [], [], [], {
  entryCooldownUntil: 0,
  dayLockUntil: 0,
  leaderExposureEpochs: [{
    id: 'epoch-1', groupId: group.id, leaderAccountId: 100, symbol: 'MNQU6',
    openedAt: 1, lastLeaderNet: 1, generation: 1, phase: 'open',
    followers: group.followers.map(follower => ({
      accountId: follower.accountId,
      replicationModeAtOpen: 'on-submit' as const,
      eligibleAtOpen: true,
      copyLineage: 'confirmed' as const,
    })),
    leaderEntryOrderIds: ['entry-1'], leaderExitOrderIds: [],
  }],
});

const stepClock = () => { let now = 0; return () => ++now; };

describe('V5 adversarial: standalone stop se při cancelu překlasifikuje po účtech', () => {
  it('za DISARM zruší orphan stop flat followera, ale drží SL otevřeného followera', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const clock = stepClock();
    const opened = await processLeaderEvent({
      event: event({}), group, runtime: createRuntime(protectedState()),
      context: gate(true), broker, clock,
    });
    broker.setPosition(200, 'MNQU6', 0);
    broker.setPosition(300, 'MNQU6', 1);

    const canceled = await processLeaderEvent({
      event: event({ id: 'sl-cancel', kind: 'canceled', sequence: 2 }),
      group, runtime: opened.runtime, context: gate(false), broker, clock,
    });

    expect(broker.orders().find(order => order.accountId === 200)?.status).toBe('canceled');
    expect(broker.orders().find(order => order.accountId === 300)?.status).toBe('working');
    expect(canceled.audit).toContainEqual(expect.objectContaining({ kind: 'canceled', accountId: 200 }));
    expect(canceled.audit).toContainEqual(expect.objectContaining({
      kind: 'blocked', accountId: 300,
      reason: expect.stringContaining('follower drží SL, který leader zrušil'),
    }));
    expect(canceled.runtime.state.lastSequence).toBe(1);
  });

  it.each([
    ['opačná pozice', -1, 1],
    ['oversized stop', 1, 2],
  ] as const)('za DISARM zruší stop, který by %s zvětšil nebo otočil', async (_label, net, quantity) => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const clock = stepClock();
    const singleGroup = {
      ...group,
      followers: [{ ...group.followers[0], multiplier: quantity }],
    };
    const opened = await processLeaderEvent({
      event: event({}), group: singleGroup, runtime: createRuntime(protectedState()),
      context: gate(true), broker, clock,
    });
    broker.setPosition(200, 'MNQU6', net);

    const canceled = await processLeaderEvent({
      event: event({ id: 'sl-cancel', kind: 'canceled', sequence: 2, quantity }),
      group: singleGroup, runtime: opened.runtime, context: gate(false), broker, clock,
    });

    expect(canceled.audit).toContainEqual(expect.objectContaining({ kind: 'canceled', accountId: 200 }));
    expect(broker.orders()[0]?.status).toBe('canceled');
  });

  it('neznámou autoritativní pozici blokuje kritickým auditem', async () => {
    const base = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const broker: BrokerPort = {
      ...base,
      listPositions: async accountId => {
        if (accountId === 200) throw new Error('position snapshot unavailable');
        return base.listPositions(accountId);
      },
    };
    const clock = stepClock();
    const opened = await processLeaderEvent({
      event: event({}), group, runtime: createRuntime(protectedState()),
      context: gate(true), broker, clock,
    });

    const canceled = await processLeaderEvent({
      event: event({ id: 'sl-cancel', kind: 'canceled', sequence: 2 }),
      group, runtime: opened.runtime, context: gate(false), broker, clock,
    });

    expect(canceled.audit).toContainEqual(expect.objectContaining({
      kind: 'blocked', accountId: 200, reasonCode: 'standalone-position-unknown',
      reason: expect.stringContaining('pozice followera není autoritativně známá'),
    }));
    expect(base.orders().filter(order => order.orderType === 'Stop').map(order => order.status))
      .toEqual(['working', 'working']);
  });
});
