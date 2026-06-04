/**
 * AccountFuneralModal — formální "pohřeb" účtu před archivací jako Failed.
 *
 * UX flow:
 *   1. User klikne Skull/Fail tlačítko v AccountsManager
 *   2. Tento modal se otevře místo prostého "Opravdu?" potvrzení
 *   3. Auto-computuje statistiky z trades (peak equity, dny konzistence, win rate)
 *   4. User vyplní co se stalo (proč, jaká částka, lekce)
 *   5. Save:
 *      - Update account.meta s failure metadata (failureReason, failureDate, …)
 *      - Insert do ai_coach_memory jako episode s importance=10
 *      - Standardní fail flow (status=Inactive, archived, result=Failed)
 *
 * Cíl: každé spálení = formální záznam co AI Coach pak nikdy nezapomene.
 * Při dotazu typu "měl bych zvýšit size?" Coach vytáhne tuhle epizodu a varuje.
 */
import React, { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Skull, X, AlertTriangle, TrendingDown, Lightbulb, Calendar, DollarSign, Target } from 'lucide-react';
import type { Account, Trade } from '../types';
import { supabase } from '../services/supabase';

interface Props {
    account: Account;
    trades: Trade[];
    userId: string;
    onConfirm: (failureData: FailureData) => void;
    onClose: () => void;
    theme: 'dark' | 'light' | 'oled';
}

export interface FailureData {
    reason: string;
    whatHappened: string;
    amountLost: number;
    daysOfConsistency: number;
    progressPct: number;
    keyLesson: string;
    failureDate: string;
}

const REASON_OPTIONS = [
    'Tilt po ztrátě',
    'Revenge trading',
    'Frustrace z propásnutého zisku',
    'Overconfidence / Greed',
    'News event / black swan',
    'Porušení daily loss limitu',
    'Porušení max drawdownu',
    'Jiný důvod',
];

