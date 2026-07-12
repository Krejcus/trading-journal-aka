import React, { useMemo, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Trade, DailyPrep, DailyReview, IronRule,
  SessionConfig, WeeklyFocus
} from '../types';
import {
  Target, Sparkles, AlertTriangle, Lightbulb, Sun, Moon,
  Check, X, Edit3, Clock, Coffee, BarChart3
} from 'lucide-react';
import { thumbSmall, thumbMedium, fullSize } from '../services/imageUrlService';
import { getTradeEntryMinuteOfDay } from '../services/tradeTime';

interface WeeklyOverviewProps {
  weekDays: string[];
  weekNumber: number;
  trades: Trade[];
  preps: DailyPrep[];
  reviews: DailyReview[];
  ironRules: IronRule[];
  sessions: SessionConfig[];
  weeklyFocus?: WeeklyFocus;
  theme: string;
  today: string;
  onEditPrep: (date: string) => void;
  onEditReview: (date: string) => void;
  onOpenTrade?: (tradeId: string) => void;
}

// ─────────────────────────────────────────────
// Vyber emoji + mood na základě výkonu dne
// ─────────────────────────────────────────────
function getDayChapter(pnl: number, count: number): { emoji: string; mood: string } {
  if (count === 0) return { emoji: '☕', mood: 'rest day' };
  if (pnl > 500) return { emoji: '🔥', mood: 'on fire' };
  if (pnl > 200) return { emoji: '✨', mood: 'green day' };
  if (pnl > 0) return { emoji: '✅', mood: 'positive' };
  if (pnl === 0) return { emoji: '⚪', mood: 'breakeven' };
  if (pnl > -200) return { emoji: '⚠️', mood: 'small loss' };
  return { emoji: '💀', mood: 'rough day' };
}

