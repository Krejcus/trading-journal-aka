import { describe, expect, it } from 'vitest';
import { createCopierState, type LeaderEvent } from '../services/copierEngine';
import { createRiskGateContext, type RiskGateContext } from '../services/copierRiskGate';
import {
  createRuntime,
  attachCopierMetrics,
  createCopierMetrics,
  createSerialCopierProcessor,
  percentile,
  processBracketPair,
  processOsoPair,
  processLeaderEvent,
  recoverOutbox,
  replayLeaderEvents,
  runtimeFromSnapshot,
} from '../services/copierRunner';
import { createMemoryCopierStore } from '../services/copierStore';
import {
  createBracketOutboxEntry,
  markBracketSending,
  markBracketUnknown,
} from '../services/copierBracketOutbox';
import {
  createOsoOutboxEntry,
  markOsoSending,
  markOsoUnknown,
} from '../services/copierOsoOutbox';
import {
  createCancelEntry,
  createModifyEntry,
  markCancelUnknown,
} from '../services/copierCancelOutbox';
import { createMockBroker } from '../services/mockBroker';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const group: CopyGroupConfig = {
  id: 'g1',
  name: 'Skupina',
  enabled: true,
  leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 2 },
  ],
};

const soloGroup: CopyGroupConfig = {
  ...group,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};

const onFillGroup: CopyGroupConfig = {
  ...group,
  followers: [{ accountId: 200, mode: 'on-fill', multiplier: 0.5 }],
};

const event = (partial: Partial<LeaderEvent> = {}): LeaderEvent => ({
  id: 'e1',
  orderId: 'o1',
  kind: 'submitted',
  accountId: 100,
  symbol: 'MNQU6',
  side: 'Buy',
  quantity: 1,
  orderType: 'Market',
  sequence: 1,
  receivedAt: 0,
  ...partial,
});

const liveGate = (overrides: Partial<RiskGateContext> = {}): RiskGateContext =>
  createRiskGateContext({
    armed: true,
    armedAt: 0,
    now: 100,
    connected: true,
    lastHeartbeatAt: 100,
    shadowMode: false,
    ...overrides,
  });

/** Deterministické hodiny — každé volání posune čas o 1 ms. */
const stepClock = () => {
  let now = 0;
  return () => (now += 1);
};

describe('shadow mode', () => {
  it('spočítá plán, ale nic neodešle ani nezapíše replikovaný klíč', async () => {
    const broker = createMockBroker();
    const result = await processLeaderEvent({
      event: event(),
      group,
      runtime: createRuntime(createCopierState()),
      context: liveGate({ shadowMode: true }),
      broker,
      clock: stepClock(),
    });

    expect(result.plan.orders).toHaveLength(2);
    expect(broker.placedRequests()).toHaveLength(0);
    expect(result.runtime.state.replicated.size).toBe(0);
    expect(result.audit.filter(entry => entry.kind === 'shadow')).toHaveLength(2);
  });

  it('nasimuluje submit, modify a cancel bez jediného broker side effectu', async () => {
    const broker = createMockBroker();
    const clock = stepClock();
    const opened = await processLeaderEvent({
      event: event({ orderType: 'Limit', limitPrice: 25_000 }),
      group: soloGroup,
      runtime: createRuntime(createCopierState()),
      context: liveGate({ shadowMode: true }),
      broker,
      clock,
    });
    expect(opened.runtime.shadowLinks?.get('o1')).toHaveLength(1);

    const replaced = await processLeaderEvent({
      event: event({ id: 'e2', kind: 'replaced', sequence: 2, orderType: 'Limit', limitPrice: 25_000.25 }),
      group: soloGroup,
      runtime: opened.runtime,
      context: liveGate({ shadowMode: true }),
      broker,
      clock,
    });
    expect(replaced.audit).toContainEqual(expect.objectContaining({ kind: 'shadow', reason: 'modify' }));
    expect(replaced.audit.some(entry => entry.reason === 'mode-mismatch')).toBe(false);

    const canceled = await processLeaderEvent({
      event: event({ id: 'e3', kind: 'canceled', sequence: 3, orderType: 'Limit', limitPrice: 25_000.25 }),
      group: soloGroup,
      runtime: replaced.runtime,
      context: liveGate({ shadowMode: true }),
      broker,
      clock,
    });
    expect(canceled.audit).toContainEqual(expect.objectContaining({ kind: 'shadow', reason: 'cancel' }));
    expect(canceled.runtime.shadowLinks?.has('o1')).toBe(false);
    expect(broker.placedRequests()).toHaveLength(0);
    expect(broker.orders()).toHaveLength(0);
  });
});

