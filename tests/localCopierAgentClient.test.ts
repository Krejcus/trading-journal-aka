import { afterEach, describe, expect, it, vi } from 'vitest';
import { canUseDirectLocalCopierAgent, createLocalCopierAgentClient } from '../services/localCopierAgentClient';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('local status deadline', () => {
  it('releases a hanging read so the dashboard can fall back to cloud', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('read aborted')), { once: true });
    })));
    const result = createLocalCopierAgentClient().status();
    const rejected = expect(result).rejects.toThrow('read aborted');
    await vi.advanceTimersByTimeAsync(1_500);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not apply the read deadline or retries to an execution write', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nonce: 'test-only' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: {} })));
    vi.stubGlobal('fetch', fetcher);
    await createLocalCopierAgentClient().execute({ type: 'disarm' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].method).toBe('POST');
    expect(fetcher.mock.calls[1][1].signal).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('canUseDirectLocalCopierAgent', () => {
  it('povolí přímý agent pouze z lokální HTTP stránky', () => {
    expect(canUseDirectLocalCopierAgent({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(true);
    expect(canUseDirectLocalCopierAgent({ protocol: 'http:', hostname: 'localhost' })).toBe(true);
  });

  it('na produkční HTTPS stránce vždy použije zabezpečený relay', () => {
    expect(canUseDirectLocalCopierAgent({ protocol: 'https:', hostname: 'alphatrade-mentor-15.vercel.app' })).toBe(false);
    expect(canUseDirectLocalCopierAgent({ protocol: 'https:', hostname: '127.0.0.1' })).toBe(false);
  });
});
