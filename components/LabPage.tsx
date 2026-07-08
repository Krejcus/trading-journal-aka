/**
 * LabPage — analytická laboratoř nad obchody.
 *
 * Fáze 1: Přehled · Na stole (counterfactual SL×řízení) · Bias · Obchody.
 * Všechna čísla počítá services/labAnalytics.ts (deterministický TS, žádné AI).
 *
 * Datová poctivost: counterfactual/excursion sbírá AlphaBridge — u manuálních
 * a importovaných obchodů chybí. UI vždy ukazuje pokrytí („X z Y obchodů").
 */
import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    FlaskConical, Table2, Compass, Scale, ChevronRight, Sparkles, Database,
    Droplets, TrendingDown, TrendingUp, Minus, AlertTriangle, Brain,
    TestTubes, Plus, Trash2, CheckCircle2, XCircle,
} from 'lucide-react';
import { Trade, Account, DailyPrep, DailyReview, LabExperiment } from '../types';
import {
    buildLabDataset, computeOverview, computeCfSummary, computeBiasSummary, computeSessionRows,
    buildTrailInsight, buildLeftInsight, buildBiasInsight,
    detectLeaks, buildLeakCoachPrompt,
    computePsychoSummary, buildPsychoCoachPrompt,
    computeExperimentReport, buildExperimentCoachPrompt,
    fmtR, fmtUsd, usdPlain, fmtVal, fmtDayTime,
    prepBiasFromPreps, prepDaysFromPreps,
    LabUnit, LabDataset, LeakFinding, SL_LABELS,
} from '../services/labAnalytics';

interface LabPageProps {
    trades: Trade[];
    accounts: Account[];
    theme: 'dark' | 'light' | 'oled';
    dashboardMode?: string;
    preps: DailyPrep[];
    reviews: DailyReview[];
    /** Lab experimenty (persistované v UserPreferences). */
    experiments: LabExperiment[];
    onUpdateExperiments: (next: LabExperiment[]) => void;
    /** Otevře AI Coach s předpřipraveným promptem (čísla už dosazená — AI je nepočítá). */
    onAskAI?: (prompt: string) => void;
    /** Otevře TradeDetailModal pro konkrétní obchod. */
    onOpenTrade?: (trade: Trade) => void;
}

type LabTab = 'prehled' | 'stole' | 'bias' | 'leaky' | 'psycho' | 'experimenty' | 'obchody';

interface ExperimentDraft { title: string; hypothesis: string; rule: string; targetTrades: string; sourceLeakId?: string }
const EMPTY_DRAFT: ExperimentDraft = { title: '', hypothesis: '', rule: '', targetTrades: '20' };

const LEAK_CATEGORY_LABEL: Record<LeakFinding['category'], string> = {
    behavior: 'Chování', timing: 'Timing', bias: 'Bias', risk: 'Risk', priprava: 'Příprava',
};
const CONF_LABEL = { high: 'vysoká', medium: 'střední', low: 'nízká' } as const;
const TREND_LABEL = { worsening: 'zhoršuje se', improving: 'zlepšuje se', stable: 'stabilní', new: 'nový' } as const;

const rCol = (v: number | null | undefined) =>
    v == null ? 'text-slate-400' : v > 0.0001 ? 'text-emerald-500' : v < -0.0001 ? 'text-rose-500' : 'text-slate-400';

