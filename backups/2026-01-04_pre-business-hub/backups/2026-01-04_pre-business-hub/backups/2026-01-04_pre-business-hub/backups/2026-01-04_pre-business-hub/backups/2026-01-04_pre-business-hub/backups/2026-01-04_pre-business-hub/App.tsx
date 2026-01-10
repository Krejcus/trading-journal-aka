
import React, { useState, useMemo, useEffect } from 'react';
import { normalizeTrades, calculateStats, findBadExits } from './services/analysis';
import { storageService } from './services/storageService';
import { Trade, Account, TradeFilters, CustomEmotion, User, DailyPrep, DailyReview, UserPreferences, DashboardWidgetConfig, SessionConfig, IronRule } from './types';
import FileUpload from './components/FileUpload';
import Dashboard from './components/Dashboard';
import MentorChat from './components/MentorChat';
import ManualTradeForm from './components/ManualTradeForm';
import Sidebar from './components/Sidebar';
import TradeHistory from './components/TradeHistory';
import Settings from './components/Settings';
import AccountsManager from './components/AccountsManager';
import FilterDropdown from './components/FilterDropdown';
import DailyJournal from './components/DailyJournal';
import UserProfileModal from './components/UserProfileModal';
import SharedTradeView from './components/SharedTradeView';
import NetworkHub from './components/NetworkHub';
import Auth from './components/Auth';
import {
  Sun,
  Moon,
  BarChart3,
  Plus,
  Menu,
  LayoutGrid,
  ChevronRight,
  Zap,
  LineChart,
  ArrowRight,
  Check,
  AlertTriangle,
  Loader2
} from 'lucide-react';

import { supabase } from './services/supabase';

const DEFAULT_USER: User = {
  id: 'default_user',
  email: 'trader@alphatrade.cz',
  name: 'Alpha Trader'
};

const DEFAULT_ACCOUNT: Account = {
  id: 'default_acc',
  name: 'Hlavní účet',
  initialBalance: 10000,
  type: 'Live',
  status: 'Active',
  currency: 'USD',
  createdAt: Date.now()
};

const DEFAULT_WIDGETS: DashboardWidgetConfig[] = [
  { id: 'kpi_pnl', label: 'Net P&L', visible: true, size: 'small', order: 0 },
  { id: 'kpi_winrate', label: 'Win Rate', visible: true, size: 'small', order: 1 },
  { id: 'kpi_profit_factor', label: 'Profit Factor', visible: true, size: 'small', order: 2 },
  { id: 'discipline', label: 'Disciplína', visible: true, size: 'full', order: 3 },
  { id: 'equity', label: 'Equity Curve', visible: true, size: 'large', order: 4 },
  { id: 'calendar', label: 'Kalendář', visible: true, size: 'large', order: 5 },
];

const DEFAULT_SESSIONS: SessionConfig[] = [
  { id: 'asia', name: 'Asia', startTime: '02:00', endTime: '08:00', color: '#64748b' },
  { id: 'london', name: 'London', startTime: '09:00', endTime: '16:00', color: '#3b82f6' },
  { id: 'ny', name: 'New York', startTime: '15:30', endTime: '22:00', color: '#f97316' }
];

