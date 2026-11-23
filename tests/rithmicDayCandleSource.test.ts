import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRithmicDayCandleSource } from '../lib/rithmicDayCandleSource';
import type { RithmicLinkHandlers, RithmicLinkOptions } from '../lib/rithmicLocalConnection';

const T0 = Date.parse('2026-11-23T15:00:00Z');
const bar = (minute: number, close = 100 + minute) => ({ time: T0 / 1000 + minute * 60, open: 100, high: 200, low: 50, close, volume: 5 });

function setup(root?: string) {
  let handlers!: RithmicLinkHandlers;
  let clock = T0 + 3 * 60_000 + 20_000; // 15:03:20
  const calls: string[] = [];
  const sent: unknown[] = [];
  const source = createRithmicDayCandleSource({
    url: 'ws://127.0.0.1:3311/?token=x', root, now: () => clock,
    connect: (options: RithmicLinkOptions) => { handlers = options.handlers; return { start: () => { calls.push('start'); }, stop: () => { calls.push('stop'); } }; },
  });
  let notified = 0;
  source.subscribe(() => { notified += 1; });
  const hello = (extra: Record<string, unknown> = {}) => handlers.onMessage({ type: 'hello', system: 'Lucid', account: 'A1', symbol: 'MNQZ6', feed: true, price: 103.5, bars: [bar(0), bar(1), bar(2), bar(3)], ...extra });
  return { source, handlers: () => handlers, hello, calls, sent, tick: (ms: number) => { clock += ms; }, notified: () => notified };
}

