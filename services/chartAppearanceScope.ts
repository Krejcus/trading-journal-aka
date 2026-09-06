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

let appearanceUserId: string | null | undefined;
let globalMemory: ChartAppearanceState = {};
export const chartAppearanceUserId = () => appearanceUserId;
export const chartAppearanceUserStorageKey = (slot: ChartAppearanceSlot, userId: string): string => (
  `${CHART_APPEARANCE_STORAGE_KEYS[slot]}:user:${userId}`
);

/** Undefined owner is still resolving: never read or claim unowned legacy data. */
export const setChartAppearanceUserId = (userId: string | null): void => {
  if (appearanceUserId === userId) return;
  if (scopeId !== null && scopeAccount === undefined && appearanceUserId === undefined) scopeAccount = userId;
  appearanceUserId = userId;
  globalMemory = {};
  notifyReset();
};

/** Globální hodnota slotu z localStorage; `undefined`, když ještě neexistuje. */
export const inheritGlobalAppearance = (slot: ChartAppearanceSlot): unknown => {
  if (appearanceUserId === undefined) return undefined;
  if (globalMemory[slot] !== undefined) return clone(globalMemory[slot]);
  if (typeof window === 'undefined') return undefined;
  try {
    const key = appearanceUserId === null ? CHART_APPEARANCE_STORAGE_KEYS[slot] : chartAppearanceUserStorageKey(slot, appearanceUserId);
    const saved = window.localStorage.getItem(key);
    return saved ? JSON.parse(saved) as unknown : undefined;
  } catch {
    return undefined;
  }
};

export const writeGlobalChartAppearance = (slot: ChartAppearanceSlot, value: unknown): boolean => {
  if (appearanceUserId === undefined) return false;
  globalMemory = { ...globalMemory, [slot]: clone(value) };
  const key = appearanceUserId === null ? CHART_APPEARANCE_STORAGE_KEYS[slot] : chartAppearanceUserStorageKey(slot, appearanceUserId);
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* private storage retains this owner's memory */ }
  return true;
};

let scopeId: string | null = null;
let scopeOwner: object | null = null;
let scopeAccount: string | null | undefined;
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
 * grafům patří do `onChartAppearanceScopeBroadcast` — invalidace tak nikdy
 * nespouští React aktualizaci uprostřed přepínání vlastníka scope.
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
  scopeId === null || scopeAccount !== appearanceUserId ? undefined : state[slot]
);

/** Vrací `false`, když žádná session neběží — volající pak zapíše do localStorage. */
export const writeChartAppearance = (slot: ChartAppearanceSlot, value: unknown): boolean => {
  if (scopeId === null) return false;
  // A still-mounted chart from the prior account must not fall back to writing
  // the new account's global defaults while its session is being removed.
  if (scopeAccount !== appearanceUserId) return true;
  state = { ...state, [slot]: clone(value) };
  return true;
};

export const chartAppearanceSnapshot = (): ChartAppearanceState | undefined => (
  scopeId === null || scopeAccount !== appearanceUserId ? undefined : clone(state)
);

/** Apply an explicit full workspace import, including absent/default slots. */
export const replaceChartAppearance = (next: ChartAppearanceState): void => {
  if (scopeId !== null) {
    if (scopeAccount !== appearanceUserId) throw new Error('Uživatel session se změnil. Otevři ji znovu.');
    state = clone(next);
  } else {
    if (appearanceUserId === undefined) throw new Error('Počkej na ověření přihlášeného účtu.');
    globalMemory = clone(next);
    for (const slot of CHART_APPEARANCE_SLOTS) {
      const key = appearanceUserId === null ? CHART_APPEARANCE_STORAGE_KEYS[slot] : chartAppearanceUserStorageKey(slot, appearanceUserId);
      try {
        if (next[slot] === undefined) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, JSON.stringify(next[slot]));
      } catch { /* in-memory appearance remains usable with restricted storage */ }
    }
  }
  notifyReset();
};

/**
 * @param inherit dodá globální hodnotu slotu, který session ještě nemá uloženou.
 */
export const openChartAppearanceScope = (
  id: string,
  saved: ChartAppearanceState | undefined,
  inherit: (slot: ChartAppearanceSlot) => unknown,
  owner: object | null = null,
): void => {
  if (scopeId === id && scopeOwner === owner) return;
  scopeId = id;
  scopeOwner = owner;
  scopeAccount = appearanceUserId;
  state = {};
  CHART_APPEARANCE_SLOTS.forEach(slot => {
    const value = saved?.[slot] ?? inherit(slot);
    if (value !== undefined) state[slot] = clone(value);
  });
  notifyReset();
};

export const closeChartAppearanceScope = (id: string, owner: object | null = null): void => {
  if (scopeId !== id || scopeOwner !== owner) return;
  scopeId = null;
  scopeOwner = null;
  scopeAccount = undefined;
  state = {};
  notifyReset();
};

/**
 * One mounted workspace owns one lease. Activation belongs in a layout effect,
 * before rendering charts. React's setup/cleanup/setup cycle retains edits;
 * a replacement workspace gets its saved state even when its run id is equal.
 */
export const createChartAppearanceSession = (
  id: string,
  saved: ChartAppearanceState | undefined,
  inherit: (slot: ChartAppearanceSlot) => unknown,
) => {
  const owner = {};
  let retained = saved;
  return {
    activate: () => openChartAppearanceScope(id, retained, inherit, owner),
    deactivate: () => {
      if (scopeId !== id || scopeOwner !== owner) return;
      retained = chartAppearanceSnapshot();
      closeChartAppearanceScope(id, owner);
    },
  };
};

/** Jen pro testy — vrátí modul do výchozího stavu. */
export const resetChartAppearanceScope = (): void => {
  scopeId = null;
  scopeOwner = null;
  scopeAccount = undefined;
  appearanceUserId = undefined;
  globalMemory = {};
  state = {};
  resetHandlers.clear();
  broadcastHandlers.clear();
};
