import React from 'react';
import type { TradeEntryOrder } from '../lib/journalEntryOrders';
import type { EntryOrderOutcome } from '../lib/entryOrderOutcome';
import { entryOrderOutcomeCard } from '../services/journalEntryOrdersPrimitive';

const price = (value: number) => value.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const time = (at: number) => new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const duration = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
};

const TONES = {
  green: ['border-emerald-200 bg-emerald-50 text-emerald-700', 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'],
  red: ['border-rose-200 bg-rose-50 text-rose-700', 'border-rose-500/30 bg-rose-500/10 text-rose-300'],
  amber: ['border-amber-200 bg-amber-50 text-amber-700', 'border-amber-500/30 bg-amber-500/10 text-amber-300'],
  slate: ['border-slate-200 bg-slate-50 text-slate-700', 'border-white/10 bg-white/5 text-slate-200'],
} as const;

/**
 * Detail vstupního příkazu v seznamu „Průběh obchodu“ (hodnocení i Průběh
 * v grafu detailu): časová osa příkazu, bracket a „kdybys nezrušil“.
 */
export default function EntryOrderDetail({ order, outcome, pointValue = 2, isDark, onClose }: {
  order: TradeEntryOrder;
  outcome?: EntryOrderOutcome | null;
  pointValue?: number;
  isDark: boolean;
  onClose?: () => void;
}) {
  const card = outcome ? entryOrderOutcomeCard(outcome, order.quantity, pointValue) : null;
  const tone = (name: keyof typeof TONES) => TONES[name][isDark ? 1 : 0];
  const status = order.end?.kind === 'fill' ? ['Vyplněn', tone('green')] : order.end ? ['Zrušen', tone('slate')] : ['Čeká', tone('amber')];
  const steps = [
    ...order.legs.map((leg, index) => ({ label: index ? 'Posunut' : 'Zadán', at: leg.at, price: leg.price as number | null, dot: index ? '#a855f7' : order.side === 'Buy' ? '#2962ff' : '#f23645' })),
    ...(order.end ? [{ label: order.end.kind === 'fill' ? 'Vyplněn' : 'Zrušen', at: order.end.at, price: null, dot: order.end.kind === 'fill' ? '#10b981' : '#94a3b8' }] : []),
  ];
  return (
    <div className={`entry-order-detail rounded-lg border px-3 py-2.5 text-[11px] ${isDark ? 'border-[var(--border-subtle)] bg-[var(--bg-page)]' : 'border-[var(--border-subtle)] bg-[var(--bg-card)]'}`}>
      <div className="mb-2 flex items-center gap-1.5">
        <span className={`rounded-full px-2 py-[3px] text-[9.5px] font-extrabold tracking-[0.02em] text-white ${order.side === 'Buy' ? 'bg-[#2962ff]' : 'bg-[#f23645]'}`}>
          {order.side === 'Buy' ? 'BUY' : 'SELL'} {order.type === 'Limit' ? 'LIMIT' : 'STOP'}
        </span>
        {order.quantity != null && <b className={isDark ? 'text-slate-100' : 'text-slate-900'}>{order.quantity} ks</b>}
        <span className={`ml-auto rounded-full border px-2 py-px text-[9.5px] font-extrabold ${status[1]}`}>{status[0]}</span>
        {onClose && <button type="button" onClick={onClose} aria-label="Zavřít detail příkazu" className="-mr-1 grid h-5 w-5 place-items-center rounded text-slate-400 hover:text-slate-600">×</button>}
      </div>
      <ol className="mb-1.5 grid gap-1">
        {steps.map(step => (
          <li key={`${step.label}:${step.at}`} className="flex items-center gap-1.5">
            <i className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: step.dot }} />
            <span className={`font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{step.label}</span>
            <time className="tabular-nums text-slate-400">{time(step.at)}</time>
            {step.price != null && <b className={`ml-auto tabular-nums ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{price(step.price)}</b>}
          </li>
        ))}
      </ol>
      {order.end && <p className="mb-2 pl-[13px] text-[10.5px] text-slate-400">{order.end.kind === 'fill' ? 'Čekal na vyplnění' : 'Stál'} {duration(order.end.at - order.placedAt)}</p>}
      {order.bracket && (order.bracket.sl != null || order.bracket.tp != null) && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {order.bracket.sl != null && <span className={`rounded-md border px-2 py-[3px] text-[10.5px] font-extrabold tabular-nums ${tone('red')}`}>SL {price(order.bracket.sl)}</span>}
          {order.bracket.tp != null && <span className={`rounded-md border px-2 py-[3px] text-[10.5px] font-extrabold tabular-nums ${tone('green')}`}>TP {price(order.bracket.tp)}</span>}
        </div>
      )}
      {card && (
        <div className={`rounded-lg border px-2.5 py-2 ${tone(card.tone)}`}>
          <small className="block text-[10px] font-semibold opacity-80">Kdybys nezrušil</small>
          <strong className="block text-[16px] font-extrabold tracking-[-0.01em] tabular-nums">{card.value}</strong>
          <span className={`block text-[10px] leading-snug ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{card.sub}</span>
        </div>
      )}
    </div>
  );
}
