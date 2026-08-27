import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import type { Account } from '../types';
import type { TradovateSourceCoverage } from '../lib/tradovateAccountDataTypes';
import type { TradovateHistorySnapshot } from '../lib/tradovateHistoricalTypes';
import { mergeTradovateHistoricalSnapshot } from '../lib/tradovateHistoricalMerge';
import {
  applyTradovateLivePnlTick,
  tradovateLiveTickClosedLastPosition,
  type TradovateContractMarkMap,
} from '../lib/tradovateLivePnl';
import {
  beginTradovateOAuth,
  disconnectTradovateOAuth,
  loadTradovateAccountProfiles,
  loadTradovateOAuthStatus,
  runTradovateReadOnlyPreflight,
  runTradovateHistoricalBackfill,
  runTradovateLivePnlTick,
  saveTradovateAccountProfiles,
  TradovateRequestError,
  type TradovateOAuthStatus,
  type TradovatePreflightResult,
} from '../services/tradovateOAuthConnection';
import {
  applyTradovateConnectionDataRefresh,
  buildTradovateConnectionSummaries,
  readTradovateConnectionDataCache,
  readTradovateConnectionShell,
  type TradovateConnectionDataRefreshMode,
  writeTradovateConnectionDataCache,
  writeTradovateConnectionShell,
} from '../lib/tradovateLiveConnectionCache';
import {
  getTradovateApiTelemetrySnapshot,
  refreshTradovateApiTelemetry,
  subscribeTradovateApiTelemetry,
} from '../lib/tradovateApiTelemetry';
import { planTradovateJournalAccountLinks } from '../lib/tradovateJournalAccountRegistry';
import {
  buildMissingTradovateOnboardingProfileInputs,
  isTradovateAccountOnboardingAvailable,
} from '../lib/tradovateAccountOnboarding';
import { storageService } from '../services/storageService';

type BusyState = 'status' | 'connect' | 'data' | 'disconnect' | null;

interface TradovateLiveCacheEntry {
  status: TradovateOAuthStatus | null;
  connectionData: Record<string, TradovatePreflightResult>;
  profiles: TradovateAccountProfile[];
  historySnapshots: Record<string, TradovateHistorySnapshot>;
}

// SPA navigation unmounts the LIVE page. Keep the last confirmed read model in
// memory, keyed by AlphaTrade user, so remounting never flashes a false
// disconnected state. Nothing sensitive (OAuth tokens) is stored here.
const tradovateLiveCache = new Map<string, TradovateLiveCacheEntry>();

const mergeCoverage = (values: TradovateSourceCoverage[]): TradovateSourceCoverage => {
  const rank = { unavailable: 0, denied: 1, empty: 2, partial: 3, available: 4 } as const;
  const availability = values.reduce<TradovateSourceCoverage['availability']>(
    (current, value) => rank[value.availability] < rank[current] ? value.availability : current,
    'available',
  );
  return {
    availability,
    count: values.reduce((sum, value) => sum + value.count, 0),
    httpStatus: values.find(value => value.httpStatus != null)?.httpStatus ?? null,
  };
};

const mergePreflights = (datasets: TradovatePreflightResult[]): TradovatePreflightResult | null => {
  if (datasets.length === 0) return null;
  const contracts = new Map(datasets.flatMap(dataset => dataset.contracts).map(contract => [contract.id, contract]));
  const coverageKeys = Object.keys(datasets[0].coverage) as Array<keyof TradovatePreflightResult['coverage']>;
  return {
    connectionId: 'all',
    environment: datasets[0].environment,
    capturedAt: datasets.map(dataset => dataset.capturedAt).sort().at(-1) ?? new Date().toISOString(),
    accounts: datasets.flatMap(dataset => dataset.accounts),
    contracts: [...contracts.values()],
    historicalSync: datasets.find(dataset => dataset.historicalSync.status === 'available')?.historicalSync
      ?? datasets[0].historicalSync,
    coverage: Object.fromEntries(coverageKeys.map(key => [
      key,
      mergeCoverage(datasets.map(dataset => dataset.coverage[key])),
    ])) as TradovatePreflightResult['coverage'],
  };
};

