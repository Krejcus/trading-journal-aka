import type { DrawingToolId } from '@getcandlekit/charts';
import type { MarketTimeframe } from '../services/marketData';
import { CHART_WORKSPACE_LAYOUTS, type ChartWorkspaceLayoutId } from '../services/chartWorkspaceLayouts';

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

/** Posun v kolečku o `steps` (i záporně) — dokola jako v TradingView. */
export function cycleDayChartTimeframe(current: MarketTimeframe, steps: number): MarketTimeframe {
  const count = DAY_CHART_TIMEFRAMES.length;
  const index = Math.max(0, DAY_CHART_TIMEFRAMES.indexOf(current));
  return DAY_CHART_TIMEFRAMES[(((index + steps) % count) + count) % count];
}

/** Celé názvy pro velké kolečko uprostřed obrazovky. */
export const DAY_CHART_TIMEFRAME_LABEL: Partial<Record<MarketTimeframe, string>> = { '1m': '1 minuta', '5m': '5 minut', '15m': '15 minut' };

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

/** Virtuální nástroj „cesta“ (TradingView Path): CandleKit ho nemá, skládá se z úseček. */
export const DAY_PATH_TOOL = 'Path';

/**
 * Nástroje, které v deníku dávají smysl; zbytek má TradingView. Cesta
 * (Šipka) je hlavní: klepnutí = bod, další klepnutí = zlom, dvojklep = konec,
 * šipka jen na posledním úseku. Jde o skupinu úseček se společným ID
 * (`path:<skupina>:<n>`), ne o nativní nástroj CandleKit.
 */
export const DAY_DRAW_TOOLS: readonly { id: DrawingToolId; label: string; points: number; virtual?: boolean }[] = [
  { id: DAY_PATH_TOOL, label: 'Šipka', points: Infinity, virtual: true },
  { id: 'Rectangle', label: 'Zóna', points: 2 },
  { id: 'HorizontalLine', label: 'Úroveň', points: 1 },
  { id: 'TrendLine', label: 'Trend', points: 2 },
];

export const pathSegmentId = (group: string, index: number) => `path:${group}:${index}`;
/** Skupina cesty z ID úsečky; jiná kresba = null. */
export const pathGroupOf = (id: string | null | undefined): string | null => {
  const match = /^path:([^:]+):\d+$/.exec(id ?? '');
  return match ? match[1] : null;
};
/** Všechny úsečky jedné cesty (mazání a obarvení celé cesty najednou). */
export const pathSegmentIds = (drawings: readonly { id: string }[], group: string) =>
  drawings.filter(item => pathGroupOf(item.id) === group).map(item => item.id);

/** Klíč kreseb dne v CandleKit (stejný tvar skládá `CandleKitTradeChart`). */
export const dayDrawingsStorageKey = (day: string) => `alphatrade:candlekit:day:${day}:day`;

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

// ── Oblíbené nástroje a plovoucí panel (telefon) ─────────────────────────
export const DAY_DRAW_FAVORITES_KEY = 'at:day-chart:draw-favorites';
export const DAY_DRAW_PANEL_KEY = 'at:day-chart:draw-panel';
const DEFAULT_DAY_DRAW_FAVORITES: readonly string[] = DAY_DRAW_TOOLS.map(tool => tool.id);

/** Oblíbené nástroje telefonu; neplatná či prázdná data = výchozí čtveřice. */
export function readDayDrawFavorites(storage: StorageLike | null | undefined, validIds: readonly string[]): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(DAY_DRAW_FAVORITES_KEY) ?? 'null');
    if (Array.isArray(parsed)) {
      const valid = new Set(validIds);
      const list = parsed.filter((id, index): id is string => typeof id === 'string' && valid.has(id) && parsed.indexOf(id) === index);
      return list;
    }
  } catch { /* poškozená data → výchozí */ }
  return [...DEFAULT_DAY_DRAW_FAVORITES];
}

export function writeDayDrawFavorites(storage: StorageLike | null | undefined, favorites: readonly string[]): void {
  try { storage?.setItem(DAY_DRAW_FAVORITES_KEY, JSON.stringify(favorites)); } catch { /* jen pohodlí */ }
}

/** Přidá nástroj na konec, nebo ho odebere. */
export const toggleDayDrawFavorite = (favorites: readonly string[], id: string): string[] =>
  favorites.includes(id) ? favorites.filter(item => item !== id) : [...favorites, id];

/** Plovoucí panel: zapnutý? a poloha (x, y) 0–1 v ploše grafu. */
export type DayDrawPanel = { on: boolean; x: number; y: number };
const unit = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback);
export function readDayDrawPanel(storage: StorageLike | null | undefined): DayDrawPanel {
  try {
    const parsed = JSON.parse(storage?.getItem(DAY_DRAW_PANEL_KEY) ?? 'null') as { on?: unknown; x?: unknown; y?: unknown } | null;
    if (parsed && typeof parsed === 'object') return { on: parsed.on === true, x: unit(parsed.x, 0.5), y: unit(parsed.y, 0.03) };
  } catch { /* výchozí */ }
  return { on: false, x: 0.5, y: 0.03 };
}

