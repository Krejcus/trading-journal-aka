export interface HostSleepIncident {
  unresponsiveSince: number;
  detectedAt: number;
  sleepDurationMs: number;
}

/**
 * Compares wall time with a monotonic clock. During macOS sleep the wall
 * clock advances while process.uptime() does not, so a large excess is a
 * host suspension rather than a broker outage.
 */
export function createHostSleepDetector(options: {
  thresholdMs?: number;
  wallClock?: () => number;
  monotonicClock?: () => number;
} = {}) {
  const thresholdMs = options.thresholdMs ?? 10_000;
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    throw new Error('host sleep threshold must be positive');
  }
  const wallClock = options.wallClock ?? Date.now;
  const monotonicClock = options.monotonicClock ?? (() => process.uptime() * 1_000);
  let previousWall = wallClock();
  let previousMonotonic = monotonicClock();

  return {
    observe(): HostSleepIncident | null {
      const wall = wallClock();
      const monotonic = monotonicClock();
      const wallDelta = wall - previousWall;
      const monotonicDelta = monotonic - previousMonotonic;
      const unresponsiveSince = previousWall;
      previousWall = wall;
      previousMonotonic = monotonic;
      if (wallDelta < 0 || monotonicDelta < 0) return null;
      const sleepDurationMs = wallDelta - monotonicDelta;
      if (sleepDurationMs < thresholdMs) return null;
      return { unresponsiveSince, detectedAt: wall, sleepDurationMs };
    },
  };
}
