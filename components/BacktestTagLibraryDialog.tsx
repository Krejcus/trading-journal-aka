import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Account, Trade } from '../types';
import { getUserId, storageService } from '../services/storageService';
import { supabase } from '../services/supabase';
import { validateBacktestTagCommitPlan, validateBacktestTagLibrary, type BacktestTagCommitPlan, type BacktestTagLibrary } from '../services/backtestTagLibrary';
import { commitBacktestTagLibrary, loadBacktestTagLibrary, type BacktestTagCommitResult } from '../services/backtestTagLibraryPersistence';
import BacktestTagManager, { captureBacktestTagCommitAttempt, tagAttemptDefinitelyNotApplied, type BacktestTagCommitAttempt } from './BacktestTagManager';

export interface BacktestTagLibraryDialogProps {
  ownerId: string;
  accounts: Account[];
  open: boolean;
  isDark: boolean;
  onClose: () => void;
  onCommitted: (patches: Array<{ tradeId: string; updates: Partial<Trade> }>) => void;
  onLibraryChanged?: (library: BacktestTagLibrary) => void;
  onLibraryError?: (message: string) => void;
}
export interface BacktestTagDialogSnapshot {
  library?: BacktestTagLibrary;
  /** Only rows eligible for explicit historical merge; exclusions remain visible below. */
  trades?: Trade[];
  excludedTrades: Array<{ tradeId: string; reason: string }>;
  libraryLoading: boolean;
  tradesLoading: boolean;
  libraryError?: string;
  tradesError?: string;
  loadedRows: number;
  committing: boolean;
  blocked: boolean;
}
export interface BacktestTagDialogDependencies {
  getOwnerId: () => Promise<string | null>;
  onLibraryChanged?: (library: BacktestTagLibrary) => void;
  onLibraryError?: (message: string) => void;
  subscribeOwner?: (listener: (ownerId: string | null) => void) => () => void;
  loadLibrary: (ownerId: string) => Promise<BacktestTagLibrary>;
  loadTrades: (accountIds: string[], ownerId: string, options: { strict: true; expectedOwnerId: string; signal: AbortSignal; onProgress: (loaded: number) => void }) => Promise<Trade[]>;
  commitPlan: (plan: BacktestTagCommitPlan) => Promise<BacktestTagCommitResult>;
}
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : 'Načtení dat nebylo potvrzené. Zkus je obnovit.';
const staleMessage = 'Uživatel nebo rozsah účtů se během operace změnil. Výsledek původního načtení nelze použít.';

/** An owner-bound session, without I/O until start(). Refresh never replaces confirmed
 * data with an empty fallback. Its external store keeps the editor mounted on retries. */
