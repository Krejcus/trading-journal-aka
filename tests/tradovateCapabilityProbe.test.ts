import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeTradovateCapabilities } from '../server/tradovateCapabilityProbe';

afterEach(() => vi.unstubAllGlobals());

describe('dočasná sonda možností připojení', () => {
  it('jen GET na povolené hosty a do výstupu nedá token ani čísla', async () => {
    const calls: Array<{ url: string; method?: string; redirect?: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method, redirect: init.redirect });
      return Response.json([{ id: 123456, accountId: 999, changesLocked: true, adminAction: 'Normal', dailyLossAutoLiq: 1500 }]);
    });
    const steps = await probeTradovateCapabilities('secret-token', { demo: 'demo-api.lucid.ninjatrader.com', riskMonitorDemo: 'evil.example.com' });
    expect(calls.every(call => call.method === 'GET' && call.redirect === 'manual')).toBe(true);
    expect(calls.some(call => call.url.includes('evil.example.com'))).toBe(false);
    const text = JSON.stringify(steps);
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('123456');
    expect(text).not.toContain('1500');
    expect(text).toContain('changesLocked');
  });
});
