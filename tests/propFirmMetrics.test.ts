import { describe, expect, it } from 'vitest';
import {
  breachDetector,
  consistencyCheck,
  dailyLedger,
  drawdownFloor,
  payoutEligibility,
  profitDayProgress,
  type DailyLedgerEntry,
} from '../lib/propFirmMetrics';
import type { FirmPayoutRules } from '../lib/propFirmRules';

const rules = (overrides: Partial<FirmPayoutRules> = {}): FirmPayoutRules => ({
  planName: 'Test',
  profitDaysRequired: null,
  minProfitPerDayUsd: null,
  minPayoutUsd: null,
  maxPayoutUsd: null,
  payoutCycleDays: null,
  consistencyPct: null,
  splitPct: null,
  drawdownType: null,
  ...overrides,
});

const ledger = (...pnls: Array<number | null>): DailyLedgerEntry[] => pnls.map((pnl, index) => ({
  date: `2026-08-${String(index + 1).padStart(2, '0')}`,
  closingBalance: 50_000 + (pnl ?? 0),
  pnl,
  capturedAt: `2026-08-${String(index + 1).padStart(2, '0')}T21:00:00.000Z`,
}));

describe('prop firm metrics', () => {
  it('uses the last balance per America/Chicago day across the UTC boundary', () => {
    expect(dailyLedger([
      { capturedAt: '2026-08-21T20:00:00.000Z', balance: 50_000 },
      { capturedAt: '2026-08-22T04:59:00.000Z', balance: 50_100 },
      { capturedAt: '2026-08-22T05:01:00.000Z', balance: 50_250 },
    ])).toEqual([
      expect.objectContaining({ date: '2026-08-21', closingBalance: 50_100, pnl: null }),
      expect.objectContaining({ date: '2026-08-22', closingBalance: 50_250, pnl: 150 }),
    ]);
  });

  it('counts only qualifying profit days and reports the remainder', () => {
    expect(profitDayProgress(ledger(null, 100, 50, -20), rules({
      profitDaysRequired: 2,
      minProfitPerDayUsd: 75,
    }))).toEqual({ completed: 1, required: 2, remaining: 1 });
    expect(profitDayProgress(ledger(null, 100), rules())).toBeNull();
  });

  it('checks the best positive day against positive cycle profit', () => {
    expect(consistencyCheck(ledger(null, 100, -50, 300), rules({ consistencyPct: 35 })))
      .toEqual({ pct: 75, limit: 35, breached: true });
  });

  it('ignores null payout rules and applies only configured requirements', () => {
    expect(payoutEligibility(ledger(null, -20), rules(), 0)).toEqual({ eligible: true, missing: {} });
    expect(payoutEligibility(ledger(null, 80), rules({
      profitDaysRequired: 2,
      minPayoutUsd: 100,
      maxPayoutUsd: 2_000,
    }), 60)).toEqual({
      eligible: false,
      missing: { profitDays: 1, amountUsd: 40 },
      capUsd: 2_000,
    });
  });

  it('derives EOD and intraday trailing floors and detects the first breach', () => {
    const snapshots = [
      { capturedAt: '2026-08-21T18:00:00.000Z', balance: 52_000 },
      { capturedAt: '2026-08-22T04:59:00.000Z', balance: 51_000 },
      { capturedAt: '2026-08-22T18:00:00.000Z', balance: 48_900 },
    ];
    const profile = { accountSize: 50_000, maxLoss: 2_000, drawdownType: 'eod_trailing' as const };
    const eod = drawdownFloor(snapshots, profile);
    const intraday = drawdownFloor(snapshots, profile, 'intraday');
    expect(eod).toMatchObject({ floor: 49_000, balance: 48_900, distance: -100, highWatermark: 51_000 });
    expect(intraday).toMatchObject({ floor: 50_000, highWatermark: 52_000 });
    expect(breachDetector(snapshots, eod!)).toEqual({
      breached: true,
      at: '2026-08-22T18:00:00.000Z',
    });
  });
});
