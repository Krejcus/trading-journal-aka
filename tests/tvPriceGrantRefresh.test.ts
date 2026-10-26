import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTvPriceGrantRefresh, TV_GRANT_REFRESH_MS, type TvPriceGrantRefreshDeps } from '../services/tvPriceGrant';

const GRANT = { topic: `tv-price-${'a'.repeat(22)}`, key: 'k'.repeat(43) };

const setup = (patch: Partial<TvPriceGrantRefreshDeps> = {}) => {
  let foreground = true;
  const listeners = new Set<(value: boolean) => void>();
  const offers: unknown[][] = [];
  const relay = vi.fn(async (connectionId: string) => (connectionId === 'c2'
    ? { connected: true, priceChannel: GRANT }
    : { connected: false }));
  const deps: TvPriceGrantRefreshDeps = {
    userId: async () => 'u1',
    connectionIds: vi.fn(async () => ['c1', 'c2']),
    relayStatus: relay,
    offer: (...args) => { offers.push(args); },
    isForeground: () => foreground,
    subscribeForeground: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    ...patch,
  };
  const setForeground = (value: boolean) => { foreground = value; listeners.forEach(listener => listener(value)); };
  return { deps, offers, relay, setForeground };
};

const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('grant kanálu ceny mimo LIVE (graf dne)', () => {
  it('přednost má odpověď s živým workerem a grantem; status se jinak nepoužije', async () => {
    const t = setup();
    const stop = startTvPriceGrantRefresh(t.deps);
    await flush();
    expect(t.offers).toEqual([['u1', GRANT, true]]);
    stop();
  });

  it('bez živého grantu nabídne poslední odpověď (serverový vypínač / grace) a seznam načte příště znovu', async () => {
    const t = setup({ relayStatus: async () => ({ connected: true }) });
    const stop = startTvPriceGrantRefresh(t.deps);
    await flush();
    expect(t.offers).toEqual([['u1', null, true]]);
    await vi.advanceTimersByTimeAsync(TV_GRANT_REFRESH_MS);
    expect(t.deps.connectionIds).toHaveBeenCalledTimes(2);
    stop();
  });

  it('na pozadí nenačítá, po návratu do popředí hned', async () => {
    const t = setup();
    t.setForeground(false);
    const stop = startTvPriceGrantRefresh(t.deps);
    await flush();
    expect(t.relay).not.toHaveBeenCalled();
    t.setForeground(true);
    await flush();
    expect(t.offers).toHaveLength(1);
    stop();
  });

  it('po zastavení během čtení nic nenabídne', async () => {
    let release!: () => void;
    const t = setup({ connectionIds: () => new Promise(resolve => { release = () => resolve(['c2']); }) });
    const stop = startTvPriceGrantRefresh(t.deps);
    await flush();
    stop();
    release();
    await flush();
    expect(t.relay).not.toHaveBeenCalled();
    expect(t.offers).toEqual([]);
  });

  it('souběžná načtení se slijí a chyba seznamu připojení se zkusí znovu v dalším kole', async () => {
    let calls = 0;
    const t = setup({ connectionIds: async () => { calls += 1; if (calls === 1) throw new Error('net'); return ['c2']; } });
    const stop = startTvPriceGrantRefresh(t.deps);
    t.setForeground(true);
    await flush();
    expect(calls).toBe(1);
    expect(t.offers).toEqual([]);
    await vi.advanceTimersByTimeAsync(TV_GRANT_REFRESH_MS);
    expect(t.offers).toEqual([['u1', GRANT, true]]);
    stop();
  });
});
