import { describe, expect, it } from 'vitest';
import { DAY_REPLAY_STEP_S, candlesUntil, dayReplayRange, dayReplayTickMs, nextDayReplaySpeed, stepDayReplay } from '../lib/dayReplay';

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
