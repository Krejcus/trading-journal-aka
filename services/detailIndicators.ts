import { chartAppearanceUserId, inheritGlobalAppearance } from './chartAppearanceScope';
import {
  DEFAULT_DETAIL_INDICATORS,
  mergeIndicatorSettings,
  type AlphaTradeIndicatorSettings,
  type DetailIndicatorToggles,
} from './chartIndicatorSettings';
import { panelSettingsEnvelope } from './chartPanelSettings';

/**
 * Indikátory v detailu obchodu. Styly se jen čtou — edituje se v backtestu
 * nebo ve fullscreenu. Detail si nikdy nesahá na nastavení otevřené backtest
 * session (mohl by ho přepsat), bere snapshot „naposledy použitého“ stylu.
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

// Přepínače jsou volba zobrazení v tomhle prohlížeči — záměrně bez ID
// uživatele: to se při načtení stránky teprve ověřuje a detail by při prvním
// vykreslení četl jiný klíč, než pod který se zapisovalo.
export function readDetailIndicatorToggles(): DetailIndicatorToggles {
  try {
    const saved = JSON.parse(window.localStorage.getItem(DETAIL_TOGGLES_KEY) ?? 'null') as Partial<DetailIndicatorToggles> | null;
    return { ...DEFAULT_DETAIL_INDICATORS, ...(saved ?? {}) };
  } catch {
    return { ...DEFAULT_DETAIL_INDICATORS };
  }
}

export function writeDetailIndicatorToggles(toggles: DetailIndicatorToggles): void {
  try { window.localStorage.setItem(DETAIL_TOGGLES_KEY, JSON.stringify(toggles)); } catch { /* jen pro tuto relaci */ }
}
