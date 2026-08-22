import { describe, expect, it } from 'vitest';
import type { Account } from '../types';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import { buildAccountCockpitModel, resolveCockpitDrawdown, sortAccountsRiskFirst } from '../lib/accountCockpit';
import type { FirmPayoutRules } from '../lib/propFirmRules';

const account = (id: string, name: string, phase: 'Challenge' | 'Funded' = 'Funded'): Account => ({
  id, name, initialBalance: 50_000, type: 'Funded', phase, status: 'Active', currency: 'USD', createdAt: 1,
  oauth: { provider: 'tradovate', environment: 'demo', externalAccountId: id, connectionId: 'connection', firm: 'Tradeify' },
});

const profile = (id: string): TradovateAccountProfile => ({
  id: `profile-${id}`, provider: 'tradovate', environment: 'demo', externalAccountId: id,
  accountName: id, displayName: null, propFirm: 'Tradeify', planName: 'Growth', accountType: 'funded',
  accountSize: 50_000, drawdownType: 'static', maxLoss: 2_000, dailyLossLimit: 1_000,
  consistencyPct: 35, profitTarget: 3_000, maxMini: null, maxMicro: null, mappedAccountId: id,
  status: 'active', lastSeenAt: '2026-08-22T10:00:00Z', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-22T10:00:00Z',
});

const rules: FirmPayoutRules = {
  planName: 'Growth', profitDaysRequired: 2, minProfitPerDayUsd: 100, minPayoutUsd: 500,
  maxPayoutUsd: 2_000, payoutCycleDays: null, consistencyPct: 60, splitPct: 90, drawdownType: 'static',
  withdrawablePctOfProfit: null, minBalanceToRequestUsd: null,
};

const rows = (id: string, balances: number[]) => balances.map((balance, index) => ({
  connection_id: 'connection',
  external_account_id: id,
  captured_at: `2026-08-${String(20 + index).padStart(2, '0')}T21:00:00.000Z`,
  balance,
  realized_pnl_day: null,
  open_pnl: null,
  auto_liq_level: null,
}));

describe('account cockpit mapping', () => {
  it('maps snapshots and rules to balance, daily limit, drawdown and funded payout checklist', () => {
    const model = buildAccountCockpitModel({
      account: account('danger', 'Danger'),
      rows: rows('danger', [50_000, 50_200, 49_350]),
      profile: profile('danger'), rules, now: new Date('2026-08-22T22:00:00Z'),
    });
    expect(model).toMatchObject({
      balance: 49_350,
      todayPnl: -850,
      dailyLimit: { usedUsd: 850, remainingUsd: 150, level: 'danger' },
      drawdown: { floor: 48_000, distance: 1_350 },
      profitDays: { completed: 1, required: 2, remaining: 1 },
      payout: { eligible: false, withdrawableUsd: 0, missing: { profitDays: 1, amountUsd: 500 }, capUsd: 2_000 },
      risk: 'danger',
    });
  });

  it('maps evaluation progress and keeps absent rules out of the model', () => {
    const evaluationProfile = { ...profile('eval'), accountType: 'evaluation' as const };
    const model = buildAccountCockpitModel({
      account: account('eval', 'Evaluation', 'Challenge'), rows: rows('eval', [50_000, 52_400]),
      profile: evaluationProfile, rules: null, now: new Date('2026-08-21T22:00:00Z'),
    });
    expect(model.evaluation).toMatchObject({ profitUsd: 2_400, targetUsd: 3_000, remainingUsd: 600, progressPct: 80 });
    expect(model.profitDays).toBeNull();
    expect(model.payout).toBeNull();
    expect(model.consistency).toMatchObject({ limit: 35 });
  });

  it('sorts danger before warning before ok inside a firm group', () => {
    const accounts = [account('ok', 'OK'), account('danger', 'Danger'), account('warning', 'Warning')];
    const models = new Map(accounts.map(item => [item.id, buildAccountCockpitModel({
      account: item,
      rows: rows(item.id, item.id === 'danger' ? [50_000, 49_100] : item.id === 'warning' ? [50_000, 49_400] : [50_000, 50_100]),
      profile: profile(item.id), rules: null, now: new Date('2026-08-21T22:00:00Z'),
    })]));
    expect(sortAccountsRiskFirst(accounts, models).map(item => item.id)).toEqual(['danger', 'warning', 'ok']);
  });

  it('prefers live broker floor, then snapshot auto-liq and finally computed floor', () => {
    const snapshots = [
      { capturedAt: '2026-08-21T21:00:00.000Z', balance: 50_600, autoLiqLevel: null },
      { capturedAt: '2026-08-22T21:00:00.000Z', balance: 50_900, autoLiqLevel: 49_250 },
    ];
    const floorProfile = { ...profile('floor'), drawdownType: 'eod_trailing' as const };
    const liveAccount = {
      balance: { autoLiqLevel: 49_700, netLiq: 50_950, totalCashValue: 50_900 },
      risk: { trailingMaxDrawdown: 2_000, maxNetLiq: 51_100 },
      daily: [],
    } as never;
    expect(resolveCockpitDrawdown({ snapshots, profile: floorProfile, liveAccount, liveCapturedAt: '2026-08-22T22:00:00Z' }))
      .toMatchObject({ floor: 49_700, balance: 50_950, distance: 1_250 });
    expect(resolveCockpitDrawdown({ snapshots, profile: floorProfile }))
      .toMatchObject({ floor: 49_250, balance: 50_900, distance: 1_650 });
    expect(resolveCockpitDrawdown({
      snapshots: snapshots.map(snapshot => ({ ...snapshot, autoLiqLevel: null })),
      profile: floorProfile,
    })).toMatchObject({ floor: 48_900, balance: 50_900, distance: 2_000 });
  });
});
