/**
 * Pattern Analysis — deterministická statistika nad trade historií.
 *
 * Vstup: Trade[]
 * Výstup: Insight[] — leaks a strengths s konkrétními akcemi
 *
 * Pravidla pro důvěryhodnost:
 *   - bucket musí mít N ≥ MIN_SAMPLE
 *   - odchylka winrate od baseline ≥ MIN_DEVIATION (procentní body)
 *
 * Bez AI — všechno se počítá lokálně v ~100ms. AI vrstva může nahoru.
 */
import { Trade } from '../types';

// ============================================================================
// CONFIG
// ============================================================================

/** Minimální počet tradů v bucketu, aby se pattern reportoval */
const MIN_SAMPLE = 8;
/** Minimální odchylka winrate od baseline (procentní body), aby se pattern reportoval */
const MIN_DEVIATION = 12;
/** Insighty se rozdělí na leaks (negativní) a strengths (pozitivní) */
const POSITIVE_THRESHOLD = 0;

// ============================================================================
// TYPES
// ============================================================================

export type InsightSeverity = 'leak' | 'strength' | 'info';

export interface Insight {
    id: string;
    severity: InsightSeverity;
    /** Krátký nadpis pro UI kartu */
    title: string;
    /** Dimension — Session, Direction, Time, atd. */
    dimension: string;
    /** Konkrétní hodnota bucketu — "Asia", "Long", "3rd trade", atd. */
    bucketValue: string;
    /** Lidsky čitelná statistika */
    statLine: string;
    /** Návrh akce, kterou trader může udělat */
    actionSuggestion: string;
    /** Raw čísla pro debug / další analýzu */
    metrics: {
        sampleSize: number;
        winRate: number;
        baselineWinRate: number;
        deviation: number; // winRate - baselineWinRate v procentních bodech
        avgPnl: number;
        avgR: number;
        totalPnl: number;
    };
    /** Konkrétní ID tradů co spadají do tohoto bucketu — pro Detail expansion */
    tradeIds: Array<string | number>;
}

interface BucketStats {
    count: number;
    wins: number;
    losses: number;
    totalPnl: number;
    totalR: number;
    rrTrades: number; // tradů co měly riskAmount > 0
    tradeIds: Array<string | number>;
}

// ============================================================================
// HELPERS
// ============================================================================

const isMissed = (t: Trade) => t.executionStatus === 'Missed';

const isWin = (t: Trade) => (t.pnl || 0) > 0.01;
const isLoss = (t: Trade) => (t.pnl || 0) < -0.01;

/** Filtruje jen relevantní trades pro analýzu — bez Missed, bez NaN PnL */
const cleanTrades = (trades: Trade[]): Trade[] =>
    trades.filter(t =>
        !isMissed(t) &&
        typeof t.pnl === 'number' &&
        isFinite(t.pnl)
    );

/** Empty bucket placeholder */
const emptyBucket = (): BucketStats => ({
    count: 0, wins: 0, losses: 0, totalPnl: 0, totalR: 0, rrTrades: 0, tradeIds: []
});

/** Agreguje trades do bucketů podle key extractoru */
function groupBy<K extends string>(
    trades: Trade[],
    keyFn: (t: Trade) => K | null
): Record<K, BucketStats> {
    const buckets: Record<string, BucketStats> = {};
    for (const t of trades) {
        const key = keyFn(t);
        if (!key) continue;
        if (!buckets[key]) buckets[key] = emptyBucket();
        const b = buckets[key];
        b.count++;
        b.totalPnl += t.pnl || 0;
        b.tradeIds.push(t.id);
        if (isWin(t)) b.wins++;
        else if (isLoss(t)) b.losses++;
        if (t.riskAmount && t.riskAmount > 0) {
            b.totalR += (t.pnl || 0) / t.riskAmount;
            b.rrTrades++;
        }
    }
    return buckets as Record<K, BucketStats>;
}

/** Spočítá winRate (0-100). Vrací 0 pokud žádné win/loss tradů (jen BE). */
function winRate(b: BucketStats): number {
    const decisive = b.wins + b.losses;
    return decisive === 0 ? 50 : (b.wins / decisive) * 100;
}

function avgPnl(b: BucketStats): number {
    return b.count === 0 ? 0 : b.totalPnl / b.count;
}

