import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import ConfirmActionDialog from './ConfirmActionDialog';
import { isCopierBrakeQueuedError } from '../lib/copierBrakeDelivery';
import { liveSafetyFailureMessage, liveSafetyTargetAge, type FlattenGroupCoordinator, type LiveSafetyAction, type LiveSafetyTarget } from '../lib/liveSafetyAction';

interface Props {
  target: LiveSafetyTarget | null;
  onAction: (action: LiveSafetyAction, confirmedTarget?: LiveSafetyTarget) => Promise<string>;
  flattenCoordinator: FlattenGroupCoordinator;
  copierArmed: boolean;
}

/** Static LIVE shell. No dependency on overview/chart chunks, balances or fresh ARM data. */
export default function LiveSafetyControls({ target, onAction, flattenCoordinator, copierArmed }: Props) {
  const [confirmation, setConfirmation] = useState<{ action: LiveSafetyAction; target: LiveSafetyTarget | null } | null>(null);
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
      <div className="flex gap-2">{(['disarm', 'kill-switch', 'flatten-group'] as const).map(action => {
        const waiting = pending.includes(action) || (action === 'flatten-group' && sharedFlattenPending);
        return <button key={action} type="button" disabled={waiting || (action === 'flatten-group' && !target)} onClick={() => setConfirmation({ action, target })} className={`min-h-9 flex-1 rounded-lg border px-2 text-xs font-black disabled:opacity-45 ${action === 'disarm' ? 'border-[var(--border-subtle)] bg-[var(--bg-page)] text-[var(--text-primary)]' : 'border-rose-500/40 bg-rose-600 text-white'}`}>
          {waiting ? `${labels[action]} · čekám` : labels[action]}
        </button>;
      })}</div>
      {!target && <p className="mb-0 mt-1.5 text-[10px] text-[var(--text-secondary)]">Flatten vyžaduje známou skupinu. Pokud worker není dostupný, ověř a zavři pozice přímo u brokera.</p>}
      {notice && <p role="status" className={`mb-0 mt-2 text-[11px] font-bold ${notice.tone === 'error' ? 'text-rose-500' : 'text-[var(--text-primary)]'}`}>Poslední akce {new Date(notice.at).toLocaleTimeString('cs-CZ')} · {notice.text}</p>}
    </section>
    {confirmation && <div className="fixed inset-0 z-[600]">
      <ConfirmActionDialog title={`${labels[confirmation.action]}?`} tone="danger" confirmLabel={labels[confirmation.action]} message={confirmation.action === 'disarm'
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
