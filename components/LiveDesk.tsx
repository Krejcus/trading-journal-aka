import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Clock3,
  Database,
  Gauge,
  Layers3,
  Link2,
  ListRestart,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  ShieldAlert,
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
import {
  beginTradovateOAuth,
  loadTradovateAccountProfiles,
  loadTradovateOAuthStatus,
  runTradovateReadOnlyPreflight,
  type TradovateOAuthStatus,
  type TradovatePreflightResult,
} from '../services/tradovateOAuthConnection';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import LiveCopyTradeOverview from './LiveCopyTradeOverview';
import TradovateAddConnectionModal from './TradovateAddConnectionModal';
import TradovateAccountProfileSetup from './TradovateAccountProfileSetup';

type LiveTab = 'connections' | 'overview' | 'accounts' | 'orders' | 'events';

interface LiveDeskProps {
  theme: 'dark' | 'light' | 'oled';
}

const money = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 });
const time = new Intl.DateTimeFormat('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTime = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

const signedMoney = (value: number) => `${value > 0 ? '+' : ''}${money.format(value)}`;
const pnlColor = (value: number) => value > 0 ? 'text-emerald-500' : value < 0 ? 'text-rose-500' : 'text-[var(--text-secondary)]';
const optionalMoney = (value: number | null) => value == null ? 'nedostupné' : money.format(value);

const LiveDesk: React.FC<LiveDeskProps> = () => {
  const [tab, setTab] = useState<LiveTab>('connections');
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [secondaryLoading, setSecondaryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<LiveAccount | null>(null);
  const [mappingSavingId, setMappingSavingId] = useState<number | null>(null);

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
    if (tab === 'connections') {
      setLoading(false);
      return;
    }
    void loadOverview();
    const refresh = window.setInterval(() => void loadOverview(true), 5_000);
    return () => {
      window.clearInterval(refresh);
    };
  }, [loadOverview, tab]);

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

  const tabs: Array<{ id: LiveTab; label: string; icon: React.ElementType }> = [
    { id: 'connections', label: 'Connections', icon: Link2 },
    { id: 'overview', label: 'Live Dashboard', icon: Gauge },
    { id: 'accounts', label: 'Účty', icon: WalletCards },
    { id: 'orders', label: 'Pozice a příkazy', icon: ListRestart },
    { id: 'events', label: 'Události', icon: Clock3 },
  ];

  if (tab !== 'connections' && loading && !snapshot) {
    return <div className="min-h-[60vh] flex items-center justify-center"><Loader2 className="animate-spin text-blue-500" size={32} /></div>;
  }

  return (
    <div className="max-w-[1500px] mx-auto space-y-4 animate-in fade-in duration-300">
      <nav className="flex items-center gap-1 overflow-x-auto no-scrollbar border-b border-[var(--border-subtle)]" aria-label="LIVE navigace">
        {tabs.map(item => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`px-3.5 py-2.5 flex items-center gap-2 whitespace-nowrap border-b-2 text-xs font-bold transition-colors ${tab === item.id ? 'border-indigo-500 text-indigo-500' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
            >
              <Icon size={14} />{item.label}
            </button>
          );
        })}
      </nav>

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-4 flex items-center gap-3 text-rose-500">
          <AlertTriangle size={18} className="shrink-0" />
          <span className="text-sm font-semibold flex-1">{error}</span>
          <button onClick={() => void loadOverview()} className="text-xs font-black uppercase">Zkusit znovu</button>
        </div>
      )}

      {tab === 'connections' && <TradovateOAuthPanel />}

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

const TradovateOAuthPanel = () => {
  const [oauthStatus, setOauthStatus] = useState<TradovateOAuthStatus | null>(null);
  const [oauthBusy, setOauthBusy] = useState<'status' | 'connect' | 'preflight' | null>('status');
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<TradovatePreflightResult | null>(null);
  const [accountProfiles, setAccountProfiles] = useState<TradovateAccountProfile[]>([]);
  const [profileSetupOpen, setProfileSetupOpen] = useState(false);
  const [addConnectionOpen, setAddConnectionOpen] = useState(false);
  const [connectionExpanded, setConnectionExpanded] = useState(true);

  const refreshOauthStatus = useCallback(async () => {
    setOauthBusy('status');
    try {
      setOauthStatus(await loadTradovateOAuthStatus());
      setOauthError(null);
    } catch (reason) {
      setOauthError(reason instanceof Error ? reason.message : 'Stav Tradovate OAuth se nepodařilo načíst.');
    } finally {
      setOauthBusy(null);
    }
  }, []);

  useEffect(() => {
    void refreshOauthStatus();
    const params = new URLSearchParams(window.location.search);
    if (params.get('tradovate') === 'error') setOauthError('Tradovate OAuth připojení se nepodařilo dokončit.');
    if (params.has('tradovate')) {
      params.delete('tradovate');
      params.delete('reason');
      params.delete('page');
      const suffix = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${suffix ? `?${suffix}` : ''}${window.location.hash}`);
    }
  }, [refreshOauthStatus]);

  const connectOauth = async () => {
    setOauthBusy('connect');
    setOauthError(null);
    try {
      await beginTradovateOAuth();
    } catch (reason) {
      setOauthError(reason instanceof Error ? reason.message : 'Tradovate OAuth se nepodařilo spustit.');
      setOauthBusy(null);
    }
  };

  const runPreflight = async () => {
    setOauthBusy('preflight');
    setOauthError(null);
    try {
      const connectionId = oauthStatus?.connections[0]?.id;
      if (!connectionId) throw new Error('Tradovate připojení nebylo nalezeno.');
      const result = await runTradovateReadOnlyPreflight(connectionId);
      setPreflight(result);
      try {
        const stored = await loadTradovateAccountProfiles();
        setAccountProfiles(stored.profiles);
        const storedIds = new Set(stored.profiles.map(profile => profile.externalAccountId));
        if (result.accounts.some(account => !storedIds.has(String(account.id)))) setProfileSetupOpen(true);
      } catch (profileError) {
        setOauthError(profileError instanceof Error ? profileError.message : 'Uložené profily účtů se nepodařilo načíst.');
      }
    } catch (reason) {
      setOauthError(reason instanceof Error ? reason.message : 'Read-only preflight selhal.');
    } finally {
      setOauthBusy(null);
    }
  };

  const profileByAccountId = new Map(accountProfiles.map(profile => [profile.externalAccountId, profile]));
  const environment = oauthStatus?.environment ?? 'demo';
  const organization = Array.from(new Set(accountProfiles.map(profile => profile.propFirm).filter(Boolean))).join(', ') || '—';
  const firstConnection = oauthStatus?.connections[0];
  const connectionName = firstConnection?.tradovateEmail
    || (firstConnection?.tradovateUserId != null ? `Tradovate user ${firstConnection.tradovateUserId}` : 'Tradovate OAuth');
  const accountCount = preflight?.accounts.length ?? 0;

  return (
    <>
      <section className="overflow-hidden rounded-lg border border-indigo-500/20 bg-indigo-500/[0.045]">
        <div className="flex items-center gap-2.5 border-b border-indigo-500/15 px-4 py-3 text-[var(--text-primary)]">
          <ShieldAlert size={16} className="text-indigo-500" />
          <h2 className="text-sm font-black">Bezpečné připojení účtů</h2>
        </div>
        <div className="grid gap-2 px-4 py-3 text-xs leading-5 text-[var(--text-secondary)] lg:grid-cols-3 lg:gap-5">
          <p><b className="text-[var(--text-primary)]">Přihlášení probíhá u Tradovate.</b> AlphaTrade nevidí ani neukládá tvoje heslo.</p>
          <p><b className="text-[var(--text-primary)]">Účty nejdřív pouze načteme.</b> Copier zůstává DISARMED a nic neodesílá.</p>
          <p><b className="text-[var(--text-primary)]">Názvy a prop pravidla zůstanou uložené.</b> Opětovný OAuth je nesmaže.</p>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
          <div>
            <h2 className="text-base font-black text-[var(--text-primary)]">Connections</h2>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--text-secondary)]">
              <span className={`h-1.5 w-1.5 rounded-full ${oauthStatus?.connected ? 'bg-emerald-500' : oauthBusy === 'status' ? 'bg-amber-500' : 'bg-[var(--text-secondary)]'}`} />
              <span className={oauthStatus?.connected ? 'font-bold text-emerald-500' : ''}>
                {oauthBusy === 'status' ? 'Ověřuji stav…' : oauthStatus?.connected ? `Tradovate ${environment.toUpperCase()} připojeno` : 'Žádné aktivní připojení'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAddConnectionOpen(true)}
              disabled={oauthBusy != null || Boolean(oauthStatus?.connected)}
              title={oauthStatus?.connected ? 'Tradovate už je připojeno.' : undefined}
              className="flex h-9 items-center gap-2 rounded-md bg-indigo-600 px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Plus size={15} /> Add connection
            </button>
            <button type="button" onClick={() => void refreshOauthStatus()} disabled={oauthBusy != null} className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] disabled:opacity-50" aria-label="Obnovit stav připojení">
              <RefreshCw size={15} className={oauthBusy === 'status' ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {oauthError && <div className="border-b border-rose-500/20 bg-rose-500/10 px-4 py-2.5 text-xs font-bold text-rose-500">{oauthError}</div>}

        <div className="hidden grid-cols-[48px_90px_90px_1.15fr_1fr_130px_180px] gap-3 bg-[var(--bg-page)] px-4 py-2.5 text-[9px] font-black uppercase tracking-[0.13em] text-[var(--text-secondary)] lg:grid">
          <span /><span>Broker</span><span>Type</span><span>Connection</span><span>Organization</span><span>Status</span><span />
        </div>

        {!oauthStatus?.connected && oauthBusy !== 'status' ? (
          <div className="flex min-h-52 flex-col items-center justify-center px-6 py-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-500"><Link2 size={22} /></span>
            <h3 className="mt-4 text-sm font-black text-[var(--text-primary)]">Žádné připojení</h3>
            <p className="mt-1 max-w-sm text-xs leading-5 text-[var(--text-secondary)]">Přidej Tradovate přes OAuth. Po návratu načteme účty a nabídneme jejich pojmenování a prop pravidla.</p>
            <button type="button" onClick={() => setAddConnectionOpen(true)} className="mt-4 flex h-9 items-center gap-2 rounded-md bg-indigo-600 px-4 text-xs font-black text-white"><Plus size={15} /> Add connection</button>
          </div>
        ) : oauthStatus?.connected ? (
          <>
            <div className="grid min-h-12 items-center gap-3 px-4 py-2 text-xs transition-colors hover:bg-indigo-500/[0.025] lg:grid-cols-[48px_90px_90px_1.15fr_1fr_130px_180px]">
              <button type="button" onClick={() => setConnectionExpanded(value => !value)} className="flex items-center gap-2 text-[var(--text-secondary)]" aria-label={connectionExpanded ? 'Sbalit účty' : 'Rozbalit účty'}>
                <ChevronRight size={15} className={`transition-transform ${connectionExpanded ? 'rotate-90' : ''}`} /><span className="text-xs font-bold">{accountCount}</span>
              </button>
              <MobileMetric label="Broker"><span className="font-bold text-[var(--text-primary)]">Tradovate</span></MobileMetric>
              <MobileMetric label="Type"><span className="font-bold text-[var(--text-secondary)]">{environment.toUpperCase()}</span></MobileMetric>
              <MobileMetric label="Connection"><span className="truncate font-mono text-xs font-bold text-[var(--text-primary)]">{connectionName}</span></MobileMetric>
              <MobileMetric label="Organization"><span className="truncate font-bold text-[var(--text-primary)]">{organization}</span></MobileMetric>
              <MobileMetric label="Status"><span className="inline-flex items-center gap-2 font-bold text-emerald-500"><span className="h-2 w-2 rounded-full bg-emerald-500" />Connected</span></MobileMetric>
              <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={() => void runPreflight()} disabled={oauthBusy != null} className="h-7 rounded-md bg-indigo-600 px-2.5 text-[11px] font-bold text-white disabled:opacity-50">
                  {oauthBusy === 'preflight' ? 'Načítám…' : preflight ? 'Obnovit účty' : 'Načíst účty'}
                </button>
                <button type="button" onClick={() => setProfileSetupOpen(true)} disabled={!preflight?.accounts.length} className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-40" aria-label="Nastavit účty"><Settings2 size={13} /></button>
              </div>
            </div>

            {connectionExpanded && preflight && (
              <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-page)] px-4 py-3">
                {preflight.accounts.length === 0 ? (
                  <div className="text-xs font-bold text-amber-600">{preflight.environment.toUpperCase()} API nevrátilo žádný viditelný účet. Copier zůstává DISARMED.</div>
                ) : (
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {preflight.accounts.map(account => {
                      const profile = profileByAccountId.get(String(account.id));
                      return (
                        <div key={account.id} className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-3 text-xs">
                          <div className="font-black text-[var(--text-primary)]">{profile?.displayName || account.name}</div>
                          {profile && (profile.propFirm || profile.planName || profile.accountType) && <div className="mt-0.5 text-[10px] font-bold text-indigo-500">{[profile.propFirm, profile.planName, profile.accountType].filter(Boolean).join(' · ')}</div>}
                          <div className="mt-1 text-[var(--text-secondary)]">{account.active ? 'Active' : 'Inactive'} · {account.canTrade ? 'Execution permission' : 'Read only'} · pozice {account.netPositionCount} · working {account.workingOrderCount}</div>
                          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                            <span className="text-[var(--text-secondary)]">Balance</span><span className="text-right font-bold text-[var(--text-primary)]">{optionalMoney(account.balance.totalCashValue)}</span>
                            <span className="text-[var(--text-secondary)]">Net liq</span><span className="text-right font-bold text-[var(--text-primary)]">{optionalMoney(account.balance.netLiq)}</span>
                            <span className="text-[var(--text-secondary)]">Realized P&amp;L</span><span className={`text-right font-bold ${account.balance.realizedPnL == null ? 'text-[var(--text-secondary)]' : pnlColor(account.balance.realizedPnL)}`}>{account.balance.realizedPnL == null ? 'nedostupné' : signedMoney(account.balance.realizedPnL)}</span>
                            <span className="text-[var(--text-secondary)]">Historie / fills</span><span className="text-right font-bold text-[var(--text-primary)]">{account.history.entryCount} / {account.activity.fillCount}</span>
                            <span className="text-[var(--text-secondary)]">Realized DD</span><span className="text-right font-bold text-[var(--text-primary)]">{optionalMoney(account.history.realizedBalanceDrawdown)}</span>
                            <span className="text-[var(--text-secondary)]">Trailing DD limit</span><span className="text-right font-bold text-[var(--text-primary)]">{optionalMoney(account.risk.trailingMaxDrawdownLimit)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="flex min-h-32 items-center justify-center"><Loader2 size={22} className="animate-spin text-indigo-500" /></div>
        )}

        <div className="flex items-center justify-between border-t border-[var(--border-subtle)] px-4 py-3 text-xs">
          <span className="font-bold text-[var(--text-secondary)]">Total Accounts: <b className="text-[var(--text-primary)]">{accountCount}</b></span>
          <span className="font-black text-[var(--text-secondary)]">AlphaTrade</span>
        </div>
      </section>

      {addConnectionOpen && (
        <TradovateAddConnectionModal
          environment={environment}
          connecting={oauthBusy === 'connect'}
          onClose={() => setAddConnectionOpen(false)}
          onConnect={() => void connectOauth()}
        />
      )}
      {profileSetupOpen && preflight && (
        <TradovateAccountProfileSetup
          accounts={preflight.accounts}
          profiles={accountProfiles}
          onClose={() => setProfileSetupOpen(false)}
          onSaved={profiles => {
            setAccountProfiles(profiles);
            setProfileSetupOpen(false);
            setOauthError(null);
          }}
        />
      )}
    </>
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


const Accounts = ({ accounts, onAccount }: { accounts: LiveAccount[]; onAccount: (account: LiveAccount) => void }) => (
  <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
    <div className="px-4 py-3 border-b border-[var(--border-subtle)]"><h3 className="text-sm font-black text-[var(--text-primary)]">ÚČTY ({accounts.length})</h3><p className="text-[11px] text-[var(--text-secondary)] mt-0.5">Balance, živá equity, pozice a dostupná rezerva k EOD drawdownu</p></div>
    <div className="hidden lg:grid grid-cols-[1.5fr_.8fr_.8fr_.75fr_.75fr_24px] gap-3 px-4 py-2.5 bg-[var(--bg-page)] text-[9px] font-black uppercase tracking-[0.13em] text-[var(--text-secondary)]"><span>Účet</span><span>Balance / equity</span><span>Realizované</span><span>Live P&L</span><span>Rezerva</span><span /></div>
    <div className="divide-y divide-[var(--border-subtle)]">
      {accounts.map(account => (
        <button key={account.id} onClick={() => onAccount(account)} className="w-full grid lg:grid-cols-[1.5fr_.8fr_.8fr_.75fr_.75fr_24px] gap-3 px-4 py-3 lg:py-1 lg:min-h-10 items-center text-left text-xs hover:bg-blue-500/[0.035] transition-colors group">
          <div className="min-w-0">
            <div className="font-black text-xs text-[var(--text-primary)] truncate">{account.name}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] leading-3">
              <span className="uppercase tracking-wider text-[var(--text-secondary)]">{account.firm}{account.phase ? ` · ${account.phase}` : ''}</span>
              <span className={`font-bold ${account.mappedAccountName ? 'text-blue-500' : 'text-amber-500'}`}>{account.mappedAccountName ? `AlphaTrade → ${account.mappedAccountName}` : account.mappingStatus === 'ignored' ? 'V AlphaTrade ignorováno' : 'Nepřiřazeno k AlphaTrade'}</span>
            </div>
          </div>
          <MobileMetric label="Balance / equity"><span className="font-bold tabular-nums text-[var(--text-primary)]">{money.format(account.balance)}</span><span className="block text-[10px] leading-3 text-[var(--text-secondary)]">{money.format(account.equity)}</span></MobileMetric>
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
