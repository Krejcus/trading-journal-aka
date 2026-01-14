import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trade, DailyPrep, DailyReview, Account, CustomEmotion } from '../types';
import {
   ChevronLeft,
   ChevronRight,
   Calendar as CalendarIcon,
   Star,
   Brain,
   Zap,
   Target,
   X,
   Coffee,
   Moon,
   TrendingUp,
   TrendingDown,
   AlertCircle,
   CheckCircle2,
   Clock,
   ArrowRight,
   BarChart3,
   Maximize2,
   Activity,
   ShieldCheck,
   ShieldAlert,
   History,
   ImageIcon,
   MessageSquare,
   Award,
   FileText,
   ListChecks,
   Info,
   LayoutGrid,
   Layers,
   Sun,
   ClipboardCheck,
   StickyNote,
   AlertOctagon,
   Monitor,
   Edit3,
   Trash2,
   ArrowUpRight,
   ArrowDownRight,
   Cpu,
   Terminal,
   List,
   Trophy,
   AlertTriangle,
   Flame,
   Snowflake,
   Timer
} from 'lucide-react';
import {
   BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, Cell, PieChart, Pie, AreaChart, Area, CartesianGrid
} from 'recharts';

interface DashboardCalendarProps {
   trades: Trade[];
   preps: DailyPrep[];
   reviews: DailyReview[];
   theme: 'dark' | 'light' | 'oled';
   accounts: Account[];
   emotions: CustomEmotion[];
   onDayClick?: (dateStr: string) => void;
   pnlFormat?: string;
}

interface DayData {
   dateStr: string;
   dateObj: Date;
   dayNum: number;
   pnl: number;
   wins: number;
   losses: number;
   trades: Trade[];
   isWeekend: boolean;
   hasTrades: boolean;
   hasPrep: boolean;
   hasReview: boolean;
   prep?: DailyPrep;
   review?: DailyReview;
   dominantEmotion?: string;
   rating?: number;
}

interface WeekData {
   weekIndex: number;
   pnl: number;
   days: DayData[];
   tradeCount: number;
   winRate: number;
}

interface GridCell {
   type: 'empty' | 'day' | 'summary';
   data?: DayData;
   summaryData?: WeekData;
}

