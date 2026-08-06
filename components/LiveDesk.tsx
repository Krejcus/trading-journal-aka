import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  CopyCheck,
  Database,
  Gauge,
  Layers3,
  Link2,
  ListRestart,
  Loader2,
  RadioTower,
  RefreshCw,
  ShieldAlert,
  Unplug,
  WalletCards,
  X,
} from 'lucide-react';
import {
  loadTradecopiaLiveEvents,
  loadTradecopiaLiveOrders,
  loadTradecopiaLiveOverview,
  updateTradecopiaLiveMapping,
  type LiveAccount,
  type LiveEvent,
  type LiveOrder,
  type LiveSnapshot,
} from '../services/tradecopiaLiveService';
import LiveCopyTradeOverview from './LiveCopyTradeOverview';

type LiveTab = 'overview' | 'accounts' | 'orders' | 'events';

interface LiveDeskProps {
  theme: 'dark' | 'light' | 'oled';
}

const money = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 });
const time = new Intl.DateTimeFormat('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTime = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

const signedMoney = (value: number) => `${value > 0 ? '+' : ''}${money.format(value)}`;
const pnlColor = (value: number) => value > 0 ? 'text-emerald-500' : value < 0 ? 'text-rose-500' : 'text-[var(--text-secondary)]';

const ageSeconds = (date: string | null | undefined, now: number) => {
  if (!date) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((now - new Date(date).getTime()) / 1000));
};

const freshness = (age: number) => age <= 90
  ? { label: 'ŽIVÁ DATA', dot: 'bg-emerald-500', text: 'text-emerald-500' }
  : age <= 180
    ? { label: 'DATA SE ZPOŽĎUJÍ', dot: 'bg-amber-500', text: 'text-amber-500' }
    : { label: 'SBĚR JE MIMO', dot: 'bg-rose-500', text: 'text-rose-500' };

const formatAge = (age: number) => {
  if (!Number.isFinite(age)) return 'bez dat';
  if (age <= 1) return 'právě teď';
  if (age < 60) return `před ${age} s`;
  return `před ${Math.floor(age / 60)} min`;
};

