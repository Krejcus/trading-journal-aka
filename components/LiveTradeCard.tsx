import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { TradeCardAccount, TradeCardLevel, TradeCardModel } from '../lib/liveTradeCard';
import { futuresSymbolRoot } from '../services/futuresContractSpecs';

/**
 * Karta aktuálního obchodu skupiny (jen zobrazení, SL/TP se posouvají
 * v Tradovate). Počítač: pruh nad účty, kliknutím rozpad po účtech.
 * Telefon: karta se stupnicí, klepnutím SL/TP po účtech.
 */

const wholeUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const centsUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pointsFmt = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const priceFmt = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ratioFmt = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 });

const signedUsd = (value: number | null) => value == null
  ? '—'
  : `${value > 0 ? '+' : value < 0 ? '−' : ''}${wholeUsd.format(Math.abs(value))}`;
const signedPoints = (value: number | null) => value == null
  ? null
  : `${value > 0 ? '+' : value < 0 ? '−' : ''}${pointsFmt.format(Math.abs(value))} b`;
const tone = (value: number | null) => value == null || value === 0
  ? 'text-[var(--text-primary)]'
  : value > 0 ? 'text-emerald-500' : 'text-rose-500';

/** Riziko : cíl. SL v plusu = bez rizika. */
export const tradeCardRatio = (model: TradeCardModel): string | null => {
  const risk = model.stop.usd;
  const reward = model.target.usd;
  if (risk == null || reward == null) return null;
  if (risk >= 0) return 'bez rizika';
  if (reward <= 0) return null;
  return `1 : ${ratioFmt.format(reward / -risk)}`;
};

const sideLabel = (model: TradeCardModel) => {
  if (model.kind === 'position') return model.direction > 0 ? 'LONG' : 'SHORT';
  const type = (model.entryType ?? '').trim().toLowerCase();
  const short = type === 'limit' ? 'LMT' : type.startsWith('stop') ? 'STP' : type.toUpperCase();
  return `${model.direction > 0 ? 'BUY' : 'SELL'} ${short}`.trim();
};

