import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { Time } from 'lightweight-charts';

/** ChartView can dispose an instance before its replacement calls onReady. */
export function readInteractivePriceScale(api: ChartViewApi | null) {
  if (!api) return null;
  try {
    const scale = api.controller.getChart().priceScale('right');
    const width = scale.width();
    return Number.isFinite(width) ? { scale, width: Math.max(64, width) } : null;
  } catch {
    return null;
  }
}

/** Ignore a queued UI gesture if the captured chart has already been replaced. */
export function zoomInteractivePriceScale(api: ChartViewApi, current: ChartViewApi | null, delta: number): boolean {
  if (current !== api || !Number.isFinite(delta) || delta === 0) return false;
  const live = readInteractivePriceScale(current);
  if (!live) return false;
  try {
    const range = live.scale.getVisibleRange();
    if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.to <= range.from) return false;
    const center = (range.from + range.to) / 2;
    const nextSpan = Math.max(5, Math.min(20_000, (range.to - range.from) * Math.exp(Math.max(-0.24, Math.min(0.24, delta * 0.0015)))));
    if (live.scale.options().autoScale) live.scale.setAutoScale(false);
    live.scale.setVisibleRange({ from: center - nextSpan / 2, to: center + nextSpan / 2 });
    return true;
  } catch {
    return false;
  }
}

export function resetInteractivePriceScale(api: ChartViewApi | null): boolean {
  const live = readInteractivePriceScale(api);
  if (!live) return false;
  try { live.scale.setAutoScale(true); return true; } catch { return false; }
}

/** onReady may precede setData, and a queued restore may outlive its chart. */
export function restoreInteractiveTimeRange(api: ChartViewApi, current: ChartViewApi | null, range: { from: Time; to: Time }): boolean {
  if (api !== current) return false;
  try {
    const scale = api.controller.getChart().timeScale();
    if (!scale.getVisibleRange()) return false;
    scale.setVisibleRange(range);
    return true;
  } catch { return false; }
}
