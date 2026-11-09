import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildTradeCard } from '../lib/liveTradeCard';
import type { LiveAccount } from '../services/tradecopiaLiveService';
import { tradeCardIbkrLegs } from '../lib/ibkrDisplayPnl';
import { ibkrPositionFingerprint, ibkrPositionPnl, independentIbkrTick, type IbkrDisplayPositionLeg } from '../lib/ibkrDisplayPnl';
import type { TvPriceFeedView } from '../lib/tvPriceStore';
import { tradovateRequestHealthDisplay } from '../lib/tradovateRequestHealthDisplay';
import type { TradovateRequestHealth, TradovateWorkerAccountCoverage } from '../lib/tradovateRequestControl';
const NOW = 1_800_000;
const feed = (patch: Partial<NonNullable<TvPriceFeedView['latest']>> = {}): TvPriceFeedView => ({ fresh: true, samples: [], trail: null,
  latest: { v: 1, runId: 'signed-run', seq: 12, chart: 'IBKR:MNQZ2026', front: 'MNQZ2026', switchAt: null, interval: '1', pane: 0, mode: 'streaming',
    bar: [1740, 26_000, 26_010, 25_990, 26_010], last: 26_010, bid: 26_009.75, ask: 26_010, at: NOW, ...patch } });
const leg = (patch: Partial<IbkrDisplayPositionLeg> = {}): IbkrDisplayPositionLeg => ({ accountId: 100, symbol: 'MNQZ6', netPosition: 2, averagePrice: 26_000,
  capturedAt: NOW - 1_000, fingerprint: ibkrPositionFingerprint(100, 'MNQZ6', 2, 26_000, NOW - 1_000), fees: 4, ...patch });
const coverage = (): TradovateWorkerAccountCoverage => ({ accountId: 100, connectionId: 'login-a', environment: 'demo', routeEpoch: 1, currentRouteEpoch: 1,
  sessionId: 'session', currentSessionId: 'session', baselineAt: NOW - 600_000, lastDataAt: NOW - 60_000, observedAt: NOW,
  socketLive: true, synchronized: true, gap: false, backlog: false, mergeInProgress: false });

