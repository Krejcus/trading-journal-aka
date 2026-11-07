import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import './day/dayJournal.css';
import type { CopierCopyEvent } from '../services/copierRuntimeController';
import { TRADE_TOAST_MS, capExtraToasts, copyEventToast, keepStickyToasts, newCopyEvents, type TradeToast, type TradeToastTone } from '../lib/liveTradeToasts';

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
/** Číselník: číslice se protočí a zastaví na ceně. */
export const RollingPrice: React.FC<{ price: number }> = ({ price }) => {
  const text = price.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <span className="dj-roll" aria-label={text}>
      {[...text].map((char, index) => (/\d/.test(char)
        ? <span key={index} className="dj-roll-digit" aria-hidden style={{ '--d': `${index * 45}ms` } as React.CSSProperties}>
            <span className="dj-roll-reel">
              {Array.from({ length: 7 }, (_, step) => <i key={step}>{(Number(char) + 3 + step) % 10}</i>)}
              <i>{char}</i>
            </span>
          </span>
        : <span key={index} aria-hidden style={{ whiteSpace: 'pre' }}>{char}</span>))}
    </span>
  );
};

const BeaconToast: React.FC<{ toast: TradeToast; isDark: boolean; onClose: () => void }> = ({ toast, isDark, onClose }) => (
  <div className="live-trade-toast pointer-events-auto relative flex w-[300px] items-center gap-[10px] overflow-hidden rounded-[12px] border py-[9px] pl-[11px] pr-[9px]" role="status"
    style={{ borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.10)', background: isDark ? 'rgba(22,26,36,0.96)' : 'rgba(255,255,255,0.97)', boxShadow: '0 14px 30px -16px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.08)' }}>
    <span className="dj-beacon" aria-hidden><b>🚨</b></span>
    <div className="min-w-0 flex-1">
      <div className={`flex items-center gap-2 text-[18px] font-semibold tracking-[-0.02em] ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
        <RollingPrice price={toast.alertBeacon!.price} />
        <span className="ml-auto text-[10px] font-normal tracking-normal text-slate-500">{time(toast.at)}</span>
        <button type="button" onClick={onClose} aria-label="Zavřít" className="px-0.5 text-[13px] leading-none text-slate-500">×</button>
      </div>
      <div className="truncate text-[10.5px] text-slate-500">{toast.title}</div>
      {toast.line && <div className={`truncate text-[12px] ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{toast.line}</div>}
    </div>
    <span aria-hidden className="dj-alert-time absolute inset-x-0 bottom-0 h-[2px]" style={{ background: toast.alertColor ?? '#f5b53d', animationDuration: `${toast.ms ?? TRADE_TOAST_MS}ms` }} />
  </div>
);

const ToastCard: React.FC<{ toast: TradeToast; isDark: boolean; copierArmed: boolean; onDismiss: (id: string) => void }> = ({ toast, isDark, copierArmed, onDismiss }) => {
  const onClose = useCallback(() => onDismiss(toast.id), [onDismiss, toast.id]);
  const color = toast.alertColor ?? TONE[toast.tone];
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (toast.sticky || hovered) return undefined;
    const timer = window.setTimeout(onClose, toast.ms ?? TRADE_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [hovered, onClose, toast.ms, toast.sticky]);
  if (toast.alertBeacon) return <BeaconToast toast={toast} isDark={isDark} onClose={onClose} />;
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
      {toast.alertColor && <span aria-hidden className="dj-alert-time absolute inset-x-0 bottom-0 h-[2px]" style={{ background: color, animationDuration: `${toast.ms ?? TRADE_TOAST_MS}ms`, animationPlayState: hovered ? 'paused' : 'running' }} />}
      <div className="flex min-w-0 items-center gap-[7px]">
        {toast.alertColor && <span aria-hidden className="dj-alert-ring shrink-0" style={{ color }}><Bell size={13} strokeWidth={2.4} /></span>}
        {/* Upozornění: štítek nahrazuje zvoneček, titulek s cenou se musí vejít. */}
        {!toast.alertColor && <span className="shrink-0 rounded-[4px] px-[5px] py-[2px] text-[8.5px] font-black uppercase tracking-[0.08em] text-white" style={{ background: color }}>{toast.badge}</span>}
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

const LiveTradeToasts: React.FC<{
  events: readonly CopierCopyEvent[] | undefined;
  copierArmed: boolean;
  isDark: boolean;
  /** Telefon: vlastní umístění (nad obchodní lištou); jinak vlevo dole v grafu PC. */
  placement?: React.CSSProperties;
  /** Karty, které nevznikly z událostí kopírky (upozornění na cenu, posun upozornění). */
  extra?: readonly TradeToast[];
  /** LIVE: `extra` jsou upozornění, strop 2 karty (`capExtraToasts`). Backtest jimi posílá vše, bez stropu. */
  capExtra?: boolean;
}> = ({ events, copierArmed, isDark, placement, extra, capExtra = false }) => {
  const [toasts, setToasts] = useState<TradeToast[]>([]);
  const extraSeenRef = useRef(new Set<string>());
  useEffect(() => {
    const fresh = (extra ?? []).filter(toast => !extraSeenRef.current.has(toast.id));
    if (!fresh.length) return;
    for (const toast of fresh) extraSeenRef.current.add(toast.id);
    setToasts(current => {
      const all = [...current, ...fresh];
      return keepStickyToasts(capExtra ? capExtraToasts(all, toast => extraSeenRef.current.has(toast.id)) : all);
    });
  }, [capExtra, extra]);
  const seenRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!events) return;
    // První načtení = staré události (bez hodin prohlížeče vs. workeru): jen si je zapamatovat.
    if (!seenRef.current) { seenRef.current = new Set(events.map(event => event.id)); return; }
    const fresh = newCopyEvents(events, seenRef.current);
    if (fresh.length === 0) return;
    for (const event of fresh) seenRef.current.add(event.id);
    const added = fresh.map(copyEventToast).filter((toast): toast is TradeToast => toast != null);
    if (added.length) setToasts(current => keepStickyToasts([...current, ...added]));
  }, [events]);
  // Stabilní: časovač karty se nesmí restartovat s každým pollem statusu.
  const dismiss = useCallback((id: string) => setToasts(current => current.filter(item => item.id !== id)), []);
  if (toasts.length === 0) return null;
  return (
    <div className={`pointer-events-none absolute ${placement ? '' : 'bottom-9 left-2 '}z-[640] flex flex-col gap-2`} style={placement} aria-live="polite">
      {toasts.map(toast => (
        <ToastCard key={toast.id} toast={toast} isDark={isDark} copierArmed={copierArmed} onDismiss={dismiss} />
      ))}
    </div>
  );
};

export default LiveTradeToasts;
