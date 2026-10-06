import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Trade, TradeStats, DailyPrep, DailyReview, DashboardWidgetConfig, DashboardLayouts, SessionConfig, TimeStat, MonthlyData, IronRule, Account, CustomEmotion, DashboardMode, User, PnLDisplayMode, BusinessPayout, EquityPoint } from '../types';
import { formatPnL, formatTradePnL, formatCurrency } from '../utils/formatPnL';
import { calculateRStatistics, tradeRMultiple } from '../utils/tradeRisk';
import { currencyService, ExchangeRates } from '../services/currencyService';
import { t } from '../services/translations';
import { getTradeEntryMinuteOfDay, getTradeEntryDate } from '../services/tradeTime';
import Charts from './Charts';
import { simulateBacktestMonteCarlo } from '../services/backtestMonteCarlo';
import DashboardCalendar from './DashboardCalendar';
import DisciplineDashboard from './DisciplineDashboard';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Cell, ReferenceLine, LabelList, PieChart, Pie, Sector, AreaChart, Area, Rectangle
} from 'recharts';
import {
  Activity,
  Maximize2,
  BarChart3,
  LayoutGrid,
  Trophy,
  Zap,
  Target,
  Plus,
  Trash2,
  LayoutTemplate,
  Info,
  Globe,
  Clock,
  Calendar as CalendarIcon,
  Search,
  ChevronRight,
  LineChart,
  ArrowUp,
  ArrowDown,
  Wallet,
  CheckCircle2,
  Layers,
  X,
  Brain,
  TrendingUp,
  TrendingDown,
  Percent,
  Timer,
  AlertTriangle,
  ShieldCheck,
  Terminal,
  Flag,
  Flame,
  Sparkles,
  Droplets,
  Undo2,
} from 'lucide-react';
import { fmtUsd as labFmtUsd, type LeakFinding } from '../services/labAnalytics';
import DailyInsightWidget from './DailyInsightWidget';
import DailyFocusWidget from './DailyFocusWidget';
import EquityIncidentModal from './EquityIncidentModal';
import PayoutDetailModal from './PayoutDetailModal';
import type { AccountDrawdownSummary } from '../services/propDrawdown';
import { reuseMonteCarloInput, type MonteCarloInput } from '../lib/monteCarloInput';

interface DashboardProps {
  stats: TradeStats;
  /** Top leak z Lab detektorů — počítá App ze STEJNÝCH vstupů jako záložka Lab
   *  (celý svět, merged účty, preps). Widget si ho nesmí počítat z scoped stats. */
  labTopLeak?: LeakFinding | null;
  theme: 'dark' | 'light' | 'oled';
  preps: DailyPrep[];
  reviews: DailyReview[];
  layouts: DashboardLayouts;
  sessions: SessionConfig[];
  ironRules: IronRule[];
  onUpdateLayouts: (newLayouts: DashboardLayouts) => void;
  isEditing: boolean;
  onCloseEdit?: () => void;
  accounts: Account[];
  emotions: CustomEmotion[];
  viewMode: 'individual' | 'combined';
  dashboardMode?: DashboardMode;
  setDashboardMode?: (mode: DashboardMode) => void;
  onDeleteTrade?: (id: number | string) => void;
  onUpdateTrade?: (tradeId: string | number, updates: Partial<Trade>) => void;
  user?: User;
  pnlDisplayMode?: PnLDisplayMode;
  exchangeRates: ExchangeRates | null;
  allTrades?: Trade[];
  payouts?: BusinessPayout[];
  drawdownSummaries?: AccountDrawdownSummary[];
  isMobileEditing?: boolean;
  setIsMobileEditing?: (v: boolean) => void;
  /** Open AI Coach with a pre-filled analysis prompt (e.g. for a specific day/week). */
  onAnalyzeWithAI?: (prompt: string) => void;
  /** Naviguje do Settings tabu — pro "Spravovat" tlačítka ve widgetech. */
  onNavigateToSettings?: () => void;
  /** Výchozí rozložení aktuálního světa — tlačítko „Obnovit výchozí“ v úpravách. */
  defaultLayouts?: DashboardLayouts;
}

// ... existing imports ...



// ... MASTER_WIDGET_LIST update ...
import TradeDetailModal from './TradeDetailModal';
import WidgetEditOverlay from './WidgetEditOverlay';
import DashboardWidgetLibrary, { type LibraryWidget } from './DashboardWidgetLibrary';
import DashboardPhoneEditor from './DashboardPhoneEditor';
import {
  arrangeDuringDrag, firstFreeSpot, packMidLayout, phoneLayoutFromRows, phoneRows, PHONE_LAYOUT_KEY, type PhoneRow,
} from '../lib/dashboardLayoutEdit';
import MonteCarloLab from './MonteCarloLab';
import { Responsive as ResponsiveGridLayout, useContainerWidth, verticalCompactor } from 'react-grid-layout';
import type { Compactor } from 'react-grid-layout/core';
import type { Layout, LayoutItem } from 'react-grid-layout';

// react-grid-layout configuration
const GRID_BREAKPOINTS = { xxl: 1920, lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 };
const GRID_COLS = { xxl: 24, lg: 12, md: 12, sm: 6, xs: 4, xxs: 2 };
const GRID_ROW_HEIGHT = 80;

const COLORS = {
  profit: '#10b981',
  profitBottom: '#059669',
  loss: '#f43f5e',
  lossBottom: '#e11d48',
  neutral: '#6366f1',
  textProfit: 'text-emerald-500',
  textLoss: 'text-rose-500',
  bgProfit: 'bg-emerald-500/10',
  bgLoss: 'bg-rose-500/10',
  borderProfit: 'border-emerald-500/20',
  borderLoss: 'border-rose-500/20'
};