describe('exact IBKR display PnL independent of broker anchor and minute snapshot', () => {
  it('uses price minus actual position and known fees, with no broker PnL anchor', () => {
    expect(ibkrPositionPnl([leg()], feed(), NOW, NOW)).toBe(36);
    const short = leg({ netPosition: -2, fingerprint: ibkrPositionFingerprint(100, 'MNQZ6', -2, 26_000, NOW - 1_000) });
    expect(ibkrPositionPnl([short], feed(), NOW, NOW)).toBe(-44);
  });
  it('does not invent bid/ask when only a signed last trade is available', () => {
    const tick = independentIbkrTick(feed({ bid: null, ask: null }), NOW, NOW);
    expect(tick).toMatchObject({ bid: null, ask: null, price: 26_010 });
    expect(ibkrPositionPnl([leg()], feed({ bid: null, ask: null }), NOW, NOW)).toBe(36);
  });
  it('rejects NQ/MNQ aliasing, different months, continuous/TV/delayed source, stale price and changed position fingerprint', () => {
    for (const patch of [{ chart: 'IBKR:NQZ2026', front: 'NQZ2026' }, { chart: 'IBKR:MNQH2027', front: 'MNQH2027' }, { chart: 'CME_MINI:MNQ1!' }, { mode: 'delayed_streaming_600' }]) {
      expect(ibkrPositionPnl([leg()], feed(patch), NOW, NOW)).toBeNull();
    }
    expect(ibkrPositionPnl([leg()], { ...feed(), fresh: false }, NOW, NOW)).toBeNull();
    expect(ibkrPositionPnl([leg()], feed(), NOW - 2_001, NOW)).toBeNull();
    expect(ibkrPositionPnl([leg({ netPosition: 3 })], feed(), NOW, NOW)).toBeNull();
    expect(ibkrPositionPnl([leg({ averagePrice: 26_005 })], feed(), NOW, NOW)).toBeNull();
    expect(ibkrPositionPnl([], feed(), NOW, NOW)).toBeNull();
  });
  it('actual group card can show direct PnL with a stale broker anchor, but never with a missing member proof', () => {
    const account = { id: 100, positionsAvailability: 'available', positionsUpdatedAt: new Date(NOW - 1000).toISOString(),
      ordersAvailability: 'available', ordersUpdatedAt: new Date(NOW - 1000).toISOString(), unrealizedPnl: 9000, unrealizedPnlSource: 'stale',
      positions: [{ accountId: 100, symbol: 'MNQZ6', netPosition: 2, netPrice: 26_000, updatedAt: new Date(NOW - 1000).toISOString() }] } as LiveAccount;
    const row = { account, accountId: 100, name: 'L', isLeader: true };
    const card = buildTradeCard([row], [], new Map(), NOW)!;
    expect(card.openPnl).toBeNull(); expect(card.positionsComplete).toBe(true);
    expect(ibkrPositionPnl(tradeCardIbkrLegs(card), feed(), NOW, NOW)).toBe(40);
    expect(account.unrealizedPnl).toBe(9000); expect(account.unrealizedPnlSource).toBe('stale');
    const unknown = { ...account, id: 200, positionsAvailability: 'unavailable' as const, positions: [] };
    const incomplete = buildTradeCard([row, { account: unknown, accountId: 200, name: 'F', isLeader: false }], [], new Map(), NOW)!;
    expect(tradeCardIbkrLegs(incomplete)).toBeNull();
    expect(ibkrPositionPnl([leg({ continuity: { ...coverage(), gap: true } })], feed(), NOW, NOW)).toBeNull();
  });
  it('phone quote and PnL depend on signed tick evidence independently of minute-history status', () => {
    const source = readFileSync('components/day/LivePhoneChart.tsx', 'utf8');
    const quote = source.slice(source.indexOf('const quote = useMemo<LivePhoneQuote'), source.indexOf('// Jeden příkaz naráz'));
    expect(quote).toContain('independentTick.bid'); expect(quote).toContain('independentTick.ask');
    expect(quote).not.toContain('liveStatus'); expect(quote).not.toMatch(/bid \+|ask \+/);
    const pnl = source.slice(source.indexOf('const guardAt ='), source.indexOf('const shownOpenPnl ='));
    expect(pnl).toContain('independentTick?.source'); expect(pnl).not.toContain('ctl.chart.liveStatus');
  });
  it('an unchanged old position needs explicit live continuity, not refreshed capture time', () => {
    const capturedAt = NOW - 60_000;
    const old = leg({ capturedAt, fingerprint: ibkrPositionFingerprint(100, 'MNQZ6', 2, 26_000, capturedAt) });
    expect(ibkrPositionPnl([old], feed(), NOW, NOW)).toBeNull();
    expect(ibkrPositionPnl([{ ...old, continuity: coverage() }], feed(), NOW, NOW)).toBe(36);
    expect(old.capturedAt).toBe(capturedAt);
    expect(ibkrPositionPnl([{ ...old, continuity: { ...coverage(), gap: true } }], feed(), NOW, NOW)).toBeNull();
  });
});
const health = (patch: Partial<TradovateRequestHealth> = {}): TradovateRequestHealth => ({ version: 1, brokerUserId: 123, state: 'ready', observedAt: NOW,
  blockedUntil: null, reason: null, evidence: null, controlFreshUntil: NOW + 5_000, cooldownIsLocalEstimate: true,
  counts: { dispatchAttempts: 0, blockedBeforeDispatch: 0, responses: 0, transportUnknown: 0 }, ...patch });
it('distinguishes actual429/captcha, local budget, and stale unknown without claiming execution permission', () => {
  expect(tradovateRequestHealthDisplay([health()], NOW)).toEqual([]);
  expect(tradovateRequestHealthDisplay([health({ state: 'cooldown', evidence: 'raw-429' })], NOW)?.[0].text).toMatch(/HTTP 429/);
  expect(tradovateRequestHealthDisplay([health({ state: 'captcha', evidence: 'captcha' })], NOW)?.[0].text).toMatch(/captcha/);
  expect(tradovateRequestHealthDisplay([health({ state: 'budget-limited' })], NOW)?.[0].text).toMatch(/Lokální rozpočet/);
  expect(tradovateRequestHealthDisplay([health({ controlFreshUntil: NOW - 1 })], NOW)?.[0].text).toMatch(/není ověřený/);
});