function avgR(b: BucketStats): number {
    return b.rrTrades === 0 ? 0 : b.totalR / b.rrTrades;
}

/** Vytvoří Insight pokud bucket splňuje threshold pravidla */
function maybeInsight(opts: {
    id: string;
    dimension: string;
    bucketValue: string;
    bucket: BucketStats;
    baseline: BucketStats;
    titleLeak: string;
    titleStrength: string;
    actionLeak: string;
    actionStrength: string;
}): Insight | null {
    const { bucket, baseline } = opts;
    if (bucket.count < MIN_SAMPLE) return null;

    const wr = winRate(bucket);
    const baseWr = winRate(baseline);
    const deviation = wr - baseWr;

    if (Math.abs(deviation) < MIN_DEVIATION) return null;

    const severity: InsightSeverity = deviation < POSITIVE_THRESHOLD ? 'leak' : 'strength';
    const aR = avgR(bucket);
    const aPnl = avgPnl(bucket);

    return {
        id: opts.id,
        severity,
        title: severity === 'leak' ? opts.titleLeak : opts.titleStrength,
        dimension: opts.dimension,
        bucketValue: opts.bucketValue,
        statLine: `${bucket.wins}W / ${bucket.losses}L · winrate ${wr.toFixed(0)}% (baseline ${baseWr.toFixed(0)}%) · avg ${aPnl >= 0 ? '+' : ''}$${aPnl.toFixed(0)}${bucket.rrTrades > 0 ? ` · ${aR >= 0 ? '+' : ''}${aR.toFixed(2)}R` : ''}`,
        actionSuggestion: severity === 'leak' ? opts.actionLeak : opts.actionStrength,
        metrics: {
            sampleSize: bucket.count,
            winRate: wr,
            baselineWinRate: baseWr,
            deviation,
            avgPnl: aPnl,
            avgR: aR,
            totalPnl: bucket.totalPnl,
        },
        tradeIds: bucket.tradeIds,
    };
}

// ============================================================================
// PATTERN DETECTORS — 12 dimenzí
// ============================================================================

function detectBySession(trades: Trade[], baseline: BucketStats): Insight[] {
    const buckets = groupBy(trades, t => t.session || null);
    const insights: Insight[] = [];
    for (const [session, bucket] of Object.entries(buckets)) {
        const insight = maybeInsight({
            id: `session_${session}`,
            dimension: 'Session',
            bucketValue: session,
            bucket, baseline,
            titleLeak: `${session} Session = LEAK`,
            titleStrength: `${session} Session = STRENGTH`,
            actionLeak: `Zvaž přeskočit nebo zpřísnit kritéria pro ${session} session.`,
            actionStrength: `${session} je tvůj sweet spot — zvaž víc capital allocation v této session.`,
        });
        if (insight) insights.push(insight);
    }
    return insights;
}

function detectByDirection(trades: Trade[], baseline: BucketStats): Insight[] {
    const buckets = groupBy(trades, t => t.direction || null);
    const insights: Insight[] = [];
    for (const [direction, bucket] of Object.entries(buckets)) {
        const insight = maybeInsight({
            id: `direction_${direction}`,
            dimension: 'Direction',
            bucketValue: direction,
            bucket, baseline,
            titleLeak: `${direction.toUpperCase()} trades = LEAK`,
            titleStrength: `${direction.toUpperCase()} trades = STRENGTH`,
            actionLeak: `Tvůj edge je ve druhém směru. Skip nebo zpřísnit ${direction} setupy.`,
            actionStrength: `${direction} je tvoje silnější strana.`,
        });
        if (insight) insights.push(insight);
    }
    return insights;
}

function detectByDirectionPerSession(trades: Trade[], baseline: BucketStats): Insight[] {
    const buckets = groupBy(trades, t => (t.session && t.direction) ? `${t.session}_${t.direction}` : null);
    const insights: Insight[] = [];
    for (const [key, bucket] of Object.entries(buckets)) {
        const [session, direction] = key.split('_');
        const insight = maybeInsight({
            id: `dirsession_${key}`,
            dimension: 'Session × Direction',
            bucketValue: `${session} ${direction}`,
            bucket, baseline,
            titleLeak: `${session} ${direction.toUpperCase()} = LEAK`,
            titleStrength: `${session} ${direction.toUpperCase()} = STRENGTH`,
            actionLeak: `Skip ${direction} setupy v ${session} session. Druhý směr možná funguje.`,
            actionStrength: `${session} ${direction.toUpperCase()} je tvoje killer kombinace.`,
        });
        if (insight) insights.push(insight);
    }
    return insights;
}

