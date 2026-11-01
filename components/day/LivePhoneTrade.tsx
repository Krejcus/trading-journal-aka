import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownUp, GripVertical, X } from 'lucide-react';
import { LIVE_QTY_PRESETS, pressQtyKey, qtyFromBuffer, type LivePillPrefs } from '../../lib/livePhoneTrade';
import { playNativeHapticIfAvailable } from '../../services/nativeCapabilities';

export type LiveTradeSide = 'buy' | 'sell';

const PILL_HEIGHT = 48;
// Aurora: sytá skleněná tlačítka s jemnou září.
const SELL_FILL: React.CSSProperties = { background: 'linear-gradient(180deg, rgba(255,92,108,.95), rgba(222,52,70,.92))', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.35), 0 8px 18px -10px rgba(239,70,85,.9)' };
const BUY_FILL: React.CSSProperties = { background: 'linear-gradient(180deg, rgba(88,136,255,.95), rgba(40,96,240,.92))', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.35), 0 8px 18px -10px rgba(47,107,255,.9)' };
const BUY = '#2f6bff';

export const formatLivePrice = (price: number | null) => (
  price == null || !Number.isFinite(price) ? '—' : price.toFixed(2)
);

/**
 * Obchodní lišta nad grafem jako v TradingView: [⋮⋮][PRODAT][množství][KOUPIT].
 * Za mřížku jde posunout (poloha se pamatuje), ⇅ ve spodní liště ji schová.
 * Jen zobrazení: Prodat / Koupit volají `onSide` a sama nic neodesílá.
 */
