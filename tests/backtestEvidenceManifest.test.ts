import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildBacktestDataManifest, type BacktestDataManifestInput } from '../services/backtestDataManifest';
import { buildBacktestExecutionProfile } from '../services/backtestExecutionProfile';
import { hashBacktestEvidence } from '../services/backtestEvidenceIdentity';
import { DEFAULT_BACKTEST_CONFIG } from '../services/backtestTypes';

const start = Date.parse('2026-09-04T20:00:00Z');
const candle = (offset: number) => ({ time: start / 1000 + offset * 60, open: 100, high: 102, low: 99, close: 101, volume: 20 });
const input = (): BacktestDataManifestInput => ({ source: { provider: 'databento', dataset: 'GLBX.MDP3', symbol: 'MNQ.v.0', basis: 'configured-loader' }, schema: 'ohlcv-1m', range: { startMs: start, endMs: start + 4 * 60_000 }, candles: [candle(0), candle(1), candle(2), candle(3)] });

describe('backtest data evidence', () => {
  it('uses standard SHA-256 of canonical JSON and ignores object key ordering', async () => {
    const expected = 'sha256:' + createHash('sha256').update('{"a":1,"b":2}').digest('hex');
    expect(await hashBacktestEvidence({ b: 2, a: 1 })).toBe(expected);
    expect(await hashBacktestEvidence({ a: 1, b: 2 })).toBe(expected);
  });
  it('identifies observed data independently from ordering or prefetched future; reports order defects separately', async () => {
    const source = input();
    const baseline = await buildBacktestDataManifest(source);
    const shuffled = await buildBacktestDataManifest({ ...source, candles: [candle(3), candle(1), candle(0), candle(2), candle(500)] });
    expect(shuffled.contentHash).toBe(baseline.contentHash);
    expect(shuffled.quality.outOfOrderTransitions).toBe(2);
    expect(baseline.coverage.observedGridSlots).toBe(4);
    expect(baseline.coverage.fetchedGridSlots).toBe(0); // bars are not fetch logs
    const changed = await buildBacktestDataManifest({ ...source, candles: [candle(0), { ...candle(1), close: 102 }, candle(2), candle(3)] });
    expect(changed.contentHash).not.toBe(baseline.contentHash);
    expect(source.candles).toEqual(input().candles);
  });
  it('detects invalid OHLC/volume/alignment and identical vs conflicting duplicate rows', async () => {
    const source = input();
    const manifest = await buildBacktestDataManifest({ ...source, candles: [candle(0), candle(0), { ...candle(0), high: 103 }, { ...candle(1), high: 98 }, { ...candle(2), volume: -1 }, { ...candle(3), time: candle(3).time + 1 }] });
    expect(manifest.quality).toMatchObject({ invalidRows: 3, duplicateRows: 2, conflictingDuplicateTimestamps: 1 });
    expect(manifest.coverage.observedGridSlots).toBe(1);
    expect(manifest.coverage.gaps.reduce((n, gap) => n + gap.slots, 0)).toBe(3);
  });
  it('does not classify a successful empty weekend fetch as a verified closure without calendar evidence', async () => {
    const source = input();
    source.range = { startMs: Date.parse('2026-09-05T12:00:00Z'), endMs: Date.parse('2026-09-05T13:00:00Z') };
    source.candles = []; source.fetchedRanges = [source.range];
    const unknown = await buildBacktestDataManifest(source);
    expect(unknown.coverage.gaps).toMatchObject([{ kind: 'unknown-schedule', slots: 60, fetchVerified: true }]);
    const closed = await buildBacktestDataManifest({ ...source, calendar: { id: 'test-calendar', version: '1', source: 'explicit fixture only', evaluatedRange: source.range, openIntervals: [] } });
    expect(closed.coverage.gaps).toMatchObject([{ kind: 'calendar-closed', slots: 60 }]);
    expect(closed.contentHash).toBe(unknown.contentHash);
    expect(closed.manifestHash).not.toBe(unknown.manifestHash);
  });
  it('separates missing fetched/open bars, fetch-unverified intervals and observed calendar contradictions', async () => {
    const source = input();
    source.candles = [candle(0)];
    source.fetchedRanges = [{ startMs: start, endMs: start + 2 * 60_000 }];
    source.calendar = { id: 'fixture', version: '1', source: 'test', evaluatedRange: source.range, openIntervals: [{ startMs: start + 60_000, endMs: source.range.endMs }] };
    const manifest = await buildBacktestDataManifest(source);
    expect(manifest.coverage.observedCalendarClosedSlots).toBe(1);
    expect(manifest.coverage.gaps).toMatchObject([{ kind: 'expected-open-without-bar', slots: 1 }, { kind: 'fetch-unverified', slots: 2 }]);
    expect(manifest.coverage.fetchedGridSlots).toBe(2);
  });
  it('canonicalizes overlapping fetch intervals; response vs configured source remains explicit evidence', async () => {
    const source = input();
    const a = await buildBacktestDataManifest({ ...source, fetchedRanges: [{ startMs: start + 60_000, endMs: source.range.endMs }, { startMs: start, endMs: start + 2 * 60_000 }] });
    const b = await buildBacktestDataManifest({ ...source, fetchedRanges: [source.range] });
    expect(a.manifestHash).toBe(b.manifestHash);
    expect(a.source.sourceSymbol).toBeNull();
    const response = await buildBacktestDataManifest({ ...source, source: { ...source.source, basis: 'response', sourceSymbol: 'MNQU6' } });
    expect(response.source.sourceSymbol).toBe('MNQU6');
    expect(response.contentHash).toBe(a.contentHash);
    expect(response.manifestHash).not.toBe(a.manifestHash);
  });
});