const SideBadge = ({ model }: { model: TradeCardModel }) => (
  <span className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-black tracking-wider ${model.direction > 0
    ? 'bg-emerald-500/15 text-emerald-500'
    : 'bg-rose-500/15 text-rose-500'}`}>{sideLabel(model)}</span>
);

/** Krátké zvýraznění, když se v Tradovate posune SL nebo TP. */
const useChangeFlash = (key: string | null) => {
  const previous = useRef(key);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const before = previous.current;
    previous.current = key;
    if (before == null || key == null || before === key) return;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 1800);
    return () => window.clearTimeout(timer);
  }, [key]);
  return flash;
};

const levelKey = (model: TradeCardModel, key: 'stop' | 'target') =>
  model.accounts.map(account => `${account.accountId}:${account[key].price ?? '-'}:${account[key].coverage}`).join('|');

/** Krytí: kolik účtů v obchodu má SL a TP přes celou pozici. */
const CoverageChip = ({ model }: { model: TradeCardModel }) => {
  const total = model.accounts.length;
  if (!model.verified) return <span className="rounded-full bg-slate-500/15 px-2 py-0.5 text-[10px] font-black text-[var(--text-secondary)]" title="Příkazy nejsou čerstvě ověřené">SL/TP ?</span>;
  if (model.kind === 'pending') {
    return model.stopCovered === total
      ? <span className="rounded-full bg-slate-500/15 px-2 py-0.5 text-[10px] font-black text-[var(--text-secondary)]" title="Bracket čeká u brokera a aktivuje se fillem vstupu">SL/TP čekají na fill</span>
      : <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-black text-amber-600">SL {model.stopCovered}/{total}</span>;
  }
  if (model.stopCovered < total) return <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-black text-rose-500" title="Některý účet nemá SL přes celou pozici">SL {model.stopCovered}/{total}</span>;
  if (model.targetCovered < total) return <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-black text-emerald-500">SL {total}/{total} · TP {model.targetCovered}/{total}</span>;
  return <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-black text-emerald-500">SL+TP {total}/{total}</span>;
};

const feeNote = (model: TradeCardModel) => model.feesIncluded
  ? `Po poplatcích za vstup i výstup (${centsUsd.format(model.totalFees ?? 0)}). Stop se plní tržně, skluz bývá tick až dva navíc.`
  : 'Bez poplatků: broker k některému účtu zatím neposlal fill s poplatky.';

const levelValue = (level: TradeCardLevel, verified: boolean) => !verified ? '?' : signedUsd(level.usd);

const KV = ({ label, value, sub, valueClass, flash }: { label: string; value: string; sub?: string | null; valueClass?: string; flash?: boolean }) => (
  <span className={`flex shrink-0 flex-col gap-0.5 rounded px-1 transition-colors duration-700 ${flash ? 'bg-amber-500/25' : 'bg-transparent'}`}>
    <span className="text-[9.5px] font-black uppercase tracking-[0.08em] text-[var(--text-muted)]">{label}</span>
    <span className={`text-[15px] font-black tabular-nums leading-tight ${valueClass ?? 'text-[var(--text-primary)]'}`}>{value}</span>
    {sub ? <span className="text-[10.5px] font-semibold tabular-nums text-[var(--text-muted)]">{sub}</span> : null}
  </span>
);

const accountCell = (level: TradeCardLevel, account: TradeCardAccount) => {
  if (!account.ordersVerified) return <span className="text-[var(--text-muted)]">?</span>;
  if (level.coverage === 0) return <span className="text-[var(--text-muted)]">—</span>;
  if (!level.exact) return <span className="text-amber-600" title="Úroveň nekryje celou pozici">{level.coverage}/{account.quantity}</span>;
  return <>
    <span className={tone(level.usd)}>{signedUsd(level.usd)}</span>
    <span className="block text-[10.5px] font-semibold text-[var(--text-muted)]">{level.price == null ? 'víc úrovní' : signedPoints(level.points)}</span>
  </>;
};

/** Buňka SL/TP v tabulce účtů (volba „SL/TP ve sloupcích“). */
export const TradeLevelCell = ({ account, level }: { account: TradeCardAccount; level: 'stop' | 'target' }) => (
  <span className="inline-flex flex-col items-end text-xs font-bold tabular-nums">{accountCell(account[level], account)}</span>
);

/** Tabulka po účtech — rozbalení pruhu na počítači. */
const AccountBreakdown = ({ model, label }: { model: TradeCardModel; label: (account: TradeCardAccount) => string }) => {
  const leaderEntry = model.accounts.find(account => account.isLeader)?.entry ?? null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="text-[10px] font-black uppercase tracking-[0.07em] text-[var(--text-muted)]">
            <th className="px-3.5 py-2 text-left">Účet</th>
            <th className="px-3.5 py-2 text-right">Vstup</th>
            {model.kind === 'position' ? <th className="px-3.5 py-2 text-right">P&amp;L</th> : null}
            <th className="px-3.5 py-2 text-right">SL</th>
            <th className="px-3.5 py-2 text-right">TP</th>
            <th className="px-3.5 py-2 text-right">Poplatky</th>
          </tr>
        </thead>
        <tbody>
          {model.accounts.map(account => {
            const slip = !account.isLeader && account.entry != null && leaderEntry != null
              ? (account.entry - leaderEntry) * model.direction * -1
              : null;
            return (
              <tr key={account.accountId} className="border-t border-[var(--border-subtle)] align-top font-bold tabular-nums">
                <td className="px-3.5 py-2 text-left">
                  <span className="flex items-center gap-1.5 whitespace-nowrap font-black">
                    {account.isLeader ? <span className="rounded bg-indigo-500/15 px-1 py-px text-[9px] font-black text-indigo-500">L</span> : null}
                    {label(account)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3.5 py-2 text-right">
                  {account.entry == null ? '—' : priceFmt.format(account.entry)}
                  <span className="block text-[10.5px] font-semibold text-[var(--text-muted)]">
                    {account.quantity} ks{slip != null && slip !== 0 ? ` · skluz ${signedPoints(slip)}` : ''}
                  </span>
                </td>
                {model.kind === 'position' ? <td className={`whitespace-nowrap px-3.5 py-2 text-right ${tone(account.openPnl)}`}>{signedUsd(account.openPnl)}</td> : null}
                <td className="whitespace-nowrap px-3.5 py-2 text-right">{accountCell(account.stop, account)}</td>
                <td className="whitespace-nowrap px-3.5 py-2 text-right">{accountCell(account.target, account)}</td>
                <td className="whitespace-nowrap px-3.5 py-2 text-right text-[var(--text-muted)]">{account.fees == null ? '—' : centsUsd.format(account.fees)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="border-t border-[var(--border-subtle)] px-3.5 py-2 text-[10.5px] font-semibold text-[var(--text-muted)]">{feeNote(model)}</p>
    </div>
  );
};

const STRIP_OPEN_KEY = 'alphatrade_live_trade_strip_open';
const loadStripOpen = () => {
  try { return localStorage.getItem(STRIP_OPEN_KEY) === '1'; } catch { return false; }
};

/** Počítač: pruh skupiny nad tabulkou účtů; s `expandable` se rozbalí po účtech. */
export const LiveTradeStrip = ({ model, expandable, label }: {
  model: TradeCardModel;
  expandable: boolean;
  label: (account: TradeCardAccount) => string;
}) => {
  const [open, setOpen] = useState(loadStripOpen);
  const stopFlash = useChangeFlash(levelKey(model, 'stop'));
  const targetFlash = useChangeFlash(levelKey(model, 'target'));
  const ratio = tradeCardRatio(model);
  const expanded = expandable && open;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(STRIP_OPEN_KEY, next ? '1' : '0'); } catch { /* jen pohodlí */ }
  };
  const content = <>
    <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
      <SideBadge model={model} />
      <b className="text-sm font-black">{futuresSymbolRoot(model.symbol)}</b>
      <span className="text-xs font-bold tabular-nums text-[var(--text-secondary)]">{model.quantity} ks{model.kind === 'pending' && model.entry != null ? ` @ ${priceFmt.format(model.entry)}` : ''}</span>
    </span>
    <span className="h-8 w-px shrink-0 bg-[var(--border-subtle)]" />
    {model.kind === 'position'
      ? <KV label="P&L" value={signedUsd(model.openPnl)} valueClass={tone(model.openPnl)} />
      : <KV label="Stav" value="čeká na fill" valueClass="text-[var(--text-secondary)]" />}
    <KV label="SL" value={levelValue(model.stop, model.verified)} valueClass={tone(model.stop.usd)} sub={signedPoints(model.stop.points)} flash={stopFlash} />
    <KV label="TP" value={levelValue(model.target, model.verified)} valueClass={tone(model.target.usd)} sub={signedPoints(model.target.points)} flash={targetFlash} />
    {ratio ? <KV label="R:R" value={ratio} /> : null}
    <span className="ml-auto flex shrink-0 items-center gap-2">
      <CoverageChip model={model} />
      {expandable ? <ChevronDown aria-hidden="true" size={16} className={`text-[var(--text-secondary)] transition-transform ${expanded ? 'rotate-180' : ''}`} /> : null}
    </span>
  </>;
  return (
    <section className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]" aria-label="Aktuální obchod skupiny">
      {expandable ? (
        <button type="button" onClick={toggle} aria-expanded={expanded} className="flex w-full items-center gap-4 overflow-x-auto px-3.5 py-2.5 text-left">
          {content}
        </button>
      ) : (
        <div className="flex w-full items-center gap-4 overflow-x-auto px-3.5 py-2.5">{content}</div>
      )}
      {expandable ? (
        <div className={`grid transition-[grid-template-rows] duration-300 ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="min-h-0 overflow-hidden">
            <div className="border-t border-[var(--border-subtle)]"><AccountBreakdown model={model} label={label} /></div>
          </div>
        </div>
      ) : null}
    </section>
  );
};

