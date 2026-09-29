import { describe, expect, it } from 'vitest';
import { createHostSleepDetector } from '../lib/hostSleepDetector';

describe('createHostSleepDetector', () => {
  it('rozliší spánek hosta od normálního zpoždění event loopu', () => {
    let wall = 1_000;
    let monotonic = 500;
    const detector = createHostSleepDetector({
      thresholdMs: 5_000,
      wallClock: () => wall,
      monotonicClock: () => monotonic,
    });

    wall += 2_000;
    monotonic += 2_000;
    expect(detector.observe()).toBeNull();

    wall += 65_000;
    monotonic += 1_000;
    expect(detector.observe()).toEqual({
      unresponsiveSince: 3_000,
      detectedAt: 68_000,
      sleepDurationMs: 64_000,
    });
  });
});
