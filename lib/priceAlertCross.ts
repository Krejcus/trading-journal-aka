import type { PriceAlertCondition } from './priceAlerts';

/**
 * Křížení ceny pro upozornění (2. 11. 2026) — čistá funkce, jen IBKR obchody z vlákna ceny.
 * Dávka obchodů od posledního vyhodnocení: `prev` = poslední cena PŘED dávkou (baseline),
 * `min`/`max`/`last` = rozsah a konec dávky. Křížení = cena prošla úrovní během dávky:
 * - up: prev < úroveň ≤ max,
 * - down: prev > úroveň ≥ min,
 * - cross: kterékoli z obou.
 * Cena přesně na úrovni před dávkou (prev == úroveň) nic nespustí; spustí až odchod a návrat.
 * Bez baseline (start, výpadek IBKR, změna kontraktu, mezera) se nikdy nespouští.
 */
export interface PriceAlertTickBatch {
  prev: number;
  min: number;
  max: number;
  last: number;
}

export function priceAlertCrossed(condition: PriceAlertCondition, level: number, batch: PriceAlertTickBatch | null): boolean {
  if (!batch || ![level, batch.prev, batch.min, batch.max, batch.last].every(Number.isFinite)) return false;
  if (batch.min > batch.max) return false;
  const up = batch.prev < level && batch.max >= level;
  const down = batch.prev > level && batch.min <= level;
  return condition === 'up' ? up : condition === 'down' ? down : up || down;
}

/**
 * Směr hlídání: ruční volba uživatele platí; automaticky odvozený (z close grafu v UI) se
 * přepočítá z IBKR baseline v okamžiku, kdy hlídání upozornění převezme (nad trhem = nahoru,
 * pod trhem = dolů). Bez baseline zůstane „překročí“, aby se nic nepromeškalo.
 */
export function priceAlertWatchCondition(alert: { price: number; condition: PriceAlertCondition; conditionAuto?: boolean }, baseline: number | null): PriceAlertCondition {
  if (alert.conditionAuto !== true || alert.condition === 'cross') return alert.condition;
  if (baseline == null || !Number.isFinite(baseline)) return 'cross';
  return alert.price >= baseline ? 'up' : 'down';
}
