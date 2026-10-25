import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { Logical } from 'lightweight-charts';

/**
 * Automatický snímek celého obchodu — jako fullscreen jednoho grafu
 * v TradingView. Graf se na okamžik vykreslí ve fullscreen rozměru,
 * obchod (vstup → výstup) se vycentruje se stejnou rezervou před i po,
 * cena se přizpůsobí svíčkám, SL a TP, a pak se všechno vrátí.
 *
 * Rezerva po výstupu: hned po obchodu za výstupem ještě svíčky nejsou —
 * časová osa pokračuje prázdná (bez budoucnosti). Při review později už ji
 * vyplní, co cena udělala potom.
 */

export interface TradeSnapshotInput {
  instrument: string;
  direction: string;
  entryTime: number;
  exitTime: number;
  entryPrice?: number;
  exitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  pnl?: number;
  riskAmount?: number;
}

const CHART_WIDTH = 1600;
const CHART_HEIGHT = 854;
const HEADER_HEIGHT = 46;

/** Rozestup svíček na snímku (px) — stejně velké svíčky u krátkého i delšího obchodu. */
export const SNAPSHOT_BAR_SPACING = 14;
/** Nejmenší rezerva před vstupem a po výstupu (bary), když je obchod dlouhý. */
const MIN_SNAPSHOT_MARGIN = 10;

/**
 * Logický výřez jako v TradingView: pevný rozestup svíček (z šířky grafu
 * vyjde počet barů na snímku) a obchod přesně uprostřed. Oddálí se jen
 * obchod, který by se s rezervou do pevného výřezu nevešel.
 */
export const centeredTradeRange = (entryIndex: number, exitIndex: number, plotWidth = CHART_WIDTH - 80) => {
  const span = Math.max(0, exitIndex - entryIndex);
  const bars = Math.max(Math.round(plotWidth / SNAPSHOT_BAR_SPACING), span + 2 * MIN_SNAPSHOT_MARGIN);
  const middle = (entryIndex + exitIndex) / 2;
  return { from: middle - bars / 2, to: middle + bars / 2 };
};

/** Index posledního baru, který začal nejpozději v daném čase (ms). */
export const barIndexAt = (barStarts: readonly number[], timeMs: number) => {
  let low = 0;
  let high = barStarts.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (barStarts[middle] <= timeMs) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
};

const nextFrame = () => new Promise<void>(resolve => {
  // Schovaná záložka nekreslí snímky — časovač jako záloha.
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  window.requestAnimationFrame(finish);
  window.setTimeout(finish, 50);
});

const finite = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
const price = (value: number | undefined) => (finite(value) ? value.toFixed(2) : '—');

// Focení stejného grafu jde za sebou: souběžné focení (např. dvojí efekt
// v StrictMode) by si jako „původní“ stav přečetlo už přepnutý fullscreen
// a graf by po návratu zůstal na pevné velikosti.
const inflight = new WeakMap<ChartViewApi, Promise<unknown>>();

export function captureTradeChartSnapshot(api: ChartViewApi, trade: TradeSnapshotInput, isDark = true): Promise<string> {
  const previous = inflight.get(api) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => captureNow(api, trade, isDark));
  inflight.set(api, next);
  return next;
}

