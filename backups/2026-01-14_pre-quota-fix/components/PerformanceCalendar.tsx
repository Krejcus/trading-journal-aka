
import React, { useMemo } from 'react';
import { CalendarDay } from '../types';

interface PerformanceCalendarProps {
  calendarData: CalendarDay[];
  theme: 'dark' | 'light' | 'oled';
}

const PerformanceCalendar: React.FC<PerformanceCalendarProps> = ({ calendarData, theme }) => {
  // Group by Month (YYYY-MM)
  const months = useMemo(() => {
    const groups: Record<string, CalendarDay[]> = {};
    calendarData.forEach(day => {
      const monthKey = day.date.substring(0, 7); // "2023-10"
      if (!groups[monthKey]) groups[monthKey] = [];
      groups[monthKey].push(day);
    });
    // Sort keys descending (newest month first)
    return Object.keys(groups).sort().reverse().map(key => ({
      key,
      days: groups[key]
    }));
  }, [calendarData]);

  if (calendarData.length === 0) return <div className="text-slate-500">Žádná data v kalendáři.</div>;

  return (
    <div className="space-y-8">
      {months.map(({ key, days }) => {
        const [year, month] = key.split('-');
        const dateObj = new Date(parseInt(year), parseInt(month) - 1, 1);
        const monthName = dateObj.toLocaleString('cs-CZ', { month: 'long', year: 'numeric' });

        return (
          <div key={key} className={`rounded-[32px] p-6 border transition-colors ${theme !== 'light' ? 'bg-[#0a0f1d]/90 border-white/5 backdrop-blur-xl' : 'bg-white border-slate-200 shadow-sm'
            }`}>
            <div className="flex justify-between items-center mb-4">
              <h4 className={`text-xl font-black capitalize tracking-tighter ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>{monthName}</h4>
              <div className="text-slate-500 text-xs font-black uppercase tracking-widest">
                Celkové PnL: <span className={`font-mono ${days.reduce((acc, d) => acc + d.pnl, 0) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                  ${days.reduce((acc, d) => acc + d.pnl, 0).toFixed(0)}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3">
              {days.map((day) => (
                <div
                  key={day.date}
                  className={`
                    aspect-square rounded-2xl p-3 flex flex-col justify-between transition-all hover:scale-105 cursor-default border
                    ${day.pnl > 0
                      ? (theme !== 'light' ? 'bg-emerald-500/10 border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.05)]' : 'bg-emerald-50 border-emerald-200')
                      : (theme !== 'light' ? 'bg-rose-500/10 border-rose-500/20 shadow-[0_0_15px_rgba(244,63,94,0.05)]' : 'bg-rose-50 border-rose-200')
                    }
                  `}
                >
                  <div className="flex justify-between items-start">
                    <span className={`text-[10px] font-mono font-black ${theme !== 'light' ? 'text-slate-500' : 'text-slate-400'}`}>{day.date.split('-')[2]}</span>
                    <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${theme !== 'light' ? 'bg-slate-900 border-white/5 text-slate-500' : 'bg-white text-slate-500 shadow-sm border-slate-100'
                      }`}>{day.trades}x</span>
                  </div>
                  <div className={`text-center font-black font-mono text-sm ${day.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                    ${Math.abs(day.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default PerformanceCalendar;
