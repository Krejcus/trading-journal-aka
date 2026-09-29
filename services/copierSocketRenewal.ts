export interface RenewableSocketRoute {
  broker: { renewSocket(): boolean };
  label: string;
}

export interface CopierSocketRenewalState {
  connected: boolean;
  /** `false` znamená jakoukoli otevřenou pozici, i po fail-closed DISARM. */
  groupFlat?: boolean;
  /** Auto-close, recovery, nejasný outbox nebo OSO okno jsou hard blocker. */
  blocker: string | null;
}

export interface CopierSocketRenewalResult {
  label: string;
  ageMs: number;
  forced: boolean;
}

/**
 * Plánuje údržbové obnovy po jedné route. Běžící obchod má omezený odklad
 * `forceAfterMs`; hard blocker se nikdy neobchází. Úspěšné obnovy jsou
 * rozložené `staggerMs`, aby všechna OAuth spojení nevytvořila jednu mezeru.
 */
export function createCopierSocketRenewalCoordinator(options: {
  routes: readonly RenewableSocketRoute[];
  clock?: () => number;
  renewAfterMs?: number;
  forceAfterMs?: number;
  staggerMs?: number;
}) {
  const clock = options.clock ?? Date.now;
  const renewAfterMs = options.renewAfterMs ?? 50 * 60_000;
  const forceAfterMs = Math.max(renewAfterMs, options.forceAfterMs ?? 70 * 60_000);
  const staggerMs = Math.max(0, options.staggerMs ?? 30_000);
  const startedAt = clock();
  const renewedAt = new Map(options.routes.map(route => [route, startedAt]));
  let nextRouteAt = startedAt;

  return {
    poll(state: CopierSocketRenewalState): CopierSocketRenewalResult | null {
      if (!state.connected || state.blocker) return null;
      const now = clock();
      if (now < nextRouteAt) return null;
      for (const route of options.routes) {
        const ageMs = now - (renewedAt.get(route) ?? now);
        if (ageMs < renewAfterMs) continue;
        const forced = ageMs >= forceAfterMs;
        if (state.groupFlat === false && !forced) continue;
        if (!route.broker.renewSocket()) continue;
        renewedAt.set(route, now);
        nextRouteAt = now + staggerMs;
        return { label: route.label, ageMs, forced };
      }
      return null;
    },
  };
}
