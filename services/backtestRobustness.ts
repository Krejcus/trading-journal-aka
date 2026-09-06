import type { Trade } from '../types';
import type { BacktestRun } from './backtestTypes';

/** All realized exits of one flat-to-flat position, supplied by the replay ledger. */
export interface BacktestPositionEvidence {
  accountId: string;
  runId: string;
  positionId: string;
  expectedTradeIds: readonly string[];
  /** false also covers an open legacy exposure whose identity cannot establish closure. */
  closed: boolean;
}
export interface BacktestBootstrapOptions {
  unit: 'position' | 'day';
  blockLength: number;
  repetitions: number;
  seed: number;
  confidenceLevel?: number;
}
export interface BacktestRobustnessOptions {
  timeZone: string;
  /** Local wall-clock boundary, minutes after midnight. Day is labelled by its start date. */
  dayStartMinute: number;
  currencyByAccount: Readonly<Record<string, string | undefined>>;
  positionEvidence?: readonly BacktestPositionEvidence[];
  bootstrap?: BacktestBootstrapOptions;
}
export interface BacktestRobustnessMetrics {
  positionN: number;
  tradeN: number;
  netPnl: number;
  expectancy: number | null;
  profitFactor: number | null;
  profitFactorState: 'finite' | 'no-losses' | 'no-results';
  maxDrawdown: number;
}
export interface BacktestRobustnessPosition {
  key: string;
  accountId: string;
  runId: string;
  positionId: string;
  tradeIds: string[];
  netPnl: number;
  closedAt: number;
  /** Whole position assigned to its final exit's local trading day. */
  day: string;
}
export interface BacktestRobustnessScenario extends BacktestRobustnessMetrics {
  id: string;
  kind: 'baseline' | 'positions' | 'days';
  requestedRemoveN: number;
  removedUnitIds: string[];
  removedPositionIds: string[];
  removedTradeIds: string[];
  /** Position counts, even when the removed unit is a day. */
  removedN: number;
  retainedN: number;
}
export interface BacktestRobustnessInterval {
  low: number | null;
  high: number | null;
  lowUnbounded: boolean;
  highUnbounded: boolean;
  validReplicates: number;
  undefinedReplicates: number;
}
export interface BacktestRobustnessBootstrap {
  status: 'ready' | 'insufficient-data';
  reason?: string;
  method: 'circular-block-percentile';
  unit: 'position' | 'day';
  unitN: number;
  blockLength: number;
  /** Number of possible overlapping circular block starting points. Not independent N. */
  sourceBlockN: number;
  drawnBlocksPerReplication: number;
  repetitions: number;
  seed: number;
  confidenceLevel: number;
  drawdownBasis: 'position-close' | 'day-close';
  observed: BacktestRobustnessMetrics;
  sampledPositionN: { min: number; max: number } | null;
  intervals: null | Record<'netPnl' | 'expectancy' | 'profitFactor' | 'maxDrawdown', BacktestRobustnessInterval>;
}
export type BacktestRobustnessExclusionReason = 'missing-run' | 'missing-identity' | 'ambiguous-identity' | 'duplicate-trade'
  | 'invalid-value' | 'unknown-currency' | 'open-position' | 'incomplete-position-selection' | 'invalid-position-member';
export interface BacktestRobustnessReport {
  status: 'ready' | 'empty' | 'mixed-currency';
  currency: string | null;
  currencies: string[];
  inputN: number;
  eligibleTradeN: number;
  excludedN: number;
  exclusions: Array<{ tradeId: string; accountId: string; reason: BacktestRobustnessExclusionReason }>;
  timeZone: string;
  dayStartMinute: number;
  /** Cash P&L is already net of costs; no fee is subtracted again. */
  pnlBasis: 'trade.pnl-net';
  drawdownBasis: 'realized-exit-ledger';
  positions: BacktestRobustnessPosition[];
  baseline: BacktestRobustnessScenario | null;
  scenarios: BacktestRobustnessScenario[];
  bootstrap: BacktestRobustnessBootstrap | null;
  warnings: string[];
}
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value;
const rowKey = (accountId: string, tradeId: string) => JSON.stringify([accountId, tradeId]);
const positionKey = (e: Pick<BacktestPositionEvidence, 'accountId' | 'runId' | 'positionId'>) => JSON.stringify([e.accountId, e.runId, e.positionId]);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const finiteTime = (time: number) => Number.isFinite(time) && time > 0 && time <= 8.64e15;

