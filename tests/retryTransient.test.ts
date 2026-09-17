import { describe, expect, it } from 'vitest';
import { isTransientRemoteError, retryTransient } from '../server/retryTransient';

describe('retryTransient', () => {
  it('retries transient failures with a growing, capped delay and returns the first success', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const result = await retryTransient(async attempt => {
      attempts = attempt;
      if (attempt < 4) throw new Error(`connection=conn:754e4b5b phase=lease-fetch mac-copier-lease-timeout (${attempt})`);
      return 'lease';
    }, { deadlineMs: 60_000, initialDelayMs: 5, maxDelayMs: 12, sleep: async ms => { delays.push(ms); } });
    expect(result).toBe('lease');
    expect(attempts).toBe(4);
    expect(delays).toEqual([5, 10, 12]);
  });
  it('gives up at the deadline with the last error instead of waiting forever', async () => {
    let now = 0;
    await expect(retryTransient(async () => { throw new Error('fetch failed'); },
      { deadlineMs: 20, initialDelayMs: 8, maxDelayMs: 8, clock: () => now, sleep: async ms => { now += ms; } }))
      .rejects.toThrow('fetch failed');
  });
  it('does not retry non-transient errors or when retries are disabled', async () => {
    let calls = 0;
    await expect(retryTransient(async () => { calls += 1; throw new Error('mac-copier-lease-http-401'); }, { deadlineMs: 60_000, sleep: async () => undefined }))
      .rejects.toThrow('http-401');
    expect(calls).toBe(1);
    await expect(retryTransient(async () => { calls += 1; throw new Error('fetch failed'); }, { deadlineMs: 0 })).rejects.toThrow('fetch failed');
    expect(calls).toBe(2);
  });
});

describe('isTransientRemoteError', () => {
  it('classifies timeouts, network failures and 5xx as transient; auth, identity and validation as final', () => {
    for (const message of ['mac-copier-lease-timeout', 'fetch failed', 'ECONNRESET', 'mac-copier-lease-http-502', 'tradovate-pilot-lease-failed', 'Tradovate account/list returned 503', 'The operation was aborted due to timeout']) {
      expect(isTransientRemoteError(new Error(message)), message).toBe(true);
    }
    for (const message of ['mac-copier-lease-http-401', 'mac-copier-lease-connection-mismatch', 'pilot-lease-expired', 'connection=conn:x phase=keychain Command failed', 'invalid-journal-projection']) {
      expect(isTransientRemoteError(new Error(message)), message).toBe(false);
    }
    expect(isTransientRemoteError(Object.assign(new Error('x'), { status: 502 }))).toBe(true);
    expect(isTransientRemoteError(Object.assign(new Error('x'), { status: 404 }))).toBe(false);
  });
});
