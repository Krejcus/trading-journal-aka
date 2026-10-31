import type { ChartLineStyleName } from './chartSettings';

export const EXACT_CROSSHAIR_SYNC_EVENT = 'alphatrade:exact-crosshair-sync';

export interface ExactCrosshairSyncDetail {
  time: number | null;
  price?: number | null;
}

export function dispatchExactCrosshairSync(target: EventTarget, time: number | null, price?: number | null): void {
  target.dispatchEvent(new CustomEvent<ExactCrosshairSyncDetail>(EXACT_CROSSHAIR_SYNC_EVENT, {
    detail: { time, price },
  }));
}

export interface ExactCrosshairPointerInput {
  clientX: number;
  clientY: number;
  chartLeft: number;
  chartTop: number;
  plotLeft: number;
  plotWidth: number;
  plotHeight: number;
}

/** Map the newest physical pointer sample straight into the plot. */
export function exactCrosshairPoint(input: ExactCrosshairPointerInput): { x: number; y: number } | null {
  const { clientX, clientY, chartLeft, chartTop, plotLeft, plotWidth, plotHeight } = input;
  if (![clientX, clientY, chartLeft, chartTop, plotLeft, plotWidth, plotHeight].every(Number.isFinite)) return null;
  if (plotWidth <= 0 || plotHeight <= 0) return null;
  const x = clientX - chartLeft - plotLeft;
  const y = clientY - chartTop;
  return x >= 0 && x <= plotWidth && y >= 0 && y <= plotHeight ? { x, y } : null;
}

export interface ExactCrosshairPositionInput {
  /** Exact local pointer coordinate supplied by the browser. */
  sourceX?: number | null;
  /** Applied chart coordinate used for programmatic/synchronised cursors. */
  fallbackX?: number | null;
  plotWidth: number;
}

/**
 * Lightweight Charts converts the horizontal pointer coordinate to a logical
 * bar index, so even CrosshairMode.Normal lands on the bar centre. Prefer the
 * original DOM coordinate for a physical pointer and retain the library value
 * for synthetic crosshair synchronisation between panes.
 */
export function exactCrosshairX({ sourceX, fallbackX, plotWidth }: ExactCrosshairPositionInput): number | null {
  if (!Number.isFinite(plotWidth) || plotWidth <= 0) return null;
  const candidate = Number.isFinite(sourceX) ? Number(sourceX) : Number.isFinite(fallbackX) ? Number(fallbackX) : null;
  if (candidate === null || candidate < 0 || candidate > plotWidth) return null;
  return candidate;
}

export function exactCrosshairLabelLeft(x: number, plotWidth: number, labelWidth = 128): number {
  const half = Math.max(0, labelWidth / 2);
  if (!Number.isFinite(plotWidth) || plotWidth <= 0) return 0;
  return Math.max(Math.min(half, plotWidth), Math.min(x, Math.max(half, plotWidth - half)));
}

export function exactCrosshairPriceLabelTop(y: number, plotHeight: number, labelHeight = 22): number {
  const half = Math.max(0, labelHeight / 2);
  if (!Number.isFinite(plotHeight) || plotHeight <= 0) return 0;
  return Math.max(0, Math.min(y - half, Math.max(0, plotHeight - labelHeight)));
}

export function crosshairCssLineStyle(style: ChartLineStyleName): 'solid' | 'dotted' | 'dashed' {
  if (style === 'solid') return 'solid';
  if (style === 'dotted' || style === 'sparse-dotted') return 'dotted';
  return 'dashed';
}
