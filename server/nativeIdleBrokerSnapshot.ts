import type { NativeLiveActivityRuntimeRow } from './nativeLiveActivityUpdater.js';

/**
 * Minutový cron četl brokera pro zámky účtů, start Live Activity a widgety každou minutu,
 * i když worker hlásil klid (10. 11. 2026: špička čerpání zobrazovacího rozpočtu přesně
 * ve 20.–24. sekundě každé minuty, ~7 dotazů/min na login bez jediné pozice). Zobrazovací
 * pruh pak býval na stropu a odmítal jiná čtení.
 *
 * V klidu lze číst jen každou pátou minutu (volitelné, viz `idleBrokerSnapshotThrottleEnabled`). „Klid“ je jen podnět ke zpomalení zobrazovacího
 * čtení, nikdy důkaz stavu: čerstvý worker hlásí flat, žádný příkaz, žádnou potřebu
 * kontroly a expozice se poslední tři minuty nezměnila (ať se po zavření obchodu widget
 * i zámek ještě dotáhnou). Cokoli nejasného = klid není, čte se jako dřív.
 * Běžící Live Activity a čtvrthodinový sběr zůstatků tím řízené nejsou.
 */
export const IDLE_BROKER_SNAPSHOT_EVERY_MINUTES = 5;

/**
 * Výchozí stav je VYPNUTO (čte se každou minutu jako dosud). Zpomalení má cenu: zámek účtu,
 * který vznikne i zmizí mezi dvěma čteními v klidu, se neoznámí vůbec, a změna na widgetu
 * může přijít až za čtyři minuty. Zapíná se proměnnou prostředí
 * `ALPHATRADE_IDLE_BROKER_SNAPSHOT=on` na serveru.
 */
export const idleBrokerSnapshotThrottleEnabled = (): boolean => process.env.ALPHATRADE_IDLE_BROKER_SNAPSHOT?.trim().toLowerCase() === 'on';
export const IDLE_BROKER_SNAPSHOT_SETTLE_MS = 3 * 60_000;
const RUNTIME_FRESH_MS = 90_000;

export function workerRuntimeReportsIdle(runtime: Pick<NativeLiveActivityRuntimeRow, 'status' | 'last_seen_at'>, now: number): boolean {
  const seen = Date.parse(runtime.last_seen_at);
  if (!Number.isFinite(seen) || now - seen > RUNTIME_FRESH_MS || seen > now + 5_000) return false;
  const controller = (runtime.status as { controller?: Record<string, unknown> } | null)?.controller;
  if (!controller || controller.connected !== true || controller.groupFlat !== true) return false;
  if (controller.reconciliationRequired === true || controller.lastError != null) return false;
  // Změna stavu bez změny expozice (vypnutí, kill switch, zámek dne, pauza po obchodu) se má
  // na widgetu a v Live Activity projevit hned: takový runtime v klidu není.
  if (controller.killSwitch === true) return false;
  const future = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > now;
  if (future(controller.dayLockUntil) || future(controller.entryCooldownUntil)) return false;
  const recent = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && now - value < IDLE_BROKER_SNAPSHOT_SETTLE_MS;
  if (recent((controller.lastDisarm as { at?: unknown } | null | undefined)?.at) || recent(controller.armedAt)) return false;
  const exposure = controller.exposure as { verifiedAt?: unknown; positions?: unknown; orders?: unknown } | null | undefined;
  if (!exposure || !Array.isArray(exposure.positions) || !Array.isArray(exposure.orders)) return false;
  if (exposure.positions.length > 0 || exposure.orders.length > 0) return false;
  const verifiedAt = exposure.verifiedAt;
  if (typeof verifiedAt !== 'number' || !Number.isFinite(verifiedAt) || verifiedAt > now + 5_000) return false;
  return now - verifiedAt >= IDLE_BROKER_SNAPSHOT_SETTLE_MS;
}

/**
 * Uživatelé, u kterých smí cron v této minutě zobrazovací čtení brokera vynechat: všechny
 * jejich čerstvé workery hlásí klid. Jeden uživatel může mít víc workerů (DEMO vedle ostré
 * skupiny) a snímek brokera se čte přes všechna jeho připojení — klidný DEMO worker nesmí
 * zdržet start Live Activity nebo widget pro pozici, kterou drží jiný worker.
 */
export function idleBrokerSnapshotUsers(
  runtimes: ReadonlyArray<Pick<NativeLiveActivityRuntimeRow, 'user_id' | 'status' | 'last_seen_at'>>, now: number,
  enabled: boolean = idleBrokerSnapshotThrottleEnabled(),
): Set<string> {
  const idle = new Set<string>();
  if (!enabled) return idle;
  if (new Date(now).getUTCMinutes() % IDLE_BROKER_SNAPSHOT_EVERY_MINUTES === 0) return idle;
  const busy = new Set<string>();
  for (const runtime of runtimes) {
    const seen = Date.parse(runtime.last_seen_at);
    // Dávno mrtvý worker o uživateli nic neříká; čerstvý, který není v klidu, klid ruší.
    if (!Number.isFinite(seen) || now - seen > RUNTIME_FRESH_MS) continue;
    if (workerRuntimeReportsIdle(runtime, now)) idle.add(runtime.user_id); else busy.add(runtime.user_id);
  }
  for (const userId of busy) idle.delete(userId);
  return idle;
}
