/**
 * Vzhled grafu vázaný na konkrétní backtest session.
 *
 * Nastavení grafu, indikátorů a výchozích stylů kreseb bydlelo v localStorage
 * jako jeden globální záznam. Znamenalo to dvě věci: přepnutí levelů v jedné
 * session je přepsalo i ve všech ostatních a na produkci se nastavení vůbec
 * neobjevilo, protože localhost je jiný origin.
 *
 * Když je otevřená session, drží stav tenhle scope a `BacktestWorkspace` ho
 * ukládá do `workspaceState.appearance`, takže jede v cloudu s runem. Mimo
 * session zůstává vše při starém — globální localStorage.
 *
 * Chybějící slot se při otevření zdědí z globálního nastavení, aby se existující
 * sessions vizuálně nezměnily a rozdělily se až od první úpravy.
 */

export type ChartAppearanceSlot = 'chartSettings' | 'indicatorSettings' | 'drawingStyleDefaults';

export type ChartAppearanceState = Partial<Record<ChartAppearanceSlot, unknown>>;

export const CHART_APPEARANCE_SLOTS: ChartAppearanceSlot[] = [
  'chartSettings',
  'indicatorSettings',
  'drawingStyleDefaults',
];

/**
 * Globální klíče žijí tady, aby existoval jediný zdroj pravdy pro dědičnost.
 * Jednotlivá úložiště si svůj klíč berou odsud.
 */
export const CHART_APPEARANCE_STORAGE_KEYS: Record<ChartAppearanceSlot, string> = {
  chartSettings: 'alphatrade:chart-settings:shared',
  indicatorSettings: 'alphatrade:chart-indicators:shared',
  drawingStyleDefaults: 'alphatrade:chart-drawing-style-defaults:v1',
};

/** Globální hodnota slotu z localStorage; `undefined`, když ještě neexistuje. */
export const inheritGlobalAppearance = (slot: ChartAppearanceSlot): unknown => {
  if (typeof window === 'undefined') return undefined;
  try {
    const saved = window.localStorage.getItem(CHART_APPEARANCE_STORAGE_KEYS[slot]);
    return saved ? JSON.parse(saved) as unknown : undefined;
  } catch {
    return undefined;
  }
};

let scopeId: string | null = null;
let state: ChartAppearanceState = {};
const resetHandlers = new Set<() => void>();
const broadcastHandlers = new Set<() => void>();

const clone = <T,>(value: T): T => (
  typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T
);

export const activeChartAppearanceScope = (): string | null => scopeId;

/**
 * Úložiště si přes tohle zaregistrují zahození vlastní paměťové cache. Bez toho
 * by graf po otevření session dál ukazoval hodnoty načtené z localStorage.
 *
 * Handler musí být čistě synchronní invalidace. Rozeslání změny namontovaným
 * grafům patří do `onChartAppearanceScopeBroadcast` — scope se otevírá v těle
 * komponenty, takže setState během renderu jiné komponenty tady není přípustný.
 */
export const onChartAppearanceScopeReset = (handler: () => void): (() => void) => {
  resetHandlers.add(handler);
  return () => { resetHandlers.delete(handler); };
};

export const onChartAppearanceScopeBroadcast = (handler: () => void): (() => void) => {
  broadcastHandlers.add(handler);
  return () => { broadcastHandlers.delete(handler); };
};

const notifyReset = () => {
  resetHandlers.forEach(handler => handler());
  const pending = [...broadcastHandlers];
  if (!pending.length) return;
  setTimeout(() => pending.forEach(handler => handler()), 0);
};

export const readChartAppearance = (slot: ChartAppearanceSlot): unknown => (
  scopeId === null ? undefined : state[slot]
);

/** Vrací `false`, když žádná session neběží — volající pak zapíše do localStorage. */
export const writeChartAppearance = (slot: ChartAppearanceSlot, value: unknown): boolean => {
  if (scopeId === null) return false;
  state = { ...state, [slot]: clone(value) };
  return true;
};

export const chartAppearanceSnapshot = (): ChartAppearanceState | undefined => (
  scopeId === null ? undefined : clone(state)
);

/**
 * @param inherit dodá globální hodnotu slotu, který session ještě nemá uloženou.
 */
export const openChartAppearanceScope = (
  id: string,
  saved: ChartAppearanceState | undefined,
  inherit: (slot: ChartAppearanceSlot) => unknown,
): void => {
  if (scopeId === id) return;
  scopeId = id;
  state = {};
  CHART_APPEARANCE_SLOTS.forEach(slot => {
    const value = saved?.[slot] ?? inherit(slot);
    if (value !== undefined) state[slot] = clone(value);
  });
  notifyReset();
};

export const closeChartAppearanceScope = (id: string): void => {
  if (scopeId !== id) return;
  scopeId = null;
  state = {};
  notifyReset();
};

/** Jen pro testy — vrátí modul do výchozího stavu. */
export const resetChartAppearanceScope = (): void => {
  scopeId = null;
  state = {};
  resetHandlers.clear();
  broadcastHandlers.clear();
};