/** Stupnice SL → vstup → TP s cenou. SL je vždy vlevo, i u shortu. */
const Ladder = ({ model }: { model: TradeCardModel }) => {
  const { stop, target } = model.ladder;
  const entry = model.entry;
  if (stop == null || target == null || entry == null) return null;
  const levels = [stop, target, entry, ...(model.mark != null ? [model.mark] : [])];
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  if (hi <= lo) return null;
  const at = (value: number) => {
    const ratio = (value - lo) / (hi - lo);
    return `${(model.direction > 0 ? ratio : 1 - ratio) * 100}%`;
  };
  const locked = (stop - entry) * model.direction >= 0;
  const split = parseFloat(at(entry));
  return (
    <div className="relative mx-1 mt-3 h-8" aria-hidden="true">
      <span
        className="absolute inset-x-0 top-[14px] h-1.5 rounded-full"
        style={{ background: locked
          ? 'rgba(16,185,129,.55)'
          : `linear-gradient(90deg, rgba(244,63,94,.55) 0 ${split}%, rgba(16,185,129,.55) ${split}% 100%)` }}
      />
      <span className="absolute top-[7px] h-5 w-0.5 -translate-x-1/2 rounded bg-[var(--text-secondary)]" style={{ left: at(stop) }} />
      <span className="absolute -top-1.5 -translate-x-1/2 text-[9.5px] font-black text-[var(--text-muted)]" style={{ left: at(stop) }}>SL</span>
      <span className="absolute top-[7px] h-5 w-0.5 -translate-x-1/2 rounded bg-[var(--text-primary)]" style={{ left: at(entry) }} />
      <span className="absolute top-[7px] h-5 w-0.5 -translate-x-1/2 rounded bg-[var(--text-secondary)]" style={{ left: at(target) }} />
      <span className="absolute -top-1.5 -translate-x-1/2 text-[9.5px] font-black text-[var(--text-muted)]" style={{ left: at(target) }}>TP</span>
      {model.mark != null ? (
        <span className="absolute top-2 h-[18px] w-3.5 -translate-x-1/2 rounded bg-indigo-500 shadow-[0_0_0_3px_rgba(99,102,241,.25)] transition-[left] duration-500" style={{ left: at(model.mark) }} />
      ) : null}
    </div>
  );
};