/** Does not infer position identity from entry timestamps or same-minute fills. */
export function buildBacktestPositionEvidence(runs: readonly Pick<BacktestRun, 'id' | 'accountId' | 'runtimeState'>[]): BacktestPositionEvidence[] {
  const evidence: BacktestPositionEvidence[] = [];
  for (const run of runs) {
    const groups = new Map<string, string[]>();
    for (const trade of run.runtimeState.closedTrades) {
      if (!id(trade.positionId) || trade.runId !== run.id) continue;
      const ids = groups.get(trade.positionId) ?? [];
      ids.push(String(trade.id)); groups.set(trade.positionId, ids);
    }
    for (const [positionId, expectedTradeIds] of groups) evidence.push({ accountId: run.accountId, runId: run.id, positionId,
      expectedTradeIds, closed: !run.runtimeState.positions.some(position => !id(position.positionId) || position.positionId === positionId) });
  }
  return evidence.sort((a, b) => compare(positionKey(a), positionKey(b)));
}

/** DST-safe: compare local clock to the boundary, then move the calendar date, never subtract elapsed UTC hours. */
function tradingDay(timestamp: number, formatter: Intl.DateTimeFormat, boundary: number): string {
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) * 60 + Number(parts.minute) >= boundary) return date;
  const previous = new Date(`${date}T12:00:00.000Z`); previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}
