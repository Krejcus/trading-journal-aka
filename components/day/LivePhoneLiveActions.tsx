import React, { useState } from 'react';
import { X } from 'lucide-react';
import { snapToTick } from '../../lib/liveOrderTicket';
import { playNativeHapticIfAvailable } from '../../services/nativeCapabilities';
import SheetGrip from './SheetGrip';

const SELL = '#ef4655';
const BUY = '#2f6bff';

/**
 * Pozice leadera nad telefonním grafem (2. 11. 2026): strana, počet, varování
 * „bez SL/TP“ u holého Marketu, doplnění nohou a zavření Flattenem (jediný DEMO
 * účet manual-only skupiny). Zavření je dvoukrokové (druhé klepnutí do 4 s).
 */
export function LivePhonePositionBar({ side, quantity, symbol, unprotected, busy, onAttach, onClose }: {
  side: 'long' | 'short';
  quantity: number;
  symbol: string;
  unprotected: boolean;
  busy: boolean;
  onAttach: () => void;
  onClose: () => void;
}) {
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const confirming = armedAt != null && Date.now() - armedAt < 4_000;
  const chip: React.CSSProperties = { height: 30, padding: '0 10px', borderRadius: 9, border: 0, cursor: 'pointer', font: '800 12px Inter, sans-serif', color: '#fff' };
  return (
    <div role="group" aria-label="Pozice" style={{ position: 'absolute', zIndex: 24, top: 8, left: 8, right: 8, display: 'flex', alignItems: 'center', gap: 6, padding: 6, borderRadius: 12, border: `1px solid ${unprotected ? 'rgba(239,70,85,.7)' : 'var(--dj-line)'}`, background: 'var(--dj-glass, rgba(13,18,27,.94))', boxShadow: '0 14px 34px -16px rgba(0,0,0,.75)' }}>
      <span className="dj-mono" style={{ fontWeight: 800, fontSize: 13, color: side === 'long' ? BUY : SELL }}>{side === 'long' ? 'LONG' : 'SHORT'} {quantity}</span>
      <span className="dj-mono" style={{ fontSize: 11, color: 'var(--dj-muted)' }}>{symbol}</span>
      {unprotected && <span style={{ fontSize: 11, fontWeight: 800, color: SELL }}>BEZ SL/TP</span>}
      <span style={{ flex: 1 }} />
      {unprotected && <button type="button" className="dj-btn" disabled={busy} onClick={() => { playNativeHapticIfAvailable('selection'); onAttach(); }} style={{ ...chip, background: 'linear-gradient(180deg,#6366f1,#4f46e5)', opacity: busy ? 0.6 : 1 }}>Přidat SL/TP</button>}
      {/* Zavřít (Flatten) nikdy nečeká na rozpracovaný vstup/attach (INV-UI-02). */}
      <button
        type="button"
        className="dj-btn"
        aria-label={confirming ? 'Potvrdit zavření (Flatten)' : 'Zavřít pozici (Flatten)'}
        onClick={() => {
          playNativeHapticIfAvailable('medium');
          if (confirming) { setArmedAt(null); onClose(); } else setArmedAt(Date.now());
        }}
        style={{ ...chip, background: confirming ? SELL : 'var(--dj-chip)', color: confirming ? '#fff' : 'var(--dj-text)' }}
      >{confirming ? 'Opravdu zavřít?' : 'Zavřít'}</button>
    </div>
  );
}

/** Doplnění SL + TP k holému Marketu: ceny v bodech od trhu, odeslání tlačítkem. */
export function LivePhoneAttachSheet({ side, market, tickSize, onSubmit, onClose }: {
  side: 'long' | 'short';
  market: number;
  tickSize: number;
  onSubmit: (stopLoss: number, takeProfit: number) => void;
  onClose: () => void;
}) {
  const d = side === 'long' ? 1 : -1;
  const [stop, setStop] = useState(snapToTick(market - d * 10, tickSize).toFixed(2));
  const [target, setTarget] = useState(snapToTick(market + d * 20, tickSize).toFixed(2));
  const parse = (text: string) => { const value = Number.parseFloat(text.replace(',', '.')); return Number.isFinite(value) ? snapToTick(value, tickSize) : null; };
  const sl = parse(stop);
  const tp = parse(target);
  const valid = sl != null && tp != null && (side === 'long' ? sl < market && tp > market : sl > market && tp < market);
  const field: React.CSSProperties = { width: '100%', height: 44, borderRadius: 10, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', color: 'var(--dj-text)', font: '700 18px ui-monospace, monospace', textAlign: 'center' };
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 46 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }} />
      <section aria-label="Přidat SL a TP" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: '20px 20px 0 0', background: 'var(--dj-sheet, var(--dj-card))', borderTop: '1px solid var(--dj-line)', padding: '8px 16px calc(16px + var(--dj-safe-bottom, env(safe-area-inset-bottom, 0px)))' }}>
        <SheetGrip onClose={onClose} gap={6} />
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <p style={{ margin: 0, flex: 1, fontSize: 16, fontWeight: 800 }}>Přidat SL a TP · trh {market.toFixed(2)}</p>
          <button type="button" className="dj-btn" aria-label="Zavřít" onClick={onClose} style={{ width: 30, height: 30, borderRadius: 15, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-muted)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={16} /></button>
        </div>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 800, color: SELL, marginBottom: 4 }}>STOP LOSS</label>
        <input aria-label="Stop loss" inputMode="decimal" value={stop} onChange={event => setStop(event.target.value)} style={field} />
        <label style={{ display: 'block', fontSize: 11, fontWeight: 800, color: '#34d399', margin: '10px 0 4px' }}>TAKE PROFIT</label>
        <input aria-label="Take profit" inputMode="decimal" value={target} onChange={event => setTarget(event.target.value)} style={field} />
        <button type="button" className="dj-btn" disabled={!valid} onClick={() => { if (valid) onSubmit(sl!, tp!); }} style={{ width: '100%', height: 46, marginTop: 12, borderRadius: 12, border: 0, cursor: valid ? 'pointer' : 'not-allowed', opacity: valid ? 1 : 0.5, color: '#fff', background: 'linear-gradient(180deg,#6366f1,#4f46e5)', font: '800 15px Inter, sans-serif' }}>Odeslat SL + TP</button>
      </section>
    </div>
  );
}
