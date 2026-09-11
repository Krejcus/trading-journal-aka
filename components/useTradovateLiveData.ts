import { createTradovateIntentPrefetch } from '../lib/tradovateIntentPrefetch';
import { consumeTradovateReads } from '../lib/tradovateReadCoordinator';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { TradovateAccountProfile, TradovateAccountProfilesResult } from '../lib/tradovateAccountProfileTypes';
import type { Account } from '../types';
import type { TradovateSourceCoverage } from '../lib/tradovateAccountDataTypes';
import type { TradovateHistorySnapshot } from '../lib/tradovateHistoricalTypes';
import { mergeTradovateHistoricalSnapshot } from '../lib/tradovateHistoricalMerge';
import {
  applyTradovateLivePnlAnchorTick,
  applyTradovateLivePnlTick,
  tradovateLivePnlAnchorCandidates,
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
  runTradovateLivePnlAnchor,
  runTradovateLivePnlTick,
  saveTradovateAccountProfiles,
  TradovateRequestError,
  type TradovateOAuthStatus,
  type TradovatePreflightResult,
} from '../services/tradovateOAuthConnection';
import {
  applyTradovateConnectionDataRefresh,
  buildTradovateConnectionSummaries,
  readTradovateConnectionShell,
  type TradovateConnectionDataRefreshMode,
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
import {
  consumeTradovatePreflights,
  startTradovatePreflights,
  type PrestartedTradovatePreflights,
} from '../lib/tradovatePreflightCoordinator';

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
const EMPTY_CONNECTION_DATA: Record<string, TradovatePreflightResult> = {};
const EMPTY_PROFILES: TradovateAccountProfile[] = [];
const EMPTY_HISTORY_SNAPSHOTS: Record<string, TradovateHistorySnapshot> = {};

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

const FAST_PNL_INTERVAL_MS = 1_000;
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
  const cached = userId ? tradovateLiveCache.get(userId) : undefined;
  const [stateUserId, setStateUserId] = useState(userId);
  const [storedStatus, setStatus] = useState<TradovateOAuthStatus | null>(() => cached?.status ?? persisted?.status ?? null);
  const [storedConnectionData, setConnectionData] = useState<Record<string, TradovatePreflightResult>>(() => cached?.connectionData ?? {});
  const [storedProfiles, setProfiles] = useState<TradovateAccountProfile[]>(() => cached?.profiles ?? []);
  const [storedHistorySnapshots, setHistorySnapshots] = useState<Record<string, TradovateHistorySnapshot>>(() => cached?.historySnapshots ?? {});
  // Identity changes must be safe during render, before reset effects run.
  // Otherwise both children and the new user's cache can receive old data.
  const identityReady = stateUserId === userId;
  const status = identityReady ? storedStatus : cached?.status ?? persisted?.status ?? null;
  const connectionData = identityReady ? storedConnectionData : cached?.connectionData ?? EMPTY_CONNECTION_DATA;
  const profiles = identityReady ? storedProfiles : cached?.profiles ?? EMPTY_PROFILES;
  const historySnapshots = identityReady ? storedHistorySnapshots : cached?.historySnapshots ?? EMPTY_HISTORY_SNAPSHOTS;
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyBusyRef = useRef(false);
  const profileOnboardingBusyRef = useRef(false);
  const livePnlBusyRef = useRef(false);
  const connectionDataRef = useRef(connectionData);
  const statusRef = useRef(status);
  const livePnlCursorsRef = useRef<Record<string, number>>({});
  const livePnlAnchorCursorsRef = useRef<Record<string, number>>({});
  const livePnlMarksRef = useRef<Record<string, TradovateContractMarkMap>>({});
  const livePnlLastFullTickAtRef = useRef(0);
  const rateLimitUntilRef = useRef(0);
  const journalLinkAttemptsRef = useRef(new Set<string>());
  const previousUserIdRef = useRef(userId);
  const activeUserIdRef = useRef(userId);
  const identityEpochRef = useRef({ userId, epoch: 0 });
  const connectionEpochRef = useRef(0);
  if (identityEpochRef.current.userId !== userId) {
    identityEpochRef.current = { userId, epoch: identityEpochRef.current.epoch + 1 };
    connectionEpochRef.current += 1;
    statusRef.current = status;
    connectionDataRef.current = connectionData;
  }
  activeUserIdRef.current = userId;
  const intentPrefetchRef = useRef<ReturnType<typeof createTradovateIntentPrefetch> | null>(null);
  if (!intentPrefetchRef.current) {
    intentPrefetchRef.current = createTradovateIntentPrefetch({
      status: loadTradovateOAuthStatus,
      bootstrap: connectionId => runTradovateReadOnlyPreflight(connectionId, 'bootstrap'),
      profiles: loadTradovateAccountProfiles,
      blocked: () => Date.now() < Math.max(rateLimitUntilRef.current, getTradovateApiTelemetrySnapshot().rateLimitedUntil ?? 0),
      onError: reason => {
        if (reason instanceof TradovateRequestError && reason.status === 429) {
          rateLimitUntilRef.current = Date.now() + (reason.retryAfterMs ?? 3_600_000);
        }
      },
    });
  }
  intentPrefetchRef.current.setUser(userId);
  const refreshStatusInFlightRef = useRef<{ userId: string; epoch: number; promise: Promise<TradovateOAuthStatus | null> } | null>(null);
  const prefetch = useCallback(() => {
    if (enabled || !userId || activeUserIdRef.current !== userId || Object.keys(connectionDataRef.current).length > 0) return;
    if (refreshStatusInFlightRef.current?.userId === userId && refreshStatusInFlightRef.current.epoch === identityEpochRef.current.epoch) return;
    intentPrefetchRef.current?.prefetch((statusRef.current?.connections ?? [])
      .filter(connection => connection.connected).map(connection => connection.id));
  }, [enabled, userId]);
  const [busy, setBusy] = useState<BusyState>('status');
  const [error, setError] = useState<string | null>(null);
  const [dataEnrichmentPending, setDataEnrichmentPending] = useState(false);
  const [profileSetupOpen, setProfileSetupOpen] = useState(false);

  useEffect(() => {
    activeUserIdRef.current = userId;
    return () => {
      // Revoke continuations before they can publish or start onboarding after
      // unmount (also covers StrictMode effect teardown and identity changes).
      identityEpochRef.current.epoch += 1;
      activeUserIdRef.current = '';
      intentPrefetchRef.current?.clear();
    };
  }, [userId]);

  useEffect(() => {
    if (previousUserIdRef.current === userId) return;
    previousUserIdRef.current = userId;
    setStateUserId(userId);
    journalLinkAttemptsRef.current.clear();
    livePnlCursorsRef.current = {};
    livePnlAnchorCursorsRef.current = {};
    livePnlMarksRef.current = {};
    livePnlLastFullTickAtRef.current = 0;
    rateLimitUntilRef.current = 0;
    setStatus(cached?.status ?? persisted?.status ?? null);
    statusRef.current = cached?.status ?? persisted?.status ?? null;
    connectionDataRef.current = cached?.connectionData ?? {};
    setConnectionData(connectionDataRef.current);
    setProfiles(cached?.profiles ?? []);
    setHistorySnapshots(cached?.historySnapshots ?? {});
    setHistoryError(null);
    setError(null);
    setDataEnrichmentPending(false);
    setProfileSetupOpen(false);
  }, [cached, persisted, userId]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!userId) return;
    tradovateLiveCache.set(userId, { status, connectionData, profiles, historySnapshots });
  }, [connectionData, historySnapshots, profiles, status, userId]);

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
    const epoch = identityEpochRef.current.epoch;
    const isCurrent = () => activeUserIdRef.current === userId && identityEpochRef.current.epoch === epoch;
    void storageService.saveAccounts(plan.accounts).then(async savedAccounts => {
      if (!isCurrent()) return;
      journalOptions.onAccountsChanged(savedAccounts);
      const savedProfiles = await saveTradovateAccountProfiles(plan.profiles);
      if (isCurrent()) setProfiles(savedProfiles.profiles);
    }).catch(reason => {
      if (isCurrent()) {
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
    if (historyBusyRef.current || datasets.length === 0 || Date.now() < Math.max(rateLimitUntilRef.current, getTradovateApiTelemetrySnapshot().rateLimitedUntil ?? 0)) return;
    const user = activeUserIdRef.current;
    const epoch = identityEpochRef.current.epoch;
    const connectionEpoch = connectionEpochRef.current;
    const isCurrent = () => activeUserIdRef.current === user && identityEpochRef.current.epoch === epoch && connectionEpochRef.current === connectionEpoch;
    historyBusyRef.current = true;
    try {
      const results = await Promise.allSettled(datasets.flatMap(dataset => dataset.accounts.map(account =>
        runTradovateHistoricalBackfill({
          connectionId: dataset.connectionId,
          accountId: account.id,
        }),
      )));
      if (!isCurrent()) return;
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
    detail: 'bootstrap' | 'full' = 'full',
    prestarted?: PrestartedTradovatePreflights,
    prestartedProfiles?: Promise<TradovateAccountProfilesResult | null>,
  ) => {
    const requestedUserId = activeUserIdRef.current;
    const requestedEpoch = identityEpochRef.current.epoch;
    const requestedConnectionEpoch = connectionEpochRef.current;
    const isCurrent = () => activeUserIdRef.current === requestedUserId && identityEpochRef.current.epoch === requestedEpoch && connectionEpochRef.current === requestedConnectionEpoch;
    if (!requestedUserId || Date.now() < Math.max(rateLimitUntilRef.current, getTradovateApiTelemetrySnapshot().rateLimitedUntil ?? 0)) return false;
    connectionIds = connectionIds.filter(id => statusRef.current?.connections.some(connection => connection.id === id && connection.connected));
    const recordRateLimit = (reason: unknown) => {
      if (isCurrent() && reason instanceof TradovateRequestError && reason.status === 429) {
        rateLimitUntilRef.current = Math.max(rateLimitUntilRef.current, Date.now() + Math.max(1_000, reason.retryAfterMs ?? 3_600_000));
      }
    };
    if (!quiet) setBusy('data');
    setError(null);
    try {
      const activeIds = new Set(connectionIds);
      if (mode === 'replace') {
        // Fresh status may invalidate a cached connection. Remove only inactive
        // IDs; valid active data can remain visible until its replacement lands.
        const next = Object.fromEntries(Object.entries(connectionDataRef.current)
          .filter(([connectionId]) => activeIds.has(connectionId)));
        connectionDataRef.current = next;
        setConnectionData(next);
      }

      const profilesPromise = prestartedProfiles
        ?? loadTradovateAccountProfiles().catch(() => null);
      void profilesPromise.then(stored => {
        if (stored && isCurrent()) setProfiles(stored.profiles);
      });

      // Every connection is applied as soon as it completes. A slow prop firm
      // no longer holds back the first usable card from a faster connection.
      const preflights = await consumeTradovatePreflights(
        connectionIds,
        connectionId => runTradovateReadOnlyPreflight(connectionId, detail),
        dataset => {
          if (!isCurrent() || !statusRef.current?.connections.some(connection => connection.id === dataset.connectionId && connection.connected)) return;
          const coverage = [
            ...Object.values(dataset.coverage),
            ...dataset.accounts.flatMap(account => [account.balance.coverage, account.history.coverage, account.risk.statusCoverage, account.risk.limitsCoverage]),
          ];
          const limitedSources = coverage.filter(source => source?.httpStatus === 429);
          if (limitedSources.length > 0) recordRateLimit(new TradovateRequestError(
            'Tradovate rate limited a partial read.', 429,
            Math.max(...limitedSources.map(source => source.retryAfterMs ?? 3_600_000)),
          ));
          // Update the shared read model synchronously before publishing to
          // React; a tick resolving in the same batch must see this refresh.
          const next = applyTradovateConnectionDataRefresh(connectionDataRef.current, [dataset], 'merge');
          connectionDataRef.current = next;
          setConnectionData(next);
        },
        prestarted,
      );
      if (!isCurrent()) return false;
      for (const result of preflights) {
        if (result.status === 'rejected') recordRateLimit(result.reason);
      }
      const datasets = preflights.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      if (datasets.length === 0 && connectionIds.length > 0) {
        const failed = preflights.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        throw failed?.reason ?? new Error('Tradovate data se nepodařilo načíst.');
      }

      // Profiles and onboarding are deliberately outside the first-paint path.
      // They may enrich labels later but never delay fresh broker values.
      void profilesPromise.then(async stored => {
        if (!stored || !isCurrent() || profileOnboardingBusyRef.current) return;
        const storedIds = new Set(stored.profiles.map(profile => profile.externalAccountId));
        const hasMissingProfiles = datasets.flatMap(dataset => dataset.accounts)
          .some(account => !storedIds.has(String(account.id)));
        if (!hasMissingProfiles) return;
        profileOnboardingBusyRef.current = true;
        try {
          if (isTradovateAccountOnboardingAvailable(stored.profiles)) {
            const missing = buildMissingTradovateOnboardingProfileInputs({
              brokerAccounts: datasets.flatMap(dataset => dataset.accounts),
              profiles: stored.profiles,
            });
            if (missing.length > 0) {
              const saved = await saveTradovateAccountProfiles([...stored.profiles, ...missing]);
              if (!isCurrent()) return;
              setProfiles(saved.profiles);
              setProfileSetupOpen(false);
            }
          } else {
            setProfileSetupOpen(true);
          }
        } finally {
          profileOnboardingBusyRef.current = false;
        }
      }).catch(reason => {
        if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Profily Tradovate účtů se nepodařilo načíst.');
      });
      const complete = datasets.length === connectionIds.length;
      if (detail === 'full' && complete) setDataEnrichmentPending(false);
      return complete;
    } catch (reason) {
      recordRateLimit(reason);
      if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Tradovate data se nepodařilo načíst.');
      return false;
    } finally {
      if (!quiet && isCurrent()) setBusy(null);
    }
  }, []);

  const refreshStatus = useCallback((): Promise<TradovateOAuthStatus | null> => {
    if (!userId || activeUserIdRef.current !== userId) return Promise.resolve(null);
    const epoch = identityEpochRef.current.epoch;
    const isCurrent = () => activeUserIdRef.current === userId && identityEpochRef.current.epoch === epoch;
    if (refreshStatusInFlightRef.current?.userId === userId && refreshStatusInFlightRef.current.epoch === epoch) return refreshStatusInFlightRef.current.promise;
    const run = async () => {
      setBusy('status');
      setError(null);
      const warmed = await intentPrefetchRef.current?.claim(userId);
      if (!isCurrent()) return null;
      const hasConfirmedData = Object.keys(connectionDataRef.current).length > 0;
      const cachedConnectionIds = hasConfirmedData
        ? []
        : (statusRef.current?.connections ?? [])
          .filter(connection => connection.connected)
          .map(connection => connection.id);
      // The cached shell contains IDs only. Start read-only work immediately,
      // but do not apply any result until fresh OAuth status confirms the ID.
      const prestartedBootstrap = warmed?.bootstrap ?? startTradovatePreflights(
        Date.now() < Math.max(rateLimitUntilRef.current, getTradovateApiTelemetrySnapshot().rateLimitedUntil ?? 0) ? [] : cachedConnectionIds,
        connectionId => runTradovateReadOnlyPreflight(connectionId, 'bootstrap'),
      );
      const profilesPromise = warmed?.profiles ?? loadTradovateAccountProfiles().catch(() => null);
      try {
        const nextStatus = warmed?.status ?? await loadTradovateOAuthStatus();
        if (!isCurrent()) return null;
        const activeConnectionIds = nextStatus.connections.filter(connection => connection.connected).map(connection => connection.id);
        const previousIds = (statusRef.current?.connections ?? []).filter(connection => connection.connected).map(connection => connection.id);
        if (JSON.stringify([...previousIds].sort()) !== JSON.stringify([...activeConnectionIds].sort())) connectionEpochRef.current += 1;
        setStatus(nextStatus);
        statusRef.current = nextStatus;
        // Fresh authorization revokes removed connections even on warm returns
        // and during backoff, before any new read is allowed to publish.
        const activeIds = new Set(activeConnectionIds);
        const retained = Object.fromEntries(Object.entries(connectionDataRef.current).filter(([id]) => activeIds.has(id)));
        connectionDataRef.current = retained;
        setConnectionData(retained);
        if (activeConnectionIds.length > 0 && Date.now() < Math.max(rateLimitUntilRef.current, getTradovateApiTelemetrySnapshot().rateLimitedUntil ?? 0)) {
          setError('Tradovate omezuje četnost požadavků. Další načtení počká na konec limitu.');
          return nextStatus;
        }
        if (activeConnectionIds.length > 0) {
          if (Object.keys(connectionDataRef.current).length > 0) {
            // Návrat v rámci SPA má už potvrzený in-memory snapshot, takže ho
            // nemažeme ani nepřepínáme do bootstrap stavu.
            void refreshData(activeConnectionIds, true, 'merge', 'full', undefined, profilesPromise);
          } else {
            setDataEnrichmentPending(true);
            const bootstrapped = await refreshData(
              activeConnectionIds,
              true,
              'replace',
              'bootstrap',
              prestartedBootstrap,
              profilesPromise,
            );
            if (!isCurrent()) return null;
            if (Date.now() < Math.max(rateLimitUntilRef.current, getTradovateApiTelemetrySnapshot().rateLimitedUntil ?? 0)) {
              setError('Tradovate omezuje četnost požadavků. Další načtení počká na konec limitu.');
              return nextStatus;
            }
            if (bootstrapped) {
              // Historie, fees a risk detail se doplní bez blokování první karty.
              void refreshData(activeConnectionIds, true, 'merge', 'full', undefined, profilesPromise)
                .then(complete => { if (complete && isCurrent()) setDataEnrichmentPending(false); });
            } else {
              const complete = await refreshData(activeConnectionIds, true, 'replace', 'full', undefined, profilesPromise);
              if (complete && isCurrent()) setDataEnrichmentPending(false);
            }
          }
        } else {
          connectionDataRef.current = {};
          setConnectionData({});
          setDataEnrichmentPending(false);
          const stored = await profilesPromise;
          if (isCurrent()) setProfiles(stored?.profiles ?? []);
        }
        return nextStatus;
      } catch (reason) {
        if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Stav Tradovate OAuth se nepodařilo načíst.');
        return null;
      } finally {
        if (isCurrent()) {
          setBusy(null);
          intentPrefetchRef.current?.clear();
        }
      }
    };
    const promise = run();
    refreshStatusInFlightRef.current = { userId, epoch, promise };
    void promise.finally(() => {
      if (refreshStatusInFlightRef.current?.promise === promise) refreshStatusInFlightRef.current = null;
    }).catch(() => {});
    return promise;
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
    const pollUserId = activeUserIdRef.current;
    let timer: number | null = null;

    const schedule = (delay: number) => {
      if (!cancelled) timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (cancelled || activeUserIdRef.current !== pollUserId) return;
      if (document.visibilityState === 'hidden') {
        schedule(IDLE_POSITION_INTERVAL_MS);
        return;
      }
      if (Date.now() < Math.max(rateLimitUntilRef.current, getTradovateApiTelemetrySnapshot().rateLimitedUntil ?? 0)) {
        schedule(Math.min(IDLE_POSITION_INTERVAL_MS, Math.max(rateLimitUntilRef.current, getTradovateApiTelemetrySnapshot().rateLimitedUntil ?? 0) - Date.now()));
        return;
      }
      if (livePnlBusyRef.current) {
        schedule(FAST_PNL_INTERVAL_MS);
        return;
      }
      const available = ids.filter(id => connectionDataRef.current[id]);
      if (available.length === 0) {
        schedule(1_000);
        return;
      }

      livePnlBusyRef.current = true;
      try {
        const hasOpenPosition = available.some(connectionId =>
          connectionDataRef.current[connectionId]?.accounts.some(account => account.netPositionCount > 0));
        const runFullTick = !hasOpenPosition
          || Date.now() - livePnlLastFullTickAtRef.current >= ACTIVE_PNL_INTERVAL_MS;
        let rateLimitResults: PromiseSettledResult<unknown>[];
        if (runFullTick) {
          const becameFlat: string[] = [];
          rateLimitResults = await consumeTradovateReads(
            available,
            connectionId => runTradovateLivePnlTick(connectionId, livePnlCursorsRef.current[connectionId] ?? 0),
            (connectionId, tick) => {
              if (cancelled || activeUserIdRef.current !== pollUserId) return;
              // Partial success must still honor the broker's rate-limit signal.
              if (tick.anchorErrorStatus === 429) rateLimitUntilRef.current = Date.now() + 3_600_000;
              const current = connectionDataRef.current;
              const dataset = current[connectionId];
              if (!dataset) return;
              const applied = applyTradovateLivePnlTick(dataset, tick, livePnlMarksRef.current[connectionId] ?? {});
              if (applied.data === dataset) return;
              if (tradovateLiveTickClosedLastPosition(dataset, tick)) becameFlat.push(connectionId);
              const next = { ...current, [connectionId]: applied.data as TradovatePreflightResult };
              connectionDataRef.current = next;
              livePnlMarksRef.current[connectionId] = applied.marks;
              livePnlCursorsRef.current[connectionId] = tick.nextContractCursor;
              setConnectionData(next);
            },
          );
          if (cancelled || activeUserIdRef.current !== pollUserId) return;
          livePnlLastFullTickAtRef.current = Date.now();
          if (becameFlat.length > 0) await refreshData(becameFlat, true, 'merge');
        } else {
          const candidatesByConnection = new Map(available.flatMap(connectionId => {
            const dataset = connectionDataRef.current[connectionId];
            if (!dataset) return [];
            const candidates = tradovateLivePnlAnchorCandidates(dataset);
            if (candidates.length === 0) return [];
            const cursor = livePnlAnchorCursorsRef.current[connectionId] ?? 0;
            return [[connectionId, { candidate: candidates[cursor % candidates.length], count: candidates.length }] as const];
          }));
          rateLimitResults = await consumeTradovateReads(
            [...candidatesByConnection.keys()],
            connectionId => {
              const { candidate } = candidatesByConnection.get(connectionId)!;
              return runTradovateLivePnlAnchor(connectionId, candidate.accountId, candidate.contractId);
            },
            (connectionId, tick) => {
              if (cancelled || activeUserIdRef.current !== pollUserId) return;
              const current = connectionDataRef.current;
              const dataset = current[connectionId];
              if (!dataset) return;
              const applied = applyTradovateLivePnlAnchorTick(dataset, tick, livePnlMarksRef.current[connectionId] ?? {});
              livePnlAnchorCursorsRef.current[connectionId] = ((livePnlAnchorCursorsRef.current[connectionId] ?? 0) + 1)
                % candidatesByConnection.get(connectionId)!.count;
              if (applied.data === dataset) return;
              const next = { ...current, [connectionId]: applied.data as TradovatePreflightResult };
              connectionDataRef.current = next;
              livePnlMarksRef.current[connectionId] = applied.marks;
              setConnectionData(next);
            },
          );
        }
        if (cancelled || activeUserIdRef.current !== pollUserId) return;
        const rateLimited = rateLimitResults.find(result =>
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
      schedule(hasOpenPosition ? FAST_PNL_INTERVAL_MS : IDLE_POSITION_INTERVAL_MS);
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
    const timeout = window.setTimeout(() => void advanceHistoricalBackfill(datasets), 5_000);
    return () => window.clearTimeout(timeout);
  }, [advanceHistoricalBackfill, connectionData, enabled, historyError, historySnapshots]);

  return {
    prefetch,
    status,
    data,
    connectionData,
    connectionSummaries,
    profiles,
    historySnapshots,
    historyError,
    apiTelemetry,
    dataEnrichmentPending,
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
