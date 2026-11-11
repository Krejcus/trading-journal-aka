import React, { useEffect, useRef, useState } from 'react';
import type { LeaderOrderManageResult } from '../lib/leaderOrderManage';

/** Druhý klik potvrzení nejdřív za tolik ms (stejné pravidlo jako potvrzení čáry v grafu). */
export const REDUCE_CONFIRM_MIN_MS = 350;
/** Potvrzení se po tolika ms samo vrátí do klidu. */
export const REDUCE_CONFIRM_TIMEOUT_MS = 4_000;

export type LiveReduceView = { symbol: string; quantity: number; positionQuantity: number };

/** Text výsledku pro uživatele (čistá funkce kvůli testu). */
export function liveReduceResultText(result: Pick<LeaderOrderManageResult, 'status' | 'blockers' | 'reason'>): { tone: 'ok' | 'warn' | 'error'; text: string } {
  if (result.status === 'acknowledged') return { tone: 'ok', text: result.reason ?? 'Lístek zavřen.' };
  if (result.status === 'blocked') return { tone: 'warn', text: result.blockers[0]?.text ?? result.reason ?? 'Nic se neodeslalo.' };
  return { tone: 'error', text: result.reason ?? 'Výsledek není jistý — zkontroluj leadera v Tradovate.' };
}

/**
 * Částečné zavření pozice (11. 11. 2026): zavře celý nejnovější lístek (poslední přikoupení).
 * Jen zobrazení a odeslání příkazu — vše ověřuje worker (INV-UI-01). Dvoukrokové potvrzení;
 * sdílený zámek jednoho příkazu desku, aby dvojklik neposlal dva příkazy.
 */
export function LiveReducePositionButton(props: {
  view: LiveReduceView;
  lockRef: React.MutableRefObject<boolean>;
  reduce: (view: LiveReduceView) => Promise<LeaderOrderManageResult>;
}) {
  const { view, lockRef, reduce } = props;
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    if (armedAt == null) return;
    const timer = window.setTimeout(() => setArmedAt(null), REDUCE_CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [armedAt]);
  // Jiná pozice nebo jiný lístek = potvrzení neplatí.
  useEffect(() => { setArmedAt(null); }, [view.symbol, view.quantity, view.positionQuantity]);

  const click = async () => {
    if (busy) return;
    const now = Date.now();
    if (armedAt == null) { setNotice(null); setArmedAt(now); return; }
    if (now - armedAt < REDUCE_CONFIRM_MIN_MS) return;
    if (lockRef.current) { setNotice({ tone: 'warn', text: 'Běží jiný příkaz — počkej na jeho výsledek.' }); return; }
    lockRef.current = true;
    setBusy(true);
    setArmedAt(null);
    try {
      const result = await reduce(view);
      if (mounted.current) setNotice(liveReduceResultText(result));
    } catch (error) {
      if (mounted.current) setNotice({ tone: 'warn', text: error instanceof Error ? error.message : 'Nic se neodeslalo.' });
    } finally {
      lockRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const label = busy ? 'Zavírám…' : armedAt != null ? `Potvrdit: zavřít ${view.quantity} ks Marketem` : `Zavřít ${view.quantity} z ${view.positionQuantity} ks`;
  const toneClass = notice?.tone === 'ok' ? 'text-emerald-500' : notice?.tone === 'error' ? 'text-rose-500' : 'text-amber-500';
  return (
    <div data-testid="live-reduce-position" className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-[12px]">
      <span className="font-bold text-[var(--text-secondary)]">{view.symbol} · částečné zavření (poslední přikoupení)</span>
      <button
        type="button" disabled={busy} onClick={() => { void click(); }}
        title="Zruší SL a TP posledního přikoupení a zavře jeho kontrakty Marketem. Zbytek pozice zůstane se svými SL/TP."
        className={`rounded-md border px-2.5 py-1 font-black ${armedAt != null ? 'border-rose-500/60 text-rose-500' : 'border-[var(--border-subtle)] text-[var(--text-primary)]'} disabled:opacity-50`}
      >
        {label}
      </button>
      {notice ? <span role="status" className={`font-semibold ${toneClass}`}>{notice.text}</span> : null}
    </div>
  );
}