const ACTIVE_PNL_INTERVAL_MS = 2_000;
const IDLE_POSITION_INTERVAL_MS = 5_000;
// At 20 accounts the full preflight is expensive (risk, history, fees, etc.).
// Ten minutes keeps it useful for reconciliation without consuming the budget
// reserved for the 2-second position/P&L read model.
const FULL_REFRESH_INTERVAL_MS = 10 * 60_000;

export function useTradovateLiveData(userId: string, journalOptions?: {
  accounts: readonly Account[] | null;
  onAccountsChanged: (accounts: Account[]) => void;
}, enabled = true) {
  const apiTelemetry = useSyncExternalStore(
    subscribeTradovateApiTelemetry,
    getTradovateApiTelemetrySnapshot,
    getTradovateApiTelemetrySnapshot,
  );
  useEffect(() => {
    if (!userId || !enabled) return;
    refreshTradovateApiTelemetry();
    const timer = window.setInterval(refreshTradovateApiTelemetry, 30_000);
    return () => window.clearInterval(timer);
  }, [enabled, userId]);
  const persisted = useMemo(
    () => readTradovateConnectionShell(userId, typeof window === 'undefined' ? undefined : window.sessionStorage),
    [userId],
  );
  // Poslední čerstvý broker snapshot přežívá i reload stránky. Karta se tak
  // vykreslí okamžitě a 2s P&L tick začne hned aktualizovat pozice, místo aby
  // obojí čekalo na dokončení plného preflightu.
  const persistedData = useMemo(
    () => readTradovateConnectionDataCache(userId, typeof window === 'undefined' ? undefined : window.sessionStorage),
    [userId],
  );
  const cached = userId ? tradovateLiveCache.get(userId) : undefined;
  const [status, setStatus] = useState<TradovateOAuthStatus | null>(() => cached?.status ?? persisted?.status ?? null);
  const [connectionData, setConnectionData] = useState<Record<string, TradovatePreflightResult>>(() => cached?.connectionData ?? persistedData ?? {});
  const [profiles, setProfiles] = useState<TradovateAccountProfile[]>(() => cached?.profiles ?? []);
  const [historySnapshots, setHistorySnapshots] = useState<Record<string, TradovateHistorySnapshot>>(() => cached?.historySnapshots ?? {});
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyBusyRef = useRef(false);
  const livePnlBusyRef = useRef(false);
  const connectionDataRef = useRef(connectionData);
  const livePnlCursorsRef = useRef<Record<string, number>>({});
  const livePnlMarksRef = useRef<Record<string, TradovateContractMarkMap>>({});
  const rateLimitUntilRef = useRef(0);
  const journalLinkAttemptsRef = useRef(new Set<string>());
  const previousUserIdRef = useRef(userId);
  const activeUserIdRef = useRef(userId);
  activeUserIdRef.current = userId;
  const [busy, setBusy] = useState<BusyState>('status');
  const [error, setError] = useState<string | null>(null);
  const [profileSetupOpen, setProfileSetupOpen] = useState(false);

  useEffect(() => {
    if (previousUserIdRef.current === userId) return;
    previousUserIdRef.current = userId;
    journalLinkAttemptsRef.current.clear();
    setStatus(cached?.status ?? persisted?.status ?? null);
    setConnectionData(cached?.connectionData ?? persistedData ?? {});
    setProfiles(cached?.profiles ?? []);
    setHistorySnapshots(cached?.historySnapshots ?? {});
    setHistoryError(null);
    setError(null);
    setProfileSetupOpen(false);
  }, [cached, persisted, persistedData, userId]);

  useEffect(() => {
    connectionDataRef.current = connectionData;
  }, [connectionData]);

  useEffect(() => {
    if (!userId) return;
    tradovateLiveCache.set(userId, { status, connectionData, profiles, historySnapshots });
  }, [connectionData, historySnapshots, profiles, status, userId]);

  // Zápis i prázdné mapy je záměr: po odpojení všech connections přepíše
  // starý snapshot, takže se po reloadu nevrátí data odpojeného účtu.
  useEffect(() => {
    if (!userId) return;
    writeTradovateConnectionDataCache(
      userId,
      connectionData,
      typeof window === 'undefined' ? undefined : window.sessionStorage,
    );
  }, [connectionData, userId]);

  const data = useMemo(() => {
    const merged = mergePreflights(Object.values(connectionData));
    return merged ? {
      ...merged,
      accounts: merged.accounts.map(account => mergeTradovateHistoricalSnapshot(
        account,
        historySnapshots[String(account.id)],
      )),
    } : null;
  }, [connectionData, historySnapshots]);

  useEffect(() => {
    if (!userId || !enabled || !journalOptions?.accounts) return;
    // Plánovač řeší nejen nenamapované profily, ale i hojení už namapovaných
    // účtů (firmOverride, evaluace vs funded) — proto se spouští nad všemi
    // profily; idempotenci hlídá attemptKey + plan.changed.
    if (profiles.length === 0 || Object.keys(connectionData).length === 0) return;
    const attemptKey = profiles
      .map(profile => `${profile.id}:${profile.updatedAt}:${profile.mappedAccountId ?? '-'}`)
      .sort()
      .join('|');
    if (journalLinkAttemptsRef.current.has(attemptKey)) return;
    journalLinkAttemptsRef.current.add(attemptKey);

    const plan = planTradovateJournalAccountLinks({
      accounts: journalOptions.accounts,
      profiles,
      connectionData,
    });
    if (!plan.changed) return;
    void storageService.saveAccounts(plan.accounts).then(async savedAccounts => {
      if (activeUserIdRef.current !== userId) return;
      journalOptions.onAccountsChanged(savedAccounts);
      const savedProfiles = await saveTradovateAccountProfiles(plan.profiles);
      if (activeUserIdRef.current === userId) setProfiles(savedProfiles.profiles);
    }).catch(reason => {
      if (activeUserIdRef.current === userId) {
        setError(reason instanceof Error ? reason.message : 'OAuth účet se nepodařilo propojit s journalem.');
      }
    });
  }, [connectionData, enabled, journalOptions?.accounts, journalOptions?.onAccountsChanged, profiles, userId]);

  const connectionSummaries = useMemo(
    () => buildTradovateConnectionSummaries(
      status,
      connectionData,
      profiles,
      persisted?.summaries,
    ),
    [connectionData, persisted?.summaries, profiles, status],
  );

  useEffect(() => {
    writeTradovateConnectionShell(
      userId,
      status,
      connectionSummaries,
      typeof window === 'undefined' ? undefined : window.sessionStorage,
    );
  }, [connectionSummaries, status, userId]);

  const advanceHistoricalBackfill = useCallback(async (datasets: TradovatePreflightResult[]) => {
    if (historyBusyRef.current || datasets.length === 0) return;
    historyBusyRef.current = true;
    try {
      const results = await Promise.allSettled(datasets.flatMap(dataset => dataset.accounts.map(account =>
        runTradovateHistoricalBackfill({
          connectionId: dataset.connectionId,
          accountId: account.id,
        }),
      )));
      const successful = results
        .filter((result): result is PromiseFulfilledResult<TradovateHistorySnapshot> => result.status === 'fulfilled')
        .map(result => result.value);
      if (successful.length > 0) {
        setHistorySnapshots(current => ({
          ...current,
          ...Object.fromEntries(successful
            .filter(snapshot => snapshot.sync)
            .map(snapshot => [String(snapshot.sync!.accountId), snapshot])),
        }));
        setHistoryError(null);
      }
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed && successful.length === 0) {
        setHistoryError(failed.reason instanceof Error ? failed.reason.message : 'Historický sync se nepodařilo spustit.');
      }
    } finally {
      historyBusyRef.current = false;
    }
  }, []);

  const refreshData = useCallback(async (
    connectionIds: string[],
    quiet = false,
    mode: TradovateConnectionDataRefreshMode = 'replace',
  ) => {
    if (!quiet) setBusy('data');
    setError(null);
    try {
      // Záměrně allSettled: pád jediného preflightu nesmí zahodit profily
      // (a naopak) — karta Účty bez profilů schovává všechna měřidla.
      const [datasetsResult, storedResult] = await Promise.allSettled([
        Promise.all(connectionIds.map(connectionId => runTradovateReadOnlyPreflight(connectionId))),
        loadTradovateAccountProfiles(),
      ]);
      const stored = storedResult.status === 'fulfilled' ? storedResult.value : null;
      if (stored) setProfiles(stored.profiles);
      if (datasetsResult.status === 'rejected') throw datasetsResult.reason;
      const datasets = datasetsResult.value;
      setConnectionData(current => {
        const next = applyTradovateConnectionDataRefresh(current, datasets, mode);
        connectionDataRef.current = next;
        return next;
      });
      if (stored) {
        const storedIds = new Set(stored.profiles.map(profile => profile.externalAccountId));
        const hasMissingProfiles = datasets.flatMap(dataset => dataset.accounts)
          .some(account => !storedIds.has(String(account.id)));
        if (hasMissingProfiles && isTradovateAccountOnboardingAvailable(stored.profiles)) {
          const missing = buildMissingTradovateOnboardingProfileInputs({
            brokerAccounts: datasets.flatMap(dataset => dataset.accounts),
            profiles: stored.profiles,
          });
          if (missing.length > 0) {
            const saved = await saveTradovateAccountProfiles([...stored.profiles, ...missing]);
            setProfiles(saved.profiles);
            setProfileSetupOpen(false);
          }
        } else if (hasMissingProfiles) {
          setProfileSetupOpen(true);
        }
      }
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Tradovate data se nepodařilo načíst.');
      return false;
    } finally {
      if (!quiet) setBusy(null);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!userId) return null;
    setBusy('status');
    setError(null);
    try {
      const nextStatus = await loadTradovateOAuthStatus();
      setStatus(nextStatus);
      const activeConnectionIds = nextStatus.connections.filter(connection => connection.connected).map(connection => connection.id);
      if (activeConnectionIds.length > 0) {
        await refreshData(activeConnectionIds, true);
      } else {
        setConnectionData({});
        const stored = await loadTradovateAccountProfiles().catch(() => null);
        setProfiles(stored?.profiles ?? []);
      }
      return nextStatus;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Stav Tradovate OAuth se nepodařilo načíst.');
      return null;
    } finally {
      setBusy(null);
    }
  }, [refreshData, userId]);

  const connect = useCallback(async (connectionId?: string) => {
    setBusy('connect');
    setError(null);
    try {
      await beginTradovateOAuth(connectionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Tradovate OAuth se nepodařilo spustit.');
      setBusy(null);
    }
  }, []);

  const disconnect = useCallback(async (connectionId: string) => {
    setBusy('disconnect');
    setError(null);
    try {
      await disconnectTradovateOAuth(connectionId);
      await refreshStatus();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Připojení se nepodařilo odpojit.');
      setBusy(null);
    }
  }, [refreshStatus]);

  useEffect(() => {
    if (!userId || !enabled) return;
    void refreshStatus();
    const params = new URLSearchParams(window.location.search);
    if (params.get('tradovate') === 'error') setError('Tradovate OAuth připojení se nepodařilo dokončit.');
    if (params.has('tradovate')) {
      params.delete('tradovate');
      params.delete('reason');
      params.delete('page');
      const suffix = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${suffix ? `?${suffix}` : ''}${window.location.hash}`);
    }
  }, [enabled, refreshStatus, userId]);

  useEffect(() => {
    if (!enabled) return;
    const ids = status?.connections.filter(connection => connection.connected).map(connection => connection.id) ?? [];
    if (ids.length === 0) return;
    const interval = window.setInterval(() => void refreshData(ids, true), FULL_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [enabled, refreshData, status?.connections]);

  useEffect(() => {
    if (!enabled) return;
    const ids = status?.connections.filter(connection => connection.connected).map(connection => connection.id) ?? [];
    if (ids.length === 0) return;
    let cancelled = false;
    let timer: number | null = null;

    const schedule = (delay: number) => {
      if (!cancelled) timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState === 'hidden') {
        schedule(IDLE_POSITION_INTERVAL_MS);
        return;
      }
      if (Date.now() < rateLimitUntilRef.current) {
        schedule(Math.min(IDLE_POSITION_INTERVAL_MS, rateLimitUntilRef.current - Date.now()));
        return;
      }
      if (livePnlBusyRef.current) {
        schedule(ACTIVE_PNL_INTERVAL_MS);
        return;
      }
      const available = ids.filter(id => connectionDataRef.current[id]);
      if (available.length === 0) {
        schedule(1_000);
        return;
      }

      livePnlBusyRef.current = true;
      try {
        const results = await Promise.allSettled(available.map(async connectionId => ({
          connectionId,
          tick: await runTradovateLivePnlTick(connectionId, livePnlCursorsRef.current[connectionId] ?? 0),
        })));
        const successful = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
        const becameFlat = successful
          .filter(({ connectionId, tick }) => {
            const previous = connectionDataRef.current[connectionId];
            return previous ? tradovateLiveTickClosedLastPosition(previous, tick) : false;
          })
          .map(({ connectionId }) => connectionId);
        if (successful.length > 0) {
          setConnectionData(current => {
            const next = { ...current };
            for (const { connectionId, tick } of successful) {
              const dataset = next[connectionId];
              if (!dataset) continue;
              const applied = applyTradovateLivePnlTick(
                dataset,
                tick,
                livePnlMarksRef.current[connectionId] ?? {},
              );
              next[connectionId] = applied.data as TradovatePreflightResult;
              livePnlMarksRef.current[connectionId] = applied.marks;
              livePnlCursorsRef.current[connectionId] = tick.nextContractCursor;
            }
            connectionDataRef.current = next;
            return next;
          });
        }
        // A flat live tick has no cash anchor by design. Refresh exactly once
        // after the close so balance, realized daily P&L, fills and orders do
        // not remain stale until the ten-minute reconciliation or page reload.
        // This is a partial refresh: replacing the whole map here would make
        // unrelated connections (for example Lucid) look disconnected.
        if (becameFlat.length > 0) {
          await refreshData(becameFlat, true, 'merge');
        }
        const rateLimited = results.find(result =>
          result.status === 'rejected'
          && result.reason instanceof TradovateRequestError
          && result.reason.status === 429);
        if (rateLimited?.status === 'rejected' && rateLimited.reason instanceof TradovateRequestError) {
          rateLimitUntilRef.current = Date.now() + (rateLimited.reason.retryAfterMs ?? 3_600_000);
        }
      } finally {
        livePnlBusyRef.current = false;
      }
      const hasOpenPosition = Object.values(connectionDataRef.current)
        .some(dataset => dataset.accounts.some(account => account.netPositionCount > 0));
      schedule(hasOpenPosition ? ACTIVE_PNL_INTERVAL_MS : IDLE_POSITION_INTERVAL_MS);
    };

    schedule(1_000);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [enabled, refreshData, status?.connections]);

  useEffect(() => {
    if (!enabled) return;
    if (historyError) return;
    const datasets = Object.values(connectionData);
    if (datasets.length === 0) return;
    const accounts = datasets.flatMap(dataset => dataset.accounts);
    // Trading-state reads have priority over historical backfill. This keeps
    // the authenticated-user request budget available for positions and P&L.
    if (accounts.some(account => account.netPositionCount > 0)) return;
    const needsWork = accounts.some(account => {
      const sync = historySnapshots[String(account.id)]?.sync;
      return !sync || sync.status === 'pending' || sync.status === 'running';
    });
    if (!needsWork) return;
    const timeout = window.setTimeout(() => void advanceHistoricalBackfill(datasets), 1_500);
    return () => window.clearTimeout(timeout);
  }, [advanceHistoricalBackfill, connectionData, enabled, historyError, historySnapshots]);

  return {
    status,
    data,
    connectionData,
    connectionSummaries,
    profiles,
    historySnapshots,
    historyError,
    apiTelemetry,
    busy,
    error,
    profileSetupOpen,
    setError,
    setProfiles,
    setProfileSetupOpen,
    refreshStatus,
    refreshData: (quiet = false) => refreshData(status?.connections.filter(connection => connection.connected).map(connection => connection.id) ?? [], quiet),
    connect,
    disconnect,
  };
}

export type TradovateLiveData = ReturnType<typeof useTradovateLiveData>;