describe('ostrý režim', () => {
  it('čekající entry + SL + TP odešle jedním nativním OSO a naváže všechny tři ordery', async () => {
    const broker = createMockBroker();
    const result = await processOsoPair({
      pair: {
        entryOrderId: 'entry-oso', stopOrderId: 'stop-oso', targetOrderId: 'target-oso',
        accountId: 100, symbol: 'MNQU6', entrySide: 'Buy', quantity: 1,
        entryOrderType: 'Limit', entryLimitPrice: 30_000,
        stopPrice: 29_950, targetPrice: 30_100, detectedAt: 10,
        correlation: 'inferred-window',
      },
      event: event({
        id: 'oso-stop', orderId: 'stop-oso', kind: 'submitted', sequence: 3,
        side: 'Sell', orderType: 'Stop', stopPrice: 29_950,
      }),
      group: soloGroup,
      runtime: createRuntime(createCopierState([], 2)),
      context: liveGate(), broker, clock: stepClock(), store: createMemoryCopierStore(),
    });

    expect(broker.placedRequests()).toHaveLength(0);
    expect(broker.placedOsoRequests()).toEqual([expect.objectContaining({
      accountId: 200, side: 'Buy', orderType: 'Limit', limitPrice: 30_000,
      first: expect.objectContaining({ side: 'Sell', orderType: 'Stop', stopPrice: 29_950 }),
      second: expect.objectContaining({ side: 'Sell', orderType: 'Limit', limitPrice: 30_100 }),
    })]);
    expect(result.runtime.osoOutbox.get('oso:g1:entry-oso:200')?.status).toBe('acknowledged');
    expect(result.runtime.state.links.get('entry-oso')).toHaveLength(1);
    expect(result.runtime.state.links.get('stop-oso')).toHaveLength(1);
    expect(result.runtime.state.links.get('target-oso')).toHaveLength(1);
    expect(result.metrics.dispatched).toBe(3);
  });

  it('odešle nativní OSO všem pěti followerům v jedné fan-out dávce', async () => {
    const broker = createMockBroker();
    const followers = [200, 300, 400, 500, 600].map(accountId => ({
      accountId, mode: 'on-submit' as const, multiplier: 1,
    }));
    const result = await processOsoPair({
      pair: {
        entryOrderId: 'entry-oso-five', stopOrderId: 'stop-oso-five', targetOrderId: 'target-oso-five',
        accountId: 100, symbol: 'MNQU6', entrySide: 'Buy', quantity: 1,
        entryOrderType: 'Limit', entryLimitPrice: 30_000,
        stopPrice: 29_950, targetPrice: 30_100, detectedAt: 10,
        correlation: 'inferred-window',
      },
      event: event({ id: 'oso-five', orderId: 'stop-oso-five', sequence: 3 }),
      group: { ...group, followers },
      runtime: createRuntime(createCopierState([], 2)),
      context: liveGate(), broker, clock: stepClock(), store: createMemoryCopierStore(),
    });

    expect(broker.placedOsoRequests().map(request => request.accountId)).toEqual([200, 300, 400, 500, 600]);
    expect([...result.runtime.osoOutbox.values()].map(entry => entry.status)).toEqual([
      'acknowledged', 'acknowledged', 'acknowledged', 'acknowledged', 'acknowledged',
    ]);
    expect(result.audit.filter(entry => entry.reason === 'stuck-outbox')).toHaveLength(0);
    expect(result.metrics.dispatched).toBe(15);
  });

  it('desetinný násobek neposílá OSO s nulovým množstvím', async () => {
    const broker = createMockBroker();
    const result = await processOsoPair({
      pair: {
        entryOrderId: 'entry-oso-zero', stopOrderId: 'stop-oso-zero', targetOrderId: 'target-oso-zero',
        accountId: 100, symbol: 'MNQU6', entrySide: 'Buy', quantity: 1,
        entryOrderType: 'Limit', entryLimitPrice: 30_000,
        stopPrice: 29_950, targetPrice: 30_100, detectedAt: 10,
        correlation: 'inferred-window',
      },
      event: event({ id: 'oso-zero', orderId: 'stop-oso-zero', sequence: 3 }),
      group: { ...soloGroup, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 0.25 }] },
      runtime: createRuntime(createCopierState([], 2)),
      context: liveGate(), broker, clock: stepClock(),
    });

    expect(broker.placedOsoRequests()).toHaveLength(0);
    expect(result.audit).toContainEqual(expect.objectContaining({
      kind: 'skipped', accountId: 200, reason: 'scaled-quantity-zero',
    }));
  });

  it('OSO timeout zůstane unknown a restart dohledá jen celý trojlístek', async () => {
    const broker = createMockBroker();
    const request = {
      tag: 'cposorecover', accountId: 200, symbol: 'MNQU6', side: 'Buy' as const,
      quantity: 1, orderType: 'Limit' as const, limitPrice: 30_000,
      first: { side: 'Sell' as const, orderType: 'Stop' as const, stopPrice: 29_950 },
      second: { side: 'Sell' as const, orderType: 'Limit' as const, limitPrice: 30_100 },
    };
    await broker.placeOso!(request);
    const pending = markOsoUnknown(markOsoSending(createOsoOutboxEntry({
      key: 'oso:g1:entry-oso:200', tag: request.tag,
      leaderEntryOrderId: 'entry-oso', leaderStopOrderId: 'stop-oso',
      leaderTargetOrderId: 'target-oso', leaderEventId: 'evt', leaderSequence: 3,
      request, updatedAt: 1,
    }), 2), 'response lost', 3);
    const runtime = createRuntime(createCopierState([], 2), [], [], 0, [], [pending]);
    const recovered = await recoverOutbox({ runtime, broker, clock: stepClock() });

    expect(recovered.runtime.osoOutbox.get(pending.key)?.status).toBe('acknowledged');
    expect(recovered.runtime.state.links.get('entry-oso')).toHaveLength(1);
    expect(recovered.runtime.state.links.get('stop-oso')).toHaveLength(1);
    expect(recovered.runtime.state.links.get('target-oso')).toHaveLength(1);
    expect(broker.placedOsoRequests()).toHaveLength(1);
  });

  it('založí SL+TP jedním nativním OCO a naváže oba follower ordery pro modify/cancel', async () => {
    const broker = createMockBroker();
    const clock = stepClock();
    const store = createMemoryCopierStore();
    const bracket = await processBracketPair({
      pair: {
        entryOrderId: 'entry-1', stopOrderId: 'stop-1', targetOrderId: 'target-1',
        accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 1,
        stopPrice: 30_100, targetPrice: 29_900, detectedAt: 10,
        correlation: 'inferred-window',
      },
      event: event({
        id: 'sl-submit', orderId: 'stop-1', kind: 'submitted', sequence: 3,
        side: 'Sell', orderType: 'Stop', stopPrice: 30_100,
      }),
      group: soloGroup,
      runtime: createRuntime(createCopierState([], 2)),
      context: liveGate(),
      broker,
      clock,
      store,
    });

    expect(broker.placedRequests()).toHaveLength(0);
    expect(broker.placedOcoRequests()).toEqual([expect.objectContaining({
      accountId: 200,
      quantity: 1,
      first: expect.objectContaining({ orderType: 'Stop', stopPrice: 30_100 }),
      second: expect.objectContaining({ orderType: 'Limit', limitPrice: 29_900 }),
    })]);
    expect(bracket.runtime.state.links.get('stop-1')).toHaveLength(1);
    expect(bracket.runtime.state.links.get('target-1')).toHaveLength(1);
    expect(bracket.runtime.bracketOutbox.get('br:g1:entry-1:200')?.status).toBe('acknowledged');

    const modified = await processLeaderEvent({
      event: event({
        id: 'sl-replace', orderId: 'stop-1', kind: 'replaced', sequence: 4,
        side: 'Sell', orderType: 'Stop', stopPrice: 30_120,
      }),
      group: soloGroup,
      runtime: bracket.runtime,
      context: liveGate(),
      broker,
      clock,
      store,
    });
    expect(modified.audit).toContainEqual(expect.objectContaining({ kind: 'modified' }));
    const stopId = modified.runtime.state.links.get('stop-1')?.[0].brokerOrderId;
    expect(broker.orders().find(item => item.brokerOrderId === stopId)?.stopPrice).toBe(30_120);
  });

  it('odešle nativní OCO všem pěti followerům v jedné fan-out dávce', async () => {
    const broker = createMockBroker();
    const followers = [200, 300, 400, 500, 600].map(accountId => ({
      accountId, mode: 'on-submit' as const, multiplier: 1,
    }));
    const result = await processBracketPair({
      pair: {
        entryOrderId: 'entry-five', stopOrderId: 'stop-five', targetOrderId: 'target-five',
        accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 1,
        stopPrice: 30_100, targetPrice: 29_900, detectedAt: 10,
        correlation: 'inferred-window',
      },
      event: event({ id: 'bracket-five', orderId: 'stop-five', sequence: 3 }),
      group: { ...group, followers },
      runtime: createRuntime(createCopierState([], 2)),
      context: liveGate(), broker, clock: stepClock(), store: createMemoryCopierStore(),
    });

    expect(broker.placedOcoRequests().map(request => request.accountId)).toEqual([200, 300, 400, 500, 600]);
    expect([...result.runtime.bracketOutbox.values()].map(entry => entry.status)).toEqual([
      'acknowledged', 'acknowledged', 'acknowledged', 'acknowledged', 'acknowledged',
    ]);
    expect(result.audit.filter(entry => entry.reason === 'stuck-outbox')).toHaveLength(0);
    expect(result.metrics.dispatched).toBe(10);
  });

  it('desetinný násobek neposílá protective OCO s nulovým množstvím', async () => {
    const broker = createMockBroker();
    const result = await processBracketPair({
      pair: {
        entryOrderId: 'entry-zero', stopOrderId: 'stop-zero', targetOrderId: 'target-zero',
        accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 1,
        stopPrice: 30_100, targetPrice: 29_900, detectedAt: 10,
        correlation: 'inferred-window',
      },
      event: event({ id: 'bracket-zero', orderId: 'stop-zero', sequence: 3 }),
      group: { ...soloGroup, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 0.25 }] },
      runtime: createRuntime(createCopierState([], 2)),
      context: liveGate(), broker, clock: stepClock(),
    });

    expect(broker.placedOcoRequests()).toHaveLength(0);
    expect(result.audit).toContainEqual(expect.objectContaining({
      kind: 'skipped', accountId: 200, reason: 'scaled-quantity-zero',
    }));
  });

  it('v shadow režimu OCO pouze naplánuje a zachová synthetic vazby', async () => {
    const broker = createMockBroker();
    const result = await processBracketPair({
      pair: {
        entryOrderId: 'entry-1', stopOrderId: 'stop-1', targetOrderId: 'target-1',
        accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 1,
        stopPrice: 30_100, targetPrice: 29_900, detectedAt: 10,
        correlation: 'inferred-window',
      },
      event: event({ id: 'tp-submit', orderId: 'target-1', sequence: 3 }),
      group: soloGroup,
      runtime: createRuntime(createCopierState([], 2)),
      context: liveGate({ shadowMode: true }),
      broker,
      clock: stepClock(),
    });
    expect(broker.placedOcoRequests()).toHaveLength(0);
    expect(result.runtime.shadowLinks?.get('stop-1')).toHaveLength(1);
    expect(result.runtime.shadowLinks?.get('target-1')).toHaveLength(1);
    expect(result.audit).toContainEqual(expect.objectContaining({ kind: 'shadow', reason: 'native-oco' }));
  });

  it('OCO timeout zůstane unknown a zablokuje další broker write', async () => {
    const broker = createMockBroker();
    broker.placeOco = async () => { throw new Error('lost OCO response'); };
    const failed = await processBracketPair({
      pair: {
        entryOrderId: 'entry-1', stopOrderId: 'stop-1', targetOrderId: 'target-1',
        accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 1,
        stopPrice: 30_100, targetPrice: 29_900, detectedAt: 10,
        correlation: 'inferred-window',
      },
      event: event({ id: 'sl-submit', orderId: 'stop-1', sequence: 3 }),
      group: soloGroup,
      runtime: createRuntime(createCopierState([], 2)),
      context: liveGate(),
      broker,
      clock: stepClock(),
      store: createMemoryCopierStore(),
    });
    expect(failed.runtime.bracketOutbox.get('br:g1:entry-1:200')?.status).toBe('unknown');

    await processLeaderEvent({
      event: event({ id: 'next', orderId: 'entry-2', sequence: 4 }),
      group: soloGroup,
      runtime: failed.runtime,
      context: liveGate(),
      broker,
      clock: stepClock(),
    });
    expect(broker.placedRequests()).toHaveLength(0);
  });

  it('restart recovery obnoví oba OCO linky jen po nalezení celého páru', async () => {
    const broker = createMockBroker();
    const request = {
      tag: 'cpbracket123', accountId: 200, symbol: 'MNQU6', quantity: 1,
      first: { side: 'Sell' as const, orderType: 'Stop' as const, stopPrice: 30_100 },
      second: { side: 'Sell' as const, orderType: 'Limit' as const, limitPrice: 29_900 },
    };
    await broker.placeOco!(request);
    const pending = markBracketUnknown(markBracketSending(createBracketOutboxEntry({
      key: 'br:g1:entry-1:200',
      tag: request.tag,
      leaderEntryOrderId: 'entry-1',
      leaderStopOrderId: 'stop-1',
      leaderTargetOrderId: 'target-1',
      leaderEventId: 'sl-submit',
      leaderSequence: 3,
      request,
      now: 1,
    }), 2), 'response lost', 3);
    const runtime = createRuntime(createCopierState([], 2), [], [], 0, [pending]);
    const recovered = await recoverOutbox({ runtime, broker, clock: stepClock() });
    expect(recovered.runtime.bracketOutbox.get(pending.key)?.status).toBe('acknowledged');
    expect(recovered.runtime.state.links.get('stop-1')).toHaveLength(1);
    expect(recovered.runtime.state.links.get('target-1')).toHaveLength(1);
  });

  it('odešle objednávky a zapíše je do stavu', async () => {
    const broker = createMockBroker();
    const result = await processLeaderEvent({
      event: event({ quantity: 2 }),
      group,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock: stepClock(),
    });

    expect(broker.placedRequests().map(request => [request.accountId, request.quantity]))
      .toEqual([[200, 2], [300, 4]]);
    expect(result.metrics.dispatched).toBe(2);
    expect(result.runtime.state.replicated.has('cp:g1:e1:200')).toBe(true);
  });

  it('zaznamená reject jako konečný stav', async () => {
    const broker = createMockBroker({
      behavior: request =>
        request.accountId === 300
          ? { kind: 'reject', reason: 'insufficient margin' }
          : { kind: 'fill', price: 0 },
    });

    const result = await processLeaderEvent({
      event: event(),
      group,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock: stepClock(),
    });

    expect(result.metrics.rejected).toBe(1);
    expect(result.metrics.dispatched).toBe(1);
    expect(result.runtime.outbox.get('cp:g1:e1:300')?.status).toBe('rejected');
    expect(result.runtime.state.replicated.has('cp:g1:e1:300')).toBe(true);
  });

  it('follower reject zastaví další události skupiny', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'reject', reason: 'risk limit' }) });
    const clock = stepClock();
    const rejected = await processLeaderEvent({
      event: event(), group: soloGroup, runtime: createRuntime(createCopierState()),
      context: liveGate(), broker, clock,
    });
    await processLeaderEvent({
      event: event({ id: 'e2', orderId: 'o2', sequence: 2 }), group: soloGroup,
      runtime: rejected.runtime, context: liveGate(), broker, clock,
    });
    expect(broker.placedRequests()).toHaveLength(1);
  });
});

