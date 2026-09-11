import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { liveBalanceDisplay, liveCapitalDisplay, liveDailyPnlDisplay, liveGroupDailyPnlDisplay } from '../lib/liveBalanceDisplay';
import { isLiveAccountReadVerified } from '../lib/liveReadFreshness';
import { BalanceValue } from '../components/LiveCopyTradeOverview';
import type { LiveAccount } from '../services/tradecopiaLiveService';

const now = Date.UTC(2026, 8, 10, 8);
const account = (patch: Partial<LiveAccount> = {}) => ({
  id: 1, balance: 51_154.40, cashAvailability: 'available',
  cashUpdatedAt: new Date(now - 1_000).toISOString(), ...patch,
} as LiveAccount);

describe('retained balance presentation', () => {
  it('keeps a confirmed balance after 45 seconds but does not make it fresh risk evidence', () => {
    const a = account({ cashUpdatedAt: new Date(now - 60_000).toISOString() });
    const display = liveBalanceDisplay(a, now);
    expect(display).toMatchObject({ value: 51_154.40, stale: true, confirmedAt: a.cashUpdatedAt });
    expect(isLiveAccountReadVerified(a, 'cash', now)).toBe(false);
    const markup = renderToStaticMarkup(React.createElement(BalanceValue, { display }));
    expect(markup).toContain('51,154.40');
    expect(markup).not.toContain('>čeká na ověření<');
    expect(markup).toContain('poslední potvrzení');
    expect(markup).toContain('data-balance-state="last-known"');
  });

  it('keeps retained cash during a failed request then replaces it with the new broker value', () => {
    const failed = account({ cashAvailability: 'unavailable', cashUpdatedAt: new Date(now - 90_000).toISOString() });
    expect(liveBalanceDisplay(failed, now)).toMatchObject({ value: 51_154.40, stale: true });
    const fresh = liveBalanceDisplay(account({ balance: 51_100 }), now);
    expect(fresh).toMatchObject({ value: 51_100, stale: false });
    expect(renderToStaticMarkup(React.createElement(BalanceValue, { display: fresh }))).not.toContain('čeká na ověření');
  });

  it.each([
    { cashAvailability: 'unavailable', cashUpdatedAt: null, balance: 0 },
    { cashUpdatedAt: 'invalid' },
    { cashUpdatedAt: new Date(now + 60_000).toISOString() },
    { cashAvailability: 'denied' },
    { balance: NaN },
  ] as Partial<LiveAccount>[])('does not invent a balance for missing/invalid evidence: %j', patch => {
    expect(liveBalanceDisplay(account(patch), now).value).toBeNull();
  });

  it('preserves real zero and legacy shadow snapshots', () => {
    expect(liveBalanceDisplay(account({ balance: 0 }), now).value).toBe(0);
    expect(liveBalanceDisplay(account({ cashAvailability: undefined, cashUpdatedAt: undefined }), now).value).toBe(51_154.40);
    expect(liveBalanceDisplay(undefined, now).value).toBeNull();
  });

  it('sums every known member and marks a stale total without silently omitting unknown members', () => {
    const older = account({ balance: 50_000, cashUpdatedAt: new Date(now - 60_000).toISOString() });
    const display = liveCapitalDisplay([account(), older], now);
    expect(display).toMatchObject({ value: 101_154.40, stale: true, confirmedAt: older.cashUpdatedAt });
    expect(liveCapitalDisplay([account(), undefined], now).value).toBeNull();
    expect(liveCapitalDisplay([], now).value).toBeNull();
    const compact = renderToStaticMarkup(React.createElement(BalanceValue, { display, compact: true }));
    expect(compact).not.toContain('>čeká na ověření<');
    expect(compact).toContain('data-balance-state="last-known"');
  });
});


describe('confirmed daily display', () => {
  it('retains confirmed zero without loosening risk freshness', () => {
    const a = account({ realizedPnl: 0, cashUpdatedAt: new Date(now - 90_000).toISOString() });
    expect(liveDailyPnlDisplay(a, now).value).toBe(0);
    expect(isLiveAccountReadVerified(a, 'cash', now)).toBe(false);
    expect(liveGroupDailyPnlDisplay([a, undefined], now)).toBeNull();
  });
  it('uses newer display evidence without changing execution fields', () => {
    const a = account({ realizedPnl: 50, cashUpdatedAt: new Date(now - 90_000).toISOString(), displayValues: {
      dailyRealizedPnL: { value: 125, requestedAt: new Date(now - 2_000).toISOString(), confirmedAt: new Date(now - 1_000).toISOString() },
    } });
    expect(liveDailyPnlDisplay(a, now).value).toBe(125);
    expect(a.realizedPnl).toBe(50);
    expect(isLiveAccountReadVerified(a, 'cash', now)).toBe(false);
  });
  it('rejects previous-session P&L but retains the balance', () => {
    const boundary = Date.UTC(2026, 8, 10, 22);
    const a = account({ realizedPnl: 125, cashUpdatedAt: new Date(boundary - 1_000).toISOString() });
    expect(liveDailyPnlDisplay(a, boundary + 1_000).value).toBeNull();
    expect(liveBalanceDisplay(a, boundary + 1_000).value).toBe(51_154.40);
  });
});
