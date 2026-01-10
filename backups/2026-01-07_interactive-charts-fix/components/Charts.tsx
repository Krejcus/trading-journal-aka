
import React, { useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, ReferenceLine, LabelList, Line
} from 'recharts';
import { TradeStats } from '../types';
import { Info, Calendar, Clock, ShieldCheck, Activity } from 'lucide-react';

interface ChartsProps {
  stats: TradeStats;
  theme: 'dark' | 'light' | 'oled';
  onlyEquity?: boolean;
  onlyDistribution?: boolean;
  isEditing?: boolean;
  showDisciplinedCurve?: boolean;
  onToggleDisciplined?: () => void;
  onTradeClick?: (tradeId: string | number) => void;
}

const COLORS = {
  profit: '#10b981', // Emerald 500
  loss: '#f43f5e',   // Rose 500
  textProfit: 'text-emerald-500',
  textLoss: 'text-rose-500',
  textLong: 'text-emerald-500',
  textShort: 'text-orange-500'
};

const CustomEquityTooltip = ({ active, payload, label, theme }: any) => {
  if (active && payload && payload.length) {
    const val = payload[0].value;
    const initial = payload[0].payload.initial;
    const isPositive = val >= initial;
    const trade = payload[0].payload.trade;

    const validVal = payload.find((p: any) => p.dataKey === 'validEquity')?.value;

    return (
      <div className={`border p-4 rounded-2xl shadow-2xl z-[1000] backdrop-blur-xl animate-in fade-in zoom-in-95 duration-200 pointer-events-none ${theme === 'oled' ? 'bg-black border-white/10 text-white' :
        theme === 'dark' ? 'bg-[#0f172a]/95 border-slate-700 text-white' :
          'bg-white/95 border-slate-200 text-slate-900'
        }`}>
        <p className={`text-[10px] font-black uppercase tracking-widest mb-2 opacity-50`}>{label}</p>

        <div className="space-y-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
              <span className="text-[10px] font-black uppercase tracking-tight text-slate-400">Portfolio Size</span>
            </div>
            <p className={`font-black text-xl leading-none ${isPositive ? COLORS.textProfit : COLORS.textLoss}`}>
              ${val.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </p>
          </div>

          {trade && (
            <div className="pt-2 border-t border-white/5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="text-[10px] font-black uppercase tracking-tight text-slate-400 block mb-0.5">Instrument</span>
                  <p className="font-black text-xs uppercase tracking-tighter text-white">
                    {trade.instrument} <span className={trade.direction === 'Long' ? COLORS.textLong : COLORS.textShort}>{trade.direction}</span>
                  </p>
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-black uppercase tracking-tight text-slate-400 block mb-0.5">Trade PnL</span>
                  <p className={`font-black text-xs ${trade.pnl >= 0 ? COLORS.textProfit : COLORS.textLoss}`}>
                    {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </p>
                </div>
              </div>
            </div>
          )}

          {validVal !== undefined && (
            <div className="pt-2 border-t border-white/5">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400"></div>
                <span className="text-[10px] font-black uppercase tracking-tight text-amber-500/80">Disciplinovaná</span>
              </div>
              <p className={`font-black text-lg leading-none text-amber-400`}>
                ${validVal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </p>
            </div>
          )}
        </div>
        {trade && (
          <p className="mt-3 text-[8px] font-black text-blue-500 uppercase tracking-widest animate-pulse">Click for details</p>
        )}
      </div>
    );
  }
  return null;
};

const CustomBarTooltip = ({ active, payload, label, theme }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    const profit = data.profit;
    const loss = Math.abs(data.loss);
    const net = profit + data.loss;
    const winRate = data.winRate;
    const count = data.trades;

    return (
      <div className={`border p-4 rounded-lg shadow-xl z-[1000] min-w-[200px] ${theme === 'oled' ? 'bg-black border-white/10 text-white' :
        theme === 'dark' ? 'bg-[#0f172a] border-slate-700 text-white' :
          'bg-white border-slate-200 text-slate-900'
        }`}>
        <div className="flex justify-between items-center mb-2 pb-2 border-b border-gray-700/50">
          <span className="font-bold text-white">{label}</span>
          <span className="text-xs text-slate-400">{count} Obchodů</span>
        </div>
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between items-center">
            <span className="text-emerald-400">Hrubý zisk:</span>
            <span className="font-mono font-bold text-emerald-400">+${profit.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-rose-400">Hrubá ztráta:</span>
            <span className="font-mono font-bold text-rose-400">-${loss.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          </div>
          <div className={`flex justify-between items-center pt-2 mt-1 border-t ${theme !== 'light' ? 'border-slate-800' : 'border-slate-100'}`}>
            <span className="text-slate-400">Čisté PnL:</span>
            <span className={`font-mono font-bold ${net >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {net >= 0 ? '+' : ''}${net.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          </div>
          <div className="flex justify-between items-center mt-1">
            <span className="text-slate-500">Win Rate:</span>
            <span className="font-bold text-blue-400">{winRate.toFixed(1)}%</span>
          </div>
        </div>
      </div>
    );
  }
  return null;
};

const CustomActiveDot = (props: any) => {
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

const Charts: React.FC<ChartsProps> = ({ stats, theme, onlyEquity, onlyDistribution, isEditing, showDisciplinedCurve, onToggleDisciplined, onTradeClick }) => {
  const axisColor = theme !== 'light' ? '#64748b' : '#94a3b8';
  const gridColor = theme !== 'light' ? '#334155' : '#e2e8f0';

  const hourData = stats.hourStats;
  const dayData = stats.dayStats.filter(d => d.label !== 'So' && d.label !== 'Ne');

  const initialCap = stats.initialBalance;
  const equityData = stats.equityCurve.map((pt, i) => ({
    ...pt,
    name: pt.date === 'Start' ? 'Start' : (i),
    initial: initialCap
  }));

  const getGradientOffset = () => {
    const dataMax = Math.max(...equityData.map((i) => i.equity));
    const dataMin = Math.min(...equityData.map((i) => i.equity));
    if (dataMax <= initialCap) return 0;
    if (dataMin >= initialCap) return 1;
    return (dataMax - initialCap) / (dataMax - dataMin);
  };

  const off = getGradientOffset();

  return (
    <div className="space-y-8">

      {/* 1. EQUITY CURVE */}
      {!onlyDistribution && (
        <div className={`p-6 rounded-[32px] border transition-all overflow-visible ${theme === 'oled' ? 'bg-black border-white/10' :
          theme === 'dark' ? 'bg-[#0a0f1d]/90 border-white/5 backdrop-blur-xl' :
            'bg-white border-slate-200 shadow-sm'
          }`}>
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
            <div>
              <h3 className={`text-xs font-black uppercase tracking-widest flex items-center gap-2 ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>
                <Activity size={16} className="text-blue-500" /> Kapitálová křivka účtu
              </h3>
              <p className="text-[9px] font-bold text-slate-500 uppercase mt-1">Live Performance vs. Strategy Logic</p>
            </div>

            <div className="flex items-center gap-3">
              {/* Tlačítko se zobrazí pouze v režimu editace dashboardu a je propojené s props */}
              {isEditing && (
                <button
                  onClick={onToggleDisciplined}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-[10px] font-black uppercase transition-all active:scale-95 animate-in slide-in-from-right-4 duration-300 ${showDisciplinedCurve
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-500 ring-2 ring-amber-500/20'
                    : (theme !== 'light' ? 'bg-slate-800 border-slate-700 text-slate-500' : 'bg-slate-100 border-slate-200 text-slate-400')
                    }`}
                >
                  <ShieldCheck size={14} /> Disciplined Curve
                </button>
              )}
              <div className="h-8 w-px bg-slate-800 mx-1 hidden md:block"></div>
              <div className="flex flex-col items-end">
                <span className="text-[8px] uppercase font-black text-slate-500">Začátek</span>
                <span className="text-sm font-mono font-black text-blue-500">${initialCap.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              </div>
            </div>
          </div>

          <div className="h-[350px] w-full" style={{ outline: 'none' }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={equityData}
                margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                onClick={(data: any) => {
                  if (data && data.activePayload && data.activePayload[0]) {
                    const trade = data.activePayload[0].payload.trade;
                    if (trade && onTradeClick) {
                      onTradeClick(trade.id);
                    }
                  }
                }}
              >
                <defs>
                  <linearGradient id="splitColor" x1="0" y1="0" x2="0" y2="1">
                    <stop offset={off} stopColor={COLORS.profit} stopOpacity={1} />
                    <stop offset={off} stopColor={COLORS.loss} stopOpacity={1} />
                  </linearGradient>
                  <linearGradient id="splitFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset={0} stopColor={COLORS.profit} stopOpacity={0.2} />
                    <stop offset={off} stopColor={COLORS.profit} stopOpacity={0} />
                    <stop offset={off} stopColor={COLORS.loss} stopOpacity={0} />
                    <stop offset={1} stopColor={COLORS.loss} stopOpacity={0.2} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.1} vertical={false} />
                <XAxis
                  dataKey="name"
                  stroke={axisColor}
                  tick={false}
                  axisLine={false}
                />
                <YAxis
                  stroke={axisColor}
                  axisLine={false} tickLine={false}
                  tickFormatter={(val) => `$${val >= 1000 ? (val / 1000).toFixed(0) + 'k' : val}`}
                  width={45}
                  domain={['auto', 'auto']}
                  tick={{ fontSize: 10, fontStyle: 'italic', fontWeight: 'bold' }}
                />
                <Tooltip content={<CustomEquityTooltip theme={theme} />} cursor={{ stroke: axisColor, strokeDasharray: '5 5' }} allowEscapeViewBox={{ x: true, y: true }} />

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
                  strokeWidth={4}
                  fill="url(#splitFill)"
                  activeDot={(props) => <CustomActiveDot {...props} onTradeClick={onTradeClick} />}
                  style={{ cursor: 'pointer' }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-4 flex gap-6 justify-center">
            <div className="flex items-center gap-2">
              <div className="w-3 h-1 bg-blue-500 rounded"></div>
              <span className="text-[9px] font-black uppercase text-slate-500">Reálný vývoj</span>
            </div>
            {showDisciplinedCurve && (
              <div className="flex items-center gap-2">
                <div className="w-3 h-0.5 border-t-2 border-dashed border-amber-400"></div>
                <span className="text-[9px] font-black uppercase text-amber-500/80">Disciplinovaný (Zlatá cesta)</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. PERFORMANCE BY HOUR & DAY */}
      {!onlyEquity && (
        <div className="space-y-8">
          <div className={`p-6 rounded-[32px] border ${theme === 'oled' ? 'bg-black border-white/10' :
            theme === 'dark' ? 'bg-[#0a0f1d]/90 border-white/5 backdrop-blur-xl' :
              'bg-white border-slate-200 shadow-sm'
            }`}>
            <div className="flex justify-between items-center mb-6">
              <h3 className={`text-xs font-black uppercase tracking-widest flex items-center gap-2 ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>
                <Clock className="w-5 h-5 text-blue-500" /> Výkonnost podle hodin
              </h3>
            </div>

            <div className="h-[400px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourData} stackOffset="sign" margin={{ top: 20, right: 30, left: 20, bottom: 5 }} barGap={0}>
                  <defs>
                    <linearGradient id="profitGradientV" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.profit} /><stop offset="100%" stopColor="#059669" /></linearGradient>
                    <linearGradient id="lossGradientV" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.loss} /><stop offset="100%" stopColor="#fb7185" /></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} opacity={0.3} />
                  <XAxis dataKey="label" interval={0} stroke={axisColor} axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 'bold' }} dy={10} />
                  <YAxis stroke={axisColor} axisLine={false} tickLine={false} tickFormatter={(val) => `$${Math.abs(val) >= 1000 ? (val / 1000).toFixed(1) + 'k' : val}`} tick={{ fontSize: 10 }} />
                  <Tooltip content={<CustomBarTooltip theme={theme} />} cursor={{ fill: theme !== 'light' ? '#334155' : '#e2e8f0', opacity: 0.1 }} allowEscapeViewBox={{ x: true, y: true }} />
                  <ReferenceLine y={0} stroke={axisColor} />
                  <Bar dataKey="profit" stackId="hour" fill="url(#profitGradientV)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="loss" stackId="hour" fill="url(#lossGradientV)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className={`p-6 rounded-[32px] border ${theme === 'oled' ? 'bg-black border-white/10' :
            theme === 'dark' ? 'bg-[#0a0f1d]/90 border-white/5 backdrop-blur-xl' :
              'bg-white border-slate-200 shadow-sm'
            }`}>
            <div className="flex justify-between items-center mb-6">
              <h3 className={`text-xs font-black uppercase tracking-widest flex items-center gap-2 ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>
                <Calendar className="w-5 h-5 text-purple-500" /> Výkonnost podle dnů
              </h3>
            </div>
            <div className="h-[400px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart layout="vertical" data={dayData} margin={{ top: 5, right: 50, left: 20, bottom: 5 }} stackOffset="sign">
                  <defs>
                    <linearGradient id="profitGradientH" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={COLORS.profit} /><stop offset="100%" stopColor="#059669" /></linearGradient>
                    <linearGradient id="lossGradientH" x1="1" y1="0" x2="0" y2="0"><stop offset="0%" stopColor={COLORS.loss} /><stop offset="100%" stopColor="#fb7185" /></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={true} stroke={gridColor} opacity={0.3} />
                  <XAxis type="number" stroke={axisColor} axisLine={false} tickLine={false} tickFormatter={(val) => `$${Math.abs(val) >= 1000 ? (val / 1000).toFixed(0) + 'k' : val}`} />
                  <YAxis dataKey="label" type="category" stroke={axisColor} axisLine={false} tickLine={false} width={40} tick={{ fontWeight: 'bold', fontSize: 10 }} />
                  <Tooltip content={<CustomBarTooltip theme={theme} />} cursor={{ fill: theme !== 'light' ? '#334155' : '#e2e8f0', opacity: 0.1 }} allowEscapeViewBox={{ x: true, y: true }} />
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
