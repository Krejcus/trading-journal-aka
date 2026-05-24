/**
 * InsightsPanel — visualizace pattern analysis nad trade historií.
 *
 * Vstup: Trade[]
 * Výstup: UI s leaks / strengths cards + baseline stats
 *
 * Lokálně počítá `analyzePatterns()` — žádné API calls.
 */
import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    AlertTriangle, CheckCircle2, TrendingUp, TrendingDown,
    BarChart3, Filter, X, ChevronDown, ChevronUp, Brain, Activity, Sparkles, ArrowUpRight, ArrowDownRight
} from 'lucide-react';
import { Trade } from '../types';
import { analyzePatterns, Insight } from '../utils/patternAnalysis';

interface InsightsPanelProps {
    trades: Trade[];
    theme: 'dark' | 'light' | 'oled';
    /** Volitelný callback — když user chce přidat insight jako Iron Rule */
    onAddRule?: (rule: string) => void;
    /** Otevře AI Coach s pre-fill promptem ohledně insightu */
    onAskAI?: (prompt: string) => void;
    /** Otevře trade detail modal */
    onOpenTrade?: (trade: Trade) => void;
}

/** Vytvoří prompt pro AI Coach z insightu */
function buildAIPrompt(insight: Insight): string {
    const direction = insight.severity === 'leak' ? 'ztrácím' : 'mám edge';
    return `Analyzuj prosím tento pattern z mojí historie obchodů:

📊 **${insight.title}**
- Dimension: ${insight.dimension}
- Bucket: ${insight.bucketValue}
- Stats: ${insight.statLine}
- Návrh akce: ${insight.actionSuggestion}

Chtěl bych vědět:
1. Proč si myslíš že ${direction} v této kategorii? Najdi konkrétní trades v této skupině (id: ${insight.tradeIds.slice(0, 10).join(', ')}${insight.tradeIds.length > 10 ? '…' : ''}) a najdi jejich společné rysy (mistakes, emotions, market context, čas).
2. ${insight.severity === 'leak' ? 'Jak konkrétně to mám opravit? Jaké pravidlo/checklist přidat?' : 'Jak to mám replikovat / posílit?'}
3. Existuje konkrétní trigger nebo událost která tomuto patternu předchází?`;
}

