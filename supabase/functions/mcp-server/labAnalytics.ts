/**
 * labAnalytics — deterministické výpočty pro záložku Lab.
 *
 * GUARDRAIL: všechna čísla v Labu vznikají TADY (čistý TS, žádné AI).
 * AI Coach smí výsledky jen interpretovat — dostane je hotové v promptu.
 *
 * Vstup: Trade[] z App state (getTrades/getDashboardData už mapují AlphaBridge
 * rich pole — counterfactual/excursion/mfeR/biasAligned — do plochých fieldů).
 *
 * Datová poctivost:
 *  - fan-out kopie (groupId/isMaster) se dedupují na 1 rozhodnutí = 1 datapoint
 *  - Missed obchody ven
 *  - každý agregát nese `n` a pokrytí — UI nikdy nepředstírá data, která nejsou
 */
// Typy jsou runtime-erased — pro Deno bundle stačí volné aliasy (zdroj pravdy: /types.ts v repu).
type Trade = Record<string, any>;
type Account = Record<string, any>;

// ============================================================================
// TYPES
// ============================================================================

export type LabUnit = 'R' | '$';
export type LabWorld = 'live' | 'backtest';

export interface CfVariantValue {
    /** Realizované R s fixním TP pro tento SL placement (null = varianta pro obchod nevalidní). */
    fixedR: number | null;
    /** Realizované R se strukturním trailingem místo fixního TP. */
    trailR: number | null;
    outcome: string | null;
    rr: number | null;
}

export interface LabTrade {
    id: string | number;
    accountId: string;
    /** ISO datum výstupu. */
    date: string;
    ts: number;
    /** YYYY-MM-DD (lokální čas prohlížeče). */
    dayKey: string;
    /** Hodina vstupu (lokální čas), null když nejde určit. */
    hour: number | null;
    /** Unix ms VSTUPU (entryTime/entryDate, fallback = exit). Pro time-gap detektory. */
    entryTs: number | null;
    session: string | null;
    instrument: string | null;
    direction: 'Long' | 'Short';
    outcome: 'Win' | 'Loss' | 'BE';
    pnl: number;
    /** Riskovaná částka v $ (1R), null = neznámá → R metriky nedostupné. */
    risk: number | null;
    /** Realizované R (pnl/risk), null bez risku. */
    r: number | null;
    mfeR: number | null;
    maeR: number | null;
    durationMinutes: number | null;
    slPlacement: string | null;
    targetType: string | null;
    targetLevel: string | null;
    management: string | null;
    sessionBias: string | null;
    /** true = ve směru biasu, false = proti, null = bez biasu / Neutral. */
    biasAligned: boolean | null;
    /** Odkud bias pochází: 'trade' = zapsaný u obchodu (AlphaBridge/backtest),
     *  'prep' = odvozený z ranní přípravy (live), null = žádný. */
    biasSource: 'trade' | 'prep' | null;
    /** Counterfactual SL varianty — jen když AlphaBridge data existují. */
    cf: { swing: CfVariantValue; ote: CfVariantValue; fvg: CfVariantValue; tpBest: { label: string; r: number } | null } | null;
    /** Excursion do konce dne — kolik zbylo na stole. */
    exc: { mfePotR: number | null; tpR: number | null; leftR: number | null; topReached: string | null } | null;
    emotions: string[];
    mistakes: string[];
    notes: string | null;
    /** Původní Trade — pro otevření detailu z UI. */
    raw: Trade;
}

export interface LabCoverage {
    /** Obchodů po world filtru (před dedupem, bez Missed). */
    rawCount: number;
    /** Rozhodnutí po dedupu fan-out kopií — základ všech agregátů. */
    total: number;
    withR: number;
    withCf: number;
    withExc: number;
    /** Obchodů s vyhodnotitelným biasem (aligned true/false). */
    withBias: number;
}

export interface LabDataset {
    trades: LabTrade[];
    coverage: LabCoverage;
    world: LabWorld;
}

// ============================================================================
// FORMAT HELPERS (sdílené s UI)
// ============================================================================

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Win rate KONVENCE APPKY: wins/(wins+losses), BE se do jmenovatele NEpočítá
 *  (shodné s calculateStats, patternAnalysis i coach get_stats). */
export const winRatePct = (wins: number, losses: number): number =>
    (wins + losses) > 0 ? wins / (wins + losses) * 100 : 0;

