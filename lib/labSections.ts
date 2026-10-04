import type { LabDecision, LabSession } from './labDataset.js';
import type { LabExcursion } from './labExcursion.js';
import type { EntryOrderOutcome } from './entryOrderOutcome.js';
import type { TradeEntryOrder } from './journalEntryOrders.js';
import { labStats, type LabStats, type LabUnit } from './labAnalysis.js';

/**
 * Sekce C–F nového Labu. Co potřebuje svíčky (C, D), dostává výsledky
 * `labExcursion` / `cancelledOrderOutcome` hotové — tady se jen sčítá. Kde
 * data chybí (svíčky až od 26. 9., R jen se SL), vrací se pokrytí.
 */

const median = (values: readonly number[]): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** $ za pohyb v bodech u rozhodnutí (velikost leadera). */
const pointsUsd = (decision: LabDecision, points: number) => decision.pointValue != null ? points * decision.pointValue * decision.size : null;

/** Kdyby obchod zůstal s původním SL/TP: hodnota v $ (TP = odměna, SL = riziko), jinak null. */
export function labHeldValueUsd(decision: LabDecision, excursion: LabExcursion | undefined): number | null {
  if (!excursion || decision.entryPrice == null || decision.sl == null || decision.tp == null) return null;
  if (excursion.heldOutcome === 'tp') return pointsUsd(decision, Math.abs(decision.tp - decision.entryPrice));
  if (excursion.heldOutcome === 'sl') { const risk = pointsUsd(decision, Math.abs(decision.entryPrice - decision.sl)); return risk == null ? null : -risk; }
  return null;
}

// ── C: řízení obchodu ────────────────────────────────────────────────────────

/** SL zadaný později než tolik sekund po vstupu = „pozdní SL“. */
export const LAB_LATE_STOP_SEC = 30;
/** Výstup do tolika bodů od vstupu = výstup na break-even. */
export const LAB_BE_POINTS = 1;

export interface LabManagementSummary {
  /** Obchody, kde SL šel na vstup nebo do zisku. */
  beMoved: LabDecision[];
  /** Z nich vyhozené na BE (výstup SL do 1 bodu od vstupu). */
  beStopped: LabDecision[];
  /** Vyhozené na BE, kde by pak původní plán došel do TP. */
  beThenTp: LabDecision[];
  /** Kolik by vyneslo nechat je s původním SL/TP (odměna TP − skutečný výsledek). */
  beCostUsd: number;
  manual: { decisions: LabDecision[]; averageUsd: number | null; covered: LabDecision[]; heldAverageUsd: number | null; actualCoveredAverageUsd: number | null };
  afterExit: { decisions: LabDecision[]; medianPoints: number | null };
  noStop: { decisions: LabDecision[]; totalUsd: number; avgLossUsd: number | null; avgLossWithStopUsd: number | null; late: LabDecision[] };
  /** Vítězové zavření před plánovaným TP: co by přineslo držet. */
  holdWinners: { decisions: LabDecision[]; extraUsd: number; reversedUsd: number; reversed: number; reached: number };
  /** Rozhodnutí, pro která jsou svíčky (MFE/MAE, po výstupu). */
  withCandles: number;
  withHistory: number;
}

