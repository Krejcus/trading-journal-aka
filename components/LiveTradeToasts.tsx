import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CopierCopyEvent } from '../services/copierRuntimeController';
import { TRADE_TOAST_MAX, TRADE_TOAST_MS, copyEventToast, newCopyEvents, type TradeToast, type TradeToastTone } from '../lib/liveTradeToasts';

const TONE: Record<TradeToastTone, string> = {
  blue: '#3b82f6', violet: '#8b5cf6', red: '#f43f5e', teal: '#14b8a6', green: '#10b981', amber: '#f59e0b', muted: '#64748b',
};
const usd = (value: number) => `${value >= 0 ? '+' : '−'}$${Math.abs(value).toFixed(2)}`;
const time = (at: number) => new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

/**
 * Tenká karta (návrh B, mockups/live-order-toasts.html) vlevo dole v LIVE
 * grafu: typ + název + P&L, pod tím čísla a tečky kopií. Mizí po 2 s, najetí
 * myší ji podrží; problémy (sticky) zůstanou do zavření. Jen zobrazení.
 */
const ToastCard: React.FC<{ toast: TradeToast; isDark: boolean; copierArmed: boolean; onDismiss: (id: string) => void }> = ({ toast, isDark, copierArmed, onDismiss }) => {
  const onClose = useCallback(() => onDismiss(toast.id), [onDismiss, toast.id]);
  const color = TONE[toast.tone];
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (toast.sticky || hovered) return undefined;
    const timer = window.setTimeout(onClose, TRADE_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [hovered, onClose, toast.sticky]);
  return (
    <div
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="live-trade-toast pointer-events-auto relative grid w-[300px] gap-[3px] overflow-hidden rounded-[10px] border py-[7px] pl-[10px] pr-[8px]"
      style={{
        borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)',
        // Vlastní výplň (Chrome nemusí kreslit backdrop blur) + jemná záře v barvě typu.
        background: `radial-gradient(110% 120% at 0% 0%, ${color}24, transparent 60%), ${isDark ? 'rgba(13,18,26,0.94)' : 'rgba(255,255,255,0.95)'}`,
        boxShadow: '0 14px 32px -20px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.05)',
      }}
    >
      <div className="flex min-w-0 items-center gap-[7px]">
        <span className="shrink-0 rounded-[4px] px-[5px] py-[2px] text-[8.5px] font-black uppercase tracking-[0.08em] text-white" style={{ background: color }}>{toast.badge}</span>
        <span className={`truncate text-[12px] font-extrabold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{toast.title}</span>
        {toast.pnl != null && <span className="ml-auto font-mono text-[12px] font-extrabold" style={{ color: toast.pnl >= 0 ? TONE.green : TONE.red }}>{usd(toast.pnl)}</span>}
        <span className={`${toast.pnl != null ? 'ml-1.5' : 'ml-auto'} font-mono text-[10px] font-semibold text-slate-500`}>{time(toast.at)}</span>
        <button type="button" onClick={onClose} aria-label="Zavřít" className="px-0.5 text-[13px] leading-none text-slate-500 hover:text-slate-200">×</button>
      </div>
      <div className="flex min-w-0 items-center gap-[7px]">
        <span className={`truncate font-mono text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{toast.line}</span>
        {toast.accounts > 0 && <span className="ml-auto flex shrink-0 gap-[3px]" title={copierArmed
          ? `Leader + ${toast.accounts - 1} followerů ve skupině (kopírka zapnutá)`
          : 'Kopírka je vypnutá — followeři se nekopírují'}>
          {Array.from({ length: Math.min(copierArmed ? toast.accounts : 1, 8) }, (_, index) => <i key={index} className="block h-[6px] w-[6px] rounded-full" style={{ background: copierArmed ? TONE.green : TONE.muted }} />)}
        </span>}
      </div>
    </div>
  );
};

const LiveTradeToasts: React.FC<{ events: readonly CopierCopyEvent[] | undefined; copierArmed: boolean; isDark: boolean }> = ({ events, copierArmed, isDark }) => {
  const [toasts, setToasts] = useState<TradeToast[]>([]);
  const seenRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!events) return;
    // První načtení = staré události (bez hodin prohlížeče vs. workeru): jen si je zapamatovat.
    if (!seenRef.current) { seenRef.current = new Set(events.map(event => event.id)); return; }
    const fresh = newCopyEvents(events, seenRef.current);
    if (fresh.length === 0) return;
    for (const event of fresh) seenRef.current.add(event.id);
    const added = fresh.map(copyEventToast).filter((toast): toast is TradeToast => toast != null);
    if (added.length) setToasts(current => [...current, ...added].slice(-TRADE_TOAST_MAX));
  }, [events]);
  // Stabilní: časovač karty se nesmí restartovat s každým pollem statusu.
  const dismiss = useCallback((id: string) => setToasts(current => current.filter(item => item.id !== id)), []);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none absolute bottom-9 left-2 z-[640] flex flex-col gap-2" aria-live="polite">
      {toasts.map(toast => (
        <ToastCard key={toast.id} toast={toast} isDark={isDark} copierArmed={copierArmed} onDismiss={dismiss} />
      ))}
    </div>
  );
};

export default LiveTradeToasts;