const InsightCard: React.FC<{
    insight: Insight;
    allTrades: Trade[];
    theme: 'dark' | 'light' | 'oled';
    onAddRule?: (rule: string) => void;
    onAskAI?: (prompt: string) => void;
    onOpenTrade?: (trade: Trade) => void;
}> = ({ insight, allTrades, theme, onAddRule, onAskAI, onOpenTrade }) => {
    const isDark = theme !== 'light';
    const isLeak = insight.severity === 'leak';
    const [expanded, setExpanded] = useState(false);

    const accentColor = isLeak ? 'rose' : 'emerald';
    const Icon = isLeak ? AlertTriangle : CheckCircle2;

    // Lookup actual trade objects from IDs (only when expanded — cheap to compute)
    const bucketTrades = expanded
        ? insight.tradeIds.map(id => allTrades.find(t => t.id === id)).filter(Boolean) as Trade[]
        : [];

    const formatDate = (d: string | undefined) => {
        if (!d) return '—';
        try { return new Date(d).toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit' }); }
        catch { return '—'; }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className={`p-5 rounded-2xl border transition-all ${
                isLeak
                    ? isDark ? 'bg-rose-500/[0.05] border-rose-500/20' : 'bg-rose-50/50 border-rose-200/60'
                    : isDark ? 'bg-emerald-500/[0.05] border-emerald-500/20' : 'bg-emerald-50/50 border-emerald-200/60'
            }`}
        >
            <div className="flex items-start gap-3 mb-3">
                <div className={`p-2 rounded-xl shrink-0 ${
                    isLeak
                        ? isDark ? 'bg-rose-500/10' : 'bg-rose-500/15'
                        : isDark ? 'bg-emerald-500/10' : 'bg-emerald-500/15'
                }`}>
                    <Icon size={16} className={`text-${accentColor}-${isDark ? '400' : '500'}`} strokeWidth={2.5} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded ${
                            isLeak
                                ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
                                : 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                        }`}>
                            {insight.dimension}
                        </span>
                        <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
                            n={insight.metrics.sampleSize}
                        </span>
                    </div>
                    <h4 className={`text-sm font-black uppercase tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                        {insight.title}
                    </h4>
                </div>
            </div>

            <p className={`text-xs font-mono font-medium mb-3 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                {insight.statLine}
            </p>

            <div className={`text-xs leading-relaxed mb-3 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                <span className="font-bold">➜ Akce:</span> {insight.actionSuggestion}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
                {onAddRule && isLeak && (
                    <button
                        onClick={() => onAddRule(insight.actionSuggestion)}
                        className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${
                            isDark ? 'bg-rose-500/20 text-rose-400 hover:bg-rose-500/30' : 'bg-rose-500 text-white hover:bg-rose-600'
                        }`}
                    >
                        + Iron Rule
                    </button>
                )}
                {onAskAI && (
                    <button
                        onClick={() => onAskAI(buildAIPrompt(insight))}
                        className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${
                            isDark ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30' : 'bg-blue-500 text-white hover:bg-blue-600 shadow-md shadow-blue-500/20'
                        }`}
                    >
                        <Sparkles size={10} strokeWidth={2.5} />
                        Zeptat AI
                    </button>
                )}
                <button
                    onClick={() => setExpanded(!expanded)}
                    className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all flex items-center gap-1 ${
                        isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    }`}
                >
                    {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                    Detail ({insight.tradeIds.length})
                </button>
            </div>

            <AnimatePresence>
                {expanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        {/* Stat grid */}
                        <div className={`mt-3 pt-3 border-t grid grid-cols-2 md:grid-cols-4 gap-3 ${isDark ? 'border-white/5' : 'border-slate-200'}`}>
                            <div>
                                <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 mb-0.5">Sample</p>
                                <p className={`text-sm font-black font-mono ${isDark ? 'text-slate-200' : 'text-slate-900'}`}>{insight.metrics.sampleSize}</p>
                            </div>
                            <div>
                                <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 mb-0.5">Winrate</p>
                                <p className={`text-sm font-black font-mono text-${accentColor}-500`}>
                                    {insight.metrics.winRate.toFixed(0)}%
                                </p>
                            </div>
                            <div>
                                <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 mb-0.5">Δ od base</p>
                                <p className={`text-sm font-black font-mono text-${accentColor}-500`}>
                                    {insight.metrics.deviation > 0 ? '+' : ''}{insight.metrics.deviation.toFixed(0)}pp
                                </p>
                            </div>
                            <div>
                                <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 mb-0.5">Avg R</p>
                                <p className={`text-sm font-black font-mono ${insight.metrics.avgR >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                    {insight.metrics.avgR >= 0 ? '+' : ''}{insight.metrics.avgR.toFixed(2)}
                                </p>
                            </div>
                        </div>

                        {/* List konkrétních tradů */}
                        {bucketTrades.length > 0 && (
                            <div className={`mt-4 pt-3 border-t ${isDark ? 'border-white/5' : 'border-slate-200'}`}>
                                <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-2">
                                    Konkrétní trades ({bucketTrades.length})
                                </p>
                                <div className="space-y-1 max-h-[200px] overflow-y-auto no-scrollbar">
                                    {bucketTrades.map(t => {
                                        const tIsWin = (t.pnl || 0) > 0.01;
                                        const tIsLong = String(t.direction || '').toLowerCase() === 'long';
                                        return (
                                            <button
                                                key={t.id}
                                                onClick={() => onOpenTrade?.(t)}
                                                disabled={!onOpenTrade}
                                                className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left transition-all ${
                                                    onOpenTrade
                                                        ? isDark ? 'bg-white/[0.03] hover:bg-white/[0.07] cursor-pointer' : 'bg-white hover:bg-slate-100 cursor-pointer border border-slate-200/60'
                                                        : isDark ? 'bg-white/[0.03]' : 'bg-white border border-slate-200/60'
                                                }`}
                                            >
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <span className="text-[9px] font-mono font-bold text-slate-400 shrink-0">{formatDate(t.date)}</span>
                                                    <span className={`text-[9px] font-black uppercase tracking-wider shrink-0 ${tIsLong ? 'text-emerald-500' : 'text-rose-500'} flex items-center gap-0.5`}>
                                                        {tIsLong ? <ArrowUpRight size={8} strokeWidth={3} /> : <ArrowDownRight size={8} strokeWidth={3} />}
                                                        {t.direction}
                                                    </span>
                                                    <span className={`text-[10px] font-black uppercase tracking-tight truncate ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                                        {t.instrument}
                                                    </span>
                                                </div>
                                                <span className={`text-[10px] font-black font-mono shrink-0 ${tIsWin ? 'text-emerald-500' : (t.pnl || 0) < -0.01 ? 'text-rose-500' : 'text-slate-400'}`}>
                                                    {(t.pnl || 0) >= 0 ? '+' : ''}${(t.pnl || 0).toFixed(0)}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
};

const InsightsPanel: React.FC<InsightsPanelProps> = ({ trades, theme, onAddRule, onAskAI, onOpenTrade }) => {
    const isDark = theme !== 'light';
    const [filter, setFilter] = useState<'all' | 'leaks' | 'strengths'>('all');

    const result = useMemo(() => analyzePatterns(trades), [trades]);

    const visibleInsights = filter === 'all'
        ? result.insights
        : filter === 'leaks' ? result.leaks : result.strengths;

    if (result.insufficientData) {
        return (
            <div className={`p-8 rounded-3xl border text-center ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-slate-50 border-slate-200'}`}>
                <Brain size={32} className="text-slate-400 mx-auto mb-3" />
                <h3 className={`text-base font-black uppercase tracking-tight mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                    Málo dat pro analýzu
                </h3>
                <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">{result.insufficientData}</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header s baseline */}
            <div className={`p-5 rounded-3xl border ${isDark ? 'bg-white/[0.03] border-white/5' : 'bg-slate-50 border-slate-200'}`}>
                <div className="flex items-center gap-2 mb-3">
                    <BarChart3 size={14} className="text-blue-500" />
                    <h3 className={`text-xs font-black uppercase tracking-[0.2em] ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        Baseline · Tvoje historie
                    </h3>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                        <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Trades</p>
                        <p className={`text-2xl font-black font-mono ${isDark ? 'text-white' : 'text-slate-900'}`}>{result.baseline.totalTrades}</p>
                    </div>
                    <div>
                        <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Winrate</p>
                        <p className={`text-2xl font-black font-mono ${result.baseline.winRate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>
                            {result.baseline.winRate.toFixed(0)}%
                        </p>
                    </div>
                    <div>
                        <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Avg R</p>
                        <p className={`text-2xl font-black font-mono ${result.baseline.avgR >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                            {result.baseline.avgR >= 0 ? '+' : ''}{result.baseline.avgR.toFixed(2)}
                        </p>
                    </div>
                    <div>
                        <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Total PnL</p>
                        <p className={`text-2xl font-black font-mono ${result.baseline.totalPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                            {result.baseline.totalPnl >= 0 ? '+' : ''}${result.baseline.totalPnl.toFixed(0)}
                        </p>
                    </div>
                </div>
            </div>

            {/* Filter buttons + counts */}
            <div className="flex items-center gap-2 flex-wrap">
                <Filter size={12} className="text-slate-400" />
                {[
                    { key: 'all' as const, label: 'Vše', count: result.insights.length, color: 'slate' },
                    { key: 'leaks' as const, label: 'Leaks', count: result.leaks.length, color: 'rose' },
                    { key: 'strengths' as const, label: 'Strengths', count: result.strengths.length, color: 'emerald' },
                ].map(opt => (
                    <button
                        key={opt.key}
                        onClick={() => setFilter(opt.key)}
                        className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${
                            filter === opt.key
                                ? opt.key === 'leaks' ? 'bg-rose-500 text-white'
                                  : opt.key === 'strengths' ? 'bg-emerald-500 text-white'
                                  : 'bg-blue-600 text-white'
                                : isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                        }`}
                    >
                        {opt.label}
                        <span className={`px-1.5 py-0.5 rounded text-[8px] ${
                            filter === opt.key ? 'bg-white/20' : isDark ? 'bg-white/10' : 'bg-slate-200'
                        }`}>
                            {opt.count}
                        </span>
                    </button>
                ))}
            </div>

            {/* Insight cards */}
            {visibleInsights.length === 0 ? (
                <div className={`p-8 rounded-2xl border text-center ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-slate-50 border-slate-200'}`}>
                    <Activity size={28} className="text-slate-400 mx-auto mb-2" />
                    <p className={`text-sm font-bold ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                        {filter === 'leaks' ? 'Žádné leaks!' : filter === 'strengths' ? 'Zatím žádné strengths.' : 'Žádné insights.'}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                        {filter === 'leaks'
                            ? 'Nic významně neoblevuje. Solidní disciplína.'
                            : 'Pokračuj v tradování — patterns se vyjeví s víc daty.'}
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <AnimatePresence mode="popLayout">
                        {visibleInsights.map(insight => (
                            <InsightCard
                                key={insight.id}
                                insight={insight}
                                allTrades={trades}
                                theme={theme}
                                onAddRule={onAddRule}
                                onAskAI={onAskAI}
                                onOpenTrade={onOpenTrade}
                            />
                        ))}
                    </AnimatePresence>
                </div>
            )}
        </div>
    );
};

export default InsightsPanel;
