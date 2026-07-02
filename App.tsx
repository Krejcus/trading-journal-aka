
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { normalizeTrades, calculateStats } from './services/analysis';
import { tradeNeedsEnrichment } from './services/tradovateImport';
import { storageService, getUserId } from './services/storageService';
import { safeSetItem } from './utils/safeStorage';
import { Trade, Account, TradeFilters, CustomEmotion, User, DailyPrep, DailyReview, UserPreferences, DashboardWidgetConfig, DashboardLayouts, SessionConfig, IronRule, BusinessExpense, BusinessPayout, PlaybookItem, BusinessGoal, BusinessResource, BusinessSettings, PsychoMetricConfig, DashboardMode, WeeklyFocus, PnLDisplayMode, ConstitutionRule, CareerCheckpoint, SystemSettings } from './types';
const Dashboard = React.lazy(() => import('./components/Dashboard'));
const ManualTradeForm = React.lazy(() => import('./components/ManualTradeForm'));
const TradeHistory = React.lazy(() => import('./components/TradeHistory'));
const Settings = React.lazy(() => import('./components/Settings'));
const AccountsManager = React.lazy(() => import('./components/AccountsManager'));
const Graveyard = React.lazy(() => import('./components/Graveyard'));
const DailyStartModal = React.lazy(() => import('./components/DailyStartModal'));
const LossDayDebriefModal = React.lazy(() => import('./components/LossDayDebriefModal'));
import WorldShiftOverlay, { WORLD_SHIFT_TIMING } from './components/WorldShiftOverlay';
const DailyJournal = React.lazy(() => import('./components/DailyJournal'));
const BacktestSessionsView = React.lazy(() => import('./components/BacktestSessionsView'));
const BacktestSessionsManager = React.lazy(() => import('./components/BacktestSessionsManager'));
const UserProfileModal = React.lazy(() => import('./components/UserProfileModal'));
const NetworkHub = React.lazy(() => import('./components/NetworkHub'));
const BusinessHub = React.lazy(() => import('./components/BusinessHub'));
const FileUpload = React.lazy(() => import('./components/FileUpload'));
const AICoachPage = React.lazy(() => import('./components/AICoachPage'));
const InsightsPanel = React.lazy(() => import('./components/InsightsPanel'));
const TradovateImportModal = React.lazy(() => import('./components/TradovateImportModal'));
const TradesyncerImportModal = React.lazy(() => import('./components/TradesyncerImportModal'));


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
  Shield,
  Sparkles
} from 'lucide-react';

import { supabase } from './services/supabase';
import type { Session } from '@supabase/supabase-js';
import MorningBriefBanner from './components/MorningBriefBanner';

const APP_VERSION = "1.5.2 [MATRIX-UPDATE]";

