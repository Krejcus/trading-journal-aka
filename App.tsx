
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { normalizeTrades, calculateStats, findBadExits } from './services/analysis';
import { storageService } from './services/storageService';
import { prefetchService } from './services/prefetchService';
import { Trade, Account, TradeFilters, CustomEmotion, User, DailyPrep, DailyReview, UserPreferences, DashboardWidgetConfig, SessionConfig, IronRule, BusinessExpense, BusinessPayout, PlaybookItem, BusinessGoal, BusinessResource, BusinessSettings, PsychoMetricConfig, DashboardMode, WeeklyFocus } from './types';
import FileUpload from './components/FileUpload';
import Dashboard from './components/Dashboard';
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
import BusinessHub from './components/BusinessHub';
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
  Loader2,
  Users,
  User as UserIcon,
  Layers
} from 'lucide-react';

import { supabase } from './services/supabase';
import { DataService } from './services/DataService';

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
  createdAt: Date.now(),
  instrumentFees: { 'NQ': 2.8, 'MNQ': 0.74 }
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
  const [initStatus, setInitStatus] = useState<string>("Inicializace...");
  const [showRetry, setShowRetry] = useState(false);

  useEffect(() => {
    console.log("[Auth] Starting initialization...");
    const start = Date.now();

    // Top-level safety timeout to always clear loading screen
    const safetyTimer = setTimeout(() => {
      if (loading) {
        console.warn(`[Auth] Safety timeout reached after ${Date.now() - start}ms. Force clearing loading state.`);
        setLoading(false);
        setShowRetry(true);
      }
    }, 10000); // 10s is safer for Vercel cold starts

    setInitStatus("Kontrola přihlášení...");
    console.log("[Auth] Calling getSession()...");
    supabase.auth.getSession().then(({ data: { session: activeSession } }) => {
      console.log(`[Auth] getSession result: ${activeSession ? 'Logged in' : 'No session'} (${Date.now() - start}ms)`);
      if (activeSession) {
        setSession(activeSession);
        setInitStatus("Načítám data...");
      } else {
        setLoading(false);
      }
    }).catch(err => {
      console.error("[Auth] Session check failed:", err);
      setLoading(false);
      setAppError("Nepodařilo se ověřit přihlášení. Zkus obnovit stránku.");
    });

    console.log("[Auth] Setting up onAuthStateChange...");
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, activeSession) => {
      console.log(`[Auth] Auth state change: ${event}, Session: ${activeSession ? 'Yes' : 'No'} (${Date.now() - start}ms)`);
      if (activeSession) {
        setSession(activeSession);
        if (!isInitialLoadDone) setInitStatus("Přihlašuji...");
      }

      if (event === 'SIGNED_OUT') {
        setSession(null);
        setLoading(false);
      }
    });

    return () => {
      console.log("[Auth] Cleaning up subscription");
      subscription.unsubscribe();
      clearTimeout(safetyTimer);
    };
  }, []);

  const [sharedTrade, setSharedTrade] = useState<Trade | null>(null);
  const isPreferencesDirty = useRef(false);
  const isJournalDirty = useRef(false);

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
  const [dashboardMode, setDashboardMode] = useState<DashboardMode>(() => {
    // Try to load from local storage first for immediate persistence
    const saved = localStorage.getItem('alphatrade_dash_mode');
    return (saved as DashboardMode) || 'combined';
  });
  const [sessions, setSessions] = useState<SessionConfig[]>(DEFAULT_SESSIONS);
  const [ironRules, setIronRules] = useState<IronRule[]>([
    { id: 'r_meditation', label: 'Ranní meditace / klid', type: 'ritual' },
    { id: 'r_news', label: 'Kontrola High Impact News', type: 'ritual' },
    { id: 't_risk', label: 'Max 1% Risk na trade', type: 'trading' },
    { id: 't_revenge', label: 'Žádný Revenge Trading', type: 'trading' },
    { id: 't_sl', label: 'Neposouvat SL do ztráty', type: 'trading' }
  ]);

  const [businessExpenses, setBusinessExpenses] = useState<BusinessExpense[]>([]);
  const [businessPayouts, setBusinessPayouts] = useState<BusinessPayout[]>([]);
  const [playbookItems, setPlaybookItems] = useState<PlaybookItem[]>([]);
  const [businessGoals, setBusinessGoals] = useState<BusinessGoal[]>([]);
  const [businessResources, setBusinessResources] = useState<BusinessResource[]>([]);
  const [businessSettings, setBusinessSettings] = useState<BusinessSettings>({ taxRatePct: 15, defaultPropThreshold: 150 });
  const [psychoMetrics, setPsychoMetrics] = useState<PsychoMetricConfig[]>([
    { id: 'mood', label: 'Nálada', color: '#6366f1' },
    { id: 'energy', label: 'Energie', color: '#f59e0b' }
  ]);

  const [weeklyFocusList, setWeeklyFocusList] = useState<WeeklyFocus[]>([]);


  const [activePage, setActivePage] = useState('dashboard');
  const [theme, setTheme] = useState<'dark' | 'light' | 'oled'>(() => {
    try {
      const storedTheme = localStorage.getItem('alphatrade_theme');
      if (storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'oled') {
        if (storedTheme === 'light') document.documentElement.classList.add('light-theme');
        else if (storedTheme === 'oled') document.documentElement.classList.add('oled-theme');
        return storedTheme as any;
      }
      const stored = localStorage.getItem('alphatrade_preferences');
      if (stored) {
        const prefs = JSON.parse(stored);
        if (prefs.theme) {
          if (prefs.theme === 'light') document.documentElement.classList.add('light-theme');
          else if (prefs.theme === 'oled') document.documentElement.classList.add('oled-theme');
          return prefs.theme;
        }
      }
    } catch (e) { }
    return 'dark';
  });

  const [viewMode, setViewMode] = useState<'individual' | 'combined'>(
    (localStorage.getItem('alphatrade_view_mode') as 'individual' | 'combined') || 'individual'
  );

  useEffect(() => {
    localStorage.setItem('alphatrade_view_mode', viewMode);
  }, [viewMode]);

  const [isSidebarOpen, setIsSidebarOpen] = useState(false); // Mobile sidebar toggle
  const touchStart = useRef<number | null>(null);
  const touchEnd = useRef<number | null>(null);

  const minSwipeDistance = 50;

  const onTouchStart = (e: React.TouchEvent) => {
    touchEnd.current = null;
    touchStart.current = e.targetTouches[0].clientX;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    touchEnd.current = e.targetTouches[0].clientX;
  };

  const onTouchEnd = () => {
    if (!touchStart.current || !touchEnd.current) return;
    const distance = touchStart.current - touchEnd.current;
    const isLeftSwipe = distance > minSwipeDistance;
    const isRightSwipe = distance < -minSwipeDistance;

    // Right swipe (Open sidebar) - only if starting from left edge (< 50px)
    if (isRightSwipe && touchStart.current < 50) {
      setIsSidebarOpen(true);
    }

    // Left swipe (Close sidebar)
    if (isLeftSwipe && isSidebarOpen) {
      setIsSidebarOpen(false);
    }
  };
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isManualEntryOpen, setIsManualEntryOpen] = useState(false);
  const [editTrade, setEditTrade] = useState<Trade | null>(null);
  const [isDashboardEditing, setIsDashboardEditing] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const lastLoadedSessionId = React.useRef<string | null>(null);

  const handleSavePrep = useCallback((prep: DailyPrep) => {
    isJournalDirty.current = true;
    setDailyPreps(prev => [...prev.filter(p => p.date !== prep.date), prep]);
  }, []);

  const handleSaveReview = useCallback((rev: DailyReview) => {
    isJournalDirty.current = true;
    setDailyReviews(prev => [...prev.filter(r => r.date !== rev.date), rev]);
  }, []);

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
      // Avoid redundant loads if the session is the same
      if (session?.user?.id === lastLoadedSessionId.current && isInitialLoadDone) return;
      lastLoadedSessionId.current = session?.user?.id || null;

      const lastUserId = localStorage.getItem('alphatrade_last_session_user');
      if (lastUserId && lastUserId !== session.user.id) {
        console.warn("User mismatch detected. Purging local storage for safety.");
        localStorage.clear();
      }
      localStorage.setItem('alphatrade_last_session_user', session.user.id);

      // Cleanup legacy localStorage trades (now using IndexedDB)
      localStorage.removeItem('alphatrade_trades');

      // --- PHASE 1: CHECK CACHE ---
      console.log("[Load] Phase 1: Checking cache...");
      const cachedTrades = await storageService.getTradesCheckCacheFirst();
      const cachedAccounts = storageService.getCachedAccounts();
      const cachedPrefs = storageService.getCachedPreferences();
      const activeId = storageService.getActiveAccountId();

      const hasCachedData = cachedTrades.length > 0 || cachedAccounts.length > 0;

      if (hasCachedData) {
        // --- FAST PATH: Cache has data, show immediately ---
        console.log("[Load] Cache HIT! Showing data instantly.");
        if (cachedTrades.length > 0) setTrades(cachedTrades);
        if (cachedAccounts.length > 0) {
          setAccounts(cachedAccounts);
          setActiveAccountId(activeId || cachedAccounts[0].id);
        }
        if (cachedPrefs) applyPreferences(cachedPrefs);

        // Clear loading screen immediately
        setLoading(false);
        setIsInitialLoadDone(true);

        // Background sync (non-blocking)
        syncFromServer(activeId);
      } else {
        // --- SLOW PATH: Cache is empty, must wait for server ---
        console.log("[Load] Cache MISS. Waiting for server data...");
        setInitStatus("Načítám data ze serveru...");

        try {
          // Fetch critical data first (trades + accounts) - this is what we need for UI
          const [dbTrades, dbAccounts] = await Promise.all([
            storageService.getTrades(),
            storageService.getAccounts()
          ]);

          console.log("[Load] Critical data received.");

          const cleanedTrades = (dbTrades || []).filter(t => {
            const d = new Date(t.date);
            const day = d.getDay();
            return day !== 0 && day !== 6;
          });
          setTrades(cleanedTrades);

          if (dbAccounts && dbAccounts.length > 0) {
            setAccounts(dbAccounts);
            setActiveAccountId(dbAccounts[0].id);
          } else {
            setAccounts([DEFAULT_ACCOUNT]);
            setActiveAccountId(DEFAULT_ACCOUNT.id);
          }

          // Now we can show the dashboard
          setLoading(false);
          setIsInitialLoadDone(true);

          // Fetch remaining data in background (non-critical)
          fetchSecondaryData();

        } catch (error: any) {
          console.error("[Load] Server fetch error:", error);
          setAppError(error.message || "Nepodařilo se načíst data ze serveru.");
          setLoading(false);
          setIsInitialLoadDone(true);
        }
      }
    };

    // Background sync when we had cache data
    const syncFromServer = async (activeId: string | null) => {
      try {
        console.log("[Sync] Background sync starting...");
        const [dbTrades, dbAccounts, dbPreps, dbReviews, dbPrefs, dbUser, dbWeeklyFocus] = await Promise.all([
          storageService.getTrades(),
          storageService.getAccounts(),
          storageService.getDailyPreps(),
          storageService.getDailyReviews(),
          storageService.getPreferences(),
          storageService.getUser(),
          storageService.getWeeklyFocusList()
        ]);

        console.log("[Sync] Background sync complete.");

        if (dbUser) setCurrentUser(dbUser);

        const cleanedTrades = (dbTrades || []).filter(t => {
          const d = new Date(t.date);
          const day = d.getDay();
          return day !== 0 && day !== 6;
        });
        setTrades(cleanedTrades);

        if (dbAccounts && dbAccounts.length > 0) {
          setAccounts(dbAccounts);
          if (!activeId) setActiveAccountId(dbAccounts[0].id);
        }

        if (!isJournalDirty.current) {
          setDailyPreps(dbPreps || []);
          setDailyReviews(dbReviews || []);
        } else {
          console.log("[Sync] Skipping journal sync (dirty state)");
        }
        setWeeklyFocusList(dbWeeklyFocus || []);

        if (dbPrefs) applyPreferences(dbPrefs);
        setSyncError(null);
      } catch (error: any) {
        console.error("[Sync] Background sync error:", error);
        // Don't show error - we already have cache data visible
      }
    };

    // Fetch secondary data after critical data is loaded (for cache-miss path)
    const fetchSecondaryData = async () => {
      try {
        const [dbPreps, dbReviews, dbPrefs, dbUser, dbWeeklyFocus] = await Promise.all([
          storageService.getDailyPreps(),
          storageService.getDailyReviews(),
          storageService.getPreferences(),
          storageService.getUser(),
          storageService.getWeeklyFocusList()
        ]);

        if (dbUser) setCurrentUser(dbUser);
        if (!isJournalDirty.current) {
          setDailyPreps(dbPreps || []);
          setDailyReviews(dbReviews || []);
        }
        setWeeklyFocusList(dbWeeklyFocus || []);
        if (dbPrefs) applyPreferences(dbPrefs);
      } catch (e) {
        console.error("[Load] Secondary data fetch error:", e);
      }
    };

    // Helper to apply preferences to state
    const applyPreferences = (prefs: UserPreferences) => {
      if (isPreferencesDirty.current) {
        console.log("[Sync] Skipping preferences sync (dirty state)");
        return;
      }

      if (prefs.emotions) setUserEmotions(prefs.emotions);
      if (prefs.standardMistakes) setUserMistakes(prefs.standardMistakes);
      if (prefs.standardGoals) setStandardGoals(prefs.standardGoals);
      if (prefs.dashboardLayout) setDashboardLayout(prefs.dashboardLayout);
      if (prefs.sessions) {
        const migratedSessions = (prefs.sessions as any[]).map(s => ({
          ...s,
          startTime: s.startTime || `${String(s.startHour ?? 9).padStart(2, '0')}:00`,
          endTime: s.endTime || `${String(s.endHour ?? 17).padStart(2, '0')}:00`,
          color: s.color || '#3b82f6'
        }));
        setSessions(migratedSessions);
      }
      if (prefs.htfOptions) setHtfOptions(prefs.htfOptions);
      if (prefs.ltfOptions) setLtfOptions(prefs.ltfOptions);
      if (prefs.ironRules) setIronRules(prefs.ironRules);
      if (prefs.businessExpenses) setBusinessExpenses(prefs.businessExpenses);
      if (prefs.businessPayouts) setBusinessPayouts(prefs.businessPayouts);
      if (prefs.playbookItems) setPlaybookItems(prefs.playbookItems);
      if (prefs.businessGoals) setBusinessGoals(prefs.businessGoals);
      if (prefs.businessResources) setBusinessResources(prefs.businessResources);
      if (prefs.businessSettings) setBusinessSettings(prefs.businessSettings || { taxRatePct: 15, defaultPropThreshold: 150 });
      if (prefs.psychoMetricsConfig) setPsychoMetrics(prefs.psychoMetricsConfig);
      if (prefs.theme) setTheme(prefs.theme);
      if (prefs.dashboardMode) setDashboardMode(prefs.dashboardMode);
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
      setLoading(false); // Ensure loading is off if no session
    }
  }, [sharedTrade, session]);

  // Phase B: Startup Global Sync (Incremental)
  useEffect(() => {
    if (session && isInitialLoadDone) {
      const syncData = async () => {
        console.log("[Sync] Starting global incremental bridge...");
        const instruments = ['usatechidxusd', 'usa500idxusd'];
        for (const inst of instruments) {
          try {
            await DataService.syncIncremental(inst, (msg) => console.log(`[Sync] ${inst}: ${msg}`));
          } catch (e) {
            console.error(`[Sync] Failed for ${inst}:`, e);
          }
        }
        console.log("[Sync] Background bridge complete.");
      };

      // Delay slightly to not compete with initial load resources
      const timer = setTimeout(syncData, 3000);
      return () => clearTimeout(timer);
    }
  }, [session, isInitialLoadDone]);

  useEffect(() => {
    if (accounts.length > 0 && filters.accounts.length === 0) {
      setFilters(prev => ({ ...prev, accounts: accounts.map(a => a.id) }));
    }
  }, [accounts]);

  // Removed dangerous auto-save effect that was overwriting data.
  // Trades should only be saved explicitly via handlers.

  const isSyncingAccounts = React.useRef(false);
  useEffect(() => {
    if (!sharedTrade && session && isInitialLoadDone && accounts.length > 0 && !isSyncingAccounts.current) {
      const timer = setTimeout(() => {
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
      }, 5000); // 5s debounce for accounts
      return () => clearTimeout(timer);
    }
  }, [accounts, sharedTrade, session, isInitialLoadDone]);

  useEffect(() => {
    if (!sharedTrade && session && isInitialLoadDone) {
      const timer = setTimeout(() => {
        storageService.saveDailyPreps(dailyPreps);
      }, 2000); // 2s debounce for journal
      return () => clearTimeout(timer);
    }
  }, [dailyPreps, sharedTrade, session, isInitialLoadDone]);

  useEffect(() => {
    if (!sharedTrade && session && isInitialLoadDone) {
      const timer = setTimeout(() => {
        storageService.saveDailyReviews(dailyReviews);
      }, 2000); // 2s debounce for journal
      return () => clearTimeout(timer);
    }
  }, [dailyReviews, sharedTrade, session, isInitialLoadDone]);

  useEffect(() => { if (!sharedTrade && session && isInitialLoadDone) storageService.setActiveAccountId(activeAccountId); }, [activeAccountId, sharedTrade, session, isInitialLoadDone]);

  useEffect(() => {
    if (!sharedTrade && session && isInitialLoadDone && weeklyFocusList.length > 0) {
      const timer = setTimeout(() => {
        // We only save the one that might have changed if we wanted to be efficient, 
        // but for now, we'll just handle it in the save function if we use a specific trigger.
        // Or just save all (upsert).
        weeklyFocusList.forEach(wf => storageService.saveWeeklyFocus(wf));
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [weeklyFocusList, sharedTrade, session, isInitialLoadDone]);

  // Handle theme persistence independently of session
  useEffect(() => {
    try {
      localStorage.setItem('alphatrade_theme', theme);
      const stored = localStorage.getItem('alphatrade_preferences');
      const currentPrefs = stored ? JSON.parse(stored) : {};
      if (currentPrefs.theme !== theme) {
        localStorage.setItem('alphatrade_preferences', JSON.stringify({ ...currentPrefs, theme }));
      }
    } catch (e) {
      console.error("Failed to save theme to localStorage", e);
    }
  }, [theme]);

  useEffect(() => {
    if (!sharedTrade && session && isInitialLoadDone) {
      const timer = setTimeout(() => {
        storageService.savePreferences({
          emotions: userEmotions,
          standardMistakes: userMistakes,
          standardGoals: standardGoals,
          dashboardLayout,
          sessions,
          htfOptions,
          ltfOptions,
          ironRules,
          businessExpenses,
          businessPayouts,
          playbookItems,
          businessGoals,
          businessResources,
          businessSettings,
          psychoMetricsConfig: psychoMetrics,
          theme,
          dashboardMode,

        });
      }, 5000); // 5s debounce for preferences
      return () => clearTimeout(timer);
    }
  }, [userEmotions, userMistakes, standardGoals, dashboardLayout, sessions, htfOptions, ltfOptions, ironRules, businessExpenses, businessPayouts, playbookItems, businessGoals, businessResources, businessSettings, psychoMetrics, theme, dashboardMode, sharedTrade, session, isInitialLoadDone]);

  // Handle Dashboard Mode Switching
  useEffect(() => {
    // Only auto-update filters if we are on dashboard to avoid disrupting other views, 
    // though "activePage" dependency might be enough.
    if (activePage === 'dashboard' || isInitialLoadDone) {
      if (dashboardMode === 'combined') {
        // Show all accounts (clear filter)
        // Only clear if we are switching TO combined, or maybe just leave it?
        // User said: "All-in". Usually implies no filter.
        setFilters(prev => ({ ...prev, accounts: [] }));
      } else if (dashboardMode === 'funded') {
        // Select Live accounts and Prop accounts that are in Funded phase
        const fundedIds = accounts
          .filter(a => (a.type === 'Funded' && a.phase === 'Funded') || a.type === 'Live')
          .map(a => a.id);
        setFilters(prev => ({ ...prev, accounts: fundedIds }));

      } else if (dashboardMode === 'challenge') {
        // IMPORTANT: Show all Prop accounts (Funded type), even if they are now in 'Funded' phase,
        // because we want to see the whole journey? 
        // OR filtering by 'Challenge' phase only?
        // User request: "kdyz zaskrtnu ze chci pouze funded" -> He implies "Funded ONLY".
        // "Challenge" usually implies active challenges. 
        // Let's stick to phase 'Challenge'.
        const challengeIds = accounts
          .filter(a => a.type === 'Funded' && a.phase === 'Challenge')
          .map(a => a.id);
        setFilters(prev => ({ ...prev, accounts: challengeIds }));
      } else if (dashboardMode === 'archive') {
        // Show only archived accounts (Challenge or Funded) that are archived
        const archivedIds = accounts
          .filter(a => a.isArchived)
          .map(a => a.id);
        setFilters(prev => ({ ...prev, accounts: archivedIds }));
      }

      // Persist immediately to local storage to survive refresh
      localStorage.setItem('alphatrade_dash_mode', dashboardMode);

    }
  }, [dashboardMode, accounts, activePage, isInitialLoadDone]);


  const contextAccounts = useMemo(() => {
    if (activePage !== 'dashboard') return accounts;
    if (dashboardMode === 'combined') return accounts;
    if (dashboardMode === 'funded') return accounts.filter(a => (a.type === 'Funded' && a.phase === 'Funded') || a.type === 'Live');
    if (dashboardMode === 'challenge') return accounts.filter(a => a.phase === 'Challenge' || (a.type === 'Funded' && a.isArchived));
    return accounts;
  }, [accounts, activePage, dashboardMode]);

  const activeAccount = useMemo(() => accounts.find(a => a.id === activeAccountId) || accounts[0] || DEFAULT_ACCOUNT, [accounts, activeAccountId]);

  const displayBalance = useMemo(() => {
    if (viewMode === 'individual') return activeAccount.initialBalance || 0;
    // Sum initial balances of all accounts that are in the current context (including masters and copies)
    return contextAccounts
      .reduce((sum, a) => sum + (a.initialBalance || 0), 0);
  }, [contextAccounts, activeAccount, viewMode]);

  const displayTrades = useMemo(() => {
    if (viewMode === 'individual') return trades;

    const grouped = new Map<string, Trade[]>();
    const independent: Trade[] = [];

    trades.forEach(t => {
      // Logic: If it's a copy, group by masterTradeId. If it's a master, group by its own ID.
      const key = t.masterTradeId || (t.isMaster ? t.id : t.groupId);
      if (key) {
        if (!grouped.has(key as string)) grouped.set(key as string, []);
        grouped.get(key as string)!.push(t);
      } else {
        independent.push(t);
      }
    });

    const aggregated: Trade[] = Array.from(grouped.values()).map(group => {
      const master = group.find(t => t.isMaster) || group[0];
      return {
        ...master,
        pnl: group.reduce((sum, t) => sum + t.pnl, 0),
        riskAmount: group.reduce((sum, t) => sum + (t.riskAmount || 0), 0),
        targetAmount: group.reduce((sum, t) => sum + (t.targetAmount || 0), 0),
        // Keep other metadata from master
      };
    });

    return [...independent, ...aggregated].sort((a, b) => b.timestamp - a.timestamp);
  }, [trades, viewMode]);

  const stats = useMemo(() => {
    try {
      return calculateStats(displayTrades, displayBalance);
    } catch (e) {
      console.error("Stats calculation error:", e);
      return calculateStats([], 0);
    }
  }, [displayTrades, displayBalance]);

  const filteredDisplayTrades = useMemo(() => {
    const now = new Date();
    return displayTrades.filter(t => {
      // Filter by phase based on dashboardMode
      if (dashboardMode === 'challenge') {
        const isChallenge = t.phase === 'Challenge' || (!t.phase && accounts.find(a => a.id === t.accountId)?.phase === 'Challenge');
        if (!isChallenge) return false;
      } else if (dashboardMode === 'funded') {
        const isFunded = t.phase === 'Funded' || (!t.phase && (accounts.find(a => a.id === t.accountId)?.type === 'Live' || accounts.find(a => a.id === t.accountId)?.phase === 'Funded'));
        if (!isFunded) return false;
      }

      const d = new Date(t.date);
      const h = new Date(t.timestamp).getHours();
      const dayName = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'][d.getDay()];
      const status = t.executionStatus || 'Valid';

      const matchDay = filters.days.includes(dayName);
      const matchHour = filters.hours.includes(h);

      let matchAcc = false;
      if (viewMode === 'combined') {
        // In combined mode, if filtering by accounts, include trades from both master and its children
        if (filters.accounts.length === 0) {
          matchAcc = true;
        } else {
          matchAcc = filters.accounts.some(filterId => {
            const isTarget = t.accountId === filterId;
            const isChildOfTarget = t.masterTradeId && t.accountId !== filterId; // Simplified check
            // More robust: does this trade's account have a parent that is in filters?
            const acc = accounts.find(a => a.id === t.accountId);
            return isTarget || (acc?.parentAccountId && filters.accounts.includes(acc.parentAccountId));
          });
        }
      } else {
        matchAcc = filters.accounts.includes(t.accountId);
      }

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
  }, [displayTrades, filters, viewMode]);

  const filteredStats = useMemo(() => {
    try {
      return calculateStats(filteredDisplayTrades, displayBalance);
    } catch (e) {
      console.error("Filtered stats calculation error:", e);
      return calculateStats([], 0);
    }
  }, [filteredDisplayTrades, displayBalance]);

  const badExits = useMemo(() => findBadExits(filteredDisplayTrades), [filteredDisplayTrades]);

  if (loading && !sharedTrade) {
    return (
      <div className="min-h-screen bg-[var(--bg-page)] flex items-center justify-center transition-colors duration-300">
        <div className="flex flex-col items-center gap-6 p-8 text-center max-w-sm">
          <div className="relative">
            <div className="w-16 h-16 border-4 border-blue-600/20 border-t-blue-600 rounded-full animate-spin"></div>
            <LayoutGrid className="absolute inset-0 m-auto w-6 h-6 text-blue-600 animate-pulse" />
          </div>

          <div className="space-y-2">
            <p className="text-[var(--text-primary)] font-bold uppercase tracking-[0.2em] text-xs">AlphaTrade Mentor</p>
            <p className="text-[var(--text-secondary)] text-sm animate-pulse">{initStatus}</p>
          </div>

          {(showRetry || isInitialLoadDone) && (
            <div className="pt-4 space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <p className="text-xs text-amber-500 bg-amber-500/10 px-3 py-2 rounded-lg">
                {showRetry ? "Načítání trvá déle než obvykle. Vercel se možná probouzí." : "Data jsou připravena."}
              </p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => setLoading(false)}
                  className="flex items-center justify-center gap-2 px-6 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-full text-sm font-medium transition-all transform hover:scale-105 active:scale-95 shadow-lg shadow-emerald-600/20"
                >
                  <Zap className="w-4 h-4" />
                  Vstoupit (Offline režim)
                </button>
                <button
                  onClick={() => window.location.reload()}
                  className="flex items-center justify-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-full text-sm font-medium transition-all transform hover:scale-105 active:scale-95 shadow-lg shadow-blue-600/20"
                >
                  Zkusit znovu
                </button>
              </div>
            </div>
          )}
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
    const activeAccount = accounts.find(a => a.id === activeAccountId);
    const newTrades = normalizeTrades(data, activeAccountId).map(t => ({
      ...t,
      phase: activeAccount?.phase || 'Challenge'
    }));
    const uniqueTrades = [...trades];
    newTrades.forEach(nt => {
      if (!uniqueTrades.some(t => t.id === nt.id && t.accountId === activeAccountId)) {
        uniqueTrades.push(nt);
      }
    });
    setTrades(uniqueTrades);
  };

  const handleManualTrade = (tradeOrTrades: Trade | Trade[]) => {
    const newTradesArray = Array.isArray(tradeOrTrades) ? tradeOrTrades : [tradeOrTrades];

    setTrades(prev => {
      let updated = [...prev];
      newTradesArray.forEach(t => {
        const idx = updated.findIndex(existing => existing.id === t.id);
        if (idx !== -1) {
          updated[idx] = { ...t, id: t.id }; // Update existing
        } else {
          updated.push({ ...t, id: t.id || crypto.randomUUID() }); // Add new
        }
      });
      // Force save immediately for manual entry to be safe
      storageService.saveTrades(updated).catch(err => console.error("Manual trade save failed", err));
      return updated;
    });

    setIsManualEntryOpen(false);
    setEditTrade(null);
  };

  const handleUpdateTrades = (updatedTrades: Trade[]) => {
    setTrades(updatedTrades);
    // Force immediate save to persist "stamps" like 'Challenge' phase
    storageService.saveTrades(updatedTrades).then(() => {
      console.log("Trades force-saved successfully");
    }).catch(err => {
      console.error("Failed to force-save trades", err);
      setSyncError("Nepodařilo se uložit změny obchodů.");
    });
  };

  const handleUpdateTrade = (tradeId: string | number, updates: Partial<Trade>) => {
    setTrades(prev => prev.map(t => t.id === tradeId ? { ...t, ...updates } : t));
  };

  const handleDeletePrep = async (date: string) => {
    try {
      await storageService.deleteDailyPrep(date);
      setDailyPreps(prev => prev.filter(p => p.date !== date));
    } catch (err) {
      console.error("Failed to delete prep", err);
      setSyncError("Nepodařilo se smazat ranní přípravu.");
    }
  };

  const handleDeleteReview = async (date: string) => {
    try {
      await storageService.deleteDailyReview(date);
      setDailyReviews(prev => prev.filter(r => r.date !== date));
    } catch (err) {
      console.error("Failed to delete review", err);
      setSyncError("Nepodařilo se smazat večerní audit.");
    }
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

  const handleDeleteTrade = async (id: number | string) => {
    try {
      const tradeToDelete = trades.find(t => t.id === id);
      if (!tradeToDelete) return;

      const idsToDelete = [id];
      // If it's a master, delete all copies too
      if (tradeToDelete.isMaster) {
        const copies = trades.filter(t => t.masterTradeId === id).map(t => t.id);
        idsToDelete.push(...copies);
      }

      // 1. Update local state
      setTrades(prev => prev.filter(t => !idsToDelete.includes(t.id)));

      // 2. Clear from Supabase
      for (const tradeId of idsToDelete) {
        await storageService.deleteTrade(tradeId as string);
      }
    } catch (err) {
      console.error("Failed to delete trade:", err);
      // In case of error, maybe reload?
    }
  };

  const handleClearTrades = async () => {
    if (!window.confirm("Opravdu chcete smazat VŠECHNY obchody? Tato akce je nevratná.")) return;
    try {
      setTrades([]);
      await storageService.clearTrades(activeAccountId);
    } catch (err) {
      console.error("Failed to clear trades:", err);
    }
  };

  return (
    <div
      className={`min-h-screen font-sans flex transition-colors duration-300 ${theme === 'light' ? 'light-theme' : (theme === 'oled' ? 'oled-theme' : '')} bg-[var(--bg-page)] text-[var(--text-primary)]`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
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
        onOpenProfile={() => setActivePage('profile')}
        onNavigate={(page) => {
          setActivePage(page);
          setIsSidebarOpen(false);
        }}
      />

      <main className={`flex-1 transition-all duration-300 relative flex flex-col ${isSidebarCollapsed ? 'lg:ml-24' : 'lg:ml-72'}`}>
        <header className={`sticky top-0 z-40 border-b backdrop-blur-md px-6 py-4 flex items-center justify-between transition-all bg-[var(--bg-page)]/80 border-[var(--border-subtle)]`}>
          <div className="flex items-center gap-4">
            <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden p-2 hover:bg-white/10 rounded-lg"><Menu size={20} /></button>
            <h2 className="text-xl font-black uppercase tracking-tighter">
              {activePage === 'dashboard' && 'Dashboard'}
              {activePage === 'history' && 'Trade Log'}
              {activePage === 'journal' && 'Tactical Hub'}
              {activePage === 'accounts' && 'Portfolio'}
              {activePage === 'settings' && 'System Config'}
              {activePage === 'network' && 'Network Hub'}
              {activePage === 'business' && 'Business Hub'}
            </h2>
          </div>

          <div className="flex items-center gap-6">
            {/* Dashboard Mode Status - Clean Text Design */}
            <div className="hidden md:flex items-center h-12 px-4">
              <div className="flex items-center gap-2.5">
                <div className="relative flex h-2 w-2">
                  <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${dashboardMode === 'funded' ? 'animate-ping bg-emerald-400' : 'hidden'}`}></span>
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${dashboardMode === 'funded' ? 'bg-emerald-500' : dashboardMode === 'challenge' ? 'bg-blue-500' : 'bg-orange-500'}`}></span>
                </div>
                <span className={`text-[10px] font-black uppercase tracking-[0.2em] ${dashboardMode === 'funded' ? 'text-emerald-400' : dashboardMode === 'challenge' ? 'text-blue-400' : 'text-orange-400'}`}>
                  {dashboardMode === 'funded' ? 'Funded' : dashboardMode === 'challenge' ? 'Challenge' : 'All'}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <FilterDropdown
                filters={filters}
                setFilters={setFilters}
                accounts={contextAccounts}
                trades={trades}
                theme={theme}
                isDashboardEditing={activePage === 'dashboard' ? isDashboardEditing : undefined}
                setIsDashboardEditing={activePage === 'dashboard' ? setIsDashboardEditing : undefined}
                dashboardMode={dashboardMode}
                setDashboardMode={setDashboardMode}
                viewMode={viewMode}
                setViewMode={setViewMode}
              />

              <button
                onClick={() => {
                  let newTheme: 'dark' | 'light' | 'oled' = 'dark';
                  if (theme === 'dark') newTheme = 'light';
                  else if (theme === 'light') newTheme = 'oled';
                  setTheme(newTheme);
                }}
                className={`p-2 rounded-xl border transition-all ${theme !== 'light' ? 'bg-white/5 border-white/10 hover:bg-white/10 text-white' : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-700 shadow-sm'}`}
              >
                {theme === 'light' ? <Sun size={20} /> : (theme === 'oled' ? <Zap size={20} className="text-blue-500" /> : <Moon size={20} />)}
              </button>
            </div>
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
                  stats={filteredStats}
                  theme={theme}
                  preps={dailyPreps}
                  reviews={dailyReviews}
                  layout={dashboardLayout}
                  sessions={sessions}
                  ironRules={ironRules}
                  onUpdateLayout={setDashboardLayout}
                  isEditing={isDashboardEditing}
                  onCloseEdit={() => setIsDashboardEditing(false)}
                  dashboardMode={dashboardMode}
                  setDashboardMode={setDashboardMode}
                  accounts={accounts}
                  emotions={userEmotions}
                  viewMode={viewMode}
                  onDeleteTrade={handleDeleteTrade}
                  onEditTrade={(t) => { setEditTrade(t); setIsManualEntryOpen(true); }}
                  onUpdateTrade={handleUpdateTrade}
                  user={currentUser}
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
                    trades={filteredDisplayTrades}
                    accounts={accounts}
                    onDelete={handleDeleteTrade}
                    onEdit={(t) => { setEditTrade(t); setIsManualEntryOpen(true); }}
                    onUpdateTrade={handleUpdateTrade}
                    onClear={handleClearTrades}
                    theme={theme}
                    emotions={userEmotions}
                  />
                )
              )}

              {activePage === 'journal' && (
                <DailyJournal
                  theme={theme}
                  trades={filteredDisplayTrades}
                  preps={dailyPreps}
                  reviews={dailyReviews}
                  onSavePrep={handleSavePrep}
                  onSaveReview={handleSaveReview}
                  onDeletePrep={handleDeletePrep}
                  onDeleteReview={handleDeleteReview}
                  standardGoals={standardGoals}
                  ironRules={ironRules}
                  psychoMetrics={psychoMetrics}
                  viewMode={viewMode}
                  weeklyFocusList={weeklyFocusList}
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
                  onUpdateTrades={handleUpdateTrades}
                  onAddExpense={(exp) => { setBusinessExpenses(prev => [...prev, exp]); isPreferencesDirty.current = true; }}
                />
              )}

              {activePage === 'network' && (
                <NetworkHub theme={theme} accounts={accounts} emotions={userEmotions} />
              )}




              {activePage === 'settings' && (
                <Settings
                  theme={theme}
                  userEmotions={userEmotions} setUserEmotions={(v) => { setUserEmotions(v); isPreferencesDirty.current = true; }}
                  userMistakes={userMistakes} setUserMistakes={(v) => { setUserMistakes(v); isPreferencesDirty.current = true; }}
                  htfOptions={htfOptions} setHtfOptions={(v) => { setHtfOptions(v); isPreferencesDirty.current = true; }}
                  ltfOptions={ltfOptions} setLtfOptions={(v) => { setLtfOptions(v); isPreferencesDirty.current = true; }}
                  sessions={sessions} setSessions={(v) => { setSessions(v); isPreferencesDirty.current = true; }}
                  ironRules={ironRules}
                  setIronRules={(v) => { setIronRules(v); isPreferencesDirty.current = true; }}
                  psychoMetrics={psychoMetrics}
                  setPsychoMetrics={(v) => { setPsychoMetrics(v); isPreferencesDirty.current = true; }}
                  weeklyFocusList={weeklyFocusList}
                  setWeeklyFocusList={(v) => { setWeeklyFocusList(v); isJournalDirty.current = true; }}
                />
              )}

              {activePage === 'business' && (
                <BusinessHub
                  theme={theme}
                  trades={trades}
                  accounts={accounts}
                  expenses={businessExpenses}
                  payouts={businessPayouts}
                  playbook={playbookItems}
                  goals={businessGoals}
                  resources={businessResources}
                  settings={businessSettings}
                  onUpdateExpenses={(v) => { setBusinessExpenses(v); isPreferencesDirty.current = true; }}
                  onUpdatePayouts={(v) => { setBusinessPayouts(v); isPreferencesDirty.current = true; }}
                  onUpdatePlaybook={(v) => { setPlaybookItems(v); isPreferencesDirty.current = true; }}
                  onUpdateGoals={(v) => { setBusinessGoals(v); isPreferencesDirty.current = true; }}
                  onUpdateResources={(v) => { setBusinessResources(v); isPreferencesDirty.current = true; }}
                  onUpdateSettings={(v) => { setBusinessSettings(v); isPreferencesDirty.current = true; }}
                  onUpdateAccounts={setAccounts}
                />
              )}
            </>
          )}
        </div>
      </main >

      {isManualEntryOpen && (
        <ManualTradeForm
          onAdd={handleManualTrade}
          onClose={() => { setIsManualEntryOpen(false); setEditTrade(null); }}
          theme={theme}
          editTrade={editTrade || undefined}
          // Pass all trades that belong to the same group as the edited trade
          existingGroupTrades={editTrade ? trades.filter(t =>
            (t.groupId && t.groupId === editTrade.groupId) ||
            (t.masterTradeId === editTrade.id) ||
            (editTrade.masterTradeId && t.id === editTrade.masterTradeId)
          ) : undefined}
          accounts={accounts}
          activeAccountId={activeAccountId}
          availableEmotions={userEmotions}
          availableMistakes={userMistakes}
          availableHtfOptions={htfOptions}
          availableLtfOptions={ltfOptions}
          viewMode={viewMode}
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
    </div >
  );
};

export default App;