describe('execution profile identity', () => {
  it('snapshots effective defaults, costs, instrument economics and actual minute OHLC policies', async () => {
    const config = structuredClone(DEFAULT_BACKTEST_CONFIG);
    delete config.flatByMinute; delete config.flatTimeZone;
    const profile = await buildBacktestExecutionProfile(config, 'fixture-engine-revision');
    expect(profile.costs.MNQ).toMatchObject({ tickSize: 0.25, pointValue: 2, commissionPerSide: 0.37 });
    expect(profile.costs.NQ.pointValue).toBe(20);
    expect(profile.cutoff).toMatchObject({ timeZone: 'America/Chicago', minuteOfDay: 910 });
    expect(profile.implementation.codeRevision).toBe('fixture-engine-revision');
    expect(profile.execution.restingActivation).toBe('only candle.time > order.updatedAt');
    config.commissionPerSide.MNQ = 999;
    expect(profile.costs.MNQ.commissionPerSide).toBe(0.37);
  });
  it('hash changes for fees, slippage, cutoff and engine revision; instrument ordering is irrelevant', async () => {
    const config = structuredClone(DEFAULT_BACKTEST_CONFIG);
    const base = await buildBacktestExecutionProfile(config);
    expect((await buildBacktestExecutionProfile({ ...config, instruments: [...config.instruments].reverse() })).profileHash).toBe(base.profileHash);
    for (const variant of [{ ...config, commissionPerSide: { ...config.commissionPerSide, MNQ: 1 } }, { ...config, slippageTicks: { ...config.slippageTicks, MNQ: 1 } }, { ...config, flatByMinute: 900 }]) expect((await buildBacktestExecutionProfile(variant)).profileHash).not.toBe(base.profileHash);
    expect((await buildBacktestExecutionProfile(config, 'new-build')).profileHash).not.toBe(base.profileHash);
  });
  it('rejects nonfinite costs and invalid cutoff timezones without mutating input', async () => {
    await expect(buildBacktestExecutionProfile({ ...DEFAULT_BACKTEST_CONFIG, flatTimeZone: 'Mars/Invalid' })).rejects.toThrow();
    await expect(buildBacktestExecutionProfile({ ...DEFAULT_BACKTEST_CONFIG, slippageTicks: { MNQ: NaN, NQ: 0 } })).rejects.toThrow();
  });
});

it('does not call an hourly slot closed when a supplied calendar is open for part of it', async () => {
  const source = input();
  source.schema = 'ohlcv-1h'; source.range = { startMs: start, endMs: start + 3_600_000 };
  source.candles = []; source.fetchedRanges = [source.range];
  source.calendar = { id: 'partial-hour', version: '1', source: 'test fixture', evaluatedRange: source.range, openIntervals: [{ startMs: start, endMs: start + 1_800_000 }] };
  const manifest = await buildBacktestDataManifest(source);
  expect(manifest.timeframe).toBe('1h');
  expect(manifest.coverage.gaps).toMatchObject([{ calendarStatus: 'mixed', kind: 'unknown-schedule', slots: 1 }]);
});
