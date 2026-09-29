import { describe, expect, it } from 'vitest';
import {
  effectiveCopyTradeAccountEligibility,
  inferredCopyTradeAccountEligibility,
} from '../lib/copyTradeAccountEligibility';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import type { LiveAccount } from '../services/tradecopiaLiveService';

const account = (overrides: Partial<LiveAccount>): LiveAccount => ({
  id: 101,
  entityId: null,
  name: 'DEMO 101',
  firm: 'Tradeify',
  phase: 'evaluation',
  accountSize: 50_000,
  balance: 50_000,
  equity: 50_000,
  realizedPnl: 0,
  weekRealizedPnl: 0,
  unrealizedPnl: 0,
  unrealizedPnlSource: 'broker',
  dailyPnlAvailable: true,
  dailyPnlTradeDate: '2026-08-26',
  peakEquity: 50_000,
  drawdownFloor: 48_000,
  cushion: 2_000,
  positions: [],
  updatedAt: '2026-08-26T12:00:00.000Z',
  mapRowId: null,
  mappedAccountId: null,
  mappedAccountName: null,
  mappingStatus: null,
  ...overrides,
});

const profile = (accountId: number, dailyLossLimit: number | null): TradovateAccountProfile => ({
  id: `profile-${accountId}`,
  provider: 'tradovate',
  environment: 'demo',
  status: 'active',
  externalAccountId: String(accountId),
  accountName: `DEMO ${accountId}`,
  displayName: null,
  propFirm: 'Tradeify',
  planName: 'Growth 50K',
  accountType: 'evaluation',
  accountSize: 50_000,
  drawdownType: 'eod_trailing',
  maxLoss: 2_000,
  dailyLossLimit,
  consistencyPct: null,
  profitTarget: 3_000,
  maxMini: null,
  maxMicro: null,
  lastSeenAt: '2026-08-26T12:00:00.000Z',
  createdAt: '2026-08-26T12:00:00.000Z',
  updatedAt: '2026-08-26T12:00:00.000Z',
});

describe('copy trade account eligibility read-model', () => {
  it('odvodí BREACHED z nulové nebo záporné rezervy vůči LIVE flooru', () => {
    const result = inferredCopyTradeAccountEligibility([
      account({ id: 230, cushion: -33 }),
    ], []);

    expect(result).toMatchObject([{ accountId: 230, state: 'breached' }]);
    expect(result[0].reason).toContain('-33.00 USD');
  });

  it('odvodí DLL z aktuálního realized + unrealized P&L a profilu účtu', () => {
    const result = inferredCopyTradeAccountEligibility([
      account({ id: 16, realizedPnl: -1_206.5 }),
    ], [profile(16, 1_200)], Date.parse('2026-08-26T12:00:00Z'));

    expect(result).toMatchObject([{ accountId: 16, state: 'dll-locked' }]);
    expect(result[0].reason).toContain('DLL 1200.00 USD');
  });

  it('odvodí DLL i přímo z broker limitu, když profil limit neobsahuje', () => {
    const result = inferredCopyTradeAccountEligibility([
      account({ id: 16, dailyLossLimit: 1_200, realizedPnl: -1_206.5 }),
    ], [], Date.parse('2026-08-26T12:00:00Z'));

    expect(result).toMatchObject([{ accountId: 16, state: 'dll-locked' }]);
    expect(result[0].reason).toContain('DLL 1200.00 USD');
  });

  it('použije stejný worker realized zdroj jako displej a konzervativně horší hodnotu', () => {
    const now = Date.parse('2026-09-28T15:07:00.000Z');
    const result = inferredCopyTradeAccountEligibility([
      account({
        id: 16,
        realizedPnl: -200,
        dailyPnlTradeDate: '2026-09-28',
        dailyPnlUpdatedAt: new Date(now - 7 * 60_000).toISOString(),
        dailyLossLimit: 1_200,
        unrealizedPnl: 0,
        unrealizedPnlUpdatedAt: new Date(now - 1_000).toISOString(),
        displayValues: {
          dailyRealizedPnL: {
            value: -1_250,
            requestedAt: new Date(now - 2_000).toISOString(),
            confirmedAt: new Date(now - 1_500).toISOString(),
          },
        },
      }),
    ], [], now);

    expect(result).toMatchObject([{ accountId: 16, state: 'dll-locked' }]);
    expect(result[0].reason).toContain('-1250.00 USD');
  });

  it('nevyrábí DLL lock z předchozího trade date ani ze stale otevřeného P&L po 17:00 CT', () => {
    const now = Date.parse('2026-09-28T23:30:00Z');
    const previousDay = account({
      id: 16,
      realizedPnl: -1_250,
      dailyPnlTradeDate: '2026-09-28',
      updatedAt: new Date(now).toISOString(),
    });
    const staleOpen = account({
      ...previousDay,
      dailyPnlTradeDate: '2026-09-29',
      unrealizedPnlSource: 'stale',
    });
    expect(inferredCopyTradeAccountEligibility([previousDay], [profile(16, 1_200)], now)).toEqual([]);
    expect(inferredCopyTradeAccountEligibility([staleOpen], [profile(16, 1_200)], now)).toEqual([]);
  });

  it('runtime důvod zachová, ale závažnější LIVE breach smí stav zpřísnit', () => {
    const sameState = effectiveCopyTradeAccountEligibility([
      account({ id: 16, realizedPnl: -1_206.5 }),
    ], [profile(16, 1_200)], [{
      accountId: 16,
      state: 'dll-locked',
      at: 123,
      reason: 'Violation: daily loss limit reached',
    }]);
    expect(sameState[0]).toMatchObject({ at: 123, reason: 'Violation: daily loss limit reached' });

    const stricter = effectiveCopyTradeAccountEligibility([
      account({ id: 16, realizedPnl: -1_206.5, cushion: -10 }),
    ], [profile(16, 1_200)], sameState);
    expect(stricter[0]).toMatchObject({ accountId: 16, state: 'breached' });
  });
});
