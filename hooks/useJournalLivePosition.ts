import { useEffect, useMemo, useRef, useState } from 'react';
import type { TradovateAccountDataResult } from '../lib/tradovateAccountDataTypes';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import { overlayWorkerExposure, WORKER_EXPOSURE_MAX_AGE_MS } from '../lib/tradovateWorkerExposureOverlay';
import { copierWorkerExecutionGroup } from '../lib/copierWorkerCapabilities';
import { tradovateCopyTradeOrders, tradovateCopyTradeSnapshot } from '../lib/tradovateCopyTradeBridge';
import { tradeCardFeeRates } from '../lib/liveTradeCard';
import { readCopyGroupCache } from '../services/copyGroupLibrary';
import {
  buildJournalLiveView, confirmWorkerMismatches, EMPTY_JOURNAL_LIVE_VIEW, journalCopierArmed,
  type JournalLiveInterest, type JournalLiveTarget, type JournalLiveView, type WorkerMismatches,
} from '../lib/journalLivePosition';
import { subscribeAppForeground } from '../lib/appForeground';
import { useDisplayWorkerStatus } from './useDisplayWorkerStatus';

/**
 * Data živé pozice pro deník (jen zobrazení): čtení z brokera, které App
 * drží pro LIVE, a k tomu čerstvý stav workeru po 2 s (pozice a příkazy
 * z jeho streamu) — stejné sloučení jako v LIVE. Dokud se deník dneška
 * dívá, App čte z brokera úsporným tempem (`setInterest`): s otevřenou
 * pozicí častěji kvůli kotvě P&L, bez ní jako na pozadí.
 */

export interface JournalLiveSource {
  userId: string;
  data: TradovateAccountDataResult | null;
  profiles: TradovateAccountProfile[];
  /** Připojená Tradovate připojení; relay z kteréhokoli najde Mac worker. */
  connectionIds: readonly string[];
  setInterest: (interest: JournalLiveInterest) => void;
}

const NO_IDS: readonly string[] = [];

/** Jak často se znovu posoudí stáří čtení, když se data nemění (worker stojí). */
const FRESHNESS_TICK_MS = 5_000;
/** Výpadek heartbeatu kratší než tohle nemaže paměť rozdílů kusů followerů. */
const WORKER_MISMATCH_MEMORY_MS = 15_000;