const LiveDesk: React.FC<LiveDeskProps> = () => {
  const [tab, setTab] = useState<LiveTab>('overview');
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [manualRefreshState, setManualRefreshState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [lastManualRefreshAt, setLastManualRefreshAt] = useState<number | null>(null);
  const [secondaryLoading, setSecondaryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<LiveAccount | null>(null);
  const [mappingSavingId, setMappingSavingId] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  const loadOverview = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await loadTradecopiaLiveOverview();
      setSnapshot(next);
      setError(null);
      setSelectedAccount(current => current ? next.accounts.find(account => account.id === current.id) ?? null : null);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'LIVE data se nepodařilo načíst.');
      return false;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const handleManualRefresh = useCallback(async () => {
    if (manualRefreshState === 'loading') return;
    setManualRefreshState('loading');
    const succeeded = await loadOverview();
    if (!succeeded) {
      setManualRefreshState('idle');
      return;
    }
    setLastManualRefreshAt(Date.now());
    setManualRefreshState('done');
    window.setTimeout(() => setManualRefreshState('idle'), 1_200);
  }, [loadOverview, manualRefreshState]);

  const handleMappingChange = useCallback(async (account: LiveAccount, mappedAccountId: string | null) => {
    if (!account.mapRowId || mappingSavingId != null) return;
    setMappingSavingId(account.id);
    try {
      const saved = await updateTradecopiaLiveMapping(account.mapRowId, mappedAccountId);
      if (!saved) throw new Error('Přiřazení účtu se nepodařilo uložit.');
      await loadOverview(true);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Přiřazení účtu se nepodařilo uložit.');
    } finally {
      setMappingSavingId(null);
    }
  }, [loadOverview, mappingSavingId]);

  useEffect(() => {
    void loadOverview();
    const refresh = window.setInterval(() => void loadOverview(true), 5_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(refresh);
      window.clearInterval(clock);
    };
  }, [loadOverview]);

  const accountNamesJson = JSON.stringify(snapshot?.accounts.map(account => [account.id, account.name]) ?? []);
  const overviewReady = snapshot != null;

  const refreshOrders = useCallback(async (quiet = false) => {
    if (!overviewReady) return;
    if (!quiet) setSecondaryLoading(true);
    try {
      const accountNames = new Map<number, string>(JSON.parse(accountNamesJson) as Array<[number, string]>);
      const next = await loadTradecopiaLiveOrders(accountNames);
      setOrders(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Příkazy se nepodařilo načíst.');
    } finally {
      if (!quiet) setSecondaryLoading(false);
    }
  }, [accountNamesJson, overviewReady]);

  useEffect(() => {
    if (!overviewReady || (tab !== 'overview' && tab !== 'orders' && tab !== 'events')) return;
    let active = true;
    const accountNames = new Map<number, string>(JSON.parse(accountNamesJson) as Array<[number, string]>);
    const load = async (quiet = false) => {
      if (!quiet) setSecondaryLoading(true);
      try {
        if (tab === 'overview' || tab === 'orders') {
          const next = await loadTradecopiaLiveOrders(accountNames);
          if (active) setOrders(next);
        } else {
          const next = await loadTradecopiaLiveEvents(accountNames);
          if (active) setEvents(next);
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Detailní LIVE data se nepodařilo načíst.');
      } finally {
        if (active && !quiet) setSecondaryLoading(false);
      }
    };
    void load();
    const interval = window.setInterval(() => void load(true), tab === 'overview' || tab === 'orders' ? 5_000 : 10_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [tab, overviewReady, accountNamesJson]);

  const capturedAt = snapshot?.run?.completed_at ?? snapshot?.run?.captured_at;
  const dataAge = ageSeconds(capturedAt, now);
  const manualRefreshAge = lastManualRefreshAt == null ? null : Math.max(0, Math.round((now - lastManualRefreshAt) / 1_000));
  const status = freshness(dataAge);
  const tabs: Array<{ id: LiveTab; label: string; icon: React.ElementType }> = [
    { id: 'overview', label: 'Přehled', icon: Gauge },
    { id: 'accounts', label: 'Účty', icon: WalletCards },
    { id: 'orders', label: 'Pozice a příkazy', icon: ListRestart },
    { id: 'events', label: 'Události', icon: Clock3 },
  ];

  if (loading && !snapshot) {
    return <div className="min-h-[60vh] flex items-center justify-center"><Loader2 className="animate-spin text-blue-500" size={32} /></div>;
  }

  return (
    <div className="max-w-[1500px] mx-auto space-y-5 animate-in fade-in duration-300">
      <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
        <div className="p-5 lg:p-6 flex flex-col xl:flex-row xl:items-center gap-4 justify-between">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-12 h-12 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 flex items-center justify-center shrink-0">
              <RadioTower size={23} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-black text-[var(--text-primary)]">LIVE CONTROL</h2>
                <span className="px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-[0.18em] bg-indigo-500/10 text-indigo-500">OAuth ready</span>
              </div>
              <p className="text-sm text-[var(--text-secondary)] mt-1">Živý přehled účtů a kompletní ovládání připravené pro naše OAuth API.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="px-4 py-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${status.dot} ${dataAge <= 90 ? 'animate-pulse' : ''}`} />
              <div>
                <div className={`text-[10px] font-black tracking-[0.16em] ${status.text}`}>{status.label}</div>
                <div className="text-[10px] text-[var(--text-secondary)]">Zdroj {formatAge(dataAge)} · {snapshot?.accounts.length ?? 0} účtů</div>
                {manualRefreshAge != null && <div className="text-[9px] font-bold text-blue-500 mt-0.5">Ručně ověřeno {formatAge(manualRefreshAge)}</div>}
              </div>
            </div>
            <button
              onClick={() => void handleManualRefresh()}
              disabled={manualRefreshState === 'loading'}
              aria-label={manualRefreshState === 'loading' ? 'Obnovuji LIVE data' : manualRefreshState === 'done' ? 'LIVE data obnovena' : 'Obnovit LIVE data'}
              className={`w-11 h-11 rounded-md border bg-[var(--bg-page)] transition-all flex items-center justify-center disabled:cursor-wait ${manualRefreshState === 'done' ? 'border-emerald-500/35 text-emerald-500 bg-emerald-500/10' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-blue-500 hover:border-blue-500/30'}`}
              title={manualRefreshState === 'loading' ? 'Obnovuji…' : manualRefreshState === 'done' ? 'Obnoveno' : 'Obnovit LIVE data'}
            >
              {manualRefreshState === 'done' ? <CheckCircle2 size={19} /> : <RefreshCw size={18} className={manualRefreshState === 'loading' ? 'animate-spin text-blue-500' : ''} />}
            </button>
          </div>
        </div>
        <div className="px-3 lg:px-5 pb-3 overflow-x-auto no-scrollbar">
          <div className="flex gap-2 min-w-max">
            {tabs.map(item => {
              const Icon = item.icon;
              return (
                <button key={item.id} onClick={() => setTab(item.id)} className={`px-4 py-2.5 rounded-md flex items-center gap-2 text-xs font-black uppercase tracking-wider transition-all ${tab === item.id ? 'bg-blue-600 text-white shadow-sm' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-page)]'}`}>
                  <Icon size={15} />{item.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-4 flex items-center gap-3 text-rose-500">
          <AlertTriangle size={18} className="shrink-0" />
          <span className="text-sm font-semibold flex-1">{error}</span>
          <button onClick={() => void loadOverview()} className="text-xs font-black uppercase">Zkusit znovu</button>
        </div>
      )}

      {tab === 'overview' && snapshot && (
        <LiveCopyTradeOverview snapshot={snapshot} orders={orders} onRefreshOrders={refreshOrders} onAccount={setSelectedAccount} />
      )}

      {tab === 'accounts' && snapshot && (
        <Accounts accounts={snapshot.accounts} onAccount={setSelectedAccount} />
      )}

      {tab === 'orders' && snapshot && (
        <Orders accounts={snapshot.accounts} orders={orders} loading={secondaryLoading} />
      )}

      {tab === 'events' && (
        <Events events={events} loading={secondaryLoading} />
      )}

      {selectedAccount && snapshot && (
        <AccountDetail
          account={selectedAccount}
          appAccounts={snapshot.appAccounts}
          mappingSaving={mappingSavingId === selectedAccount.id}
          onMappingChange={mappedAccountId => void handleMappingChange(selectedAccount, mappedAccountId)}
          onClose={() => setSelectedAccount(null)}
        />
      )}
    </div>
  );
};

const MetricCard = ({ label, value, sub, icon: Icon, valueClass = 'text-[var(--text-primary)]' }: { label: string; value: string; sub: string; icon: React.ElementType; valueClass?: string }) => (
  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 min-h-[142px] flex flex-col justify-between">
    <div className="flex justify-between items-start gap-3">
      <span className="text-[10px] font-black uppercase tracking-[0.16em] text-[var(--text-secondary)]">{label}</span>
      <span className="w-9 h-9 rounded-xl bg-blue-500/10 text-blue-500 flex items-center justify-center"><Icon size={17} /></span>
    </div>
    <div><div className={`text-2xl lg:text-3xl font-black tabular-nums ${valueClass}`}>{value}</div><div className="text-xs text-[var(--text-secondary)] mt-1">{sub}</div></div>
  </div>
);

const AccountMini = ({ account, onClick }: { account: LiveAccount; onClick: () => void }) => {
  const open = account.positions.filter(position => position.netPosition !== 0);
  return (
    <button onClick={onClick} className="text-left rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] p-4 hover:border-blue-500/35 hover:bg-blue-500/[0.025] transition-colors group">
      <div className="flex justify-between gap-3"><div className="min-w-0"><div className="font-black text-sm text-[var(--text-primary)] truncate">{account.name}</div><div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] mt-1">{account.firm}{account.phase ? ` · ${account.phase}` : ''}</div><div className={`text-[10px] font-bold mt-1.5 truncate ${account.mappedAccountName ? 'text-blue-500' : 'text-amber-500'}`}>{account.mappedAccountName ? `AlphaTrade → ${account.mappedAccountName}` : account.mappingStatus === 'ignored' ? 'V AlphaTrade ignorováno' : 'Nepřiřazeno k AlphaTrade'}</div></div><ChevronRight size={17} className="text-[var(--text-secondary)] group-hover:text-blue-500" /></div>
      <div className="mt-4 flex items-end justify-between gap-3"><div><div className="text-[9px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Equity</div><div className="font-black tabular-nums text-[var(--text-primary)]">{money.format(account.equity)}</div></div><div className="text-right"><div className="text-[9px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Pozice</div><div className={`text-xs font-black ${open.length ? 'text-blue-500' : 'text-[var(--text-secondary)]'}`}>{open.length ? open.map(position => `${position.netPosition > 0 ? '+' : ''}${position.netPosition} ${position.symbol}`).join(', ') : 'FLAT'}</div></div></div>
    </button>
  );
};

const Accounts = ({ accounts, onAccount }: { accounts: LiveAccount[]; onAccount: (account: LiveAccount) => void }) => (
  <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
    <div className="p-5 lg:p-6 border-b border-[var(--border-subtle)]"><h3 className="font-black text-[var(--text-primary)]">ÚČTY ({accounts.length})</h3><p className="text-xs text-[var(--text-secondary)] mt-1">Balance, živá equity, pozice a dostupná rezerva k EOD drawdownu</p></div>
    <div className="hidden lg:grid grid-cols-[1.5fr_.8fr_.8fr_.75fr_.75fr_24px] gap-4 px-6 py-3 text-[9px] font-black uppercase tracking-[0.14em] text-[var(--text-secondary)]"><span>Účet</span><span>Balance / equity</span><span>Realizované</span><span>Live P&L</span><span>Rezerva</span><span /></div>
    <div className="divide-y divide-[var(--border-subtle)]">
      {accounts.map(account => (
        <button key={account.id} onClick={() => onAccount(account)} className="w-full grid lg:grid-cols-[1.5fr_.8fr_.8fr_.75fr_.75fr_24px] gap-3 lg:gap-4 p-5 lg:px-6 items-center text-left hover:bg-blue-500/[0.035] transition-colors group">
          <div><div className="font-black text-sm text-[var(--text-primary)]">{account.name}</div><div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] mt-1">{account.firm}{account.phase ? ` · ${account.phase}` : ''}</div><div className={`text-[10px] font-bold mt-1 ${account.mappedAccountName ? 'text-blue-500' : 'text-amber-500'}`}>{account.mappedAccountName ? `AlphaTrade → ${account.mappedAccountName}` : account.mappingStatus === 'ignored' ? 'V AlphaTrade ignorováno' : 'Nepřiřazeno k AlphaTrade'}</div></div>
          <MobileMetric label="Balance / equity"><span className="font-bold tabular-nums text-[var(--text-primary)]">{money.format(account.balance)}</span><span className="block text-xs text-[var(--text-secondary)]">{money.format(account.equity)}</span></MobileMetric>
          <MobileMetric label="Realizované"><span className={`font-black tabular-nums ${pnlColor(account.realizedPnl)}`}>{signedMoney(account.realizedPnl)}</span></MobileMetric>
          <MobileMetric label="Live P&L"><span className={`font-black tabular-nums ${pnlColor(account.unrealizedPnl)}`}>{signedMoney(account.unrealizedPnl)}</span></MobileMetric>
          <MobileMetric label="Rezerva"><span className={`font-black tabular-nums ${account.cushion != null && account.cushion <= 500 ? 'text-rose-500' : 'text-[var(--text-primary)]'}`}>{account.cushion == null ? '—' : money.format(account.cushion)}</span></MobileMetric>
          <ChevronRight size={17} className="hidden lg:block text-[var(--text-secondary)] group-hover:text-blue-500" />
        </button>
      ))}
    </div>
  </section>
);

const MobileMetric = ({ label, children }: { label: string; children: React.ReactNode }) => <div><div className="lg:hidden text-[9px] font-black uppercase tracking-wider text-[var(--text-secondary)] mb-1">{label}</div>{children}</div>;

const Orders = ({ accounts, orders, loading }: { accounts: LiveAccount[]; orders: LiveOrder[]; loading: boolean }) => {
  const openPositions = accounts.flatMap(account => account.positions.filter(position => position.netPosition !== 0).map(position => ({ account, position })));
  return (
    <div className="space-y-5">
      <div className="grid md:grid-cols-3 gap-3">
        <MetricCard label="Otevřené pozice" value={String(openPositions.length)} sub="Napříč načtenými účty" icon={Layers3} />
        <MetricCard label="Pracující příkazy" value={String(orders.filter(order => order.working).length)} sub="Limit, stop a další aktivní" icon={Activity} />
        <MetricCard label="Načtené příkazy" value={String(orders.length)} sub="Posledních 300 záznamů" icon={Database} />
      </div>
      <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 lg:p-6">
        <div className="flex items-center justify-between mb-4"><div><h3 className="font-black text-[var(--text-primary)]">OTEVŘENÉ POZICE</h3><p className="text-xs text-[var(--text-secondary)] mt-1">Aktuální net pozice a živé P&L</p></div></div>
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
          {openPositions.length === 0 && <Empty text="Všechny účty jsou aktuálně flat." />}
          {openPositions.map(({ account, position }) => (
            <div key={`${account.id}-${position.symbol}`} className="rounded-md border border-blue-500/20 bg-blue-500/[0.045] p-4">
              <div className="flex items-start justify-between gap-3"><div><div className="font-black text-[var(--text-primary)]">{position.symbol}</div><div className="text-xs text-[var(--text-secondary)] mt-1">{account.name}</div></div><span className={`px-2 py-1 rounded-lg text-[10px] font-black ${position.netPosition > 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>{position.netPosition > 0 ? 'LONG' : 'SHORT'} {Math.abs(position.netPosition)}</span></div>
              <div className="grid grid-cols-2 gap-3 mt-4"><div><div className="text-[9px] uppercase font-black text-[var(--text-secondary)]">Průměrná cena</div><div className="font-bold text-sm text-[var(--text-primary)] mt-1">{position.netPrice == null ? '—' : number.format(position.netPrice)}</div></div><div><div className="text-[9px] uppercase font-black text-[var(--text-secondary)]">Live P&L</div><div className={`font-black text-sm mt-1 ${pnlColor(position.unrealizedPnl)}`}>{signedMoney(position.unrealizedPnl)}</div></div></div>
            </div>
          ))}
        </div>
      </section>
      <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
        <div className="p-5 lg:p-6 border-b border-[var(--border-subtle)] flex items-center justify-between"><div><h3 className="font-black text-[var(--text-primary)]">PŘÍKAZY</h3><p className="text-xs text-[var(--text-secondary)] mt-1">Pracující příkazy jsou vždy nahoře</p></div>{loading && <Loader2 size={18} className="animate-spin text-blue-500" />}</div>
        <div className="divide-y divide-[var(--border-subtle)]">
          {[...orders].sort((a, b) => Number(b.working) - Number(a.working)).map(order => (
            <div key={`${order.accountId}-${order.id}`} className={`p-4 lg:px-6 grid md:grid-cols-[1.5fr_.7fr_.7fr_.7fr_.8fr] gap-3 items-center ${order.working ? 'bg-blue-500/[0.045]' : ''}`}>
              <div><div className="font-black text-sm text-[var(--text-primary)]">{order.accountName}</div><div className="text-xs text-[var(--text-secondary)] mt-1">{order.symbol} · {order.action} {number.format(order.quantity)}×</div></div>
              <MobileMetric label="Typ"><span className="text-sm font-bold text-[var(--text-primary)]">{order.orderType}</span></MobileMetric>
              <MobileMetric label="Cena"><span className="text-sm font-bold text-[var(--text-primary)]">{order.stopPrice ?? order.price ?? '—'}</span></MobileMetric>
              <MobileMetric label="Stav"><span className={`inline-flex px-2.5 py-1 rounded-lg text-[10px] font-black uppercase ${order.working ? 'bg-blue-500/10 text-blue-500' : order.status.toLowerCase() === 'filled' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-slate-500/10 text-[var(--text-secondary)]'}`}>{order.status}</span></MobileMetric>
              <MobileMetric label="Čas"><span className="text-xs text-[var(--text-secondary)]">{order.updatedAt ? dateTime.format(new Date(order.updatedAt)) : '—'}</span></MobileMetric>
            </div>
          ))}
          {!loading && orders.length === 0 && <Empty text="Žádné příkazy nebyly načteny." />}
        </div>
      </section>
    </div>
  );
};

const Events = ({ events, loading }: { events: LiveEvent[]; loading: boolean }) => (
  <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 lg:p-6">
    <div className="flex items-center justify-between mb-5"><div><h3 className="font-black text-[var(--text-primary)]">UDÁLOSTI</h3><p className="text-xs text-[var(--text-secondary)] mt-1">Změny po prvním výchozím načtení databáze</p></div>{loading && <Loader2 size={18} className="animate-spin text-blue-500" />}</div>
    <div className="relative pl-7 space-y-3 before:absolute before:left-[9px] before:top-2 before:bottom-2 before:w-px before:bg-[var(--border-subtle)]">
      {events.map(event => (
        <div key={event.id} className="relative rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] p-4">
          <span className={`absolute -left-[25px] top-5 w-3 h-3 rounded-full ring-4 ring-[var(--bg-card)] ${event.changeType === 'deleted' ? 'bg-rose-500' : event.changeType === 'inserted' ? 'bg-emerald-500' : 'bg-blue-500'}`} />
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2"><div><div className="text-sm font-black text-[var(--text-primary)]">{event.title}</div><div className="text-xs text-[var(--text-secondary)] mt-1">{event.accountName} · {event.detail}</div></div><div className="text-[10px] font-bold text-[var(--text-secondary)] whitespace-nowrap">{dateTime.format(new Date(event.observedAt))}</div></div>
        </div>
      ))}
      {!loading && events.length === 0 && <Empty text="Od prvního načtení zatím nejsou žádné nové události." />}
    </div>
  </section>
);

const AccountDetail = ({
  account,
  appAccounts,
  mappingSaving,
  onMappingChange,
  onClose,
}: {
  account: LiveAccount;
  appAccounts: LiveSnapshot['appAccounts'];
  mappingSaving: boolean;
  onMappingChange: (mappedAccountId: string | null) => void;
  onClose: () => void;
}) => (
  <div className="fixed inset-0 z-[100] bg-black/65 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-5" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="w-full sm:max-w-3xl max-h-[92vh] overflow-y-auto custom-scrollbar rounded-t-xl sm:rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-2xl">
      <div className="sticky top-0 z-10 p-5 lg:p-6 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] flex items-center justify-between gap-4"><div><div className="text-[10px] font-black uppercase tracking-[0.18em] text-blue-500">Live detail účtu</div><h3 className="text-xl font-black text-[var(--text-primary)] mt-1">{account.name}</h3><div className="text-xs text-[var(--text-secondary)] mt-1">{account.firm}{account.phase ? ` · ${account.phase}` : ''}</div></div><button onClick={onClose} className="w-10 h-10 rounded-xl bg-[var(--bg-page)] text-[var(--text-secondary)] hover:text-rose-500 flex items-center justify-center"><X size={19} /></button></div>
      <div className="p-5 lg:p-6 space-y-5">
        <div className="rounded-md border border-blue-500/20 bg-blue-500/[0.045] p-4">
          <div className="flex items-start gap-3">
            <span className="w-9 h-9 rounded-xl bg-blue-500/10 text-blue-500 flex items-center justify-center shrink-0"><Link2 size={17} /></span>
            <div className="min-w-0 flex-1">
              <label htmlFor={`live-account-map-${account.id}`} className="text-[10px] font-black uppercase tracking-[0.14em] text-blue-500">Účet v AlphaTrade</label>
              <p className="text-[10px] text-[var(--text-secondary)] mt-1 mb-2">Toto propojení používá i import exekucí a AI Coach.</p>
              <div className="relative">
                <select
                  id={`live-account-map-${account.id}`}
                  value={account.mappedAccountId ?? ''}
                  disabled={!account.mapRowId || mappingSaving}
                  onChange={event => onMappingChange(event.target.value || null)}
                  className="w-full appearance-none rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2.5 pr-10 text-sm font-bold text-[var(--text-primary)] outline-none focus:border-blue-500 disabled:opacity-60"
                >
                  <option value="">— nepřiřazeno —</option>
                  {appAccounts.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
                </select>
                {mappingSaving && <Loader2 size={16} className="absolute right-3 top-3 animate-spin text-blue-500" />}
              </div>
              {!account.mapRowId && <div className="text-[10px] text-amber-500 mt-2">Mapovací záznam zatím není dostupný. Obnov LIVE stránku.</div>}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <DetailMetric label="Balance" value={money.format(account.balance)} />
          <DetailMetric label="Equity" value={money.format(account.equity)} />
          <DetailMetric label="Realizované P&L" value={signedMoney(account.realizedPnl)} color={pnlColor(account.realizedPnl)} />
          <DetailMetric label="Live P&L" value={signedMoney(account.unrealizedPnl)} color={pnlColor(account.unrealizedPnl)} />
        </div>
        <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] p-4">
          <div className="flex items-center justify-between mb-4"><div><div className="text-xs font-black text-[var(--text-primary)]">EOD TRAILING DRAWDOWN</div><div className="text-[10px] text-[var(--text-secondary)] mt-1">Jen z ověřených prop-firm parametrů a peak equity</div></div><ShieldAlert size={19} className={account.cushion != null && account.cushion <= 500 ? 'text-rose-500' : 'text-blue-500'} /></div>
          <div className="grid grid-cols-3 gap-3"><DetailMetric label="Peak equity" value={account.peakEquity == null ? '—' : money.format(account.peakEquity)} /><DetailMetric label="Floor" value={account.drawdownFloor == null ? '—' : money.format(account.drawdownFloor)} /><DetailMetric label="Rezerva" value={account.cushion == null ? '—' : money.format(account.cushion)} color={account.cushion != null && account.cushion <= 500 ? 'text-rose-500' : undefined} /></div>
        </div>
        <div><div className="text-xs font-black uppercase tracking-wider text-[var(--text-secondary)] mb-3">Pozice</div><div className="space-y-2">{account.positions.map(position => <div key={position.symbol} className="rounded-md border border-[var(--border-subtle)] p-4 grid grid-cols-2 sm:grid-cols-4 gap-3"><DetailMetric label="Symbol" value={position.symbol} /><DetailMetric label="Net pozice" value={String(position.netPosition)} /><DetailMetric label="Průměr" value={position.netPrice == null ? '—' : number.format(position.netPrice)} /><DetailMetric label="Live P&L" value={signedMoney(position.unrealizedPnl)} color={pnlColor(position.unrealizedPnl)} /></div>)}{account.positions.length === 0 && <Empty text="Účet nemá načtenou pozici." />}</div></div>
        <div className="text-[10px] text-[var(--text-secondary)]">Poslední změna zdroje: {account.updatedAt ? time.format(new Date(account.updatedAt)) : 'neznámá'}</div>
      </div>
    </div>
  </div>
);

const DetailMetric = ({ label, value, color = 'text-[var(--text-primary)]' }: { label: string; value: string; color?: string }) => <div><div className="text-[9px] font-black uppercase tracking-wider text-[var(--text-secondary)]">{label}</div><div className={`text-sm lg:text-base font-black tabular-nums mt-1 ${color}`}>{value}</div></div>;
const Empty = ({ text }: { text: string }) => <div className="col-span-full py-8 text-center text-sm text-[var(--text-secondary)]">{text}</div>;

export default LiveDesk;
