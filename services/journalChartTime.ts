import type { MarketCandle } from './marketData';

type CandleTime = Pick<MarketCandle, 'time'>;
export interface JournalCandleCoverage { candles: readonly CandleTime[]; intervalSeconds: number }
export interface JournalTimeSpan {
  from: number; to: number; fromLogical: number; toLogical: number;
  leftBreak: boolean; rightBreak: boolean;
}

/** Fractional time inside an observed candle. The end is exclusive: a missing
 * following candle must not borrow the next actual bar's timestamp. */
export function journalTimeLogical(candles: readonly CandleTime[], atMs: number, intervalSeconds: number): number | null {
  if (!candles.length || !Number.isFinite(atMs) || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return null;
  const time = atMs / 1000;
  let low = 0; let high = candles.length - 1;
  while (low <= high) { const mid = (low + high) >>> 1; if (candles[mid].time <= time) low = mid + 1; else high = mid - 1; }
  if (high < 0) return null;
  const offset = (time - candles[high].time) / intervalSeconds;
  return offset >= 0 && offset < 1 ? high + offset : null;
}

/** Interpolate screen coordinates through integer slots. Never interpolate prices. */
export function journalLogicalCoordinate(logical: number | null, coordinate: (index: number) => number | null): number | null {
  if (logical == null || !Number.isFinite(logical)) return null;
  const index = Math.floor(logical), left = coordinate(index);
  if (left == null || !Number.isFinite(left)) return null;
  const fraction = logical - index;
  if (fraction === 0) return left;
  const right = coordinate(index + 1);
  return right == null || !Number.isFinite(right) ? null : left + (right - left) * fraction;
}

/** Build once per candle set, not once per paint/event. Gaps may mean missing
 * data or a market break; this mapper does not infer which. */
export function createJournalTimeProjection(candles: readonly CandleTime[], intervalSeconds: number, source?: JournalCandleCoverage) {
  const coverage = source ? createJournalTimeProjection(source.candles, source.intervalSeconds) : null;
  const runs: Array<{ from: number; to: number; first: number; last: number }> = [];
  const intervalMs = intervalSeconds * 1000;
  let valid = Number.isFinite(intervalMs) && intervalMs > 0;
  for (let index = 0; valid && index < candles.length; index++) {
    const from = candles[index].time * 1000;
    if (!Number.isFinite(from) || (index > 0 && from < candles[index - 1].time * 1000 + intervalMs)) { valid = false; break; }
    const previous = runs.at(-1);
    if (previous?.to === from) { previous.to = from + intervalMs; previous.last = index; }
    else runs.push({ from, to: from + intervalMs, first: index, last: index });
  }
  const point = (at: number): number | null => valid && (!coverage || coverage.point(at) != null) ? journalTimeLogical(candles, at, intervalSeconds) : null;
  const spans = (from: number, to: number, gaps: readonly { from: number; to?: number | null }[] = []): JournalTimeSpan[] => {
    if (!valid || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
    if (gaps.some(gap => !Number.isFinite(gap.from) || (gap.to != null && (!Number.isFinite(gap.to) || gap.to < gap.from)))) return [];
    const result: JournalTimeSpan[] = [];
    for (const run of runs) {
      if (run.to <= from) continue;
      if (run.from >= to) break;
      let parts = [{ from: Math.max(from, run.from), to: Math.min(to, run.to) }];
      for (const gap of gaps) parts = parts.flatMap(part => {
        if (gap.from >= part.to || (gap.to ?? Infinity) <= part.from || gap.to === gap.from) return [part];
        return [...(gap.from > part.from ? [{ from: part.from, to: gap.from }] : []),
          ...((gap.to ?? Infinity) < part.to ? [{ from: gap.to!, to: part.to }] : [])];
      });
      for (const part of parts) if (part.to > part.from) result.push({ ...part,
        fromLogical: run.first + (part.from - run.from) / intervalMs,
        toLogical: run.first + (part.to - run.from) / intervalMs,
        leftBreak: part.from > from, rightBreak: part.to < to });
    }
    return coverage ? result.flatMap(span => coverage.spans(span.from, span.to).map(part => ({
      from: part.from, to: part.to,
      fromLogical: span.fromLogical + (part.from - span.from) / intervalMs,
      toLogical: span.fromLogical + (part.to - span.from) / intervalMs,
      leftBreak: span.leftBreak || part.from > span.from, rightBreak: span.rightBreak || part.to < span.to,
    }))) : result;
  };
  return { point, spans };
}

/** A small visual cut distinguishes disjoint ranges on a compressed trading
 * axis. Exact event markers still use point(), without this presentation cut. */
export function journalSpanCoordinates(span: JournalTimeSpan, coordinate: (index: number) => number | null): { left: number; right: number } | null {
  const left = journalLogicalCoordinate(span.fromLogical, coordinate), right = journalLogicalCoordinate(span.toLogical, coordinate);
  if (left == null || right == null || right <= left) return null;
  const cut = Math.min(3, (right - left) / 4);
  return { left: left + (span.leftBreak ? cut : 0), right: right - (span.rightBreak ? cut : 0) };
}
