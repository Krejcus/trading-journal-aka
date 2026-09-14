/** Capture only while this event still describes the chart. Upload retries
 * belong to the durable image spool and must never call capture again. */
export async function captureTimelyCopierSnapshot<T>(options: {
  eventAt: number;
  isCurrent: () => boolean;
  capture: (timeoutMs: number) => Promise<T | null>;
  onSkip: (code: string) => void;
  now?: () => number;
}): Promise<T | null> {
  const now = options.now ?? Date.now;
  const deadline = options.eventAt + 15_000;
  const valid = () => {
    const code = now() >= deadline ? 'snapshot-capture-expired'
      : !options.isCurrent() ? 'snapshot-capture-superseded' : null;
    if (code) options.onSkip(code);
    return code === null;
  };
  if (!valid()) return null;
  const image = await options.capture(Math.min(8_000, deadline - now()));
  return valid() ? image : null;
}
