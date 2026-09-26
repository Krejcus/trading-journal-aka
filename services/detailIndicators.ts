import { chartAppearanceUserId, inheritGlobalAppearance } from './chartAppearanceScope';
import { mergeIndicatorSettings, type AlphaTradeIndicatorSettings } from './chartIndicatorSettings';
import { panelSettingsEnvelope } from './chartPanelSettings';

/**
 * Indikátory v detailu obchodu. Detail si nikdy nesahá na nastavení otevřené
 * backtest session (mohl by ho přepsat): čte snapshot „naposledy použitého“
 * stylu a úpravy z detailu zapisuje jen do globálního nastavení.
 */

const scopedKey = (base: string) => {
  const user = chartAppearanceUserId();
  return user ? `${base}:user:${user}` : base;
};
const LATEST_STYLE_KEY = 'alphatrade:indicator-style-latest';
const DETAIL_TOGGLES_KEY = 'alphatrade:detail-indicators';

/** Backtest/fullscreen po uložení stylu indikátorů — ať ho vidí i detail. */
export function rememberLatestIndicatorSettings(settings: AlphaTradeIndicatorSettings): void {
  if (chartAppearanceUserId() === undefined) return;
  try { window.localStorage.setItem(scopedKey(LATEST_STYLE_KEY), JSON.stringify(settings)); } catch { /* bez úložiště */ }
}

/** Jen když ještě nic uloženého není (povýšení stylu ze starší session). */
export function rememberLatestIndicatorSettingsIfMissing(settings: AlphaTradeIndicatorSettings): void {
  if (chartAppearanceUserId() === undefined) return;
  try {
    if (window.localStorage.getItem(scopedKey(LATEST_STYLE_KEY)) == null) rememberLatestIndicatorSettings(settings);
  } catch { /* bez úložiště */ }
}

/** Snapshot pro detail: naposledy použitý styl → globální sdílený → výchozí. */
export function detailIndicatorStyleSnapshot(): AlphaTradeIndicatorSettings {
  try {
    const latest = window.localStorage.getItem(scopedKey(LATEST_STYLE_KEY));
    if (latest) return mergeIndicatorSettings(latest);
  } catch { /* bez úložiště */ }
  const envelope = panelSettingsEnvelope<AlphaTradeIndicatorSettings>(inheritGlobalAppearance('indicatorSettings'));
  const shared = envelope.shared ?? Object.values(envelope.panels)[0];
  return mergeIndicatorSettings(shared ? JSON.stringify(shared) : null);
}

/**
 * Které indikátory má graf obchodu — detail i fullscreen obchodu ukazují
 * totéž. Přidávají se ve fullscreenu, v detailu jdou upravit nebo odebrat.
 * VWAP je součást levelů (jako ve fullscreenu), zapíná se v jejich nastavení.
 */
export interface TradeChartIndicators { fvg: boolean; levels: boolean; structure: boolean }
export const NO_TRADE_CHART_INDICATORS: TradeChartIndicators = { fvg: false, levels: false, structure: false };
const TRADE_CHART_INDICATORS_EVENT = 'alphatrade:trade-chart-indicators';

// Volba zobrazení v tomhle prohlížeči — záměrně bez ID uživatele: to se při
// načtení stránky teprve ověřuje a detail by při prvním vykreslení četl jiný
// klíč, než pod který se zapisovalo.
export function readTradeChartIndicators(): TradeChartIndicators {
  try {
    const saved = JSON.parse(window.localStorage.getItem(DETAIL_TOGGLES_KEY) ?? 'null') as Record<string, unknown> | null;
    if (!saved || typeof saved !== 'object') return { ...NO_TRADE_CHART_INDICATORS };
    // Starší zápis měl VWAP zvlášť; teď patří k levelům.
    return { fvg: saved.fvg === true, levels: saved.levels === true || saved.vwap === true, structure: saved.structure === true };
  } catch {
    return { ...NO_TRADE_CHART_INDICATORS };
  }
}

export function writeTradeChartIndicators(next: TradeChartIndicators): void {
  const value = { fvg: next.fvg, levels: next.levels, structure: next.structure };
  try { window.localStorage.setItem(DETAIL_TOGGLES_KEY, JSON.stringify(value)); } catch { /* jen pro tuto relaci */ }
  window.dispatchEvent(new CustomEvent(TRADE_CHART_INDICATORS_EVENT, { detail: value }));
}

export function onTradeChartIndicatorsChange(handler: (next: TradeChartIndicators) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<TradeChartIndicators>).detail);
  window.addEventListener(TRADE_CHART_INDICATORS_EVENT, listener);
  return () => window.removeEventListener(TRADE_CHART_INDICATORS_EVENT, listener);
}
