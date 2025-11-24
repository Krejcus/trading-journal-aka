"use client";

import { useState, useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export default function TradingCalendar() {
    const [currentDate, setCurrentDate] = useState(new Date());
    const [calendarData, setCalendarData] = useState<Record<string, number>>({});

    useEffect(() => {
        const fetchTrades = async () => {
            try {
                const res = await fetch('/api/trades');
                const trades: any[] = await res.json();

                if (Array.isArray(trades)) {
                    const pnlByDate: Record<string, number> = {};
                    trades.forEach(trade => {
                        const date = new Date(trade.entryTime * 1000).toISOString().split('T')[0];
                        pnlByDate[date] = (pnlByDate[date] || 0) + (trade.pnl || 0);
                    });
                    setCalendarData(pnlByDate);
                }
            } catch (error) {
                console.error("Failed to fetch trades for calendar", error);
            }
        };

        fetchTrades();
    }, []);

    const daysInMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
    const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).getDay(); // 0 = Sunday

    // Adjust for Monday start (0 = Monday, 6 = Sunday)
    const startDay = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;

    const days = [];
    // Empty slots for previous month
    for (let i = 0; i < startDay; i++) {
        days.push(null);
    }
    // Days of current month
    for (let i = 1; i <= daysInMonth; i++) {
        days.push(i);
    }

    const getPnl = (day: number) => {
        const dateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        return calendarData[dateStr];
    };

    const prevMonth = () => {
        setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
    };

    const nextMonth = () => {
        setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
    };

    return (
        <div className="w-full">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-md font-semibold text-white">
                    {currentDate.toLocaleString('cs-CZ', { month: 'long', year: 'numeric' })}
                </h3>
                <div className="flex space-x-1">
                    <button onClick={prevMonth} className="p-1 hover:bg-slate-800 rounded text-slate-400"><ChevronLeft className="w-4 h-4" /></button>
                    <button onClick={nextMonth} className="p-1 hover:bg-slate-800 rounded text-slate-400"><ChevronRight className="w-4 h-4" /></button>
                </div>
            </div>

            <div className="grid grid-cols-7 gap-1 text-center mb-2">
                {['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'].map(day => (
                    <div key={day} className="text-xs text-slate-500 font-medium py-1">{day}</div>
                ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
                {days.map((day, index) => {
                    if (day === null) return <div key={`empty-${index}`} className="aspect-square"></div>;

                    const pnl = getPnl(day);
                    const hasTrade = pnl !== undefined;
                    const isWin = pnl > 0;

                    return (
                        <div
                            key={day}
                            className={`aspect-square rounded border border-slate-800 flex flex-col items-center justify-center relative group cursor-pointer transition-colors
                ${hasTrade ? (isWin ? 'bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20' : 'bg-rose-500/10 border-rose-500/30 hover:bg-rose-500/20') : 'bg-slate-900 hover:bg-slate-800'}
              `}
                        >
                            <span className={`text-xs ${hasTrade ? 'text-white font-bold' : 'text-slate-500'}`}>{day}</span>
                            {hasTrade && (
                                <span className={`text-[10px] font-bold mt-1 ${isWin ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    {pnl > 0 ? '+' : ''}{pnl}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