describe('timeout a dohledání — broker není idempotentní', () => {
  it('timeout po přijetí objednávky nesmí vést k druhému odeslání', async () => {
    const broker = createMockBroker({
      behavior: (_request, attempt) =>
        attempt === 1 ? { kind: 'timeout-after-accept' } : { kind: 'fill', price: 0 },
    });
    const clock = stepClock();

    const failed = await processLeaderEvent({
      event: event(),
      group: soloGroup,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock,
    });

    expect(failed.metrics.unknown).toBe(1);
    expect(failed.runtime.outbox.get('cp:g1:e1:200')?.status).toBe('unknown');
    expect(failed.runtime.state.replicated.size).toBe(0);
    expect(broker.placedRequests()).toHaveLength(1);

    // Další pokus o tutéž událost NESMÍ poslat druhou objednávku.
    const retried = await processLeaderEvent({
      event: event(),
      group: soloGroup,
      runtime: failed.runtime,
      context: liveGate(),
      broker,
      clock,
    });
    expect(broker.placedRequests()).toHaveLength(1);

    // Teprve dohledání zjistí, že objednávka u brokera existuje.
    const recovered = await recoverOutbox({ runtime: retried.runtime, broker, clock });
    expect(recovered.metrics.recovered).toBe(1);
    expect(recovered.runtime.outbox.get('cp:g1:e1:200')?.status).toBe('acknowledged');
    expect(recovered.runtime.state.replicated.has('cp:g1:e1:200')).toBe(true);
    expect(broker.placedRequests()).toHaveLength(1);
  });

  it('eventual prázdný lookup nepovolí retry ani při opožděné viditelnosti', async () => {
    const broker = createMockBroker({
      behavior: () => ({ kind: 'timeout-after-accept' }),
      lookupCompleteness: 'eventual',
      lookupVisibilityDelay: 1,
    });
    const clock = stepClock();
    const failed = await processLeaderEvent({
      event: event(), group: soloGroup, runtime: createRuntime(createCopierState()),
      context: liveGate(), broker, clock,
    });
    const stillUnknown = await recoverOutbox({ runtime: failed.runtime, broker, clock });
    expect(stillUnknown.runtime.outbox.get('cp:g1:e1:200')?.status).toBe('unknown');
    await processLeaderEvent({
      event: event(), group: soloGroup, runtime: stillUnknown.runtime,
      context: liveGate(), broker, clock,
    });
    expect(broker.placedRequests()).toHaveLength(1);
    const visible = await recoverOutbox({ runtime: stillUnknown.runtime, broker, clock });
    expect(visible.runtime.outbox.get('cp:g1:e1:200')?.status).toBe('acknowledged');
  });

  it('uloží sending před prvním síťovým side effectem', async () => {
    const store = createMemoryCopierStore();
    const inner = createMockBroker();
    const broker = {
      ...inner,
      async placeOrder(request: Parameters<typeof inner.placeOrder>[0]) {
        const snapshot = await store.load();
        expect(snapshot.outbox.find(item => item.key === 'cp:g1:e1:200')?.status).toBe('sending');
        return inner.placeOrder(request);
      },
    };
    await processLeaderEvent({
      event: event(), group: soloGroup, runtime: createRuntime(createCopierState()),
      context: liveGate(), broker, clock: stepClock(), store,
    });
  });

  it('pád po broker acceptu obnoví sending lookupem bez druhé objednávky', async () => {
    const innerStore = createMemoryCopierStore();
    let commits = 0;
    const store = {
      load: () => innerStore.load(),
      async commit(snapshot: Parameters<typeof innerStore.commit>[0], expected: number) {
        commits += 1;
        if (commits === 2) throw new Error('simulated process crash before final commit');
        return innerStore.commit(snapshot, expected);
      },
    };
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const clock = stepClock();
    await expect(processLeaderEvent({
      event: event(), group: soloGroup, runtime: createRuntime(createCopierState()),
      context: liveGate(), broker, clock, store,
    })).rejects.toThrow('simulated process crash');
    expect(broker.placedRequests()).toHaveLength(1);
    const crashedSnapshot = await store.load();
    expect(crashedSnapshot.outbox[0].status).toBe('sending');
    const recovered = await recoverOutbox({
      runtime: runtimeFromSnapshot(crashedSnapshot), broker, clock, store,
    });
    expect(recovered.runtime.outbox.get('cp:g1:e1:200')?.status).toBe('acknowledged');
    expect(broker.placedRequests()).toHaveLength(1);
  });

  it('timeout před doručením se po dohledání smí poslat znovu', async () => {
    const broker = createMockBroker({
      behavior: (_request, attempt) =>
        attempt === 1 ? { kind: 'timeout-before-accept' } : { kind: 'fill', price: 0 },
    });
    const clock = stepClock();

    const failed = await processLeaderEvent({
      event: event(),
      group: soloGroup,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock,
    });
    expect(broker.placedRequests()).toHaveLength(0);

    const recovered = await recoverOutbox({ runtime: failed.runtime, broker, clock });
    expect(recovered.runtime.outbox.get('cp:g1:e1:200')?.status).toBe('planned');

    const retried = await processLeaderEvent({
      event: event(),
      group: soloGroup,
      runtime: recovered.runtime,
      context: liveGate(),
      broker,
      clock,
    });
    expect(broker.placedRequests()).toHaveLength(1);
    expect(retried.runtime.state.replicated.has('cp:g1:e1:200')).toBe(true);
  });

  it('on-fill cíl se neposune, dokud follower order není potvrzená', async () => {
    const broker = createMockBroker({
      behavior: (_request, attempt) => attempt === 1
        ? { kind: 'timeout-before-accept' }
        : { kind: 'fill', price: 29_500 },
    });
    const clock = stepClock();
    const fillEvent = event({ kind: 'filled', quantity: 2, cumulativeQuantity: 2 });
    const failed = await processLeaderEvent({
      event: fillEvent, group: onFillGroup, runtime: createRuntime(createCopierState()),
      context: liveGate(), broker, clock,
    });
    expect(failed.runtime.state.followerFillTargets.size).toBe(0);
    const lookedUp = await recoverOutbox({ runtime: failed.runtime, broker, clock });
    const retried = await processLeaderEvent({
      event: fillEvent, group: onFillGroup, runtime: lookedUp.runtime,
      context: liveGate(), broker, clock,
    });
    expect(broker.placedRequests()).toHaveLength(1);
    expect(retried.runtime.state.followerFillTargets.get('o1:200')).toBe(1);
  });

  it('nalezená duplicita se nevyřeší sama, ale předá člověku', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'timeout-after-accept' }) });
    const clock = stepClock();

    // Dvě objednávky se stejným tagem — přesně to, co by způsobil slepý retry.
    const request = {
      tag: 'cpduplicate',
      accountId: 200,
      symbol: 'MNQU6' as const,
      side: 'Buy' as const,
      quantity: 1,
      orderType: 'Market' as const,
    };
    await broker.placeOrder(request).catch(() => undefined);
    await broker.placeOrder(request).catch(() => undefined);

    const runtime = createRuntime(createCopierState(), [
      {
        key: 'cp:g1:e1:200',
        tag: 'cpduplicate',
        leaderOrderId: 'o1',
        request,
        status: 'unknown',
        attempts: 1,
        updatedAt: 0,
      },
    ]);

    const recovered = await recoverOutbox({ runtime, broker, clock });
    expect(recovered.metrics.duplicatesFound).toBe(1);
    expect(recovered.runtime.outbox.get('cp:g1:e1:200')?.status).toBe('abandoned');
    expect(recovered.runtime.state.replicated.has('cp:g1:e1:200')).toBe(false);
  });

  it('nevyřešená položka v outboxu zastaví další replikaci', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'timeout-after-accept' }) });
    const clock = stepClock();

    const failed = await processLeaderEvent({
      event: event({ id: 'e1', sequence: 1 }),
      group: soloGroup,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock,
    });

    const next = await processLeaderEvent({
      event: event({ id: 'e2', sequence: 2 }),
      group: soloGroup,
      runtime: failed.runtime,
      context: liveGate(),
      broker,
      clock,
    });

    expect(next.audit.some(entry => entry.reason === 'stuck-outbox')).toBe(true);
    expect(broker.placedRequests()).toHaveLength(1);
  });
});

