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