const AccountFuneralModal: React.FC<Props> = ({ account, trades, userId, onConfirm, onClose, theme }) => {
    const isDark = theme !== 'light';

    // Trades na tomto účtu, chronologicky
    const accountTrades = useMemo(() =>
        trades
            .filter(t => t.accountId === account.id)
            .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)),
        [trades, account.id]
    );

    // Auto-compute stats
    const stats = useMemo(() => {
        if (accountTrades.length === 0) {
            return { peakEquity: 0, currentEquity: 0, maxDrawdown: 0, daysActive: 0, daysConsistency: 0, progressPct: 0, totalTrades: 0, peakProfit: 0, challengeTarget: 0 };
        }
        let runningEquity = account.initialBalance;
        let peak = account.initialBalance;
        accountTrades.forEach(t => {
            runningEquity += (t.pnl || 0);
            if (runningEquity > peak) peak = runningEquity;
        });
        const peakProfit = peak - account.initialBalance;
        // Max drawdown: largest peak-to-trough decline across the equity curve
        let runDD = account.initialBalance;
        let peakDD = account.initialBalance;
        let maxDrawdown = 0;
        accountTrades.forEach(t => {
            runDD += (t.pnl || 0);
            if (runDD > peakDD) peakDD = runDD;
            const dd = peakDD - runDD;
            if (dd > maxDrawdown) maxDrawdown = dd;
        });
        // Days from first trade to last trade
        const first = accountTrades[0].timestamp || Date.now();
        const last = accountTrades[accountTrades.length - 1].timestamp || Date.now();
        const daysActive = Math.max(1, Math.ceil((last - first) / (1000 * 60 * 60 * 24)));
        // Progress to target (Challenge: typicky 8-10% of initial balance)
        // Challenge target = initialBalance * profitTarget% (same source as AccountsManager progress bar)
        const targetPct = (account.profitTarget && account.profitTarget > 0) ? account.profitTarget : 10;
        const challengeTarget = account.initialBalance * (targetPct / 100);
        const progressPct = Math.round((peakProfit / challengeTarget) * 100);

        // Days of consistency = number of distinct calendar days with at least one trade
        const tradingDaySet = new Set<string>();
        accountTrades.forEach(t => {
            const ts = t.timestamp || Date.now();
            tradingDaySet.add(new Date(ts).toISOString().slice(0, 10));
        });
        const daysConsistency = tradingDaySet.size;
        return {
            peakEquity: peak,
            currentEquity: runningEquity,
            maxDrawdown: Math.round(maxDrawdown),
            daysConsistency,
            daysActive,
            progressPct: Math.max(0, Math.min(100, progressPct)),
            totalTrades: accountTrades.length,
            peakProfit: Math.round(peakProfit),
            challengeTarget: Math.round(challengeTarget),
        };
    }, [accountTrades, account.initialBalance, account]);

    const today = new Date().toISOString().slice(0, 10);
    const [reason, setReason] = useState<string>(REASON_OPTIONS[0]);
    const [whatHappened, setWhatHappened] = useState<string>('');
    const [amountLost, setAmountLost] = useState<number>(stats.maxDrawdown || 0);
    const [keyLesson, setKeyLesson] = useState<string>('');
    const [failureDate, setFailureDate] = useState<string>(today);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canSave = keyLesson.trim().length > 5 && whatHappened.trim().length > 5;

    const handleSave = async () => {
        if (!canSave) {
            setError('Vyplň co se stalo a klíčovou lekci (min. 5 znaků).');
            return;
        }
        setSaving(true);
        setError(null);

        const failureData: FailureData = {
            reason,
            whatHappened: whatHappened.trim(),
            amountLost,
            daysOfConsistency: stats.daysConsistency,
            progressPct: stats.progressPct,
            keyLesson: keyLesson.trim(),
            failureDate,
        };

        // Insert do ai_coach_memory jako episode (importance 10 = nezapomeň!)
        try {
            const content = [
                `KRITICKÁ EPIZODA — Spálení účtu ${account.name} (${failureDate})`,
                ``,
                `CONTEXT:`,
                `• Účet: ${account.name} (${account.type}, ${account.currency})`,
                `• Initial balance: $${account.initialBalance.toLocaleString()}`,
                `• Peak equity: $${stats.peakEquity.toLocaleString()} (+$${stats.peakProfit})`,
                `• Pokrok v challenge: ${stats.progressPct} % k targetu ($${stats.peakProfit}/$${stats.challengeTarget})`,
                `• Dní konzistentní práce: ${stats.daysConsistency}`,
                `• Celkem trades: ${stats.totalTrades}`,
                ``,
                `DŮVOD SPÁLENÍ: ${reason}`,
                ``,
                `CO SE STALO:`,
                whatHappened,
                ``,
                `FINANČNÍ DOPAD: -$${amountLost.toLocaleString()}`,
                ``,
                `KLÍČOVÁ LEKCE:`,
                `⚠️ ${keyLesson}`,
                ``,
                `AI COACH: Při jakékoliv otázce o disciplíně, position sizing, revenge tradingu`,
                `nebo po loss day, VŽDY připomeň tuto epizodu. Zdůrazni že účet byl`,
                `na ${stats.progressPct}% k targetu po ${stats.daysConsistency} dnech konzistence,`,
                `a všechno se ztratilo kvůli: ${reason}.`,
            ].join('\n');

            await supabase.from('ai_coach_memory').insert({
                user_id: userId,
                type: 'episode',
                content,
                importance: 10,
                memory_date: failureDate,
                metadata: {
                    event_type: 'account_blowup',
                    account_id: account.id,
                    account_name: account.name,
                    account_type: account.type,
                    amount_lost_usd: amountLost,
                    progress_at_blowup_pct: stats.progressPct,
                    progress_pnl_usd: stats.peakProfit,
                    target_pnl_usd: stats.challengeTarget,
                    days_of_consistency: stats.daysConsistency,
                    reason,
                    key_lesson: keyLesson.trim(),
                    total_trades: stats.totalTrades,
                },
            });
        } catch (e: any) {
            console.error('[AccountFuneral] Failed to save AI memory:', e);
            // Pokračujeme i kdyby AI memory selhala — důležité je archive account
        }

        setSaving(false);
        onConfirm(failureData);
    };

    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md" onClick={onClose}>
            <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                className={`max-w-2xl w-full max-h-[90vh] overflow-y-auto rounded-[32px] border shadow-2xl ${isDark ? 'bg-slate-900 border-white/10' : 'bg-white border-slate-200'}`}
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="relative p-6 lg:p-8 border-b border-rose-500/20 bg-gradient-to-b from-rose-500/5 to-transparent">
                    <button onClick={onClose} className={`absolute top-4 right-4 p-2 rounded-full ${isDark ? 'hover:bg-white/10 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}>
                        <X size={18} />
                    </button>
                    <div className="flex items-center gap-4">
                        <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-2xl">
                            <Skull size={28} className="text-rose-500" />
                        </div>
                        <div>
                            <p className="text-[9px] font-black uppercase tracking-[0.3em] text-rose-500 mb-1">Account Funeral</p>
                            <h2 className={`text-2xl font-black tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>{account.name}</h2>
                        </div>
                    </div>
                </div>

                <div className="p-6 lg:p-8 space-y-6">
                    {/* Auto-computed stats grid */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <StatCard label="Peak Equity" value={`$${stats.peakEquity.toLocaleString()}`} icon={Target} color="emerald" isDark={isDark} />
                        <StatCard label="Max Drawdown" value={`-$${stats.maxDrawdown.toLocaleString()}`} icon={TrendingDown} color="rose" isDark={isDark} />
                        <StatCard label="Pokrok" value={`${stats.progressPct} %`} icon={Target} color="amber" isDark={isDark} />
                        <StatCard label="Dní aktivní" value={stats.daysActive.toString()} icon={Calendar} color="blue" isDark={isDark} />
                    </div>

                    {/* Reflection form */}
                    <div className="space-y-4">
                        {/* Reason */}
                        <div>
                            <label className={`text-[10px] font-black uppercase tracking-widest mb-2 block ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                                <AlertTriangle size={11} className="inline mr-1.5" />
                                Důvod spálení
                            </label>
                            <select
                                value={reason}
                                onChange={e => setReason(e.target.value)}
                                className={`w-full px-4 py-3 rounded-xl border text-sm ${isDark ? 'bg-slate-800 border-white/10 text-white' : 'bg-white border-slate-200 text-slate-900'}`}
                            >
                                {REASON_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                            </select>
                        </div>

                        {/* What happened */}
                        <div>
                            <label className={`text-[10px] font-black uppercase tracking-widest mb-2 block ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                                Co se stalo <span className="text-rose-500">*</span>
                            </label>
                            <textarea
                                value={whatHappened}
                                onChange={e => setWhatHappened(e.target.value)}
                                placeholder="Stručně popiš co se stalo. Trigger, eskalace, finální moment..."
                                rows={4}
                                className={`w-full px-4 py-3 rounded-xl border text-sm resize-none ${isDark ? 'bg-slate-800 border-white/10 text-white placeholder:text-slate-600' : 'bg-white border-slate-200 text-slate-900 placeholder:text-slate-400'}`}
                            />
                        </div>

                        {/* Datum spálení — důležité, AI Coach ho čte ("včera", "před 3 dny")
                            Často účet padne večer/noc a Funeral se vyplní druhý den → uživatel
                            si může opravit datum ručně. */}
                        <div>
                            <label className={`text-[10px] font-black uppercase tracking-widest mb-2 block ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                                <Calendar size={11} className="inline mr-1.5" />
                                Datum spálení <span className="text-rose-500">*</span>
                                <span className="ml-2 font-normal normal-case tracking-normal text-[9px] opacity-60">(opraf pokud Funeral vyplňuješ až další den)</span>
                            </label>
                            <input
                                type="date"
                                value={failureDate}
                                max={today}
                                onChange={e => setFailureDate(e.target.value)}
                                className={`w-full px-4 py-3 rounded-xl border text-sm font-mono ${isDark ? 'bg-slate-800 border-white/10 text-white' : 'bg-white border-slate-200 text-slate-900'}`}
                            />
                        </div>

                        {/* Amount lost + days */}
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className={`text-[10px] font-black uppercase tracking-widest mb-2 block ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                                    <DollarSign size={11} className="inline mr-1" />
                                    Spálená částka ($)
                                </label>
                                <input
                                    type="number"
                                    value={amountLost}
                                    onChange={e => setAmountLost(Number(e.target.value) || 0)}
                                    className={`w-full px-4 py-3 rounded-xl border text-sm font-mono ${isDark ? 'bg-slate-800 border-white/10 text-white' : 'bg-white border-slate-200 text-slate-900'}`}
                                />
                            </div>
                            <div>
                                <label className={`text-[10px] font-black uppercase tracking-widest mb-2 block ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                                    <Calendar size={11} className="inline mr-1" />
                                    Dní konzistence
                                </label>
                                <div
                                    title="Automaticky spočítáno z obchodních dní — nelze upravit"
                                    className={`w-full px-4 py-3 rounded-xl border text-sm font-mono flex items-center gap-2 ${isDark ? 'bg-slate-800/50 border-white/5 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                                >
                                    <span>{stats.daysConsistency}</span>
                                    <span className="text-[9px] uppercase tracking-widest opacity-50 ml-auto">auto</span>
                                </div>
                            </div>
                        </div>

                        {/* Key lesson */}
                        <div>
                            <label className={`text-[10px] font-black uppercase tracking-widest mb-2 block text-amber-500`}>
                                <Lightbulb size={11} className="inline mr-1.5" />
                                Klíčová lekce <span className="text-rose-500">*</span>
                            </label>
                            <textarea
                                value={keyLesson}
                                onChange={e => setKeyLesson(e.target.value)}
                                placeholder="Co si z toho odnesu? AI Coach ti to bude připomínat při každém riziku, že to uděláš znovu."
                                rows={3}
                                className={`w-full px-4 py-3 rounded-xl border-2 text-sm resize-none ${isDark ? 'bg-amber-500/5 border-amber-500/30 text-white placeholder:text-slate-500' : 'bg-amber-50 border-amber-300 text-slate-900 placeholder:text-amber-700/40'}`}
                            />
                        </div>
                    </div>

                    {/* AI Coach note */}
                    <div className={`p-4 rounded-xl border ${isDark ? 'bg-blue-500/5 border-blue-500/20' : 'bg-blue-50 border-blue-200'}`}>
                        <p className={`text-xs leading-relaxed ${isDark ? 'text-blue-300' : 'text-blue-700'}`}>
                            <strong>🤖 AI Coach:</strong> Tato epizoda bude uložena s nejvyšší prioritou (importance 10/10).
                            Až se Coache zeptáš na cokoliv o disciplíně, position sizing nebo po loss day, vždy ti tohle připomene.
                        </p>
                    </div>

                    {error && (
                        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-500 text-xs font-bold text-center">
                            {error}
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex gap-3 pt-2">
                        <button
                            onClick={onClose}
                            disabled={saving}
                            className={`flex-1 py-3 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all ${isDark ? 'bg-white/5 hover:bg-white/10 text-slate-400' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'} disabled:opacity-50`}
                        >
                            Zrušit
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={!canSave || saving}
                            className="flex-1 py-3 rounded-xl text-[11px] font-black uppercase tracking-widest bg-gradient-to-r from-rose-600 to-rose-500 text-white shadow-lg shadow-rose-500/30 hover:shadow-rose-500/50 transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {saving ? 'Ukládám…' : '⚰️ Pohřbít účet'}
                        </button>
                    </div>
                </div>
            </motion.div>
        </div>
    );
};

const StatCard: React.FC<{ label: string; value: string; icon: any; color: 'emerald' | 'rose' | 'amber' | 'blue'; isDark: boolean }> = ({ label, value, icon: Icon, color, isDark }) => {
    const colorMap = {
        emerald: 'text-emerald-500 border-emerald-500/20 bg-emerald-500/5',
        rose: 'text-rose-500 border-rose-500/20 bg-rose-500/5',
        amber: 'text-amber-500 border-amber-500/20 bg-amber-500/5',
        blue: 'text-blue-500 border-blue-500/20 bg-blue-500/5',
    };
    return (
        <div className={`p-3 rounded-2xl border ${colorMap[color]}`}>
            <div className="flex items-center gap-1.5 mb-1.5">
                <Icon size={11} />
                <p className="text-[9px] font-black uppercase tracking-widest opacity-70">{label}</p>
            </div>
            <p className={`text-lg font-black font-mono tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>{value}</p>
        </div>
    );
};

export default AccountFuneralModal;
