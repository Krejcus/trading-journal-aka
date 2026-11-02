import type { CopierPriceAlertWatchStatus } from './localCopierAgentProtocol';

/** Cena i seznam upozornění (včetně stáří samotného statusu) nejvýš takhle staré. */
export const PRICE_ALERT_WATCH_FRESH_MS = 15_000;
/** Status workeru starší než tohle „hlídá“ netvrdí (smlouva: ≤ 8 s). */
export const PRICE_ALERT_WATCH_STATUS_MAX_AGE_MS = 8_000;

/**
 * Text „kdo hlídá upozornění“ pro seznam a kartu (2. 11. 2026) — jen zobrazení. Hlídá jen
 * čerstvý, neobnovený status workeru se stavem `watching` a s cenou z IBKR i seznamem
 * upozornění ≤ 15 s; jinak `null` (UI pak přizná, že teď nikdo nehlídá).
 */
export function priceAlertWatchLabel(input: {
  fresh: boolean;
  watch: CopierPriceAlertWatchStatus | null | undefined;
  /** Jak dlouho web status drží (od přečtení); bez něj se „hlídá“ netvrdí. */
  statusAgeMs: number | null;
}): string | null {
  const watch = input.watch;
  const statusAge = input.statusAgeMs;
  if (!input.fresh || !watch || watch.state !== 'watching') return null;
  if (statusAge == null || !Number.isFinite(statusAge) || statusAge < 0 || statusAge > PRICE_ALERT_WATCH_STATUS_MAX_AGE_MS) return null;
  if (watch.priceAgeMs == null || statusAge + watch.priceAgeMs > PRICE_ALERT_WATCH_FRESH_MS) return null;
  if (watch.syncAgeMs == null || statusAge + watch.syncAgeMs > PRICE_ALERT_WATCH_FRESH_MS) return null;
  const count = Math.max(0, Math.floor(watch.alerts));
  return `Hlídá Mac z ceny IBKR · ${count} upozornění`;
}