describe('restart přes persistentní store', () => {
  it('stav i outbox přežijí restart a replikace se neopakuje', async () => {
    const store = createMemoryCopierStore();
    const broker = createMockBroker();
    const clock = stepClock();
    const events = [event({ id: 'e1', sequence: 1 }), event({ id: 'e2', sequence: 2 })];

    await replayLeaderEvents(events, {
      group,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock,
      store,
    });
    expect(broker.placedRequests()).toHaveLength(4);

    // Restart: runtime se skládá výhradně z toho, co je ve store.
    const snapshot = await store.load();
    const restored = runtimeFromSnapshot(snapshot);
    expect(restored.state.replicated.size).toBe(4);

    await replayLeaderEvents(events, {
      group,
      runtime: restored,
      context: liveGate(),
      broker,
      clock,
      store,
    });
    expect(broker.placedRequests()).toHaveLength(4);
  });

  it('commit ukládá i nevyřešené položky, aby se po restartu dohledaly', async () => {
    const store = createMemoryCopierStore();
    const broker = createMockBroker({ behavior: () => ({ kind: 'timeout-after-accept' }) });
    const clock = stepClock();

    await processLeaderEvent({
      event: event(),
      group: soloGroup,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock,
      store,
    });

    const snapshot = await store.load();
    expect(snapshot.replicated).toHaveLength(0);
    expect(snapshot.outbox[0]).toMatchObject({ key: 'cp:g1:e1:200', status: 'unknown' });
  });
});

