type PrivacyState = { locked: boolean; busy: boolean; error: boolean };
type NativeState = { enabled: boolean; generation: number };

/** A native lock generation separates a cancelled prompt from a new background lock. */
export function createNativePrivacyController(deps: {
  read: () => Promise<NativeState>; authenticate: () => Promise<boolean>;
}) {
  let state: PrivacyState = { locked: true, busy: false, error: false };
  let generation = 0;
  let unlockedGeneration: number | null = null;
  let attemptedGeneration: number | null = null;
  let refreshSequence = 0;
  const subscribers = new Set<(state: PrivacyState) => void>();
  const update = (next: Partial<PrivacyState>) => {
    state = { ...state, ...next };
    subscribers.forEach(fn => fn(state));
  };
  async function unlock() {
    if (state.busy) return;
    const attempt = generation;
    attemptedGeneration = attempt;
    update({ busy: true, error: false });
    try {
      const success = await deps.authenticate();
      const current = await deps.read();
      if (current.generation >= generation) {
        generation = current.generation;
        if (success && generation === attempt) unlockedGeneration = generation;
        update({ locked: current.enabled && unlockedGeneration !== generation, error: !success });
      }
    } catch { update({ locked: true, error: true }); }
    finally { update({ busy: false }); }
    // Retry only a newer native lock, never loop on a cancelled prompt.
    if (state.locked && generation !== attempt) await unlock();
  }
  async function refresh() {
    const request = ++refreshSequence;
    try {
      const current = await deps.read();
      if (request !== refreshSequence) return;
      if (current.generation < generation) return;
      generation = current.generation;
      if (!current.enabled) { unlockedGeneration = null; attemptedGeneration = null; }
      update({ locked: current.enabled && unlockedGeneration !== generation });
      if (state.locked && !state.busy && attemptedGeneration !== generation) await unlock();
    } catch { if (request === refreshSequence) update({ locked: true, error: true }); }
  }
  return {
    get state() { return state; }, refresh, unlock,
    subscribe(fn: (state: PrivacyState) => void) { subscribers.add(fn); fn(state); return () => { subscribers.delete(fn); }; },
  };
}
