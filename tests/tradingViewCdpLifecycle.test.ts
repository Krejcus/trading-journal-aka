import { describe, expect, it, vi } from 'vitest';
import { ensureTradingViewCdp } from '../server/tradingViewCdpLifecycle';

describe('TradingView CDP lifecycle', () => {
  it('nedělá nic, když už CDP odpovídá', async () => {
    const processRunning = vi.fn(async () => false);
    const launch = vi.fn();
    await expect(ensureTradingViewCdp(true, {
      fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch,
      processRunning,
      launch,
    })).resolves.toBe('ready');
    expect(processRunning).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('existující TradingView bez CDP nikdy násilně nerestartuje', async () => {
    const launch = vi.fn();
    await expect(ensureTradingViewCdp(true, {
      fetchImpl: vi.fn(async () => { throw new TypeError('offline'); }) as typeof fetch,
      processRunning: async () => true,
      launch,
    })).resolves.toBe('running-without-cdp');
    expect(launch).not.toHaveBeenCalled();
  });

  it('po opt-inu spustí TradingView jen když aplikace neběží', async () => {
    const launch = vi.fn();
    await expect(ensureTradingViewCdp(true, {
      fetchImpl: vi.fn(async () => { throw new TypeError('offline'); }) as typeof fetch,
      processRunning: async () => false,
      launch,
    })).resolves.toBe('launched');
    expect(launch).toHaveBeenCalledOnce();
  });
});
