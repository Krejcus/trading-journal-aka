import { beforeEach, describe, expect, it, vi } from 'vitest';

const plugin = vi.hoisted(() => ({ perfTrace: vi.fn(async () => undefined) }));
vi.mock('../services/alphaTradeNativePlugin', () => ({ alphaTradeNativePlugin: plugin }));
vi.mock('../utils/runtimeConfig', () => ({ isNativeBuild: true }));

describe('perfTrace (měření na iPhonu)', () => {
  beforeEach(() => { plugin.perfTrace.mockClear(); vi.stubGlobal('window', globalThis); delete (globalThis as { __atPerf?: unknown }).__atPerf; });

  it('posílá jen název z povolené abecedy a celé ms; zarovnávací značku jednou', async () => {
    const { perfMark, perfDuration } = await import('../lib/perfTrace');
    perfMark('boot:auth-done');
    perfDuration('net:tradovate-oauth-status:fetch', 123.7);
    perfMark('Neplatné jméno s mezerou');
    perfDuration('ok:dur-negative', -1);
    const sent = plugin.perfTrace.mock.calls.map(call => (call as unknown as [{ name: string; ms: number }])[0]);
    expect(sent[0].name).toBe('origin:utc-ms-of-day');
    expect(sent.slice(1).map(entry => entry.name)).toEqual(['boot:auth-done', 'net:tradovate-oauth-status:fetch:dur']);
    expect(sent.every(entry => Number.isInteger(entry.ms) && /^[a-z0-9:._-]{1,80}$/.test(entry.name))).toBe(true);
  });

  it('URL zkrátí na bezpečný slug bez parametrů', async () => {
    const { perfSlug } = await import('../lib/perfTrace');
    expect(perfSlug('/api/tradovate/oauth/copier-relay?connectionId=abc&commandId=x')).toBe('tradovate-oauth-copier-relay');
  });

  it('Server-Timing rozloží na trvání po metrikách', async () => {
    const { perfServerTiming } = await import('../lib/perfTrace');
    perfServerTiming('copier-relay', 'auth;dur=12.4, resolve;desc="x";dur=80, bogus');
    const names = plugin.perfTrace.mock.calls.map(call => (call as unknown as [{ name: string; ms: number }])[0]);
    expect(names.filter(entry => entry.name.startsWith('srv:'))).toEqual([
      { name: 'srv:copier-relay:auth:dur', ms: 12 },
      { name: 'srv:copier-relay:resolve:dur', ms: 80 },
    ]);
  });
  it('nativní appka uloží značky běhu do localStorage (stažení bez kabelu)', async () => {
    vi.useFakeTimers();
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
    try {
      const { perfMark, PERF_RUNS_KEY } = await import('../lib/perfTrace');
      perfMark('boot:dashboard-paint');
      perfMark('boot:refresh-done');
      vi.advanceTimersByTime(1_600);
      const runs = JSON.parse(store.get(PERF_RUNS_KEY) ?? '[]');
      expect(runs).toHaveLength(1);
      expect(runs[0].entries.map((entry: { name: string }) => entry.name)).toEqual(expect.arrayContaining(['boot:dashboard-paint', 'boot:refresh-done']));
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
});

