import { describe, expect, it } from 'vitest';
import { planTradovateJournalAccountLinks } from '../lib/tradovateJournalAccountRegistry';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import type { TradovatePreflightResult } from '../services/tradovateOAuthConnection';

const profile = (patch: Partial<TradovateAccountProfile> = {}): TradovateAccountProfile => ({
  id: 'profile-1',
  provider: 'tradovate',
  environment: 'demo',
  externalAccountId: '62364058',
  accountName: 'TDFYG50621860230',
  displayName: 'Tradeify hlavní',
  propFirm: 'Tradeify',
  planName: null,
  accountType: 'funded',
  accountSize: 50_000,
  drawdownType: null,
  maxLoss: null,
  dailyLossLimit: null,
  consistencyPct: null,
  profitTarget: null,
  maxMini: null,
  maxMicro: null,
  mappedAccountId: null,
  status: 'active',
  lastSeenAt: '2026-08-22T10:00:00.000Z',
  createdAt: '2026-08-22T10:00:00.000Z',
  updatedAt: '2026-08-22T10:00:00.000Z',
  ...patch,
});

const connectionData = {
  'connection-1': {
    connectionId: 'connection-1',
    environment: 'demo',
    accounts: [{
      id: 62364058,
      name: 'TDFYG50621860230',
      balance: { totalCashValue: 49_850 },
    }],
  } as TradovatePreflightResult,
};

describe('Tradovate journal account registry', () => {
  it('založí účet jen jednou a druhý průchod nevytvoří duplikát', () => {
    const first = planTradovateJournalAccountLinks({
      accounts: [],
      profiles: [profile()],
      connectionData,
      now: 123,
      createId: () => '0f0f0f0f-1111-4111-8111-222222222222',
    });
    expect(first.accounts).toHaveLength(1);
    expect(first.accounts[0]).toMatchObject({
      name: 'Tradeify hlavní',
      type: 'Funded',
      initialBalance: 50_000,
      oauth: {
        provider: 'tradovate',
        environment: 'demo',
        externalAccountId: '62364058',
        connectionId: 'connection-1',
        firm: 'Tradeify',
      },
    });
    expect(first.profiles[0].mappedAccountId).toBe(first.accounts[0].id);

    const second = planTradovateJournalAccountLinks({
      accounts: first.accounts,
      profiles: first.profiles,
      connectionData,
      createId: () => 'should-not-be-used',
    });
    expect(second.changed).toBe(false);
    expect(second.accounts).toHaveLength(1);
  });

  it('dopojí existující OAuth účet podle externí identity', () => {
    const existing = {
      id: '0f0f0f0f-1111-4111-8111-333333333333',
      name: 'Dřívější název',
      initialBalance: 50_000,
      type: 'Funded' as const,
      status: 'Active' as const,
      currency: 'USD',
      createdAt: 1,
      oauth: {
        provider: 'tradovate' as const,
        environment: 'demo' as const,
        externalAccountId: '62364058',
        connectionId: 'old-connection',
        firm: 'Tradeify',
      },
    };
    const result = planTradovateJournalAccountLinks({
      accounts: [existing],
      profiles: [profile()],
      connectionData,
      createId: () => 'should-not-be-used',
    });
    expect(result.accounts).toEqual([existing]);
    expect(result.profiles[0].mappedAccountId).toBe(existing.id);
  });
});