const Tooltip: React.FC<{ text: string; theme: 'dark' | 'light' | 'oled'; subtext?: string }> = ({ text, theme, subtext }) => (
   <div className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-48 p-3 rounded-2xl border shadow-[0_20px_50px_rgba(0,0,0,0.5)] backdrop-blur-2xl z-[400] opacity-0 pointer-events-none transition-all duration-200 translate-y-2 scale-95 group-hover:opacity-100 group-hover:translate-y-0 group-hover:scale-100 ${theme === 'oled' ? 'bg-black border-white/10 text-slate-200' :
      theme === 'dark' ? 'bg-slate-900/95 border-slate-700 text-slate-200' :
         'bg-white/95 border-slate-200 text-slate-700'
      }`}>
      <div className="flex flex-col items-center gap-1">
         <div className="text-[10px] font-black uppercase tracking-widest opacity-60 text-center">{text}</div>
         {subtext && <div className="text-sm font-black text-center">{subtext}</div>}
      </div>
      <div className={`absolute top-full left-1/2 -translate-x-1/2 border-8 border-transparent ${theme !== 'light' ? 'border-t-slate-700' : 'border-t-slate-200'}`}></div>
   </div>
);

const InfoIcon: React.FC<{ text: string; theme: 'dark' | 'light' | 'oled' }> = ({ text, theme }) => (
   <div className="relative group inline-flex items-center">
      <div className="p-1 -m-1 cursor-help">
         <Info size={14} className="text-slate-500 opacity-40 hover:opacity-100 transition-opacity" />
      </div>
      <Tooltip text="Info" subtext={text} theme={theme} />
   </div>
);

const DashboardCalendar: React.FC<DashboardCalendarProps> = ({
   trades,
   preps,
   reviews,
   theme,
   accounts,
   emotions,
   onDayClick,
   pnlFormat
}) => {
   const [currentMonthIndex, setCurrentMonthIndex] = useState(0);
   const [selectedDay, setSelectedDay] = useState<DayData | null>(null);
   const [selectedWeek, setSelectedWeek] = useState<WeekData | null>(null);

   const monthsData = useMemo(() => {
      const allDates = new Set([
         ...trades.map(t => t.date.substring(0, 7)),
         ...preps.map(p => p.date.substring(0, 7)),
         ...reviews.map(r => r.date.substring(0, 7))
      ]);
      const now = new Date();
      allDates.add(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
      return Array.from(allDates).sort().reverse().map(key => {
         const [year, month] = key.split('-').map(Number);
         const monthTrades = trades.filter(t => t.date.startsWith(key));
         return { year, month, trades: monthTrades };
      });
   }, [trades, preps, reviews]);

   const handlePrevMonth = () => {
      if (currentMonthIndex < monthsData.length - 1) setCurrentMonthIndex(prev => prev + 1);
   };
   const handleNextMonth = () => {
      if (currentMonthIndex > 0) setCurrentMonthIndex(prev => prev - 1);
   };

   if (monthsData.length === 0) return (
      <div className={`p-8 text-center rounded-xl border border-dashed ${theme !== 'light' ? 'border-slate-700 text-slate-500' : 'border-slate-300 text-slate-400'}`}>
         Žádná data pro kalendář.
      </div>
   );

   const currentData = monthsData[currentMonthIndex];

   return (
      <div className="relative h-full flex flex-col">
         <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 h-full flex flex-col">
            <SingleMonthView
               year={currentData.year}
               month={currentData.month}
               trades={currentData.trades}
               preps={preps}
               reviews={reviews}
               theme={theme}
               onPrev={handlePrevMonth}
               onNext={handleNextMonth}
               canPrev={true}
               canNext={true}
               onDayClick={(day) => {
                  if (onDayClick) onDayClick(day.dateStr);
                  else setSelectedDay(day);
               }}
               onWeekClick={setSelectedWeek}
               pnlFormat={pnlFormat}
            />
         </div>
         {selectedDay && createPortal(
            <DayDeepDiveModal day={selectedDay} theme={theme} onClose={() => setSelectedDay(null)} accounts={accounts} emotions={emotions} pnlFormat={pnlFormat} />,
            document.body
         )}
         {selectedWeek && createPortal(
            <WeekDetailModal week={selectedWeek} monthName={new Date(currentData.year, currentData.month - 1, 1).toLocaleString('cs-CZ', { month: 'long' })} theme={theme} onClose={() => setSelectedWeek(null)} accounts={accounts} emotions={emotions} pnlFormat={pnlFormat} />,
            document.body
         )}
      </div>
   );
};

const SingleMonthView: React.FC<SingleMonthViewProps> = ({ year, month, trades, preps, reviews, theme, onPrev, onNext, canPrev, canNext, onDayClick, onWeekClick, pnlFormat }) => {
   const gridRows = useMemo(() => {
      const rows: GridCell[][] = [];
      const daysInMonth = new Date(year, month, 0).getDate();
      const firstDayObj = new Date(year, month - 1, 1);
      let currentRow: GridCell[] = [];
      let weekDaysData: DayData[] = [];
      let jsDay = firstDayObj.getDay();
      let paddingCount = (jsDay === 0 ? 6 : jsDay - 1);
      for (let i = 0; i < paddingCount; i++) if (currentRow.length < 5) currentRow.push({ type: 'empty' });

      for (let day = 1; day <= daysInMonth; day++) {
         const dateObj = new Date(year, month - 1, day);
         const dateStr = dateObj.toLocaleDateString('en-CA');
         const dayOfWeek = dateObj.getDay();
         const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

         // Filter trades for the day
         const dayTrades = trades.filter(t => t.date.startsWith(dateStr));
         // Filter out MISSED trades for financial stats
         const realTrades = dayTrades.filter(t => t.executionStatus !== 'Missed');

         const pnl = realTrades.reduce((acc, t) => acc + t.pnl, 0);
         const prep = preps.find(p => p.date === dateStr);
         const review = reviews.find(r => r.date === dateStr);

         // Emotion logic using only real trades
         const emotions = realTrades.flatMap(t => t.emotions || []);
         const emotionCounts: Record<string, number> = {};
         emotions.forEach(e => emotionCounts[e] = (emotionCounts[e] || 0) + 1);
         const dominantEmotion = Object.entries(emotionCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

         const dayData: DayData = {
            dateStr, dateObj, dayNum: day, pnl,
            wins: realTrades.filter(t => t.pnl > 0).length,
            losses: realTrades.filter(t => t.pnl < 0).length,
            trades: dayTrades, // Keep missed trades for the detail modal list
            isWeekend,
            hasTrades: realTrades.length > 0, // Only color cell if real trades were taken
            hasPrep: !!prep, hasReview: !!review, prep, review,
            dominantEmotion, rating: review?.rating
         };

         if (!isWeekend) { currentRow.push({ type: 'day', data: dayData }); weekDaysData.push(dayData); }
         const isSunday = dayOfWeek === 0;
         const isLastDay = day === daysInMonth;
         if (isSunday || isLastDay) {
            while (currentRow.length < 5 && currentRow.length > 0) currentRow.push({ type: 'empty' });
            if (currentRow.length > 0) {
               const weekPnl = weekDaysData.reduce((acc, d) => acc + d.pnl, 0);
               const weekTradesCount = weekDaysData.reduce((acc, d) => acc + d.trades.filter(t => t.executionStatus !== 'Missed').length, 0);
               const weekWins = weekDaysData.reduce((acc, d) => acc + d.wins, 0);
               currentRow.push({ type: 'summary', summaryData: { weekIndex: rows.length + 1, pnl: weekPnl, days: [...weekDaysData], tradeCount: weekTradesCount, winRate: weekTradesCount > 0 ? (weekWins / weekTradesCount) * 100 : 0 } });
               rows.push(currentRow);
            }
            currentRow = []; weekDaysData = [];
         }
      }
      return rows;
   }, [year, month, trades, preps, reviews]);

   const monthName = new Date(year, month - 1, 1).toLocaleString('cs-CZ', { month: 'long', year: 'numeric' });

   // Overall month PNL should also exclude missed
   const totalMonthPnl = useMemo(() => {
      return trades.filter(t => t.executionStatus !== 'Missed').reduce((acc, t) => acc + t.pnl, 0);
   }, [trades]);

   const maxDayPnL = useMemo(() => {
      const absolutePnLs = gridRows.flatMap(row => row.map(cell => cell.type === 'day' ? Math.abs(cell.data!.pnl) : 0));
      return Math.max(...absolutePnLs, 1);
   }, [gridRows]);

   const DAY_LABELS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'Týden'];

   return (
      <div className={`rounded-[32px] border shadow-sm overflow-hidden transition-all flex flex-col h-full ${theme === 'oled' ? 'bg-black border-white/10 shadow-none' :
         theme === 'dark' ? 'bg-[#0a0f1d]/90 border-white/5 shadow-2xl backdrop-blur-xl' :
            'bg-white border-slate-200'
         }`}>
         <div className={`px-6 py-6 border-b flex flex-col md:flex-row justify-between md:items-center gap-4 ${theme !== 'light' ? 'border-white/5' : 'border-slate-100 bg-slate-50/80'}`}>
            <div className="flex flex-col gap-4">
               <h3 className={`text-[10px] font-black uppercase tracking-[0.2em] flex items-center gap-2 ${theme !== 'light' ? 'text-slate-400' : 'text-slate-500'}`}>
                  <LayoutGrid size={14} className="text-blue-500" /> Obchodní Kalendář
                  <InfoIcon text="Denní přehled výsledků v kalendářním zobrazení. Zmeškané obchody neovlivňují statistiky ani barvu." theme={theme} />
               </h3>
               <div className="flex items-center gap-3 select-none ml-0.5">
                  <button onClick={onPrev} disabled={!canPrev} className={`p-1.5 rounded-xl transition-all ${!canPrev ? 'opacity-20 pointer-events-none' : (theme !== 'light' ? 'bg-white/5 hover:bg-white/10 text-slate-300 border border-white/5' : 'bg-slate-100 hover:bg-slate-200')}`}><ChevronLeft size={18} /></button>
                  <div className="min-w-[130px]"><h3 className={`text-xl font-black capitalize leading-none tracking-tighter ${theme !== 'light' ? 'text-white' : 'text-blue-600'}`}>{monthName}</h3></div>
                  <button onClick={onNext} disabled={!canNext} className={`p-1.5 rounded-xl transition-all ${!canNext ? 'opacity-20 pointer-events-none' : (theme !== 'light' ? 'bg-white/5 hover:bg-white/10 text-slate-300 border border-white/5' : 'bg-slate-100 hover:bg-slate-200')}`}><ChevronRight size={18} /></button>
               </div>
            </div>
            <div className={`flex flex-col items-end gap-1 px-5 py-3 rounded-2xl border ${theme === 'oled' ? 'bg-black border-white/10' :
               theme === 'dark' ? 'bg-slate-900/50 border-white/5' :
                  'bg-white border-slate-200'
               }`}>
               <span className="text-[8px] font-black uppercase tracking-[0.2em] text-slate-500">Měsíční PnL</span>
               <span className={`text-2xl font-mono font-black tracking-tighter ${totalMonthPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                  {totalMonthPnl >= 0 ? '+' : '-'}{pnlFormat === 'rr' ? `${Math.abs(totalMonthPnl).toFixed(2)}R` : `$${Math.abs(totalMonthPnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
               </span>
            </div>
         </div>

         <div className="grid grid-cols-6 gap-3 p-4 pb-0">
            {DAY_LABELS.map((label, idx) => (
               <div key={label} className={`py-2 rounded-xl text-center text-[10px] font-black uppercase tracking-widest border transition-colors ${idx === 5
                  ? 'text-blue-500 bg-blue-500/5 border-blue-500/20'
                  : (theme === 'oled' ? 'text-slate-500 bg-black border-white/10' :
                     theme === 'dark' ? 'text-slate-500 bg-white/5 border-white/5' :
                        'text-slate-400 bg-slate-50 border-slate-100')
                  }`}>
                  {label}
               </div>
            ))}
         </div>

         <div className="p-4 space-y-3 flex-1 overflow-y-auto no-scrollbar">
            {gridRows.map((row, rIdx) => (
               <div key={rIdx} className="grid grid-cols-6 gap-3">
                  {row.map((cell, cIdx) => (
                     <CalendarCell key={cIdx} cell={cell} theme={theme} maxPnL={maxDayPnL} onDayClick={onDayClick} onWeekClick={onWeekClick} />
                  ))}
               </div>
            ))}
         </div>
      </div>
   );
};

const CalendarCell: React.FC<{ cell: GridCell; theme: 'dark' | 'light' | 'oled'; maxPnL: number; onDayClick: (day: DayData) => void; onWeekClick: (week: WeekData) => void; pnlFormat?: string }> = ({ cell, theme, maxPnL, onDayClick, onWeekClick, pnlFormat }) => {
   if (cell.type === 'empty') return <div className="aspect-square opacity-0"></div>;
   if (cell.type === 'summary') {
      const week = cell.summaryData!;
      const { pnl, weekIndex } = week;
      return (
         <div onClick={() => onWeekClick(week)} className={`aspect-square rounded-2xl flex flex-col items-center justify-center p-2 border transition-all cursor-pointer relative overflow-hidden group hover:ring-2 hover:ring-blue-500/50 ${theme === 'oled' ? 'bg-black border-white/10 text-slate-400 hover:bg-white/5' :
            theme === 'dark' ? 'bg-white/5 border-white/5 text-slate-400 hover:bg-white/10' :
               'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
            }`}>
            <div className={`absolute top-0 w-full h-1 ${pnl >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`}></div>
            <span className="text-[8px] font-black uppercase tracking-widest opacity-60 mb-1">T{weekIndex}</span>
            <span className={`font-bold font-mono text-xs md:text-sm ${pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{pnl >= 0 ? '+' : '-'}{pnlFormat === 'rr' ? `${Math.abs(pnl).toFixed(2)}R` : `$${Math.abs(pnl) >= 1000 ? (Math.abs(pnl) / 1000).toFixed(1) + 'k' : Math.abs(pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}</span>
            <div className="absolute inset-0 bg-blue-500/0 group-hover:bg-blue-500/5 transition-colors duration-200" />
         </div>
      );
   }
   const day = cell.data!;
   const intensity = day.hasTrades ? Math.max(0.15, Math.min(1, Math.abs(day.pnl) / maxPnL)) : 0;
   let bgStyle = {};
   let borderClass = theme !== 'light' ? 'border-white/5' : 'border-slate-100';
   if (day.hasTrades) {
      const color = day.pnl >= 0 ? '16, 185, 129' : '244, 63, 94';
      bgStyle = { backgroundColor: `rgba(${color}, ${intensity})` };
      borderClass = day.pnl >= 0 ? 'border-emerald-500/30' : 'border-rose-500/30';
   }
   return (
      <div onClick={() => onDayClick(day)} className={`aspect-square rounded-2xl p-2 md:p-3 flex flex-col justify-between cursor-pointer border relative overflow-hidden transition-all group hover:ring-2 hover:ring-slate-500/30 ${borderClass} ${theme === 'oled' ? 'bg-black hover:bg-white/5 shadow-none' :
         theme === 'dark' ? 'bg-white/5 hover:bg-white/10' :
            'bg-white shadow-sm hover:shadow-md'
         }`} style={bgStyle}>
         <div className="absolute top-2 left-2 flex gap-1">
            {day.hasPrep && <div className={`w-1.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_5px_rgba(59,130,246,0.8)]`} />}
            {day.hasReview && <div className={`w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_5px_rgba(99,102,241,0.8)]`} />}
         </div>
         <div className="flex justify-end items-start"><span className={`font-mono text-xs font-black ${!day.hasTrades && (theme !== 'light' ? 'text-slate-700' : 'text-slate-300')}`}>{day.dayNum}</span></div>
         <div className="flex-1 flex items-center justify-center">
            {day.hasTrades ? <span className={`font-bold text-sm md:text-base tracking-tighter ${intensity > 0.6 ? 'text-white' : (day.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500')}`}>{day.pnl >= 0 ? '+' : '-'}{pnlFormat === 'rr' ? `${Math.abs(day.pnl).toFixed(2)}R` : `$${Math.abs(day.pnl) >= 1000 ? (Math.abs(day.pnl) / 1000).toFixed(1) + 'k' : Math.abs(day.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}</span> : null}
         </div>
         <div className="absolute inset-0 bg-white/0 group-hover:bg-white/5 transition-colors duration-200" />
      </div>
   );
};

const WeekDetailModal: React.FC<{ week: WeekData; monthName: string; theme: 'dark' | 'light' | 'oled'; onClose: () => void; accounts: Account[]; emotions: CustomEmotion[]; pnlFormat?: string }> = ({ week, monthName, theme, onClose, accounts, emotions, pnlFormat }) => {
   const isDark = theme !== 'light';
   const [activeTab, setActiveTab] = useState<'overview' | 'trades'>('overview');
   const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);

   // Aggregate all trades for the week
   const allWeekTrades = useMemo(() => {
      return week.days.flatMap(d => d.trades).sort((a, b) => b.timestamp - a.timestamp);
   }, [week]);

   // --- STATISTICAL INTELLIGENCE ---
   // Statistics should exclude missed
   const realWeekTrades = useMemo(() => allWeekTrades.filter(t => t.executionStatus !== 'Missed'), [allWeekTrades]);
   const wins = realWeekTrades.filter(t => t.pnl > 0).length;
   const losses = realWeekTrades.filter(t => t.pnl < 0).length;
   const validTrades = realWeekTrades.filter(t => t.executionStatus === 'Valid').length;
   const invalidTrades = realWeekTrades.filter(t => t.executionStatus === 'Invalid').length;

   // Extremes
   const sortedByPnL = [...realWeekTrades].sort((a, b) => b.pnl - a.pnl);
   const maxWin = sortedByPnL[0]?.pnl > 0 ? sortedByPnL[0] : null;
   const maxLoss = sortedByPnL[sortedByPnL.length - 1]?.pnl < 0 ? sortedByPnL[sortedByPnL.length - 1] : null;

   // Best/Worst Day (already excludes missed in hasTrades)
   const daysWithTrades = week.days.filter(d => d.hasTrades).sort((a, b) => b.pnl - a.pnl);
   const bestDay = daysWithTrades[0];
   const worstDay = daysWithTrades[daysWithTrades.length - 1];

   // Best/Worst Session
   const sessionStats = useMemo(() => {
      const map = new Map<string, number>();
      realWeekTrades.forEach(t => {
         const s = t.session || 'Unknown';
         map.set(s, (map.get(s) || 0) + t.pnl);
      });
      const sorted = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
      return {
         best: sorted[0],
         worst: sorted[sorted.length - 1]
      };
   }, [realWeekTrades]);

   // Stat Card Component
   const StatCard = ({ icon, label, value, subValue, color, subColor }: any) => (
      <div className={`p-4 rounded-2xl border flex flex-col justify-between ${isDark ? 'bg-white/5 border-white/5' : 'bg-white border-slate-100'}`}>
         <div className="flex justify-between items-start mb-2">
            <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">{label}</p>
            <div className={`p-1.5 rounded-lg ${isDark ? 'bg-white/5' : 'bg-slate-50'} ${color}`}>{icon}</div>
         </div>
         <div>
            <p className={`text-lg font-black tracking-tight ${color}`}>{value}</p>
            {subValue && <p className={`text-[10px] font-bold ${subColor || 'text-slate-500'}`}>{subValue}</p>}
         </div>
      </div>
   );

   return (
      <>
         <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xl animate-in fade-in duration-300">
            <div className={`w-full max-w-6xl h-[85vh] rounded-[32px] overflow-hidden shadow-2xl flex flex-col border ${isDark ? 'bg-[#0a0f1d] border-white/10' : 'bg-white border-slate-200'}`}>
               <div className={`h-20 shrink-0 border-b flex items-center justify-between px-8 ${isDark ? 'border-white/5 bg-[#0a0f1d]' : 'bg-white border-slate-100'}`}>
                  <div className="flex items-center gap-4">
                     <div className="p-2.5 rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-500/20"><CalendarIcon size={20} /></div>
                     <div>
                        <h2 className={`text-xl font-black tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>WEEK {week.weekIndex}</h2>
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{monthName} Report</p>
                     </div>
                  </div>
                  <div className="flex items-center gap-6">
                     <div className="text-right">
                        <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Net Result</p>
                        <p className={`text-3xl font-black font-mono leading-none ${week.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                           {week.pnl >= 0 ? '+' : '-'}{pnlFormat === 'rr' ? `${Math.abs(week.pnl).toFixed(2)}R` : `$${Math.abs(week.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                        </p>
                     </div>
                     <button onClick={onClose} className="p-2.5 hover:bg-white/10 rounded-full transition-all text-slate-500 hover:text-white"><X size={24} /></button>
                  </div>
               </div>

               <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
                  <div className={`w-full lg:w-[40%] overflow-y-auto custom-scrollbar border-r p-6 flex flex-col gap-6 ${isDark ? 'bg-[#0F172A]/50 border-white/5' : 'bg-slate-50 border-slate-200'}`}>
                     <div className="grid grid-cols-2 gap-4">
                        <div className="col-span-2 p-5 rounded-[24px] border border-blue-500/20 bg-blue-500/5 relative overflow-hidden">
                           <div className="flex justify-between items-center mb-4 relative z-10">
                              <span className="text-[10px] font-black uppercase text-blue-400 tracking-widest flex items-center gap-2"><Target size={14} /> Execution</span>
                              <span className="text-xs font-black text-white">{week.tradeCount} Trades</span>
                           </div>
                           <div className="grid grid-cols-2 gap-4 relative z-10">
                              <div>
                                 <p className="text-[9px] font-bold text-slate-500 uppercase">Valid</p>
                                 <p className="text-xl font-black text-emerald-500">{validTrades}</p>
                              </div>
                              <div>
                                 <p className="text-[9px] font-bold text-slate-500 uppercase">Invalid</p>
                                 <p className="text-xl font-black text-rose-500">{invalidTrades}</p>
                              </div>
                              <div className="col-span-2 h-2 rounded-full bg-slate-900 overflow-hidden flex">
                                 <div style={{ width: `${week.tradeCount > 0 ? (validTrades / week.tradeCount) * 100 : 0}%` }} className="bg-emerald-500 h-full" />
                                 <div style={{ width: `${week.tradeCount > 0 ? (invalidTrades / week.tradeCount) * 100 : 0}%` }} className="bg-rose-500 h-full" />
                              </div>
                           </div>
                        </div>
                        <StatCard icon={<TrendingUp size={16} />} label="Wins" value={wins} color="text-emerald-500" subValue={`${week.tradeCount > 0 ? ((wins / week.tradeCount) * 100).toFixed(0) : 0}% Rate`} subColor="text-emerald-500/60" />
                        <StatCard icon={<TrendingDown size={16} />} label="Losses" value={losses} color="text-rose-500" subValue={`${week.tradeCount > 0 ? ((losses / week.tradeCount) * 100).toFixed(0) : 0}% Rate`} subColor="text-rose-500/60" />
                        <StatCard icon={<Trophy size={16} />} label="Max Win" value={maxWin ? (pnlFormat === 'rr' ? `+${maxWin.pnl}R` : `+$${maxWin.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`) : '-'} color="text-emerald-400" subValue={maxWin?.instrument} />
                        <StatCard icon={<Trophy size={16} />} label="Max Loss" value={maxLoss ? (pnlFormat === 'rr' ? `-${Math.abs(maxLoss.pnl).toFixed(2)}R` : `-$${Math.abs(maxLoss.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`) : '-'} color="text-rose-400" subValue={maxLoss?.instrument} />
                     </div>
                  </div>

                  <div className={`flex-1 flex flex-col overflow-hidden ${isDark ? 'bg-[#050914]' : 'bg-slate-100'}`}>
                     <div className={`flex p-1 mx-6 mt-6 mb-2 rounded-xl border ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                        <button onClick={() => setActiveTab('overview')} className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${activeTab === 'overview' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}><LayoutGrid size={12} /> Daily Overview</button>
                        <button onClick={() => setActiveTab('trades')} className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${activeTab === 'trades' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}><List size={12} /> Trade Feed ({allWeekTrades.length})</button>
                     </div>
                     <div className="flex-1 overflow-y-auto custom-scrollbar p-6 pt-2">
                        {activeTab === 'overview' ? (
                           <div className="space-y-2">
                              {week.days.map((day) => (
                                 <div key={day.dateStr} className={`p-4 rounded-2xl border flex items-center justify-between transition-all hover:scale-[1.01] ${isDark ? 'bg-[#0a0f1d] border-white/5' : 'bg-white border-slate-200 shadow-sm'}`}>
                                    <div className="flex items-center gap-4">
                                       <div className={`w-12 h-12 rounded-xl flex flex-col items-center justify-center border font-black ${day.hasTrades ? (day.pnl >= 0 ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500' : 'bg-rose-500/10 border-rose-500/20 text-rose-500') : (isDark ? 'bg-slate-800 border-slate-700 text-slate-500' : 'bg-slate-100 border-slate-200 text-slate-400')}`}>
                                          <span className="text-[10px] uppercase leading-none">{day.dateObj.toLocaleString('cs-CZ', { weekday: 'short' })}</span>
                                          <span className="text-xs leading-none mt-0.5">{day.dayNum}</span>
                                       </div>
                                       <div>
                                          <div className="flex items-center gap-2"><span className="text-xs font-black uppercase tracking-tight">{day.trades.filter(t => t.executionStatus !== 'Missed').length} Trades</span>{day.hasPrep && day.hasReview && <CheckCircle2 size={12} className="text-blue-500" />}</div>
                                          <p className="text-[10px] text-slate-500 truncate max-w-[200px] italic">{day.review?.mainTakeaway || (day.prep?.goals[0] ? `Goal: ${day.prep.goals[0]}` : "No notes")}</p>
                                       </div>
                                    </div>
                                    <div className="text-right"><span className={`text-lg font-black font-mono ${day.hasTrades ? (day.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500') : 'text-slate-500'}`}>{day.hasTrades ? (day.pnl >= 0 ? '+' : '-') : ''}{pnlFormat === 'rr' ? `${Math.abs(day.pnl).toFixed(2)}R` : `$${Math.abs(day.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}</span></div>
                                 </div>
                              ))}
                           </div>
                        ) : (
                           <div className="space-y-2">
                              {allWeekTrades.length > 0 ? allWeekTrades.map((trade) => (
                                 <div key={trade.id} onClick={() => setSelectedTrade(trade)} className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition-all hover:scale-[1.01] hover:border-blue-500/30 ${isDark ? 'bg-[#0a0f1d] border-white/5' : 'bg-white border-slate-200'} ${trade.executionStatus === 'Missed' ? 'opacity-60' : ''}`}>
                                    <div className="flex items-center gap-3">
                                       <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${trade.executionStatus === 'Missed' ? 'bg-blue-500/10 border-blue-500/20 text-blue-400' : (trade.pnl >= 0 ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500' : 'bg-rose-500/10 border-rose-500/20 text-rose-500')}`}>{trade.executionStatus === 'Missed' ? <Clock size={16} /> : (trade.direction === 'Long' ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />)}</div>
                                       <div>
                                          <div className="flex items-center gap-2"><span className="text-xs font-black uppercase">{trade.instrument}</span><span className="text-[9px] font-mono text-slate-500">{new Date(trade.timestamp).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}</span></div>
                                          <div className="flex gap-1 mt-0.5">{trade.executionStatus === 'Missed' && <span className="text-[8px] bg-blue-500/20 text-blue-400 px-1.5 rounded uppercase font-bold">Missed</span>}{trade.mistakes && trade.mistakes.length > 0 && <span className="text-[8px] bg-rose-500/20 text-rose-500 px-1.5 rounded uppercase font-bold">Mistake</span>}</div>
                                       </div>
                                    </div>
                                    <div className="text-right"><span className={`text-sm font-black font-mono ${trade.executionStatus === 'Missed' ? 'text-blue-400' : (trade.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500')}`}>{trade.executionStatus === 'Missed' ? '±' : (trade.pnl >= 0 ? '+' : '-')}{pnlFormat === 'rr' ? `${Math.abs(trade.pnl)}R` : `$${Math.abs(trade.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}</span></div>
                                 </div>
                              )) : <div className="text-center py-10 opacity-30"><p className="text-[10px] font-black uppercase">No trades this week</p></div>}
                           </div>
                        )}
                     </div>
                  </div>
               </div>
            </div>
         </div>
         {selectedTrade && <TradeDetailOverlay trade={selectedTrade} theme={theme} onClose={() => setSelectedTrade(null)} accounts={accounts} emotions={emotions} />}
      </>
   );
};

const DayDeepDiveModal: React.FC<{ day: DayData; theme: 'dark' | 'light' | 'oled'; onClose: () => void; accounts: Account[]; emotions: CustomEmotion[]; pnlFormat?: string }> = ({ day, theme, onClose, accounts, emotions, pnlFormat }) => {
   const { dateObj, pnl, trades, prep, review, dominantEmotion, hasTrades } = day;
   const isDark = theme !== 'light';
   const formattedDate = dateObj.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
   const [zoomImg, setZoomImg] = useState<string | null>(null);
   const [activeTab, setActiveTab] = useState<'narrative' | 'trades'>('narrative');
   const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);

   const screenshots = [
      ...(prep?.scenarios.scenarioImages || []),
      ...(prep?.scenarios.bullishImage ? [prep.scenarios.bullishImage] : []),
      ...(prep?.scenarios.bearishImage ? [prep.scenarios.bearishImage] : []),
      ...trades.flatMap(t => t.screenshots && t.screenshots.length > 0 ? t.screenshots : (t.screenshot ? [t.screenshot] : []))
   ];

   const realDayTrades = trades.filter(t => t.executionStatus !== 'Missed');

   return (
      <>
         <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xl animate-in fade-in duration-300">
            <div className={`w-full max-w-7xl h-[85vh] rounded-[32px] overflow-hidden shadow-2xl flex flex-col border ${isDark ? 'bg-[#0a0f1d] border-white/10' : 'bg-white border-slate-200'}`}>
               <div className={`h-20 shrink-0 border-b flex items-center justify-between px-8 ${isDark ? 'border-white/5 bg-[#0a0f1d]' : 'bg-white border-slate-100'}`}>
                  <div className="flex items-center gap-4">
                     <div className={`p-2.5 rounded-xl text-white shadow-lg ${hasTrades ? (pnl >= 0 ? 'bg-emerald-500 shadow-emerald-500/20' : 'bg-rose-500 shadow-rose-500/20') : 'bg-slate-700'}`}>
                        <Activity size={20} />
                     </div>
                     <div>
                        <h2 className={`text-lg font-black tracking-tight uppercase ${isDark ? 'text-white' : 'text-slate-900'}`}>{formattedDate}</h2>
                        <div className="flex items-center gap-2">{review?.rating && <div className="flex gap-0.5">{[1, 2, 3, 4, 5].map(s => <div key={s} className={`w-1 h-1 rounded-full ${s <= review.rating ? 'bg-yellow-500' : 'bg-slate-700'}`} />)}</div>}<span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Daily Log</span></div>
                     </div>
                  </div>
                  <div className="flex items-center gap-6">
                     <div className="text-right">
                        <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Daily PnL</p>
                        <p className={`text-3xl font-black font-mono leading-none ${hasTrades ? (pnl >= 0 ? 'text-emerald-500' : 'text-rose-500') : 'text-slate-500'}`}>
                           {hasTrades ? (pnl >= 0 ? '+' : '-') : ''}{pnlFormat === 'rr' ? `${Math.abs(pnl).toFixed(2)}R` : `$${Math.abs(pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                        </p>
                     </div>
                     <button onClick={onClose} className="p-2.5 hover:bg-white/10 rounded-full transition-all text-slate-500 hover:text-white"><X size={24} /></button>
                  </div>
               </div>

               <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
                  <div className={`w-full lg:w-[35%] flex flex-col border-r ${isDark ? 'bg-[#0F172A]/50 border-white/5' : 'bg-slate-50 border-slate-200'}`}>
                     <div className={`grid grid-cols-3 border-b ${isDark ? 'border-white/5' : 'border-slate-200'}`}>
                        <div className="p-4 border-r border-white/5 text-center"><p className="text-[9px] font-black uppercase text-slate-500 mb-1">Trades</p><p className="text-xl font-black">{realDayTrades.length}</p></div>
                        <div className="p-4 border-r border-white/5 text-center"><p className="text-[9px] font-black uppercase text-slate-500 mb-1">Win Rate</p><p className="text-xl font-black text-blue-500">{realDayTrades.length > 0 ? ((realDayTrades.filter(t => t.pnl > 0).length / realDayTrades.length) * 100).toFixed(0) : 0}%</p></div>
                        <div className="p-4 text-center"><p className="text-[9px] font-black uppercase text-slate-500 mb-1">Mood</p><p className="text-xl font-black text-purple-500 capitalize">{dominantEmotion || '-'}</p></div>
                     </div>
                     <div className={`flex p-1 border-b ${isDark ? 'border-white/5 bg-slate-900/50' : 'border-slate-200 bg-slate-100'}`}>
                        <button onClick={() => setActiveTab('narrative')} className={`flex-1 py-2 text-[9px] font-black uppercase tracking-widest rounded-lg transition-all ${activeTab === 'narrative' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>Context Feed</button>
                        <button onClick={() => setActiveTab('trades')} className={`flex-1 py-2 text-[9px] font-black uppercase tracking-widest rounded-lg transition-all ${activeTab === 'trades' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>Trade List ({trades.length})</button>
                     </div>
                     <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
                        {activeTab === 'narrative' ? (
                           <>{prep && (<div className="space-y-3"><p className="text-[9px] font-black uppercase text-blue-500 flex items-center gap-2"><Sun size={12} /> Morning Prep</p><div className={`p-4 rounded-xl text-xs leading-relaxed italic border ${isDark ? 'bg-blue-500/5 border-blue-500/10 text-slate-300' : 'bg-white border-blue-100 text-slate-600'}`}>{prep.scenarios.bullish || prep.scenarios.bearish || "No notes."}</div></div>)}{review && (<div className="space-y-3"><p className="text-[9px] font-black uppercase text-indigo-500 flex items-center gap-2"><Moon size={12} /> Evening Audit</p><div className={`p-4 rounded-xl text-xs leading-relaxed italic border ${isDark ? 'bg-indigo-500/5 border-indigo-500/10 text-slate-300' : 'bg-white border-indigo-100 text-slate-600'}`}>{review.mainTakeaway || "No review."}</div>{review.mistakes.length > 0 && review.mistakes[0] && (<div className="flex flex-wrap gap-2 pt-2">{review.mistakes.map(m => <span key={m} className="px-2 py-1 rounded bg-rose-500/10 text-rose-500 text-[9px] font-black uppercase border border-rose-500/20">{m}</span>)}</div>)}</div>)}{!prep && !review && <div className="text-center opacity-30 mt-10"><FileText size={32} className="mx-auto mb-2" /><p className="text-[10px] uppercase font-black">No Data</p></div>}</>
                        ) : (
                           <div className="space-y-2">
                              {trades.map((t, i) => (
                                 <div key={i} onClick={() => setSelectedTrade(t)} className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition-all hover:scale-[1.02] ${isDark ? 'bg-white/5 border-white/5 hover:bg-white/10' : 'bg-white border-slate-100 hover:shadow-md'} ${t.executionStatus === 'Missed' ? 'opacity-60' : ''}`}>
                                    <div className="flex items-center gap-3">
                                       <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${t.executionStatus === 'Missed' ? 'bg-blue-500/20 text-blue-400' : (t.direction === 'Long' ? 'bg-emerald-500/20 text-emerald-500' : 'bg-rose-500/20 text-rose-500')}`}>{t.executionStatus === 'Missed' ? 'MISSED' : t.direction}</span>
                                       <div><p className="text-[10px] font-black uppercase">{t.instrument}</p><p className="text-[9px] text-slate-500 font-mono">{t.duration}</p></div>
                                    </div>
                                    <div className="flex items-center gap-3"><span className={`text-sm font-black font-mono ${t.executionStatus === 'Missed' ? 'text-blue-400' : (t.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500')}`}>{t.executionStatus === 'Missed' ? '±' : (t.pnl >= 0 ? '+' : '-')}{pnlFormat === 'rr' ? `${Math.abs(t.pnl)}R` : `$${Math.abs(t.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}</span><ArrowRight size={12} className="text-slate-600" /></div>
                                 </div>
                              ))}
                           </div>
                        )}
                     </div>
                  </div>
                  <div className={`flex-1 relative flex flex-col ${isDark ? 'bg-[#050914]' : 'bg-slate-100'}`}>
                     <div className="flex-1 relative overflow-hidden flex items-center justify-center p-4">{screenshots.length > 0 ? (<img src={zoomImg || screenshots[0]} className="max-w-full max-h-full object-contain rounded-xl shadow-2xl" />) : (<div className="text-center opacity-20"><ImageIcon size={64} className="mx-auto mb-4" /><p className="text-xs font-black uppercase tracking-[0.2em]">Visual Data Missing</p></div>)}</div>
                     {screenshots.length > 1 && (<div className={`h-24 border-t shrink-0 flex items-center gap-3 px-4 overflow-x-auto ${isDark ? 'bg-[#0a0f1d] border-white/5' : 'bg-white border-slate-200'}`}>{screenshots.map((src, i) => (<div key={i} onClick={() => setZoomImg(src)} className={`h-16 aspect-video rounded-lg border overflow-hidden cursor-pointer transition-all ${src === (zoomImg || screenshots[0]) ? 'ring-2 ring-blue-500' : 'opacity-50 hover:opacity-100'}`}><img src={src} className="w-full h-full object-cover" /></div>))}</div>)}
                  </div>
               </div>
            </div>
         </div>
         {selectedTrade && <TradeDetailOverlay trade={selectedTrade} theme={theme} onClose={() => setSelectedTrade(null)} accounts={accounts} emotions={emotions} />}
      </>
   );
};

const TradeDetailOverlay: React.FC<{ trade: Trade, theme: 'dark' | 'light' | 'oled', onClose: () => void, accounts: Account[], emotions: CustomEmotion[] }> = ({ trade, theme, onClose, accounts, emotions }) => {
   const isDark = theme !== 'light';
   const [isZoomed, setIsZoomed] = useState(false);
   const [activeImageIndex, setActiveImageIndex] = useState(0);

   const images = trade.screenshots && trade.screenshots.length > 0
      ? trade.screenshots
      : (trade.screenshot ? [trade.screenshot] : []);

   const entryPrice = parseFloat(String(trade.entryPrice || 0));
   const exitPrice = parseFloat(String(trade.exitPrice || 0));
   const stopLoss = parseFloat(String(trade.stopLoss || 0));
   const takeProfit = parseFloat(String(trade.takeProfit || 0));
   const riskAmount = parseFloat(String(trade.riskAmount || 0));
   const realRRR = (riskAmount !== 0 && riskAmount !== undefined) ? (Math.abs(trade.pnl) / riskAmount).toFixed(2) : 'N/A';
   const holdTime = trade.duration || (Math.round(trade.durationMinutes || 0) + 'm');
   const isWin = trade.pnl >= 0;

   const isMissed = trade.executionStatus === 'Missed';
   const pnlColor = isMissed ? 'text-blue-400' : (isWin ? 'text-emerald-500' : 'text-rose-500');
   const directionColor = isMissed ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' : (trade.direction === 'Long' ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' : 'text-orange-500 bg-orange-500/10 border-orange-500/20');

   const MetricCell = ({ label, value, color = 'text-white' }: { label: string, value: string | number, color?: string }) => (
      <div className={`p-4 border-r border-b ${isDark ? 'border-white/5' : 'border-slate-100'} flex flex-col justify-center`}>
         <span className="text-[9px] font-black uppercase text-slate-500 tracking-wider mb-1">{label}</span>
         <span className={`text-sm font-black font-mono tracking-tight ${color}`}>{value}</span>
      </div>
   );

   return (
      <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xl animate-in fade-in duration-300">
         <div className={`w-full max-w-7xl h-[85vh] rounded-[32px] overflow-hidden shadow-2xl flex flex-col border ${isDark ? 'bg-[#0a0f1d] border-white/10' : 'bg-white border-slate-200'}`}>
            <div className={`h-20 shrink-0 border-b flex items-center justify-between px-6 lg:px-8 ${isDark ? 'border-white/5 bg-[#0a0f1d]' : 'bg-white border-slate-100'}`}>
               <div className="flex items-center gap-6">
                  <div className={`px-3 py-1.5 rounded-lg border flex items-center gap-2 ${directionColor}`}>
                     {isMissed ? <Clock size={14} /> : (trade.direction === 'Long' ? <ArrowUpRight size={14} strokeWidth={3} /> : <ArrowDownRight size={14} strokeWidth={3} />)}
                     <span className="text-[10px] font-black uppercase tracking-widest">{isMissed ? 'Missed' : trade.direction}</span>
                  </div>
                  <div>
                     <h2 className={`text-lg font-black tracking-tighter uppercase ${isDark ? 'text-white' : 'text-slate-900'}`}>{trade.instrument}</h2>
                     <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">{new Date(trade.date).toLocaleString('cs-CZ')}</p>
                  </div>
               </div>
               <div className={`text-3xl font-black font-mono tracking-tighter ${pnlColor}`}>{isMissed ? '±' : (isWin ? '+' : '-')}${Math.abs(trade.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
               <button onClick={onClose} className="p-2.5 hover:bg-white/10 rounded-full transition-all text-slate-500 hover:text-white"><X size={20} /></button>
            </div>

            <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
               <div className={`w-full lg:w-[30%] flex flex-col overflow-y-auto custom-scrollbar border-r ${isDark ? 'bg-[#0F172A]/50 border-white/5' : 'bg-slate-50 border-slate-200'}`}>
                  <div className={`grid grid-cols-2 border-b ${isDark ? 'border-white/5 bg-[#0a0f1d]' : 'border-slate-200 bg-white'}`}>
                     <MetricCell label="Entry Price" value={entryPrice || '-'} />
                     <MetricCell label="Exit Price" value={exitPrice || '-'} />
                     <MetricCell label="Stop Loss" value={stopLoss || '-'} color="text-rose-500" />
                     <MetricCell label="Take Profit" value={takeProfit || '-'} color="text-emerald-500" />
                     <MetricCell label="Size" value={trade.positionSize || 1} />
                     <MetricCell label="Duration" value={holdTime} color="text-blue-400" />
                     <MetricCell label="Risk" value={`$${riskAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} color="text-slate-400" />
                     <MetricCell label="Realized RR" value={`${realRRR}R`} color={parseFloat(realRRR) > 1 ? 'text-emerald-500' : 'text-slate-400'} />
                  </div>
                  <div className="p-6 space-y-6">
                     <div className="space-y-3">
                        <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><Monitor size={12} /> Context</p>
                        <div className="flex flex-wrap gap-2">
                           {trade.htfConfluence?.length ? trade.htfConfluence.map(t => <span key={t} className="px-2 py-1 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[9px] font-bold uppercase">{t}</span>) : <span className="text-[10px] text-slate-600 italic">No HTF data</span>}
                        </div>
                     </div>
                     <div className="space-y-3">
                        <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><Brain size={12} /> Psycho</p>
                        <div className="flex flex-wrap gap-2">
                           {trade.emotions?.length ? trade.emotions.map(e => {
                              const det = emotions.find(em => em.id === e) || { label: e };
                              return <span key={e} className="px-2 py-1 rounded-md bg-purple-500/10 border border-purple-500/20 text-purple-400 text-[9px] font-bold uppercase">{det.label}</span>
                           }) : null}
                           {trade.mistakes?.length ? trade.mistakes.map(m => <span key={m} className="px-2 py-1 rounded-md bg-rose-500/10 border border-rose-500/20 text-rose-500 text-[9px] font-bold uppercase">{m}</span>) : null}
                        </div>
                     </div>
                     <div className="space-y-3">
                        <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><FileText size={12} /> Notes</p>
                        <div className={`p-4 rounded-xl border text-xs font-medium leading-relaxed ${isDark ? 'bg-black/20 border-white/5 text-slate-300' : 'bg-white border-slate-200 text-slate-700'}`}>{trade.notes || "No notes."}</div>
                     </div>
                  </div>
               </div>
               <div className={`flex-1 relative flex items-center justify-center overflow-hidden group ${isDark ? 'bg-[#050914]' : 'bg-slate-100'}`}>
                  <div className="flex-1 relative overflow-hidden flex items-center justify-center p-4">
                     {images.length > 0 ? (
                        <>
                           <img src={images[activeImageIndex]} className="w-full h-full object-contain" />
                           <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={() => setIsZoomed(true)} className="p-3 rounded-xl bg-black/50 backdrop-blur-md text-white border border-white/10 hover:bg-blue-600 transition-colors shadow-xl">
                                 <Maximize2 size={18} />
                              </button>
                           </div>
                        </>
                     ) : (
                        <div className="text-center opacity-30">
                           <ImageIcon size={64} className="mx-auto mb-4 text-slate-500" />
                           <p className="text-xs font-black uppercase tracking-[0.2em] text-slate-500">Visual Data Missing</p>
                        </div>
                     )}
                  </div>
                  {images.length > 1 && (<div className={`h-24 border-t shrink-0 flex items-center gap-3 px-4 overflow-x-auto ${isDark ? 'bg-[#0a0f1d] border-white/5' : 'bg-white border-slate-200'}`}>{images.map((src, i) => (<div key={i} onClick={() => setActiveImageIndex(i)} className={`h-16 aspect-video rounded-lg border overflow-hidden cursor-pointer transition-all ${activeImageIndex === i ? 'ring-2 ring-blue-500 opacity-100' : 'opacity-50 hover:opacity-100'}`}><img src={src} className="w-full h-full object-cover" /></div>))}</div>)}
               </div>
            </div>
         </div>
         {isZoomed && images.length > 0 && (<div className="fixed inset-0 z-[250] flex items-center justify-center bg-black/98 backdrop-blur-3xl p-6 animate-in fade-in duration-300" onClick={() => setIsZoomed(false)}><button className="absolute top-10 right-10 p-5 bg-white/5 hover:bg-white/10 rounded-full transition-all border border-white/10 text-white"><X size={40} /></button><img src={images[activeImageIndex]} className="max-w-full max-h-full object-contain rounded-[32px] shadow-[0_0_100px_rgba(59,130,246,0.1)] border border-white/10" onClick={e => e.stopPropagation()} /></div>)}
      </div>
   );
};

interface SingleMonthViewProps { year: number; month: number; trades: Trade[]; preps: DailyPrep[]; reviews: DailyReview[]; theme: 'dark' | 'light' | 'oled'; onPrev: () => void; onNext: () => void; canPrev: boolean; canNext: boolean; onDayClick: (day: DayData) => void; onWeekClick: (week: WeekData) => void; pnlFormat?: string; }

export default DashboardCalendar;