export function useJournalLivePosition(source: JournalLiveSource | null | undefined, enabled: boolean, target: JournalLiveTarget): JournalLiveView {
  const active = enabled && source != null;
  const setInterest = source?.setInterest;

  const worker = useDisplayWorkerStatus(active ? source?.connectionIds ?? NO_IDS : NO_IDS, active);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), FRESHNESS_TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  // Nový stav workeru = nová data; čas posoudit hned s nimi. Po návratu
  // z pozadí hned, ať se staré čtení neukáže jako čerstvé ani na chvíli.
  useEffect(() => { if (worker.observedAt != null) setNow(Date.now()); }, [worker.observedAt]);
  useEffect(() => {
    if (!active) return;
    return subscribeAppForeground(() => setNow(Date.now()));
  }, [active]);
  // Heartbeat, který ustal (relay vrací pořád stejný status): data workeru
  // vyprší přesně po 8 s, ne až s dalším tickem hodin.
  useEffect(() => {
    if (!active || worker.observedAt == null) return;
    const delay = worker.observedAt + WORKER_EXPOSURE_MAX_AGE_MS + 1 - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [active, worker.observedAt]);

  const userId = source?.userId ?? '';
  const cachedGroup = useMemo(
    () => (userId ? readCopyGroupCache(userId, []).find(group => group.enabled && group.leaderAccountId != null) ?? null : null),
    [userId],
  );
  const data = source?.data ?? null;
  const profiles = source?.profiles;
  const liveData = useMemo(
    () => (active ? overlayWorkerExposure(data, worker.status, worker.observedAt, now) : null),
    [active, data, worker.status, worker.observedAt, now],
  );
  const accounts = useMemo(() => (liveData && profiles ? tradovateCopyTradeSnapshot(liveData, profiles).accounts : []), [liveData, profiles]);
  const orders = useMemo(() => (liveData ? tradovateCopyTradeOrders(liveData) : []), [liveData]);
  const feeRates = useMemo(() => (liveData ? tradeCardFeeRates(liveData.accounts) : new Map<string, number>()), [liveData]);
  // Skupina, kterou worker právě kopíruje (smazaná = žádná); bez workeru uložená.
  const group = worker.status ? copierWorkerExecutionGroup(worker.status) : cachedGroup;
  // Rozjetí followerů jen z heartbeatu, který ještě platí (stejně jako pozice).
  const workerFresh = worker.observedAt != null && now - worker.observedAt <= WORKER_EXPOSURE_MAX_AGE_MS;
  const followerVerdicts = workerFresh ? worker.status?.controller?.exposure?.followers ?? null : null;
  // Zapnutost kopírky jen z čerstvého heartbeatu; jinak, nebo po incidentu,
  // neznámo (platí poplachy o rozjetí).
  const copierArmed = workerFresh ? journalCopierArmed(worker.status?.controller, worker.status?.startedAt) : null;
  // Od kdy worker hlásí rozdíl kusů. Krátký výpadek heartbeatu paměť nemaže
  // (potvrzené rozjetí se po návratu znovu nečeká), delší ano. Čas podle
  // skutečných hodin — stavové `now` zaostává a okno by zkracovalo.
  const mismatchMemoryRef = useRef<{ since: Map<number, number>; at: number }>({ since: new Map(), at: 0 });
  const workerMismatches = useMemo<WorkerMismatches | null>(() => {
    const clock = Date.now();
    if (!followerVerdicts) {
      if (clock - mismatchMemoryRef.current.at > WORKER_MISMATCH_MEMORY_MS) mismatchMemoryRef.current = { since: new Map(), at: 0 };
      return null;
    }
    const next = confirmWorkerMismatches(followerVerdicts, mismatchMemoryRef.current.since, clock);
    mismatchMemoryRef.current = { since: next.since, at: clock };
    return { pending: next.pending, confirmed: next.confirmed, ok: next.ok };
  }, [followerVerdicts, now]);
  // Od kdy pohled hlásí rozjetí (okno dobíhání kopie, i potvrzené).
  const divergenceSinceRef = useRef<number | null>(null);

  const view = useMemo(() => {
    if (!active) {
      divergenceSinceRef.current = null;
      return EMPTY_JOURNAL_LIVE_VIEW;
    }
    const built = buildJournalLiveView({
      accounts, orders, feeRates, group, target, workerMismatches, divergenceSince: divergenceSinceRef.current, copierArmed, now,
    });
    // Začátek okna podle skutečného času, ne podle hodin pohledu (ty jdou
    // bez workeru jen po 5 s) — okno se tak nikdy nezkrátí.
    divergenceSinceRef.current = built.divergenceCandidate ? divergenceSinceRef.current ?? Date.now() : null;
    return built;
  }, [active, accounts, orders, feeRates, group, target, workerMismatches, copierArmed, now]);
  // Otevřená pozice skupiny = častější čtení z brokera (kotva P&L); jinak jen
  // udržovací. Pozice z workeru se tu pozná dřív, než ji vidí REST. Neúplný
  // nebo rozjetý pohled s pozicí taky — ať se co nejdřív ověří.
  const memberIds = useMemo(() => new Set(group ? [
    ...(group.leaderAccountId != null ? [group.leaderAccountId] : []),
    ...group.followers.map(follower => follower.accountId),
  ] : []), [group]);
  const hasPosition = accounts.some(account => memberIds.has(account.id) && account.positions.some(position => position.netPosition !== 0));
  const interest: JournalLiveInterest = view.model?.kind === 'position' || (view.issue != null && hasPosition) ? 'position' : 'watch';
  useEffect(() => {
    if (!active || !setInterest) return;
    setInterest(interest);
    return () => setInterest('off');
  }, [active, interest, setInterest]);
  return view;
}
