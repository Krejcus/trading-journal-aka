/**
 * Graveyard — "hřbitov" spálených účtů.
 *
 * Zobrazí se v záložce Archiv (AccountsManager) pro účty s result === 'Failed'.
 * Cíl: data spálených účtů nikdy nezmizí a jdou kdykoliv prohlédnout + učit se z nich.
 *
 * Sekce:
 *   1. Souhrnný pruh (kolik pohřbeno, celkem spáleno, nejčastější příčina, prům. % k cíli, dní disciplíny)
 *   2. Náhrobek karty s multi-výběrem (checkbox)
 *   3. Memorial detail (klik na kartu) — read-only mini-dashboard: equity křivka, statistiky, funeral zápis, obchody
 *   4. Porovnání (výběr více karet) — sloučené ztráty, opakující se vzorce, společné lekce
 *   5. Zeď lekcí — všechny klíčové lekce pohromadě
 */
import React, { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Skull, X, TrendingDown, Target, Calendar, Lightbulb, Scale, AlertTriangle, BookOpen, Check, BarChart3, Activity, Archive, Trophy, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Account, Trade } from '../types';
import { firmOf, firmLabel, firmInitials, firmColor, FIRM_LOGOS } from '../utils/accountFirm';
import { storageService } from '../services/storageService';

interface Props {
    accounts: Account[]; // pouze spálené (result === 'Failed')
    trades: Trade[];
    theme: 'dark' | 'light' | 'oled';
}

// ── Stats helper ────────────────────────────────────────────────
export interface AccountStats {
    totalTrades: number;
    totalPnL: number;
    winRate: number;
    avgR: number | null;
    bestTrade: number;
    worstTrade: number;
    peakEquity: number;
    peakProfit: number;
    maxDrawdown: number;
    daysConsistency: number;
    challengeTarget: number;
    progressPct: number;
    equityCurve: number[]; // running equity včetně initial
    amountLost: number;
}

export function computeStats(account: Account, allTrades: Trade[]): AccountStats {
    const t = allTrades
        .filter(x => x.accountId === account.id)
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const initial = account.initialBalance;
    if (t.length === 0) {
        return {
            totalTrades: 0, totalPnL: 0, winRate: 0, avgR: null, bestTrade: 0, worstTrade: 0,
            peakEquity: initial, peakProfit: 0, maxDrawdown: account.failureAmountLost || 0,
            daysConsistency: account.failureDaysOfConsistency || 0,
            challengeTarget: initial * ((account.profitTarget || 10) / 100),
            progressPct: account.failureProgressPct || 0, equityCurve: [initial], amountLost: account.failureAmountLost || 0,
        };
    }

    let running = initial;
    let peak = initial;
    let peakForDD = initial;
    let maxDD = 0;
    const curve: number[] = [initial];
    let wins = 0;
    let best = -Infinity;
    let worst = Infinity;
    let rSum = 0;
    let rCount = 0;
    const daySet = new Set<string>();

    t.forEach(tr => {
        const pnl = tr.pnl || 0;
        running += pnl;
        curve.push(running);
        if (running > peak) peak = running;
        if (running > peakForDD) peakForDD = running;
        const dd = peakForDD - running;
        if (dd > maxDD) maxDD = dd;
        if (pnl > 0) wins++;
        if (pnl > best) best = pnl;
        if (pnl < worst) worst = pnl;
        if (tr.riskAmount && tr.riskAmount > 0) { rSum += pnl / tr.riskAmount; rCount++; }
        daySet.add(new Date(tr.timestamp || Date.now()).toISOString().slice(0, 10));
    });

    const totalPnL = running - initial;
    const peakProfit = peak - initial;
    const targetPct = (account.profitTarget && account.profitTarget > 0) ? account.profitTarget : 10;
    const challengeTarget = initial * (targetPct / 100);
    const progressPct = account.failureProgressPct ?? Math.max(0, Math.min(100, Math.round((peakProfit / challengeTarget) * 100)));

    return {
        totalTrades: t.length,
        totalPnL: Math.round(totalPnL),
        winRate: Math.round((wins / t.length) * 100),
        avgR: rCount > 0 ? rSum / rCount : null,
        bestTrade: Math.round(best),
        worstTrade: Math.round(worst),
        peakEquity: Math.round(peak),
        peakProfit: Math.round(peakProfit),
        maxDrawdown: Math.round(account.failureAmountLost || maxDD),
        daysConsistency: account.failureDaysOfConsistency || daySet.size,
        challengeTarget: Math.round(challengeTarget),
        progressPct,
        equityCurve: curve,
        amountLost: Math.round(account.failureAmountLost || maxDD),
    };
}

// ── Equity sparkline ────────────────────────────────────────────
const EquityCurve: React.FC<{ data: number[]; initial: number; width?: number; height?: number; isDark: boolean }> = ({ data, initial, width = 600, height = 160, isDark }) => {
    if (data.length < 2) return <div className="text-xs text-slate-500 italic py-8 text-center">Žádné obchody k vykreslení</div>;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const pts = data.map((v, i) => {
        const x = (i / (data.length - 1)) * width;
        const y = height - ((v - min) / range) * height;
        return [x, y];
    });
    const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const areaPath = `${path} L ${width} ${height} L 0 ${height} Z`;
    const baselineY = height - ((initial - min) / range) * height;
    const endsDown = data[data.length - 1] < initial;
    const stroke = endsDown ? '#f43f5e' : '#10b981';

    return (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }} preserveAspectRatio="none">
            <defs>
                <linearGradient id="gv-eq-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
                    <stop offset="100%" stopColor={stroke} stopOpacity="0" />
                </linearGradient>
            </defs>
            {/* baseline (initial balance) */}
            <line x1="0" y1={baselineY} x2={width} y2={baselineY} stroke={isDark ? '#475569' : '#cbd5e1'} strokeWidth="1" strokeDasharray="4 4" />
            <path d={areaPath} fill="url(#gv-eq-grad)" />
            <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
    );
};

