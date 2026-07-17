
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, ReferenceLine, LabelList, Line
} from 'recharts';
import { TradeStats } from '../types';
import { Info, Calendar, Clock, ShieldCheck, Activity } from 'lucide-react';
import { thumbSmall } from '../services/imageUrlService';

// Module-level mouse tracker shared with Dashboard — position at render time, no re-renders
let _mx = 0, _my = 0;
let _suppressTooltipUntil = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('mousemove', (e) => { _mx = e.clientX; _my = e.clientY; }, { passive: true });
}

function chartTooltipStyle(width = 220): React.CSSProperties {
  const pad = 12;
  const showLeft = _mx > window.innerWidth * 0.55;
  return {
    position: 'fixed',
    left: showLeft ? Math.max(pad, _mx - width - 16) : Math.min(_mx + 16, window.innerWidth - width - pad),
    top: Math.max(pad, Math.min(_my - 60, window.innerHeight - 260)),
    zIndex: 9999,
    pointerEvents: 'none',
    width,
  };
}

interface ChartsProps {
  stats: TradeStats;
  theme: 'dark' | 'light' | 'oled';
  onlyEquity?: boolean;
  onlyDistribution?: boolean;
  isEditing?: boolean;
  showDisciplinedCurve?: boolean;
  onToggleDisciplined?: () => void;
  onTradeClick?: (tradeId: string | number) => void;
  /** PnL display mode — když je 'rr', equity křivka se přepne na kumulativní R. */
  pnlDisplayMode?: 'usd' | 'percent' | 'rr';
}

const COLORS = {
  profit: '#10b981', // Emerald 500
  profitBottom: '#059669',
  loss: '#f43f5e',   // Rose 500
  lossBottom: '#e11d48',
  textProfit: 'text-emerald-500',
  textLoss: 'text-rose-500',
  textLong: 'text-emerald-500',
  textShort: 'text-rose-500'
};

interface CustomTooltipProps {
  active?: boolean;
  payload?: any[];
  label?: string;
  theme: 'dark' | 'light' | 'oled';
}