describe('dnešní svíčky deníku z Rithmic služby (jen čtení)', () => {
  it('dokud služba neodpoví, čeká; když první pokus selže, hlásí nedostupnost a nenechá graf načítat donekonečna', () => {
    const t = setup();
    expect(t.source.snapshot().status).toBe('loading');
    t.handlers().onLink('connecting');
    expect(t.source.snapshot().status).toBe('loading');
    t.handlers().onLink('closed');
    expect(t.source.snapshot()).toMatchObject({ status: 'unavailable', candles: [] });
  });

  it('úvodní zpráva: dokončené minuty jdou mezi svíčky, rozpracovaná do živé svíčky', () => {
    const t = setup();
    t.handlers().onLink('open');
    t.hello();
    const snap = t.source.snapshot();
    expect(snap.status).toBe('live');
    expect(snap.symbol).toBe('MNQZ6');
    expect(snap.candles.map(c => c.time)).toEqual([bar(0).time, bar(1).time, bar(2).time]);
    expect(snap.capturedAt).toBe(T0 + 3 * 60_000);
    expect(t.source.feed.current('MNQ')).toMatchObject({ time: bar(3).time });
    expect(t.source.feed.current('NQ')).toMatchObject({ time: bar(3).time });
    expect(t.source.feed.current('ES')).toBeNull();
    expect(t.source.feed.lastPrice('MNQ')).toBe(103.5);
    expect(t.source.feed.contractMatchesData?.()).toBe(true);
  });

  it('tick uvnitř minuty deník nepřekresluje; nová minuta zapíše dokončenou svíčku', () => {
    const t = setup();
    t.handlers().onLink('open');
    t.hello();
    const before = t.notified();
    let feedTicks = 0;
    t.source.feed.subscribe(() => { feedTicks += 1; });
    t.handlers().onMessage({ type: 'tick', symbol: 'MNQZ6', price: 104, bar: bar(3, 104), at: T0 });
    t.handlers().onMessage({ type: 'tick', symbol: 'MNQZ6', price: 105, bar: bar(3, 105), at: T0 });
    expect(t.notified()).toBe(before);
    expect(feedTicks).toBe(2);
    expect(t.source.feed.current('MNQ')).toMatchObject({ close: 105 });
    t.tick(60_000);
    t.handlers().onMessage({ type: 'tick', symbol: 'MNQZ6', price: 106, bar: bar(4, 106), at: T0 });
    const snap = t.source.snapshot();
    expect(snap.candles.at(-1)).toMatchObject({ time: bar(3).time, close: 105 });
    expect(snap.candles).toHaveLength(4);
    expect(t.source.feed.current('MNQ')).toMatchObject({ time: bar(4).time });
    expect(t.notified()).toBe(before + 1);
  });

  it('tep každou sekundu deník nepřekresluje, dokud se nezmění minuta nebo stav', () => {
    const t = setup();
    t.handlers().onLink('open');
    t.hello();
    const before = t.notified();
    for (let i = 0; i < 5; i += 1) { t.tick(1_000); t.handlers().onMessage({ type: 'beat', at: T0, feed: true }); }
    expect(t.notified()).toBe(before);
    t.handlers().onMessage({ type: 'beat', at: T0, feed: false });
    expect(t.source.snapshot().status).toBe('stale');
    expect(t.source.feed.current('MNQ')).toBeNull();
    expect(t.source.feed.lastPrice('MNQ')).toBeNull();
  });

  it('výpadek spojení i mlčení služby: svíčky zůstanou, stav je starý a živá svíčka zmizí', () => {
    const t = setup();
    t.handlers().onLink('open');
    t.hello();
    t.handlers().onSilent(true);
    expect(t.source.snapshot().status).toBe('stale');
    expect(t.source.feed.current('MNQ')).toBeNull();
    t.hello();
    expect(t.source.snapshot().status).toBe('live');
    t.handlers().onSessionReset();
    t.handlers().onLink('closed');
    expect(t.source.snapshot().status).toBe('stale');
    expect(t.source.snapshot().candles).toHaveLength(3);
  });

  it('druhá úvodní zpráva s historií se se svíčkami spojí; návrat po výpadku graf nezkrátí', () => {
    const t = setup();
    t.handlers().onLink('open');
    t.hello({ bars: [bar(2), bar(3)] });
    expect(t.source.snapshot().candles.map(c => c.time)).toEqual([bar(2).time]);
    t.hello({ bars: [bar(-2), bar(-1), bar(0), bar(1), bar(2), bar(3)] });
    expect(t.source.snapshot().candles).toHaveLength(5);
    t.handlers().onSessionReset();
    t.handlers().onLink('open');
    t.hello({ bars: [bar(2), bar(3)] });
    expect(t.source.snapshot().candles).toHaveLength(5);
  });

  it('zkušební Rithmic Test ani jiný kontrakt se do deníku nepustí', () => {
    const test = setup();
    test.handlers().onLink('open');
    test.hello({ system: 'Rithmic Test' });
    expect(test.source.snapshot()).toMatchObject({ status: 'unavailable', candles: [], symbol: null });
    expect(test.source.feed.current('MNQ')).toBeNull();
    const other = setup();
    other.handlers().onLink('open');
    other.hello({ symbol: 'ESZ6' });
    expect(other.source.snapshot().status).toBe('unavailable');
    // Tick cizího kontraktu po přijaté úvodní zprávě se zahodí.
    const mine = setup();
    mine.handlers().onLink('open');
    mine.hello();
    mine.handlers().onMessage({ type: 'tick', symbol: 'ESZ6', price: 9, bar: bar(3, 9), at: T0 });
    expect(mine.source.feed.lastPrice('MNQ')).toBe(103.5);
  });

  it('vadné svíčky se zahodí a odmítnuté zařízení nic neukáže', () => {
    const t = setup();
    t.handlers().onLink('open');
    t.hello({ bars: [bar(0), { time: 'x' }, null, { ...bar(1), close: Number.NaN }, bar(2), bar(3)] });
    expect(t.source.snapshot().candles.map(c => c.time)).toEqual([bar(0).time, bar(2).time]);
    t.handlers().onAuthFailed?.('revoked');
    expect(t.source.snapshot()).toMatchObject({ status: 'unavailable', candles: [] });
  });

  it('zdroj jen poslouchá: spojení spustí a zastaví, žádný příkaz neposílá', () => {
    const t = setup();
    t.source.start();
    t.source.stop();
    expect(t.calls).toEqual(['start', 'stop']);
    const code = readFileSync(new URL('../lib/rithmicDayCandleSource.ts', import.meta.url), 'utf8');
    expect(code).not.toMatch(/\.send\(|\.command\(|flatten|placeEntry/);
  });
});