const LabPage: React.FC<LabPageProps> = ({ trades, accounts, theme, dashboardMode, preps, reviews, experiments, onUpdateExperiments, onAskAI, onOpenTrade }) => {
    const isDark = theme !== 'light';
    const world = dashboardMode === 'backtesting' ? 'backtest' as const : 'live' as const;

    const [tab, setTab] = useState<LabTab>('prehled');
    const [accountSel, setAccountSel] = useState<string>('all');
    const [unit, setUnit] = useState<LabUnit>('$');
    const [showTrail, setShowTrail] = useState(true);

    // Obchody tab
    const [filters, setFilters] = useState({ session: 'all', dir: 'all', outcome: 'all', bias: 'all' });
    const [expanded, setExpanded] = useState<string | number | null>(null);

    // Experimenty tab
    const [draft, setDraft] = useState<ExperimentDraft | null>(null);

    // Přepnutí světa (live ↔ backtest): vybraný účet z minulého světa neexistuje
    // v novém → reset na „vše", jinak by dataset spadl na 0 obchodů.
    useEffect(() => {
        setAccountSel('all');
        setFilters({ session: 'all', dir: 'all', outcome: 'all', bias: 'all' });
        setExpanded(null);
        setDraft(null);
    }, [world]);

    const isUsd = unit === '$';
    const cardCls = isDark ? 'bg-white/[0.03] border-white/5' : 'bg-white border-slate-200';
    const eyebrow = 'text-[9px] font-black uppercase tracking-[0.2em] text-slate-500';
    const bigMono = 'font-mono font-black tracking-tighter tabular-nums';

    const worldAccounts = useMemo(
        () => accounts.filter(a => world === 'backtest' ? a.type === 'Backtest' : a.type !== 'Backtest'),
        [accounts, world]
    );

    // Live: bias per den z ranního prepu (denní market bias + per-session karty).
    // Backtest má bias zapsaný přímo u obchodů (AlphaBridge), prep se nepoužije.
    const prepBias = useMemo(
        () => world === 'live' ? prepBiasFromPreps(preps) : undefined,
        [world, preps]
    );

    const ds: LabDataset = useMemo(
        () => buildLabDataset(trades, accounts, { world, accountIds: accountSel === 'all' ? undefined : [accountSel], prepBias }),
        [trades, accounts, world, accountSel, prepBias]
    );
    // Experimenty se VŽDY měří proti celému světu (ne proti přechodnému UI filtru
    // účtu) — jinak by dropdown měnil before/after čísla i verdikt běžícího experimentu.
    const dsWorld: LabDataset = useMemo(
        () => accountSel === 'all' ? ds : buildLabDataset(trades, accounts, { world, prepBias }),
        [ds, trades, accounts, world, accountSel, prepBias]
    );

    const overview = useMemo(() => computeOverview(ds), [ds]);
    const cf = useMemo(() => computeCfSummary(ds), [ds]);
    const bias = useMemo(() => computeBiasSummary(ds), [ds]);
    const sessions = useMemo(() => computeSessionRows(ds), [ds]);
    const leaks = useMemo(
        () => detectLeaks(ds, world === 'live' ? prepDaysFromPreps(preps) : undefined),
        [ds, world, preps]
    );
    const psycho = useMemo(
        // Prep/review korelace jen v live světě — backtest dny nemají deník.
        () => computePsychoSummary(ds, world === 'live' ? preps : [], world === 'live' ? reviews : []),
        [ds, world, preps, reviews]
    );

    // ── Na stole: bar chart data ────────────────────────────────────────────
    const barRows = useMemo(() => {
        const rows = [cf.real, ...cf.variants.filter(v => showTrail || !v.isTrail)]
            .filter(v => v.isReal || v.n > 0);
        const maxVal = Math.max(...rows.map(v => isUsd ? v.usd : v.r), 1);
        return rows.map(v => {
            const val = isUsd ? v.usd : v.r;
            const isBest = cf.bestFixed != null && v.key === cf.bestFixed.key;
            return {
                v, isBest,
                pct: Math.max(2.5, (Math.max(0, val) / maxVal) * 100),
                valStr: isUsd ? usdPlain(v.usd) : fmtR(v.r),
                fill: v.isReal
                    ? 'linear-gradient(90deg,#0891b2,#22d3ee)'
                    : isBest ? 'linear-gradient(90deg,#059669,#10b981)'
                        : v.isTrail ? 'rgba(100,116,139,.3)' : 'rgba(59,130,246,.35)',
                valCls: v.isReal ? 'text-cyan-500' : isBest ? 'text-emerald-500' : (isDark ? 'text-slate-300' : 'text-slate-600'),
            };
        });
    }, [cf, isUsd, showTrail, isDark]);

    const trailInsight = useMemo(() => buildTrailInsight(cf), [cf]);
    const leftInsight = useMemo(() => buildLeftInsight(cf), [cf]);
    const biasInsight = useMemo(() => buildBiasInsight(bias), [bias]);

    // ── Obchody tab: filtrace ───────────────────────────────────────────────
    const sessionOptions = useMemo(() => {
        const s = new Set<string>();
        ds.trades.forEach(t => s.add(t.session || 'Bez session'));
        return Array.from(s);
    }, [ds]);

    const visibleRows = useMemo(() => ds.trades.filter(t =>
        (filters.session === 'all' || (t.session || 'Bez session') === filters.session) &&
        (filters.dir === 'all' || t.direction === filters.dir) &&
        (filters.outcome === 'all' || t.outcome === filters.outcome) &&
        (filters.bias === 'all'
            || (filters.bias === 'aligned' && t.biasAligned === true)
            || (filters.bias === 'against' && t.biasAligned === false)
            || (filters.bias === 'neutral' && t.biasAligned == null))
    ).slice().reverse(), [ds, filters]);

    // ── Tabs ────────────────────────────────────────────────────────────────
    const tabs: Array<{ key: LabTab; label: string; sub: string; icon: React.ElementType }> = [
        { key: 'prehled', label: 'Přehled', sub: 'souhrn & statistiky', icon: Compass },
        { key: 'stole', label: 'Na stole', sub: 'co kdyby — SL & TP', icon: Scale },
        { key: 'bias', label: 'Bias', sub: 'směr vs. výsledek', icon: FlaskConical },
        { key: 'leaky', label: 'Leaky', sub: `${leaks.length} detektorů zabralo`, icon: Droplets },
        { key: 'psycho', label: 'Psychologie', sub: 'emoce & rituály v číslech', icon: Brain },
        { key: 'experimenty', label: 'Experimenty', sub: `${experiments.filter(e => e.world === world && e.status === 'running').length} běží`, icon: TestTubes },
        { key: 'obchody', label: 'Obchody', sub: `${ds.trades.length} záznamů`, icon: Table2 },
    ];

    const worldExperiments = experiments
        .filter(e => e.world === world)
        .slice()
        .sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.createdAt - a.createdAt);

    const startExperimentFromLeak = (f: LeakFinding) => {
        setDraft({
            title: f.title,
            hypothesis: `Když tenhle pattern utnu, výsledek na obchod se zlepší (teď: ${f.statLine}).`,
            rule: '',
            targetTrades: '20',
            sourceLeakId: f.id,
        });
        setTab('experimenty');
    };

    const saveDraft = () => {
        if (!draft || !draft.title.trim() || !draft.rule.trim()) return;
        const target = Math.max(5, parseInt(draft.targetTrades, 10) || 20);
        onUpdateExperiments([
            ...experiments,
            {
                id: `exp_${Date.now()}`,
                createdAt: Date.now(),
                world,
                title: draft.title.trim(),
                hypothesis: draft.hypothesis.trim(),
                rule: draft.rule.trim(),
                sourceLeakId: draft.sourceLeakId,
                targetTrades: target,
                startTs: Date.now(),
                status: 'running',
            },
        ]);
        setDraft(null);
    };

    // ── Empty state (žádné obchody ve světě) ────────────────────────────────
    if (ds.trades.length === 0) {
        return (
            <div className={`p-10 rounded-3xl border text-center ${cardCls}`}>
                <FlaskConical size={32} className="text-slate-400 mx-auto mb-3" />
                <h3 className={`text-base font-black uppercase tracking-tight mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                    Zatím žádná data pro Lab
                </h3>
                <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                    {world === 'backtest'
                        ? 'V backtest světě nejsou žádné obchody. Zapiš obchody do backtest session a Lab je rozebere.'
                        : 'Na live účtech nejsou žádné obchody k analýze.'}
                </p>
            </div>
        );
    }

    // POZOR: nad tímhle bodem (early return výše) už nesmí být žádný hook —
    // všechny useMemo/useEffect jsou proto definované PŘED empty-state returnem.

    // ── Hero KPI strip ──────────────────────────────────────────────────────
    const heroCells: Array<{ label: string; val: string; sub: string; col: string }> = [
        {
            label: 'Čistý P&L', val: usdPlain(overview.pnl),
            sub: overview.totalR != null ? `${fmtR(overview.totalR)} celkem` : 'R nedostupné (chybí risk)',
            col: rCol(overview.pnl),
        },
        {
            label: 'Win rate', val: `${Math.round(overview.winRate)}%`,
            sub: `${overview.wins} W · ${overview.losses} L${overview.be ? ` · ${overview.be} BE` : ''}`,
            col: isDark ? 'text-white' : 'text-slate-900',
        },
        {
            label: 'Profit factor', val: overview.profitFactor != null ? overview.profitFactor.toFixed(2) : '∞',
            sub: 'hrubý zisk / ztráta',
            col: (overview.profitFactor ?? 99) >= 1.5 ? 'text-emerald-500' : (isDark ? 'text-white' : 'text-slate-900'),
        },
        {
            label: 'Na stole', val: cf.deltaR != null ? (isUsd ? fmtUsd(cf.deltaUsd) : fmtR(cf.deltaR)) : '—',
            sub: cf.bestFixed ? `vs. ${cf.bestFixed.label} · ${cf.bestFixed.sub}` : 'bez counterfactual dat',
            col: 'text-amber-500',
        },
    ];

    const setFilter = (key: keyof typeof filters, val: string) => {
        setFilters(f => ({ ...f, [key]: val }));
        setExpanded(null);
    };

    const filterGroups: Array<{ label: string; key: keyof typeof filters; opts: Array<[string, string]> }> = [
        { label: 'Session', key: 'session', opts: [['all', 'Vše'], ...sessionOptions.map(s => [s, s] as [string, string])] },
        { label: 'Směr', key: 'dir', opts: [['all', 'Vše'], ['Long', 'Long'], ['Short', 'Short']] },
        { label: 'Výsledek', key: 'outcome', opts: [['all', 'Vše'], ['Win', 'Win'], ['Loss', 'Loss'], ['BE', 'BE']] },
        { label: 'Bias', key: 'bias', opts: [['all', 'Vše'], ['aligned', 'Ve směru'], ['against', 'Proti'], ['neutral', 'Bez']] },
    ];

    // ── Pomocné UI kusy ─────────────────────────────────────────────────────
    const coverageChip = (label: string, covered: number, total: number) => (
        <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[9px] font-black uppercase tracking-widest ${
                covered === 0
                    ? 'border-rose-500/30 text-rose-500 bg-rose-500/5'
                    : covered < total
                        ? 'border-amber-500/30 text-amber-500 bg-amber-500/5'
                        : 'border-emerald-500/30 text-emerald-500 bg-emerald-500/5'
            }`}
            title={`${label}: data existují u ${covered} z ${total} obchodů`}
        >
            <Database size={9} /> {label} {covered}/{total}
        </span>
    );

    const askCoachButton = (prompt: string) => onAskAI ? (
        <button
            onClick={() => onAskAI(prompt)}
            className={`mt-3 px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${
                isDark ? 'bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25' : 'bg-cyan-500 text-white hover:bg-cyan-600'
            }`}
        >
            <Sparkles size={10} strokeWidth={2.5} /> Probrat s coachem
        </button>
    ) : null;

    const fadeIn = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] as any } };

    return (
        <div className="space-y-5">
            {/* ── Ovládací řádek: účet · jednotky · pokrytí ── */}
            <div className="flex items-center gap-3 flex-wrap">
                <select
                    value={accountSel}
                    onChange={e => setAccountSel(e.target.value)}
                    className={`px-3 py-2 rounded-xl border text-[11px] font-bold outline-none ${
                        isDark ? 'bg-white/5 border-white/10 text-slate-200' : 'bg-white border-slate-200 text-slate-700'
                    }`}
                >
                    <option value="all">{world === 'backtest' ? 'Všechny sessions' : 'Všechny účty'}</option>
                    {worldAccounts.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
                </select>

                <div className={`flex rounded-xl border overflow-hidden ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
                    {(['$', 'R'] as LabUnit[]).map(u => (
                        <button
                            key={u}
                            onClick={() => setUnit(u)}
                            className={`px-3.5 py-2 text-[11px] font-black transition-all ${
                                unit === u
                                    ? 'bg-cyan-500/20 text-cyan-500'
                                    : isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'
                            }`}
                        >
                            {u}
                        </button>
                    ))}
                </div>

                <div className="flex items-center gap-2 flex-wrap ml-auto">
                    {coverageChip('Counterfactual', ds.coverage.withCf, ds.coverage.total)}
                    {coverageChip('Excursion', ds.coverage.withExc, ds.coverage.total)}
                    {coverageChip('Bias', ds.coverage.withBias, ds.coverage.total)}
                </div>
            </div>

            {/* ── Hero KPI strip ── */}
            <div className={`grid grid-cols-2 md:grid-cols-4 gap-px rounded-3xl overflow-hidden border ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-200 border-slate-200'}`}>
                {heroCells.map(c => (
                    <div key={c.label} className={isDark ? 'bg-[#0a0f1d] p-5' : 'bg-white p-5'}>
                        <p className={eyebrow}>{c.label}</p>
                        <p className={`${bigMono} text-2xl md:text-[26px] mt-2 ${c.col}`}>{c.val}</p>
                        <p className="text-[10px] text-slate-500 mt-1.5">{c.sub}</p>
                    </div>
                ))}
            </div>

            {/* ── Tab pills ── */}
            <div className="flex gap-2 flex-wrap">
                {tabs.map(tb => {
                    const active = tab === tb.key;
                    const Icon = tb.icon;
                    return (
                        <button
                            key={tb.key}
                            onClick={() => setTab(tb.key)}
                            className={`text-left rounded-2xl px-4 py-2.5 border transition-all duration-200 ${
                                active
                                    ? 'bg-gradient-to-br from-cyan-500/15 to-indigo-500/10 border-cyan-500/40 shadow-[0_0_20px_rgba(34,211,238,0.12)]'
                                    : isDark ? 'bg-white/[0.03] border-white/5 hover:border-white/15' : 'bg-white border-slate-200 hover:border-slate-300'
                            }`}
                        >
                            <p className={`text-[10px] font-black uppercase tracking-[0.18em] flex items-center gap-1.5 ${active ? (isDark ? 'text-white' : 'text-slate-900') : 'text-slate-400'}`}>
                                <Icon size={11} /> {tb.label}
                            </p>
                            <p className="text-[10px] text-slate-500 mt-0.5">{tb.sub}</p>
                        </button>
                    );
                })}
            </div>

            {/* ══════════ PŘEHLED ══════════ */}
            {tab === 'prehled' && (
                <motion.div {...fadeIn} className="space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
                        {[
                            { label: 'Celkové R', val: overview.totalR != null ? fmtR(overview.totalR) : '—', sub: `${overview.rCovered} z ${overview.n} obchodů s riskem`, col: rCol(overview.totalR) },
                            { label: 'Čistý P&L', val: usdPlain(overview.pnl), sub: `${overview.n} obchodů`, col: rCol(overview.pnl) },
                            { label: 'Ø výhra', val: overview.avgWinR != null ? fmtR(overview.avgWinR) : '—', sub: `${overview.wins} vítězných`, col: 'text-emerald-500' },
                            { label: 'Ø ztráta', val: overview.avgLossR != null ? fmtR(overview.avgLossR) : '—', sub: `${overview.losses} ztrátových`, col: 'text-rose-500' },
                            { label: 'Win rate', val: `${Math.round(overview.winRate)}%`, sub: `${overview.wins} W · ${overview.losses} L${overview.be ? ` · ${overview.be} BE` : ''}`, col: isDark ? 'text-white' : 'text-slate-900' },
                            { label: 'Profit factor', val: overview.profitFactor != null ? overview.profitFactor.toFixed(2) : '∞', sub: 'zisk / ztráta ($)', col: (overview.profitFactor ?? 99) >= 1.5 ? 'text-emerald-500' : (isDark ? 'text-white' : 'text-slate-900') },
                            { label: 'Nejlepší obchod', val: overview.bestTrade ? (overview.bestTrade.r != null ? fmtR(overview.bestTrade.r) : fmtUsd(overview.bestTrade.pnl)) : '—', sub: overview.bestTrade ? `${fmtDayTime(overview.bestTrade.date)} · ${overview.bestTrade.session || '—'}` : '', col: 'text-emerald-500' },
                            { label: 'Na stole', val: cf.deltaR != null ? fmtR(cf.deltaR) : '—', sub: cf.bestFixed ? `${cf.bestFixed.label} · ${cf.bestFixed.sub}` : 'bez CF dat', col: 'text-amber-500' },
                        ].map(k => (
                            <div key={k.label} className={`p-4 rounded-2xl border ${cardCls}`}>
                                <p className={eyebrow}>{k.label}</p>
                                <p className={`${bigMono} text-xl mt-2 ${k.col}`}>{k.val}</p>
                                <p className="text-[10px] text-slate-500 mt-1">{k.sub}</p>
                            </div>
                        ))}
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
                        {/* Podle session */}
                        <div className={`p-5 rounded-2xl border ${cardCls}`}>
                            <p className={`${eyebrow} mb-3`}>Podle session</p>
                            {(() => {
                                const maxAbs = Math.max(...sessions.map(x => Math.abs(x.r ?? 0)), 0.001);
                                return sessions.map(s => {
                                const val = s.r ?? 0;
                                return (
                                    <div key={s.name} className={`flex items-center gap-3 py-2.5 border-t ${isDark ? 'border-white/5' : 'border-slate-100'}`}>
                                        <span className={`w-24 text-xs font-bold truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{s.name}</span>
                                        <div className={`flex-1 h-2 rounded-full overflow-hidden ${isDark ? 'bg-white/5' : 'bg-slate-100'}`}>
                                            <div
                                                className="h-full rounded-full transition-all duration-500"
                                                style={{
                                                    width: `${Math.max(3, Math.abs(val) / maxAbs * 100)}%`,
                                                    background: val >= 0 ? 'linear-gradient(90deg,#0891b2,#22d3ee)' : '#f43f5e',
                                                }}
                                            />
                                        </div>
                                        <span className={`w-20 text-right text-xs font-mono font-black ${rCol(s.r ?? s.usd)}`}>
                                            {isUsd ? usdPlain(s.usd) : (s.r != null ? fmtR(s.r) : '—')}
                                        </span>
                                        <span className="w-16 text-right text-[10px] font-mono text-slate-500">{s.n}t · {Math.round(s.winRate)}%</span>
                                    </div>
                                );
                                });
                            })()}
                        </div>

                        {/* Teasery na další taby */}
                        <div className="grid grid-rows-2 gap-3.5">
                            <button
                                onClick={() => setTab('stole')}
                                className="text-left rounded-2xl p-5 border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 to-transparent hover:border-emerald-500/50 transition-all"
                            >
                                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-500">Necháváš peníze na stole?</p>
                                <p className={`text-sm mt-2 leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                                    {cf.bestFixed
                                        ? <>Nejlepší varianta SL by přinesla <b className={isDark ? 'text-white' : 'text-slate-900'}>{fmtVal(unit, cf.bestFixed.r, cf.bestFixed.usd)}</b> místo tvých <b className={isDark ? 'text-white' : 'text-slate-900'}>{fmtVal(unit, cf.real.r, cf.real.usd)}</b> <ChevronRight size={12} className="inline" /></>
                                        : 'Counterfactual data zatím chybí — sbírá je AlphaBridge při zápisu obchodu.'}
                                </p>
                            </button>
                            <button
                                onClick={() => setTab('bias')}
                                className="text-left rounded-2xl p-5 border border-cyan-500/25 bg-gradient-to-br from-cyan-500/10 to-transparent hover:border-cyan-500/50 transition-all"
                            >
                                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-500">Pomáhá ti bias?</p>
                                <p className={`text-sm mt-2 leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                                    {bias.alignedSharePct != null
                                        ? <>Obchody ve směru biasu udělaly <b className={isDark ? 'text-white' : 'text-slate-900'}>{bias.alignedSharePct} %</b> celkového výsledku <ChevronRight size={12} className="inline" /></>
                                        : 'Bias data zatím chybí — nastav session bias před obchodováním.'}
                                </p>
                            </button>
                        </div>
                    </div>
                </motion.div>
            )}

            {/* ══════════ NA STOLE ══════════ */}
            {tab === 'stole' && (
                <motion.div {...fadeIn} className="space-y-4">
                    {cf.covered === 0 ? (
                        <div className={`p-10 rounded-3xl border text-center ${cardCls}`}>
                            <Scale size={32} className="text-slate-400 mx-auto mb-3" />
                            <h3 className={`text-base font-black uppercase tracking-tight mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Chybí counterfactual data</h3>
                            <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                                Žádný z {ds.trades.length} obchodů nemá counterfactual blok (varianty SL dopočítané z barů).
                                Sbírá ho AlphaBridge extension při zápisu obchodu z grafu — manuální a importované obchody ho nemají.
                            </p>
                        </div>
                    ) : (
                        <>
                            {cf.covered < cf.total && (
                                <div className={`px-4 py-2.5 rounded-xl border text-[11px] font-bold ${isDark ? 'bg-amber-500/5 border-amber-500/20 text-amber-500' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
                                    ⚠️ Srovnání počítáno jen z {cf.covered} z {cf.total} obchodů, které mají counterfactual data a risk.
                                </div>
                            )}

                            {/* 3 hero karty */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
                                <div className={`p-5 rounded-2xl border ${cardCls}`}>
                                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Tvoje realita</p>
                                    <p className={`${bigMono} text-[26px] mt-2 text-cyan-500`}>{fmtVal(unit, cf.real.r, cf.real.usd)}</p>
                                    <p className="text-[10px] text-slate-500 mt-1.5">skutečně zapsané výsledky ({cf.real.n} obchodů)</p>
                                </div>
                                <div className={`p-5 rounded-2xl border border-emerald-500/25 ${isDark ? 'bg-white/[0.03]' : 'bg-white'}`}>
                                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-500">Nejlepší varianta</p>
                                    <p className={`${bigMono} text-[26px] mt-2 text-emerald-500`}>{cf.bestFixed ? fmtVal(unit, cf.bestFixed.r, cf.bestFixed.usd) : '—'}</p>
                                    <p className="text-[10px] text-slate-500 mt-1.5">{cf.bestFixed ? `${cf.bestFixed.label} · ${cf.bestFixed.sub} (${cf.bestFixed.n} obchodů)` : ''}</p>
                                </div>
                                <div className="p-5 rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 to-transparent">
                                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-500">Na stole</p>
                                    <p className={`${bigMono} text-[26px] mt-2 text-amber-500`}>{isUsd ? fmtUsd(cf.deltaUsd) : fmtR(cf.deltaR)}</p>
                                    <p className="text-[10px] text-slate-500 mt-1.5">rozdíl mezi realitou a optimem</p>
                                </div>
                            </div>

                            {/* Bar chart variant */}
                            <div className={`p-5 rounded-3xl border ${cardCls}`}>
                                <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4">
                                    <p className={eyebrow}>Umístění SL × řízení pozice — souhrn {isUsd ? 'v $' : 'v R'}</p>
                                    <div className="flex items-center gap-3">
                                        <span className="text-[10px] text-slate-500">z {cf.covered} obchodů · dopočítáno z barů</span>
                                        <button
                                            onClick={() => setShowTrail(s => !s)}
                                            className={`px-2.5 py-1 rounded-lg border text-[9px] font-black uppercase tracking-widest transition-all ${
                                                showTrail
                                                    ? 'border-cyan-500/40 text-cyan-500 bg-cyan-500/10'
                                                    : isDark ? 'border-white/10 text-slate-500' : 'border-slate-200 text-slate-400'
                                            }`}
                                        >
                                            Trailing {showTrail ? 'zap' : 'vyp'}
                                        </button>
                                    </div>
                                </div>
                                {barRows.map(({ v, isBest, pct, valStr, fill, valCls }) => (
                                    <div key={v.key} className="flex items-center gap-4 my-2.5">
                                        <div className="w-32 md:w-36 shrink-0">
                                            <p className={`text-xs font-bold flex items-center gap-1.5 flex-wrap ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                                                {v.label}
                                                {v.isReal && <span className="text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-500">Realita</span>}
                                                {isBest && <span className="text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-500">Nejlepší</span>}
                                            </p>
                                            <p className="text-[10px] text-slate-500">
                                                {v.sub}
                                                {v.n > 0 ? ` · WR ${Math.round(v.wins / v.n * 100)} %` : ''}
                                                {!v.isReal && v.n < cf.covered ? ` · ${v.n}/${cf.covered}` : ''}
                                            </p>
                                        </div>
                                        <div className={`flex-1 h-7 rounded-lg overflow-hidden ${isDark ? 'bg-white/[0.03]' : 'bg-slate-100'}`}>
                                            <div className="h-full rounded-lg transition-all duration-500" style={{ width: `${pct}%`, background: fill }} />
                                        </div>
                                        <span className={`w-20 md:w-24 text-right text-sm font-mono font-black tabular-nums ${valCls}`}>{valStr}</span>
                                    </div>
                                ))}
                            </div>

                            {/* Insight karty */}
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
                                {trailInsight && (
                                    <div className={`p-5 rounded-2xl border border-l-[3px] border-l-rose-500 ${cardCls}`}>
                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-rose-500">Set & forget vs. trailing</p>
                                        <p className={`text-[13px] mt-2 leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{trailInsight}</p>
                                        {askCoachButton(`V Labu (Na stole) mi vyšlo tohle srovnání řízení pozice — čísla jsou spočítaná deterministicky z counterfactual dat (${cf.covered} obchodů): ${trailInsight} Co z toho plyne pro můj playbook?`)}
                                    </div>
                                )}
                                {leftInsight && (
                                    <div className={`p-5 rounded-2xl border border-l-[3px] border-l-emerald-500 ${cardCls}`}>
                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-500">Kde utekl zisk</p>
                                        <p className={`text-[13px] mt-2 leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{leftInsight}</p>
                                        {askCoachButton(`V Labu (Na stole) mi vyšlo: ${leftInsight} Jak mám upravit výběr TP targetů?`)}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </motion.div>
            )}

            {/* ══════════ BIAS ══════════ */}
            {tab === 'bias' && (
                <motion.div {...fadeIn} className="space-y-4">
                    {ds.coverage.withBias === 0 ? (
                        <div className={`p-10 rounded-3xl border text-center ${cardCls}`}>
                            <FlaskConical size={32} className="text-slate-400 mx-auto mb-3" />
                            <h3 className={`text-base font-black uppercase tracking-tight mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Chybí bias data</h3>
                            <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                                {world === 'live'
                                    ? 'Žádný obchod nejde spárovat s biasem. Na live se bias bere z ranní přípravy (Market bias, případně bias na session kartě) — vyplň ho v Deníku před obchodováním a Lab změří, jestli ti pomáhá. Neutral se nepočítá jako bias.'
                                    : 'Žádný obchod nemá vyhodnocený session bias. Nastav bias (Long/Short) před session — Lab pak změří, jestli ti pomáhá.'}
                            </p>
                        </div>
                    ) : (
                        <>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
                                {bias.groups.map(g => {
                                    const accent = g.key === 'aligned' ? 'emerald' : g.key === 'neutral' ? 'blue' : 'rose';
                                    const accentText = g.key === 'aligned' ? 'text-emerald-500' : g.key === 'neutral' ? 'text-blue-500' : 'text-rose-500';
                                    const borderCls = g.n === 0
                                        ? (isDark ? 'border-white/5' : 'border-slate-200')
                                        : g.key === 'aligned' ? 'border-emerald-500/30' : g.key === 'neutral' ? 'border-blue-500/25' : 'border-rose-500/30';
                                    return (
                                        <div key={g.key} className={`p-5 rounded-2xl border ${borderCls} ${isDark ? 'bg-white/[0.03]' : 'bg-white'}`}>
                                            <p className={`text-[10px] font-black uppercase tracking-[0.18em] flex items-center gap-2 ${g.n === 0 ? 'text-slate-500' : accentText}`}>
                                                <span className={`w-2 h-2 rounded-full ${g.n === 0 ? 'bg-slate-500' : `bg-${accent}-500`}`} style={g.n > 0 ? { boxShadow: '0 0 8px currentColor' } : undefined} />
                                                {g.label}
                                            </p>
                                            <p className={`${bigMono} text-[26px] mt-3 ${g.n === 0 ? 'text-slate-500' : rCol(g.r ?? g.usd)}`}>
                                                {g.n === 0 ? '—' : fmtVal(unit, g.r, g.usd)}
                                            </p>
                                            <p className="text-[10px] text-slate-500 mt-1">
                                                {g.n === 0 ? 'žádné takové obchody' : (isUsd ? (g.r != null ? fmtR(g.r) : 'R nedostupné') : usdPlain(g.usd))}
                                            </p>
                                            <div className={`flex gap-5 mt-4 pt-3 border-t ${isDark ? 'border-white/5' : 'border-slate-100'}`}>
                                                <div>
                                                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Obchody</p>
                                                    <p className={`text-sm font-mono font-black mt-0.5 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{g.n}</p>
                                                </div>
                                                <div>
                                                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Win rate</p>
                                                    <p className={`text-sm font-mono font-black mt-0.5 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{g.n ? `${Math.round(g.winRate)}%` : '—'}</p>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Contribution bar */}
                            {bias.contribution.length > 0 && (
                                <div className={`p-5 rounded-3xl border ${cardCls}`}>
                                    <p className={`${eyebrow} mb-3`}>Podíl na celkovém kladném R</p>
                                    <div className={`flex h-10 rounded-xl overflow-hidden ${isDark ? 'bg-white/[0.03]' : 'bg-slate-100'}`}>
                                        {bias.contribution.map(seg => (
                                            <div
                                                key={seg.key}
                                                className="flex items-center justify-center text-[11px] font-mono font-black text-[#020617] min-w-0"
                                                style={{
                                                    width: `${seg.pct}%`,
                                                    background: seg.key === 'aligned' ? '#10b981' : seg.key === 'neutral' ? '#3b82f6' : '#f43f5e',
                                                }}
                                            >
                                                {seg.pct >= 8 ? `${Math.round(seg.pct)}%` : ''}
                                            </div>
                                        ))}
                                    </div>
                                    <div className="flex gap-4 mt-3 flex-wrap">
                                        {bias.contribution.map(seg => (
                                            <span key={seg.key} className="flex items-center gap-2 text-[11px] text-slate-500">
                                                <span className="w-2.5 h-2.5 rounded" style={{ background: seg.key === 'aligned' ? '#10b981' : seg.key === 'neutral' ? '#3b82f6' : '#f43f5e' }} />
                                                {seg.label} · <span className={`font-mono ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{fmtR(seg.r)}</span>
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {biasInsight && (
                                <div className={`p-5 rounded-2xl border border-l-[3px] border-l-cyan-500 ${cardCls}`}>
                                    <p className={`text-[13px] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{biasInsight}</p>
                                    {askCoachButton(`V Labu (Bias) mi vyšlo — čísla deterministicky spočítaná z ${ds.coverage.total} obchodů: ${biasInsight} Jak s tím naložit v přípravě na session?`)}
                                </div>
                            )}

                            {world === 'live' && (
                                <p className="text-[10px] text-slate-500">
                                    Zdroj biasu na live: ranní příprava — bias na session kartě má přednost před denním Market biasem.
                                    Dny s Neutral nebo bez prepu se počítají jako „bez biasu". U obchodů z AlphaBridge má přednost bias zapsaný přímo u obchodu.
                                </p>
                            )}
                        </>
                    )}
                </motion.div>
            )}

            {/* ══════════ LEAKY ══════════ */}
            {tab === 'leaky' && (
                <motion.div {...fadeIn} className="space-y-4">
                    {leaks.length === 0 ? (
                        <div className={`p-10 rounded-3xl border text-center ${cardCls}`}>
                            <Droplets size={32} className="text-slate-400 mx-auto mb-3" />
                            <h3 className={`text-base font-black uppercase tracking-tight mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                Žádný detektor nezabral
                            </h3>
                            <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                                {ds.trades.length < 8
                                    ? `Detektory potřebují víc dat (máš ${ds.trades.length} obchodů, minimum je ~8).`
                                    : 'Na aktuálním vzorku žádný z detektorů (revenge, sizing po ztrátě, slabé hodiny/session, bias flip, overtrading, cold start, bez přípravy) nenašel skupinu obchodů se statisticky odlišným chováním. Solidní.'}
                            </p>
                        </div>
                    ) : (
                        <>
                            <div className={`px-4 py-2.5 rounded-xl border text-[11px] ${isDark ? 'bg-white/[0.02] border-white/5 text-slate-500' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
                                Deterministické detektory nad {ds.trades.length} obchody. Skóre = |$ dopad| × konfidence (z-test win rate) × trend.
                                Dopad = co skupina udělala vs. kdyby ty samé obchody běžely na tvém průměru.
                            </div>
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                {leaks.map((f, idx) => {
                                    const isCostly = f.usdImpact < 0;
                                    const TrendIcon = f.trend === 'worsening' ? TrendingDown : f.trend === 'improving' ? TrendingUp : Minus;
                                    return (
                                        <div
                                            key={f.id}
                                            className={`p-5 rounded-2xl border ${
                                                idx === 0 && isCostly
                                                    ? (isDark ? 'bg-rose-500/[0.06] border-rose-500/25' : 'bg-rose-50/60 border-rose-200')
                                                    : isCostly
                                                        ? (isDark ? 'bg-rose-500/[0.03] border-rose-500/15' : 'bg-rose-50/30 border-rose-200/60')
                                                        : cardCls
                                            }`}
                                        >
                                            <div className="flex items-start gap-3">
                                                <div className={`p-2 rounded-xl shrink-0 ${isCostly ? 'bg-rose-500/10' : 'bg-emerald-500/10'}`}>
                                                    <AlertTriangle size={15} className={isCostly ? 'text-rose-500' : 'text-emerald-500'} strokeWidth={2.5} />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
                                                        <span className={`text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border ${isCostly ? 'bg-rose-500/10 text-rose-500 border-rose-500/20' : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'}`}>
                                                            {LEAK_CATEGORY_LABEL[f.category]}
                                                        </span>
                                                        <span className={`text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border ${
                                                            f.confidence === 'high' ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' : (isDark ? 'bg-white/5 text-slate-400 border-white/10' : 'bg-slate-100 text-slate-500 border-slate-200')
                                                        }`}>
                                                            konfidence {CONF_LABEL[f.confidence]}{f.z != null ? ` · z=${Math.abs(f.z).toFixed(1)}` : ''}
                                                        </span>
                                                        <span className={`text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border flex items-center gap-1 ${
                                                            f.trend === 'worsening' ? 'bg-rose-500/10 text-rose-500 border-rose-500/20' : (isDark ? 'bg-white/5 text-slate-400 border-white/10' : 'bg-slate-100 text-slate-500 border-slate-200')
                                                        }`}>
                                                            <TrendIcon size={8} /> {TREND_LABEL[f.trend]}
                                                        </span>
                                                    </div>
                                                    <h4 className={`text-sm font-black uppercase tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{f.title}</h4>
                                                </div>
                                                <div className="text-right shrink-0">
                                                    <p className={`font-mono text-lg font-black tabular-nums ${isCostly ? 'text-rose-500' : 'text-emerald-500'}`}>{fmtUsd(f.usdImpact)}</p>
                                                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">dopad</p>
                                                </div>
                                            </div>
                                            <p className={`text-xs font-mono mt-3 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{f.statLine}</p>
                                            <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">{f.detail}</p>
                                            <div className="flex items-center gap-2 mt-3 flex-wrap">
                                                {onAskAI && (
                                                    <button
                                                        onClick={() => onAskAI(buildLeakCoachPrompt(f))}
                                                        className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${isDark ? 'bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25' : 'bg-cyan-500 text-white hover:bg-cyan-600'}`}
                                                    >
                                                        <Sparkles size={10} strokeWidth={2.5} /> Probrat s coachem
                                                    </button>
                                                )}
                                                <button
                                                    onClick={() => startExperimentFromLeak(f)}
                                                    className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${isDark ? 'bg-violet-500/15 text-violet-400 hover:bg-violet-500/25' : 'bg-violet-500 text-white hover:bg-violet-600'}`}
                                                >
                                                    <TestTubes size={10} strokeWidth={2.5} /> Vytvořit experiment
                                                </button>
                                                <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">n={f.n} vs. {f.restN}</span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </motion.div>
            )}

            {/* ══════════ PSYCHOLOGIE ══════════ */}
            {tab === 'psycho' && (
                <motion.div {...fadeIn} className="space-y-4">
                    {psycho.tagRows.length === 0 && !psycho.confidence && !psycho.sleep && !psycho.ratingNextDay ? (
                        <div className={`p-10 rounded-3xl border text-center ${cardCls}`}>
                            <Brain size={32} className="text-slate-400 mx-auto mb-3" />
                            <h3 className={`text-base font-black uppercase tracking-tight mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                Zatím málo psychologických dat
                            </h3>
                            <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                                Taguj obchody emocemi a chybami{world === 'live' ? ', vyplňuj ranní prep (confidence, spánek) a večerní audit (rating)' : ''} —
                                Lab pak spočítá, kolik tě který stav reálně stojí. Každá korelace potřebuje aspoň ~4 dny / 3 obchody.
                            </p>
                        </div>
                    ) : (
                        <>
                            {/* Cena emocí a chyb */}
                            {psycho.tagRows.length > 0 && (
                                <div className={`p-5 rounded-3xl border ${cardCls}`}>
                                    <p className={`${eyebrow} mb-1`}>Cena emocí a chyb</p>
                                    <p className="text-[10px] text-slate-500 mb-4">
                                        Dopad = P&L otagovaných obchodů vs. kdyby běžely na tvém průměru. Min. 3 obchody na tag.
                                    </p>
                                    <div className="space-y-1.5">
                                        {psycho.tagRows.map(row => (
                                            <div key={`${row.kind}_${row.tag}`} className={`flex items-center gap-3 px-3 py-2.5 rounded-xl ${isDark ? 'bg-white/[0.02]' : 'bg-slate-50'}`}>
                                                <span className={`text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border shrink-0 ${
                                                    row.kind === 'emotion' ? 'bg-violet-500/10 text-violet-400 border-violet-500/20' : 'bg-rose-500/10 text-rose-500 border-rose-500/20'
                                                }`}>
                                                    {row.kind === 'emotion' ? 'Emoce' : 'Chyba'}
                                                </span>
                                                <span className={`text-xs font-bold flex-1 min-w-0 truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{row.tag}</span>
                                                <span className="text-[10px] font-mono text-slate-500 shrink-0">{row.n}× · WR {Math.round(row.winRate)} %{row.avgR != null ? ` · Ø ${fmtR(row.avgR)}` : ''}</span>
                                                <span className={`w-20 text-right font-mono text-xs font-black tabular-nums shrink-0 ${row.usdImpact < 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                                                    {fmtUsd(row.usdImpact)}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Prep / spánek / rating korelace */}
                            {(psycho.confidence || psycho.sleep || psycho.ratingNextDay) && (
                                <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5">
                                    {psycho.confidence && (
                                        <div className={`p-5 rounded-2xl border ${cardCls}`}>
                                            <p className={`${eyebrow} mb-1`}>Confidence z prepu → den</p>
                                            <p className="text-[10px] text-slate-500 mb-3">{psycho.confidence.coveredDays} z {psycho.confidence.tradingDays} obchodních dní má prep s confidence</p>
                                            {psycho.confidence.buckets.map(b => (
                                                <div key={b.label} className={`flex items-center justify-between py-2 border-t ${isDark ? 'border-white/5' : 'border-slate-100'}`}>
                                                    <div>
                                                        <p className={`text-xs font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{b.label}</p>
                                                        <p className="text-[9px] text-slate-500">{b.days} dní · {b.posDays} zelených</p>
                                                    </div>
                                                    <p className={`font-mono text-sm font-black ${rCol(b.avgPnl)}`}>{fmtUsd(b.avgPnl)}<span className="text-[9px] text-slate-500 font-normal">/den</span></p>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {psycho.sleep && (
                                        <div className={`p-5 rounded-2xl border ${cardCls}`}>
                                            <p className={`${eyebrow} mb-1`}>Spánek → den</p>
                                            <p className="text-[10px] text-slate-500 mb-3">checklist „vyspal jsem se" z ranního prepu ({psycho.sleep.coveredDays} dní)</p>
                                            {psycho.sleep.buckets.map(b => (
                                                <div key={b.label} className={`flex items-center justify-between py-2 border-t ${isDark ? 'border-white/5' : 'border-slate-100'}`}>
                                                    <div>
                                                        <p className={`text-xs font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{b.label}</p>
                                                        <p className="text-[9px] text-slate-500">{b.days} dní · {b.posDays} zelených</p>
                                                    </div>
                                                    <p className={`font-mono text-sm font-black ${rCol(b.avgPnl)}`}>{fmtUsd(b.avgPnl)}<span className="text-[9px] text-slate-500 font-normal">/den</span></p>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {psycho.ratingNextDay && (
                                        <div className={`p-5 rounded-2xl border ${cardCls}`}>
                                            <p className={`${eyebrow} mb-1`}>Rating večera → další den</p>
                                            <p className="text-[10px] text-slate-500 mb-3">tilt carry-over: jak jede den po špatném dni ({psycho.ratingNextDay.coveredDays} dvojic)</p>
                                            {psycho.ratingNextDay.buckets.map(b => (
                                                <div key={b.label} className={`flex items-center justify-between py-2 border-t ${isDark ? 'border-white/5' : 'border-slate-100'}`}>
                                                    <div>
                                                        <p className={`text-xs font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{b.label}</p>
                                                        <p className="text-[9px] text-slate-500">{b.days} dní · {b.posDays} zelených</p>
                                                    </div>
                                                    <p className={`font-mono text-sm font-black ${rCol(b.avgPnl)}`}>{fmtUsd(b.avgPnl)}<span className="text-[9px] text-slate-500 font-normal">/den</span></p>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {world === 'backtest' && (
                                <p className="text-[10px] text-slate-500">
                                    V backtest světě se korelace s deníkem (prep/review) nepočítají — backtest dny nemají ranní přípravu.
                                </p>
                            )}

                            <div className={`p-5 rounded-2xl border border-l-[3px] border-l-violet-500 ${cardCls}`}>
                                <p className={`text-[13px] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                                    Emoční stav při vstupu bývá nejsilnější netrackovaný prediktor výsledku. Tahle čísla ti říkají, kolik stojí — pravidlo z nich vyrobí coach.
                                </p>
                                {askCoachButton(buildPsychoCoachPrompt(psycho))}
                            </div>
                        </>
                    )}
                </motion.div>
            )}

            {/* ══════════ EXPERIMENTY ══════════ */}
            {tab === 'experimenty' && (
                <motion.div {...fadeIn} className="space-y-4">
                    <div className={`px-4 py-2.5 rounded-xl border text-[11px] flex items-center justify-between gap-3 flex-wrap ${isDark ? 'bg-white/[0.02] border-white/5 text-slate-500' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
                        <span>Uzavřená smyčka: leak → pravidlo → měření. Obchody před startem = baseline, po startu = běh experimentu.</span>
                        {!draft && (
                            <button
                                onClick={() => setDraft({ ...EMPTY_DRAFT })}
                                className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 shrink-0 ${isDark ? 'bg-violet-500/15 text-violet-400 hover:bg-violet-500/25' : 'bg-violet-500 text-white hover:bg-violet-600'}`}
                            >
                                <Plus size={10} strokeWidth={3} /> Nový experiment
                            </button>
                        )}
                    </div>

                    {/* Formulář */}
                    {draft && (
                        <div className={`p-5 rounded-2xl border border-violet-500/30 ${isDark ? 'bg-violet-500/[0.04]' : 'bg-violet-50/50'}`}>
                            <p className={`${eyebrow} mb-3`}>Nový experiment{draft.sourceLeakId ? ' (z leak detektoru)' : ''}</p>
                            <div className="space-y-3">
                                <div>
                                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Název</p>
                                    <input
                                        value={draft.title}
                                        onChange={e => setDraft({ ...draft, title: e.target.value })}
                                        placeholder="např. Neobchoduji London session"
                                        className={`w-full rounded-xl px-3 py-2.5 text-sm outline-none border transition-all ${isDark ? 'bg-white/5 border-white/10 text-white placeholder:text-slate-500 focus:border-violet-500/50' : 'bg-white border-slate-200 text-slate-800 placeholder:text-slate-400 focus:border-violet-400'}`}
                                    />
                                </div>
                                <div>
                                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Pravidlo (co od teď dodržuji)</p>
                                    <input
                                        value={draft.rule}
                                        onChange={e => setDraft({ ...draft, rule: e.target.value })}
                                        placeholder="např. Vstupuji jen v NY session, London pouze sleduji"
                                        className={`w-full rounded-xl px-3 py-2.5 text-sm outline-none border transition-all ${isDark ? 'bg-white/5 border-white/10 text-white placeholder:text-slate-500 focus:border-violet-500/50' : 'bg-white border-slate-200 text-slate-800 placeholder:text-slate-400 focus:border-violet-400'}`}
                                    />
                                </div>
                                <div>
                                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Hypotéza (co očekávám)</p>
                                    <textarea
                                        value={draft.hypothesis}
                                        onChange={e => setDraft({ ...draft, hypothesis: e.target.value })}
                                        rows={2}
                                        placeholder="např. Ø výsledek na obchod se zlepší, protože London mi dlouhodobě prodělává"
                                        className={`w-full rounded-xl px-3 py-2.5 text-sm outline-none border transition-all resize-none ${isDark ? 'bg-white/5 border-white/10 text-white placeholder:text-slate-500 focus:border-violet-500/50' : 'bg-white border-slate-200 text-slate-800 placeholder:text-slate-400 focus:border-violet-400'}`}
                                    />
                                </div>
                                <div className="flex items-end gap-3 flex-wrap">
                                    <div>
                                        <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Vyhodnotit po (obchodů)</p>
                                        <input
                                            type="number"
                                            min={5}
                                            value={draft.targetTrades}
                                            onChange={e => setDraft({ ...draft, targetTrades: e.target.value })}
                                            className={`w-28 rounded-xl px-3 py-2.5 text-sm outline-none border font-mono transition-all ${isDark ? 'bg-white/5 border-white/10 text-white focus:border-violet-500/50' : 'bg-white border-slate-200 text-slate-800 focus:border-violet-400'}`}
                                        />
                                    </div>
                                    <button
                                        onClick={saveDraft}
                                        disabled={!draft.title.trim() || !draft.rule.trim()}
                                        className={`px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed ${isDark ? 'bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 border border-violet-500/40' : 'bg-violet-500 text-white hover:bg-violet-600'}`}
                                    >
                                        Spustit experiment
                                    </button>
                                    <button
                                        onClick={() => setDraft(null)}
                                        className={`px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                                    >
                                        Zrušit
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Seznam experimentů */}
                    {worldExperiments.length === 0 && !draft ? (
                        <div className={`p-10 rounded-3xl border text-center ${cardCls}`}>
                            <TestTubes size={32} className="text-slate-400 mx-auto mb-3" />
                            <h3 className={`text-base font-black uppercase tracking-tight mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                Žádný experiment neběží
                            </h3>
                            <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                                Vytvoř experiment ručně, nebo rovnou z leak karty (záložka Leaky → „Vytvořit experiment").
                                Lab pak automaticky měří before/after a po dosažení cíle nabídne vyhodnocení.
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-3.5">
                            {worldExperiments.map(exp => {
                                const report = computeExperimentReport(dsWorld, exp);
                                const running = exp.status === 'running';
                                const statusChip = exp.status === 'running'
                                    ? { label: 'Běží', cls: 'bg-violet-500/10 text-violet-400 border-violet-500/25' }
                                    : exp.status === 'evaluated'
                                        ? { label: 'Vyhodnoceno', cls: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/25' }
                                        : { label: 'Zrušeno', cls: isDark ? 'bg-white/5 text-slate-400 border-white/10' : 'bg-slate-100 text-slate-500 border-slate-200' };
                                const sideCell = (label: string, s: typeof report.before) => (
                                    <div className={`p-3.5 rounded-xl border ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-slate-50 border-slate-100'}`}>
                                        <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 mb-1.5">{label} · {s.n} obchodů</p>
                                        {s.n === 0 ? (
                                            <p className="text-xs text-slate-500">zatím nic</p>
                                        ) : (
                                            <div className="flex gap-4 flex-wrap">
                                                <span className={`font-mono text-sm font-black ${rCol(s.avgPnl)}`}>{fmtUsd(s.avgPnl)}<span className="text-[9px] text-slate-500 font-normal">/obchod</span></span>
                                                <span className="font-mono text-sm font-black text-slate-400">{Math.round(s.winRate)}%<span className="text-[9px] text-slate-500 font-normal"> WR</span></span>
                                                {s.avgR != null && <span className={`font-mono text-sm font-black ${rCol(s.avgR)}`}>{fmtR(s.avgR)}<span className="text-[9px] text-slate-500 font-normal"> Ø</span></span>}
                                            </div>
                                        )}
                                    </div>
                                );
                                return (
                                    <div key={exp.id} className={`p-5 rounded-2xl border ${running ? 'border-violet-500/25' : ''} ${cardCls}`}>
                                        <div className="flex items-start justify-between gap-3 flex-wrap">
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap mb-1">
                                                    <span className={`text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border ${statusChip.cls}`}>{statusChip.label}</span>
                                                    <span className="text-[9px] font-bold text-slate-500">od {new Date(exp.startTs).toLocaleDateString('cs-CZ')}</span>
                                                </div>
                                                <h4 className={`text-sm font-black uppercase tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{exp.title}</h4>
                                                <p className="text-[11px] text-slate-500 mt-1"><b>Pravidlo:</b> {exp.rule}</p>
                                                {exp.hypothesis && <p className="text-[11px] text-slate-500 mt-0.5"><b>Hypotéza:</b> {exp.hypothesis}</p>}
                                            </div>
                                            <div className="text-right shrink-0">
                                                <p className={`font-mono text-lg font-black tabular-nums ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{report.after.n}<span className="text-slate-500 text-sm">/{exp.targetTrades}</span></p>
                                                <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">obchodů po startu</p>
                                            </div>
                                        </div>

                                        {/* Progress bar */}
                                        {running && (
                                            <div className={`mt-3 h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-white/5' : 'bg-slate-100'}`}>
                                                <div
                                                    className={`h-full rounded-full transition-all duration-500 ${report.ready ? 'bg-emerald-500' : 'bg-violet-500'}`}
                                                    style={{ width: `${report.progress * 100}%` }}
                                                />
                                            </div>
                                        )}

                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3.5">
                                            {sideCell('Před (baseline)', report.before)}
                                            {sideCell('Po startu', report.after)}
                                        </div>

                                        {exp.status === 'evaluated' && exp.conclusion && (
                                            <p className={`mt-3 px-3.5 py-2.5 rounded-xl border text-[12px] leading-relaxed ${isDark ? 'bg-emerald-500/5 border-emerald-500/20 text-slate-300' : 'bg-emerald-50 border-emerald-200 text-slate-600'}`}>
                                                <b>Závěr:</b> {exp.conclusion}
                                            </p>
                                        )}
                                        {running && report.verdict && (
                                            <p className={`mt-3 px-3.5 py-2.5 rounded-xl border text-[12px] leading-relaxed ${isDark ? 'bg-white/[0.02] border-white/5 text-slate-400' : 'bg-slate-50 border-slate-100 text-slate-500'}`}>
                                                <b>Průběžně:</b> {report.verdict}{!report.ready ? ' (vzorek ještě neúplný)' : ''}
                                            </p>
                                        )}

                                        <div className="flex items-center gap-2 mt-3.5 flex-wrap">
                                            {running && (
                                                <button
                                                    onClick={() => onUpdateExperiments(experiments.map(e => e.id === exp.id
                                                        ? { ...e, status: 'evaluated' as const, evaluatedAt: Date.now(), conclusion: report.verdict || `Vyhodnoceno ručně po ${report.after.n} obchodech.` }
                                                        : e))}
                                                    className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${
                                                        report.ready
                                                            ? (isDark ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30' : 'bg-emerald-500 text-white hover:bg-emerald-600')
                                                            : (isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10' : 'bg-slate-100 text-slate-500 hover:bg-slate-200')
                                                    }`}
                                                >
                                                    <CheckCircle2 size={10} strokeWidth={2.5} /> Vyhodnotit{!report.ready ? ' předčasně' : ''}
                                                </button>
                                            )}
                                            {running && (
                                                <button
                                                    onClick={() => onUpdateExperiments(experiments.map(e => e.id === exp.id ? { ...e, status: 'cancelled' as const } : e))}
                                                    className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                                                >
                                                    <XCircle size={10} strokeWidth={2.5} /> Zrušit
                                                </button>
                                            )}
                                            {onAskAI && (
                                                <button
                                                    onClick={() => onAskAI(buildExperimentCoachPrompt(exp, report))}
                                                    className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${isDark ? 'bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25' : 'bg-cyan-500 text-white hover:bg-cyan-600'}`}
                                                >
                                                    <Sparkles size={10} strokeWidth={2.5} /> Probrat s coachem
                                                </button>
                                            )}
                                            {!running && (
                                                <button
                                                    onClick={() => onUpdateExperiments(experiments.filter(e => e.id !== exp.id))}
                                                    className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${isDark ? 'bg-rose-500/10 text-rose-400 hover:bg-rose-500/20' : 'bg-rose-50 text-rose-500 hover:bg-rose-100'}`}
                                                >
                                                    <Trash2 size={10} strokeWidth={2.5} /> Smazat
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </motion.div>
            )}

            {/* ══════════ OBCHODY ══════════ */}
            {tab === 'obchody' && (
                <motion.div {...fadeIn} className="space-y-4">
                    {/* Filtry */}
                    <div className="flex gap-4 flex-wrap">
                        {filterGroups.map(fg => (
                            <div key={fg.key}>
                                <p className="text-[8px] font-black uppercase tracking-[0.18em] text-slate-500 mb-1.5">{fg.label}</p>
                                <div className="flex gap-1.5 flex-wrap">
                                    {fg.opts.map(([val, lab]) => {
                                        const active = filters[fg.key] === val;
                                        return (
                                            <button
                                                key={val}
                                                onClick={() => setFilter(fg.key, val)}
                                                className={`px-2.5 py-1.5 rounded-lg border text-[10px] font-bold transition-all ${
                                                    active
                                                        ? 'bg-cyan-500/15 text-cyan-500 border-cyan-500/40'
                                                        : isDark ? 'bg-white/[0.03] text-slate-400 border-white/5 hover:border-white/15' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
                                                }`}
                                            >
                                                {lab}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Tabulka */}
                    <div className={`rounded-2xl border overflow-hidden ${cardCls}`}>
                        <div className={`hidden md:grid grid-cols-[100px_90px_70px_75px_1fr_85px_32px] gap-3 px-5 py-2.5 border-b text-[8px] font-black uppercase tracking-[0.15em] text-slate-500 ${isDark ? 'border-white/5' : 'border-slate-100'}`}>
                            <span>Čas</span><span>Session</span><span>Směr</span><span>Výsledek</span><span>SL · Cíl · Bias</span><span className="text-right">{isUsd ? '$' : 'R'}</span><span />
                        </div>
                        {visibleRows.length === 0 && (
                            <p className="p-10 text-center text-xs text-slate-500">Žádné obchody neodpovídají filtru.</p>
                        )}
                        {visibleRows.map(t => {
                            const exp = expanded === t.id;
                            const dirCls = t.direction === 'Long' ? 'bg-cyan-500/15 text-cyan-500' : 'bg-violet-500/15 text-violet-400';
                            const outCls = t.outcome === 'Win' ? 'bg-emerald-500/15 text-emerald-500' : t.outcome === 'Loss' ? 'bg-rose-500/15 text-rose-500' : 'bg-amber-500/15 text-amber-500';
                            const biasCls = t.biasAligned === true ? 'bg-emerald-500/15 text-emerald-500' : t.biasAligned === false ? 'bg-rose-500/15 text-rose-500' : (isDark ? 'bg-white/5 text-slate-400' : 'bg-slate-100 text-slate-500');
                            const setup = `${t.slPlacement ? (SL_LABELS[t.slPlacement] || t.slPlacement) : '—'} → ${t.targetLevel || t.targetType || 'trail'}`;
                            return (
                                <div key={String(t.id)} className={`border-b last:border-b-0 ${isDark ? 'border-white/[0.04]' : 'border-slate-100'}`}>
                                    <button
                                        onClick={() => setExpanded(exp ? null : t.id)}
                                        className={`w-full grid grid-cols-[1fr_auto] md:grid-cols-[100px_90px_70px_75px_1fr_85px_32px] gap-2 md:gap-3 px-5 py-3 items-center text-left transition-colors ${exp ? 'bg-cyan-500/[0.05]' : ''} ${isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-slate-50'}`}
                                    >
                                        <span className={`font-mono text-[11px] ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{fmtDayTime(t.date)}</span>
                                        <span className="hidden md:block text-[11px] text-slate-500 truncate">{t.session || '—'}</span>
                                        <span className="hidden md:block"><span className={`text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-md ${dirCls}`}>{t.direction}</span></span>
                                        <span className="hidden md:block"><span className={`text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-md ${outCls}`}>{t.outcome}</span></span>
                                        <span className="hidden md:flex items-center gap-2 flex-wrap text-[11px] text-slate-500 min-w-0">
                                            <span className="truncate">{setup}</span>
                                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${biasCls}`}>
                                                {t.biasAligned === true ? 'bias ✓' : t.biasAligned === false ? 'proti ✕' : 'bez biasu'}
                                            </span>
                                        </span>
                                        <span className={`text-right font-mono text-[13px] font-black tabular-nums ${rCol(t.r ?? t.pnl)}`}>
                                            {isUsd ? fmtUsd(t.pnl) : (t.r != null ? fmtR(t.r) : '—')}
                                        </span>
                                        <ChevronRight size={13} className={`justify-self-center transition-transform ${exp ? 'rotate-90 text-cyan-500' : 'text-slate-500'}`} />
                                    </button>

                                    <AnimatePresence>
                                        {exp && (
                                            <motion.div
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{ height: 'auto', opacity: 1 }}
                                                exit={{ height: 0, opacity: 0 }}
                                                className="overflow-hidden"
                                            >
                                                <div className={`px-5 pb-5 pt-1 ${isDark ? 'bg-black/20' : 'bg-slate-50/60'}`}>
                                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
                                                        {/* Co kdyby — varianty SL */}
                                                        <div className={`p-4 rounded-xl border ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-white border-slate-200'}`}>
                                                            <p className={`${eyebrow} mb-3`}>Co kdyby — varianty SL</p>
                                                            {t.cf ? (
                                                                <>
                                                                    <div className="grid grid-cols-[1fr_auto_auto] gap-x-5 gap-y-2 text-xs items-center">
                                                                        <span />
                                                                        <span className="text-[8px] font-black uppercase tracking-widest text-slate-500 text-right">Fix TP</span>
                                                                        <span className="text-[8px] font-black uppercase tracking-widest text-slate-500 text-right">Trailing</span>
                                                                        {([['Swing', t.cf.swing], ['OTE', t.cf.ote], ['FVG', t.cf.fvg]] as const).map(([name, v]) => (
                                                                            <React.Fragment key={name}>
                                                                                <span className={`font-bold ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{name}</span>
                                                                                <span className={`text-right font-mono font-black ${rCol(v.fixedR)}`}>{fmtR(v.fixedR)}</span>
                                                                                <span className={`text-right font-mono font-black ${rCol(v.trailR)}`}>{fmtR(v.trailR)}</span>
                                                                            </React.Fragment>
                                                                        ))}
                                                                    </div>
                                                                    {t.cf.tpBest && (
                                                                        <p className="text-[10px] text-slate-500 mt-3">
                                                                            Nejlepší cíl (zpětně): <span className="text-emerald-500 font-mono">{fmtR(t.cf.tpBest.r)} @ {t.cf.tpBest.label}</span>
                                                                        </p>
                                                                    )}
                                                                </>
                                                            ) : (
                                                                <p className="text-[11px] text-slate-500">Tento obchod nemá counterfactual data (není z AlphaBridge).</p>
                                                            )}
                                                        </div>

                                                        {/* Průběh & kontext */}
                                                        <div className={`p-4 rounded-xl border ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-white border-slate-200'}`}>
                                                            <p className={`${eyebrow} mb-3`}>Průběh & kontext</p>
                                                            <div className="flex gap-5 flex-wrap">
                                                                <div>
                                                                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">MFE</p>
                                                                    <p className="font-mono text-sm font-black text-emerald-500 mt-0.5">{fmtR(t.mfeR)}</p>
                                                                </div>
                                                                <div>
                                                                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">MAE</p>
                                                                    <p className="font-mono text-sm font-black text-rose-500 mt-0.5">{t.maeR != null ? `−${Math.abs(t.maeR).toFixed(1)}R` : '—'}</p>
                                                                </div>
                                                                <div>
                                                                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Trvání</p>
                                                                    <p className={`font-mono text-sm font-black mt-0.5 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{t.durationMinutes != null ? `${t.durationMinutes}m` : '—'}</p>
                                                                </div>
                                                                <div>
                                                                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Došlo až na</p>
                                                                    <p className={`font-mono text-xs font-bold mt-1 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{t.exc?.topReached || '—'}</p>
                                                                </div>
                                                                {t.exc?.leftR != null && (
                                                                    <div>
                                                                        <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Na stole</p>
                                                                        <p className={`font-mono text-sm font-black mt-0.5 ${t.exc.leftR > 0 ? 'text-amber-500' : 'text-slate-400'}`}>{fmtR(t.exc.leftR)}</p>
                                                                    </div>
                                                                )}
                                                            </div>
                                                            {t.notes && (
                                                                <p className={`mt-3 pt-3 border-t text-[11px] italic leading-relaxed ${isDark ? 'border-white/5 text-slate-400' : 'border-slate-100 text-slate-500'}`}>
                                                                    „{t.notes}"
                                                                </p>
                                                            )}
                                                            {onOpenTrade && (
                                                                <button
                                                                    onClick={() => onOpenTrade(t.raw)}
                                                                    className={`mt-3 px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${isDark ? 'bg-white/5 text-slate-300 hover:bg-white/10' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                                                                >
                                                                    Otevřít detail obchodu
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            );
                        })}
                    </div>
                    <p className="text-[10px] text-slate-500 text-right">{visibleRows.length} z {ds.trades.length} obchodů</p>
                </motion.div>
            )}
        </div>
    );
};

export default LabPage;
