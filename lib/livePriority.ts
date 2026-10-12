/**
 * Přednost pro LIVE při studeném otevření. Na iPhonu se při startu rozjede
 * obnova dashboardu (~6 MB), synchronizace deníku a jejich dotazy a zahltí
 * síť telefonu — malé dotazy LIVE (stav připojení, účty, stav kopírky) pak
 * čekaly 5–8 s. Dokud se LIVE poprvé nezobrazí s daty a stavem kopírky
 * (nejdéle LIVE_PRIORITY_MAX_MS), těžké čtení na pozadí počká.
 *
 * Jen pořadí síťových čtení: nic nezahazuje, nic neautorizuje.
 */
export const LIVE_PRIORITY_MAX_MS = 6_000;

let holdUntil = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let waiters: Array<() => void> = [];

const flush = () => {
  holdUntil = 0;
  if (timer != null) clearTimeout(timer);
  timer = null;
  const pending = waiters;
  waiters = [];
  pending.forEach(resolve => resolve());
};

export function holdForLive(maxMs = LIVE_PRIORITY_MAX_MS, now = Date.now()): void {
  const until = now + maxMs;
  if (until <= holdUntil) return;
  holdUntil = until;
  if (timer != null) clearTimeout(timer);
  timer = setTimeout(flush, maxMs);
}

export function releaseLivePriority(): void {
  if (holdUntil === 0 && waiters.length === 0) return;
  flush();
}

export function livePriorityActive(now = Date.now()): boolean {
  return holdUntil > now;
}

/** Počká, dokud LIVE nemá přednost (hned, když žádná neběží). */
export function afterLivePriority(now = Date.now()): Promise<void> {
  if (holdUntil <= now) return Promise.resolve();
  return new Promise(resolve => { waiters.push(resolve); });
}
