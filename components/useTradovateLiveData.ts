import { applyTradovateConnectionHealth, type TradovateConnectionHealthMap } from '../lib/tradovateConnectionHealth';
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
  setTradovateOAuthConnectionArchived,
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
  recordTradovateBrokerCalls,
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
  connectionHealth: TradovateConnectionHealthMap;
  status: TradovateOAuthStatus | null;
  connectionData: Record<string, TradovatePreflightResult>;
  profiles: TradovateAccountProfile[];
  historySnapshots: Record<string, TradovateHistorySnapshot>;
}

// SPA navigation unmounts the LIVE page. Keep the last confirmed read model in
// memory, keyed by AlphaTrade user, so remounting never flashes a false
// disconnected state. Nothing sensitive (OAuth tokens) is stored here.
const tradovateLiveCache = new Map<string, TradovateLiveCacheEntry>();
const EMPTY_CONNECTION_HEALTH: TradovateConnectionHealthMap = {};
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

// 18. 9. 2026: každý tick = 3–4 Tradovate REST volání na připojení; při 1–2 s
// to bylo ~90 volání/min na token, tedy nad limitem Tradovate (~80/min,
// 5000/h). Tradovate pak místo 429 zavíral WebSocket workeru (1005/1006) a
// penalizoval syncrequest (p-ticket) — kopírka nešla zapnout. Pozice a
// příkazy má LIVE z heartbeatu workera každou sekundu; REST je jen záloha
// a zdroj zůstatků, na které stačí sekundy.
const FAST_PNL_INTERVAL_MS = 3_000;
const ACTIVE_PNL_INTERVAL_MS = 6_000;
const IDLE_POSITION_INTERVAL_MS = 15_000;
// At 20 accounts the full preflight is expensive (risk, history, fees, etc.).
// Ten minutes keeps it useful for reconciliation without consuming the budget
// reserved for the 2-second position/P&L read model.
const FULL_REFRESH_INTERVAL_MS = 10 * 60_000;
const FULL_REFRESH_FOREGROUND_MAX_AGE_MS = 5 * 60_000;
const FULL_REFRESH_RETRY_BASE_MS = 15_000;
const FULL_REFRESH_RETRY_MAX_MS = 10 * 60_000;
// Bez p-time od Tradovate se čeká 5 minut, ne hodinu: hodinový backoff nechal
// LIVE po jediném 429 celé odpoledne na „neověřeno".
const RATE_LIMIT_FALLBACK_MS = 5 * 60_000;
const RATE_LIMIT_MAX_MS = 10 * 60_000;

export interface TradovateConnectionEnrichmentState {
  pending: boolean;
  lastFullSuccessAt: number | null;
  retryAt: number | null;
  failureCount: number;
  error: string | null;
}

export const tradovateClientBackoffMs = (retryAfterMs: number | null | undefined): number =>
  Math.min(RATE_LIMIT_MAX_MS, Math.max(1_000, retryAfterMs ?? RATE_LIMIT_FALLBACK_MS));

export const tradovateFullRefreshBackoffMs = (failureCount: number): number =>
  Math.min(FULL_REFRESH_RETRY_MAX_MS, FULL_REFRESH_RETRY_BASE_MS * 2 ** Math.max(0, failureCount - 1));

export const tradovateForegroundRefreshIds = (
  connectionIds: readonly string[],
  states: Readonly<Record<string, TradovateConnectionEnrichmentState>>,
  now = Date.now(),
): string[] => connectionIds.filter(id => {
  const state = states[id];
  return !state || state.pending || state.lastFullSuccessAt == null
    || now - state.lastFullSuccessAt >= FULL_REFRESH_FOREGROUND_MAX_AGE_MS;
});

const emptyEnrichment = (): TradovateConnectionEnrichmentState => ({
  pending: true,
  lastFullSuccessAt: null,
  retryAt: null,
  failureCount: 0,
  error: null,
});

