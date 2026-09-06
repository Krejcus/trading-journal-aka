import { describe, expect, it } from 'vitest';
import { createBacktestAnalyticsWorkerRuntime } from '../services/backtestAnalyticsWorkerRuntime';
import { createBacktestAnalyticsWorkerClient, type BacktestAnalyticsWorkerPort } from '../services/backtestAnalyticsWorkerClient';
import { createBacktestAnalyticsPlanner, planBacktestAnalyticsRefresh, type BacktestAnalyticsRefreshInput } from '../services/backtestAnalyticsRefresh';
import { backtestClosedTradeToTrade, createBacktestTradeMapper } from '../services/backtestIntel';
import { createBacktestContextSource } from '../services/backtestEntryContext';
import type { BacktestAnalyticsWorkerRequest, BacktestAnalyticsWorkerResponse } from '../services/backtestAnalyticsWorkerProtocol';
import type { BacktestClosedTrade } from '../services/backtestTypes';
const T = Date.UTC(2026, 8, 4, 12) / 1000;
const bars = Array.from({ length: 70 }, (_, i) => ({ time: T + (i - 68) * 60, open: 100, high: 101, low: 100, close: 100, volume: 1 }));
const closed: BacktestClosedTrade = { id: 'closed', runId: 'run', instrument: 'MNQ', direction: 'Long', quantity: 1, entryPrice: 100, exitPrice: 100, entryTime: T, exitTime: T + 60, grossPnl: 0, pnl: 0, commission: 0, reason: 'manual', initialStopLoss: 99, initialTakeProfit: 102, riskAmount: 2 };
const mapping = { accountId: 'account', timeZone: 'UTC', orderEvents: [], flatTimeZone: 'UTC', flatByMinute: 12 * 60 + 2, replayHorizonTime: T + 60 };
const trade = backtestClosedTradeToTrade(closed, { ...mapping, candles: bars });
const input: BacktestAnalyticsRefreshInput = { trades: [trade], closedTrades: [closed], candlesByInstrument: { MNQ: bars }, mappingOptions: mapping, replayHorizonTime: T + 60 };
class Port implements BacktestAnalyticsWorkerPort {
  messages: BacktestAnalyticsWorkerRequest[] = [];
  listeners = new Map<string, Set<EventListener>>();
  terminated = false;
  runtime = createBacktestAnalyticsWorkerRuntime();
  replies: BacktestAnalyticsWorkerResponse[] = [];
  postMessage(message: BacktestAnalyticsWorkerRequest) {
    const copy = structuredClone(message); this.messages.push(copy);
    const response = this.runtime.handle(copy); if (response) this.replies.push(response);
  }
  flush() { const response = this.replies.shift(); if (response) for (const fn of this.listeners.get('message') ?? []) fn({ data: response } as unknown as Event); }
  terminate() { this.terminated = true; }
  addEventListener(type: string, listener: EventListener) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
}
const setup = () => { const port = new Port(); const client = createBacktestAnalyticsWorkerClient({ scopeKey: 'owner:run', workerFactory: () => port }); client.setSources({ candlesByInstrument: { MNQ: bars } }); return { port, client }; };
describe('persistent planner and trusted mapper', () => {
  it('matches stateless results, then reuses hashes and invalidates corrections/events/config', () => {
    const planner = createBacktestAnalyticsPlanner();
    const [first] = planner.plan(input);
    expect(first).toEqual(planBacktestAnalyticsRefresh(input)[0]);
    const saved = { ...trade, ...first.updates, backtestAnalyticsRefresh: first.stamp };
    const before = structuredClone(planner.diagnostics);
    for (let i = 0; i < 5; i++) expect(planner.plan({ ...input, trades: [saved] })).toEqual([]);
    expect(planner.diagnostics).toEqual(before);
    const corrected = { ...input, trades: [saved], candlesByInstrument: { MNQ: bars.map((bar, i) => i === 69 ? { ...bar, high: 101.5 } : bar) } };
    expect(planner.plan(corrected)).toEqual(planBacktestAnalyticsRefresh(corrected));
    const fees = { ...input, trades: [saved], slippageTicks: { MNQ: 2 } };
    expect(planner.plan(fees)).toEqual(planBacktestAnalyticsRefresh(fees));
    const events = { ...input, trades: [saved], mappingOptions: { ...mapping, orderEvents: [{ id: 'e', runId: 'run', orderId: 'o', instrument: 'MNQ' as const, kind: 'created' as const, marketTime: T }] } };
    expect(planner.plan(events)).toEqual(planBacktestAnalyticsRefresh(events));
  });
  it('reuses a bounded context across trades and ignores a supplied poisoned future context', () => {
    const mapper = createBacktestTradeMapper();
    const future = [...bars, { ...bars[69], time: T + 120, high: 1000 }];
    const opts = { ...mapping, candles: future, contextSource: createBacktestContextSource({ candles: future, timeZone: 'UTC' }) };
    expect(mapper.map(closed, opts)).toEqual(trade);
    expect(mapper.map({ ...closed, id: 'second' }, opts)).toEqual({ ...trade, id: 'second' });
    expect(mapper.diagnostics.contextBuilds).toBe(1);
    expect(mapper.map(closed, { ...opts, replayHorizonTime: T + 120 })).toEqual(backtestClosedTradeToTrade(closed, { ...opts, replayHorizonTime: T + 120 }));
    expect(mapper.diagnostics.contextBuilds).toBe(2);
  });
});
describe('analytics worker transport', () => {
  it('sends sources/ledger only on identity changes and strips private payloads', async () => {
    const { port, client } = setup();
    const privateInput = { ...input, trades: [{ ...trade, notes: 'SECRET', screenshots: ['SECRET'], noteHistory: { version: 1 as const, revision: 1, revisions: [{
      id: 'rev', noteId: 'note', operationId: 'op', revision: 1, parentRevision: 0, supersedesId: null,
      phase: 'after' as const, operation: 'write' as const, text: 'SECRET', clientCapturedAt: T * 1000,
      captureContext: { marketTime: T, maxRevealedMarketTime: T, closedTradeReview: true }, marketTime: T,
      knowledgeHorizonTime: T, retrospective: true, retrospectiveReason: 'closed-trade-review' as const, source: 'user' as const,
    }] } }] };
    const first = client.plan(privateInput); port.flush(); expect(await first).toEqual(planBacktestAnalyticsRefresh(input));
    const second = client.plan(privateInput); port.flush(); await second;
    expect(port.messages.filter(m => m.type === 'sources')).toHaveLength(1);
    expect(port.messages.filter(m => m.type === 'ledger')).toHaveLength(1);
    expect(JSON.stringify(port.messages)).not.toContain('SECRET');
    const replacement = bars.map((bar, i) => i === 0 ? { ...bar, volume: 99 } : bar);
    client.setSources({ candlesByInstrument: { MNQ: replacement } });
    const third = client.plan(input); port.flush(); await third;
    expect(port.messages.filter(m => m.type === 'sources')).toHaveLength(2);
    client.dispose();
  });
  it('coalesces refreshes and rejects every superseded promise', async () => {
    const { port, client } = setup();
    const first = client.plan(input).catch(error => error.name);
    const second = client.plan(input).catch(error => error.name);
    const third = client.plan(input);
    expect(await first).toBe('AbortError'); expect(await second).toBe('AbortError');
    port.flush(); port.flush(); expect(await third).toHaveLength(1);
    expect(port.messages.filter(m => m.type === 'plan')).toHaveLength(2);
    client.dispose();
  });
  it('keeps independent mapping jobs, permits per-request cancellation and rejects stale generations', async () => {
    const { port, client } = setup(); const abort = new AbortController();
    const first = client.mapClosedTrade(closed, mapping, { signal: abort.signal }).catch(error => error.name);
    const second = client.mapClosedTrade({ ...closed, id: 'second' }, mapping);
    abort.abort(); expect(await first).toBe('AbortError'); port.flush(); port.flush(); expect((await second).id).toBe('second');
    const stale = client.plan(input).catch(error => error.name);
    client.setSources({ candlesByInstrument: { MNQ: [...bars] } });
    expect(await stale).toBe('AbortError'); port.flush();
    const waiting = client.plan(input).catch(error => error.name); client.dispose();
    expect(await waiting).toBe('AbortError'); expect(port.terminated).toBe(true);
    await expect(client.plan(input)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('stops without leaving pending promises and restarts with complete source initialization', async () => {
    const ports: Port[] = [];
    const client = createBacktestAnalyticsWorkerClient({ scopeKey: 'owner:run', workerFactory: () => { const port = new Port(); ports.push(port); return port; } });
    client.setSources({ candlesByInstrument: { MNQ: bars } });
    const pending = client.plan(input).catch(error => error.name); client.stop(); expect(await pending).toBe('AbortError');
    const next = client.mapClosedTrade(closed, mapping); ports[1].flush(); expect(await next).toEqual(trade);
    expect(ports[1].messages[0].type).toBe('sources'); client.dispose();
  });
  it('settles active and queued promises on a worker crash', async () => {
    const { port, client } = setup();
    const first = client.mapClosedTrade(closed, mapping).catch(error => error.message);
    const second = client.mapClosedTrade({ ...closed, id: 'other' }, mapping).catch(error => error.message);
    for (const listener of port.listeners.get('error') ?? []) listener({ message: 'worker crashed' } as unknown as Event);
    expect(await first).toBe('worker crashed'); expect(await second).toBe('worker crashed');
    expect(port.terminated).toBe(true); client.dispose();
  });
  it('rejects future closes and cross-scope worker use', () => {
    const runtime = createBacktestAnalyticsWorkerRuntime();
    runtime.handle({ type: 'sources', scopeKey: 'a', sourceVersion: 1, candles: { MNQ: bars }, htfCandles: {} });
    expect(runtime.handle({ type: 'map', scopeKey: 'b', id: 1, sourceVersion: 1, closed, options: mapping })).toMatchObject({ type: 'error' });
    expect(runtime.handle({ type: 'map', scopeKey: 'a', id: 2, sourceVersion: 1, closed, options: { ...mapping, replayHorizonTime: T } })).toMatchObject({ type: 'error' });
  });
});
