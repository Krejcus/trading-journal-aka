
import React, { useState, useMemo, useEffect } from 'react';
import { Trade, TradeStats, DailyPrep, DailyReview, DashboardWidgetConfig, SessionConfig, TimeStat, MonthlyData, IronRule, Account, CustomEmotion, DashboardMode, User } from '../types';
import Charts from './Charts';
import DashboardCalendar from './DashboardCalendar';
import DisciplineDashboard from './DisciplineDashboard';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Cell, ReferenceLine, LabelList, PieChart, Pie, Sector, AreaChart, Area, Rectangle
} from 'recharts';
import {
  Maximize2,
  Minimize2,
  Activity,
  BarChart3,
  LayoutGrid,
  Trophy,
  GripVertical,
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
  ChevronDown,
  LineChart,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Wallet,
  CheckCircle2,
  Layers,
  X,
  Brain,
  TrendingUp,
  TrendingDown,
  ChevronUp,
  Percent,
  Timer,
  AlertTriangle,
  ShieldCheck,
  Terminal,
  Flag
} from 'lucide-react';

interface DashboardProps {
  stats: TradeStats;
  theme: 'dark' | 'light' | 'oled';
  preps: DailyPrep[];
  reviews: DailyReview[];
  layout: DashboardWidgetConfig[];
  sessions: SessionConfig[];
  ironRules: IronRule[];
  onUpdateLayout: (newLayout: DashboardWidgetConfig[]) => void;
  isEditing: boolean;
  onCloseEdit?: () => void;
  accounts: Account[];
  emotions: CustomEmotion[];
  viewMode: 'individual' | 'combined';
  dashboardMode?: DashboardMode;
  setDashboardMode?: (mode: DashboardMode) => void;
  onDeleteTrade?: (id: number | string) => void;
  onEditTrade?: (trade: Trade) => void;
  onUpdateTrade?: (tradeId: string | number, updates: Partial<Trade>) => void;
  user?: User;
}

// ... existing imports ...



