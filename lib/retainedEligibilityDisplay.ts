import type { CopierAccountEligibility } from '../services/copierEngine';

/**
 * Zobrazovací paměť rozhodnutí o způsobilosti účtu (Aktivní / Zamčeno DLL /
 * Breached) pro AKTUÁLNÍ obchodní den. Když po otevření LIVE ještě nejde
 * rozhodnout (worker neodpověděl, denní report se načítá), ukáže se dnešní
 * poslední rozhodnutí místo krátkého „Ověřuji“, které by vzápětí zmizelo.
 *
 * Jen zobrazení. Bezpečnostní brány (ARM, způsobilost pro kopírování) se
 * řídí workerem a čerstvými daty, nikdy touto pamětí. Den se mění s
 * obchodním dnem Tradovate, takže včerejší zámek DLL se dnes neukáže.
 */
type RetainedState = 'active' | 'dll-locked' | 'breached';
export interface RetainedEligibility {
  tradeDate: string;
  states: Record<string, { state: RetainedState; reason?: string }>;
}

const storageKey = (userId: string) => `alphatrade:eligibility-display:v1:${userId}`;

interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
const storageSafe = (): StorageLike | undefined => {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
};

export function readRetainedEligibility(userId: string, tradeDate: string, storage = storageSafe()): RetainedEligibility {
  const empty: RetainedEligibility = { tradeDate, states: {} };
  if (!userId || !storage) return empty;
  try {
    const raw = JSON.parse(storage.getItem(storageKey(userId)) ?? 'null') as RetainedEligibility | null;
    if (!raw || raw.tradeDate !== tradeDate || typeof raw.states !== 'object' || raw.states == null) return empty;
    const states: RetainedEligibility['states'] = {};
    for (const [id, entry] of Object.entries(raw.states)) {
      if (entry && (entry.state === 'active' || entry.state === 'dll-locked' || entry.state === 'breached')) {
        states[id] = { state: entry.state, ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}) };
      }
    }
    return { tradeDate, states };
  } catch {
    return empty;
  }
}

export function writeRetainedEligibility(userId: string, value: RetainedEligibility, storage = storageSafe()): void {
  if (!userId || !storage) return;
  try { storage.setItem(storageKey(userId), JSON.stringify(value)); } catch { /* Volitelná paměť zobrazení. */ }
}

/**
 * Rozhodne, co se má u účtů zobrazit. Rozhodnuté účty se zapíšou do paměti
 * dne; nerozhodnuté převezmou dnešní poslední rozhodnutí, jinak zůstanou
 * nerozhodnuté („Ověřuji“).
 */
export function resolveDisplayEligibility(options: {
  accountIds: readonly number[];
  effective: ReadonlyMap<number, CopierAccountEligibility>;
  isUndecided: (accountId: number, eligibility: CopierAccountEligibility | undefined) => boolean;
  retained: RetainedEligibility;
  now?: number;
}): { byAccount: Map<number, CopierAccountEligibility>; undecided: Set<number>; retained: RetainedEligibility } {
  const now = options.now ?? Date.now();
  const byAccount = new Map(options.effective);
  const undecided = new Set<number>();
  const states = { ...options.retained.states };
  for (const accountId of options.accountIds) {
    const current = options.effective.get(accountId);
    if (!options.isUndecided(accountId, current)) {
      const state = current?.state ?? 'active';
      if (state === 'active' || state === 'dll-locked' || state === 'breached') {
        states[String(accountId)] = { state, ...(current?.reason ? { reason: current.reason } : {}) };
      }
      continue;
    }
    const remembered = options.retained.states[String(accountId)];
    if (!remembered) {
      undecided.add(accountId);
      continue;
    }
    if (remembered.state === 'active') {
      // Dnes už potvrzeno jako aktivní: bez štítku, čerstvá data to potvrdí.
      byAccount.delete(accountId);
      continue;
    }
    byAccount.set(accountId, {
      accountId,
      state: remembered.state,
      reason: `${remembered.reason ?? (remembered.state === 'dll-locked' ? 'Denní limit ztráty vyčerpán' : 'Účet vyřazen')} · naposledy potvrzeno dnes`,
      at: now,
    });
  }
  return { byAccount, undecided, retained: { tradeDate: options.retained.tradeDate, states } };
}
