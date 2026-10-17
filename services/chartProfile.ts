import { CHART_APPEARANCE_STORAGE_KEYS, chartAppearanceUserId, chartAppearanceUserStorageKey, inheritGlobalAppearance, writeGlobalChartAppearance } from './chartAppearanceScope';
import { mergeIndicatorSettings, type AlphaTradeIndicatorSettings } from './chartIndicatorSettings';
import { writeAllPanelSettings } from './chartPanelSettings';
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
  /** Výchozí styly kreslicích nástrojů; chybí u profilu ze starší verze appky. */
  drawingStyleDefaults?: unknown;
}

/** Profil z tohoto prohlížeče. Vlastník vzhledu musí být už známý. */
export function currentChartProfile(): ChartProfile {
  return {
    version: CHART_PROFILE_VERSION,
    indicators: readTradeChartIndicators(),
    indicatorStyle: detailIndicatorStyleSnapshot(),
    chartSettings: inheritGlobalAppearance('chartSettings') ?? null,
    drawingStyleDefaults: inheritGlobalAppearance('drawingStyleDefaults') ?? null,
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
    ...(isRecord(value.drawingStyleDefaults) ? { drawingStyleDefaults: value.drawingStyleDefaults } : {}),
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
  // Styl i nastavení nejdřív do úložiště, teprve potom přepínače — jejich
  // událost už přečte nový stav.
  rememberLatestIndicatorSettings(profile.indicatorStyle);
  writeGlobalChartAppearance('indicatorSettings', writeAllPanelSettings(profile.indicatorStyle));
  if (profile.chartSettings !== null) writeGlobalChartAppearance('chartSettings', profile.chartSettings);
  if (profile.drawingStyleDefaults) writeGlobalChartAppearance('drawingStyleDefaults', profile.drawingStyleDefaults);
  writeTradeChartIndicators(profile.indicators);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CHART_PROFILE_APPLIED_EVENT));
}

/** Profil ze serveru se zapsal do úložiště — namontované grafy si ho přečtou znovu. */
export const CHART_PROFILE_APPLIED_EVENT = 'alphatrade:chart-profile-applied';

/** Krátký otisk pro uložení stavu synchronizace (celý profil může mít desítky kB). */
export function chartProfileHash(fingerprint: string): string {
  let hash = 5381;
  for (let index = 0; index < fingerprint.length; index += 1) hash = ((hash << 5) + hash + fingerprint.charCodeAt(index)) | 0;
  return `${fingerprint.length}:${(hash >>> 0).toString(36)}`;
}

/** Stav synchronizace tohoto zařízení (uložený u uživatele v localStorage). */
export interface ChartProfileSyncState {
  /** Nejnovější `updated_at` serveru, který toto zařízení už vidělo (ms). */
  seenServerAt: number | null;
  /** Otisk místního profilu v okamžiku poslední shody se serverem. */
  syncedHash: string | null;
  /** Otisk místního profilu při posledním pozorování a kdy se naposled změnil. */
  localHash: string | null;
  localAt: number | null;
}

export const EMPTY_CHART_PROFILE_SYNC_STATE: ChartProfileSyncState = { seenServerAt: null, syncedHash: null, localHash: null, localAt: null };

export type ChartProfileSyncDecision = 'apply-server' | 'push-local' | 'none';

/**
 * Obousměrná synchronizace — novější změna vyhraje.
 * - Server má novější verzi, než jakou zařízení vidělo, a místně se od poslední
 *   shody nic nezměnilo (nebo místní změna je starší) → převzít server.
 * - Místní změna, kterou server nemá → nahrát.
 * - První běh této verze na zařízení (bez uloženého stavu): server vyhraje.
 *   Dřívější verze nahrávala každou místní změnu do 30 s, takže server drží
 *   poslední změnu z kteréhokoli zařízení. Bez profilu na serveru se nahraje místní.
 */
export function decideChartProfileSync(input: {
  state: ChartProfileSyncState;
  localHash: string;
  serverHash: string | null;
  serverAt: number | null;
}): ChartProfileSyncDecision {
  const { state, localHash, serverHash, serverAt } = input;
  if (serverHash === null) return 'push-local';
  const dirty = state.syncedHash !== null && localHash !== state.syncedHash;
  const serverNew = serverAt !== null && (state.seenServerAt === null || serverAt > state.seenServerAt);
  if (serverNew && serverHash !== localHash) {
    if (!dirty) return 'apply-server';
    if (state.localAt !== null && serverAt !== null && serverAt > state.localAt) return 'apply-server';
  }
  return dirty && serverHash !== localHash ? 'push-local' : 'none';
}