const CustomEquityTooltip = (props: any) => {
  const { active, payload, label, theme, isRR } = props;
  if (!active || !payload || !payload.length) return null;
  // Suppress tooltip briefly after a click — prevents stale tooltip overlaying the trade detail modal
  if (Date.now() < _suppressTooltipUntil) return null;

  const data = payload[0].payload;
  const val = payload[0].value ?? 0;
  const initial = data?.initial ?? 0;
  const isPositive = val >= initial;
  const trade = data?.trade;
  const validVal = payload.find((p: any) => p.dataKey === 'validEquity')?.value;

  // Format value based on display mode
  const fmtPortfolio = (v: number) => isRR
    ? `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}R`
    : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const fmtTrade = (pnl: number, riskAmount: number | undefined) => {
    if (isRR && riskAmount && riskAmount > 0) {
      const r = pnl / riskAmount;
      return `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
    }
    return `${pnl >= 0 ? '+' : '-'}$${Number(Math.abs(pnl || 0)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  };

  return createPortal(
    <div style={chartTooltipStyle(230)} className={`border p-4 rounded-2xl shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150
      ${theme === 'oled' ? 'bg-black border-white/10 text-white' :
        theme === 'dark' ? 'bg-theme-page-95 border-slate-700 text-white' :
          'bg-white/95 border-slate-200 text-slate-900'
      }`}>
      <p className="text-[10px] font-black uppercase tracking-widest mb-2 opacity-50">{label}</p>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5 mb-0.5">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
              <span className="text-[9px] font-black uppercase tracking-tight text-slate-400">Portfolio</span>
            </div>
            <p className={`font-black text-base leading-none ${isPositive ? COLORS.textProfit : COLORS.textLoss}`}>
              {fmtPortfolio(Number(val))}
            </p>
          </div>
          {trade && (
            <div className="text-right">
              <span className="text-[9px] font-black uppercase tracking-tight text-slate-400 block mb-0.5">{trade.instrument} <span className={trade.direction === 'Long' ? COLORS.textLong : COLORS.textShort}>{trade.direction}</span></span>
              <p className={`font-black text-base leading-none ${trade.pnl >= 0 ? COLORS.textProfit : COLORS.textLoss}`}>
                {fmtTrade(trade.pnl, trade.riskAmount)}
              </p>
            </div>
          )}
        </div>
        {trade?.screenshot && (
          <div className="border-t border-white/5 pt-2">
            <img
              src={thumbSmall(trade.screenshot)}
              alt="screenshot"
              className="w-full rounded-lg object-cover"
              style={{ height: 90 }}
            />
          </div>
        )}
        {validVal != null && (
          <div className="pt-2 border-t border-white/5">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-1.5 h-1.5 rounded-full bg-amber-400"></div>
              <span className="text-[10px] font-black uppercase tracking-tight text-amber-500/80">Disciplinovaná</span>
            </div>
            <p className="font-black text-lg leading-none text-amber-400">
              ${Number(validVal).toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </p>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};


const CustomBarTooltip = (props: any) => {
  const { active, payload, label, theme } = props;
  if (!active || !payload || !payload.length) return null;

  const data = payload[0].payload;
  if (!data) return null;

  const profit = data.profit || 0;
  const loss = Math.abs(data.loss || 0);
  const net = profit + (data.loss || 0);
  const winRate = data.winRate || 0;
  const count = data.trades || 0;

  return createPortal(
    <div style={chartTooltipStyle(220)} className={`border p-4 rounded-lg shadow-xl
      ${theme === 'oled' ? 'bg-black border-white/10 text-white' :
        theme === 'dark' ? 'bg-theme-card border-slate-700 text-white' :
          'bg-white border-slate-200 text-slate-900'
      }`}>
      <div className="flex justify-between items-center mb-2 pb-2 border-b border-gray-700/50">
        <span className="font-bold text-white">{label}</span>
        <span className="text-xs text-slate-400">{count} Obchodů</span>
      </div>
      <div className="space-y-1.5 text-sm">
        <div className="flex justify-between items-center">
          <span className="text-emerald-400">Hrubý zisk:</span>
          <span className="font-mono font-bold text-emerald-400">+${Number(profit).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-rose-400">Hrubá ztráta:</span>
          <span className="font-mono font-bold text-rose-400">-${Number(loss).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
        </div>
        <div className={`flex justify-between items-center pt-2 mt-1 border-t ${theme !== 'light' ? 'border-slate-800' : 'border-slate-100'}`}>
          <span className="text-slate-400">Čisté PnL:</span>
          <span className={`font-mono font-bold ${net >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {net >= 0 ? '+' : '-'}${Number(Math.abs(net)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        </div>
        <div className="flex justify-between items-center mt-1">
          <span className="text-slate-500">Win Rate:</span>
          <span className="font-bold text-blue-400">{Number(winRate).toFixed(1)}%</span>
        </div>
      </div>
    </div>,
    document.body
  );
};


interface CustomActiveDotProps {
  cx?: number;
  cy?: number;
  payload?: any;
  onTradeClick?: (tradeId: string | number) => void;
}

const CustomActiveDot = (props: CustomActiveDotProps) => {
  const { cx, cy, payload, onTradeClick } = props;

  if (!onTradeClick || !payload || !payload.trade) return null;

  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r={20}
        fill="transparent"
        cursor="pointer"
        onClick={(e) => {
          e.stopPropagation();
          _suppressTooltipUntil = Date.now() + 2000;
          onTradeClick(payload.trade.id);
        }}
      />
      <circle
        cx={cx}
        cy={cy}
        r={6}
        fill="#fff"
        stroke="#3b82f6"
        strokeWidth={2}
        pointerEvents="none"
      />
      <circle
        cx={cx}
        cy={cy}
        r={10}
        fill="none"
        stroke="#3b82f6"
        strokeWidth={1}
        strokeOpacity={0.5}
        pointerEvents="none"
      >
        <animate attributeName="r" from="6" to="12" dur="1.5s" repeatCount="indefinite" />
        <animate attributeName="opacity" from="1" to="0" dur="1.5s" repeatCount="indefinite" />
      </circle>
    </g>
  );
};

const Charts: React.FC<ChartsProps> = ({ stats, theme, onlyEquity, onlyDistribution, isEditing, showDisciplinedCurve, onToggleDisciplined, onTradeClick, pnlDisplayMode = 'usd' }) => {
  const axisColor = theme !== 'light' ? '#64748b' : '#94a3b8';
  const gridColor = theme !== 'light' ? '#334155' : '#e2e8f0';

  const hourData = stats.hourStats;
  const dayData = stats.dayStats.filter(d => d.label !== 'So' && d.label !== 'Ne');

  const isRRMode = pnlDisplayMode === 'rr';
  const initialCap = stats.initialBalance;

  // V RR mode přepočti equity z USD na kumulativní R-multiple.
  // Start = 0R (ne initialBalance), každý trade přispěje pnl/riskAmount.
  const equityData = React.useMemo(() => {
    if (!isRRMode) {
      return stats.equityCurve.map((pt, i) => ({
        ...pt,
        name: pt.date === 'Start' ? 'Start' : (i),
        initial: initialCap,
      }));
    }
    // Build R-based equity from trades sorted by timestamp ASC
    const sorted = [...stats.trades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    let cumR = 0;
    const out: any[] = [{ name: 'Start', date: 'Start', equity: 0, initial: 0 }];
    sorted.forEach((t, i) => {
      const r = t.riskAmount && t.riskAmount > 0 ? (t.pnl || 0) / t.riskAmount : 0;
      cumR += r;
      out.push({
        name: i + 1,
        date: t.date,
        equity: parseFloat(cumR.toFixed(2)),
        initial: 0,
        trade: t,
      });
    });
    return out;
  }, [stats.equityCurve, stats.trades, initialCap, isRRMode]);

  // Baseline pro gradient — v USD mode je to initialCap (start kapitálu),
  // v RR mode je to 0 (start na 0R).
  const baseline = isRRMode ? 0 : initialCap;

  // Dynamické vygenerování ticků na ose Y, aby obsahovaly i počáteční hodnotu (baseline)
  const yAxisTicks = React.useMemo(() => {
    if (equityData.length === 0) return [];
    const values = equityData.map(d => d.equity);
    // KRITICKÉ: kotva = baseline (v RR módu 0, v USD initialCap). Dřív se i v RR módu
    // kotvilo na initialCap (USD!) → funded účet s balance $250k dal range ~250 000
    // při kroku 5 → ~50 000 ticků → while smyčky + recharts zamrzly UI na minuty
    // (přepnutí $/%/R ve funded vypadalo jako "nefunkční toggle").
    const anchor = baseline;
    const minVal = Math.min(...values, anchor);
    const maxVal = Math.max(...values, anchor);
    const range = maxVal - minVal;
    if (!Number.isFinite(range)) return [anchor];

    // Určení kroku (step) podle velikosti rozpětí
    let step = 1000;
    if (isRRMode) {
      if (range <= 2) step = 0.5;
      else if (range <= 5) step = 1;
      else if (range <= 10) step = 2;
      else step = 5;
    } else {
      if (range <= 1000) step = 200;
      else if (range <= 2500) step = 500;
      else if (range <= 5000) step = 1000;
      else if (range <= 15000) step = 2000;
      else if (range <= 30000) step = 5000;
      else step = 10000;
    }

    // Pojistka: extrémní range (špinavý riskAmount, outlier trade…) nesmí vygenerovat
    // tisíce ticků — víc než ~24 jich osa stejně nezobrazí čitelně.
    const MAX_TICKS = 24;
    if (range / step > MAX_TICKS) {
      step = Math.ceil(range / MAX_TICKS / step) * step;
    }

    const ticksDown: number[] = [];
    let currentTick = anchor - step;
    while (currentTick >= minVal - step * 0.5 || ticksDown.length < 1) {
      ticksDown.unshift(currentTick);
      currentTick -= step;
    }

    const ticksUp: number[] = [];
    currentTick = anchor + step;
    while (currentTick <= maxVal + step * 0.5 || ticksUp.length < 1) {
      ticksUp.push(currentTick);
      currentTick += step;
    }

    return [...ticksDown, anchor, ...ticksUp];
  }, [equityData, baseline, isRRMode]);

  const getGradientOffset = () => {
    if (yAxisTicks.length < 2) return 0.5;
    const yMax = yAxisTicks[yAxisTicks.length - 1];
    const yMin = yAxisTicks[0];
    if (yMax <= baseline) return 0;
    if (yMin >= baseline) return 1;
    return (yMax - baseline) / (yMax - yMin);
  };

  const off = getGradientOffset();

  return (
    <div className="space-y-8 h-full">

      {/* 1. EQUITY CURVE */}
      {!onlyDistribution && (
        <div className="p-6 rounded-[32px] transition-all overflow-visible h-full flex flex-col glass-panel">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
            <div>
              <h3 className={`text-xs font-black uppercase tracking-widest flex items-center gap-2 ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>
                <Activity size={16} className="text-blue-500" /> Equity křivka
              </h3>
            </div>

            {isEditing && (
              <div className="flex items-center gap-3">
                <button
                  onClick={onToggleDisciplined}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-[10px] font-black uppercase transition-all active:scale-95 animate-in slide-in-from-right-4 duration-300 ${showDisciplinedCurve
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-500 ring-2 ring-amber-500/20'
                    : (theme !== 'light' ? 'bg-slate-800 border-slate-700 text-slate-500' : 'bg-slate-100 border-slate-200 text-slate-400')
                    }`}
                >
                  <ShieldCheck size={14} /> Disciplined Curve
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 min-h-0 w-full min-w-[1px]" style={{ outline: 'none' }}>
            <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
              <AreaChart
                data={equityData}
                margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                onClick={(data: any) => {
                  if (data && data.activePayload && data.activePayload[0]) {
                    const trade = data.activePayload[0].payload.trade;
                    if (trade && onTradeClick) {
                      _suppressTooltipUntil = Date.now() + 2000;
                      onTradeClick(trade.id);
                    }
                  }
                }}
              >
                <defs>
                  <linearGradient id="splitColor" x1="0" y1="0" x2="0" y2="1">
                    <stop offset={off} stopColor={COLORS.profit} stopOpacity={1} />
                    <stop offset={off} stopColor={COLORS.profitBottom} stopOpacity={1} />
                    <stop offset={off} stopColor={COLORS.loss} stopOpacity={1} />
                    <stop offset={off} stopColor={COLORS.lossBottom} stopOpacity={1} />
                  </linearGradient>
                  <linearGradient id="splitFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset={0} stopColor={COLORS.profit} stopOpacity={0.2} />
                    <stop offset={off} stopColor={COLORS.profit} stopOpacity={0} />
                    <stop offset={off} stopColor={COLORS.loss} stopOpacity={0} />
                    <stop offset={1} stopColor={COLORS.loss} stopOpacity={0.2} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.05} vertical={false} />
                <XAxis
                  dataKey="name"
                  stroke={axisColor}
                  tick={false}
                  axisLine={false}
                  padding={{ left: 0, right: 0 }}
                />
                <YAxis
                  stroke={axisColor}
                  axisLine={false} tickLine={false}
                  tickFormatter={(val) => {
                    if (isRRMode) {
                      return `${val >= 0 ? '+' : ''}${val.toFixed(val % 1 === 0 ? 0 : 1)}R`;
                    }
                    const absVal = Math.abs(val);
                    if (absVal >= 1000) {
                      const kVal = val / 1000;
                      const hasDecimals = val % 1000 !== 0;
                      return `${val < 0 ? '-' : ''}$${Math.abs(kVal).toFixed(hasDecimals ? 1 : 0)}k`;
                    }
                    return `${val < 0 ? '-' : ''}$${absVal}`;
                  }}
                  width={45}
                  ticks={yAxisTicks}
                  domain={[yAxisTicks[0], yAxisTicks[yAxisTicks.length - 1]]}
                  tick={{ fontSize: 10, fontStyle: 'italic', fontWeight: 'bold' }}
                />
                <Tooltip content={<CustomEquityTooltip theme={theme} isRR={isRRMode} />} cursor={{ stroke: axisColor, strokeDasharray: '5 5' }} wrapperStyle={{ background: 'transparent', border: 'none', boxShadow: 'none', padding: 0 }} />

                <ReferenceLine
                  y={initialCap}
                  stroke={axisColor}
                  strokeDasharray="3 3"
                  opacity={0.3}
                />

                {/* Druhá, disciplinovaná křivka - ZLATÁ */}
                {showDisciplinedCurve && (
                  <Area
                    type="stepAfter"
                    dataKey="validEquity"
                    stroke="#fbbf24"
                    strokeWidth={2.5}
                    fill="transparent"
                    strokeDasharray="6 4"
                    animationDuration={1500}
                    isAnimationActive={true}
                  />
                )}

                <Area
                  type="monotone"
                  dataKey="equity"
                  stroke="url(#splitColor)"
                  strokeWidth={2.5}
                  fill="url(#splitFill)"
                  activeDot={(props) => <CustomActiveDot {...props} onTradeClick={onTradeClick} />}
                  style={{ cursor: 'pointer' }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {showDisciplinedCurve && (
            <div className="mt-4 flex justify-center">
              <div className="flex items-center gap-2">
                <div className="w-3 h-0.5 border-t-2 border-dashed border-amber-400"></div>
                <span className="text-[9px] font-black uppercase text-amber-500/80">Disciplinovaný (Zlatá cesta)</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 2. PERFORMANCE BY HOUR & DAY */}
      {!onlyEquity && (
        <div className="space-y-8">
          <div className={`p-6 rounded-[32px] border ${theme === 'oled' ? 'bg-black border-white/10' :
            theme === 'dark' ? 'bg-theme-card-90 border-white/5 backdrop-blur-xl' :
              'bg-white border-slate-200 shadow-sm'
            }`}>
            <div className="flex justify-between items-center mb-6">
              <h3 className={`text-xs font-black uppercase tracking-widest flex items-center gap-2 ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>
                <Clock className="w-5 h-5 text-blue-500" /> Výkonnost podle hodin
              </h3>
            </div>

            <div className="h-[400px] w-full">
              <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                <BarChart data={hourData} stackOffset="sign" margin={{ top: 20, right: 30, left: 20, bottom: 5 }} barGap={0}>
                  <defs>
                    <linearGradient id="profitGradientV" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.profit} /><stop offset="100%" stopColor={COLORS.profitBottom} /></linearGradient>
                    <linearGradient id="lossGradientV" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.loss} /><stop offset="100%" stopColor={COLORS.lossBottom} /></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} opacity={0.05} />
                  <XAxis dataKey="label" interval={0} stroke={axisColor} axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 'bold' }} dy={10} />
                  <YAxis stroke={axisColor} axisLine={false} tickLine={false} tickFormatter={(val) => `$${Math.abs(val) >= 1000 ? (val / 1000).toFixed(1) + 'k' : val}`} tick={{ fontSize: 10 }} />
                  <Tooltip content={<CustomBarTooltip theme={theme} />} cursor={{ fill: theme !== 'light' ? '#334155' : '#e2e8f0', opacity: 0.1 }} wrapperStyle={{ background: 'transparent', border: 'none', boxShadow: 'none', padding: 0 }} />
                  <ReferenceLine y={0} stroke={axisColor} />
                  <Bar dataKey="profit" stackId="hour" fill="url(#profitGradientV)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="loss" stackId="hour" fill="url(#lossGradientV)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className={`p-6 rounded-[32px] border ${theme === 'oled' ? 'bg-black border-white/10' :
            theme === 'dark' ? 'bg-theme-card-90 border-white/5 backdrop-blur-xl' :
              'bg-white border-slate-200 shadow-sm'
            }`}>
            <div className="flex justify-between items-center mb-6">
              <h3 className={`text-xs font-black uppercase tracking-widest flex items-center gap-2 ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>
                <Calendar className="w-5 h-5 text-purple-500" /> Výkonnost podle dnů
              </h3>
            </div>
            <div className="h-[400px] w-full">
              <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                <BarChart layout="vertical" data={dayData} margin={{ top: 5, right: 50, left: 20, bottom: 5 }} stackOffset="sign">
                  <defs>
                    <linearGradient id="profitGradientH" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={COLORS.profit} /><stop offset="100%" stopColor={COLORS.profitBottom} /></linearGradient>
                    <linearGradient id="lossGradientH" x1="1" y1="0" x2="0" y2="0"><stop offset="0%" stopColor={COLORS.loss} /><stop offset="100%" stopColor={COLORS.lossBottom} /></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={true} stroke={gridColor} opacity={0.05} />
                  <XAxis type="number" stroke={axisColor} axisLine={false} tickLine={false} tickFormatter={(val) => `$${Math.abs(val) >= 1000 ? (val / 1000).toFixed(0) + 'k' : val}`} />
                  <YAxis dataKey="label" type="category" stroke={axisColor} axisLine={false} tickLine={false} width={40} tick={{ fontWeight: 'bold', fontSize: 10 }} />
                  <Tooltip content={<CustomBarTooltip theme={theme} />} cursor={{ fill: theme !== 'light' ? '#334155' : '#e2e8f0', opacity: 0.1 }} wrapperStyle={{ background: 'transparent', border: 'none', boxShadow: 'none', padding: 0 }} />
                  <ReferenceLine x={0} stroke={axisColor} />
                  <Bar dataKey="loss" stackId="stack" fill="url(#lossGradientH)" radius={[0, 8, 8, 0]} />
                  <Bar dataKey="profit" stackId="stack" fill="url(#profitGradientH)" radius={[0, 8, 8, 0]}>
                    <LabelList dataKey="winRate" position="right" formatter={(val: number) => `${val.toFixed(0)}%`} style={{ fill: axisColor, fontSize: '10px', fontWeight: 'black' }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Charts;
