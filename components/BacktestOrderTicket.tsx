import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  bracketDisplayValue,
  bracketPriceFromInput,
  limitIsMarketable,
  marketPrice,
  newTicketDraft,
  snapToTick,
  ticketMetrics,
  ticketProblems,
  withBracket,
  withEntryPrice,
  withSide,
  type TicketBracket,
  type TicketBracketUnits,
  type TicketDraft,
  type TicketInstrument,
  type TicketOrderType,
  type TicketQuote,
  type TicketSide,
} from '../lib/liveOrderTicket';
import { backtestPositionDraftProblem, type BacktestPositionSummary } from '../lib/backtestChartTrading';
import { NumberField, formatPrice, formatUsd } from './LiveOrderTicket';

/**
 * Panel Objednávka v backtest grafu — stejný postup jako LIVE (Koupit/Prodat →
 * návrh v grafu → jedno velké tlačítko), aby se trénoval stejný pohyb ruky.
 * Odesílá jen do enginu session: Market se vyplní za závěr svíčky replaye,
 * Limit/Stop čekají na další svíčky. Žádný relay ani broker.
 */

const TYPE_LABEL: Record<TicketOrderType, string> = { market: 'Market', limit: 'Limit', stop: 'Stop' };
const UNIT_LABEL: Record<TicketBracketUnits, string> = { pts: 'Body', ticks: 'Ticky', usd: '$', price: 'Cena' };
const UNIT_SUFFIX: Record<TicketBracketUnits, string> = { pts: 'b', ticks: 't', usd: '$', price: '' };
const formatPoints = (value: number) => `${Math.abs(value).toFixed(2)} b`;

export type BacktestTicketSubmitResult = { ok: true; text: string } | { ok: false; text: string };

interface Props {
  isDark: boolean;
  instrument: TicketInstrument;
  /** Závěr poslední odkryté svíčky (bid = ask); null = replay ještě nemá cenu. */
  quote: TicketQuote | null;
  /** Čas svíčky, ze které je cena (unix s), a časová zóna session. */
  quoteTime: number | null;
  timeZone: string;
  draft: TicketDraft | null;
  onDraft: (next: TicketDraft | null) => void;
  units: TicketBracketUnits;
  onUnits: (units: TicketBracketUnits) => void;
  sessionName: string;
  balance: number;
  equity: number;
  position: BacktestPositionSummary | null;
  onSubmit: (draft: TicketDraft) => BacktestTicketSubmitResult;
  onNewDraft: (side: TicketSide) => void;
  onClose: () => void;
}

/** Karta otevřené pozice (jen zobrazení z enginu session). */
const PositionCard: React.FC<{ isDark: boolean; summary: BacktestPositionSummary; muted: string; ink: string; field: string }> = ({ isDark, summary, muted, ink, field }) => {
  const long = summary.side === 'long';
  const price = (value: number | null) => (value == null ? '—' : formatPrice(value));
  const progress = summary.mark != null && summary.stop != null && summary.target != null && summary.target !== summary.stop
    ? Math.min(1, Math.max(0, (summary.mark - summary.stop) / (summary.target - summary.stop)))
    : null;
  const entryAt = progress != null && summary.stop != null && summary.target != null
    ? Math.min(1, Math.max(0, (summary.entry - summary.stop) / (summary.target - summary.stop)))
    : null;
  return <div className={`grid gap-1.5 rounded-[6px] border p-2.5 ${field}`}>
    <div className="flex items-baseline gap-2">
      <b className={`text-[11px] font-black uppercase tracking-[0.06em] ${long ? 'text-blue-500' : 'text-rose-500'}`}>{long ? 'Long' : 'Short'} {summary.quantity}</b>
      <span className={`font-mono text-[10.5px] ${muted}`}>@ {price(summary.entry)}</span>
    </div>
    <div className="flex items-baseline gap-2">
      <b className={`font-mono text-[22px] font-black leading-none ${summary.openPnl == null ? muted : summary.openPnl < 0 ? 'text-rose-500' : 'text-emerald-500'}`}>{formatUsd(summary.openPnl)}</b>
      <span className={`text-[9.5px] font-bold ${muted}`} title="Otevřené P&L z ceny replaye, před poplatky">z replaye</span>
    </div>
    {progress != null && <div className={`relative flex h-1.5 overflow-hidden rounded-full ${isDark ? 'bg-white/[0.06]' : 'bg-slate-900/[0.06]'}`} title="Cena mezi SL a TP">
      <i className="block h-full bg-rose-500/45" style={{ width: `${(entryAt ?? 0) * 100}%` }} />
      <i className="block h-full flex-1 bg-emerald-500/35" />
      <span className={`absolute top-0 h-full w-[2px] rounded transition-[left] duration-500 ${isDark ? 'bg-white' : 'bg-slate-900'}`} style={{ left: `calc(${progress * 100}% - 1px)` }} />
    </div>}
    <div className={`flex gap-3 font-mono text-[10px] ${ink}`}>
      <span className="text-rose-500">SL {price(summary.stop)}</span><span className="text-emerald-500">TP {price(summary.target)}</span>
      <span className={`flex-1 text-right font-sans font-bold ${muted}`}>{summary.protection}</span>
    </div>
  </div>;
};

