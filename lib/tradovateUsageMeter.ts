/**
 * Klouzavé počítadlo volání na Tradovate (minuta / hodina) po minutových
 * koších. Sdílené workerem (REST + WebSocket požadavky brokeru) i webem
 * (Tradovate volání serveru na jeden tick). Limit Tradovate je ~80 volání za
 * minutu a 5 000 za hodinu na uživatele; překročení 18. 9. 2026 zavíralo
 * WebSocket workeru a penalizovalo sync.
 */
export const TRADOVATE_MINUTE_LIMIT = 80;
export const TRADOVATE_HOUR_LIMIT = 5_000;

export interface TradovateUsageWindow {
  minute: number;
  hour: number;
}

export interface TradovateUsageMeter {
  record(count?: number, at?: number): void;
  snapshot(now?: number): TradovateUsageWindow;
}

const MINUTE_MS = 60_000;

export function createTradovateUsageMeter(clock: () => number = Date.now): TradovateUsageMeter {
  const buckets = new Map<number, number>();
  const minuteStartOf = (at: number) => Math.floor(at / MINUTE_MS) * MINUTE_MS;
  const prune = (now: number) => {
    const oldest = minuteStartOf(now - 61 * MINUTE_MS);
    for (const key of buckets.keys()) if (key < oldest) buckets.delete(key);
  };
  return {
    record(count = 1, at = clock()) {
      if (!Number.isFinite(count) || count <= 0) return;
      const key = minuteStartOf(at);
      buckets.set(key, (buckets.get(key) ?? 0) + count);
      prune(at);
    },
    snapshot(now = clock()) {
      prune(now);
      const minuteFrom = minuteStartOf(now);
      const hourFrom = minuteStartOf(now - 59 * MINUTE_MS);
      let minute = 0;
      let hour = 0;
      for (const [start, count] of buckets) {
        if (start >= hourFrom) hour += count;
        if (start >= minuteFrom) minute += count;
      }
      return { minute, hour };
    },
  };
}

/** Semafor pro UI: zelená do 60 % limitu, oranžová do limitu, červená nad ním. */
export function tradovateUsageLevel(usage: TradovateUsageWindow): 'ok' | 'warn' | 'over' {
  if (usage.minute > TRADOVATE_MINUTE_LIMIT || usage.hour > TRADOVATE_HOUR_LIMIT) return 'over';
  if (usage.minute > TRADOVATE_MINUTE_LIMIT * 0.6 || usage.hour > TRADOVATE_HOUR_LIMIT * 0.6) return 'warn';
  return 'ok';
}
