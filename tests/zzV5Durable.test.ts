import { describe, expect, it } from 'vitest';
import { createRiskGateContext } from '../services/copierRiskGate';
import { processLeaderEvent, runtimeFromSnapshot } from '../services/copierRunner';
import { createMockBroker } from '../services/mockBroker';
import { emptySnapshot, type CopierSnapshot } from '../services/copierStore';

describe('V5 durable compatibility', () => {
  it.each([false, true])('starý i nový snapshot (%s) jde načíst a flat stop za DISARM zrušit', async withRole => {
    const snapshot: CopierSnapshot = {
      ...emptySnapshot(),
      revision: 3,
      lastSequence: 5,
      outbox: [{
        key: 'k1', tag: 't1', leaderOrderId: 'leader-sl', leaderEventId: 'e', leaderSequence: 4,
        request: { tag: 't1', accountId: 200, symbol: 'MNQU6', side: 'Sell' as const,
          quantity: 1, orderType: 'Stop' as const, stopPrice: 29_400 },
        status: 'acknowledged' as const, attempts: 1, brokerOrderId: 'mo-1', updatedAt: 1,
        ...(withRole ? { protectiveRole: 'standalone-stop' as const } : {}),
      }],
      links: [['leader-sl', [{
        key: 'k1', accountId: 200, brokerOrderId: 'mo-1', quantity: 1, stopPrice: 29_400,
        ...(withRole ? { protectiveRole: 'standalone-stop' as const } : {}),
      }]]],
    };
    const runtime = runtimeFromSnapshot(snapshot);
    expect(runtime.state.links.get('leader-sl')?.[0]?.protectiveRole)
      .toBe(withRole ? 'standalone-stop' : undefined);
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    await broker.placeOrder(snapshot.outbox[0].request);
    broker.setPosition(200, 'MNQU6', 0);

    const result = await processLeaderEvent({
      event: { id: 'cancel', orderId: 'leader-sl', kind: 'canceled', accountId: 100,
        symbol: 'MNQU6', side: 'Sell', quantity: 1, orderType: 'Stop', stopPrice: 29_400,
        sequence: 6, receivedAt: 0 },
      group: { id: 'g1', name: 'Group', enabled: true, leaderAccountId: 100,
        followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }] },
      runtime,
      context: createRiskGateContext({
        armed: false, connected: true, lastHeartbeatAt: 100, now: 100, shadowMode: true,
      }),
      broker,
      clock: () => 101,
    });

    expect(result.audit).toContainEqual(expect.objectContaining({ kind: 'canceled', accountId: 200 }));
    expect(broker.orders()[0]?.status).toBe('canceled');
  });
});