const App: React.FC = () => {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [appError, setAppError] = useState<string | null>(null);
  const [isInitialLoadDone, setIsInitialLoadDone] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: activeSession } }) => {
      setSession(activeSession);
      if (!activeSession) setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, activeSession) => {
      setSession(activeSession);
      if (activeSession) {
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const [sharedTrade, setSharedTrade] = useState<Trade | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shareData = params.get('share');
    const shareId = params.get('shareId');

    if (shareData) {
      try {
        const jsonStr = decodeURIComponent(escape(atob(shareData)));
        const trade = JSON.parse(jsonStr);
        setSharedTrade(trade);
      } catch (e) {
        console.error("Failed to parse shared trade", e);
      }
    } else if (shareId) {
      storageService.getTradeById(shareId).then(trade => {
        if (trade) setSharedTrade(trade);
      });
    }
  }, []);

  const [trades, setTrades] = useState<Trade[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string>('');
  const [currentUser, setCurrentUser] = useState<User>(DEFAULT_USER);

  const [dailyPreps, setDailyPreps] = useState<DailyPrep[]>([]);
  const [dailyReviews, setDailyReviews] = useState<DailyReview[]>([]);

  const [userEmotions, setUserEmotions] = useState<CustomEmotion[]>([
    { id: 'fomo', label: 'FOMO', icon: 'zap' },
    { id: 'fear', label: 'Strach', icon: 'shield' },
    { id: 'greed', label: 'Chamtivost', icon: 'dollar-sign' },
    { id: 'revenge', label: 'Revenge', icon: 'flame' },
    { id: 'flow', label: 'Flow', icon: 'activity' },
    { id: 'boredom', label: 'Nuda', icon: 'clock' }
  ]);
  const [userMistakes, setUserMistakes] = useState<string[]>(['Early Exit', 'Chase', 'No Stop Loss', 'Overrisking', 'Impulsive Entry']);
  const [htfOptions, setHtfOptions] = useState<string[]>(['4H Demand', '4H Supply', 'Daily Level', 'Weekly High/Low']);
  const [ltfOptions, setLtfOptions] = useState<string[]>(['M5 BoS', 'M1 Choch', 'Liquidity Sweep', 'FVG Entry']);
  const [standardGoals, setStandardGoals] = useState<string[]>(['Dodržet max risk 1%', 'Žádný obchod po 11:00', 'Počkat na setup A+']);
  const [dashboardLayout, setDashboardLayout] = useState<DashboardWidgetConfig[]>(DEFAULT_WIDGETS);
  const [sessions, setSessions] = useState<SessionConfig[]>(DEFAULT_SESSIONS);
  const [instrumentFees, setInstrumentFees] = useState<Record<string, number>>({ 'MNQ': 0.52, 'NQ': 2.42 });
  const [ironRules, setIronRules] = useState<IronRule[]>([
    { id: 'r_meditation', label: 'Ranní meditace / klid', type: 'ritual' },
    { id: 'r_news', label: 'Kontrola High Impact News', type: 'ritual' },
    { id: 't_risk', label: 'Max 1% Risk na trade', type: 'trading' },
    { id: 't_revenge', label: 'Žádný Revenge Trading', type: 'trading' },
    { id: 't_sl', label: 'Neposouvat SL do ztráty', type: 'trading' }
  ]);

  const [activePage, setActivePage] = useState('dashboard');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isManualEntryOpen, setIsManualEntryOpen] = useState(false);
  const [isDashboardEditing, setIsDashboardEditing] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  const [filters, setFilters] = useState<TradeFilters>({
    days: ['Po', 'Út', 'St', 'Čt', 'Pá'],
    hours: Array.from({ length: 24 }, (_, i) => i),
    accounts: [],
    directions: ['Long', 'Short'],
    outcomes: ['Win', 'Loss', 'BE'],
    period: 'all',
    signals: [],
    executionStatuses: ['Valid'],
    htfConfluences: [],
    ltfConfluences: [],
    mistakes: []
  });

  useEffect(() => {
    if (sharedTrade) return;
    if (!session) return;

    const load = async () => {
      // 1. Session safety: If current user doesn't match last stored user, wipe local storage
      const lastUserId = localStorage.getItem('alphatrade_last_session_user');
      if (lastUserId && lastUserId !== session.user.id) {
        console.warn("User mismatch detected. Purging local storage for safety.");
        localStorage.clear();
      }
      localStorage.setItem('alphatrade_last_session_user', session.user.id);

      if (!isInitialLoadDone) setLoading(true);
      try {
        // Clear state before loading to avoid ghost data
        setTrades([]);
        setAccounts([]);

        const storedTrades = await storageService.getTrades();

        // Clean up weekend trades (Safety: remove any trades entered on Sat/Sun)
        const cleanedTrades = (storedTrades || []).filter(t => {
          const d = new Date(t.date);
          const day = d.getDay();
          return day !== 0 && day !== 6;
        });

        if (cleanedTrades.length !== (storedTrades || []).length) {
          console.warn(`System logic: Cleaned up ${(storedTrades || []).length - cleanedTrades.length} invalid weekend trades.`);
        }

        setTrades(cleanedTrades);
        const storedAccounts = await storageService.getAccounts();

        let finalAccounts = storedAccounts;
        if (!finalAccounts || finalAccounts.length === 0) {
          finalAccounts = [DEFAULT_ACCOUNT];
        }
        setAccounts(finalAccounts);

        const storedPreps = await storageService.getDailyPreps();
        const storedReviews = await storageService.getDailyReviews();
        const prefs = await storageService.getPreferences();
        const storedUser = await storageService.getUser();
        const activeId = storageService.getActiveAccountId();

        if (storedUser) setCurrentUser(storedUser);
        setActiveAccountId(activeId || (finalAccounts[0]?.id || ''));

        setDailyPreps(storedPreps || []);
        setDailyReviews(storedReviews || []);

        if (prefs) {
          if (prefs.emotions) setUserEmotions(prefs.emotions);
          if (prefs.standardMistakes) setUserMistakes(prefs.standardMistakes);
          if (prefs.standardGoals) setStandardGoals(prefs.standardGoals);
          if (prefs.dashboardLayout) setDashboardLayout(prefs.dashboardLayout);
          if (prefs.sessions) {
            const migratedSessions = (prefs.sessions as any[]).map(s => {
              if (s.startTime && s.endTime) return s;
              return {
                ...s,
                startTime: `${String(s.startHour ?? 9).padStart(2, '0')}:00`,
                endTime: `${String(s.endHour ?? 17).padStart(2, '0')}:00`,
                color: s.color || '#3b82f6'
              };
            });
            setSessions(migratedSessions);
          }
          if (prefs.htfOptions) setHtfOptions(prefs.htfOptions);
          if (prefs.ltfOptions) setLtfOptions(prefs.ltfOptions);
          if (prefs.ironRules) setIronRules(prefs.ironRules);
          if (prefs.instrumentFees) setInstrumentFees(prefs.instrumentFees);
        }
      } catch (error: any) {
        console.error("Error loading data:", error);
        setAppError(error.message || "Nepodařilo se načíst data z databáze. Zkontroluj připojení.");
      } finally {
        setLoading(false);
        setIsInitialLoadDone(true);
      }
    };

    if (session) {
      // If we switched users, we might still have old data in state
      // Load will overwrite it, but let's be safe
      load();
    } else {
      // Not logged in, clear everything to be ready for next user
      setTrades([]);
      setAccounts([]);
      setIsInitialLoadDone(false);
    }
  }, [sharedTrade, session]);

  useEffect(() => {
    if (accounts.length > 0 && filters.accounts.length === 0) {
      setFilters(prev => ({ ...prev, accounts: accounts.map(a => a.id) }));
    }
  }, [accounts]);

  useEffect(() => {
    if (!sharedTrade && session && isInitialLoadDone) {
      storageService.saveTrades(trades).then(updatedTrades => {
        if (updatedTrades && updatedTrades.length > 0) {
          // If IDs changed (e.g. from local ID to UUID), update local state
          const currentIds = trades.map(t => t.id).sort().join(',');
          const newIds = updatedTrades.map(t => t.id).sort().join(',');
          if (currentIds !== newIds) {
            setTrades(updatedTrades);
          }
        }
      }).catch(err => {
        console.error("Trade sync failed", err);
        setSyncError("Chyba při ukládání obchodů.");
      });
    }
  }, [trades, sharedTrade, session, isInitialLoadDone]);

  const isSyncingAccounts = React.useRef(false);
  useEffect(() => {
    if (!sharedTrade && session && isInitialLoadDone && accounts.length > 0 && !isSyncingAccounts.current) {
      isSyncingAccounts.current = true;
      storageService.saveAccounts(accounts).then(updatedAccounts => {
        // If IDs changed (e.g. from temp ID to UUID), update local state
        const currentIds = JSON.stringify(accounts.map(a => a.id).sort());
        const newIds = JSON.stringify(updatedAccounts.map(a => a.id).sort());

        if (currentIds !== newIds) {
          // Find if activeAccountId was one of the temp IDs and update it
          const oldActiveAccountIndex = accounts.findIndex(a => a.id === activeAccountId);
          if (oldActiveAccountIndex !== -1) {
            const newActiveId = updatedAccounts[oldActiveAccountIndex]?.id;
            if (newActiveId && newActiveId !== activeAccountId) {
              setActiveAccountId(newActiveId);
            }
          }
          setAccounts(updatedAccounts);
        }
        setSyncError(null);
      }).catch(err => {
        console.error("Account sync failed", err);
        setSyncError(`Chyba synchronizace účtů: ${err.message || 'Neznámá chyba'}`);
      }).finally(() => {
        isSyncingAccounts.current = false;
      });
    }
  }, [accounts, sharedTrade, session, isInitialLoadDone]);

  useEffect(() => { if (!sharedTrade && session && isInitialLoadDone) storageService.saveDailyPreps(dailyPreps); }, [dailyPreps, sharedTrade, session, isInitialLoadDone]);
  useEffect(() => { if (!sharedTrade && session && isInitialLoadDone) storageService.saveDailyReviews(dailyReviews); }, [dailyReviews, sharedTrade, session, isInitialLoadDone]);
  useEffect(() => { if (!sharedTrade && session && isInitialLoadDone) storageService.setActiveAccountId(activeAccountId); }, [activeAccountId, sharedTrade, session, isInitialLoadDone]);

  useEffect(() => {
    if (!sharedTrade && session && isInitialLoadDone) {
      storageService.savePreferences({
        emotions: userEmotions,
        standardMistakes: userMistakes,
        standardGoals: standardGoals,
        dashboardLayout,
        sessions,
        htfOptions,
        ltfOptions,
        ironRules,
        instrumentFees
      });
    }
  }, [userEmotions, userMistakes, standardGoals, dashboardLayout, sessions, htfOptions, ltfOptions, ironRules, instrumentFees, sharedTrade, session, isInitialLoadDone]);

  const stats = useMemo(() => {
    try {
      const activeAccount = accounts.find(a => a.id === activeAccountId) || accounts[0] || DEFAULT_ACCOUNT;
      return calculateStats(trades, activeAccount.initialBalance || 0);
    } catch (e) {
      console.error("Stats calculation error:", e);
      return calculateStats([], 0);
    }
  }, [trades, accounts, activeAccountId]);

  const filteredTrades = useMemo(() => {
    const now = new Date();
    return trades.filter(t => {
      const d = new Date(t.date);
      const h = new Date(t.timestamp).getHours();
      const dayName = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'][d.getDay()];
      const status = t.executionStatus || 'Valid';

      const matchDay = filters.days.includes(dayName);
      const matchHour = filters.hours.includes(h);
      const matchAcc = filters.accounts.includes(t.accountId);
      const matchDir = filters.directions.includes(t.direction);
      const matchStatus = filters.executionStatuses.includes(status);

      let matchRes = false;
      if (t.pnl > 0 && filters.outcomes.includes('Win')) matchRes = true;
      else if (t.pnl < 0 && filters.outcomes.includes('Loss')) matchRes = true;
      else if (t.pnl === 0 && filters.outcomes.includes('BE')) matchRes = true;

      let matchHtf = filters.htfConfluences.length === 0 ||
        (t.htfConfluence?.some(c => filters.htfConfluences.includes(c)) || false);

      let matchLtf = filters.ltfConfluences.length === 0 ||
        (t.ltfConfluence?.some(c => filters.ltfConfluences.includes(c)) || false);

      let matchMistake = filters.mistakes.length === 0 ||
        (t.mistakes?.some(m => filters.mistakes.includes(m)) || false);

      let matchPeriod = true;
      if (filters.period !== 'all') {
        const diffDays = (now.getTime() - d.getTime()) / (1000 * 3600 * 24);
        if (filters.period === 'week' && diffDays > 7) matchPeriod = false;
        if (filters.period === 'month' && diffDays > 30) matchPeriod = false;
        if (filters.period === 'quarter' && diffDays > 90) matchPeriod = false;
        if (filters.period === 'year' && diffDays > 365) matchPeriod = false;
      }

      return matchDay && matchHour && matchAcc && matchDir && matchRes && matchPeriod &&
        matchStatus && matchHtf && matchLtf && matchMistake;
    });
  }, [trades, filters]);

  const badExits = useMemo(() => findBadExits(filteredTrades), [filteredTrades]);

  if (loading && !sharedTrade) {
    return (
      <div className="min-h-screen bg-[#020617] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-white font-bold uppercase tracking-widest text-xs">Načítám terminál...</p>
        </div>
      </div>
    );
  }

  if (sharedTrade) {
    return <SharedTradeView trade={sharedTrade} theme={theme} />;
  }

  if (!session) {
    return <Auth onLogin={(user) => { }} theme={theme} />;
  }

  const handleUpdateUser = async (updatedUser: User) => {
    setCurrentUser(updatedUser);
    try {
      await storageService.saveUser(updatedUser);
      console.log("Profile saved successfully");
    } catch (err) {
      console.error("Failed to save profile", err);
      setSyncError("Nepodařilo se uložit profil.");
    }
  };

  const handleFileUpload = (data: any[]) => {
    const newTrades = normalizeTrades(data, activeAccountId);
    const uniqueTrades = [...trades];
    newTrades.forEach(nt => {
      if (!uniqueTrades.some(t => t.id === nt.id && t.accountId === activeAccountId)) {
        uniqueTrades.push(nt);
      }
    });
    setTrades(uniqueTrades);
  };

  const handleManualTrade = (trade: Trade) => {
    // Generate a proper UUID for new trades to prevent duplicates and DB errors
    const tradeWithUUID = {
      ...trade,
      id: crypto.randomUUID()
    };
    setTrades([...trades, tradeWithUUID]);
    setIsManualEntryOpen(false);
  };

  const handleDeleteAccount = async (id: string) => {
    try {
      await storageService.deleteAccount(id);
      setAccounts(accounts.filter(a => a.id !== id));
      setTrades(trades.filter(t => t.accountId !== id));
      if (activeAccountId === id) {
        const nextAccount = accounts.find(a => a.id !== id);
        if (nextAccount) {
          setActiveAccountId(nextAccount.id);
        } else {
          setActiveAccountId(DEFAULT_ACCOUNT.id);
        }
      }
    } catch (err) {
      console.error("Failed to delete account", err);
      setSyncError("Nepodařilo se smazat účet.");
    }
  };

  const handleDeleteTrade = (id: number | string) => {
    setTrades(trades.filter(t => t.id !== id));
  };

  const handleClearTrades = () => {
    setTrades([]);
  };

  return (
    <div className={`min-h-screen font-sans text-slate-200 flex ${theme === 'dark' ? 'bg-[#020617]' : 'bg-slate-50 text-slate-800'}`}>
      <Sidebar
        activePage={activePage}
        setActivePage={setActivePage}
        isOpen={isSidebarOpen}
        setIsOpen={setIsSidebarOpen}
        isCollapsed={isSidebarCollapsed}
        setIsCollapsed={setIsSidebarCollapsed}
        theme={theme}
        onAddTrade={() => setIsManualEntryOpen(true)}
        user={currentUser}
        onLogout={async () => {
          localStorage.clear(); // CRITICAL: Clear dirty local data
          await supabase.auth.signOut();
          setSession(null);
          window.location.reload(); // Force a clean state
        }}
        onOpenProfile={() => setIsProfileOpen(true)}
      />

      <main className={`flex-1 transition-all duration-300 relative flex flex-col ${isSidebarCollapsed ? 'lg:ml-24' : 'lg:ml-72'}`}>
        <header className={`sticky top-0 z-40 border-b backdrop-blur-md px-6 py-4 flex items-center justify-between transition-all ${theme === 'dark' ? 'bg-[#020617]/80 border-white/5' : 'bg-white/80 border-slate-200'}`}>
          <div className="flex items-center gap-4">
            <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden p-2 hover:bg-white/10 rounded-lg"><Menu size={20} /></button>
            <h2 className={`text-xl font-black uppercase tracking-tighter ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>
              {activePage === 'dashboard' && 'Dashboard'}
              {activePage === 'history' && 'Trade Log'}
              {activePage === 'journal' && 'Tactical Hub'}
              {activePage === 'accounts' && 'Portfolio'}
              {activePage === 'settings' && 'System Config'}
              {activePage === 'network' && 'Network Hub'}
            </h2>
          </div>

          <div className="flex items-center gap-3">
            <FilterDropdown
              filters={filters}
              setFilters={setFilters}
              accounts={accounts}
              trades={trades}
              theme={theme}
              isDashboardEditing={activePage === 'dashboard' ? isDashboardEditing : undefined}
              setIsDashboardEditing={activePage === 'dashboard' ? setIsDashboardEditing : undefined}
            />

            <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className={`p-2.5 rounded-xl border transition-all ${theme === 'dark' ? 'bg-white/5 border-white/5 text-yellow-400' : 'bg-white border-slate-200 text-slate-600'}`}>
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </header>

        <div className="p-4 lg:p-8 flex-1 overflow-x-hidden">
          {syncError && (
            <div className="mb-4 bg-red-500/10 border border-red-500/20 text-red-500 p-3 rounded-xl flex items-center gap-2 text-xs font-bold animate-pulse">
              <AlertTriangle size={16} />
              <span>{syncError}</span>
            </div>
          )}
          {appError ? (
            <div className="flex flex-col items-center justify-center h-[60vh] text-center p-6 bg-red-500/5 border border-red-500/20 rounded-[40px]">
              <AlertTriangle className="text-red-500 w-16 h-16 mb-4 animate-pulse" />
              <h2 className="text-2xl font-black text-white mb-2">CHYBA TERMINÁLU</h2>
              <p className="text-slate-400 mb-6 max-w-md">{appError}</p>
              <button
                onClick={() => window.location.reload()}
                className="px-8 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl font-black uppercase text-xs"
              >
                Restartovat aplikaci
              </button>
            </div>
          ) : (
            <>
              {activePage === 'dashboard' && (
                <Dashboard
                  stats={stats}
                  theme={theme}
                  preps={dailyPreps}
                  reviews={dailyReviews}
                  layout={dashboardLayout}
                  sessions={sessions}
                  ironRules={ironRules}
                  onUpdateLayout={setDashboardLayout}
                  isEditing={isDashboardEditing}
                  onCloseEdit={() => setIsDashboardEditing(false)}
                  accounts={accounts}
                  emotions={userEmotions}
                />
              )}

              {activePage === 'history' && (
                trades.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-[60vh] space-y-6">
                    <div className="w-full max-w-md h-64">
                      <FileUpload onDataLoaded={handleFileUpload} />
                    </div>
                    <div className="flex items-center gap-4 w-full max-w-md">
                      <div className="h-px bg-slate-800 flex-1"></div>
                      <span className="text-xs text-slate-500 font-bold uppercase">Nebo</span>
                      <div className="h-px bg-slate-800 flex-1"></div>
                    </div>
                    <button onClick={() => setIsManualEntryOpen(true)} className="flex items-center gap-2 px-8 py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl shadow-blue-500/20 transition-all active:scale-95">
                      <Plus size={18} /> Zapsat první obchod
                    </button>
                  </div>
                ) : (
                  <TradeHistory
                    trades={filteredTrades}
                    accounts={accounts}
                    onDelete={handleDeleteTrade}
                    onEdit={(t) => { setIsManualEntryOpen(true); }}
                    onClear={handleClearTrades}
                    theme={theme}
                    emotions={userEmotions}
                  />
                )
              )}

              {activePage === 'journal' && (
                <DailyJournal
                  theme={theme}
                  trades={trades}
                  preps={dailyPreps}
                  reviews={dailyReviews}
                  onSavePrep={(prep) => setDailyPreps(prev => [...prev.filter(p => p.date !== prep.date), prep])}
                  onSaveReview={(rev) => setDailyReviews(prev => [...prev.filter(r => r.date !== rev.date), rev])}
                  standardGoals={standardGoals}
                  ironRules={ironRules}
                />
              )}

              {activePage === 'accounts' && (
                <AccountsManager
                  accounts={accounts}
                  activeAccountId={activeAccountId}
                  setActiveAccountId={setActiveAccountId}
                  onUpdate={setAccounts}
                  onDelete={handleDeleteAccount}
                  theme={theme}
                  trades={trades}
                />
              )}

              {activePage === 'network' && (
                <NetworkHub theme={theme} accounts={accounts} emotions={userEmotions} />
              )}

              {activePage === 'settings' && (
                <Settings
                  theme={theme}
                  userEmotions={userEmotions} setUserEmotions={setUserEmotions}
                  userMistakes={userMistakes} setUserMistakes={setUserMistakes}
                  htfOptions={htfOptions} setHtfOptions={setHtfOptions}
                  ltfOptions={ltfOptions} setLtfOptions={setLtfOptions}
                  sessions={sessions} setSessions={setSessions}
                  ironRules={ironRules} setIronRules={setIronRules}
                  instrumentFees={instrumentFees} setInstrumentFees={setInstrumentFees}
                />
              )}
            </>
          )}
        </div>
      </main>

      {isManualEntryOpen && (
        <ManualTradeForm
          onAdd={handleManualTrade}
          onClose={() => setIsManualEntryOpen(false)}
          theme={theme}
          accounts={accounts}
          activeAccountId={activeAccountId}
          availableEmotions={userEmotions}
          availableMistakes={userMistakes}
          availableHtfOptions={htfOptions}
          availableLtfOptions={ltfOptions}
          instrumentFees={instrumentFees}
        />
      )}

      <UserProfileModal
        isOpen={isProfileOpen}
        onClose={() => setIsProfileOpen(false)}
        user={currentUser}
        onUpdate={handleUpdateUser}
        trades={trades}
        theme={theme}
      />
    </div>
  );
};

export default App;
