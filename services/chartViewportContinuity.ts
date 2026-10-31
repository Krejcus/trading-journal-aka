import type { ChartViewApi } from '@getcandlekit/charts/react';

export interface AnchoredChartViewport { anchorMs: number; offset: number; span: number; centerMs: number; price?: { from: number; to: number }; priceScaleId?: 'left' | 'right' }
/** Capture fractional bar position, including whitespace; rounded time ranges lose pixels. */
export function captureChartViewport(api: ChartViewApi | null): AnchoredChartViewport | null {
  if (!api) return null;
  try {
    const bars = api.controller.getBars();
    const range = api.controller.getChart().timeScale().getVisibleLogicalRange();
    if (!range || !bars.length || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.to <= range.from) return null;
    const anchor = Math.max(0, Math.min(bars.length - 1, Math.ceil(range.from)));
    const center = Math.max(0, Math.min(bars.length - 1, Math.round((range.from + range.to) / 2)));
    let price: { from: number; to: number } | undefined;
    let priceScaleId: 'left' | 'right' | undefined;
    for (const id of ['right', 'left'] as const) {
      try {
        const scale = api.controller.getChart().priceScale(id);
        const visible = scale.options().visible !== false && !scale.options().autoScale && scale.getVisibleRange();
        if (visible && Number.isFinite(visible.from) && Number.isFinite(visible.to)) { price = visible; priceScaleId = id; break; }
      } catch { /* time continuity still works without that price scale */ }
    }
    return { anchorMs: bars[anchor].ts, offset: range.from - anchor, span: range.to - range.from, centerMs: bars[center].ts, price, priceScaleId };
  } catch { return null; }
}

export function restoreChartViewport(api: ChartViewApi | null, view: AnchoredChartViewport, changedTimeframe = false): boolean {
  if (!api) return false;
  try {
    const bars = api.controller.getBars();
    if (!bars.length) return false;
    const target = changedTimeframe ? view.centerMs : view.anchorMs;
    // The center may lie inside the final coarser bar, after its start time.
    if (target < bars[0].ts || (!changedTimeframe && target > bars[bars.length - 1].ts)) return false;
    let lo = 0, hi = bars.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (bars[mid].ts < target) lo = mid + 1; else hi = mid; }
    if (!changedTimeframe && bars[lo]?.ts !== target) return false;
    const index = changedTimeframe ? Math.max(0, Math.min(bars.length - 1, bars[lo]?.ts === target ? lo : lo - 1)) : lo;
    const from = changedTimeframe ? index - view.span / 2 : index + view.offset;
    api.controller.getChart().timeScale().setVisibleLogicalRange({ from, to: from + view.span });
    if (view.price && !changedTimeframe) {
      const scale = api.controller.getChart().priceScale(view.priceScaleId ?? 'right');
      scale.setAutoScale(false); scale.setVisibleRange(view.price);
    }
    return true;
  } catch { return false; }
}
