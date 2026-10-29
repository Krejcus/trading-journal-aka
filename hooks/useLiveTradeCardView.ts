import { useMemo, useRef } from 'react';
import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import {
  buildJournalLiveView, confirmWorkerMismatches, EMPTY_JOURNAL_LIVE_VIEW, journalCopierArmed,
  type JournalLiveTarget, type JournalLiveView, type WorkerMismatches,
} from '../lib/journalLivePosition';

/** Výpadek heartbeatu kratší než tohle nemaže paměť rozdílů kusů followerů. */
export const WORKER_MISMATCH_MEMORY_MS = 15_000;

/**
 * Pohled na živou pozici skupiny / účtu se stavem rozjetí (jen zobrazení):
 * paměť rozdílů kusů followerů z verdiktů workeru a okno, od kdy pohled
 * hlásí rozjetí. Společné pro graf dne (deník) a LIVE → Graf — oba musí
 * rozjetí ukázat stejně (INV-DIVERGENCE-01, INV-UI-03).
 *
 * `worker` je jen ČERSTVÝ stav (do 8 s); starý nebo obnovený = null —
 * verdikty i zapnutost kopírky pak nejsou známé. Nový start workeru
 * (`startedAt`) paměť rozdílů maže.
 */
export function useLiveTradeCardView(input: {
  active: boolean;
  accounts: readonly LiveAccount[];
  orders: readonly LiveOrder[];
  feeRates: ReadonlyMap<string, number>;
  group: CopyGroupConfig | null;
  target: JournalLiveTarget;
  worker: Pick<LocalCopierAgentStatus, 'controller' | 'startedAt'> | null;
  now: number;
}): JournalLiveView {
  const { active, accounts, orders, feeRates, group, target, worker, now } = input;
  const followerVerdicts = worker?.controller?.exposure?.followers ?? null;
  // Zapnutost kopírky jen z čerstvého heartbeatu; jinak, nebo po incidentu,
  // neznámo (platí poplachy o rozjetí).
  const copierArmed = worker ? journalCopierArmed(worker.controller, worker.startedAt) : null;
  const startedAt = worker?.startedAt ?? null;
  // Od kdy worker hlásí rozdíl kusů. Krátký výpadek heartbeatu paměť nemaže
  // (potvrzené rozjetí se po návratu znovu nečeká), delší ano. Čas podle
  // skutečných hodin — stavové `now` zaostává a okno by zkracovalo.
  const mismatchMemoryRef = useRef<{ since: Map<number, number>; at: number; startedAt: string | null }>({ since: new Map(), at: 0, startedAt: null });
  const workerMismatches = useMemo<WorkerMismatches | null>(() => {
    const clock = Date.now();
    if (startedAt != null && mismatchMemoryRef.current.startedAt != null && mismatchMemoryRef.current.startedAt !== startedAt) {
      mismatchMemoryRef.current = { since: new Map(), at: 0, startedAt };
    }
    if (!followerVerdicts) {
      if (clock - mismatchMemoryRef.current.at > WORKER_MISMATCH_MEMORY_MS) {
        mismatchMemoryRef.current = { since: new Map(), at: 0, startedAt: mismatchMemoryRef.current.startedAt };
      }
      return null;
    }
    const next = confirmWorkerMismatches(followerVerdicts, mismatchMemoryRef.current.since, clock);
    mismatchMemoryRef.current = { since: next.since, at: clock, startedAt };
    return { pending: next.pending, confirmed: next.confirmed, ok: next.ok };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` posuzuje stáří paměti
  }, [followerVerdicts, startedAt, now]);
  // Od kdy pohled hlásí rozjetí (okno dobíhání kopie, i potvrzené).
  const divergenceSinceRef = useRef<number | null>(null);

  return useMemo(() => {
    if (!active) {
      divergenceSinceRef.current = null;
      return EMPTY_JOURNAL_LIVE_VIEW;
    }
    const built = buildJournalLiveView({
      accounts, orders, feeRates, group, target, workerMismatches, divergenceSince: divergenceSinceRef.current, copierArmed, now,
    });
    // Začátek okna podle skutečného času, ne podle hodin pohledu — okno se
    // tak nikdy nezkrátí.
    divergenceSinceRef.current = built.divergenceCandidate ? divergenceSinceRef.current ?? Date.now() : null;
    return built;
  }, [active, accounts, orders, feeRates, group, target, workerMismatches, copierArmed, now]);
}
