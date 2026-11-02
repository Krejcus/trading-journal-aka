import { priceAlertCrossed, priceAlertWatchCondition } from '../lib/priceAlertCross';
import type { PriceAlertCondition } from '../lib/priceAlerts';

/**
 * Jádro hlídače upozornění na cenu (2. 11. 2026) — čistá logika bez sítě a bez vlákna,
 * aby šla testovat. Vstup = seznam aktivních upozornění ze serveru a dávky obchodů IBKR;
 * výstup = spuštění k nahlášení (jedno id na jedno křížení). Nikdy nespouští bez výchozí
 * ceny (start, výpadek ceny > 15 s, jiný kontrakt, nová verze upozornění). „Jednou“
 * rozhoduje server; jádro jen nespouští totéž křížení dvakrát a drží lokální strop.
 */
export interface WatchAlert {
  id: string;
  symbol: 'MNQ' | 'NQ';
  price: number;
  condition: PriceAlertCondition;
  conditionAuto: boolean;
  frequency: 'once' | 'every';
  version: number;
  expiresAt: number | null;
}

export interface WatchBatch { contract: string; prev: number | null; min: number; max: number; last: number; at: number }
export interface WatchTrigger { alertId: string; version: number; triggerId: string; observedAt: number; front: string }

export const PRICE_GAP_MS = 15_000;
export const LOCAL_CAP = 30;
export const LOCAL_CAP_WINDOW_MS = 10 * 60_000;
/**
 * Odstup „pokaždé“: server hlídá 60 s od svého času zápisu, hlídač od času pozorování —
 * o 2 s víc, ať pomalejší první doručení nezpůsobí odmítnutí druhého (a ztracené křížení).
 */
export const EVERY_COOLDOWN_MS = 62_000;
const ALERT_ID = /^pa-[0-9a-z-]{1,61}$/;
const FRONT = /^(MNQ|NQ)[FGHJKMNQUVXZ]\d{4}$/;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function parseWatchAlert(raw: unknown): WatchAlert | null {
  const row = raw as Record<string, unknown> | null;
  if (!row || typeof row.id !== 'string' || !ALERT_ID.test(row.id)) return null;
  if (row.symbol !== 'MNQ' && row.symbol !== 'NQ') return null;
  if (!finite(row.price) || row.price <= 0) return null;
  if (row.condition !== 'cross' && row.condition !== 'up' && row.condition !== 'down') return null;
  if (row.frequency !== 'once' && row.frequency !== 'every') return null;
  if (!Number.isSafeInteger(row.version) || (row.version as number) < 1) return null;
  return {
    id: row.id, symbol: row.symbol, price: row.price, condition: row.condition, conditionAuto: row.conditionAuto === true,
    frequency: row.frequency, version: row.version as number, expiresAt: finite(row.expiresAt) ? row.expiresAt : null,
  };
}

interface Watched { alert: WatchAlert; condition: PriceAlertCondition | null; firedAt: number | null }

export function createPriceAlertWatchCore(deps: { now?: () => number; uuid: () => string }) {
  const now = deps.now ?? Date.now;
  const watched = new Map<string, Watched>();
  const fired: number[] = [];
  // Spuštění čekající na konečnou odpověď serveru: odkud a jaký byl předchozí čas spuštění.
  const unsettled = new Map<string, { key: string; previous: number | null }>();
  let priceAt: number | null = null;
  let contract: string | null = null;
  const keyOf = (alert: WatchAlert) => `${alert.id}:${alert.version}`;

  return {
    /** Nový seznam ze serveru; stav se drží podle dvojice (id, verze). */
    setAlerts(alerts: readonly WatchAlert[]): void {
      const next = new Map<string, Watched>();
      for (const alert of alerts.slice(0, 50)) {
        const key = keyOf(alert);
        const previous = watched.get(key);
        next.set(key, previous ? { ...previous, alert } : { alert, condition: null, firedAt: null });
      }
      watched.clear();
      for (const [key, value] of next) watched.set(key, value);
    },
    clear(): void {
      watched.clear();
      unsettled.clear();
      priceAt = null;
      contract = null;
    },
    onBatch(batch: WatchBatch): WatchTrigger[] {
      if (!FRONT.test(batch.contract) || ![batch.min, batch.max, batch.last, batch.at].every(finite) || batch.min > batch.max) return [];
      const prev = finite(batch.prev) ? batch.prev : null;
      // Výpadek ceny, jiný kontrakt nebo dávka bez výchozí ceny = jen nová výchozí cena.
      const gap = priceAt == null || batch.at - priceAt > PRICE_GAP_MS || contract !== batch.contract || prev == null;
      priceAt = batch.at;
      contract = batch.contract;
      if (gap) {
        for (const entry of watched.values()) entry.condition = priceAlertWatchCondition(entry.alert, batch.last);
        return [];
      }
      const triggers: WatchTrigger[] = [];
      const at = now();
      for (const entry of watched.values()) {
        const { alert } = entry;
        if (alert.expiresAt != null && alert.expiresAt <= at) continue;
        if (entry.condition == null) {
          // Upozornění přibylo během hlídání: dávka jen nastaví směr — z konce dávky, protože
          // ten je výchozí cenou příští dávky (stejně jako po mezeře).
          entry.condition = priceAlertWatchCondition(alert, batch.last);
          continue;
        }
        if (alert.frequency === 'once' && entry.firedAt != null) continue;
        if (alert.frequency === 'every' && entry.firedAt != null && batch.at - entry.firedAt < EVERY_COOLDOWN_MS) continue;
        if (!priceAlertCrossed(entry.condition, alert.price, { prev, min: batch.min, max: batch.max, last: batch.last })) continue;
        while (fired.length && at - fired[0] > LOCAL_CAP_WINDOW_MS) fired.shift();
        if (fired.length >= LOCAL_CAP) continue;
        fired.push(at);
        const triggerId = deps.uuid();
        unsettled.set(triggerId, { key: keyOf(alert), previous: entry.firedAt });
        entry.firedAt = batch.at;
        triggers.push({ alertId: alert.id, version: alert.version, triggerId, observedAt: batch.at, front: batch.contract });
      }
      return triggers;
    },
    /**
     * Konečná odpověď serveru na spuštění. `final` (triggered / duplicate / jiné odmítnutí) ho
     * nechá; `retry` (odmítnuto kvůli odstupu, nebo zahozeno bez odpovědi po výpadku) vrátí
     * předchozí čas spuštění, aby upozornění neumlklo, zatímco ho server dál drží aktivní.
     */
    settle(triggerId: string, outcome: 'final' | 'retry'): void {
      const pending = unsettled.get(triggerId);
      if (!pending) return;
      unsettled.delete(triggerId);
      if (outcome !== 'retry') return;
      const entry = watched.get(pending.key);
      if (entry) entry.firedAt = pending.previous;
    },
    state(): { alerts: number; priceAt: number | null } {
      return { alerts: watched.size, priceAt };
    },
  };
}
