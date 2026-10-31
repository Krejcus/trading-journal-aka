interface WindowBounds { start: number; end: number }

/** Study input follows the viewed past, with its warm-up before the left edge.
 * It never includes a bar after the selected right edge. */
export function indicatorContextWindow(candles: readonly { time: number }[], viewport: { from: number; to: number } | null, context: number, endLimit = candles.length): WindowBounds {
  const limit = Math.min(candles.length, endLimit);
  const find = (time: number, inclusive: boolean) => {
    let lo = 0, hi = limit;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (candles[mid].time < time || (inclusive && candles[mid].time === time)) lo = mid + 1; else hi = mid; }
    return lo;
  };
  if (!viewport) return { start: Math.max(0, limit - context), end: limit };
  const end = find(viewport.to, true);
  return { start: Math.max(0, Math.min(end - context, find(viewport.from, false) - context)), end };
}

/** A shorter replacement must never leave the renderer slicing beyond its data. */
export function renderableCandleWindow(current: WindowBounds, fallback: WindowBounds, count: number): WindowBounds {
  if (count <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, current.start);
  const end = Math.min(count, current.end);
  if (start < end) return start === current.start && end === current.end ? current : { start, end };
  const nextStart = Math.max(0, Math.min(count - 1, fallback.start));
  return { start: nextStart, end: Math.max(nextStart + 1, Math.min(count, fallback.end)) };
}