describe('kontrola sekvence', () => {
  it('mezera ve streamu zastaví replikaci', async () => {
    const broker = createMockBroker();
    const result = await processLeaderEvent({
      event: event({ sequence: 5 }),
      group,
      runtime: createRuntime(createCopierState([], 1)),
      context: liveGate(),
      broker,
      clock: stepClock(),
    });

    expect(result.audit.some(entry => entry.kind === 'sequence-broken')).toBe(true);
    expect(broker.placedRequests()).toHaveLength(0);
  });

  it('duplicitní sekvence se zaznamená, ale nezastaví nedokončený pokus', async () => {
    // Událost se stejnou sekvencí přijde znovu poté, co minule spadla.
    // Musí projít až k odeslání, jinak by replikace zůstala navždy viset.
    const broker = createMockBroker();
    const result = await processLeaderEvent({
      event: event({ sequence: 3 }),
      group: soloGroup,
      runtime: createRuntime(createCopierState([], 3)),
      context: liveGate(),
      broker,
      clock: stepClock(),
    });

    expect(result.audit[0]).toMatchObject({ kind: 'skipped', reason: 'duplicate-sequence' });
    expect(broker.placedRequests()).toHaveLength(1);
  });

  it('už vyřízenou replikaci neodešle podruhé ani při shodné sekvenci', async () => {
    const broker = createMockBroker();
    const result = await processLeaderEvent({
      event: event({ sequence: 3 }),
      group: soloGroup,
      runtime: createRuntime(createCopierState(['cp:g1:e1:200'], 3)),
      context: liveGate(),
      broker,
      clock: stepClock(),
    });

    expect(broker.placedRequests()).toHaveLength(0);
    expect(result.plan.skipped[0]).toMatchObject({ reason: 'already-replicated' });
  });
});

describe('výpadek spojení', () => {
  it('gate zastaví replikaci, dokud je spojení mrtvé', async () => {
    const broker = createMockBroker();
    const result = await processLeaderEvent({
      event: event(),
      group,
      runtime: createRuntime(createCopierState()),
      context: liveGate({ connected: false }),
      broker,
      clock: stepClock(),
    });

    expect(broker.placedRequests()).toHaveLength(0);
    expect(result.audit.every(entry => entry.reason === 'disconnected')).toBe(true);
  });
});

