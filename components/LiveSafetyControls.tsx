import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import ConfirmActionDialog from './ConfirmActionDialog';
import { LiveCancelPendingBar, LiveCancelPendingBoundary, type LiveCancelPendingBarInput } from './LivePendingCancel';
import { isCopierBrakeQueuedError } from '../lib/copierBrakeDelivery';
import { liveSafetyFailureMessage, liveSafetyTargetAge, type FlattenGroupCoordinator, type LiveSafetyAction, type LiveSafetyTarget } from '../lib/liveSafetyAction';
import {
  liveSafetyShortcutConfirmation,
  subscribeLiveSafetyShortcut,
  type LiveSafetyShortcutListener,
  type LiveSafetyShortcutSource,
  type LiveSafetyShortcutView,
} from '../lib/liveSafetyShortcut';

/** Potvrzení lišty; `source` = otevřeno zkratkou (Shift+F, akce notifikace), chybí = tlačítkem lišty. */
export interface LiveSafetyConfirmation { action: LiveSafetyAction; target: LiveSafetyTarget | null; source?: LiveSafetyShortcutSource }

/**
 * Fokus dialogu lišty při otevření: ze zkratky na Zrušit (reflexní Enter / mezerník hned
 * po Shift+F nesmí potvrdit Flatten — oponentura vlny B, INV-UI-02), z tlačítka lišty
 * beze změny na potvrzení (uživatel už klikl myší).
 */
export const liveSafetyDialogInitialFocus = (source: LiveSafetyShortcutSource | null | undefined): 'confirm' | 'cancel' => (
  source != null ? 'cancel' : 'confirm'
);

/**
 * Posluchač bezpečnostní zkratky (U1 Shift+F na PC, U6 akce notifikace): jen OTEVŘE
 * potvrzovací dialog lišty (`open` = `setConfirmation`) se stejným cílem, nebo ukáže
 * důvod, proč ne. Akci nikdy nevolá — příkaz vzniká dál jen potvrzením v dialogu
 * (`onResolve` → `run` → `onAction`, týž zámek skupiny; INV-UI-02, INV-BRAKE-01).
 */
export function liveSafetyShortcutListener(deps: {
  view: () => LiveSafetyShortcutView;
  open: (confirmation: LiveSafetyConfirmation) => void;
  ignored: (text: string) => void;
  now?: () => number;
}): LiveSafetyShortcutListener {
  return request => {
    const decision = liveSafetyShortcutConfirmation(request, deps.view(), (deps.now ?? Date.now)());
    if ('open' in decision) deps.open({ ...decision.open, source: request.source });
    else deps.ignored(decision.ignored);
  };
}

interface Props {
  target: LiveSafetyTarget | null;
  onAction: (action: LiveSafetyAction, confirmedTarget?: LiveSafetyTarget) => Promise<string>;
  flattenCoordinator: FlattenGroupCoordinator;
  copierArmed: boolean;
  /**
   * C7 (4. 11. 2026): „Zrušit čekající“ vedle Flatten All (PC) — jen vlastní čekající vstupy,
   * dvoukrokově, sdíleným zámkem desku. Chybí / null = tlačítko není. Flatten tím zamčený není.
   * Vykresluje se ve vlastní hranici chyb: pád části C7 lištu OFF / Kill / Flatten nesundá.
   */
  cancelPending?: LiveCancelPendingBarInput | null;
}