// --- NEW WIDGET: DISTANCE TO TARGET ---
const DistanceToTargetWidget: React.FC<{ stats: TradeStats, accounts: Account[], theme: 'dark' | 'light' | 'oled', currency: 'USD' | 'CZK' | 'EUR', rates: any, payouts?: BusinessPayout[] }> = ({ stats, accounts, theme, currency, rates, payouts = [] }) => {
  const isDark = theme !== 'light';
  const format = (val: number) => formatCurrency(val, currency, rates);
  const initial = stats.initialBalance;

  // Calculate withdrawals for active accounts if we're in individual mode
  // Or just sum up all payouts in the current stats context
  const totalWithdrawals = payouts
    .filter(p => p.status === 'Received')
    .filter(p => stats.trades.some(t => t.accountId === p.accountId)) // Only payouts for accounts present in current stats
    .reduce((sum, p) => sum + (p.grossAmount || p.amount), 0);

  const current = initial + stats.totalPnL - totalWithdrawals;

  // Profit target z účtu/účtů ve scope (ne natvrdo 10 %).
  // V individual módu = profitTarget aktivního účtu; v combined = vážený průměr dle initial balance.
  const scopedIds = new Set(stats.trades.map(t => t.accountId));
  const scopedAccounts = accounts.filter(a => scopedIds.has(a.id));
  let targetPct = 10;
  if (scopedAccounts.length > 0) {
    const totalInit = scopedAccounts.reduce((s, a) => s + (a.initialBalance || 0), 0);
    if (totalInit > 0) {
      const weighted = scopedAccounts.reduce((s, a) => s + (a.initialBalance || 0) * (((a.profitTarget && a.profitTarget > 0) ? a.profitTarget : 10) / 100), 0);
      targetPct = (weighted / totalInit) * 100;
    }
  } else if (accounts.length === 1) {
    // Nový účet bez obchodů (individual): vezmi jeho cíl
    targetPct = (accounts[0].profitTarget && accounts[0].profitTarget > 0) ? accounts[0].profitTarget : 10;
  }
  const targetPctLabel = Number.isInteger(targetPct) ? targetPct.toString() : targetPct.toFixed(1);

  const target = initial * (1 + targetPct / 100);
  const progress = target === initial ? 0 : Math.min(100, Math.max(0, ((current - initial) / (target - initial)) * 100));
  const remaining = target - current;
  const isPassed = current >= target;

  // Dynamically calculate color: starts red and transitions via orange/yellow to green (closer to target = greener)
  const progressRatio = Math.min(100, Math.max(0, progress)) / 100;
  let r, g, b;
  if (progressRatio < 0.5) {
    // Phase 1: Red (239, 68, 68) -> Yellow (234, 179, 8)
    const ratio = progressRatio * 2;
    r = Math.round(239 + (234 - 239) * ratio);
    g = Math.round(68 + (179 - 68) * ratio);
    b = Math.round(68 + (8 - 68) * ratio);
  } else {
    // Phase 2: Yellow (234, 179, 8) -> Emerald Green (16, 185, 129)
    const ratio = (progressRatio - 0.5) * 2;
    r = Math.round(234 + (16 - 234) * ratio);
    g = Math.round(179 + (185 - 179) * ratio);
    b = Math.round(8 + (129 - 8) * ratio);
  }
  const currentRGB = `${r}, ${g}, ${b}`;

  return (
    <div className="p-6 rounded-[32px] glass-panel relative overflow-visible h-full flex flex-col justify-between">
      <div className="flex justify-between items-start mb-4">
        <h3 className="text-[13px] font-bold flex items-center gap-2 text-[var(--text-primary)]">
          <Flag size={16} className="text-blue-500" /> Challenge Cíl
        </h3>
        <div className={`px-2 py-1 rounded-lg text-[11px] font-semibold ${isPassed ? 'bg-emerald-500 text-white' : (isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-600')}`}>
          {isPassed ? 'Splněno' : 'In Progress'}
        </div>
      </div>

      <div className="flex-1 flex flex-col justify-center">
        <div className="flex justify-between items-end mb-2">
          <span className={`text-3xl font-black tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>{format(current)}</span>
          <div className="text-right">
            <span className="text-[11px] font-bold text-slate-500 block">Cíl ({targetPctLabel}%)</span>
            <span className={`text-sm font-black ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{format(target)}</span>
          </div>
        </div>
        
        <div className="relative w-full h-5 my-2">
          {/* Track and Progress Fill */}
          <div className={`h-full w-full rounded-full overflow-hidden relative border ${isDark ? 'bg-[var(--bg-page)] border-[var(--border-subtle)] shadow-[inset_0_2px_4px_rgba(0,0,0,0.6)]' : 'bg-[var(--bg-page)] border-[var(--border-subtle)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.1)]'}`}>
            <div 
              className="absolute top-0 bottom-0 left-0 transition-all duration-1000 ease-out flex items-center justify-end pr-3" 
              style={{ 
                width: `${progress}%`,
                background: `linear-gradient(to right, rgb(239, 68, 68), rgb(${currentRGB}))`
              }}
            >
              {progress > 15 && <span className="text-[10px] font-black text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]">{progress.toFixed(1)}%</span>}
            </div>
            
            {/* 50% Milestone indicator */}
            <div className={`absolute top-0 bottom-0 w-px left-[50%] border-l border-dashed ${isDark ? 'border-white/20' : 'border-slate-400/30'}`}></div>
          </div>
        </div>

        <div className="mt-3 flex justify-between items-center text-[10px] font-bold text-slate-500">
          <span>Start: {format(initial)}</span>
          <span>Zbývá: <span className={isDark ? 'text-white' : 'text-slate-900'}>{format(Math.max(0, remaining))}</span></span>
        </div>
      </div>
    </div>
  );
};

const SmartTooltip: React.FC<{
  children: React.ReactNode;
  text: string;
  subtext?: string;
  theme: 'dark' | 'light' | 'oled';
  color?: string;
  className?: string;
  style?: React.CSSProperties;
}> = ({ children, text, subtext, theme, color, className, style }) => {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current || !tooltipRef.current) return;
    const tr = triggerRef.current.getBoundingClientRect();
    const tt = tooltipRef.current.getBoundingClientRect();

    const fitsAbove = tr.top > tt.height + 16;
    const top = fitsAbove ? tr.top - tt.height - 12 : tr.bottom + 12;
    let left = tr.left + tr.width / 2 - tt.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tt.width - 8));

    tooltipRef.current.style.top = `${top}px`;
    tooltipRef.current.style.left = `${left}px`;
    requestAnimationFrame(() => {
      if (tooltipRef.current) {
        tooltipRef.current.style.opacity = '1';
        tooltipRef.current.style.transform = 'scale(1)';
      }
    });
  }, [isOpen]);

  return (
    <div
      className={`inline-block ${className || ''}`}
      style={style}
      ref={triggerRef}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      {children}
      {isOpen && createPortal(
        <div
          ref={tooltipRef}
          style={{ opacity: 0, transform: 'scale(0.95)' }}
          className="fixed p-3 rounded-2xl border shadow-2xl backdrop-blur-2xl z-[9999] w-48 pointer-events-none theme-card theme-border transition-all duration-200"
        >
          <div className="flex flex-col items-center gap-1">
            {color && <div className="w-2 h-2 rounded-full mb-1" style={{ backgroundColor: color }}></div>}
            <div className="text-[11px] font-semibold opacity-60 text-center text-wrap">{text}</div>
            {subtext && <div className="text-sm font-black text-center text-wrap">{subtext}</div>}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};


const InfoIcon: React.FC<{ text: string; theme: 'dark' | 'light' | 'oled' }> = ({ text, theme }) => (
  <SmartTooltip text="Info" subtext={text} theme={theme}>
    <div className="p-1 -m-1 cursor-help relative z-10">
      <Info size={14} className="text-slate-500 opacity-40 hover:opacity-100 transition-opacity" />
    </div>
  </SmartTooltip>
);

// --- NEW WIDGET: AVG WIN/LOSS ---
const AvgWinLossWidget: React.FC<{ stats: TradeStats, theme: 'dark' | 'light' | 'oled', pnlDisplayMode: PnLDisplayMode, initialBalance: number, currency: any, rates: any }> = ({ stats, theme, pnlDisplayMode, initialBalance, currency, rates }) => {
  const riskStats = useMemo(() => calculateRStatistics(stats.trades), [stats.trades]);
  const formatVal = (val: number, mode: PnLDisplayMode = pnlDisplayMode, bal?: number, rr?: number | null, sign: boolean = true) => {
    return formatPnL(val, mode, bal, rr, sign, currency, rates);
  };
  const avgWin = stats.avgWin || 0;
  const avgLoss = Math.abs(stats.avgLoss || 0);
  const shownWin = pnlDisplayMode === 'rr' ? riskStats.avgWin : avgWin;
  const shownLoss = pnlDisplayMode === 'rr' ? (riskStats.avgLoss === null ? null : Math.abs(riskStats.avgLoss)) : avgLoss;
  const hasRiskComparison = shownWin !== null && shownLoss !== null;

  // Calculate bar percentages (clamped to avoid layout break)
  const total = (shownWin ?? 0) + (shownLoss ?? 0);
  const winPct = total > 0 ? ((shownWin ?? 0) / total) * 100 : 50;

  return (
    <div className="p-6 rounded-[32px] glass-panel h-full flex flex-col justify-between">
      <div className="flex justify-between items-start mb-2">
        <h3 className="text-[13px] font-bold flex items-center gap-2 text-[var(--text-primary)]">
          Avg win/loss trade <InfoIcon text="Poměr průměrného zisku a ztráty. V režimu R se každý obchod přepočítá podle vlastního původního risku." theme={theme} />
        </h3>
      </div>

      <div className="flex-1 flex flex-col justify-center gap-4">
        <div className="w-full">
          <div className="w-full h-3 bg-slate-800 rounded-full flex items-center">
            <SmartTooltip
              text="Průměrný zisk"
              subtext={formatVal(avgWin, pnlDisplayMode, initialBalance, riskStats.avgWin)}
              theme={theme}
              color={COLORS.profit}
              style={{ width: `${winPct}%` }}
              className="h-full"
            >
              <div
                className={`${hasRiskComparison ? 'bg-emerald-500' : 'bg-slate-500'} w-full h-full rounded-l-full cursor-pointer hover:scale-y-125 transition-transform duration-300 origin-left`}
              />
            </SmartTooltip>
            <SmartTooltip
              text="Průměrná ztráta"
              subtext={formatVal(-avgLoss, pnlDisplayMode, initialBalance, riskStats.avgLoss)}
              theme={theme}
              color={COLORS.loss}
              style={{ width: `${100 - winPct}%` }}
              className="h-full"
            >
              <div
                className={`${hasRiskComparison ? 'bg-rose-500' : 'bg-slate-500'} w-full h-full rounded-r-full cursor-pointer hover:scale-y-125 transition-transform duration-300 origin-right`}
              />
            </SmartTooltip>
          </div>
        </div>

        <div className="flex justify-between items-center text-xs font-black">
          <span className={shownWin === null ? 'text-slate-400' : COLORS.textProfit}>{formatVal(avgWin, pnlDisplayMode, initialBalance, riskStats.avgWin)}</span>
          <span className={shownLoss === null ? 'text-slate-400' : COLORS.textLoss}>{formatVal(-avgLoss, pnlDisplayMode, initialBalance, riskStats.avgLoss)}</span>
        </div>
      </div>
    </div>
  );
};

// --- NEW WIDGET: STREAK ---
const StreakWidget: React.FC<{ stats: TradeStats, theme: 'dark' | 'light' | 'oled' }> = ({ stats, theme }) => {
  const dayStreak = stats.currentDayStreak || 0;
  const tradeStreak = stats.currentTradeStreak || 0;

  const getStreakColor = (val: number) => val > 0 ? 'text-emerald-500 border-emerald-500' : val < 0 ? 'text-rose-500 border-rose-500' : 'text-slate-500 border-slate-700';

  return (
    <div className="p-6 rounded-[32px] glass-panel flex flex-col h-full">
      <div className="flex justify-between items-start mb-4">
        <h3 className="text-[13px] font-bold flex items-center gap-2 text-[var(--text-primary)]">
          Current streak <InfoIcon text="Aktuální série ziskových/ztrátových dnů a obchodů." theme={theme} />
        </h3>
      </div>

      <div className="grid grid-cols-2 gap-4 flex-1 content-center">
        {/* DAYS STREAK */}
        <div className="flex items-center gap-3">
          <SmartTooltip text="Denní série" subtext={dayStreak > 0 ? `${dayStreak} ziskových dní v řadě` : `${Math.abs(dayStreak)} ztrátových dní v řadě`} theme={theme}>
            <div className={`w-14 h-14 rounded-full border-[6px] flex items-center justify-center text-xl font-black ${getStreakColor(dayStreak)} cursor-pointer hover:scale-110 transition-transform duration-300`}>
              {Math.abs(dayStreak)}
            </div>
          </SmartTooltip>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold text-slate-500">DAYS</span>
            <div className="flex flex-col gap-1 text-[9px] font-bold">
              <SmartTooltip text="Nejhorší série" subtext="Nejvíce ztrátových dní v řadě" theme={theme} color={COLORS.loss}>
                <span className="bg-rose-500/20 text-rose-500 px-1.5 py-0.5 rounded w-fit cursor-pointer hover:opacity-80 transition-opacity">{stats.maxLosingDayStreak} days</span>
              </SmartTooltip>
              <SmartTooltip text="Nejlepší série" subtext="Nejvíce ziskových dní v řadě" theme={theme} color={COLORS.profit}>
                <span className="bg-emerald-500/20 text-emerald-500 px-1.5 py-0.5 rounded w-fit cursor-pointer hover:opacity-80 transition-opacity">{stats.maxWinningDayStreak} days</span>
              </SmartTooltip>
            </div>
          </div>
        </div>

        {/* TRADES STREAK */}
        <div className="flex items-center gap-3">
          <SmartTooltip text="Obchodní série" subtext={tradeStreak > 0 ? `${tradeStreak} ziskových obchodů v řadě` : `${Math.abs(tradeStreak)} ztrátových obchodů v řadě`} theme={theme}>
            <div className={`w-14 h-14 rounded-full border-[6px] flex items-center justify-center text-xl font-black ${getStreakColor(tradeStreak)} cursor-pointer hover:scale-110 transition-transform duration-300`}>
              {Math.abs(tradeStreak)}
            </div>
          </SmartTooltip>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold text-slate-500">TRADES</span>
            <div className="flex flex-col gap-1 text-[9px] font-bold">
              <SmartTooltip text="Nejhorší série" subtext="Nejvíce ztrát v řadě" theme={theme} color={COLORS.loss}>
                <span className="bg-rose-500/20 text-rose-500 px-1.5 py-0.5 rounded w-fit cursor-pointer hover:opacity-80 transition-opacity">{stats.maxConsecutiveLosses} trades</span>
              </SmartTooltip>
              <SmartTooltip text="Nejlepší série" subtext="Nejvíce výher v řadě" theme={theme} color={COLORS.profit}>
                <span className="bg-emerald-500/20 text-emerald-500 px-1.5 py-0.5 rounded w-fit cursor-pointer hover:opacity-80 transition-opacity">{stats.maxConsecutiveWins} trades</span>
              </SmartTooltip>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const DisciplineStreakWidget: React.FC<{ trades: Trade[], theme: 'dark' | 'light' | 'oled' }> = ({ trades, theme }) => {
  const isDark = theme !== 'light';

  const { currentStreak, bestStreak } = useMemo(() => {
    // Group trades by date, sorted descending
    const dayMap = new Map<string, Trade[]>();
    const sorted = [...trades]
      .filter(t => t.executionStatus !== 'Missed')
      .sort((a, b) => b.date.localeCompare(a.date));
    sorted.forEach(t => {
      const existing = dayMap.get(t.date) || [];
      existing.push(t);
      dayMap.set(t.date, existing);
    });

    const tradingDays = Array.from(dayMap.entries())
      .sort(([a], [b]) => b.localeCompare(a)); // descending

    // Current streak: consecutive trading days with no isValid=false trades
    let current = 0;
    for (const [, dayTrades] of tradingDays) {
      const hasInvalid = dayTrades.some(t => t.isValid === false);
      if (hasInvalid) break;
      current++;
    }

    // Best streak: longest run ever
    let best = 0;
    let run = 0;
    for (const [, dayTrades] of tradingDays) {
      const hasInvalid = dayTrades.some(t => t.isValid === false);
      if (hasInvalid) {
        run = 0;
      } else {
        run++;
        best = Math.max(best, run);
      }
    }

    return { currentStreak: current, bestStreak: best };
  }, [trades]);

  // Color tiers
  const getColor = (days: number) => {
    if (days >= 30) return { ring: 'border-purple-500', text: 'text-purple-400', glow: 'shadow-purple-500/20' };
    if (days >= 14) return { ring: 'border-amber-500', text: 'text-amber-400', glow: 'shadow-amber-500/20' };
    if (days >= 7) return { ring: 'border-emerald-500', text: 'text-emerald-400', glow: 'shadow-emerald-500/20' };
    return { ring: 'border-blue-500', text: 'text-blue-400', glow: 'shadow-blue-500/20' };
  };

  const color = getColor(currentStreak);
  const fireCount = currentStreak >= 30 ? 3 : currentStreak >= 14 ? 2 : currentStreak >= 7 ? 1 : 0;

  return (
    <div className="p-5 rounded-[24px] flex flex-col justify-between h-full relative overflow-hidden glass-panel">
      <div className="flex justify-between items-start mb-2">
        <div className="text-[11px] font-semibold text-slate-500 flex items-center gap-1.5 whitespace-nowrap">
          Discipline Streak
          <SmartTooltip text="Info" subtext="Počet po sobě jdoucích obchodních dní bez nevalidního obchodu (isValid = false)." theme={theme}>
            <div className="p-1 -m-1 cursor-help"><Info size={14} className="text-slate-500 opacity-40 hover:opacity-100 transition-opacity" /></div>
          </SmartTooltip>
        </div>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center gap-2">
        <div className={`w-20 h-20 rounded-full border-[5px] ${color.ring} flex items-center justify-center shadow-lg ${color.glow} transition-all duration-500`}>
          <div className="flex flex-col items-center">
            <span className={`text-2xl font-black leading-none ${isDark ? 'text-white' : 'text-slate-900'}`}>{currentStreak}</span>
            <span className="text-[10px] font-semibold text-slate-500 mt-0.5">
              {currentStreak === 1 ? 'den' : currentStreak >= 2 && currentStreak <= 4 ? 'dny' : 'dní'}
            </span>
          </div>
        </div>
        {fireCount > 0 && (
          <div className="flex gap-0.5">
            {Array.from({ length: fireCount }).map((_, i) => (
              <span key={i} className="text-sm animate-pulse" style={{ animationDelay: `${i * 150}ms` }}>🔥</span>
            ))}
          </div>
        )}
        <p className="text-[9px] font-bold text-slate-500">
          Rekord: <span className={`font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{bestStreak}</span> {bestStreak === 1 ? 'den' : bestStreak >= 2 && bestStreak <= 4 ? 'dny' : 'dní'}
        </p>
      </div>
    </div>
  );
};

// ── BACKTEST widgety ──────────────────────────────────────────────────────────
const _isBEt = (t: Trade) => t.isBE === true || t.outcome === 'BE' || (t.pnl || 0) === 0;
const _isWin = (t: Trade) => !_isBEt(t) && (t.pnl || 0) > 0;
const _isLoss = (t: Trade) => !_isBEt(t) && (t.pnl || 0) < 0;

function _sampleTier(n: number): { label: string; cls: string; pct: number } {
  if (n < 5) return { label: 'kriticky málo', cls: 'text-rose-400 bg-rose-500/10 border-rose-500/20', pct: (n / 30) * 100 };
  if (n < 10) return { label: 'malý vzorek', cls: 'text-amber-400 bg-amber-500/10 border-amber-500/20', pct: (n / 30) * 100 };
  if (n < 30) return { label: 'ok vzorek', cls: 'text-sky-400 bg-sky-500/10 border-sky-500/20', pct: (n / 30) * 100 };
  return { label: 'solidní vzorek', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', pct: 100 };
}

// Win rate dle počtu confluencí
const BtConfluenceWrWidget: React.FC<{ stats: TradeStats; theme: any }> = ({ stats, theme }) => {
  const buckets = useMemo(() => {
    const m = new Map<string, { count: number; wins: number; losses: number; pnl: number }>();
    for (const t of stats.trades) {
      if (t.executionStatus === 'Missed') continue;
      const n = (t.htfConfluence?.length || 0) + (t.ltfConfluence?.length || 0);
      const k = n >= 4 ? '4+' : String(n);
      const g = m.get(k) || { count: 0, wins: 0, losses: 0, pnl: 0 };
      g.count++; g.pnl += t.pnl || 0;
      if (_isWin(t)) g.wins++; else if (_isLoss(t)) g.losses++;
      m.set(k, g);
    }
    return ['0', '1', '2', '3', '4+']
      .filter(k => m.has(k))
      .map(k => { const g = m.get(k)!; const d = g.wins + g.losses; return { k, ...g, wr: d ? (g.wins / d) * 100 : 0 }; });
  }, [stats.trades]);

  return (
    <div className="p-6 rounded-[32px] glass-panel h-full flex flex-col">
      <h3 className="text-[13px] font-bold flex items-center gap-2 text-[var(--text-primary)] mb-4">
        WR dle počtu confluencí <InfoIcon text="Win rate podle počtu HTF+LTF confluencí. Testuje hypotézu víc confluencí = vyšší WR." theme={theme} />
      </h3>
      <div className="flex-1 flex flex-col justify-center gap-3 min-h-0">
        {buckets.length === 0 ? (
          <p className="text-xs text-slate-500 text-center">Obchody nemají vyplněné confluence.</p>
        ) : buckets.map(b => (
          <div key={b.k}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-bold">{b.k} {b.k === '1' ? 'confluence' : 'confluencí'}</span>
              <span className="text-[10px] font-bold text-slate-500">{b.count}× ({b.wins}/{b.losses})</span>
            </div>
            <div className={`relative h-5 rounded-lg overflow-hidden bg-[var(--bg-page)]`}>
              <div className={`absolute inset-y-0 left-0 ${b.wr >= 50 ? 'bg-emerald-500' : 'bg-rose-500'} opacity-80`} style={{ width: `${Math.max(b.wr, 3)}%` }} />
              <span className="absolute inset-0 flex items-center px-2 text-[10px] font-black text-white mix-blend-luminosity">{b.wr.toFixed(0)}% WR</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// Sample-size přehled
const BtSampleSizeWidget: React.FC<{ stats: TradeStats; theme: any }> = ({ stats, theme }) => {
  // Jeden průchod místo trojího filtrování.
  const { total, wins, losses } = useMemo(() => {
    let total = 0, wins = 0, losses = 0;
    for (const t of stats.trades) {
      if (t.executionStatus === 'Missed') continue;
      total++;
      if (_isWin(t)) wins++; else if (_isLoss(t)) losses++;
    }
    return { total, wins, losses };
  }, [stats.trades]);
  const be = total - wins - losses;
  const tier = _sampleTier(total);
  return (
    <div className="p-6 rounded-[32px] glass-panel h-full flex flex-col justify-between">
      <h3 className="text-[13px] font-bold flex items-center gap-2 text-[var(--text-primary)]">
        Sample-size <InfoIcon text="Statistická důvěra: pod 30 obchodů ber výsledky s rezervou. Pod 5 je to jen náhoda." theme={theme} />
      </h3>
      <div className="flex-1 flex flex-col justify-center gap-3">
        <div className="flex items-end gap-3">
          <span className="text-4xl font-black font-mono leading-none">{total}</span>
          <span className="text-[11px] font-bold text-slate-500 mb-1">obchodů</span>
        </div>
        <div className="relative h-2.5 rounded-full overflow-hidden bg-slate-500/15">
          <div className={`absolute inset-y-0 left-0 ${total >= 30 ? 'bg-emerald-500' : total >= 10 ? 'bg-sky-500' : total >= 5 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${Math.min(tier.pct, 100)}%` }} />
        </div>
        <div className="flex items-center justify-between">
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${tier.cls}`}>{tier.label}</span>
          <span className="text-[10px] font-bold text-slate-500">{wins}V · {losses}P{be ? ` · ${be}BE` : ''}</span>
        </div>
        {total < 30 && <p className="text-[9px] text-slate-500">Do „solidního" vzorku zbývá {30 - total} obchodů.</p>}
      </div>
    </div>
  );
};

// Monte Carlo simulace — bootstrap resampling existujících obchodů.
// Odpovídá na otázku „je edge reálná, nebo klika?": rozdělení výsledků, max DD, riziko ztráty.
const _money = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;

const BtMonteCarloWidget: React.FC<{ stats: TradeStats; theme: any; onExpand?: () => void }> = ({ stats, theme, onExpand }) => {
  const isDark = theme !== 'light';
  const SIMS = 600;
  const previousSimulationInput = useRef<MonteCarloInput | null>(null);
  const simulationInput = reuseMonteCarloInput(previousSimulationInput.current, stats.trades, stats.initialBalance);
  previousSimulationInput.current = simulationInput;
  const sim = useMemo(() => simulateBacktestMonteCarlo(
    simulationInput.pnls, simulationInput.initialBalance, { simulations: SIMS },
  ), [simulationInput]);

  if (!sim) {
    return (
      <div className="p-6 rounded-[32px] glass-panel h-full flex flex-col">
        <div className="flex items-start justify-between mb-1">
          <h3 className="text-[13px] font-bold flex items-center gap-2 text-[var(--text-primary)]">
            Monte Carlo <InfoIcon text="Simuluje stovky náhodných pořadí tvých obchodů (bootstrap) — ukáže rozptyl výsledků, drawdown a riziko. Odpoví: je edge reálná, nebo klika?" theme={theme} />
          </h3>
          {onExpand && (
            <button onClick={onExpand} title="Otevřít Monte Carlo Lab (celá obrazovka)"
              className={`w-6 h-6 rounded-lg flex items-center justify-center transition-all ${isDark ? 'text-slate-400 hover:text-violet-400 hover:bg-violet-500/10' : 'text-slate-400 hover:text-violet-600 hover:bg-violet-50'}`}>
              <Maximize2 size={13} />
            </button>
          )}
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-1 text-center">
          <Activity size={26} className="text-violet-400/60" />
          <p className="text-xs font-bold text-slate-500">Potřebuješ aspoň 10 obchodů pro mini-graf</p>
          <p className="text-[10px] text-slate-500">Nebo otevři Lab (↗) a simuluj z parametrů.</p>
        </div>
      </div>
    );
  }

  // ── Fan chart geometrie ──
  const W = 1000, H = 175, padX = 4, padY = 6;
  const minY = Math.min(0, ...sim.b5), maxY = Math.max(0, ...sim.b95);
  const range = maxY - minY || 1;
  const x = (i: number, total: number) => padX + (i / (total - 1)) * (W - padX * 2);
  const y = (v: number) => H - padY - ((v - minY) / range) * (H - padY * 2);
  const yFrac = (v: number) => `${(1 - (v - minY) / range) * 100}%`; // pro HTML overlay
  const line = (arr: number[], move = true) => arr.map((v, i) => `${i === 0 && move ? 'M' : 'L'}${x(i, arr.length).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const areaBetween = (top: number[], bot: number[]) =>
    `${line(top)} ${bot.map((_, i) => `L${x(bot.length - 1 - i, bot.length).toFixed(1)},${y(bot[bot.length - 1 - i]).toFixed(1)}`).join(' ')} Z`;
  const zeroY = y(0);

  const Metric: React.FC<{ label: string; value: string; sub?: string; cls?: string }> = ({ label, value, sub, cls }) => (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold text-slate-500 truncate">{label}</div>
      <div className={`text-[15px] font-black font-mono leading-tight ${cls || (isDark ? 'text-white' : 'text-slate-800')}`}>{value}</div>
      {sub && <div className="text-[8px] font-bold text-slate-500 truncate">{sub}</div>}
    </div>
  );

  return (
    <div className="p-6 rounded-[32px] glass-panel h-full flex flex-col">
      <div className="flex items-start justify-between mb-0.5">
        <h3 className="text-[13px] font-bold flex items-center gap-2 text-[var(--text-primary)]">
          Monte Carlo <InfoIcon text="Bootstrap: stovky náhodných přeskládání tvých obchodů. Tmavé pásmo = pravděpodobná zóna (P25–P75), světlé = krajní (P5–P95), čára = medián. Tenké čáry jsou ukázkové simulace. Ukazuje, kolik z výsledku je edge a kolik náhoda." theme={theme} />
        </h3>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[9px] font-bold text-slate-500">{SIMS} sim. · {sim.len} obchodů</span>
          {onExpand && (
            <button onClick={onExpand} title="Otevřít Monte Carlo Lab (celá obrazovka)"
              className={`w-6 h-6 rounded-lg flex items-center justify-center transition-all ${isDark ? 'text-slate-400 hover:text-violet-400 hover:bg-violet-500/10' : 'text-slate-400 hover:text-violet-600 hover:bg-violet-50'}`}>
              <Maximize2 size={13} />
            </button>
          )}
        </div>
      </div>
      <p className="text-[10px] text-slate-500 mb-2 leading-snug">Kam až se může equity reálně rozejít při stejné edge.</p>

      <div className="flex-1 min-h-0 flex flex-col gap-2.5">
        {/* Equity fan chart s osami */}
        <div className="relative flex-1 min-h-[96px]">
          <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
            <defs>
              <linearGradient id="mc-outer" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.16" />
                <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <line x1={padX} y1={zeroY} x2={W - padX} y2={zeroY} stroke={isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)'} strokeWidth="1" strokeDasharray="5 5" />
            {/* krajní pásmo P5–P95 */}
            <path d={areaBetween(sim.b95, sim.b5)} fill="url(#mc-outer)" />
            {/* pravděpodobná zóna P25–P75 */}
            <path d={areaBetween(sim.b75, sim.b25)} fill="#8b5cf6" fillOpacity="0.18" />
            {/* ukázkové simulace (spaghetti) */}
            {sim.paths.map((p, k) => (
              <path key={k} d={line(p)} fill="none" stroke="#a78bfa" strokeWidth="1" strokeOpacity="0.07" vectorEffect="non-scaling-stroke" />
            ))}
            <path d={line(sim.b95)} fill="none" stroke="#a78bfa" strokeWidth="1.25" strokeOpacity="0.55" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            <path d={line(sim.b5)} fill="none" stroke="#a78bfa" strokeWidth="1.25" strokeOpacity="0.55" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            <path d={line(sim.b50)} fill="none" stroke="#8b5cf6" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
          {/* Y osa */}
          <span className="absolute left-0 top-0 text-[8px] font-bold text-slate-500 leading-none">{_money(maxY)}</span>
          <span className="absolute left-0 bottom-0 text-[8px] font-bold text-slate-500 leading-none">{_money(minY)}</span>
          <span className="absolute left-0 text-[8px] font-bold text-slate-400 leading-none -translate-y-1/2" style={{ top: yFrac(0) }}>$0</span>
          {/* P-popisky na pravém okraji */}
          <span className="absolute right-0 text-[8px] font-black text-violet-300 leading-none -translate-y-1/2 px-1 rounded bg-violet-500/10" style={{ top: yFrac(sim.b95[sim.b95.length - 1]) }}>P95</span>
          <span className="absolute right-0 text-[8px] font-black text-violet-400 leading-none -translate-y-1/2 px-1 rounded bg-violet-500/15" style={{ top: yFrac(sim.b50[sim.b50.length - 1]) }}>P50</span>
          <span className="absolute right-0 text-[8px] font-black text-violet-300 leading-none -translate-y-1/2 px-1 rounded bg-violet-500/10" style={{ top: yFrac(sim.b5[sim.b5.length - 1]) }}>P5</span>
        </div>
        {/* X osa */}
        <div className="flex justify-between text-[8px] font-bold text-slate-500 -mt-1">
          <span>start</span><span>po {sim.len} obchodech</span>
        </div>

        {/* Rozpětí konečných výsledků */}
        <div>
          <div className="text-[11px] font-semibold text-slate-500 mb-1">Konečný výsledek (rozpětí 90 % scénářů)</div>
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Nepříznivý · P5" value={_money(sim.p5)} sub="1 z 20 horší" cls={sim.p5 >= 0 ? COLORS.textProfit : COLORS.textLoss} />
            <Metric label="Pravděpodobný · P50" value={_money(sim.p50)} sub="medián" cls={sim.p50 >= 0 ? COLORS.textProfit : COLORS.textLoss} />
            <Metric label="Příznivý · P95" value={_money(sim.p95)} sub="1 z 20 lepší" cls={sim.p95 >= 0 ? COLORS.textProfit : COLORS.textLoss} />
          </div>
        </div>

        {/* Riziko */}
        <div className="grid grid-cols-3 gap-2 pt-2 border-t border-[var(--border-subtle)]">
          <Metric label="Riziko ztráty" value={`${sim.pLoss.toFixed(0)}%`} sub="sim. v mínusu"
            cls={sim.pLoss <= 20 ? 'text-emerald-400' : sim.pLoss <= 40 ? 'text-amber-400' : 'text-rose-400'} />
          <Metric label="Max drawdown" value={`−$${Math.round(sim.ddMed).toLocaleString('en-US')}`} sub={`nejhorší −$${Math.round(sim.ddP95).toLocaleString('en-US')}`} cls="text-rose-400" />
          {sim.ruinPct != null
            ? <Metric label="Riziko ruinu" value={`${sim.ruinPct.toFixed(sim.ruinPct < 10 ? 1 : 0)}%`} sub="ztráta celého účtu"
                cls={sim.ruinPct <= 1 ? 'text-emerald-400' : sim.ruinPct <= 5 ? 'text-amber-400' : 'text-rose-400'} />
            : <Metric label="Expectancy" value={_money(sim.expectancy)} sub="/ obchod"
                cls={sim.expectancy >= 0 ? COLORS.textProfit : COLORS.textLoss} />}
        </div>
      </div>
    </div>
  );
};

// ── Lab: největší leak — top nález deterministických detektorů z labAnalytics ──
const LabTopLeakWidget: React.FC<{ top: LeakFinding | null; nTrades: number; theme: any }> = ({ top, nTrades, theme }) => {
  const isDark = theme !== 'light';

  return (
    <div className="p-6 rounded-[32px] glass-panel h-full flex flex-col">
      <h3 className="text-[13px] font-bold flex items-center gap-2 text-[var(--text-primary)] mb-1">
        <Droplets size={13} className="text-rose-400" /> Největší leak
        <InfoIcon text="Top nález deterministických Lab detektorů (revenge, sizing po ztrátě, slabé hodiny/session, bias flip, overtrading…). Skóre = |$ dopad| × konfidence (z-test) × trend. Detail v záložce Lab → Leaky." theme={theme} />
      </h3>
      {top ? (
        <div className="flex-1 flex flex-col justify-center min-h-0">
          <p className={`text-sm font-semibold tracking-tight leading-snug ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{top.title}</p>
          <p className={`text-xl font-black font-mono mt-1 ${top.usdImpact < 0 ? 'text-rose-500' : 'text-emerald-500'}`}>{labFmtUsd(top.usdImpact)}</p>
          <p className="text-[10px] font-bold text-slate-500 truncate mt-0.5">{top.statLine}</p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-1 text-center">
          <ShieldCheck size={24} className="text-emerald-400/70" />
          <p className="text-xs font-bold text-slate-500">Žádný detektor nezabral</p>
          <p className="text-[10px] text-slate-500">{nTrades < 8 ? 'Málo dat (min. ~8 obchodů).' : 'Na aktuálním vzorku čisto.'}</p>
        </div>
      )}
    </div>
  );
};

const PropDrawdownRoomWidget: React.FC<{
  summaries: AccountDrawdownSummary[];
  theme: 'dark' | 'light' | 'oled';
  isCombined?: boolean;
}> = ({ summaries, theme, isCombined = false }) => {
  const weakest = useMemo(() => [...summaries].sort((a, b) => a.remainingPct - b.remainingPct)[0], [summaries]);
  if (!weakest) {
    return <ProKpiCard theme={theme} label="DD prostor" value="—" subValue="Nastav drawdown u účtu" info="Aktuální prostor mezi balance a prop-firm breach floorem." icon={<ShieldCheck size={14} />} />;
  }
  const portfolioMode = isCombined && summaries.length > 1;
  const room = Math.round(portfolioMode
    ? summaries.reduce((sum, summary) => sum + summary.remainingRoom, 0)
    : weakest.remainingRoom);
  const state = weakest.breached ? 'BREACH' : weakest.locked ? 'LOCKED' : 'TRAILING';
  return (
    <ProKpiCard
      theme={theme}
      label={portfolioMode ? 'Portfolio DD' : 'DD prostor'}
      value={`${room < 0 ? '−' : ''}$${Math.abs(room).toLocaleString('en-US')}`}
      subValue={`${portfolioMode ? 'Nejslabší: ' : ''}${weakest.accountName} · $${Math.round(weakest.remainingRoom).toLocaleString('en-US')} · ${state}`}
      info={portfolioMode
        ? 'Součet DD rezerv vybraných účtů. Rezerva není mezi účty přenositelná — stav i barva se proto vždy řídí nejslabším účtem.'
        : 'Aktuální prostor do hard breach. U EOD účtu se floor posouvá až po uzavření dne, ale breach se hlídá během obchodování.'}
      icon={<div className={`${weakest.remainingPct <= 25 ? 'bg-rose-500/15 text-rose-500' : weakest.remainingPct <= 50 ? 'bg-amber-500/15 text-amber-500' : 'bg-emerald-500/15 text-emerald-500'} p-1 rounded-lg`}><ShieldCheck size={14} /></div>}
    />
  );
};

const MASTER_WIDGET_LIST = [
  { id: 'avg_win_loss', label: 'Avg Win/Loss', category: 'KPIs', icon: <ArrowUp size={18} />, description: 'Poměr průměrného zisku a ztráty.', preview: <div className="text-emerald-500 font-black text-xl">3.40</div>, defaultRowSpan: 1 },
  { id: 'streak', label: 'Current Streak', category: 'Psychologie', icon: <Zap size={18} />, description: 'Aktuální série výher/proher.', preview: <div className="text-blue-500 font-black text-xs">Streak: 5 days</div>, defaultRowSpan: 1 },
  { id: 'discipline_streak', label: 'Discipline Streak', category: 'Psychologie', icon: <Flame size={18} />, description: 'Počet dní bez nevalidního obchodu.', preview: <div className="text-emerald-500 font-black text-xl">12 dní</div>, defaultRowSpan: 1 },
  { id: 'challenge_target', label: 'Challenge Cíl', category: 'KPIs', icon: <Flag size={18} />, description: 'Sleduje postup k profit targetu (10%).', preview: <div className="text-blue-500 font-black text-xs">Progress: 45%</div>, defaultRowSpan: 1 },
  { id: 'kpi_pnl', label: 'Net P&L', category: 'KPIs', icon: <Trophy size={18} />, description: 'Čistý zisk nebo ztráta účtu.', preview: <div className={`${COLORS.textProfit} font-black text-xl`}>$215,873</div>, defaultRowSpan: 1 },
  { id: 'kpi_winrate', label: 'Trade win %', category: 'KPIs', icon: <Activity size={18} />, description: 'Procento vítězných obchodů.', preview: <div className="text-blue-500 font-black text-xl">57.97%</div>, defaultRowSpan: 1 },
  { id: 'kpi_execution_rate', label: 'Execution %', category: 'KPIs', icon: <Target size={18} />, description: 'Procento signálů, které jsi reálně vzal.', preview: <div className="text-orange-500 font-black text-xl">92%</div>, defaultRowSpan: 1 },
  { id: 'kpi_profit_factor', label: 'Profit factor', category: 'KPIs', icon: <BarChart3 size={18} />, description: 'Poměr hrubých zisků a ztrát.', preview: <div className={`${COLORS.textProfit} font-black text-xl`}>19.89</div>, defaultRowSpan: 1 },
  { id: 'kpi_day_winrate', label: 'Day win %', category: 'KPIs', icon: <CalendarIcon size={18} />, description: 'Procento ziskových obchodních dnů.', preview: <div className="text-purple-500 font-black text-xl">62.15%</div>, defaultRowSpan: 1 },
  { id: 'kpi_max_drawdown', label: 'Max Drawdown', category: 'KPIs', icon: <TrendingDown size={18} />, description: 'Největší propad kapitálu.', preview: <div className={`${COLORS.textLoss} font-black text-xl`}>12.4%</div>, defaultRowSpan: 1 },
  { id: 'prop_drawdown_room', label: 'DD prostor', category: 'KPIs', icon: <ShieldCheck size={18} />, description: 'Nejmenší prostor do prop-firm hard breach.', preview: <div className="text-emerald-500 font-black text-xl">$1 640</div>, defaultRowSpan: 1 },
  { id: 'discipline', label: 'Rituály & Disciplína', category: 'Chování', icon: <Brain size={18} />, description: 'Sleduje tvé ranní a večerní rituály.', preview: <div className="text-blue-500 font-black text-xs">Streak: 5 days</div>, defaultRowSpan: 2 },
  { id: 'winners_losers', label: 'Výhry a Prohry', category: 'Analýza', icon: <TrendingUp size={18} />, description: 'Statistické srovnání zisků a ztrát.', preview: <div className="flex gap-1"><div className={`w-4 h-4 ${COLORS.bgProfit} ${COLORS.borderProfit} border rounded`} /><div className={`w-4 h-4 ${COLORS.bgLoss} ${COLORS.borderLoss} border rounded`} /></div>, defaultRowSpan: 2 },
  { id: 'monthly_performance', label: 'Měsíční Výkonnost', category: 'Analýza', icon: <CalendarIcon size={18} />, description: 'Měsíční přehled ziskovosti s heatmapou.', preview: <div className="grid grid-cols-4 gap-0.5"><div className="w-2 h-2 bg-emerald-500/40" /><div className="w-2 h-2 bg-emerald-500/80" /><div className="w-2 h-2 bg-emerald-500/20" /><div className="w-2 h-2 bg-rose-500/40" /></div>, defaultRowSpan: 2 },
  { id: 'equity', label: 'Equity Curve', category: 'Analýza', icon: <Activity size={20} />, description: 'Vizuální cesta tvého kapitálu.', preview: <div className="h-12 w-full px-2 flex items-center"><svg viewBox="0 0 100 40" className="w-full h-full stroke-blue-500 fill-none stroke-[3] opacity-60"><path d="M0,35 Q20,30 40,32 T70,10 T100,5" strokeLinecap="round" /></svg></div>, defaultRowSpan: 2 },
  { id: 'session_performance', label: 'Výkon Sessions', category: 'Analýza', icon: <Globe size={18} />, description: 'Výkon rozdělený podle seancí.', preview: <div className="text-orange-500 font-black text-xs">NY Peak</div>, defaultRowSpan: 2 },
  { id: 'hourly_edge', label: 'Hodinový Výkon', category: 'Analýza', icon: <Clock size={18} />, description: 'Výkonnost podle hodin.', preview: <div className="text-blue-500 font-black text-xs">NY Open</div>, defaultRowSpan: 2 },
  { id: 'daily_edge', label: 'Denní Výkon', category: 'Analýza', icon: <CalendarIcon size={18} />, description: 'Výkonnost podle dnů v týdnu.', preview: <div className="text-blue-500 font-black text-xs">Tue/Thu Focus</div>, defaultRowSpan: 2 },
  { id: 'calendar', label: 'Obchodní Kalendář', category: 'Analýza', icon: <CalendarIcon size={18} />, description: 'Denní zisky v kalendáři.', preview: <div className={`${COLORS.textProfit} font-black text-xs`}>Green Month</div>, defaultRowSpan: 3 },
  { id: 'daily_insight', label: 'Insight Dne (AI)', category: 'KPIs', icon: <Sparkles size={18} />, description: 'Coach každý den vygeneruje jeden personalizovaný insight z tvé historie.', preview: <div className="text-purple-500 font-black text-xs">Sparkles ✨</div>, defaultRowSpan: 1 },
  { id: 'daily_focus', label: 'Dnes Hlídat', category: 'Chování', icon: <Target size={18} />, description: 'Aktivní Iron Rules a checklisty z AI Coache — připomínka co dnes hlídat.', preview: <div className="text-blue-500 font-black text-xs">📋 3 pravidla</div>, defaultRowSpan: 2 },
  { id: 'lab_top_leak', label: 'Největší Leak (Lab)', category: 'Chování', icon: <Droplets size={18} />, description: 'Top nález deterministických Lab detektorů — co tě teď stojí nejvíc peněz.', preview: <div className="text-rose-500 font-black text-xs">Revenge −$420</div>, defaultRowSpan: 1 },
  { id: 'bt_avg_r', label: 'Avg R / Expectancy', category: 'Backtest', icon: <Target size={18} />, description: 'Průměrný R-multiple a expectancy na obchod.', preview: <div className="text-violet-500 font-black text-xl">+1.38R</div>, defaultRowSpan: 1 },
  { id: 'bt_confluence_wr', label: 'WR dle confluencí', category: 'Backtest', icon: <Layers size={18} />, description: 'Win rate podle počtu confluencí — testuje „víc confluencí = vyšší WR".', preview: <div className="text-violet-500 font-black text-xs">0→4+ conf.</div>, defaultRowSpan: 2 },
  { id: 'bt_sample_size', label: 'Sample-size', category: 'Backtest', icon: <BarChart3 size={18} />, description: 'Statistická důvěra tvého vzorku obchodů.', preview: <div className="text-violet-500 font-black text-xs">solidní vzorek</div>, defaultRowSpan: 1 },
  { id: 'bt_monte_carlo', label: 'Monte Carlo', category: 'Backtest', icon: <Activity size={18} />, description: '500 simulací náhodného pořadí obchodů — rozptyl výsledků, max DD, riziko ztráty.', preview: <div className="text-violet-500 font-black text-xs">P5–P95 fan</div>, defaultRowSpan: 2 },
];

// Widgety dostupné v backtest světě (subset live + backtest specifické). Žádné rituály,
// challenge cíl, execution %, AI insight/review ani „dnes hlídat" (to je live coaching).
const BACKTEST_WIDGET_IDS = new Set<string>([
  'kpi_pnl', 'kpi_winrate', 'kpi_profit_factor', 'avg_win_loss', 'kpi_day_winrate', 'kpi_max_drawdown',
  'streak', 'discipline_streak',
  'equity', 'winners_losers', 'monthly_performance', 'session_performance', 'hourly_edge', 'daily_edge', 'calendar',
  'lab_top_leak',
  'bt_avg_r', 'bt_confluence_wr', 'bt_sample_size', 'bt_monte_carlo',
]);

// Widgety, které patří VÝHRADNĚ do backtest světa (mimo něj se nenabízí ani nerenderují).
// bt_monte_carlo zde NENÍ — Monte Carlo je užitečné i pro live ("je živá edge reálná?").
const BACKTEST_ONLY_IDS = new Set<string>(['bt_avg_r', 'bt_confluence_wr', 'bt_sample_size']);

/** Výchozí konfigurace nového widgetu pro breakpoint (malé KPI vs. velké karty). */
function newWidgetConfig(id: string, bp: string): DashboardWidgetConfig | null {
  const template = MASTER_WIDGET_LIST.find(m => m.id === id);
  if (!template) return null;
  const isKpi = (template as { defaultRowSpan?: number }).defaultRowSpan === 1;
  const isXxl = bp === 'xxl';
  return {
    id: template.id,
    label: template.label,
    visible: true,
    x: 0,
    y: Infinity,
    w: isKpi ? (isXxl ? 4 : 2) : (isXxl ? 12 : 6),
    h: isKpi ? 2 : 4,
    minW: isKpi ? (isXxl ? 3 : 2) : (isXxl ? 6 : 4),
    minH: isKpi ? 2 : 3,
    maxW: isKpi ? (isXxl ? 8 : 6) : (isXxl ? 24 : 12),
    maxH: isKpi ? 4 : 8,
  };
}

// Na telefonu stojí ve dvojici vedle sebe jen čisté číselné karty (jedno číslo
// + popisek); složitější malé widgety jdou výchozí přes celou šířku.
const PAIRABLE_KPI_IDS = new Set([
  'kpi_pnl', 'kpi_winrate', 'kpi_profit_factor', 'kpi_day_winrate',
  'kpi_max_drawdown', 'kpi_execution_rate', 'discipline_streak',
]);
const canHalfOnPhone = (id: string) => (MASTER_WIDGET_LIST.find(m => m.id === id) as { defaultRowSpan?: number } | undefined)?.defaultRowSpan === 1;
const halfOnPhoneByDefault = (id: string) => PAIRABLE_KPI_IDS.has(id);
const EDITABLE_BREAKPOINTS = new Set(['xxl', 'lg', 'md']);
/** Kde widget „držíš“ při tažení z knihovny (od levého horního rohu). */
const DRAG_GRAB = { x: 48, y: 22 };

/** Štítek „6 × 4“ v rohu měněného widgetu — přímo v DOM, ne přes stav. */
function showResizeBadge(element: HTMLElement, w: number, h: number, atMin: boolean) {
  let badge = element.querySelector<HTMLSpanElement>(':scope > .dbe-size');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'dbe-size';
    element.appendChild(badge);
  }
  badge.classList.toggle('dbe-size-min', atMin);
  badge.textContent = `${w} × ${h}${atMin ? ' · minimum' : ''}`;
}

// Module-level mouse tracker — no re-renders, just reads position at tooltip render time
let _mx = 0, _my = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('mousemove', (e) => { _mx = e.clientX; _my = e.clientY; }, { passive: true });
}

function chartTooltipStyle(width = 200): React.CSSProperties {
  const pad = 12;
  const showLeft = _mx > window.innerWidth * 0.55;
  return {
    position: 'fixed',
    left: showLeft ? Math.max(pad, _mx - width - 16) : Math.min(_mx + 16, window.innerWidth - width - pad),
    top: Math.max(pad, Math.min(_my - 60, window.innerHeight - 200)),
    zIndex: 9999,
    pointerEvents: 'none',
    width,
  };
}

const CustomKpiTooltip = (props: any) => {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const data = payload[0].payload;
  const value = payload[0].value ?? 0;

  return createPortal(
    <div style={chartTooltipStyle(180)} className="px-3 py-2 rounded-xl border shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-150 theme-card theme-border">
      <p className="text-[11px] font-semibold mb-1 opacity-50">{data.name || data.label}</p>
      <p className="text-xs font-black flex items-center gap-2">
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: data.fill || payload[0].color }}></span>
        {value > 0 ? '+' : value < 0 ? '-' : ''}{Number(Math.abs(value)).toLocaleString(undefined, { maximumFractionDigits: 0 })} {data.unit || '$'}
      </p>
    </div>,
    document.body
  );
};