describe('zrušení objednávky u leadera', () => {
  it('zruší follower objednávky, které z ní vznikly', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const clock = stepClock();

    const opened = await processLeaderEvent({
      event: event({ id: 'e1', orderId: 'o1', sequence: 1 }),
      group,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock,
    });
    expect(opened.runtime.state.links.get('o1')).toHaveLength(2);

    const canceled = await processLeaderEvent({
      event: event({ id: 'e2', orderId: 'o1', kind: 'canceled', sequence: 2 }),
      group,
      runtime: opened.runtime,
      context: liveGate(),
      broker,
      clock,
    });

    expect(canceled.audit.filter(entry => entry.kind === 'canceled')).toHaveLength(2);
    expect(broker.orders().every(order => order.status === 'canceled')).toBe(true);
  });

  it('dokončí cancel známé follower objednávky i po DISARM', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const clock = stepClock();
    const opened = await processLeaderEvent({
      event: event({ orderType: 'Limit', limitPrice: 30_000 }), group: soloGroup,
      runtime: createRuntime(createCopierState()), context: liveGate(), broker, clock,
    });

    const canceled = await processLeaderEvent({
      event: event({ id: 'e2', kind: 'canceled', sequence: 2, orderType: 'Limit', limitPrice: 30_000 }),
      group: soloGroup, runtime: opened.runtime,
      context: liveGate({ armed: false }), broker, clock,
    });

    expect(canceled.audit).toContainEqual(expect.objectContaining({ kind: 'canceled', accountId: 200 }));
    expect(canceled.audit.some(item => item.reason === 'disarmed')).toBe(false);
    expect(broker.orders()).toEqual([expect.objectContaining({ status: 'canceled' })]);
    expect(canceled.runtime.state.lastSequence).toBe(2);
  });

  it('dokončí cancel dlouho čekající follower objednávky i po expiraci ARM TTL', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const clock = stepClock();
    const opened = await processLeaderEvent({
      event: event({ orderType: 'Limit', limitPrice: 30_000 }), group: soloGroup,
      runtime: createRuntime(createCopierState()), context: liveGate(), broker, clock,
    });

    const canceled = await processLeaderEvent({
      event: event({ id: 'e2', kind: 'canceled', sequence: 2, orderType: 'Limit', limitPrice: 30_000 }),
      group: soloGroup, runtime: opened.runtime,
      context: liveGate({
        armedAt: 0,
        armTtlMs: 100,
        now: 10_000,
        lastHeartbeatAt: 10_000,
      }),
      broker,
      clock,
    });

    expect(canceled.audit).toContainEqual(expect.objectContaining({ kind: 'canceled', accountId: 200 }));
    expect(canceled.audit.some(item => item.reason === 'arm-expired')).toBe(false);
    expect(broker.orders()).toEqual([expect.objectContaining({ status: 'canceled' })]);
    expect(canceled.runtime.state.lastSequence).toBe(2);
  });

  it('potvrzený cancel po DISARM nahradí starý nejasný modify stejného orderu', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const clock = stepClock();
    const opened = await processLeaderEvent({
      event: event({ orderType: 'Limit', limitPrice: 30_000 }), group: soloGroup,
      runtime: createRuntime(createCopierState()), context: liveGate(), broker, clock,
    });
    const followerOrder = broker.orders()[0];
    const stuckModify = markCancelUnknown(createModifyEntry(
      'mx:old-modify', 'replace-event', 2, 200, followerOrder.brokerOrderId,
      { quantity: 1, orderType: 'Limit', limitPrice: 30_001 }, clock(),
    ), 'změna zatím není potvrzena order streamem', clock());
    const runtimeWithStuckModify = {
      ...opened.runtime,
      cancelOutbox: new Map([[stuckModify.key, stuckModify]]),
    };

    const canceled = await processLeaderEvent({
      event: event({ id: 'e3', kind: 'canceled', sequence: 2, orderType: 'Limit', limitPrice: 30_001 }),
      group: soloGroup, runtime: runtimeWithStuckModify,
      context: liveGate({ armed: false, stuckOutbox: true }), broker, clock,
    });

    expect(canceled.audit).toContainEqual(expect.objectContaining({ kind: 'canceled', accountId: 200 }));
    expect(canceled.runtime.cancelOutbox.get(stuckModify.key)).toMatchObject({
      status: 'waived',
      reason: expect.stringContaining('nahrazeno potvrzeným cancellem'),
    });
    expect(broker.orders()).toEqual([expect.objectContaining({ status: 'canceled' })]);
    expect(canceled.runtime.state.lastSequence).toBe(2);
  });

  it('restart recovery potvrzeného cancelu uklidí i starší nejasný modify', async () => {
    const store = createMemoryCopierStore();
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const clock = stepClock();
    const opened = await processLeaderEvent({
      event: event({ orderType: 'Limit', limitPrice: 30_000 }), group: soloGroup,
      runtime: createRuntime(createCopierState()), context: liveGate(), broker, clock, store,
    });
    const follower = opened.runtime.state.links.get('o1')?.[0];
    expect(follower).toBeDefined();
    if (!follower) throw new Error('test follower link nebyl vytvořen');

    const stuckModify = markCancelUnknown(createModifyEntry(
      'mx:before-crash', 'replace-event', 2, follower.accountId, follower.brokerOrderId,
      { quantity: 1, orderType: 'Limit', limitPrice: 30_001 }, clock(),
    ), 'modify nemá potvrzený výsledek', clock());
    const unknownCancel = markCancelUnknown(createCancelEntry(
      `cx:${follower.key}`, 'cancel-event', 3, follower.accountId, follower.brokerOrderId, clock(),
    ), 'proces spadl před lookupem cancelu', clock());

    // Broker cancel už skutečně provedl, ale runtime před jeho potvrzením spadl.
    await broker.cancelOrder(follower.accountId, follower.brokerOrderId);
    const recovered = await recoverOutbox({
      runtime: {
        ...opened.runtime,
        cancelOutbox: new Map([
          [stuckModify.key, stuckModify],
          [unknownCancel.key, unknownCancel],
        ]),
      },
      broker,
      clock,
      store,
    });

    expect(recovered.runtime.cancelOutbox.get(unknownCancel.key)).toMatchObject({ status: 'confirmed' });
    // Modify proti už zrušené objednávce je od 2026-08-20 bezpředmětný
    // no-op (confirmed), ne waived — výsledek je ekvivalentně terminální.
    expect(recovered.runtime.cancelOutbox.get(stuckModify.key)).toMatchObject({
      status: 'confirmed',
      reason: expect.stringContaining('bezpředmětný'),
    });
    expect(recovered.runtime.state.lastSequence).toBe(3);
    expect(recovered.metrics.recovered).toBe(2);
  });

  it('po pádu mezi broker cancellem a finálním commitem obnoví všechny followery bez druhého cancelu', async () => {
    const persisted = createMemoryCopierStore();
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const clock = stepClock();
    let crashBeforeFinalCommit = true;
    const crashingStore = {
      load: () => persisted.load(),
      async commit(snapshot: Awaited<ReturnType<typeof persisted.load>>, expectedRevision: number) {
        if (
          crashBeforeFinalCommit
          && snapshot.cancelOutbox.length === group.followers.length
          && snapshot.cancelOutbox.every(entry => entry.status === 'confirmed')
        ) {
          crashBeforeFinalCommit = false;
          throw new Error('simulovaný pád před finálním commitem cancelu');
        }
        return persisted.commit(snapshot, expectedRevision);
      },
    };

    const opened = await processLeaderEvent({
      event: event({ orderType: 'Limit', limitPrice: 30_000 }), group,
      runtime: createRuntime(createCopierState()), context: liveGate(), broker, clock,
      store: crashingStore,
    });
    const brokerOrderIds = broker.orders().map(order => order.brokerOrderId);

    await expect(processLeaderEvent({
      event: event({ id: 'e2', kind: 'canceled', sequence: 2, orderType: 'Limit', limitPrice: 30_000 }),
      group, runtime: opened.runtime, context: liveGate(), broker, clock, store: crashingStore,
    })).rejects.toThrow('simulovaný pád');

    const afterCrash = await persisted.load();
    expect(afterCrash.lastSequence).toBe(1);
    expect(afterCrash.cancelOutbox).toHaveLength(2);
    expect(afterCrash.cancelOutbox.every(entry => entry.status === 'sending')).toBe(true);
    expect(broker.orders().every(order => order.status === 'canceled')).toBe(true);

    const recovered = await recoverOutbox({
      runtime: runtimeFromSnapshot(afterCrash), broker, clock, store: persisted,
    });

    expect(recovered.runtime.state.lastSequence).toBe(2);
    expect([...recovered.runtime.cancelOutbox.values()].every(entry => entry.status === 'confirmed')).toBe(true);
    for (const brokerOrderId of brokerOrderIds) {
      expect(broker.cancelRequestCount(brokerOrderId)).toBe(1);
    }
  });

  it('při smíšeném výsledku cancelu více followerů neposune sekvenci celé leader události', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const clock = stepClock();
    const opened = await processLeaderEvent({
      event: event({ orderType: 'Limit', limitPrice: 30_000 }), group,
      runtime: createRuntime(createCopierState()), context: liveGate(), broker, clock,
    });
    const links = opened.runtime.state.links.get('o1') ?? [];
    expect(links).toHaveLength(2);
    const [confirmedLink, filledLink] = links;
    await broker.cancelOrder(confirmedLink.accountId, confirmedLink.brokerOrderId);

    const confirmedEntry = markCancelUnknown(createCancelEntry(
      `cx:${confirmedLink.key}`, 'cancel-event', 2,
      confirmedLink.accountId, confirmedLink.brokerOrderId, clock(),
    ), 'proces spadl před lookupem', clock());
    const filledEntry = markCancelUnknown(createCancelEntry(
      `cx:${filledLink.key}`, 'cancel-event', 2,
      filledLink.accountId, filledLink.brokerOrderId, clock(),
    ), 'proces spadl před lookupem', clock());
    const filledOrder = broker.orders().find(order => order.brokerOrderId === filledLink.brokerOrderId);
    expect(filledOrder).toBeDefined();
    if (!filledOrder) throw new Error('test follower order nebyl vytvořen');
    const mixedLookupBroker = {
      ...broker,
      async findOrderById(accountId: number, brokerOrderId: string) {
        if (brokerOrderId === filledLink.brokerOrderId) {
          return {
            order: { ...filledOrder, status: 'filled' as const, filledQuantity: filledOrder.quantity },
            completeness: 'authoritative' as const,
            observedAt: clock(),
          };
        }
        return broker.findOrderById(accountId, brokerOrderId);
      },
    };

    const recovered = await recoverOutbox({
      runtime: {
        ...opened.runtime,
        cancelOutbox: new Map([
          [confirmedEntry.key, confirmedEntry],
          [filledEntry.key, filledEntry],
        ]),
      },
      broker: mixedLookupBroker,
      clock,
    });

    expect(recovered.runtime.cancelOutbox.get(confirmedEntry.key)?.status).toBe('confirmed');
    expect(recovered.runtime.cancelOutbox.get(filledEntry.key)?.status).toBe('abandoned');
    expect(recovered.runtime.state.lastSequence).toBe(1);
  });

  it('cancel po DISARM zůstane blokovaný bez broker spojení', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const clock = stepClock();
    const opened = await processLeaderEvent({
      event: event({ orderType: 'Limit', limitPrice: 30_000 }), group: soloGroup,
      runtime: createRuntime(createCopierState()), context: liveGate(), broker, clock,
    });

    const canceled = await processLeaderEvent({
      event: event({ id: 'e2', kind: 'canceled', sequence: 2, orderType: 'Limit', limitPrice: 30_000 }),
      group: soloGroup, runtime: opened.runtime,
      context: liveGate({ armed: false, connected: false }), broker, clock,
    });

    expect(canceled.audit).toContainEqual(expect.objectContaining({ kind: 'blocked', reason: 'disconnected' }));
    expect(broker.orders()).toEqual([expect.objectContaining({ status: 'working' })]);
    expect(canceled.runtime.state.lastSequence).toBe(1);
  });

  it('neúspěšné zrušení je v auditu vidět — follower zůstal v trhu', async () => {
    const inner = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const broker = {
      ...inner,
      async cancelOrder(): Promise<void> {
        throw new Error('cancel rejected');
      },
    };
    const clock = stepClock();

    const opened = await processLeaderEvent({
      event: event({ id: 'e1', orderId: 'o1', sequence: 1 }),
      group: soloGroup,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock,
    });

    const canceled = await processLeaderEvent({
      event: event({ id: 'e2', orderId: 'o1', kind: 'canceled', sequence: 2 }),
      group: soloGroup,
      runtime: opened.runtime,
      context: liveGate(),
      broker,
      clock,
    });

    expect(canceled.audit.filter(entry => entry.kind === 'cancel-failed')).toHaveLength(1);
  });

  it('bez známé vazby se neruší nic — nehádá se podle pozice', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const result = await processLeaderEvent({
      event: event({ orderId: 'neznama', kind: 'canceled' }),
      group,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock: stepClock(),
    });

    expect(result.audit.filter(entry => entry.kind === 'canceled')).toHaveLength(0);
  });

  it('vazba přežije restart, takže jde zrušit i po něm', async () => {
    const store = createMemoryCopierStore();
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const clock = stepClock();

    await processLeaderEvent({
      event: event({ id: 'e1', orderId: 'o1', sequence: 1 }),
      group: soloGroup,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock,
      store,
    });

    const snapshot = await store.load();
    const restored = runtimeFromSnapshot(snapshot);

    const canceled = await processLeaderEvent({
      event: event({ id: 'e2', orderId: 'o1', kind: 'canceled', sequence: 2 }),
      group: soloGroup,
      runtime: restored,
      context: liveGate(),
      broker,
      clock,
      store,
    });

    expect(canceled.audit.filter(entry => entry.kind === 'canceled')).toHaveLength(1);
  });

  it('timeout po provedeném cancelu se potvrdí přes order lookup', async () => {
    const broker = createMockBroker({
      behavior: () => ({ kind: 'working' }),
      cancelBehavior: () => 'timeout-after-cancel',
    });
    const clock = stepClock();
    const opened = await processLeaderEvent({
      event: event(), group: soloGroup, runtime: createRuntime(createCopierState()),
      context: liveGate(), broker, clock,
    });
    const canceled = await processLeaderEvent({
      event: event({ id: 'e2', kind: 'canceled', sequence: 2 }), group: soloGroup,
      runtime: opened.runtime, context: liveGate(), broker, clock,
    });
    expect(canceled.audit.some(item => item.kind === 'canceled')).toBe(true);
    expect(canceled.runtime.cancelOutbox.values().next().value?.status).toBe('confirmed');
  });

  it('timeout před cancellem zůstane unknown a neposune sekvenci', async () => {
    const store = createMemoryCopierStore();
    const broker = createMockBroker({
      behavior: () => ({ kind: 'working' }),
      cancelBehavior: () => 'timeout-before-cancel',
    });
    const clock = stepClock();
    const opened = await processLeaderEvent({
      event: event(), group: soloGroup, runtime: createRuntime(createCopierState()),
      context: liveGate(), broker, clock, store,
    });
    const canceled = await processLeaderEvent({
      event: event({ id: 'e2', kind: 'canceled', sequence: 2 }), group: soloGroup,
      runtime: opened.runtime, context: liveGate(), broker, clock, store,
    });
    expect(canceled.runtime.state.lastSequence).toBe(1);
    expect([...canceled.runtime.cancelOutbox.values()][0].status).toBe('unknown');
    expect((await store.load()).cancelOutbox[0].status).toBe('unknown');
    const brokerOrderId = broker.orders()[0].brokerOrderId;
    await processLeaderEvent({
      event: event({ id: 'e2', kind: 'canceled', sequence: 2 }), group: soloGroup,
      runtime: canceled.runtime, context: liveGate(), broker, clock, store,
    });
    expect(broker.cancelRequestCount(brokerOrderId)).toBe(1);
  });
});

