/** Debounce bursts and allow only one read in flight. An event arriving during
 * the read invalidates it and schedules exactly one trailing fresh read. */
export function coalescedJournalRead(options: {
  read: (isLatest: () => boolean) => Promise<void>; delayMs?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let disposed = false;
  let version = 0;
  const schedule = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      if (disposed || running) return;
      running = true;
      const current = version;
      try { await options.read(() => !disposed && version === current); }
      finally { running = false; if (!disposed && current !== version) schedule(); }
    }, options.delayMs ?? 350);
  };
  return {
    request() { if (!disposed) { version++; if (!running) schedule(); } },
    dispose() { disposed = true; version++; if (timer) clearTimeout(timer); },
  };
}
