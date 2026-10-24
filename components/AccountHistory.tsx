import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { Account, BusinessExpense, BusinessPayout, Trade } from '../types';
import { accountLifecycles, isFundedFromChallenge, pairAccountsWithPurchases, type AccountOutcome } from '../lib/accountPurchases';
import { firmDisplayName } from '../lib/businessFirms';

/**
 * Historie účtů: jeden řádek na účet, který už neběží (spálený, prošlý,
 * archivovaný). Nákup a výplaty jsou jen ke čtení — peníze žijí v Byznysu.
 * Vykresluje se po stránkách, ať se desítky účtů nekreslí najednou.
 */

const PAGE = 15;
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money = (value: number) => `${value < 0 ? '−' : ''}${usd.format(Math.abs(value))}`;
const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${usd.format(Math.abs(value))}`;
const dateCz = (time: number | null) => time == null ? '—'
  : new Date(time).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: '2-digit' });
const isoCz = (date: string) => dateCz(Date.parse(`${date}T12:00:00`));
const tone = (value: number | null) => value == null || value === 0 ? '' : value > 0 ? 'text-emerald-500' : 'text-rose-500';

const OUTCOME_LABEL: Record<Exclude<AccountOutcome, 'alive' | 'hidden'>, string> = {
  burned: 'Spálen', passed: 'Prošel', archived: 'Archiv',
};
const OUTCOME_CHIP: Record<Exclude<AccountOutcome, 'alive' | 'hidden'>, string> = {
  burned: 'bg-rose-500/12 text-rose-500', passed: 'bg-emerald-500/12 text-emerald-500', archived: 'bg-slate-500/15 text-[var(--text-secondary)]',
};

type OutcomeFilter = 'all' | 'burned' | 'passed' | 'archived';

export default function AccountHistory({ accounts, trades, payouts, expenses, onOpenAccount }: {
  /** Všechny účty včetně archivu; živé a skryté se vynechají. */
  accounts: Account[];
  trades: Trade[];
  payouts: BusinessPayout[];
  expenses: BusinessExpense[];
  onOpenAccount?: (accountId: string) => void;
}) {
  const [firm, setFirm] = useState<string>('all');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);

  const lifecycles = useMemo(() => accountLifecycles(accounts, trades, payouts), [accounts, trades, payouts]);
  const purchases = useMemo(() => pairAccountsWithPurchases(accounts, expenses).byAccount, [accounts, expenses]);
  const ended = useMemo(() => accounts
    .flatMap(account => {
      const life = lifecycles.get(account.id);
      return life && life.outcome !== 'alive' && life.outcome !== 'hidden' ? [{ account, life }] : [];
    })
    .sort((a, b) => (b.life.end ?? b.life.start) - (a.life.end ?? a.life.start)), [accounts, lifecycles]);
  const firms = useMemo(() => [...new Set(ended.map(row => row.life.firmKey))], [ended]);
  const needle = query.trim().toLowerCase();
  const rows = ended.filter(({ account, life }) => (firm === 'all' || life.firmKey === firm)
    && (outcome === 'all' || life.outcome === outcome)
    && (!needle || account.name.toLowerCase().includes(needle)));
  const visible = rows.slice(0, shown);

  const pill = (active: boolean) => `rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${active
    ? 'border-indigo-500 bg-indigo-500 text-white'
    : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`;
  const th = 'whitespace-nowrap border-b border-[var(--border-subtle)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.07em] text-[var(--text-muted)]';
  const td = 'whitespace-nowrap border-b border-[var(--border-subtle)] px-3 py-2.5 align-top tabular-nums';

  if (ended.length === 0) {
    return <p className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-8 text-center text-xs text-[var(--text-secondary)]">Zatím žádný ukončený účet.</p>;
  }

  return (
    <section className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]" aria-label="Historie účtů">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2.5">
        <label className="flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] px-2 py-1">
          <Search size={13} className="text-[var(--text-muted)]" aria-hidden="true" />
          <input
            value={query}
            onChange={event => { setQuery(event.target.value); setShown(PAGE); }}
            placeholder="Hledat účet…"
            aria-label="Hledat účet"
            className="w-40 bg-transparent text-xs text-[var(--text-primary)] outline-none"
          />
        </label>
        <button type="button" className={pill(firm === 'all')} onClick={() => { setFirm('all'); setShown(PAGE); }}>Všechny firmy</button>
        {firms.map(key => (
          <button key={key} type="button" className={pill(firm === key)} onClick={() => { setFirm(key); setShown(PAGE); }}>{firmDisplayName(key)}</button>
        ))}
        <span className="text-[var(--text-muted)]" aria-hidden="true">·</span>
        {(['all', 'burned', 'passed', 'archived'] as const).map(key => (
          <button key={key} type="button" className={pill(outcome === key)} onClick={() => { setOutcome(key); setShown(PAGE); }}>
            {key === 'all' ? 'Vše' : key === 'burned' ? 'Spálené' : key === 'passed' ? 'Prošlé' : 'Archiv'}
          </button>
        ))}
        <span className="ml-auto text-[11px] font-semibold text-[var(--text-muted)]">{rows.length} {rows.length === 1 ? 'účet' : rows.length >= 2 && rows.length <= 4 ? 'účty' : 'účtů'}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead><tr>
            <th className={`${th} text-left`}>Účet</th>
            <th className={`${th} text-left`}>Fáze</th>
            <th className={`${th} text-left`} title="Z nákladů v Byznysu">Nákup</th>
            <th className={`${th} text-right`}>Žil</th>
            <th className={`${th} text-right`}>Konec</th>
            <th className={`${th} text-right`}>Max zisk</th>
            <th className={`${th} text-right`}>Výsledek</th>
            <th className={`${th} text-right`} title="Z výplat v Byznysu">Výplaty</th>
          </tr></thead>
          <tbody>
            {visible.map(({ account, life }) => {
              const purchase = purchases.get(account.id);
              const result = life.outcome as Exclude<AccountOutcome, 'alive' | 'hidden'>;
              return (
                <tr
                  key={account.id}
                  onClick={onOpenAccount ? () => onOpenAccount(account.id) : undefined}
                  className={onOpenAccount ? 'cursor-pointer hover:bg-[var(--bg-page)]/60' : undefined}
                >
                  <td className={`${td} text-left`}>
                    <b className="block max-w-[220px] truncate text-[var(--text-primary)]" title={account.name}>{account.name}</b>
                    <span className="text-[10.5px] font-semibold text-[var(--text-muted)]">{firmDisplayName(life.firmKey)}</span>
                  </td>
                  <td className={`${td} text-left text-[var(--text-secondary)]`}>{account.phase ?? account.type}</td>
                  <td className={`${td} text-left`}>
                    {purchase ? <>
                      <span className="font-bold text-[var(--text-primary)]">{money(purchase.price)}</span>
                      <span className="block text-[10.5px] text-[var(--text-muted)]">
                        {isoCz(purchase.date)} · {purchase.label}{purchase.sure ? '' : <span className="text-amber-500"> · potvrdit</span>}
                      </span>
                    </> : <span className="text-[10.5px] text-[var(--text-muted)]">{isFundedFromChallenge(account) ? 'funded z challenge' : 'nákup nenalezen'}</span>}
                  </td>
                  <td className={`${td} text-right`}>{life.lifeDays != null ? `${life.lifeDays} d` : '—'}</td>
                  <td className={`${td} text-right text-[var(--text-secondary)]`}>{dateCz(life.end)}</td>
                  <td className={`${td} text-right ${tone(life.maxProfit)}`}>{life.maxProfit != null ? signed(life.maxProfit) : '—'}</td>
                  <td className={`${td} text-right`}>
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10.5px] font-black ${OUTCOME_CHIP[result]}`}>{OUTCOME_LABEL[result]}</span>
                    {life.trades > 0 || life.pnl !== 0 ? <span className={`block text-[10.5px] font-semibold ${tone(life.pnl)}`}>{signed(life.pnl)}</span> : null}
                  </td>
                  <td className={`${td} text-right ${life.payouts ? 'font-bold text-emerald-500' : 'text-[var(--text-muted)]'}`}>{life.payouts ? money(life.payouts) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > shown ? (
        <button
          type="button"
          onClick={() => setShown(count => count + PAGE)}
          className="w-full border-t border-[var(--border-subtle)] py-2.5 text-xs font-bold text-indigo-500 hover:bg-[var(--bg-page)]/60"
        >
          Zobrazit dalších {Math.min(PAGE, rows.length - shown)} · zbývá {rows.length - shown}
        </button>
      ) : null}
      <p className="border-t border-[var(--border-subtle)] px-3 py-2 text-[10.5px] text-[var(--text-muted)]">Nákup a výplaty jsou z Byznysu, tady jen ke čtení. Kliknutím otevřeš účet v dashboardu.</p>
    </section>
  );
}
