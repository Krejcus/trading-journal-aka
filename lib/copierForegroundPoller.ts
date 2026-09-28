export const COPIER_STATUS_FRESH_MS = 15_000;
export const COPIER_STATUS_FUTURE_TOLERANCE_MS = 5_000;

export function isCopierStatusFresh(
  observedAt: number | null,
  now: number,
  readHealthy: boolean,
  maxAgeMs = COPIER_STATUS_FRESH_MS,
): boolean {
  if (!readHealthy || observedAt == null || !Number.isFinite(observedAt)) return false;
  const age = now - observedAt;
  return age >= -COPIER_STATUS_FUTURE_TOLERANCE_MS && age < maxAgeMs;
}

/** One read at a time. Returning to LIVE refreshes immediately, without accepting a pre-sleep response. */
export function createCopierForegroundPoller(options: {
  visible: () => boolean;
  read: (isCurrent: () => boolean) => Promise<void>;
  invalidate: () => void;
  now?: () => number;
  resumeCoalesceMs?: number;
}) {
  let stopped = false;
  let busy = false;
  let hiddenGeneration = 0;
  let requested = false;
  let wasVisible = options.visible();
  let lastResumeAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const now = options.now ?? Date.now;
  const resumeCoalesceMs = options.resumeCoalesceMs ?? 1_000;
  const run = async () => {
    if (stopped || !options.visible()) return;
    if (busy) { requested = true; return; }
    busy = true;
    requested = false;
    const currentHiddenGeneration = hiddenGeneration;
    try {
      await options.read(() => (
        !stopped
        && options.visible()
        && hiddenGeneration === currentHiddenGeneration
      ));
    } catch { /* The read reports unavailable state; the next cycle may recover. */ }
    finally {
      busy = false;
      if (!stopped && options.visible()) {
        if (requested) void run();
        else timer = setTimeout(() => void run(), 2_000);
      }
    }
  };
  const resume = () => {
    if (stopped) return;
    const visible = options.visible();
    if (!visible) {
      if (wasVisible) {
        wasVisible = false;
        hiddenGeneration += 1;
        requested = false;
        clearTimeout(timer);
        options.invalidate();
      }
      return;
    }

    const resumedFromHidden = !wasVisible;
    wasVisible = true;
    const at = now();
    if (!resumedFromHidden && at - lastResumeAt < resumeCoalesceMs) return;
    lastResumeAt = at;
    clearTimeout(timer);
    void run();
  };
  void run();
  return { resume, stop() { stopped = true; hiddenGeneration += 1; clearTimeout(timer); } };
}