const WeeklyOverview: React.FC<WeeklyOverviewProps> = ({
  weekDays, weekNumber, trades, preps, reviews, ironRules,
  sessions, weeklyFocus, theme, today, onEditPrep, onEditReview, onOpenTrade
}) => {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const isDark = theme !== 'light';

  // Statistiky týdne
  const stats = useMemo(() => {
    const weekTrades = trades.filter(t => weekDays.includes(t.date.split('T')[0]));
    const weekPreps = preps.filter(p => weekDays.includes(p.date));
    const weekReviews = reviews.filter(r => weekDays.includes(r.date));

    const pnl = weekTrades.reduce((s, t) => s + t.pnl, 0);
    const validTrades = weekTrades.filter(t => t.isValid !== false);
    const disciplinedPnL = validTrades.reduce((s, t) => s + t.pnl, 0);
    const wins = weekTrades.filter(t => t.pnl > 0).length;
    const losses = weekTrades.filter(t => t.pnl < 0).length;
    const wr = weekTrades.length > 0 ? (wins / weekTrades.length) * 100 : 0;

    const avgWin = wins > 0 ? weekTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins : 0;
    const avgLoss = losses > 0 ? Math.abs(weekTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0) / losses) : 0;
    const rr = avgLoss > 0 ? avgWin / avgLoss : 0;

    const prepCount = weekPreps.filter(p => p.completed).length;
    const auditCount = weekReviews.filter(r => r.completed).length;

    const ritualCompliance = ironRules.map(rule => {
      let passedCount = 0;
      weekDays.forEach(day => {
        const p = weekPreps.find(prep => prep.date === day);
        const r = weekReviews.find(rev => rev.date === day);
        const isRitualPass = p?.ritualCompletions?.find(c => c.ruleId === rule.id)?.status === 'Pass';
        const isTradingPass = r?.ruleAdherence?.find(a => a.ruleId === rule.id)?.status === 'Pass';
        if (isRitualPass || isTradingPass) passedCount++;
      });
      return { label: rule.label, count: passedCount, total: 5 };
    });

    const weeklyGoalStats = weeklyFocus?.goals.map((goal, idx) => {
      let passCount = 0;
      weekDays.forEach(day => {
        const rev = weekReviews.find(r => r.date === day);
        if (rev?.weeklyGoalAdherence?.[idx]?.status === 'Pass') passCount++;
      });
      return { label: goal.text, emoji: goal.emoji, count: passCount };
    }) || [];

    const lessons = weekReviews
      .filter(r => r.lessons?.trim())
      .map(r => ({ date: r.date, text: r.lessons || '' }));

    const mistakesMap = new Map<string, number>();
    weekReviews.forEach(r => {
      r.mistakes?.filter(m => m.trim()).forEach(m => {
        mistakesMap.set(m, (mistakesMap.get(m) || 0) + 1);
      });
    });
    const mistakes = Array.from(mistakesMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([text, count]) => ({ text, count }));

    return {
      pnl, disciplinedPnL, validCount: validTrades.length, count: weekTrades.length,
      wr, rr, prepCount, auditCount,
      ritualCompliance, weeklyGoalStats, lessons, mistakes,
      totalMistakes: weekReviews.reduce((sum, r) => sum + (r.mistakes?.filter(m => m.trim() !== '').length || 0), 0),
    };
  }, [trades, preps, reviews, weekDays, ironRules, sessions, weeklyFocus]);

  const handleSelect = useCallback((date: string) => {
    setSelectedDate(prev => prev === date ? null : date);
  }, []);

  // Vybraný den data
  const selectedDayData = useMemo(() => {
    if (!selectedDate) return null;
    const dayTrades = trades.filter(t => t.date.startsWith(selectedDate));
    const dayPrep = preps.find(p => p.date === selectedDate);
    const dayReview = reviews.find(r => r.date === selectedDate);
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    const dayWins = dayTrades.filter(t => t.pnl > 0).length;
    const dayWr = dayTrades.length > 0 ? (dayWins / dayTrades.length) * 100 : 0;
    const chapter = getDayChapter(dayPnl, dayTrades.length);
    const idx = weekDays.indexOf(selectedDate);
    return {
      dayTrades, dayPrep, dayReview, dayPnl, dayWr,
      chapter, chapterNum: idx + 1, isToday: selectedDate === today
    };
  }, [selectedDate, trades, preps, reviews, weekDays, today]);

  return (
    <div className="space-y-6 md:space-y-8 animate-in fade-in duration-300">

      {/* ═══════════════ HERO ═══════════════ */}
      <div className={`relative overflow-hidden p-6 md:p-10 rounded-[36px] border ${isDark
        ? stats.pnl >= 0
          ? 'bg-gradient-to-br from-emerald-600/15 via-[var(--bg-card)]/40 to-[var(--bg-card)]/40 border-emerald-500/20'
          : 'bg-gradient-to-br from-rose-600/15 via-[var(--bg-card)]/40 to-[var(--bg-card)]/40 border-rose-500/20'
        : 'bg-white border-slate-200 shadow-xl'}`}>

        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6">
          <div>
            <p className="text-[10px] font-black uppercase text-blue-500 tracking-[0.3em] mb-2">Weekly Story</p>
            <h2 className={`text-4xl md:text-6xl font-black italic tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'} mb-2`}>
              TÝDEN {weekNumber}
            </h2>
            <p className={`text-[13px] ${isDark ? 'text-slate-400' : 'text-slate-600'} max-w-md`}>
              {stats.count === 0
                ? 'Tento týden jsi neobchodoval — perfektní čas se učit z minulosti.'
                : stats.pnl > 500
                  ? `Skvělý týden — vydělal jsi $${stats.pnl.toLocaleString()} z ${stats.count} obchodů.`
                  : stats.pnl > 0
                    ? `Solidní týden, ${stats.count} obchodů s ${stats.wr.toFixed(0)}% WR.`
                    : stats.pnl === 0
                      ? 'Vyrovnaný týden — žádný progress, ale ani regres.'
                      : `Ztrátový týden. ${stats.count} obchodů, ${stats.wr.toFixed(0)}% WR. Co se ukázalo?`}
            </p>
          </div>
          <div className="flex flex-col items-end">
            <p className={`text-5xl md:text-6xl font-black ${stats.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
              {stats.pnl >= 0 ? '+' : ''}${stats.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </p>
            <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest mt-1">Total PnL</p>
          </div>
        </div>

        <div className={`mt-6 pt-6 border-t grid grid-cols-2 md:grid-cols-5 gap-4 ${isDark ? 'border-white/5' : 'border-slate-100'}`}>
          <StatTile label="Trades" value={`${stats.count}`} sub={`${stats.validCount} valid`} isDark={isDark} />
          <StatTile label="Win Rate" value={`${stats.wr.toFixed(0)}%`} highlight={stats.wr >= 50} isDark={isDark} />
          <StatTile label="R-Multiple" value={stats.rr.toFixed(2)} highlight={stats.rr >= 1.5} isDark={isDark} />
          <StatTile label="Discipline" value={`${stats.disciplinedPnL >= 0 ? '+' : ''}$${stats.disciplinedPnL.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} isDark={isDark} colorOverride={stats.disciplinedPnL >= 0 ? 'text-blue-400' : 'text-rose-400'} />
          <StatTile label="Compliance" value={`${stats.prepCount}·${stats.auditCount}/5`} sub="prep · audit" highlight={stats.prepCount === 5 && stats.auditCount === 5} isDark={isDark} />
        </div>
      </div>

      {/* ═══════════════ HORIZONTAL WEEK STRIP ═══════════════ */}
      <div>
        <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.3em] mb-4 flex items-center gap-2">
          <Clock size={12} /> Týden v pěti kapitolách · klikni pro detail
        </p>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 md:gap-4">
          {weekDays.map((dateStr, idx) => {
            const dayTrades = trades.filter(t => t.date.startsWith(dateStr));
            const dayPrep = preps.find(p => p.date === dateStr);
            const dayReview = reviews.find(r => r.date === dateStr);
            const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
            const dayWins = dayTrades.filter(t => t.pnl > 0).length;
            const dayWr = dayTrades.length > 0 ? (dayWins / dayTrades.length) * 100 : 0;
            const isToday = dateStr === today;
            const chapter = getDayChapter(dayPnl, dayTrades.length);
            const isSelected = selectedDate === dateStr;

            return (
              <DayChip
                key={dateStr}
                date={dateStr}
                chapterNum={idx + 1}
                emoji={chapter.emoji}
                mood={chapter.mood}
                trades={dayTrades}
                prep={dayPrep}
                review={dayReview}
                pnl={dayPnl}
                wr={dayWr}
                isToday={isToday}
                isSelected={isSelected}
                isDark={isDark}
                onClick={() => handleSelect(dateStr)}
              />
            );
          })}
        </div>

        {/* Detail panel */}
        <AnimatePresence initial={false} mode="wait">
          {selectedDate && selectedDayData && (
            <motion.div
              key={selectedDate}
              initial={{ opacity: 0, y: -10, height: 0 }}
              animate={{ opacity: 1, y: 0, height: 'auto' }}
              exit={{ opacity: 0, y: -10, height: 0 }}
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              style={{ overflow: 'hidden' }}
            >
              <div className="mt-4">
                <DayDetailPanel
                  date={selectedDate}
                  chapterNum={selectedDayData.chapterNum}
                  emoji={selectedDayData.chapter.emoji}
                  mood={selectedDayData.chapter.mood}
                  trades={selectedDayData.dayTrades}
                  prep={selectedDayData.dayPrep}
                  review={selectedDayData.dayReview}
                  pnl={selectedDayData.dayPnl}
                  wr={selectedDayData.dayWr}
                  isToday={selectedDayData.isToday}
                  ironRules={ironRules}
                  sessions={sessions}
                  isDark={isDark}
                  onClose={() => setSelectedDate(null)}
                  onEditPrep={() => onEditPrep(selectedDate)}
                  onEditReview={() => onEditReview(selectedDate)}
                  onOpenTrade={onOpenTrade}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ═══════════════ WEEKLY FOCUS + IRON RULES ═══════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {stats.weeklyGoalStats.length > 0 && (
          <div className={`p-6 md:p-8 rounded-[32px] border ${isDark ? 'bg-[var(--bg-card)]/40 border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}>
            <p className="text-[10px] font-black uppercase text-emerald-500 tracking-[0.25em] mb-5 flex items-center gap-2">
              <Sparkles size={13} /> Weekly Focus
            </p>
            <div className="space-y-3">
              {stats.weeklyGoalStats.map((goal, idx) => {
                const mastered = goal.count === 5;
                return (
                  <div key={idx} className={`p-3 rounded-2xl border ${mastered
                    ? 'bg-emerald-500/10 border-emerald-500/30'
                    : isDark ? 'bg-white/[0.02] border-white/5' : 'bg-slate-50 border-slate-100'}`}>
                    <div className="flex items-center gap-3">
                      <div className={`text-2xl ${goal.count === 0 ? 'grayscale opacity-30' : ''}`}>{goal.emoji || '🎯'}</div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-[11px] font-black tracking-tighter truncate ${mastered ? 'text-emerald-500' : isDark ? 'text-slate-200' : 'text-slate-700'}`}>{goal.label}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <div className="flex gap-0.5 flex-1">
                            {[...Array(5)].map((_, i) => (
                              <div key={i} className={`flex-1 h-1 rounded-full ${i < goal.count ? 'bg-emerald-500' : isDark ? 'bg-white/10' : 'bg-slate-200'}`} />
                            ))}
                          </div>
                          <span className={`text-[9px] font-black tracking-widest ${mastered ? 'text-emerald-500' : 'text-slate-500'}`}>
                            {mastered ? 'MASTERED' : `${goal.count}/5`}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {stats.ritualCompliance.length > 0 && (
          <div className={`p-6 md:p-8 rounded-[32px] border ${isDark ? 'bg-[var(--bg-card)]/40 border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}>
            <p className="text-[10px] font-black uppercase text-amber-500 tracking-[0.25em] mb-5 flex items-center gap-2">
              <Target size={13} /> Iron Rules
            </p>
            <div className="space-y-2.5">
              {stats.ritualCompliance.map((rule, idx) => (
                <div key={idx}>
                  <div className="flex justify-between text-[10px] font-black uppercase tracking-tighter mb-1.5">
                    <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>{rule.label}</span>
                    <span className={rule.count >= 4 ? 'text-emerald-500' : rule.count >= 2 ? 'text-blue-400' : 'text-slate-500'}>{rule.count}/5</span>
                  </div>
                  <div className={`h-1.5 w-full rounded-full overflow-hidden flex gap-0.5 p-0.5 ${isDark ? 'bg-white/5' : 'bg-slate-100'}`}>
                    {[...Array(5)].map((_, i) => (
                      <div key={i} className={`flex-1 rounded-full ${i < rule.count
                        ? rule.count >= 4 ? 'bg-emerald-500' : 'bg-blue-500'
                        : isDark ? 'bg-white/5' : 'bg-slate-200'}`} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ═══════════════ LESSONS / MISTAKES ═══════════════ */}
      {(stats.lessons.length > 0 || stats.mistakes.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className={`p-6 rounded-[28px] border ${isDark ? 'bg-amber-500/5 border-amber-500/20' : 'bg-amber-50 border-amber-100'}`}>
            <p className="text-[10px] font-black uppercase text-amber-500 tracking-[0.25em] mb-4 flex items-center gap-2">
              <Lightbulb size={13} /> Lessons Learned · {stats.lessons.length}
            </p>
            {stats.lessons.length > 0 ? (
              <div className="space-y-2.5">
                {stats.lessons.map((l, i) => {
                  const dayLabel = new Date(l.date).toLocaleDateString('cs-CZ', { weekday: 'short' });
                  return (
                    <div key={i} className={`p-3 rounded-2xl ${isDark ? 'bg-white/[0.02]' : 'bg-white'}`}>
                      <p className="text-[9px] font-black uppercase text-amber-500 tracking-widest mb-1">{dayLabel}</p>
                      <p className={`text-[11px] leading-relaxed whitespace-pre-wrap ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{l.text}</p>
                    </div>
                  );
                })}
              </div>
            ) : <p className="text-[11px] text-slate-500 italic">Žádné lessons z tohoto týdne.</p>}
          </div>

          <div className={`p-6 rounded-[28px] border ${isDark ? 'bg-rose-500/5 border-rose-500/20' : 'bg-rose-50 border-rose-100'}`}>
            <p className="text-[10px] font-black uppercase text-rose-500 tracking-[0.25em] mb-4 flex items-center gap-2">
              <AlertTriangle size={13} /> Mistakes · {stats.totalMistakes}
            </p>
            {stats.mistakes.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {stats.mistakes.map((m, i) => (
                  <div key={i} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border ${isDark ? 'bg-white/[0.02] border-rose-500/20' : 'bg-white border-rose-100'}`}>
                    <span className={`text-[11px] font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{m.text}</span>
                    {m.count > 1 && (
                      <span className="px-1.5 py-0.5 bg-rose-500 text-white rounded-full text-[8px] font-black">{m.count}×</span>
                    )}
                  </div>
                ))}
              </div>
            ) : <p className="text-[11px] text-slate-500 italic">Žádné chyby! 🎯</p>}
          </div>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────
// StatTile
// ─────────────────────────────────────────────
const StatTile: React.FC<{
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  colorOverride?: string;
  isDark: boolean;
}> = ({ label, value, sub, highlight, colorOverride, isDark }) => (
  <div>
    <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest mb-1">{label}</p>
    <p className={`text-xl md:text-2xl font-black ${colorOverride || (highlight ? 'text-emerald-500' : isDark ? 'text-white' : 'text-slate-900')}`}>{value}</p>
    {sub && <p className="text-[9px] font-bold text-slate-500 mt-0.5">{sub}</p>}
  </div>
);

// ─────────────────────────────────────────────
// DayChip — kompaktní karta v horizontálním stripu
// ─────────────────────────────────────────────
interface DayChipProps {
  date: string;
  chapterNum: number;
  emoji: string;
  mood: string;
  trades: Trade[];
  prep?: DailyPrep;
  review?: DailyReview;
  pnl: number;
  wr: number;
  isToday: boolean;
  isSelected: boolean;
  isDark: boolean;
  onClick: () => void;
}

const DayChip: React.FC<DayChipProps> = React.memo(({
  date, chapterNum, emoji, mood, trades, prep, review, pnl, wr,
  isToday, isSelected, isDark, onClick
}) => {
  const d = new Date(date);
  const dayName = d.toLocaleString('cs-CZ', { weekday: 'short' }).toUpperCase();
  const dayNum = d.getDate();

  const pnlColor = pnl > 0 ? 'text-emerald-500' : pnl < 0 ? 'text-rose-500' : 'text-slate-500';
  const accentBar = pnl > 0 ? 'bg-emerald-500' : pnl < 0 ? 'bg-rose-500' : isDark ? 'bg-slate-700' : 'bg-slate-300';

  const borderClass = isSelected
    ? 'border-blue-500 shadow-[0_0_24px_rgba(59,130,246,0.25)]'
    : pnl > 0 ? 'border-emerald-500/30' : pnl < 0 ? 'border-rose-500/30' : isDark ? 'border-[var(--border-subtle)]' : 'border-slate-200';
  const bgClass = isSelected
    ? isDark ? 'bg-blue-500/5' : 'bg-blue-50'
    : isDark ? 'bg-[var(--bg-card)]/50' : 'bg-white shadow-sm';

  const mistakesCount = review?.mistakes?.filter(m => m.trim()).length || 0;

  return (
    <button
      onClick={onClick}
      className={`group relative w-full text-left rounded-2xl border-2 overflow-hidden transition-all duration-200 active:scale-[0.98] hover:border-blue-400/50 ${borderClass} ${bgClass}`}
    >
      <div className={`absolute left-0 top-0 right-0 h-1 ${accentBar}`} />

      <div className="p-3 md:p-4">
        <div className="flex items-start justify-between mb-2">
          <div>
            <p className={`text-[10px] font-black uppercase tracking-widest ${isToday ? 'text-blue-500' : 'text-slate-500'}`}>
              {dayName} {dayNum}.
            </p>
            <p className="text-[7px] font-black uppercase text-slate-600 tracking-widest mt-0.5">CH.{chapterNum}</p>
          </div>
          <div className="text-2xl md:text-3xl leading-none">{emoji}</div>
        </div>

        <p className={`text-xl md:text-2xl font-black ${pnlColor} mb-1`}>
          {pnl >= 0 ? '+' : ''}${pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </p>

        <p className="text-[9px] font-bold italic text-slate-500 lowercase mb-2">· {mood}</p>

        {trades.length > 0 && (
          <div className="flex items-center gap-1.5 text-[9px] font-black uppercase text-slate-400 mb-2">
            <span>{trades.length}T</span>
            <span className="text-slate-700">·</span>
            <span className={wr >= 50 ? 'text-emerald-400' : ''}>{wr.toFixed(0)}%</span>
          </div>
        )}

        <div className="flex items-center gap-1 flex-wrap">
          <MiniDot icon={Sun} active={!!prep?.completed} color="blue" />
          <MiniDot icon={Moon} active={!!review?.completed} color="indigo" />
          {mistakesCount > 0 && <MiniDot icon={AlertTriangle} active={true} color="rose" count={mistakesCount} />}
        </div>

        {isSelected && (
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-1 bg-blue-500 rounded-t-full" />
        )}
      </div>
    </button>
  );
});

DayChip.displayName = 'DayChip';

// ─────────────────────────────────────────────
// MiniDot
// ─────────────────────────────────────────────
const MiniDot: React.FC<{
  icon: React.ElementType;
  active: boolean;
  color: 'blue' | 'indigo' | 'amber' | 'rose';
  count?: number;
}> = ({ icon: Icon, active, color, count }) => {
  const colors = {
    blue: active ? 'bg-blue-500/20 text-blue-400' : 'bg-white/5 text-slate-700',
    indigo: active ? 'bg-indigo-500/20 text-indigo-400' : 'bg-white/5 text-slate-700',
    amber: active ? 'bg-amber-500/20 text-amber-400' : 'bg-white/5 text-slate-700',
    rose: active ? 'bg-rose-500/20 text-rose-400' : 'bg-white/5 text-slate-700',
  };
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[9px] font-black ${colors[color]}`}>
      <Icon size={9} />
      {count !== undefined && count > 0 && <span>{count}</span>}
    </span>
  );
};

// ─────────────────────────────────────────────
// DayDetailPanel — full detail vybraného dne pod stripem
// ─────────────────────────────────────────────
interface DayDetailPanelProps {
  date: string;
  chapterNum: number;
  emoji: string;
  mood: string;
  trades: Trade[];
  prep?: DailyPrep;
  review?: DailyReview;
  pnl: number;
  wr: number;
  isToday: boolean;
  ironRules: IronRule[];
  sessions: SessionConfig[];
  isDark: boolean;
  onClose: () => void;
  onEditPrep: () => void;
  onEditReview: () => void;
  onOpenTrade?: (tradeId: string) => void;
}

const DayDetailPanel: React.FC<DayDetailPanelProps> = ({
  date, chapterNum, emoji, mood, trades, prep, review, pnl, wr,
  isToday, ironRules, sessions, isDark,
  onClose, onEditPrep, onEditReview, onOpenTrade
}) => {
  const d = new Date(date);
  const dayName = d.toLocaleString('cs-CZ', { weekday: 'long' }).toUpperCase();
  const dayDate = d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });

  const pnlColor = pnl > 0 ? 'text-emerald-500' : pnl < 0 ? 'text-rose-500' : 'text-slate-500';
  const accentBar = pnl > 0 ? 'bg-emerald-500' : pnl < 0 ? 'bg-rose-500' : 'bg-slate-500';
  const hasContent = trades.length > 0 || prep || review;

  return (
    <div className={`relative rounded-[28px] border overflow-hidden ${isDark ? 'bg-[var(--bg-card)]/50 border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}>
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${accentBar}`} />

      {/* Hlavička */}
      <div className={`flex items-start justify-between gap-4 p-5 md:p-6 ${hasContent ? `border-b ${isDark ? 'border-white/5' : 'border-slate-100'}` : ''}`}>
        <div className="flex items-start gap-4 flex-1 min-w-0">
          <div className="flex flex-col items-center shrink-0">
            <div className="text-4xl md:text-5xl leading-none">{emoji}</div>
            <p className="text-[8px] font-black uppercase text-slate-500 tracking-widest mt-1">CH.{chapterNum}</p>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h3 className={`text-lg md:text-xl font-black italic tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {dayName}
              </h3>
              <span className="text-[11px] font-bold text-slate-500">{dayDate}</span>
              {isToday && <span className="px-2 py-0.5 bg-blue-600 rounded-md text-[8px] font-black uppercase text-white tracking-widest">Dnes</span>}
              <span className="text-[10px] font-bold italic text-slate-500 lowercase">· {mood}</span>
            </div>
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className={`text-2xl md:text-3xl font-black ${pnlColor}`}>
                {pnl >= 0 ? '+' : ''}${pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
              {trades.length > 0 && (
                <>
                  <span className="text-[11px] font-bold text-slate-500">·</span>
                  <span className={`text-[13px] font-black ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                    {trades.length} {trades.length === 1 ? 'trade' : 'trades'}
                  </span>
                  <span className="text-[11px] font-bold text-slate-500">·</span>
                  <span className={`text-[13px] font-black ${wr >= 50 ? 'text-emerald-400' : 'text-slate-400'}`}>
                    {wr.toFixed(0)}% WR
                  </span>
                </>
              )}
            </div>
            {review?.mainTakeaway && (
              <p className={`mt-2 text-[12px] italic ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                "{review.mainTakeaway}"
              </p>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className={`p-2 rounded-xl transition-all active:scale-95 shrink-0 ${isDark ? 'bg-white/5 hover:bg-white/10 text-slate-400' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}
          aria-label="Zavřít detail"
        >
          <X size={16} />
        </button>
      </div>

      {/* Obsah */}
      {hasContent ? (
        <div className="p-5 md:p-6 space-y-5">

          {/* PREP */}
          {prep && (
            <DetailSection
              icon={<Sun size={12} className="text-blue-500" />}
              title="Ranní příprava"
              accent="blue"
              onEdit={onEditPrep}
              isDark={isDark}
            >
              {prep.scenarios?.bullish && (
                <Block label="BULLISH" color="text-emerald-500" text={prep.scenarios.bullish} isDark={isDark} image={prep.scenarios.bullishImage} />
              )}
              {prep.scenarios?.bearish && (
                <Block label="BEARISH" color="text-rose-500" text={prep.scenarios.bearish} isDark={isDark} image={prep.scenarios.bearishImage} />
              )}
              {!prep.scenarios?.bullish && prep.scenarios?.bullishImage && (
                <Block label="BULLISH" color="text-emerald-500" text="" isDark={isDark} image={prep.scenarios.bullishImage} />
              )}
              {!prep.scenarios?.bearish && prep.scenarios?.bearishImage && (
                <Block label="BEARISH" color="text-rose-500" text="" isDark={isDark} image={prep.scenarios.bearishImage} />
              )}
              {prep.scenarios?.scenarioImages && prep.scenarios.scenarioImages.length > 0 && (
                <div>
                  <p className="text-[9px] font-black uppercase tracking-widest mb-2 text-cyan-500">DALŠÍ SCÉNÁŘE</p>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {prep.scenarios.scenarioImages.map((img, i) => (
                      <img key={i} src={thumbMedium(img)} alt={`Scenario ${i + 1}`} className="w-full rounded-lg border border-white/10 cursor-pointer hover:opacity-80 transition-opacity" loading="lazy" onClick={() => window.open(fullSize(img), '_blank')} />
                    ))}
                  </div>
                </div>
              )}
              {prep.mindsetState && (
                <Block label="MINDSET" color="text-purple-500" text={prep.mindsetState} isDark={isDark} />
              )}
              {prep.confidence !== undefined && prep.confidence !== null && (
                <div>
                  <div className="flex justify-between mb-1">
                    <p className="text-[9px] font-black uppercase tracking-widest text-purple-500">CONFIDENCE</p>
                    <p className={`text-[9px] font-black ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{prep.confidence}/100</p>
                  </div>
                  <div className={`h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-white/10' : 'bg-slate-200'}`}>
                    <div className="h-full bg-gradient-to-r from-purple-500 to-pink-500" style={{ width: `${prep.confidence}%` }} />
                  </div>
                </div>
              )}
              {!prep.scenarios?.bullish && !prep.scenarios?.bearish && !prep.scenarios?.bullishImage && !prep.scenarios?.bearishImage && !prep.mindsetState && !prep.scenarios?.scenarioImages?.length && (
                <p className="text-[11px] text-slate-500 italic">Prep je založen ale prázdný.</p>
              )}
            </DetailSection>
          )}

          {/* SESSIONS — paired plán vs realita */}
          {(() => {
            const sessionPairs: {
              session: SessionConfig;
              plan?: { plan?: string; image?: string; bias?: string };
              breakdown?: { notes?: string; screenshot?: string };
              trades: Trade[];
            }[] = [];

            // Pro každou session v config sestav pár plán + breakdown
            sessions.forEach(sess => {
              const plan = prep?.scenarios?.sessions?.find(s => s.id === sess.id);
              const breakdown = review?.sessionBreakdowns?.find(b => b.sessionId === sess.id);

              // Filtruj trades podle session časového okna
              const [startH, startM] = (sess.startTime || '00:00').split(':').map(Number);
              const [endH, endM] = (sess.endTime || '23:59').split(':').map(Number);
              const startMin = startH * 60 + startM;
              const endMin = endH * 60 + endM;
              const sessionTrades = trades.filter(t => {
                // Bin podle ENTRY času (jako ostatní session widgety) — exit po session by jinak obchod vyřadil.
                const tMin = getTradeEntryMinuteOfDay(t);
                return tMin >= startMin && tMin <= endMin;
              });

              const hasPlan = plan?.plan?.trim() || plan?.image;
              const hasBreakdown = breakdown?.notes?.trim() || breakdown?.screenshot;

              // Skip session pokud nemá nic
              if (!hasPlan && !hasBreakdown && sessionTrades.length === 0) return;

              sessionPairs.push({
                session: sess,
                plan: hasPlan ? plan : undefined,
                breakdown: hasBreakdown ? breakdown : undefined,
                trades: sessionTrades,
              });
            });

            if (sessionPairs.length === 0) return null;

            return (
              <DetailSection
                icon={<div className="w-3 h-3 rounded-full bg-gradient-to-br from-cyan-500 to-blue-500" />}
                title={`Sessions · ${sessionPairs.length}`}
                accent="indigo"
                isDark={isDark}
              >
                <div className="space-y-3">
                  {sessionPairs.map(({ session, plan, breakdown, trades: sessTrades }, idx) => {
                    const sessPnl = sessTrades.reduce((s, t) => s + t.pnl, 0);
                    return (
                      <div key={session.id || idx} className={`rounded-2xl border overflow-hidden ${isDark ? 'border-white/5' : 'border-slate-200'}`}>
                        {/* Session header */}
                        <div className={`px-4 py-2.5 flex items-center justify-between flex-wrap gap-2 ${isDark ? 'bg-white/[0.03]' : 'bg-slate-50'}`}>
                          <div className="flex items-center gap-2">
                            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: session.color || '#6366f1' }} />
                            <p className={`text-[11px] font-black uppercase tracking-widest ${isDark ? 'text-white' : 'text-slate-900'}`}>{session.name}</p>
                            <span className="text-[9px] font-bold text-slate-500">{session.startTime}–{session.endTime}</span>
                            {plan?.bias && (
                              <span className={`text-[8px] font-black uppercase px-1.5 py-0.5 rounded ${plan.bias === 'Long' ? 'bg-emerald-500/10 text-emerald-500' : plan.bias === 'Short' ? 'bg-rose-500/10 text-rose-500' : 'bg-slate-500/10 text-slate-500'}`}>
                                {plan.bias}
                              </span>
                            )}
                          </div>
                          {sessTrades.length > 0 && (
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] font-bold text-slate-500">{sessTrades.length}T</span>
                              <span className={`text-[11px] font-black ${sessPnl > 0 ? 'text-emerald-500' : sessPnl < 0 ? 'text-rose-500' : 'text-slate-500'}`}>
                                {sessPnl >= 0 ? '+' : ''}${sessPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                              </span>
                            </div>
                          )}
                        </div>

                        {/* Paired content */}
                        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-white/5">
                          {/* PLÁN (z prep) */}
                          <div className="p-3 md:p-4">
                            <div className="flex items-center gap-1.5 mb-2">
                              <Sun size={10} className="text-blue-500" />
                              <p className="text-[9px] font-black uppercase tracking-widest text-blue-500">Plán</p>
                            </div>
                            {plan ? (
                              <div className="space-y-2">
                                {plan.plan?.trim() && (
                                  <p className={`text-[11px] leading-relaxed whitespace-pre-wrap ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{plan.plan}</p>
                                )}
                                {plan.image && (
                                  <img src={thumbMedium(plan.image)} alt="Plán" className="w-full rounded-lg border border-white/10 cursor-pointer hover:opacity-80 transition-opacity" loading="lazy" onClick={() => window.open(fullSize(plan.image), '_blank')} />
                                )}
                              </div>
                            ) : (
                              <p className="text-[10px] text-slate-500 italic">Žádný plán nebyl vytvořen.</p>
                            )}
                          </div>

                          {/* BREAKDOWN (z review) */}
                          <div className="p-3 md:p-4">
                            <div className="flex items-center gap-1.5 mb-2">
                              <Moon size={10} className="text-indigo-500" />
                              <p className="text-[9px] font-black uppercase tracking-widest text-indigo-500">Co se stalo</p>
                            </div>
                            {breakdown ? (
                              <div className="space-y-2">
                                {breakdown.notes?.trim() && (
                                  <p className={`text-[11px] leading-relaxed whitespace-pre-wrap ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{breakdown.notes}</p>
                                )}
                                {breakdown.screenshot && (
                                  <img src={thumbMedium(breakdown.screenshot)} alt="Breakdown" className="w-full rounded-lg border border-white/10 cursor-pointer hover:opacity-80 transition-opacity" loading="lazy" onClick={() => window.open(fullSize(breakdown.screenshot), '_blank')} />
                                )}
                              </div>
                            ) : (
                              <p className="text-[10px] text-slate-500 italic">Žádný breakdown nebyl napsán.</p>
                            )}
                          </div>
                        </div>

                        {/* Trades v této session */}
                        {sessTrades.length > 0 && (
                          <div className={`px-3 md:px-4 py-2 border-t ${isDark ? 'border-white/5 bg-white/[0.01]' : 'border-slate-100 bg-slate-50/50'}`}>
                            <div className="flex items-center gap-2 flex-wrap">
                              <BarChart3 size={10} className="text-amber-500" />
                              <span className="text-[9px] font-black uppercase tracking-widest text-amber-500 mr-1">Trades</span>
                              {sessTrades.map(t => (
                                <button
                                  key={t.id}
                                  onClick={() => onOpenTrade?.(String(t.id))}
                                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-black transition-all active:scale-95 ${t.pnl > 0 ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20' : t.pnl < 0 ? 'bg-rose-500/10 text-rose-400 hover:bg-rose-500/20' : 'bg-slate-500/10 text-slate-400'}`}
                                >
                                  <span>{t.instrument}</span>
                                  <span>·</span>
                                  <span>{t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </DetailSection>
            );
          })()}

          {/* TRADES */}
          {trades.length > 0 && (
            <DetailSection
              icon={<BarChart3 size={12} className="text-amber-500" />}
              title={`Obchody · ${trades.length}`}
              accent="amber"
              isDark={isDark}
            >
              <div className="space-y-1.5">
                {trades.map(t => {
                  const time = new Date(t.timestamp).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
                  const allScreens = [t.screenshot, ...(t.screenshots || [])].filter(Boolean) as string[];
                  const primaryScreen = allScreens[0];
                  return (
                    <button
                      key={t.id}
                      onClick={() => onOpenTrade?.(String(t.id))}
                      className={`w-full flex items-center justify-between gap-2.5 p-2.5 rounded-xl text-left transition-all active:scale-[0.99] ${isDark ? 'bg-white/[0.02] hover:bg-white/5' : 'bg-slate-50 hover:bg-slate-100'}`}
                    >
                      <div className="flex items-center gap-2.5 flex-1 min-w-0">
                        <div className={`w-1 h-10 rounded-full shrink-0 ${t.pnl > 0 ? 'bg-emerald-500' : t.pnl < 0 ? 'bg-rose-500' : 'bg-slate-500'}`} />
                        {primaryScreen && (
                          <div
                            className="relative w-12 h-12 rounded overflow-hidden border border-white/10 shrink-0"
                            onClick={(e) => { e.stopPropagation(); window.open(fullSize(primaryScreen), '_blank'); }}
                          >
                            <img src={thumbSmall(primaryScreen)} alt="" className="w-full h-full object-cover" loading="lazy" />
                            {allScreens.length > 1 && (
                              <span className="absolute bottom-0 right-0 bg-black/80 text-white text-[8px] font-black px-1 rounded-tl">+{allScreens.length - 1}</span>
                            )}
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`text-[11px] font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{t.instrument}</span>
                            <span className={`text-[8px] font-black uppercase px-1.5 py-0.5 rounded ${t.direction === 'Long' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>{t.direction}</span>
                            {t.isValid === false && <span className="text-[8px] font-black uppercase px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500">Invalid</span>}
                          </div>
                          <p className="text-[9px] font-bold text-slate-500 mt-0.5">{time}</p>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`text-[13px] font-black ${t.pnl > 0 ? 'text-emerald-500' : t.pnl < 0 ? 'text-rose-500' : 'text-slate-500'}`}>
                          {t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </p>
                        {t.riskAmount && t.riskAmount > 0 && (
                          <p className="text-[9px] font-bold text-slate-500">{(t.pnl / t.riskAmount) > 0 ? '+' : ''}{(t.pnl / t.riskAmount).toFixed(2)}R</p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </DetailSection>
          )}

          {/* REVIEW */}
          {review && (
            <DetailSection
              icon={<Moon size={12} className="text-indigo-500" />}
              title="Večerní audit"
              accent="indigo"
              onEdit={onEditReview}
              isDark={isDark}
            >
              {review.mainTakeaway && (
                <Block label="MAIN TAKEAWAY" color="text-blue-500" text={review.mainTakeaway} isDark={isDark} italic />
              )}
              {review.lessons && (
                <Block label="LESSONS LEARNED" color="text-amber-500" text={review.lessons} isDark={isDark} />
              )}
              {review.mistakes && review.mistakes.filter(m => m.trim()).length > 0 && (
                <div>
                  <p className="text-[9px] font-black uppercase text-rose-500 tracking-widest mb-1.5">MISTAKES</p>
                  <div className="flex flex-wrap gap-1.5">
                    {review.mistakes.filter(m => m.trim()).map((m, i) => (
                      <span key={i} className="px-2 py-0.5 bg-rose-500/10 text-rose-400 rounded-md text-[10px] font-bold">{m}</span>
                    ))}
                  </div>
                </div>
              )}
              {(review.psycho?.stressors?.trim() || review.psycho?.gratitude?.trim() || review.psycho?.notes?.trim()) && (
                <div>
                  <p className="text-[9px] font-black uppercase text-pink-500 tracking-widest mb-1.5">PSYCHO POZNÁMKY</p>
                  <div className="space-y-1.5">
                    {review.psycho?.stressors?.trim() && (
                      <div className={`p-2 rounded-lg ${isDark ? 'bg-rose-500/5 border border-rose-500/10' : 'bg-rose-50'}`}>
                        <p className="text-[8px] font-black uppercase tracking-widest text-rose-400 mb-1">Stresory</p>
                        <p className={`text-[10px] whitespace-pre-wrap ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{review.psycho.stressors}</p>
                      </div>
                    )}
                    {review.psycho?.gratitude?.trim() && (
                      <div className={`p-2 rounded-lg ${isDark ? 'bg-emerald-500/5 border border-emerald-500/10' : 'bg-emerald-50'}`}>
                        <p className="text-[8px] font-black uppercase tracking-widest text-emerald-400 mb-1">Gratitude</p>
                        <p className={`text-[10px] whitespace-pre-wrap ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{review.psycho.gratitude}</p>
                      </div>
                    )}
                    {review.psycho?.notes?.trim() && (
                      <div className={`p-2 rounded-lg ${isDark ? 'bg-white/[0.02]' : 'bg-slate-50'}`}>
                        <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 mb-1">Další pozn.</p>
                        <p className={`text-[10px] whitespace-pre-wrap ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{review.psycho.notes}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {review.ruleAdherence && review.ruleAdherence.length > 0 && (
                <div>
                  <p className="text-[9px] font-black uppercase text-emerald-500 tracking-widest mb-1.5">IRON RULES</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                    {review.ruleAdherence.map((a, i) => {
                      const rule = ironRules.find(r => r.id === a.ruleId);
                      const pass = a.status === 'Pass';
                      return (
                        <div key={i} className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] ${pass ? 'bg-emerald-500/10' : a.status === 'Fail' ? 'bg-rose-500/10' : 'bg-slate-500/10'}`}>
                          {pass ? <Check size={10} className="text-emerald-500" /> : a.status === 'Fail' ? <X size={10} className="text-rose-500" /> : <Clock size={10} className="text-slate-500" />}
                          <span className={`font-bold flex-1 truncate ${pass ? 'text-emerald-500' : a.status === 'Fail' ? 'text-rose-500' : 'text-slate-500'}`}>
                            {rule?.label || a.label || 'Pravidlo'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </DetailSection>
          )}

          {/* Edit shortcuts pokud chybí prep nebo audit */}
          {(!prep || !review) && (
            <div className="flex gap-2 pt-2 flex-wrap">
              {!prep && (
                <button onClick={onEditPrep} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all active:scale-95">
                  <Sun size={11} /> Vytvořit prep
                </button>
              )}
              {!review && (
                <button onClick={onEditReview} className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all active:scale-95">
                  <Moon size={11} /> Vytvořit audit
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 py-10">
          <Coffee size={28} className="text-slate-500" />
          <p className="text-[12px] text-slate-500 italic">Klidný den. Žádné záznamy.</p>
          <div className="flex gap-2 mt-3">
            <button onClick={onEditPrep} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all active:scale-95">
              <Sun size={11} /> Vytvořit prep
            </button>
            <button onClick={onEditReview} className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all active:scale-95">
              <Moon size={11} /> Vytvořit audit
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────
// DetailSection
// ─────────────────────────────────────────────
const DetailSection: React.FC<{
  icon: React.ReactNode;
  title: string;
  accent: 'blue' | 'indigo' | 'amber';
  onEdit?: () => void;
  isDark: boolean;
  children: React.ReactNode;
}> = ({ icon, title, accent, onEdit, isDark, children }) => {
  const accentColors = {
    blue: 'text-blue-500',
    indigo: 'text-indigo-500',
    amber: 'text-amber-500',
  };
  return (
    <div>
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-1.5">
          {icon}
          <p className={`text-[10px] font-black uppercase tracking-widest ${accentColors[accent]}`}>{title}</p>
        </div>
        {onEdit && (
          <button onClick={onEdit} className={`flex items-center gap-1 px-2 py-1 rounded-md text-[9px] font-black uppercase tracking-widest transition-all active:scale-95 ${isDark ? 'bg-white/5 hover:bg-white/10 text-slate-400' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>
            <Edit3 size={9} /> Editovat
          </button>
        )}
      </div>
      <div className="space-y-3 pl-1">{children}</div>
    </div>
  );
};

// ─────────────────────────────────────────────
// Block — text/obrázek block
// ─────────────────────────────────────────────
const Block: React.FC<{
  label: string;
  color: string;
  text: string;
  isDark: boolean;
  image?: string;
  italic?: boolean;
}> = ({ label, color, text, isDark, image, italic }) => (
  <div>
    <p className={`text-[9px] font-black uppercase tracking-widest mb-1 ${color}`}>{label}</p>
    {text && (
      <p className={`text-[11px] leading-relaxed whitespace-pre-wrap mb-2 ${italic ? 'italic' : ''} ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
        {italic ? `"${text}"` : text}
      </p>
    )}
    {image && (
      <img
        src={thumbMedium(image)}
        alt={label}
        className="w-full max-w-md rounded-lg border border-white/10 cursor-pointer hover:opacity-80 transition-opacity"
        loading="lazy"
        onClick={() => window.open(fullSize(image), '_blank')}
      />
    )}
  </div>
);

export default WeeklyOverview;
