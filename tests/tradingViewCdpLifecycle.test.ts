import { describe, expect, it, vi } from 'vitest';
import { ensureTradingViewCdp, restartTradingViewWithCdp } from '../server/tradingViewCdpLifecycle';

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

  it('výslovná UI oprava standardně ukončí běžící aplikaci a spustí ji s CDP', async () => {
    let running = true;
    let cdpReady = false;
    const quit = vi.fn(async () => { running = false; });
    const launch = vi.fn(async () => { running = true; cdpReady = true; });
    await expect(restartTradingViewWithCdp({
      fetchImpl: vi.fn(async () => cdpReady
        ? new Response('{}', { status: 200 })
        : Promise.reject(new TypeError('offline'))) as typeof fetch,
      processRunning: async () => running,
      quit,
      launch,
      sleep: async () => undefined,
      pollIntervalMs: 10,
      quitTimeoutMs: 500,
      cdpTimeoutMs: 500,
    })).resolves.toBe('restarted');
    expect(quit).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('při odmítnutém ukončení nespustí druhou instanci TradingView', async () => {
    const launch = vi.fn();
    await expect(restartTradingViewWithCdp({
      fetchImpl: vi.fn(async () => Promise.reject(new TypeError('offline'))) as typeof fetch,
      processRunning: async () => true,
      quit: async () => undefined,
      launch,
      sleep: async () => undefined,
      pollIntervalMs: 10,
      quitTimeoutMs: 500,
    })).resolves.toBe('quit-timeout');
    expect(launch).not.toHaveBeenCalled();
  });
});
