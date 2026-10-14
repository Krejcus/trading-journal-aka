import type { DrawingToolId } from '@getcandlekit/charts';
import type { MarketTimeframe } from '../services/marketData';

/**
 * Celoobrazovkový graf dne na telefonu: pevná sada nástrojů, barev a
 * timeframů (viz docs/DAY_CHART_PHONE_FULLSCREEN.md). Žádná vazba na copier.
 */

export const DAY_CHART_TIMEFRAMES: readonly MarketTimeframe[] = ['1m', '5m', '15m'];
export const DAY_CHART_TIMEFRAME_KEY = 'at:day-chart:timeframe';

/** Další timeframe v kolečku (po posledním zase první). */
export function nextDayChartTimeframe(current: MarketTimeframe): MarketTimeframe {
  const index = DAY_CHART_TIMEFRAMES.indexOf(current);
  return DAY_CHART_TIMEFRAMES[(index + 1) % DAY_CHART_TIMEFRAMES.length];
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function readStoredDayChartTimeframe(storage: StorageLike | null | undefined, fallback: MarketTimeframe = '5m'): MarketTimeframe {
  try {
    const value = storage?.getItem(DAY_CHART_TIMEFRAME_KEY);
    return value && (DAY_CHART_TIMEFRAMES as readonly string[]).includes(value) ? value as MarketTimeframe : fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredDayChartTimeframe(storage: StorageLike | null | undefined, timeframe: MarketTimeframe): void {
  try { storage?.setItem(DAY_CHART_TIMEFRAME_KEY, timeframe); } catch { /* soukromý režim */ }
}

/** Tři nástroje, které v deníku dávají smysl; zbytek má TradingView. */
export const DAY_DRAW_TOOLS: readonly { id: DrawingToolId; label: string; points: number }[] = [
  { id: 'Rectangle', label: 'Zóna', points: 2 },
  { id: 'HorizontalLine', label: 'Úroveň', points: 1 },
  { id: 'TrendLine', label: 'Trendline', points: 2 },
];

export type DayDrawColorId = 'long' | 'short' | 'neutral';
export const DAY_DRAW_COLORS: readonly { id: DayDrawColorId; label: string; color: string; fill: string }[] = [
  { id: 'long', label: 'Long', color: '#10b981', fill: 'rgba(16,185,129,0.18)' },
  { id: 'short', label: 'Short', color: '#f43f5e', fill: 'rgba(244,63,94,0.18)' },
  { id: 'neutral', label: 'Neutrál', color: '#94a3b8', fill: 'rgba(148,163,184,0.18)' },
];

/** Styl kresby pro barvu: výplň jen u zóny, čáry zůstávají bez výplně. */
export function dayDrawStyle(colorId: DayDrawColorId, tool: DrawingToolId | null | undefined): { color: string; fill: string | null } {
  const preset = DAY_DRAW_COLORS.find(item => item.id === colorId) ?? DAY_DRAW_COLORS[2];
  return { color: preset.color, fill: tool === 'Rectangle' ? preset.fill : null };
}

/** Barva kresby → předvolba (pro zvýraznění v liště); neznámá barva = null. */
export function dayDrawColorOf(color: string | undefined): DayDrawColorId | null {
  const normalized = (color ?? '').trim().toLowerCase();
  return DAY_DRAW_COLORS.find(item => item.color === normalized)?.id ?? null;
}

/**
 * Poslední ručně nakreslená kresba (`auto-*` jsou generované překryvy
 * grafu, ty se nikdy nemažou undo tlačítkem).
 */
export function lastManualDrawingId(drawings: readonly { id: string }[]): string | null {
  for (let i = drawings.length - 1; i >= 0; i -= 1) {
    if (!drawings[i].id.startsWith('auto-')) return drawings[i].id;
  }
  return null;
}
