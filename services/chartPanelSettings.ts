/**
 * Nastavení grafu a indikátorů drží každý panel svoje.
 *
 * Dřív existovala jediná sdílená hodnota, takže úprava v jednom grafu okamžitě
 * přepsala i všechny ostatní. Nově se ukládá obálka: `shared` je výchozí stav
 * pro panel, který si nic vlastního nenastavil, a `panels` drží odchylky.
 *
 * Tlačítko „Na všechny grafy" přepíše `shared` a odchylky zahodí — po něm mají
 * všechny panely stejný stav a nový panel ho zdědí taky.
 *
 * Funkce jsou čistě datové a nevědí nic o tom, jestli obálka leží v localStorage
 * nebo v backtest session; o to se stará volající.
 */

/** Panel, pod který spadnou grafy mimo workspace (detail obchodu apod.). */
export const DEFAULT_CHART_PANEL_ID = 'default';

const ENVELOPE_MARKER = '__panelScoped';
const ENVELOPE_VERSION = 1;

export interface PanelScopedEnvelope<T = unknown> {
  [ENVELOPE_MARKER]: typeof ENVELOPE_VERSION;
  shared?: T;
  panels: Record<string, T>;
}

const isEnvelope = (value: unknown): value is PanelScopedEnvelope => (
  Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
  && (value as Record<string, unknown>)[ENVELOPE_MARKER] === ENVELOPE_VERSION
);

/**
 * Starší plochý zápis se bere jako sdílená hodnota — dosavadní nastavení tak
 * po aktualizaci zůstane platné pro všechny panely.
 */
export const panelSettingsEnvelope = <T,>(raw: unknown): PanelScopedEnvelope<T> => {
  if (isEnvelope(raw)) {
    const envelope = raw as PanelScopedEnvelope<T>;
    return {
      [ENVELOPE_MARKER]: ENVELOPE_VERSION,
      shared: envelope.shared,
      panels: envelope.panels && typeof envelope.panels === 'object' ? { ...envelope.panels } : {},
    };
  }
  return { [ENVELOPE_MARKER]: ENVELOPE_VERSION, shared: raw === null ? undefined : raw as T, panels: {} };
};

/** Hodnota panelu, nebo sdílená hodnota, když si panel nic vlastního nedrží. */
export const readPanelSettings = <T,>(raw: unknown, panelId: string): T | undefined => {
  const envelope = panelSettingsEnvelope<T>(raw);
  const own = envelope.panels[panelId];
  return own !== undefined ? own : envelope.shared;
};

export const writePanelSettings = <T,>(
  raw: unknown,
  panelId: string,
  value: T,
): PanelScopedEnvelope<T> => {
  const envelope = panelSettingsEnvelope<T>(raw);
  return { ...envelope, panels: { ...envelope.panels, [panelId]: value } };
};

/** „Na všechny grafy" — nová sdílená hodnota a žádné odchylky. */
export const writeAllPanelSettings = <T,>(value: T): PanelScopedEnvelope<T> => (
  { [ENVELOPE_MARKER]: ENVELOPE_VERSION, shared: value, panels: {} }
);

/** Cíl změny rozeslané ostatním panelům. */
export interface PanelSettingsTarget {
  panelId: string;
  allPanels: boolean;
}

export const panelSettingsTargetMatches = (target: PanelSettingsTarget | undefined, panelId: string): boolean => {
  // Chybějící cíl pochází ze starší události; zachovej dosavadní chování a
  // aplikuj ji všude, ať se panel nezasekne na neaktuálním nastavení.
  if (!target) return true;
  return target.allPanels || target.panelId === panelId;
};