// ... MASTER_WIDGET_LIST update ...
import TradeDetailModal from './TradeDetailModal';

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
const DistanceToTargetWidget: React.FC<{ stats: TradeStats, accounts: Account[], theme: 'dark' | 'light' | 'oled' }> = ({ stats, accounts, theme }) => {
  const initial = stats.initialBalance;
  const current = initial + stats.totalPnL;
  const target = initial * 1.10; // 10% Profit Target
  const progress = Math.min(100, Math.max(0, ((current - initial) / (target - initial)) * 100));
  const remaining = target - current;
  const isPassed = current >= target;
  const color = isPassed ? COLORS.profit : '#3b82f6';
  return (
    <div className="p-6 rounded-[32px] glass-panel relative overflow-visible h-full flex flex-col justify-between">
      <div className="flex justify-between items-start mb-4">
        <h3 className="text-xs font-black uppercase tracking-widest flex items-center gap-2 text-slate-400">
          <Flag size={16} className="text-blue-500" /> Challenge Cíl
        </h3>
        <div className={`px-2 py-1 rounded-lg text-[10px] font-black uppercase ${isPassed ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-slate-400'}`}>
          {isPassed ? 'Splněno' : 'In Progress'}
        </div>
      </div>
      <div className="flex-1 flex flex-col justify-center">
        <div className="flex justify-between items-end mb-2">
          <span className="text-3xl font-black tracking-tighter text-white">${current.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          <div className="text-right">
            <span className="text-[10px] font-bold text-slate-500 uppercase block">Cíl (10%)</span>
            <span className="text-sm font-black text-slate-300">${target.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          </div>
        </div>
        <div className="h-4 w-full bg-slate-900 rounded-full overflow-hidden relative border border-white/5">
          <div className="absolute top-0 bottom-0 left-0 transition-all duration-1000 ease-out flex items-center justify-end pr-1" style={{ width: `${progress}%`, backgroundColor: color }}>
            {progress > 15 && <span className="text-[9px] font-black text-white/90">{progress.toFixed(1)}%</span>}
          </div>
          <div className="absolute top-0 bottom-0 w-px bg-white/20 left-[50%]"></div>
        </div>
        <div className="mt-3 flex justify-between items-center text-[10px] font-bold text-slate-500">
          <span>Start: ${initial.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          <span>Zbývá: <span className="text-white">${Math.max(0, remaining).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></span>
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
}> = ({ children, text, subtext, theme, color }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ isFlipped: false, isRight: false });

  const checkPosition = () => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const isFlipped = rect.top < 250; // Flip to bottom if close to top
      const isRight = rect.right > window.innerWidth - 150; // Shift left if close to right edge
      setPos({ isFlipped, isRight });
    }
  };

  return (
    <div
      className="relative inline-block"
      ref={containerRef}
      onMouseEnter={() => { checkPosition(); setIsOpen(true); }}
      onMouseLeave={() => setIsOpen(false)}
    >
      {children}
      <div
        className={`absolute p-3 rounded-2xl border shadow-2xl backdrop-blur-2xl z-[9999] w-48 transition-all duration-200 pointer-events-none theme-card theme-border
          ${isOpen ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}
          ${pos.isFlipped ? 'top-full mt-3' : 'bottom-full mb-3'}
          ${pos.isRight ? 'right-0' : 'left-1/2 -translate-x-1/2'}
          ${!pos.isFlipped && !isOpen ? 'translate-y-2' : ''}
          ${pos.isFlipped && !isOpen ? '-translate-y-2' : ''}
        `}
      >
        <div className="flex flex-col items-center gap-1">
          {color && <div className="w-2 h-2 rounded-full mb-1" style={{ backgroundColor: color }}></div>}
          <div className="text-[10px] font-black uppercase tracking-widest opacity-60 text-center text-wrap">{text}</div>
          {subtext && <div className="text-sm font-black text-center text-wrap">{subtext}</div>}
        </div>
        {/* Arrow */}
        <div className={`absolute w-0 h-0 border-8 border-transparent ${pos.isRight ? 'hidden' : 'left-1/2 -translate-x-1/2 ' + (pos.isFlipped
          ? `bottom-full border-b-[var(--glass-border)] ${theme === 'light' ? 'border-b-white' : ''}`
          : `top-full border-t-[var(--glass-border)] ${theme === 'light' ? 'border-t-white' : ''}`)
          }`}></div>
      </div>
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

const MASTER_WIDGET_LIST = [
  { id: 'challenge_target', label: 'Challenge Cíl', category: 'KPIs', icon: <Flag size={18} />, description: 'Sleduje postup k profit targetu (10%).', preview: <div className="text-blue-500 font-black text-xs">Progress: 45%</div>, defaultRowSpan: 1 },
  { id: 'kpi_pnl', label: 'Net P&L', category: 'KPIs', icon: <Trophy size={18} />, description: 'Čistý zisk nebo ztráta účtu.', preview: <div className={`${COLORS.textProfit} font-black text-xl`}>$215,873</div>, defaultRowSpan: 1 },
  { id: 'kpi_winrate', label: 'Trade win %', category: 'KPIs', icon: <Activity size={18} />, description: 'Procento vítězných obchodů.', preview: <div className="text-blue-500 font-black text-xl">57.97%</div>, defaultRowSpan: 1 },
  { id: 'kpi_execution_rate', label: 'Execution %', category: 'KPIs', icon: <Target size={18} />, description: 'Procento signálů, které jsi reálně vzal.', preview: <div className="text-orange-500 font-black text-xl">92%</div>, defaultRowSpan: 1 },
  { id: 'kpi_profit_factor', label: 'Profit factor', category: 'KPIs', icon: <BarChart3 size={18} />, description: 'Poměr hrubých zisků a ztrát.', preview: <div className={`${COLORS.textProfit} font-black text-xl`}>19.89</div>, defaultRowSpan: 1 },
  { id: 'kpi_day_winrate', label: 'Day win %', category: 'KPIs', icon: <CalendarIcon size={18} />, description: 'Procento ziskových obchodních dnů.', preview: <div className="text-purple-500 font-black text-xl">62.15%</div>, defaultRowSpan: 1 },
  { id: 'kpi_avg_win', label: 'Average Win', category: 'KPIs', icon: <ArrowUp size={18} />, description: 'Průměrný zisk na vítězný trade.', preview: <div className={`${COLORS.textProfit} font-black text-xl`}>$450</div>, defaultRowSpan: 1 },
  { id: 'kpi_avg_loss', label: 'Average Loss', category: 'KPIs', icon: <ArrowDown size={18} />, description: 'Průměrná ztráta na trade.', preview: <div className={`${COLORS.textLoss} font-black text-xl`}>$320</div>, defaultRowSpan: 1 },
  { id: 'kpi_max_drawdown', label: 'Max Drawdown', category: 'KPIs', icon: <TrendingDown size={18} />, description: 'Největší propad kapitálu.', preview: <div className={`${COLORS.textLoss} font-black text-xl`}>12.4%</div>, defaultRowSpan: 1 },
  { id: 'discipline', label: 'Rituály & Disciplína', category: 'Chování', icon: <Brain size={18} />, description: 'Sleduje tvé ranní a večerní rituály.', preview: <div className="text-blue-500 font-black text-xs">Streak: 5 days</div>, defaultRowSpan: 2 },
  { id: 'winners_losers', label: 'Výhry a Prohry', category: 'Analýza', icon: <TrendingUp size={18} />, description: 'Statistické srovnání zisků a ztrát.', preview: <div className="flex gap-1"><div className={`w-4 h-4 ${COLORS.bgProfit} ${COLORS.borderProfit} border rounded`} /><div className={`w-4 h-4 ${COLORS.bgLoss} ${COLORS.borderLoss} border rounded`} /></div>, defaultRowSpan: 2 },
  { id: 'monthly_performance', label: 'Měsíční Výkonnost', category: 'Analýza', icon: <CalendarIcon size={18} />, description: 'Měsíční přehled ziskovosti s heatmapou.', preview: <div className="grid grid-cols-4 gap-0.5"><div className="w-2 h-2 bg-emerald-500/40" /><div className="w-2 h-2 bg-emerald-500/80" /><div className="w-2 h-2 bg-emerald-500/20" /><div className="w-2 h-2 bg-rose-500/40" /></div>, defaultRowSpan: 2 },
  { id: 'equity', label: 'Equity Curve', category: 'Analýza', icon: <Activity size={20} />, description: 'Vizuální cesta tvého kapitálu.', preview: <div className="h-12 w-full px-2 flex items-center"><svg viewBox="0 0 100 40" className="w-full h-full stroke-blue-500 fill-none stroke-[3] opacity-60"><path d="M0,35 Q20,30 40,32 T70,10 T100,5" strokeLinecap="round" /></svg></div>, defaultRowSpan: 2 },
  { id: 'session_performance', label: 'Výkon Sessions', category: 'Analýza', icon: <Globe size={18} />, description: 'Výkon rozdělený podle seancí.', preview: <div className="text-orange-500 font-black text-xs">NY Peak</div>, defaultRowSpan: 2 },
  { id: 'hourly_edge', label: 'Hodinový Výkon', category: 'Analýza', icon: <Clock size={18} />, description: 'Výkonnost podle hodin.', preview: <div className="text-blue-500 font-black text-xs">NY Open</div>, defaultRowSpan: 2 },
  { id: 'daily_edge', label: 'Denní Výkon', category: 'Analýza', icon: <CalendarIcon size={18} />, description: 'Výkonnost podle dnů v týdnu.', preview: <div className="text-blue-500 font-black text-xs">Tue/Thu Focus</div>, defaultRowSpan: 2 },
  { id: 'calendar', label: 'Obchodní Kalendář', category: 'Analýza', icon: <CalendarIcon size={18} />, description: 'Denní zisky v kalendáři.', preview: <div className={`${COLORS.textProfit} font-black text-xs`}>Green Month</div>, defaultRowSpan: 3 },
];

const CustomKpiTooltip = (props: any) => {
  const { active, payload, theme, coordinate, viewBox } = props;
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    const isDark = theme !== 'light';

    // Safety check for values
    const value = payload[0].value ?? 0;

    // Vertical flipping logic (if too close to top, shift down)
    const isTopSide = (coordinate?.y || 0) < 180;
    const isRightSide = (coordinate?.x || 0) > (viewBox?.width || 0) * 0.7;

    return (
      <div className={`px-3 py-2 rounded-xl border shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-200 z-[9999] pointer-events-none theme-card theme-border transition-transform ${isTopSide ? 'translate-y-[80%]' : '-translate-y-[80%]'} ${isRightSide ? '-translate-x-[105%]' : ''}`}>
        <p className="text-[10px] font-black uppercase tracking-widest mb-1 opacity-50">{data.name || data.label}</p>
        <p className="text-xs font-black flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: data.fill || payload[0].color }}></span>
          {value > 0 ? '+' : value < 0 ? '-' : ''}{Number(Math.abs(value)).toLocaleString(undefined, { maximumFractionDigits: 0 })} {data.unit || '$'}
        </p>
      </div>
    );
  }
  return null;
};

const CustomEdgeTooltip = (props: any) => {
  const { active, payload, label, theme } = props;
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    const isDark = theme !== 'light';
    const profit = data.profit || 0;
    const loss = Math.abs(data.loss || 0);
    const net = profit - loss;
    // Identify if the tooltip is likely to clip on the right
    const { coordinate, viewBox } = props as any;
    const isRightSide = (coordinate?.x || 0) > (viewBox?.width || 0) * 0.6; // Shift left if past 60% of width

    return (
      <div className={`p-4 rounded-2xl border shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 duration-200 min-w-[180px] z-[1000] pointer-events-none transition-transform ${isRightSide ? '-translate-x-[105%]' : ''} ${theme === 'oled' ? 'bg-black border-white/10 text-white' :
        theme === 'dark' ? 'bg-[var(--bg-card)]/95 border-[var(--border-subtle)] text-white' :
          'bg-white/95 border-slate-200 text-slate-900'
        }`}>
        <div className={`flex justify-between items-center mb-3 pb-2 border-b ${theme !== 'light' ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
          <span className="font-black text-sm uppercase tracking-tight">{label}</span>
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
            <span className="text-[10px] font-black uppercase text-slate-400">Čisté PnL:</span>
            <p className={`text-sm font-black font-mono ${net >= 0 ? COLORS.textProfit : COLORS.textLoss}`}>
              {net >= 0 ? '+' : '-'}${Math.abs(net).toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </p>
          </div>
          <div className="flex justify-between items-center mt-1">
            <span className="text-[9px] font-black uppercase text-slate-500">Win Rate:</span>
            <span className="text-xs font-black text-blue-500">{(data.winRate || 0).toFixed(1)}%</span>
          </div>
        </div>
      </div>
    );
  }
  return null;
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

  // Helper to remove unnecessary .00 decimals
  const displayValue = useMemo(() => {
    if (!value.includes('.')) return value;
    // Handle percentage
    if (value.endsWith('%')) {
      const num = parseFloat(value.replace('%', ''));
      return `${num}%`;
    }
    // Handle other numbers (if they don't have currency symbols mixed in complex ways)
    if (value.startsWith('$')) {
      const num = parseFloat(value.replace('$', '').replace(/,/g, ''));
      if (isNaN(num)) return value;
      return `$${num.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
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
        <div className="flex items-center justify-between w-full h-full pl-2 gap-6">
          <div className="flex flex-col items-start justify-center h-full min-w-0">
            <span className="text-3xl lg:text-4xl font-black tracking-tighter leading-none">
              {displayValue}
            </span>
          </div>
          <div className="flex flex-col items-center justify-end">
            <div className="h-16 w-32 relative flex-shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart {...({ overflow: 'visible' } as any)}>
                  <defs>
                    <linearGradient id="kpiProfitGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.profit} /><stop offset="100%" stopColor={COLORS.profitBottom} /></linearGradient>
                    <linearGradient id="kpiLossGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.loss} /><stop offset="100%" stopColor={COLORS.lossBottom} /></linearGradient>
                  </defs>
                  <RechartsTooltip content={<CustomKpiTooltip theme={theme} />} allowEscapeViewBox={{ x: true, y: true }} />
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
            <div className="flex gap-1 mt-2">
              {data.wins !== undefined && (
                <SmartTooltip text={`Vítězné ${unit.toLowerCase()}`} subtext={`${data.wins} ${unit}`} color={COLORS.profit} theme={theme}>
                  <div className="relative group" onMouseEnter={() => { const idx = chartData.findIndex(d => d.fill === COLORS.profit); if (idx >= 0) setActiveIndex(idx); }} onMouseLeave={() => setActiveIndex(-1)}>
                    <span className={`px-1.5 py-0.5 rounded-md ${COLORS.bgProfit} ${COLORS.textProfit} text-[9px] font-black border ${COLORS.borderProfit} cursor-help min-w-[24px] text-center block`}>{data.wins}</span>
                  </div>
                </SmartTooltip>
              )}
              {data.be !== undefined && data.be > 0 && (
                <SmartTooltip text={`BE ${unit.toLowerCase()}`} subtext={`${data.be} ${unit}`} color="#3b82f6" theme={theme}>
                  <div className="relative" onMouseEnter={() => { const idx = chartData.findIndex(d => d.fill === '#3b82f6'); if (idx >= 0) setActiveIndex(idx); }} onMouseLeave={() => setActiveIndex(-1)}>
                    <span className="px-1.5 py-0.5 rounded-md bg-blue-500/10 text-blue-500 text-[9px] font-black border border-blue-500/20 cursor-help min-w-[24px] text-center block">{data.be}</span>
                  </div>
                </SmartTooltip>
              )}
              {data.losses !== undefined && (
                <SmartTooltip text={`Ztrátové ${unit.toLowerCase()}`} subtext={`${data.losses} ${unit}`} color={COLORS.loss} theme={theme}>
                  <div className="relative" onMouseEnter={() => { const idx = chartData.findIndex(d => d.fill === COLORS.loss); if (idx >= 0) setActiveIndex(idx); }} onMouseLeave={() => setActiveIndex(-1)}>
                    <span className={`px-1.5 py-0.5 rounded-md ${COLORS.bgLoss} ${COLORS.textLoss} text-[9px] font-black border ${COLORS.borderLoss} cursor-help min-w-[24px] text-center block`}>{data.losses}</span>
                  </div>
                </SmartTooltip>
              )}
              {data.missed !== undefined && data.missed > 0 && (
                <SmartTooltip text={`Zmeškané ${unit.toLowerCase()}`} subtext={`${data.missed} ${unit}`} color="#64748b" theme={theme}>
                  <div className="relative" onMouseEnter={() => { const idx = chartData.findIndex(d => d.fill === '#64748b'); if (idx >= 0) setActiveIndex(idx); }} onMouseLeave={() => setActiveIndex(-1)}>
                    <span className={`px-1.5 py-0.5 rounded-md bg-slate-500/10 text-slate-500 text-[9px] font-black border border-slate-500/20 cursor-help min-w-[24px] text-center block`}>{data.missed}</span>
                  </div>
                </SmartTooltip>
              )}
            </div>
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
          <div className="h-20 w-20 cursor-pointer relative">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart {...({ overflow: 'visible' } as any)}>
                <defs>
                  <linearGradient id="donutProfitGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.profit} /><stop offset="100%" stopColor={COLORS.profitBottom} /></linearGradient>
                  <linearGradient id="donutLossGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.loss} /><stop offset="100%" stopColor={COLORS.lossBottom} /></linearGradient>
                </defs>
                <RechartsTooltip content={<CustomKpiTooltip theme={theme} />} allowEscapeViewBox={{ x: true, y: true }} />
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
              <span className={`text-xs font-black tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>{displayValue}</span>
            </div>
          </div>
          <div className="flex gap-1 mt-2">
            <div className="relative" onMouseEnter={() => { const idx = chartData.findIndex(d => d.fill === COLORS.profit); if (idx >= 0) setActiveIndex(idx); }} onMouseLeave={() => setActiveIndex(-1)}>
              <SmartTooltip text="Hrubý zisk" subtext={`$${(data.profit || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`} color={COLORS.profit} theme={theme}>
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 cursor-help shadow-lg" />
              </SmartTooltip>
            </div>
            <div className="relative" onMouseEnter={() => { const idx = chartData.findIndex(d => d.fill === COLORS.loss); if (idx >= 0) setActiveIndex(idx); }} onMouseLeave={() => setActiveIndex(-1)}>
              <SmartTooltip text="Hrubá ztráta" subtext={`$${(data.loss || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`} color={COLORS.loss} theme={theme}>
                <div className="w-2.5 h-2.5 rounded-full bg-rose-500 cursor-help shadow-lg" />
              </SmartTooltip>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="p-5 rounded-[24px] flex flex-col justify-between h-full relative overflow-visible transition-all hover:scale-[1.02] hover:shadow-xl glass-panel">
      <div className="flex justify-between items-start mb-2">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
          {label}
          {info && <SmartTooltip text="Info" subtext={info} theme={theme}><div className="p-1 -m-1 cursor-help"><Info size={14} className="text-slate-500 opacity-40 hover:opacity-100 transition-opacity" /></div></SmartTooltip>}
        </p>
        {icon && <div className="p-1.5 rounded-lg theme-card theme-border theme-text-secondary">{icon}</div>}
      </div>
      <div className="flex-1 flex flex-col items-center justify-center min-h-[60px]">
        {type === 'text' && (
          <div className="text-center">
            <p className="text-2xl lg:text-3xl font-black tracking-tighter">{displayValue}</p>
            {subValue && <p className="text-xs font-bold theme-text-secondary mt-1">{subValue}</p>}
          </div>
        )}
        {renderVisual()}
      </div>
    </div >
  );
};

const WinnersLosersWidget: React.FC<{ stats: TradeStats, theme: 'dark' | 'light' | 'oled' }> = ({ stats, theme }) => {
  const isDark = theme !== 'light';
  const formatDur = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return `${h}h ${m}m`;
  };
  const Row = ({ label, value, color, info }: any) => (
    <div className={`flex justify-between items-center py-2 border-b last:border-0 ${theme !== 'light' ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
      <span className="text-[10px] font-bold text-slate-500 flex items-center gap-1 uppercase tracking-tight">
        {label}
        {info && <InfoIcon text={info} theme={theme} />}
      </span>
      <span className={`text-xs font-black ${color || (isDark ? 'text-white' : 'text-slate-900')}`}>{value}</span>
    </div>
  );
  return (
    <div className="p-6 rounded-[32px] transition-all relative h-full flex flex-col justify-between overflow-visible glass-panel">
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-xs font-black uppercase tracking-widest flex items-center gap-2 text-slate-400">
          <TrendingUp size={16} className="text-emerald-500" /> Výhry a Prohry
          <SmartTooltip text="Info" subtext="Detailní statistický rozbor vašich ziskových a ztrátových obchodů." theme={theme}><div className="p-1 -m-1 cursor-help"><Info size={14} className="text-slate-500 opacity-40 hover:opacity-100 transition-opacity" /></div></SmartTooltip>
        </h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1">
        <div className={`p-4 rounded-2xl border ${isDark ? 'bg-emerald-500/5 border-emerald-500/10' : 'bg-emerald-50 border-emerald-100'}`}>
          <h4 className={`text-[10px] font-black uppercase tracking-widest ${COLORS.textProfit} mb-4 flex items-center gap-2`}><ArrowUp size={12} /> Ziskové Obchody</h4>
          <div className="space-y-1">
            <Row label="Total winners" value={stats.winningTrades} />
            <Row label="Best win" value={`${stats.bestWinPct.toFixed(2)}%`} color={COLORS.textProfit} />
            <Row label="Average win" value={`${stats.avgWinPct.toFixed(2)}%`} color={COLORS.textProfit} />
            <Row label="Average duration" value={formatDur(stats.avgDurationWin)} />
            <Row label="Max consecutive" value={stats.maxConsecutiveWins} />
          </div>
        </div>
        <div className={`p-4 rounded-2xl border ${isDark ? 'bg-rose-500/5 border-rose-500/10' : 'bg-rose-50 border-rose-100'}`}>
          <h4 className={`text-[10px] font-black uppercase tracking-widest ${COLORS.textLoss} mb-4 flex items-center gap-2`}><ArrowDown size={12} /> Ztrátové Obchody</h4>
          <div className="space-y-1">
            <Row label="Total losers" value={stats.losingTrades} />
            <Row label="Worst loss" value={`${stats.worstLossPct.toFixed(2)}%`} color={COLORS.textLoss} />
            <Row label="Average loss" value={`${stats.avgLossPct.toFixed(2)}%`} color={COLORS.textLoss} />
            <Row label="Average duration" value={formatDur(stats.avgDurationLoss)} />
            <Row label="Max consecutive" value={stats.maxConsecutiveLosses} />
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
    <div className="p-6 rounded-[32px] glass-panel">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <h3 className="text-xs font-black uppercase tracking-widest flex items-center gap-2">
          Měsíční Výkonnost
          <InfoIcon text="Měsíční přehled vaší ziskovosti. Intenzita barvy odpovídá velikosti zisku nebo ztráty." theme={theme} />
        </h3>
        <div className="flex gap-4 items-center">
          <div className={`flex ${isDark ? 'bg-slate-950/50 border-white/5' : 'bg-slate-200/50 border-slate-300'} p-1 rounded-lg border text-[9px] font-black uppercase`}>
            <button onClick={() => setView('individual')} className={`px-2 py-1 rounded ${view === 'individual' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>Individual</button>
            <button onClick={() => setView('accum')} className={`px-2 py-1 rounded ${view === 'accum' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>Accum</button>
          </div>
          <div className={`flex ${isDark ? 'bg-slate-950/50 border-white/5' : 'bg-slate-200/50 border-slate-300'} p-1 rounded-lg border text-[9px] font-black uppercase`}>
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
              {months.map(m => <th key={m} className={`p-3 rounded-xl text-[10px] font-black uppercase text-slate-500 ${theme !== 'light' ? 'bg-[var(--bg-page)]/30' : 'bg-slate-50'}`}>{m}</th>)}
              <th className="p-3 rounded-xl bg-blue-600/10 text-[10px] font-black uppercase text-blue-500">Total</th>
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

const HourlyEdgeWidget: React.FC<{ data: TimeStat[], theme: 'dark' | 'light' | 'oled' }> = ({ data, theme }) => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  return (
    <div className="p-6 rounded-[32px] flex flex-col min-h-[380px] overflow-visible glass-panel">
      <div className="flex justify-between items-center mb-8">
        <h3 className="text-xs font-black uppercase tracking-widest flex items-center gap-2">
          <Clock size={16} className="text-blue-500" /> Hodinový Výkon
          <InfoIcon text="Statistický výkon podle hodin. Zjistěte, ve které hodiny dne generujete největší zisk." theme={theme} />
        </h3>
        <div className="flex gap-4 text-[9px] font-black uppercase text-slate-500">
          <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-emerald-500"></div> Profit</div>
          <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-rose-500"></div> Loss</div>
        </div>
      </div>
      <div className="w-full h-[260px] mt-auto relative">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            stackOffset="sign"
            margin={{ top: 10, right: 10, left: -20, bottom: 5 }}
            onMouseMove={(state) => {
              if (state.activeTooltipIndex !== undefined) setActiveIndex(Number(state.activeTooltipIndex));
            }}
            onMouseLeave={() => setActiveIndex(null)}
          >
            <defs>
              <linearGradient id="hourlyProfitGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.profit} /><stop offset="100%" stopColor={COLORS.profitBottom} /></linearGradient>
              <linearGradient id="hourlyLossGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.loss} /><stop offset="100%" stopColor={COLORS.lossBottom} /></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border-subtle)" opacity={0.6} />
            <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#64748b', fontWeight: 'black' }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#64748b' }} tickFormatter={(val) => `$${Math.abs(val)}`} />
            <RechartsTooltip content={<CustomEdgeTooltip theme={theme} />} cursor={false} allowEscapeViewBox={{ x: true, y: true }} />
            <ReferenceLine y={0} stroke={theme !== 'light' ? 'var(--text-muted)' : '#cbd5e1'} strokeWidth={1} />
            <Bar dataKey="profit" stackId="a" fill="url(#hourlyProfitGrad)" radius={[8, 8, 0, 0]} shape={(props: any) => <CustomActiveBar {...props} activeIndex={activeIndex} layout="horizontal" />} isAnimationActive={false} />
            <Bar dataKey="loss" stackId="a" fill="url(#hourlyLossGrad)" radius={[8, 8, 0, 0]} shape={(props: any) => <CustomActiveBar {...props} activeIndex={activeIndex} layout="horizontal" />} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

const DailyEdgeWidget: React.FC<{ data: TimeStat[], theme: 'dark' | 'light' | 'oled' }> = ({ data, theme }) => {
  const tradingDays = data.filter(d => d.label !== 'So' && d.label !== 'Ne');
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  return (
    <div className="p-6 rounded-[32px] flex flex-col min-h-[380px] overflow-visible glass-panel">
      <div className="flex justify-between items-center mb-8">
        <h3 className="text-xs font-black uppercase tracking-widest flex items-center gap-2">
          <CalendarIcon size={16} className="text-indigo-500" /> Denní Výkon
          <InfoIcon text="Které dny v týdnu jsou pro vaši strategii nejziskovější? Pomáhá identifikovat dny pro zvýšení nebo snížení expozice." theme={theme} />
        </h3>
      </div>
      <div className="w-full h-[260px] mt-auto relative">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            layout="vertical"
            data={tradingDays}
            stackOffset="sign"
            margin={{ top: 5, right: 50, left: 10, bottom: 5 }}
            onMouseMove={(state) => {
              if (state.activeTooltipIndex !== undefined) setActiveIndex(Number(state.activeTooltipIndex));
            }}
            onMouseLeave={() => setActiveIndex(null)}
          >
            <defs>
              <linearGradient id="dailyProfitGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={COLORS.profit} /><stop offset="100%" stopColor={COLORS.profitBottom} /></linearGradient>
              <linearGradient id="dailyLossGrad" x1="1" y1="0" x2="0" y2="0"><stop offset="0%" stopColor={COLORS.loss} /><stop offset="100%" stopColor={COLORS.lossBottom} /></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border-subtle)" opacity={0.6} />
            <XAxis type="number" hide />
            <YAxis dataKey="label" type="category" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#64748b', fontWeight: 'black' }} width={40} />
            <RechartsTooltip content={<CustomEdgeTooltip theme={theme} />} cursor={false} allowEscapeViewBox={{ x: true, y: true }} />
            <ReferenceLine x={0} stroke={theme !== 'light' ? 'var(--text-muted)' : '#cbd5e1'} strokeWidth={1} />
            <Bar dataKey="profit" stackId="a" fill="url(#dailyProfitGrad)" radius={[0, 8, 8, 0]} shape={(props: any) => <CustomActiveBar {...props} activeIndex={activeIndex} layout="vertical" />} isAnimationActive={false}>
              <LabelList dataKey="winRate" position="right" content={(props: any) => <text x={props.x + props.width + 5} y={props.y + props.height / 2 + 4} fill="#64748b" fontSize="9" fontWeight="black" textAnchor="start">{props.value.toFixed(0)}%</text>} />
            </Bar>
            <Bar dataKey="loss" stackId="a" fill="url(#dailyLossGrad)" radius={[0, 8, 8, 0]} shape={(props: any) => <CustomActiveBar {...props} activeIndex={activeIndex} layout="vertical" />} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

const SessionBreakdownWidget: React.FC<{ trades: any[], theme: 'dark' | 'light' | 'oled', configs: SessionConfig[] }> = ({ trades, theme, configs }) => {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  return (
    <div className="p-4 lg:p-6 rounded-[24px] lg:rounded-[32px] h-full flex flex-col overflow-visible glass-panel">
      <div className="flex justify-between items-center mb-4 lg:mb-6">
        <h3 className={`text-xs lg:text-sm font-black uppercase tracking-widest flex items-center gap-2 ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>
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
            const d = new Date(t.timestamp);
            const tm = d.getHours() * 60 + d.getMinutes();
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
                    <p className={`text-[9px] lg:text-[10px] font-black uppercase tracking-widest ${isLive ? (theme !== 'light' ? 'text-white' : 'text-slate-900') : 'text-slate-500'}`}>{cfg.name}</p>
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

const Dashboard: React.FC<DashboardProps> = ({ stats, theme, preps, reviews, layout, sessions, ironRules, onUpdateLayout, isEditing, onCloseEdit, accounts, emotions, onDeleteTrade, onEditTrade, onUpdateTrade, dashboardMode, setDashboardMode, user }) => {
  // Check if we need to auto-inject the Challenge widget when in Challenge mode
  useEffect(() => {
    if (dashboardMode === 'challenge' && !layout.some(w => w.id === 'challenge_target')) {
      // Auto-inject if not present
      onUpdateLayout([{ id: 'challenge_target', label: 'Challenge Cíl', visible: true, size: 'large', order: 0 }, ...layout]);
    }
  }, [dashboardMode, layout, onUpdateLayout]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isArmoryOpen, setIsArmoryOpen] = useState(false);
  const [selectedTradeId, setSelectedTradeId] = useState<string | number | null>(null);

  const selectedTrade = useMemo(() => {
    if (!selectedTradeId) return null;
    return stats.trades.find(t => t.id === selectedTradeId);
  }, [selectedTradeId, stats.trades]);
  useEffect(() => {
    if (isEditing && window.innerWidth >= 1024) setIsArmoryOpen(true);
    else if (!isEditing) setIsArmoryOpen(false);
  }, [isEditing]);
  const currentLayout = useMemo(() => {
    return [...layout].filter(w => w.visible).map(w => {
      if (w.rowSpan) return w;
      const master = MASTER_WIDGET_LIST.find(m => m.id === w.id);
      return { ...w, rowSpan: (master as any)?.defaultRowSpan || 1 };
    }).sort((a, b) => (a.order || 0) - (b.order || 0));
  }, [layout]);
  const categories = useMemo(() => {
    const cats: Record<string, any[]> = {};
    MASTER_WIDGET_LIST.forEach(w => {
      if (!cats[w.category!]) cats[w.category!] = [];
      cats[w.category!].push(w);
    });
    return cats;
  }, []);
  const updateWidgetStatus = (id: string, visible: boolean) => {
    const exists = layout.some(w => w.id === id);
    if (exists) {
      onUpdateLayout(layout.map(w => w.id === id ? { ...w, visible, order: visible ? layout.length : w.order } : w));
    } else {
      const template = MASTER_WIDGET_LIST.find(m => m.id === id);
      if (template) {
        onUpdateLayout([...layout, {
          id: template.id,
          label: template.label,
          visible: true,
          size: template.id.startsWith('kpi_') || template.id === 'challenge_target' ? 'small' : 'large',
          rowSpan: (template as any).defaultRowSpan || 1,
          order: layout.length
        }]);
      }
    }
    if (visible && window.innerWidth < 1024) setIsArmoryOpen(false);
  };
  const toggleWidgetSize = (id: string) => {
    onUpdateLayout(layout.map(w => {
      if (w.id === id) {
        let nextSize: 'small' | 'large' | 'full' = 'small';
        if (w.size === 'small') nextSize = 'large';
        else if (w.size === 'large') nextSize = 'full';
        else if (w.size === 'full') nextSize = 'small';
        return { ...w, size: nextSize };
      }
      return w;
    }));
  };
  const toggleWidgetHeight = (id: string) => {
    onUpdateLayout(layout.map(w => {
      if (w.id === id) {
        let nextSpan = (w.rowSpan || 1) + 1;
        if (nextSpan > 4) nextSpan = 1;
        return { ...w, rowSpan: nextSpan };
      }
      return w;
    }));
  };
  const toggleDisciplinedCurve = (id: string) => {
    onUpdateLayout(layout.map(w => {
      if (w.id === id) {
        return { ...w, showDisciplinedCurve: !w.showDisciplinedCurve };
      }
      return w;
    }));
  };
  const moveWidget = (id: string, direction: 'prev' | 'next') => {
    const visibleWidgets = [...currentLayout];
    const index = visibleWidgets.findIndex(w => w.id === id);
    if (index < 0) return;
    const targetIndex = direction === 'prev' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= visibleWidgets.length) return;
    const currentWidget = { ...visibleWidgets[index] };
    const targetWidget = { ...visibleWidgets[targetIndex] };
    const currentOrder = currentWidget.order;
    const targetOrder = targetWidget.order;
    const newLayout = layout.map(w => {
      if (w.id === currentWidget.id) return { ...w, order: targetOrder };
      if (w.id === targetWidget.id) return { ...w, order: currentOrder };
      return w;
    });
    onUpdateLayout(newLayout);
  };

  const renderWidget = (id: string, config?: DashboardWidgetConfig) => {
    switch (id) {
      case 'challenge_target': return <DistanceToTargetWidget stats={stats} accounts={accounts} theme={theme} />;
      case 'discipline': return <DisciplineDashboard theme={theme} preps={preps} reviews={reviews} trades={stats.trades} ironRules={ironRules} />;
      case 'kpi_pnl': return <ProKpiCard theme={theme} label="Net P&L" value={`$${stats.totalPnL.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} sampleSize={stats.totalTrades} info="Čistý zisk nebo ztráta po odečtení všech nákladů a poplatků." icon={<div className="bg-purple-100 text-purple-600 p-1 rounded-lg dark:bg-purple-500/20"><BarChart3 size={14} /></div>} />;
      case 'kpi_winrate': return <ProKpiCard theme={theme} label="Trade win %" value={`${stats.winRate.toFixed(2)}%`} type="gauge" info="Procento vítězných obchodů z reálně exekuovaných signálů." data={{ wins: stats.winningTrades, be: stats.breakEvenTrades, losses: stats.losingTrades }} />;
      case 'kpi_execution_rate': return <ProKpiCard theme={theme} label="Execution %" value={`${stats.executionRate.toFixed(0)}%`} type="gauge" info="Kolik procent validních signálů jsi reálně exekuoval. Nízké číslo znamená přílišnou selektivitu nebo váhání." data={{ wins: stats.winningTrades + stats.losingTrades + stats.breakEvenTrades, missed: stats.missedTrades }} />;
      case 'kpi_profit_factor': return <ProKpiCard theme={theme} label="Profit factor" value={stats.profitFactor.toFixed(2)} type="donut" info="Poměr hrubého zisku ku hrubé ztrátě. Hodnota nad 1.0 znamená profitabilní systém. Elitní tradeři cílí na 1.5 - 2.5." data={{ profit: stats.grossProfit, loss: stats.grossLoss }} />;
      case 'kpi_day_winrate': return <ProKpiCard theme={theme} label="Day win %" value={`${stats.dayWinRate.toFixed(2)}%`} type="gauge" data={{ wins: stats.winningDays, be: stats.breakEvenDays, losses: stats.losingDays }} info="Procento obchodních dní, které skončily v zisku. Klíčová metrika pro konzistenci." />;
      case 'kpi_avg_win': return <ProKpiCard theme={theme} label="Average Win" value={`$${stats.avgWin.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} icon={<div className={`${COLORS.bgProfit} ${COLORS.textProfit} p-1 rounded-lg`}><ArrowUp size={14} /></div>} info="Průměrný dolarový zisk na jeden vítězný obchod." />;
      case 'kpi_avg_loss': return <ProKpiCard theme={theme} label="Average Loss" value={`$${stats.avgLoss.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} icon={<div className={`${COLORS.bgLoss} ${COLORS.textLoss} p-1 rounded-lg`}><ArrowDown size={14} /></div>} info="Průměrná dolarová ztráta na jeden trade." />;
      case 'kpi_max_drawdown': return <ProKpiCard theme={theme} label="Max Drawdown" value={`$${stats.maxDrawdown.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} icon={<div className={`${COLORS.bgLoss} ${COLORS.textLoss} p-1 rounded-lg`}><AlertTriangle size={14} /></div>} info="Největší propad kapitálu z vrcholu (peak-to-trough). Důležité pro řízení rizika a psychiku." />;
      case 'winners_losers': return <WinnersLosersWidget stats={stats} theme={theme} />;
      case 'monthly_performance': return <PerformanceByMonthWidget monthlyData={stats.monthlyBreakdown} theme={theme} />;
      case 'hourly_edge': return <HourlyEdgeWidget data={stats.hourStats} theme={theme} />;
      case 'daily_edge': return <DailyEdgeWidget data={stats.dayStats} theme={theme} />;
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
        />
      );
      case 'calendar': return <div className="h-full flex flex-col overflow-hidden"><DashboardCalendar trades={stats.trades} preps={preps} reviews={reviews} theme={theme} accounts={accounts} emotions={emotions} /></div>;
      default: return null;
    }
  };

  return (
    <div className={`relative min-h-screen transition-all duration-700 max-w-full overflow-x-hidden ${isEditing && isArmoryOpen ? 'lg:pr-[340px]' : ''}`}>
      <div className="space-y-6 lg:space-y-10 pb-24 relative z-10 w-full overflow-x-hidden">
        <div className="flex justify-between items-center px-2">
          <div>
            <div className="flex items-center gap-4">
              {/* MODE SWITCHER */}
            </div>
          </div>
          {isEditing && (
            <div className="flex gap-2">
              <button onClick={() => setIsArmoryOpen(!isArmoryOpen)} className="lg:hidden p-3 bg-blue-600 text-white rounded-xl font-black text-xs uppercase shadow-lg shadow-blue-500/20"><LayoutTemplate size={18} /></button>
              <button onClick={onCloseEdit} className="p-3 bg-emerald-600 text-white rounded-xl font-black text-xs uppercase shadow-lg shadow-emerald-500/20"><CheckCircle2 size={18} /></button>
            </div>
          )}
        </div>

        <div className={`grid grid-cols-4 gap-3 lg:gap-6 auto-rows-[minmax(180px,auto)] grid-flow-dense transition-all duration-700 w-full overflow-x-hidden`}>
          {currentLayout.map((widget, idx) => {
            const gridClass = widget.size === 'small' ? 'col-span-2 lg:col-span-1' : (widget.size === 'large' ? 'col-span-4 lg:col-span-2' : 'col-span-4');
            const rowSpanClass = widget.rowSpan ? (widget.rowSpan === 2 ? 'row-span-2' : widget.rowSpan === 3 ? 'row-span-3' : widget.rowSpan === 4 ? 'row-span-4' : '') : '';

            return (
              <div key={widget.id} className={`${gridClass} ${rowSpanClass} relative transition-all duration-500 h-full overflow-visible hover:z-[50]`}>
                {isEditing && (
                  <div className="absolute -top-1 -left-1 -right-1 -bottom-1 z-30 rounded-[28px] border-2 border-dashed border-blue-500 flex flex-col items-center justify-center pointer-events-none bg-blue-500/10 backdrop-blur-[2px]">
                    <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[8px] font-black px-3 py-1 rounded-full uppercase tracking-widest flex items-center gap-2 pointer-events-auto shadow-2xl">
                      <GripVertical size={10} /> {widget.label}
                    </div>
                    <div className="absolute bottom-4 flex items-center gap-2 pointer-events-auto">
                      <button onClick={(e) => { e.stopPropagation(); moveWidget(widget.id, 'prev'); }} disabled={idx === 0} className="p-2 bg-slate-900 text-white border border-slate-700 rounded-lg hover:bg-slate-800 disabled:opacity-30 shadow-xl transition-all"><ArrowLeft size={14} /></button>
                      {widget.id === 'equity' && (
                        <button onClick={(e) => { e.stopPropagation(); toggleDisciplinedCurve(widget.id); }} className={`p-2 border rounded-lg shadow-xl transition-all ${widget.showDisciplinedCurve ? 'bg-amber-600 text-white border-amber-500' : 'bg-slate-900 text-slate-500 border-slate-700'}`} title="Zlatá křivka"><ShieldCheck size={14} /></button>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); toggleWidgetHeight(widget.id); }} className="p-2 bg-indigo-600 text-white border border-indigo-500 rounded-lg hover:bg-indigo-500 shadow-xl transition-all flex flex-col items-center gap-0.5" title="Změnit výšku">
                        <div className="flex gap-0.5">
                          {[...Array(4)].map((_, i) => (
                            <div key={i} className={`w-1 h-3 rounded-full ${i < (widget.rowSpan || 1) ? 'bg-white' : 'bg-white/20'}`} />
                          ))}
                        </div>
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); toggleWidgetSize(widget.id); }} className="p-2 bg-blue-600 text-white border border-blue-500 rounded-lg hover:bg-blue-500 shadow-xl transition-all" title="Změnit šířku">
                        {widget.size === 'small' ? <Maximize2 size={14} /> : (widget.size === 'large' ? <ChevronUp size={14} /> : <Minimize2 size={14} />)}
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); updateWidgetStatus(widget.id, false); }} className="p-2 bg-rose-600 text-white border border-rose-500 rounded-lg hover:bg-rose-500 shadow-xl transition-all"><Trash2 size={14} /></button>
                      <button onClick={(e) => { e.stopPropagation(); moveWidget(widget.id, 'next'); }} disabled={idx === currentLayout.length - 1} className="p-2 bg-slate-900 text-white border border-slate-700 rounded-lg hover:bg-slate-800 disabled:opacity-30 shadow-xl transition-all"><ArrowRight size={14} /></button>
                    </div>
                  </div>
                )}
                <div className={`h-full animate-in fade-in zoom-in-95 duration-500 ${isEditing ? 'opacity-40 blur-[2px]' : ''}`}>
                  {renderWidget(widget.id, widget)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <aside className={`fixed top-0 right-0 bottom-0 z-[100] transform transition-all duration-700 ease-in-out shadow-[-20px_0_50px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden ${isEditing && isArmoryOpen ? 'translate-x-0' : 'translate-x-full'} w-full sm:w-[340px] bg-[var(--bg-sidebar)] border-l border-[var(--border-subtle)] backdrop-blur-3xl`}>
        <div className="p-6 md:p-8 border-b border-slate-800/50 flex flex-col gap-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-2xl bg-blue-600 shadow-[0_0_20px_rgba(59,130,246,0.5)] text-white"><LayoutTemplate size={20} /></div>
              <div><h3 className="text-lg font-black tracking-tight leading-none">ARMORY</h3><p className="text-[9px] font-bold text-slate-500 uppercase mt-1 tracking-widest">Tactical Modules</p></div>
            </div>
            <button onClick={() => setIsArmoryOpen(false)} className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400"><X size={18} /></button>
          </div>
          <button onClick={onCloseEdit} className="w-full py-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 active:scale-95"><CheckCircle2 size={18} /> Hotovo</button>
          <div className="relative"><Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={16} /><input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Hledat modul..." className={`w-full pl-12 pr-4 py-3 rounded-2xl border transition-all text-sm outline-none ${theme !== 'light' ? 'bg-[var(--bg-page)] border-[var(--border-subtle)] focus:border-blue-500' : 'bg-white border-slate-200'}`} /></div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
          {(Object.entries(categories)).map(([catName, widgets]) => {
            const filtered = (widgets as any[]).filter(w => w.label.toLowerCase().includes(searchQuery.toLowerCase()));
            if (filtered.length === 0) return null;
            return (
              <div key={catName} className="space-y-4">
                <button className="w-full flex items-center justify-between p-2 rounded-xl"><span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 flex items-center gap-2"><Layers size={12} className="text-blue-500" /> {catName}</span></button>
                <div className="space-y-4 pl-1">
                  {filtered.map(master => {
                    const isActive = layout.find(w => w.id === master.id)?.visible;
                    return (
                      <div key={master.id} className={`group relative p-3 rounded-2xl border transition-all flex items-center justify-between gap-3 ${isActive ? 'bg-blue-600/10 border-blue-500/30' : (theme !== 'light' ? 'bg-[var(--bg-page)]/40 border-[var(--border-subtle)] hover:border-slate-700' : 'bg-slate-50 border-slate-200 hover:shadow-sm')}`}>
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className={`p-2 rounded-xl border shrink-0 transition-colors ${isActive ? 'bg-blue-600 text-white border-blue-500' : 'bg-slate-800 border-white/5 text-slate-500'}`}>
                            {React.cloneElement(master.icon as React.ReactElement<any>, { size: 16 })}
                          </div>
                          <div className="min-w-0">
                            <h4 className={`text-[10px] font-black uppercase tracking-tight truncate ${isActive ? 'text-blue-400' : (theme !== 'light' ? 'text-white' : 'text-slate-900')}`}>{master.label}</h4>
                            <p className="text-[7px] font-bold text-slate-500 uppercase tracking-widest truncate">{master.category}</p>
                          </div>

                          {/* Rich Tooltip via Title (Native) or Custom Tooltip Component if preferred */}
                          <div className="absolute inset-0 z-10 cursor-help" title={master.description}></div>
                        </div>

                        <button
                          onClick={(e) => { e.stopPropagation(); updateWidgetStatus(master.id, !isActive); }}
                          className={`relative z-20 w-8 h-8 rounded-lg flex items-center justify-center transition-all active:scale-90 ${isActive ? 'bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white' : 'bg-blue-600 text-white shadow-lg shadow-blue-600/20 hover:bg-blue-500'}`}
                        >
                          {isActive ? <Trash2 size={14} /> : <Plus size={14} />}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {selectedTrade && (
        <TradeDetailModal
          trade={selectedTrade}
          accountName={accounts.find(a => a.id === selectedTrade.accountId)?.name || 'Neznámý účet'}
          theme={theme}
          onClose={() => setSelectedTradeId(null)}
          onEdit={() => { if (onEditTrade) onEditTrade(selectedTrade); setSelectedTradeId(null); }}
          onDelete={() => { if (onDeleteTrade) onDeleteTrade(selectedTrade.id); setSelectedTradeId(null); }}
          emotions={emotions}
          onUpdateTrade={(updates) => onUpdateTrade?.(selectedTrade.id, updates)}
        />
      )}
    </div>
  );
};
export default Dashboard;