function detectByTimeOfDay(trades: Trade[], baseline: BucketStats): Insight[] {
    const buckets = groupBy(trades, t => {
        const ts = t.entryTime || t.timestamp || new Date(t.date).getTime();
        const h = new Date(ts).getHours();
        if (h < 9) return 'Před 9:00';
        if (h < 12) return '9-12h';
        if (h < 15) return '12-15h';
        if (h < 18) return '15-18h';
        return 'Po 18:00';
    });
    const insights: Insight[] = [];
    for (const [bucket_name, bucket] of Object.entries(buckets)) {
        const insight = maybeInsight({
            id: `time_${bucket_name}`,
            dimension: 'Čas dne',
            bucketValue: bucket_name,
            bucket, baseline,
            titleLeak: `Čas ${bucket_name} = LEAK`,
            titleStrength: `Čas ${bucket_name} = STRENGTH`,
            actionLeak: `Vyhni se tradování v ${bucket_name}. Možná únava nebo špatný flow.`,
            actionStrength: `${bucket_name} je tvůj sweet spot — naplánuj sem hlavní tradování.`,
        });
        if (insight) insights.push(insight);
    }
    return insights;
}

function detectByNthTradeOfDay(trades: Trade[], baseline: BucketStats): Insight[] {
    // Sort trades by timestamp ASC v rámci každého dne, přiřaď index
    const byDay: Record<string, Trade[]> = {};
    for (const t of trades) {
        const day = new Date(t.timestamp || new Date(t.date).getTime()).toISOString().split('T')[0];
        if (!byDay[day]) byDay[day] = [];
        byDay[day].push(t);
    }
    for (const day in byDay) {
        byDay[day].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    }

    const nthBuckets: Record<string, BucketStats> = {};
    for (const day in byDay) {
        byDay[day].forEach((t, idx) => {
            const label = idx === 0 ? '1. trade dne' :
                          idx === 1 ? '2. trade dne' :
                          idx === 2 ? '3. trade dne' :
                          '4+. trade dne';
            if (!nthBuckets[label]) nthBuckets[label] = emptyBucket();
            const b = nthBuckets[label];
            b.count++;
            b.totalPnl += t.pnl || 0;
            b.tradeIds.push(t.id);
            if (isWin(t)) b.wins++;
            else if (isLoss(t)) b.losses++;
            if (t.riskAmount && t.riskAmount > 0) {
                b.totalR += (t.pnl || 0) / t.riskAmount;
                b.rrTrades++;
            }
        });
    }

    const insights: Insight[] = [];
    for (const [label, bucket] of Object.entries(nthBuckets)) {
        const insight = maybeInsight({
            id: `nth_${label}`,
            dimension: 'Pořadí v dni',
            bucketValue: label,
            bucket, baseline,
            titleLeak: `${label} = LEAK`,
            titleStrength: `${label} = STRENGTH`,
            actionLeak: `Po N tradech dne klesá kvalita. Nastavit kill-switch — stop po ${label.charAt(0)} tradech dne.`,
            actionStrength: `Edge se drží i u dalších tradů — disciplína funguje.`,
        });
        if (insight) insights.push(insight);
    }
    return insights;
}

