import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTvPriceStream, type TvPriceStreamDeps, type TvStreamReading } from '../services/tradingViewPriceStream';
import type { TvPriceEnvelope, TvPricePayload } from '../lib/tvPriceMessage';

const reading = (close: number, overrides: Partial<TvStreamReading> = {}): TvStreamReading => ({
  chart: 'CME_MINI:MNQ1!', interval: '1', pane: 1, bar: [1_792_994_820, 29_144, 29_150, 29_140, close],
  last: close, bid: close - 0.25, ask: close, mode: 'streaming', ...overrides,
});

const setup = (overrides: Partial<TvPriceStreamDeps> = {}) => {
  const published: TvPricePayload[] = [];
  let current = reading(29_145);
  let demand = true;
  let ready = true;
  const deps: TvPriceStreamDeps = {
    read: vi.fn(async () => current),
    meta: () => ({ front: 'MNQZ2026', switchAt: 1_797_285_601 }),
    demand: () => demand,
    ready: () => ready,
    sign: async payload => ({ p: JSON.stringify(payload), sig: 'sig' }) as TvPriceEnvelope,
    publish: vi.fn(async (envelope: TvPriceEnvelope) => { published.push(JSON.parse(envelope.p)); return true; }),
    runId: 'run-1',
    ...overrides,
  };
  const stream = createTvPriceStream(deps);
  return {
    stream, deps, published,
    setReading: (value: TvStreamReading) => { current = value; },
    setDemand: (value: boolean) => { demand = value; },
    setReady: (value: boolean) => { ready = value; },
  };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('jádro kanálu ceny z TV (vlákno workeru)', () => {
  it('bez poslechu klienta nečte ani neposílá, jen se jednou za sekundu podívá', async () => {
    const t = setup();
    t.setDemand(false);
    t.stream.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.deps.read).not.toHaveBeenCalled();
    expect(t.published).toHaveLength(0);
    expect(t.stream.stats().state).toBe('idle');
    t.stream.stop();
  });

  it('bez připojeného kanálu nečte ani neposílá (žádný REST fallback)', async () => {
    const t = setup();
    t.setReady(false);
    t.stream.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.deps.read).not.toHaveBeenCalled();
    expect(t.deps.publish).not.toHaveBeenCalled();
    t.stream.stop();
  });

  it('čte po 250 ms, posílá při změně a jinak heartbeat 1/s; seq roste jen po odeslání', async () => {
    const t = setup();
    t.stream.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(t.published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(900);
    expect((t.deps.read as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(t.published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(t.published).toHaveLength(2);
    t.setReading(reading(29_146.5));
    await vi.advanceTimersByTimeAsync(260);
    expect(t.published).toHaveLength(3);
    expect(t.published.map(item => item.seq)).toEqual([0, 1, 2]);
    expect(t.published[2]).toMatchObject({ v: 1, runId: 'run-1', last: 29_146.5, front: 'MNQZ2026', interval: '1' });
    t.stream.stop();
  });

  it('po návratu poslechu pošle hned i neměnnou cenu', async () => {
    const t = setup();
    t.stream.start();
    await vi.advanceTimersByTimeAsync(10);
    t.setDemand(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const before = t.published.length;
    t.setDemand(true);
    await vi.advanceTimersByTimeAsync(1_010);
    expect(t.published.length).toBe(before + 1);
    t.stream.stop();
  });

  it('jedno čtení naráz: visící CDP neplodí další čtení', async () => {
    const read = vi.fn(() => new Promise<TvStreamReading | null>(() => {}));
    const t = setup({ read });
    t.stream.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(t.published).toHaveLength(0);
    t.stream.stop();
  });

  it('chyba čtení se jen započítá a další čtení počká 1 s', async () => {
    const read = vi.fn(async () => { throw new Error('cdp-closed'); });
    const t = setup({ read });
    t.stream.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(t.stream.stats().errors).toBe(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(read).toHaveBeenCalledTimes(2);
    t.stream.stop();
  });

  it('nepodepsaná zpráva ani neúspěšné odeslání neposune seq', async () => {
    const publish = vi.fn(async () => false);
    const t = setup({ publish });
    t.stream.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(t.stream.stats().sends).toBe(0);
    const unsigned = setup({ sign: async () => null });
    unsigned.stream.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(unsigned.deps.publish).not.toHaveBeenCalled();
    t.stream.stop();
    unsigned.stream.stop();
  });

  it('strop 5 zpráv za sekundu drží i při okamžitých tikách', async () => {
    let close = 29_000;
    const t = setup({
      read: async () => reading(close += 0.25),
      setTimeoutImpl: (callback: () => void) => { queueMicrotask(callback); return 0; },
      clearTimeoutImpl: () => {},
    });
    t.stream.start();
    for (let step = 0; step < 50; step += 1) await Promise.resolve();
    expect(t.published.length).toBeLessThanOrEqual(5);
    expect(t.stream.stats().skippedRateCap).toBeGreaterThan(0);
    t.stream.stop();
  });

  it('nudge (dávka obchodů IBKR) pošle novou cenu za 25 ms, ne až v dalším kole po 250 ms', async () => {
    const t = setup();
    t.stream.start();
    await vi.advanceTimersByTimeAsync(205);
    expect(t.published).toHaveLength(1);
    t.setReading(reading(29_147));
    for (let index = 0; index < 50; index += 1) t.stream.nudge();
    await vi.advanceTimersByTimeAsync(24);
    expect(t.published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(t.published).toHaveLength(2);
    expect(t.published[1]).toMatchObject({ seq: 1, last: 29_147 });
    // Celá dávka = jedno čtení; běžné kolo pak běží dál po 250 ms od něj.
    const reads = (t.deps.read as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    expect((t.deps.read as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads);
    t.stream.stop();
  });

  it('nudge drží rozestup 200 ms od poslední zprávy', async () => {
    const t = setup();
    t.stream.start();
    await vi.advanceTimersByTimeAsync(10);
    t.setReading(reading(29_147));
    t.stream.nudge();
    await vi.advanceTimersByTimeAsync(180);
    expect(t.published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(t.published).toHaveLength(2);
    t.stream.stop();
  });

  it('souvislý proud obchodů: zprávy rovnoměrně po 200 ms, strop se nezasekne', async () => {
    let close = 29_000;
    const t = setup({ read: vi.fn(async () => reading(close)) });
    t.stream.start();
    for (let ms = 0; ms < 3_000; ms += 7) {
      close += 0.25;
      t.stream.nudge();
      await vi.advanceTimersByTimeAsync(7);
    }
    const times = t.published.map(item => item.at);
    const gaps = times.slice(1).map((value, index) => value - times[index]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(200);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(260);
    expect(t.stream.stats().skippedRateCap).toBe(0);
    t.stream.stop();
  });

  it('po chybě odeslání nudge neobejde prodlevu 1 s', async () => {
    const publish = vi.fn(async () => { throw new Error('socket'); });
    const t = setup({ publish });
    t.stream.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(publish).toHaveBeenCalledTimes(1);
    for (let ms = 0; ms < 900; ms += 50) {
      t.stream.nudge();
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(publish).toHaveBeenCalledTimes(2);
    t.stream.stop();
  });

  it('stop zruší čtení naplánované přes nudge', async () => {
    const t = setup();
    t.stream.start();
    await vi.advanceTimersByTimeAsync(300);
    const reads = (t.deps.read as ReturnType<typeof vi.fn>).mock.calls.length;
    t.stream.nudge();
    t.stream.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((t.deps.read as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads);
  });

  it('nudge během čtení: po něm se čte znovu hned, jen jeden řetěz čtení', async () => {
    let release: (() => void) | null = null;
    let close = 29_145;
    const read = vi.fn(() => new Promise<TvStreamReading | null>(resolve => { release = () => resolve(reading(close)); }));
    const t = setup({ read });
    t.stream.start();
    await vi.advanceTimersByTimeAsync(1);
    close = 29_146;
    t.stream.nudge();
    t.stream.nudge();
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(190);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(read).toHaveBeenCalledTimes(2);
    close = 29_147;
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.published.map(item => item.last)).toEqual([29_146, 29_147]);
    t.stream.stop();
  });

  it('nudge bez poslechu klienta ani po stop nic nečte', async () => {
    const t = setup();
    t.setDemand(false);
    t.stream.start();
    await vi.advanceTimersByTimeAsync(10);
    t.stream.nudge();
    await vi.advanceTimersByTimeAsync(100);
    expect(t.deps.read).not.toHaveBeenCalled();
    t.stream.stop();
    t.stream.nudge();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.deps.read).not.toHaveBeenCalled();
  });

  it('změna jen bid/ask zprávu nevyvolá (jede s další změnou nebo heartbeatem)', async () => {
    const t = setup();
    t.stream.start();
    await vi.advanceTimersByTimeAsync(10);
    t.setReading(reading(29_145, { bid: 29_144, ask: 29_145.25 }));
    await vi.advanceTimersByTimeAsync(800);
    expect(t.published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(t.published).toHaveLength(2);
    expect(t.published[1]).toMatchObject({ bid: 29_144, ask: 29_145.25 });
    t.stream.stop();
  });

  it('stop zastaví čtení i odesílání', async () => {
    const t = setup();
    t.stream.start();
    await vi.advanceTimersByTimeAsync(10);
    t.stream.stop();
    const reads = (t.deps.read as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect((t.deps.read as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads);
    expect(t.stream.stats().state).toBe('stopped');
  });
});
