
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { normalizeTrades, calculateStats } from './services/analysis';
import { storageService, getUserId } from './services/storageService';
import { safeSetItem } from './utils/safeStorage';
import { Trade, Account, TradeFilters, CustomEmotion, User, DailyPrep, DailyReview, UserPreferences, DashboardWidgetConfig, SessionConfig, IronRule, BusinessExpense, BusinessPayout, PlaybookItem, BusinessGoal, BusinessResource, BusinessSettings, PsychoMetricConfig, DashboardMode, WeeklyFocus, PnLDisplayMode, ConstitutionRule, CareerCheckpoint, SystemSettings } from './types';
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
const AICoachPage = React.lazy(() => import('./components/AICoachPage'));
const InsightsPanel = React.lazy(() => import('./components/InsightsPanel'));

import Sidebar from './components/Sidebar';
import BottomNav from './components/BottomNav';
import LockedFeatureModal from './components/LockedFeatureModal';
import { canAccess } from './utils/featureGating';
import FilterDropdown from './components/FilterDropdown';
import Auth from './components/Auth';
import QuantumLoader from './components/QuantumLoader';
import { PullToRefresh } from './components/PullToRefresh';
import ConfirmationModal from './components/ConfirmationModal';
import TradeDetailModal from './components/TradeDetailModal';
import SharedTradeView from './components/SharedTradeView';
import { currencyService, ExchangeRates } from './services/currencyService';
import { t } from './services/translations';
import { GuardianIntervention, GuardianOverlay, DebtCollector } from './components/GuardianSystem';
import { getGuardianState, GuardianState } from './utils/guardianLogic';
import { requestNotificationPermission, sendLocalNotification } from './utils/notificationHelper';
// pushManager import removed — push notifications deferred to native app
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
  RefreshCw,
  Clock,
  Calendar,
  History,
  DollarSign,
  Target,
  Trophy,
  MessageSquare,
  Activity,
  Brain,
  Shield
} from 'lucide-react';

import { supabase } from './services/supabase';
import type { Session } from '@supabase/supabase-js';

const APP_VERSION = "1.5.2 [MATRIX-UPDATE]";

