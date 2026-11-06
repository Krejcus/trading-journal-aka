/**
 * Řádek O/H/L/C grafu po živé svíčce. Živá svíčka jde přímo do grafu (`updateBar`), React
 * data ji neznají, takže hlavička jinak stála na poslední svíčce ze souboru. Jen zobrazení.
 */
const refreshers = new WeakMap<object, () => void>();

export function registerLiveLegend(controller: object, refresh: () => void): void {
  refreshers.set(controller, refresh);
}

export function notifyLiveLegend(controller: object): void {
  try {
    refreshers.get(controller)?.();
  } catch {
    // Hlavička nesmí shodit překreslení svíčky.
  }
}
