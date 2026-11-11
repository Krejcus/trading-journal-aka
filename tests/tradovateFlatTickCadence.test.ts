import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dueFullTickConnections, FULL_TICK_ROUND_COST_MS, isWorkerSideConnection, SIDE_FLAT_TICK_INTERVAL_MS } from '../lib/tradovateFlatTickCadence';
import { tradovatePositionPollDelay } from '../components/useTradovateLiveData';
import { LIVE_READ_MAX_AGE_MS } from '../lib/liveReadFreshness';
import { LIVE_CHART_REST_CONFIRM_MAX_AGE_MS } from '../lib/liveChartExposureProjection';

const now = 1_800_000_000_000;
const idle = tradovatePositionPollDelay(true, 'off', false);
const fast = tradovatePositionPollDelay(true, 'off', true);

/** Deset minut smyčky s koly plného čtení po `periodMs`; vrací rozestupy čtení prázdného připojení. */
const flatReadGaps = (periodMs: number, nextRoundMs: number): number[] => {
  const lastFlatTickAt: Record<string, number> = { side: now };
  const gaps: number[] = [];
  for (let at = now + periodMs; at <= now + 600_000; at += periodMs) {
    const due = dueFullTickConnections({ connectionIds: ['side'], hasOpenPosition: () => false, lastFlatTickAt, flatIntervalMs: idle, nextRoundMs, now: at });
    if (due.length) { gaps.push(at - lastFlatTickAt.side); lastFlatTickAt.side = at; }
  }
  return gaps;
};