async function captureNow(api: ChartViewApi, trade: TradeSnapshotInput, isDark: boolean): Promise<string> {
  const chart = api.controller.getChart();
  const series = api.controller.getSeries();
  const timeScale = chart.timeScale();
  const priceScale = chart.priceScale('right');
  const bars = api.controller.getBars();
  if (!bars.length) throw new Error('Graf ještě nemá svíčky.');
  const starts = bars.map(bar => bar.ts);
  const entryIndex = barIndexAt(starts, trade.entryTime);
  const exitIndex = Math.max(entryIndex, barIndexAt(starts, trade.exitTime));
  if (entryIndex < 0) throw new Error('Vstup obchodu není v načtených datech grafu.');
  const range = centeredTradeRange(entryIndex, exitIndex);

  const element = chart.chartElement();
  const host = element.parentElement;
  const hostRect = host?.getBoundingClientRect();
  const autoSize = chart.options().autoSize;
  const logicalBefore = timeScale.getVisibleLogicalRange();
  const autoScaleBefore = priceScale.options().autoScale;
  const priceBefore = priceScale.getVisibleRange();

  let shot: HTMLCanvasElement;
  const markers: Array<{ x: number; y: number; kind: 'entry' | 'exit' }> = [];
  try {
    chart.applyOptions({ autoSize: false });
    chart.resize(CHART_WIDTH, CHART_HEIGHT, true);
    timeScale.setVisibleLogicalRange(range);
    const view = bars.slice(Math.max(0, range.from), Math.min(bars.length, range.to + 1));
    const prices = [
      ...view.flatMap(bar => [bar.high, bar.low]),
      trade.entryPrice, trade.exitPrice, trade.stopLoss, trade.takeProfit,
    ].filter(finite);
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const margin = Math.max((high - low) * 0.08, 1);
    priceScale.setAutoScale(false);
    priceScale.setVisibleRange({ from: low - margin, to: high + margin });
    for (let frame = 0; frame < 4; frame += 1) await nextFrame();
    shot = chart.takeScreenshot(true, false);
    // Šipky vstupu a výstupu: overlay plnění je React canvas mimo snímek knihovny.
    const point = (index: number, value: number | undefined, kind: 'entry' | 'exit') => {
      if (!finite(value)) return;
      const x = timeScale.logicalToCoordinate(index as Logical);
      const y = series.priceToCoordinate(value);
      if (x !== null && y !== null) markers.push({ x, y, kind });
    };
    point(entryIndex, trade.entryPrice, 'entry');
    point(exitIndex, trade.exitPrice, 'exit');
  } finally {
    if (hostRect) chart.resize(Math.floor(hostRect.width), Math.floor(hostRect.height), true);
    chart.applyOptions({ autoSize });
    if (logicalBefore) timeScale.setVisibleLogicalRange(logicalBefore);
    if (autoScaleBefore) priceScale.setAutoScale(true);
    else if (priceBefore) priceScale.setVisibleRange(priceBefore);
  }

  const ratio = shot.width / CHART_WIDTH;
  const output = document.createElement('canvas');
  output.width = shot.width;
  output.height = Math.round((CHART_HEIGHT + HEADER_HEIGHT) * ratio);
  const context = output.getContext('2d');
  if (!context) return shot.toDataURL('image/jpeg', 0.88);
  const background = isDark ? '#0b0f15' : '#ffffff';
  context.fillStyle = background;
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(shot, 0, HEADER_HEIGHT * ratio);
  context.scale(ratio, ratio);

  const long = trade.direction.toLowerCase() === 'long';
  const entry = markers.find(marker => marker.kind === 'entry');
  const exit = markers.find(marker => marker.kind === 'exit');
  if (entry && exit) {
    context.save();
    context.setLineDash([3, 4]);
    context.strokeStyle = isDark ? 'rgba(255,255,255,.6)' : 'rgba(51,65,85,.6)';
    context.beginPath();
    context.moveTo(entry.x, entry.y + HEADER_HEIGHT);
    context.lineTo(exit.x, exit.y + HEADER_HEIGHT);
    context.stroke();
    context.restore();
  }
  const arrow = (marker: { x: number; y: number }, up: boolean, color: string, label: string) => {
    const y = marker.y + HEADER_HEIGHT;
    const tip = up ? y + 6 : y - 6;
    const base = up ? y + 15 : y - 15;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(marker.x, tip);
    context.lineTo(marker.x - 6, base);
    context.lineTo(marker.x + 6, base);
    context.closePath();
    context.fill();
    context.font = '800 10px Inter, system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText(label, marker.x, up ? base + 11 : base - 4);
  };
  // Long: nákup pod cenou (šipka nahoru), prodej nad ní; short obráceně.
  if (entry) arrow(entry, long, '#3b82f6', long ? 'BUY' : 'SELL');
  if (exit) arrow(exit, !long, (trade.pnl ?? 0) >= 0 ? '#22c55e' : '#f43f5e', long ? 'SELL' : 'BUY');

  // Hlavička: trh, směr, čas, ceny a výsledek.
  context.textAlign = 'left';
  context.fillStyle = isDark ? '#e8edf5' : '#0f172a';
  context.font = '800 17px Inter, system-ui, sans-serif';
  context.fillText(trade.instrument, 18, 30);
  const badgeX = 18 + context.measureText(trade.instrument).width + 12;
  context.fillStyle = long ? 'rgba(34,197,94,.16)' : 'rgba(244,63,94,.16)';
  context.beginPath();
  context.roundRect(badgeX, 15, 52, 22, 5);
  context.fill();
  context.fillStyle = long ? '#22c55e' : '#f43f5e';
  context.font = '700 12px Inter, system-ui, sans-serif';
  context.fillText(long ? 'Long' : 'Short', badgeX + 10, 30);
  const time = (ms: number) => new Date(ms).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Prague' });
  const day = new Date(trade.entryTime).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' });
  context.fillStyle = isDark ? '#8391a7' : '#64748b';
  context.font = '600 13px Inter, system-ui, sans-serif';
  context.fillText(`${day} · ${time(trade.entryTime)} → ${time(trade.exitTime)}   ·   vstup ${price(trade.entryPrice)}   výstup ${price(trade.exitPrice)}   SL ${price(trade.stopLoss)}   TP ${price(trade.takeProfit)}`, badgeX + 66, 30);
  if (finite(trade.pnl)) {
    const r = finite(trade.riskAmount) && trade.riskAmount > 0 ? ` · ${(trade.pnl / trade.riskAmount).toFixed(2)}R` : '';
    context.textAlign = 'right';
    context.fillStyle = trade.pnl >= 0 ? '#22c55e' : '#f43f5e';
    context.font = '700 13px "JetBrains Mono", ui-monospace, monospace';
    context.fillText(`${trade.pnl >= 0 ? '+' : '−'}$${Math.abs(trade.pnl).toFixed(2)}${r}`, CHART_WIDTH - 18, 30);
  }
  context.fillStyle = isDark ? 'rgba(255,255,255,.08)' : 'rgba(15,23,42,.08)';
  context.fillRect(0, HEADER_HEIGHT - 1, CHART_WIDTH, 1);
  return output.toDataURL('image/jpeg', 0.88);
}
