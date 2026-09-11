/** UI notification lifetime only. Never changes runtime safety or incident history. */
export const COPIER_DISARM_NOTICE_MS = 15 * 60_000;

export function isRecentCopierDisarm(at: number | undefined, now = Date.now()): boolean {
  return at != null && Number.isFinite(at) && at > 0 && now < at + COPIER_DISARM_NOTICE_MS;
}
