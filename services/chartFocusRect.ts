/**
 * Zaostření na vybranou věc v grafu (telefon): okolí ztmavne, vybraná kresba
 * nebo čára zůstane v „okně“. Tady jen výpočet okna ze souřadnic bodů —
 * čistá funkce, vrstva `ChartFocusVeil` ji volá v každém snímku.
 */

export interface FocusPoint {
  /** Souřadnice v okně grafu; `null` = bod je mimo načtená data / mimo měřítko. */
  x: number | null;
  y: number | null;
}

export interface FocusRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Okraj okna kolem kresby (úchyty a štítky se do něj musí vejít). */
export const FOCUS_PADDING_PX = 16;
/** Polovina výšky / šířky pruhu kolem čáry bez plochy. */
export const FOCUS_LINE_BAND_PX = 22;

/** Position box má štítky nad cílem, pod stopem a širší než box sám. */
const POSITION_TOOLS = new Set(['LongPosition', 'ShortPosition']);
export const FOCUS_POSITION_PAD_X_PX = 60;
export const FOCUS_POSITION_PAD_Y_PX = 30;
const FULL_WIDTH_TOOLS = new Set(['HorizontalLine']);
const TO_RIGHT_EDGE_TOOLS = new Set(['HorizontalRay']);
const FULL_HEIGHT_TOOLS = new Set(['VerticalLine']);

const clampRect = (left: number, top: number, right: number, bottom: number, width: number, height: number): FocusRect => {
  const l = Math.max(0, Math.min(width, left));
  const t = Math.max(0, Math.min(height, top));
  return { left: l, top: t, width: Math.max(0, Math.min(width, right) - l), height: Math.max(0, Math.min(height, bottom) - t) };
};

/**
 * Okno kolem kresby. `null` = kresbu nejde umístit (žádný bod nemá cenu v
 * měřítku) — pak se neztmavuje nic, ať graf nezůstane tmavý bez důvodu.
 */
export function focusRectForDrawing(tool: string, points: readonly FocusPoint[], paneWidth: number, paneHeight: number): FocusRect | null {
  if (paneWidth <= 0 || paneHeight <= 0) return null;
  const ys = points.map(point => point.y).filter((y): y is number => y != null && Number.isFinite(y));
  const xs = points.map(point => point.x).filter((x): x is number => x != null && Number.isFinite(x));
  if (FULL_HEIGHT_TOOLS.has(tool)) {
    if (!xs.length) return null;
    return clampRect(xs[0] - FOCUS_LINE_BAND_PX, 0, xs[0] + FOCUS_LINE_BAND_PX, paneHeight, paneWidth, paneHeight);
  }
  if (!ys.length) return null;
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const position = POSITION_TOOLS.has(tool);
  const pad = position ? FOCUS_POSITION_PAD_Y_PX : bottom - top < 1 ? FOCUS_LINE_BAND_PX : FOCUS_PADDING_PX;
  const padX = position ? FOCUS_POSITION_PAD_X_PX : FOCUS_PADDING_PX;
  if (FULL_WIDTH_TOOLS.has(tool)) return clampRect(0, top - pad, paneWidth, bottom + pad, paneWidth, paneHeight);
  // Bod mimo načtená data: vodorovný rozsah neznáme, okno přes celou šířku.
  const unknownX = xs.length < points.length || !xs.length;
  const left = unknownX ? 0 : Math.min(...xs) - padX;
  const right = unknownX || TO_RIGHT_EDGE_TOOLS.has(tool) ? paneWidth : Math.max(...xs) + padX;
  return clampRect(left, top - pad, right, bottom + pad, paneWidth, paneHeight);
}

/** Pruh kolem vodorovné čáry na dané ceně (upozornění). */
export function focusRectForPrice(y: number | null, paneWidth: number, paneHeight: number): FocusRect | null {
  if (y == null || !Number.isFinite(y) || paneWidth <= 0 || paneHeight <= 0) return null;
  return clampRect(0, y - FOCUS_LINE_BAND_PX, paneWidth, y + FOCUS_LINE_BAND_PX, paneWidth, paneHeight);
}
