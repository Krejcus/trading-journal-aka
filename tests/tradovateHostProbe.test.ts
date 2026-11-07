import { describe, expect, it } from 'vitest';
import { describeTokenShape, isAllowedTradovateHost, probeTradovateHosts } from '../server/tradovateHostProbe';

const TOKEN = 'secret-token-value';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe('sonda dynamických hostů Tradovate', () => {
  it('povoluje jen známé domény', () => {
    expect(isAllowedTradovateHost('lucid.tradovateapi.com')).toBe(true);
    expect(isAllowedTradovateHost('evil.com')).toBe(false);
    expect(isAllowedTradovateHost('tradovateapi.com.evil.com')).toBe(false);
    expect(isAllowedTradovateHost('https://demo.tradovateapi.com')).toBe(false);
  });
  it('z odpovědi s tokenem vezme jen názvy polí a hosty', () => {
    const shape = describeTokenShape({ access_token: TOKEN, apiHosts: { demo: 'x.tradovateapi.com', bad: 'a/b' } });
    expect(shape).toEqual({ responseKeys: ['access_token', 'apiHosts'], apiHosts: { demo: 'x.tradovateapi.com' } });
    expect(JSON.stringify(shape)).not.toContain(TOKEN);
  });
  it('sleduje přesměrování na povolený host a do výstupu nedá token', async () => {
    const calls: string[] = [];
    const steps = await probeTradovateHosts({
      baseHost: 'demo.tradovateapi.com', accessToken: TOKEN,
      fetchImpl: (async (input: string) => {
        calls.push(input);
        if (input === 'https://demo.tradovateapi.com/v1/auth/me') return json(307, {}, { location: 'https://org.tradovateapi.com/v1/auth/me' });
        if (input.endsWith('/auth/me')) return json(200, { userId: 1, email: 'x' });
        return json(200, { accessToken: TOKEN, apiHosts: { demo: 'org.tradovateapi.com' } });
      }) as unknown as typeof fetch,
    });
    expect(calls).toEqual([
      'https://demo.tradovateapi.com/v1/auth/me',
      'https://org.tradovateapi.com/v1/auth/me',
      'https://org.tradovateapi.com/v1/auth/renewaccesstoken',
    ]);
    expect(steps[0].locationHost).toBe('org.tradovateapi.com');
    expect(steps[2].apiHosts).toEqual({ demo: 'org.tradovateapi.com' });
    expect(JSON.stringify(steps)).not.toContain(TOKEN);
  });
  it('na nepovolený host token nepošle a chyba sítě sondu neshodí', async () => {
    const calls: string[] = [];
    const steps = await probeTradovateHosts({
      baseHost: 'demo.tradovateapi.com', accessToken: TOKEN,
      fetchImpl: (async (input: string) => {
        calls.push(input);
        if (input.endsWith('/auth/me')) return json(307, {}, { location: 'https://evil.com/v1/auth/me' });
        throw new Error('network');
      }) as unknown as typeof fetch,
    });
    expect(calls.some(url => url.includes('evil.com'))).toBe(false);
    expect(steps.at(-1)?.status).toBeNull();
  });
});
