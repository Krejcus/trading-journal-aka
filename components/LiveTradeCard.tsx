import React, { useEffect, useRef, useState } from 'react';
import type { TradeCardAccount, TradeCardLevel, TradeCardModel } from '../lib/liveTradeCard';
import { tradeCardTvLegs } from '../lib/tvLivePnl';
import { futuresSymbolRoot, pointValueUsd } from '../services/futuresContractSpecs';
import { LiveOpenPnlValue, LivePriceSourceTag, LiveTvMark, TV_LIVE_PNL_TITLE } from './LiveOpenPnlValue';

/**
 * SL/TP aktuálního obchodu skupiny (jen zobrazení, posouvají se v Tradovate).
 * Počítač: sloupce SL a TP v řádku skupiny i v řádcích účtů.
 * Telefon: karta se stupnicí nad účty a SL/TP v řádcích účtů v trhu.
 */

const wholeUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const centsUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pointsFmt = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const priceFmt = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const signedUsd = (value: number | null) => value == null
  ? '—'
  : `${value > 0 ? '+' : value < 0 ? '−' : ''}${wholeUsd.format(Math.abs(value))}`;
const signedPoints = (value: number | null) => value == null
  ? null
  : `${value > 0 ? '+' : value < 0 ? '−' : ''}${pointsFmt.format(Math.abs(value))} b`;
const tone = (value: number | null) => value == null || value === 0
  ? 'text-[var(--text-primary)]'
  : value > 0 ? 'text-emerald-500' : 'text-rose-500';

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

const accountCell = (level: TradeCardLevel, account: TradeCardAccount) => {
  if (!account.ordersVerified) return <span className="text-[var(--text-muted)]">?</span>;
  if (level.coverage === 0) return <span className="text-[var(--text-muted)]">—</span>;
  if (!level.exact) return <span className="text-amber-600" title="Úroveň nekryje celou pozici">{level.coverage}/{account.quantity}</span>;
  return <>
    <span className={tone(level.usd)}>{signedUsd(level.usd)}</span>
    <span className="block text-[10.5px] font-semibold text-[var(--text-muted)]">{level.price == null ? 'víc úrovní' : signedPoints(level.points)}</span>
  </>;
};

const accountLevelKey = (account: TradeCardAccount, level: 'stop' | 'target') =>
  `${account[level].price ?? '-'}:${account[level].coverage}`;

/** Buňka SL/TP v řádku účtu; po posunu v Tradovate krátce blikne. */
export const TradeLevelCell = ({ account, level }: { account: TradeCardAccount; level: 'stop' | 'target' }) => {
  const flash = useChangeFlash(accountLevelKey(account, level));
  return (
    <span className={`inline-flex flex-col items-end rounded px-1 text-xs font-bold tabular-nums transition-colors duration-700 ${flash ? 'bg-amber-500/25' : 'bg-transparent'}`}>
      {accountCell(account[level], account)}
    </span>
  );
};

/**
 * Součet SL/TP celé skupiny v řádku skupiny. Neúplné krytí ukáže počet
 * krytých účtů místo částky; čekající vstup dostane poznámku.
 */
export const GroupTradeLevelCell = ({ model, level }: { model: TradeCardModel | null; level: 'stop' | 'target' }) => {
  const flash = useChangeFlash(model ? levelKey(model, level) : null);
  if (!model) return <span className="text-xs text-[var(--text-secondary)]">—</span>;
  const value = model[level];
  const covered = level === 'stop' ? model.stopCovered : model.targetCovered;
  const total = model.accounts.length;
  const body = !model.verified
    ? <span className="text-[var(--text-muted)]" title="Příkazy nejsou čerstvě ověřené">?</span>
    : value.usd != null
      ? <>
          <span className={tone(value.usd)}>{signedUsd(value.usd)}</span>
          <span className="block text-[10px] font-semibold text-[var(--text-muted)]">
            {model.kind === 'pending' ? 'čeká na fill' : signedPoints(value.points) ?? 'víc úrovní'}
          </span>
        </>
      : covered > 0
        ? <span className="text-amber-600" title="Ne všechny účty mají úroveň přes celou pozici">{covered}/{total} účtů</span>
        : <span className={level === 'stop' && model.kind === 'position' ? 'text-rose-500' : 'text-[var(--text-muted)]'}>{level === 'stop' && model.kind === 'position' ? 'bez SL' : '—'}</span>;
  return (
    <span
      className={`inline-flex flex-col items-end rounded px-1 text-xs font-bold tabular-nums transition-colors duration-700 ${flash ? 'bg-amber-500/25' : 'bg-transparent'}`}
      title={model.verified && value.usd != null ? feeNote(model) : undefined}
    >{body}</span>
  );
};