describe('tempo čtení prázdného připojení', () => {
  it('pozice na účtech s ručením workeru nerozběhne prázdné připojení po 3 s', () => {
    // Smyčka po 3 s (+ doba čtení), plné čtení v každém kole.
    for (const period of [fast, fast + 300, fast + 1_000]) {
      const gaps = flatReadGaps(period, fast + FULL_TICK_ROUND_COST_MS);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(10_000);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(idle);
      // Dřív 20 čtení za minutu; teď nejvýš 6.
      expect(gaps.length).toBeLessThanOrEqual(60);
    }
  });

  it('s pozicí bez ručení workeru (plné čtení po 6–8 s) rozestup nepřekročí interval klidu', () => {
    for (let period = 6_000; period <= 8_000; period += 250) {
      const gaps = flatReadGaps(period, 6_000 + FULL_TICK_ROUND_COST_MS);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(idle + 1_000);
      expect(Math.max(...gaps)).toBeLessThan(LIVE_CHART_REST_CONFIRM_MAX_AGE_MS);
      // Nejhůř každé kolo plného čtení (tedy po 6–8 s), nikdy častěji.
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(period);
    }
  });

  it('připojení s pozicí se čte v každém kole, prázdné ne', () => {
    expect(dueFullTickConnections({
      connectionIds: ['held', 'side'], hasOpenPosition: id => id === 'held',
      lastFlatTickAt: { held: now, side: now }, flatIntervalMs: idle, nextRoundMs: fast + FULL_TICK_ROUND_COST_MS, now: now + fast,
    })).toEqual(['held']);
  });

  it('když je prázdné všechno, čte se každé kolo jako dřív', () => {
    expect(dueFullTickConnections({ connectionIds: ['a', 'b'], hasOpenPosition: () => false,
      lastFlatTickAt: { a: now, b: now }, flatIntervalMs: idle, nextRoundMs: idle + FULL_TICK_ROUND_COST_MS, now: now + idle })).toEqual(['a', 'b']);
    expect(flatReadGaps(idle, idle + FULL_TICK_ROUND_COST_MS).every(gap => gap === idle)).toBe(true);
  });

  it('neznámý, nečíselný nebo budoucí čas posledního čtení = číst hned', () => {
    for (const last of [undefined, Number.NaN, now + 60_000]) {
      expect(dueFullTickConnections({ connectionIds: ['side'], hasOpenPosition: () => false,
        lastFlatTickAt: { side: last }, flatIntervalMs: idle, nextRoundMs: 0, now })).toEqual(['side']);
    }
  });

  it('časovač probuzený o chlup dřív kolo nepřeskočí', () => {
    expect(dueFullTickConnections({ connectionIds: ['side'], hasOpenPosition: () => false,
      lastFlatTickAt: { side: now }, flatIntervalMs: idle, nextRoundMs: 0, now: now + idle - 300 })).toEqual(['side']);
  });

  it('interval klidu se vejde do oken, která na čerstvém čtení stojí', () => {
    expect(idle).toBeLessThan(LIVE_CHART_REST_CONFIRM_MAX_AGE_MS);
    expect(2 * idle).toBeLessThan(LIVE_READ_MAX_AGE_MS);
  });

  it('smyčka čtení v appce používá vlastní tempo prázdných připojení', () => {
    const source = readFileSync(new URL('../components/useTradovateLiveData.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/const fullTickConnections = dueFullTickConnections\(\{[\s\S]{0,300}flatIntervalMs: idleDelay/);
    expect(source).toMatch(/nextRoundMs: FULL_TICK_ROUND_COST_MS \+ \(hasOpenPosition \? ACTIVE_PNL_INTERVAL_MS/);
    // Razítko až po kontrole platnosti čtení; návrat do popředí a změna uživatele ho mažou.
    expect(source).toMatch(/if \(!readIsCurrent\(\)\) return;\s*\/\/[^\n]*\n\s*flatTickAtRef\.current\[connectionId\] = Date\.now\(\);/);
    expect(source.match(/flatTickAtRef\.current = \{\};/g)).toHaveLength(2);
    expect(source).toContain('const hasOpenPosition = uncoveredConnections.some(connectionHasPosition);');
  });

  it('smyčka dává vedlejšímu loginu delší interval jen na LIVE', () => {
    const source = readFileSync(new URL('../components/useTradovateLiveData.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/flatIntervalMsOf: connectionId => enabled && isWorkerSideConnection\(workerReadCoverageRef\.current,/);
  });
});

describe('vedlejší připojení (žádný účet ve skupině workera)', () => {
  const group = { leaderAccountId: 10, followers: [{ accountId: 11 }, { accountId: 12 }] };
  const receipt = (overrides: Record<string, unknown> = {}, ageMs = 1_000) => ({
    status: { controller: { connected: true }, group, ...overrides }, observedAt: now - ageMs });

  it('čte se po 30 s místo 15 s; účty skupiny a smíšené připojení původním tempem', () => {
    expect(isWorkerSideConnection(receipt(), [99], now)).toBe(true);
    expect(isWorkerSideConnection(receipt(), [10], now)).toBe(false);
    expect(isWorkerSideConnection(receipt(), [99, 12], now)).toBe(false);
    expect(isWorkerSideConnection(receipt(), [], now)).toBe(false);
    const lastFlatTickAt = { side: now, group: now };
    const due = (elapsed: number) => dueFullTickConnections({
      connectionIds: ['side', 'group'], hasOpenPosition: () => false, lastFlatTickAt, flatIntervalMs: idle,
      flatIntervalMsOf: id => id === 'side' ? SIDE_FLAT_TICK_INTERVAL_MS : 0, nextRoundMs: 0, now: now + elapsed });
    expect(due(idle)).toEqual(['group']);
    expect(due(SIDE_FLAT_TICK_INTERVAL_MS)).toEqual(['side', 'group']);
  });

  it('starý, odpojený nebo neúplný stav workera = původní tempo (porucha nesmí zpomalit čtení)', () => {
    expect(isWorkerSideConnection(receipt({}, 9_000), [99], now)).toBe(false);
    expect(isWorkerSideConnection(receipt({}, -5_000), [99], now)).toBe(false);
    expect(isWorkerSideConnection(receipt({ controller: { connected: false } }), [99], now)).toBe(false);
    expect(isWorkerSideConnection(receipt({ group: null }), [99], now)).toBe(false);
    expect(isWorkerSideConnection(receipt({ group: { leaderAccountId: 10 } }), [99], now)).toBe(false);
    expect(isWorkerSideConnection(receipt({ group: { leaderAccountId: 10, followers: [{}] } }), [99], now)).toBe(false);
    expect(isWorkerSideConnection(null, [99], now)).toBe(false);
    expect(isWorkerSideConnection({ status: null, observedAt: now }, [99], now)).toBe(false);
  });

  it('pozice na vedlejším připojení ho čte v každém kole', () => {
    expect(dueFullTickConnections({ connectionIds: ['side'], hasOpenPosition: () => true, lastFlatTickAt: { side: now },
      flatIntervalMs: idle, flatIntervalMsOf: () => SIDE_FLAT_TICK_INTERVAL_MS, nextRoundMs: 0, now: now + fast })).toEqual(['side']);
  });

  it('delší interval se pořád vejde do ověřovacího okna pozic', () => {
    expect(SIDE_FLAT_TICK_INTERVAL_MS + idle).toBeLessThanOrEqual(LIVE_READ_MAX_AGE_MS);
  });
});
