import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createSessionRequestGuard } from '../utils/sessionRequestGuard';

const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string, context: Record<string, unknown>) {
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name && node.initializer) {
      expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!expression) throw new Error(`Missing actual App callback ${name}`);
  const js = ts.transpile(`const run = ${expression.getText(parsed)};`, { target: ts.ScriptTarget.ES2022 });
  return new Function('context', `with (context) { ${js}; return run; }`)(context) as () => Promise<void>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture() {
  let identity = { userId: 'A', epoch: 1 };
  const capture = (id: string) => createSessionRequestGuard(id, () => identity);
  const setTrades = vi.fn();
  const storage = { getCachedDashboardData: vi.fn(), getDashboardData: vi.fn() } as any;
  const context = {
    isCurrentSession: capture('A'), captureSessionRequest: capture,
    session: { user: { id: 'A' } }, storageService: storage,
    isFetchingRef: { current: false }, lastLoadedSessionId: { current: null },
    isInitialLoadDone: false, loading: true, setLoadedUserId: vi.fn(),
    localStorage: { getItem: () => null }, safeSetItem: vi.fn(),
    setTrades, setAccounts: vi.fn(), setCurrentUser: vi.fn(), setLoading: vi.fn(),
    setIsInitialLoadDone: vi.fn(), setInitStatus: vi.fn(), setAppError: vi.fn(),
    setDailyPreps: vi.fn(), setDailyReviews: vi.fn(),
    isSyncedWithDbRef: { current: false },
    isPrepsDirty: { current: false }, isReviewsDirty: { current: false },
    isPreferencesDirty: { current: false }, document: { visibilityState: 'visible' },
    lastVisibleAt: { current: Date.now() - 60_000 },
  };
  return { context, storage, setTrades, switchUser: (userId: string | null) => { identity = { userId, epoch: identity.epoch + 1 }; } };
}
afterEach(() => vi.useRealTimers());
describe('session isolation across asynchronous App reads', () => {
  it('invalidates even logout/login back to the same account, and rejects stale captured user IDs', () => {
    const f = fixture();
    expect(f.context.isCurrentSession()).toBe(true);
    f.switchUser(null); f.switchUser('A');
    expect(f.context.isCurrentSession()).toBe(false);
    expect(f.context.captureSessionRequest('B')()).toBe(false);
    expect(f.context.captureSessionRequest('A')()).toBe(true);
  });
  it('keeps work valid when a same-user token refresh preserves the auth epoch', () => {
    let context = { userId: 'A', epoch: 2 };
    const current = createSessionRequestGuard('A', () => context);
    context = { ...context };
    expect(current()).toBe(true);
  });
  it('actual cache-first load rejects A cache that resolves after B signs in', async () => {
    vi.useFakeTimers();
    const f = fixture(); const cache = deferred<any>();
    f.storage.getCachedDashboardData.mockReturnValue(cache.promise);
    const running = callback('load', f.context)();
    f.switchUser('B');
    cache.resolve({ user: { id: 'A' }, trades: [{ id: 'A-secret' }] });
    await running;
    expect(f.setTrades).not.toHaveBeenCalled();
    expect(f.storage.getDashboardData).not.toHaveBeenCalled();
  });
  it('actual blocking load cannot repopulate A or release a newer request after logout', async () => {
    vi.useFakeTimers();
    const f = fixture(); const dashboard = deferred<any>();
    f.storage.getCachedDashboardData.mockResolvedValue(null);
    f.storage.getDashboardData.mockReturnValue(dashboard.promise);
    const running = callback('load', f.context)();
    await Promise.resolve(); await Promise.resolve();
    expect(f.storage.getDashboardData).toHaveBeenCalledOnce();
    f.switchUser('B'); f.context.isFetchingRef.current = true;
    dashboard.resolve({ user: { id: 'A' }, trades: [{ id: 'A-secret' }] });
    await running;
    expect(f.setTrades).not.toHaveBeenCalled();
    expect(f.context.isFetchingRef.current).toBe(true);
  });
  it('actual pull refresh drops all old-user responses', async () => {
    const f = fixture(); const response = deferred<any>();
    for (const name of ['getTrades', 'getAccounts', 'getDailyPreps', 'getDailyReviews', 'getPreferences', 'getUser', 'getWeeklyFocusList', 'getBusinessPayouts', 'getBusinessExpenses', 'getBusinessGoals', 'getBusinessResources']) f.storage[name] = () => response.promise;
    const running = callback('handleRefreshData', f.context)();
    f.switchUser('B'); response.resolve([{ id: 'A-secret' }]); await running;
    expect(f.setTrades).not.toHaveBeenCalled();
    expect(f.context.setCurrentUser).not.toHaveBeenCalled();
  });
  it('actual focus sync stops before applying old preps or starting another user query', async () => {
    const f = fixture(); const response = deferred<any>();
    f.storage.getDailyPreps = () => response.promise;
    f.storage.getDailyReviews = () => response.promise;
    f.storage.getPreferences = vi.fn();
    const running = callback('handleFocusSync', f.context)();
    f.switchUser('B'); response.resolve([{ id: 'A-secret' }]); await running;
    expect(f.context.setDailyPreps).not.toHaveBeenCalled();
    expect(f.storage.getPreferences).not.toHaveBeenCalled();
  });
});