/** SL/TP v druhém řádku účtu v trhu na telefonu. */
export const TradeLevelInline = ({ account }: { account: TradeCardAccount }) => {
  const part = (name: string, level: TradeCardLevel) => {
    if (!account.ordersVerified) return <span className="text-[var(--text-muted)]">{name} ?</span>;
    if (level.coverage === 0) return <span className="text-[var(--text-muted)]">{name} —</span>;
    if (!level.exact) return <span className="text-amber-600">{name} {level.coverage}/{account.quantity}</span>;
    return <span className={tone(level.usd)}>{name} {signedUsd(level.usd)}</span>;
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-black tabular-nums">
      {part('SL', account.stop)}
      <span className="text-[var(--text-muted)]">·</span>
      {part('TP', account.target)}
    </span>
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

/** Telefon: karta se stupnicí nad účty; SL/TP po účtech jsou v jejich řádcích. */
export const LiveTradeCompactCard = ({ model }: { model: TradeCardModel }) => {
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
    <section className="border-b border-[var(--border-subtle)] px-3 pb-2.5 pt-3" aria-label="Aktuální obchod skupiny">
      <div className="flex items-center gap-2">
        <SideBadge model={model} />
        <b className="text-[14px] font-black">{futuresSymbolRoot(model.symbol)} · {model.quantity} ks</b>
        <span className="ml-auto"><CoverageChip model={model} /></span>
      </div>
      {model.kind === 'position' && model.openPnl != null ? (
        // Hlavní číslo karty se hýbe s cenou z TV (jen zobrazení); stupnice a SL/TP zůstávají z kotvy.
        <LiveOpenPnlValue anchor={model.openPnl} legs={tradeCardTvLegs(model)}>
          {(value, live) => {
            const pointValue = pointValueUsd(model.symbol);
            const points = avgPoints != null && pointValue != null && model.quantity > 0
              ? avgPoints + (value - model.openPnl!) / (model.quantity * pointValue)
              : avgPoints;
            return (
              <div className="mt-1.5 flex items-baseline gap-2" title={live ? TV_LIVE_PNL_TITLE : undefined}>
                <b className={`text-[28px] font-black tabular-nums tracking-tight ${tone(value)}`}>{signedUsd(value)}</b>
                {points != null ? <span className="text-xs font-bold tabular-nums text-[var(--text-secondary)]">{signedPoints(points)}</span> : null}
                {live ? <span className="ml-auto inline-flex items-center gap-1 self-center text-[10px] font-black uppercase tracking-[0.08em] text-indigo-500"><LiveTvMark /><LivePriceSourceTag /></span> : null}
              </div>
            );
          }}
        </LiveOpenPnlValue>
      ) : model.kind === 'position' ? (
        <div className="mt-1.5 flex items-baseline gap-2">
          <b className={`text-[28px] font-black tabular-nums tracking-tight ${tone(model.openPnl)}`}>{signedUsd(model.openPnl)}</b>
          {avgPoints != null ? <span className="text-xs font-bold tabular-nums text-[var(--text-secondary)]">{signedPoints(avgPoints)}</span> : null}
        </div>
      ) : (
        <div className="mt-1.5 text-[13px] font-bold tabular-nums text-[var(--text-secondary)]">
          Čeká na fill{model.entry != null ? ` @ ${priceFmt.format(model.entry)}` : ''}
        </div>
      )}
      <Ladder model={model} />
      <div className="mt-2 grid grid-cols-2 gap-2">
        {levelBox('SL', model.stop, stopFlash)}
        {levelBox('TP', model.target, targetFlash)}
      </div>
      <p className="mt-2 text-[10.5px] font-semibold leading-snug text-[var(--text-muted)]">{feeNote(model)}</p>
    </section>
  );
};