export function labManagement(decisions: readonly LabDecision[], excursions: ReadonlyMap<string, LabExcursion>): LabManagementSummary {
  const ex = (decision: LabDecision) => { const value = excursions.get(decision.id); return value && value.candles > 0 ? value : undefined; };
  const withHistory = decisions.filter(d => d.management != null);
  const beMoved = withHistory.filter(d => d.management!.movedToBreakEven);
  const beStopped = beMoved.filter(d => d.exitKind === 'sl' && d.points != null && Math.abs(d.points) <= LAB_BE_POINTS);
  const beThenTp = beStopped.filter(d => ex(d)?.heldOutcome === 'tp');
  const beCostUsd = beThenTp.reduce((sum, d) => sum + Math.max(0, (labHeldValueUsd(d, ex(d)) ?? 0) - d.pnlUsd), 0);

  const manualList = decisions.filter(d => d.exitKind === 'manual');
  const manualCovered = manualList.filter(d => labHeldValueUsd(d, ex(d)) != null);
  const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

  const afterExitList = decisions.filter(d => ex(d)?.afterExitPoints != null);

  // Bez SL = obchod SL nikdy neměl. Ruční SL po pár sekundách je běžný — „pozdní“ až po 30 s.
  const noStopList = withHistory.filter(d => d.management!.stopDelaySec == null);
  const lateStop = withHistory.filter(d => (d.management!.stopDelaySec ?? 0) > LAB_LATE_STOP_SEC);
  const losses = (list: LabDecision[]) => list.filter(d => d.pnlUsd < 0).map(d => d.pnlUsd);

  const winners = decisions.filter(d => d.pnlUsd > 0 && d.exitKind !== 'tp' && d.tp != null && ex(d)?.heldOutcome != null);
  let extraUsd = 0, reversedUsd = 0, reversed = 0, reached = 0;
  for (const d of winners) {
    const held = labHeldValueUsd(d, ex(d));
    if (held == null) continue;
    if (ex(d)!.heldOutcome === 'tp') { reached += 1; extraUsd += Math.max(0, held - d.pnlUsd); }
    else { reversed += 1; reversedUsd += held - d.pnlUsd; }
  }

  return {
    beMoved, beStopped, beThenTp, beCostUsd,
    manual: {
      decisions: manualList, averageUsd: avg(manualList.map(d => d.pnlUsd)), covered: manualCovered,
      heldAverageUsd: avg(manualCovered.map(d => labHeldValueUsd(d, ex(d))!)),
      actualCoveredAverageUsd: avg(manualCovered.map(d => d.pnlUsd)),
    },
    afterExit: { decisions: afterExitList, medianPoints: median(afterExitList.map(d => ex(d)!.afterExitPoints!)) },
    noStop: {
      decisions: noStopList, totalUsd: noStopList.reduce((sum, d) => sum + d.pnlUsd, 0),
      avgLossUsd: avg(losses(noStopList)), avgLossWithStopUsd: avg(losses(withHistory.filter(d => !noStopList.includes(d)))),
      late: lateStop,
    },
    holdWinners: { decisions: winners, extraUsd, reversedUsd, reversed, reached },
    withCandles: decisions.filter(d => ex(d)).length,
    withHistory: withHistory.length,
  };
}

// ── D: nevzaté obchody ───────────────────────────────────────────────────────

export interface LabUntakenItem {
  id: string;
  order: TradeEntryOrder;
  pointValue: number;
  reason: string | null;
  outcome: EntryOrderOutcome | null;
}

/** Jaký výsledek důvod tvrdí — „trefa“ = výsledek odpovídá důvodu. */
const REASON_EXPECTS: Record<string, (outcome: EntryOrderOutcome) => boolean> = {
  'Cena nedošla': outcome => outcome.kind === 'nofill',
  'Zrušil jsem předčasně': outcome => outcome.kind === 'fill' && outcome.result === 'tp',
  'Setup přestal platit': outcome => outcome.kind === 'nofill' || (outcome.kind === 'fill' && outcome.result === 'sl'),
};

export const labUntakenUsd = (item: LabUntakenItem): number | null => {
  const outcome = item.outcome;
  if (outcome?.kind !== 'fill' || outcome.points == null || item.order.quantity == null) return null;
  return outcome.points * item.order.quantity * item.pointValue;
};

export function labUntaken(items: readonly LabUntakenItem[]) {
  let missed = 0, saved = 0, tp = 0, sl = 0, nofill = 0, unknown = 0;
  for (const item of items) {
    const usd = labUntakenUsd(item);
    if (item.outcome?.kind === 'nofill') nofill += 1;
    else if (item.outcome?.kind === 'fill' && item.outcome.result === 'tp') { tp += 1; missed += usd ?? 0; }
    else if (item.outcome?.kind === 'fill' && item.outcome.result === 'sl') { sl += 1; saved -= usd ?? 0; }
    else unknown += 1;
  }
  const heldMin = (item: LabUntakenItem) => item.order.end ? (item.order.end.at - item.order.placedAt) / 60_000 : null;
  const bucket = (label: string, test: (minutes: number) => boolean) => {
    const list = items.filter(item => { const m = heldMin(item); return m != null && test(m); });
    return { label, items: list, tp: list.filter(i => i.outcome?.kind === 'fill' && i.outcome.result === 'tp').length,
      sl: list.filter(i => i.outcome?.kind === 'fill' && i.outcome.result === 'sl').length,
      nofill: list.filter(i => i.outcome?.kind === 'nofill').length,
      netUsd: -list.reduce((sum, i) => sum + (labUntakenUsd(i) ?? 0), 0) };
  };
  const reasons = new Map<string, { reason: string; items: LabUntakenItem[]; hits: number; judged: number }>();
  for (const item of items) {
    if (!item.reason) continue;
    const row = reasons.get(item.reason) ?? { reason: item.reason, items: [], hits: 0, judged: 0 };
    row.items.push(item);
    const expects = REASON_EXPECTS[item.reason];
    if (expects && item.outcome && !(item.outcome.kind === 'fill' && (item.outcome.result === 'ambiguous' || item.outcome.result === 'open'))) {
      row.judged += 1; if (expects(item.outcome)) row.hits += 1;
    }
    reasons.set(item.reason, row);
  }
  return {
    count: items.length, missed, saved, tp, sl, nofill, unknown,
    /** Správně zrušené = šel by do SL nebo se nevyplnil. */
    correct: sl + nofill,
    buckets: [bucket('do 2 min', m => m < 2), bucket('2–10 min', m => m >= 2 && m < 10), bucket('nad 10 min', m => m >= 10)],
    reasons: [...reasons.values()].sort((a, b) => b.items.length - a.items.length),
    unreviewed: items.filter(item => !item.reason).length,
  };
}