// Liquid-glass displacement mapa — strukturovaný "bevel" (ne náhodný šum jako feTurbulence).
// R kanál = horizontální offset, G = vertikální. Střed = 128/128 (neutrální, žádné zkreslení),
// hladký lineární ramp jen na okrajích → ROVNÝ lom u hrany, žádné zvlnění.
// Dvě crossed gradient vrstvy blendnuté přes mix-blend-mode:screen (R z horizontální, G z vertikální).
// SYMETRICKÝ (čistá lupa): stejný jemný ramp na všech 4 hranách (H i V: 64→128→128→192),
// takže obsah za headerem se u hran ohne jako přes čočku — žádný asymetrický fold/zrcadlení.
const GLASS_DISPLACEMENT_MAP = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='600' height='120'>` +
  `<defs>` +
  `<linearGradient id='h' x1='0' y1='0' x2='1' y2='0'>` +
  `<stop offset='0' stop-color='rgb(64,0,0)'/>` +
  `<stop offset='0.16' stop-color='rgb(128,0,0)'/>` +
  `<stop offset='0.84' stop-color='rgb(128,0,0)'/>` +
  `<stop offset='1' stop-color='rgb(192,0,0)'/>` +
  `</linearGradient>` +
  `<linearGradient id='v' x1='0' y1='0' x2='0' y2='1'>` +
  `<stop offset='0' stop-color='rgb(0,64,0)'/>` +
  `<stop offset='0.16' stop-color='rgb(0,128,0)'/>` +
  `<stop offset='0.84' stop-color='rgb(0,128,0)'/>` +
  `<stop offset='1' stop-color='rgb(0,192,0)'/>` +
  `</linearGradient>` +
  `</defs>` +
  `<rect width='600' height='120' fill='url(#h)'/>` +
  `<rect width='600' height='120' fill='url(#v)' style='mix-blend-mode:screen'/>` +
  `</svg>`
);

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

// Widget min/max constraints for react-grid-layout (lg = 12 cols)
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
  calendar: { minW: 4, minH: 5, maxW: 12, maxH: 10 },
  daily_insight: { minW: 2, minH: 2, maxW: 6, maxH: 4 },
  bt_avg_r: { minW: 2, minH: 2, maxW: 6, maxH: 4 },
  bt_confluence_wr: { minW: 4, minH: 3, maxW: 12, maxH: 8 },
  bt_sample_size: { minW: 2, minH: 2, maxW: 12, maxH: 6 },
  bt_monte_carlo: { minW: 4, minH: 3, maxW: 12, maxH: 8 },
};

// Widget constraints for xxl breakpoint (24 cols) — doubled widths
const WIDGET_CONSTRAINTS_XXL: Record<string, { minW: number; minH: number; maxW: number; maxH: number }> = {
  avg_win_loss: { minW: 2, minH: 2, maxW: 8, maxH: 4 },
  streak: { minW: 3, minH: 2, maxW: 12, maxH: 4 },
  discipline_streak: { minW: 2, minH: 2, maxW: 8, maxH: 4 },
  challenge_target: { minW: 2, minH: 2, maxW: 12, maxH: 4 },
  kpi_pnl: { minW: 2, minH: 2, maxW: 8, maxH: 4 },
  kpi_winrate: { minW: 2, minH: 2, maxW: 8, maxH: 4 },
  kpi_execution_rate: { minW: 2, minH: 2, maxW: 8, maxH: 4 },
  kpi_profit_factor: { minW: 2, minH: 2, maxW: 8, maxH: 4 },
  kpi_day_winrate: { minW: 2, minH: 2, maxW: 8, maxH: 4 },
  kpi_max_drawdown: { minW: 2, minH: 2, maxW: 8, maxH: 4 },
  discipline: { minW: 8, minH: 3, maxW: 24, maxH: 8 },
  winners_losers: { minW: 6, minH: 3, maxW: 24, maxH: 8 },
  monthly_performance: { minW: 6, minH: 3, maxW: 24, maxH: 8 },
  equity: { minW: 6, minH: 3, maxW: 24, maxH: 8 },
  session_performance: { minW: 6, minH: 3, maxW: 24, maxH: 8 },
  hourly_edge: { minW: 6, minH: 3, maxW: 24, maxH: 8 },
  daily_edge: { minW: 6, minH: 3, maxW: 24, maxH: 8 },
  calendar: { minW: 6, minH: 5, maxW: 24, maxH: 10 },
  daily_insight: { minW: 3, minH: 2, maxW: 8, maxH: 4 },
  bt_avg_r: { minW: 2, minH: 2, maxW: 8, maxH: 4 },
  bt_confluence_wr: { minW: 6, minH: 3, maxW: 24, maxH: 8 },
  bt_sample_size: { minW: 3, minH: 2, maxW: 24, maxH: 6 },
  bt_monte_carlo: { minW: 6, minH: 3, maxW: 24, maxH: 8 },
};

/** Generate a 24-column xxl layout from a 12-column lg layout by scaling positions & widths ×2 */
function generateXxlFromLg(lgLayout: DashboardWidgetConfig[]): DashboardWidgetConfig[] {
  return lgLayout.map(widget => {
    const c = WIDGET_CONSTRAINTS_XXL[widget.id] || { minW: 4, minH: 2, maxW: 24, maxH: 8 };
    return {
      ...widget,
      x: widget.x * 2,
      w: Math.min(widget.w * 2, 24),
      ...c,
    };
  });
}

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

// Default layout for lg (12 cols, notebook)
const DEFAULT_WIDGETS_LG: DashboardWidgetConfig[] = [
  { id: 'kpi_pnl', label: 'Net P&L', visible: true, x: 0, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { id: 'kpi_winrate', label: 'Win Rate', visible: true, x: 2, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { id: 'kpi_profit_factor', label: 'Profit Factor', visible: true, x: 4, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { id: 'discipline', label: 'Disciplína', visible: true, x: 0, y: 2, w: 12, h: 4, minW: 4, minH: 3, maxW: 12, maxH: 8 },
  { id: 'equity', label: 'Equity Curve', visible: true, x: 0, y: 6, w: 6, h: 4, minW: 4, minH: 3, maxW: 12, maxH: 8 },
  { id: 'calendar', label: 'Kalendář', visible: true, x: 6, y: 6, w: 6, h: 6, minW: 4, minH: 5, maxW: 12, maxH: 10 },
  { id: 'bt_monte_carlo', label: 'Monte Carlo', visible: true, x: 0, y: 10, w: 6, h: 5, minW: 4, minH: 4, maxW: 12, maxH: 8 },
];

// Default layout for xxl (24 cols, ultrawide) — more widgets side-by-side
const DEFAULT_WIDGETS_XXL: DashboardWidgetConfig[] = generateXxlFromLg(DEFAULT_WIDGETS_LG);

const DEFAULT_LAYOUTS: DashboardLayouts = {
  lg: DEFAULT_WIDGETS_LG,
  xxl: DEFAULT_WIDGETS_XXL,
};

// Výchozí layout pro backtest svět — vlastní sada widgetů (subset live + backtest specifické).
const DEFAULT_BACKTEST_WIDGETS_LG: DashboardWidgetConfig[] = [
  { id: 'kpi_pnl', label: 'Net P&L', visible: true, x: 0, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { id: 'kpi_winrate', label: 'Win Rate', visible: true, x: 2, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { id: 'kpi_profit_factor', label: 'Profit Factor', visible: true, x: 4, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { id: 'bt_avg_r', label: 'Avg R', visible: true, x: 6, y: 0, w: 2, h: 2, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  { id: 'equity', label: 'Equity Curve', visible: true, x: 0, y: 2, w: 6, h: 4, minW: 4, minH: 3, maxW: 12, maxH: 8 },
  { id: 'bt_monte_carlo', label: 'Monte Carlo', visible: true, x: 6, y: 2, w: 6, h: 5, minW: 4, minH: 4, maxW: 12, maxH: 8 },
  { id: 'bt_confluence_wr', label: 'WR dle confluencí', visible: true, x: 0, y: 6, w: 6, h: 4, minW: 4, minH: 3, maxW: 12, maxH: 8 },
  { id: 'session_performance', label: 'Výkon Sessions', visible: true, x: 6, y: 6, w: 6, h: 4, minW: 4, minH: 3, maxW: 12, maxH: 8 },
  { id: 'bt_sample_size', label: 'Sample-size', visible: true, x: 0, y: 10, w: 6, h: 3, minW: 2, minH: 2, maxW: 12, maxH: 6 },
  { id: 'calendar', label: 'Kalendář', visible: true, x: 6, y: 10, w: 6, h: 6, minW: 4, minH: 5, maxW: 12, maxH: 10 },
];

const DEFAULT_BACKTEST_LAYOUTS: DashboardLayouts = {
  lg: DEFAULT_BACKTEST_WIDGETS_LG,
  xxl: generateXxlFromLg(DEFAULT_BACKTEST_WIDGETS_LG),
};

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

// Jediná definice hranice mezi live a backtest světem. Když přibude další
// backtest-like typ účtu (např. 'Replay'), upraví se jen tady.
const isBacktestAccount = (a?: { type?: string } | null): boolean => a?.type === 'Backtest';

// Sanitizuje uložený per-breakpoint layout (new format): zahodí neznámé widgety,
// dosadí aktuální constraints a doplní chybějící lg/xxl breakpoint z defaultu.
// Sdílené live i backtest layoutem — jediný zdroj pravdy pro sanitizaci.
const sanitizeLayouts = (raw: Record<string, DashboardWidgetConfig[]>, defaultLg: DashboardWidgetConfig[]): DashboardLayouts => {
  const result: DashboardLayouts = {};
  for (const [bp, bpLayout] of Object.entries(raw)) {
    if (!Array.isArray(bpLayout) || bpLayout.length === 0) continue;
    const constraints = bp === 'xxl' ? WIDGET_CONSTRAINTS_XXL : WIDGET_CONSTRAINTS;
    result[bp] = bpLayout
      .filter(w => w.id in WIDGET_CONSTRAINTS) // lg constraints = kanonický seznam widgetů
      .map(w => ({ ...w, ...(constraints[w.id] || (bp === 'xxl' ? { minW: 4, minH: 2, maxW: 24, maxH: 8 } : { minW: 2, minH: 2, maxW: 12, maxH: 8 })) }));
  }
  if (!result.lg || result.lg.length === 0) result.lg = defaultLg;
  if (!result.xxl || result.xxl.length === 0) result.xxl = generateXxlFromLg(result.lg);
  return result;
};

// --- Per-mód layouty (funded/challenge/combined zvlášť; archive sdílí combined) ---
const EMPTY_LAYOUTS: DashboardLayouts = {};
const liveLayoutKey = (m: DashboardMode): string =>
  (m === 'funded' || m === 'challenge' || m === 'combined') ? m : 'combined';

// Vertikální komprese jednoho breakpointu — po odebrání widgetu vyplní mezeru (posune nahoru).
const compactLayoutItems = (items: DashboardWidgetConfig[]): DashboardWidgetConfig[] => {
  const sorted = [...items].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const placed: DashboardWidgetConfig[] = [];
  for (const it of sorted) {
    const collides = (yy: number) => placed.some(p =>
      it.x < (p.x + p.w) && (it.x + it.w) > p.x && yy < (p.y + p.h) && (yy + it.h) > p.y);
    let y = 0;
    while (collides(y)) y++;
    placed.push({ ...it, y });
  }
  return placed;
};

// Odebere widget ze všech breakpointů a zavře mezeru (kompresí).
const stripWidgetAndCompact = (layouts: DashboardLayouts, id: string): DashboardLayouts => {
  const out: DashboardLayouts = {};
  for (const [bp, arr] of Object.entries(layouts)) {
    out[bp] = compactLayoutItems((arr || []).filter(w => w.id !== id));
  }
  return out;
};

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
        isSyncedWithDbRef.current = false;

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
  // AI streaming state — když je true a user chce odejít z AI stránky, zobrazí
  // se warning modal (přepnutí by ztratilo streamovanou odpověď).
  const [isAIStreaming, setIsAIStreaming] = useState(false);
  // Daily Start Ritual — modal pro ranní brief (auto-trigger 6-12 PRG pokud nemá prep, nebo manuálně).
  const [dailyStartOpen, setDailyStartOpen] = useState(false);
  // Loss Day Debrief — modal po překročení daily limitu (auto-trigger po setTrades).
  const [lossDayDebriefOpen, setLossDayDebriefOpen] = useState(false);
  const [lossDayTargetDate, setLossDayTargetDate] = useState<string | undefined>(undefined);
  // Pending navigace která čeká na potvrzení v modalu.
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
  const [journalTargetDate, setJournalTargetDate] = useState<string | undefined>(undefined);
  const isPreferencesDirty = useRef(false);
  const isApplyingPrefsRef = useRef(false);
  const isSyncedWithDbRef = useRef(false);
  const markPreferencesDirty = () => {
    if (isSyncedWithDbRef.current) {
      isPreferencesDirty.current = true;
    } else {
      console.log('[Preferences] markPreferencesDirty BLOCKED — not synced with DB yet');
    }
  };
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
  // Tradovate import modal
  const [tradovateImportOpen, setTradovateImportOpen] = useState(false);
  const [tradesyncerImportOpen, setTradesyncerImportOpen] = useState(false);
  // Toast „nový obchod přidán" — spustí se z Realtime INSERTu (obchod z AlphaBridge dorazil do appky).
  const [tradeToast, setTradeToast] = useState<{ id: number; instrument: string; pnl: number; accountId: string } | null>(null);
  useEffect(() => {
    if (!tradeToast) return;
    const t = setTimeout(() => setTradeToast(cur => (cur && cur.id === tradeToast.id ? null : cur)), 4500);
    return () => clearTimeout(t);
  }, [tradeToast]);
  const [tradovateImportAccount, setTradovateImportAccount] = useState<string | undefined>(undefined);
  // Průvodce doplněním importovaných obchodů — inkrement spustí wizard v TradeHistory.
  const [enrichSignal, setEnrichSignal] = useState(0);
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
  // Init `{}` ne DEFAULT_LAYOUTS — zabraní flashe defaultních widgetů před DB loadem.
  // applyPreferences pak nastaví buď DB layout nebo DEFAULT_LAYOUTS (pro nového usera).
  // Layout zvlášť pro každý live mód (funded/challenge/combined). Init `{}` ne default — viz pozn. níže.
  const [liveLayoutsByMode, setLiveLayoutsByMode] = useState<Record<string, DashboardLayouts>>({});
  const [backtestDashboardLayouts, setBacktestDashboardLayouts] = useState<DashboardLayouts>(DEFAULT_BACKTEST_LAYOUTS);
  const [dashboardMode, setDashboardMode] = useState<DashboardMode>(() => {
    // Try to load from local storage first for immediate persistence
    const saved = localStorage.getItem('alphatrade_dash_mode');
    return (saved as DashboardMode) || 'combined';
  });

  useEffect(() => {
    safeSetItem('alphatrade_dash_mode', dashboardMode);
  }, [dashboardMode]);

  // Aktivní live layout dle módu (funded/challenge/combined zvlášť). Prázdný `{}` dokud
  // applyPreferences nenastaví — brání flashe defaultních widgetů před DB loadem.
  const dashboardLayouts: DashboardLayouts = liveLayoutsByMode[liveLayoutKey(dashboardMode)] || liveLayoutsByMode['combined'] || EMPTY_LAYOUTS;

  // Backtest „svět" — vstup/výstup přes sidebar. Pamatuje si poslední live mód pro návrat.
  const prevLiveModeRef = useRef<DashboardMode>('combined');
  // Cinematic přechod mezi live/backtest světem.
  const [worldShift, setWorldShift] = useState<{ active: boolean; to: 'live' | 'backtest' }>({ active: false, to: 'live' });
  const worldShiftTimers = useRef<number[]>([]);
  const toggleBacktestMode = useCallback(() => {
    setDashFocusAccount(null);
    const goingToBacktest = dashboardMode !== 'backtesting';
    const nextMode: DashboardMode = goingToBacktest ? 'backtesting' : (prevLiveModeRef.current || 'combined');
    if (goingToBacktest) prevLiveModeRef.current = dashboardMode;

    const applySwap = () => { setDashboardMode(nextMode); markPreferencesDirty(); };

    // Respektuj prefers-reduced-motion — přepni okamžitě bez animace.
    const reduced = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { applySwap(); return; }

    worldShiftTimers.current.forEach(clearTimeout);
    worldShiftTimers.current = [];
    setWorldShift({ active: true, to: goingToBacktest ? 'backtest' : 'live' });
    // Swap obsahu přesně když clona plně zakrývá → výměna je neviditelná.
    worldShiftTimers.current.push(window.setTimeout(applySwap, WORLD_SHIFT_TIMING.swapAt));
    worldShiftTimers.current.push(window.setTimeout(
      () => setWorldShift(prev => ({ ...prev, active: false })),
      WORLD_SHIFT_TIMING.end,
    ));
  }, [dashboardMode]);
  useEffect(() => () => { worldShiftTimers.current.forEach(clearTimeout); }, []);
  const [sessions, setSessions] = useState<SessionConfig[]>(DEFAULT_SESSIONS);
  // Samostatná sada sessionů pro backtest svět. Prázdné = použij živé `sessions` (fallback).
  const [backtestSessions, setBacktestSessions] = useState<SessionConfig[]>([]);
  // Sady se přepínají automaticky podle světa (live vs backtest). Backtest s prázdnou sadou
  // spadne zpět na live sessiony → žádná migrace, nic se nerozbije.
  const activeSessions = useMemo(
    () => (dashboardMode === 'backtesting' && backtestSessions.length > 0) ? backtestSessions : sessions,
    [dashboardMode, backtestSessions, sessions]
  );
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
    dashboardLayouts, // ponecháno (aktivní mód) kvůli zpětné kompatibilitě / rollbacku
    liveLayoutsByMode,
    backtestDashboardLayouts,
    sessions,
    backtestSessions,
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

  /**
   * Wrapper kolem setActivePage — když je AI Coach v aktivním streamu a user
   * chce odejít, zachytí to a zobrazí warning modal. User pak rozhodne.
   */
  const navigateTo = useCallback((page: string) => {
    if (isAIStreaming && activePage === 'ai' && page !== 'ai') {
      setPendingNav(() => () => setActivePage(page));
      return;
    }
    setActivePage(page);
  }, [isAIStreaming, activePage]);

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
    // POZOR: clientX === 0 (dotek na úplném levém okraji = přesně tam, kde začíná
    // gesto pro otevření sidebaru) je falsy → původní `!touchStart.current` takový
    // swipe zahodil. Kontrolujeme proto explicitně na null.
    if (touchStart.current === null || touchEnd.current === null) return;
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
        if (pendingReviewSave.current?.date === rev.date) {
          const pending = pendingReviewSave.current;
          pendingReviewSave.current = null;
          handleSaveReview(pending).catch(() => {});
        }
      });
  }, [saveWithRetry]);

  const applyPreferences = useCallback((prefs: Partial<UserPreferences>) => {
    isApplyingPrefsRef.current = true;
    
    // DIAGNOSTIC: track what fields are present in incoming prefs
    console.log('[applyPreferences] called with dirty=', isPreferencesDirty.current, 'fields:', {
      sessions: prefs.sessions?.length,
      htfOptions: prefs.htfOptions?.length,
      ltfOptions: prefs.ltfOptions?.length,
      ironRules: prefs.ironRules?.length,
      dashboardLayouts: prefs.dashboardLayouts ? Object.keys(prefs.dashboardLayouts) : prefs.dashboardLayout?.length,
      systemSettings: !!prefs.systemSettings,
    });
    if (isPreferencesDirty.current) {
      console.log('[applyPreferences] SKIPPED — dirty=true');
      // I když přeskočíme apply (uživatel má rozdělanou změnu), aspoň označíme že
      // preference už dorazily z DB/cache — autosave se může spustit a nepřepíše DB
      // defaulty z useState (které by jinak vznikly při saves PŘED prvním applyPreferences).
      prefsAppliedRef.current = true;
      isApplyingPrefsRef.current = false;
      return;
    }

    // PRO NOVÉ USERY: Pokud pole v databázi vůbec neexistuje (nový user), necháme defaulty.
    // Pokud je pole definované jako prázdné pole [], respektujeme volbu uživatele (nesmíme ji přebít defaulty).
    if (Array.isArray(prefs.emotions)) setUserEmotions(prefs.emotions);
    if (Array.isArray(prefs.standardMistakes)) setUserMistakes(prefs.standardMistakes);
    if (Array.isArray(prefs.standardGoals)) setStandardGoals(prefs.standardGoals);
    // --- Dashboard Layouts: per-mód (funded/challenge/combined zvlášť) ---
    const lbm = (prefs as any).liveLayoutsByMode;
    if (lbm && typeof lbm === 'object' && !Array.isArray(lbm) && Object.keys(lbm).length > 0) {
      // New format: layout zvlášť per mód
      const byMode: Record<string, DashboardLayouts> = {};
      for (const [mode, lays] of Object.entries(lbm)) {
        if (lays && typeof lays === 'object') byMode[mode] = sanitizeLayouts(lays as any, DEFAULT_WIDGETS_LG);
      }
      setLiveLayoutsByMode(byMode);
    } else {
      // Migrace ze sdíleného layoutu → seed všech módů. Funded bez „Challenge Cíle" (+ komprese mezery).
      let migrated: DashboardLayouts;
      if (prefs.dashboardLayouts && typeof prefs.dashboardLayouts === 'object' && !Array.isArray(prefs.dashboardLayouts)) {
        migrated = sanitizeLayouts(prefs.dashboardLayouts as any, DEFAULT_WIDGETS_LG);
      } else if (Array.isArray(prefs.dashboardLayout) && prefs.dashboardLayout.length > 0) {
        // Legacy format: flat array (12-col) — migrate to per-breakpoint
        const dl = prefs.dashboardLayout!;
        const validDl = dl.filter(w => w.id in WIDGET_CONSTRAINTS);
        const isOld = validDl.length > 0 && (validDl[0] as any).x === undefined && (validDl[0] as any).size !== undefined;
        let lgLayout: DashboardWidgetConfig[];
        if (isOld) {
          lgLayout = migrateOldLayout(validDl);
        } else {
          const needsHeightMigration = validDl.length > 0 && validDl.every(w => (w.h || 0) <= 4);
          lgLayout = validDl.map(w => {
            const c = WIDGET_CONSTRAINTS[w.id] || { minW: 2, minH: 2, maxW: 12, maxH: 8 };
            return needsHeightMigration ? { ...w, h: (w.h || 2) * 2, ...c } : { ...w, ...c };
          });
        }
        migrated = { lg: lgLayout, xxl: generateXxlFromLg(lgLayout) };
      } else if (prefs.dashboardLayout) {
        migrated = { lg: [], xxl: [] };
      } else {
        migrated = DEFAULT_LAYOUTS;
      }
      setLiveLayoutsByMode({
        funded: stripWidgetAndCompact(migrated, 'challenge_target'),
        challenge: migrated,
        combined: migrated,
      });
    }

    // --- Backtest Dashboard Layout (separátní svět) ---
    const btRaw = (prefs as any).backtestDashboardLayouts;
    if (btRaw && typeof btRaw === 'object' && !Array.isArray(btRaw)) {
      setBacktestDashboardLayouts(sanitizeLayouts(btRaw, DEFAULT_BACKTEST_WIDGETS_LG));
    } else {
      setBacktestDashboardLayouts(DEFAULT_BACKTEST_LAYOUTS);
    }

    const migrateSessions = (arr: any[]) => arr.map(s => ({
      ...s,
      startTime: s.startTime || `${String(s.startHour ?? 9).padStart(2, '0')}:00`,
      endTime: s.endTime || `${String(s.endHour ?? 17).padStart(2, '0')}:00`,
      color: s.color || '#3b82f6'
    }));
    if (Array.isArray(prefs.sessions)) setSessions(migrateSessions(prefs.sessions as any[]));
    if (Array.isArray(prefs.backtestSessions)) setBacktestSessions(migrateSessions(prefs.backtestSessions as any[]));
    if (Array.isArray(prefs.htfOptions)) setHtfOptions(prefs.htfOptions);
    if (Array.isArray(prefs.ltfOptions)) setLtfOptions(prefs.ltfOptions);
    if (Array.isArray(prefs.ironRules)) setIronRules(prefs.ironRules);
    // Business Hub data (expenses, payouts, goals, resources) now use dedicated Supabase tables
    // DO NOT apply from preferences - prevents stale data overwriting fresh table data
    if (Array.isArray(prefs.playbookItems)) setPlaybookItems(prefs.playbookItems);
    if (Array.isArray(prefs.constitutionRules)) setConstitutionRules(prefs.constitutionRules);
    if (Array.isArray(prefs.careerRoadmap)) setCareerRoadmap(prefs.careerRoadmap);
    if (prefs.businessSettings) setBusinessSettings(prefs.businessSettings || { taxRatePct: 15, defaultPropThreshold: 150 });
    if (Array.isArray(prefs.psychoMetricsConfig)) setPsychoMetrics(prefs.psychoMetricsConfig);
    // Theme is NOT applied here — it has its own persistence via localStorage
    // to prevent cross-tab sync or focus sync from reverting user's theme choice.
    // Theme is applied only on initial load (useState initializer).
    if (prefs.dashboardMode) setDashboardMode(prefs.dashboardMode);
    if (prefs.systemSettings) setSystemSettings(prefs.systemSettings);
    if ((prefs as any).networkNotifications) setNetworkNotifications((prefs as any).networkNotifications);
    // Mark prefs as applied — autosave se teď může spustit, nehrozí přepsání DB
    // defaulty z useState (HTF/LTF, sessions, emotions, …).
    prefsAppliedRef.current = true;
    
    // Zámek uvolníme až po dokončení re-renderů a inicializace v Reactu (zabraňuje samovolnému znečištění refs)
    setTimeout(() => {
      isApplyingPrefsRef.current = false;
    }, 1500);
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

      // Načteme preferences z IndexedDB cache ihned při startu (i když jsou starší než 24h),
      // abychom zabránili probliknutí výchozího nastavení. DB reload na pozadí je tiše přepíše, pokud se liší.
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
        // User profile NEČTEME z cache — vždy z DB.
        if (cached.preferences) {
          applyPreferences(cached.preferences);
        }
        setDailyPreps(cached.preps || []);
        setDailyReviews(cached.reviews || []);
        setWeeklyFocusList(cached.weeklyFocus || []);
        setSyncError(null);
        setLoading(false);
        setIsInitialLoadDone(true);
        isFetchingRef.current = false;
        clearTimeout(safetyTimer);

        // AI CONVERSATIONS prefetch na pozadí — když user klikne na AI tab, cache je hotová.
        // Screenshoty se NEprefetchují při STARTU appky (dřív: full-table query + stažení VŠECH
        // obrázků ~desítky MB na každé otevření) — načte si je až TradeHistory při mountu.
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
              dashboardLayouts: fresh.preferences.dashboardLayouts ? Object.keys(fresh.preferences.dashboardLayouts) : fresh.preferences.dashboardLayout?.length,
            });
            if (!isPreferencesDirty.current) applyPreferences(fresh.preferences);
          } else {
            console.log('[BG-Refresh] received null/empty fresh prefs, dirty=', isPreferencesDirty.current);
            if (!isPreferencesDirty.current) applyPreferences({});
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
          isSyncedWithDbRef.current = true; // Mark as synced
        }).catch(err => {
          console.warn('[Load] Background refresh failed:', err);
          isSyncedWithDbRef.current = true; // Fallback
        });
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


        // OCHRANA: nepřepisuj prázdným polem pokud RPC selhal a fb fallback vrátil [].
        // Bez tohoto cache z předchozí session zmizí při dočasné chybě sítě.
        setTrades(prev => (dbTrades && dbTrades.length > 0) ? dbTrades : (prev.length > 0 ? prev : []));

        if (dbAccounts && dbAccounts.length > 0) {
          setAccounts(dbAccounts);
          const activeId = storageService.getActiveAccountId();
          setActiveAccountId(activeId || dbAccounts[0].id);
        } else if (accounts.length === 0) {
          setAccounts([DEFAULT_ACCOUNT]);
          setActiveAccountId(DEFAULT_ACCOUNT.id);
        }

        if (dbUser) { setCurrentUser(dbUser); setIsUserFromDb(true); }
        if (dbPrefs) {
          applyPreferences(dbPrefs);
        } else {
          applyPreferences({});
        }
        isSyncedWithDbRef.current = true; // Mark as synced
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
        isSyncedWithDbRef.current = true; // Fallback
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
              let isNew = false;
              setTrades(prev => {
                if (prev.some(t => t.id === fullTrade.id)) return prev;
                isNew = true;
                return [fullTrade, ...prev].sort((a, b) => b.timestamp - a.timestamp);
              });
              // Toast jen pro fakt NOVÝ obchod (ne pro to, co appka vložila sama optimisticky).
              if (isNew) setTradeToast({ id: Date.now(), instrument: fullTrade.instrument || '?', pnl: Number(fullTrade.pnl) || 0, accountId: String(fullTrade.accountId || '') });

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

  // --- AUTO-TRIGGER: Daily Start Ritual ---
  // Pokud user nemá prep pro dnešek + je obchodní den + jsme v okně 6-12 PRG, otevři modal.
  // Jen jednou per session — pak už respektuj user volbu.
  const dailyStartCheckedRef = useRef(false);
  useEffect(() => {
    if (!isInitialLoadDone || dailyStartCheckedRef.current) return;
    // V backtest světě ranní přípravu nespouštíme (je to live trading rituál).
    // Ref nenastavujeme → když user přepne zpět na live, check proběhne normálně.
    if (dashboardMode === 'backtesting') return;
    const now = new Date();
    const hourPrg = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Prague', hour: 'numeric', hour12: false }).format(now));
    const wkdayShort = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Prague', weekday: 'short' }).format(now);
    const isWeekend = wkdayShort === 'Sat' || wkdayShort === 'Sun';
    const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(now);
    const hasPrepToday = dailyPreps.some(p => p.date === todayIso && (p.scenarios?.bullish || p.scenarios?.bearish || p.mindsetState || p.ritualCompletions?.some(rc => rc.status === 'Pass')));
    if (!isWeekend && hourPrg >= 6 && hourPrg < 12 && !hasPrepToday) {
      // Slight delay aby loading flicker neblokoval první view
      const t = setTimeout(() => setDailyStartOpen(true), 1500);
      dailyStartCheckedRef.current = true;
      return () => clearTimeout(t);
    }
    // Stále označ že jsme check udělali, ať se to neopakuje napříč rerendery
    dailyStartCheckedRef.current = true;
  }, [isInitialLoadDone, dailyPreps, dashboardMode]);

  // --- AUTO-TRIGGER: Loss Day Debrief ---
  // Po každém setTrades (import / save) zkontroluj dnešní P&L. Pokud < -dailyLimit
  // a ještě dnes nebyl debrief (review s autoDebrief flagem), otevři modal.
  const lossDayDebriefShownRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isInitialLoadDone) return;
    const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());
    if (lossDayDebriefShownRef.current === todayIso) return;
    // Spočítej dnešní P&L
    const todayPnl = trades
      .filter(t => String(t.date || '').slice(0, 10) === todayIso && t.executionStatus !== 'Missed')
      .reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    // Default daily limit (250) — TODO: tahat z user prefs
    const dailyLimit = 250;
    if (todayPnl < -dailyLimit) {
      // Zkontroluj jestli už dnes byl auto-debrief uložen
      const todayReview = dailyReviews.find(r => r.date === todayIso);
      const alreadyDebriefed = (todayReview as any)?.autoDebrief === true;
      if (!alreadyDebriefed) {
        lossDayDebriefShownRef.current = todayIso;
        setLossDayTargetDate(todayIso);
        setLossDayDebriefOpen(true);
      }
    }
  }, [isInitialLoadDone, trades, dailyReviews]);

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
  // Pokud uživatel otevře konkrétní archivovaný účet z karty ("Otevřít v dashboardu"),
  // nascopujeme archiv režim jen na tento účet (jinak by se ukázaly všechny inactive).
  const [dashFocusAccount, setDashFocusAccount] = useState<string | null>(null);

  useEffect(() => {
    // Načti archivované účty, když uživatel: (a) přepne na archive dashboard,
    // (b) otevře stránku Účty (kvůli zobrazení Hřbitova spálených účtů).
    // History/Deník/AI také potřebují, aby se v UI místo "Neznámý účet" objevil
    // název archivovaného (spáleného) účtu pro jeho staré obchody.
    // Combined ("Vše") na dashboardu chce zahrnout i archivované obchody → musíme načíst.
    const needsArchived = (dashboardMode === 'archive' || dashboardMode === 'combined' || activePage === 'accounts' || activePage === 'history' || activePage === 'journal' || activePage === 'ai');
    if (needsArchived && session && !isArchivedLoaded) {
      storageService.getArchivedAccounts().then(archived => {
        setArchivedAccounts(archived || []);
        setIsArchivedLoaded(true);
      }).catch(err => console.error("[LazyLoad] Failed to load archived accounts:", err));
    }
  }, [dashboardMode, activePage, session, isArchivedLoaded]);

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
              dashboardLayouts: freshPrefs.dashboardLayouts ? Object.keys(freshPrefs.dashboardLayouts) : freshPrefs.dashboardLayout?.length,
            });
            applyPreferences(freshPrefs);
          } else {
            console.log('[FocusSync] applying empty fresh prefs from DB');
            applyPreferences({});
          }
          isSyncedWithDbRef.current = true;
        } else {
          console.log('[FocusSync] SKIPPED prefs fetch — dirty=true (uživatel má rozdělanou změnu)');
        }

        const freshAccounts = await storageService.getAccounts();
        if (freshAccounts?.length) setAccounts(freshAccounts);

        // Trades taky — záloha, kdyby Realtime websocket spadl/se nepřipojil; po návratu na tab dožene.
        const freshTrades = await storageService.getTrades();
        if (freshTrades?.length) setTrades(freshTrades);

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
          dashboardLayouts: prefs.dashboardLayouts ? Object.keys(prefs.dashboardLayouts) : 0,
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
  }, [userEmotions, userMistakes, standardGoals, liveLayoutsByMode, backtestDashboardLayouts, sessions, htfOptions, ltfOptions, ironRules, playbookItems, constitutionRules, careerRoadmap, businessSettings, psychoMetrics, theme, dashboardMode, systemSettings, networkNotifications, canSave]);

  // ⚡ PERIODIC AUTO-SAVE (Google Docs-like protection)
  // Backup save every 30s if user is still editing
  // This protects against browser crashes or quick tab closures
  //
  // Aktuální data v refu, aby interval NEMUSEL být v deps na ~21 stavech. Dřív se při každé
  // změně (i každém keystroke v deníku → dailyPreps/Reviews) interval clearnul a založil nový,
  // takže se 30s tik během aktivního psaní prakticky nikdy nestihl. Ref se aktualizuje každý
  // render, takže interval vždy přečte čerstvé hodnoty když po 30s fírne.
  const periodicSaveRef = useRef<any>(null);
  periodicSaveRef.current = { currentUserPreferences, dailyPreps, dailyReviews, weeklyFocusList };
  useEffect(() => {
    if (!canSave) return;

    const interval = setInterval(() => {
      const { currentUserPreferences, dailyPreps, dailyReviews, weeklyFocusList } = periodicSaveRef.current;
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
            ? Promise.all(weeklyFocusList.map((wf: any) => storageService.saveWeeklyFocus(wf)))
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
  }, [canSave]);

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
  }, [canSave, dailyPreps, dailyReviews, userEmotions, userMistakes, standardGoals, liveLayoutsByMode, backtestDashboardLayouts, sessions, htfOptions, ltfOptions, ironRules, playbookItems, constitutionRules, careerRoadmap, businessSettings, psychoMetrics, theme, dashboardMode, systemSettings, networkNotifications]);

  // Handle Dashboard Mode Switching
  // Sleduj POUZE skutečnou změnu módu — bez tohoto se efekt spouští při každé změně
  // accounts/archivedAccounts (např. realtime sync, lazy load) a PŘEPÍŠE uživatelův
  // ručně toggle v dropdownu zpět na "všechny vybrané".
  const lastAppliedModeRef = useRef<string | null>(null);
  // Pamatuje si, jestli jsme pro combined mode už jednou domergeli i lazy-loaded archived účty.
  // Po té už se filters.accounts nikdy nepřepisuje — patří uživateli.
  const combinedArchivedMergedRef = useRef(false);
  useEffect(() => {
    // Only auto-update filters if we are on dashboard to avoid disrupting other views,
    // though "activePage" dependency might be enough.
    if (activePage === 'dashboard' || isInitialLoadDone) {
      const modeChanged = lastAppliedModeRef.current !== dashboardMode;
      // Jen pro combined mode: jednorázový merge archivovaných ID až po jejich lazy loadu.
      const combinedFirstArchivedLoad =
        dashboardMode === 'combined' &&
        !modeChanged &&
        !combinedArchivedMergedRef.current &&
        archivedAccounts.length > 0;
      if (!modeChanged && !combinedFirstArchivedLoad) {
        return; // User klikl v dropdownu — neresetujeme jeho výběr.
      }
      lastAppliedModeRef.current = dashboardMode;
      if (dashboardMode !== 'combined') combinedArchivedMergedRef.current = false;

      if (dashboardMode === 'combined') {
        if (archivedAccounts.length > 0) combinedArchivedMergedRef.current = true;
        // "Vše" — chceme OPRAVDU vše, včetně obchodů ze spálených/archivovaných účtů.
        // Backtest účty ale do live "Vše" NIKDY nepatří (mají vlastní svět).
        const seen = new Set<string>();
        const allIds: string[] = [];
        accounts.forEach(a => { if (!isBacktestAccount(a) && !seen.has(a.id)) { seen.add(a.id); allIds.push(a.id); } });
        archivedAccounts.forEach(a => { if (!isBacktestAccount(a) && !seen.has(a.id)) { seen.add(a.id); allIds.push(a.id); } });
        setFilters(prev => ({ ...prev, accounts: allIds }));
      } else if (dashboardMode === 'funded') {
        // Select Live accounts and Prop accounts that are in Funded phase
        const fundedIds = accounts
          .filter(a => a.status === 'Active' && ((a.type === 'Funded' && a.phase === 'Funded') || a.type === 'Live'))
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
          .filter(a => a.status === 'Active' && a.type === 'Funded' && a.phase === 'Challenge')
          .map(a => a.id);
        setFilters(prev => ({ ...prev, accounts: challengeIds }));
      } else if (dashboardMode === 'backtesting') {
        const backtestIds = accounts
          .filter(a => a.status === 'Active' && isBacktestAccount(a))
          .map(a => a.id);
        setFilters(prev => ({ ...prev, accounts: backtestIds }));
      } else if (dashboardMode === 'archive') {
        // Archiv: deaktivované účty z hlavního pole + lazy isArchived slupky.
        // Pokud je nastaven fokus na konkrétní účet (otevřeno z karty), scopujeme jen na něj.
        if (dashFocusAccount) {
          setFilters(prev => ({ ...prev, accounts: [dashFocusAccount] }));
        } else {
          const inactive = accounts.filter(a => a.status === 'Inactive').map(a => a.id);
          const seen = new Set(inactive);
          const archivedIds = archivedAccounts.filter(a => !seen.has(a.id)).map(a => a.id);
          setFilters(prev => ({ ...prev, accounts: [...inactive, ...archivedIds] }));
        }
      }

      // Persist immediately to local storage to survive refresh
      safeSetItem('alphatrade_dash_mode', dashboardMode);

    }
  }, [dashboardMode, accounts, archivedAccounts, activePage, isInitialLoadDone, dashFocusAccount]);

  const contextAccounts = useMemo(() => {
    // Backtest svět: jen Backtest účty. Live svět: Backtest účty NIKDY (oddělené světy).
    const isBacktestWorld = dashboardMode === 'backtesting';
    const liveFilter = (a: Account) => isBacktestWorld ? isBacktestAccount(a) : !isBacktestAccount(a);
    // Mimo dashboard (History / Deník / AI) zahrň i archivované (spálené) účty,
    // aby filter chips a tooltipy ukazovaly jejich název místo "Neznámý účet".
    if (activePage !== 'dashboard') {
      const seen = new Set(accounts.map(a => a.id));
      return [...accounts, ...archivedAccounts.filter(a => !seen.has(a.id))].filter(liveFilter);
    }
    if (dashboardMode === 'combined') {
      // "Vše" — vrať active i archivované, aby na dashboardu byly všechny obchody
      // (včetně spálených) započítané do stats/widgetů. Backtest účty vyloučeny.
      const seen = new Set(accounts.map(a => a.id));
      return [...accounts, ...archivedAccounts.filter(a => !seen.has(a.id))].filter(a => !isBacktestAccount(a));
    }
    if (dashboardMode === 'funded') return accounts.filter(a => a.status === 'Active' && ((a.type === 'Funded' && a.phase === 'Funded') || a.type === 'Live'));
    if (dashboardMode === 'challenge') return accounts.filter(a => a.status === 'Active' && a.type === 'Funded' && a.phase === 'Challenge');
    if (dashboardMode === 'backtesting') return accounts.filter(a => a.status === 'Active' && isBacktestAccount(a));
    // Archiv: deaktivované účty z hlavního pole (mají obchody). 'isArchived' slupky (Passed/Failed,
    // prázdné) řešíme jinde — Hřbitov. archivedAccounts (lazy) ponecháno jako doplněk pro jistotu.
    if (dashboardMode === 'archive') {
      const inactive = accounts.filter(a => a.status === 'Inactive' && !isBacktestAccount(a));
      const seen = new Set(inactive.map(a => a.id));
      return [...inactive, ...archivedAccounts.filter(a => !isBacktestAccount(a) && !seen.has(a.id))];
    }
    return accounts;
  }, [accounts, archivedAccounts, activePage, dashboardMode]);

  const activeAccount = useMemo(() => accounts.find(a => a.id === activeAccountId) || accounts[0] || DEFAULT_ACCOUNT, [accounts, activeAccountId]);

  // Indexy pro O(1) lookupy v hot memos (dřív O(účty×obchody) lineární skeny per přepočet).
  const tradedAccountIds = useMemo(() => {
    const s = new Set<any>();
    for (const t of trades) s.add(t.accountId);
    return s;
  }, [trades]);
  const childrenByParent = useMemo(() => {
    const m = new Map<any, Account[]>();
    for (const a of accounts) {
      if (!a.parentAccountId) continue;
      const arr = m.get(a.parentAccountId);
      if (arr) arr.push(a); else m.set(a.parentAccountId, [a]);
    }
    return m;
  }, [accounts]);
  // Sloučené aktivní+archivované účty (dedup) + O(1) lookup — dřív se spread s O(A²)
  // `.some()` filtrem stavěl inline ve 3 memos i v JSX props.
  const allAccountsMerged = useMemo(() => {
    const seen = new Set(accounts.map(a => a.id));
    return [...accounts, ...archivedAccounts.filter(a => !seen.has(a.id))];
  }, [accounts, archivedAccounts]);
  const accountsById = useMemo(() => {
    const m = new Map<any, Account>();
    for (const a of allAccountsMerged) m.set(a.id, a);
    return m;
  }, [allAccountsMerged]);

  // Effective active account for the current dashboard context:
  // if the globally-selected activeAccount is NOT in contextAccounts (e.g. you switched to Challenge mode
  // but activeAccountId still points to a Live account), fall back to the first contextAccount.
  const effectiveActiveAccount = useMemo(() => {
    // Scope = účty odpovídající aktuálnímu account-filtru (dashboardMode).
    // Na Historii je contextAccounts = všechny účty, takže scope odvodíme z filters.accounts,
    // jinak by individual mód mohl vybrat účet mimo aktuální mód (challenge/funded/...).
    const scopeIds = filters.accounts.length > 0 ? new Set(filters.accounts) : null;
    const inScope = (a: Account) => !scopeIds || scopeIds.has(a.id);

    // 1. Globálně zvolený aktivní účet, pokud je platný a ve scope
    if (activeAccountId) {
      const a = accounts.find(x => x.id === activeAccountId);
      if (a && inScope(a)) return a;
    }

    // 2. První účet ve scope, který má obchody (vlastní nebo na svých kopiích) — O(1) přes indexy
    const scopeAccounts = accounts.filter(inScope);
    const hasTrades = (a: Account) =>
      tradedAccountIds.has(a.id) ||
      (childrenByParent.get(a.id) || []).some(c => tradedAccountIds.has(c.id));
    const withTrades = scopeAccounts.find(hasTrades);
    if (withTrades) return withTrades;

    // 3. Fallbacky
    return scopeAccounts[0] || contextAccounts[0] || activeAccount;
  }, [contextAccounts, accounts, tradedAccountIds, childrenByParent, filters.accounts, activeAccount, activeAccountId]);

  const displayBalance = useMemo(() => {
    // Balance přes účty které prošly dropdown filtrem. Active i Inactive — když user explicitně
    // přepnul i "spálené" do filtru, jejich initialBalance se taky započítá pro fair % výpočet.
    const selectedIds = new Set(filters.accounts);
    const inFilter = (a: any) => selectedIds.size === 0 ? true : selectedIds.has(a.id);

    if (viewMode === 'individual') {
      // Indiv. mód: pokud má user manuálně zvolené účty, sečti je. Jinak fallback na aktivní účet.
      if (filters.accounts.length > 0) {
        return contextAccounts
          .filter(inFilter)
          .reduce((sum, a) => sum + (a.initialBalance || 0), 0);
      }
      return effectiveActiveAccount.initialBalance || 0;
    }

    // Combined: sum balances přes účty v contextAccounts které jsou v filtru.
    const candidates = contextAccounts.filter(inFilter);
    if (candidates.length === 0) return 0;
    return candidates.reduce((sum, a) => sum + (a.initialBalance || 0), 0);
  }, [contextAccounts, effectiveActiveAccount, viewMode, filters.accounts]);

  const [quickNote, setQuickNote] = useState('');

  const [journalActiveTab, setJournalActiveTab] = useState<'daily' | 'weekly' | 'archives'>('daily');
  const [settingsActiveTab, setSettingsActiveTab] = useState<'psychology' | 'strategy' | 'market' | 'system'>('psychology');
  const [businessActiveTab, setBusinessActiveTab] = useState<'financials' | 'goals'>('financials');
  const [historyLayoutMode, setHistoryLayoutMode] = useState<'grid' | 'table'>('grid');
  const [networkActiveTab, setNetworkActiveTab] = useState<'leaderboard' | 'feed' | 'following' | 'followers' | 'requests' | 'share'>('feed');
  const [isNetworkSpectating, setIsNetworkSpectating] = useState(false);

  const displayTrades = useMemo(() => {
    if (viewMode === 'individual') {
      // Indiv. mód = každý obchod zvlášť (žádné agregování přes master/groupId).
      // Account scoping NEDĚLÁME tady — to řídí čistě dropdown přes filters.accounts
      // v baseFilteredTrades. Bez tohoto byl Indiv. zaseklý na "active account family"
      // a klikání na ostatní účty v dropdownu nic neudělalo.
      return trades;
    }

    const grouped = new Map<string, Trade[]>();
    const independent: Trade[] = [];

    // Fáze účtu pro grupování — funded a challenge kopie téhož fan-outu NESMÍ splynout do
    // jedné karty, jinak by combined karta (klíčovaná masterem) ve funded/challenge filtru
    // míchala cizí peníze. Klíč proto zahrnuje "phase bucket".
    const phaseBucketOf = (accId?: string): string => {
      const acc = accountsById.get(accId);
      if (!acc) return 'other';
      if (acc.type === 'Funded' && acc.phase === 'Challenge') return 'challenge';
      if (acc.type === 'Live' || (acc.type === 'Funded' && acc.phase === 'Funded')) return 'funded';
      if (acc.type === 'Backtest') return 'backtest';
      return 'other';
    };

    trades.forEach(t => {
      // Logic: If it's a copy, group by masterTradeId. If it's a master, group by its own ID.
      const baseKey = t.masterTradeId || (t.isMaster ? t.id : t.groupId);
      if (baseKey) {
        const key = `${baseKey}__${phaseBucketOf(t.accountId)}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(t);
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
    // Pozn.: dřív deps obsahovaly i effectiveActiveAccount a contextAccounts, které tělo
    // vůbec nečte → zbytečné přepočty (full group+sort) při každé změně jejich identity.
  }, [trades, viewMode, accountsById]);

  // (Pozn.: dřív tu byl `const stats = useMemo(calculateStats(displayTrades…))`, který se ale
  // nikde nepoužíval — Dashboard bere `filteredStats`. Odstraněno: byl to plný průchod všemi
  // obchody (equity křivka, kalendář, hodinové/denní mapy) na každou změnu trades zbytečně.)

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

      // OCHRANA: nepřepisuj trades prázdným polem pokud DB call selhal/timeoutoval.
      // Bez tohoto bliká dashboard na 0pnl/0RR při dočasné chybě sítě nebo Supabase glitch.
      setTrades(prev => (dbTrades && dbTrades.length > 0) ? dbTrades : prev);

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
    // KRITICKÉ: account lookup musí brát i archivované účty, jinak obchody z archivovaných
    // (např. spálené Tradeify 50k) zmizí z Deníku/Dashboardu, i když jsou v Historii vidět.
    // accountsById (sdílené memo) je pokrývá — a navíc O(1) místo O(A) find per trade.
    return displayTrades.filter(t => {
      // DEBUG: Log Alpha Bridge trades to see why they're filtered
      const isAlphaBridge = t.signal === 'Alpha Bridge v2';

      // TVRDÁ PŘEPÁŽKA: Backtest obchody patří jen do backtest světa.
      // Mimo 'backtesting' je NIKDY nezobrazuj (Deník/Dashboard/History), i v "Vše".
      {
        const acc = accountsById.get(t.accountId);
        const isBacktestTrade = isBacktestAccount(acc);
        if (dashboardMode === 'backtesting') {
          if (!isBacktestTrade) return false;
        } else if (isBacktestTrade) {
          return false;
        }
      }

      // Filter by phase based on dashboardMode
      // ALWAYS use account phase as source of truth, not trade phase
      if (dashboardMode === 'challenge') {
        const acc = accountsById.get(t.accountId);
        const isChallenge = acc?.type === 'Funded' && acc?.phase === 'Challenge';
        if (!isChallenge) {
          return false;
        }
      } else if (dashboardMode === 'funded') {
        const acc = accountsById.get(t.accountId);
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
      // Prázdný account-filtr: "ukaž vše" platí JEN v módu 'combined' (Vše).
      // U konkrétního módu (funded/challenge/backtesting) prázdný filtr znamená,
      // že v něm není žádný aktivní účet → nic nezobrazuj (obchody se ale nemažou).
      const emptyMeansAll = dashboardMode === 'combined';
      if (viewMode === 'combined') {
        // In combined mode, if filtering by accounts, include trades from both master and its children
        if (filters.accounts.length === 0) {
          matchAcc = emptyMeansAll;
        } else {
          matchAcc = filters.accounts.some(filterId => {
            const isTarget = t.accountId === filterId;
            const isChildOfTarget = t.masterTradeId && t.accountId !== filterId; // Simplified check
            // More robust: does this trade's account have a parent that is in filters?
            const acc = accountsById.get(t.accountId);
            return isTarget || (acc?.parentAccountId && filters.accounts.includes(acc.parentAccountId));
          });
        }
      } else {
        // In normal mode, empty filter means "show all accounts" (jen v combined módu)
        if (filters.accounts.length === 0) {
          matchAcc = emptyMeansAll;
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
  }, [displayTrades, filters, viewMode, accountsById, dashboardMode]);

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
    const normalized = normalizeTrades(data, activeAccountId).map(t => ({
      ...t,
      phase: activeAccount?.phase || 'Challenge'
    }));
    // Jen skutečně NOVÉ obchody (dedup proti tomu, co už máme v paměti).
    const newTrades = normalized.filter(nt =>
      !trades.some(t => t.id === nt.id && t.accountId === activeAccountId)
    );
    if (newTrades.length === 0) return;

    // Optimistic UI — přidej nové k existujícím.
    setTrades(prev => [...prev, ...newTrades]);

    // CRITICAL: ulož JEN nové obchody, ne celé pole. Dřív se posílal [...trades, ...new] →
    // saveTrades re-fetchnul a re-upsertnul VŠECHNY existující řádky (write amplification).
    // saveTrades existující v DB nechá být; tady jen zreconcilujeme optimistické nové
    // (temp ID) za uložené verze (reálná UUID z DB), zbytek stavu se nedotkneme.
    const optimisticIds = new Set(newTrades.map(t => t.id));
    storageService.saveTrades(newTrades).then(saved => {
      if (saved && saved.length > 0) {
        setTrades(prev => [...prev.filter(t => !optimisticIds.has(t.id)), ...saved]);
      }
    }).catch(err => {
      console.error("[FileUpload] Failed to save imported trades:", err);
      setSyncError("Nepodařilo se uložit importované obchody do cloudu.");
    });
  };

  // Tradovate import: modal už spáruje fills→obchody a vyřeší dedup,
  // takže sem chodí jen NOVÉ obchody (s accountId zapečeným) k uložení.
  // Tradesyncer import: nejdřív vytvoř nové účty (temp id → real DB id), pak ulož obchody.
  const handleTradesyncerImport = async (newTrades: Trade[], newAccounts: Account[]) => {
    if (!newTrades || newTrades.length === 0) return;
    let tradesToSave = newTrades;

    // 1) Vytvoř nové účty a získej mapování temp id → real id (matchuje se přes jméno).
    if (newAccounts.length > 0) {
      try {
        const saved = await storageService.saveAccounts(newAccounts);
        const nameToReal = new Map(saved.map(a => [a.name, a.id]));
        const tempToReal = new Map<string, string>();
        for (const na of newAccounts) {
          const real = nameToReal.get(na.name);
          if (real) tempToReal.set(na.id, real);
        }
        // Přidej nové účty do stavu (s reálnými id) — ať jsou hned vidět.
        setAccounts(prev => {
          const have = new Set(prev.map(a => a.id));
          return [...prev, ...saved.filter(a => !have.has(a.id))];
        });
        // Přemapuj accountId na obchodech z temp na real.
        tradesToSave = newTrades.map(t =>
          tempToReal.has(String(t.accountId)) ? { ...t, accountId: tempToReal.get(String(t.accountId))! } : t
        );
        // Zapamatuj i nově vytvořené účty (accountName je zapečené v temp id) pro příští importy.
        try {
          const PREFIX = 'tradesyncer-new-';
          const saved = JSON.parse(localStorage.getItem('tradesyncer-account-map') || '{}') || {};
          for (const [temp, real] of tempToReal) {
            if (temp.startsWith(PREFIX)) saved[temp.slice(PREFIX.length)] = real;
          }
          localStorage.setItem('tradesyncer-account-map', JSON.stringify(saved));
        } catch { /* localStorage nedostupné */ }
      } catch (err) {
        console.error('[TradesyncerImport] Vytvoření účtů selhalo:', err);
        setSyncError('Nepodařilo se vytvořit nové účty pro import.');
        return;
      }
    }

    // 2) Ulož obchody (stejný flow jako Tradovate import).
    const importedIds = new Set(tradesToSave.map(t => String(t.id)));
    setTrades(prev => [...prev, ...tradesToSave]);
    const rollback = () => setTrades(prev => prev.filter(t => !importedIds.has(String(t.id))));
    try {
      const savedTrades = await storageService.saveTrades(tradesToSave);
      if (savedTrades && savedTrades.length > 0) {
        setTrades(prev => {
          const savedIds = new Set(savedTrades.map(s => String(s.id)));
          const withoutImported = prev.filter(t => !importedIds.has(String(t.id)) && !savedIds.has(String(t.id)));
          return [...withoutImported, ...savedTrades];
        });
      } else {
        rollback();
        setSyncError('Nepodařilo se uložit importované obchody do cloudu.');
      }
    } catch (err) {
      console.error('[TradesyncerImport] Uložení obchodů selhalo:', err);
      rollback();
      setSyncError('Nepodařilo se uložit importované obchody do cloudu.');
    }
  };

  const handleTradovateImport = (newTrades: Trade[]) => {
    if (!newTrades || newTrades.length === 0) return;
    const importedIds = new Set(newTrades.map(t => String(t.id)));
    // Optimisticky přidej, ať uživatel hned vidí výsledek.
    setTrades(prev => [...prev, ...newTrades]);
    // Vrátí optimistické přidání zpět (aby v UI nezůstaly obchody s dočasnými id, které v DB nejsou).
    const rollback = () => setTrades(prev => prev.filter(t => !importedIds.has(String(t.id))));
    storageService.saveTrades(newTrades).then(saved => {
      if (saved && saved.length > 0) {
        // Nahraď optimistické verze uloženými (s reálnými DB id).
        setTrades(prev => {
          const savedIds = new Set(saved.map(s => String(s.id)));
          const withoutImported = prev.filter(t => !importedIds.has(String(t.id)) && !savedIds.has(String(t.id)));
          return [...withoutImported, ...saved];
        });
      } else {
        // Uložení neproběhlo (prázdná odpověď bez výjimky) → ber jako selhání, ne tiše nechat orphany.
        console.error('[TradovateImport] saveTrades vrátilo prázdný výsledek — rollback optimistického přidání.');
        rollback();
        setSyncError('Nepodařilo se uložit importované obchody do cloudu.');
      }
    }).catch(err => {
      console.error('[TradovateImport] Failed to save imported trades:', err);
      rollback();
      setSyncError('Nepodařilo se uložit importované obchody do cloudu.');
    });
  };

  // Počet importovaných obchodů bez doplněného screenshotu/konfluence.
  const enrichCount = useMemo(() => trades.filter(tradeNeedsEnrichment).length, [trades]);

  // Spustí průvodce doplněním — přepne na historii a inkrementuje signál pro TradeHistory.
  const startEnrichWizard = useCallback(() => {
    setActivePage('history');
    setEnrichSignal(s => s + 1);
  }, []);

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

      {worldShift.active && <WorldShiftOverlay to={worldShift.to} />}

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
            navigateTo(page);
            setIsSidebarOpen(false);
          }}
          onLockedFeature={(featureId) => setLockedFeatureModal(featureId)}
          enrichCount={enrichCount}
          dashboardMode={dashboardMode}
          onToggleBacktest={toggleBacktestMode}
        />
      </div>

      {/* Bottom navigation — pouze mobil */}
      <BottomNav
        activePage={activePage}
        onNavigate={navigateTo}
        onAddTrade={handleTryAddTrade}
        theme={theme}
        userRole={currentUser.role}
        enrichCount={enrichCount}
        onLockedFeature={(featureId) => setLockedFeatureModal(featureId)}
        dashboardMode={dashboardMode}
        onToggleBacktest={toggleBacktestMode}
      />

      {/* Locked feature info modal — friend role klikne na uzamčenou položku */}
      <LockedFeatureModal
        featureId={lockedFeatureModal}
        onClose={() => setLockedFeatureModal(null)}
      />

      <main className={`flex-1 h-screen overflow-hidden transition-all duration-300 relative flex flex-col ${isSidebarCollapsed ? 'lg:pl-[88px]' : 'lg:pl-[240px]'} ${isNetworkSpectating ? '!ml-0' : ''} pb-[72px] lg:pb-0`}>
        {/* SVG displacement filter pro liquid-glass edge refrakci (Stage 2).
            Nízká baseFrequency = velké hladké blobу (jemné lámání), ne wavy koupelnové sklo.
            scale řídí sílu ohybu — laditelné. Použito přes backdrop-filter: url(#liquid-glass). */}
        <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute', pointerEvents: 'none' }}>
          <filter id="liquid-glass" x="-25%" y="-25%" width="150%" height="150%" colorInterpolationFilters="sRGB">
            {/* Strukturovaná bevel mapa = rovný lom na okrajích, žádné zvlnění (vs feTurbulence).
                Větší region (150%) = displacement má kam "přetéct" → fold funguje na obou hranách. */}
            <feImage href={GLASS_DISPLACEMENT_MAP} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map" />
            <feDisplacementMap in="SourceGraphic" in2="map" scale={20} xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>
        <header className={`absolute z-40 px-6 py-2 flex items-center justify-between transition-all rounded-2xl floating-glass-header header-clear ${isSidebarCollapsed ? 'lg:left-[96px]' : 'lg:left-[264px]'} left-4 right-4 top-4 lg:top-6 lg:right-6 ${isNetworkSpectating ? 'hidden' : ''}`}>
          {/* Vizuál headeru dělá CSS: gradient tint + border + stín + lupa přes backdrop-filter:url(#liquid-glass). */}
          <div className="flex items-center gap-3 relative z-10">
            <button onClick={() => setIsSidebarOpen(true)} className="hidden p-2 hover:bg-white/10 rounded-lg"><Menu size={20} /></button>
            <div className="flex items-center gap-2.5 pr-1">
              <img
                src="/logos/at_logo_light_clean.png"
                alt="Alpha Trade"
                className={`h-8 w-8 object-contain shrink-0 ${theme !== 'light' ? 'drop-shadow-[0_0_12px_rgba(34,211,238,0.35)]' : ''}`}
              />
              <div className={`hidden xl:block h-6 w-px ${theme !== 'light' ? 'bg-white/15' : 'bg-slate-300/60'}`}></div>
            </div>
            <h2 className={`text-xl font-black uppercase tracking-tighter whitespace-nowrap ${theme !== 'light' ? 'text-white' : 'text-slate-800'}`}>
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
            <div className="hidden md:flex flex-1 justify-center relative z-10">
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
            <div className="hidden md:flex flex-1 justify-center relative z-10">
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
            <div className="hidden md:flex flex-1 justify-center relative z-10">
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
            <div className="hidden md:flex flex-1 justify-center relative z-10">
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

          <div className="flex items-center gap-2 md:gap-3 relative z-10">
            {/* Item 1: Dashboard Mode Status */}
            <div className="hidden md:flex items-center">
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border transition-all duration-200 select-none ${
                theme !== 'light'
                  ? 'bg-white/5 border-white/10 text-white shadow-inner'
                  : 'bg-white border-slate-200/80 text-slate-800 shadow-xs'
              }`}>
                <div className="relative flex h-1.5 w-1.5">
                  <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${
                    dashboardMode === 'funded' ? 'animate-ping bg-emerald-400' :
                    dashboardMode === 'challenge' ? 'animate-ping bg-blue-400' :
                    dashboardMode === 'backtesting' ? 'animate-ping bg-violet-400' :
                    'animate-ping bg-orange-400'
                  }`}></span>
                  <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${
                    dashboardMode === 'funded' ? 'bg-emerald-500' :
                    dashboardMode === 'challenge' ? 'bg-blue-500' :
                    dashboardMode === 'backtesting' ? 'bg-violet-500' :
                    'bg-orange-500'
                  }`}></span>
                </div>
                <span className={`text-[10px] font-black uppercase tracking-[0.2em] ${
                  dashboardMode === 'funded' ? 'text-emerald-400' :
                  dashboardMode === 'challenge' ? 'text-blue-400' :
                  dashboardMode === 'backtesting' ? 'text-violet-400' :
                  'text-orange-400'
                }`}>
                  {dashboardMode === 'funded' ? 'Funded' : dashboardMode === 'challenge' ? 'Challenge' : dashboardMode === 'backtesting' ? 'Backtesting' : 'All'}
                </span>
              </div>
            </div>

            {/* Filtr + přepínač režimu — vlastní skupina blízko u sebe */}
            <div className="flex items-center gap-1.5">
            {/* Item 2: Filter Dropdown */}
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
              setDashboardMode={(v) => { setDashFocusAccount(null); setDashboardMode(v); markPreferencesDirty(); }}
              viewMode={viewMode}
              setViewMode={setViewMode}
              pnlDisplayMode={pnlDisplayMode}
              setPnlDisplayMode={setPnlDisplayMode}
              historyLayoutMode={activePage === 'history' ? historyLayoutMode : undefined}
              setHistoryLayoutMode={activePage === 'history' ? setHistoryLayoutMode : undefined}
              grouped={false}
            />

            {/* Item 3: Theme Toggle Button */}
            <button
              onClick={() => {
                let newTheme: 'dark' | 'light' | 'oled' = 'dark';
                if (theme === 'dark') newTheme = 'light';
                else if (theme === 'light') newTheme = 'oled';
                setTheme(newTheme);
              }}
              className={`p-2.5 rounded-xl border transition-all duration-200 ${
                theme !== 'light'
                  ? 'bg-white/5 border-white/10 hover:bg-white/10 text-slate-400 hover:text-white shadow-inner'
                  : 'bg-white border-slate-200/80 hover:bg-slate-50 text-slate-700 shadow-xs'
              }`}
            >
              {theme === 'light' ? <Sun size={20} /> : (theme === 'oled' ? <Zap size={20} className="text-blue-500" /> : <Moon size={20} />)}
            </button>
            </div>
          </div>
        </header>

        {/* AI Coach — renders directly in <main>, bypasses PullToRefresh/scroll container */}
        {activePage === 'ai' && (
          <div className="flex-1 overflow-hidden h-full pt-[80px] lg:pt-[96px]">
            <React.Suspense fallback={<div className="flex-1" />}>
              <AICoachPage
                trades={trades}
                accounts={accounts}
                ironRules={ironRules}
                standardGoals={standardGoals}
                playbookItems={playbookItems}
                dailyPreps={dailyPreps}
                dailyReviews={dailyReviews}
                sessions={activeSessions}
                theme={theme}
                dashboardMode={dashboardMode}
                initialConversationId={aiActiveConvId}
                initialPrompt={aiInitialPrompt}
                onInitialPromptConsumed={() => setAiInitialPrompt(undefined)}
                onStreamingChange={setIsAIStreaming}
                onOpenTrade={(trade) => setAiChatTrade(trade)}
                onOpenJournal={(date) => {
                  setJournalTargetDate(date);
                  setActivePage('journal');
                }}
                onApplyAction={(action) => {
                  // Aplikuje doporučenou akci z AI Coache do uživatelova systému.
                  // Každý typ akce má jiný target — Iron Rule, Goal (standardGoals), atd.
                  // KRITICKÉ: setIronRules / setStandardGoals MUSÍ být doprovozeny
                  // markPreferencesDirty(), jinak background sync přepíše tvoje změny.
                  switch (action.type) {
                    case 'rule':
                    case 'experiment': {
                      // Experiment je rule s expirací — pro MVP ho přidáme jako Iron Rule
                      // s prefixem ⏱ a duration suffixem. Auto-expire můžeme doplnit později.
                      const prefix = action.type === 'experiment' && action.duration
                        ? `⏱ [${action.duration}] ` : '';
                      const label = `${prefix}${action.label}`;
                      // type:'trading' je KRITICKÉ — Settings i příprava filtrují pravidla
                      // podle type. Bez něj pravidlo propadne filtry a je neviditelné.
                      const newRule: IronRule = {
                        id: `rule_${Date.now()}`,
                        label,
                        type: 'trading',
                      };
                      setIronRules(prev => [...prev, newRule]);
                      markPreferencesDirty();
                      break;
                    }
                    case 'goal': {
                      // Goals jsou string[] (standardGoals). Přidej jen pokud ještě není.
                      setStandardGoals(prev =>
                        prev.includes(action.label) ? prev : [...prev, action.label]
                      );
                      markPreferencesDirty();
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
                        type: 'trading',
                      };
                      setIronRules(prev => [...prev, newRule]);
                      markPreferencesDirty();
                      break;
                    }
                    case 'modify_rule': {
                      // Najdi cílené pravidlo: 1) podle targetId (case-insensitive, coach píše
                      // občas T_SL vs t_sl), 2) fallback podle oldLabel (když ID chybí/nesedí).
                      const tid = action.targetId?.toLowerCase();
                      const oldL = action.oldLabel?.trim().toLowerCase();
                      const matches = (r: IronRule) =>
                        (tid && r.id.toLowerCase() === tid) ||
                        (oldL && r.label.trim().toLowerCase().startsWith(oldL));
                      setIronRules(prev => prev.map(r => matches(r) ? { ...r, label: action.label } : r));
                      markPreferencesDirty();
                      break;
                    }
                    case 'remove_rule': {
                      // Stejná logika cílení jako modify_rule (targetId → fallback oldLabel).
                      const tid = action.targetId?.toLowerCase();
                      const oldL = action.oldLabel?.trim().toLowerCase();
                      const matches = (r: IronRule) =>
                        (tid && r.id.toLowerCase() === tid) ||
                        (oldL && r.label.trim().toLowerCase().startsWith(oldL));
                      setIronRules(prev => prev.filter(r => !matches(r)));
                      markPreferencesDirty();
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
            <div className="flex-1 overflow-x-hidden px-4 lg:px-8 pb-12 pt-[80px] lg:pt-[96px]">
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
                  {activePage === 'dashboard' && dashboardMode !== 'backtesting' && loadedUserId && (
                    <MorningBriefBanner
                      userId={loadedUserId}
                      theme={theme}
                      onOpenCoach={(prompt) => {
                        setAiInitialPrompt(prompt);
                        setActivePage('ai');
                      }}
                    />
                  )}
                  {activePage === 'dashboard' && (
                    <Dashboard
                      stats={filteredStats}
                      theme={theme}
                      preps={dailyPreps}
                      reviews={dailyReviews}
                      layouts={dashboardMode === 'backtesting' ? backtestDashboardLayouts : dashboardLayouts}
                      sessions={activeSessions}
                      ironRules={ironRules}
                      onUpdateLayouts={(v: DashboardLayouts) => {
                          // GATE: Blokujeme automatické mount-time změny z react-grid-layout nebo během aplikace preferencí
                          if (!prefsAppliedRef.current || isApplyingPrefsRef.current || !isSyncedWithDbRef.current) {
                              console.log('[Setter] setDashboardLayouts BLOCKED (applying prefs lock or not synced)');
                              return;
                          }
                          const isBt = dashboardMode === 'backtesting';
                          const prev = isBt ? backtestDashboardLayouts : dashboardLayouts;
                          // Identity check pro post-load auto-fires (resize, theme change atd.)
                          try {
                              if (JSON.stringify(v) === JSON.stringify(prev)) return;
                          } catch { /* fallthrough */ }
                          if (isBt) {
                              setBacktestDashboardLayouts(v);
                          } else {
                              // Zapiš jen do layoutu aktuálního módu (funded/challenge/combined zvlášť).
                              const key = liveLayoutKey(dashboardMode);
                              setLiveLayoutsByMode(p => ({ ...p, [key]: v }));
                          }
                          markPreferencesDirty();
                          console.log(`[Setter] set${isBt ? 'Backtest' : ''}DashboardLayouts (mód:`, dashboardMode, ', breakpoints:', Object.keys(v), ') → dirty=true');
                      }}
                      isEditing={isDashboardEditing}
                      onCloseEdit={() => setIsDashboardEditing(false)}
                      dashboardMode={dashboardMode}
                      setDashboardMode={(v) => { setDashboardMode(v); markPreferencesDirty(); }}
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
                        accounts={[...accounts, ...archivedAccounts.filter(a => !accounts.some(x => x.id === a.id))]}
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
                        setViewMode={setHistoryLayoutMode}
                        enrichSignal={enrichSignal}
                        userMistakes={userMistakes}
                        onImportTradovate={() => {
                          setTradovateImportAccount(viewMode === 'individual' ? activeAccountId : undefined);
                          setTradovateImportOpen(true);
                        }}
                        onImportTradesyncer={() => setTradesyncerImportOpen(true)}
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
                          // Přidá insight jako nové Iron Rule (type:'trading' — jinak propadne filtry).
                          const newRule: IronRule = { id: `rule_${Date.now()}`, label: rule, type: 'trading' };
                          setIronRules(prev => [...prev, newRule]);
                          markPreferencesDirty();
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

                  {activePage === 'journal' && dashboardMode === 'backtesting' && (
                    <BacktestSessionsView theme={theme} accounts={accounts} trades={trades} />
                  )}

                  {activePage === 'journal' && dashboardMode !== 'backtesting' && (
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
                      sessions={activeSessions}
                      initialDate={journalTargetDate}
                      userMistakes={userMistakes}
                    />
                  )}

                  {activePage === 'accounts' && dashboardMode === 'backtesting' && (
                    <BacktestSessionsManager
                      theme={theme}
                      accounts={accounts.filter(isBacktestAccount)}
                      trades={trades}
                      // Merge zpět live účty, ať je BacktestSessionsManager nesmaže.
                      onUpdate={(next) => setAccounts([...accounts.filter(a => !isBacktestAccount(a)), ...next])}
                      onDelete={handleDeleteAccount}
                    />
                  )}

                  {activePage === 'accounts' && dashboardMode !== 'backtesting' && (
                    <>
                      <AccountsManager
                        accounts={accounts.filter(a => !isBacktestAccount(a))}
                        activeAccountId={activeAccountId}
                        setActiveAccountId={setActiveAccountId}
                        // Merge zpět Backtest účty, ať je AccountsManager nesmaže.
                        onUpdate={(next) => setAccounts([...next, ...accounts.filter(isBacktestAccount)])}
                        onDelete={handleDeleteAccount}
                        theme={theme}
                        trades={trades}
                        onUpdateTrades={handleUpdateTrades}
                        onAddExpense={handleAddSingleExpense}
                        onUpdatePayouts={handleUpdatePayouts}
                        payouts={businessPayouts}
                        user={currentUser}
                        onOpenInDashboard={(id) => {
                          setDashFocusAccount(id);
                          setActiveAccountId(id);
                          setViewMode('individual');
                          setDashboardMode('archive');
                          markPreferencesDirty();
                          setActivePage('dashboard');
                        }}
                        onImportTradovate={(id) => {
                          setTradovateImportAccount(id);
                          setTradovateImportOpen(true);
                        }}
                      />
                      {/* Hřbitov spálených účtů — všechny Failed účty z aktivního i archivovaného pole. */}
                      {(() => {
                        const failedAccounts = [...accounts, ...archivedAccounts]
                          .filter((a, i, arr) => a.result === 'Failed' && arr.findIndex(x => x.id === a.id) === i);
                        if (failedAccounts.length === 0) return null;
                        return (
                          <div className="mt-8">
                            <React.Suspense fallback={<div className="h-32" />}>
                              <Graveyard
                                accounts={failedAccounts}
                                trades={trades}
                                theme={theme}
                              />
                            </React.Suspense>
                          </div>
                        );
                      })()}
                    </>
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
                      onNetworkNotificationsChange={(prefs) => { setNetworkNotifications(prefs); markPreferencesDirty(); }}
                      onSpectatingChange={setIsNetworkSpectating}
                    />
                  )}

                  {activePage === 'settings' && (
                    <Settings
                      theme={theme}
                      activeTab={settingsActiveTab}
                      onTabChange={setSettingsActiveTab}
                      userEmotions={userEmotions} setUserEmotions={(v) => { setUserEmotions(v); markPreferencesDirty(); }}
                      userMistakes={userMistakes} setUserMistakes={(v) => { setUserMistakes(v); markPreferencesDirty(); }}
                      htfOptions={htfOptions} setHtfOptions={(v) => { setHtfOptions(v); markPreferencesDirty(); }}
                      ltfOptions={ltfOptions} setLtfOptions={(v) => { setLtfOptions(v); markPreferencesDirty(); }}
                      sessions={sessions} setSessions={(v) => { setSessions(v); markPreferencesDirty(); }}
                      backtestSessions={backtestSessions} setBacktestSessions={(v) => { setBacktestSessions(v); markPreferencesDirty(); }}
                      isBacktestWorld={dashboardMode === 'backtesting'}
                      ironRules={ironRules}
                      setIronRules={(v) => { setIronRules(v); markPreferencesDirty(); }}
                      psychoMetrics={psychoMetrics}
                      setPsychoMetrics={(v) => { setPsychoMetrics(v); markPreferencesDirty(); }}
                      weeklyFocusList={weeklyFocusList}
                      setWeeklyFocusList={(v) => { setWeeklyFocusList(v); isWeeklyFocusDirty.current = true; }}
                      systemSettings={systemSettings}
                      setSystemSettings={(v: SystemSettings) => { setSystemSettings(v); markPreferencesDirty(); }}
                      standardGoals={standardGoals}
                      setStandardGoals={(v) => { setStandardGoals(v); markPreferencesDirty(); }}
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
                      onUpdatePlaybook={(v) => { setPlaybookItems(v); markPreferencesDirty(); }}
                      onUpdateGoals={handleUpdateGoals}
                      onUpdateResources={handleUpdateResources}
                      onUpdateSettings={(v) => { setBusinessSettings(v); markPreferencesDirty(); }}
                      onUpdateAccounts={setAccounts}
                      constitutionRules={constitutionRules}
                      onUpdateConstitution={(v) => { setConstitutionRules(v); markPreferencesDirty(); }}
                      careerRoadmap={careerRoadmap}
                      onUpdateRoadmap={(v) => { setCareerRoadmap(v); markPreferencesDirty(); }}
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


      {tradovateImportOpen && (
        <React.Suspense fallback={null}>
          <TradovateImportModal
            isOpen={tradovateImportOpen}
            onClose={() => setTradovateImportOpen(false)}
            accounts={accounts.filter(a => a.status === 'Active')}
            defaultAccountId={tradovateImportAccount || activeAccountId}
            existingTrades={trades}
            isDark={theme !== 'light'}
            onConfirm={handleTradovateImport}
            onStartEnrich={startEnrichWizard}
          />
        </React.Suspense>
      )}

      {tradesyncerImportOpen && (
        <React.Suspense fallback={null}>
          <TradesyncerImportModal
            isOpen={tradesyncerImportOpen}
            onClose={() => setTradesyncerImportOpen(false)}
            accounts={accounts}
            existingTrades={trades}
            isDark={theme !== 'light'}
            onConfirm={handleTradesyncerImport}
          />
        </React.Suspense>
      )}

      {/* Warning modal — pokud user odchází z AI stránky během streamu. */}
      <ConfirmationModal
        isOpen={!!pendingNav}
        onClose={() => setPendingNav(null)}
        onConfirm={() => {
          const fn = pendingNav;
          setPendingNav(null);
          if (fn) fn();
        }}
        title="Coach pořád pracuje"
        message="Mentor analyzuje data a píše odpověď. Pokud teď odejdeš, ztratíš ji a budeš muset poslat dotaz znovu. Chceš počkat nebo odejít přesto?"
        confirmText="Odejít přesto"
        cancelText="Počkat"
        theme={theme}
      />

      {/* Daily Start Ritual — ranní brief před tradingem. */}
      <React.Suspense fallback={null}>
        <DailyStartModal
          isOpen={dailyStartOpen}
          onClose={() => setDailyStartOpen(false)}
          onConfirm={(data) => {
            // Ulož commit do daily_preps pro dnešek (merge, ne overwrite).
            // Pro každé committed pravidlo vyrob ritualCompletion se status 'Pass'
            // — tak to Deník (ranní checklist) přečte jako "hotovo".
            const today = new Date().toISOString().slice(0, 10);
            const newCompletions = data.committedRuleIds.map(ruleId => ({ ruleId, status: 'Pass' as const }));
            setDailyPreps(prev => {
              const idx = prev.findIndex(p => p.date === today);
              if (idx === -1) {
                const newPrep: any = {
                  id: crypto.randomUUID(), date: today,
                  scenarios: { bullish: '', bearish: '' }, goals: [],
                  checklist: { sleptWell: false, planReady: false, disciplineCommitted: true, newsChecked: false },
                  mindsetState: data.affirmation, confidence: 70,
                  ritualCompletions: newCompletions,
                  startedAt: Date.now(),
                  committedRuleIds: data.committedRuleIds,
                  dailyFocus: data.focus,
                };
                isPrepsDirty.current = true;
                return [newPrep, ...prev];
              }
              // Merge: zachovej existující ritualCompletions, jen overrideni těch které user
              // teď v modalu odškrtnul (přepiš status na Pass — modal vždy posílá co je hotové)
              const existingCompletions = prev[idx].ritualCompletions || [];
              const mergedCompletions = [...existingCompletions];
              for (const c of newCompletions) {
                const ei = mergedCompletions.findIndex(x => x.ruleId === c.ruleId);
                if (ei >= 0) mergedCompletions[ei] = c;
                else mergedCompletions.push(c);
              }
              const merged = {
                ...prev[idx],
                startedAt: Date.now(),
                committedRuleIds: data.committedRuleIds,
                dailyFocus: data.focus,
                ritualCompletions: mergedCompletions,
              };
              if (!prev[idx].mindsetState) (merged as any).mindsetState = data.affirmation;
              isPrepsDirty.current = true;
              return prev.map((p, i) => i === idx ? merged : p);
            });
            setDailyStartOpen(false);
          }}
          theme={theme}
          ironRules={ironRules}
        />
      </React.Suspense>

      {/* Loss Day Debrief — automatický po překročení daily limitu. */}
      <React.Suspense fallback={null}>
        <LossDayDebriefModal
          isOpen={lossDayDebriefOpen}
          onClose={() => setLossDayDebriefOpen(false)}
          targetDate={lossDayTargetDate}
          theme={theme}
          onSave={({ whatHappened, trigger, prevention, date }) => {
            // Ulož reflexi do daily_reviews (autoDebrief flag).
            setDailyReviews(prev => {
              const idx = prev.findIndex(r => r.date === date);
              const reviewBody: any = {
                id: idx === -1 ? crypto.randomUUID() : prev[idx].id,
                date,
                rating: 1,
                mainTakeaway: whatHappened,
                lessons: `Trigger: ${trigger}\n\nPrevence: ${prevention}`,
                mistakes: [],
                autoDebrief: true,
              };
              isReviewsDirty.current = true;
              if (idx === -1) return [reviewBody, ...prev];
              return prev.map((r, i) => i === idx ? { ...r, ...reviewBody } : r);
            });
            setLossDayDebriefOpen(false);
          }}
          onApplyAction={(action) => {
            // Reuse existing onApplyAction logic z chat akcí.
            switch (action.type) {
              case 'rule':
              case 'experiment': {
                const prefix = action.type === 'experiment' && action.duration ? `⏱ [${action.duration}] ` : '';
                const label = `${prefix}${action.label}`;
                const newRule: IronRule = { id: `rule_${Date.now()}`, label, type: 'trading' };
                setIronRules(prev => [...prev, newRule]);
                markPreferencesDirty();
                break;
              }
              case 'modify_rule': {
                if (!action.targetId) break;
                const tid = action.targetId.toLowerCase();
                const oldL = action.oldLabel?.trim().toLowerCase();
                const matches = (r: IronRule) =>
                  r.id.toLowerCase() === tid || (oldL && r.label.trim().toLowerCase().startsWith(oldL));
                setIronRules(prev => prev.map(r => matches(r) ? { ...r, label: action.label } : r));
                markPreferencesDirty();
                break;
              }
            }
          }}
        />
      </React.Suspense>

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

      {/* Toast: nový obchod dorazil přes Realtime (typicky z AlphaBridge) — neblokuje, sám zmizí, klik → Historie */}
      <AnimatePresence>
        {tradeToast && (() => {
          const win = tradeToast.pnl > 0.01, be = Math.abs(tradeToast.pnl) <= 0.01;
          const col = be ? '#f59e0b' : win ? '#10b981' : '#ef4444';
          const accName = accounts.find(a => String(a.id) === tradeToast.accountId)?.name || '';
          const pnlTxt = `${tradeToast.pnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(tradeToast.pnl)).toLocaleString('en-US')}`;
          return (
            <motion.button
              key={tradeToast.id}
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              onClick={() => { setActivePage('history'); setTradeToast(null); }}
              style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 9999, borderLeft: `3px solid ${col}` }}
              className={`flex items-center gap-3 pl-3 pr-4 py-3 rounded-xl shadow-2xl text-left ${theme === 'light' ? 'bg-white border border-slate-200' : 'bg-slate-900 border border-white/10'}`}
            >
              <span style={{ color: col, fontSize: 20, fontWeight: 900, lineHeight: 1 }}>✓</span>
              <div>
                <div className={`text-[10px] font-black uppercase tracking-wider ${theme === 'light' ? 'text-slate-500' : 'text-slate-400'}`}>Nový obchod přidán</div>
                <div className="text-sm font-bold flex items-center gap-2 mt-0.5">
                  <span className={theme === 'light' ? 'text-slate-900' : 'text-white'}>{tradeToast.instrument}</span>
                  <span style={{ color: col }}>{pnlTxt}</span>
                  {accName && <span className={`text-[11px] font-medium ${theme === 'light' ? 'text-slate-400' : 'text-slate-500'}`}>· {accName}</span>}
                </div>
              </div>
            </motion.button>
          );
        })()}
      </AnimatePresence>
    </div >
  );
};

export default App;
