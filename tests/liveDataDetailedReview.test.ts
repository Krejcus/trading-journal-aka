import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal hook scheduler for deterministic state/effect races; no DOM, network,
// Supabase session, worker or broker is created by this test.
const harness = vi.hoisted(() => {
  let slots: any[] = [];
  let cursor = 0;
  let pending: Array<() => void> = [];
  let dirty = false;
  let mounted = true;
  let postUnmountUpdates = 0;
  const changed = (before: any[] | undefined, after: any[] | undefined) => !before || !after || before.length !== after.length || before.some((value, i) => !Object.is(value, after[i]));
  const memo = (factory: () => any, deps?: any[]) => {
    const i = cursor++;
    if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { value: factory(), deps };
    return slots[i].value;
  };
  return {
    reset() { slots.forEach(slot => slot?.cleanup?.()); slots = []; cursor = 0; pending = []; dirty = false; mounted = true; postUnmountUpdates = 0; },
    render<T>(fn: () => T): T { cursor = 0; dirty = false; mounted = true; return fn(); },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); mounted = false; },
    postUnmountUpdates: () => postUnmountUpdates,
    commit() { const effects = pending; pending = []; effects.forEach(effect => effect()); },
    dirty: () => dirty,
    react: {
      useState(initial: any) {
        const i = cursor++;
        if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
        return [slots[i].value, (next: any) => {
          if (!mounted) postUnmountUpdates += 1;
          const value = typeof next === 'function' ? next(slots[i].value) : next;
          if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; }
        }];
      },
      useRef(initial: any) { const i = cursor++; return slots[i] ??= { current: initial }; },
      useMemo: memo,
      useCallback(fn: any, deps: any[]) { return memo(() => fn, deps); },
      useEffect(effect: () => void | (() => void), deps?: any[]) {
        const i = cursor++;
        if (!slots[i] || changed(slots[i].deps, deps)) {
          const previous = slots[i];
          slots[i] = { deps, cleanup: previous?.cleanup };
          pending.push(() => { previous?.cleanup?.(); slots[i].cleanup = effect(); });
        }
      },
      useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) { return getSnapshot(); },
    },
  };
});
const api = vi.hoisted(() => ({
  loadTradovateOAuthStatus: vi.fn(), loadTradovateAccountProfiles: vi.fn(),
  runTradovateReadOnlyPreflight: vi.fn(), runTradovateHistoricalBackfill: vi.fn(),
  runTradovateLivePnlAnchor: vi.fn(), runTradovateLivePnlTick: vi.fn(),
  saveTradovateAccountProfiles: vi.fn(), beginTradovateOAuth: vi.fn(), disconnectTradovateOAuth: vi.fn(),
  TradovateRequestError: class extends Error { constructor(message: string, public status: number, public retryAfterMs: number | null = null) { super(message); } },
}));
vi.mock('react', () => harness.react);
vi.mock('../services/tradovateOAuthConnection', () => api);
vi.mock('../services/storageService', () => ({ storageService: { saveAccounts: vi.fn() } }));
import {
  tradovateClientBackoffMs,
  tradovateForegroundRefreshIds,
  tradovateFullRefreshBackoffMs,
  useTradovateLiveData,
} from '../components/useTradovateLiveData';
import { loadTradovateAccountData } from '../server/tradovateAccountData';
import { tradovateCopyTradeSnapshot } from '../lib/tradovateCopyTradeBridge';
import { isLiveAccountReadVerified } from '../lib/liveReadFreshness';
import type { TradovatePreflightResult } from '../services/tradovateOAuthConnection';