/** Telefon: karta se stupnicí, klepnutím SL/TP po účtech. */
export const LiveTradeCompactCard = ({ model, label }: {
  model: TradeCardModel;
  label: (account: TradeCardAccount) => string;
}) => {
  const [open, setOpen] = useState(false);
  const stopFlash = useChangeFlash(levelKey(model, 'stop'));
  const targetFlash = useChangeFlash(levelKey(model, 'target'));
  const avgPoints = model.mark != null && model.entry != null ? (model.mark - model.entry) * model.direction : null;
  const levelBox = (name: 'SL' | 'TP', level: TradeCardLevel, flash: boolean) => (
    <span className={`block rounded-md px-2.5 py-2 transition-colors duration-700 ${flash ? 'bg-amber-500/25' : 'bg-slate-500/10'}`}>
      <span className="block text-[9.5px] font-black uppercase tracking-[0.08em] text-[var(--text-muted)]">{name}</span>
      <span className={`block text-[17px] font-black tabular-nums ${tone(level.usd)}`}>{levelValue(level, model.verified)}</span>
      <span className="block text-[11px] font-semibold tabular-nums text-[var(--text-secondary)]">{signedPoints(level.points) ?? (level.coverage > 0 ? 'víc úrovní' : 'žádný')}</span>
    </span>
  );
  return (
    <section className="border-b border-[var(--border-subtle)]" aria-label="Aktuální obchod skupiny">
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} className="block w-full px-3 pb-2.5 pt-3 text-left">
        <span className="flex items-center gap-2">
          <SideBadge model={model} />
          <b className="text-[14px] font-black">{futuresSymbolRoot(model.symbol)} · {model.quantity} ks</b>
          <span className="ml-auto"><CoverageChip model={model} /></span>
        </span>
        {model.kind === 'position' ? (
          <span className="mt-1.5 flex items-baseline gap-2">
            <b className={`text-[28px] font-black tabular-nums tracking-tight ${tone(model.openPnl)}`}>{signedUsd(model.openPnl)}</b>
            {avgPoints != null ? <span className="text-xs font-bold tabular-nums text-[var(--text-secondary)]">{signedPoints(avgPoints)}</span> : null}
          </span>
        ) : (
          <span className="mt-1.5 block text-[13px] font-bold tabular-nums text-[var(--text-secondary)]">
            Čeká na fill{model.entry != null ? ` @ ${priceFmt.format(model.entry)}` : ''}
          </span>
        )}
        <Ladder model={model} />
        <span className="mt-2 grid grid-cols-2 gap-2">
          {levelBox('SL', model.stop, stopFlash)}
          {levelBox('TP', model.target, targetFlash)}
        </span>
        <span className="mt-2 flex items-center justify-center gap-1 text-[11px] font-bold text-[var(--text-muted)]">
          {open ? 'Skrýt účty' : 'SL/TP po účtech'}
          <ChevronDown aria-hidden="true" size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      <div className={`grid transition-[grid-template-rows] duration-300 ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="min-h-0 overflow-hidden">
          <div className="px-3 pb-3">
            <div className="grid grid-cols-[minmax(0,1fr)_56px_66px_66px] gap-1.5 border-t border-[var(--border-subtle)] pb-1.5 pt-2 text-[9.5px] font-black uppercase tracking-[0.07em] text-[var(--text-muted)]">
              <span>Účet</span>
              <span className="text-right">{model.kind === 'position' ? 'P&L' : 'Vstup'}</span>
              <span className="text-right">SL</span>
              <span className="text-right">TP</span>
            </div>
            {model.accounts.map(account => (
              <div key={account.accountId} className="grid grid-cols-[minmax(0,1fr)_56px_66px_66px] items-start gap-1.5 border-t border-[var(--border-subtle)] py-2 text-[12px] font-black tabular-nums">
                <span className="min-w-0 truncate">
                  {label(account)}{account.isLeader ? <span className="ml-1 text-[var(--text-muted)]">L</span> : null}
                  <span className="block text-[10px] font-semibold text-[var(--text-muted)]">{account.entry == null ? '—' : priceFmt.format(account.entry)}</span>
                </span>
                <span className={`text-right ${model.kind === 'position' ? tone(account.openPnl) : 'text-[var(--text-secondary)]'}`}>
                  {model.kind === 'position' ? signedUsd(account.openPnl) : `${account.quantity} ks`}
                </span>
                <span className="text-right">{accountCell(account.stop, account)}</span>
                <span className="text-right">{accountCell(account.target, account)}</span>
              </div>
            ))}
            <p className="border-t border-[var(--border-subtle)] pt-2 text-[10.5px] font-semibold leading-snug text-[var(--text-muted)]">{feeNote(model)}</p>
          </div>
        </div>
      </div>
    </section>
  );
};
