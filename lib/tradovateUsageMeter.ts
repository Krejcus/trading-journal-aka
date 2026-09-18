/**
 * Klouzavé počítadlo volání na Tradovate (minuta / hodina) po minutových
 * koších. Sdílené workerem (REST + WebSocket požadavky brokeru) i webem
 * (Tradovate volání serveru na jeden tick). Limit Tradovate je ~80 volání za
 * minutu a 5 000 za hodinu na uživatele; překročení 18. 9. 2026 zavíralo
 * WebSocket workeru a penalizovalo sync.
 */
/**
 * Oficiální limity (partner.tradovate.com/overview/core-concepts/rate-limits):
 * přihlášený uživatel 5 000 požadavků za hodinu přes všechny endpointy
 * (překročení = 429); `user/syncrequest` 300 za hodinu na IP rozsah /24
 * (překročení = p-ticket v odpovědi). Žádný pevný limit 80/min neexistuje;
 * 84/min je jen tempo, které by hodinový limit vyčerpalo.
 */
export const TRADOVATE_HOUR_LIMIT = 5_000;
export const TRADOVATE_MINUTE_PACE = Math.floor(TRADOVATE_HOUR_LIMIT / 60);
export const TRADOVATE_SYNCREQUEST_HOUR_LIMIT = 300;
/** @deprecated jen tempo, ne limit — viz TRADOVATE_MINUTE_PACE. */
export const TRADOVATE_MINUTE_LIMIT = TRADOVATE_MINUTE_PACE;

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

/**
 * Semafor pro UI: červená nad hodinovým limitem uživatele nebo nad limitem
 * syncrequest; oranžová nad 60 % hodinového limitu nebo při tempu, které by
 * ho vyčerpalo; jinak zelená.
 */
export function tradovateUsageLevel(usage: TradovateUsageWindow, syncRequestsHour = 0): 'ok' | 'warn' | 'over' {
  if (usage.hour > TRADOVATE_HOUR_LIMIT || syncRequestsHour > TRADOVATE_SYNCREQUEST_HOUR_LIMIT) return 'over';
  if (usage.hour > TRADOVATE_HOUR_LIMIT * 0.6 || usage.minute > TRADOVATE_MINUTE_PACE || syncRequestsHour > TRADOVATE_SYNCREQUEST_HOUR_LIMIT * 0.6) return 'warn';
  return 'ok';
}
