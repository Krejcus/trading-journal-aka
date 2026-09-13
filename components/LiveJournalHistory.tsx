import { isLegacyJournalTrade } from '../lib/journalTradeFacts';
import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import type { Account, Trade } from '../types';
import { liveJournalHistory } from '../lib/liveJournalHistory';
import { buildTradeGroupIndex, isCombinedTrade, tradeAccountLabel, tradeGroupMembers, tradeEstimateNotice } from '../lib/tradeHistoryPresentation';

const money = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const PAGE_SIZE = 10;

export default function LiveJournalHistory({ trades, accounts, mode, onMode, onSelect, onHistory }: {
  trades: Trade[]; accounts: Account[]; mode: 'combined' | 'individual';
  onMode: (mode: 'combined' | 'individual') => void; onSelect: (trade: Trade) => void; onHistory?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [page, setPage] = useState(0);
  const rows = useMemo(() => liveJournalHistory(trades, mode), [trades, mode]);
  const groups = useMemo(() => buildTradeGroupIndex(trades), [trades]);
  const names = useMemo(() => new Map(accounts.map(account => [account.id, account.name])), [accounts]);
  const lastPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  return <section aria-label="Historie kopírovaných obchodů" className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)]">
    <header className="flex flex-wrap items-center gap-3 px-5 py-4">
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} className="flex items-center gap-2 font-black text-base">
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<History size={17} className="text-indigo-500" />Historie obchodů
      </button>
      <div className="ml-auto flex gap-1 rounded-lg border border-[var(--border-subtle)] p-1 text-[11px] font-bold" aria-label="Zobrazení historie">
        {(['combined', 'individual'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => { setPage(0); onMode(value); }} className={`rounded-md px-3 py-1.5 ${mode === value ? 'bg-indigo-500/10 text-indigo-500' : 'text-[var(--text-secondary)]'}`}>{value === 'combined' ? 'Kombinované' : 'Individuální'}</button>)}
      </div>
      {onHistory && <button type="button" onClick={onHistory} className="text-xs font-bold text-indigo-500">Celá historie</button>}
    </header>
    {open && <>
      <p className="px-5 pb-3 text-[11px] text-[var(--text-secondary)]">Uzavřené obchody · starší záznamy jsou označené · stejné filtry účtů a období jako v historii</p>
      {visible.length ? <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
        {visible.map(trade => {
          const combined = isCombinedTrade(trade);
          const members = tradeGroupMembers(trade, groups);
          return <button type="button" key={trade.id} onClick={() => onSelect(trade)} className="flex w-full flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3 text-left hover:bg-indigo-500/[0.035] focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500">
            <span className="w-40 shrink-0 text-[11px] tabular-nums text-[var(--text-secondary)]" title={combined ? 'Čas reprezentativního účtu; vlastní časy jsou v detailu.' : undefined}>{dateTime.format(new Date(trade.timestamp))}</span>
            <span className="min-w-24 text-xs font-black">{trade.instrument} <span className={trade.direction === 'Long' ? 'text-emerald-500' : 'text-rose-500'}>{trade.direction}</span></span>
            <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]">{combined ? `${tradeAccountLabel(members)}${isLegacyJournalTrade(trade) ? '' : ' s plněním'}` : names.get(trade.accountId) ?? trade.accountId}</span>
            <span className="text-[9px] font-bold text-amber-500" title={tradeEstimateNotice(trade) || undefined}>{isLegacyJournalTrade(trade) ? 'Starší záznam' : null}</span>
            <span className={`ml-auto text-sm font-black tabular-nums ${trade.pnl > 0 ? 'text-emerald-500' : trade.pnl < 0 ? 'text-rose-500' : 'text-[var(--text-secondary)]'}`}>{trade.pnl > 0 ? '+' : ''}{money.format(trade.pnl)}</span>
            <ChevronRight size={14} className="text-[var(--text-secondary)]" />
          </button>;
        })}
      </div> : <p className="border-t border-[var(--border-subtle)] px-5 py-6 text-xs text-[var(--text-secondary)]">Pro vybrané filtry zatím není dostupný uzavřený obchod.</p>}
      {lastPage > 0 && <footer className="flex items-center justify-end gap-3 border-t border-[var(--border-subtle)] px-5 py-3 text-xs text-[var(--text-secondary)]">
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="disabled:opacity-30">Předchozí</button>
        <span>{currentPage + 1} / {lastPage + 1}</span>
        <button type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)} className="disabled:opacity-30">Další</button>
      </footer>}
    </>}
  </section>;
}
