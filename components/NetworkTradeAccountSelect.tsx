import React from 'react';
import type { NetworkTradeMember } from '../lib/networkTradeGroups';
import { formatSharedPnL } from '../utils/formatPnL';
import type { ExchangeRates } from '../services/currencyService';

export const networkTradeTime = (value: unknown): string => {
  const millis = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(millis) || !Number.isFinite(new Date(millis).getTime())) return '—';
  return new Date(millis).toLocaleString('cs-CZ', { year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
};

export default function NetworkTradeAccountSelect({ members, selectedId, unit, currency, exchangeRates, isDark, onSelect }: {
  members: readonly NetworkTradeMember[]; selectedId: string | number; unit: 'usd' | 'rr' | 'hidden' | undefined;
  currency?: 'USD' | 'CZK' | 'EUR'; exchangeRates?: ExchangeRates | null; isDark: boolean; onSelect: (member: NetworkTradeMember) => void;
}) {
  const count = new Set(members.map(row => row.accountId).filter(Boolean)).size;
  const known = unit !== 'hidden' && members.every(row => typeof row.pnl === 'number' && Number.isFinite(row.pnl));
  const total = known ? members.reduce((sum, row) => sum + row.pnl!, 0) : null;
  return <div className={`mb-6 rounded-2xl border p-4 space-y-3 ${isDark ? 'border-[var(--border-subtle)] bg-[var(--bg-card)]' : 'border-slate-100 bg-slate-50'}`}>
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-slate-500">{count} {count === 1 ? 'účet' : count < 5 ? 'účty' : 'účtů'} · Součet zobrazených účtů</span>
      <span className={`font-mono font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>{formatSharedPnL(total, unit, currency, exchangeRates)}</span>
    </div>
    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">
      Účet v detailu
      <select aria-label="Účet ve sdíleném obchodu" value={String(selectedId)} onChange={event => {
        const member = members.find(row => String(row.id) === event.target.value);
        if (member) onSelect(member);
      }} className={`mt-2 w-full rounded-xl border p-3 text-xs normal-case tracking-normal ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)] text-white' : 'bg-white border-slate-200 text-slate-900'}`}>
        {members.map(row => <option key={String(row.id)} value={String(row.id)}>
          {row.accountName || `Účet ${row.accountId}`} · {formatSharedPnL(row.pnl, unit, currency, exchangeRates)} · {networkTradeTime(row.timestamp ?? row.date)}
        </option>)}
      </select>
    </label>
    <p className="text-[10px] text-slate-500">Ceny, časy a výsledek níže patří vybranému účtu.</p>
  </div>;
}