const BacktestOrderTicket: React.FC<Props> = ({
  isDark, instrument, quote, quoteTime, timeZone, draft, onDraft, units, onUnits,
  sessionName, balance, equity, position, onSubmit, onNewDraft, onClose,
}) => {
  const tone = {
    dock: isDark ? 'border-white/10 bg-[#0d1219] text-slate-200' : 'border-slate-200 bg-white text-slate-800',
    field: isDark ? 'border-white/10 bg-white/[0.04]' : 'border-slate-900/10 bg-white/70',
    muted: isDark ? 'text-slate-400' : 'text-slate-500',
    ink: isDark ? 'text-slate-100' : 'text-slate-900',
    line: isDark ? 'border-white/[0.08]' : 'border-slate-900/[0.08]',
    seg: isDark ? 'border-white/10 bg-white/[0.04]' : 'border-slate-900/10 bg-white/70',
    segOn: isDark ? 'bg-white/10 text-white' : 'bg-white text-slate-950 shadow-[0_1px_3px_rgba(15,23,42,0.14),0_0_0_1px_rgba(15,23,42,0.06)]',
    segOff: isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800',
  };
  const seg = (on: boolean) => `h-full flex-1 rounded-[7px] px-1.5 text-[10.5px] font-bold transition-colors ${on ? tone.segOn : tone.segOff}`;
  const label = `text-[9px] font-black uppercase tracking-[0.1em] ${tone.muted}`;

  const m = draft && quote ? ticketMetrics(draft, instrument, quote) : null;
  // Otevřený panel bez návrhu ukazuje formulář ztlumený — ožije až Koupit / Prodat (jako LIVE).
  const restingDraft = !draft && quote ? newTicketDraft('buy', 'limit', quote.ask - 10, instrument, quote) : null;
  const formDraft = draft ?? restingDraft;
  const formMetrics = formDraft && quote ? (draft ? m : ticketMetrics(formDraft, instrument, quote)) : null;
  // Otevřená pozice: přikoupení přepíše její SL/TP, příkaz proti ní ji zmenší (engine session).
  const positionProblem = draft ? backtestPositionDraftProblem(draft, position) : null;
  const problems = draft && quote ? [...ticketProblems(draft, instrument, quote, null), ...(positionProblem ? [positionProblem] : [])] : [];
  const blocked = !draft || !quote || !m ? 'Vyber Koupit nebo Prodat.'
    : problems.some(problem => problem.level === 'error') ? 'Nejdřív oprav chyby v panelu.'
      : null;
  const [result, setResult] = useState<{ key: string; text: string } | null>(null);
  // Market jede s cenou (SL/TP se posouvají každou svíčkou) — hláška nesmí zmizet s tikem.
  const draftKey = draft ? `${draft.side}|${draft.type}|${draft.type === 'market' ? '' : draft.price}|${draft.sizing}|${draft.quantity}|${draft.riskUsd}` : '';
  // Po přijetí se návrh hned maže; zelené „Zadáno“ je jen chvilková ozvěna.
  const [sentFlash, setSentFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!sentFlash) return undefined;
    const timer = window.setTimeout(() => setSentFlash(null), 1600);
    return () => window.clearTimeout(timer);
  }, [sentFlash]);
  const send = () => {
    if (blocked != null || !draft) return;
    const outcome = onSubmit(draft);
    if (outcome.ok) { setResult(null); setSentFlash(outcome.text); onDraft(null); }
    else setResult({ key: draftKey, text: outcome.text });
  };
  const shownResult = result && result.key === draftKey ? result : null;
  const sideColor = draft?.side === 'sell' ? '#e11d48' : '#2563eb';

  const setType = (type: TicketOrderType) => {
    if (!draft || !quote || type === draft.type) return;
    const market = marketPrice(draft.side, quote);
    const d = draft.side === 'buy' ? 1 : -1;
    // Limit pod trhem (long) / nad trhem (short), stop opačně — 10 bodů od trhu.
    const price = type === 'market' ? market : snapToTick(market + (type === 'limit' ? -d : d) * 10, instrument.tickSize);
    onDraft({ ...draft, type, price: draft.type === 'market' ? price : draft.price });
  };
  const toggleBracket = (which: TicketBracket) => {
    if (!draft || !quote) return;
    const current = which === 'sl' ? draft.stopLoss : draft.takeProfit;
    if (current != null) onDraft(which === 'sl' ? { ...draft, stopLoss: null } : { ...draft, takeProfit: null });
    else onDraft(withBracket(draft, which, instrument, quote));
  };
  const commitBracket = (which: TicketBracket, value: number) => {
    if (!draft || !quote) return;
    const price = bracketPriceFromInput(draft, which, units, value, instrument, quote);
    if (price == null) return;
    onDraft(which === 'sl' ? { ...draft, stopLoss: price } : { ...draft, takeProfit: price });
  };
  const stepQuantity = (step: number) => {
    if (!draft) return;
    onDraft(draft.sizing === 'risk'
      ? { ...draft, riskUsd: Math.max(25, draft.riskUsd + step * 25) }
      : { ...draft, quantity: Math.max(1, draft.quantity + step) });
  };
  const quoteClock = quoteTime != null
    ? new Date(quoteTime * 1_000).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', timeZone })
    : null;

  return <div className={`flex h-full min-h-0 flex-col gap-2.5 overflow-hidden border-l p-2.5 ${tone.dock}`}>
    <div className="flex items-center gap-1.5">
      <h3 className={`m-0 flex-1 truncate text-[12.5px] font-black ${tone.ink}`}>
        Objednávka<small className={`ml-1.5 font-bold ${tone.muted}`}>{instrument.symbol}</small>
        <span className="ml-1.5 rounded border border-amber-500/45 px-1 align-[1px] text-[8.5px] font-black uppercase tracking-[0.06em] text-amber-500">backtest</span>
      </h3>
      <button type="button" onClick={onClose} title="Skrýt panel" aria-label="Skrýt panel objednávky" className={`flex h-7 w-7 items-center justify-center rounded-lg ${isDark ? 'text-slate-400 hover:bg-white/[0.08] hover:text-white' : 'text-slate-500 hover:bg-white/70 hover:text-slate-900'}`}><X size={14} /></button>
    </div>

    {/* Místo výběru účtu LIVE: účet session (jen zobrazení). */}
    <div className={`flex h-[40px] shrink-0 items-center gap-2 rounded-[9px] border px-2.5 ${tone.field}`}>
      <span className="grid min-w-0 flex-1 leading-tight">
        <small className={label}>Obchodovat na</small>
        <b className={`truncate text-[11.5px] font-extrabold ${tone.ink}`} title={sessionName}>Session · {sessionName}</b>
      </span>
      <span className="grid text-right leading-tight">
        <small className={label}>Equity</small>
        <b className={`font-mono text-[11px] font-bold ${equity < balance ? 'text-rose-500' : tone.ink}`} title={`Balance ${formatUsd(balance, false)}`}>{formatUsd(equity, false)}</b>
      </span>
    </div>

    <div className="live-ticket-stagger -mx-2.5 flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto px-2.5 pb-0.5">
      {position && <PositionCard isDark={isDark} summary={position} muted={tone.muted} ink={tone.ink} field={tone.field} />}
      {!quote ? (
        <p className={`m-0 py-6 text-center text-[11px] ${tone.muted}`}>Spusť replay — panel potřebuje cenu svíčky.</p>
      ) : <>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
          {(['sell', 'buy'] as const).map((side, index) => {
            const on = draft?.side === side;
            const color = side === 'sell' ? 'rose' : 'blue';
            const tile = <button
              key={side}
              type="button"
              onClick={() => (draft ? onDraft(withSide(draft, side, quote, instrument)) : onNewDraft(side))}
              className={`live-ticket-side ${on ? 'is-on' : ''} grid h-[52px] content-center rounded-[10px] border px-2.5 ${side === 'buy' ? 'justify-items-end text-right' : 'justify-items-start text-left'} ${on
                ? color === 'rose' ? 'border-rose-500/60 bg-rose-500/[0.14] text-rose-500' : 'border-blue-500/60 bg-blue-500/[0.14] text-blue-500'
                : `${tone.field} ${tone.ink}`}`}
            >
              <small className={`text-[9px] font-black uppercase tracking-[0.08em] ${on ? '' : tone.muted}`}>{side === 'sell' ? 'Prodat' : 'Koupit'}</small>
              <b className="font-mono text-[14px] font-bold">{formatPrice(side === 'sell' ? quote.bid : quote.ask)}</b>
            </button>;
            return index === 0
              ? <React.Fragment key={side}>{tile}<span className={`font-mono text-[9.5px] ${tone.muted}`} title="Replay nemá bid/ask — obě strany jsou závěr svíčky">0.00</span></React.Fragment>
              : tile;
          })}
        </div>
        <div className={`-mt-1.5 text-center text-[9.5px] ${tone.muted}`} title="Market se vyplní za závěr svíčky replaye (+ skluz session), Limit/Stop podle dalších svíček.">
          Závěr svíčky replaye{quoteClock ? ` · ${quoteClock}` : ''}
        </div>

        {formDraft && formMetrics ? <div className={draft ? 'contents' : 'pointer-events-none flex select-none flex-col gap-2.5 opacity-45'} inert={!draft} aria-hidden={!draft || undefined}>{((draft: TicketDraft, m: NonNullable<typeof formMetrics>) => <>
          <div className={`flex h-[30px] rounded-[9px] border p-0.5 ${tone.seg}`}>
            {(['market', 'limit', 'stop'] as const).map(type => <button key={type} type="button" onClick={() => setType(type)} className={seg(draft.type === type)}>{TYPE_LABEL[type]}</button>)}
          </div>

          <div className="grid gap-1">
            <div className="flex items-center justify-between">
              <span className={label}>Cena</span>
              <span className={`text-[10px] ${tone.muted}`}>{draft.type === 'market'
                ? 'Vyplní se za aktuální cenu'
                : <><b className={`font-mono ${tone.ink}`}>{formatPoints(draft.price - marketPrice(draft.side, quote))}</b> {draft.price < marketPrice(draft.side, quote) ? 'pod' : 'nad'} trhem</>}</span>
            </div>
            <div className={`flex h-[34px] items-center rounded-[9px] border ${tone.field}`}>
              <button type="button" disabled={draft.type === 'market'} onClick={() => onDraft(withEntryPrice(draft, draft.price - instrument.tickSize, instrument, true))} className={`h-full w-8 text-[15px] disabled:opacity-30 ${tone.muted}`}>−</button>
              {draft.type === 'market'
                ? <span className={`flex-1 text-center font-mono text-[13px] ${tone.muted}`}>Market</span>
                : <NumberField ariaLabel="Cena" value={draft.price} format={value => value.toFixed(2)} onCommit={value => onDraft(withEntryPrice(draft, value, instrument, true))} className={`min-w-0 flex-1 bg-transparent text-center font-mono text-[13px] outline-none ${tone.ink}`} />}
              <button type="button" disabled={draft.type === 'market'} onClick={() => onDraft(withEntryPrice(draft, draft.price + instrument.tickSize, instrument, true))} className={`h-full w-8 text-[15px] disabled:opacity-30 ${tone.muted}`}>+</button>
            </div>
          </div>

          <div className="grid gap-1">
            <div className="flex items-center justify-between">
              <span className={label}>Množství</span>
              <div className={`flex h-[24px] w-[150px] rounded-[8px] border p-0.5 ${tone.seg}`}>
                <button type="button" onClick={() => onDraft({ ...draft, sizing: 'qty', quantity: Math.max(1, m.quantity || draft.quantity) })} className={seg(draft.sizing === 'qty')}>Kontrakty</button>
                <button type="button" onClick={() => onDraft(draft.stopLoss == null ? withBracket({ ...draft, sizing: 'risk' }, 'sl', instrument, quote) : { ...draft, sizing: 'risk' })} className={seg(draft.sizing === 'risk')}>Riziko $</button>
              </div>
            </div>
            <div className={`flex h-[34px] items-center rounded-[9px] border ${tone.field}`}>
              <button type="button" onClick={() => stepQuantity(-1)} className={`h-full w-8 text-[15px] ${tone.muted}`}>−</button>
              <NumberField
                ariaLabel={draft.sizing === 'risk' ? 'Riziko v dolarech' : 'Počet kontraktů'}
                value={draft.sizing === 'risk' ? draft.riskUsd : draft.quantity}
                format={value => String(Math.round(value))}
                onCommit={value => onDraft(draft.sizing === 'risk' ? { ...draft, riskUsd: Math.max(0, value) } : { ...draft, quantity: Math.max(1, Math.round(value)) })}
                className={`min-w-0 flex-1 bg-transparent text-center font-mono text-[13px] outline-none ${tone.ink}`}
              />
              <span className={`pr-1 text-[10px] font-bold ${tone.muted}`}>{draft.sizing === 'risk' ? '$' : instrument.symbol}</span>
              <button type="button" onClick={() => stepQuantity(1)} className={`h-full w-8 text-[15px] ${tone.muted}`}>+</button>
            </div>
            {draft.sizing === 'risk' && <div className={`text-[10.5px] ${tone.muted}`}>→ <b className={`font-mono ${tone.ink}`}>{m.quantity}</b> kontraktů · skutečné riziko <b className={`font-mono ${tone.ink}`}>{formatUsd(m.stopLossUsd)}</b></div>}
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <span className={label}>Závorky</span>
              <div className={`flex h-[24px] w-[170px] rounded-[8px] border p-0.5 ${tone.seg}`}>
                {(['pts', 'ticks', 'usd', 'price'] as const).map(unit => <button key={unit} type="button" onClick={() => onUnits(unit)} className={seg(units === unit)}>{UNIT_LABEL[unit]}</button>)}
              </div>
            </div>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
              {(['tp', 'sl'] as const).map(which => {
                const on = (which === 'sl' ? draft.stopLoss : draft.takeProfit) != null;
                const color = which === 'sl' ? 'text-rose-500' : 'text-emerald-500';
                const box = which === 'sl' ? 'border-rose-500 bg-rose-500' : 'border-emerald-500 bg-emerald-500';
                return <React.Fragment key={which}>
                  <button type="button" onClick={() => toggleBracket(which)} className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-extrabold ${color}`}>
                    <i className={`grid h-[15px] w-[15px] place-items-center rounded-[4px] border-[1.5px] text-[10px] not-italic text-white ${on ? box : tone.field}`}>{on ? '✓' : ''}</i>
                    {which === 'tp' ? 'Take profit' : 'Stop loss'}
                  </button>
                  <div className={`flex h-[30px] items-center rounded-[9px] border ${tone.field} ${on ? '' : 'opacity-50'}`}>
                    <NumberField
                      ariaLabel={which === 'tp' ? 'Take profit' : 'Stop loss'}
                      disabled={!on}
                      value={bracketDisplayValue(draft, which, units, instrument, quote)}
                      format={value => (units === 'ticks' ? String(Math.round(value)) : value.toFixed(2))}
                      onCommit={value => commitBracket(which, value)}
                      className={`min-w-0 flex-1 bg-transparent px-2 text-center font-mono text-[13px] outline-none ${tone.ink}`}
                    />
                    <span className={`pr-2 text-[10px] font-bold ${tone.muted}`}>{UNIT_SUFFIX[units]}</span>
                  </div>
                </React.Fragment>;
              })}
            </div>
          </div>

          <div className={`grid gap-1.5 rounded-[10px] border px-2.5 py-2 ${tone.field}`}>
            <div className={`flex items-baseline justify-between text-[11px] ${tone.muted}`}><span>Stop loss</span><b className="font-mono text-[12px] text-rose-500">{formatUsd(m.stopLossUsd)}</b></div>
            <div className={`flex items-baseline justify-between text-[11px] ${tone.muted}`}><span>Take profit</span><b className="font-mono text-[12px] text-emerald-500">{formatUsd(m.takeProfitUsd)}</b></div>
            <div className={`flex items-baseline justify-between text-[11px] ${tone.muted}`}><span>Poměr R:R</span><b className={`font-mono text-[12px] ${tone.ink}`}>{m.riskReward != null ? `1 : ${m.riskReward.toFixed(2)}` : '—'}</b></div>
          </div>
        </>)(formDraft, formMetrics)}</div> : null}
      </>}
    </div>

    {draft && m && quote && <div className={`grid shrink-0 gap-1.5 border-t pt-2 ${tone.line}`}>
      {problems.length > 0 && <div className="grid gap-1">
        {problems.map(problem => <div key={problem.text} className={`rounded-[7px] px-2 py-1.5 text-[10.5px] font-bold ${problem.level === 'error' ? 'bg-rose-500/10 text-rose-500' : 'bg-amber-500/10 text-amber-600'}`}>{problem.text}</div>)}
      </div>}
      <button
        type="button"
        disabled={blocked != null}
        title={blocked ?? (draft.type === 'market' ? 'Vyplní se hned za závěr svíčky replaye.' : 'Zadá příkaz do session; vyplní ho další svíčky replaye.')}
        onClick={send}
        className="live-ticket-send grid h-[44px] content-center rounded-[8px] text-[12px] font-extrabold leading-tight text-white disabled:cursor-not-allowed disabled:opacity-60"
        style={{ background: `linear-gradient(180deg, color-mix(in srgb, ${sideColor} 82%, #fff), ${sideColor})`, boxShadow: `0 10px 22px -12px ${sideColor}` }}
      >
        <span>{`${draft.side === 'buy' ? 'Koupit' : 'Prodat'} ${m.quantity} ${instrument.symbol}`}</span>
        <small className="font-mono text-[10px] font-semibold opacity-85">
          {draft.type === 'market' ? `MKT · ~${formatPrice(marketPrice(draft.side, quote))}` : `${draft.type === 'stop' ? 'STP' : 'LMT'} @ ${formatPrice(draft.price)}`}
          {' · backtest'}{limitIsMarketable(draft, quote) ? ' · hned' : ''}
        </small>
      </button>
      {shownResult && <div className="rounded-[7px] bg-rose-500/10 px-2 py-1.5 text-[10.5px] font-bold text-rose-500">{shownResult.text}</div>}
    </div>}
    {!draft && !sentFlash && quote && <div className={`grid shrink-0 gap-1.5 border-t pt-2 ${tone.line}`}>
      <div className={`grid h-[44px] place-items-center rounded-[8px] border border-dashed text-[11.5px] font-bold ${tone.field} ${tone.muted}`}>
        Vyber Koupit nebo Prodat
      </div>
    </div>}
    {!draft && sentFlash && <div className={`grid shrink-0 gap-1.5 border-t pt-2 ${tone.line}`}>
      <div role="status" className="live-ticket-send is-ok grid h-[44px] place-items-center rounded-[8px] text-[12px] font-extrabold text-white">
        <span className="live-ticket-ring" aria-hidden="true" />
        <span className="inline-flex items-center gap-2">
          <svg className="live-ticket-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7" /></svg>
          {sentFlash}
        </span>
      </div>
    </div>}
  </div>;
};

export default BacktestOrderTicket;
