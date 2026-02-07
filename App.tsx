
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { normalizeTrades, calculateStats, findBadExits } from './services/analysis';
import { storageService } from './services/storageService';
import { Trade, Account, TradeFilters, CustomEmotion, User, DailyPrep, DailyReview, UserPreferences, DashboardWidgetConfig, SessionConfig, IronRule, BusinessExpense, BusinessPayout, PlaybookItem, BusinessGoal, BusinessResource, BusinessSettings, PsychoMetricConfig, DashboardMode, WeeklyFocus, PnLDisplayMode, ConstitutionRule, CareerCheckpoint } from './types';
const Dashboard = React.lazy(() => import('./components/Dashboard'));
const ManualTradeForm = React.lazy(() => import('./components/ManualTradeForm'));
const TradeHistory = React.lazy(() => import('./components/TradeHistory'));
const Settings = React.lazy(() => import('./components/Settings'));
const AccountsManager = React.lazy(() => import('./components/AccountsManager'));
const DailyJournal = React.lazy(() => import('./components/DailyJournal'));
const UserProfileModal = React.lazy(() => import('./components/UserProfileModal'));
const NetworkHub = React.lazy(() => import('./components/NetworkHub'));
const BusinessHub = React.lazy(() => import('./components/BusinessHub'));
const FileUpload = React.lazy(() => import('./components/FileUpload'));

import Sidebar from './components/Sidebar';
import FilterDropdown from './components/FilterDropdown';
import Auth from './components/Auth';
import QuantumLoader from './components/QuantumLoader';
import { PullToRefresh } from './components/PullToRefresh';
import ConfirmationModal from './components/ConfirmationModal';
import SharedTradeView from './components/SharedTradeView';
import { currencyService, ExchangeRates } from './services/currencyService';
import { t } from './services/translations';
import { GuardianIntervention, GuardianOverlay, DebtCollector } from './components/GuardianSystem';
import { getGuardianState, GuardianState } from './utils/guardianLogic';
import { requestNotificationPermission, sendLocalNotification } from './utils/notificationHelper';
import { subscribeUserToPush } from './utils/pushManager';
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
  Layers,
  RefreshCw
} from 'lucide-react';

import { supabase } from './services/supabase';

const APP_VERSION = "1.5.2 [MATRIX-UPDATE]";

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

const DEFAULT_CONSTITUTION: ConstitutionRule[] = [
  { id: 'c_daily_loss', label: 'Denní Limit Ztráty', type: 'daily_loss', value: 1, unit: '%', action: 'stop_trading', penaltyDays: 1, isActive: true, description: 'Max 1 % účtu / den. -1 % = okamžitý konec dne.' },
  { id: 'c_daily_trades', label: 'Max Počet Obchodů', type: 'daily_trades', value: 2, unit: 'trades', action: 'warning', isActive: true, description: 'Max 2 obchody denně.' },
  { id: 'c_weekly_loss', label: 'Týdenní Limit Ztráty', type: 'weekly_loss', value: 3, unit: '%', action: 'stop_trading', penaltyDays: 3, isActive: true, description: 'Max -3 % týdně. Při dosažení zbytek týdne pouze replay.' },
  { id: 'c_kill_switch', label: 'Absolutní Kill-Switch', type: 'absolute_dd', value: 10, unit: '%', action: 'reset', isActive: true, description: 'DD -10 % od začátku období = konec experimentu.' }
];

const DEFAULT_ROADMAP: CareerCheckpoint[] = [
  { id: 'cp_30', label: 'Checkpoint 30 Dní', dayTarget: 30, description: 'První měsíc v procesu', status: 'active', criteria: [{ label: 'Max DD < 5%', metric: 'dd', condition: '<', targetValue: 5 }], rules: DEFAULT_CONSTITUTION },
  { id: 'cp_60', label: 'Checkpoint 60 Dní', dayTarget: 60, description: 'Stabilizace disciplíny', status: 'locked', criteria: [{ label: 'Risk Adherence 100%', metric: 'risk_adherence', condition: '==', targetValue: 100 }], rules: DEFAULT_CONSTITUTION },
  { id: 'cp_150', label: 'Finální Verdikt', dayTarget: 150, description: 'Rozhodnutí o budoucnosti tradingu', status: 'locked', criteria: [{ label: 'Max DD < 10%', metric: 'dd', condition: '<', targetValue: 10 }], rules: DEFAULT_CONSTITUTION }
];



const aggregateTrades = (trades: Trade[]): Trade[] => {
  const groups = new Map<string, Trade[]>();
  const independent: Trade[] = [];

  trades.forEach(t => {
    if (t.groupId) {
      if (!groups.has(t.groupId)) groups.set(t.groupId, []);
      groups.get(t.groupId)!.push(t);
    } else {
      independent.push(t);
    }
  });

  const aggregated: Trade[] = [...independent];

  groups.forEach((groupTrades, groupId) => {
    // Find master trade or just pick the first one
    const master = groupTrades.find(t => t.isMaster) || groupTrades[0];

    // Create combined trade Object
    const combined: Trade = {
      ...master,
      id: `combined_${groupId}`,
      pnl: groupTrades.reduce((sum, t) => sum + t.pnl, 0),
      riskAmount: groupTrades.reduce((sum, t) => sum + (t.riskAmount || 0), 0),
      notes: `${master.notes || ''} (Kombinováno z ${groupTrades.length} účtů)`.trim(),
      // Ensure we mark it so UI can potentially handle it
      tags: [...(master.tags || []), 'aggregated']
    };
    aggregated.push(combined);
  });

  return aggregated.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
};