// ── Mini sparkline for tombstone card ───────────────────────────
const MiniCurve: React.FC<{ data: number[]; }> = ({ data }) => {
    if (data.length < 2) return null;
    const w = 120, h = 32;
    const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
    const path = data.map((v, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = h - ((v - min) / range) * h;
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    return (
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-8" preserveAspectRatio="none">
            <path d={path} fill="none" stroke="#f43f5e" strokeWidth="1.5" strokeOpacity="0.6" strokeLinejoin="round" />
        </svg>
    );
};

const fmt = (n: number) => `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const fmtDate = (d?: string) => d ? new Date(d).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';

const Graveyard: React.FC<Props> = ({ accounts, trades, theme }) => {
    const isDark = theme !== 'light';
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [detailAccount, setDetailAccount] = useState<Account | null>(null);
    const [showCompare, setShowCompare] = useState(false);
    const [showLessons, setShowLessons] = useState(false);
    const [expandedFunerals, setExpandedFunerals] = useState<Set<string>>(new Set());

    // Stats per account (memoized map)
    const statsMap = useMemo(() => {
        const m = new Map<string, AccountStats>();
        accounts.forEach(a => m.set(a.id, computeStats(a, trades)));
        return m;
    }, [accounts, trades]);

    // ── Summary across all failed accounts ──
    const summary = useMemo(() => {
        const buried = accounts.length;
        let totalLost = 0, totalDays = 0, progressSum = 0, progressCount = 0;
        const reasonCount: Record<string, number> = {};
        accounts.forEach(a => {
            const s = statsMap.get(a.id)!;
            totalLost += s.amountLost;
            totalDays += s.daysConsistency;
            if (typeof s.progressPct === 'number') { progressSum += s.progressPct; progressCount++; }
            const r = a.failureReason || 'Neuvedeno';
            reasonCount[r] = (reasonCount[r] || 0) + 1;
        });
        const topReason = Object.entries(reasonCount).sort((a, b) => b[1] - a[1])[0];
        return {
            buried,
            totalLost,
            totalDays,
            avgProgress: progressCount > 0 ? Math.round(progressSum / progressCount) : 0,
            topReason: topReason ? topReason[0] : '—',
            topReasonCount: topReason ? topReason[1] : 0,
        };
    }, [accounts, statsMap]);

    // Seskupení po firmách a po společném Funeral obřadu. Nové hromadné pohřby mají
    // failureGroupId; starší záznamy bezpečně domergujeme jen při shodné reflexi
    // a archivaci v rámci jedné minuty.
    const firmGroups = useMemo(() => {
        const byFirm = new Map<string, Account[]>();
        for (const a of accounts) {
            const f = firmOf(a);
            if (!byFirm.has(f)) byFirm.set(f, []);
            byFirm.get(f)!.push(a);
        }
        return [...byFirm.entries()].map(([firm, accts]) => {
            const byFuneral = new Map<string, Account[]>();
            for (const a of accts) {
                const legacyMinute = a.archivedAt ? Math.floor(a.archivedAt / 60_000) : a.id;
                const reflection = [a.failureDate, a.failureReason, a.failureWhatHappened, a.failureKeyLesson].join('|');
                const key = a.failureGroupId || `legacy:${legacyMinute}:${reflection}`;
                if (!byFuneral.has(key)) byFuneral.set(key, []);
                byFuneral.get(key)!.push(a);
            }
            const funerals = [...byFuneral.entries()].map(([key, funeralAccounts]) => ({
                key,
                accts: funeralAccounts,
                totalLost: funeralAccounts.reduce((s, a) => s + (statsMap.get(a.id)?.amountLost || 0), 0),
            })).sort((a, b) => (b.accts[0]?.archivedAt || 0) - (a.accts[0]?.archivedAt || 0));
            return {
                firm,
                accts,
                funerals,
                totalLost: accts.reduce((s, a) => s + (statsMap.get(a.id)?.amountLost || 0), 0),
            };
        }).sort((a, b) => b.accts.length - a.accts.length || b.totalLost - a.totalLost);
    }, [accounts, statsMap]);

    const toggleFuneral = (key: string) => {
        setExpandedFunerals(prev => {
            const next = new Set(prev);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
        });
    };

    const toggleSelect = (id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const selectedAccounts = accounts.filter(a => selected.has(a.id));

    // Jeden náhrobek (vytaženo z mřížky kvůli seskupení po firmách)
    const renderTombstone = (acc: Account) => {
        const s = statsMap.get(acc.id)!;
        const isSel = selected.has(acc.id);
        return (
            <motion.div
                key={acc.id}
                layout
                onClick={() => setDetailAccount(acc)}
                className={`group relative cursor-pointer rounded-[24px] border p-5 transition-all ${isSel ? 'border-blue-500/60 ring-2 ring-blue-500/30' : isDark ? 'border-rose-500/15 hover:border-rose-500/30' : 'border-rose-200 hover:border-rose-300'} ${isDark ? 'bg-gradient-to-b from-rose-500/[0.06] to-slate-900/40' : 'bg-gradient-to-b from-rose-50 to-white'}`}
            >
                <button
                    onClick={(e) => { e.stopPropagation(); toggleSelect(acc.id); }}
                    className={`absolute top-4 right-4 w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${isSel ? 'bg-blue-500 border-blue-500 text-white' : isDark ? 'border-white/15 hover:border-white/40' : 'border-slate-300 hover:border-slate-400'}`}
                >
                    {isSel && <Check size={13} strokeWidth={3} />}
                </button>

                <div className="flex items-start gap-3 mb-4 pr-8">
                    <div className="p-2 bg-rose-500/10 border border-rose-500/20 rounded-xl shrink-0">
                        <Skull size={18} className="text-rose-500" />
                    </div>
                    <div className="min-w-0">
                        <h3 className={`text-base font-black tracking-tight truncate ${isDark ? 'text-white' : 'text-slate-900'}`}>{acc.name}</h3>
                        <p className="text-[10px] font-bold text-slate-500">† {fmtDate(acc.failureDate)}</p>
                    </div>
                </div>

                <div className="mb-3 -mx-1">
                    <MiniCurve data={s.equityCurve} />
                </div>

                <div className="grid grid-cols-3 gap-2 mb-4">
                    <TombStat label="Spáleno" value={`-${fmt(s.amountLost)}`} accent="rose" isDark={isDark} />
                    <TombStat label="K cíli" value={`${s.progressPct}%`} accent="amber" isDark={isDark} />
                    <TombStat label="Dní" value={s.daysConsistency.toString()} isDark={isDark} />
                </div>

                {acc.failureReason && (
                    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold mb-2 ${isDark ? 'bg-rose-500/10 text-rose-400' : 'bg-rose-100 text-rose-600'}`}>
                        <AlertTriangle size={10} /> {acc.failureReason}
                    </div>
                )}

                {acc.failureKeyLesson && (
                    <p className={`text-xs leading-snug line-clamp-2 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                        <Lightbulb size={11} className="inline mr-1 text-amber-500" />
                        {acc.failureKeyLesson}
                    </p>
                )}
            </motion.div>
        );
    };

    // All lessons across funerals
    const allLessons = useMemo(() =>
        accounts
            .filter(a => a.failureKeyLesson && a.failureKeyLesson.trim())
            .map(a => ({ id: a.id, name: a.name, date: a.failureDate, reason: a.failureReason, lesson: a.failureKeyLesson! }))
            .sort((a, b) => (b.date || '').localeCompare(a.date || '')),
        [accounts]);

    if (accounts.length === 0) {
        return (
            <div className={`p-12 rounded-[24px] border text-center ${isDark ? 'bg-theme-page/40 border-white/5' : 'bg-white border-slate-200'}`}>
                <Skull size={40} className="mx-auto text-slate-600 mb-3" />
                <p className="text-sm font-bold text-slate-500">Žádné spálené účty. Drž se plánu. 🙏</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* ── Summary bar ── */}
            <div className={`rounded-[24px] border overflow-hidden ${isDark ? 'bg-gradient-to-br from-rose-500/[0.07] to-transparent border-rose-500/15' : 'bg-rose-50/50 border-rose-200'}`}>
                <div className="px-6 py-3 flex items-center gap-2 border-b border-rose-500/10">
                    <Skull size={15} className="text-rose-500" />
                    <p className="text-[10px] font-black uppercase tracking-[0.25em] text-rose-500">Hřbitov účtů</p>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 divide-x divide-y md:divide-y-0 divide-rose-500/10">
                    <SummaryCell label="Pohřbeno" value={summary.buried.toString()} isDark={isDark} />
                    <SummaryCell label="Celkem spáleno" value={`-${fmt(summary.totalLost)}`} accent="rose" isDark={isDark} />
                    <SummaryCell label="Ø k cíli" value={`${summary.avgProgress} %`} accent="amber" isDark={isDark} />
                    <SummaryCell label="Dní disciplíny" value={summary.totalDays.toString()} isDark={isDark} />
                    <SummaryCell label="Nejč. příčina" value={summary.topReason} sub={`${summary.topReasonCount}×`} isDark={isDark} small />
                </div>
            </div>

            {/* ── Action bar ── */}
            <div className="flex items-center justify-between flex-wrap gap-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                    {selected.size > 0 ? `${selected.size} vybráno` : `${accounts.length} náhrobků`}
                </p>
                <div className="flex items-center gap-2">
                    {selected.size >= 2 && (
                        <button onClick={() => setShowCompare(true)} className="flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20 active:scale-95 transition-all">
                            <Scale size={13} /> Porovnat ({selected.size})
                        </button>
                    )}
                    {selected.size > 0 && (
                        <button onClick={() => setSelected(new Set())} className="px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-300">Zrušit výběr</button>
                    )}
                    {allLessons.length > 0 && (
                        <button onClick={() => setShowLessons(true)} className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${isDark ? 'border-amber-500/30 text-amber-500 hover:bg-amber-500/10' : 'border-amber-300 text-amber-600 hover:bg-amber-50'}`}>
                            <BookOpen size={13} /> Zeď lekcí ({allLessons.length})
                        </button>
                    )}
                </div>
            </div>

            {/* ── Náhrobky seskupené po firmách ── */}
            <div className="space-y-6">
                {firmGroups.map(g => {
                    const logo = FIRM_LOGOS[g.firm];
                    return (
                        <div key={g.firm}>
                            <div className="flex items-center gap-2.5 mb-3 px-1">
                                {logo
                                    ? <img src={logo} alt="" className="w-6 h-6 rounded-md object-contain bg-white/90 p-0.5 border border-black/5 shrink-0 opacity-90" />
                                    : <div className="w-6 h-6 rounded-md shrink-0 flex items-center justify-center text-[9px] font-black text-white opacity-90" style={{ background: firmColor(g.firm).bg }}>{firmInitials(g.firm)}</div>}
                                <h4 className={`text-xs font-black uppercase tracking-tight ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{firmLabel(g.firm)}</h4>
                                <span className="text-[10px] font-black uppercase tracking-widest text-rose-500/70">{g.accts.length} ☠</span>
                                <span className="ml-auto text-[11px] font-black font-mono text-rose-500">−{fmt(g.totalLost)}</span>
                            </div>
                            <div className="space-y-3">
                                {g.funerals.map(funeral => {
                                    if (funeral.accts.length === 1) {
                                        return <div key={funeral.key} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{renderTombstone(funeral.accts[0])}</div>;
                                    }
                                    const first = funeral.accts[0];
                                    const expanded = expandedFunerals.has(funeral.key);
                                    const avgProgress = Math.round(funeral.accts.reduce((sum, a) => sum + (statsMap.get(a.id)?.progressPct || 0), 0) / funeral.accts.length);
                                    return (
                                        <div key={funeral.key} className={`rounded-[24px] border overflow-hidden ${isDark ? 'bg-rose-500/[0.04] border-rose-500/15' : 'bg-rose-50/60 border-rose-200'}`}>
                                            <button
                                                onClick={() => toggleFuneral(funeral.key)}
                                                className={`w-full p-4 flex items-center gap-4 text-left transition-colors ${isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-rose-50'}`}
                                            >
                                                <div className="relative p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-500">
                                                    <Skull size={19} />
                                                    <span className="absolute -top-2 -right-2 min-w-5 h-5 px-1 rounded-full bg-rose-500 text-white text-[9px] font-black flex items-center justify-center">{funeral.accts.length}</span>
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <p className={`text-sm font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>Hromadný pohřeb · {funeral.accts.length} účtů</p>
                                                    <p className="text-[10px] font-bold text-slate-500 truncate">† {fmtDate(first.failureDate)} · {funeral.accts.map(a => a.name).join(', ')}</p>
                                                </div>
                                                <div className="hidden sm:block text-right">
                                                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Spáleno celkem</p>
                                                    <p className="text-sm font-black font-mono text-rose-500">−{fmt(funeral.totalLost)}</p>
                                                </div>
                                                <div className="hidden md:block text-right">
                                                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Ø k cíli</p>
                                                    <p className="text-sm font-black font-mono text-amber-500">{avgProgress}%</p>
                                                </div>
                                                {expanded ? <ChevronDown size={18} className="text-slate-500 shrink-0" /> : <ChevronRight size={18} className="text-slate-500 shrink-0" />}
                                            </button>
                                            <AnimatePresence initial={false}>
                                                {expanded && (
                                                    <motion.div
                                                        initial={{ height: 0, opacity: 0 }}
                                                        animate={{ height: 'auto', opacity: 1 }}
                                                        exit={{ height: 0, opacity: 0 }}
                                                        className="overflow-hidden"
                                                    >
                                                        <div className={`p-4 pt-0 border-t ${isDark ? 'border-white/5' : 'border-rose-100'}`}>
                                                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
                                                                {funeral.accts.map(renderTombstone)}
                                                            </div>
                                                        </div>
                                                    </motion.div>
                                                )}
                                            </AnimatePresence>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* ── Memorial detail modal ── */}
            <AnimatePresence>
                {detailAccount && (
                    <MemorialModal
                        account={detailAccount}
                        stats={statsMap.get(detailAccount.id)!}
                        trades={trades.filter(t => t.accountId === detailAccount.id)}
                        isDark={isDark}
                        onClose={() => setDetailAccount(null)}
                    />
                )}
            </AnimatePresence>

            {/* ── Comparison modal ── */}
            <AnimatePresence>
                {showCompare && selectedAccounts.length >= 2 && (
                    <CompareModal
                        accounts={selectedAccounts}
                        statsMap={statsMap}
                        isDark={isDark}
                        onClose={() => setShowCompare(false)}
                    />
                )}
            </AnimatePresence>

            {/* ── Lessons wall modal ── */}
            <AnimatePresence>
                {showLessons && (
                    <LessonsModal lessons={allLessons} isDark={isDark} onClose={() => setShowLessons(false)} />
                )}
            </AnimatePresence>
        </div>
    );
};

// ── Summary cell ──
const SummaryCell: React.FC<{ label: string; value: string; sub?: string; accent?: 'rose' | 'amber'; isDark: boolean; small?: boolean }> = ({ label, value, sub, accent, isDark, small }) => {
    const color = accent === 'rose' ? 'text-rose-500' : accent === 'amber' ? 'text-amber-500' : (isDark ? 'text-white' : 'text-slate-900');
    return (
        <div className="px-5 py-4">
            <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">{label}</p>
            <p className={`font-black font-mono tracking-tight ${small ? 'text-sm' : 'text-xl'} ${color} ${small ? 'truncate' : ''}`}>{value}</p>
            {sub && <p className="text-[9px] font-bold text-slate-500 mt-0.5">{sub}</p>}
        </div>
    );
};

const TombStat: React.FC<{ label: string; value: string; accent?: 'rose' | 'amber'; isDark: boolean }> = ({ label, value, accent, isDark }) => {
    const color = accent === 'rose' ? 'text-rose-500' : accent === 'amber' ? 'text-amber-500' : (isDark ? 'text-slate-200' : 'text-slate-700');
    return (
        <div>
            <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 mb-0.5">{label}</p>
            <p className={`text-sm font-black font-mono tracking-tighter ${color}`}>{value}</p>
        </div>
    );
};

// ── Memorial modal ──
export const MemorialModal: React.FC<{ account: Account; stats: AccountStats; trades: Trade[]; isDark: boolean; onClose: () => void; onOpenInDashboard?: (id: string) => void }> = ({ account, stats, trades, isDark, onClose, onOpenInDashboard }) => {
    const sorted = useMemo(() => [...trades].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)), [trades]);
    const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
    const isFailed = account.result === 'Failed';
    const isPassed = account.result === 'Passed';
    const HeaderIcon = isFailed ? Skull : isPassed ? Trophy : Archive;
    const label = isFailed ? `Memorial · ${account.type}` : isPassed ? `Splněno · ${account.type}` : `Archiv · ${account.type}`;
    const headerDate = isFailed
        ? `† ${fmtDate(account.failureDate)} · Initial ${fmt(account.initialBalance)}`
        : `Archivovaný účet · Initial ${fmt(account.initialBalance)}`;
    const headerBorder = isFailed ? 'border-rose-500/20' : isPassed ? 'border-emerald-500/20' : 'border-white/10';
    const headerGrad = isFailed ? 'from-rose-500/5' : isPassed ? 'from-emerald-500/5' : 'from-slate-500/5';
    const iconWrap = isFailed ? 'bg-rose-500/10 border-rose-500/30' : isPassed ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-slate-500/10 border-slate-500/30';
    const iconColor = isFailed ? 'text-rose-500' : isPassed ? 'text-emerald-500' : 'text-slate-400';
    const labelColor = isFailed ? 'text-rose-500' : isPassed ? 'text-emerald-500' : 'text-slate-400';
    const selectedTradeIndex = selectedTrade ? sorted.findIndex(t => String(t.id) === String(selectedTrade.id)) : -1;
    const showPreviousTrade = () => {
        if (!sorted.length || selectedTradeIndex < 0) return;
        setSelectedTrade(sorted[(selectedTradeIndex - 1 + sorted.length) % sorted.length]);
    };
    const showNextTrade = () => {
        if (!sorted.length || selectedTradeIndex < 0) return;
        setSelectedTrade(sorted[(selectedTradeIndex + 1) % sorted.length]);
    };
    return (
        <div className="fixed inset-0 z-[320] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md" onClick={onClose}>
            <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 12 }}
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                className={`max-w-3xl w-full max-h-[90vh] overflow-y-auto rounded-[32px] border shadow-2xl ${isDark ? 'bg-slate-900 border-white/10' : 'bg-white border-slate-200'}`}
                onClick={e => e.stopPropagation()}
            >
                {/* header */}
                <div className={`relative p-6 lg:p-8 border-b ${headerBorder} bg-gradient-to-b ${headerGrad} to-transparent`}>
                    <div className="absolute top-4 right-4 flex items-center gap-2">
                        {onOpenInDashboard && (
                            <button onClick={() => onOpenInDashboard(account.id)} className="px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-1.5 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/20 transition-all" title="Otevřít v dashboardu">
                                <BarChart3 size={12} /> Dashboard
                            </button>
                        )}
                        <button onClick={onClose} className={`p-2 rounded-full ${isDark ? 'hover:bg-white/10 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}><X size={18} /></button>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className={`p-3 border rounded-2xl ${iconWrap}`}><HeaderIcon size={26} className={iconColor} /></div>
                        <div>
                            <p className={`text-[9px] font-black uppercase tracking-[0.3em] mb-1 ${labelColor}`}>{label}</p>
                            <h2 className={`text-2xl font-black tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>{account.name}</h2>
                            <p className="text-[11px] font-bold text-slate-500 mt-0.5">{headerDate}</p>
                        </div>
                    </div>
                </div>

                <div className="p-6 lg:p-8 space-y-6">
                    {/* equity curve */}
                    <div>
                        <div className="flex items-center gap-2 mb-3">
                            <BarChart3 size={13} className="text-slate-500" />
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Equity křivka</p>
                        </div>
                        <div className={`rounded-2xl border p-4 ${isDark ? 'bg-slate-800/40 border-white/5' : 'bg-slate-50 border-slate-200'}`}>
                            <EquityCurve data={stats.equityCurve} initial={account.initialBalance} isDark={isDark} />
                        </div>
                    </div>

                    {/* stat grid */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <MStat label="Peak Equity" value={fmt(stats.peakEquity)} icon={Target} color="emerald" isDark={isDark} />
                        <MStat label="Max Drawdown" value={`-${fmt(stats.maxDrawdown)}`} icon={TrendingDown} color="rose" isDark={isDark} />
                        <MStat label="Pokrok k cíli" value={`${stats.progressPct} %`} icon={Target} color="amber" isDark={isDark} />
                        <MStat label="Dní konzistence" value={stats.daysConsistency.toString()} icon={Calendar} color="blue" isDark={isDark} />
                        <MStat label="Win Rate" value={`${stats.winRate} %`} icon={BarChart3} color="emerald" isDark={isDark} />
                        <MStat label="Obchodů" value={stats.totalTrades.toString()} icon={BarChart3} color="blue" isDark={isDark} />
                        <MStat label="Ø R" value={stats.avgR != null ? `${stats.avgR.toFixed(2)}R` : '—'} icon={Scale} color="amber" isDark={isDark} />
                        <MStat label="Nejlepší / Nejhorší" value={`+${fmt(stats.bestTrade)} / -${fmt(stats.worstTrade)}`} icon={Activity} color="emerald" isDark={isDark} small />
                    </div>

                    {/* funeral writeup */}
                    {(account.failureReason || account.failureWhatHappened || account.failureKeyLesson) && (
                        <div className="space-y-3">
                            {account.failureReason && (
                                <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold ${isDark ? 'bg-rose-500/10 text-rose-400' : 'bg-rose-100 text-rose-600'}`}>
                                    <AlertTriangle size={12} /> {account.failureReason}
                                </div>
                            )}
                            {account.failureWhatHappened && (
                                <div className={`p-4 rounded-2xl border ${isDark ? 'bg-slate-800/40 border-white/5' : 'bg-slate-50 border-slate-200'}`}>
                                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Co se stalo</p>
                                    <p className={`text-sm leading-relaxed whitespace-pre-wrap ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{account.failureWhatHappened}</p>
                                </div>
                            )}
                            {account.failureKeyLesson && (
                                <div className={`p-4 rounded-2xl border-2 ${isDark ? 'bg-amber-500/5 border-amber-500/30' : 'bg-amber-50 border-amber-300'}`}>
                                    <p className="text-[10px] font-black uppercase tracking-widest text-amber-500 mb-2"><Lightbulb size={11} className="inline mr-1" /> Klíčová lekce</p>
                                    <p className={`text-sm leading-relaxed font-medium ${isDark ? 'text-amber-100' : 'text-amber-900'}`}>{account.failureKeyLesson}</p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* trades list */}
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3">Obchody ({sorted.length})</p>
                        {sorted.length === 0 ? (
                            <p className="text-xs text-slate-500 italic">Žádné obchody na tomto účtu.</p>
                        ) : (
                            <div className={`rounded-2xl border divide-y overflow-hidden ${isDark ? 'border-white/5 divide-white/5' : 'border-slate-200 divide-slate-100'}`}>
                                {sorted.slice(0, 50).map(t => (
                                    <button
                                        key={t.id}
                                        onClick={() => setSelectedTrade(t)}
                                        className={`w-full flex items-center justify-between px-4 py-2.5 text-left transition-colors ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-50'}`}
                                        title="Otevřít náhled obchodu"
                                    >
                                        <div className="flex items-center gap-3 min-w-0">
                                            <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded ${t.direction === 'Long' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'}`}>{t.direction === 'Long' ? 'L' : 'S'}</span>
                                            <span className={`text-xs font-bold truncate ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{t.instrument || t.symbol || '—'}</span>
                                            <span className="text-[10px] text-slate-500 shrink-0">{t.date}</span>
                                        </div>
                                        <span className="flex items-center gap-2 shrink-0">
                                            <span className={`text-sm font-black font-mono ${(t.pnl || 0) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{(t.pnl || 0) >= 0 ? '+' : '-'}{fmt(t.pnl || 0)}</span>
                                            <ChevronRight size={14} className="text-slate-500" />
                                        </span>
                                    </button>
                                ))}
                                {sorted.length > 50 && (
                                    <div className="px-4 py-2 text-center text-[10px] font-bold text-slate-500">+ {sorted.length - 50} dalších obchodů</div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </motion.div>

            <AnimatePresence>
                {selectedTrade && (
                    <MemorialTradePreview
                        trade={selectedTrade}
                        accountName={account.name}
                        isDark={isDark}
                        tradePosition={selectedTradeIndex + 1}
                        tradeCount={sorted.length}
                        onPreviousTrade={showPreviousTrade}
                        onNextTrade={showNextTrade}
                        onClose={() => setSelectedTrade(null)}
                    />
                )}
            </AnimatePresence>
        </div>
    );
};

const MemorialTradePreview: React.FC<{
    trade: Trade;
    accountName: string;
    isDark: boolean;
    tradePosition: number;
    tradeCount: number;
    onPreviousTrade: () => void;
    onNextTrade: () => void;
    onClose: () => void;
}> = ({ trade, accountName, isDark, tradePosition, tradeCount, onPreviousTrade, onNextTrade, onClose }) => {
    const [fullTrade, setFullTrade] = useState<Trade>(trade);
    const [loadingImages, setLoadingImages] = useState(false);
    const images = fullTrade.screenshots?.length ? fullTrade.screenshots : (fullTrade.screenshot ? [fullTrade.screenshot] : []);
    const [selectedImage, setSelectedImage] = useState(0);
    const directionLong = String(trade.direction).toLowerCase() === 'long';
    const price = (value?: number) => value != null && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
    const dateLabel = (() => {
        const parsed = new Date(trade.date || trade.timestamp);
        return Number.isNaN(parsed.getTime()) ? trade.date : parsed.toLocaleString('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' });
    })();

    const showPreviousImage = () => setSelectedImage(current => (current - 1 + images.length) % images.length);
    const showNextImage = () => setSelectedImage(current => (current + 1) % images.length);

    useEffect(() => {
        let cancelled = false;
        setFullTrade(trade);
        setSelectedImage(0);

        const loadImages = async () => {
            if (!trade.id) return;
            setLoadingImages(true);
            try {
                const detailed = await storageService.getTradeById(String(trade.id));
                if (detailed && !cancelled) {
                    setFullTrade(current => ({
                        ...current,
                        screenshot: detailed.screenshot ?? current.screenshot,
                        screenshots: detailed.screenshots ?? current.screenshots,
                    }));
                }
            } catch (error) {
                console.error('[MemorialTradePreview] Nepodařilo se načíst screenshoty:', error);
            } finally {
                if (!cancelled) setLoadingImages(false);
            }
        };

        loadImages();
        return () => { cancelled = true; };
    }, [trade]);

    useEffect(() => {
        if (tradeCount <= 1) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                onPreviousTrade();
            } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                onNextTrade();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [tradeCount, onPreviousTrade, onNextTrade]);

    return (
        <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[340] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md"
            onClick={onClose}
        >
            <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 10 }}
                className={`relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-[28px] border shadow-2xl ${isDark ? 'bg-slate-900 border-white/10' : 'bg-white border-slate-200'}`}
                onClick={e => e.stopPropagation()}
            >
                <div className="absolute z-20 top-4 right-4 flex items-center gap-2">
                    {tradeCount > 1 && (
                        <>
                            <button onClick={onPreviousTrade} className={`p-2 rounded-full border shadow-lg ${isDark ? 'bg-slate-900/85 hover:bg-white/10 text-slate-200 border-white/10' : 'bg-white/90 hover:bg-slate-100 text-slate-600 border-slate-200'}`} title="Předchozí obchod (←)"><ChevronLeft size={18} /></button>
                            <span className="px-2.5 py-2 rounded-full bg-slate-950/80 border border-white/10 text-[9px] font-black tracking-widest text-white">{tradePosition} / {tradeCount}</span>
                            <button onClick={onNextTrade} className={`p-2 rounded-full border shadow-lg ${isDark ? 'bg-slate-900/85 hover:bg-white/10 text-slate-200 border-white/10' : 'bg-white/90 hover:bg-slate-100 text-slate-600 border-slate-200'}`} title="Další obchod (→)"><ChevronRight size={18} /></button>
                        </>
                    )}
                    <button onClick={onClose} className={`p-2 rounded-full border shadow-lg ${isDark ? 'bg-slate-900/85 hover:bg-white/10 text-slate-300 border-white/10' : 'bg-white/90 hover:bg-slate-100 text-slate-500 border-slate-200'}`}><X size={18} /></button>
                </div>

                {loadingImages && images.length === 0 ? (
                    <div className={`h-44 flex flex-col items-center justify-center border-b ${isDark ? 'bg-slate-800/40 border-white/5 text-slate-500' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>
                        <div className="w-6 h-6 mb-3 rounded-full border-2 border-slate-500/30 border-t-blue-500 animate-spin" />
                        <p className="text-xs font-bold">Načítám screenshoty…</p>
                    </div>
                ) : images.length > 0 ? (
                    <div className="relative p-3">
                        <img src={images[selectedImage]} alt={`Screenshot obchodu ${selectedImage + 1}`} className="block w-full max-h-[58vh] object-contain rounded-2xl" />
                        {images.length > 1 && (
                            <>
                                <button
                                    onClick={showPreviousImage}
                                    className="absolute left-6 top-1/2 -translate-y-1/2 p-3 rounded-full bg-slate-950/75 hover:bg-slate-950 text-white border border-white/15 shadow-xl transition-all active:scale-95"
                                    aria-label="Předchozí screenshot"
                                >
                                    <ChevronLeft size={22} />
                                </button>
                                <button
                                    onClick={showNextImage}
                                    className="absolute right-6 top-1/2 -translate-y-1/2 p-3 rounded-full bg-slate-950/75 hover:bg-slate-950 text-white border border-white/15 shadow-xl transition-all active:scale-95"
                                    aria-label="Další screenshot"
                                >
                                    <ChevronRight size={22} />
                                </button>
                                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-slate-950/80 border border-white/10 text-[10px] font-black tracking-widest text-white">
                                    {selectedImage + 1} / {images.length}
                                </div>
                            </>
                        )}
                    </div>
                ) : (
                    <div className={`h-44 flex flex-col items-center justify-center border-b ${isDark ? 'bg-slate-800/40 border-white/5 text-slate-500' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>
                        <BarChart3 size={30} className="mb-2 opacity-40" />
                        <p className="text-xs font-bold">K tomuto obchodu není uložený screenshot</p>
                    </div>
                )}

                <div className="p-5 lg:p-6 space-y-5">
                    <div className="flex items-start gap-3 pr-10">
                        <span className={`mt-0.5 text-[10px] font-black uppercase px-2 py-1 rounded-lg ${directionLong ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'}`}>{directionLong ? 'LONG' : 'SHORT'}</span>
                        <div className="min-w-0 flex-1">
                            <h3 className={`text-xl font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{trade.instrument || trade.symbol || 'Obchod'}</h3>
                            <p className="text-[11px] font-bold text-slate-500">{accountName} · {dateLabel}</p>
                        </div>
                        <p className={`text-xl font-black font-mono ${(trade.pnl || 0) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{(trade.pnl || 0) >= 0 ? '+' : '-'}{fmt(trade.pnl || 0)}</p>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        <PreviewStat label="Entry" value={price(trade.entryPrice)} isDark={isDark} />
                        <PreviewStat label="Exit" value={price(trade.exitPrice)} isDark={isDark} />
                        <PreviewStat label="Stop-loss" value={price(trade.stopLoss)} accent="rose" isDark={isDark} />
                        <PreviewStat label="Take-profit" value={price(trade.takeProfit)} accent="emerald" isDark={isDark} />
                        <PreviewStat label="Pozice" value={trade.positionSize != null ? String(trade.positionSize) : '—'} isDark={isDark} />
                    </div>

                    {trade.notes && (
                        <div className={`p-4 rounded-2xl border ${isDark ? 'bg-slate-800/40 border-white/5' : 'bg-slate-50 border-slate-200'}`}>
                            <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-2">Poznámka</p>
                            <p className={`text-sm leading-relaxed whitespace-pre-wrap ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{trade.notes}</p>
                        </div>
                    )}
                </div>
            </motion.div>
        </motion.div>
    );
};

const PreviewStat: React.FC<{ label: string; value: string; isDark: boolean; accent?: 'rose' | 'emerald' }> = ({ label, value, isDark, accent }) => (
    <div className={`p-3 rounded-xl border ${isDark ? 'bg-slate-800/40 border-white/5' : 'bg-slate-50 border-slate-200'}`}>
        <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 mb-1">{label}</p>
        <p className={`text-sm font-black font-mono ${accent === 'rose' ? 'text-rose-500' : accent === 'emerald' ? 'text-emerald-500' : isDark ? 'text-slate-200' : 'text-slate-800'}`}>{value}</p>
    </div>
);

const MStat: React.FC<{ label: string; value: string; icon: any; color: 'emerald' | 'rose' | 'amber' | 'blue'; isDark: boolean; small?: boolean }> = ({ label, value, icon: Icon, color, isDark, small }) => {
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
                <p className="text-[9px] font-black uppercase tracking-widest opacity-70 truncate">{label}</p>
            </div>
            <p className={`${small ? 'text-xs' : 'text-lg'} font-black font-mono tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>{value}</p>
        </div>
    );
};

// ── Compare modal ──
const CompareModal: React.FC<{ accounts: Account[]; statsMap: Map<string, AccountStats>; isDark: boolean; onClose: () => void }> = ({ accounts, statsMap, isDark, onClose }) => {
    const agg = useMemo(() => {
        let totalLost = 0, totalDays = 0, progressSum = 0, progressCount = 0, totalTrades = 0;
        const reasonCount: Record<string, number> = {};
        accounts.forEach(a => {
            const s = statsMap.get(a.id)!;
            totalLost += s.amountLost;
            totalDays += s.daysConsistency;
            totalTrades += s.totalTrades;
            if (typeof s.progressPct === 'number') { progressSum += s.progressPct; progressCount++; }
            const r = a.failureReason || 'Neuvedeno';
            reasonCount[r] = (reasonCount[r] || 0) + 1;
        });
        const reasons = Object.entries(reasonCount).sort((a, b) => b[1] - a[1]);
        return {
            totalLost, totalDays, totalTrades,
            avgProgress: progressCount > 0 ? Math.round(progressSum / progressCount) : 0,
            reasons,
        };
    }, [accounts, statsMap]);

    return (
        <div className="fixed inset-0 z-[330] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md" onClick={onClose}>
            <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 12 }}
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                className={`max-w-4xl w-full max-h-[90vh] overflow-y-auto rounded-[32px] border shadow-2xl ${isDark ? 'bg-slate-900 border-white/10' : 'bg-white border-slate-200'}`}
                onClick={e => e.stopPropagation()}
            >
                <div className="relative p-6 lg:p-8 border-b border-blue-500/20 bg-gradient-to-b from-blue-500/5 to-transparent">
                    <button onClick={onClose} className={`absolute top-4 right-4 p-2 rounded-full ${isDark ? 'hover:bg-white/10 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}><X size={18} /></button>
                    <div className="flex items-center gap-4">
                        <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-2xl"><Scale size={24} className="text-blue-500" /></div>
                        <div>
                            <p className="text-[9px] font-black uppercase tracking-[0.3em] text-blue-500 mb-1">Porovnání · {accounts.length} účtů</p>
                            <h2 className={`text-2xl font-black tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>Co mají společného?</h2>
                        </div>
                    </div>
                </div>

                <div className="p-6 lg:p-8 space-y-6">
                    {/* aggregate */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <MStat label="Celkem spáleno" value={`-${fmt(agg.totalLost)}`} icon={TrendingDown} color="rose" isDark={isDark} />
                        <MStat label="Ø k cíli" value={`${agg.avgProgress} %`} icon={Target} color="amber" isDark={isDark} />
                        <MStat label="Dní disciplíny" value={agg.totalDays.toString()} icon={Calendar} color="blue" isDark={isDark} />
                        <MStat label="Obchodů celkem" value={agg.totalTrades.toString()} icon={BarChart3} color="emerald" isDark={isDark} />
                    </div>

                    {/* recurring patterns */}
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3">Opakující se příčiny</p>
                        <div className="space-y-2">
                            {agg.reasons.map(([reason, count]) => (
                                <div key={reason} className={`flex items-center gap-3 p-3 rounded-xl border ${isDark ? 'bg-slate-800/40 border-white/5' : 'bg-slate-50 border-slate-200'}`}>
                                    <div className="flex-1">
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className={`text-xs font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{reason}</span>
                                            <span className="text-[10px] font-black text-rose-500">{count}× ({Math.round((count / accounts.length) * 100)} %)</span>
                                        </div>
                                        <div className={`h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-white/5' : 'bg-slate-200'}`}>
                                            <div className="h-full bg-rose-500" style={{ width: `${(count / accounts.length) * 100}%` }} />
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {agg.reasons.length === 1 && agg.reasons[0][1] === accounts.length && (
                            <p className={`mt-3 p-3 rounded-xl text-xs font-bold text-center ${isDark ? 'bg-rose-500/10 text-rose-400' : 'bg-rose-100 text-rose-600'}`}>
                                ⚠️ Všechny vybrané účty spáleny stejnou příčinou: <strong>{agg.reasons[0][0]}</strong>
                            </p>
                        )}
                    </div>

                    {/* per-account row */}
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3">Vybrané účty</p>
                        <div className={`rounded-2xl border divide-y overflow-hidden ${isDark ? 'border-white/5 divide-white/5' : 'border-slate-200 divide-slate-100'}`}>
                            {accounts.map(a => {
                                const s = statsMap.get(a.id)!;
                                return (
                                    <div key={a.id} className={`grid grid-cols-4 gap-2 px-4 py-3 items-center ${isDark ? '' : ''}`}>
                                        <span className={`text-xs font-black truncate ${isDark ? 'text-white' : 'text-slate-900'}`}>{a.name}</span>
                                        <span className="text-xs font-mono font-bold text-rose-500 text-right">-{fmt(s.amountLost)}</span>
                                        <span className="text-xs font-mono font-bold text-amber-500 text-right">{s.progressPct}%</span>
                                        <span className="text-xs font-mono font-bold text-slate-500 text-right">{s.daysConsistency} dní</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* lessons of selected */}
                    {accounts.some(a => a.failureKeyLesson) && (
                        <div>
                            <p className="text-[10px] font-black uppercase tracking-widest text-amber-500 mb-3"><Lightbulb size={11} className="inline mr-1" /> Lekce z těchto účtů</p>
                            <div className="space-y-2">
                                {accounts.filter(a => a.failureKeyLesson).map(a => (
                                    <div key={a.id} className={`p-3 rounded-xl border ${isDark ? 'bg-amber-500/5 border-amber-500/20' : 'bg-amber-50 border-amber-200'}`}>
                                        <p className="text-[10px] font-black text-amber-500 mb-1">{a.name}</p>
                                        <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{a.failureKeyLesson}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </motion.div>
        </div>
    );
};

// ── Lessons wall modal ──
const LessonsModal: React.FC<{ lessons: { id: string; name: string; date?: string; reason?: string; lesson: string }[]; isDark: boolean; onClose: () => void }> = ({ lessons, isDark, onClose }) => {
    return (
        <div className="fixed inset-0 z-[330] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md" onClick={onClose}>
            <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 12 }}
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                className={`max-w-2xl w-full max-h-[90vh] overflow-y-auto rounded-[32px] border shadow-2xl ${isDark ? 'bg-slate-900 border-white/10' : 'bg-white border-slate-200'}`}
                onClick={e => e.stopPropagation()}
            >
                <div className="relative p-6 lg:p-8 border-b border-amber-500/20 bg-gradient-to-b from-amber-500/5 to-transparent">
                    <button onClick={onClose} className={`absolute top-4 right-4 p-2 rounded-full ${isDark ? 'hover:bg-white/10 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}><X size={18} /></button>
                    <div className="flex items-center gap-4">
                        <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl"><BookOpen size={24} className="text-amber-500" /></div>
                        <div>
                            <p className="text-[9px] font-black uppercase tracking-[0.3em] text-amber-500 mb-1">Zeď lekcí</p>
                            <h2 className={`text-2xl font-black tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>Co tě to stálo naučit</h2>
                        </div>
                    </div>
                </div>
                <div className="p-6 lg:p-8 space-y-3">
                    {lessons.map(l => (
                        <div key={l.id} className={`p-4 rounded-2xl border-l-4 border-amber-500 border-y border-r ${isDark ? 'bg-amber-500/5 border-y-white/5 border-r-white/5' : 'bg-amber-50/60 border-y-slate-200 border-r-slate-200'}`}>
                            <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
                                <span className={`text-xs font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{l.name}</span>
                                <span className="text-[10px] font-bold text-slate-500">{fmtDate(l.date)}{l.reason ? ` · ${l.reason}` : ''}</span>
                            </div>
                            <p className={`text-sm leading-relaxed font-medium ${isDark ? 'text-amber-100' : 'text-amber-900'}`}>
                                <Lightbulb size={13} className="inline mr-1.5 text-amber-500" />{l.lesson}
                            </p>
                        </div>
                    ))}
                </div>
            </motion.div>
        </div>
    );
};

export default Graveyard;
