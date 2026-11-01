import React, { useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import {
  snapToTick, ticketEntry, ticketMetrics, ticketProblems, withSide,
  type TicketDraft, type TicketInstrument, type TicketOrderType, type TicketQuote,
} from '../../lib/liveOrderTicket';
import { playNativeHapticIfAvailable } from '../../services/nativeCapabilities';

const SELL = '#ef4655';
const BUY = '#2f6bff';
const LOSS = '#ff8c95';
const GAIN = '#34d399';

const price = (value: number) => value.toFixed(2);
const money = (value: number) => `$${Math.round(Math.abs(value)).toLocaleString('cs-CZ')}`;
const parsePrice = (text: string): number | null => {
  const value = Number.parseFloat(text.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
};

/**
 * Objednávka z position toolu na telefonu (jako „Vytvořit limitní objednávku…“
 * v TradingView). Počítá stejně jako panel na PC (lib/liveOrderTicket.ts).
 * Jen návrh: tlačítko odeslání volá `onSubmit` a samo nic neodesílá.
 */
export default function LivePhoneOrderSheet({ initial, instrument, quote, onSubmit, onClose }: {
  initial: TicketDraft;
  instrument: TicketInstrument;
  /** Orientační cena z grafu (INV-UI-04: odeslání ji musí přepočítat u brokera). */
  quote: TicketQuote;
  onSubmit: (draft: TicketDraft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TicketDraft>(initial);
  // Vypnutý TP/SL si pamatuje poslední cenu, ať se po zapnutí vrátí.
  const [memo, setMemo] = useState({ tp: initial.takeProfit, sl: initial.stopLoss });
  const [text, setText] = useState({ price: price(initial.price), tp: initial.takeProfit == null ? '' : price(initial.takeProfit), sl: initial.stopLoss == null ? '' : price(initial.stopLoss), qty: String(initial.quantity) });

  const tick = instrument.tickSize;
  const m = ticketMetrics(draft, instrument, quote);
  const problems = ticketProblems(draft, instrument, quote, null);
  const blocked = problems.some(problem => problem.level === 'error');
  const sell = draft.side === 'sell';
  const market = draft.type === 'market';
  const ticks = (points: number | null) => (points == null ? null : Math.round(Math.abs(points) / tick));
  const slTicks = ticks(m.stopLossPoints);
  const tpTicks = ticks(m.takeProfitPoints);
  const reference = sell ? quote.bid : quote.ask;
  const relative = Math.round((m.entry - reference) / tick);

  const update = (next: TicketDraft) => setDraft(next);
  const setSide = (side: 'buy' | 'sell') => {
    if (side === draft.side) return;
    playNativeHapticIfAvailable('selection');
    const next = withSide(draft, side, quote, instrument);
    update(next);
    setText(current => ({ ...current, tp: next.takeProfit == null ? current.tp : price(next.takeProfit), sl: next.stopLoss == null ? current.sl : price(next.stopLoss) }));
  };
  const setType = (type: TicketOrderType) => { playNativeHapticIfAvailable('selection'); update({ ...draft, type }); };
  const setQty = (quantity: number) => { const qty = Math.max(1, Math.min(999, Math.floor(quantity))); update({ ...draft, quantity: qty }); setText(current => ({ ...current, qty: String(qty) })); };
  const editPrice = (field: 'price' | 'tp' | 'sl', value: string) => {
    setText(current => ({ ...current, [field]: value }));
    const parsed = parsePrice(value);
    if (parsed == null) return;
    const snapped = snapToTick(parsed, tick);
    if (field === 'price') update({ ...draft, price: snapped });
    else if (field === 'tp') { update({ ...draft, takeProfit: snapped }); setMemo(current => ({ ...current, tp: snapped })); }
    else { update({ ...draft, stopLoss: snapped }); setMemo(current => ({ ...current, sl: snapped })); }
  };
  const blurPrice = (field: 'price' | 'tp' | 'sl') => {
    const value = field === 'price' ? draft.price : field === 'tp' ? draft.takeProfit : draft.stopLoss;
    if (value != null) setText(current => ({ ...current, [field]: price(value) }));
  };
  const toggleExit = (field: 'tp' | 'sl') => {
    playNativeHapticIfAvailable('selection');
    const key = field === 'tp' ? 'takeProfit' : 'stopLoss';
    if (draft[key] != null) { update({ ...draft, [key]: null }); return; }
    const entry = ticketEntry(draft, quote);
    const d = sell ? -1 : 1;
    const fallback = snapToTick(field === 'tp' ? entry + d * 24 : entry - d * 12, tick);
    const restored = memo[field] ?? fallback;
    update({ ...draft, [key]: restored });
    setText(current => ({ ...current, [field]: price(restored) }));
  };

  const label: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '14px 2px 6px', fontSize: 12, fontWeight: 700, color: 'var(--dj-muted)' };
  const box = (bad: boolean, dim = false): React.CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 8, height: 46, padding: '0 12px', borderRadius: 12, border: `1px solid ${bad ? 'rgba(239,70,85,.7)' : 'var(--dj-line)'}`, background: 'var(--dj-chip)', opacity: dim ? 0.45 : 1 });
  const input: React.CSSProperties = { flex: 1, minWidth: 0, height: '100%', border: 0, outline: 0, background: 'transparent', color: 'var(--dj-text)', font: '600 16px "JetBrains Mono", ui-monospace, monospace' };
  const row = (name: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderTop: '1px solid var(--dj-line)', fontSize: 13 }}>
      <span style={{ color: 'var(--dj-muted)' }}>{name}</span><b className="dj-mono" style={{ fontSize: 13 }}>{value}</b>
    </div>
  );
  const switchButton = (on: boolean, onClick: () => void, name: string) => (
    <button type="button" role="switch" aria-checked={on} aria-label={name} className="dj-btn" onClick={onClick} style={{ width: 46, height: 28, borderRadius: 99, padding: 3, boxSizing: 'border-box', border: '1px solid var(--dj-line)', cursor: 'pointer', background: on ? 'linear-gradient(180deg,#6366f1,#4f46e5)' : 'var(--dj-chip)', display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start' }}>
      <span style={{ width: 20, height: 20, borderRadius: 99, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
    </button>
  );
  const exitProblem = (which: 'Take' | 'Stop') => problems.some(problem => problem.level === 'error' && problem.text.startsWith(which));
  const priceProblem = problems.some(problem => /^(Limit|Stop je)/.test(problem.text));

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 46 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', animation: 'dj-fade .18s ease both' }} />
      <section aria-label="Objednávka" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: 'calc(env(safe-area-inset-top, 0px) + 36px)', display: 'flex', flexDirection: 'column', borderRadius: '20px 20px 0 0', background: 'var(--dj-sheet, var(--dj-card))', borderTop: '1px solid var(--dj-line)', animation: 'dj-sheet .28s cubic-bezier(.2,.9,.25,1) both' }}>
        <div aria-hidden="true" style={{ display: 'grid', placeItems: 'center', padding: '8px 0 4px' }}><span style={{ width: 38, height: 5, borderRadius: 3, background: 'var(--dj-line)', filter: 'brightness(2.2)' }} /></div>
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 16px 8px' }}>
          <p style={{ margin: 0, flex: 1, fontSize: 16, fontWeight: 800 }}>{instrument.symbol} · objednávka</p>
          <button type="button" className="dj-btn" aria-label="Zavřít" onClick={onClose} style={{ width: 30, height: 30, borderRadius: 15, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-muted)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={16} /></button>
        </div>
        <div className="dj-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '0 16px 12px' }}>
          {/* Riziko a cíl v USD hned nahoře. */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)' }}>
              <span style={{ fontSize: 11.5, color: 'var(--dj-muted)', fontWeight: 700 }}>Riziko</span>
              <b className="dj-mono" style={{ display: 'block', fontSize: 18, color: LOSS }}>{m.stopLossUsd != null ? `−${money(m.stopLossUsd)}` : 'bez SL'}</b>
              <span className="dj-mono" style={{ fontSize: 11.5, color: 'var(--dj-muted)' }}>{slTicks != null ? `${slTicks} t` : '—'}</span>
            </div>
            <div style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', textAlign: 'right' }}>
              <span style={{ fontSize: 11.5, color: 'var(--dj-muted)', fontWeight: 700 }}>Cíl</span>
              <b className="dj-mono" style={{ display: 'block', fontSize: 18, color: GAIN }}>{m.takeProfitUsd != null ? `+${money(m.takeProfitUsd)}` : 'bez TP'}</b>
              <span className="dj-mono" style={{ fontSize: 11.5, color: 'var(--dj-muted)' }}>{tpTicks != null ? `${tpTicks} t` : '—'}</span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 6, marginTop: 12 }}>
            {(['sell', 'buy'] as const).map((side, index) => {
              const on = draft.side === side;
              const color = side === 'sell' ? SELL : BUY;
              const button = (
                <button key={side} type="button" className="dj-btn" aria-pressed={on} onClick={() => setSide(side)} style={{ height: 50, borderRadius: 12, cursor: 'pointer', border: `1px solid ${on ? color : 'var(--dj-line)'}`, background: on ? color : 'transparent', color: on ? '#fff' : 'var(--dj-text-2)', font: '800 14px Inter, sans-serif', lineHeight: 1.15 }}>
                  {side === 'sell' ? 'Prodat' : 'Koupit'}
                  <span className="dj-mono" style={{ display: 'block', fontSize: 12, fontWeight: 600, opacity: 0.85 }}>{price(side === 'sell' ? quote.bid : quote.ask)}</span>
                </button>
              );
              // Spread až s bid/ask ze streamu; z ceny svíčky by byl vždy 0.
              return index === 0 ? [button, <span key="spread" className="dj-mono" style={{ fontSize: 11, color: 'var(--dj-muted)' }}>{quote.ask > quote.bid ? (quote.ask - quote.bid).toFixed(2) : ''}</span>] : button;
            })}
          </div>

          <div role="radiogroup" aria-label="Typ příkazu" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, padding: 4, marginTop: 12, borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)' }}>
            {(['market', 'limit', 'stop'] as const).map(type => (
              <button key={type} type="button" role="radio" aria-checked={draft.type === type} className="dj-btn" onClick={() => setType(type)} style={{ height: 34, borderRadius: 9, border: 0, cursor: 'pointer', font: '700 12.5px Inter, sans-serif', background: draft.type === type ? 'var(--dj-seg-on)' : 'transparent', color: draft.type === type ? 'var(--dj-seg-on-ink)' : 'var(--dj-muted)' }}>{type === 'market' ? 'Market' : type === 'limit' ? 'Limit' : 'Stop'}</button>
            ))}
          </div>

          <div style={label}><span>Cena</span><span>{market ? 'market vezme aktuální cenu' : draft.type === 'limit' ? 'limitní vstup' : 'stop vstup'}</span></div>
          <div style={box(priceProblem)}>
            <input aria-label="Cena" inputMode="decimal" disabled={market} value={market ? `Trh · ${price(m.entry)}` : text.price} onChange={event => editPrice('price', event.target.value)} onBlur={() => blurPrice('price')} style={input} />
            {!market && <span className="dj-mono" style={{ fontSize: 12, color: 'var(--dj-muted)', whiteSpace: 'nowrap' }}>{sell ? 'Bid' : 'Ask'} {relative >= 0 ? '+' : '−'} {Math.abs(relative)} t</span>}
          </div>

          <div style={label}><span>Kontrakty</span><span>{m.stopLossUsd != null ? `riziko ${money(m.stopLossUsd)}` : 'bez stop lossu'}</span></div>
          <div style={box(m.quantity < 1)}>
            <button type="button" className="dj-btn" aria-label="Méně" onClick={() => setQty(draft.quantity - 1)} style={{ width: 34, height: 34, borderRadius: 9, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-text)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Minus size={16} /></button>
            <input aria-label="Kontrakty" inputMode="numeric" value={text.qty} onChange={event => { setText(current => ({ ...current, qty: event.target.value })); const value = Number.parseInt(event.target.value, 10); if (value > 0) update({ ...draft, quantity: Math.min(999, value) }); }} onBlur={() => setText(current => ({ ...current, qty: String(draft.quantity) }))} style={{ ...input, textAlign: 'center' }} />
            <button type="button" className="dj-btn" aria-label="Více" onClick={() => setQty(draft.quantity + 1)} style={{ width: 34, height: 34, borderRadius: 9, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-text)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Plus size={16} /></button>
          </div>

          <div style={{ ...label, marginTop: 18 }}><span>Výstupy</span></div>
          {(['tp', 'sl'] as const).map(field => {
            const on = (field === 'tp' ? draft.takeProfit : draft.stopLoss) != null;
            const usd = field === 'tp' ? m.takeProfitUsd : m.stopLossUsd;
            const t = field === 'tp' ? tpTicks : slTicks;
            return (
              <div key={field} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '4px 2px 6px' }}>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>{field === 'tp' ? 'Take profit' : 'Stop loss'}</span>
                  {switchButton(on, () => toggleExit(field), field === 'tp' ? 'Take profit' : 'Stop loss')}
                </div>
                <div style={box(exitProblem(field === 'tp' ? 'Take' : 'Stop'), !on)}>
                  <input aria-label={field === 'tp' ? 'Cena take profit' : 'Cena stop loss'} inputMode="decimal" disabled={!on} value={on ? text[field] : ''} placeholder="vypnuto" onChange={event => editPrice(field, event.target.value)} onBlur={() => blurPrice(field)} style={input} />
                  {on && t != null && usd != null && <span className="dj-mono" style={{ fontSize: 12, color: 'var(--dj-muted)', whiteSpace: 'nowrap' }}>{t} t · <b style={{ color: field === 'tp' ? GAIN : LOSS }}>{field === 'tp' ? '+' : '−'}{money(usd)}</b></span>}
                </div>
              </div>
            );
          })}

          {problems.length > 0 && (
            <div role="status" style={{ marginTop: 6, display: 'grid', gap: 4 }}>
              {problems.map(problem => <p key={problem.text} style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: problem.level === 'error' ? LOSS : 'var(--dj-amber-text)' }}>{problem.text}</p>)}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            {row('Riziko (SL)', <span style={{ color: LOSS }}>{m.stopLossUsd != null ? `−${money(m.stopLossUsd)}` : '—'}</span>)}
            {row('Zisk (TP)', <span style={{ color: GAIN }}>{m.takeProfitUsd != null ? `+${money(m.takeProfitUsd)}` : '—'}</span>)}
            {row('Riziko : zisk', m.riskReward != null ? `1 : ${m.riskReward.toFixed(2).replace('.', ',')}` : '—')}
            {row('Tick', `${String(tick).replace('.', ',')} = ${(tick * instrument.pointValue).toFixed(2).replace('.', ',')} USD`)}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8, padding: '10px 16px calc(12px + env(safe-area-inset-bottom, 0px))', borderTop: '1px solid var(--dj-line)' }}>
          <button type="button" className="dj-btn" onClick={onClose} style={{ height: 48, borderRadius: 12, border: '1px solid var(--dj-line)', background: 'transparent', color: 'var(--dj-text)', font: '700 14px Inter, sans-serif', cursor: 'pointer' }}>Zahodit</button>
          <button type="button" className="dj-btn" disabled={blocked} onClick={() => { playNativeHapticIfAvailable('medium'); onSubmit({ ...draft, sizing: 'qty', quantity: m.quantity }); }} style={{ height: 48, borderRadius: 12, border: 0, color: '#fff', background: sell ? SELL : BUY, opacity: blocked ? 0.4 : 1, font: '800 14px Inter, sans-serif', cursor: blocked ? 'not-allowed' : 'pointer' }}>
            {sell ? 'Prodat' : 'Koupit'} {m.quantity} {market ? 'market' : draft.type === 'limit' ? 'limit' : 'stop'}
          </button>
        </div>
      </section>
    </div>
  );
}