function drawdown(pnls: readonly number[]): number {
  let balance = 0, peak = 0, maximum = 0;
  for (const pnl of pnls) { balance += pnl; peak = Math.max(peak, balance); maximum = Math.max(maximum, peak - balance); }
  return maximum;
}
function metrics(positions: readonly BacktestRobustnessPosition[], equityPnls: readonly number[]): BacktestRobustnessMetrics {
  let netPnl = 0, gains = 0, losses = 0, tradeN = 0;
  for (const position of positions) {
    netPnl += position.netPnl; gains += Math.max(0, position.netPnl); losses += Math.max(0, -position.netPnl); tradeN += position.tradeIds.length;
  }
  return { positionN: positions.length, tradeN, netPnl, expectancy: positions.length ? netPnl / positions.length : null,
    profitFactor: losses ? gains / losses : null, profitFactorState: losses ? 'finite' : gains ? 'no-losses' : 'no-results', maxDrawdown: drawdown(equityPnls) };
}
/** Equal-time exits are one balance event; an arbitrary row ID cannot create a fictitious intraminute drawdown. */
function ledgerPnls(positions: readonly BacktestRobustnessPosition[], rows: ReadonlyMap<string, Trade>): number[] {
  const at = new Map<number, number>();
  for (const position of positions) for (const tradeId of position.tradeIds) {
    const trade = rows.get(rowKey(position.accountId, tradeId))!;
    at.set(trade.timestamp, (at.get(trade.timestamp) ?? 0) + trade.pnl);
  }
  return [...at].sort(([a], [b]) => a - b).map(([, pnl]) => pnl);
}
function randomSequence(seed: number) {
  let value = seed >>> 0;
  return () => { value = (value + 0x6D2B79F5) >>> 0; let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function interval(values: readonly (number | null)[], confidence: number): BacktestRobustnessInterval {
  const sorted = values.filter((value): value is number => value !== null && !Number.isNaN(value)).sort((a, b) => a - b);
  // Empirical inverse CDF / nearest-rank quantiles also preserve an unbounded PF tail.
  const quantile = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  const low = quantile((1 - confidence) / 2), high = quantile(1 - (1 - confidence) / 2);
  return { low: low !== null && Number.isFinite(low) ? low : null, high: high !== null && Number.isFinite(high) ? high : null,
    lowUnbounded: low === Infinity, highUnbounded: high === Infinity, validReplicates: sorted.length, undefinedReplicates: values.length - sorted.length };
}
function bootstrap(positions: readonly BacktestRobustnessPosition[], options: BacktestBootstrapOptions): BacktestRobustnessBootstrap {
  const { unit, blockLength, repetitions, seed } = options;
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  if (!['position', 'day'].includes(unit) || !Number.isInteger(blockLength) || blockLength < 1
    || !Number.isInteger(repetitions) || repetitions < 100 || repetitions > 5_000 || !Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF
    || !Number.isFinite(confidenceLevel) || confidenceLevel < 0.5 || confidenceLevel >= 1) throw new Error('Neplatné nastavení blokového bootstrapu.');
  const dayMap = new Map<string, BacktestRobustnessPosition[]>();
  for (const position of positions) { const group = dayMap.get(position.day) ?? []; group.push(position); dayMap.set(position.day, group); }
  const units = unit === 'position' ? positions.map(position => [position]) : [...dayMap].sort(([a], [b]) => compare(a, b)).map(([, group]) => group);
  const sums = units.map(group => group.reduce((sum, position) => sum + position.netPnl, 0));
  const base: BacktestRobustnessBootstrap = { status: 'insufficient-data', method: 'circular-block-percentile', unit,
    unitN: units.length, blockLength, sourceBlockN: units.length, drawnBlocksPerReplication: Math.ceil(units.length / blockLength), repetitions, seed,
    confidenceLevel, drawdownBasis: unit === 'position' ? 'position-close' : 'day-close', observed: metrics(positions, sums), sampledPositionN: null, intervals: null };
  if (units.length < 2 * blockLength) return { ...base, reason: 'Vzorek musí obsahovat alespoň dva celé bloky zvolené délky. Ani tento počet nepotvrzuje nezávislost.' };
  if (units.length * repetitions > 5_000_000) return { ...base, reason: 'Tento výpočet překračuje lokální limit 5 milionů vzorkovaných jednotek. Sniž počet opakování nebo zvol dny.' };
  const totals = units.map(group => group.reduce((sum, position) => ({
    pnl: sum.pnl + position.netPnl, gains: sum.gains + Math.max(0, position.netPnl), losses: sum.losses + Math.max(0, -position.netPnl), n: sum.n + 1,
  }), { pnl: 0, gains: 0, losses: 0, n: 0 }));
  const random = randomSequence(seed);
  const samples = { netPnl: [] as number[], expectancy: [] as (number | null)[], profitFactor: [] as (number | null)[], maxDrawdown: [] as number[] };
  let minN = Infinity, maxN = 0;
  for (let replication = 0; replication < repetitions; replication += 1) {
    let selectedN = 0, sampledUnits = 0, pnl = 0, gains = 0, losses = 0, peak = 0, maxDD = 0;
    while (sampledUnits < units.length) {
      const start = Math.floor(random() * units.length);
      for (let offset = 0; offset < blockLength && sampledUnits < units.length; offset += 1) {
        const total = totals[(start + offset) % units.length];
        selectedN += total.n; pnl += total.pnl; gains += total.gains; losses += total.losses; sampledUnits += 1;
        peak = Math.max(peak, pnl); maxDD = Math.max(maxDD, peak - pnl);
      }
    }
    minN = Math.min(minN, selectedN); maxN = Math.max(maxN, selectedN);
    samples.netPnl.push(pnl); samples.expectancy.push(selectedN ? pnl / selectedN : null); samples.maxDrawdown.push(maxDD);
    samples.profitFactor.push(losses ? gains / losses : gains ? Infinity : null);
  }
  return { ...base, status: 'ready', sampledPositionN: { min: minN, max: maxN }, intervals: {
    netPnl: interval(samples.netPnl, confidenceLevel), expectancy: interval(samples.expectancy, confidenceLevel),
    profitFactor: interval(samples.profitFactor, confidenceLevel), maxDrawdown: interval(samples.maxDrawdown, confidenceLevel),
  } };
}

/** Descriptive sensitivity and conditional resampling; never mutates the journal or claims independent samples. */
export function computeBacktestRobustness(trades: readonly Trade[], options: BacktestRobustnessOptions): BacktestRobustnessReport {
  if (!Number.isInteger(options.dayStartMinute) || options.dayStartMinute < 0 || options.dayStartMinute > 1439) throw new Error('Neplatný začátek obchodního dne.');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: options.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const exclusions: BacktestRobustnessReport['exclusions'] = [];
  const reject = (trade: Trade, reason: BacktestRobustnessExclusionReason) => exclusions.push({ tradeId: String(trade.id), accountId: trade.accountId, reason });
  const claims = new Map<string, BacktestPositionEvidence[]>();
  const evidenceCounts = new Map<string, number>();
  for (const evidence of options.positionEvidence ?? []) {
    if (!id(evidence.accountId) || !id(evidence.runId) || !id(evidence.positionId) || !Array.isArray(evidence.expectedTradeIds)
      || !evidence.expectedTradeIds.length || !evidence.expectedTradeIds.every(id) || new Set(evidence.expectedTradeIds).size !== evidence.expectedTradeIds.length || typeof evidence.closed !== 'boolean') continue;
    const pk = positionKey(evidence); evidenceCounts.set(pk, (evidenceCounts.get(pk) ?? 0) + 1);
    for (const tradeId of evidence.expectedTradeIds) { const key = rowKey(evidence.accountId, tradeId); const existing = claims.get(key) ?? []; existing.push(evidence); claims.set(key, existing); }
  }
  const count = new Map<string, number>();
  for (const trade of trades) { const key = rowKey(trade.accountId, String(trade.id)); count.set(key, (count.get(key) ?? 0) + 1); }
  const rows = new Map<string, Trade>(); const groups = new Map<string, { evidence: BacktestPositionEvidence; trades: Trade[]; currency: string }>();
  for (const trade of trades) {
    const key = rowKey(trade.accountId, String(trade.id));
    if (count.get(key)! > 1) { reject(trade, 'duplicate-trade'); continue; }
    if (!id(trade.backtestRunId)) { reject(trade, 'missing-run'); continue; }
    const evidence = claims.get(key);
    if (!evidence?.length) { reject(trade, 'missing-identity'); continue; }
    if (evidence.length !== 1 || evidence[0].runId !== trade.backtestRunId || evidenceCounts.get(positionKey(evidence[0])) !== 1) { reject(trade, 'ambiguous-identity'); continue; }
    if (!Number.isFinite(trade.pnl) || !finiteTime(trade.timestamp)) { reject(trade, 'invalid-value'); continue; }
    const currency = options.currencyByAccount[trade.accountId]?.trim().toUpperCase();
    if (!currency || !/^[A-Z]{3}$/.test(currency)) { reject(trade, 'unknown-currency'); continue; }
    rows.set(key, trade);
    const position = positionKey(evidence[0]); const group = groups.get(position) ?? { evidence: evidence[0], trades: [], currency };
    group.trades.push(trade); groups.set(position, group);
  }
  const positions: BacktestRobustnessPosition[] = []; const currencies = new Set<string>();
  for (const [key, group] of groups) {
    const expected = group.evidence.expectedTradeIds;
    const reason = !group.evidence.closed ? 'open-position' : (group.trades.length !== expected.length || expected.some(tradeId => !group.trades.some(trade => String(trade.id) === tradeId)))
      ? expected.some(tradeId => !count.has(rowKey(group.evidence.accountId, tradeId))) ? 'incomplete-position-selection' : 'invalid-position-member' : null;
    if (reason) { for (const trade of group.trades) reject(trade, reason); continue; }
    group.trades.sort((a, b) => a.timestamp - b.timestamp || compare(String(a.id), String(b.id)));
    const closedAt = group.trades[group.trades.length - 1].timestamp;
    positions.push({ key, accountId: group.evidence.accountId, runId: group.evidence.runId, positionId: group.evidence.positionId,
      tradeIds: group.trades.map(trade => String(trade.id)), netPnl: group.trades.reduce((sum, trade) => sum + trade.pnl, 0), closedAt,
      day: tradingDay(closedAt, formatter, options.dayStartMinute) });
    currencies.add(group.currency);
  }
  positions.sort((a, b) => a.closedAt - b.closedAt || compare(a.key, b.key));
  exclusions.sort((a, b) => compare(rowKey(a.accountId, a.tradeId), rowKey(b.accountId, b.tradeId)) || compare(a.reason, b.reason));
  const warnings = [
    'Vzorkem je celá doložená uzavřená pozice. Partial výstupy nejsou další nezávislé vzorky. P&L už zahrnuje náklady.',
    'Pozice přes více dní patří celá dni posledního výstupu. Dny bez uzavřené pozice nejsou ve vzorku; hranice dne je místní čas, datum označuje začátek dne.',
    'DD baseline a citlivosti používá realizované výstupy, stejné timestampy slučuje. Nejde o intrabarový ani účtový drawdown.',
    'Bootstrap zachovává jen závislosti uvnitř zvolených kruhových bloků; konec řady spojuje se začátkem. Neprokazuje nezávislost, stacionaritu ani budoucí výnos.',
    'Percentilové intervaly jsou podmíněné tímto vybraným vzorkem a délkou bloku; neřeší výběr strategie z mnoha pokusů ani neznámé režimy.',
  ];
  if (new Set(positions.map(position => position.runId)).size > 1) warnings.push('Vzorek obsahuje více replay sessions. Opakované přehrání stejného trhu může násobit stejné informace; sessions nejsou automaticky nezávislé.');
  if (options.bootstrap?.blockLength === 1) warnings.push('Délka bloku 1 nezachovává závislost mezi sousedními jednotkami.');
  const report: BacktestRobustnessReport = { status: currencies.size > 1 ? 'mixed-currency' : positions.length ? 'ready' : 'empty',
    currency: currencies.size === 1 ? [...currencies][0] : null, currencies: [...currencies].sort(compare), inputN: trades.length,
    eligibleTradeN: positions.reduce((sum, position) => sum + position.tradeIds.length, 0), excludedN: exclusions.length, exclusions,
    timeZone: options.timeZone, dayStartMinute: options.dayStartMinute, pnlBasis: 'trade.pnl-net', drawdownBasis: 'realized-exit-ledger',
    positions, baseline: null, scenarios: [], bootstrap: null, warnings };
  if (report.status !== 'ready') return report;
  const scenario = (kind: BacktestRobustnessScenario['kind'], requestedRemoveN: number, removedUnitIds: string[]): BacktestRobustnessScenario => {
    const removedSet = new Set(removedUnitIds);
    const removed = positions.filter(position => removedSet.has(kind === 'days' ? position.day : position.key));
    const removedKeys = new Set(removed.map(position => position.key)); const retained = positions.filter(position => !removedKeys.has(position.key));
    return { ...metrics(retained, ledgerPnls(retained, rows)), id: `${kind}-${requestedRemoveN}`, kind, requestedRemoveN, removedUnitIds,
      removedPositionIds: removed.map(position => position.key), removedTradeIds: removed.flatMap(position => position.tradeIds),
      removedN: removed.length, retainedN: retained.length };
  };
  report.baseline = scenario('baseline', 0, []);
  const bestPositions = positions.filter(position => position.netPnl > 0).sort((a, b) => b.netPnl - a.netPnl || compare(a.key, b.key));
  const days = new Map<string, number>();
  for (const position of positions) days.set(position.day, (days.get(position.day) ?? 0) + position.netPnl);
  const bestDays = [...days].filter(([, pnl]) => pnl > 0).sort(([a, ap], [b, bp]) => bp - ap || compare(a, b));
  report.scenarios = [1, 3, 5].flatMap(n => [scenario('positions', n, bestPositions.slice(0, n).map(position => position.key)), scenario('days', n, bestDays.slice(0, n).map(([day]) => day))]);
  report.bootstrap = options.bootstrap ? bootstrap(positions, options.bootstrap) : null;
  return report;
}
