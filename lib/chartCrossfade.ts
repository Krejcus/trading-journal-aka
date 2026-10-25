import type { ChartViewApi } from '@getcandlekit/charts/react';

/**
 * Prolnutí grafu při změně, která graf přestaví (timeframe, trh) nebo skokem
 * přesune záběr (Go To). Dřív graf jen problikl: starý zmizel a nový se
 * kreslil od prázdna. Tady se nad graf položí snímek dosavadního stavu,
 * chvíli drží (nový graf se mezitím vykreslí pod ním) a pak se rozplyne —
 * u Go To s posunem ve směru skoku.
 *
 * Jen vizuální vrstva bez interakce (pointer-events: none) nad plátnem grafu;
 * na data ani na replay nesahá. Bez snímku (rozebraný graf) se nic neděje.
 */

const FADE_MS = 320;
const MAX_HOLD_MS = 700;

export interface ChartCrossfadeOptions {
  /** Posun snímku při rozplynutí (px): záporný = doleva (skok dopředu v čase). */
  slideX?: number;
  /** Jak dlouho snímek drží, než se začne rozplývat. */
  holdMs?: number;
}

export function crossfadeChart(area: HTMLElement | null, api: ChartViewApi | null, options: ChartCrossfadeOptions = {}): void {
  if (!area || !api || typeof document === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  let shot: HTMLCanvasElement;
  let chartRect: DOMRect;
  try {
    const chart = api.controller.getChart();
    shot = chart.takeScreenshot(true, false);
    chartRect = chart.chartElement().getBoundingClientRect();
  } catch {
    return;
  }
  const areaRect = area.getBoundingClientRect();
  if (chartRect.width <= 0 || chartRect.height <= 0) return;
  area.querySelectorAll('[data-chart-crossfade]').forEach(node => node.remove());
  // Ořezový rámeček přes celý panel: snímek (ani jeho posun při Go To) nesmí
  // přetéct — přetečení dalo panelu na okamžik posuvníky a graf se o jejich
  // šířku zmenšil.
  const frame = document.createElement('div');
  frame.setAttribute('data-chart-crossfade', '');
  frame.setAttribute('data-snapshot-hide', '');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none', zIndex: '30' } satisfies Partial<CSSStyleDeclaration>);
  const dpr = window.devicePixelRatio || 1;
  Object.assign(shot.style, {
    position: 'absolute',
    left: `${chartRect.left - areaRect.left}px`,
    top: `${chartRect.top - areaRect.top}px`,
    // Snímek je v pixelech zařízení — 1:1, bez přeškálování.
    width: `${shot.width / dpr}px`,
    height: `${shot.height / dpr}px`,
  } satisfies Partial<CSSStyleDeclaration>);
  frame.appendChild(shot);
  area.appendChild(frame);
  const remove = () => frame.remove();
  if (typeof shot.animate !== 'function') { window.setTimeout(remove, 120); return; }
  const slideX = options.slideX ?? 0;
  const hold = Math.min(MAX_HOLD_MS, Math.max(0, options.holdMs ?? 90));
  const fade = shot.animate([
    { opacity: 1, transform: 'translateX(0)' },
    { opacity: 0, transform: `translateX(${slideX}px)` },
  ], { duration: FADE_MS, delay: hold, easing: 'cubic-bezier(.22, .61, .36, 1)', fill: 'forwards' });
  fade.finished.then(remove, remove);
  // Pojistka pro schovanou záložku (animace bez snímků neskončí).
  window.setTimeout(remove, hold + FADE_MS + 600);
}