export const createBacktestTagDialogController = (ownerId: string, dependencies: BacktestTagDialogDependencies) => {
  let state: BacktestTagDialogSnapshot = { libraryLoading: true, tradesLoading: true, excludedTrades: [], loadedRows: 0, committing: false, blocked: false };
  let active = false, generation = 0, paused = false, refreshAfterCommit = false;
  let accountIds: string[] = [];
  let abort: AbortController | undefined;
  let unsubscribeOwner: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const attempted = new Map<string, BacktestTagCommitAttempt>();
  const emit = (patch: Partial<BacktestTagDialogSnapshot>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const isCurrent = (captured: number) => active && captured === generation;
  const requireCurrent = (captured: number) => { if (!isCurrent(captured)) throw new Error(staleMessage); };
  const assertCurrent = async (captured: number) => {
    if (!isCurrent(captured)) throw new Error(staleMessage);
    const actual = await dependencies.getOwnerId();
    if (isCurrent(captured) && actual !== ownerId) invalidateOwner();
    if (!isCurrent(captured)) throw new Error(staleMessage);
  };
  const stop = () => { active = false; generation += 1; abort?.abort(); unsubscribeOwner?.(); unsubscribeOwner = undefined; if (state.committing) emit({ committing: false }); };
  const invalidateOwner = () => {
    generation += 1; abort?.abort();
    emit({ library: undefined, trades: undefined, excludedTrades: [], loadedRows: 0, blocked: true, libraryLoading: false, tradesLoading: false,
      committing: false, libraryError: staleMessage, tradesError: undefined });
  };
  const refresh = async () => {
    if (!active || state.committing) return;
    const captured = ++generation;
    abort?.abort(); abort = new AbortController();
    const signal = abort.signal, scope = [...accountIds];
    emit({ libraryLoading: true, tradesLoading: true, libraryError: undefined, tradesError: undefined, loadedRows: 0 });
    try { await assertCurrent(captured); requireCurrent(captured); }
    catch (reason) {
      if (isCurrent(captured)) emit({ blocked: true, library: undefined, trades: undefined,
        libraryLoading: false, tradesLoading: false, libraryError: errorText(reason) });
      if (isCurrent(captured)) dependencies.onLibraryError?.(errorText(reason));
      return;
    }
    emit({ blocked: false });
    await Promise.allSettled([
      (async () => {
        try {
          const library = await dependencies.loadLibrary(ownerId);
          await assertCurrent(captured); requireCurrent(captured);
          if (library.ownerId !== ownerId) throw new Error(staleMessage);
          validateBacktestTagLibrary(library);
          emit({ library, libraryLoading: false });
          requireCurrent(captured); dependencies.onLibraryChanged?.(structuredClone(library));
        } catch (reason) { if (isCurrent(captured)) { emit({ libraryLoading: false, libraryError: errorText(reason) }); requireCurrent(captured); dependencies.onLibraryError?.(errorText(reason)); } }
      })(),
      (async () => {
        try {
          const trades = scope.length ? await dependencies.loadTrades(scope, ownerId, {
            strict: true, expectedOwnerId: ownerId, signal,
            onProgress: loadedRows => { if (isCurrent(captured)) emit({ loadedRows }); },
          }) : [];
          await assertCurrent(captured); requireCurrent(captured);
          const seen = new Set<string>();
          const eligible: Trade[] = [], excludedTrades: BacktestTagDialogSnapshot['excludedTrades'] = [];
          for (const trade of trades) {
            if ((typeof trade.id !== 'string' && typeof trade.id !== 'number') || !String(trade.id).trim() || !trade.accountId || !scope.includes(trade.accountId) || seen.has(String(trade.id))) {
              throw new Error('Načtené obchody nemají jednoznačnou identitu a backtest účet. Rozsah nebyl potvrzen.');
            }
            seen.add(String(trade.id));
            if (typeof trade.backtestRunId !== 'string' || !trade.backtestRunId.trim()) {
              excludedTrades.push({ tradeId: String(trade.id), reason: 'Chybí propojení s backtest session (backtestRunId). Historické tagy nelze bezpečně sloučit; katalog lze upravovat.' });
            } else eligible.push(trade);
          }
          emit({ trades: eligible, excludedTrades, tradesLoading: false, loadedRows: trades.length });
        } catch (reason) { if (isCurrent(captured)) emit({ tradesLoading: false, tradesError: errorText(reason) }); }
      })(),
    ]);
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: (ids: string[]) => {
      active = true; paused = false; accountIds = [...new Set(ids)].sort();
      unsubscribeOwner?.();
      unsubscribeOwner = dependencies.subscribeOwner?.(actual => { if (active && actual !== ownerId) invalidateOwner(); });
      if (state.committing) { refreshAfterCommit = true; return Promise.resolve(); }
      return refresh();
    },
    stop,
    // Closing may cancel reads, but a still-mounted owner must receive a confirmed
    // commit. Its auth subscription remains only until that in-flight RPC settles.
    pause: () => { paused = true; if (!state.committing) stop(); },
    refresh,
    commit: async (plan: BacktestTagCommitPlan, onConfirmed?: (patches: Array<{ tradeId: string; updates: Partial<Trade> }>) => void) => {
      const captured = generation, operationId = plan.operationId;
      if (!active || state.blocked || state.committing || state.libraryLoading || state.tradesLoading
        || state.libraryError || state.tradesError || !state.library || !state.trades) {
        throw new Error('Nejdřív musí být potvrzené načtení katalogu i všech obchodů. Obnov data; náhled zůstává zachovaný.');
      }
      emit({ committing: true });
      try {
        const request = await captureBacktestTagCommitAttempt(plan);
        await assertCurrent(captured); requireCurrent(captured);
        if (attempted.get(operationId)?.hash !== request.hash) validateBacktestTagCommitPlan(request.plan, state.library!, state.trades!, ownerId);
        attempted.set(operationId, request);
        const result = await dependencies.commitPlan(request.plan);
        await assertCurrent(captured); requireCurrent(captured);
        // The RPC receipt can acknowledge an older operation after a later review.
        // Apply its current, authoritative tag fields, never the original plan again.
        const patches = new Map(result.tradePatches.map(patch => [patch.tradeId, patch.updates]));
        emit({ library: result.library, trades: state.trades!.map(trade => patches.has(String(trade.id)) ? { ...trade, ...patches.get(String(trade.id)) } : trade) });
        requireCurrent(captured);
        dependencies.onLibraryChanged?.(structuredClone(result.library));
        requireCurrent(captured); onConfirmed?.(result.tradePatches);
        return result.tradePatches;
      } catch (reason) {
        if (tagAttemptDefinitelyNotApplied(reason)) attempted.delete(operationId);
        throw reason;
      } finally { if (isCurrent(captured)) { emit({ committing: false }); if (paused) stop(); else if (refreshAfterCommit) { refreshAfterCommit = false; void refresh(); } } }
    },
  };
};
const dependencies: BacktestTagDialogDependencies = {
  getOwnerId: getUserId,
  subscribeOwner: listener => {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => listener(session?.user?.id ?? null));
    return () => data.subscription.unsubscribe();
  },
  loadLibrary: loadBacktestTagLibrary,
  loadTrades: (ids, ownerId, options) => storageService.getTradesWithDataByAccounts(ids, ownerId, options),
  commitPlan: commitBacktestTagLibrary,
};

