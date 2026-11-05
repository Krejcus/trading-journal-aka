import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canUseDirectLocalCopierAgent,
  canUseLocalCopierRelayWake,
  createLocalCopierAgentClient,
  nudgeLocalCopierRelay,
} from '../services/localCopierAgentClient';
import { shouldProbeLocalCopierAgent } from '../lib/localCopierProbePolicy';

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

  it('předá explicitní safety timeout do execution POSTu', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nonce: 'test-only' })))
      .mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
        if (init.signal?.aborted) {
          reject(new Error('write aborted'));
          return;
        }
        init.signal?.addEventListener('abort', () => reject(new Error('write aborted')), { once: true });
      }));
    vi.stubGlobal('fetch', fetcher);
    const result = createLocalCopierAgentClient().execute({ type: 'disarm' }, { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow('write aborted');
    expect(fetcher.mock.calls[1][1].signal).toBe(controller.signal);
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

describe('local relay wake', () => {
  it('povolí pouze lokální stránku a přesný produkční origin', () => {
    expect(canUseLocalCopierRelayWake({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(true);
    expect(canUseLocalCopierRelayWake({ protocol: 'http:', hostname: 'localhost' })).toBe(true);
    expect(canUseLocalCopierRelayWake({ protocol: 'https:', hostname: 'alphatrade-mentor-15.vercel.app' })).toBe(true);
    expect(canUseLocalCopierRelayWake({ protocol: 'https:', hostname: 'evil.example' })).toBe(false);
  });

  it('je best-effort: 202 = úspěch, chyba nebo timeout = false', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202 }))
      .mockRejectedValueOnce(new Error('blocked'));
    vi.stubGlobal('fetch', fetcher);
    await expect(nudgeLocalCopierRelay('http://127.0.0.1:3211')).resolves.toBe(true);
    await expect(nudgeLocalCopierRelay('http://127.0.0.1:3211')).resolves.toBe(false);

    vi.useFakeTimers();
    fetcher.mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const timed = nudgeLocalCopierRelay('http://127.0.0.1:3211', 25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(timed).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('local copier reprobe policy', () => {
  it('retries an unavailable desktop agent only after backoff or a visibility return', () => {
    const base = { directSupported: true, nativeBuild: false, state: 'unavailable' as const, lastAttemptAt: 10_000 };
    expect(shouldProbeLocalCopierAgent({ ...base, now: 29_999 })).toBe(false);
    expect(shouldProbeLocalCopierAgent({ ...base, now: 30_000 })).toBe(true);
    expect(shouldProbeLocalCopierAgent({ ...base, now: 10_100, resumedFromHidden: true })).toBe(true);
  });

  it('never probes loopback in a native build', () => {
    expect(shouldProbeLocalCopierAgent({
      directSupported: true,
      nativeBuild: true,
      state: 'unknown',
      now: 30_000,
      lastAttemptAt: null,
      resumedFromHidden: true,
    })).toBe(false);
  });

  it('never probes loopback from a production HTTPS page', () => {
    expect(shouldProbeLocalCopierAgent({
      directSupported: false,
      nativeBuild: false,
      state: 'unknown',
      now: 30_000,
      lastAttemptAt: null,
      resumedFromHidden: true,
    })).toBe(false);
  });
});
