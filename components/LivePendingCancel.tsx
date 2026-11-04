import React, { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LiveManageNotice } from '../hooks/useLiveManageRunner';
import { createLiveCancelPendingClick, createLiveCancelPendingRun } from '../hooks/liveCommandRuns';
import { useLiveConfirmGate } from '../hooks/useLiveConfirmGate';
import type { CancelPendingItemResult, PendingOwnEntry } from '../lib/liveCancelPending';
import { cancelPendingConfirmText } from '../lib/liveCancelPending';
import { dashboardOrderCancelView, type DashboardOrderCancelInput, type LiveCancelPendingView } from '../lib/liveCancelPendingUi';

/** Deskový `cancelPendingEntries` — N× `cancel-entry` jádra (C7). */
export type LiveCancelPendingCallback = (entries: readonly PendingOwnEntry[]) => Promise<CancelPendingItemResult[]>;

/**
 * Ovládání „Zrušit čekající“ (C7, 4. 11. 2026): dvoukrok `createLiveConfirmGate` (2. klik 350 ms
 * – 4 s od PŘEDCHOZÍHO kliku, klíč = přesně sada, kterou uživatel vidí), sdílený zámek jednoho
 * příkazu (`lockRef` = zámek desku `liveCommandLockRef`) a výsledek po položkách. Nic se
 * neopakuje. Rozběhnuté „Opravdu?“ zmizí po 4 s, při zablokování i při změně sady (vyplnění,
 * nový vstup) — i bez kliku.
 */
