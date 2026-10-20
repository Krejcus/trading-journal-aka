import { describe, expect, it } from 'vitest';
import { DAY_REPLAY_PREFS_KEY, DAY_REPLAY_STEP_S, candlesUntil, dayReplayRange, dayReplayTickMs, nextDayReplaySpeed, readDayReplayPrefs, retreatDayReplay, stepDayReplay, writeDayReplayPrefs } from '../lib/dayReplay';

const times = [600, 660, 720, 780, 840];

describe('dayReplay', () => {
  it('rozsah začíná oknem session (zaokrouhleno na minutu) a končí poslední svíčkou', () => {
    expect(dayReplayRange(times, null)).toEqual({ start: 600, end: 840 });
    expect(dayReplayRange(times, 701)).toEqual({ start: 660, end: 840 });
    expect(dayReplayRange(times, 0)).toEqual({ start: 600, end: 840 });
    expect(dayReplayRange(times, 99_999)).toEqual({ start: 840, end: 840 });
    expect(dayReplayRange([], 600)).toBeNull();
  });

  it('krok posouvá o svíčky a drží se v rozsahu', () => {
    const range = { start: 600, end: 840 };
    expect(stepDayReplay(600, 1, range)).toBe(600 + DAY_REPLAY_STEP_S);
    expect(stepDayReplay(600, -5, range)).toBe(600);
    expect(stepDayReplay(780, 10, range)).toBe(840);
  });

  it('svíčky do kurzoru včetně; bez kurzoru všechny', () => {
    const candles = times.map(time => ({ time }));
    expect(candlesUntil(candles, 720).map(item => item.time)).toEqual([600, 660, 720]);
    expect(candlesUntil(candles, 700).map(item => item.time)).toEqual([600, 660]);
    expect(candlesUntil(candles, 100)).toEqual([]);
    expect(candlesUntil(candles, null)).toHaveLength(5);
  });

  it('rychlost jde dokola a zkracuje interval', () => {
    expect(nextDayReplaySpeed(1)).toBe(3);
    expect(nextDayReplaySpeed(30)).toBe(1);
    expect(dayReplayTickMs(1)).toBe(600);
    expect(dayReplayTickMs(30)).toBe(20);
  });
});

describe('Bar Replay na telefonu', () => {
  it('krok zpět o interval přistane na existující svíčce a ne před začátek', () => {
    const candles = [600, 660, 720, 780, 840, 1200].map(time => ({ time }));
    expect(retreatDayReplay(candles, 840, 1, 600)).toBe(780);
    expect(retreatDayReplay(candles, 1200, 5, 600)).toBe(840);
    expect(retreatDayReplay(candles, 660, 5, 600)).toBe(600);
  });

  it('volby přehrávání: výchozí 1× a 1m, neplatné hodnoty se ignorují', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
    expect(readDayReplayPrefs(storage, [10, 1, 0.5])).toEqual({ speed: 1, step: 1 });
    writeDayReplayPrefs(storage, { speed: 0.5, step: 15 });
    expect(readDayReplayPrefs(storage, [10, 1, 0.5])).toEqual({ speed: 0.5, step: 15 });
    map.set(DAY_REPLAY_PREFS_KEY, JSON.stringify({ speed: 99, step: 7 }));
    expect(readDayReplayPrefs(storage, [10, 1, 0.5])).toEqual({ speed: 1, step: 1 });
  });
});
