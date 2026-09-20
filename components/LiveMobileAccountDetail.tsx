import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Crown, X, Clock3 } from 'lucide-react';
import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
import type { TradovateAccountDataAccount } from '../lib/tradovateAccountDataTypes';
import { liveBalanceDisplay, liveDailyPnlDisplay } from '../lib/liveBalanceDisplay';
import { isLiveAccountReadVerified } from '../lib/liveReadFreshness';
import { mobileOpenPnl, mobilePosition } from '../lib/liveMobilePresentation';
import { FIRM_LOGOS, firmInitials, firmColor } from '../utils/accountFirm';
import { CopyTradePositionsCell } from './LiveCopyTradeOverview';
import LivePositionOverview, { mobileMoney, mobilePnlColor } from './LivePositionOverview';
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const price = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 });
const money = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '—' : usd.format(n);
const Metric = ({ label, value, pnl = false }: { label: string; value: number | null; pnl?: boolean }) => <div className="min-w-0 p-3"><div className="text-[9px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">{label}</div><b className={`mt-1 block text-xl tabular-nums ${pnl ? mobilePnlColor(value) : 'text-[var(--text-primary)]'}`}>{pnl ? mobileMoney(value) : money(value)}</b></div>;
export default function LiveMobileAccountDetail({ account, history, orders, multiplier = 1, leader = false, dailyPnlPending = false, onClose }: {
  account: LiveAccount; history?: TradovateAccountDataAccount; orders: LiveOrder[]; multiplier?: number; leader?: boolean; dailyPnlPending?: boolean; onClose: () => void;
}) {
  const [tab, setTab] = useState<'overview' | 'orders' | 'history'>('overview');
  const dialog = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  const closeStarted = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeCallback = useRef(onClose);
  useEffect(() => { closeCallback.current = onClose; }, [onClose]);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      clearTimeout(closeTimer.current);
      el?.close();
      document.body.style.overflow = overflow;
    };
  }, []);
  const finishClose = () => {
    clearTimeout(closeTimer.current);
    closeCallback.current();
  };
  const requestClose = () => {
    if (closeStarted.current) return;
    closeStarted.current = true;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finishClose();
      return;
    }
    setClosing(true);
    // Keep the dialog and its focus trap mounted until the exit finishes.
    // The timeout also handles interrupted or disabled CSS animations.
    closeTimer.current = setTimeout(finishClose, 260);
  };
  const firmKey = account.firm.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const logo = FIRM_LOGOS[firmKey];
  const positionsVerified = isLiveAccountReadVerified(account, 'positions');
  const ordersVerified = isLiveAccountReadVerified(account, 'orders');
  const accountOrders = orders.filter(o => o.accountId === account.id);
  const working = accountOrders.filter(o => o.working);
  const positions = account.positions.filter(p => p.netPosition !== 0);
  const balance = liveBalanceDisplay(account);
  const openPnl = mobileOpenPnl(account);
  const orderList = (items: LiveOrder[]) => <div className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
    {items.map(o => <div key={o.id} className="flex items-center gap-2 px-3 py-3 text-xs"><Clock3 size={14} className="shrink-0 text-[var(--text-secondary)]" /><div className="min-w-0 flex-1"><b className={o.action.toLowerCase() === 'buy' ? 'text-emerald-500' : 'text-rose-500'}>{o.action.toUpperCase()} {o.orderType.toUpperCase()}</b><div className="mt-1 text-[10px] text-[var(--text-secondary)]">{o.quantity} {o.symbol} · {o.status}</div></div><b className="font-mono">{(o.stopPrice ?? o.price) != null ? price.format((o.stopPrice ?? o.price)!) : '—'}</b></div>)}
    {!items.length ? <p className="p-3 text-xs text-[var(--text-secondary)]">{ordersVerified ? 'Žádné příkazy.' : 'Příkazy nejsou ověřené.'}</p> : null}
  </div>;
  return createPortal(<dialog ref={dialog} data-closing={closing || undefined}
    onCancel={e => { e.preventDefault(); requestClose(); }}
    onClick={e => { if (e.target === e.currentTarget) requestClose(); }}
    onAnimationEnd={e => { if (e.target === e.currentTarget && e.animationName === 'live-account-sheet-out') finishClose(); }}
    aria-labelledby="mobile-account-name"
    className="live-mobile-account-sheet fixed inset-x-0 m-0 w-full max-w-none overflow-y-auto overscroll-contain rounded-t-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/60">
    <div className="sticky top-0 z-10 bg-[var(--bg-card)]">
      <div className="mx-auto mb-1 mt-2 h-1 w-10 rounded-full bg-[var(--text-muted)]" />
      <header className="flex items-center gap-3 px-4 py-3"><span className="relative shrink-0">{logo ? <img src={logo} alt={account.firm} className="h-10 w-10 rounded-lg object-cover" /> : <span className="flex h-10 w-10 items-center justify-center rounded-lg text-xs text-white" style={{ background: firmColor(firmKey).bg }}>{firmInitials(account.firm)}</span>}{leader ? <Crown size={14} aria-label="Leader účet" className="absolute -right-1 -top-2 text-amber-500" /> : null}</span><div className="min-w-0 flex-1"><h2 id="mobile-account-name" className="truncate text-lg font-black">{account.name}</h2><p className="mt-0.5 text-[10px] text-[var(--text-secondary)]">{[account.accountSize ? `${account.accountSize / 1000}K` : null, account.phase, `Násobek ${multiplier}×`].filter(Boolean).join(' · ')}</p></div><button type="button" autoFocus onClick={requestClose} aria-label="Zavřít detail účtu" className="flex h-11 w-11 shrink-0 items-center justify-center text-[var(--text-secondary)]"><X size={20} /></button></header>
      <nav aria-label="Detail účtu" className="grid grid-cols-3 border-b border-[var(--border-subtle)]">{([['overview', 'Přehled'], ['orders', 'Příkazy'], ['history', 'Historie']] as const).map(([id, label]) => <button type="button" key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)} className={`min-h-11 border-b-2 text-xs font-bold ${tab === id ? 'border-indigo-500 text-indigo-500' : 'border-transparent text-[var(--text-secondary)]'}`}>{label}</button>)}</nav>
    </div>
    <div className="live-mobile-account-sheet-content space-y-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {tab === 'overview' ? <>
        <div className="grid grid-cols-2 rounded-xl border border-[var(--border-subtle)]"><Metric label="Zůstatek" value={balance.value} /><Metric label="Včetně pozice" value={balance.value != null && openPnl != null ? balance.value + openPnl : null} /><Metric label="Dnes realizováno" value={liveDailyPnlDisplay(account, Date.now(), dailyPnlPending).value} pnl /><Metric label="Otevřený P&L" value={openPnl} pnl /></div>
        {positionsVerified ? positions.map(p => <LivePositionOverview key={p.symbol} position={mobilePosition(account, p, orders)} status={<CopyTradePositionsCell accountId={account.id} positions={[p]} orders={orders} positionsVerified={positionsVerified} ordersVerified={ordersVerified} />} />) : <p className="text-xs text-amber-500">Pozice nejsou ověřené.</p>}
        {positionsVerified && !positions.length ? <p className="text-xs text-[var(--text-secondary)]">Bez otevřené pozice.</p> : null}
        <section><h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">Limity účtu</h3><dl className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">{[['Denní limit ztráty', account.dailyLossLimit], ['Hranice účtu', account.drawdownFloor], ['Rezerva k hranici', account.cushion]].map(([label, value]) => <div key={String(label)} className="flex justify-between gap-3 px-3 py-2.5 text-xs"><dt className="text-[var(--text-secondary)]">{label}</dt><dd className="font-bold tabular-nums">{money(value as number | null)}</dd></div>)}</dl></section>
        <section><h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">Pracující příkazy · {ordersVerified ? working.length : 'neověřeno'}</h3>{orderList(ordersVerified ? working : [])}</section>
      </> : tab === 'orders' ? <>{!ordersVerified ? <p className="text-xs text-amber-500">Stav příkazů není ověřený; zobrazeny jsou poslední načtené údaje.</p> : null}{orderList(accountOrders)}</> : <section className="space-y-2">{history?.daily.map(day => <div key={day.tradeDate} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] p-3 text-xs"><div><b>{day.tradeDate}</b><p className="mt-1 text-[10px] text-[var(--text-secondary)]">{day.pairedTradeCount} obchodů · zůstatek {money(day.endingBalance)}</p></div><b className={mobilePnlColor(day.reportedRealizedPnl)}>{mobileMoney(day.reportedRealizedPnl)}</b></div>)}{!history?.daily.length ? <p className="text-xs text-[var(--text-secondary)]">Historie účtu není načtená.</p> : null}</section>}
      <button type="button" onClick={requestClose} className="min-h-11 w-full rounded-lg border border-[var(--border-subtle)] text-xs font-bold text-[var(--text-secondary)]">Zavřít detail</button>
    </div>
  </dialog>, document.body);
}