const DEFAULT_USER: User = {
  id: 'default_user',
  email: 'trader@alphatrade.cz',
  name: 'Alpha Trader',
  role: 'friend', // SAFE default — před DB load je vše locked, owner se unlockne po loadu.
  // Lepší než 'owner' (kde by neowner viděl plný přístup než dorazí DB).
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

// Widget min/max constraints for react-grid-layout
const WIDGET_CONSTRAINTS: Record<string, { minW: number; minH: number; maxW: number; maxH: number }> = {
  avg_win_loss: { minW: 2, minH: 2, maxW: 6, maxH: 4 },
  streak: { minW: 4, minH: 2, maxW: 6, maxH: 4 },
  discipline_streak: { minW: 2, minH: 2, maxW: 6, maxH: 4 },
  challenge_target: { minW: 2, minH: 2, maxW: 6, maxH: 4 },
  kpi_pnl: { minW: 2, minH: 2, maxW: 6, maxH: 4 },
  kpi_winrate: { minW: 2, minH: 2, maxW: 6, maxH: 4 },
  kpi_execution_rate: { minW: 2, minH: 2, maxW: 6, maxH: 4 },
  kpi_profit_factor: { minW: 2, minH: 2, maxW: 6, maxH: 4 },
  kpi_day_winrate: { minW: 2, minH: 2, maxW: 6, maxH: 4 },
  kpi_max_drawdown: { minW: 2, minH: 2, maxW: 6, maxH: 4 },
  discipline: { minW: 4, minH: 3, maxW: 12, maxH: 8 },
  winners_losers: { minW: 4, minH: 3, maxW: 12, maxH: 8 },
  monthly_performance: { minW: 4, minH: 3, maxW: 12, maxH: 8 },
  equity: { minW: 4, minH: 3, maxW: 12, maxH: 8 },
  session_performance: { minW: 4, minH: 3, maxW: 12, maxH: 8 },
  hourly_edge: { minW: 4, minH: 3, maxW: 12, maxH: 8 },
  daily_edge: { minW: 4, minH: 3, maxW: 12, maxH: 8 },
  calendar: { minW: 6, minH: 5, maxW: 12, maxH: 10 },
  daily_insight: { minW: 2, minH: 2, maxW: 6, maxH: 4 },
};

const SIZE_TO_W: Record<string, number> = { small: 2, medium: 4, large: 6, full: 12 };

function migrateOldLayout(oldLayout: DashboardWidgetConfig[]): DashboardWidgetConfig[] {
  const sorted = [...oldLayout].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const COLS = 12;
  let cursorX = 0;
  let cursorY = 0;
  let rowMaxH = 0;

  return sorted.map(widget => {
    const w = SIZE_TO_W[widget.size || 'medium'] || 4;
    const h = (widget.rowSpan || 1) * 2; // multiply by 2 for rowHeight=80
    const constraints = WIDGET_CONSTRAINTS[widget.id] || { minW: 2, minH: 2, maxW: 12, maxH: 8 };

    if (cursorX + w > COLS) {
      cursorX = 0;
      cursorY += rowMaxH;
      rowMaxH = 0;
    }

    const x = cursorX;
    const y = cursorY;
    cursorX += w;
    rowMaxH = Math.max(rowMaxH, h);

    return { ...widget, x, y, w, h, ...constraints };
  });
}

const DEFAULT_WIDGETS: DashboardWidgetConfig[] = [
  { id: 'kpi_pnl', label: 'Net P&L', visible: true, x: 0, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { id: 'kpi_winrate', label: 'Win Rate', visible: true, x: 2, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { id: 'kpi_profit_factor', label: 'Profit Factor', visible: true, x: 4, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { id: 'discipline', label: 'Disciplína', visible: true, x: 0, y: 2, w: 12, h: 4, minW: 4, minH: 3, maxW: 12, maxH: 8 },
  { id: 'equity', label: 'Equity Curve', visible: true, x: 0, y: 6, w: 6, h: 4, minW: 4, minH: 3, maxW: 12, maxH: 8 },
  { id: 'calendar', label: 'Kalendář', visible: true, x: 6, y: 6, w: 6, h: 6, minW: 6, minH: 5, maxW: 12, maxH: 10 },
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

const aggregateTrades = (trades: Trade[], accounts: Account[]): Trade[] => {
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
    // Smarter master identification:
    // 1. Explicit isMaster flag
    // 2. Account name contains 'hlavní'
    // 3. Fallback to first one
    let master = groupTrades.find(t => t.isMaster);

    if (!master && accounts.length > 0) {
      master = groupTrades.find(t => {
        const acc = accounts.find(a => a.id === t.accountId);
        return acc?.name?.toLowerCase().includes('hlavní');
      });
    }

    if (!master) master = groupTrades[0];

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
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [appError, setAppError] = useState<string | null>(null);
  const [isInitialLoadDone, setIsInitialLoadDone] = useState(false);
  // Ochrana proti přepsání DB defaultními hodnotami z useState — autosave preferences
  // se spustí jen po prvním úspěšném applyPreferences (z cache NEBO DB).
  const prefsAppliedRef = useRef(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [initStatus, setInitStatus] = useState<string>("Inicializace...");
  const [showRetry, setShowRetry] = useState(false);

  useEffect(() => {

    setInitStatus("Kontrola přihlášení...");
    supabase.auth.getSession().then(({ data: { session: activeSession } }) => {
      if (activeSession) {
        setSession(activeSession);
        // INSTANT user z cached snapshot předchozí session — žádný flash avatara/jména/role.
        // Cache obsahuje plný User objekt z posledního DB loadu.
        let instantUser: User | null = null;
        try {
          const raw = localStorage.getItem(`alphatrade_user_cache_${activeSession.user.id}`);
          if (raw) instantUser = JSON.parse(raw) as User;
        } catch { /* parse error → fallback níž */ }

        if (instantUser && instantUser.id === activeSession.user.id) {
          // Cached user existuje → instant render
          setCurrentUser(instantUser);
          setIsUserFromDb(true); // splash zmizí instantně
        } else {
          // První přihlášení nebo cache prázdná → fallback z JWT (email, id z tokenu)
          setCurrentUser({
            id: activeSession.user.id,
            email: activeSession.user.email || '',
            name: (activeSession.user.user_metadata as any)?.full_name || activeSession.user.email?.split('@')[0] || '',
            avatar: (activeSession.user.user_metadata as any)?.avatar_url || '',
            role: 'friend',
          });
          // Splash bude držet dokud DB nedoběhne (~300-500ms)
        }
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
        setSession(null);
        setLoading(false);
        setIsInitialLoadDone(false);
        lastLoadedSessionId.current = null;
        setLoadedUserId(null);

        // Reset all data states to prevent leakage to next user
        setTrades([]);
        setAccounts([]);
        setActiveAccountId('');
        setCurrentUser(DEFAULT_USER);
        setIsUserFromDb(false);
        setDailyPreps([]);
        setDailyReviews([]);
        setWeeklyFocusList([]);
        setBusinessExpenses([]);
        setBusinessPayouts([]);
        setBusinessGoals([]);
        setBusinessResources([]);
        setPlaybookItems([]);

        // Reset flags
        isPrepsDirty.current = false;
        isReviewsDirty.current = false;
        isWeeklyFocusDirty.current = false;
        isPreferencesDirty.current = false;

        // Optional: clear entire localStorage on logout for ultimate safety
        localStorage.clear();
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const [sharedTrade, setSharedTrade] = useState<Trade | null>(null);
  const [sharedOwnerName, setSharedOwnerName] = useState<string | undefined>();
  const [sharedOwnerAvatar, setSharedOwnerAvatar] = useState<string | undefined>();
  const [aiChatTrade, setAiChatTrade] = useState<Trade | null>(null);
  const [aiActiveConvId, setAiActiveConvId] = useState<string | undefined>(undefined);
  const [aiInitialPrompt, setAiInitialPrompt] = useState<string | undefined>(undefined);
  const [journalTargetDate, setJournalTargetDate] = useState<string | undefined>(undefined);
  const isPreferencesDirty = useRef(false);
  const [networkNotifications, setNetworkNotifications] = useState<Record<string, { newTrade: boolean; newPrep: boolean; newReview: boolean }> | null>(null);
  const isPrepsDirty = useRef(false);
  const isReviewsDirty = useRef(false);
  const isWeeklyFocusDirty = useRef(false);
  const isFetchingRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shareData = params.get('share');
    const shareId = params.get('shareId');

    if (shareData) {
      try {
        // Modern Unicode-safe decode: base64 → bytes → UTF-8 string
        const bytes = Uint8Array.from(atob(shareData), c => c.charCodeAt(0));
        const jsonStr = new TextDecoder().decode(bytes);
        const trade = JSON.parse(jsonStr);
        setSharedTrade(trade);
      } catch (e) {
        console.error("Failed to parse shared trade", e);
      }
    } else if (shareId) {
      // Public share — funguje i pro nepřihlášené uživatele (RLS is_public=true)
      storageService.getPublicTradeById(shareId).then(result => {
        if (result) {
          setSharedTrade(result.trade);
          setSharedOwnerName(result.ownerName);
          setSharedOwnerAvatar(result.ownerAvatar);
        }
      }).catch(err => console.warn('[Share] Failed to load shared trade:', err));
    }
  }, []);

  const [trades, setTrades] = useState<Trade[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string>('');
  const [currentUser, setCurrentUser] = useState<User>(DEFAULT_USER);
  // Locked feature modal pro non-owner roli (kamarád apod.)
  const [lockedFeatureModal, setLockedFeatureModal] = useState<string | null>(null);
  // True pokud currentUser obsahuje data z DB (ne jen DEFAULT_USER nebo JWT instant fallback).
  // Drží loader dokud role nedorazí z DB → eliminuje flash locked tabů pro ownery.
  const [isUserFromDb, setIsUserFromDb] = useState(false);

  // Safety timeout: pokud DB user load selže nebo trvá moc dlouho (>5s),
  // uvolnit loader s JWT user data. Lepší fallback než nekonečný spinner.
  useEffect(() => {
    if (!isUserFromDb && currentUser.id !== 'default_user') {
      const t = setTimeout(() => {
        console.warn('[Auth] DB user load timeout — proceeding with JWT instant fallback');
        setIsUserFromDb(true);
      }, 5000);
      return () => clearTimeout(t);
    }
  }, [isUserFromDb, currentUser.id]);

  // Persist celý user objekt do localStorage při každé změně z DB — další reload pak má
  // instant rendering (žádný flash avatara/jména/role). Cache klíč per-user.
  useEffect(() => {
    if (isUserFromDb && currentUser.id !== 'default_user') {
      try {
        localStorage.setItem(`alphatrade_user_cache_${currentUser.id}`, JSON.stringify(currentUser));
      } catch { /* localStorage full nebo blocked */ }
    }
  }, [isUserFromDb, currentUser]);

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
  // Init `[]` ne DEFAULT_WIDGETS — zabraní flashe defaultních widgetů před DB loadem.
  // applyPreferences pak nastaví buď DB layout nebo DEFAULT_WIDGETS (pro nového usera).
  const [dashboardLayout, setDashboardLayout] = useState<DashboardWidgetConfig[]>([]);
  const [dashboardMode, setDashboardMode] = useState<DashboardMode>(() => {
    // Try to load from local storage first for immediate persistence
    const saved = localStorage.getItem('alphatrade_dash_mode');
    return (saved as DashboardMode) || 'combined';
  });

  useEffect(() => {
    safeSetItem('alphatrade_dash_mode', dashboardMode);
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

  const [systemSettings, setSystemSettings] = useState<SystemSettings>({
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
    constitutionRules,
    careerRoadmap,
    businessSettings,
    psychoMetricsConfig: psychoMetrics,
    theme,
    dashboardMode,
    systemSettings,
    ...(networkNotifications ? { networkNotifications } : {}),
  });

  const [activePage, setActivePage] = useState('dashboard');

  // Defense-in-depth: kdyby se non-owner role pokusila dostat na uzamčenou page
  // přes přímou state mutaci nebo router redirect → přesměrovat na dashboard.
  useEffect(() => {
    if (!canAccess(activePage, currentUser.role)) {
      setActivePage('dashboard');
    }
  }, [activePage, currentUser.role]);
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
    safeSetItem('alphatrade_accent_color', color);
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
    safeSetItem('alphatrade_view_mode', viewMode);
  }, [viewMode]);

  const [pnlDisplayMode, setPnlDisplayMode] = useState<PnLDisplayMode>(
    (localStorage.getItem('alphatrade_pnl_display_mode') as PnLDisplayMode) || 'usd'
  );

  useEffect(() => {
    safeSetItem('alphatrade_pnl_display_mode', pnlDisplayMode);
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
  const [isMobileEditing, setIsMobileEditing] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRates | null>(null);
  const lastLoadedSessionId = React.useRef<string | null>(null);
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);

  // Track in-flight saves + pending queue to prevent race conditions
  const savingPrepDate = useRef<string | null>(null);
  const savingReviewDate = useRef<string | null>(null);
  const pendingPrepSave = useRef<DailyPrep | null>(null);
  const pendingReviewSave = useRef<DailyReview | null>(null);

  // Retry helper s exponential backoff — kritické pro deník, aby data nezmizely při dočasném výpadku Supabase
  const saveWithRetry = useCallback(async <T,>(
    fn: () => Promise<T>,
    label: string,
    maxAttempts = 4
  ): Promise<T> => {
    const delays = [0, 1500, 4000, 10000]; // 0s, 1.5s, 4s, 10s
    let lastErr: any;
    for (let i = 0; i < maxAttempts; i++) {
      if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
      try {
        const result = await fn();
        if (i > 0) console.log(`[Save] ${label} succeeded on attempt ${i + 1}`);
        return result;
      } catch (e) {
        lastErr = e;
        console.warn(`[Save] ${label} attempt ${i + 1}/${maxAttempts} failed:`, (e as any)?.message || e);
      }
    }
    throw lastErr;
  }, []);

  const handleSavePrep = useCallback((prep: DailyPrep): Promise<void> => {
    isPrepsDirty.current = true;
    setDailyPreps(prev => [...prev.filter(p => p.date !== prep.date), prep]);

    if (savingPrepDate.current === prep.date) {
      // In-flight save for this date — queue latest version, resolve immediately
      pendingPrepSave.current = prep;
      return Promise.resolve();
    }

    savingPrepDate.current = prep.date;
    // Použij vždy NEJNOVĚJŠÍ verzi (pendingPrepSave) — předchází ztrátě dat při rychlém typování
    const latestPrep = () => pendingPrepSave.current?.date === prep.date ? pendingPrepSave.current : prep;
    return saveWithRetry(() => storageService.saveSinglePrep(latestPrep()!), `Prep ${prep.date}`)
      .then(() => {
        // Úspěch — vyčisti error pokud byl předtím nastavený
        setSyncError(prev => prev === 'Nepodařilo se uložit ranní přípravu.' ? null : prev);
      })
      .catch(e => {
        console.error('[Save] Prep FAILED after retries:', e);
        setSyncError('⚠️ Ranní příprava se nepodařila uložit. Zkus to znova nebo zkontroluj síť/Supabase.');
        throw e;
      })
      .finally(() => {
        savingPrepDate.current = null;
        // Flush pending save if a newer version arrived while we were in-flight
        if (pendingPrepSave.current?.date === prep.date) {
          const pending = pendingPrepSave.current;
          pendingPrepSave.current = null;
          handleSavePrep(pending).catch(() => {});
        }
      });
  }, [saveWithRetry]);

  const handleSaveReview = useCallback((rev: DailyReview): Promise<void> => {
    isReviewsDirty.current = true;
    setDailyReviews(prev => [...prev.filter(r => r.date !== rev.date), rev]);

    if (savingReviewDate.current === rev.date) {
      // In-flight save for this date — queue latest version, resolve immediately
      pendingReviewSave.current = rev;
      return Promise.resolve();
    }

    savingReviewDate.current = rev.date;
    const latestRev = () => pendingReviewSave.current?.date === rev.date ? pendingReviewSave.current : rev;
    return saveWithRetry(() => storageService.saveSingleReview(latestRev()!), `Review ${rev.date}`)
      .then(() => {
        setSyncError(prev => prev === 'Nepodařilo se uložit večerní audit.' ? null : prev);
      })
      .catch(e => {
        console.error('[Save] Review FAILED after retries:', e);
        setSyncError('⚠️ Večerní audit se nepodařil uložit. Zkus to znova nebo zkontroluj síť/Supabase.');
        throw e;
      })
      .finally(() => {
        savingReviewDate.current = null;
        // Flush pending save if a newer version arrived while we were in-flight
        if (pendingReviewSave.current?.date === rev.date) {
          const pending = pendingReviewSave.current;
          pendingReviewSave.current = null;
          handleSaveReview(pending).catch(() => {});
        }
      });
  }, [saveWithRetry]);

  const applyPreferences = useCallback((prefs: UserPreferences) => {
    // DIAGNOSTIC: track what fields are present in incoming prefs
    console.log('[applyPreferences] called with dirty=', isPreferencesDirty.current, 'fields:', {
      sessions: prefs.sessions?.length,
      htfOptions: prefs.htfOptions?.length,
      ltfOptions: prefs.ltfOptions?.length,
      ironRules: prefs.ironRules?.length,
      dashboardLayout: prefs.dashboardLayout?.length,
      systemSettings: !!prefs.systemSettings,
    });
    if (isPreferencesDirty.current) {
      console.log('[applyPreferences] SKIPPED — dirty=true');
      // I když přeskočíme apply (uživatel má rozdělanou změnu), aspoň označíme že
      // preference už dorazily z DB/cache — autosave se může pustit a nepřepíše DB
      // defaulty z useState (které by jinak vznikly při saves PŘED prvním applyPreferences).
      prefsAppliedRef.current = true;
      return;
    }

    // PRO NOVÉ USERY: DB má default preferences s prázdnými poli [].
    // Ignorujeme je — necháme useState defaulty (DEFAULT_WIDGETS, DEFAULT_SESSIONS, atd.).
    // Auto-save pak při první user akci uloží skutečné defaulty místo prázdných.
    const hasItems = (arr: any) => Array.isArray(arr) && arr.length > 0;

    if (hasItems(prefs.emotions)) setUserEmotions(prefs.emotions);
    if (hasItems(prefs.standardMistakes)) setUserMistakes(prefs.standardMistakes);
    if (hasItems(prefs.standardGoals)) setStandardGoals(prefs.standardGoals);
    if (hasItems(prefs.dashboardLayout)) {
      const dl = prefs.dashboardLayout!;
      // Remove any widget IDs that no longer exist in the app (orphaned widgets show as empty boxes)
      const validDl = dl.filter(w => w.id in WIDGET_CONSTRAINTS);
      const isOld = validDl.length > 0 && (validDl[0] as any).x === undefined && (validDl[0] as any).size !== undefined;
      if (isOld) {
        setDashboardLayout(migrateOldLayout(validDl));
      } else {
        // Detect layouts saved with old rowHeight=160 (all h values ≤ 4) and double them
        const needsHeightMigration = validDl.length > 0 && validDl.every(w => (w.h || 0) <= 4);
        if (needsHeightMigration) {
          setDashboardLayout(validDl.map(w => {
            const c = WIDGET_CONSTRAINTS[w.id] || { minW: 2, minH: 2, maxW: 12, maxH: 8 };
            return { ...w, h: (w.h || 2) * 2, ...c };
          }));
        } else {
          setDashboardLayout(validDl);
        }
      }
    } else {
      // DB nemá uložený dashboard layout → nový user nebo prázdný blob → set defaulty
      setDashboardLayout(DEFAULT_WIDGETS);
    }
    if (hasItems(prefs.sessions)) {
      const migratedSessions = (prefs.sessions as any[]).map(s => ({
        ...s,
        startTime: s.startTime || `${String(s.startHour ?? 9).padStart(2, '0')}:00`,
        endTime: s.endTime || `${String(s.endHour ?? 17).padStart(2, '0')}:00`,
        color: s.color || '#3b82f6'
      }));
      setSessions(migratedSessions);
    }
    if (hasItems(prefs.htfOptions)) setHtfOptions(prefs.htfOptions);
    if (hasItems(prefs.ltfOptions)) setLtfOptions(prefs.ltfOptions);
    if (hasItems(prefs.ironRules)) setIronRules(prefs.ironRules);
    // Business Hub data (expenses, payouts, goals, resources) now use dedicated Supabase tables
    // DO NOT apply from preferences - prevents stale data overwriting fresh table data
    if (hasItems(prefs.playbookItems)) setPlaybookItems(prefs.playbookItems);
    if (hasItems(prefs.constitutionRules)) setConstitutionRules(prefs.constitutionRules);
    if (hasItems(prefs.careerRoadmap)) setCareerRoadmap(prefs.careerRoadmap);
    if (prefs.businessSettings) setBusinessSettings(prefs.businessSettings || { taxRatePct: 15, defaultPropThreshold: 150 });
    if (hasItems(prefs.psychoMetricsConfig)) setPsychoMetrics(prefs.psychoMetricsConfig);
    // Theme is NOT applied here — it has its own persistence via localStorage
    // to prevent cross-tab sync or focus sync from reverting user's theme choice.
    // Theme is applied only on initial load (useState initializer).
    if (prefs.dashboardMode) setDashboardMode(prefs.dashboardMode);
    if (prefs.systemSettings) setSystemSettings(prefs.systemSettings);
    if ((prefs as any).networkNotifications) setNetworkNotifications((prefs as any).networkNotifications);
    // Mark prefs as applied — autosave se teď může spustit, nehrozí přepsání DB
    // defaulty z useState (HTF/LTF, sessions, emotions, …).
    prefsAppliedRef.current = true;
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
    currencyService.getRates().then(setExchangeRates).catch(err => console.warn('[Currency] Failed to fetch rates:', err));
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
      setLoadedUserId(session?.user?.id || null);

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
        });

      }
      safeSetItem('alphatrade_last_session_user', session.user.id);

      // --- CACHE-FIRST LOADING: Instant from IndexedDB, then background refresh ---
      const cached = await storageService.getCachedDashboardData(session.user.id);

      // Cache staleness check — cache starší než 24h nepoužij, načti čerstvě z DB.
      // Zabraňuje "po noci se to vrátilo do defaultu" — staré cache by overwrite čerstvé prefs.
      const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
      const savedAtRaw = localStorage.getItem(`alphatrade_preferences_${session.user.id}_savedAt`);
      const cacheAge = savedAtRaw ? Date.now() - parseInt(savedAtRaw, 10) : Infinity;
      const cacheIsFresh = cacheAge < CACHE_MAX_AGE_MS;

      if (cached) {
        setTrades(cached.trades || []);
        if (cached.accounts && cached.accounts.length > 0) {
          setAccounts(cached.accounts);
          const activeId = storageService.getActiveAccountId();
          setActiveAccountId(activeId || cached.accounts[0].id);
        } else {
          setAccounts([DEFAULT_ACCOUNT]);
          setActiveAccountId(DEFAULT_ACCOUNT.id);
        }
        // User profile NEČTEME z cache — vždy z DB. Cache může mít zastaralou role
        // (např. před přiřazením 'owner'). DB call je rychlý (1 řádek, 3 fieldy).
        // Před DB loadem zůstává DEFAULT_USER s role='friend' (safe — flash locked → unlocked).
        // Apply cached preferences POUZE pokud cache je fresh — jinak počkáme na background refresh.
        // To zabrání aplikování zastaralých prefs (sessions, htf, atd.) co byly přepsány z DB.
        if (cached.preferences && cacheIsFresh) {
          applyPreferences(cached.preferences);
        } else if (cached.preferences && !cacheIsFresh) {
          console.log('[Cache] Skipping stale cached preferences (age:', Math.round(cacheAge / 1000 / 60), 'min), waiting for fresh DB load');
        }
        setDailyPreps(cached.preps || []);
        setDailyReviews(cached.reviews || []);
        setWeeklyFocusList(cached.weeklyFocus || []);
        setSyncError(null);
        setLoading(false);
        setIsInitialLoadDone(true);
        isFetchingRef.current = false;
        clearTimeout(safetyTimer);

        // PREFETCH SCREENSHOTŮ + AI CONVERSATIONS na pozadí — když user klikne
        // na History / AI tab, cache je už hotová, žádný flash.
        storageService.prefetchAllScreenshots().catch(() => { /* silent */ });
        storageService.getConversations().catch(() => { /* silent */ });

        // Background refresh — silently sync with server, only update if data actually changed
        // Fingerprint checks both count AND content (catches edits without add/delete)
        const fingerprintTrades = (t: Trade[]) => t.map(x => `${x.id}:${x.pnl}:${x.timestamp}`).join('|');
        const fingerprintSimple = (arr: any[]) => arr.map(x => x.id ?? x.date).join('|');
        storageService.getDashboardData().then(fresh => {
          setTrades(prev =>
            fingerprintTrades(fresh.trades) !== fingerprintTrades(prev) ? (fresh.trades || []) : prev
          );
          if (fresh.accounts && fresh.accounts.length > 0) {
            setAccounts(prev =>
              fingerprintSimple(fresh.accounts) !== fingerprintSimple(prev) ? fresh.accounts : prev
            );
          }
          if (fresh.user) { setCurrentUser(fresh.user); setIsUserFromDb(true); }
          if (fresh.preferences) {
            console.log('[BG-Refresh] received fresh prefs, dirty=', isPreferencesDirty.current, 'fields:', {
              sessions: fresh.preferences.sessions?.length,
              htfOptions: fresh.preferences.htfOptions?.length,
              dashboardLayout: fresh.preferences.dashboardLayout?.length,
            });
            if (!isPreferencesDirty.current) applyPreferences(fresh.preferences);
          }
          setDailyPreps(prev =>
            fingerprintSimple(fresh.preps) !== fingerprintSimple(prev) ? (fresh.preps || []) : prev
          );
          setDailyReviews(prev =>
            fingerprintSimple(fresh.reviews) !== fingerprintSimple(prev) ? (fresh.reviews || []) : prev
          );
          setWeeklyFocusList(prev =>
            fingerprintSimple(fresh.weeklyFocus) !== fingerprintSimple(prev) ? (fresh.weeklyFocus || []) : prev
          );
        }).catch(err => console.warn('[Load] Background refresh failed:', err));
        return;
      }

      // --- NO CACHE (first visit): Blocking server load ---
      setInitStatus("Načítám data...");

      try {
        // OPTIMIZED: Single RPC call replaces 7 parallel HTTP requests

        let dbTrades: Trade[] = [];
        let dbAccounts: Account[] = [];
        let dbPreps: DailyPrep[] = [];
        let dbReviews: DailyReview[] = [];
        let dbPrefs: UserPreferences | null = null;
        let dbUser: User | null = null;
        let dbWeeklyFocus: WeeklyFocus[] = [];

        try {
          const result = await Promise.race([
            storageService.getDashboardData(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('RPC timeout')), 15000))
          ]);

          dbTrades = result.trades;
          dbAccounts = result.accounts;
          dbPreps = result.preps;
          dbReviews = result.reviews;
          dbPrefs = result.preferences;
          dbUser = result.user;
          dbWeeklyFocus = result.weeklyFocus;
        } catch (rpcErr) {
          console.warn('[Load] RPC failed, falling back to parallel queries:', rpcErr);
          await getUserId();
          const fb = async <T,>(n: string, fn: () => Promise<T>, d: T): Promise<T> => {
            try {
              return await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${n} timeout`)), 15000))]);
            } catch (e) { console.warn(`[Fallback] ${n} failed:`, e); return d; }
          };
          [dbTrades, dbAccounts, dbPreps, dbReviews, dbPrefs, dbUser, dbWeeklyFocus] = await Promise.all([
            fb('trades', () => storageService.getTrades(), []),
            fb('accounts', () => storageService.getAccounts(), []),
            fb('dailyPreps', () => storageService.getDailyPreps(), []),
            fb('dailyReviews', () => storageService.getDailyReviews(), []),
            fb('preferences', () => storageService.getPreferences(), null),
            fb('user', () => storageService.getUser(), null),
            fb('weeklyFocus', () => storageService.getWeeklyFocusList(), [])
          ]);
        }


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

        if (dbUser) { setCurrentUser(dbUser); setIsUserFromDb(true); }
        if (dbPrefs) applyPreferences(dbPrefs);
        setDailyPreps(dbPreps || []);
        setDailyReviews(dbReviews || []);
        setWeeklyFocusList(dbWeeklyFocus || []);
        // Business Hub data (expenses, payouts, goals, resources) loaded lazily when entering BusinessHub

        setSyncError(null);
        setLoading(false);
        setIsInitialLoadDone(true);

        // Deferred: cleanup legacy localStorage data (not blocking initial render)
        setTimeout(() => {
          const legacyKeys = Object.keys(localStorage).filter(k =>
            k.includes('alphatrade_trades') ||
            k.includes('alphatrade_daily_preps') ||
            k.includes('alphatrade_daily_reviews') ||
            k.includes('alphatrade_cache_timestamp')
          );
          legacyKeys.forEach(k => localStorage.removeItem(k));
        }, 0);

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

            // Helper: parse raw DB row into Trade (same mapping as getTradeById)
            const parseRealtimeTrade = (raw: any): Trade => ({
              ...(raw.data || {}),
              id: raw.id,
              accountId: raw.account_id,
              instrument: raw.instrument,
              pnl: raw.pnl,
              direction: raw.direction,
              date: raw.date,
              timestamp: raw.timestamp,
              drawings: raw.drawings || raw.data?.drawings || [],
              isPublic: raw.is_public,
              createdAt: raw.created_at,
            });

            if (payload.eventType === 'INSERT') {
              const fullTrade = parseRealtimeTrade(payload.new);
              setTrades(prev => {
                if (prev.some(t => t.id === fullTrade.id)) return prev;
                return [fullTrade, ...prev].sort((a, b) => b.timestamp - a.timestamp);
              });

              // Refresh accounts so balance/stats stay current after new trade
              storageService.getAccounts().then(freshAccounts => {
                if (freshAccounts.length > 0) setAccounts(freshAccounts);
              }).catch(() => {});

              try {
                const { addTradeToCache } = await import('./services/cacheHelper');
                await addTradeToCache(fullTrade);
              } catch (err) {
                console.error('[Realtime] Failed to update cache:', err);
              }
            } else if (payload.eventType === 'UPDATE') {
              // Payload může být ČÁSTEČNÝ podle REPLICA IDENTITY (DEFAULT vs FULL).
              // Pokud chybí klíčová pole (account_id nebo data blob), MERGE-uj přes existující
              // optimistic verzi místo přepisu — jinak rozbijeme trade a filtry ho vyhodí.
              const raw: any = payload.new;
              const hasFullPayload = raw && raw.account_id && raw.data && typeof raw.data === 'object';
              if (hasFullPayload) {
                const fullTrade = parseRealtimeTrade(raw);
                setTrades(prev => prev.map(t => t.id === fullTrade.id ? fullTrade : t));
              } else {
                // Částečný payload — mergni jen pole co dorazila do existujícího trade
                setTrades(prev => prev.map(t => {
                  if (t.id !== raw?.id) return t;
                  const partial: any = {};
                  if (raw.account_id) partial.accountId = raw.account_id;
                  if (raw.instrument != null) partial.instrument = raw.instrument;
                  if (raw.pnl != null) partial.pnl = raw.pnl;
                  if (raw.direction != null) partial.direction = raw.direction;
                  if (raw.date != null) partial.date = raw.date;
                  if (raw.timestamp != null) partial.timestamp = raw.timestamp;
                  if (raw.data && typeof raw.data === 'object') Object.assign(partial, raw.data);
                  return { ...t, ...partial };
                }));
              }
            } else if (payload.eventType === 'DELETE') {
              setTrades(prev => prev.filter(t => t.id !== payload.old.id));
            }
          }
        )
        .subscribe((status) => {
          if (status === 'CHANNEL_ERROR') {
            console.warn('[Realtime] WebSocket connection failed. Falling back to REST API only.');
          }
        });

      realtimeChannelRef.current = tradesChannel;
    }, 1000); // 1 second delay after initial load

    return () => {
      clearTimeout(realtimeTimer);
      if (realtimeChannelRef.current) {
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
        return;
      }

      // Debounce to avoid multiple rapid syncs
      setTimeout(async () => {
        try {
          const freshPrefs = await storageService.getPreferences();
          if (freshPrefs) {
            applyPreferences(freshPrefs);
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
      import('./components/DailyJournal');

      // Screenshots now come with the RPC response — no separate prefetch needed

      // Less critical modules - prefetch after small delay
      const prefetchTimer = setTimeout(() => {
        import('./components/Settings');
        import('./components/BusinessHub');
      }, 2000);
      return () => clearTimeout(prefetchTimer);
    }
  }, [isInitialLoadDone]);

  // --- LAZY LOADING: Archived Accounts ---
  const [archivedAccounts, setArchivedAccounts] = useState<Account[]>([]);
  const [isArchivedLoaded, setIsArchivedLoaded] = useState(false);

  useEffect(() => {
    if (dashboardMode === 'archive' && session && !isArchivedLoaded) {
      storageService.getArchivedAccounts().then(archived => {
        setArchivedAccounts(archived || []);
        setIsArchivedLoaded(true);
      }).catch(err => console.error("[LazyLoad] Failed to load archived accounts:", err));
    }
  }, [dashboardMode, session, isArchivedLoaded]);

  // --- LAZY LOADING: Business Hub Data ---
  // Load expenses, goals, resources only when user enters BusinessHub section
  const [isBusinessDataLoaded, setIsBusinessDataLoaded] = useState(false);

  useEffect(() => {
    if (activePage === 'business' && session && !isBusinessDataLoaded) {
      const userId = session.user.id;

      // Cache-first: show cached data instantly, then refresh in background
      try {
        const ce = localStorage.getItem(`alphatrade_biz_expenses_${userId}`);
        const cp = localStorage.getItem(`alphatrade_biz_payouts_${userId}`);
        const cg = localStorage.getItem(`alphatrade_biz_goals_${userId}`);
        const cr = localStorage.getItem(`alphatrade_biz_resources_${userId}`);
        if (ce) {
          setBusinessExpenses(JSON.parse(ce));
          setBusinessPayouts(cp ? JSON.parse(cp) : []);
          setBusinessGoals(cg ? JSON.parse(cg) : []);
          setBusinessResources(cr ? JSON.parse(cr) : []);
          setIsBusinessDataLoaded(true);
        }
      } catch {}

      // Always fetch fresh data (background if cache hit, blocking if not)
      Promise.all([
        storageService.getBusinessExpenses(),
        storageService.getBusinessPayouts(),
        storageService.getBusinessGoals(),
        storageService.getBusinessResources()
      ]).then(([expenses, payouts, goals, resources]) => {
        // Guard: only update state if data actually changed (prevents flicker when cache == server)
        // Using length + id+amount fingerprint avoids expensive JSON.stringify on objects with large fields (e.g. images)
        const fingerprint = (arr: any[]) =>
          arr.length + '|' + arr.map(x => `${x.id ?? ''}:${x.amount ?? x.target ?? x.updatedAt ?? ''}`).join(',');
        const stableSet = <T,>(setter: React.Dispatch<React.SetStateAction<T[]>>, next: T[]) => {
          setter(prev => fingerprint(next) === fingerprint(prev) ? prev : next);
        };
        stableSet(setBusinessExpenses, expenses || []);
        stableSet(setBusinessPayouts, payouts || []);
        stableSet(setBusinessGoals, goals || []);
        stableSet(setBusinessResources, resources || []);
        setIsBusinessDataLoaded(true);

        // Cache for next visit
        try {
          safeSetItem(`alphatrade_biz_expenses_${userId}`, JSON.stringify(expenses || []));
          safeSetItem(`alphatrade_biz_payouts_${userId}`, JSON.stringify(payouts || []));
          safeSetItem(`alphatrade_biz_goals_${userId}`, JSON.stringify(goals || []));
          safeSetItem(`alphatrade_biz_resources_${userId}`, JSON.stringify(resources || []));
        } catch {}

        // Prefetch payout images in background
        if (payouts && payouts.length > 0) {
          storageService.prefetchPayoutImages().then(imageMap => {
            if (imageMap.size > 0) {
              setBusinessPayouts(prev => prev.map(p => {
                const image = imageMap.get(String(p.id));
                return image ? { ...p, image } : p;
              }));
            }
          }).catch(() => {});
        }
      }).catch(err => {
        console.error("[LazyLoad] Failed to load Business Hub data:", err);
      });
    }
  }, [activePage, session, isBusinessDataLoaded]);

  // Cross-device sync: refresh stale data when user returns to tab after 30+ seconds
  const lastVisibleAt = useRef(Date.now());

  useEffect(() => {
    if (!session || !isInitialLoadDone) return;

    const handleFocusSync = async () => {
      if (document.visibilityState !== 'visible') {
        lastVisibleAt.current = Date.now();
        return;
      }

      const elapsed = Date.now() - lastVisibleAt.current;
      if (elapsed < 30000) return; // Skip if tab was hidden < 30s

      try {
        if (!isPrepsDirty.current && !isReviewsDirty.current) {
          const [freshPreps, freshReviews] = await Promise.all([
            storageService.getDailyPreps(),
            storageService.getDailyReviews(),
          ]);
          setDailyPreps(freshPreps || []);
          setDailyReviews(freshReviews || []);
        }

        if (!isPreferencesDirty.current) {
          const freshPrefs = await storageService.getPreferences();
          if (freshPrefs) {
            console.log('[FocusSync] applying fresh prefs from DB:', {
              sessions: freshPrefs.sessions?.length,
              htfOptions: freshPrefs.htfOptions?.length,
              dashboardLayout: freshPrefs.dashboardLayout?.length,
            });
            applyPreferences(freshPrefs);
          }
        } else {
          console.log('[FocusSync] SKIPPED prefs fetch — dirty=true (uživatel má rozdělanou změnu)');
        }

        const freshAccounts = await storageService.getAccounts();
        if (freshAccounts?.length) setAccounts(freshAccounts);

        if (isBusinessDataLoaded) {
          const [expenses, goals, resources] = await Promise.all([
            storageService.getBusinessExpenses(),
            storageService.getBusinessGoals(),
            storageService.getBusinessResources(),
          ]);
          setBusinessExpenses(expenses || []);
          setBusinessGoals(goals || []);
          setBusinessResources(resources || []);
        }

      } catch (err) {
        console.error("[Cross-device] Sync failed:", err);
      }
    };

    document.addEventListener('visibilitychange', handleFocusSync);
    return () => document.removeEventListener('visibilitychange', handleFocusSync);
  }, [session, isInitialLoadDone, applyPreferences, isBusinessDataLoaded]);

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
          // If any accounts were just archived, remove them from active state
          const justArchived = accounts.filter(a => a.isArchived);
          if (justArchived.length > 0) {
            const activeOnly = updatedAccounts.filter(a => !a.isArchived);
            setAccounts(activeOnly);
            setIsArchivedLoaded(false); // Force re-fetch of archived accounts
            return;
          }

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
  // loadedUserId mirrors lastLoadedSessionId.current as proper state so useMemo recalculates on change
  const canSave = useMemo(() => {
    return !sharedTrade && !!session && isInitialLoadDone && session.user?.id === loadedUserId;
  }, [sharedTrade, session, isInitialLoadDone, loadedUserId]);

  useEffect(() => {
    if (canSave && isPrepsDirty.current) {
      const timer = setTimeout(() => {
        isPrepsDirty.current = false;

        storageService.saveDailyPreps(dailyPreps).catch(err => {
          console.error("[Journal] DailyPreps save failed:", err);
          isPrepsDirty.current = true;
        });
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [dailyPreps, canSave]);

  useEffect(() => {
    if (canSave && isReviewsDirty.current) {
      const timer = setTimeout(() => {
        isReviewsDirty.current = false;

        storageService.saveDailyReviews(dailyReviews).catch(err => {
          console.error("[Journal] DailyReviews save failed:", err);
          isReviewsDirty.current = true;
        });
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [dailyReviews, canSave]);

  useEffect(() => { if (canSave) storageService.setActiveAccountId(activeAccountId); }, [activeAccountId, canSave]);

  useEffect(() => {
    if (canSave && isWeeklyFocusDirty.current && weeklyFocusList.length > 0) {
      const timer = setTimeout(() => {
        isWeeklyFocusDirty.current = false;

        // Convert forEach to Promise.all for better error handling
        Promise.all(weeklyFocusList.map(wf => storageService.saveWeeklyFocus(wf)))
          .catch(err => {
            console.error("[Journal] WeeklyFocus save failed:", err);
            isWeeklyFocusDirty.current = true;
          });
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [weeklyFocusList, canSave]);

  // Handle theme persistence independently of session
  useEffect(() => {
    try {
      safeSetItem('alphatrade_theme', theme);
      const stored = localStorage.getItem('alphatrade_preferences');
      const currentUserId = session?.user?.id;
      const prefKey = currentUserId ? `alphatrade_preferences_${currentUserId}` : 'alphatrade_preferences';

      const currentPrefs = stored ? JSON.parse(stored) : {};
      if (currentPrefs.theme !== theme) {
        safeSetItem(prefKey, JSON.stringify({ ...currentPrefs, theme }));
      }
    } catch (e) {
      console.error("Failed to save theme to localStorage", e);
    }
  }, [theme, session]);

  useEffect(() => {
    // KRITICKÉ: nesaveuj preferences, pokud applyPreferences ještě neproběhlo —
    // state by mohl mít defaulty z useState (HTF/LTF, sessions, emotions) a přepsali bychom DB.
    if (canSave && isPreferencesDirty.current && prefsAppliedRef.current) {
      console.log('[Save:debounce] scheduling save in 2s, dirty=', isPreferencesDirty.current, 'applied=', prefsAppliedRef.current);
      const timer = setTimeout(() => {
        const prefs = currentUserPreferences();
        console.log('[Save:debounce] FIRING save with', {
          sessions: (prefs.sessions || []).length,
          htfOptions: (prefs.htfOptions || []).length,
          ltfOptions: (prefs.ltfOptions || []).length,
          ironRules: (prefs.ironRules || []).length,
          dashboardLayout: (prefs.dashboardLayout || []).length,
        });
        // CRITICAL FIX: Clear dirty flag BEFORE saving, not after
        // This prevents background sync from skipping fresh data while save is in progress
        isPreferencesDirty.current = false;

        // Business Hub data (expenses, payouts, goals, resources) now saved to dedicated tables
        // NOT in preferences - prevents data duplication and inconsistency
        storageService.savePreferences(prefs as any).then(() => {
          console.log('[Save:debounce] ✓ SUCCESS');
        }).catch(err => {
          // If save fails, mark as dirty again so we retry
          console.error("[Save:debounce] ✗ FAILED:", err);
          isPreferencesDirty.current = true;
        });
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [userEmotions, userMistakes, standardGoals, dashboardLayout, sessions, htfOptions, ltfOptions, ironRules, playbookItems, constitutionRules, careerRoadmap, businessSettings, psychoMetrics, theme, dashboardMode, systemSettings, networkNotifications, canSave]);

  // ⚡ PERIODIC AUTO-SAVE (Google Docs-like protection)
  // Backup save every 30s if user is still editing
  // This protects against browser crashes or quick tab closures
  useEffect(() => {
    if (!canSave) return;

    const interval = setInterval(() => {
      // Only save if there are pending changes AND prefs už byly aplikovány z cache/DB
      if (isPreferencesDirty.current && prefsAppliedRef.current) {
        isPreferencesDirty.current = false;

        // Business Hub data excluded - saved to dedicated tables, not preferences
        storageService.savePreferences(currentUserPreferences() as any).catch(err => {
          console.error("[Auto-Save] Periodic save failed:", err);
          isPreferencesDirty.current = true;
        });
      }

      // Journal data (daily preps/reviews/weeklyFocus) — each flag is independent
      const wasPreps = isPrepsDirty.current;
      const wasReviews = isReviewsDirty.current;
      const wasWeekly = isWeeklyFocusDirty.current;
      if (wasPreps || wasReviews || wasWeekly) {
        isPrepsDirty.current = false;
        isReviewsDirty.current = false;
        isWeeklyFocusDirty.current = false;

        Promise.all([
          wasPreps ? storageService.saveDailyPreps(dailyPreps) : Promise.resolve(),
          wasReviews ? storageService.saveDailyReviews(dailyReviews) : Promise.resolve(),
          wasWeekly && weeklyFocusList.length > 0
            ? Promise.all(weeklyFocusList.map(wf => storageService.saveWeeklyFocus(wf)))
            : Promise.resolve()
        ]).catch(err => {
          console.error("[Auto-Save] Periodic journal save failed:", err);
          if (wasPreps) isPrepsDirty.current = true;
          if (wasReviews) isReviewsDirty.current = true;
          if (wasWeekly) isWeeklyFocusDirty.current = true;
        });
      }
    }, 30000); // 30 seconds

    return () => {
      clearInterval(interval);
    };
  }, [canSave, userEmotions, userMistakes, standardGoals, dashboardLayout, sessions, htfOptions, ltfOptions, ironRules, playbookItems, constitutionRules, careerRoadmap, businessSettings, psychoMetrics, theme, dashboardMode, systemSettings, networkNotifications, dailyPreps, dailyReviews, weeklyFocusList]);

  // Flush dirty data to DB when user leaves tab (visibilitychange) or closes browser (beforeunload)
  useEffect(() => {
    if (!canSave) return;

    const flushDirtyData = () => {
      if (isPrepsDirty.current) {
        isPrepsDirty.current = false;
        storageService.saveDailyPreps(dailyPreps).catch(() => { isPrepsDirty.current = true; });
      }
      if (isReviewsDirty.current) {
        isReviewsDirty.current = false;
        storageService.saveDailyReviews(dailyReviews).catch(() => { isReviewsDirty.current = true; });
      }
      if (isWeeklyFocusDirty.current && weeklyFocusList.length > 0) {
        isWeeklyFocusDirty.current = false;
        Promise.all(weeklyFocusList.map(wf => storageService.saveWeeklyFocus(wf)))
          .catch(() => { isWeeklyFocusDirty.current = true; });
      }
      if (isPreferencesDirty.current && prefsAppliedRef.current) {
        // KRITICKÉ: NEČISTI dirty flag dokud save nepotvrdí. Pri beforeunload je tab close
        // race — pokud bys clearnul dirty před save completion, save může selhat tiše
        // (tab dies mid-request) a uživatel ztratí změny. Necháváme dirty=true; flush
        // probíhá best-effort, pokud projde, server-side update se vystaví a další load
        // si vezme čerstvá data z DB.
        const prefs = currentUserPreferences() as any;
        storageService.savePreferences(prefs)
          .then(() => { isPreferencesDirty.current = false; })
          .catch((err: any) => {
            console.warn('[Flush] savePreferences failed during page unload:', err?.message || err);
            // Dirty stays true — next load triggers retry via auto-save interval
          });
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushDirtyData();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', flushDirtyData);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', flushDirtyData);
    };
  }, [canSave, dailyPreps, dailyReviews, userEmotions, userMistakes, standardGoals, dashboardLayout, sessions, htfOptions, ltfOptions, ironRules, playbookItems, constitutionRules, careerRoadmap, businessSettings, psychoMetrics, theme, dashboardMode, systemSettings, networkNotifications]);

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
      } else if (dashboardMode === 'backtesting') {
        const backtestIds = accounts
          .filter(a => a.type === 'Backtest')
          .map(a => a.id);
        setFilters(prev => ({ ...prev, accounts: backtestIds }));
      } else if (dashboardMode === 'archive') {
        // Show only archived accounts (lazy-loaded separately)
        const archivedIds = archivedAccounts.map(a => a.id);
        setFilters(prev => ({ ...prev, accounts: archivedIds }));
      }

      // Persist immediately to local storage to survive refresh
      safeSetItem('alphatrade_dash_mode', dashboardMode);

    }
  }, [dashboardMode, accounts, archivedAccounts, activePage, isInitialLoadDone]);

  const contextAccounts = useMemo(() => {
    if (activePage !== 'dashboard') return accounts;
    if (dashboardMode === 'combined') return accounts;
    if (dashboardMode === 'funded') return accounts.filter(a => (a.type === 'Funded' && a.phase === 'Funded') || a.type === 'Live');
    if (dashboardMode === 'challenge') return accounts.filter(a => a.type === 'Funded' && a.phase === 'Challenge');
    if (dashboardMode === 'backtesting') return accounts.filter(a => a.type === 'Backtest');
    if (dashboardMode === 'archive') return archivedAccounts;
    return accounts;
  }, [accounts, archivedAccounts, activePage, dashboardMode]);

  const activeAccount = useMemo(() => accounts.find(a => a.id === activeAccountId) || accounts[0] || DEFAULT_ACCOUNT, [accounts, activeAccountId]);

  // Effective active account for the current dashboard context:
  // if the globally-selected activeAccount is NOT in contextAccounts (e.g. you switched to Challenge mode
  // but activeAccountId still points to a Live account), fall back to the first contextAccount.
  const effectiveActiveAccount = useMemo(() => {
    if (contextAccounts.some(a => a.id === activeAccountId)) return activeAccount;
    return contextAccounts[0] || activeAccount;
  }, [contextAccounts, activeAccount, activeAccountId]);

  const displayBalance = useMemo(() => {
    if (viewMode === 'individual') return effectiveActiveAccount.initialBalance || 0;

    // Filter out archived accounts - only use active accounts for balance calculation
    const activeContextAccounts = contextAccounts.filter(a => a.status === 'Active');

    // If no active accounts, return 0 instead of summing archived accounts
    if (activeContextAccounts.length === 0) return 0;

    // Sum initial balances of all active accounts that are in the current context
    return activeContextAccounts
      .reduce((sum, a) => sum + (a.initialBalance || 0), 0);
  }, [contextAccounts, effectiveActiveAccount, viewMode]);

  const [quickNote, setQuickNote] = useState('');

  const [journalActiveTab, setJournalActiveTab] = useState<'daily' | 'weekly' | 'archives'>('daily');
  const [settingsActiveTab, setSettingsActiveTab] = useState<'psychology' | 'strategy' | 'market' | 'system'>('psychology');
  const [businessActiveTab, setBusinessActiveTab] = useState<'financials' | 'goals'>('financials');
  const [historyLayoutMode, setHistoryLayoutMode] = useState<'grid' | 'table'>('grid');
  const [networkActiveTab, setNetworkActiveTab] = useState<'leaderboard' | 'feed' | 'following' | 'followers' | 'requests' | 'share'>('feed');
  const [isNetworkSpectating, setIsNetworkSpectating] = useState(false);

  const displayTrades = useMemo(() => {
    if (viewMode === 'individual') {
      // Strategie:
      //   1. Primárně zkus zobrazit trades z aktivního účtu + jeho kopií (jeho "rodiny")
      //   2. Pokud má aktivní účet 0 trades (typický case: prázdný master account jako "Hlavní účet"),
      //      fallback na všechny účty v contextAccounts (= v aktuálním dashboardMode).
      //      Tím uživatel uvidí všechny své challenge/funded trades i když má aktivní prázdný účet.
      const activeId = effectiveActiveAccount.id;
      const childIds = accounts.filter(a => a.parentAccountId === activeId).map(a => a.id);
      const familyIds = new Set([activeId, ...childIds]);
      // Pokud je aktivní účet kopie, přidej i master a sourozence
      const masterId = effectiveActiveAccount.parentAccountId;
      if (masterId) {
        familyIds.add(masterId as string);
        accounts.filter(a => a.parentAccountId === masterId).forEach(a => familyIds.add(a.id));
      }
      const familyResult = trades.filter(t => familyIds.has(t.accountId as string));

      if (familyResult.length > 0) return familyResult;

      // Fallback: žádné trades v rodině → ukaž všechny účty z contextAccounts
      // (= účty co prošly dashboardMode filtrem, např. všechny challenge účty)
      if (contextAccounts.length > 0) {
        const contextIds = new Set(contextAccounts.map(a => a.id));
        return trades.filter(t => contextIds.has(t.accountId as string));
      }
      return [];
    }

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
  }, [trades, viewMode, effectiveActiveAccount, accounts, contextAccounts]);

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

      if (dbUser) { setCurrentUser(dbUser); setIsUserFromDb(true); }

      // No longer filter weekends at data level - this should be a UI filter
      setTrades(dbTrades || []);

      if (dbAccounts && dbAccounts.length > 0) {
        setAccounts(dbAccounts);
      }

      if (!isPrepsDirty.current) setDailyPreps(dbPreps || []);
      if (!isReviewsDirty.current) setDailyReviews(dbReviews || []);
      setWeeklyFocusList(dbWeeklyFocus || []);

      // Refresh Business Hub data
      setBusinessPayouts(dbPayouts || []);
      setBusinessExpenses(dbExpenses || []);
      setBusinessGoals(dbGoals || []);
      setBusinessResources(dbResources || []);

      if (dbPrefs) {
        console.log('[PullRefresh] received dbPrefs, dirty=', isPreferencesDirty.current);
        if (!isPreferencesDirty.current) applyPreferences(dbPrefs);
      }

    } catch (error) {
      console.error('[Refresh] Error:', error);
      throw error; // Re-throw to show error in Pull-to-Refresh
    }
  }, [session, isPrepsDirty, isReviewsDirty, isWeeklyFocusDirty, isPreferencesDirty]);

  const baseFilteredTrades = useMemo(() => {
    const now = new Date();
    return displayTrades.filter(t => {
      // DEBUG: Log Alpha Bridge trades to see why they're filtered
      const isAlphaBridge = t.signal === 'Alpha Bridge v2';

      // Filter by phase based on dashboardMode
      // ALWAYS use account phase as source of truth, not trade phase
      if (dashboardMode === 'challenge') {
        const acc = accounts.find(a => a.id === t.accountId);
        const isChallenge = acc?.type === 'Funded' && acc?.phase === 'Challenge';
        if (!isChallenge) {
          return false;
        }
      } else if (dashboardMode === 'backtesting') {
        const acc = accounts.find(a => a.id === t.accountId);
        const isBacktest = acc?.type === 'Backtest';
        if (!isBacktest) {
          return false;
        }
      } else if (dashboardMode === 'funded') {
        const acc = accounts.find(a => a.id === t.accountId);
        const isFunded = acc?.type === 'Live' || (acc?.type === 'Funded' && acc?.phase === 'Funded');
        if (!isFunded) {
          return false;
        }
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
        // In normal mode, empty filter means "show all accounts"
        if (filters.accounts.length === 0) {
          matchAcc = true;
        } else {
          matchAcc = filters.accounts.includes(t.accountId);
        }
      }

      // Case-insensitive direction matching (SHORT/Short, LONG/Long)
      const matchDir = filters.directions.some(dir =>
        dir.toLowerCase() === t.direction?.toLowerCase()
      );
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
      if (dashboardMode !== 'backtesting' && filters.period !== 'all') {
        const diffDays = (now.getTime() - d.getTime()) / (1000 * 3600 * 24);
        if (filters.period === 'week' && diffDays > 7) matchPeriod = false;
        if (filters.period === 'month' && diffDays > 30) matchPeriod = false;
        if (filters.period === 'quarter' && diffDays > 90) matchPeriod = false;
        if (filters.period === 'year' && diffDays > 365) matchPeriod = false;
      }

      const passes = matchDay && matchHour && matchAcc && matchDir && matchRes && matchPeriod &&
        matchStatus && matchHtf && matchLtf && matchMistake;

      return passes;
    });
  }, [displayTrades, filters, viewMode, accounts, dashboardMode]);

  const filteredDisplayTrades = useMemo(() => {
    return viewMode === 'combined' ? aggregateTrades(baseFilteredTrades, accounts) : baseFilteredTrades;
  }, [baseFilteredTrades, viewMode]);

  const filteredStats = useMemo(() => {
    try {
      return calculateStats(filteredDisplayTrades, displayBalance);
    } catch (e) {
      console.error("Filtered stats calculation error:", e);
      return calculateStats([], 0);
    }
  }, [filteredDisplayTrades, displayBalance]);

  const handleUpdateUser = async (updatedUser: User) => {
    setCurrentUser(updatedUser);
    try {
      await storageService.saveUser(updatedUser);
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
        }
        // Check for bulk-entry group
        else if (firstNewTrade.groupId) {
          const groupId = firstNewTrade.groupId;
          // Remove all trades with this groupId
          updated = updated.filter(t => t.groupId !== groupId);
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

      return updated;
    });

    // Save ONLY the new/changed trades (not ALL trades — prevents screenshot data loss)
    storageService.saveTrades(newTradesArray).catch(err => {
      console.error("Manual trade save failed:", err);
      setSyncError("Nepodařilo se uložit obchod.");
    });

    setIsManualEntryOpen(false);
  };

  const handleUpdateTrades = useCallback((updatedTrades: Trade[]) => {
    const snapshot = trades;
    setTrades(updatedTrades);
    // Use per-trade updateTrade to avoid bulk saveTrades overwriting screenshot data
    Promise.all(updatedTrades.map(t => storageService.updateTrade(t.id as string, t)))
      
      .catch(err => {
        console.error("Failed to force-save trades", err);
        setTrades(snapshot);
        setSyncError("Nepodařilo se uložit změny obchodů.");
      });
  }, [trades]);

  const handleUpdateTrade = useCallback((tradeId: string | number, updates: Partial<Trade>) => {
    // Snapshot stavu před optimistickou aktualizací pro případ rollbacku
    let snapshot: Trade | undefined;
    setTrades(prev => {
      snapshot = prev.find(t => t.id === tradeId);
      return prev.map(t => t.id === tradeId ? { ...t, ...updates } : t);
    });

    // Persist only the changed trade to DB (not ALL trades — prevents screenshot data loss)
    if (typeof tradeId === 'string' && tradeId.includes('-')) {
      storageService.updateTrade(tradeId, updates).catch(err => {
        console.error("Failed to persist trade update:", err);
        setSyncError("Nepodařilo se uložit změny obchodu. Změny byly vráceny zpět.");
        // Rollback optimistické aktualizace — vrať původní data
        if (snapshot) {
          setTrades(prev => prev.map(t => t.id === tradeId ? snapshot! : t));
        }
      });
    }
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
    const idsToDelete: (string | number)[] = [];

    if (typeof id === 'string' && id.startsWith('combined_')) {
      const groupId = id.replace('combined_', '');
      const groupTrades = trades.filter(t => t.groupId === groupId);
      idsToDelete.push(...groupTrades.map(t => t.id));
    } else {
      const tradeToDelete = trades.find(t => t.id === id);
      if (!tradeToDelete) return;
      // Přeskočit non-UUID ID (combined_, numerické) — deleteTrade je tiše ignoruje
      if (!isUUID(String(id))) {
        console.warn(`[DeleteTrade] Skipping non-UUID id: ${id}`);
        setSyncError("Tento obchod nelze smazat — nemá platné ID.");
        return;
      }
      idsToDelete.push(id);
      if (tradeToDelete.isMaster) {
        const copies = trades.filter(t => t.masterTradeId === id).map(t => t.id);
        idsToDelete.push(...copies);
      }
    }

    if (idsToDelete.length === 0) return;

    // Snapshot pro rollback
    const snapshot = trades;
    setTrades(prev => prev.filter(t => !idsToDelete.includes(t.id)));

    try {
      for (const tradeId of idsToDelete) {
        await storageService.deleteTrade(tradeId as string);
      }
    } catch (err) {
      console.error("Failed to delete trade:", err);
      // Rollback — vrátit původní stav
      setTrades(snapshot);
      setSyncError("Nepodařilo se smazat obchod. Zkus to znovu.");
    }
  };

  const handleClearTrades = async () => {
    setIsClearTradesModalOpen(true);
  };

  const executeClearTrades = async () => {
    const snapshot = trades;
    setTrades(prev => prev.filter(t => t.accountId !== activeAccountId));
    try {
      await storageService.clearTrades(activeAccountId);
    } catch (err) {
      console.error("Failed to clear trades:", err);
      setTrades(snapshot); // Rollback
      setSyncError("Nepodařilo se smazat obchody. Zkus to znovu.");
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
      setBusinessExpenses(prev); // Rollback on failure
      setSyncError("Nepodařilo se uložit výdaje.");
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
        if (!old) return false;
        // Compare metadata only — skip base64 image field to avoid slow serialization
        return old.amount !== np.amount || old.date !== np.date || old.accountId !== np.accountId || old.notes !== np.notes;
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
        // Merge images back from local state (getBusinessPayouts doesn't fetch images)
        setBusinessPayouts(fresh.map(fp => {
          const local = newPayouts.find(np => np.accountId === fp.accountId && np.date === fp.date && np.amount === fp.amount);
          return local?.image ? { ...fp, image: local.image } : fp;
        }));
      }
    } catch (err) {
      console.error('[BusinessHub] Failed to sync payouts:', err);
      setBusinessPayouts(prev); // Rollback on failure
      setSyncError("Nepodařilo se uložit výplaty.");
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
      setBusinessGoals(prev); // Rollback on failure
      setSyncError("Nepodařilo se uložit cíle.");
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
      setBusinessResources(prev); // Rollback on failure
      setSyncError("Nepodařilo se uložit zdroje.");
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

  // GATE pro shared trade — pokud je v URL ?shareId nebo ?share, NEZOBRAZUJEME
  // ani login ani app UI dokud se shared trade nenačte. Předchází to flashe
  // tvého účtu / login screenu před shared view (race condition).
  const hasShareInUrl = (() => {
    const p = new URLSearchParams(window.location.search);
    return !!p.get('shareId') || !!p.get('share');
  })();

  if (hasShareInUrl && !sharedTrade) {
    // Stále načítáme — držet loader bez ohledu na session/loading stav
    return <QuantumLoader theme={theme} />;
  }

  if (sharedTrade) {
    return <SharedTradeView trade={sharedTrade} theme={theme} ownerName={sharedOwnerName} ownerAvatar={sharedOwnerAvatar} />;
  }

  // Show loader during initial auth check OR when logged in but data not yet loaded.
  // Také DRŽÍME loader dokud nedoběhne DB user s rolí — eliminuje flash locked tabů
  // pro ownery (instant user z JWT má dočasnou role='friend' než DB přepíše).
  if (loading || (session && !isInitialLoadDone) || (session && !isUserFromDb)) {
    return <QuantumLoader theme={theme} />;
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
      {/* Sidebar — pouze desktop */}
      <div className="hidden lg:block">
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
            localStorage.clear();
            await supabase.auth.signOut();
            setSession(null);
            window.location.reload();
          }}
          onOpenProfile={() => setIsProfileOpen(true)}
          onNavigate={(page) => {
            setActivePage(page);
            setIsSidebarOpen(false);
          }}
          onLockedFeature={(featureId) => setLockedFeatureModal(featureId)}
        />
      </div>

      {/* Bottom navigation — pouze mobil */}
      <BottomNav
        activePage={activePage}
        onNavigate={(page) => setActivePage(page)}
        onAddTrade={handleTryAddTrade}
        theme={theme}
        userRole={currentUser.role}
        onLockedFeature={(featureId) => setLockedFeatureModal(featureId)}
      />

      {/* Locked feature info modal — friend role klikne na uzamčenou položku */}
      <LockedFeatureModal
        featureId={lockedFeatureModal}
        onClose={() => setLockedFeatureModal(null)}
      />

      <main className={`flex-1 h-screen overflow-hidden transition-all duration-300 relative flex flex-col ${isSidebarCollapsed ? 'lg:ml-[72px]' : 'lg:ml-[240px]'} ${isNetworkSpectating ? '!ml-0' : ''} pb-[72px] lg:pb-0`}>
        <header className={`sticky top-0 z-40 border-b backdrop-blur-md px-6 py-2 flex items-center justify-between transition-all bg-[var(--bg-page)]/30 border-[var(--border-subtle)] ${isNetworkSpectating ? 'hidden' : ''}`}>
          <div className="flex items-center gap-4">
            <button onClick={() => setIsSidebarOpen(true)} className="hidden p-2 hover:bg-white/10 rounded-lg"><Menu size={20} /></button>
            <h2 className="text-xl font-black uppercase tracking-tighter">
              {activePage === 'dashboard' && 'Dashboard'}
              {activePage === 'history' && 'Historie obchodu'}
              {activePage === 'insights' && 'Insights'}
              {activePage === 'journal' && 'Deník'}
              {activePage === 'accounts' && 'Portfolio'}
              {activePage === 'settings' && 'Nastavení'}
              {activePage === 'network' && 'Síť'}
              {activePage === 'business' && 'Business Hub'}
              {activePage === 'ai' && 'AI Coach'}
            </h2>
          </div>

          {activePage === 'journal' && (
            <div className="hidden md:flex flex-1 justify-center">
              <div className="p-1 rounded-2xl border flex gap-1 bg-[var(--bg-card)]/40 border-[var(--border-subtle)] backdrop-blur-md shadow-sm">
                {[
                  { id: 'daily', label: 'Dnešek', icon: Clock },
                  { id: 'weekly', label: 'Týden', icon: Calendar },
                  { id: 'archives', label: 'Deník', icon: History }
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setJournalActiveTab(tab.id as any)}
                    className={`relative flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold uppercase transition-all ${journalActiveTab === tab.id ? (theme !== 'light' ? 'text-white' : 'text-slate-900') : (theme !== 'light' ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600')}`}
                  >
                    {journalActiveTab === tab.id && (
                      <motion.div
                        layoutId="activeJournalTab"
                        className={`absolute inset-0 rounded-xl shadow-sm z-0 ${theme !== 'light' ? 'bg-slate-700/50' : 'bg-white border border-slate-200/60'}`}
                        transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                      />
                    )}
                    <span className="relative z-10 flex items-center gap-2">
                      <tab.icon size={14} /> {tab.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {activePage === 'business' && (
            <div className="hidden md:flex flex-1 justify-center">
              <div className="p-1 rounded-2xl border flex gap-1 bg-[var(--bg-card)]/40 border-[var(--border-subtle)] backdrop-blur-md shadow-sm">
                {[
                  { id: 'financials', label: 'Finance', icon: DollarSign },
                  { id: 'goals', label: 'Cíle', icon: Target }
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setBusinessActiveTab(tab.id as any)}
                    className={`relative flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold uppercase transition-all ${businessActiveTab === tab.id ? (theme !== 'light' ? 'text-white' : 'text-slate-900') : (theme !== 'light' ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600')}`}
                  >
                    {businessActiveTab === tab.id && (
                      <motion.div
                        layoutId="activeBusinessTab"
                        className={`absolute inset-0 rounded-xl shadow-sm z-0 ${theme !== 'light' ? 'bg-slate-700/50' : 'bg-white border border-slate-200/60'}`}
                        transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                      />
                    )}
                    <span className="relative z-10 flex items-center gap-2">
                      <tab.icon size={14} /> {tab.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {activePage === 'network' && (
            <div className="hidden md:flex flex-1 justify-center">
              <div className="p-1 rounded-2xl border flex gap-1 bg-[var(--bg-card)]/40 border-[var(--border-subtle)] backdrop-blur-md shadow-sm">
                {[
                  { id: 'feed', label: 'Feed', icon: Activity },
                  { id: 'leaderboard', label: 'Žebříček', icon: Trophy },
                  { id: 'following', label: 'Sledovaní', icon: Users },
                  { id: 'followers', label: 'Sledující', icon: UserIcon },
                  { id: 'requests', label: 'Žádosti', icon: MessageSquare }
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setNetworkActiveTab(tab.id as any)}
                    className={`relative flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold uppercase transition-all ${networkActiveTab === tab.id ? (theme !== 'light' ? 'text-white' : 'text-slate-900') : (theme !== 'light' ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600')}`}
                  >
                    {networkActiveTab === tab.id && (
                      <motion.div
                        layoutId="activeNetworkTab"
                        className={`absolute inset-0 rounded-xl shadow-sm z-0 ${theme !== 'light' ? 'bg-slate-700/50' : 'bg-white border border-slate-200/60'}`}
                        transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                      />
                    )}
                    <span className="relative z-10 flex items-center gap-2">
                      <tab.icon size={14} /> {tab.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {activePage === 'settings' && (
            <div className="hidden md:flex flex-1 justify-center">
              <div className="p-1 rounded-2xl border flex gap-1 bg-[var(--bg-card)]/40 border-[var(--border-subtle)] backdrop-blur-md shadow-sm">
                {[
                  { id: 'psychology', label: 'Psychologie', icon: Brain },
                  { id: 'strategy', label: 'Strategie', icon: Target },
                  { id: 'market', label: 'Trh', icon: Clock },
                  { id: 'system', label: 'Systém', icon: Shield }
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setSettingsActiveTab(tab.id as any)}
                    className={`relative flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold uppercase transition-all ${settingsActiveTab === tab.id ? (theme !== 'light' ? 'text-white' : 'text-slate-900') : (theme !== 'light' ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600')}`}
                  >
                    {settingsActiveTab === tab.id && (
                      <motion.div
                        layoutId="activeSettingsTab"
                        className={`absolute inset-0 rounded-xl shadow-sm z-0 ${theme !== 'light' ? 'bg-slate-700/50' : 'bg-white border border-slate-200/60'}`}
                        transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                      />
                    )}
                    <span className="relative z-10 flex items-center gap-2">
                      <tab.icon size={14} /> {tab.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-6">
            {/* Dashboard Mode Status - Clean Text Design */}
            <div className="hidden md:flex items-center h-8 px-4">
              <div className="flex items-center gap-2.5">
                <div className="relative flex h-2 w-2">
                  <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${dashboardMode === 'funded' ? 'animate-ping bg-emerald-400' : 'hidden'}`}></span>
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${dashboardMode === 'funded' ? 'bg-emerald-500' : dashboardMode === 'challenge' ? 'bg-blue-500' : dashboardMode === 'backtesting' ? 'bg-violet-500' : 'bg-orange-500'}`}></span>
                </div>
                <span className={`text-[10px] font-black uppercase tracking-[0.2em] ${dashboardMode === 'funded' ? 'text-emerald-400' : dashboardMode === 'challenge' ? 'text-blue-400' : dashboardMode === 'backtesting' ? 'text-violet-400' : 'text-orange-400'}`}>
                  {dashboardMode === 'funded' ? 'Funded' : dashboardMode === 'challenge' ? 'Challenge' : dashboardMode === 'backtesting' ? 'Backtesting' : 'All'}
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
                isMobileEditing={activePage === 'dashboard' ? isMobileEditing : undefined}
                setIsMobileEditing={activePage === 'dashboard' ? setIsMobileEditing : undefined}
                dashboardMode={dashboardMode}
                setDashboardMode={(v) => { setDashboardMode(v); isPreferencesDirty.current = true; }}
                viewMode={viewMode}
                setViewMode={setViewMode}
                pnlDisplayMode={pnlDisplayMode}
                setPnlDisplayMode={setPnlDisplayMode}
                historyLayoutMode={activePage === 'history' ? historyLayoutMode : undefined}
                setHistoryLayoutMode={activePage === 'history' ? setHistoryLayoutMode : undefined}
              />

              <button
                onClick={() => {
                  let newTheme: 'dark' | 'light' | 'oled' = 'dark';
                  if (theme === 'dark') newTheme = 'light';
                  else if (theme === 'light') newTheme = 'oled';
                  setTheme(newTheme);
                }}
                className={`p-3 rounded-xl border transition-all ${theme !== 'light' ? 'bg-white/5 border-white/10 hover:bg-white/10 text-white' : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-700 shadow-sm'}`}
              >
                {theme === 'light' ? <Sun size={20} /> : (theme === 'oled' ? <Zap size={20} className="text-blue-500" /> : <Moon size={20} />)}
              </button>
            </div>
          </div>
        </header>

        {/* AI Coach — renders directly in <main>, bypasses PullToRefresh/scroll container */}
        {activePage === 'ai' && (
          <div className="flex-1 overflow-hidden h-full">
            <React.Suspense fallback={<div className="flex-1" />}>
              <AICoachPage
                trades={trades}
                accounts={accounts}
                ironRules={ironRules}
                standardGoals={standardGoals}
                playbookItems={playbookItems}
                dailyPreps={dailyPreps}
                dailyReviews={dailyReviews}
                theme={theme}
                initialConversationId={aiActiveConvId}
                initialPrompt={aiInitialPrompt}
                onInitialPromptConsumed={() => setAiInitialPrompt(undefined)}
                onOpenTrade={(trade) => setAiChatTrade(trade)}
                onOpenJournal={(date) => {
                  setJournalTargetDate(date);
                  setActivePage('journal');
                }}
                onApplyAction={(action) => {
                  // Aplikuje doporučenou akci z AI Coache do uživatelova systému.
                  // Každý typ akce má jiný target — Iron Rule, Goal (standardGoals), atd.
                  // KRITICKÉ: setIronRules / setStandardGoals MUSÍ být doprovozeny
                  // `isPreferencesDirty.current = true`, jinak background sync přepíše tvoje změny.
                  switch (action.type) {
                    case 'rule':
                    case 'experiment': {
                      // Experiment je rule s expirací — pro MVP ho přidáme jako Iron Rule
                      // s prefixem ⏱ a duration suffixem. Auto-expire můžeme doplnit později.
                      const prefix = action.type === 'experiment' && action.duration
                        ? `⏱ [${action.duration}] ` : '';
                      const label = `${prefix}${action.label}`;
                      const newRule: IronRule = {
                        id: `rule_${Date.now()}`,
                        label,
                        isActive: true,
                      };
                      setIronRules(prev => [...prev, newRule]);
                      isPreferencesDirty.current = true;
                      break;
                    }
                    case 'goal': {
                      // Goals jsou string[] (standardGoals). Přidej jen pokud ještě není.
                      setStandardGoals(prev =>
                        prev.includes(action.label) ? prev : [...prev, action.label]
                      );
                      isPreferencesDirty.current = true;
                      break;
                    }
                    case 'checklist': {
                      // Checklist uložíme jako JEDEN Iron Rule s multi-line textem
                      // (hlavička + odrážky). User pak vidí celý checklist pohromadě
                      // v Settings → Pravidla. AI Coach k tomu má přístup.
                      const items = action.items || [];
                      const itemsText = items.length > 0
                        ? '\n' + items.map(item => `  ▢ ${item}`).join('\n')
                        : '';
                      const newRule: IronRule = {
                        id: `rule_${Date.now()}`,
                        label: `📋 ${action.label}${itemsText}`,
                        isActive: true,
                      };
                      setIronRules(prev => [...prev, newRule]);
                      isPreferencesDirty.current = true;
                      break;
                    }
                  }
                }}
              />
            </React.Suspense>
          </div>
        )}

        <div className={`flex-1 no-scrollbar overflow-y-auto ${activePage === 'ai' ? 'hidden' : ''}`}>
          <PullToRefresh
            onRefresh={handleRefreshData}
            disabled={!session || loading}
          >
            <div className="flex-1 overflow-x-hidden p-4 lg:p-8 pb-12">
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
                <React.Suspense fallback={<div className="flex-1" />}>
                  {activePage === 'dashboard' && (
                    <Dashboard
                      stats={filteredStats}
                      theme={theme}
                      preps={dailyPreps}
                      reviews={dailyReviews}
                      layout={dashboardLayout}
                      sessions={sessions}
                      ironRules={ironRules}
                      onUpdateLayout={(v) => {
                          // GATE: před DB loadem (prefsAppliedRef=false) je layout v state pouze
                          // DEFAULT_WIDGETS. react-grid-layout fires onLayoutChange automaticky při
                          // mount s normalizovanými coords (různé od defaultů ale stále NE user input).
                          // Bez tohoto gate by dirty=true → BG-Refresh SKIPNE fresh prefs → auto-save
                          // přepíše DB defaultem. User akce není možná před loadem (loading screen).
                          if (!prefsAppliedRef.current) {
                              console.log('[Setter] setDashboardLayout BLOCKED (prefs not yet applied)');
                              return;
                          }
                          // Identity check pro post-load auto-fires (resize, theme change atd.)
                          try {
                              if (JSON.stringify(v) === JSON.stringify(dashboardLayout)) return;
                          } catch { /* fallthrough */ }
                          setDashboardLayout(v);
                          isPreferencesDirty.current = true;
                          console.log('[Setter] setDashboardLayout (widgets:', v.length, ') → dirty=true');
                      }}
                      isEditing={isDashboardEditing}
                      onCloseEdit={() => setIsDashboardEditing(false)}
                      dashboardMode={dashboardMode}
                      setDashboardMode={(v) => { setDashboardMode(v); isPreferencesDirty.current = true; }}
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
                      isMobileEditing={isMobileEditing}
                      setIsMobileEditing={setIsMobileEditing}
                      onAnalyzeWithAI={(prompt) => {
                        setAiActiveConvId(undefined);
                        setAiInitialPrompt(prompt);
                        setActivePage('ai');
                      }}
                      onNavigateToSettings={() => setActivePage('settings')}
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
                        viewMode={historyLayoutMode}
                      />
                    )
                  )}

                  {activePage === 'insights' && (
                    <div className="p-4 md:p-8 max-w-7xl mx-auto w-full">
                      <div className="mb-6">
                        <h2 className={`text-3xl font-black tracking-tighter uppercase mb-1 ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>
                          Insights
                        </h2>
                        <p className="text-xs text-slate-500 font-bold uppercase tracking-widest">
                          Pattern analýza nad tvojí historií · detekce leaks & strengths
                        </p>
                      </div>
                      <InsightsPanel
                        trades={trades}
                        theme={theme}
                        onAddRule={(rule) => {
                          // Přidá insight jako nové Iron Rule
                          const newRule = { id: `rule_${Date.now()}`, label: rule, isActive: true };
                          setIronRules(prev => [...prev, newRule as any]);
                        }}
                        onAskAI={(prompt) => {
                          // Otevře AI Coach s pre-fill promptem
                          setAiInitialPrompt(prompt);
                          setActivePage('ai');
                        }}
                        onOpenTrade={(trade) => {
                          // Otevře trade detail modal (existující flow pro AI chat trade)
                          setAiChatTrade(trade);
                        }}
                      />
                    </div>
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
                      activeTab={journalActiveTab}
                      onTabChange={setJournalActiveTab}
                      sessions={sessions}
                      initialDate={journalTargetDate}
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
                    <NetworkHub
                      theme={theme}
                      accounts={accounts}
                      emotions={userEmotions}
                      user={currentUser}
                      exchangeRates={exchangeRates}
                      activeTab={networkActiveTab}
                      onTabChange={setNetworkActiveTab}
                      onNetworkNotificationsChange={(prefs) => { setNetworkNotifications(prefs); isPreferencesDirty.current = true; }}
                      onSpectatingChange={setIsNetworkSpectating}
                    />
                  )}

                  {activePage === 'settings' && (
                    <Settings
                      theme={theme}
                      activeTab={settingsActiveTab}
                      onTabChange={setSettingsActiveTab}
                      userEmotions={userEmotions} setUserEmotions={(v) => { setUserEmotions(v); isPreferencesDirty.current = true; }}
                      userMistakes={userMistakes} setUserMistakes={(v) => { setUserMistakes(v); isPreferencesDirty.current = true; }}
                      htfOptions={htfOptions} setHtfOptions={(v) => { setHtfOptions(v); isPreferencesDirty.current = true; }}
                      ltfOptions={ltfOptions} setLtfOptions={(v) => { setLtfOptions(v); isPreferencesDirty.current = true; }}
                      sessions={sessions} setSessions={(v) => { setSessions(v); isPreferencesDirty.current = true; console.log('[Setter] setSessions → dirty=true'); }}
                      ironRules={ironRules}
                      setIronRules={(v) => { setIronRules(v); isPreferencesDirty.current = true; }}
                      psychoMetrics={psychoMetrics}
                      setPsychoMetrics={(v) => { setPsychoMetrics(v); isPreferencesDirty.current = true; }}
                      weeklyFocusList={weeklyFocusList}
                      setWeeklyFocusList={(v) => { setWeeklyFocusList(v); isWeeklyFocusDirty.current = true; }}
                      systemSettings={systemSettings}
                      setSystemSettings={(v: SystemSettings) => { setSystemSettings(v); isPreferencesDirty.current = true; }}
                      standardGoals={standardGoals}
                      setStandardGoals={(v) => { setStandardGoals(v); isPreferencesDirty.current = true; }}
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
                      onUpdateConstitution={(v) => { setConstitutionRules(v); isPreferencesDirty.current = true; }}
                      careerRoadmap={careerRoadmap}
                      onUpdateRoadmap={(v) => { setCareerRoadmap(v); isPreferencesDirty.current = true; }}
                      dailyReviews={dailyReviews}
                      weeklyFocusList={weeklyFocusList}
                      activeTab={businessActiveTab}
                      onTabChange={setBusinessActiveTab}
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

      {/* Trade detail otevřený z AI Chatu */}
      {aiChatTrade && (
        <TradeDetailModal
          trade={aiChatTrade}
          accountName={accounts.find(a => String(a.id) === String(aiChatTrade.accountId))?.name ?? accounts[0]?.name ?? ''}
          theme={theme as 'dark' | 'light' | 'oled'}
          onClose={() => setAiChatTrade(null)}
          onDelete={() => { handleDeleteTrade(aiChatTrade.id); setAiChatTrade(null); }}
          emotions={userEmotions}
          onUpdateTrade={(updates) => handleUpdateTrade(aiChatTrade.id, updates)}
          pnlDisplayMode={pnlDisplayMode}
          accounts={accounts}
          initialBalance={displayBalance}
          user={currentUser ?? undefined}
          exchangeRates={exchangeRates}
          allTrades={trades}
        />
      )}
    </div >
  );
};

export default App;
