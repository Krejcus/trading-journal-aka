import React from 'react';
import { ChevronLeft } from 'lucide-react';
import { playNativeHapticIfAvailable } from '../../services/nativeCapabilities';

const BUY = '#2f6bff';
const SELL = '#ef4655';
const GAIN = '#34d399';
const LOSS = '#ff8c95';

/** Živá pozice pro štítek přehrávání — z read modelu brokera (lišta pozice), jen zobrazení. */
export interface LivePhoneReplayLivePosition {
  side: 'long' | 'short';
  quantity: number;
  /** Jen čekající vstup (pozice zatím není). */
  pending: boolean;
}

/** P&L z brokera pro štítek: „+$12.50“ / „−$4.00“; neznámé = null (nic se nedopočítává). */
export function livePhoneReplayPnlText(pnl: number | null | undefined): string | null {
  if (pnl == null || !Number.isFinite(pnl)) return null;
  return `${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)}`;
}

/** Text o živém stavu během přehrávání: „živě LONG 2“, „živě ČEKÁ BUY 1“, „živě bez pozice“. */
export function livePhoneReplayLiveText(position: LivePhoneReplayLivePosition | null): string {
  if (!position) return 'živě bez pozice';
  if (position.pending) return `živě ČEKÁ ${position.side === 'long' ? 'BUY' : 'SELL'} ${position.quantity}`;
  return `živě ${position.side === 'long' ? 'LONG' : 'SHORT'} ${position.quantity}`;
}

/**
 * Štítek „PŘEHRÁVÁNÍ · živě LONG 2 · P&L (z brokera) · ‹ Zpět na živo“ (U3, 3. 11. 2026).
 * Během přehrávání graf ukazuje historii, proto se v něm neobchoduje: lišta Koupit/Prodat,
 * plusko, čáry a návrh jsou schované a štítek připomíná živý stav z read modelu brokera.
 * Jen zobrazení — jediné tlačítko přehrávání ukončí, nic neodesílá (INV-UI-01, INV-UI-04).
 * Lišta pozice (Zavřít, Přidat SL/TP) zůstává, protože snižuje riziko (INV-UI-02).
 */
export default function LivePhoneReplayLiveChip({ position, pnl, top = 8, onExit }: {
  position: LivePhoneReplayLivePosition | null;
  /** Otevřený P&L skupiny z brokera; null = neznámý (nic se neukáže). */
  pnl: number | null;
  /** Odsazení shora (pod lištou pozice, je-li vidět). */
  top?: number;
  onExit: () => void;
}) {
  const pnlText = position && !position.pending ? livePhoneReplayPnlText(pnl) : null;
  const sideColor = position ? (position.side === 'long' ? BUY : SELL) : 'var(--dj-muted)';
  return (
    <div
      role="status"
      aria-label="Přehrávání — obchoduj v živém grafu"
      style={{ position: 'absolute', zIndex: 25, top, left: '50%', transform: 'translateX(-50%)', maxWidth: 'calc(100% - 16px)', boxSizing: 'border-box', pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 4px 4px 10px', borderRadius: 12, border: '1px solid rgba(245,181,61,.55)', background: 'var(--dj-glass, rgba(13,18,27,.94))', boxShadow: '0 14px 34px -16px rgba(0,0,0,.75)', whiteSpace: 'nowrap' }}
    >
      <span style={{ display: 'grid', minWidth: 0, lineHeight: 1.2 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 11.5, fontWeight: 700 }}>
          <b style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.08em', color: 'var(--dj-amber-text, #f5b53d)' }}>PŘEHRÁVÁNÍ</b>
          <span className="dj-mono" style={{ color: sideColor, overflow: 'hidden', textOverflow: 'ellipsis' }}>{livePhoneReplayLiveText(position)}</span>
          {pnlText && <span className="dj-mono" style={{ color: (pnl ?? 0) >= 0 ? GAIN : LOSS }}>{pnlText}</span>}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--dj-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>Obchoduj v živém grafu{pnlText ? ' · P&L z brokera' : ''}</span>
      </span>
      <button
        type="button"
        className="dj-btn"
        onClick={() => { playNativeHapticIfAvailable('selection'); onExit(); }}
        style={{ height: 32, padding: '0 10px 0 6px', borderRadius: 9, border: 0, flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 2, cursor: 'pointer', color: '#fff', background: 'linear-gradient(180deg,#6366f1,#4f46e5)', font: '800 12px Inter, sans-serif' }}
      ><ChevronLeft size={15} />Zpět na živo</button>
    </div>
  );
}
