
import React, { useMemo } from 'react';
import { DailyPrep, DailyReview, Trade, IronRule } from '../types';
import { Flame, Target, Info } from 'lucide-react';

interface DisciplineDashboardProps {
  theme: 'dark' | 'light' | 'oled';
  preps: DailyPrep[];
  reviews: DailyReview[];
  trades: Trade[];
  ironRules: IronRule[];
}

const DisciplineDashboard: React.FC<DisciplineDashboardProps> = ({ theme, preps, reviews, trades, ironRules = [] }) => {
  const stats = useMemo(() => {
    const getLocalDate = (offset = 0) => {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      return d.toLocaleDateString('en-CA');
    };

    const todayStr = getLocalDate(0);
    // Get last 45 days to ensure we have enough weekdays for a good history
    const lastDates = Array.from({ length: 45 }, (_, i) => getLocalDate(44 - i));

    // Filter out weekends (0 = Sunday, 6 = Saturday)
    const weekdaysOnly = lastDates.filter(date => {
      const day = new Date(date).getUTCDay();
      return day !== 0 && day !== 6;
    }).slice(-30); // Keep last 30 weekdays

    // Celkový streak rituálů
    let currentStreak = 0;
    const sortedDatesForStreak = [...weekdaysOnly].reverse();

    for (const date of sortedDatesForStreak) {
      const hasPrep = preps.some(p => p.date === date);
      const hasReview = reviews.some(r => r.date === date);
      const hasTrades = trades.some(t => t.date.startsWith(date));
      const isToday = date === todayStr;

      if ((hasPrep && hasReview) || (isToday && hasPrep)) {
        currentStreak++;
      } else if (hasTrades) {
        break;
      } else if (!isToday && new Date(date) < new Date(todayStr)) {
        // If not today (and in past) and missing prep/review -> break
        // Unless it's today (handled above) or future (not possible here)
        break;
      } else {
        // Today but no prep/review yet -> don't break streak from yesterday? 
        // The logic above: if (isToday && hasPrep) streak++. 
        // If isToday and NO prep:
        // We shouldn't break streak if we just haven't done it YET today?
        // Original logic: "else if (!isToday) break". 
        // So if it IS today and we fail conditions, we just don't increment, but we continue to check yesterday?
        // No, "else break" would run.
        // Let's stick to original logic structure but simplified for weekdays
        if (isToday) continue; // Don't break on today if missing, just don't count it yet
        break;
      }
    }

    // Výpočet rule streaks (Elite Trackers)
    const ruleStreaks: Record<string, { streak: number, label: string, type: 'ritual' | 'trading' }> = {};

    // Získáme unikátní pravidla z historie + aktuální definice
    const allRuleIds = new Set<string>();
    if (Array.isArray(ironRules)) {
      ironRules.forEach(r => { if (r && r.id) allRuleIds.add(r.id); });
    }
    preps.forEach(p => p.ritualCompletions?.forEach(c => { if (c && c.ruleId) allRuleIds.add(c.ruleId); }));
    reviews.forEach(r => r.ruleAdherence?.forEach(a => { if (a && a.ruleId) allRuleIds.add(a.ruleId); }));

    allRuleIds.forEach(ruleId => {
      if (!ruleId) return;
      let rStreak = 0;
      for (const date of sortedDatesForStreak) {
        const prep = preps.find(p => p.date === date);
        const review = reviews.find(r => r.date === date);
        const hasTrades = trades.some(t => t.date.startsWith(date));
        const isToday = date === todayStr;

        const ritualComp = prep?.ritualCompletions?.find(c => c.ruleId === ruleId);
        const ruleAdh = review?.ruleAdherence?.find(a => a.ruleId === ruleId);

        const isPassed = ritualComp?.status === 'Pass' || ruleAdh?.status === 'Pass';
        const isPendingToday = isToday && ritualComp?.status === 'Pass';

        if (isPassed || isPendingToday) {
          rStreak++;
        } else if (hasTrades || ritualComp?.status === 'Fail' || ruleAdh?.status === 'Fail') {
          break;
        } else if (!isToday && new Date(date) < new Date(todayStr)) {
          break;
        }
      }

      const ruleDef = Array.isArray(ironRules) ? ironRules.find(r => r.id === ruleId) : null;
      const label = ruleDef ? ruleDef.label : (ruleId.startsWith('rule_') ? 'Nové pravidlo' : ruleId);
      const type = ruleDef ? ruleDef.type : (ruleId.startsWith('ritual') || ruleId.startsWith('r_') ? 'ritual' : 'trading');

      ruleStreaks[ruleId] = { streak: rStreak, label, type };
    });

    const heatmapData = weekdaysOnly.map(date => {
      const hasPrep = preps.some(p => p.date === date);
      const hasReview = reviews.some(r => r.date === date);
      const hasTrades = trades.some(t => t.date.startsWith(date));
      let status: 'full' | 'partial' | 'trades-only' | 'none' = 'none';
      if (hasPrep && hasReview) status = 'full';
      else if (hasPrep || hasReview) status = 'partial';
      else if (hasTrades) status = 'trades-only';
      return { date, status };
    });

    return { currentStreak, heatmapData, ruleStreaks, disciplineScore: Math.min(100, Math.round((heatmapData.filter(d => d.status === 'full').length / heatmapData.length) * 100)) };
  }, [preps, reviews, trades, ironRules]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'full': return 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]';
      case 'partial': return 'bg-amber-500';
      case 'trades-only': return 'bg-rose-500 animate-pulse';
      default: return theme !== 'light' ? 'bg-[var(--border-subtle)]' : 'bg-slate-200';
    }
  };

  return (
    <div className={`p-5 rounded-[32px] border transition-all flex flex-col overflow-visible ${theme === 'oled' ? 'bg-black border-white/10' :
      theme === 'dark' ? 'bg-[var(--bg-card)]/90 border-[var(--border-subtle)] backdrop-blur-xl' :
        'bg-white border-slate-200 shadow-sm'
      }`}>

      {/* Header Widgetu */}
      <div className="flex justify-between items-center mb-5 shrink-0">
        <h3 className="text-xs font-black uppercase tracking-widest flex items-center gap-2">
          <Target size={16} className="text-blue-500" /> Rituály & Disciplína
          <div className="relative group inline-flex items-center">
            <div className="p-1 -m-1 cursor-help"><Info size={14} className="text-slate-500 opacity-40 hover:opacity-100 transition-opacity" /></div>
          </div>
        </h3>
        <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full ${theme !== 'light' ? 'bg-[var(--bg-page)]/50 border border-[var(--border-subtle)]' : 'bg-slate-50 border border-slate-200'}`}>
          <Flame size={12} className={stats.currentStreak > 0 ? 'text-orange-500' : 'text-slate-600'} />
          <span className="text-[9px] font-black uppercase text-slate-400">Streak: <span className={theme !== 'light' ? 'text-white' : 'text-slate-900'}>{stats.currentStreak}</span></span>
        </div>
      </div>

      <div className="flex flex-col flex-1 min-h-0 gap-5">

        {/* Top Section: Heatmap & Score */}
        <div className="flex flex-col lg:flex-row gap-5 items-center">

          {/* Heatmap Area */}
          <div className="flex-1 w-full min-w-0">
            <div className="flex justify-between items-center mb-2">
              <span className="text-[8px] font-black uppercase text-slate-500 tracking-widest">30 Day Consistency</span>
              <span className={`text-[10px] font-black ${stats.disciplineScore > 80 ? 'text-emerald-500' : 'text-blue-500'}`}>{stats.disciplineScore}% Score</span>
            </div>
            <div className="grid grid-cols-[repeat(15,minmax(0,1fr))] gap-1.5 max-w-[400px]">
              {stats.heatmapData.slice(-30).map((d, i) => (
                <div key={i} title={`${d.date}`} className={`aspect-square w-full rounded-[3px] transition-all hover:scale-125 cursor-help ${getStatusColor(d.status)}`} />
              ))}
            </div>
          </div>

          {/* Score Circle - Mini */}
          <div className="shrink-0 text-center">
            <div className={`w-12 h-12 rounded-full border-4 flex items-center justify-center relative ${theme !== 'light' ? 'border-[var(--bg-page)]' : 'border-slate-100'}`}>
              <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 64 64">
                <circle cx="32" cy="32" r="28" fill="none" stroke={theme !== 'light' ? 'var(--bg-card)' : '#f1f5f9'} strokeWidth="4" />
                <circle
                  cx="32" cy="32" r="28" fill="none"
                  stroke={stats.disciplineScore > 75 ? '#10b981' : '#3b82f6'}
                  strokeWidth="4"
                  strokeDasharray={`${(stats.disciplineScore / 100) * 175} 175`}
                  strokeLinecap="round"
                  className="transition-all duration-1000"
                />
              </svg>
              <span className="text-[9px] font-black">{stats.disciplineScore}</span>
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className={`h-px w-full ${theme !== 'light' ? 'bg-[var(--border-subtle)]' : 'bg-slate-100'}`}></div>

        {/* Bottom Section: Compact Elite Trackers */}
        <div className="flex-1">
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6 gap-2">
            {Object.entries(stats.ruleStreaks).map(([id, data]: [string, any]) => {
              const isActive = data.streak > 0;
              const colorHex = data.type === 'ritual' ? '#3b82f6' : '#f59e0b'; // Blue vs Amber
              const circumference = 2 * Math.PI * 22; // r=22 -> ~138
              const offset = circumference - (Math.min(1, data.streak / 10) * circumference);

              return (
                <div key={id} className={`p-2.5 rounded-xl border flex flex-col items-center justify-center gap-1.5 transition-all hover:bg-[var(--text-primary)]/5 ${theme !== 'light' ? 'bg-[var(--bg-page)]/30 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'
                  }`}>
                  {/* Mini Ring */}
                  <div className="relative w-8 h-8 flex items-center justify-center">
                    <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 50 50">
                      <circle cx="25" cy="25" r="22" fill="none" stroke={theme !== 'light' ? 'var(--bg-card)' : '#cbd5e1'} strokeWidth="4" />
                      <circle
                        cx="25" cy="25" r="22" fill="none"
                        stroke={isActive ? colorHex : 'transparent'}
                        strokeWidth="4"
                        strokeDasharray={circumference}
                        strokeDashoffset={isActive ? offset : circumference}
                        strokeLinecap="round"
                        className="transition-all duration-1000 ease-out"
                      />
                    </svg>
                    <span className={`text-xs font-black tracking-tighter ${isActive ? (theme !== 'light' ? 'text-white' : 'text-slate-900') : 'text-slate-600'}`}>{data.streak}</span>
                  </div>

                  {/* Label */}
                  <p className="text-[6px] font-black uppercase text-slate-500 text-center leading-tight line-clamp-2 px-1 h-4 flex items-center">
                    {data.label}
                  </p>
                </div>
              );
            })}
          </div>
          {Object.keys(stats.ruleStreaks).length === 0 && (
            <div className="text-center py-4 opacity-40 text-[9px] uppercase font-black tracking-widest text-slate-500">
              Definuj pravidla v nastavení pro aktivaci trackerů
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DisciplineDashboard;
