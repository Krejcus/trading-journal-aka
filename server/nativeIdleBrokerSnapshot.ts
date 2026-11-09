import type { NativeLiveActivityRuntimeRow } from './nativeLiveActivityUpdater.js';

/**
 * Minutový cron četl brokera pro zámky účtů, start Live Activity a widgety každou minutu,
 * i když worker hlásil klid (10. 11. 2026: špička čerpání zobrazovacího rozpočtu přesně
 * ve 20.–24. sekundě každé minuty, ~7 dotazů/min na login bez jediné pozice). Zobrazovací
 * pruh pak býval na stropu a odmítal jiná čtení.
 *
 * V klidu stačí číst každou pátou minutu. „Klid“ je jen podnět ke zpomalení zobrazovacího
 * čtení, nikdy důkaz stavu: čerstvý worker hlásí flat, žádný příkaz, žádnou potřebu
 * kontroly a expozice se poslední tři minuty nezměnila (ať se po zavření obchodu widget
 * i zámek ještě dotáhnou). Cokoli nejasného = klid není, čte se jako dřív.
 * Běžící Live Activity a čtvrthodinový sběr zůstatků tím řízené nejsou.
 */
export const IDLE_BROKER_SNAPSHOT_EVERY_MINUTES = 5;
export const IDLE_BROKER_SNAPSHOT_SETTLE_MS = 3 * 60_000;
const RUNTIME_FRESH_MS = 90_000;

export function workerRuntimeReportsIdle(runtime: Pick<NativeLiveActivityRuntimeRow, 'status' | 'last_seen_at'>, now: number): boolean {
  const seen = Date.parse(runtime.last_seen_at);
  if (!Number.isFinite(seen) || now - seen > RUNTIME_FRESH_MS || seen > now + 5_000) return false;
  const controller = (runtime.status as { controller?: Record<string, unknown> } | null)?.controller;
  if (!controller || controller.connected !== true || controller.groupFlat !== true) return false;
  if (controller.reconciliationRequired === true || controller.lastError != null) return false;
  const exposure = controller.exposure as { verifiedAt?: unknown; positions?: unknown; orders?: unknown } | null | undefined;
  if (!exposure || !Array.isArray(exposure.positions) || !Array.isArray(exposure.orders)) return false;
  if (exposure.positions.length > 0 || exposure.orders.length > 0) return false;
  const verifiedAt = exposure.verifiedAt;
  if (typeof verifiedAt !== 'number' || !Number.isFinite(verifiedAt) || verifiedAt > now + 5_000) return false;
  return now - verifiedAt >= IDLE_BROKER_SNAPSHOT_SETTLE_MS;
}

/** Smí cron v této minutě vynechat zobrazovací čtení brokera pro tento runtime? */
export function skipIdleBrokerSnapshot(runtime: Pick<NativeLiveActivityRuntimeRow, 'status' | 'last_seen_at'>, now: number): boolean {
  return new Date(now).getUTCMinutes() % IDLE_BROKER_SNAPSHOT_EVERY_MINUTES !== 0 && workerRuntimeReportsIdle(runtime, now);
}