it('actual logout invalidates the session before awaiting native cleanup and then signs out', async () => {
  const cleanup = deferred<void>();
  const original = { user: { id: 'A' } };
  const context = {
    logoutInProgressRef: { current: false }, authEpochRef: { current: 1 }, sessionRef: { current: original as any },
    setSession: vi.fn(), setLogoutBusy: vi.fn(), setLogoutError: vi.fn(),
    clearNativeSessionSurfaces: vi.fn(() => cleanup.promise),
    supabase: { auth: { signOut: vi.fn().mockResolvedValue({ error: null }) } },
    clearAppStorage: vi.fn(), isFetchingRef: { current: true },
    window: { location: { reload: vi.fn() } },
  };
  const running = callback('handleLogout', context)();
  expect(context.sessionRef.current).toBeNull();
  expect(context.authEpochRef.current).toBe(2);
  expect(context.setSession).toHaveBeenCalledWith(null);
  expect(context.logoutInProgressRef.current).toBe(true);
  expect(context.supabase.auth.signOut).not.toHaveBeenCalled();
  cleanup.resolve(); await running;
  expect(context.supabase.auth.signOut).toHaveBeenCalledOnce();
  expect(context.window.location.reload).toHaveBeenCalledOnce();
  expect(context.logoutInProgressRef.current).toBe(true);
  expect(context.setLogoutBusy).not.toHaveBeenCalledWith(false);
});
it('actual failed logout restores the captured session after cleanup for a visible retry', async () => {
  const original = { user: { id: 'A' } };
  const context = {
    logoutInProgressRef: { current: false }, authEpochRef: { current: 1 }, sessionRef: { current: original as any },
    setSession: vi.fn(), setLogoutBusy: vi.fn(), setLogoutError: vi.fn(),
    clearNativeSessionSurfaces: vi.fn().mockResolvedValue(undefined),
    supabase: { auth: { signOut: vi.fn().mockResolvedValue({ error: new Error('offline') }) } },
    clearAppStorage: vi.fn(), isFetchingRef: { current: true },
    window: { location: { reload: vi.fn() } },
  };
  await callback('handleLogout', context)();
  expect(context.sessionRef.current).toBe(original);
  expect(context.authEpochRef.current).toBe(3);
  expect(context.setSession).toHaveBeenLastCalledWith(original);
  expect(context.logoutInProgressRef.current).toBe(false);
  expect(context.clearAppStorage).not.toHaveBeenCalled();
  expect(context.window.location.reload).not.toHaveBeenCalled();
});
it('actual native registration waiting for cleanup cannot restart the outgoing user', async () => {
  const cleanup = deferred<void>();
  const context = {
    cancelled: false, isCurrentSession: () => true, logoutInProgressRef: { current: false },
    waitForNativeSessionCleanup: () => cleanup.promise,
    initializeNativeRemoteNotifications: vi.fn(), initializeNativeWidgetRemote: vi.fn(), initializeNativeLiveActivityPush: vi.fn(),
    userId: 'A', setIsPushActive: vi.fn(),
  };
  const running = callback('refreshNative', context)();
  context.logoutInProgressRef.current = true;
  cleanup.resolve(); await running;
  expect(context.initializeNativeRemoteNotifications).not.toHaveBeenCalled();
  expect(context.initializeNativeWidgetRemote).not.toHaveBeenCalled();
  expect(context.initializeNativeLiveActivityPush).not.toHaveBeenCalled();
});

