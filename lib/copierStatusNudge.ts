const NUDGE_TOPIC = /^copier-nudge-[A-Za-z0-9_-]{22}$/;
export const COPIER_STATUS_NUDGE_MIN_SPACING_MS = 250;
/** Strop čtení z budíčku (i podvrženého): víc za minutu se ignoruje, poll jede dál. */
export const COPIER_STATUS_NUDGE_MAX_PER_MINUTE = 60;

/** Téma budíčku ze statusu relaye; cokoli jiného = bez budíčku (jen poll). */
export function copierStatusNudgeTopic(value: unknown): string | null {
  return typeof value === 'string' && NUDGE_TOPIC.test(value) ? value : null;
}
