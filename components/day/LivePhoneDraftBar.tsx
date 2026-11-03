import React from 'react';
import { Pencil, X } from 'lucide-react';
import { ticketMetrics, type TicketDraft, type TicketInstrument, type TicketQuote } from '../../lib/liveOrderTicket';
import { playNativeHapticIfAvailable } from '../../services/nativeCapabilities';
import { livePhoneSheetProblems, livePhoneSheetSubmitDraft, type LivePhoneSheetTrade } from './LivePhoneOrderSheet';

const SELL = '#ef4655';
const BUY = '#2f6bff';
const LOSS = '#ff8c95';

const price = (value: number) => value.toFixed(2);

/**
 * Text lišty návrhu: „BUY 2 LMT @ 25000.00 · SL 24988.00 · TP 25024.00 · −$48“.
 * Riziko je ztráta při SL na leaderovi; u Marketu jen odhad z ceny grafu (INV-UI-04).
 */
export function livePhoneDraftText(draft: TicketDraft, instrument: TicketInstrument, quote: TicketQuote): string {
  const m = ticketMetrics(draft, instrument, quote);
  const type = draft.type === 'market' ? 'MKT' : draft.type === 'limit' ? 'LMT' : 'STP';
  const at = draft.type === 'market' ? `~${price(m.entry)}` : `@ ${price(m.entry)}`;
  const legs = draft.stopLoss == null && draft.takeProfit == null
    ? 'bez SL/TP'
    : [draft.stopLoss != null ? `SL ${price(draft.stopLoss)}` : 'bez SL', draft.takeProfit != null ? `TP ${price(draft.takeProfit)}` : 'bez TP'].join(' · ');
  const risk = m.stopLossUsd != null && m.quantity >= 1 ? ` · ${draft.type === 'market' ? '≈ ' : ''}−$${Math.round(Math.abs(m.stopLossUsd))}` : '';
  return `${draft.side === 'buy' ? 'BUY' : 'SELL'} ${m.quantity} ${type} ${at} · ${legs}${risk}`;
}

/**
 * Lišta návrhu nad obchodní lištou (U2, 3. 11. 2026): po „Upravit v grafu“ se list
 * stáhne sem a návrh se dolaďuje tažením čar v grafu. [Odeslat] je STEJNÁ cesta jako
 * tlačítko listu — volá jen `onSubmit` rodiče (`submitSheetDraft` v `LivePhoneChart`)
 * se zobrazeným N; sama nic neodesílá a k deskovým callbackům nemá přístup (INV-UI-01).
 * Jedno klepnutí jako v listu; × jen zahodí návrh (u brokera nic není).
 */
export default function LivePhoneDraftBar({ draft, instrument, quote, trade = null, busy = false, bottom = 62, onSubmit, onEdit, onDiscard }: {
  draft: TicketDraft;
  instrument: TicketInstrument;
  /** Orientační cena z grafu (stejná jako pro list). */
  quote: TicketQuote;
  /** Brány desku a strop (jako list); null = jen výpočet návrhu. */
  trade?: LivePhoneSheetTrade | null;
  /** Rodič právě odesílá (sdílený zámek listu / lišty) — Odeslat je vypnuté. */
  busy?: boolean;
  /** Vzdálenost od spodku vrstvy grafu (nad obchodní lištou). */
  bottom?: number | string;
  /** Odeslání rodičem: dostane návrh s velikostí v kontraktech (`livePhoneSheetSubmitDraft`). */
  onSubmit: (draft: TicketDraft) => void;
  /** Zpět do listu s tímto návrhem. */
  onEdit: () => void;
  /** Zahodit návrh (čáry návrhu zmizí; u brokera nic). */
  onDiscard: () => void;
}) {
  const problems = livePhoneSheetProblems(draft, instrument, quote, trade);
  const error = problems.find(problem => problem.level === 'error') ?? null;
  const reason = trade?.blockedReason ?? error?.text ?? null;
  const disabled = busy || reason != null;
  const sell = draft.side === 'sell';
  const icon: React.CSSProperties = { width: 36, height: 36, borderRadius: 10, border: '1px solid var(--dj-line)', background: 'transparent', color: 'var(--dj-text)', display: 'grid', placeItems: 'center', cursor: 'pointer', flex: 'none' };
  return (
    <div
      role="group"
      aria-label="Návrh objednávky"
      style={{ position: 'absolute', zIndex: 25, left: 8, right: 8, bottom, pointerEvents: 'auto', display: 'grid', gap: 4, padding: 6, borderRadius: 12, border: `1px solid ${sell ? 'rgba(239,70,85,.55)' : 'rgba(47,107,255,.55)'}`, background: 'var(--dj-glass, rgba(13,18,27,.94))', boxShadow: '0 14px 34px -16px rgba(0,0,0,.75)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="dj-mono" style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, lineHeight: 1.3, color: 'var(--dj-text)' }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.06em', color: 'var(--dj-muted)', marginRight: 6 }}>NÁVRH</span>
          {livePhoneDraftText(draft, instrument, quote)}
        </span>
        <button type="button" className="dj-btn" aria-label="Zahodit návrh" onClick={() => { playNativeHapticIfAvailable('selection'); onDiscard(); }} style={icon}><X size={16} /></button>
        <button type="button" className="dj-btn" aria-label="Upravit v listu" onClick={() => { playNativeHapticIfAvailable('selection'); onEdit(); }} style={icon}><Pencil size={15} /></button>
        <button
          type="button"
          className="dj-btn"
          disabled={disabled}
          onClick={() => { playNativeHapticIfAvailable('medium'); onSubmit(livePhoneSheetSubmitDraft(draft, instrument, quote)); }}
          style={{ height: 36, padding: '0 12px', borderRadius: 10, border: 0, flex: 'none', color: '#fff', background: sell ? SELL : BUY, opacity: disabled ? 0.4 : 1, cursor: disabled ? 'not-allowed' : 'pointer', font: '800 13px Inter, sans-serif' }}
        >{busy ? 'Odesílám…' : 'Odeslat'}</button>
      </div>
      {reason && <p role="status" style={{ margin: 0, padding: '0 2px', fontSize: 11.5, fontWeight: 600, color: trade?.blockedReason ? 'var(--dj-amber-text)' : LOSS }}>{reason}</p>}
    </div>
  );
}
