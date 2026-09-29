import { expect, it } from 'vitest';
import { CopierDispatchRevokedError } from '../services/exposureCappedBroker';
import { createCopierState, type LeaderEvent } from '../services/copierEngine';
import { createRiskGateContext } from '../services/copierRiskGate';
import { createRuntime, processLeaderEvent } from '../services/copierRunner';
import { createMockBroker } from '../services/mockBroker';
import type { BrokerPort } from '../services/brokerPort';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

it('ochranný cancel zahozený v závodu s DISARM je kritický a vyžádá reconciliation', async () => {
  const group: CopyGroupConfig = {
    id: 'g1', name: 'Group', enabled: true, leaderAccountId: 100,
    followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
  };
  const base = createMockBroker({ behavior: () => ({ kind: 'working' }) });
  let revokeModify = false;
  const broker: BrokerPort = {
    ...base,
    assertDispatchAllowed(operation) {
      if (operation === 'modify' && revokeModify) throw new CopierDispatchRevokedError('manual-disarm');
    },
  };
  let now = 0;
  const clock = () => ++now;
  const leaderEvent = (partial: Partial<LeaderEvent>): LeaderEvent => ({
    id: 'submit', orderId: 'leader-sl', kind: 'submitted', accountId: 100, symbol: 'MNQU6',
    side: 'Sell', quantity: 1, orderType: 'Stop', stopPrice: 29_400,
    sequence: 1, receivedAt: 0, ...partial,
  });
  const state = createCopierState([], 0, [], [], [], {
    entryCooldownUntil: 0, dayLockUntil: 0,
    leaderExposureEpochs: [{
      id: 'epoch', groupId: 'g1', leaderAccountId: 100, symbol: 'MNQU6', openedAt: 1,
      lastLeaderNet: 1, generation: 1, phase: 'open',
      followers: [{ accountId: 200, replicationModeAtOpen: 'on-submit', eligibleAtOpen: true, copyLineage: 'confirmed' }],
      leaderEntryOrderIds: ['entry'], leaderExitOrderIds: [],
    }],
  });
  const context = createRiskGateContext({
    armed: true, armedAt: 0, connected: true, lastHeartbeatAt: 100, now: 100, shadowMode: false,
  });
  const opened = await processLeaderEvent({
    event: leaderEvent({}), group, runtime: createRuntime(state), context, broker, clock,
  });
  base.setPosition(200, 'MNQU6', 1);
  revokeModify = true;

  const canceled = await processLeaderEvent({
    event: leaderEvent({ id: 'cancel', kind: 'canceled', sequence: 2 }),
    group, runtime: opened.runtime, context, broker, clock,
  });

  expect(canceled.audit).toContainEqual(expect.objectContaining({
    kind: 'cancel-failed', accountId: 200,
    reason: expect.stringContaining('ochranný cancel byl zastaven před odesláním'),
  }));
  expect(base.orders()[0]?.status).toBe('working');
});