const CustomEdgeTooltip = (props: any) => {
  const { active, payload, label, theme } = props;
  if (!active || !payload?.length) return null;
  const data = payload[0].payload;
  const profit = data.profit || 0;
  const loss = Math.abs(data.loss || 0);
  const net = profit - loss;

  return createPortal(
    <div style={chartTooltipStyle(200)} className={`p-4 rounded-2xl border shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150 ${theme === 'oled' ? 'bg-black border-white/10 text-white' :
      theme === 'dark' ? 'bg-[var(--bg-card)]/95 border-[var(--border-subtle)] text-white' :
        'bg-[var(--bg-card)]/95 border-[var(--border-subtle)] text-[var(--text-primary)]'
      }`}>
      <div className={`flex justify-between items-center mb-3 pb-2 border-b ${theme !== 'light' ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
        <span className="font-semibold text-sm tracking-tight">{label}</span>
        <span className="text-[10px] font-bold text-slate-500">{data.trades} Trades</span>
      </div>
      <div className="space-y-1.5">
        <div className="flex justify-between items-center text-xs">
          <span className="text-slate-500 font-medium">Hrubý zisk:</span>
          <span className={`${COLORS.textProfit} font-black`}>+${profit.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
        </div>
        <div className="flex justify-between items-center text-xs">
          <span className="text-slate-500 font-medium">Hrubá ztráta:</span>
          <span className={`${COLORS.textLoss} font-black`}>-${loss.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
        </div>
        <div className={`flex justify-between items-center pt-2 mt-1 border-t ${theme !== 'light' ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
          <span className="text-[11px] font-semibold text-slate-400">Čisté PnL:</span>
          <p className={`text-sm font-black font-mono ${net >= 0 ? COLORS.textProfit : COLORS.textLoss}`}>
            {net >= 0 ? '+' : '-'}${Math.abs(net).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </p>
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-[11px] font-semibold text-slate-500">Win Rate:</span>
          <span className="text-xs font-black text-blue-500">{(data.winRate || 0).toFixed(1)}%</span>
        </div>
      </div>
    </div>,
    document.body
  );
};

const renderActiveShape = (props: any) => {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill } = props;
  return (
    <g>
      <Sector
        cx={cx}
        cy={cy}
        innerRadius={innerRadius}
        outerRadius={outerRadius + 4}
        startAngle={startAngle}
        endAngle={endAngle}
        fill={fill}
        style={{
          filter: 'drop-shadow(0 0 8px rgba(0,0,0,0.3))',
          transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
        }}
      />
    </g>
  );
};

const CustomActiveBar = (props: any) => {
  const { fill, x, y, width, height, value, index, activeIndex, layout = 'horizontal' } = props;

  // COMPLETELY HIDE 0-VALUE BARS to prevent "ghost lines"
  // For stacked bars, value is often an array [start, end]
  const val = Array.isArray(value) ? (value[1] - value[0]) : value;
  if (!val || Math.abs(val) < 0.1) return null;

  const isBarHovered = index === activeIndex;

  // More aggressive expansion when hovered
  const expansion = isBarHovered ? 12 : 0;

  // Recharts layout="horizontal" means bars are vertical -> we expand width
  // Recharts layout="vertical" means bars are horizontal -> we expand height
  const expandWidth = layout === 'horizontal';

  const newX = expandWidth ? x - expansion / 2 : x;
  const newY = expandWidth ? y : y - expansion / 2;
  const newW = expandWidth ? width + expansion : width;
  const newH = expandWidth ? height : height + expansion;

  const glowRaw = fill?.includes('Profit') ? COLORS.profit : fill?.includes('Loss') ? COLORS.loss : fill;

  return (
    <g>
      <Rectangle
        {...props}
        x={newX}
        y={newY}
        width={newW}
        height={newH}
        fill={fill}
        fillOpacity={1}
        stroke="none"
        style={{
          filter: isBarHovered ? `drop-shadow(0 0 20px ${glowRaw || '#fff'})` : 'none',
          transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          cursor: 'pointer'
        }}
      />
    </g>
  );
};

const ProKpiCard: React.FC<{
  label: string;
  value: string;
  subValue?: string;
  theme: 'dark' | 'light' | 'oled';
  icon?: React.ReactNode;
  sampleSize?: number;
  type?: 'text' | 'gauge' | 'donut' | 'balance';
  data?: any;
  info?: string;
}> = ({ label, value, subValue, theme, icon, sampleSize, type = 'text', data, info }) => {
  const isDark = theme !== 'light';
  const [activeIndex, setActiveIndex] = useState(-1);
  const onPieEnter = (_: any, index: number) => setActiveIndex(index);
  const onPieLeave = () => setActiveIndex(-1);

  // Helper to remove unnecessary .00 decimals.
  // Zachová sufixy (R, %, Kč, €) a prefixy (+/-) — bug-fix: dřív zahodil 'R'
  // protože poslední větev parseFloat→toString stripla non-number suffix.
  const displayValue = useMemo(() => {
    if (!value.includes('.')) return value;
    // Percentage
    if (value.endsWith('%')) {
      const num = parseFloat(value.replace('%', ''));
      return `${num}%`;
    }
    // R-multiple (např. "+4.38R") — vrať as-is, zachovej R a znaménko
    if (value.endsWith('R')) return value;
    // CZK / EUR — zachovej as-is
    if (value.endsWith('Kč') || value.endsWith('€')) return value;
    // USD
    if (value.includes('$')) {
      const num = parseFloat(value.replace(/[+\-$,]/g, ''));
      if (isNaN(num)) return value;
      const sign = value.trim().startsWith('+') ? '+' : value.trim().startsWith('-') ? '-' : '';
      return `${sign}$${num.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    }
    const num = parseFloat(value);
    return isNaN(num) ? value : num.toString();
  }, [value]);

  const renderVisual = () => {
    if (type === 'gauge') {
      const isDays = label.toLowerCase().includes('day');
      const unit = isDays ? 'Dní' : 'Obchodů';
      const gaugeData = [
        { name: `Vítězné ${unit.toLowerCase()}`, value: data.wins || 0, fill: COLORS.profit, unit },
        { name: `BE ${unit.toLowerCase()}`, value: data.be || 0, fill: '#3b82f6', unit },
        { name: `Ztrátové ${unit.toLowerCase()}`, value: data.losses || 0, fill: COLORS.loss, unit },
        { name: `Zmeškané ${unit.toLowerCase()}`, value: data.missed || 0, fill: '#64748b', unit },
      ].filter(d => d.value >= 0);
      const chartData = gaugeData.filter(d => d.value > 0);
      if (chartData.length === 0) chartData.push({ name: 'Žádná data', value: 1, fill: isDark ? '#334155' : '#e2e8f0', unit: '' });
      return (
        <div className="flex flex-col items-center w-full">
          <span className="text-2xl font-bold tracking-tight tabular-nums leading-none mb-1">
            {displayValue}
          </span>
          <div className="h-16 w-full max-w-[140px] min-w-[1px] min-h-[1px] relative">
            <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
              <PieChart {...({ overflow: 'visible' } as any)}>
                <defs>
                  <linearGradient id="kpiProfitGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.profit} /><stop offset="100%" stopColor={COLORS.profitBottom} /></linearGradient>
                  <linearGradient id="kpiLossGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.loss} /><stop offset="100%" stopColor={COLORS.lossBottom} /></linearGradient>
                </defs>
                <RechartsTooltip content={<CustomKpiTooltip theme={theme} />} wrapperStyle={{ background: 'transparent', border: 'none', boxShadow: 'none', padding: 0 }} />
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="100%"
                  startAngle={180}
                  endAngle={0}
                  innerRadius="60%"
                  outerRadius="100%"
                  paddingAngle={3}
                  dataKey="value"
                  stroke="none"
                  {...({ activeIndex, activeShape: renderActiveShape, onMouseEnter: onPieEnter, onMouseLeave: onPieLeave } as any)}
                >
                  {chartData.map((entry, index) => {
                    let fill = entry.fill;
                    if (fill === COLORS.profit) fill = "url(#kpiProfitGrad)";
                    if (fill === COLORS.loss) fill = "url(#kpiLossGrad)";
                    return <Cell key={`cell-${index}`} fill={fill} className="transition-all duration-300" />;
                  })}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-3 mt-1.5">
            {data.wins !== undefined && (
              <SmartTooltip text={`Vítězné ${unit.toLowerCase()}`} subtext={`${data.wins} ${unit}`} color={COLORS.profit} theme={theme}>
                <div className="relative group" onMouseEnter={() => { const idx = chartData.findIndex(d => d.fill === COLORS.profit); if (idx >= 0) setActiveIndex(idx); }} onMouseLeave={() => setActiveIndex(-1)}>
                  <span className={`${COLORS.textProfit} text-[11px] font-bold tabular-nums cursor-help min-w-[18px] text-center block`}>{data.wins}</span>
                </div>
              </SmartTooltip>
            )}
            {data.be !== undefined && data.be > 0 && (
              <SmartTooltip text={`BE ${unit.toLowerCase()}`} subtext={`${data.be} ${unit}`} color="#3b82f6" theme={theme}>
                <div className="relative" onMouseEnter={() => { const idx = chartData.findIndex(d => d.fill === '#3b82f6'); if (idx >= 0) setActiveIndex(idx); }} onMouseLeave={() => setActiveIndex(-1)}>
                  <span className="text-blue-500 text-[11px] font-bold tabular-nums cursor-help min-w-[18px] text-center block">{data.be}</span>
                </div>
              </SmartTooltip>
            )}
            {data.losses !== undefined && (
              <SmartTooltip text={`Ztrátové ${unit.toLowerCase()}`} subtext={`${data.losses} ${unit}`} color={COLORS.loss} theme={theme}>
                <div className="relative" onMouseEnter={() => { const idx = chartData.findIndex(d => d.fill === COLORS.loss); if (idx >= 0) setActiveIndex(idx); }} onMouseLeave={() => setActiveIndex(-1)}>
                  <span className={`${COLORS.textLoss} text-[11px] font-bold tabular-nums cursor-help min-w-[18px] text-center block`}>{data.losses}</span>
                </div>
              </SmartTooltip>
            )}
            {data.missed !== undefined && data.missed > 0 && (
              <SmartTooltip text={`Zmeškané ${unit.toLowerCase()}`} subtext={`${data.missed} ${unit}`} color="#64748b" theme={theme}>
                <div className="relative" onMouseEnter={() => { const idx = chartData.findIndex(d => d.fill === '#64748b'); if (idx >= 0) setActiveIndex(idx); }} onMouseLeave={() => setActiveIndex(-1)}>
                  <span className={`text-[var(--text-muted)] text-[11px] font-bold tabular-nums cursor-help min-w-[18px] text-center block`}>{data.missed}</span>
                </div>
              </SmartTooltip>
            )}
          </div>
        </div>
      );
    }
    if (type === 'donut') {
      const donutData = [{ name: 'Hrubý zisk', value: data.profit || 0, fill: COLORS.profit, unit: '$' }, { name: 'Hrubá ztráta', value: data.loss || 0, fill: COLORS.loss, unit: '$' }];
      const chartData = donutData.filter(d => d.value > 0);
      if (chartData.length === 0) chartData.push({ name: 'Žádná data', value: 1, fill: isDark ? '#334155' : '#e2e8f0', unit: '' });
      return (
        <div className="flex flex-col items-center">
          <div className="h-16 w-16 lg:h-20 lg:w-20 min-w-[1px] min-h-[1px] cursor-pointer relative">
            <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
              <PieChart {...({ overflow: 'visible' } as any)}>
                <defs>
                  <linearGradient id="donutProfitGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.profit} /><stop offset="100%" stopColor={COLORS.profitBottom} /></linearGradient>
                  <linearGradient id="donutLossGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.loss} /><stop offset="100%" stopColor={COLORS.lossBottom} /></linearGradient>
                </defs>
                <RechartsTooltip content={<CustomKpiTooltip theme={theme} />} wrapperStyle={{ background: 'transparent', border: 'none', boxShadow: 'none', padding: 0 }} />
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius="70%"
                  outerRadius="100%"
                  paddingAngle={0}
                  dataKey="value"
                  stroke="none"
                  {...({ activeIndex, activeShape: renderActiveShape, onMouseEnter: onPieEnter, onMouseLeave: onPieLeave } as any)}
                >
                  {chartData.map((entry, index) => {
                    let fill = entry.fill;
                    if (fill === COLORS.profit) fill = "url(#donutProfitGrad)";
                    if (fill === COLORS.loss) fill = "url(#donutLossGrad)";
                    return <Cell key={`cell-${index}`} fill={fill} className="transition-all duration-300" />;
                  })}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="text-[13px] font-bold tracking-tight tabular-nums text-[var(--text-primary)]">{displayValue}</span>
            </div>
          </div>
          <div className="flex gap-2 mt-2.5">
            <div className="relative" onMouseEnter={() => { const idx = chartData.findIndex(d => d.fill === COLORS.profit); if (idx >= 0) setActiveIndex(idx); }} onMouseLeave={() => setActiveIndex(-1)}>
              <SmartTooltip text="Hrubý zisk" subtext={`$${(data.profit || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`} color={COLORS.profit} theme={theme}>
                <div className="w-2 h-2 rounded-full bg-emerald-500 cursor-help" />
              </SmartTooltip>
            </div>
            <div className="relative" onMouseEnter={() => { const idx = chartData.findIndex(d => d.fill === COLORS.loss); if (idx >= 0) setActiveIndex(idx); }} onMouseLeave={() => setActiveIndex(-1)}>
              <SmartTooltip text="Hrubá ztráta" subtext={`$${(data.loss || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`} color={COLORS.loss} theme={theme}>
                <div className="w-2 h-2 rounded-full bg-rose-500 cursor-help" />
              </SmartTooltip>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="p-4 rounded-lg flex flex-col justify-between h-full relative overflow-visible border border-[var(--border-subtle)] bg-[var(--bg-card)] transition-colors">
      <div className="flex justify-between items-start mb-2">
        <div className="text-[11px] font-semibold text-[var(--text-secondary)] flex items-center gap-1.5">
          {label}
          {info && <SmartTooltip text="Info" subtext={info} theme={theme}><div className="p-1 -m-1 cursor-help"><Info size={13} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors" /></div></SmartTooltip>}
        </div>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center min-h-[60px]">
        {type === 'text' && (
          <div className="text-center">
            <p className="text-2xl lg:text-[28px] font-bold tracking-tight tabular-nums leading-none">{displayValue}</p>
            {subValue && <p className="text-[11px] font-medium theme-text-secondary mt-2">{subValue}</p>}
          </div>
        )}
        {renderVisual()}
      </div>
    </div >
  );
};

const MobileKpiCarousel: React.FC<{ widgets: DashboardWidgetConfig[], renderWidget: (id: string, config?: DashboardWidgetConfig) => React.ReactNode, theme: 'dark' | 'light' | 'oled' }> = ({ widgets, renderWidget, theme }) => {
  const [index, setIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const isDark = theme !== 'light';
  const autoRotateInterval = 5000;
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const resetTimeout = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  useEffect(() => {
    if (isPaused) {
      resetTimeout();
      return;
    }

    resetTimeout();
    timeoutRef.current = setTimeout(() => {
      setIndex((prevIndex) => (prevIndex + 1) % widgets.length);
    }, autoRotateInterval);

    return () => resetTimeout();
  }, [index, widgets.length, resetTimeout, isPaused]);

  if (widgets.length === 0) return null;

  const extendedWidgets = widgets.length > 1 ? [...widgets, widgets[0]] : widgets;

  return (
    <div
      className="lg:hidden w-full relative group"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onTouchStart={() => setIsPaused(true)}
      onTouchEnd={() => setIsPaused(false)}
    >
      <div className="overflow-hidden py-1">
        <motion.div
          className="flex gap-4"
          drag="x"
          dragConstraints={{ left: 0, right: 0 }}
          onDragStart={() => setIsPaused(true)}
          onDragEnd={(_, info) => {
            setIsPaused(false);
            if (info.offset.x < -50) setIndex((index + 1) % widgets.length);
            else if (info.offset.x > 50) setIndex((index - 1 + widgets.length) % widgets.length);
          }}
          animate={{ x: `calc(-${index * 50}% - ${index * 8}px)` }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
        >
          {extendedWidgets.map((widget, i) => (
            <div key={`${widget.id}-${i}`} className="min-w-[calc(50%-8px)] pb-1">
              <div className="h-[215px]">
                {renderWidget(widget.id, widget)}
              </div>
            </div>
          ))}
        </motion.div>
      </div>
    </div>
  );
};

const WinnersLosersWidget: React.FC<{ stats: TradeStats, theme: 'dark' | 'light' | 'oled', pnlDisplayMode: PnLDisplayMode, initialBalance: number, currency: any, rates: any }> = ({ stats, theme, pnlDisplayMode, initialBalance, currency, rates }) => {
  const riskStats = useMemo(() => calculateRStatistics(stats.trades), [stats.trades]);
  const formatVal = (val: number, mode: PnLDisplayMode = pnlDisplayMode, bal?: number, rr?: number | null, sign: boolean = true) => {
    return formatPnL(val, mode, bal, rr, sign, currency, rates);
  };
  const isDark = theme !== 'light';
  const formatDur = (mins: number) => {
    if (!mins || mins === 0) return "0m";
    if (mins < 1) return "< 1m";
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };
  const Row = ({ label, value, color, info }: any) => (
    <div className={`flex justify-between items-center py-2 border-b last:border-0 ${theme !== 'light' ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
      <span className="text-[11px] font-bold text-slate-500 flex items-center gap-1 tracking-tight">
        {label}
        {info && <InfoIcon text={info} theme={theme} />}
      </span>
      <span className={`text-xs font-black ${value === '—' ? 'text-slate-400' : color || (isDark ? 'text-white' : 'text-slate-900')}`}>{value}</span>
    </div>
  );
  return (
    <div className="p-6 rounded-[32px] transition-all relative h-full flex flex-col justify-between overflow-hidden glass-panel">
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-[13px] font-bold flex items-center gap-2 text-[var(--text-primary)]">
          <TrendingUp size={16} className="text-emerald-500" /> Výhry a Prohry
          <SmartTooltip text="Info" subtext="Detailní statistický rozbor vašich ziskových a ztrátových obchodů." theme={theme}><div className="p-1 -m-1 cursor-help"><Info size={14} className="text-slate-500 opacity-40 hover:opacity-100 transition-opacity" /></div></SmartTooltip>
        </h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1">
        <div className={`p-4 rounded-2xl border ${isDark ? 'bg-emerald-500/5 border-emerald-500/10' : 'bg-emerald-50 border-emerald-100'}`}>
          <h4 className={`text-[11px] font-semibold ${COLORS.textProfit} mb-4 flex items-center gap-2`}><ArrowUp size={12} /> Ziskové Obchody</h4>
          <div className="space-y-1">
            <Row label="Nejlepší zisk" value={formatVal(stats.maxWin, pnlDisplayMode, initialBalance, riskStats.maxWin)} color={COLORS.textProfit} />
            <Row label="Průměrný zisk" value={formatVal(stats.avgWin, pnlDisplayMode, initialBalance, riskStats.avgWin)} color={COLORS.textProfit} />
            <Row label="Průměrná doba" value={formatDur(stats.avgDurationWin)} />
            <Row label="Max v řadě" value={stats.maxConsecutiveWins} />
          </div>
        </div>
        <div className={`p-4 rounded-2xl border ${isDark ? 'bg-rose-500/5 border-rose-500/10' : 'bg-rose-50 border-rose-100'}`}>
          <h4 className={`text-[11px] font-semibold ${COLORS.textLoss} mb-4 flex items-center gap-2`}><ArrowDown size={12} /> Ztrátové Obchody</h4>
          <div className="space-y-1">
            <Row label="Nejhorší ztráta" value={formatVal(stats.maxLoss, pnlDisplayMode, initialBalance, riskStats.maxLoss)} color={COLORS.textLoss} />
            <Row label="Průměrná ztráta" value={formatVal(-stats.avgLoss, pnlDisplayMode, initialBalance, riskStats.avgLoss)} color={COLORS.textLoss} />
            <Row label="Průměrná doba" value={formatDur(stats.avgDurationLoss)} />
            <Row label="Max v řadě" value={stats.maxConsecutiveLosses} />
          </div>
        </div>
      </div>
    </div>
  );
};

const PerformanceByMonthWidget: React.FC<{ monthlyData: MonthlyData[], theme: 'dark' | 'light' | 'oled' }> = ({ monthlyData, theme }) => {
  const isDark = theme !== 'light';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [view, setView] = useState<'individual' | 'accum'>('individual');
  const [unit, setUnit] = useState<'pct' | 'val'>('pct');
  const getIntensity = (val: number) => {
    if (val === 0) return isDark ? 'bg-[var(--bg-page)]/50' : 'bg-slate-50';
    if (val > 0) {
      if (val > 10) return 'bg-emerald-500 text-white';
      if (val > 5) return 'bg-emerald-500/80 text-white';
      if (val > 2) return 'bg-emerald-500/60 text-white';
      return 'bg-emerald-500/30 text-emerald-500';
    } else {
      const abs = Math.abs(val);
      if (abs > 10) return 'bg-rose-500 text-white';
      if (abs > 5) return 'bg-rose-500/80 text-white';
      if (abs > 2) return 'bg-rose-500/60 text-white';
      return 'bg-rose-500/30 text-rose-500';
    }
  };
  return (
    <div className="p-6 rounded-[32px] h-full flex flex-col overflow-hidden glass-panel">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <h3 className="text-[13px] font-bold flex items-center gap-2 text-[var(--text-primary)]">
          Měsíční Výkonnost
          <InfoIcon text="Měsíční přehled vaší ziskovosti. Intenzita barvy odpovídá velikosti zisku nebo ztráty." theme={theme} />
        </h3>
        <div className="flex gap-4 items-center">
          <div className={`flex ${isDark ? 'bg-theme-page/50 border-white/5' : 'bg-slate-200/50 border-slate-300'} p-1 rounded-lg border text-[11px] font-semibold`}>
            <button onClick={() => setView('individual')} className={`px-2 py-1 rounded ${view === 'individual' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>Individual</button>
            <button onClick={() => setView('accum')} className={`px-2 py-1 rounded ${view === 'accum' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>Accum</button>
          </div>
          <div className={`flex ${isDark ? 'bg-theme-page/50 border-white/5' : 'bg-slate-200/50 border-slate-300'} p-1 rounded-lg border text-[11px] font-semibold`}>
            <button onClick={() => setUnit('pct')} className={`px-2 py-1 rounded ${unit === 'pct' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>% Gain</button>
            <button onClick={() => setUnit('val')} className={`px-2 py-1 rounded ${unit === 'val' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>$ Value</button>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto custom-scrollbar max-w-full">
        <table className="w-full min-w-[800px] border-separate border-spacing-2">
          <thead>
            <tr>
              <th className="w-16"></th>
              {months.map(m => <th key={m} className={`p-3 rounded-xl text-[11px] font-semibold text-slate-500 ${theme !== 'light' ? 'bg-[var(--bg-page)]/30' : 'bg-slate-50'}`}>{m}</th>)}
              <th className="p-3 rounded-xl bg-blue-600/10 text-[11px] font-semibold text-blue-500">Total</th>
            </tr>
          </thead>
          <tbody>
            {monthlyData.map(yearRow => (
              <tr key={yearRow.year}>
                <td className={`p-3 rounded-xl text-[10px] font-black text-center text-slate-300 ${theme !== 'light' ? 'bg-[var(--bg-page)]/50' : 'bg-slate-100'}`}>{yearRow.year}</td>
                {months.map((_, i) => {
                  const mData = yearRow.months[i];
                  const val = mData ? (unit === 'pct' ? mData.gainPct : mData.pnl) : 0;
                  return (
                    <td key={i} className={`p-3 rounded-xl text-[10px] font-bold text-center transition-all ${getIntensity(val)}`}>
                      {mData ? (val > 0 ? '+' : val < 0 ? '-' : '') + Math.abs(val).toLocaleString(undefined, { maximumFractionDigits: unit === 'pct' ? 2 : 0 }) + (unit === 'pct' ? '%' : '$') : '-'}
                    </td>
                  );
                })}
                <td className={`p-3 rounded-xl text-[10px] font-bold text-center ${getIntensity(unit === 'pct' ? yearRow.yearlyGainPct : yearRow.yearlyPnl)}`}>
                  {(yearRow.yearlyPnl > 0 ? '+' : yearRow.yearlyPnl < 0 ? '-' : '') + Math.abs(unit === 'pct' ? yearRow.yearlyGainPct : yearRow.yearlyPnl).toLocaleString(undefined, { maximumFractionDigits: unit === 'pct' ? 2 : 0 }) + (unit === 'pct' ? '%' : '$')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// Dny v týdnu — stejné pořadí jako getDay() (0=Ne), musí sedět s analysis.ts.
const WEEKDAY_LABELS = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];

// Drill-down modal: seznam obchodů dané hodiny / dne. Klik na obchod → onOpenTrade (detail).
const EdgeDrilldownModal: React.FC<{
  title: string;
  subtitle?: string;
  trades: Trade[];
  theme: 'dark' | 'light' | 'oled';
  formatTradePnl: (t: Trade) => string;
  onOpenTrade: (t: Trade) => void;
  onClose: () => void;
}> = ({ title, subtitle, trades, theme, formatTradePnl, onOpenTrade, onClose }) => {
  const isDark = theme !== 'light';
  const sorted = [...trades].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className={`relative w-full max-w-md max-h-[80vh] flex flex-col rounded-[24px] overflow-hidden shadow-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] backdrop-blur-2xl`}
        onClick={e => e.stopPropagation()}
      >
        <div className={`flex items-center justify-between p-5 border-b ${isDark ? 'border-white/10' : 'border-slate-100'}`}>
          <div className="flex flex-col">
            <h3 className="text-sm font-semibold">{title}</h3>
            <span className="text-[10px] font-bold text-slate-500 mt-0.5">
              {subtitle ? subtitle + ' · ' : ''}{trades.length} {trades.length === 1 ? 'obchod' : (trades.length >= 2 && trades.length <= 4 ? 'obchody' : 'obchodů')}
              {' · '}<span className={totalPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}>{totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString('en-US')}</span>
            </span>
          </div>
          <button onClick={onClose} className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-white/10' : 'hover:bg-slate-100'}`}><X size={18} /></button>
        </div>
        <div className="overflow-y-auto p-3 flex flex-col gap-2">
          {sorted.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-sm">Žádné obchody</div>
          ) : sorted.map(t => {
            const rr = t.riskAmount ? (t.pnl || 0) / t.riskAmount : null;
            const isMissed = t.executionStatus === 'Missed';
            return (
              <div
                key={t.id}
                onClick={() => onOpenTrade(t)}
                className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition-all hover:scale-[1.01] bg-[var(--bg-page)] border-[var(--border-subtle)] hover:shadow-md ${isMissed ? 'opacity-60' : ''}`}
              >
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-black truncate">{String(t.direction || '').toUpperCase()} {t.instrument || ''}</span>
                  <span className="text-[10px] font-bold text-slate-500 truncate">{t.date?.slice(0, 10)}{t.signal ? ' · ' + t.signal : ''}{t.session ? ' · ' + t.session : ''}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0 pl-2">
                  {rr != null && <span className={`text-[10px] font-black font-mono ${rr >= 0 ? 'text-emerald-500/70' : 'text-rose-500/70'}`}>{rr >= 0 ? '+' : ''}{rr.toFixed(2)}R</span>}
                  <span className={`text-sm font-black font-mono ${isMissed ? 'text-blue-400' : ((t.pnl || 0) >= 0 ? 'text-emerald-500' : 'text-rose-500')}`}>{isMissed ? '±' : formatTradePnl(t)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
};

const HourlyEdgeWidget: React.FC<{
  data: TimeStat[], theme: 'dark' | 'light' | 'oled',
  trades?: Trade[], onOpenTrade?: (t: Trade) => void, formatTradePnl?: (t: Trade) => string,
}> = ({ data, theme, trades = [], onOpenTrade, formatTradePnl }) => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [drillHour, setDrillHour] = useState<number | null>(null);

  const drillTrades = drillHour == null ? [] : trades.filter(t =>
    t.executionStatus !== 'Missed' && getTradeEntryDate(t).getHours() === drillHour
  );

  const handleBarClick = (e: any) => {
    if (!onOpenTrade || !e || e.activeLabel == null) return;
    const hr = parseInt(String(e.activeLabel), 10);
    if (!Number.isNaN(hr)) { setDrillHour(hr); setActiveIndex(null); } // vynuluj hover tooltip, ať nezůstane viset nad modalem
  };

  return (
    <div className="p-6 rounded-[32px] flex flex-col h-full overflow-visible glass-panel">
      <div className="flex justify-between items-center mb-8">
        <h3 className="text-[13px] font-bold flex items-center gap-2 text-[var(--text-primary)]">
          <Clock size={16} className="text-blue-500" /> Hodinový Výkon
          <InfoIcon text="Statistický výkon podle hodin. Zjistěte, ve které hodiny dne generujete největší zisk. Klikni na sloupec pro obchody dané hodiny." theme={theme} />
        </h3>
        <div className="flex gap-4 text-[11px] font-semibold text-slate-500">
          <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-emerald-500"></div> Profit</div>
          <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-rose-500"></div> Loss</div>
        </div>
      </div>
      <div className="w-full flex-1 min-h-0 mt-auto relative">
        <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
          <BarChart
            data={data}
            stackOffset="sign"
            margin={{ top: 10, right: 10, left: -20, bottom: 5 }}
            onMouseLeave={() => setActiveIndex(null)}
            onClick={handleBarClick}
            style={{ cursor: onOpenTrade ? 'pointer' : 'default' }}
          >
            <defs>
              <linearGradient id="hourlyProfitGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.profit} /><stop offset="100%" stopColor={COLORS.profitBottom} /></linearGradient>
              <linearGradient id="hourlyLossGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.loss} /><stop offset="100%" stopColor={COLORS.lossBottom} /></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border-subtle)" opacity={0.6} />
            <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#64748b', fontWeight: 'black' }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#64748b' }} tickFormatter={(val) => `$${Math.abs(val)}`} />
            <RechartsTooltip content={<CustomEdgeTooltip theme={theme} />} cursor={false} active={activeIndex !== null} wrapperStyle={{ background: 'transparent', border: 'none', boxShadow: 'none', padding: 0 }} />
            <ReferenceLine y={0} stroke={theme !== 'light' ? 'var(--text-muted)' : '#cbd5e1'} strokeWidth={1} />
            <Bar dataKey="profit" stackId="a" fill="url(#hourlyProfitGrad)" radius={[8, 8, 0, 0]} shape={(props: any) => <CustomActiveBar {...props} activeIndex={activeIndex} layout="horizontal" />} isAnimationActive={false} onMouseEnter={(_: any, idx: number) => setActiveIndex(idx)} onMouseLeave={() => setActiveIndex(null)} />
            <Bar dataKey="loss" stackId="a" fill="url(#hourlyLossGrad)" radius={[8, 8, 0, 0]} shape={(props: any) => <CustomActiveBar {...props} activeIndex={activeIndex} layout="horizontal" />} isAnimationActive={false} onMouseEnter={(_: any, idx: number) => setActiveIndex(idx)} onMouseLeave={() => setActiveIndex(null)} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {drillHour != null && onOpenTrade && formatTradePnl && (
        <EdgeDrilldownModal
          title={`${drillHour}:00 — ${drillHour + 1}:00`}
          subtitle="hodina vstupu"
          trades={drillTrades}
          theme={theme}
          formatTradePnl={formatTradePnl}
          onOpenTrade={(t) => { setDrillHour(null); onOpenTrade(t); }}
          onClose={() => setDrillHour(null)}
        />
      )}
    </div>
  );
};

const DailyEdgeWidget: React.FC<{
  data: TimeStat[], theme: 'dark' | 'light' | 'oled',
  trades?: Trade[], onOpenTrade?: (t: Trade) => void, formatTradePnl?: (t: Trade) => string,
}> = ({ data, theme, trades = [], onOpenTrade, formatTradePnl }) => {
  const tradingDays = data.filter(d => d.label !== 'So' && d.label !== 'Ne');
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [drillDay, setDrillDay] = useState<string | null>(null);

  const drillTrades = drillDay == null ? [] : trades.filter(t =>
    t.executionStatus !== 'Missed' && WEEKDAY_LABELS[new Date(t.date).getDay()] === drillDay
  );

  const handleBarClick = (e: any) => {
    if (!onOpenTrade || !e || e.activeLabel == null) return;
    setDrillDay(String(e.activeLabel)); setActiveIndex(null); // vynuluj hover tooltip, ať nezůstane viset nad modalem
  };

  // Calculate dynamic domain to center 0 and scale bars to utilize full width
  const maxAbsPnL = Math.max(
    ...tradingDays.map(d => Math.abs(d.profit || 0)),
    ...tradingDays.map(d => Math.abs(d.loss || 0)),
    1
  );

  return (
    <div className="p-6 rounded-[32px] flex flex-col h-full overflow-visible glass-panel">
      <div className="flex justify-between items-center mb-8">
        <h3 className="text-[13px] font-bold flex items-center gap-2 text-[var(--text-primary)]">
          <CalendarIcon size={16} className="text-indigo-500" /> Denní Výkon
          <InfoIcon text="Které dny v týdnu jsou pro vaši strategii nejziskovější? Pomáhá identifikovat dny pro zvýšení nebo snížení expozice." theme={theme} />
        </h3>
      </div>
      <div className="w-full flex-1 min-h-0 mt-auto relative">
        <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
          <BarChart
            layout="vertical"
            data={tradingDays}
            stackOffset="sign"
            margin={{ top: 5, right: 50, left: 10, bottom: 5 }}
            onMouseLeave={() => setActiveIndex(null)}
            onClick={handleBarClick}
            style={{ cursor: onOpenTrade ? 'pointer' : 'default' }}
          >
            <defs>
              <linearGradient id="dailyProfitGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={COLORS.profit} /><stop offset="100%" stopColor={COLORS.profitBottom} /></linearGradient>
              <linearGradient id="dailyLossGrad" x1="1" y1="0" x2="0" y2="0"><stop offset="0%" stopColor={COLORS.loss} /><stop offset="100%" stopColor={COLORS.lossBottom} /></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border-subtle)" opacity={0.6} />
            <XAxis type="number" hide domain={[-maxAbsPnL, maxAbsPnL]} />
            <YAxis dataKey="label" type="category" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#64748b', fontWeight: 'black' }} width={40} />
            <RechartsTooltip content={<CustomEdgeTooltip theme={theme} />} cursor={false} active={activeIndex !== null} wrapperStyle={{ background: 'transparent', border: 'none', boxShadow: 'none', padding: 0 }} />
            <ReferenceLine x={0} stroke={theme !== 'light' ? 'var(--text-muted)' : '#cbd5e1'} strokeWidth={1} />

            <Bar dataKey="profit" stackId="a" fill="url(#dailyProfitGrad)" radius={[0, 10, 10, 0]} shape={(props: any) => <CustomActiveBar {...props} activeIndex={activeIndex} layout="vertical" />} isAnimationActive={false} onMouseEnter={(_: any, idx: number) => setActiveIndex(idx)} onMouseLeave={() => setActiveIndex(null)}>
              <LabelList dataKey="winRate" position="right" content={(props: any) => {
                const { y, height, value } = props;
                return (
                  <g>
                    <text x="98%" y={y + height / 2 + 5} fill="#64748b" fontSize="10" fontWeight="black" textAnchor="end">
                      {value.toFixed(0)}%
                    </text>
                  </g>
                );
              }} />
            </Bar>

            <Bar dataKey="loss" stackId="a" fill="url(#dailyLossGrad)" radius={[0, 10, 10, 0]} shape={(props: any) => <CustomActiveBar {...props} activeIndex={activeIndex} layout="vertical" />} isAnimationActive={false} onMouseEnter={(_: any, idx: number) => setActiveIndex(idx)} onMouseLeave={() => setActiveIndex(null)} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {drillDay != null && onOpenTrade && formatTradePnl && (
        <EdgeDrilldownModal
          title={drillDay}
          subtitle="den v týdnu"
          trades={drillTrades}
          theme={theme}
          formatTradePnl={formatTradePnl}
          onOpenTrade={(t) => { setDrillDay(null); onOpenTrade(t); }}
          onClose={() => setDrillDay(null)}
        />
      )}
    </div>
  );
};

const SessionBreakdownWidget: React.FC<{ trades: any[], theme: 'dark' | 'light' | 'oled', configs: SessionConfig[] }> = ({ trades, theme, configs }) => {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  return (
    <div className="p-4 lg:p-6 rounded-[24px] lg:rounded-[32px] h-full flex flex-col overflow-visible glass-panel">
      <div className="flex justify-between items-center mb-4 lg:mb-6">
        <h3 className={`text-xs lg:text-sm font-semibold flex items-center gap-2 ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>
          <Globe size={16} className="text-blue-500" /> Výkon Sessions
          <InfoIcon text="Výkon podle obchodních seancí (Asie, Londýn, New York). Každá seance má jinou volatilitu a charakteristiku." theme={theme} />
        </h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 lg:gap-4 flex-1">
        {configs.map(cfg => {
          const startTime = cfg.startTime || '09:00';
          const endTime = cfg.endTime || '17:00';
          const [startH, startM] = startTime.split(':').map(Number);
          const [endH, endM] = endTime.split(':').map(Number);
          const startMin = startH * 60 + (startM || 0);
          const endMin = endH * 60 + (endM || 0);

          const sessionTrades = trades.filter(t => {
            if (t.executionStatus === 'Missed') return false; // missed nepočítej do session P&L
            const tm = getTradeEntryMinuteOfDay(t);
            return startMin <= endMin ? (tm >= startMin && tm < endMin) : (tm >= startMin || tm < endMin);
          });

          const pnl = sessionTrades.reduce((s, t) => s + t.pnl, 0);
          const isLive = startMin <= endMin ? (currentMinutes >= startMin && currentMinutes < endMin) : (currentMinutes >= startMin || currentMinutes < endMin);
          const sessionColor = cfg.color || '#3b82f6';

          return (
            <div key={cfg.id} className={`p-4 lg:p-5 rounded-xl lg:rounded-2xl border transition-all ${isLive ? 'border-blue-500/20 bg-blue-500/5 ring-1 ring-blue-500/30' : (theme !== 'light' ? 'bg-[var(--bg-page)]/40 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100')}`}>
              <div className="flex justify-between items-start mb-2 lg:mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: sessionColor }} />
                    <p className={`text-[11px] lg:text-[10px] font-semibold ${isLive ? (theme !== 'light' ? 'text-white' : 'text-slate-900') : 'text-slate-500'}`}>{cfg.name}</p>
                  </div>
                  <p className={`text-base lg:text-lg font-black ${pnl >= 0 ? COLORS.textProfit : COLORS.textLoss}`}>{pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                </div>
                {isLive && <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse shadow-[0_0_8px_rgba(59,130,246,0.5)]" />}
              </div>
              <p className="text-[9px] lg:text-[10px] font-bold text-slate-500">{sessionTrades.length} Trades</p>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Dashboard: React.FC<DashboardProps> = ({
  stats, labTopLeak, theme, preps, reviews, layouts, sessions, ironRules, onUpdateLayouts,
  isEditing, onCloseEdit, accounts, emotions, viewMode, dashboardMode,
  setDashboardMode, onDeleteTrade, onUpdateTrade, user, pnlDisplayMode, exchangeRates,
  allTrades = [], payouts = [],
  drawdownSummaries = [],
  isMobileEditing: isMobileEditingProp = false, setIsMobileEditing: setIsMobileEditingProp,
  onAnalyzeWithAI,
  onNavigateToSettings,
  defaultLayouts,
}) => {
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' ? window.innerWidth < 1024 : false);
  const isMobileEditing = isMobileEditingProp;
  const setIsMobileEditing = setIsMobileEditingProp ?? (() => {});

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => setIsMobile(window.innerWidth < 1024);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  const lang = user?.language || 'cs';
  const targetCurrency = user?.currency || 'USD';

  const riskStats = useMemo(() => calculateRStatistics(stats.trades), [stats.trades]);

  // Local helper for formatting with user preferences
  const formatValue = (val: number, mode: PnLDisplayMode = pnlDisplayMode, bal?: number, rr?: number | null, sign: boolean = true) => {
    return formatPnL(val, mode, bal, rr, sign, targetCurrency, exchangeRates);
  };

  const formatRawCurrency = (val: number, showSign: boolean = false) => {
    return formatCurrency(val, targetCurrency, exchangeRates, showSign);
  };

  // Formátování PnL obchodu pro drill-down (respektuje $/%/R preferenci a měnu jako zbytek dashboardu).
  const drillPnlFormatter = (t: Trade) =>
    formatTradePnL(t, pnlDisplayMode, stats.initialBalance, tradeRMultiple(t), true, targetCurrency, exchangeRates);

  // Detect current breakpoint from container width
  const [currentBreakpoint, setCurrentBreakpoint] = useState<string>('lg');

  // Get the layout for the current breakpoint, falling back to lg
  const activeLayout = useMemo(() => {
    return layouts[currentBreakpoint] || layouts.lg || [];
  }, [layouts, currentBreakpoint]);

  // Úpravy: každá změna během editace jde do historie (Zpět / ⌘Z), stav při
  // otevření úprav drží „Zrušit změny“.
  const [layoutHistory, setLayoutHistory] = useState<DashboardLayouts[]>([]);
  const editSnapshotRef = useRef<DashboardLayouts | null>(null);
  const applyLayouts = useCallback((next: DashboardLayouts) => {
    if (isEditing) setLayoutHistory(history => [...history.slice(-30), layouts]);
    onUpdateLayouts(next);
  }, [isEditing, layouts, onUpdateLayouts]);
  useEffect(() => {
    if (isEditing) {
      editSnapshotRef.current = layouts;
      setLayoutHistory([]);
    } else {
      editSnapshotRef.current = null;
    }
    // Snímek jen při otevření úprav, ne při každé změně rozložení.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  // Helper: update layout for ALL breakpoints (used for add/remove/toggle visible)
  const updateAllBreakpointLayouts = useCallback((updater: (prev: DashboardWidgetConfig[], bp: string) => DashboardWidgetConfig[]) => {
    const result: DashboardLayouts = {};
    for (const bp of Object.keys(layouts)) {
      result[bp] = updater(layouts[bp] || [], bp);
    }
    applyLayouts(result);
  }, [layouts, applyLayouts]);

  // Check if we need to auto-inject the Challenge widget when in Challenge mode
  useEffect(() => {
    if (dashboardMode === 'challenge' && !activeLayout.some(w => w.id === 'challenge_target')) {
      updateAllBreakpointLayouts((bpLayout, bp) => {
        if (bpLayout.some(w => w.id === 'challenge_target')) return bpLayout;
        const isXxl = bp === 'xxl';
        return [{ id: 'challenge_target', label: 'Challenge Cíl', visible: true, x: 0, y: 0, w: isXxl ? 12 : 6, h: 2, minW: isXxl ? 3 : 2, minH: 2, maxW: isXxl ? 12 : 6, maxH: 4 }, ...bpLayout];
      });
    }
  }, [dashboardMode, activeLayout, updateAllBreakpointLayouts]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isArmoryOpen, setIsArmoryOpen] = useState(false);
  const [selectedTradeId, setSelectedTradeId] = useState<string | number | null>(null);
  const [selectedPayoutIndex, setSelectedPayoutIndex] = useState<number | null>(null);
  const [selectedIncidentPoint, setSelectedIncidentPoint] = useState<EquityPoint | null>(null);
  const [mcLabOpen, setMcLabOpen] = useState(false);

  const selectedTrade = useMemo(() => {
    if (!selectedTradeId) return null;
    return stats.trades.find(t => t.id === selectedTradeId);
  }, [selectedTradeId, stats.trades]);
  const selectedIncident = useMemo(() => {
    const id = selectedIncidentPoint?.event?.referenceId;
    if (!id) return null;
    for (const review of reviews) {
      const found = review.incidents?.find(incident => incident.id === id);
      if (found) return found;
    }
    return null;
  }, [reviews, selectedIncidentPoint]);
  useEffect(() => {
    if (isEditing && window.innerWidth >= 1024) setIsArmoryOpen(true);
    else if (!isEditing) setIsArmoryOpen(false);
  }, [isEditing]);
  const currentLayout = useMemo(() => {
    // Mimo backtest svět nikdy nerenderuj backtest-specifické widgety (bt_*),
    // i kdyby zůstaly uložené v live layoutu z dřívějška — ať nezůstane prázdný box.
    return [...activeLayout].filter(w => w.visible && !(BACKTEST_ONLY_IDS.has(w.id) && dashboardMode !== 'backtesting')).map(w => {
      if (w.h) return w;
      const master = MASTER_WIDGET_LIST.find(m => m.id === w.id);
      return { ...w, h: (master as any)?.defaultRowSpan || 1, w: w.w || 4, x: w.x || 0, y: w.y || 0 };
    }).sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }, [activeLayout, dashboardMode]);
  // V backtest světě nabízíme jen vybranou podmnožinu + backtest widgety;
  // v live světě NIKDY nenabízíme backtest-specifické widgety (bt_*).
  const visibleMaster = useMemo(
    () => dashboardMode === 'backtesting'
      ? MASTER_WIDGET_LIST.filter(w => BACKTEST_WIDGET_IDS.has(w.id))
      : MASTER_WIDGET_LIST.filter(w => !BACKTEST_ONLY_IDS.has(w.id)),
    [dashboardMode],
  );
  const categories = useMemo(() => {
    const cats: Record<string, any[]> = {};
    visibleMaster.forEach(w => {
      if (!cats[w.category!]) cats[w.category!] = [];
      cats[w.category!].push(w);
    });
    return cats;
  }, [visibleMaster]);
  const updateWidgetStatus = (id: string, visible: boolean) => {
    updateAllBreakpointLayouts((bpLayout, bp) => {
      const exists = bpLayout.some(w => w.id === id);
      if (exists) {
        return bpLayout.map(w => w.id === id ? { ...w, visible } : w);
      } else if (visible) {
        const config = newWidgetConfig(id, bp);
        if (config) return [...bpLayout, config];
      }
      return bpLayout;
    });
    if (visible && window.innerWidth < 1024) setIsArmoryOpen(false);
  };
  const toggleDisciplinedCurve = (id: string) => {
    updateAllBreakpointLayouts((bpLayout) => bpLayout.map(w => {
      if (w.id === id) return { ...w, showDisciplinedCurve: !w.showDisciplinedCurve };
      return w;
    }));
  };

  // react-grid-layout: width measurement
  const { width: containerWidth, containerRef, mounted: widthMounted } = useContainerWidth({ initialWidth: 1280 });

  // react-grid-layout: convert DashboardLayouts to per-breakpoint Layout objects
  const rglLayouts = useMemo(() => {
    const makeLayoutItems = (bpLayout: DashboardWidgetConfig[]): LayoutItem[] =>
      bpLayout.filter(w => w.visible).map(widget => ({
        i: widget.id,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        minW: widget.minW,
        minH: widget.minH,
        maxW: widget.maxW,
        maxH: widget.maxH,
        // Ne `static`: zamčené položky mřížka nesesouvá, takže by mimo úpravy
        // stály i s mezerami a v úpravách (kde se sesunou) vypadaly jinak.
        // Tažení a velikost vypíná dragConfig/resizeConfig.
        static: false,
      }));

    const xxlItems = makeLayoutItems(layouts.xxl || []);
    const lgItems = makeLayoutItems(layouts.lg || []);

    return {
      xxl: xxlItems.length > 0 ? xxlItems : lgItems, // fallback to lg if xxl empty
      lg: lgItems,
      md: lgItems,
      // 6 sloupců: dopočítané z širokého (malé po třech, velké přes celou
      // šířku). Jen oříznutá šířka dřív skládala pravou půlku do sloupce.
      sm: packMidLayout(lgItems, 6).map(item => ({ ...item, static: true })),
      xs: lgItems.map(item => ({ ...item, w: Math.min(item.w, 4), static: true })),
      xxs: lgItems.map(item => ({ ...item, x: 0, w: 2, static: true })),
    };
  }, [layouts]);

  // react-grid-layout: handle layout changes ONLY when drag or resize completes (avoids lag and breakpoint overwrite bugs)
  const handleDragOrResizeStop = useCallback((newLayout: Layout) => {
    const storageKey = currentBreakpoint === 'xxl' ? 'xxl' : 'lg';
    
    const activeLayout = layouts[storageKey] || [];
    const updatedActive = activeLayout.map(config => {
      const rglItem = newLayout.find(item => item.i === config.id);
      if (!rglItem) return config;
      return { ...config, x: rglItem.x, y: rglItem.y, w: rglItem.w, h: rglItem.h };
    });

    const nextLayouts = {
      ...layouts,
      [storageKey]: updatedActive
    };

    // Two-way mirroring for newly added widgets (still at y === Infinity)
    if (storageKey === 'lg') {
      // Notebook -> Large Screen (scale up coordinates)
      const xxlLayout = layouts.xxl || [];
      const updatedXxl = xxlLayout.map(xxlConfig => {
        if (xxlConfig.y !== Infinity && xxlConfig.y !== null && xxlConfig.y !== undefined) {
          return xxlConfig;
        }
        const lgConfig = updatedActive.find(item => item.id === xxlConfig.id);
        if (!lgConfig || lgConfig.y === Infinity) return xxlConfig;

        return {
          ...xxlConfig,
          x: Math.min(lgConfig.x * 2, 20),
          y: lgConfig.y,
          w: Math.min(lgConfig.w * 2, 24),
          h: lgConfig.h
        };
      });
      nextLayouts.xxl = updatedXxl;
    } else if (storageKey === 'xxl') {
      // Large Screen -> Notebook (scale down coordinates)
      const lgLayout = layouts.lg || [];
      const updatedLg = lgLayout.map(lgConfig => {
        if (lgConfig.y !== Infinity && lgConfig.y !== null && lgConfig.y !== undefined) {
          return lgConfig;
        }
        const xxlConfig = updatedActive.find(item => item.id === lgConfig.id);
        if (!xxlConfig || xxlConfig.y === Infinity) return lgConfig;

        return {
          ...lgConfig,
          x: Math.min(Math.round(xxlConfig.x / 2), 10),
          y: xxlConfig.y,
          w: Math.max(Math.round(xxlConfig.w / 2), 2),
          h: xxlConfig.h
        };
      });
      nextLayouts.lg = updatedLg;
    }

    onUpdateLayouts(nextLayouts);
  }, [currentBreakpoint, layouts, onUpdateLayouts]);

  // Track breakpoint changes from react-grid-layout
  const handleBreakpointChange = useCallback((newBreakpoint: string) => {
    setCurrentBreakpoint(newBreakpoint);
  }, []);

  // ── Úpravy mřížky: náhled během tažení, přidávání, odebírání, Zpět ──────────
  // Střední a úzká šířka se skládá automaticky; úprava tam by se uložila do
  // rozložení pro široké okno a rozbila ho.
  const editableBreakpoint = EDITABLE_BREAKPOINTS.has(currentBreakpoint);
  const canEditGrid = isEditing && editableBreakpoint;
  const storageKey = currentBreakpoint === 'xxl' ? 'xxl' : 'lg';
  const storageCols = storageKey === 'xxl' ? GRID_COLS.xxl : GRID_COLS.lg;
  const movingRef = useRef<string | null>(null);
  const dragStartRef = useRef<Layout>([]);
  const swapRef = useRef<string | null>(null);
  const dropWidgetRef = useRef<LibraryWidget | null>(null);
  const [swapId, setSwapId] = useState<string | null>(null);
  const [libraryDrag, setLibraryDrag] = useState<LibraryWidget | null>(null);
  const dragGhostRef = useRef<HTMLDivElement>(null);
  const [freshWidget, setFreshWidget] = useState<string | null>(null);
  const [leavingWidget, setLeavingWidget] = useState<string | null>(null);
  const [editToast, setEditToast] = useState<{ text: string; undo?: boolean } | null>(null);
  useEffect(() => { if (!freshWidget) return; const t = setTimeout(() => setFreshWidget(null), 1600); return () => clearTimeout(t); }, [freshWidget]);
  useEffect(() => { if (!editToast) return; const t = setTimeout(() => setEditToast(null), 3400); return () => clearTimeout(t); }, [editToast]);

  // Mřížka volá skládání při každém posunu; během tahu vrátíme náhled výsledku
  // (prohození stejně velkých / uvolnění místa) a ostatní widgety do něj
  // plynule dojedou. Mimo tah běžné svislé skládání.
  const editCompactor = useMemo<Compactor>(() => ({
    type: 'vertical',
    get allowOverlap() { return movingRef.current != null; },
    compact(layout: Layout, cols: number) {
      const id = movingRef.current;
      const moving = id ? layout.find(item => item.i === id) : undefined;
      if (!moving) return verticalCompactor.compact(layout, cols);
      const result = arrangeDuringDrag(dragStartRef.current, moving, cols);
      if (swapRef.current !== result.swapWith) {
        swapRef.current = result.swapWith;
        const next = result.swapWith;
        queueMicrotask(() => setSwapId(next));
      }
      return result.layout;
    },
  }), []);

  const endMove = () => {
    movingRef.current = null;
    swapRef.current = null;
    setSwapId(null);
  };

  const undoLayout = useCallback(() => {
    setLayoutHistory(history => {
      if (!history.length) return history;
      onUpdateLayouts(history[history.length - 1]);
      setEditToast({ text: 'Vráceno' });
      return history.slice(0, -1);
    });
  }, [onUpdateLayouts]);

  useEffect(() => {
    if (!isEditing) return;
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undoLayout();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [isEditing, undoLayout]);

  const cancelEdit = () => {
    if (editSnapshotRef.current) onUpdateLayouts(editSnapshotRef.current);
    onCloseEdit?.();
  };

  const resetToDefault = () => {
    if (!defaultLayouts) return;
    applyLayouts({ ...layouts, lg: defaultLayouts.lg, xxl: defaultLayouts.xxl });
    setEditToast({ text: 'Obnoveno výchozí rozložení', undo: true });
  };

  const removeWidget = (id: string, label: string) => {
    setLeavingWidget(id);
    setTimeout(() => {
      setLeavingWidget(null);
      updateWidgetStatus(id, false);
      setEditToast({ text: `${label} odebrán`, undo: true });
    }, 190);
  };

  /** Přidá widget na místo (z knihovny tažením) nebo do prvního volného místa. */
  const addWidget = (id: string, at?: { x: number; y: number }) => {
    const keys = new Set([...Object.keys(layouts), 'lg', 'xxl']);
    const result: DashboardLayouts = {};
    for (const bp of keys) {
      const bpLayout = layouts[bp] || [];
      const existing = bpLayout.find(w => w.id === id);
      const base = existing ?? newWidgetConfig(id, bp);
      if (!base) { result[bp] = bpLayout; continue; }
      if (bp !== storageKey) {
        result[bp] = existing ? bpLayout.map(w => w.id === id ? { ...w, visible: true } : w) : [...bpLayout, base];
        continue;
      }
      const placed = bpLayout.filter(w => w.visible && w.id !== id && Number.isFinite(w.y));
      const spot = at ?? firstFreeSpot(placed, base.w, base.h, storageCols);
      const arranged = arrangeDuringDrag(
        placed.map(w => ({ i: w.id, x: w.x, y: w.y, w: w.w, h: w.h })),
        { i: id, x: spot.x, y: spot.y, w: base.w, h: base.h },
        storageCols,
      ).layout;
      const position = new Map(arranged.map(item => [item.i, item]));
      const withWidget = existing ? bpLayout : [...bpLayout, base];
      result[bp] = withWidget.map(w => {
        const item = position.get(w.id);
        if (w.id === id) return { ...w, visible: true, x: item?.x ?? spot.x, y: item?.y ?? spot.y };
        return item ? { ...w, x: item.x, y: item.y } : w;
      });
    }
    applyLayouts(result);
    setFreshWidget(id);
    const label = MASTER_WIDGET_LIST.find(m => m.id === id)?.label ?? 'Widget';
    setEditToast({ text: `${label} přidán`, undo: true });
  };

  const libraryWidgets = useMemo<LibraryWidget[]>(() => visibleMaster
    .filter(master => !activeLayout.find(w => w.id === master.id)?.visible)
    .map(master => {
      const config = newWidgetConfig(master.id, 'lg');
      return {
        id: master.id,
        label: master.label,
        description: master.description,
        category: master.category === 'KPIs' ? 'Čísla' : master.category ?? 'Ostatní',
        icon: master.icon,
        w: config?.w ?? 2,
        h: config?.h ?? 2,
      };
    }), [visibleMaster, activeLayout]);

  // Telefon: vlastní pořadí a šířky (klíč `phone`), mřížku počítače nemění.
  const phoneOrder = useMemo(() => phoneRows(layouts, canHalfOnPhone, halfOnPhoneByDefault)
    .filter(row => visibleMaster.some(master => master.id === row.id)), [layouts, visibleMaster]);
  const savePhoneOrder = (rows: PhoneRow[]) => {
    const catalog = [...(layouts.lg || [])];
    for (const row of rows) if (!catalog.some(w => w.id === row.id)) { const config = newWidgetConfig(row.id, 'lg'); if (config) catalog.push(config); }
    applyLayouts({ ...layouts, [PHONE_LAYOUT_KEY]: phoneLayoutFromRows(rows, catalog) });
    setIsMobileEditing(false);
  };

  const gridCols = (GRID_COLS as Record<string, number>)[currentBreakpoint] ?? GRID_COLS.lg;
  const colWidth = (containerWidth - 12 * (gridCols + 1)) / gridCols;
  const spanPx = (units: number, unit: number) => units * unit + Math.max(0, units - 1) * 12;

  // Náhled taženého widgetu jede za kurzorem přímo přes styl (bez Reactu).
  useEffect(() => {
    if (!libraryDrag) return;
    const move = (event: DragEvent) => {
      const ghost = dragGhostRef.current;
      if (!ghost || (event.clientX === 0 && event.clientY === 0)) return;
      ghost.style.transform = `translate(${event.clientX - DRAG_GRAB.x}px, ${event.clientY - DRAG_GRAB.y}px)`;
      ghost.style.opacity = '1';
    };
    const end = () => setLibraryDrag(null);
    window.addEventListener('dragover', move);
    window.addEventListener('drop', end);
    window.addEventListener('dragend', end);
    return () => {
      window.removeEventListener('dragover', move);
      window.removeEventListener('drop', end);
      window.removeEventListener('dragend', end);
    };
  }, [libraryDrag]);

  // Jeden průchod přes obchody pro všechny KPI widgety. Dřív renderWidget dělal pro každý
  // widget vlastní sadu .filter()/.reduce() přes stats.trades přímo v render path (kpi_winrate
  // 4×, profit_factor 2×, day_winrate build mapy, …) → desítky O(n) průchodů na každý render.
  const kpiData = useMemo(() => {
    const list = stats.trades || [];
    let winCount = 0, beCount = 0, lossCount = 0, nonMissed = 0, missed = 0;
    let grossProfit = 0, grossLoss = 0;
    const dayPnL: Record<string, number> = {};
    for (const tr of list) {
      if (tr.executionStatus === 'Missed') { missed++; continue; }
      nonMissed++;
      if (tr.pnl > 0) { winCount++; grossProfit += tr.pnl; }
      else if (tr.pnl < 0) { lossCount++; grossLoss += tr.pnl; }
      else beCount++;
      const dayKey = (tr.date || '').slice(0, 10);
      if (dayKey) dayPnL[dayKey] = (dayPnL[dayKey] || 0) + tr.pnl;
    }
    const dayVals = Object.values(dayPnL);
    return {
      winCount, beCount, lossCount, totalCount: nonMissed, missed,
      allSignals: list.length,
      grossProfit, grossLoss: Math.abs(grossLoss),
      tradingDays: dayVals.length,
      profitableDays: dayVals.filter(p => p > 0).length,
      lossDays: dayVals.filter(p => p < 0).length,
      beDays: dayVals.filter(p => p === 0).length,
    };
  }, [stats.trades]);

  const renderWidget = (id: string, config?: DashboardWidgetConfig) => {
    // Pojistka: backtest-only widgety se nikdy nevykreslí mimo backtest svět
    // (Monte Carlo je povolené i v live, proto BACKTEST_ONLY_IDS, ne prefix bt_).
    if (BACKTEST_ONLY_IDS.has(id) && dashboardMode !== 'backtesting') return null;
    switch (id) {
      case 'challenge_target': return <DistanceToTargetWidget stats={stats} accounts={accounts} theme={theme} currency={targetCurrency} rates={exchangeRates} payouts={payouts} />;
      case 'discipline': return <DisciplineDashboard theme={theme} preps={preps} reviews={reviews} trades={stats.trades} ironRules={ironRules} />;
      case 'lab_top_leak': return <LabTopLeakWidget top={labTopLeak ?? null} nTrades={stats.trades.length} theme={theme} />;
      case 'kpi_pnl': {
        const totalRr = pnlDisplayMode === 'rr' ? riskStats.total : undefined;
        // Net P&L = reálný stav peněz (vč. výplat a incidentů). Když se od tradů
        // liší, ukaž rozpad — jinak by nebylo poznat, proč číslo nesedí s obchody.
        const payoutsAbs = Math.abs(stats.payouts || 0);
        const adjAbs = Math.abs(stats.financialAdjustments || 0);
        const fmtPlain = (v: number) => `$${Math.round(v).toLocaleString()}`;
        const parts = [`Obchody ${stats.tradePnL >= 0 ? '+' : '−'}${fmtPlain(Math.abs(stats.tradePnL))}`];
        if (payoutsAbs > 0) parts.push(`výplaty −${fmtPlain(payoutsAbs)}`);
        if (adjAbs > 0) parts.push(`incidenty −${fmtPlain(adjAbs)}`);
        const breakdown = (payoutsAbs > 0 || adjAbs > 0) ? parts.join(' · ') : undefined;
        return (
          <ProKpiCard
            theme={theme}
            label={pnlDisplayMode === 'rr' ? "Výsledek obchodů v R" : "Net P&L"}
            value={formatValue(stats.totalPnL, pnlDisplayMode, stats.initialBalance, totalRr)}
            subValue={pnlDisplayMode === 'rr' ? undefined : breakdown}
            sampleSize={stats.totalTrades}
            info={pnlDisplayMode === 'rr' ? "Součet výsledků jednotlivých obchodů dělených jejich původním riskem. Chybějící risk znamená neznámé R. Výplaty a incidenty nejsou obchody." : "Skutečný stav peněz: zisk z obchodů minus vyplacené peníze a incidenty mimo obchody."}
            icon={<div className="bg-purple-100 text-purple-600 p-1 rounded-lg dark:bg-purple-500/20"><BarChart3 size={14} /></div>}
          />
        );
      }
      case 'kpi_max_drawdown': {
        const drawdownRr = pnlDisplayMode === 'rr' ? riskStats.maxDrawdown : undefined;
        return (
          <ProKpiCard
            theme={theme}
            label="Max Drawdown"
            value={formatValue(stats.maxDrawdown, pnlDisplayMode, stats.initialBalance, drawdownRr, false)}
            icon={<div className={`${COLORS.bgLoss} ${COLORS.textLoss} p-1 rounded-lg`}><AlertTriangle size={14} /></div>}
            info={pnlDisplayMode === 'rr' ? "Největší propad kumulovaných výsledků obchodů v R. Bez úplného původního risku a časů není známý. Nezahrnuje výplaty ani incidenty." : "Největší propad kapitálu z vrcholu (peak-to-trough). Důležité pro řízení rizika a psychiku."}
          />
        );
      }
      case 'prop_drawdown_room': return <PropDrawdownRoomWidget summaries={drawdownSummaries} theme={theme} isCombined={viewMode === 'combined'} />;
      case 'kpi_winrate': {
        const { winCount, beCount, lossCount, totalCount } = kpiData;
        const winRate = totalCount > 0 ? ((winCount / totalCount) * 100).toFixed(1) : '0.0';
        return (
          <ProKpiCard
            theme={theme}
            label="Trade win %"
            value={`${winRate}%`}
            type="gauge"
            sampleSize={totalCount}
            data={{ wins: winCount, be: beCount, losses: lossCount }}
            icon={<div className="bg-blue-100 text-blue-600 p-1 rounded-lg dark:bg-blue-500/20"><Activity size={14} /></div>}
            info="Procento vítězných obchodů ze všech uzavřených obchodů."
          />
        );
      }
      case 'kpi_profit_factor': {
        const { grossProfit, grossLoss } = kpiData;
        const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? '∞' : '0.00');
        return (
          <ProKpiCard
            theme={theme}
            label="Profit Factor"
            value={profitFactor}
            type="donut"
            data={{ profit: grossProfit, loss: grossLoss }}
            sampleSize={stats.totalTrades}
            icon={<div className={`${COLORS.bgProfit} ${COLORS.textProfit} p-1 rounded-lg`}><BarChart3 size={14} /></div>}
            info="Poměr hrubých zisků a ztrát. Hodnota > 1.5 je považována za dobrou."
          />
        );
      }
      case 'kpi_day_winrate': {
        // Group trades by date (YYYY-MM-DD only — NE full ISO timestamp!) and calculate profitable days.
        // BUG FIX: dříve t.date je plný ISO ("2026-05-22T15:51:00.000Z"), každý trade dostal vlastní
        // klíč v `dayPnL` → 1 den s 5 trady se počítal jako 5 různých dnů.
        const { tradingDays, profitableDays, lossDays, beDays } = kpiData;
        const dayWinRate = tradingDays > 0 ? ((profitableDays / tradingDays) * 100).toFixed(1) : '0.0';
        return (
          <ProKpiCard
            theme={theme}
            label="Day win %"
            value={`${dayWinRate}%`}
            type="gauge"
            sampleSize={tradingDays}
            data={{ wins: profitableDays, be: beDays, losses: lossDays }}
            subValue={`${profitableDays}/${tradingDays} dnů`}
            icon={<div className="bg-purple-100 text-purple-600 p-1 rounded-lg dark:bg-purple-500/20"><CalendarIcon size={14} /></div>}
            info="Procento ziskových obchodních dnů."
          />
        );
      }
      case 'kpi_execution_rate': {
        // Calculate how many signals were taken vs missed
        const allSignals = kpiData.allSignals;
        const executedSignals = kpiData.totalCount;
        const missedSignals = kpiData.missed;
        const executionRate = allSignals > 0 ? ((executedSignals / allSignals) * 100).toFixed(1) : '100.0';
        return (
          <ProKpiCard
            theme={theme}
            label="Execution %"
            value={`${executionRate}%`}
            type="gauge"
            sampleSize={allSignals}
            data={{ wins: executedSignals, missed: missedSignals }}
            subValue={`${executedSignals}/${allSignals} signálů`}
            icon={<div className="bg-orange-100 text-orange-600 p-1 rounded-lg dark:bg-orange-500/20"><Target size={14} /></div>}
            info="Procento signálů, které jsi skutečně zexekutoval. Zmeškané obchody snižují toto číslo."
          />
        );
      }
      case 'avg_win_loss': return <AvgWinLossWidget stats={stats} theme={theme} pnlDisplayMode={pnlDisplayMode} initialBalance={stats.initialBalance} currency={targetCurrency} rates={exchangeRates} />;
      case 'streak': return <StreakWidget stats={stats} theme={theme} />;
      case 'discipline_streak': return <DisciplineStreakWidget trades={stats.trades} theme={theme} />;
      case 'winners_losers': return <WinnersLosersWidget stats={stats} theme={theme} pnlDisplayMode={pnlDisplayMode} initialBalance={stats.initialBalance} currency={targetCurrency} rates={exchangeRates} />;
      case 'monthly_performance': return <PerformanceByMonthWidget monthlyData={stats.monthlyBreakdown} theme={theme} />;
      case 'hourly_edge': return <HourlyEdgeWidget data={stats.hourStats} theme={theme} trades={stats.trades} onOpenTrade={(t) => setSelectedTradeId(t.id)} formatTradePnl={drillPnlFormatter} />;
      case 'daily_edge': return <DailyEdgeWidget data={stats.dayStats} theme={theme} trades={stats.trades} onOpenTrade={(t) => setSelectedTradeId(t.id)} formatTradePnl={drillPnlFormatter} />;
      case 'session_performance': return <SessionBreakdownWidget trades={stats.trades} theme={theme} configs={sessions} />;
      case 'equity': return (
        <Charts
          stats={stats}
          theme={theme}
          onlyEquity
          isEditing={isEditing}
          showDisciplinedCurve={config?.showDisciplinedCurve}
          onToggleDisciplined={() => toggleDisciplinedCurve('equity')}
          onTradeClick={(id) => setSelectedTradeId(id)}
          onEventClick={(point) => {
            if (point.event?.kind === 'payout') {
              const payoutIndex = payouts.findIndex(item => item.id === point.event?.referenceId);
              if (payoutIndex >= 0) setSelectedPayoutIndex(payoutIndex);
              return;
            }
            if (point.event?.kind === 'incident') setSelectedIncidentPoint(point);
          }}
          pnlDisplayMode={pnlDisplayMode}
        />
      );
      case 'calendar': return <div className="h-full flex flex-col"><DashboardCalendar trades={stats.trades} preps={preps} reviews={reviews} theme={theme} accounts={accounts} emotions={emotions} pnlFormat={pnlDisplayMode} initialBalance={stats.initialBalance} user={user!} exchangeRates={exchangeRates} onAnalyzeWithAI={onAnalyzeWithAI} onOpenTrade={trade => setSelectedTradeId(trade.id)} /></div>;
      case 'daily_insight': return <DailyInsightWidget theme={theme} trades={allTrades.length > 0 ? allTrades : stats.trades} onOpenTrade={(t) => setSelectedTradeId(String(t.id))} />;
      case 'daily_focus': return <DailyFocusWidget ironRules={ironRules} theme={theme} onManage={onNavigateToSettings} />;
      case 'bt_avg_r': {
        const valid = stats.trades.filter(t => t.executionStatus !== 'Missed');
        const rTrades = valid.filter(t => t.riskAmount && (t.riskAmount as number) > 0);
        const avgR = rTrades.length ? rTrades.reduce((s, t) => s + (t.pnl || 0) / (t.riskAmount as number), 0) / rTrades.length : null;
        const exp = valid.length ? valid.reduce((s, t) => s + (t.pnl || 0), 0) / valid.length : 0;
        const pos = (avgR ?? 0) >= 0;
        return (
          <ProKpiCard
            theme={theme}
            label="Avg R"
            value={avgR == null ? '—' : `${pos ? '+' : ''}${avgR.toFixed(2)}R`}
            subValue={avgR == null ? 'vyplň risk u obchodů' : `${exp >= 0 ? '+' : '−'}$${Math.abs(Math.round(exp)).toLocaleString('en-US')} / obchod`}
            info="Průměrný R-multiple na obchod (pnl ÷ risk). Expectancy = průměrný $ výdělek na obchod."
            icon={<div className="bg-violet-100 text-violet-600 p-1 rounded-lg dark:bg-violet-500/20"><Target size={14} /></div>}
          />
        );
      }
      case 'bt_confluence_wr': return <BtConfluenceWrWidget stats={stats} theme={theme} />;
      case 'bt_sample_size': return <BtSampleSizeWidget stats={stats} theme={theme} />;
      case 'bt_monte_carlo': return <BtMonteCarloWidget stats={stats} theme={theme} onExpand={() => setMcLabOpen(true)} />;
      default: return null;
    }
  };


  return (
    <div className={`relative min-h-screen transition-all duration-700 max-w-full overflow-x-hidden ${isEditing ? 'canvas-grid' : ''}`}>
      <div className={`space-y-6 lg:space-y-10 relative z-10 w-full mx-auto transition-[padding] duration-500 ${isEditing ? 'pb-[420px]' : 'pb-40'}`}>
        <div className={`flex justify-between items-center px-4 pt-4 ${!isEditing ? 'hidden lg:flex' : ''}`}>
          <div>
            <div className="flex items-center gap-4">
              {/* MODE SWITCHER */}
            </div>
          </div>
          {isEditing && (
            <div className="dbe-editbar">
              <button type="button" className="dbe-btn" onClick={undoLayout} disabled={!layoutHistory.length} title="Zpět (⌘Z)">
                <Undo2 size={14} /> Zpět
              </button>
              {defaultLayouts ? <button type="button" className="dbe-btn" onClick={resetToDefault}>Obnovit výchozí</button> : null}
              <button type="button" className="dbe-btn" onClick={cancelEdit}>Zrušit změny</button>
              <button type="button" className="dbe-btn dbe-btn-ok" onClick={onCloseEdit}>
                <CheckCircle2 size={14} /> Hotovo
              </button>
            </div>
          )}
        </div>

        <div ref={containerRef} className={`w-full p-2 md:px-6 rounded-[32px] ${isEditing ? 'pt-6' : ''}`}>
          {isEditing && !editableBreakpoint && !isMobile ? (
            <p className="dbe-note">
              Na téhle šířce okna se rozložení skládá automaticky z toho širokého — malé widgety po třech, velké přes celou šířku.
              Upravovat ho jde na širším okně, aby se úpravy neuložily do rozložení pro velkou obrazovku.
            </p>
          ) : null}
          {/* Mobile: jednoduchý vertikální seznam, KPI widgety ve dvojicích vedle sebe */}
          {isMobile && !isEditing && (() => {
            const chartHeights: Record<string, number> = {
              equity: 340, hourly_edge: 320, daily_edge: 320, monthly_performance: 320, calendar: 520,
              streak: 180, avg_win_loss: 140,
            };
            const wiggleAnimate = isMobileEditing
              ? { rotate: [0, -1.5, 1.5, -1.5, 0], scale: [1, 1.01, 1.01, 1.01, 1] }
              : { rotate: 0 as number, scale: 1 };
            const wiggleTransition = isMobileEditing
              ? { duration: 0.45, repeat: Infinity, repeatDelay: 1.2, ease: 'easeInOut' as const }
              : { duration: 0.2 };
            const editClass = isMobileEditing
              ? 'ring-2 ring-emerald-500/40 rounded-2xl shadow-[0_0_16px_rgba(16,185,129,0.15)]'
              : '';

            // Pořadí a šířky z telefonního rozložení (nebo odvozené ze širokého).
            const layoutById = new Map(currentLayout.map(widget => [widget.id, widget]));
            const items = phoneOrder.flatMap(row => {
              const widget = layoutById.get(row.id) ?? activeLayout.find(w => w.id === row.id)
                ?? newWidgetConfig(row.id, 'lg');
              if (!widget) return [];
              const content = renderWidget(widget.id, widget);
              if (content == null) return [];
              return [{ widget, content, isKpi: row.half }];
            });

            // Global KPI pairing: collect all pairable KPI indices first, pair them up globally.
            // This ensures KPIs get paired even when separated by full-width widgets.
            const kpiIndices = items.reduce<number[]>((acc, item, idx) => {
              if (item.isKpi) acc.push(idx);
              return acc;
            }, []);
            // Build pairs: (first-kpi-index, second-kpi-index | null)
            const kpiPairMap = new Map<number, number | null>();
            for (let k = 0; k < kpiIndices.length; k += 2) {
              kpiPairMap.set(kpiIndices[k], kpiIndices[k + 1] ?? null);
              if (kpiIndices[k + 1] != null) kpiPairMap.set(kpiIndices[k + 1], -1); // -1 = "skip, already used"
            }

            const rows: React.ReactNode[] = [];
            items.forEach((item, idx) => {
              const pairInfo = kpiPairMap.get(idx);

              if (pairInfo === -1) return; // second of a pair — already rendered

              if (item.isKpi && pairInfo != null) {
                // First of a pair → render grid-cols-2
                const second = items[pairInfo];
                rows.push(
                  <div key={`kpi-pair-${item.widget.id}-${second.widget.id}`} className="grid grid-cols-2 gap-3">
                    <motion.div style={{ minHeight: 160 }} animate={wiggleAnimate} transition={wiggleTransition} className={`dashboard-widget-shell ${editClass}`}>
                      {item.content}
                    </motion.div>
                    <motion.div style={{ minHeight: 160 }} animate={wiggleAnimate} transition={wiggleTransition} className={`dashboard-widget-shell ${editClass}`}>
                      {second.content}
                    </motion.div>
                  </div>
                );
              } else if (item.isKpi) {
                // Unpaired KPI (lichý počet) — na mobilu poloviční šířka,
                // ne natažený přes celé pole (vypadalo by to směšně velké)
                rows.push(
                  <div key={`kpi-solo-${item.widget.id}`} className="grid grid-cols-2 gap-3">
                    <motion.div style={{ minHeight: 160 }} animate={wiggleAnimate} transition={wiggleTransition} className={`dashboard-widget-shell ${editClass}`}>
                      {item.content}
                    </motion.div>
                  </div>
                );
              } else {
                // Full-width widget (komplexní karty)
                const fixedHeight = chartHeights[item.widget.id];
                const isSelfSizing = item.widget.id === 'daily_insight';
                const style = isSelfSizing
                  ? {}
                  : fixedHeight ? { height: fixedHeight } : { minHeight: 260 };
                rows.push(
                  <motion.div key={item.widget.id} style={style} animate={wiggleAnimate} transition={wiggleTransition} className={`dashboard-widget-shell ${editClass}`}>
                    {item.content}
                  </motion.div>
                );
              }
            });
            return <div className="flex flex-col gap-3 px-2">{rows}</div>;
          })()}

          {/* Desktop: react-grid-layout */}
          {(!isMobile || isEditing) && widthMounted && (
            <ResponsiveGridLayout
              className={`layout dbe-grid ${isEditing ? 'editing' : ''} ${canEditGrid ? 'dbe-editing' : ''}`}
              width={containerWidth}
              layouts={rglLayouts}
              breakpoints={GRID_BREAKPOINTS}
              cols={GRID_COLS}
              rowHeight={GRID_ROW_HEIGHT}
              margin={[12, 12] as [number, number]}
              compactor={editCompactor}
              dragConfig={{ enabled: canEditGrid, cancel: '.dbe-no-drag' }}
              resizeConfig={{ enabled: canEditGrid, handles: ['se'] }}
              dropConfig={{
                enabled: canEditGrid,
                defaultItem: { w: 2, h: 2 },
                onDragOver: () => (dropWidgetRef.current
                  ? { w: dropWidgetRef.current.w, h: dropWidgetRef.current.h, dragOffsetX: DRAG_GRAB.x, dragOffsetY: DRAG_GRAB.y }
                  : false),
              }}
              droppingItem={{ i: '__dbe_drop__', x: 0, y: 0, w: 2, h: 2 }}
              onDragStart={(layout, oldItem) => {
                dragStartRef.current = layout.map(item => ({ ...item }));
                movingRef.current = oldItem?.i ?? null;
              }}
              onDragStop={(layout) => { endMove(); handleDragOrResizeStop(layout); }}
              // Štítek velikosti se píše rovnou do prvku: přes React stav by každý
              // pohyb myši překreslil celý dashboard i s grafy (sekalo se to).
              onResize={(_layout, _old, item, _placeholder, _event, element) => {
                if (item && element) showResizeBadge(element, item.w, item.h, item.w <= (item.minW ?? 1) && item.h <= (item.minH ?? 1));
              }}
              onResizeStop={(layout, _old, _item, _placeholder, _event, element) => { element?.querySelector('.dbe-size')?.remove(); handleDragOrResizeStop(layout); }}
              onDrop={(_layout, item) => {
                const widget = dropWidgetRef.current;
                dropWidgetRef.current = null;
                endMove();
                setLibraryDrag(null);
                if (widget && item) addWidget(widget.id, { x: item.x, y: item.y });
              }}
              onBreakpointChange={handleBreakpointChange}
              autoSize
            >
              {currentLayout.map(widget => {
                const grid = (rglLayouts as Record<string, { i: string; minW?: number; minH?: number; maxW?: number; maxH?: number }[]>)[currentBreakpoint]
                  ?.find(item => item.i === widget.id);
                // Minimum i maximum drží i během tažení rohu: mřížka by jinak
                // widget vizuálně zmenšila až na 1×1 a po puštění skočil zpět.
                const clamp = canEditGrid && grid ? {
                  minWidth: spanPx(grid.minW ?? 1, colWidth), minHeight: spanPx(grid.minH ?? 1, GRID_ROW_HEIGHT),
                  maxWidth: spanPx(Math.min(grid.maxW ?? gridCols, gridCols), colWidth), maxHeight: spanPx(grid.maxH ?? 99, GRID_ROW_HEIGHT),
                } : undefined;
                return (
                  <div
                    key={widget.id}
                    style={clamp}
                    className={[
                      'h-full',
                      isEditing ? 'group relative' : '',
                      swapId === widget.id ? 'dbe-swap' : '',
                      freshWidget === widget.id ? 'dbe-new' : '',
                      leavingWidget === widget.id ? 'dbe-out' : '',
                    ].join(' ')}
                  >
                    {canEditGrid && (
                      <WidgetEditOverlay
                        id={widget.id}
                        label={widget.label}
                        showDisciplinedCurve={widget.showDisciplinedCurve}
                        onRemove={() => removeWidget(widget.id, widget.label)}
                        onToggleDisciplinedCurve={widget.id === 'equity' ? () => toggleDisciplinedCurve(widget.id) : undefined}
                      />
                    )}
                    <div className={`dashboard-widget-shell dbe-shell ${isEditing ? 'h-full pointer-events-none select-none' : 'h-full'}`}>
                      {renderWidget(widget.id, widget)}
                    </div>
                  </div>
                );
              })}
            </ResponsiveGridLayout>
          )}
        </div>
      </div>


      {/* Telefon: úpravy pořadí, šířky a výběru widgetů */}
      <AnimatePresence>
        {isMobileEditing && (
          <DashboardPhoneEditor
            rows={phoneOrder}
            catalog={visibleMaster.map(master => ({
              id: master.id,
              label: master.label,
              description: master.description,
              icon: React.cloneElement(master.icon as React.ReactElement<{ size?: number }>, { size: 16 }),
              canHalf: canHalfOnPhone(master.id),
            }))}
            onSave={savePhoneOrder}
            onCancel={() => setIsMobileEditing(false)}
          />
        )}
      </AnimatePresence>

      {/* Knihovna widgetů (místo doku) + hláška s Vrátit */}
      {isEditing && canEditGrid && !isMobile ? (
        <DashboardWidgetLibrary
          widgets={libraryWidgets}
          onAdd={id => addWidget(id)}
          dragging={!!libraryDrag}
          onDragStartWidget={widget => {
            // Až po startu tahu: změna DOM přímo v dragstart umí v Chromu tah zrušit.
            setTimeout(() => setLibraryDrag(widget), 0);
            dropWidgetRef.current = widget;
            dragStartRef.current = ((rglLayouts as Record<string, Layout>)[currentBreakpoint] ?? []).map(item => ({ ...item }));
            movingRef.current = '__dbe_drop__';
          }}
          onDragEndWidget={() => { dropWidgetRef.current = null; setLibraryDrag(null); endMove(); }}
        />
      ) : null}
      {/* Tažený widget z knihovny: skutečný vzhled ve velikosti, kterou na ploše zabere. */}
      {libraryDrag ? (
        <div
          ref={dragGhostRef}
          className="dbe-drag-ghost dashboard-widget-shell"
          style={{ width: spanPx(libraryDrag.w, colWidth), height: spanPx(libraryDrag.h, GRID_ROW_HEIGHT) }}
          aria-hidden
        >
          {renderWidget(libraryDrag.id, newWidgetConfig(libraryDrag.id, 'lg') ?? undefined)}
        </div>
      ) : null}
      {editToast ? (
        <div className="dbe-toast" key={editToast.text} role="status">
          {editToast.text}
          {editToast.undo && layoutHistory.length ? <button type="button" onClick={undoLayout}>Vrátit</button> : null}
        </div>
      ) : null}


      {
        selectedTrade && (
          <TradeDetailModal
            trade={selectedTrade}
            accountName={accounts.find(a => a.id === selectedTrade.accountId)?.name || 'Neznámý účet'}
            theme={theme}
            onClose={() => setSelectedTradeId(null)}
            onDelete={() => { if (onDeleteTrade) onDeleteTrade(selectedTrade.id); setSelectedTradeId(null); }}
            emotions={emotions}
            onUpdateTrade={(updates) => onUpdateTrade?.(selectedTrade.id, updates)}
            pnlDisplayMode={pnlDisplayMode}
            accounts={accounts}
            initialBalance={stats.initialBalance}
            user={user}
            exchangeRates={exchangeRates}
            allTrades={allTrades.length > 0 ? allTrades : stats.trades}
          />
        )
      }

      {selectedPayoutIndex !== null && payouts[selectedPayoutIndex] && (
        <PayoutDetailModal
          payouts={payouts}
          index={selectedPayoutIndex}
          onIndexChange={setSelectedPayoutIndex}
          accounts={accounts}
          trades={allTrades.length > 0 ? allTrades : stats.trades}
          theme={theme}
          formatValue={(amount) => formatRawCurrency(amount)}
          onEdit={() => {}}
          onDelete={() => {}}
          onClose={() => setSelectedPayoutIndex(null)}
          readOnly
        />
      )}

      {selectedIncidentPoint && selectedIncident && (
        <EquityIncidentModal
          point={selectedIncidentPoint}
          incident={selectedIncident}
          theme={theme}
          onClose={() => setSelectedIncidentPoint(null)}
        />
      )}

      {mcLabOpen && (
        <MonteCarloLab
          theme={theme}
          trades={stats.trades}
          initialBalance={stats.initialBalance}
          onClose={() => setMcLabOpen(false)}
        />
      )}
    </div >
  );
};
export default Dashboard;