export function useLiveCancelPendingAction(input: {
  view: LiveCancelPendingView | null;
  lockRef: { current: boolean };
  cancel: LiveCancelPendingCallback | null | undefined;
  onNotice?: (notice: LiveManageNotice) => void;
}) {
  const view = input.view;
  const { gate } = useLiveConfirmGate([view]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<LiveManageNotice | null>(null);
  const cancelRef = useRef(input.cancel);
  cancelRef.current = input.cancel;
  const onNoticeRef = useRef(input.onNotice);
  onNoticeRef.current = input.onNotice;
  const click = useMemo(() => {
    const report = (next: LiveManageNotice) => { setNotice(next); onNoticeRef.current?.(next); };
    return createLiveCancelPendingClick({
      gate,
      run: createLiveCancelPendingRun({ cancel: () => cancelRef.current, busyRef: input.lockRef, setBusy, report }),
      report,
    });
  }, [gate, input.lockRef]);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(current => (current === notice ? null : current)), 15_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const asking = view != null && gate.asking(view.key);
  return {
    asking, busy, notice,
    click: (event?: { currentTarget: { blur: () => void } }) => {
      event?.currentTarget.blur();
      void click(view);
    },
  };
}

/** Odkaz na deskový zámek a odeslání (PC lišta pod grafem). */
export interface LiveCancelPendingBarInput {
  view: LiveCancelPendingView;
  lockRef: { current: boolean };
  cancel: LiveCancelPendingCallback;
}

const FALLBACK_LOCK = { current: false };

const noticeTone = (notice: LiveManageNotice) => (notice.tone === 'bad' ? 'text-rose-500' : notice.tone === 'warn' ? 'text-amber-600' : 'text-emerald-600');

/**
 * PC lišta pod grafem vedle Flatten All (prvky řady s `flex-wrap`): tlačítko + řádek přes celou
 * šířku s textem potvrzení / důvodem / výsledkem. Komponenta zůstává připojená i bez pohledu
 * (`input` null), takže výsledek, který přijde až po zmizení nabídky (status se aktualizoval dřív
 * než ACK), se pořád ukáže. Flatten zůstává mimo zámek (tlačítka lišty mají vlastní cestu, INV-UI-02).
 */
export function LiveCancelPendingBar({ input }: { input: LiveCancelPendingBarInput | null }) {
  const action = useLiveCancelPendingAction({ view: input?.view ?? null, lockRef: input?.lockRef ?? FALLBACK_LOCK, cancel: input?.cancel });
  const view = input?.view ?? null;
  const button = view ? <button
    type="button"
    data-live-cancel-pending
    disabled={!view.enabled || action.busy}
    onClick={event => action.click(event)}
    title={view.reason ?? `${view.confirmText} Potvrdíš druhým kliknutím (350 ms – 4 s).`}
    className={`min-h-9 flex-1 rounded-lg border px-2 text-xs font-black disabled:opacity-45 ${action.asking ? 'border-amber-600 bg-amber-600 text-white' : 'border-amber-500/50 bg-[var(--bg-page)] text-amber-600'}`}
  >{action.busy ? 'Ruším…' : action.asking ? 'Opravdu zrušit?' : view.label}</button> : null;
  const status = view && action.asking
    ? <p role="status" className="m-0 basis-full text-[10.5px] font-bold text-amber-600">{view.confirmText} Klikni znovu do 4 s.</p>
    : view && !view.enabled && view.reason
      ? <p className="m-0 basis-full text-[10px] text-[var(--text-secondary)]">Zrušit čekající: {view.reason}</p>
      : action.notice
        ? <p role="status" className={`m-0 basis-full text-[11px] font-bold ${noticeTone(action.notice)}`}>Zrušit čekající · {action.notice.text}</p>
        : null;
  return <>{button}{status}</>;
}

/**
 * Vlastní hranice chyb části C7 v nouzové liště (oponentura UI kolo 1, P3 INV-UI-02 /
 * INV-DEFAULT-02): chyba „Zrušit čekající“ (rozjetý status workeru, chyba výpočtu) nikdy
 * nesundá OFF, Kill ani Flatten All — místo ní se nevykreslí nic. Jiný pohled (`resetKey`)
 * zkusí část C7 vykreslit znovu.
 */
export class LiveCancelPendingBoundary extends Component<{ children: ReactNode; resetKey?: string }, { failed: boolean; failedKey: string | null }> {
  public state: { failed: boolean; failedKey: string | null } = { failed: false, failedKey: null };

  public static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  public componentDidCatch(error: Error) {
    console.error('LiveCancelPendingBoundary: část „Zrušit čekající“ spadla — OFF / Kill / Flatten běží dál.', error);
    this.setState({ failedKey: this.props.resetKey ?? '' });
  }

  public componentDidUpdate() {
    if (this.state.failed && this.state.failedKey != null && (this.props.resetKey ?? '') !== this.state.failedKey) {
      this.setState({ failed: false, failedKey: null });
    }
  }

  public render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Desk → Dashboard: brány `dashboardCancelTarget` + zámek a odeslání (C7). */
export interface LiveDashboardPendingCancel extends DashboardOrderCancelInput {
  lockRef: { current: boolean };
  cancel: LiveCancelPendingCallback;
}

/**
 * Dashboard „Zrušit“ u příkazu (C7): jen vlastní čekající vstup leadera skupiny workeru
 * (`dashboardCancelTarget`), dvoukrokově přes deskový `cancel-entry`; jinak zamčené s vysvětlením
 * (starý worker, skupina mimo worker, blokace workeru, SL/TP pozice, cizí příkaz, neověřený stav).
 * Nepracující příkaz = jen výsledek posledního zrušení (pokud ještě je). Dřívější `cancel-order`
 * worker odmítá — tahle cesta ho už nikdy neposílá.
 */
export function DashboardOrderCancelButton({ order, cancel, compact = false, blocked = false }: {
  order: { accountId: number | null; id: number | string; working: boolean };
  cancel: LiveDashboardPendingCancel | null | undefined;
  compact?: boolean;
  /** Přehled právě posílá jiný příkaz (Flatten účtu, změna skupiny) — zrušení počká. */
  blocked?: boolean;
}) {
  const view = dashboardOrderCancelView(order, cancel);
  const pending = view.kind === 'cancel' ? view : null;
  const action = useLiveCancelPendingAction({
    view: pending ? {
      entries: [pending.entry], key: pending.key, label: 'Zrušit',
      enabled: !blocked, reason: blocked ? 'Přehled právě posílá jiný příkaz — zrušení počká.' : null,
      confirmText: cancelPendingConfirmText([pending.entry], null),
    } : null,
    lockRef: cancel?.lockRef ?? FALLBACK_LOCK,
    cancel: cancel?.cancel,
  });
  const notice = action.notice
    ? <span role="status" className={`max-w-[260px] text-right text-[10px] font-bold ${noticeTone(action.notice)}`}>{action.notice.text}</span>
    : null;
  if (view.kind === 'hidden') return notice;
  const size = compact ? 'h-9 px-3 text-xs rounded-lg' : 'h-6 px-2 text-[10px] rounded-md';
  const button = view.kind === 'locked'
    ? <button type="button" disabled title={view.reason} aria-label={`Zrušit nejde: ${view.reason}`} className={`${size} border border-rose-500/20 font-bold text-rose-500 disabled:opacity-35`}>Zrušit</button>
    : <button
      type="button"
      data-dashboard-cancel-entry
      disabled={action.busy || blocked}
      onClick={event => action.click(event)}
      title={`${cancelPendingConfirmText([view.entry], null)} Potvrdíš druhým kliknutím (350 ms – 4 s).`}
      className={`${size} border font-bold disabled:opacity-35 ${action.asking ? 'border-rose-600 bg-rose-600 text-white' : 'border-rose-500/20 text-rose-500'}`}
    >{action.busy ? 'Ruším…' : action.asking ? 'Opravdu?' : 'Zrušit'}</button>;
  if (!notice) return button;
  return <span className="inline-grid justify-items-end gap-0.5">{button}{notice}</span>;
}