export function BacktestTagLibraryLoadStatus({ state, onRefresh }: { state: BacktestTagDialogSnapshot; onRefresh: () => void }) {
  const loading = state.libraryLoading || state.tradesLoading;
  return <div className="mb-4 space-y-2 rounded border border-slate-500/30 p-3 text-xs">
    <p role="status">{state.libraryLoading ? 'Načítám katalog…' : state.libraryError ? 'Katalog se nepodařilo načíst.' : 'Katalog načtený.'} {state.tradesLoading ? `Načítám obchody · potvrzeno ${state.loadedRows}…` : state.tradesError || state.blocked ? 'Úplný rozsah obchodů nebyl potvrzený.' : `Načteno ${state.loadedRows} backtest obchodů.`}</p>
    {state.trades && !state.blocked && <div className="space-y-2">
      <p>{state.tradesLoading || state.tradesError ? 'Poslední potvrzený rozsah' : 'Rozsah pro sloučení'}: {state.trades.length + state.excludedTrades.length} načtených · {state.trades.length} způsobilých · {state.excludedTrades.length} vyloučených.</p>
      {state.excludedTrades.length > 0 && <details><summary className="cursor-pointer underline">Vyloučené historické obchody a důvody ({state.excludedTrades.length})</summary><ul className="mt-2 max-h-40 space-y-2 overflow-y-auto">{state.excludedTrades.map(item => <li key={item.tradeId}><strong>{item.tradeId}</strong> — {item.reason}</li>)}</ul></details>}
    </div>}
    {state.libraryError && <p role="alert" className="whitespace-pre-wrap text-red-500">{state.libraryError}</p>}
    {state.tradesError && <p role="alert" className="whitespace-pre-wrap text-red-500">{state.tradesError}</p>}
    <button type="button" disabled={loading || state.committing} onClick={onRefresh} className="underline disabled:opacity-40">Obnovit katalog a obchody</button>
    <p>Obnovení zachová rozepsanou úpravu i náhled. Změněný rozsah vyžaduje nový náhled před potvrzením.</p>
  </div>;
}
export const backtestTagAccountIds = (accounts: readonly Account[]) => [...new Set(accounts.filter(account => account.type === 'Backtest').map(account => account.id))].sort();
function OwnerTagLibraryDialog({ ownerId, accounts, open, isDark, onClose, onCommitted, onLibraryChanged, onLibraryError }: BacktestTagLibraryDialogProps) {
  const callbacks = useRef({ onLibraryChanged, onLibraryError });
  callbacks.current = { onLibraryChanged, onLibraryError };
  const [controller] = useState(() => createBacktestTagDialogController(ownerId, { ...dependencies,
    onLibraryChanged: library => callbacks.current.onLibraryChanged?.(library),
    onLibraryError: message => callbacks.current.onLibraryError?.(message),
  }));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const scope = useMemo(() => JSON.stringify(backtestTagAccountIds(accounts)), [accounts]);
  const initialDialog = useRef<HTMLElement>(null);
  const ready = Boolean(state.library && state.trades && !state.blocked);
  // Closing retains the mounted owner editor, but cancels read requests. Reopening
  // refreshes both resources before an old preview can be committed.
  useEffect(() => {
    if (!open) return;
    void controller.start(JSON.parse(scope));
    return () => controller.pause();
  }, [controller, open, scope]);
  useEffect(() => () => controller.stop(), [controller]);
  useEffect(() => {
    if (!open || ready) return;
    const previous = document.activeElement as HTMLElement | null;
    initialDialog.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [open, ready]);
  const status = <BacktestTagLibraryLoadStatus state={state} onRefresh={() => void controller.refresh()} />;
  if (ready) return <BacktestTagManager library={state.library!} trades={state.trades!} ownerId={ownerId}
    open={open} isDark={isDark} onClose={onClose} headerContent={status}
    onCommit={async plan => { await controller.commit(plan, onCommitted); }} />;
  if (!open) return null;
  return <div className="fixed inset-0 z-[960] flex items-center justify-center bg-slate-950/50 p-4" role="presentation">
    <section ref={initialDialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="backtest-tag-library-load-title"
      className={`w-full max-w-xl rounded-xl border p-5 shadow-xl ${isDark ? 'border-slate-700 bg-slate-950 text-slate-100' : 'border-slate-200 bg-slate-50 text-slate-900'}`}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        if (event.key === 'Tab') {
          const buttons = [...(initialDialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
          if (event.shiftKey && (document.activeElement === buttons[0] || document.activeElement === initialDialog.current)) { event.preventDefault(); buttons.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
        }
      }}>
      <header className="mb-4 flex items-center justify-between gap-3"><h2 id="backtest-tag-library-load-title" className="font-bold">Správa tagů</h2><button type="button" onClick={onClose} className="text-sm underline">Zavřít</button></header>
      {status}
    </section>
  </div>;
}
export default function BacktestTagLibraryDialog(props: BacktestTagLibraryDialogProps) {
  // A new owner gets a new controller and draft; late responses from the old
  // instance cannot reach either the new editor or onCommitted.
  return <OwnerTagLibraryDialog key={props.ownerId} {...props} />;
}