describe('změna pracovní objednávky', () => {
  it('změní follower quantity/cenu a potvrdí změnu přes order stream', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const clock = stepClock();
    const opened = await processLeaderEvent({
      event: event({ orderType: 'Limit', limitPrice: 29_500 }), group: soloGroup,
      runtime: createRuntime(createCopierState()), context: liveGate(), broker, clock,
    });
    const modified = await processLeaderEvent({
      event: event({ id: 'e2', kind: 'replaced', quantity: 3, limitPrice: 29_600, orderType: 'Limit', sequence: 2 }),
      group: soloGroup, runtime: opened.runtime, context: liveGate(), broker, clock,
    });
    expect(modified.audit.some(item => item.kind === 'modified')).toBe(true);
    expect(broker.orders()[0]).toMatchObject({ quantity: 3, limitPrice: 29_600 });
  });

  it('změnu follower objednávky po DISARM neodešle', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const clock = stepClock();
    const opened = await processLeaderEvent({
      event: event({ orderType: 'Limit', limitPrice: 29_500 }), group: soloGroup,
      runtime: createRuntime(createCopierState()), context: liveGate(), broker, clock,
    });
    const modified = await processLeaderEvent({
      event: event({ id: 'e2', kind: 'replaced', quantity: 3, limitPrice: 29_600, orderType: 'Limit', sequence: 2 }),
      group: soloGroup, runtime: opened.runtime,
      context: liveGate({ armed: false }), broker, clock,
    });

    expect(modified.audit).toContainEqual(expect.objectContaining({ kind: 'blocked', reason: 'disarmed' }));
    expect(broker.orders()[0]).toMatchObject({ quantity: 1, limitPrice: 29_500, status: 'working' });
    expect(modified.runtime.state.lastSequence).toBe(1);
  });
});