const datasetRateLimitMs = (dataset: TradovatePreflightResult): number | null => {
  const coverage = [
    ...Object.values(dataset.coverage),
    ...dataset.accounts.flatMap(account => [account.balance.coverage, account.history.coverage, account.risk.statusCoverage, account.risk.limitsCoverage]),
  ];
  const limited = coverage.filter(source => source?.httpStatus === 429);
  return limited.length > 0
    ? Math.max(...limited.map(source => tradovateClientBackoffMs(source.retryAfterMs)))
    : null;
};

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
  const [storedConnectionHealth, setConnectionHealth] = useState<TradovateConnectionHealthMap>(() => cached?.connectionHealth ?? {});
  const [storedStatus, setStatus] = useState<TradovateOAuthStatus | null>(() => cached?.status ?? persisted?.status ?? null);
  const [storedConnectionData, setConnectionData] = useState<Record<string, TradovatePreflightResult>>(() => cached?.connectionData ?? {});
  const [storedProfiles, setProfiles] = useState<TradovateAccountProfile[]>(() => cached?.profiles ?? []);
  const [storedHistorySnapshots, setHistorySnapshots] = useState<Record<string, TradovateHistorySnapshot>>(() => cached?.historySnapshots ?? {});
  // Identity changes must be safe during render, before reset effects run.
  // Otherwise both children and the new user's cache can receive old data.
  const identityReady = stateUserId === userId;
  const connectionHealth = identityReady ? storedConnectionHealth : cached?.connectionHealth ?? EMPTY_CONNECTION_HEALTH;
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
  const rateLimitUntilByConnectionRef = useRef<Record<string, number>>({});
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
      bootstrap: connectionId => {
        const until = rateLimitUntilByConnectionRef.current[connectionId] ?? 0;
        return Date.now() < until
          ? Promise.reject(new TradovateRequestError('Tradovate rate limit stále platí.', 429, until - Date.now()))
          : runTradovateReadOnlyPreflight(connectionId, 'bootstrap');
      },
      profiles: loadTradovateAccountProfiles,
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
  const [dataEnrichmentByConnection, setDataEnrichmentByConnection] = useState<Record<string, TradovateConnectionEnrichmentState>>({});
  const dataEnrichmentByConnectionRef = useRef(dataEnrichmentByConnection);
  const updateEnrichment = useCallback((update: (current: Record<string, TradovateConnectionEnrichmentState>) => Record<string, TradovateConnectionEnrichmentState>) => {
    const next = update(dataEnrichmentByConnectionRef.current);
    dataEnrichmentByConnectionRef.current = next;
    setDataEnrichmentByConnection(next);
  }, []);
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
    setConnectionHealth(cached?.connectionHealth ?? {});
    journalLinkAttemptsRef.current.clear();
    livePnlCursorsRef.current = {};
    livePnlAnchorCursorsRef.current = {};
    livePnlMarksRef.current = {};
    livePnlLastFullTickAtRef.current = 0;
    rateLimitUntilByConnectionRef.current = {};
    setStatus(cached?.status ?? persisted?.status ?? null);
    statusRef.current = cached?.status ?? persisted?.status ?? null;
    connectionDataRef.current = cached?.connectionData ?? {};
    setConnectionData(connectionDataRef.current);
    setProfiles(cached?.profiles ?? []);
    setHistorySnapshots(cached?.historySnapshots ?? {});
    setHistoryError(null);
    setError(null);
    dataEnrichmentByConnectionRef.current = {};
    setDataEnrichmentByConnection({});
    setProfileSetupOpen(false);
  }, [cached, persisted, userId]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!userId) return;
    tradovateLiveCache.set(userId, { status, connectionData, profiles, historySnapshots, connectionHealth });
  }, [connectionData, historySnapshots, profiles, status, userId, connectionHealth]);

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
    datasets = datasets.filter(dataset => Date.now() >= (rateLimitUntilByConnectionRef.current[dataset.connectionId] ?? 0));
    if (historyBusyRef.current || datasets.length === 0) return;
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
    const healthRequestedAt = Date.now();
    const requestedUserId = activeUserIdRef.current;
    const requestedEpoch = identityEpochRef.current.epoch;
    const requestedConnectionEpoch = connectionEpochRef.current;
    const isCurrent = () => activeUserIdRef.current === requestedUserId && identityEpochRef.current.epoch === requestedEpoch && connectionEpochRef.current === requestedConnectionEpoch;
    if (!requestedUserId) return false;
    connectionIds = connectionIds.filter(id => statusRef.current?.connections.some(connection => connection.id === id && connection.connected));
    const startedAt = Date.now();
    const recordRateLimit = (connectionId: string, reason: unknown) => {
      if (isCurrent() && reason instanceof TradovateRequestError && reason.status === 429) {
        rateLimitUntilByConnectionRef.current[connectionId] = Math.max(
          rateLimitUntilByConnectionRef.current[connectionId] ?? 0,
          Date.now() + tradovateClientBackoffMs(reason.retryAfterMs),
        );
      }
    };
    const markPending = (ids: readonly string[]) => updateEnrichment(current => {
      const next = { ...current };
      for (const id of ids) next[id] = { ...(next[id] ?? emptyEnrichment()), pending: true };
      return next;
    });
    const markSuccess = (connectionId: string) => updateEnrichment(current => ({
      ...current,
      [connectionId]: { pending: false, lastFullSuccessAt: Date.now(), retryAt: null, failureCount: 0, error: null },
    }));
    const markFailure = (connectionId: string, reason: unknown) => updateEnrichment(current => {
      const previous = current[connectionId] ?? emptyEnrichment();
      const failureCount = previous.failureCount + 1;
      const rateLimitUntil = rateLimitUntilByConnectionRef.current[connectionId] ?? 0;
      const retryAt = Math.max(Date.now() + tradovateFullRefreshBackoffMs(failureCount), rateLimitUntil);
      return {
        ...current,
        [connectionId]: {
          ...previous,
          pending: true,
          retryAt,
          failureCount,
          error: reason instanceof Error ? reason.message : 'Tradovate data se nepodařilo načíst.',
        },
      };
    });
    if (detail === 'full') markPending(connectionIds);
    const eligibleConnectionIds = connectionIds.filter(id => startedAt >= (rateLimitUntilByConnectionRef.current[id] ?? 0));
    if (detail === 'full') {
      const blocked = connectionIds.filter(id => !eligibleConnectionIds.includes(id));
      if (blocked.length > 0) updateEnrichment(current => {
        const next = { ...current };
        for (const id of blocked) {
          const previous = next[id] ?? emptyEnrichment();
          next[id] = { ...previous, pending: true, retryAt: rateLimitUntilByConnectionRef.current[id] ?? previous.retryAt };
        }
        return next;
      });
    }
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
        eligibleConnectionIds,
        connectionId => runTradovateReadOnlyPreflight(connectionId, detail),
        dataset => {
          if (!isCurrent() || !statusRef.current?.connections.some(connection => connection.id === dataset.connectionId && connection.connected)) return;
          const limitedFor = datasetRateLimitMs(dataset);
          if (limitedFor != null) recordRateLimit(dataset.connectionId, new TradovateRequestError(
            'Tradovate rate limited a partial read.', 429, limitedFor,
          ));
          // Update the shared read model synchronously before publishing to
          // React; a tick resolving in the same batch must see this refresh.
          const next = applyTradovateConnectionDataRefresh(connectionDataRef.current, [dataset], 'merge');
          connectionDataRef.current = next;
          setConnectionData(next);
        },
        prestarted,
        (connectionId, result) => {
          if (!isCurrent()) return;
          setConnectionHealth(current => applyTradovateConnectionHealth(
            current, connectionId, healthRequestedAt, result.status === 'rejected' ? result.reason : undefined,
          ));
          if (detail === 'full') {
            if (result.status === 'rejected') {
              recordRateLimit(connectionId, result.reason);
              markFailure(connectionId, result.reason);
            } else {
              const limitedFor = datasetRateLimitMs(result.value);
              if (limitedFor == null) markSuccess(connectionId);
              else markFailure(connectionId, new TradovateRequestError('Tradovate rate limited a partial read.', 429, limitedFor));
            }
          }
        },
      );
      if (!isCurrent()) return false;
      preflights.forEach((result, index) => {
        if (result.status === 'rejected') recordRateLimit(eligibleConnectionIds[index], result.reason);
      });
      const datasets = preflights.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      if (datasets.length === 0 && eligibleConnectionIds.length > 0) {
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
      const complete = connectionIds.length > 0 && connectionIds.every(id => dataEnrichmentByConnectionRef.current[id]?.pending === false);
      return complete;
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Tradovate data se nepodařilo načíst.');
      return false;
    } finally {
      if (!quiet && isCurrent()) setBusy(null);
    }
  }, [updateEnrichment]);

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
        cachedConnectionIds.filter(id => Date.now() >= (rateLimitUntilByConnectionRef.current[id] ?? 0)),
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
        updateEnrichment(current => Object.fromEntries(activeConnectionIds.map(id => [
          id,
          current[id] ?? emptyEnrichment(),
        ])));
        if (activeConnectionIds.length > 0) {
          if (Object.keys(connectionDataRef.current).length > 0) {
            // Návrat v rámci SPA má už potvrzený in-memory snapshot, takže ho
            // nemažeme ani nepřepínáme do bootstrap stavu.
            void refreshData(activeConnectionIds, true, 'merge', 'full', undefined, profilesPromise);
          } else {
            await refreshData(
              activeConnectionIds,
              true,
              'replace',
              'bootstrap',
              prestartedBootstrap,
              profilesPromise,
            );
            if (!isCurrent()) return null;
            if (activeConnectionIds.every(id => Date.now() < (rateLimitUntilByConnectionRef.current[id] ?? 0))) {
              setError('Tradovate omezuje četnost požadavků. Další načtení počká na konec limitu.');
            }
            // Historie, fees a risk detail se doplní bez blokování první karty.
            // Neúspěšná připojení mají vlastní 15/30/60s retry a nezadržují ostatní.
            void refreshData(activeConnectionIds, true, 'merge', 'full', undefined, profilesPromise);
          }
        } else {
          connectionDataRef.current = {};
          setConnectionData({});
          dataEnrichmentByConnectionRef.current = {};
          setDataEnrichmentByConnection({});
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
  }, [refreshData, updateEnrichment, userId]);

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

  /** Skrýt odpojené připojení z přehledu (nebo ukázat); server nic nemaže. */
  const setArchived = useCallback(async (connectionId: string, archived: boolean) => {
    setBusy('disconnect');
    setError(null);
    try {
      await setTradovateOAuthConnectionArchived(connectionId, archived);
      await refreshStatus();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Připojení se nepodařilo skrýt.');
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
    const active = new Set(status?.connections.filter(connection => connection.connected).map(connection => connection.id) ?? []);
    const due = Object.entries(dataEnrichmentByConnection)
      .filter(([id, state]) => active.has(id) && state.pending && state.retryAt != null)
      .sort((a, b) => a[1].retryAt! - b[1].retryAt!);
    if (due.length === 0) return;
    const delay = Math.max(0, due[0][1].retryAt! - Date.now());
    const timer = window.setTimeout(() => {
      const now = Date.now();
      const ids = due.filter(([, state]) => state.retryAt! <= now + 50).map(([id]) => id);
      if (ids.length > 0) void refreshData(ids, true, 'merge', 'full');
    }, delay);
    return () => window.clearTimeout(timer);
  }, [dataEnrichmentByConnection, enabled, refreshData, status?.connections]);

  useEffect(() => {
    if (!enabled) return;
    const refreshIfNeeded = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      const activeIds = statusRef.current?.connections
        .filter(connection => connection.connected)
        .map(connection => connection.id) ?? [];
      const ids = tradovateForegroundRefreshIds(activeIds, dataEnrichmentByConnectionRef.current, now);
      if (ids.length > 0) void refreshData(ids, true, 'merge', 'full');
    };
    const listensDocument = typeof document.addEventListener === 'function';
    const listensWindow = typeof window.addEventListener === 'function';
    if (listensDocument) document.addEventListener('visibilitychange', refreshIfNeeded);
    if (listensWindow) window.addEventListener('focus', refreshIfNeeded);
    return () => {
      if (listensDocument) document.removeEventListener('visibilitychange', refreshIfNeeded);
      if (listensWindow) window.removeEventListener('focus', refreshIfNeeded);
    };
  }, [enabled, refreshData]);

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
      if (livePnlBusyRef.current) {
        schedule(FAST_PNL_INTERVAL_MS);
        return;
      }
      const available = ids.filter(id => connectionDataRef.current[id]
        && Date.now() >= (rateLimitUntilByConnectionRef.current[id] ?? 0));
      if (available.length === 0) {
        const nextRateLimit = ids.map(id => rateLimitUntilByConnectionRef.current[id] ?? 0)
          .filter(until => until > Date.now()).sort((a, b) => a - b)[0];
        schedule(nextRateLimit ? Math.min(IDLE_POSITION_INTERVAL_MS, nextRateLimit - Date.now()) : 1_000);
        return;
      }

      livePnlBusyRef.current = true;
      try {
        const hasOpenPosition = available.some(connectionId =>
          connectionDataRef.current[connectionId]?.accounts.some(account => account.netPositionCount > 0));
        const runFullTick = !hasOpenPosition
          || Date.now() - livePnlLastFullTickAtRef.current >= ACTIVE_PNL_INTERVAL_MS;
        let rateLimitResults: PromiseSettledResult<unknown>[];
        let rateLimitIds: string[];
        const readWithHealth = async <T,>(connectionId: string, read: () => Promise<T>): Promise<T> => {
          const requestedAt = Date.now();
          try {
            const result = await read();
            if (!cancelled && activeUserIdRef.current === pollUserId) setConnectionHealth(current =>
              applyTradovateConnectionHealth(current, connectionId, requestedAt));
            return result;
          } catch (error) {
            if (!cancelled && activeUserIdRef.current === pollUserId) setConnectionHealth(current =>
              applyTradovateConnectionHealth(current, connectionId, requestedAt, error));
            throw error;
          }
        };
        if (runFullTick) {
          const becameFlat: string[] = [];
          rateLimitIds = available;
          rateLimitResults = await consumeTradovateReads(
            available,
            connectionId => readWithHealth(connectionId, () => runTradovateLivePnlTick(connectionId, livePnlCursorsRef.current[connectionId] ?? 0)),
            (connectionId, tick) => {
              if (cancelled || activeUserIdRef.current !== pollUserId) return;
              recordTradovateBrokerCalls(connectionId, tick.brokerCalls);
              // Partial success must still honor the broker's rate-limit signal.
              if (tick.anchorErrorStatus === 429) {
                rateLimitUntilByConnectionRef.current[connectionId] = Date.now() + RATE_LIMIT_FALLBACK_MS;
              }
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
          rateLimitIds = [...candidatesByConnection.keys()];
          rateLimitResults = await consumeTradovateReads(
            rateLimitIds,
            connectionId => {
              const { candidate } = candidatesByConnection.get(connectionId)!;
              return readWithHealth(connectionId, () => runTradovateLivePnlAnchor(connectionId, candidate.accountId, candidate.contractId));
            },
            (connectionId, tick) => {
              if (cancelled || activeUserIdRef.current !== pollUserId) return;
              recordTradovateBrokerCalls(connectionId, tick.brokerCalls);
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
        rateLimitResults.forEach((result, index) => {
          if (result.status !== 'rejected' || !(result.reason instanceof TradovateRequestError) || result.reason.status !== 429) return;
          const id = rateLimitIds[index];
          rateLimitUntilByConnectionRef.current[id] = Math.max(
            rateLimitUntilByConnectionRef.current[id] ?? 0,
            Date.now() + tradovateClientBackoffMs(result.reason.retryAfterMs),
          );
        });
      } finally {
        livePnlBusyRef.current = false;
      }
      const hasOpenPosition = Object.values(connectionDataRef.current)
        .some(dataset => dataset.accounts.some(account => account.netPositionCount > 0));
      schedule(hasOpenPosition ? FAST_PNL_INTERVAL_MS : IDLE_POSITION_INTERVAL_MS);
    };

    // Návrat do popředí (telefon po spánku, přepnutí záložky) čte hned,
    // ne až za další interval; poslední známé hodnoty tak nahradí do sekundy.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || cancelled) return;
      if (timer != null) window.clearTimeout(timer);
      timer = null;
      void poll();
    };
    // Testovací prostředí stubuje `document` bez event API.
    const listens = typeof document.addEventListener === 'function';
    if (listens) document.addEventListener('visibilitychange', onVisible);
    schedule(1_000);
    return () => {
      cancelled = true;
      if (listens) document.removeEventListener('visibilitychange', onVisible);
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

  const activeConnectionIds = status?.connections
    .filter(connection => connection.connected).map(connection => connection.id) ?? [];
  const dataEnrichmentPending = activeConnectionIds.some(id => dataEnrichmentByConnection[id]?.pending !== false);

  return {
    prefetch,
    status,
    data,
    connectionData,
    connectionSummaries,
    connectionHealth,
    profiles,
    historySnapshots,
    historyError,
    apiTelemetry,
    dataEnrichmentPending,
    dataEnrichmentByConnection,
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
    setArchived,
  };
}

export type TradovateLiveData = ReturnType<typeof useTradovateLiveData>;