it.each([
  ['handleUpdateExpenses', 'businessExpenses', 'saveBusinessExpense', 'getBusinessExpenses', 'setBusinessExpenses'],
  ['handleUpdatePayouts', 'businessPayouts', 'saveBusinessPayout', 'getBusinessPayouts', 'setBusinessPayouts'],
  ['handleUpdateGoals', 'businessGoals', 'saveBusinessGoal', 'getBusinessGoals', 'setBusinessGoals'],
  ['handleUpdateResources', 'businessResources', 'saveBusinessResource', 'getBusinessResources', 'setBusinessResources'],
  ['handleAddSingleExpense', 'businessExpenses', 'saveBusinessExpense', 'getBusinessExpenses', 'setBusinessExpenses'],
])('actual %s cannot apply a completed A edit after logout/login B', async (name, state, save, get, setter) => {
  const f = fixture(); const response = deferred<any>(); const set = vi.fn();
  const context: Record<string, any> = { ...f.context, [state]: [], [setter]: set, isUUID: () => true,
    mergePayoutImages: (value: any) => value, stripPayoutImagesForCache: (value: any) => value, setSyncError: vi.fn() };
  f.storage[save] = vi.fn().mockResolvedValue(undefined);
  f.storage[get] = vi.fn(() => response.promise);
  const running = (callback(name, context) as any)(name === 'handleAddSingleExpense' ? { id: 'A-edit' } : [{ id: 'A-edit' }]);
  await Promise.resolve(); await Promise.resolve();
  expect(f.storage[get]).toHaveBeenCalledOnce();
  f.switchUser('B'); response.resolve([{ id: 'A-private-result' }]); await running;
  expect(set).toHaveBeenCalledTimes(1); // The optimistic update before logout only.
  expect(context.safeSetItem).not.toHaveBeenCalled();
});
it('actual BusinessHub edit stops subsequent writes when logout interrupts a multi-item save', async () => {
  const f = fixture(); const first = deferred<void>(); const set = vi.fn();
  f.storage.saveBusinessExpense = vi.fn(() => first.promise);
  f.storage.getBusinessExpenses = vi.fn();
  const running = (callback('handleUpdateExpenses', { ...f.context, businessExpenses: [], setBusinessExpenses: set, isUUID: () => true }) as any)([{ id: 'A-first' }, { id: 'A-second' }]);
  f.switchUser(null); first.resolve(); await running;
  expect(f.storage.saveBusinessExpense).toHaveBeenCalledTimes(1);
  expect(f.storage.getBusinessExpenses).not.toHaveBeenCalled();
  expect(set).toHaveBeenCalledTimes(1);
});
it('actual BusinessHub failed edit cannot roll back B to an A snapshot', async () => {
  const f = fixture(); const set = vi.fn();
  let reject!: (reason: Error) => void;
  f.storage.saveBusinessExpense = () => new Promise<void>((_, fail) => { reject = fail; });
  const running = (callback('handleUpdateExpenses', { ...f.context, businessExpenses: [{ id: 'A-old' }], setBusinessExpenses: set, isUUID: () => true }) as any)([{ id: 'A-new' }]);
  f.switchUser('B'); reject(new Error('offline')); await running;
  expect(set).toHaveBeenCalledTimes(1);
});