// Elegant Loading Fallback for Suspense
const LoadingFallback = () => (
  <div className="flex-1 flex flex-col items-center justify-center min-h-[60vh] animate-in fade-in duration-500">
    <div className="relative">
      <img src="/logos/at_logo_light_clean.png" alt="Loading..." className="w-32 h-32 object-contain animate-spin animate-pulse" style={{ animationDuration: '2s' }} />

    </div>
  </div>
);

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

    setInitStatus("Kontrola přihlášení...");
    console.log("[Auth] Calling getSession()...");
    supabase.auth.getSession().then(({ data: { session: activeSession } }) => {
      console.log(`[Auth] getSession result: ${activeSession ? 'Logged in' : 'No session'}`);
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

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, activeSession) => {
      console.log(`[Auth] Auth state change: ${event}, Session: ${activeSession ? 'Yes' : 'No'}`);

      if (activeSession) {
        // Only trigger session update if it's actually different to avoid loops
        setSession(prev => {
          if (prev?.user?.id === activeSession.user.id && prev?.access_token === activeSession.access_token) {
            return prev;
          }
          return activeSession;
        });

        if (!isInitialLoadDone) setInitStatus("Přihlašuji...");
      }

      if (event === 'SIGNED_OUT') {
        console.log("[Auth] User signed out, resetting all state.");
        setSession(null);
        setLoading(false);
        setIsInitialLoadDone(false);
        lastLoadedSessionId.current = null;

        // Reset all data states to prevent leakage to next user
        setTrades([]);
        setAccounts([]);
        setActiveAccountId('');
        setCurrentUser(DEFAULT_USER);
        setDailyPreps([]);
        setDailyReviews([]);
        setWeeklyFocusList([]);
        setBusinessExpenses([]);
        setBusinessPayouts([]);
        setBusinessGoals([]);
        setBusinessResources([]);
        setPlaybookItems([]);

        // Reset flags
        isJournalDirty.current = false;
        isPreferencesDirty.current = false;

        // Optional: clear entire localStorage on logout for ultimate safety
        localStorage.clear();
      }
    });

    return () => {
      console.log("[Auth] Cleaning up subscription");
      subscription.unsubscribe();
    };
  }, []);

  const [sharedTrade, setSharedTrade] = useState<Trade | null>(null);
  const isPreferencesDirty = useRef(false);
  const isJournalDirty = useRef(false);
  const isFetchingRef = useRef(false);

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

  useEffect(() => {
    localStorage.setItem('alphatrade_dash_mode', dashboardMode);
  }, [dashboardMode]);
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
  const [constitutionRules, setConstitutionRules] = useState<ConstitutionRule[]>(DEFAULT_CONSTITUTION);
  const [careerRoadmap, setCareerRoadmap] = useState<CareerCheckpoint[]>(DEFAULT_ROADMAP);
  const [businessResources, setBusinessResources] = useState<BusinessResource[]>([]);
  const [businessSettings, setBusinessSettings] = useState<BusinessSettings>({ taxRatePct: 15, defaultPropThreshold: 150 });
  const [psychoMetrics, setPsychoMetrics] = useState<PsychoMetricConfig[]>([
    { id: 'mood', label: 'Nálada', color: '#6366f1' },
    { id: 'energy', label: 'Energie', color: '#f59e0b' }
  ]);

  const [weeklyFocusList, setWeeklyFocusList] = useState<WeeklyFocus[]>([]);

  const [systemSettings, setSystemSettings] = useState<any>({
    sessionAlertsEnabled: true,
    sessionStartAlert15m: true,
    sessionStartAlertExact: true,
    sessionEndAlertExact: true,
    sessionEndAlert10m: false,
    guardianEnabled: true,
    morningPrepAlert60m: true,
    morningPrepAlert15m: true,
    morningPrepAlertCritical: true,
    strictModeEnabled: false,
    eveningAuditAlertEnabled: true,
    eveningAuditAlertTime: '21:00',
    morningWakeUpDebtAlert: true
  });

  const [guardian, setGuardian] = useState<GuardianState>({
    isCriticalAlert: false,
    isPrepMissing: true,
    activeSession: null,
    nextSession: null,
    isDebtActive: false,
    showMorningIntervention: false,
    showEveningIntervention: false
  });
  const [isMorningInterventionOpen, setIsMorningInterventionOpen] = useState(false);
  const [isEveningInterventionOpen, setIsEveningInterventionOpen] = useState(false);
  const hasTriggeredMorning = useRef(false);
  const hasTriggeredEvening = useRef(false);
  const [isGuardianOverlayOpen, setIsGuardianOverlayOpen] = useState(false);
  const [isDebtCollectorOpen, setIsDebtCollectorOpen] = useState(false);
  const lastCheckTime = useRef<string>("");

  useEffect(() => {
    const checkGuardian = () => {
      const state = getGuardianState(systemSettings, sessions, dailyPreps, dailyReviews);
      setGuardian(state);

      // Notification Logic
      const now = new Date();
      const timeKey = `${now.getHours()}:${now.getMinutes()}`;
      if (timeKey === lastCheckTime.current) return;
      lastCheckTime.current = timeKey;

      if (systemSettings.sessionAlertsEnabled) {
        sessions.forEach(s => {
          const startH = parseInt(s.startTime.split(':')[0]);
          const startM = parseInt(s.startTime.split(':')[1]);
          const endH = parseInt(s.endTime.split(':')[0]);
          const endM = parseInt(s.endTime.split(':')[1]);

          const diffStart = (startH * 60 + startM) - (now.getHours() * 60 + now.getMinutes());
          const diffEnd = (endH * 60 + endM) - (now.getHours() * 60 + now.getMinutes());

          if (systemSettings.sessionStartAlert15m && diffStart === 15) {
            sendLocalNotification(`Seance ${s.name} začíná za 15m`, "Jsi připraven? Zkontroluj svůj plán.");
          }
          if (systemSettings.sessionStartAlertExact && diffStart === 0) {
            sendLocalNotification(`Seance ${s.name} právě začala`, "Přejeme úspěšný trading!");
          }
          if (systemSettings.sessionEndAlertExact && diffEnd === 0) {
            sendLocalNotification(`Konec seance ${s.name}`, "Je čas zastavit trading a jít na audit.");
          }
          if (systemSettings.sessionEndAlert10m && diffEnd === -10) {
            sendLocalNotification("Audit čeká", "Už je to 10m od konce seance. Máš hotový večerní audit?");
          }
        });

        // Guardian Alerts
        if (state.nextSession && state.isPrepMissing && systemSettings.guardianEnabled) {
          if (systemSettings.morningPrepAlert60m && state.nextSession.minutesToStart === 60) {
            sendLocalNotification("Alpha Guardian: 60m do startu", "Máš dost času na kvalitní přípravu.");
          }
          if (systemSettings.morningPrepAlert15m && state.nextSession.minutesToStart === 15) {
            sendLocalNotification("Alpha Guardian: 15m do startu", "VAROVÁNÍ: Stále nemáš hotovou přípravu!", "/logos/at_logo_light_clean.png");
          }
        }
      }

      if (isInitialLoadDone) {
        if (state.showMorningIntervention && !hasTriggeredMorning.current) {
          setIsMorningInterventionOpen(true);
          hasTriggeredMorning.current = true;
        }
        if (state.showEveningIntervention && !hasTriggeredEvening.current) {
          setIsEveningInterventionOpen(true);
          hasTriggeredEvening.current = true;
        }
      }

      // Reset triggers when conditions no longer met (to allow re-triggering if user ignores but session changes etc)
      if (!state.showMorningIntervention) hasTriggeredMorning.current = false;
      if (!state.showEveningIntervention) hasTriggeredEvening.current = false;

      // Test Mode Notification
      if (systemSettings.testModeEnabled) {
        sendLocalNotification(`Test: ${timeKey}`, "Alpha Guardian Test Notifikace");
      }
    };

    const timer = setInterval(checkGuardian, 30000);
    checkGuardian();
    return () => clearInterval(timer);
  }, [systemSettings, sessions, dailyPreps, dailyReviews]);

  useEffect(() => {
    if (isInitialLoadDone && guardian.isDebtActive && systemSettings.morningWakeUpDebtAlert) {
      setIsDebtCollectorOpen(true);
    }
  }, [isInitialLoadDone, guardian.isDebtActive, systemSettings.morningWakeUpDebtAlert]);

  const handleTryAddTrade = () => {
    if (systemSettings.strictModeEnabled && guardian.isPrepMissing) {
      setIsGuardianOverlayOpen(true);
    } else {
      setIsManualEntryOpen(true);
    }
  };

  const handleApplyNotificationPermission = async () => {
    const granted = await requestNotificationPermission();
    if (granted) {
      try {
        const sub = await subscribeUserToPush();

        if (sub && (sub as any).endpoint) {
          const currentPrefs = currentUserPreferences();
          const updatedPrefs = { ...currentPrefs, pushSubscription: sub };
          await storageService.savePreferences(updatedPrefs as any);
          alert("✅ HOTOVO!\nNotifikace na pozadí byly úspěšně aktivovány.");
        }
      } catch (err: any) {
        alert("❌ CHYBA AKTIVACE:\n" + err.message);
      }
    } else {
      alert("⚠️ Oznámení nejsou v prohlížeči povolena.");
    }
  };

  const handleHardRefresh = async () => {
    if (confirm("Opravdu chcete vyčistit mezipaměť a restartovat aplikaci?")) {
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (let registration of registrations) {
          await registration.unregister();
        }
      }
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        for (let name of cacheNames) {
          await caches.delete(name);
        }
      }
      localStorage.removeItem('alphatrade_preferences');
      window.location.reload();
    }
  };

  // Helper to get current prefs state
  // NOTE: Business Hub data (expenses, payouts, goals, resources) excluded - they use dedicated tables
  const currentUserPreferences = () => ({
    emotions: userEmotions,
    standardGoals,
    standardMistakes: userMistakes,
    dashboardLayout,
    sessions,
    htfOptions,
    ltfOptions,
    ironRules,
    playbookItems,
    businessSettings,
    psychoMetricsConfig: psychoMetrics,
    theme,
    dashboardMode,
    systemSettings
  });


  const [activePage, setActivePage] = useState('dashboard');
  const [isClearTradesModalOpen, setIsClearTradesModalOpen] = useState(false);
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

  const [accentColor, setAccentColor] = useState<string>(() => {
    try {
      const stored = localStorage.getItem('alphatrade_accent_color');
      if (stored) {
        document.documentElement.dataset.accent = stored;
        return stored;
      }
      const prefs = localStorage.getItem('alphatrade_preferences');
      if (prefs) {
        const parsed = JSON.parse(prefs);
        if (parsed.accentColor) {
          document.documentElement.dataset.accent = parsed.accentColor;
          return parsed.accentColor;
        }
      }
    } catch (e) { }
    document.documentElement.dataset.accent = 'blue';
    return 'blue';
  });

  const handleAccentColorChange = (color: string) => {
    setAccentColor(color);
    document.documentElement.dataset.accent = color;
    localStorage.setItem('alphatrade_accent_color', color);
  };

  // Fix theme switching - properly manage CSS classes
  useEffect(() => {
    // Remove all theme classes first
    document.documentElement.classList.remove('light-theme', 'oled-theme');

    // Add the appropriate class for current theme
    if (theme === 'light') {
      document.documentElement.classList.add('light-theme');
    } else if (theme === 'oled') {
      document.documentElement.classList.add('oled-theme');
    }
    // dark theme has no class (default)
  }, [theme]);

  const [viewMode, setViewMode] = useState<'individual' | 'combined'>(
    (localStorage.getItem('alphatrade_view_mode') as 'individual' | 'combined') || 'individual'
  );

  useEffect(() => {
    localStorage.setItem('alphatrade_view_mode', viewMode);
  }, [viewMode]);

  const [pnlDisplayMode, setPnlDisplayMode] = useState<PnLDisplayMode>(
    (localStorage.getItem('alphatrade_pnl_display_mode') as PnLDisplayMode) || 'usd'
  );

  useEffect(() => {
    localStorage.setItem('alphatrade_pnl_display_mode', pnlDisplayMode);
  }, [pnlDisplayMode]);

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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
  const [isManualEntryOpen, setIsManualEntryOpen] = useState(false);
  const [isDashboardEditing, setIsDashboardEditing] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRates | null>(null);
  const lastLoadedSessionId = React.useRef<string | null>(null);

  const handleSavePrep = useCallback((prep: DailyPrep) => {
    isJournalDirty.current = true;
    setDailyPreps(prev => [...prev.filter(p => p.date !== prep.date), prep]);
  }, []);

  const handleSaveReview = useCallback((rev: DailyReview) => {
    isJournalDirty.current = true;
    setDailyReviews(prev => [...prev.filter(r => r.date !== rev.date), rev]);
  }, []);

  const applyPreferences = useCallback((prefs: UserPreferences) => {
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
    // Business Hub data (expenses, payouts, goals, resources) now use dedicated Supabase tables
    // DO NOT apply from preferences - prevents stale data overwriting fresh table data
    if (prefs.playbookItems) setPlaybookItems(prefs.playbookItems);
    if (prefs.constitutionRules) setConstitutionRules(prefs.constitutionRules);
    if (prefs.careerRoadmap) setCareerRoadmap(prefs.careerRoadmap);
    if (prefs.businessSettings) setBusinessSettings(prefs.businessSettings || { taxRatePct: 15, defaultPropThreshold: 150 });
    if (prefs.psychoMetricsConfig) setPsychoMetrics(prefs.psychoMetricsConfig);
    if (prefs.theme) setTheme(prefs.theme);
    if (prefs.dashboardMode) setDashboardMode(prefs.dashboardMode);
    if (prefs.systemSettings) setSystemSettings(prefs.systemSettings);
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
    currencyService.getRates().then(setExchangeRates);
  }, []);

  useEffect(() => {
    if (sharedTrade) return;
    if (!session) return;

    const load = async () => {
      if (isFetchingRef.current) return;

      // Avoid redundant loads if the session is the same
      if (session?.user?.id === lastLoadedSessionId.current && isInitialLoadDone) {
        setLoading(false);
        return;
      }

      isFetchingRef.current = true;
      lastLoadedSessionId.current = session?.user?.id || null;

      // Safety timeout in case everything hangs
      const safetyTimer = setTimeout(() => {
        if (loading && !isInitialLoadDone) {
          console.warn("[Load] Safety timeout reached. Forcing dashboard display.");
          setLoading(false);
          setIsInitialLoadDone(true);
          isFetchingRef.current = false;
        }
      }, 15000);

      const lastUserId = localStorage.getItem('alphatrade_last_session_user');
      if (lastUserId && lastUserId !== session.user.id) {
        console.warn(`[Safety] User switched: ${lastUserId.slice(0, 8)}... → ${session.user.id.slice(0, 8)}...`);

        // SAFE: Only remove data from the PREVIOUS user
        const keysToRemove = Object.keys(localStorage).filter(k =>
          k.startsWith('alphatrade_') && k.includes(lastUserId)
        );

        keysToRemove.forEach(k => {
          localStorage.removeItem(k);
          console.log(`[Safety] Removed old user data: ${k}`);
        });

        console.log(`[Safety] Cleaned ${keysToRemove.length} old user keys (selective cleanup)`);
      }
      localStorage.setItem('alphatrade_last_session_user', session.user.id);

      // Cleanup ALL legacy localStorage data (now using IndexedDB for large data)
      // This frees up quota that was causing errors
      const keysToRemove = Object.keys(localStorage).filter(k =>
        k.includes('alphatrade_trades') ||
        k.includes('alphatrade_daily_preps') ||
        k.includes('alphatrade_daily_reviews') ||
        k.includes('alphatrade_cache_timestamp') // Remove old cache timestamp strategy
      );
      keysToRemove.forEach(k => localStorage.removeItem(k));


      // --- SIMPLE RELIABLE LOADING: Server-First ---
      console.log("[Load] Starting simple server data load...");
      setInitStatus("Načítám data...");

      try {
        // OPTIMIZED: Fetch critical data first, Business Hub data is loaded lazily
        // This reduces initial load from 11 to 7 API calls (saves ~3-4 seconds)

        // ⏱️ PERFORMANCE MEASUREMENT - Individual API calls
        console.time('[Perf] TOTAL LOAD');

        const timedFetch = async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
          console.time(`[Perf] ${name}`);
          const result = await fn();
          console.timeEnd(`[Perf] ${name}`);
          return result;
        };

        const [dbTrades, dbAccounts, dbPreps, dbReviews, dbPrefs, dbUser, dbWeeklyFocus, dbPayouts] = await Promise.all([
          timedFetch('trades', () => storageService.getTrades()),
          timedFetch('accounts', () => storageService.getAccounts()),
          timedFetch('dailyPreps', () => storageService.getDailyPreps()),
          timedFetch('dailyReviews', () => storageService.getDailyReviews()),
          timedFetch('preferences', () => storageService.getPreferences()),
          timedFetch('user', () => storageService.getUser()),
          timedFetch('weeklyFocus', () => storageService.getWeeklyFocusList()),
          timedFetch('payouts', () => storageService.getBusinessPayouts())
        ]);

        console.timeEnd('[Perf] TOTAL LOAD');
        console.log(`[Load] Success! Loaded ${dbTrades?.length || 0} trades, ${dbAccounts?.length || 0} accounts, ${dbPayouts?.length || 0} payouts`);

        // Update state with fresh data
        setTrades(dbTrades || []);

        if (dbAccounts && dbAccounts.length > 0) {
          setAccounts(dbAccounts);
          const activeId = storageService.getActiveAccountId();
          setActiveAccountId(activeId || dbAccounts[0].id);
        } else {
          setAccounts([DEFAULT_ACCOUNT]);
          setActiveAccountId(DEFAULT_ACCOUNT.id);
        }

        if (dbUser) setCurrentUser(dbUser);
        if (dbPrefs) applyPreferences(dbPrefs);
        setDailyPreps(dbPreps || []);
        setDailyReviews(dbReviews || []);
        setWeeklyFocusList(dbWeeklyFocus || []);
        setBusinessPayouts(dbPayouts || []);
        // Business Hub data (expenses, goals, resources) loaded lazily when entering BusinessHub

        setSyncError(null);
        setLoading(false);
        setIsInitialLoadDone(true);

      } catch (error: any) {
        console.error("[Load] Server fetch error:", error);
        setAppError(error.message || "Nepodařilo se načíst data ze serveru");
        setLoading(false);
        setIsInitialLoadDone(true);
      } finally {
        isFetchingRef.current = false;
        clearTimeout(safetyTimer);
      }
    };

    // Helper to apply preferences to state


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

  // Realtime channel ref for cleanup
  const realtimeChannelRef = useRef<any>(null);

  // START REALTIME SYNC - Delayed until after initial load to prevent WebSocket blocking REST API
  useEffect(() => {
    if (!session || !isInitialLoadDone) return;

    // Delay Realtime subscription to avoid WebSocket connection attempts blocking initial REST calls
    const realtimeTimer = setTimeout(() => {
      console.log("[Realtime] Setting up trades subscription (delayed start)...");

      const tradesChannel = supabase
        .channel('public:trades')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'trades',
            filter: `user_id=eq.${session.user.id}`
          },
          async (payload) => {
            console.log("[Realtime] Trade change detected:", payload.eventType);

            if (payload.eventType === 'INSERT') {
              const raw = payload.new;
              const fullTrade = await storageService.getTradeById(raw.id);
              if (fullTrade) {
                setTrades(prev => {
                  if (prev.some(t => t.id === fullTrade.id)) return prev;
                  const newTrades = [fullTrade, ...prev].sort((a, b) => b.timestamp - a.timestamp);
                  return newTrades;
                });

                try {
                  const { addTradeToCache } = await import('./services/cacheHelper');
                  await addTradeToCache(fullTrade);
                  console.log('[Realtime] Trade added to cache for persistence');
                } catch (err) {
                  console.error('[Realtime] Failed to update cache:', err);
                }
              }
            } else if (payload.eventType === 'UPDATE') {
              const raw = payload.new;
              const fullTrade = await storageService.getTradeById(raw.id);
              if (fullTrade) {
                setTrades(prev => prev.map(t => t.id === fullTrade.id ? fullTrade : t));
              }
            } else if (payload.eventType === 'DELETE') {
              setTrades(prev => prev.filter(t => t.id !== payload.old.id));
            }
          }
        )
        .subscribe((status) => {
          console.log("[Realtime] Subscription status:", status);
          if (status === 'CHANNEL_ERROR') {
            console.warn('[Realtime] WebSocket connection failed. Falling back to REST API only.');
          }
        });

      realtimeChannelRef.current = tradesChannel;
    }, 1000); // 1 second delay after initial load

    return () => {
      clearTimeout(realtimeTimer);
      if (realtimeChannelRef.current) {
        console.log("[Realtime] Cleaning up trades subscription");
        supabase.removeChannel(realtimeChannelRef.current);
        realtimeChannelRef.current = null;
      }
    };
  }, [session, isInitialLoadDone]);

  // Cross-tab synchronization for preferences
  // When user edits business data in Tab A, Tab B will auto-sync
  useEffect(() => {
    if (!session) return;

    const handleStorageChange = async (e: StorageEvent) => {
      // Only react to preferences changes
      if (!e.key?.includes('alphatrade_preferences_')) return;

      // Ignore if we're currently editing (dirty state)
      if (isPreferencesDirty.current) {
        console.log("[Cross-tab] Ignoring sync during local edit");
        return;
      }

      console.log("[Cross-tab] Detected preferences change in another tab");

      // Debounce to avoid multiple rapid syncs
      setTimeout(async () => {
        try {
          const freshPrefs = await storageService.getPreferences();
          if (freshPrefs) {
            applyPreferences(freshPrefs);
            console.log("[Cross-tab] Synced preferences from other tab");
          }
        } catch (err) {
          console.error("[Cross-tab] Sync failed:", err);
        }
      }, 500);
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [session, applyPreferences]);

  // --- SMART PREFETCHING ---
  // Preload critical secondary modules immediately after dashboard loads
  useEffect(() => {
    if (isInitialLoadDone) {
      // DailyJournal is frequently accessed - preload immediately
      console.log("[Prefetch] Preloading DailyJournal for instant access...");
      import('./components/DailyJournal');

      // Less critical modules - prefetch after small delay
      const prefetchTimer = setTimeout(() => {
        console.log("[Prefetch] Prefetching secondary modules...");
        import('./components/Settings');
        import('./components/BusinessHub');
      }, 2000);
      return () => clearTimeout(prefetchTimer);
    }
  }, [isInitialLoadDone]);

  // --- LAZY LOADING: Business Hub Data ---
  // Load expenses, goals, resources only when user enters BusinessHub section
  const [isBusinessDataLoaded, setIsBusinessDataLoaded] = useState(false);

  useEffect(() => {
    if (activePage === 'business' && session && !isBusinessDataLoaded) {
      console.log("[LazyLoad] Loading Business Hub data...");

      Promise.all([
        storageService.getBusinessExpenses(),
        storageService.getBusinessGoals(),
        storageService.getBusinessResources()
      ]).then(([expenses, goals, resources]) => {
        setBusinessExpenses(expenses || []);
        setBusinessGoals(goals || []);
        setBusinessResources(resources || []);
        setIsBusinessDataLoaded(true);
        console.log(`[LazyLoad] Business Hub data loaded: ${expenses?.length || 0} expenses, ${goals?.length || 0} goals, ${resources?.length || 0} resources`);
      }).catch(err => {
        console.error("[LazyLoad] Failed to load Business Hub data:", err);
      });
    }
  }, [activePage, session, isBusinessDataLoaded]);

  // Phase B: Startup Global Sync (Incremental) - DISABLED
  // Trade Replay was removed for performance optimization.
  // See .archive/trade-replay-system/RESTORATION_GUIDE.md to restore.

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



  // Security check: Ensure we don't save if there's a session mismatch or no session
  const canSave = useMemo(() => {
    return !sharedTrade && !!session && isInitialLoadDone && session.user?.id === lastLoadedSessionId.current;
  }, [sharedTrade, session, isInitialLoadDone, lastLoadedSessionId.current]);

  useEffect(() => {
    if (canSave) {
      const timer = setTimeout(() => {
        // CRITICAL FIX: Clear journal dirty flag BEFORE saving
        const wasDirty = isJournalDirty.current;
        isJournalDirty.current = false;

        storageService.saveDailyPreps(dailyPreps).catch(err => {
          console.error("[Journal] DailyPreps save failed:", err);
          if (wasDirty) isJournalDirty.current = true; // Rollback on error
        });
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [dailyPreps, canSave]);

  useEffect(() => {
    if (canSave) {
      const timer = setTimeout(() => {
        // CRITICAL FIX: Clear journal dirty flag BEFORE saving
        const wasDirty = isJournalDirty.current;
        isJournalDirty.current = false;

        storageService.saveDailyReviews(dailyReviews).catch(err => {
          console.error("[Journal] DailyReviews save failed:", err);
          if (wasDirty) isJournalDirty.current = true; // Rollback on error
        });
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [dailyReviews, canSave]);

  useEffect(() => { if (canSave) storageService.setActiveAccountId(activeAccountId); }, [activeAccountId, canSave]);

  useEffect(() => {
    if (canSave && weeklyFocusList.length > 0) {
      const timer = setTimeout(() => {
        // CRITICAL FIX: Clear journal dirty flag BEFORE saving weekly focus
        const wasDirty = isJournalDirty.current;
        isJournalDirty.current = false;

        // Convert forEach to Promise.all for better error handling
        Promise.all(weeklyFocusList.map(wf => storageService.saveWeeklyFocus(wf)))
          .catch(err => {
            console.error("[Journal] WeeklyFocus save failed:", err);
            if (wasDirty) isJournalDirty.current = true; // Rollback on error
          });
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [weeklyFocusList, canSave]);

  // Handle theme persistence independently of session
  useEffect(() => {
    try {
      localStorage.setItem('alphatrade_theme', theme);
      const stored = localStorage.getItem('alphatrade_preferences');
      const currentUserId = session?.user?.id;
      const prefKey = currentUserId ? `alphatrade_preferences_${currentUserId}` : 'alphatrade_preferences';

      const currentPrefs = stored ? JSON.parse(stored) : {};
      if (currentPrefs.theme !== theme) {
        localStorage.setItem(prefKey, JSON.stringify({ ...currentPrefs, theme }));
      }
    } catch (e) {
      console.error("Failed to save theme to localStorage", e);
    }
  }, [theme, session]);

  useEffect(() => {
    if (canSave) {
      const timer = setTimeout(() => {
        // CRITICAL FIX: Clear dirty flag BEFORE saving, not after
        // This prevents background sync from skipping fresh data while save is in progress
        isPreferencesDirty.current = false;

        // Business Hub data (expenses, payouts, goals, resources) now saved to dedicated tables
        // NOT in preferences - prevents data duplication and inconsistency
        storageService.savePreferences({
          emotions: userEmotions,
          standardMistakes: userMistakes,
          standardGoals: standardGoals,
          dashboardLayout,
          sessions,
          htfOptions,
          ltfOptions,
          ironRules,
          playbookItems,
          constitutionRules,
          careerRoadmap,
          businessSettings,
          psychoMetricsConfig: psychoMetrics,
          theme,
          dashboardMode,
          systemSettings,
        }).catch(err => {
          // If save fails, mark as dirty again so we retry
          console.error("[Preferences] Save failed:", err);
          isPreferencesDirty.current = true;
        });
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [userEmotions, userMistakes, standardGoals, dashboardLayout, sessions, htfOptions, ltfOptions, ironRules, playbookItems, constitutionRules, careerRoadmap, businessSettings, psychoMetrics, theme, dashboardMode, systemSettings, canSave]);

  // ⚡ PERIODIC AUTO-SAVE (Google Docs-like protection)
  // Backup save every 30s if user is still editing
  // This protects against browser crashes or quick tab closures
  useEffect(() => {
    if (!canSave) return;

    console.log("[Auto-Save] Periodic auto-save enabled (30s interval)");

    const interval = setInterval(() => {
      // Only save if there are pending changes
      if (isPreferencesDirty.current) {
        console.log("[Auto-Save] Periodic preferences save triggered");
        isPreferencesDirty.current = false;

        // Business Hub data excluded - saved to dedicated tables, not preferences
        storageService.savePreferences({
          emotions: userEmotions,
          standardMistakes: userMistakes,
          standardGoals: standardGoals,
          dashboardLayout,
          sessions,
          htfOptions,
          ltfOptions,
          ironRules,
          playbookItems,
          constitutionRules,
          careerRoadmap,
          businessSettings,
          psychoMetricsConfig: psychoMetrics,
          theme,
          dashboardMode,
          systemSettings,
        }).catch(err => {
          console.error("[Auto-Save] Periodic save failed:", err);
          isPreferencesDirty.current = true;
        });
      }

      // Journal data (daily preps/reviews)
      if (isJournalDirty.current) {
        console.log("[Auto-Save] Periodic journal save triggered");
        const wasJournalDirty = isJournalDirty.current;
        isJournalDirty.current = false;

        Promise.all([
          storageService.saveDailyPreps(dailyPreps),
          storageService.saveDailyReviews(dailyReviews),
          weeklyFocusList.length > 0
            ? Promise.all(weeklyFocusList.map(wf => storageService.saveWeeklyFocus(wf)))
            : Promise.resolve()
        ]).catch(err => {
          console.error("[Auto-Save] Periodic journal save failed:", err);
          if (wasJournalDirty) isJournalDirty.current = true;
        });
      }
    }, 30000); // 30 seconds

    return () => {
      console.log("[Auto-Save] Periodic auto-save disabled");
      clearInterval(interval);
    };
  }, [canSave, userEmotions, userMistakes, standardGoals, dashboardLayout, sessions, htfOptions, ltfOptions, ironRules, playbookItems, constitutionRules, careerRoadmap, businessSettings, psychoMetrics, theme, dashboardMode, systemSettings, dailyPreps, dailyReviews, weeklyFocusList]);

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

  // Global refresh handler for Pull-to-Refresh
  const handleRefreshData = useCallback(async () => {
    if (!session) return;

    try {
      console.log('[Refresh] Starting data refresh...');

      const [dbTrades, dbAccounts, dbPreps, dbReviews, dbPrefs, dbUser, dbWeeklyFocus, dbPayouts, dbExpenses, dbGoals, dbResources] = await Promise.all([
        storageService.getTrades(),
        storageService.getAccounts(),
        storageService.getDailyPreps(),
        storageService.getDailyReviews(),
        storageService.getPreferences(),
        storageService.getUser(),
        storageService.getWeeklyFocusList(),
        storageService.getBusinessPayouts(),
        storageService.getBusinessExpenses(),
        storageService.getBusinessGoals(),
        storageService.getBusinessResources()
      ]);

      console.log('[Refresh] Data received, updating state...');

      if (dbUser) setCurrentUser(dbUser);

      // No longer filter weekends at data level - this should be a UI filter
      setTrades(dbTrades || []);

      if (dbAccounts && dbAccounts.length > 0) {
        setAccounts(dbAccounts);
      }

      if (!isJournalDirty.current) {
        setDailyPreps(dbPreps || []);
        setDailyReviews(dbReviews || []);
      }
      setWeeklyFocusList(dbWeeklyFocus || []);

      // Refresh Business Hub data
      setBusinessPayouts(dbPayouts || []);
      setBusinessExpenses(dbExpenses || []);
      setBusinessGoals(dbGoals || []);
      setBusinessResources(dbResources || []);

      if (dbPrefs) applyPreferences(dbPrefs);

      console.log('[Refresh] Refresh complete!');
    } catch (error) {
      console.error('[Refresh] Error:', error);
      throw error; // Re-throw to show error in Pull-to-Refresh
    }
  }, [session, isJournalDirty, isPreferencesDirty]);

  const baseFilteredTrades = useMemo(() => {
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
  }, [displayTrades, filters, viewMode, accounts, dashboardMode]);

  const filteredDisplayTrades = useMemo(() => {
    return viewMode === 'combined' ? aggregateTrades(baseFilteredTrades) : baseFilteredTrades;
  }, [baseFilteredTrades, viewMode]);

  const filteredStats = useMemo(() => {
    try {
      return calculateStats(filteredDisplayTrades, displayBalance);
    } catch (e) {
      console.error("Filtered stats calculation error:", e);
      return calculateStats([], 0);
    }
  }, [filteredDisplayTrades, displayBalance]);

  const badExits = useMemo(() => findBadExits(filteredDisplayTrades), [filteredDisplayTrades]);



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

    // CRITICAL FIX: Save imported trades to Supabase (without this, they only exist in memory)
    storageService.saveTrades(uniqueTrades).then(saved => {
      if (saved && saved.length > 0) {
        setTrades(saved);
        console.log(`[FileUpload] Saved ${saved.length} trades to Supabase`);
      }
    }).catch(err => {
      console.error("[FileUpload] Failed to save imported trades:", err);
      setSyncError("Nepodařilo se uložit importované obchody do cloudu.");
    });
  };

  const handleManualTrade = (tradeOrTrades: Trade | Trade[]) => {
    const newTradesArray = Array.isArray(tradeOrTrades) ? tradeOrTrades : [tradeOrTrades];

    setTrades(prev => {
      let updated = [...prev];

      // CRITICAL FIX: Detect if we're editing a grouped trade
      // If so, FIRST remove ALL old trades from that group to prevent duplicates
      const firstNewTrade = newTradesArray[0];
      if (firstNewTrade) {
        // Check for master/copy group
        if (firstNewTrade.isMaster || firstNewTrade.masterTradeId) {
          const groupKey = firstNewTrade.isMaster ? firstNewTrade.id : firstNewTrade.masterTradeId;
          // Remove all trades that are part of this master/copy group
          updated = updated.filter(t => {
            const isPartOfGroup = t.id === groupKey || t.masterTradeId === groupKey;
            return !isPartOfGroup;
          });
          console.log(`[Dedup] Removed master/copy group with key: ${groupKey}`);
        }
        // Check for bulk-entry group
        else if (firstNewTrade.groupId) {
          const groupId = firstNewTrade.groupId;
          // Remove all trades with this groupId
          updated = updated.filter(t => t.groupId !== groupId);
          console.log(`[Dedup] Removed bulk group: ${groupId}`);
        }
      }

      // Now add/update all new trades
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

  const handleUpdateTrade = useCallback((tradeId: string | number, updates: Partial<Trade>) => {
    setTrades(prev => {
      const updated = prev.map(t => t.id === tradeId ? { ...t, ...updates } : t);
      // Persist to DB
      storageService.saveTrades(updated).catch(err => {
        console.error("Failed to persist trade update", err);
        setSyncError("Nepodařilo se uložit změny obchodu.");
      });
      return updated;
    });
  }, []);

  const handleDeletePrep = useCallback(async (date: string) => {
    try {
      await storageService.deleteDailyPrep(date);
      setDailyPreps(prev => prev.filter(p => p.date !== date));
    } catch (err) {
      console.error("Failed to delete prep", err);
      setSyncError("Nepodařilo se smazat ranní přípravu.");
    }
  }, []);

  const handleDeleteReview = useCallback(async (date: string) => {
    try {
      await storageService.deleteDailyReview(date);
      setDailyReviews(prev => prev.filter(r => r.date !== date));
    } catch (err) {
      console.error("Failed to delete review", err);
      setSyncError("Nepodařilo se smazat večerní audit.");
    }
  }, []);

  const handleDeleteAccount = useCallback(async (id: string) => {
    try {
      // Find all slave accounts that depend on this account
      const slaveIds = accounts.filter(a => a.parentAccountId === id).map(a => a.id);
      const allIdsToDelete = [id, ...slaveIds];

      // 1. Delete from database
      for (const accountId of allIdsToDelete) {
        await storageService.deleteAccount(accountId);
      }

      // 2. Update local state - Accounts
      setAccounts(prev => prev.filter(a => !allIdsToDelete.includes(a.id)));

      // 3. Update local state - Trades (Delete trades for ALL deleted accounts)
      setTrades(prev => prev.filter(t => !allIdsToDelete.includes(t.accountId)));

      // 4. Handle active account redirection
      if (allIdsToDelete.includes(activeAccountId)) {
        const remainingAccounts = accounts.filter(a => !allIdsToDelete.includes(a.id));
        const nextAccount = remainingAccounts[0];
        if (nextAccount) {
          setActiveAccountId(nextAccount.id);
        } else {
          setActiveAccountId(DEFAULT_ACCOUNT.id);
        }
      }
    } catch (err) {
      console.error("Failed to delete account(s)", err);
      setSyncError("Nepodařilo se smazat účet a jeho kopie.");
    }
  }, [accounts, trades, activeAccountId]);

  const handleDeleteTrade = async (id: number | string) => {
    try {
      const idsToDelete: (string | number)[] = [];

      if (typeof id === 'string' && id.startsWith('combined_')) {
        const groupId = id.replace('combined_', '');
        const groupTrades = trades.filter(t => t.groupId === groupId);
        idsToDelete.push(...groupTrades.map(t => t.id));
      } else {
        const tradeToDelete = trades.find(t => t.id === id);
        if (!tradeToDelete) return;
        idsToDelete.push(id);

        // If it's a master, delete all copies too
        if (tradeToDelete.isMaster) {
          const copies = trades.filter(t => t.masterTradeId === id).map(t => t.id);
          idsToDelete.push(...copies);
        }
      }

      if (idsToDelete.length === 0) return;

      // 1. Update local state
      setTrades(prev => prev.filter(t => !idsToDelete.includes(t.id)));

      // 2. Clear from Supabase
      for (const tradeId of idsToDelete) {
        await storageService.deleteTrade(tradeId as string);
      }
    } catch (err) {
      console.error("Failed to delete trade:", err);
    }
  };

  const handleClearTrades = async () => {
    setIsClearTradesModalOpen(true);
  };

  const executeClearTrades = async () => {
    try {
      setTrades([]);
      await storageService.clearTrades(activeAccountId);
    } catch (err) {
      console.error("Failed to clear trades:", err);
    }
  };
  // --- BUSINESS HUB PERSISTENCE HANDLERS ---
  // These ensure business data is saved to dedicated Supabase tables (not just local state)
  const isUUID = (id: any) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  const handleUpdateExpenses = useCallback(async (newExpenses: BusinessExpense[]) => {
    const prev = businessExpenses;
    setBusinessExpenses(newExpenses);

    try {
      // Detect added items
      const added = newExpenses.filter(ne => !prev.some(pe => pe.id === ne.id));
      // Detect removed items
      const removed = prev.filter(pe => !newExpenses.some(ne => ne.id === pe.id));
      // Detect updated items (same ID, different data)
      const updated = newExpenses.filter(ne => {
        const old = prev.find(pe => pe.id === ne.id);
        return old && JSON.stringify(old) !== JSON.stringify(ne);
      });

      for (const exp of added) {
        await storageService.saveBusinessExpense(exp);
      }
      for (const exp of removed) {
        if (isUUID(exp.id)) await storageService.deleteBusinessExpense(exp.id);
      }
      for (const exp of updated) {
        if (isUUID(exp.id)) await storageService.updateBusinessExpense(exp.id, exp);
      }

      // Reload from DB to get proper UUIDs for newly added items
      if (added.length > 0) {
        const fresh = await storageService.getBusinessExpenses();
        setBusinessExpenses(fresh);
      }
    } catch (err) {
      console.error('[BusinessHub] Failed to sync expenses:', err);
    }
  }, [businessExpenses]);

  const handleUpdatePayouts = useCallback(async (newPayouts: BusinessPayout[]) => {
    const prev = businessPayouts;
    setBusinessPayouts(newPayouts);

    try {
      const added = newPayouts.filter(np => !prev.some(pp => pp.id === np.id));
      const removed = prev.filter(pp => !newPayouts.some(np => np.id === pp.id));
      const updated = newPayouts.filter(np => {
        const old = prev.find(pp => pp.id === np.id);
        return old && JSON.stringify(old) !== JSON.stringify(np);
      });

      for (const p of added) {
        await storageService.saveBusinessPayout(p);
      }
      for (const p of removed) {
        if (isUUID(p.id)) await storageService.deleteBusinessPayout(p.id);
      }
      for (const p of updated) {
        if (isUUID(p.id)) await storageService.updateBusinessPayout(p.id, p);
      }

      if (added.length > 0) {
        const fresh = await storageService.getBusinessPayouts();
        setBusinessPayouts(fresh);
      }
    } catch (err) {
      console.error('[BusinessHub] Failed to sync payouts:', err);
    }
  }, [businessPayouts]);

  const handleUpdateGoals = useCallback(async (newGoals: BusinessGoal[]) => {
    const prev = businessGoals;
    setBusinessGoals(newGoals);

    try {
      const added = newGoals.filter(ng => !prev.some(pg => pg.id === ng.id));
      const removed = prev.filter(pg => !newGoals.some(ng => ng.id === pg.id));
      const updated = newGoals.filter(ng => {
        const old = prev.find(pg => pg.id === ng.id);
        return old && JSON.stringify(old) !== JSON.stringify(ng);
      });

      for (const g of added) {
        await storageService.saveBusinessGoal(g);
      }
      for (const g of removed) {
        if (isUUID(g.id)) await storageService.deleteBusinessGoal(g.id);
      }
      for (const g of updated) {
        if (isUUID(g.id)) await storageService.updateBusinessGoal(g.id, g);
      }

      if (added.length > 0) {
        const fresh = await storageService.getBusinessGoals();
        setBusinessGoals(fresh);
      }
    } catch (err) {
      console.error('[BusinessHub] Failed to sync goals:', err);
    }
  }, [businessGoals]);

  const handleUpdateResources = useCallback(async (newResources: BusinessResource[]) => {
    const prev = businessResources;
    setBusinessResources(newResources);

    try {
      const added = newResources.filter(nr => !prev.some(pr => pr.id === nr.id));
      const removed = prev.filter(pr => !newResources.some(nr => nr.id === pr.id));
      const updated = newResources.filter(nr => {
        const old = prev.find(pr => pr.id === nr.id);
        return old && JSON.stringify(old) !== JSON.stringify(nr);
      });

      for (const r of added) {
        await storageService.saveBusinessResource(r);
      }
      for (const r of removed) {
        if (isUUID(r.id)) await storageService.deleteBusinessResource(r.id);
      }
      for (const r of updated) {
        if (isUUID(r.id)) await storageService.updateBusinessResource(r.id, r);
      }

      if (added.length > 0) {
        const fresh = await storageService.getBusinessResources();
        setBusinessResources(fresh);
      }
    } catch (err) {
      console.error('[BusinessHub] Failed to sync resources:', err);
    }
  }, [businessResources]);

  // Single expense add handler (used by AccountsManager)
  const handleAddSingleExpense = useCallback(async (exp: BusinessExpense) => {
    setBusinessExpenses(prev => [...prev, exp]);
    try {
      await storageService.saveBusinessExpense(exp);
      const fresh = await storageService.getBusinessExpenses();
      setBusinessExpenses(fresh);
    } catch (err) {
      console.error('[BusinessHub] Failed to save expense:', err);
    }
  }, []);

  // Show loader during initial auth check OR when logged in but data not yet loaded
  if ((loading || (session && !isInitialLoadDone)) && !sharedTrade) {
    return <QuantumLoader theme={theme} />;
  }

  if (sharedTrade) {
    return <SharedTradeView trade={sharedTrade} theme={theme} />;
  }

  if (!session) {
    return <Auth onLogin={(user) => { }} theme={theme} />;
  }


  return (
    <div
      className="h-screen font-sans flex overflow-hidden transition-colors duration-300 bg-[var(--bg-page)] text-[var(--text-primary)]"
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
        onAddTrade={handleTryAddTrade}
        user={currentUser}
        onLogout={async () => {
          localStorage.clear(); // CRITICAL: Clear dirty local data
          await supabase.auth.signOut();
          setSession(null);
          window.location.reload(); // Force a clean state
        }}
        onOpenProfile={() => setIsProfileOpen(true)}
        onNavigate={(page) => {
          setActivePage(page);
          setIsSidebarOpen(false);
        }}
      />

      <main className={`flex-1 h-screen overflow-hidden transition-all duration-300 relative flex flex-col ${isSidebarCollapsed ? 'lg:ml-[72px]' : 'lg:ml-[240px]'}`}>
        <header className={`sticky top-0 z-40 border-b backdrop-blur-md px-6 py-2 flex items-center justify-between transition-all bg-[var(--bg-page)]/30 border-[var(--border-subtle)]`}>
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
            <div className="hidden md:flex items-center h-8 px-4">
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
                pnlDisplayMode={pnlDisplayMode}
                setPnlDisplayMode={setPnlDisplayMode}
              />

              {/* Force Refresh Button */}
              <button
                onClick={() => window.location.reload()}
                className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] rounded-lg transition-colors"
                title="Force Refresh - načíst nejnovější data ze serveru"
              >
                <RefreshCw size={16} className="text-[var(--text-secondary)]" />
                <span className="text-xs text-[var(--text-secondary)] font-medium hidden md:inline">Refresh</span>
              </button>

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

        <div className="flex-1 overflow-y-auto no-scrollbar">
          <PullToRefresh
            onRefresh={handleRefreshData}
            disabled={!session || loading}
          >
            <div className="p-4 lg:p-8 pb-12 flex-1 overflow-x-hidden">
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
                <React.Suspense fallback={<LoadingFallback />}>
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
                      onUpdateTrade={handleUpdateTrade}
                      user={currentUser}
                      pnlDisplayMode={pnlDisplayMode}
                      exchangeRates={exchangeRates}
                      allTrades={trades}
                      payouts={businessPayouts}
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
                        <button onClick={handleTryAddTrade} className="flex items-center gap-2 px-8 py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl shadow-blue-500/20 transition-all active:scale-95">
                          <Plus size={18} /> Zapsat první obchod
                        </button>
                      </div>
                    ) : (
                      <TradeHistory
                        trades={filteredDisplayTrades}
                        accounts={accounts}
                        onDelete={handleDeleteTrade}
                        onUpdateTrade={handleUpdateTrade}
                        onClear={handleClearTrades}
                        theme={theme}
                        emotions={userEmotions}
                        pnlDisplayMode={pnlDisplayMode}
                        initialBalance={displayBalance}
                        user={currentUser}
                        exchangeRates={exchangeRates}
                        allTrades={trades}
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
                      onAddExpense={handleAddSingleExpense}
                      onUpdatePayouts={handleUpdatePayouts}
                      payouts={businessPayouts}
                      user={currentUser}
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
                      systemSettings={systemSettings}
                      setSystemSettings={(v: any) => { setSystemSettings(v); isPreferencesDirty.current = true; }}
                      standardGoals={standardGoals}
                      setStandardGoals={(v) => { setStandardGoals(v); isPreferencesDirty.current = true; }}
                      onEnableNotifications={handleApplyNotificationPermission}
                      appVersion={APP_VERSION}
                      onHardRefresh={handleHardRefresh}
                      accentColor={accentColor}
                      onAccentColorChange={handleAccentColorChange}
                    />
                  )}

                  {activePage === 'business' && (
                    <BusinessHub
                      theme={theme}
                      user={currentUser}
                      exchangeRates={exchangeRates}
                      trades={trades}
                      accounts={accounts}
                      expenses={businessExpenses}
                      payouts={businessPayouts}
                      playbook={playbookItems}
                      goals={businessGoals}
                      resources={businessResources}
                      settings={businessSettings}
                      onUpdateExpenses={handleUpdateExpenses}
                      onUpdatePayouts={handleUpdatePayouts}
                      onUpdatePlaybook={(v) => { setPlaybookItems(v); isPreferencesDirty.current = true; }}
                      onUpdateGoals={handleUpdateGoals}
                      onUpdateResources={handleUpdateResources}
                      onUpdateSettings={(v) => { setBusinessSettings(v); isPreferencesDirty.current = true; }}
                      onUpdateAccounts={setAccounts}
                      constitutionRules={constitutionRules}
                      onUpdateConstitution={setConstitutionRules}
                      careerRoadmap={careerRoadmap}
                      onUpdateRoadmap={setCareerRoadmap}
                      dailyReviews={dailyReviews}
                      weeklyFocusList={weeklyFocusList}
                    />
                  )}
                </React.Suspense>
              )}
            </div>
          </PullToRefresh>
        </div>
      </main>

      {/* Alpha Guardian System Components */}
      <GuardianIntervention
        type="morning"
        isOpen={isMorningInterventionOpen}
        onClose={() => setIsMorningInterventionOpen(false)}
        onAction={() => {
          setIsMorningInterventionOpen(false);
          setActivePage('journal');
        }}
      />

      <GuardianIntervention
        type="evening"
        isOpen={isEveningInterventionOpen}
        onClose={() => setIsEveningInterventionOpen(false)}
        onAction={() => {
          setIsEveningInterventionOpen(false);
          setActivePage('journal');
        }}
      />

      <GuardianOverlay
        isOpen={isGuardianOverlayOpen}
        onClose={() => setIsGuardianOverlayOpen(false)}
        onGoToJournal={() => {
          setIsGuardianOverlayOpen(false);
          setActivePage('journal');
        }}
      />

      <DebtCollector
        isOpen={isDebtCollectorOpen}
        onClose={() => setIsDebtCollectorOpen(false)}
        onGoToAudit={() => {
          setIsDebtCollectorOpen(false);
          setActivePage('journal');
        }}
      />

      {
        isManualEntryOpen && (
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
            viewMode={viewMode}
          />
        )
      }

      <UserProfileModal
        isOpen={isProfileOpen}
        onClose={() => setIsProfileOpen(false)}
        user={currentUser}
        onUpdate={handleUpdateUser}
        theme={theme}
      />

      <ConfirmationModal
        isOpen={isClearTradesModalOpen}
        onClose={() => setIsClearTradesModalOpen(false)}
        onConfirm={executeClearTrades}
        title="Smazat vše"
        message="Opravdu chcete smazat VŠECHNY obchody z tohoto účtu? Tato akce je nevratná a data budou trvale odstraněna z cloudu."
        theme={theme}
      />
    </div >
  );
};

export default App;