function detectAfterLossStreak(trades: Trade[], baseline: BucketStats): Insight[] {
    // Sort ASC, pro každý trade spočítej kolik losses v řadě bylo PŘED ním (cross-day OK)
    const sorted = [...trades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const buckets: Record<string, BucketStats> = {};
    let streak = 0;

    for (const t of sorted) {
        const label = streak === 0 ? 'Po win/start' :
                      streak === 1 ? 'Po 1 lossu' :
                      streak === 2 ? 'Po 2 lossech' :
                      'Po 3+ lossech';
        if (!buckets[label]) buckets[label] = emptyBucket();
        const b = buckets[label];
        b.count++;
        b.totalPnl += t.pnl || 0;
        b.tradeIds.push(t.id);
        if (isWin(t)) { b.wins++; streak = 0; }
        else if (isLoss(t)) { b.losses++; streak++; }
        if (t.riskAmount && t.riskAmount > 0) {
            b.totalR += (t.pnl || 0) / t.riskAmount;
            b.rrTrades++;
        }
    }

    const insights: Insight[] = [];
    for (const [label, bucket] of Object.entries(buckets)) {
        if (label === 'Po win/start') continue; // baseline-like, skip
        const insight = maybeInsight({
            id: `streak_${label}`,
            dimension: 'Loss streak',
            bucketValue: label,
            bucket, baseline,
            titleLeak: `${label} = REVENGE TRADING`,
            titleStrength: `${label} = COMEBACK strength`,
            actionLeak: `Klasický revenge trade pattern. Add Iron Rule: "Stop trading ${label.toLowerCase()}".`,
            actionStrength: `Nepropadáš emocím po lossech — solidní disciplína.`,
        });
        if (insight) insights.push(insight);
    }
    return insights;
}

function detectByExecutionStatus(trades: Trade[]): Insight[] {
    // Speciální — porovnání Invalid vs Valid uvnitř same dataset
    const valids = trades.filter(t => (t.executionStatus || 'Valid') === 'Valid');
    const invalids = trades.filter(t => t.executionStatus === 'Invalid');
    if (invalids.length < MIN_SAMPLE) return [];

    const validStats = emptyBucket();
    const invalidStats = emptyBucket();
    for (const t of valids) {
        validStats.count++;
        validStats.totalPnl += t.pnl || 0;
        validStats.tradeIds.push(t.id);
        if (isWin(t)) validStats.wins++;
        else if (isLoss(t)) validStats.losses++;
    }
    for (const t of invalids) {
        invalidStats.count++;
        invalidStats.totalPnl += t.pnl || 0;
        invalidStats.tradeIds.push(t.id);
        if (isWin(t)) invalidStats.wins++;
        else if (isLoss(t)) invalidStats.losses++;
    }

    const insight = maybeInsight({
        id: 'execution_invalid',
        dimension: 'Execution Status',
        bucketValue: 'Invalid trades',
        bucket: invalidStats,
        baseline: validStats,
        titleLeak: `Invalid trades = velké LEAK`,
        titleStrength: `Invalid trades = ironicky lepší než Valid?!`,
        actionLeak: `Invalid trades tě stojí $${Math.abs(invalidStats.totalPnl).toFixed(0)}. Pre-trade checklist by je zablokoval.`,
        actionStrength: `Invalid jsou lepší než Valid? Možná tvá pravidla potřebují revizi.`,
    });
    return insight ? [insight] : [];
}

function detectByEmotion(trades: Trade[], baseline: BucketStats): Insight[] {
    // Trade může mít víc emocí — analyzuj per emotion
    const emotionBuckets: Record<string, BucketStats> = {};
    for (const t of trades) {
        const emos = t.emotions || [];
        for (const emo of emos) {
            if (!emotionBuckets[emo]) emotionBuckets[emo] = emptyBucket();
            const b = emotionBuckets[emo];
            b.count++;
            b.totalPnl += t.pnl || 0;
            b.tradeIds.push(t.id);
            if (isWin(t)) b.wins++;
            else if (isLoss(t)) b.losses++;
            if (t.riskAmount && t.riskAmount > 0) {
                b.totalR += (t.pnl || 0) / t.riskAmount;
                b.rrTrades++;
            }
        }
    }
    const insights: Insight[] = [];
    for (const [emotion, bucket] of Object.entries(emotionBuckets)) {
        const insight = maybeInsight({
            id: `emotion_${emotion}`,
            dimension: 'Emoce',
            bucketValue: emotion,
            bucket, baseline,
            titleLeak: `Emoce "${emotion}" = LEAK`,
            titleStrength: `Emoce "${emotion}" = STRENGTH`,
            actionLeak: `Když pociťuješ "${emotion}", trades končí špatně. Detekuj toto stav před entry.`,
            actionStrength: `"${emotion}" mood ti pomáhá. Co tě sem dostává? Replicate it.`,
        });
        if (insight) insights.push(insight);
    }
    return insights;
}

function detectByMistake(trades: Trade[], baseline: BucketStats): Insight[] {
    // Mistake = vždy leak (negativní). Analyzuj frequency a cost.
    const mistakeBuckets: Record<string, BucketStats> = {};
    for (const t of trades) {
        const mistakes = t.mistakes || [];
        for (const m of mistakes) {
            if (!mistakeBuckets[m]) mistakeBuckets[m] = emptyBucket();
            const b = mistakeBuckets[m];
            b.count++;
            b.totalPnl += t.pnl || 0;
            b.tradeIds.push(t.id);
            if (isWin(t)) b.wins++;
            else if (isLoss(t)) b.losses++;
            if (t.riskAmount && t.riskAmount > 0) {
                b.totalR += (t.pnl || 0) / t.riskAmount;
                b.rrTrades++;
            }
        }
    }
    const insights: Insight[] = [];
    for (const [mistake, bucket] of Object.entries(mistakeBuckets)) {
        if (bucket.count < MIN_SAMPLE) continue;
        const wr = winRate(bucket);
        const baseWr = winRate(baseline);
        // Mistakes reportujeme i bez velké deviation pokud frequency je vysoká
        const isFrequent = bucket.count >= MIN_SAMPLE;
        if (!isFrequent) continue;
        const aPnl = avgPnl(bucket);
        const aR = avgR(bucket);
        insights.push({
            id: `mistake_${mistake}`,
            severity: 'leak',
            title: `Chyba "${mistake}" se opakuje`,
            dimension: 'Mistake',
            bucketValue: mistake,
            statLine: `${bucket.count}× výskyt · winrate ${wr.toFixed(0)}% (baseline ${baseWr.toFixed(0)}%) · cost ${bucket.totalPnl >= 0 ? '+' : ''}$${bucket.totalPnl.toFixed(0)}`,
            actionSuggestion: `Nejčastější chyba. Pre-trade checklist: "Nedělám právě '${mistake}'?"`,
            metrics: {
                sampleSize: bucket.count,
                winRate: wr,
                baselineWinRate: baseWr,
                deviation: wr - baseWr,
                avgPnl: aPnl,
                avgR: aR,
                totalPnl: bucket.totalPnl,
            },
            tradeIds: bucket.tradeIds,
        });
    }
    return insights;
}

function detectByConfluenceCount(trades: Trade[], baseline: BucketStats): Insight[] {
    // HTF + LTF confluence — víc confluencí = lepší setup?
    const buckets = groupBy(trades, t => {
        const htf = (t.htfConfluence || []).length;
        const ltf = (t.ltfConfluence || []).length;
        const total = htf + ltf;
        if (total === 0) return 'Bez confluence';
        if (total === 1) return '1 confluence';
        if (total === 2) return '2 confluence';
        return '3+ confluence';
    });
    const insights: Insight[] = [];
    for (const [label, bucket] of Object.entries(buckets)) {
        const insight = maybeInsight({
            id: `confluence_${label}`,
            dimension: 'Confluence count',
            bucketValue: label,
            bucket, baseline,
            titleLeak: `Setupy s "${label}" = LEAK`,
            titleStrength: `Setupy s "${label}" = STRENGTH`,
            actionLeak: `Tyhle setupy nefungují — vyžaduj víc confluencí.`,
            actionStrength: `Více confluencí = lepší výsledky. Filtr: brát jen setupy s ${label.toLowerCase()}.`,
        });
        if (insight) insights.push(insight);
    }
    return insights;
}

function detectByDayOfWeek(trades: Trade[], baseline: BucketStats): Insight[] {
    const dayNames = ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota'];
    const buckets = groupBy(trades, t => {
        const ts = t.timestamp || new Date(t.date).getTime();
        const day = new Date(ts).getDay();
        return dayNames[day];
    });
    const insights: Insight[] = [];
    for (const [day, bucket] of Object.entries(buckets)) {
        const insight = maybeInsight({
            id: `dow_${day}`,
            dimension: 'Den v týdnu',
            bucketValue: day,
            bucket, baseline,
            titleLeak: `${day} = LEAK day`,
            titleStrength: `${day} = STRENGTH day`,
            actionLeak: `${day} ti nesedí. Zvaž paper-trading nebo skip.`,
            actionStrength: `${day} je tvůj best day. Vyšší size?`,
        });
        if (insight) insights.push(insight);
    }
    return insights;
}

function detectByHoldTime(trades: Trade[], baseline: BucketStats): Insight[] {
    const buckets = groupBy(trades, t => {
        const m = t.durationMinutes || 0;
        if (m < 5) return '< 5 min';
        if (m < 15) return '5-15 min';
        if (m < 60) return '15-60 min';
        return '60+ min';
    });
    const insights: Insight[] = [];
    for (const [label, bucket] of Object.entries(buckets)) {
        const insight = maybeInsight({
            id: `hold_${label}`,
            dimension: 'Hold time',
            bucketValue: label,
            bucket, baseline,
            titleLeak: `Holdy ${label} = LEAK`,
            titleStrength: `Holdy ${label} = STRENGTH`,
            actionLeak: `Tyhle holdy nefungují. Možná příliš brzké/pozdní exity.`,
            actionStrength: `${label} je tvůj sweet spot pro hold duration.`,
        });
        if (insight) insights.push(insight);
    }
    return insights;
}

// ============================================================================
// MAIN ANALYZER
// ============================================================================

export interface AnalysisResult {
    insights: Insight[];
    leaks: Insight[];
    strengths: Insight[];
    baseline: {
        totalTrades: number;
        winRate: number;
        avgPnl: number;
        avgR: number;
        totalPnl: number;
    };
    /** Pokud je dat málo, vrátíme tuto zprávu místo insightů */
    insufficientData?: string;
}

const MIN_TOTAL_TRADES = 15;

export function analyzePatterns(allTrades: Trade[]): AnalysisResult {
    const trades = cleanTrades(allTrades);

    if (trades.length < MIN_TOTAL_TRADES) {
        return {
            insights: [], leaks: [], strengths: [],
            baseline: {
                totalTrades: trades.length, winRate: 0, avgPnl: 0, avgR: 0, totalPnl: 0
            },
            insufficientData: `Potřebujeme alespoň ${MIN_TOTAL_TRADES} validních obchodů pro spolehlivou analýzu. Máš jen ${trades.length}.`
        };
    }

    // Baseline = celkový stats nad všemi clean trades
    const baseline = emptyBucket();
    for (const t of trades) {
        baseline.count++;
        baseline.totalPnl += t.pnl || 0;
        baseline.tradeIds.push(t.id);
        if (isWin(t)) baseline.wins++;
        else if (isLoss(t)) baseline.losses++;
        if (t.riskAmount && t.riskAmount > 0) {
            baseline.totalR += (t.pnl || 0) / t.riskAmount;
            baseline.rrTrades++;
        }
    }

    // Spustit všechny detektory
    const allInsights: Insight[] = [
        ...detectBySession(trades, baseline),
        ...detectByDirection(trades, baseline),
        ...detectByDirectionPerSession(trades, baseline),
        ...detectByTimeOfDay(trades, baseline),
        ...detectByNthTradeOfDay(trades, baseline),
        ...detectAfterLossStreak(trades, baseline),
        ...detectByExecutionStatus(trades),
        ...detectByEmotion(trades, baseline),
        ...detectByMistake(trades, baseline),
        ...detectByConfluenceCount(trades, baseline),
        ...detectByDayOfWeek(trades, baseline),
        ...detectByHoldTime(trades, baseline),
    ];

    // Seřadit: leaks podle |deviation| desc, pak strengths
    const leaks = allInsights
        .filter(i => i.severity === 'leak')
        .sort((a, b) => Math.abs(b.metrics.deviation) - Math.abs(a.metrics.deviation));
    const strengths = allInsights
        .filter(i => i.severity === 'strength')
        .sort((a, b) => Math.abs(b.metrics.deviation) - Math.abs(a.metrics.deviation));

    return {
        insights: [...leaks, ...strengths],
        leaks,
        strengths,
        baseline: {
            totalTrades: baseline.count,
            winRate: winRate(baseline),
            avgPnl: avgPnl(baseline),
            avgR: avgR(baseline),
            totalPnl: baseline.totalPnl,
        }
    };
}
