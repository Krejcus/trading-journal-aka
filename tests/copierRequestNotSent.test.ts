import { describe, expect, it, vi } from 'vitest';
import { BrokerRequestNotSentError } from '../services/brokerPort';
import { createCopierState, type LeaderEvent } from '../services/copierEngine';
import { createRiskGateContext } from '../services/copierRiskGate';
import {
  createRuntime, processBracketPair, processLeaderEvent, processOsoPair, recoverOutbox,
} from '../services/copierRunner';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const group: CopyGroupConfig = {
  id: 'g1', name: 'Test', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};
const event = (overrides: Partial<LeaderEvent> = {}): LeaderEvent => ({
  id: 'e1', orderId: 'o1', accountId: 100, symbol: 'MNQU6', kind: 'submitted',
  side: 'Buy', quantity: 1, orderType: 'Limit', limitPrice: 25_000,
  sequence: 1, receivedAt: 0, ...overrides,
});
const gate = () => createRiskGateContext({
  armed: true, armedAt: 0, now: 100, connected: true, lastHeartbeatAt: 100, shadowMode: false,
});
const clock = () => { let now = 0; return () => ++now; };
const notSent = async (): Promise<never> => {
  throw new BrokerRequestNotSentError('Přístup dočasně pozastaven');
};

describe('request control preserves durable execution uncertainty', () => {
  it('keeps follower requests and post-dispatch recovery inside the accepted-lifecycle context', async () => {
    const underlying = createMockBroker({ behavior: () => ({ kind: 'timeout-after-accept' }) });
    let inAcceptedScope = false;
    const acceptedScopeCalls = vi.fn();
    const runWithAcceptedRequests = async <T,>(action: () => Promise<T>): Promise<T> => {
      acceptedScopeCalls();
      inAcceptedScope = true;
      try { return await action(); } finally { inAcceptedScope = false; }
    };
    const broker = { ...underlying, runWithAcceptedRequests,
      async placeOrder(...args: Parameters<typeof underlying.placeOrder>) {
        expect(inAcceptedScope).toBe(true);
        return underlying.placeOrder(...args);
      },
      async findOrdersByTag(...args: Parameters<typeof underlying.findOrdersByTag>) {
        expect(inAcceptedScope).toBe(true);
        return underlying.findOrdersByTag(...args);
      },
    };
    const runClock = clock();
    const first = await processLeaderEvent({
      event: event(), group, runtime: createRuntime(createCopierState()), context: gate(), broker, clock: runClock,
    });
    const recovered = await recoverOutbox({ runtime: first.runtime, broker, clock: runClock });
    expect([...recovered.runtime.outbox.values()][0].status).toBe('acknowledged');
    expect(inAcceptedScope).toBe(false);
    expect(acceptedScopeCalls).toHaveBeenCalledTimes(2);
    expect(underlying.placedRequests()).toHaveLength(1);
  });

  it('rejects a proven first-attempt local refusal without a broker order or replay', async () => {
    const underlying = createMockBroker();
    const placeOrder = vi.fn(notSent);
    const broker = { ...underlying, placeOrder };
    const runClock = clock();
    const store = createMemoryCopierStore();
    const first = await processLeaderEvent({
      event: event(), group, runtime: createRuntime(createCopierState()),
      context: gate(), broker, clock: runClock, store,
    });
    expect([...first.runtime.outbox.values()]).toEqual([
      expect.objectContaining({ status: 'rejected', rejectedBy: 'policy', attempts: 1 }),
    ]);
    expect(first.metrics.unknown).toBe(0);
    const repeated = await processLeaderEvent({
      event: event(), group, runtime: first.runtime, context: gate(), broker,
      clock: runClock, store,
    });
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(underlying.placedRequests()).toHaveLength(0);
    expect([...repeated.runtime.outbox.values()][0].status).toBe('rejected');
  });

  it('keeps an accepted-but-unconfirmed order unknown when later lookup is locally blocked', async () => {
    const underlying = createMockBroker({ behavior: () => ({ kind: 'timeout-after-accept' }) });
    const runClock = clock();
    const first = await processLeaderEvent({
      event: event(), group, runtime: createRuntime(createCopierState()),
      context: gate(), broker: underlying, clock: runClock,
    });
    expect([...first.runtime.outbox.values()][0].status).toBe('unknown');
    const placeOrder = vi.fn(underlying.placeOrder);
    await expect(recoverOutbox({
      runtime: first.runtime, broker: { ...underlying, placeOrder, findOrdersByTag: notSent },
      clock: runClock,
    })).rejects.toBeInstanceOf(BrokerRequestNotSentError);
    expect([...first.runtime.outbox.values()][0].status).toBe('unknown');
    expect(placeOrder).not.toHaveBeenCalled();
    expect(underlying.placedRequests()).toHaveLength(1);
  });

  it('records local rejection of a native OSO without pretending broker acceptance', async () => {
    const underlying = createMockBroker();
    const placeOso = vi.fn(notSent);
    const result = await processOsoPair({
      pair: {
        entryOrderId: 'parent', stopOrderId: 'stop', targetOrderId: 'target',
        accountId: 100, symbol: 'MNQU6', entrySide: 'Buy', quantity: 1,
        entryOrderType: 'Limit', entryLimitPrice: 25_000,
        stopPrice: 24_990, targetPrice: 25_020, detectedAt: 10,
        correlation: 'broker-parent',
      },
      event: event({ id: 'protective', orderId: 'stop', sequence: 3 }),
      group, runtime: createRuntime(createCopierState([], 2)), context: gate(),
      broker: { ...underlying, placeOso }, clock: clock(), store: createMemoryCopierStore(),
    });
    expect(placeOso).toHaveBeenCalledTimes(1);
    expect([...result.runtime.osoOutbox.values()]).toEqual([
      expect.objectContaining({ status: 'rejected', attempts: 1, reason: expect.stringContaining('Neodesláno') }),
    ]);
    expect(result.runtime.state.links.size).toBe(0);
    expect(underlying.placedOsoRequests()).toHaveLength(0);
  });

  it('records local rejection of protective OCO without fake child order ids', async () => {
    const underlying = createMockBroker();
    const placeOco = vi.fn(notSent);
    const result = await processBracketPair({
      pair: {
        entryOrderId: 'parent', stopOrderId: 'stop', targetOrderId: 'target',
        accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 1,
        stopPrice: 24_990, targetPrice: 25_020, detectedAt: 10,
        correlation: 'broker-parent',
      },
      event: event({ id: 'protective', orderId: 'stop', side: 'Sell', orderType: 'Stop', sequence: 3 }),
      group, runtime: createRuntime(createCopierState([], 2)), context: gate(),
      broker: { ...underlying, placeOco }, clock: clock(), store: createMemoryCopierStore(),
    });
    expect(placeOco).toHaveBeenCalledTimes(1);
    expect([...result.runtime.bracketOutbox.values()]).toEqual([
      expect.objectContaining({ status: 'rejected', attempts: 1 }),
    ]);
    expect(result.runtime.state.links.size).toBe(0);
    expect(underlying.placedOcoRequests()).toHaveLength(0);
  });

  it.each(['canceled', 'replaced'] as const)(
    'a locally refused %s cannot become an uncertain broker write or be resent', async kind => {
      const underlying = createMockBroker({ behavior: () => ({ kind: 'working' }) });
      const runClock = clock();
      const opened = await processLeaderEvent({
        event: event(), group, runtime: createRuntime(createCopierState()),
        context: gate(), broker: underlying, clock: runClock,
      });
      const cancelOrder = vi.fn(notSent);
      const modifyOrder = vi.fn(notSent);
      const broker = { ...underlying, cancelOrder, modifyOrder };
      const changed = event({ id: 'e2', sequence: 2, kind, limitPrice: 25_001 });
      const result = await processLeaderEvent({
        event: changed, group, runtime: opened.runtime, context: gate(), broker, clock: runClock,
      });
      expect([...result.runtime.cancelOutbox.values()]).toEqual([
        expect.objectContaining({ status: 'unknown', neverSent: true, attempts: 1 }),
      ]);
      await processLeaderEvent({
        event: changed, group, runtime: result.runtime, context: gate(), broker, clock: runClock,
      });
      expect(cancelOrder.mock.calls.length + modifyOrder.mock.calls.length).toBe(1);
      expect(underlying.orders()[0]).toMatchObject({ status: 'working', limitPrice: 25_000 });
    },
  );
});