/** Static LIVE shell. No dependency on overview/chart chunks, balances or fresh ARM data. */
export default function LiveSafetyControls({ target, onAction, flattenCoordinator, copierArmed, cancelPending = null }: Props) {
  const [confirmation, setConfirmation] = useState<LiveSafetyConfirmation | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'error'; at: number } | null>(null);
  const [pending, setPending] = useState<LiveSafetyAction[]>([]);
  const inFlight = useRef(new Set<LiveSafetyAction>());
  const noticeEpoch = useRef(0);
  const barRef = useRef<HTMLElement>(null);
  const sharedFlattenPending = useSyncExternalStore(
    flattenCoordinator.subscribe,
    () => target != null && flattenCoordinator.pending(target.id),
    () => false,
  );
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    // Reserve the whole bar (including notices) so it never covers the chart
    // ticket or the final controls in the scrolling LIVE overview.
    const measure = () => document.documentElement.style.setProperty('--live-safety-height', `${Math.ceil(window.innerHeight - bar.getBoundingClientRect().top + 12)}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    window.addEventListener('resize', measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); document.documentElement.style.removeProperty('--live-safety-height'); };
  }, []);
  // Zkratka (Shift+F / notifikace) smí jen otevřít dialog lišty: stav se čte přes ref
  // v okamžiku požadavku, otevřený dialog se nikdy nepřepíše (liveSafetyShortcutConfirmation).
  const confirmationRef = useRef(confirmation);
  confirmationRef.current = confirmation;
  const targetRef = useRef(target);
  targetRef.current = target;
  const coordinatorRef = useRef(flattenCoordinator);
  coordinatorRef.current = flattenCoordinator;
  const [shortcutNotice, setShortcutNotice] = useState<{ text: string; at: number } | null>(null);
  useEffect(() => subscribeLiveSafetyShortcut(liveSafetyShortcutListener({
    view: () => {
      const current = targetRef.current;
      return {
        target: current,
        confirmationOpen: confirmationRef.current != null,
        pending: [...inFlight.current],
        flattenPending: current != null && coordinatorRef.current.pending(current.id),
      };
    },
    open: next => {
      confirmationRef.current = next;
      setShortcutNotice(null);
      setConfirmation(next);
    },
    ignored: text => setShortcutNotice({ text, at: Date.now() }),
  })), []);
  useEffect(() => {
    if (!shortcutNotice) return undefined;
    const timer = window.setTimeout(() => setShortcutNotice(current => (current?.at === shortcutNotice.at ? null : current)), 6_000);
    return () => window.clearTimeout(timer);
  }, [shortcutNotice]);
  useEffect(() => {
    if (!notice) return undefined;
    if (copierArmed) {
      setNotice(null);
      return undefined;
    }
    const remaining = Math.max(0, 10 * 60_000 - (Date.now() - notice.at));
    const timer = window.setTimeout(() => setNotice(current => current?.at === notice.at ? null : current), remaining);
    return () => window.clearTimeout(timer);
  }, [copierArmed, notice]);
  const run = async (action: LiveSafetyAction, confirmedTarget?: LiveSafetyTarget) => {
    if (inFlight.current.has(action)) return;
    inFlight.current.add(action);
    const epoch = ++noticeEpoch.current;
    setPending([...inFlight.current]);
    setNotice(null);
    try {
      const text = await onAction(action, confirmedTarget);
      if (noticeEpoch.current === epoch) setNotice({ text, tone: 'info', at: Date.now() });
    }
    catch (reason) {
      if (noticeEpoch.current === epoch) setNotice({ at: Date.now(), tone: isCopierBrakeQueuedError(reason) ? 'info' : 'error', text: liveSafetyFailureMessage(reason) });
    } finally { inFlight.current.delete(action); setPending([...inFlight.current]); }
  };
  const labels = { disarm: 'OFF', 'kill-switch': 'Kill switch', 'flatten-group': 'Flatten All' } as const;
  const content = <>
    <section ref={barRef} data-live-safety-controls aria-label="Nouzové ovládání LIVE" className="native-fixed-above-tab-bar fixed bottom-[calc(env(safe-area-inset-bottom,0px)+5.75rem)] left-3 right-3 z-[350] mx-auto max-w-[1500px] rounded-xl border border-rose-500/40 bg-[var(--bg-card)] p-2 shadow-xl lg:bottom-[max(12px,env(safe-area-inset-bottom))]">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px] text-[var(--text-secondary)]"><b>Nouzové ovládání</b><span className="truncate">{target ? `Skupina: ${target.name} · ${liveSafetyTargetAge(target)}` : 'Skupina workeru nezjištěna · stav cíle neověřený'}</span></div>
      <div className="flex flex-wrap gap-2">{(['disarm', 'kill-switch', 'flatten-group'] as const).map(action => {
        const waiting = pending.includes(action) || (action === 'flatten-group' && sharedFlattenPending);
        return <button key={action} type="button" disabled={waiting || (action === 'flatten-group' && !target)} onClick={() => setConfirmation({ action, target })} className={`min-h-9 flex-1 rounded-lg border px-2 text-xs font-black disabled:opacity-45 ${action === 'disarm' ? 'border-[var(--border-subtle)] bg-[var(--bg-page)] text-[var(--text-primary)]' : 'border-rose-500/40 bg-rose-600 text-white'}`}>
          {waiting ? `${labels[action]} · čekám` : labels[action]}
        </button>;
      })}
        {/* C7 (není safety akce): vlastní hranice chyb, stále připojené kvůli výsledku po zmizení nabídky. */}
        <LiveCancelPendingBoundary resetKey={typeof cancelPending?.view?.key === 'string' ? cancelPending.view.key : ''}><LiveCancelPendingBar input={cancelPending} /></LiveCancelPendingBoundary>
      </div>
      {!target && <p className="mb-0 mt-1.5 text-[10px] text-[var(--text-secondary)]">Flatten vyžaduje známou skupinu. Pokud worker není dostupný, ověř a zavři pozice přímo u brokera.</p>}
      {shortcutNotice && <p role="status" className="mb-0 mt-1.5 text-[10.5px] font-bold text-amber-600">Zkratka: {shortcutNotice.text}</p>}
      {notice && <p role="status" className={`mb-0 mt-2 text-[11px] font-bold ${notice.tone === 'error' ? 'text-rose-500' : 'text-[var(--text-primary)]'}`}>Poslední akce {new Date(notice.at).toLocaleTimeString('cs-CZ')} · {notice.text}</p>}
    </section>
    {confirmation && <div className="fixed inset-0 z-[600]">
      <ConfirmActionDialog title={`${labels[confirmation.action]}?`} tone="danger" confirmLabel={labels[confirmation.action]} initialFocus={liveSafetyDialogInitialFocus(confirmation.source)} message={confirmation.action === 'disarm'
        ? 'Vypnout kopírování? Pozice zůstanou otevřené a followeři přestanou dostávat posuny SL/TP a výstupy leadera. K zavření pozic použij Flatten All.'
        : confirmation.action === 'kill-switch'
          ? 'Aktivovat Kill switch? Zablokuje běžné brokerové akce kopírky a zůstává aktivní do výslovné obnovy. Pozice samo nezavírá.'
          : `Zavřít pozice a zrušit pracovní příkazy ve skupině ${confirmation.target?.name}? Zahrnuje leadera i všechny followery potvrzené skupiny (${confirmation.target?.accountIds.length ?? 0} účtů). Názvy ani čísla účtů se v tomto dialogu nezobrazují. Rozsah vychází z posledního známého stavu workeru; jiné skupiny nejsou cílem.`} onResolve={confirmed => {
            const request = confirmation;
            setConfirmation(null);
            if (confirmed) void run(request.action, request.target ?? undefined);
          }} />
    </div>}
  </>;
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