export function LiveTradePill({ prefs, onPrefs, bid, ask, onQty, onSide }: {
  prefs: LivePillPrefs;
  onPrefs: (next: LivePillPrefs) => void;
  bid: number | null;
  ask: number | null;
  onQty: () => void;
  onSide: (side: LiveTradeSide) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startY: number; x: number; y: number; spanX: number; spanY: number } | null>(null);
  const [pos, setPos] = useState({ x: prefs.x, y: prefs.y });
  const [dragging, setDragging] = useState(false);
  useEffect(() => { if (!drag.current) setPos({ x: prefs.x, y: prefs.y }); }, [prefs.x, prefs.y]);
  // Šířka lišty pro výpočet polohy (ceny mění šířku tlačítek).
  useLayoutEffect(() => { const el = ref.current; if (el) el.style.setProperty('--pill-w', `${el.offsetWidth}px`); });

  const spread = bid != null && ask != null && ask > bid ? ask - bid : null;
  const side = (kind: LiveTradeSide, price: number | null) => (
    <button
      type="button"
      className="dj-btn dj-pill-side"
      aria-label={kind === 'sell' ? 'Prodat market' : 'Koupit market'}
      onClick={() => { playNativeHapticIfAvailable('medium'); onSide(kind); }}
      style={{ minWidth: 92, padding: '5px 10px', border: 0, borderRadius: 9, cursor: 'pointer', color: '#fff', textAlign: 'center', lineHeight: 1.1, ...(kind === 'sell' ? SELL_FILL : BUY_FILL) }}
    >
      <small style={{ display: 'block', fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', opacity: 0.82 }}>{kind === 'sell' ? 'PRODAT' : 'KOUPIT'}</small>
      <span className="dj-mono" style={{ fontSize: 14, fontWeight: 700 }}>{formatLivePrice(price)}</span>
    </button>
  );

  return (
    <div
      ref={ref}
      role="group"
      aria-label="Rychlý obchod"
      aria-hidden={!prefs.on}
      style={{
        position: 'absolute', zIndex: 23, height: PILL_HEIGHT, boxSizing: 'border-box',
        left: `calc(6px + (100% - var(--pill-w, 280px) - 12px) * ${pos.x})`,
        top: `calc(6px + (100% - ${PILL_HEIGHT}px - 34px) * ${pos.y})`,
        display: 'flex', alignItems: 'stretch', padding: 3, borderRadius: 12,
        border: `1px solid ${dragging ? 'rgba(157,183,255,.6)' : 'var(--dj-line)'}`,
        background: 'var(--dj-glass, rgba(13,18,27,.92))',
        backdropFilter: 'blur(24px) saturate(180%)', WebkitBackdropFilter: 'blur(24px) saturate(180%)',
        boxShadow: '0 14px 34px -16px rgba(0,0,0,.75)',
        opacity: prefs.on ? 1 : 0,
        pointerEvents: prefs.on ? 'auto' : 'none',
        transform: !prefs.on ? 'translateY(14px) scale(.96)' : dragging ? 'scale(1.04)' : 'none',
        transition: dragging ? 'transform .15s cubic-bezier(.2,.9,.25,1)' : 'transform .32s cubic-bezier(.2,.9,.25,1), opacity .22s ease',
      }}
    >
      <span
        aria-label="Přesunout lištu"
        onPointerDown={event => {
          const area = ref.current?.offsetParent as HTMLElement | null;
          const width = ref.current?.offsetWidth ?? 0;
          drag.current = { startX: event.clientX, startY: event.clientY, x: pos.x, y: pos.y, spanX: Math.max(1, (area?.clientWidth ?? 0) - width - 12), spanY: Math.max(1, (area?.clientHeight ?? 0) - PILL_HEIGHT - 40) };
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* syntetická událost */ }
          setDragging(true);
          playNativeHapticIfAvailable('light');
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerMove={event => {
          const current = drag.current;
          if (!current) return;
          const clamp = (value: number) => Math.min(1, Math.max(0, value));
          setPos({ x: clamp(current.x + (event.clientX - current.startX) / current.spanX), y: clamp(current.y + (event.clientY - current.startY) / current.spanY) });
        }}
        onPointerUp={() => {
          if (!drag.current) return;
          drag.current = null;
          setDragging(false);
          onPrefs({ ...prefs, x: pos.x, y: pos.y });
        }}
        onPointerCancel={() => { drag.current = null; setDragging(false); setPos({ x: prefs.x, y: prefs.y }); }}
        style={{ width: 24, display: 'grid', placeItems: 'center', color: dragging ? '#9db7ff' : 'var(--dj-muted)', cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
      ><GripVertical size={16} /></span>
      {side('sell', bid)}
      <button type="button" className="dj-btn" aria-label={`Počet kontraktů ${prefs.qty}`} onClick={onQty} style={{ width: 54, border: 0, background: 'transparent', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--dj-muted)', fontSize: 10, lineHeight: 1.15 }}>
        <span className="dj-mono">{spread != null ? spread.toFixed(2) : 'ks'}</span>
        <b className="dj-mono" style={{ fontSize: 15, color: 'var(--dj-text)' }}>{prefs.qty}</b>
      </button>
      {side('buy', ask)}
    </div>
  );
}

/** ⇅ ve spodní liště grafu: schová / ukáže obchodní lištu. */
export function LiveTradeToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="dj-btn"
      aria-label={on ? 'Skrýt obchodní lištu' : 'Zobrazit obchodní lištu'}
      aria-pressed={on}
      onClick={() => { playNativeHapticIfAvailable('selection'); onToggle(); }}
      style={{ width: 40, height: 40, borderRadius: 11, border: 0, padding: 0, flex: 'none', display: 'grid', placeItems: 'center', cursor: 'pointer', color: on ? 'var(--dj-indigo-text)' : 'var(--dj-text-2)', background: on ? 'var(--dj-indigo-bg-soft)' : 'transparent' }}
    ><ArrowDownUp size={18} /></button>
  );
}

/** Spodní list s klávesnicí: počet kontraktů pro obchodní lištu. */
export function LiveQtySheet({ value, onDone, onClose }: { value: number; onDone: (qty: number) => void; onClose: () => void }) {
  const [buffer, setBuffer] = useState(String(value));
  const key: React.CSSProperties = { height: 46, borderRadius: 10, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-text)', fontSize: 20, fontWeight: 600, cursor: 'pointer' };
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 46 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', animation: 'dj-fade .18s ease both' }} />
      <section aria-label="Počet kontraktů" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: '20px 20px 0 0', background: 'var(--dj-sheet, var(--dj-card))', borderTop: '1px solid var(--dj-line)', padding: '8px 16px calc(16px + var(--dj-safe-bottom, env(safe-area-inset-bottom, 0px)))', animation: 'dj-sheet .26s cubic-bezier(.2,.9,.25,1) both' }}>
        <div aria-hidden="true" style={{ display: 'grid', placeItems: 'center', padding: '0 0 6px' }}><span style={{ width: 38, height: 5, borderRadius: 3, background: 'var(--dj-line)', filter: 'brightness(2.2)' }} /></div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <p style={{ margin: 0, flex: 1, fontSize: 16, fontWeight: 800 }}>Počet kontraktů</p>
          <button type="button" className="dj-btn" aria-label="Zavřít" onClick={onClose} style={{ width: 30, height: 30, borderRadius: 15, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-muted)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={16} /></button>
        </div>
        <div className="dj-mono" aria-live="polite" style={{ height: 48, borderRadius: 12, border: `1px solid ${BUY}`, background: 'var(--dj-chip)', display: 'grid', placeItems: 'center', fontSize: 24, fontWeight: 700 }}>{buffer || '0'}</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          {LIVE_QTY_PRESETS.map(preset => (
            <button key={preset} type="button" className="dj-btn" onClick={() => { playNativeHapticIfAvailable('selection'); setBuffer(String(preset)); }} style={{ flex: 1, height: 34, borderRadius: 9, cursor: 'pointer', border: `1px solid ${buffer === String(preset) ? 'rgba(129,140,248,.6)' : 'var(--dj-line)'}`, background: buffer === String(preset) ? 'var(--dj-indigo-bg-soft)' : 'transparent', color: 'var(--dj-text)', font: '700 13px Inter, sans-serif' }}>{preset}</button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 10 }}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((label, index) => (
            label
              ? <button key={label} type="button" className="dj-btn" aria-label={label === '⌫' ? 'Smazat číslici' : label} onClick={() => { playNativeHapticIfAvailable('selection'); setBuffer(current => pressQtyKey(current, label)); }} style={key}>{label}</button>
              : <span key={`gap${index}`} />
          ))}
        </div>
        <button type="button" className="dj-btn" onClick={() => onDone(qtyFromBuffer(buffer))} style={{ width: '100%', height: 46, marginTop: 12, borderRadius: 12, border: 0, cursor: 'pointer', color: '#fff', background: 'linear-gradient(180deg,#6366f1,#4f46e5)', font: '800 15px Inter, sans-serif' }}>Hotovo</button>
      </section>
    </div>
  );
}

/** Krátké oznámení nahoře v grafu (zmizí samo). */
export function LiveChartNotice({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const id = window.setTimeout(onDone, 2600);
    return () => window.clearTimeout(id);
  }, [onDone, text]);
  return (
    <div role="status" style={{ position: 'absolute', top: 46, left: '50%', zIndex: 30, maxWidth: 'calc(100% - 32px)', padding: '8px 12px', borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-glass, rgba(13,18,27,.94))', backdropFilter: 'blur(24px) saturate(180%)', WebkitBackdropFilter: 'blur(24px) saturate(180%)', boxShadow: '0 14px 34px -16px rgba(0,0,0,.75)', fontSize: 12.5, fontWeight: 600, lineHeight: 1.35, textAlign: 'center', pointerEvents: 'none', animation: 'dj-saved 2.6s ease both' }}>
      {text}
    </div>
  );
}
