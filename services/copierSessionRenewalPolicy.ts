/**
 * Kdy smí worker vynutit obnovu Tradovate access tokenu kvůli podezřelé
 * broker session.
 *
 * 18. 9. 2026: server obnovil tokeny Tradeify a FundedNext v 15:31Z, staré
 * tokeny vypršely v 15:41Z a od té chvíle Tradovate s novými tokeny neobsloužil
 * ani WebSocket sync, ani REST (Vercel dostával 408). Ožilo to přesně v 16:41Z,
 * kdy si worker vyžádal další obnovu (nový token = nová session). Bez této
 * politiky trvá takový výpadek do přirozeného okna obnovy, tedy až hodinu.
 *
 * Pravidla: vynutit až po `threshold` sync timeoutech v řadě, nejvýš jednou za
 * `cooldownMs` na jedno spojení. Obnova tokenu nic neposílá brokerovi a děje
 * se jen ve stavu bez streamu, takže nemá vliv na živé kopírování.
 */
export interface SessionRenewalPolicyOptions {
  /** Kolik sync timeoutů v řadě je potřeba (default 2 ≈ 2 minuty). */
  threshold?: number;
  /** Minimální rozestup vynucených obnov jednoho spojení (default 5 min). */
  cooldownMs?: number;
}

export interface SessionRenewalPolicy {
  /** Vrátí true, když má volající vynutit obnovu; zároveň si to zapíše. */
  shouldForceRenewal(consecutiveSyncTimeouts: number, now: number): boolean;
  lastForcedAt(): number | null;
}

export function createSessionRenewalPolicy(options: SessionRenewalPolicyOptions = {}): SessionRenewalPolicy {
  const threshold = Math.max(1, Math.floor(options.threshold ?? 2));
  const cooldownMs = Math.max(0, options.cooldownMs ?? 5 * 60_000);
  let lastForcedAt: number | null = null;
  return {
    shouldForceRenewal(consecutiveSyncTimeouts, now) {
      if (!Number.isFinite(consecutiveSyncTimeouts) || consecutiveSyncTimeouts < threshold) return false;
      if (lastForcedAt != null && now - lastForcedAt < cooldownMs) return false;
      lastForcedAt = now;
      return true;
    },
    lastForcedAt: () => lastForcedAt,
  };
}