describe('serializace a live pojistka', () => {
  it('živý broker bez durable store nic neodešle', async () => {
    const broker = createMockBroker({ environment: 'live' });
    const result = await processLeaderEvent({
      event: event(), group: soloGroup, runtime: createRuntime(createCopierState()),
      context: liveGate({ brokerEnvironment: 'live', expectedEnvironment: 'live' }), broker,
      clock: stepClock(),
    });
    expect(broker.placedRequests()).toHaveLength(0);
    expect(result.audit.some(item => item.reason === 'durable-store-required')).toBe(true);
  });

  it('zpracuje překrývající se leader callbacky striktně za sebou', async () => {
    const broker = createMockBroker();
    const processor = createSerialCopierProcessor(createRuntime(createCopierState()));
    const clock = stepClock();
    const common = { group: soloGroup, context: liveGate(), broker, clock };
    const [first, second] = await Promise.all([
      processor.process({ ...common, event: event({ id: 'e1', sequence: 1 }) }),
      processor.process({ ...common, event: event({ id: 'e2', orderId: 'o2', sequence: 2 }) }),
    ]);
    expect(first.runtime.state.lastSequence).toBe(1);
    expect(second.runtime.state.lastSequence).toBe(2);
    expect(broker.placedRequests()).toHaveLength(2);
  });
});

describe('metriky latence', () => {
  it('měří od přijetí leader události, ne až od začátku odesílání', async () => {
    const broker = createMockBroker();
    const clock = stepClock();
    const result = await processLeaderEvent({
      event: event({ receivedAt: 0 }),
      group: soloGroup,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock,
    });

    const sample = result.metrics.samples[0];
    expect(sample.queueMs).toBeGreaterThan(0);
    expect(sample.totalMs).toBe(sample.queueMs + sample.brokerMs);
  });

  it('odděluje command ack, order acceptance, first fill a terminal event', async () => {
    const broker = createMockBroker();
    const metrics = createCopierMetrics();
    const clock = stepClock();
    const detach = attachCopierMetrics(broker, metrics, clock);
    const result = await processLeaderEvent({
      event: event(), group: soloGroup, runtime: createRuntime(createCopierState()),
      context: liveGate(), broker, clock, metrics,
    });
    detach();
    expect(result.metrics.samples[0]).toMatchObject({
      orderAcceptedMs: expect.any(Number),
      firstFillMs: expect.any(Number),
      terminalMs: expect.any(Number),
    });
  });

  it('followery odesílá souběžně, ne jeden po druhém', async () => {
    // Sekvenční odesílání by poslednímu followerovi započítalo čekání na
    // všechny předchozí a měření latence by lhalo. Ověřujeme překryv volání.
    const inner = createMockBroker();
    let inFlight = 0;
    let maxInFlight = 0;
    const broker = {
      ...inner,
      async placeOrder(request: Parameters<typeof inner.placeOrder>[0]) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        const ack = await inner.placeOrder(request);
        inFlight -= 1;
        return ack;
      },
    };

    await processLeaderEvent({
      event: event(),
      group,
      runtime: createRuntime(createCopierState()),
      context: liveGate(),
      broker,
      clock: stepClock(),
    });

    expect(maxInFlight).toBe(2);
  });
});

describe('percentile', () => {
  it('počítá p50 a p95', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
  });

  it('prázdný vstup vrací nulu', () => {
    expect(percentile([], 95)).toBe(0);
  });
});