const now = Date.parse('2026-09-05T10:00:00.000Z');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const dataset = async (connectionId = 'c', cash: unknown = { totalCashValue: 50_000, openPnL: 0 }) => ({
  ...await loadTradovateAccountData({ baseUrl: 'https://mock.invalid/v1', accessToken: 'mock-only', detail: 'bootstrap', now,
    fetchImpl: (async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/account/list')) return json([{ id: connectionId === 'gone' ? 20 : 10, name: connectionId }]);
      if (path.endsWith('/getcashbalancesnapshot')) return json(cash);
      return json([]);
    }) as typeof fetch }),
  connectionId, environment: 'demo', historicalSync: { status: 'unavailable' },
}) as TradovatePreflightResult;
const status = (ids: string[]) => ({ connected: ids.length > 0, environment: 'demo', connections: ids.map(id => ({ id, connected: true, environment: 'demo' })) });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const view = (userId: string, enabled = false) => {
  let value = harness.render(() => useTradovateLiveData(userId, undefined, enabled));
  harness.commit();
  for (let i = 0; harness.dirty() && i < 20; i++) {
    value = harness.render(() => useTradovateLiveData(userId, undefined, enabled));
    harness.commit();
  }
  if (harness.dirty()) throw new Error('Hook state did not stabilize within 20 renders.');
  return value;
};
let timers: Array<{ callback: () => void; delay: number; cleared: boolean; id: number }> = [];
let nextTimerId = 1;
let listeners: Record<string, Array<() => void>> = {};
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  harness.reset();
  const storage = new Map<string, string>();
  timers = [];
  listeners = {};
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: (type: string, listener: () => void) => { (listeners[`document:${type}`] ??= []).push(listener); },
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('window', {
    setTimeout: vi.fn((callback: () => void, delay: number) => {
      const id = nextTimerId++;
      timers.push({ callback, delay, cleared: false, id });
      return id;
    }),
    clearTimeout: vi.fn((id: number) => {
      const timer = timers.find(candidate => candidate.id === id);
      if (timer) timer.cleared = true;
    }),
    setInterval: vi.fn(() => 1), clearInterval: vi.fn(),
    addEventListener: (type: string, listener: () => void) => { (listeners[`window:${type}`] ??= []).push(listener); },
    removeEventListener: vi.fn(),
    location: { search: '', pathname: '/', hash: '' }, history: { replaceState: vi.fn() },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  api.loadTradovateAccountProfiles.mockResolvedValue({ profiles: [] });
});
afterEach(() => { harness.reset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('detailed LIVE data reliability regressions', () => {
  it('revokes a removed connection dataset after fresh status still contains another active connection', async () => {
    const keep = await dataset('keep');
    const gone = await dataset('gone');
    api.loadTradovateOAuthStatus.mockResolvedValueOnce(status(['keep', 'gone'])).mockResolvedValue(status(['keep']));
    api.runTradovateReadOnlyPreflight.mockImplementation(async id => id === 'gone' ? gone : keep);
    await view('review-prune').refreshStatus();
    await settle();
    expect(Object.keys(view('review-prune').connectionData).sort()).toEqual(['gone', 'keep']);
    await view('review-prune').refreshStatus();
    await settle();
    expect(Object.keys(view('review-prune').connectionData)).toEqual(['keep']);
  });

  it('honors a bootstrap 429 instead of immediately retrying the full read', async () => {
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['c']));
    api.runTradovateReadOnlyPreflight.mockRejectedValue(new api.TradovateRequestError('rate limited', 429, 60_000));
    await view('review-rate-limit').refreshStatus();
    expect(api.runTradovateReadOnlyPreflight.mock.calls.map(call => call[1])).toEqual(['bootstrap']);
  });

  it('does not expose the previous users data in the identity-change render', async () => {
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['c']));
    api.runTradovateReadOnlyPreflight.mockResolvedValue(await dataset());
    await view('review-user-a').refreshStatus();
    await settle();
    expect(view('review-user-a').data?.accounts).toHaveLength(1);
    const firstRenderForB = harness.render(() => useTradovateLiveData('review-user-b', undefined, false));
    expect(firstRenderForB.data).toBeNull();
    harness.commit();
  });

  it('blocks manual retries until Retry-After expires, then allows a new read', async () => {
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['c']));
    api.runTradovateReadOnlyPreflight.mockRejectedValue(new api.TradovateRequestError('rate limited', 429, 60_000));
    await view('review-expiry').refreshStatus();
    await view('review-expiry').refreshData(true);
    expect(api.runTradovateReadOnlyPreflight).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(now + 60_001);
    api.runTradovateReadOnlyPreflight.mockResolvedValue(await dataset());
    await view('review-expiry').refreshData(true);
    expect(api.runTradovateReadOnlyPreflight).toHaveBeenCalledTimes(2);
  });

  it('retains a successful connection but skips full retry when another bootstrap is rate limited', async () => {
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['keep', 'gone']));
    const keep = await dataset('keep');
    api.runTradovateReadOnlyPreflight.mockImplementation(async id => {
      if (id === 'gone') throw new api.TradovateRequestError('rate limited', 429, 60_000);
      return keep;
    });
    await view('review-partial-429').refreshStatus();
    await settle();
    expect(Object.keys(view('review-partial-429').connectionData)).toEqual(['keep']);
    expect(api.runTradovateReadOnlyPreflight.mock.calls.filter(call => call[0] === 'gone').map(call => call[1])).toEqual(['bootstrap']);
    expect(api.runTradovateReadOnlyPreflight.mock.calls.some(call => call[0] === 'keep' && call[1] === 'full')).toBe(true);
    expect(view('review-partial-429').dataEnrichmentByConnection.keep.pending).toBe(false);
    expect(view('review-partial-429').dataEnrichmentByConnection.gone.pending).toBe(false);
    api.runTradovateReadOnlyPreflight.mockClear();
    await view('review-partial-429').refreshData(true);
    expect(api.runTradovateReadOnlyPreflight.mock.calls.map(call => call[0])).toEqual(['keep']);
  });

  it('retries failed full enrichment per connection after 15/30/60 seconds', async () => {
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['fast', 'slow']));
    const fast = await dataset('fast');
    const slow = await dataset('slow');
    api.runTradovateReadOnlyPreflight.mockImplementation(async (id, detail) => {
      if (detail === 'bootstrap') return id === 'fast' ? fast : slow;
      if (id === 'slow') throw new Error('slow full failed');
      return fast;
    });
    await view('review-per-connection-retry').refreshStatus();
    await settle();
    const state = view('review-per-connection-retry').dataEnrichmentByConnection;
    expect(state.fast).toMatchObject({ pending: false, failureCount: 0 });
    expect(state.slow).toMatchObject({ pending: false, failureCount: 1, retryAt: now + 15_000 });
    view('review-per-connection-retry', true);
    expect(vi.mocked(window.setTimeout).mock.calls.some(call => call[1] === 15_000)).toBe(true);
    expect([1, 2, 3, 8].map(tradovateFullRefreshBackoffMs)).toEqual([15_000, 30_000, 60_000, 600_000]);
  });

  it('spustí retry timer nejvýše jednou, i když nový full request zůstane viset', async () => {
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['c']));
    const current = await dataset('c');
    let fullCalls = 0;
    api.runTradovateReadOnlyPreflight.mockImplementation(async (_id, detail) => {
      if (detail === 'bootstrap') return current;
      fullCalls += 1;
      if (fullCalls === 1) throw new Error('500 full failed');
      return new Promise(() => {});
    });
    await view('review-real-retry-timer').refreshStatus();
    await settle();
    view('review-real-retry-timer', true);
    expect(view('review-real-retry-timer', true).dataEnrichmentByConnection.c)
      .toMatchObject({ pending: false, failureCount: 1, retryAt: now + 15_000 });

    vi.mocked(Date.now).mockReturnValue(now + 15_000);
    for (let round = 0; round < 20; round += 1) {
      const due = timers.filter(timer => !timer.cleared && (timer.delay === 15_000 || timer.delay === 0));
      if (due.length === 0) break;
      for (const timer of due) {
        timer.cleared = true;
        timer.callback();
      }
      await settle();
      view('review-real-retry-timer', true);
    }
    expect(fullCalls).toBe(2);
  });

  it('respects explicit Retry-After and keeps only the fallback bounded', () => {
    expect(tradovateClientBackoffMs(null)).toBe(300_000);
    expect(tradovateClientBackoffMs(60_000)).toBe(60_000);
    expect(tradovateClientBackoffMs(3_600_000)).toBe(3_600_000);
  });

  it('na návratu do popředí obnoví pending a starší než pět minut, ne čerstvé spojení', () => {
    expect(tradovateForegroundRefreshIds(['pending', 'stale', 'fresh'], {
      pending: { pending: true, lastFullSuccessAt: null, retryAt: now + 15_000, failureCount: 1, error: 'failed' },
      stale: { pending: false, lastFullSuccessAt: now - 5 * 60_000, retryAt: null, failureCount: 0, error: null },
      fresh: { pending: false, lastFullSuccessAt: now - 60_000, retryAt: null, failureCount: 0, error: null },
    }, now)).toEqual(['stale']);
    expect(tradovateForegroundRefreshIds(['pending'], {
      pending: { pending: false, lastFullSuccessAt: null, retryAt: now, failureCount: 1, error: 'failed' },
    }, now)).toEqual(['pending']);
  });

  it('sloučí visibilitychange a focus a respektuje běžící full request', async () => {
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['c']));
    const current = await dataset('c');
    let fullCalls = 0;
    let release!: (value: TradovatePreflightResult) => void;
    api.runTradovateReadOnlyPreflight.mockImplementation(async (_id, detail) => {
      if (detail === 'bootstrap') return current;
      fullCalls += 1;
      if (fullCalls === 1) return current;
      return new Promise<TradovatePreflightResult>(resolve => { release = resolve; });
    });
    await view('review-foreground-coalesce', true).refreshStatus();
    await settle();
    view('review-foreground-coalesce', true);
    vi.mocked(Date.now).mockReturnValue(now + 6 * 60_000);
    const before = fullCalls;
    listeners['document:visibilitychange']?.[0]?.();
    listeners['window:focus']?.[0]?.();
    await settle();
    expect(fullCalls - before).toBe(1);
    release(current);
    await settle();
  });

  it('zapíše prefetch 429 do per-connection backoffu a entry ho neopakuje', async () => {
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['c']));
    api.runTradovateReadOnlyPreflight.mockRejectedValue(
      new api.TradovateRequestError('prefetch limited', 429, 90_000),
    );
    const hook = view('review-prefetch-429', false);
    hook.prefetch();
    await settle();
    await view('review-prefetch-429', false).refreshStatus();
    await settle();
    expect(api.runTradovateReadOnlyPreflight).toHaveBeenCalledTimes(1);
  });

  it('honors a 429 embedded in partial HTTP 200 source coverage', async () => {
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['c']));
    const partial = await dataset();
    partial.coverage.positions = { availability: 'unavailable', count: 0, httpStatus: 429, retryAfterMs: 12_000 };
    api.runTradovateReadOnlyPreflight.mockResolvedValue(partial);
    await view('review-coverage-429').refreshStatus();
    await view('review-coverage-429').refreshData(true);
    expect(api.runTradovateReadOnlyPreflight).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(now + 12_001);
    api.runTradovateReadOnlyPreflight.mockResolvedValue(await dataset());
    await view('review-coverage-429').refreshData(true);
    expect(api.runTradovateReadOnlyPreflight).toHaveBeenCalledTimes(2);
  });

  it('cannot resurrect a removed connection when an earlier full read resolves late', async () => {
    const keep = await dataset('keep');
    const gone = await dataset('gone');
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['keep', 'gone']));
    api.runTradovateReadOnlyPreflight.mockImplementation(async id => id === 'gone' ? gone : keep);
    await view('review-late-removed').refreshStatus();
    await settle();
    const late = deferred<TradovatePreflightResult>();
    api.runTradovateReadOnlyPreflight.mockImplementation(async id => id === 'gone' ? late.promise : keep);
    const oldRefresh = view('review-late-removed').refreshData(true);
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['keep']));
    await view('review-late-removed').refreshStatus();
    late.resolve(gone);
    await oldRefresh;
    await settle();
    expect(Object.keys(view('review-late-removed').connectionData)).toEqual(['keep']);
  });

  it('drops an old bootstrap after switching from user A to B', async () => {
    const old = deferred<TradovatePreflightResult>();
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['c']));
    api.runTradovateReadOnlyPreflight.mockReturnValue(old.promise);
    const refreshing = view('review-epoch-a').refreshStatus();
    await settle();
    expect(api.runTradovateReadOnlyPreflight).toHaveBeenCalledTimes(1);
    expect(view('review-epoch-b').data).toBeNull();
    old.resolve(await dataset());
    await refreshing;
    await settle();
    expect(view('review-epoch-b').data).toBeNull();
  });

  it('does not accept a former user A response after A -> B -> A', async () => {
    const initial = await dataset();
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['c']));
    api.runTradovateReadOnlyPreflight.mockResolvedValue(initial);
    await view('review-return-a').refreshStatus();
    await settle();
    const old = deferred<TradovatePreflightResult>();
    api.runTradovateReadOnlyPreflight.mockReturnValue(old.promise);
    const loading = view('review-return-a').refreshData(true);
    view('review-return-b');
    view('review-return-a');
    old.resolve({ ...initial, accounts: initial.accounts.map(account => ({ ...account, name: 'obsolete response' })) });
    await loading;
    expect(view('review-return-a').data?.accounts[0].name).toBe('c');
  });

  it('does not restore data from the former authorization after a connection is removed and re-added', async () => {
    const keep = await dataset('keep');
    const gone = await dataset('gone');
    const fresh = { ...gone, accounts: gone.accounts.map(account => ({ ...account, name: 'reconnected' })) };
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['keep', 'gone']));
    api.runTradovateReadOnlyPreflight.mockImplementation(async id => id === 'gone' ? gone : keep);
    await view('review-connection-return').refreshStatus();
    await settle();
    const old = deferred<TradovatePreflightResult>();
    api.runTradovateReadOnlyPreflight.mockImplementation(async id => id === 'gone' ? old.promise : keep);
    const loading = view('review-connection-return').refreshData(true);
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['keep']));
    await view('review-connection-return').refreshStatus();
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['keep', 'gone']));
    api.runTradovateReadOnlyPreflight.mockImplementation(async id => id === 'gone' ? fresh : keep);
    await view('review-connection-return').refreshStatus();
    await settle();
    old.resolve(gone);
    await loading;
    expect(view('review-connection-return').connectionData.gone.accounts[0].name).toBe('reconnected');
  });

  it('revokes a pending bootstrap on unmount and does not start enrichment', async () => {
    const pending = deferred<TradovatePreflightResult>();
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['c']));
    api.runTradovateReadOnlyPreflight.mockReturnValue(pending.promise);
    const loading = view('review-unmount').refreshStatus();
    await settle();
    harness.unmount();
    pending.resolve(await dataset());
    await loading;
    await settle();
    expect(api.runTradovateReadOnlyPreflight).toHaveBeenCalledTimes(1);
    expect(harness.postUnmountUpdates()).toBe(0);
  });

  it('drops historical backfill that resolves after changing users', async () => {
    api.loadTradovateOAuthStatus.mockResolvedValue(status(['c']));
    api.runTradovateReadOnlyPreflight.mockResolvedValue(await dataset());
    await view('review-history-a').refreshStatus();
    await settle();
    const historical = deferred<unknown>();
    api.runTradovateHistoricalBackfill.mockReturnValue(historical.promise);
    view('review-history-a', true);
    const historyTimer = vi.mocked(window.setTimeout).mock.calls.find(call => call[1] === 5_000);
    expect(historyTimer).toBeDefined();
    (historyTimer![0] as () => void)();
    expect(api.runTradovateHistoricalBackfill).toHaveBeenCalledTimes(1);
    view('review-history-b');
    historical.resolve({ sync: { accountId: 10, status: 'complete' } });
    await settle();
    expect(view('review-history-b').historySnapshots).toEqual({});
  });

  it('keeps an empty HTTP 200 cash object unverified at the copier boundary', async () => {
    const result = await dataset('c', {});
    const account = tradovateCopyTradeSnapshot(result, []).accounts[0];
    expect(result.accounts[0].balance.totalCashValue).toBeNull();
    expect(isLiveAccountReadVerified(account, 'cash', now)).toBe(false);
  });

  it('keeps an explicit failed cash read unverified', async () => {
    const result = await dataset('c', { errorText: 'unavailable' });
    expect(isLiveAccountReadVerified(tradovateCopyTradeSnapshot(result, []).accounts[0], 'cash', now)).toBe(false);
  });
});