export function writeDayDrawPanel(storage: StorageLike | null | undefined, panel: DayDrawPanel): void {
  try { storage?.setItem(DAY_DRAW_PANEL_KEY, JSON.stringify(panel)); } catch { /* jen pohodlí */ }
}

// ── Rozvržení grafů na celé obrazovce (telefon) — stejné šablony jako PC/TV ──
/** 'auto' = na výšku 1 graf, na šířku 2 vedle sebe; jinak id šablony z PC (1–4 okna). */
export type DayChartLayout = ChartWorkspaceLayoutId | 'auto';
export const DAY_CHART_LAYOUT_KEY = 'at:day-chart:layout';
const LAYOUT_IDS = new Set<string>(CHART_WORKSPACE_LAYOUTS.map(template => template.id));
export function readDayChartLayout(storage: StorageLike | null | undefined): DayChartLayout {
  try {
    const value = storage?.getItem(DAY_CHART_LAYOUT_KEY);
    if (value === 'auto') return 'auto';
    if (value === '2') return '2v'; // starší uložení „2 grafy“ = pod sebou
    if (value && LAYOUT_IDS.has(value)) return value as ChartWorkspaceLayoutId;
  } catch { /* výchozí */ }
  return 'auto';
}
export function writeDayChartLayout(storage: StorageLike | null | undefined, layout: DayChartLayout): void {
  try { storage?.setItem(DAY_CHART_LAYOUT_KEY, layout); } catch { /* jen pohodlí */ }
}
/** Skutečná šablona pro rozvržení a orientaci. */
export const effectiveDayChartLayout = (layout: DayChartLayout, landscape: boolean): ChartWorkspaceLayoutId =>
  layout === 'auto' ? (landscape ? '2h' : '1') : layout;

/** Rámce oken 2–4 (okno 1 má rámec sdílený s malým grafem). */
export const DAY_CHART_PANE_TF_KEY = 'at:day-chart:pane-timeframes';
const DEFAULT_PANE_TIMEFRAMES: MarketTimeframe[] = ['15m', '1m', '5m'];
export function readDayPaneTimeframes(storage: StorageLike | null | undefined): MarketTimeframe[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(DAY_CHART_PANE_TF_KEY) ?? 'null');
    if (Array.isArray(parsed)) {
      return DEFAULT_PANE_TIMEFRAMES.map((fallback, index) => (
        (DAY_CHART_TIMEFRAMES as readonly unknown[]).includes(parsed[index]) ? parsed[index] as MarketTimeframe : fallback
      ));
    }
  } catch { /* výchozí */ }
  return [...DEFAULT_PANE_TIMEFRAMES];
}
export function writeDayPaneTimeframes(storage: StorageLike | null | undefined, timeframes: readonly MarketTimeframe[]): void {
  try { storage?.setItem(DAY_CHART_PANE_TF_KEY, JSON.stringify(timeframes)); } catch { /* jen pohodlí */ }
}

/** Synchronizace v rozvržení (jako TV „Sync in layout“; symbol je vždy MNQ). */
export type DayChartSync = { interval: boolean; crosshair: boolean; time: boolean; dateRange: boolean };
export const DAY_CHART_SYNC_KEY = 'at:day-chart:sync';
const DEFAULT_SYNC: DayChartSync = { interval: false, crosshair: true, time: true, dateRange: false };
export function readDayChartSync(storage: StorageLike | null | undefined): DayChartSync {
  try {
    const parsed = JSON.parse(storage?.getItem(DAY_CHART_SYNC_KEY) ?? 'null') as Partial<Record<keyof DayChartSync, unknown>> | null;
    if (parsed && typeof parsed === 'object') {
      return {
        interval: typeof parsed.interval === 'boolean' ? parsed.interval : DEFAULT_SYNC.interval,
        crosshair: typeof parsed.crosshair === 'boolean' ? parsed.crosshair : DEFAULT_SYNC.crosshair,
        time: typeof parsed.time === 'boolean' ? parsed.time : DEFAULT_SYNC.time,
        dateRange: typeof parsed.dateRange === 'boolean' ? parsed.dateRange : DEFAULT_SYNC.dateRange,
      };
    }
  } catch { /* výchozí */ }
  return { ...DEFAULT_SYNC };
}
export function writeDayChartSync(storage: StorageLike | null | undefined, sync: DayChartSync): void {
  try { storage?.setItem(DAY_CHART_SYNC_KEY, JSON.stringify(sync)); } catch { /* jen pohodlí */ }
}