// ── E: čas ───────────────────────────────────────────────────────────────────

export interface LabCell { decisions: LabDecision[]; stats: LabStats }

export function labTime(decisions: readonly LabDecision[], unit: LabUnit) {
  const hours = [...new Set(decisions.map(d => Math.floor(d.entryMinute / 60)))].sort((a, b) => a - b);
  const weekdays = [1, 2, 3, 4, 5];
  const cell = (list: LabDecision[]): LabCell => ({ decisions: list, stats: labStats(list, unit) });
  const heat = weekdays.map(weekday => ({
    weekday,
    cells: hours.map(hour => cell(decisions.filter(d => d.weekday === weekday && Math.floor(d.entryMinute / 60) === hour))),
  }));
  const byHour = hours.map(hour => ({ hour, ...cell(decisions.filter(d => Math.floor(d.entryMinute / 60) === hour)) }));
  const sessions: LabSession[] = ['Asie', 'Londýn', 'NY open', 'NY', 'Mimo'];
  const bySession = sessions.map(session => ({ session, ...cell(decisions.filter(d => d.session === session)) })).filter(row => row.decisions.length);
  const order = [1, 2, 3].map(n => ({ label: `${n}.`, ...cell(decisions.filter(d => d.orderInDay === n)) }));
  order.push({ label: '4. a další', ...cell(decisions.filter(d => d.orderInDay >= 4)) });
  return { hours, heat, byHour, bySession, order };
}

// ── F: setupy ────────────────────────────────────────────────────────────────

/** Kolik obchodů potřebuje kombinace štítků, aby srovnání nebylo šum. */
export const LAB_SETUP_MIN = 30;
/** Jednotlivý štítek se ukáže od tolika obchodů. */
export const LAB_TAG_MIN = 5;

export function labSetups(decisions: readonly LabDecision[], unit: LabUnit) {
  const tagged = decisions.filter(d => d.reviewed && (d.htf.length || d.ltf.length));
  const combos = new Map<string, LabDecision[]>();
  const tags = new Map<string, { tag: string; kind: 'HTF' | 'LTF'; decisions: LabDecision[] }>();
  for (const decision of tagged) {
    const key = [...decision.htf.map(t => `HTF ${t}`), ...decision.ltf.map(t => `LTF ${t}`)].sort().join(' + ');
    combos.set(key, [...(combos.get(key) ?? []), decision]);
    for (const [kind, list] of [['HTF', decision.htf], ['LTF', decision.ltf]] as const) for (const tag of list) {
      const row = tags.get(`${kind}:${tag}`) ?? { tag, kind, decisions: [] };
      row.decisions.push(decision); tags.set(`${kind}:${tag}`, row);
    }
  }
  const comboRows = [...combos.entries()].map(([combo, list]) => ({ combo, decisions: list, stats: labStats(list, unit) }))
    .sort((a, b) => b.decisions.length - a.decisions.length);
  const tagRows = [...tags.values()].map(row => ({ ...row, stats: labStats(row.decisions, unit) }))
    .filter(row => row.decisions.length >= LAB_TAG_MIN)
    .sort((a, b) => (b.stats.average ?? -Infinity) - (a.stats.average ?? -Infinity));
  return {
    tagged: tagged.length,
    largestCombo: comboRows[0]?.decisions.length ?? 0,
    combos: comboRows.filter(row => row.decisions.length >= LAB_SETUP_MIN),
    tags: tagRows,
  };
}

