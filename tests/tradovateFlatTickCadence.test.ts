import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dueFullTickConnections } from '../lib/tradovateFlatTickCadence';
import { tradovatePositionPollDelay } from '../components/useTradovateLiveData';
import { LIVE_READ_MAX_AGE_MS } from '../lib/liveReadFreshness';
import { LIVE_CHART_REST_CONFIRM_MAX_AGE_MS } from '../lib/liveChartExposureProjection';

const now = 1_800_000_000_000;
const idle = tradovatePositionPollDelay(true, 'off', false);
const fast = tradovatePositionPollDelay(true, 'off', true);

describe('tempo čtení prázdného připojení', () => {
  it('pozice na jiném připojení nerozběhne prázdné připojení po 3 s', () => {
    const lastFlatTickAt: Record<string, number> = { side: now };
    let reads = 0;
    // Minuta smyčky v rychlém tempu (pozice jinde): prázdné připojení se čte v tempu klidu.
    for (let at = now + fast; at <= now + 60_000; at += fast) {
      const due = dueFullTickConnections({ connectionIds: ['side'], hasOpenPosition: () => false, lastFlatTickAt, flatIntervalMs: idle, now: at });
      if (due.length) { reads += 1; lastFlatTickAt.side = at; }
    }
    expect(reads).toBe(60_000 / idle);
    expect(reads).toBeLessThan(60_000 / fast / 4);
  });

  it('připojení s pozicí se čte v každém kole, prázdné jen po svém intervalu', () => {
    expect(dueFullTickConnections({
      connectionIds: ['held', 'side'], hasOpenPosition: id => id === 'held',
      lastFlatTickAt: { held: now, side: now }, flatIntervalMs: idle, now: now + fast,
    })).toEqual(['held']);
  });

  it('když je prázdné všechno, čte se každé kolo jako dřív', () => {
    expect(dueFullTickConnections({ connectionIds: ['a', 'b'], hasOpenPosition: () => false,
      lastFlatTickAt: { a: now, b: now }, flatIntervalMs: idle, now: now + idle })).toEqual(['a', 'b']);
  });

  it('neznámý, nečíselný nebo budoucí čas posledního čtení = číst hned', () => {
    for (const last of [undefined, Number.NaN, now + 60_000]) {
      expect(dueFullTickConnections({ connectionIds: ['side'], hasOpenPosition: () => false,
        lastFlatTickAt: { side: last }, flatIntervalMs: idle, now })).toEqual(['side']);
    }
  });

  it('časovač probuzený o chlup dřív kolo nepřeskočí', () => {
    expect(dueFullTickConnections({ connectionIds: ['side'], hasOpenPosition: () => false,
      lastFlatTickAt: { side: now }, flatIntervalMs: idle, now: now + idle - 300 })).toEqual(['side']);
  });

  it('tempo klidu se s rezervou vejde do oken, která na čerstvém čtení stojí', () => {
    // Nejhorší rozestup v rychlé smyčce je interval + jedno kolo.
    expect(idle + fast).toBeLessThan(LIVE_READ_MAX_AGE_MS);
    expect(idle + fast).toBeLessThan(LIVE_CHART_REST_CONFIRM_MAX_AGE_MS);
  });

  it('smyčka čtení v appce používá vlastní tempo prázdných připojení', () => {
    const source = readFileSync(new URL('../components/useTradovateLiveData.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/const fullTickConnections = dueFullTickConnections\(\{[\s\S]{0,300}flatIntervalMs: idleDelay/);
    expect(source).toContain('flatTickAtRef.current[connectionId] = Date.now();');
  });
});