export const fmtR = (v: number | null | undefined): string =>
    v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${r1(v).toFixed(1)}R`;

export const fmtUsd = (v: number | null | undefined): string =>
    v == null || Number.isNaN(v) ? '—' : `${v < 0 ? '−$' : '+$'}${Math.abs(Math.round(v)).toLocaleString('en-US')}`;

export const usdPlain = (v: number | null | undefined): string =>
    v == null || Number.isNaN(v) ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;

export const fmtVal = (unit: LabUnit, rVal: number | null, usdVal: number | null): string =>
    unit === '$' ? fmtUsd(usdVal) : fmtR(rVal);

// ============================================================================
// NORMALIZACE
// ============================================================================

const isMissed = (t: Trade) => t.executionStatus === 'Missed';

const toNum = (v: any): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
};

const normDirection = (d: any): 'Long' | 'Short' =>
    String(d || '').toUpperCase().startsWith('L') ? 'Long' : 'Short';

const normOutcome = (t: Trade): 'Win' | 'Loss' | 'BE' => {
    if (t.isBE || t.outcome === 'BE') return 'BE';
    const p = t.pnl || 0;
    if (p > 0.01) return 'Win';
    if (p < -0.01) return 'Loss';
    return 'BE';
};

const dayKeyOf = (d: Date): string => {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const cfVariantOf = (raw: any): CfVariantValue => {
    if (!raw) return { fixedR: null, trailR: null, outcome: null, rr: null };
    return {
        fixedR: toNum(raw.realizedR),
        trailR: toNum(raw.trail?.realizedR),
        outcome: raw.outcome ?? null,
        rr: toNum(raw.rr),
    };
};

/** Denní bias z ranního prepu — pro odvození biasAligned u live obchodů,
 *  které nemají bias zapsaný přímo (ten píše jen AlphaBridge/backtest). */
export interface PrepBiasDay {
    date: string; // YYYY-MM-DD
    bias?: string | null; // 'Bullish' | 'Neutral' | 'Bearish'
    sessions?: Array<{ label?: string | null; bias?: string | null }>;
}

/** Bullish→Long, Bearish→Short, jinak null. */
const biasToDirection = (b?: string | null): 'Long' | 'Short' | null => {
    const s = String(b || '').toLowerCase();
    if (s === 'bullish' || s === 'long') return 'Long';
    if (s === 'bearish' || s === 'short') return 'Short';
    return null;
};

const normalizeLabTrade = (t: Trade, prepByDay?: Map<string, PrepBiasDay>): LabTrade => {
    const exit = new Date(t.date);
    const entry = t.entryTime ? new Date(t.entryTime) : (t.entryDate ? new Date(t.entryDate) : exit);
    const risk = t.riskAmount && t.riskAmount > 0 ? t.riskAmount : null;
    const pnl = t.pnl || 0;
    const dayKey = dayKeyOf(exit);
    const direction = normDirection(t.direction);

    // ── Bias: přednost má bias zapsaný u obchodu (AlphaBridge/backtest);
    //    když chybí, odvodí se z ranního prepu (session karta > denní bias). ──
    let sessionBias: string | null = t.sessionBias || null;
    let biasAligned: boolean | null = t.biasAligned == null ? null : t.biasAligned;
    let biasSource: LabTrade['biasSource'] = (sessionBias != null || biasAligned != null) ? 'trade' : null;
    if (biasSource == null && prepByDay) {
        const prep = prepByDay.get(dayKey);
        if (prep) {
            const sessCard = t.session
                ? (prep.sessions || []).find(s => String(s.label || '').trim().toLowerCase() === String(t.session).trim().toLowerCase())
                : undefined;
            const rawBias = (sessCard?.bias || prep.bias) ?? null;
            const biasDir = biasToDirection(rawBias);
            if (biasDir) {
                sessionBias = biasDir;
                biasAligned = direction === biasDir;
                biasSource = 'prep';
            } else if (String(rawBias || '').toLowerCase() === 'neutral') {
                sessionBias = 'Neutral';
                biasSource = 'prep';
            }
        }
    }

    // Counterfactual — jen když AlphaBridge blob existuje a je aspoň 1 varianta.
    const cfRaw: any = t.counterfactual;
    let cf: LabTrade['cf'] = null;
    if (cfRaw && cfRaw.available) {
        const swing = cfVariantOf(cfRaw.swing);
        const ote = cfVariantOf(cfRaw.ote);
        const fvg = cfVariantOf(cfRaw.fvg);
        if (swing.fixedR != null || ote.fixedR != null || fvg.fixedR != null) {
            // Nejlepší TP target zpětně (nejvyšší realizované R přes tpTargets).
            let tpBest: { label: string; r: number } | null = null;
            if (Array.isArray(cfRaw.tpTargets)) {
                for (const tgt of cfRaw.tpTargets) {
                    const rv = toNum(tgt?.realizedR);
                    if (rv == null) continue;
                    if (!tpBest || rv > tpBest.r) tpBest = { label: String(tgt.label || '?').replace(/\s*\[.*?\]\s*$/, ''), r: rv };
                }
            }
            cf = { swing, ote, fvg, tpBest };
        }
    }

    const excRaw: any = t.excursion;
    let exc: LabTrade['exc'] = null;
    if (excRaw && excRaw.available) {
        const reached = Array.isArray(excRaw.levels) ? excRaw.levels.filter((l: any) => l?.reached) : [];
        const top = reached.length ? reached.reduce((m: any, l: any) => (toNum(l.r) ?? -Infinity) > (toNum(m.r) ?? -Infinity) ? l : m, reached[0]) : null;
        exc = {
            mfePotR: toNum(excRaw.mfePotentialR),
            tpR: toNum(excRaw.tpR),
            leftR: toNum(excRaw.leftOnTableR),
            topReached: top ? String(top.label || '').replace(/\s*\[.*?\]\s*$/, '') : null,
        };
    }

    return {
        id: t.id,
        accountId: String(t.accountId),
        date: t.date,
        ts: t.timestamp || exit.getTime(),
        dayKey,
        hour: Number.isNaN(entry.getTime()) ? null : entry.getHours(),
        entryTs: Number.isNaN(entry.getTime()) ? null : entry.getTime(),
        session: t.session || null,
        instrument: t.instrument || t.symbol || null,
        direction,
        outcome: normOutcome(t),
        pnl,
        risk,
        r: risk ? pnl / risk : null,
        mfeR: toNum(t.mfeR),
        maeR: toNum(t.maeR),
        durationMinutes: t.durationMinutes || null,
        slPlacement: t.slPlacement || null,
        targetType: t.targetType || null,
        targetLevel: t.targetLevel || null,
        management: t.management || null,
        sessionBias,
        biasAligned,
        biasSource,
        cf,
        exc,
        emotions: t.emotions || [],
        mistakes: t.mistakes || [],
        notes: t.notes?.trim() || null,
        raw: t,
    };
};

/**
 * Fan-out kopie (stejné rozhodnutí na víc účtech) → 1 datapoint.
 *
 * Klíč skupiny: groupId → masterTradeId → vlastní id (když je obchod master).
 * POŘADÍ JE KRITICKÉ: AlphaBridge fan-out dává masteru groupId (bez masterTradeId)
 * a kopiím groupId + masterTradeId (JINÉ UUID než groupId) — klíčovat masterTradeId
 * dřív než groupId by master a jeho kopie rozdělilo do dvou skupin = každé rozhodnutí
 * započtené 2×. Tradesyncer import groupId nemá (master: isMaster, kopie: masterTradeId
 * = master.id) → spadne správně do masterTradeId/id větví.
 *
 * $ sémantika: reprezentant je master, ale pnl/riskAmount se SČÍTAJÍ přes celou
 * skupinu (reálné dolary rozhodnutí přes všechny účty) — stejně jako collapseCopies
 * v coachTools, ať Lab a coach reportují stejný P&L. R zůstává (Σpnl/Σrisk = R kopie).
 */
export const dedupeDecisions = (trades: Trade[]): Trade[] => {
    const groups = new Map<string, Trade[]>();
    const independent: Trade[] = [];
    for (const t of trades) {
        const key = t.groupId ? `g:${t.groupId}`
            : (t.masterTradeId ? `m:${t.masterTradeId}` : (t.isMaster ? `m:${t.id}` : null));
        if (key) {
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(t);
        } else {
            independent.push(t);
        }
    }
    const out = [...independent];
    groups.forEach(g => {
        const rep = g.find(t => t.isMaster) || g[0];
        if (g.length === 1) { out.push(rep); return; }
        const pnl = g.reduce((s, t) => s + (t.pnl || 0), 0);
        const risk = g.reduce((s, t) => s + (t.riskAmount || 0), 0);
        out.push({ ...rep, pnl, riskAmount: risk > 0 ? risk : rep.riskAmount });
    });
    return out;
};

/** Sdílené sestavení prep vstupů — JEDINÝ zdroj pro LabPage i coach get_lab_analytics
 *  (dřív dvě ručně synchronizované kopie → riziko rozjezdu krmení stejného kódu). */
export const prepBiasFromPreps = (preps: Array<{ date: string; bias?: string | null; scenarios?: { sessions?: Array<{ label?: string | null; bias?: string | null }> } | null }>): PrepBiasDay[] =>
    (preps || []).map(p => ({
        date: p.date,
        bias: p.bias,
        sessions: (p.scenarios?.sessions || []).map(s => ({ label: s.label, bias: s.bias })),
    }));

export const prepDaysFromPreps = (preps: Array<{ date: string; completed?: boolean }>): PrepDayInfo[] =>
    (preps || []).map(p => ({ date: p.date, completed: !!p.completed }));

export interface BuildOpts {
    world: LabWorld;
    /** Omezit na konkrétní účty (jinak všechny účty daného světa). */
    accountIds?: string[];
    /** Ranní prep bias per den — pro live obchody bez biasu zapsaného u obchodu. */
    prepBias?: PrepBiasDay[];
}

/** Dataset přímo z pole obchodů (už vyfiltrovaného volajícím) — dedup + normalizace + pokrytí. */
export const buildLabDatasetFromTrades = (raw: Trade[], world: LabWorld = 'live', prepBias?: PrepBiasDay[]): LabDataset => {
    const clean = raw.filter(t => !isMissed(t) && t.pnl != null && !Number.isNaN(Number(t.pnl)));
    const deduped = dedupeDecisions(clean);
    const prepByDay = prepBias?.length ? new Map(prepBias.map(p => [p.date, p])) : undefined;
    const lab = deduped.map(t => normalizeLabTrade(t, prepByDay)).sort((a, b) => a.ts - b.ts);
    return {
        trades: lab,
        world,
        coverage: {
            rawCount: clean.length,
            total: lab.length,
            withR: lab.filter(t => t.r != null).length,
            withCf: lab.filter(t => t.cf != null).length,
            withExc: lab.filter(t => t.exc != null).length,
            withBias: lab.filter(t => t.biasAligned != null).length,
        },
    };
};

export const buildLabDataset = (trades: Trade[], accounts: Account[], opts: BuildOpts): LabDataset => {
    const isBacktestAcc = (a: Account) => a.type === 'Backtest';
    const worldAccIds = new Set(
        accounts
            .filter(a => opts.world === 'backtest' ? isBacktestAcc(a) : !isBacktestAcc(a))
            .map(a => String(a.id))
    );
    const wanted = opts.accountIds && opts.accountIds.length ? new Set(opts.accountIds.map(String)) : null;

    const raw = trades.filter(t =>
        worldAccIds.has(String(t.accountId)) &&
        (!wanted || wanted.has(String(t.accountId)))
    );

    return buildLabDatasetFromTrades(raw, opts.world, opts.prepBias);
};

// ============================================================================
// PŘEHLED — celkové KPI
// ============================================================================

export interface LabOverview {
    n: number;
    wins: number;
    losses: number;
    be: number;
    winRate: number;         // wins/(wins+losses), BE mimo jmenovatel (konvence appky)
    pnl: number;
    totalR: number | null;   // null když žádný obchod nemá risk
    rCovered: number;
    profitFactor: number | null; // z $ (vždy dostupné); null = žádná ztráta
    avgWinR: number | null;
    avgLossR: number | null;
    bestTrade: LabTrade | null;  // dle R (fallback $)
}

export const computeOverview = (ds: LabDataset): LabOverview => {
    const T = ds.trades;
    const wins = T.filter(t => t.outcome === 'Win');
    const losses = T.filter(t => t.outcome === 'Loss');
    const be = T.filter(t => t.outcome === 'BE');
    const withR = T.filter(t => t.r != null);
    // Ø win/loss R klasifikujeme dle OUTCOME (ne znaménka r) — BE s pnl ±pár $ má
    // r≠0, ale do průměru výher/ztrát nepatří (ředil by je k nule).
    const posR = withR.filter(t => t.outcome === 'Win');
    const negR = withR.filter(t => t.outcome === 'Loss');
    const grossProfit = T.reduce((a, t) => a + Math.max(0, t.pnl), 0);
    const grossLoss = T.reduce((a, t) => a + Math.min(0, t.pnl), 0);
    const sumR = (arr: LabTrade[]) => arr.reduce((a, t) => a + (t.r as number), 0);

    let best: LabTrade | null = null;
    for (const t of T) {
        if (!best) { best = t; continue; }
        const a = t.r ?? -Infinity, b = best.r ?? -Infinity;
        if (a !== b ? a > b : t.pnl > best.pnl) best = t;
    }

    return {
        n: T.length,
        wins: wins.length,
        losses: losses.length,
        be: be.length,
        winRate: winRatePct(wins.length, losses.length),
        pnl: T.reduce((a, t) => a + t.pnl, 0),
        totalR: withR.length ? sumR(withR) : null,
        rCovered: withR.length,
        profitFactor: grossLoss !== 0 ? Math.abs(grossProfit / grossLoss) : null,
        avgWinR: posR.length ? sumR(posR) / posR.length : null,
        avgLossR: negR.length ? sumR(negR) / negR.length : null,
        bestTrade: best,
    };
};

// ============================================================================
// NA STOLE — counterfactual varianty SL × řízení
// ============================================================================

export interface VariantAgg {
    key: 'real' | 'swF' | 'swT' | 'otF' | 'otT' | 'fvF' | 'fvT';
    label: string;
    sub: string;
    isTrail: boolean;
    isReal: boolean;
    /** Σ R přes obchody, kde je varianta validní (non-null). */
    r: number;
    /** Σ R × risk — dolarový ekvivalent. */
    usd: number;
    /** Σ SKUTEČNÉHO R na TĚCH SAMÝCH obchodech (párové srovnání) — jediný fér
     *  protějšek k `r`, protože varianta nemusí být validní u všech obchodů. */
    realR: number;
    realUsd: number;
    n: number;
    wins: number;
}

export interface CfSummary {
    /** Obchodů s cf datovým blobem A riskem (základ srovnání). */
    covered: number;
    total: number;
    real: VariantAgg;
    variants: VariantAgg[];       // 6 counterfactual variant
    bestFixed: VariantAgg | null; // nejlepší fixní-TP varianta dle Σ R
    deltaR: number | null;        // bestFixed.r − real.r
    deltaUsd: number | null;
    /** Srovnání fix vs trail per SL typ — pro insight „set & forget vs trailing". */
    trailPairs: Array<{ name: string; fixedR: number; trailR: number; n: number }>;
    /** Top obchody, kde utekl zisk (exc.leftR > 0.3R). */
    leftOnTable: Array<{ t: LabTrade; gapR: number }>;
    /** Σ leftR přes všechny obchody s pozitivním leftR. */
    leftTotalR: number;
}

const VARIANT_DEFS: Array<{ key: VariantAgg['key']; label: string; sub: string; slKey: 'swing' | 'ote' | 'fvg'; trail: boolean }> = [
    { key: 'swF', label: 'Swing SL', sub: 'fixní TP', slKey: 'swing', trail: false },
    { key: 'swT', label: 'Swing SL', sub: 'trailing', slKey: 'swing', trail: true },
    { key: 'otF', label: 'OTE SL', sub: 'fixní TP', slKey: 'ote', trail: false },
    { key: 'otT', label: 'OTE SL', sub: 'trailing', slKey: 'ote', trail: true },
    { key: 'fvF', label: 'FVG SL', sub: 'fixní TP', slKey: 'fvg', trail: false },
    { key: 'fvT', label: 'FVG SL', sub: 'trailing', slKey: 'fvg', trail: true },
];

export const computeCfSummary = (ds: LabDataset): CfSummary => {
    // Základ: obchody, kde cf existuje A známe risk (jinak nejde R→$ ani fér srovnání).
    const base = ds.trades.filter(t => t.cf != null && t.risk != null);

    const realTotR = base.reduce((a, t) => a + (t.r as number), 0);
    const realTotUsd = base.reduce((a, t) => a + t.pnl, 0);
    const real: VariantAgg = {
        key: 'real', label: 'Tvoje realita', sub: 'skutečnost', isTrail: false, isReal: true,
        r: realTotR,
        usd: realTotUsd,
        realR: realTotR,
        realUsd: realTotUsd,
        n: base.length,
        wins: base.filter(t => t.outcome === 'Win').length,
    };

    const variants: VariantAgg[] = VARIANT_DEFS.map(def => {
        let r = 0, usd = 0, n = 0, wins = 0, realR = 0, realUsd = 0;
        for (const t of base) {
            const v = t.cf![def.slKey];
            const val = def.trail ? v.trailR : v.fixedR;
            if (val == null) continue;
            r += val;
            usd += val * (t.risk as number);
            realR += t.r as number;      // realita na STEJNÉM obchodě (párově)
            realUsd += t.pnl;
            n++;
            if (val > 0) wins++;
        }
        return { key: def.key, label: def.label, sub: def.sub, isTrail: def.trail, isReal: false, r, usd, realR, realUsd, n, wins };
    });

    // Nejlepší fixní varianta dle PÁROVÉ delty (varianta − realita na stejných
    // obchodech). Porovnávat syrová Σ R napříč variantami s různým n by lhalo.
    const fixed = variants.filter(v => !v.isTrail && v.n > 0);
    const bestFixed = fixed.length ? fixed.reduce((m, v) => (v.r - v.realR) > (m.r - m.realR) ? v : m, fixed[0]) : null;

    const trailPairs = (['swing', 'ote', 'fvg'] as const).map((slKey, i) => {
        // Striktně párově: jen obchody, kde existuje fix I trail hodnota téhož SL.
        let f = 0, tr = 0, n = 0;
        for (const t of base) {
            const v = t.cf![slKey];
            if (v.fixedR == null || v.trailR == null) continue;
            f += v.fixedR; tr += v.trailR; n++;
        }
        return { name: variants[i * 2].label, fixedR: f, trailR: tr, n };
    }).filter(p => p.n > 0);

    const leftAll = ds.trades
        .filter(t => t.exc?.leftR != null && (t.exc.leftR as number) > 0)
        .map(t => ({ t, gapR: t.exc!.leftR as number }));
    const leftOnTable = leftAll.filter(x => x.gapR > 0.3).sort((a, b) => b.gapR - a.gapR).slice(0, 3);

    return {
        covered: base.length,
        total: ds.trades.length,
        real,
        variants,
        bestFixed,
        deltaR: bestFixed ? bestFixed.r - bestFixed.realR : null,
        deltaUsd: bestFixed ? bestFixed.usd - bestFixed.realUsd : null,
        trailPairs,
        leftOnTable,
        leftTotalR: leftAll.reduce((a, x) => a + x.gapR, 0),
    };
};

/** Deterministický insight text — trailing vs set & forget (s tolerancí na remízy ±0.05R). */
export const buildTrailInsight = (cf: CfSummary): string | null => {
    if (!cf.trailPairs.length) return null;
    const EPS = 0.05;
    const worse = cf.trailPairs.filter(p => p.trailR < p.fixedR - EPS);
    const better = cf.trailPairs.filter(p => p.trailR > p.fixedR + EPS);
    const parts = cf.trailPairs.map(p => `${p.name} ${fmtR(p.fixedR)}→${fmtR(p.trailR)}`).join(', ');
    if (better.length === 0 && worse.length > 0) {
        return `Trailing výsledek nikde nezlepšil (${worse.length === cf.trailPairs.length ? 'u všech typů SL snížil' : 'snížil nebo nechal stejný'}): ${parts}. Předčasně tě vyhazoval z běžců — set & forget na fixní level byl lepší.`;
    }
    if (worse.length === 0 && better.length > 0) {
        return `Trailing výsledek ${better.length === cf.trailPairs.length ? 'zlepšil u všech typů SL' : 'zlepšil nebo nechal stejný'}: ${parts}. Strukturní trail chránil zisk lépe než fixní TP.`;
    }
    if (worse.length === 0 && better.length === 0) {
        return `Trailing vs. fixní TP prakticky bez rozdílu: ${parts}.`;
    }
    return `Trailing pomohl jen u některých typů SL: ${parts}. Rozhoduje umístění SL — porovnej detail po obchodech.`;
};

/** Deterministický insight — kde utekl zisk (top obchody dle leftOnTableR). */
export const buildLeftInsight = (cf: CfSummary): string | null => {
    if (cf.covered === 0) return null;
    if (!cf.leftOnTable.length) return 'Zisky jsi bral blízko maxima dosahu (MFE) — na stole toho moc nezůstávalo.';
    const items = cf.leftOnTable.map(x => `${fmtDayTime(x.t.date)} (+${r1(x.gapR)}R do MFE)`).join(', ');
    return `Vítězné obchody často zašly dál, než kde jsi vybral zisk — např. ${items}. Celkem zůstalo na stole ${fmtR(cf.leftTotalR)} potenciálu.`;
};

// ============================================================================
// BIAS
// ============================================================================

export interface BiasGroup {
    key: 'aligned' | 'neutral' | 'against';
    label: string;
    n: number;
    r: number | null;   // null když žádný obchod ve skupině nemá risk
    rCovered: number;
    usd: number;
    wins: number;
    winRate: number;
}

export interface BiasSummary {
    groups: BiasGroup[];
    /** Podíl aligned skupiny na celkovém kladném R (0–100), null když nejde spočítat. */
    alignedSharePct: number | null;
    /** Segmenty pro contribution bar — jen skupiny s kladným R. */
    contribution: Array<{ key: BiasGroup['key']; label: string; r: number; pct: number }>;
}

export const computeBiasSummary = (ds: LabDataset): BiasSummary => {
    const mk = (key: BiasGroup['key'], label: string, arr: LabTrade[]): BiasGroup => {
        const withR = arr.filter(t => t.r != null);
        const wins = arr.filter(t => t.outcome === 'Win').length;
        const losses = arr.filter(t => t.outcome === 'Loss').length;
        return {
            key, label,
            n: arr.length,
            r: withR.length ? withR.reduce((a, t) => a + (t.r as number), 0) : null,
            rCovered: withR.length,
            usd: arr.reduce((a, t) => a + t.pnl, 0),
            wins,
            winRate: winRatePct(wins, losses),
        };
    };
    const T = ds.trades;
    const groups = [
        mk('aligned', 'Ve směru biasu', T.filter(t => t.biasAligned === true)),
        mk('neutral', 'Bez biasu', T.filter(t => t.biasAligned == null)),
        mk('against', 'Proti biasu', T.filter(t => t.biasAligned === false)),
    ];

    const positive = groups.filter(g => g.r != null && g.r > 0);
    const posTotal = positive.reduce((a, g) => a + (g.r as number), 0);
    const contribution = posTotal > 0
        ? positive.map(g => ({ key: g.key, label: g.label, r: g.r as number, pct: (g.r as number) / posTotal * 100 }))
        : [];

    const totalR = groups.reduce((a, g) => a + (g.r ?? 0), 0);
    const aligned = groups[0];
    // Clamp 0–100: se zápornou proti-bias skupinou by podíl matematicky přeletěl 100 %.
    const alignedSharePct = aligned.r != null && totalR > 0 ? Math.max(0, Math.min(100, Math.round((aligned.r / totalR) * 100))) : null;

    return { groups, alignedSharePct, contribution };
};

/** Deterministický bias insight — čísla dosazená z agregátů. */
export const buildBiasInsight = (b: BiasSummary): string | null => {
    const [al, ne, ag] = b.groups;
    if (al.n + ag.n === 0) return null;
    const parts: string[] = [];
    if (al.n > 0) {
        parts.push(`Obchody ve směru předem stanoveného biasu (${al.n}) měly ${Math.round(al.winRate)}% win rate a přinesly ${al.r != null ? fmtR(al.r) : usdPlain(al.usd)}${b.alignedSharePct != null ? ` — tedy ${b.alignedSharePct} % celkového výsledku` : ''}.`);
    }
    if (ne.n > 0) {
        parts.push(`${ne.n} obchodů bez biasu: ${ne.r != null ? fmtR(ne.r) : usdPlain(ne.usd)}, ${Math.round(ne.winRate)}% WR.`);
    }
    if (ag.n === 0) {
        parts.push('Proti biasu jsi neobchodoval ani jednou — dobrá disciplína.');
    } else {
        parts.push(`Proti biasu: ${ag.n} obchodů, ${ag.r != null ? fmtR(ag.r) : usdPlain(ag.usd)}, ${Math.round(ag.winRate)}% WR — tohle je tvůj známý leak (bias flip).`);
    }
    return parts.join(' ');
};

// ============================================================================
// SESSIONS
// ============================================================================

export interface SessionRow {
    name: string;
    n: number;
    r: number | null;
    rCovered: number;
    usd: number;
    wins: number;
    winRate: number;
}

export const computeSessionRows = (ds: LabDataset): SessionRow[] => {
    const by = new Map<string, LabTrade[]>();
    for (const t of ds.trades) {
        const k = t.session || 'Bez session';
        if (!by.has(k)) by.set(k, []);
        by.get(k)!.push(t);
    }
    const rows: SessionRow[] = [];
    by.forEach((arr, name) => {
        const withR = arr.filter(t => t.r != null);
        const wins = arr.filter(t => t.outcome === 'Win').length;
        const losses = arr.filter(t => t.outcome === 'Loss').length;
        rows.push({
            name,
            n: arr.length,
            r: withR.length ? withR.reduce((a, t) => a + (t.r as number), 0) : null,
            rCovered: withR.length,
            usd: arr.reduce((a, t) => a + t.pnl, 0),
            wins,
            winRate: winRatePct(wins, losses),
        });
    });
    return rows.sort((a, b) => (b.r ?? b.usd / 1000) - (a.r ?? a.usd / 1000));
};

// ============================================================================
// SDÍLENÉ UI POMOCNÍKY
// ============================================================================

export const fmtDayTime = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const SL_LABELS: Record<string, string> = { swing: 'Swing', ote: 'OTE', fvg: 'FVG', other: 'jiné' };

// ============================================================================
// LEAK DETEKTORY (fáze 2)
//
// Model po vzoru TradesViz AI Coach: každý detektor porovná skupinu obchodů
// (chování) proti zbytku, spočítá dolarový dopad, konfidenci (two-proportion
// z-test win rate) a trend (první vs. druhá polovina historie).
// score = |$ dopad| × váha konfidence × trend multiplikátor.
// Vše deterministické — žádné AI, žádná náhoda.
// ============================================================================

export type LeakConfidence = 'high' | 'medium' | 'low';
export type LeakTrend = 'worsening' | 'improving' | 'stable' | 'new';

export interface LeakFinding {
    id: string;
    title: string;
    category: 'behavior' | 'timing' | 'bias' | 'risk' | 'priprava';
    /** Skóre pro řazení: |$ dopad| × konfidence × trend. */
    score: number;
    /** Odhad, kolik tě pattern stojí v $ vs. tvůj baseline (záporné = stojí peníze). */
    usdImpact: number;
    rImpact: number | null;
    confidence: LeakConfidence;
    /** z-statistika two-proportion testu WR skupiny vs. zbytek (null = málo dat). */
    z: number | null;
    trend: LeakTrend;
    /** Lidsky čitelná čísla — jde 1:1 do UI i do promptu pro coache. */
    statLine: string;
    /** Co detektor měří a proč. */
    detail: string;
    n: number;
    restN: number;
    tradeIds: Array<string | number>;
}

const CONF_WEIGHT: Record<LeakConfidence, number> = { high: 1, medium: 0.6, low: 0.3 };
const TREND_MULT: Record<LeakTrend, number> = { worsening: 1.25, stable: 1, new: 1, improving: 0.75 };
/** Minimální vzorek skupiny, aby detektor vůbec reportoval. */
const LEAK_MIN_SAMPLE = 5;

/** Two-proportion z-test: WR skupiny vs. WR zbytku. */
const twoPropZ = (w1: number, n1: number, w2: number, n2: number): number | null => {
    if (n1 < 3 || n2 < 3) return null;
    const p1 = w1 / n1, p2 = w2 / n2, p = (w1 + w2) / (n1 + n2);
    const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    if (se === 0) return null;
    return (p1 - p2) / se;
};

const confFromZ = (z: number | null): LeakConfidence =>
    z == null ? 'low' : Math.abs(z) >= 1.96 ? 'high' : Math.abs(z) >= 1.645 ? 'medium' : 'low';

/** Trend: dopad na obchod v první vs. druhé polovině historie skupiny. */
const trendOf = (group: LabTrade[], avgRestPnl: number): LeakTrend => {
    if (group.length < 6) return 'new';
    const half = Math.floor(group.length / 2);
    const impactPer = (arr: LabTrade[]) => arr.reduce((a, t) => a + (t.pnl - avgRestPnl), 0) / (arr.length || 1);
    const first = impactPer(group.slice(0, half));
    const second = impactPer(group.slice(half));
    if (second < first - 10) return 'worsening';
    if (second > first + 10) return 'improving';
    return 'stable';
};

/** Postaví LeakFinding ze skupiny vs. zbytku — sdílená kostra všech detektorů. */
const buildFinding = (
    id: string, title: string, category: LeakFinding['category'],
    group: LabTrade[], rest: LabTrade[], detail: string,
    extraStat?: string
): LeakFinding | null => {
    if (group.length < LEAK_MIN_SAMPLE || rest.length < 3) return null;

    const wins = (arr: LabTrade[]) => arr.filter(t => t.outcome === 'Win').length;
    const losses = (arr: LabTrade[]) => arr.filter(t => t.outcome === 'Loss').length;
    const sumPnl = (arr: LabTrade[]) => arr.reduce((a, t) => a + t.pnl, 0);
    // WR i z-test na BE-excluded bázi (konvence appky) — jinak by Lab hlásil jiná
    // procenta než dashboard/coach pro tytéž obchody.
    const gWr = winRatePct(wins(group), losses(group));
    const rWr = winRatePct(wins(rest), losses(rest));
    const avgRestPnl = sumPnl(rest) / rest.length;
    // Dopad: co skupina reálně udělala vs. kdyby ty obchody běžely na tvém baseline.
    const usdImpact = sumPnl(group) - group.length * avgRestPnl;

    const gWithR = group.filter(t => t.r != null);
    const rWithR = rest.filter(t => t.r != null);
    const gAvgR = gWithR.length ? gWithR.reduce((a, t) => a + (t.r as number), 0) / gWithR.length : null;
    const rAvgR = rWithR.length ? rWithR.reduce((a, t) => a + (t.r as number), 0) / rWithR.length : null;
    const rImpact = gAvgR != null && rAvgR != null ? (gAvgR - rAvgR) * group.length : null;

    const z = twoPropZ(wins(group), wins(group) + losses(group), wins(rest), wins(rest) + losses(rest));
    const confidence = confFromZ(z);
    const trend = trendOf(group, avgRestPnl);
    const score = Math.max(0, -usdImpact) * CONF_WEIGHT[confidence] * TREND_MULT[trend];

    const statLine = `${group.length}× · WR ${Math.round(gWr)} % vs. ${Math.round(rWr)} % zbytek · dopad ${fmtUsd(usdImpact)}${gAvgR != null && rAvgR != null ? ` · Ø ${fmtR(gAvgR)} vs. ${fmtR(rAvgR)}` : ''}${extraStat ? ` · ${extraStat}` : ''}`;

    return {
        id, title, category, score, usdImpact, rImpact, confidence, z, trend,
        statLine, detail, n: group.length, restN: rest.length,
        tradeIds: group.map(t => t.id),
    };
};

/** Info o dnech s prep — pro detektor „obchod bez přípravy" (live svět). */
export interface PrepDayInfo { date: string; completed: boolean }

export const detectLeaks = (ds: LabDataset, prepDays?: PrepDayInfo[]): LeakFinding[] => {
    const T = ds.trades; // seřazené vzestupně dle času
    if (T.length < LEAK_MIN_SAMPLE + 3) return [];
    const findings: LeakFinding[] = [];
    const add = (f: LeakFinding | null) => { if (f) findings.push(f); };

    const byDay = new Map<string, LabTrade[]>();
    for (const t of T) {
        if (!byDay.has(t.dayKey)) byDay.set(t.dayKey, []);
        byDay.get(t.dayKey)!.push(t);
    }

    // ── 1. Revenge trading: vstup < 30 min po ztrátě (stejný den) ──────────
    {
        const revenge = new Set<LabTrade>();
        byDay.forEach(day => {
            for (let i = 1; i < day.length; i++) {
                const prev = day[i - 1];
                if (prev.outcome !== 'Loss') continue;
                // ts = EXIT čas (konvence appky) → pro "vstup do 30 min po ztrátě"
                // porovnáváme VSTUP dalšího obchodu (entryTs) s exitem ztráty.
                const gapMin = ((day[i].entryTs ?? day[i].ts) - prev.ts) / 60000;
                if (gapMin >= 0 && gapMin <= 30) revenge.add(day[i]);
            }
        });
        const g = T.filter(t => revenge.has(t));
        add(buildFinding(
            'revenge', 'Rychlý vstup po ztrátě (revenge)', 'behavior',
            g, T.filter(t => !revenge.has(t)),
            'Obchody otevřené do 30 minut po ztrátovém obchodu. Klasický revenge pattern — vstup z frustrace místo ze setupu.'
        ));
    }

    // ── 2. Martingale sizing: risk > 1.5× medián po ztrátě ────────────────
    {
        const risks = T.map(t => t.risk).filter((r): r is number => r != null).sort((a, b) => a - b);
        if (risks.length >= LEAK_MIN_SAMPLE) {
            const median = risks[Math.floor(risks.length / 2)];
            const oversized = new Set<LabTrade>();
            byDay.forEach(day => {
                for (let i = 1; i < day.length; i++) {
                    if (day[i - 1].outcome === 'Loss' && day[i].risk != null && (day[i].risk as number) > median * 1.5) {
                        oversized.add(day[i]);
                    }
                }
            });
            const g = T.filter(t => oversized.has(t));
            add(buildFinding(
                'martingale', 'Zvětšený risk po ztrátě', 'risk',
                g, T.filter(t => !oversized.has(t)),
                `Obchody po ztrátě s riskem > 1.5× tvého mediánu (${usdPlain(median)}). Dohánění ztráty velikostí pozice — martingale chování.`,
                `medián risku ${usdPlain(median)}`
            ));
        }
    }

    // ── 3. Slabé hodiny: hodinové buckety s negativním výsledkem ──────────
    {
        const byHour = new Map<number, LabTrade[]>();
        for (const t of T) {
            if (t.hour == null) continue;
            if (!byHour.has(t.hour)) byHour.set(t.hour, []);
            byHour.get(t.hour)!.push(t);
        }
        let worst: { hour: number; g: LabTrade[]; pnl: number } | null = null;
        byHour.forEach((g, hour) => {
            if (g.length < LEAK_MIN_SAMPLE) return;
            const pnl = g.reduce((a, t) => a + t.pnl, 0);
            if (pnl < 0 && (!worst || pnl < worst.pnl)) worst = { hour, g, pnl };
        });
        if (worst != null) {
            const w = worst as { hour: number; g: LabTrade[]; pnl: number };
            const gSet = new Set(w.g);
            add(buildFinding(
                `weak_hour_${w.hour}`, `Slabá hodina: ${String(w.hour).padStart(2, '0')}:00–${String(w.hour + 1).padStart(2, '0')}:00`, 'timing',
                w.g, T.filter(t => !gSet.has(t)),
                'Hodina vstupu s nejhorším součtem P&L (min. 5 obchodů). Zvaž, jestli v tomhle okně máš reálný edge.'
            ));
        }
    }

    // ── 4. Slabá session ───────────────────────────────────────────────────
    {
        const bySess = new Map<string, LabTrade[]>();
        for (const t of T) {
            const k = t.session || 'Bez session';
            if (!bySess.has(k)) bySess.set(k, []);
            bySess.get(k)!.push(t);
        }
        let worst: { name: string; g: LabTrade[]; pnl: number } | null = null;
        bySess.forEach((g, name) => {
            if (g.length < LEAK_MIN_SAMPLE || bySess.size < 2) return;
            const pnl = g.reduce((a, t) => a + t.pnl, 0);
            if (pnl < 0 && (!worst || pnl < worst.pnl)) worst = { name, g, pnl };
        });
        if (worst != null) {
            const w = worst as { name: string; g: LabTrade[]; pnl: number };
            const gSet = new Set(w.g);
            add(buildFinding(
                `weak_session_${w.name}`, `Slabá session: ${w.name}`, 'timing',
                w.g, T.filter(t => !gSet.has(t)),
                'Session s nejhorším součtem P&L. Jestli tam nemáš edge, zvaž ji vynechat — méně obchodování, víc peněz.'
            ));
        }
    }

    // ── 5. Bias flip: obchody PROTI nastavenému biasu (tvůj známý leak) ────
    {
        const g = T.filter(t => t.biasAligned === false);
        const rest = T.filter(t => t.biasAligned === true);
        const f = buildFinding(
            'bias_flip', 'Obchod proti vlastnímu biasu (bias flip)', 'bias',
            g, rest,
            'Obchody proti biasu, který sis PŘED session sám nastavil. Tvůj pojmenovaný leak — otočka uprostřed session většinou znamená honění ceny.'
        );
        // Bias flip reportujeme i pod prahem vzorku — je to explicitně sledovaný leak.
        if (f) findings.push(f);
        else if (g.length > 0 && rest.length >= 3) {
            const wins = g.filter(t => t.outcome === 'Win').length;
            const pnl = g.reduce((a, t) => a + t.pnl, 0);
            findings.push({
                id: 'bias_flip', title: 'Obchod proti vlastnímu biasu (bias flip)', category: 'bias',
                score: Math.max(0, -pnl) * 0.3,
                usdImpact: pnl, rImpact: null, confidence: 'low', z: null, trend: 'new',
                statLine: `${g.length}× · ${wins} W / ${g.length - wins} L · ${fmtUsd(pnl)} (malý vzorek)`,
                detail: 'Obchody proti biasu, který sis PŘED session sám nastavil. Tvůj pojmenovaný leak — hlídej ho, i když je vzorek zatím malý.',
                n: g.length, restN: rest.length, tradeIds: g.map(t => t.id),
            });
        }
    }

    // ── 6. Bez biasu: obchody bez nastaveného směru ────────────────────────
    {
        const g = T.filter(t => t.biasAligned == null && t.sessionBias == null);
        add(buildFinding(
            'no_bias', 'Obchod bez nastaveného biasu', 'bias',
            g, T.filter(t => t.biasAligned === true),
            'Obchody v session, kde jsi neměl předem daný bias, vs. obchody ve směru biasu. Bez názoru na směr bývá výsledek hod mincí.'
        ));
    }

    // ── 7. Overtrading: 4.+ obchod dne ─────────────────────────────────────
    {
        const late = new Set<LabTrade>();
        byDay.forEach(day => day.forEach((t, i) => { if (i >= 3) late.add(t); }));
        const g = T.filter(t => late.has(t));
        add(buildFinding(
            'overtrading', '4. a další obchod dne (overtrading)', 'behavior',
            g, T.filter(t => !late.has(t)),
            'Obchody od čtvrtého v jednom dni. Pozdní obchody bývají únava, nuda nebo dohánění — porovnej s prvními třemi.'
        ));
    }

    // ── 8. Cold start: první obchod dne ────────────────────────────────────
    {
        const first = new Set<LabTrade>();
        byDay.forEach(day => { if (day.length > 1) first.add(day[0]); });
        // Jen dny s 2+ obchody — jinak „první" nemá s čím srovnat.
        const g = T.filter(t => first.has(t));
        const rest = T.filter(t => !first.has(t) && byDay.get(t.dayKey)!.length > 1);
        add(buildFinding(
            'cold_start', 'První obchod dne (cold start)', 'timing',
            g, rest,
            'První obchod dne vs. další obchody (jen dny s 2+ obchody). Slabý první obchod = vstupuješ dřív, než sis přečetl den.'
        ));
    }

    // ── 9. Bez přípravy: obchod ve dni bez dokončeného prepu (live) ────────
    if (prepDays && prepDays.length > 0) {
        const prepped = new Set(prepDays.filter(p => p.completed).map(p => p.date));
        const g = T.filter(t => !prepped.has(t.dayKey));
        add(buildFinding(
            'no_prep', 'Obchod bez ranní přípravy', 'priprava',
            g, T.filter(t => prepped.has(t.dayKey)),
            'Obchody ve dnech, kdy chyběla dokončená ranní příprava. Měří, kolik tě stojí skipnutý ritual.'
        ));
    }

    return findings.sort((a, b) => b.score - a.score);
};

// ============================================================================
// PSYCHOLOGIE (fáze 3) — emoce/chyby → $ dopad, prep/review korelace
// ============================================================================

export interface TagImpactRow {
    tag: string;
    kind: 'emotion' | 'mistake';
    n: number;
    pnl: number;
    winRate: number;
    avgR: number | null;
    /** Dopad vs. baseline: skupina pnl − n × Ø pnl zbytku (záporné = tag stojí peníze). */
    usdImpact: number;
    tradeIds: Array<string | number>;
}

export interface DayBucket {
    label: string;
    days: number;
    pnl: number;
    avgPnl: number;
    /** Dny s kladným P&L. */
    posDays: number;
}

export interface PsychoSummary {
    tagRows: TagImpactRow[];
    /** DailyPrep.confidence vs. výsledek TÉHOŽ dne. Null = nedost dat. */
    confidence: { buckets: DayBucket[]; coveredDays: number; tradingDays: number } | null;
    /** Checklist sleptWell vs. výsledek dne. */
    sleep: { buckets: DayBucket[]; coveredDays: number } | null;
    /** DailyReview.rating vs. výsledek NÁSLEDUJÍCÍHO obchodního dne (tilt carry-over). */
    ratingNextDay: { buckets: DayBucket[]; coveredDays: number } | null;
    tradingDays: number;
}

/** Minimální počet dní v korelaci, aby se sekce vůbec ukázala. */
const PSYCHO_MIN_DAYS = 4;

export const computePsychoSummary = (
    ds: LabDataset,
    preps: Array<{ date: string; confidence?: number; completed?: boolean; checklist?: { sleptWell?: boolean } }>,
    reviews: Array<{ date: string; rating?: number }>
): PsychoSummary => {
    const T = ds.trades;

    // ── Cena emocí a chyb ───────────────────────────────────────────────────
    const tagRows: TagImpactRow[] = [];
    const collect = (kind: 'emotion' | 'mistake') => {
        const byTag = new Map<string, LabTrade[]>();
        for (const t of T) {
            const tags = kind === 'emotion' ? t.emotions : t.mistakes;
            for (const tag of tags || []) {
                const k = String(tag).trim();
                if (!k) continue;
                if (!byTag.has(k)) byTag.set(k, []);
                byTag.get(k)!.push(t);
            }
        }
        byTag.forEach((group, tag) => {
            if (group.length < 3) return; // pod 3 obchody je to anekdota, ne pattern
            const gSet = new Set(group);
            const rest = T.filter(t => !gSet.has(t));
            if (!rest.length) return;
            const gPnl = group.reduce((a, t) => a + t.pnl, 0);
            const avgRestPnl = rest.reduce((a, t) => a + t.pnl, 0) / rest.length;
            const withR = group.filter(t => t.r != null);
            tagRows.push({
                tag, kind,
                n: group.length,
                pnl: gPnl,
                winRate: winRatePct(group.filter(t => t.outcome === 'Win').length, group.filter(t => t.outcome === 'Loss').length),
                avgR: withR.length ? withR.reduce((a, t) => a + (t.r as number), 0) / withR.length : null,
                usdImpact: gPnl - group.length * avgRestPnl,
                tradeIds: group.map(t => t.id),
            });
        });
    };
    collect('emotion');
    collect('mistake');
    tagRows.sort((a, b) => a.usdImpact - b.usdImpact); // nejdražší nahoře

    // ── Denní P&L mapa ──────────────────────────────────────────────────────
    const dayPnl = new Map<string, number>();
    for (const t of T) dayPnl.set(t.dayKey, (dayPnl.get(t.dayKey) || 0) + t.pnl);
    const tradingDayKeys = Array.from(dayPnl.keys()).sort();

    const mkBuckets = (defs: Array<{ label: string; match: (v: any) => boolean }>, pairs: Array<{ key: any; day: string }>): DayBucket[] =>
        defs.map(def => {
            const days = pairs.filter(p => def.match(p.key));
            const pnl = days.reduce((a, p) => a + (dayPnl.get(p.day) as number), 0);
            return {
                label: def.label,
                days: days.length,
                pnl,
                avgPnl: days.length ? pnl / days.length : 0,
                posDays: days.filter(p => (dayPnl.get(p.day) as number) > 0).length,
            };
        }).filter(b => b.days > 0);

    // ── Confidence z prepu vs. výsledek dne ─────────────────────────────────
    let confidence: PsychoSummary['confidence'] = null;
    {
        const pairs = preps
            .filter(p => p.confidence != null && dayPnl.has(p.date))
            .map(p => ({ key: p.confidence as number, day: p.date }));
        if (pairs.length >= PSYCHO_MIN_DAYS) {
            confidence = {
                buckets: mkBuckets([
                    { label: 'Nízká (< 40)', match: v => v < 40 },
                    { label: 'Střední (40–70)', match: v => v >= 40 && v <= 70 },
                    { label: 'Vysoká (> 70)', match: v => v > 70 },
                ], pairs),
                coveredDays: pairs.length,
                tradingDays: tradingDayKeys.length,
            };
        }
    }

    // ── Spánek (checklist) vs. výsledek dne ─────────────────────────────────
    let sleep: PsychoSummary['sleep'] = null;
    {
        const pairs = preps
            .filter(p => p.checklist?.sleptWell != null && dayPnl.has(p.date))
            .map(p => ({ key: !!p.checklist!.sleptWell, day: p.date }));
        if (pairs.length >= PSYCHO_MIN_DAYS) {
            sleep = {
                buckets: mkBuckets([
                    { label: 'Vyspalý', match: v => v === true },
                    { label: 'Nevyspalý', match: v => v === false },
                ], pairs),
                coveredDays: pairs.length,
            };
        }
    }

    // ── Rating večerního auditu vs. NÁSLEDUJÍCÍ obchodní den ────────────────
    let ratingNextDay: PsychoSummary['ratingNextDay'] = null;
    {
        const pairs: Array<{ key: number; day: string }> = [];
        for (const rv of reviews) {
            if (rv.rating == null || rv.rating <= 0) continue;
            const next = tradingDayKeys.find(d => d > rv.date);
            if (next) pairs.push({ key: rv.rating, day: next });
        }
        if (pairs.length >= PSYCHO_MIN_DAYS) {
            ratingNextDay = {
                buckets: mkBuckets([
                    { label: 'Po dni 1–2 ★', match: v => v <= 2 },
                    { label: 'Po dni 3 ★', match: v => v === 3 },
                    { label: 'Po dni 4–5 ★', match: v => v >= 4 },
                ], pairs),
                coveredDays: pairs.length,
            };
        }
    }

    return { tagRows, confidence, sleep, ratingNextDay, tradingDays: tradingDayKeys.length };
};

// ============================================================================
// LAB REPORT PRO AI COACHE — strukturovaný JSON přesně z UI výpočtů.
// Coach ho dostane přes tool get_lab_analytics; čísla NIKDY nepočítá sám.
// ============================================================================

const round2 = (v: number | null | undefined): number | null =>
    v == null || Number.isNaN(v) ? null : Math.round(v * 100) / 100;

export const buildLabReport = (ds: LabDataset, section: string = 'all', prepDays?: PrepDayInfo[]): any => {
    const want = (s: string) => section === 'all' || section === s;
    const out: any = {
        _pozn: 'Deterministická čísla ze záložky Lab (stejný kód jako UI). Cituj přesně, nepřepočítávej. R = násobky risku.',
        svet: ds.world,
        pokryti: {
            obchodu_po_dedupu: ds.coverage.total,
            s_riskem_R: ds.coverage.withR,
            s_counterfactual: ds.coverage.withCf,
            s_excursion: ds.coverage.withExc,
            s_biasem: ds.coverage.withBias,
        },
    };
    if (ds.coverage.total === 0) return { ...out, _pozn: 'Žádné obchody v aktuálním světě/filtru.' };

    if (want('overview')) {
        const ov = computeOverview(ds);
        out.overview = {
            n: ov.n, wins: ov.wins, losses: ov.losses, be: ov.be,
            winrate_pct: Math.round(ov.winRate),
            pnl_usd: round2(ov.pnl),
            total_R: round2(ov.totalR),
            profit_factor: round2(ov.profitFactor),
            avg_win_R: round2(ov.avgWinR),
            avg_loss_R: round2(ov.avgLossR),
        };
    }

    if (want('counterfactual')) {
        const cf = computeCfSummary(ds);
        out.counterfactual = cf.covered === 0
            ? { _pozn: 'Žádný obchod nemá counterfactual data (sbírá je AlphaBridge).' }
            : {
                _pozn: 'Každá varianta je PÁROVÉ srovnání: R varianty vs. skutečné R na TĚCH SAMÝCH obchodech (n se u variant liší — varianta nemusí být u všech obchodů validní). Winrate varianty = podíl obchodů s kladným R varianty.',
                zaklad_obchodu: cf.covered,
                realita: { R: round2(cf.real.r), usd: round2(cf.real.usd), n: cf.real.n, winrate_pct: cf.real.n ? Math.round(cf.real.wins / cf.real.n * 100) : null },
                varianty: cf.variants.map(v => ({
                    varianta: `${v.label} · ${v.sub}`,
                    R: round2(v.r), usd: round2(v.usd), n: v.n,
                    realita_stejne_obchody_R: round2(v.realR),
                    delta_R: round2(v.r - v.realR),
                    winrate_pct: v.n ? Math.round(v.wins / v.n * 100) : null,
                })),
                nejlepsi_fixni: cf.bestFixed ? `${cf.bestFixed.label} · ${cf.bestFixed.sub}` : null,
                na_stole_delta_R: round2(cf.deltaR),
                na_stole_delta_usd: round2(cf.deltaUsd),
                trailing_vs_fix: buildTrailInsight(cf),
                kde_utekl_zisk: buildLeftInsight(cf),
            };
    }

    if (want('bias')) {
        const b = computeBiasSummary(ds);
        out.bias = {
            _pozn: ds.world === 'live'
                ? 'Bias na live odvozen z ranního prepu (session karta > denní Market bias); Neutral/bez prepu = bez biasu.'
                : 'Bias zapsaný u obchodů (AlphaBridge/backtest).',
            skupiny: b.groups.map(g => ({
                skupina: g.label, n: g.n, R: round2(g.r), usd: round2(g.usd), winrate_pct: g.n ? Math.round(g.winRate) : null,
            })),
            podil_aligned_na_vysledku_pct: b.alignedSharePct,
            shrnuti: buildBiasInsight(b),
        };
    }

    if (want('sessions')) {
        out.sessions = computeSessionRows(ds).map(s => ({
            session: s.name, n: s.n, R: round2(s.r), usd: round2(s.usd), winrate_pct: Math.round(s.winRate),
        }));
    }

    if (want('leaks')) {
        const leaks = detectLeaks(ds, prepDays);
        out.leaks = leaks.length === 0
            ? { _pozn: 'Žádný detektor nezabral (nebo málo dat — minimum ~8 obchodů).' }
            : leaks.map(f => ({
                leak: f.title,
                kategorie: f.category,
                dopad_usd: round2(f.usdImpact),
                statistika: f.statLine,
                konfidence: f.confidence,
                z_test: round2(f.z),
                trend: f.trend,
                n: f.n,
            }));
    }

    return out;
};

/** Prompt pro coache ze souhrnu psychologie — čísla dosazená z kódu. */
export const buildPsychoCoachPrompt = (p: PsychoSummary): string => {
    const lines: string[] = ['V Labu (záložka Psychologie) mi vyšla tahle deterministická čísla:'];
    const worstTags = p.tagRows.filter(r => r.usdImpact < 0).slice(0, 3);
    if (worstTags.length) {
        lines.push(`\nNejdražší tagy: ${worstTags.map(r => `„${r.tag}" (${r.kind === 'emotion' ? 'emoce' : 'chyba'}, ${r.n}×, WR ${Math.round(r.winRate)} %, dopad ${fmtUsd(r.usdImpact)})`).join('; ')}.`);
    }
    if (p.confidence) {
        lines.push(`Confidence z ranního prepu vs. den: ${p.confidence.buckets.map(b => `${b.label}: ${b.days} dní, Ø ${fmtUsd(b.avgPnl)}/den`).join(' · ')}.`);
    }
    if (p.sleep) {
        lines.push(`Spánek: ${p.sleep.buckets.map(b => `${b.label}: ${b.days} dní, Ø ${fmtUsd(b.avgPnl)}/den`).join(' · ')}.`);
    }
    if (p.ratingNextDay) {
        lines.push(`Rating večera vs. další den: ${p.ratingNextDay.buckets.map(b => `${b.label}: Ø ${fmtUsd(b.avgPnl)}/den (${b.days} dní)`).join(' · ')}.`);
    }
    lines.push('\nČísla nepřepočítávej — jsou z kódu. Co z toho plyne pro moje rituály a pravidla? Navrhni max. 2 konkrétní změny.');
    return lines.join('\n');
};

// ============================================================================
// EXPERIMENTY (fáze 4) — uzavřená smyčka: leak → pravidlo → měření before/after
// ============================================================================

export interface ExperimentSideStats {
    n: number;
    pnl: number;
    avgPnl: number;
    winRate: number;
    avgR: number | null;
    rCovered: number;
}

export interface ExperimentReport {
    before: ExperimentSideStats;
    after: ExperimentSideStats;
    /** after.n / targetTrades, 0–1 (capnuté). */
    progress: number;
    /** Připraveno k vyhodnocení (after.n >= targetTrades). */
    ready: boolean;
    /** Deterministický verdikt — jen když jsou data na obou stranách. */
    verdict: string | null;
    /** Zlepšení Ø P&L na obchod (after − before), null bez dat. */
    deltaAvgPnl: number | null;
}

const sideStats = (arr: LabTrade[]): ExperimentSideStats => {
    const withR = arr.filter(t => t.r != null);
    const pnl = arr.reduce((a, t) => a + t.pnl, 0);
    return {
        n: arr.length,
        pnl,
        avgPnl: arr.length ? pnl / arr.length : 0,
        winRate: winRatePct(arr.filter(t => t.outcome === 'Win').length, arr.filter(t => t.outcome === 'Loss').length),
        avgR: withR.length ? withR.reduce((a, t) => a + (t.r as number), 0) / withR.length : null,
        rCovered: withR.length,
    };
};

export const computeExperimentReport = (
    ds: LabDataset,
    exp: { startTs: number; targetTrades: number }
): ExperimentReport => {
    const before = sideStats(ds.trades.filter(t => t.ts < exp.startTs));
    const after = sideStats(ds.trades.filter(t => t.ts >= exp.startTs));
    const ready = after.n >= exp.targetTrades;
    const deltaAvgPnl = before.n > 0 && after.n > 0 ? after.avgPnl - before.avgPnl : null;

    let verdict: string | null = null;
    if (before.n >= 3 && after.n >= 3) {
        const wrDelta = after.winRate - before.winRate;
        const dir = (deltaAvgPnl as number) > 5 ? 'ZLEPŠENÍ' : (deltaAvgPnl as number) < -5 ? 'ZHORŠENÍ' : 'BEZE ZMĚNY';
        verdict = `${dir}: Ø P&L na obchod ${fmtUsd(before.avgPnl)} → ${fmtUsd(after.avgPnl)} (${fmtUsd(deltaAvgPnl)}), WR ${Math.round(before.winRate)} % → ${Math.round(after.winRate)} % (${wrDelta >= 0 ? '+' : ''}${Math.round(wrDelta)} pb)${before.avgR != null && after.avgR != null ? `, Ø R ${fmtR(before.avgR)} → ${fmtR(after.avgR)}` : ''}. Vzorek: ${before.n} před / ${after.n} po.`;
    }

    return {
        before, after,
        progress: exp.targetTrades > 0 ? Math.min(1, after.n / exp.targetTrades) : 1,
        ready,
        verdict,
        deltaAvgPnl,
    };
};

/** Prompt pro coache z experimentu — čísla dosazená z kódu. */
export const buildExperimentCoachPrompt = (
    exp: { title: string; hypothesis: string; rule: string; targetTrades: number },
    report: ExperimentReport
): string =>
    `V Labu běží můj experiment „${exp.title}".\n` +
    `- Hypotéza: ${exp.hypothesis}\n- Pravidlo: ${exp.rule}\n` +
    `- Stav: ${report.after.n}/${exp.targetTrades} obchodů po startu\n` +
    `- Před: ${report.before.n} obchodů, Ø ${fmtUsd(report.before.avgPnl)}/obchod, WR ${Math.round(report.before.winRate)} %${report.before.avgR != null ? `, Ø ${fmtR(report.before.avgR)}` : ''}\n` +
    `- Po: ${report.after.n} obchodů, Ø ${fmtUsd(report.after.avgPnl)}/obchod, WR ${Math.round(report.after.winRate)} %${report.after.avgR != null ? `, Ø ${fmtR(report.after.avgR)}` : ''}\n` +
    (report.verdict ? `- Deterministický verdikt: ${report.verdict}\n` : '') +
    `\nČísla nepřepočítávej — jsou z kódu. Řekni mi: drží hypotéza, nebo je vzorek ještě malý na závěr? Mám pravidlo zafixovat do playbooku, upravit, nebo zrušit?`;

/** Prompt pro coache z leak nálezu — čísla dosazená, AI je jen interpretuje. */
export const buildLeakCoachPrompt = (f: LeakFinding): string =>
    `V Labu (záložka Leaky) mi deterministický detektor našel tento pattern:\n\n` +
    `**${f.title}**\n- Statistika: ${f.statLine}\n- Konfidence: ${f.confidence}${f.z != null ? ` (z=${f.z.toFixed(2)})` : ''} · trend: ${f.trend}\n- Co měří: ${f.detail}\n- Trade IDs: ${f.tradeIds.slice(0, 12).join(', ')}${f.tradeIds.length > 12 ? '…' : ''}\n\n` +
    `Čísla neověřuj ani nepřepočítávej — jsou z kódu. Pomoz mi: 1) projít ty konkrétní obchody a najít společný spouštěč, 2) navrhnout jedno konkrétní pravidlo do playbooku, které tenhle leak utne.`;
