import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTradovateDisplayPoller, DISPLAY_FALLBACK_INTERVAL_MS, type DisplayPollState } from '../lib/tradovateDisplayPoller';

describe('záložní čtení zůstatků: jedno čtení za minutu na připojení', () => {
  beforeEach(() => { vi.useFakeTimers({ now: 1_800_000_000_000 }); });
  afterEach(() => { vi.useRealTimers(); });

  const run = async (accountCount: number, minutes: number) => {
    const reads: number[] = [];
    const state: DisplayPollState = {
      userId: 'u', worker: null, publish: () => undefined,
      membership: new Map([['c1', { environment: 'demo' as const, accountIds: new Set(Array.from({ length: accountCount }, (_, i) => i + 1)) }]]),
    };
    const poller = createTradovateDisplayPoller({
      current: () => state, visible: () => true, failure: () => undefined,
      read: async (_connection, _environment, accountId) => { reads.push(accountId); return { snapshots: [], legacy: false }; },
    });
    await vi.advanceTimersByTimeAsync(minutes * 60_000);
    poller.stop();
    return reads;
  };

  it('čtyři účty: dřív 4 čtení za minutu, teď jedno, účty se střídají', async () => {
    const reads = await run(4, 10);
    expect(DISPLAY_FALLBACK_INTERVAL_MS).toBe(60_000);
    expect(reads.length).toBeGreaterThanOrEqual(8);
    expect(reads.length).toBeLessThanOrEqual(10);
    expect(reads.slice(0, 5)).toEqual([1, 2, 3, 4, 1]);
  });

  it('počet účtů tempo nezrychlí', async () => {
    expect((await run(20, 10)).length).toBeLessThanOrEqual(10);
    expect((await run(1, 10)).length).toBeLessThanOrEqual(10);
  });
});
