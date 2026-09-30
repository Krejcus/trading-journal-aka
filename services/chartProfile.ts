import { CHART_APPEARANCE_STORAGE_KEYS, chartAppearanceUserId, chartAppearanceUserStorageKey, inheritGlobalAppearance, writeGlobalChartAppearance } from './chartAppearanceScope';
import { mergeIndicatorSettings, type AlphaTradeIndicatorSettings } from './chartIndicatorSettings';
import {
  detailIndicatorStyleSnapshot,
  hasLatestIndicatorSettings,
  hasSavedTradeChartIndicators,
  readTradeChartIndicators,
  rememberLatestIndicatorSettings,
  writeTradeChartIndicators,
  type TradeChartIndicators,
} from './detailIndicators';

/**
 * Profil grafu uživatele na serveru (`user_chart_profiles`): které indikátory
 * má graf obchodu, jejich styl a nastavení grafu (barvy, osy, mřížka).
 * Potřebuje ho vykreslovací stránka automatických snímků (skrytý prohlížeč
 * nemá tvoje localStorage) a nové zařízení.
 */

export const CHART_PROFILE_VERSION = 1;
/** Server odmítne víc než 64 kB; klient nechá rezervu. */
export const CHART_PROFILE_MAX_CHARS = 60_000;

export interface ChartProfile {
  version: typeof CHART_PROFILE_VERSION;
  indicators: TradeChartIndicators;
  indicatorStyle: AlphaTradeIndicatorSettings;
  /** Uložená obálka nastavení grafu (jako v localStorage); null = výchozí. */
  chartSettings: unknown;
}

/** Profil z tohoto prohlížeče. Vlastník vzhledu musí být už známý. */
export function currentChartProfile(): ChartProfile {
  return {
    version: CHART_PROFILE_VERSION,
    indicators: readTradeChartIndicators(),
    indicatorStyle: detailIndicatorStyleSnapshot(),
    chartSettings: inheritGlobalAppearance('chartSettings') ?? null,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Profil ze serveru; cokoli neznámého nebo poškozeného → null (platí místní). */
export function parseChartProfile(value: unknown): ChartProfile | null {
  if (!isRecord(value) || value.version !== CHART_PROFILE_VERSION) return null;
  const indicators = value.indicators;
  if (!isRecord(indicators) || !['fvg', 'levels', 'structure'].every(key => typeof indicators[key] === 'boolean')) return null;
  if (!isRecord(value.indicatorStyle)) return null;
  if (value.chartSettings !== null && !isRecord(value.chartSettings)) return null;
  return {
    version: CHART_PROFILE_VERSION,
    indicators: { fvg: indicators.fvg as boolean, levels: indicators.levels as boolean, structure: indicators.structure as boolean },
    // Doplní chybějící a zahodí neznámé položky stylu (starší/novější verze appky).
    indicatorStyle: mergeIndicatorSettings(JSON.stringify(value.indicatorStyle)),
    chartSettings: value.chartSettings ?? null,
  };
}

/** Má tento prohlížeč vlastní nastavení (pak ho profil ze serveru nepřepíše)? */
export function hasLocalChartCustomization(): boolean {
  const user = chartAppearanceUserId();
  if (!user) return false;
  try {
    return hasLatestIndicatorSettings()
      || hasSavedTradeChartIndicators()
      || window.localStorage.getItem(chartAppearanceUserStorageKey('chartSettings', user)) != null
      || window.localStorage.getItem(CHART_APPEARANCE_STORAGE_KEYS.chartSettings) != null;
  } catch {
    return false;
  }
}

/** Stabilní text profilu pro porovnání (databáze jsonb přeskládá klíče). */
export function chartProfileFingerprint(profile: ChartProfile): string {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  return JSON.stringify(sorted(profile));
}

/** Zapíše profil do místního úložiště tohoto prohlížeče (před vykreslením grafu). */
export function applyChartProfile(profile: ChartProfile): void {
  writeTradeChartIndicators(profile.indicators);
  rememberLatestIndicatorSettings(profile.indicatorStyle);
  if (profile.chartSettings !== null) writeGlobalChartAppearance('chartSettings', profile.chartSettings);
}
