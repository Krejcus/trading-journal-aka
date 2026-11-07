import { isMarketTimeframe, type MarketTimeframe } from '../services/marketData';
import { CHART_WORKSPACE_LAYOUTS } from '../services/chartWorkspaceLayouts';
import { stampChartProfileEdit } from '../services/chartAppearanceScope';
import {
  DAY_CHART_LAYOUT_KEY,
  DAY_CHART_PANE_TF_KEY,
  DAY_CHART_TIMEFRAME_KEY,
  readDayChartLayout,
  readDayPaneTimeframes,
  readStoredDayChartTimeframe,
} from './dayChartTools';

/**
 * Společné rozložení a timeframy grafů (LIVE a graf dne) napříč zařízeními. Jde na server v profilu grafů
 * (`services/chartProfile.ts`), takže přežije čistou instalaci appky a poslední změna platí všude. Jen zobrazení.
 * Telefon i PC dál čtou své místní klíče; převzetí ze serveru je přepíše všechny najednou.
 */
export interface ChartView {
  /** Id šablony (`1`, `2h`, …), nebo `auto` z telefonu (na výšku 1 graf, na šířku 2). */
  layout: string;
  /** Timeframe oken 1–4 podle pořadí. */
  timeframes: MarketTimeframe[];
}

export const CHART_VIEW_KEY = 'at:chart-view';
const WORKSPACE_LAYOUT_KEY = 'alphatrade:chart-workspace-layout';
const WORKSPACE_SCOPES = ['live-trading', 'day'] as const;
const MAX_PANES = 4;
const LAYOUT_IDS = new Set<string>(CHART_WORKSPACE_LAYOUTS.map(template => template.id));

/** Tvar pro server; cokoli poškozeného → `null` (platí místní nastavení). */
export function parseChartView(value: unknown): ChartView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.layout !== 'string' || (row.layout !== 'auto' && !LAYOUT_IDS.has(row.layout))) return null;
  if (!Array.isArray(row.timeframes) || row.timeframes.length < 1 || row.timeframes.length > MAX_PANES) return null;
  if (!row.timeframes.every(isMarketTimeframe)) return null;
  return { layout: row.layout, timeframes: row.timeframes as MarketTimeframe[] };
}

export function readChartView(storage: Storage | null = typeof window === 'undefined' ? null : window.localStorage): ChartView | null {
  try {
    return parseChartView(JSON.parse(storage?.getItem(CHART_VIEW_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

/** Změna od uživatele: zapíše se a značí profil k nahrání, jen když se opravdu liší. */
function remember(view: ChartView, storage: Storage): void {
  const next = JSON.stringify(view);
  try {
    if (storage.getItem(CHART_VIEW_KEY) === next) return;
    storage.setItem(CHART_VIEW_KEY, next);
  } catch {
    return;
  }
  stampChartProfileEdit();
}

/** Telefon změnil rozložení nebo timeframe: stav skládá z jeho klíčů. */
export function rememberPhoneChartView(storage: Storage = window.localStorage): void {
  const timeframes = [readStoredDayChartTimeframe(storage), ...readDayPaneTimeframes(storage)];
  remember({ layout: readDayChartLayout(storage), timeframes }, storage);
}

/** PC změnilo rozložení nebo timeframy panelů. */
export function rememberWorkspaceChartView(layout: string, timeframes: readonly MarketTimeframe[], storage: Storage = window.localStorage): void {
  const view = parseChartView({ layout, timeframes: timeframes.slice(0, MAX_PANES) });
  if (view) remember(view, storage);
}

/** Převzetí ze serveru: přepíše místní klíče telefonu i PC, bez značky změny (není to místní úprava). */
export function applyChartView(view: ChartView, storage: Storage = window.localStorage): void {
  try {
    storage.setItem(CHART_VIEW_KEY, JSON.stringify(view));
    storage.setItem(DAY_CHART_LAYOUT_KEY, view.layout);
    storage.setItem(DAY_CHART_TIMEFRAME_KEY, view.timeframes[0]);
    if (view.timeframes.length > 1) {
      const panes = readDayPaneTimeframes(storage);
      view.timeframes.slice(1).forEach((timeframe, index) => { panes[index] = timeframe; });
      storage.setItem(DAY_CHART_PANE_TF_KEY, JSON.stringify(panes));
    }
    for (const scope of WORKSPACE_SCOPES) {
      const key = `${WORKSPACE_LAYOUT_KEY}:${scope}`;
      storage.setItem(key, view.layout === 'auto' ? '1' : view.layout);
      storage.setItem(`${key}:timeframes`, JSON.stringify(view.timeframes));
    }
  } catch {
    // Plné nebo blokované úložiště: platí dosavadní nastavení.
  }
}
