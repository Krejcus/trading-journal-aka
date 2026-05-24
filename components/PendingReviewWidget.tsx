import React, { useMemo } from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';
import type { Trade } from '../types';

interface Props {
    theme: 'dark' | 'light' | 'oled';
    trades: Trade[];
    /** Klik → otevři trade detail (skrz parent App.tsx setSelectedTradeId). */
    onOpenTrade?: (trade: Trade) => void;
}

/**
 * Widget na dashboardu: kolik obchodů má AI návrhy čekající na review.
 * Když je počet 0, widget je skrytý (render null) — žádný šum.
 */
const PendingReviewWidget: React.FC<Props> = ({ theme, trades, onOpenTrade }) => {
    const isDark = theme !== 'light';

    const pending = useMemo(() => {
        return trades.filter(t => {
            const ai = t.aiSuggestions;
            return ai && ai.unreviewed === true;
        }).sort((a, b) => {
            // Nejnovější první
            return new Date(b.date).getTime() - new Date(a.date).getTime();
        });
    }, [trades]);

    if (pending.length === 0) {
        // Žádné pending → widget je tichý
        return (
            <div className={`p-4 rounded-[24px] lg:rounded-[32px] h-full min-h-0 w-full flex flex-col overflow-hidden glass-panel items-center justify-center text-center gap-2`}>
                <Sparkles size={18} className={isDark ? 'text-slate-600' : 'text-slate-400'} />
                <p className={`text-[10px] font-bold uppercase tracking-widest ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    Vše otagováno
                </p>
            </div>
        );
    }

    const latest = pending.slice(0, 3);

    return (
        <div className={`p-4 rounded-[24px] lg:rounded-[32px] h-full min-h-0 w-full flex flex-col overflow-hidden glass-panel`}>
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded-md bg-amber-500/10 border border-amber-500/20">
                        <Sparkles size={14} className="text-amber-500" />
                    </div>
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-amber-500">AI Návrhy</p>
                        <p className={`text-base font-black leading-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
                            {pending.length} {pending.length === 1 ? 'obchod čeká' : pending.length < 5 ? 'obchody čekají' : 'obchodů čeká'}
                        </p>
                    </div>
                </div>
            </div>

            <div className="flex-1 space-y-1.5 overflow-y-auto custom-scrollbar">
                {latest.map(t => {
                    const ai = t.aiSuggestions;
                    const totalSuggestions =
                        (ai?.htf?.length || 0) +
                        (ai?.ltf?.length || 0) +
                        (ai?.mistakes?.length || 0) +
                        (ai?.emotions?.length || 0);
                    const dateStr = String(t.date).slice(0, 10);
                    const pnlPositive = (t.pnl || 0) >= 0;
                    return (
                        <button
                            key={t.id}
                            onClick={() => onOpenTrade?.(t)}
                            className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl transition-all text-left ${
                                isDark
                                    ? 'bg-white/[0.03] hover:bg-white/[0.06] border border-white/5'
                                    : 'bg-white/60 hover:bg-white border border-slate-200'
                            }`}
                        >
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className={`text-[11px] font-black uppercase tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>
                                        {t.instrument} {t.direction}
                                    </span>
                                    <span className={`text-[10px] font-mono font-black ${pnlPositive ? 'text-emerald-500' : 'text-rose-500'}`}>
                                        {pnlPositive ? '+' : ''}${(t.pnl || 0).toFixed(0)}
                                    </span>
                                </div>
                                <p className={`text-[9px] font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'} mt-0.5`}>
                                    {dateStr} · {totalSuggestions} návrhů
                                </p>
                            </div>
                            <ArrowRight size={12} className={isDark ? 'text-slate-500' : 'text-slate-400'} />
                        </button>
                    );
                })}
                {pending.length > 3 && (
                    <p className={`text-[9px] text-center mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        + dalších {pending.length - 3}
                    </p>
                )}
            </div>
        </div>
    );
};

export default PendingReviewWidget;
