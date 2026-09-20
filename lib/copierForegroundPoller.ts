/** One read at a time. Returning to LIVE refreshes immediately, without accepting a pre-sleep response. */
export function createCopierForegroundPoller(options: {
  visible: () => boolean;
  read: (isCurrent: () => boolean) => Promise<void>;
  invalidate: () => void;
}) {
  let stopped = false;
  let busy = false;
  let generation = 0;
  let requested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    if (stopped || !options.visible()) return;
    if (busy) { requested = true; return; }
    busy = true;
    requested = false;
    const current = generation;
    try {
      await options.read(() => !stopped && options.visible() && generation === current);
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
    generation += 1;
    clearTimeout(timer);
    options.invalidate();
    if (options.visible()) void run();
  };
  void run();
  return { resume, stop() { stopped = true; generation += 1; clearTimeout(timer); } };
}
