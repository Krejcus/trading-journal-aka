import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  normalizeTradovateAccountProfileInput,
  tradovateAccountProfileFromRow,
  tradovateAccountProfileToRow,
} from '../server/tradovateAccountProfiles';

const migration = readFileSync(
  new URL('../supabase/migrations/20260815040436_tradovate_account_profiles.sql', import.meta.url),
  'utf8',
);
const journalLinkMigration = readFileSync(
  new URL('../supabase/migrations/20260822120000_account_profile_journal_link.sql', import.meta.url),
  'utf8',
);
const onboardingMigration = readFileSync(
  new URL('../supabase/migrations/20260823070913_account_profile_onboarding.sql', import.meta.url),
  'utf8',
);

describe('Tradovate account profiles', () => {
  it('normalizuje texty, zachová nuly a přijme podporovaná prop pravidla', () => {
    expect(normalizeTradovateAccountProfileInput({
      externalAccountId: ' 123 ',
      accountName: ' TDFY123 ',
      displayName: ' Tradeify #1 ',
      propFirm: ' Tradeify ',
      planName: ' Growth 50K ',
      accountType: 'evaluation',
      accountSize: 50_000,
      drawdownType: 'eod_trailing',
      maxLoss: 2_000,
      dailyLossLimit: 1_000,
      consistencyPct: 20,
      profitTarget: 3_000,
      maxMini: 0,
      maxMicro: 10,
    })).toEqual({
      externalAccountId: '123',
      accountName: 'TDFY123',
      displayName: 'Tradeify #1',
      propFirm: 'Tradeify',
      planName: 'Growth 50K',
      accountType: 'evaluation',
      accountSize: 50_000,
      drawdownType: 'eod_trailing',
      maxLoss: 2_000,
      dailyLossLimit: 1_000,
      consistencyPct: 20,
      profitTarget: 3_000,
      maxMini: 0,
      maxMicro: 10,
      mappedAccountId: null,
    });
  });

  it('zapíše a přečte mappedAccountId v API řádku', () => {
    const mappedAccountId = '0f0f0f0f-1111-4111-8111-222222222222';
    const normalized = normalizeTradovateAccountProfileInput({
      externalAccountId: '123',
      accountName: 'TDFY123',
      mappedAccountId,
    });
    const row = tradovateAccountProfileToRow(normalized, 'user-id', 'demo', '2026-08-22T12:00:00.000Z');
    expect(row.mapped_account_id).toBe(mappedAccountId);
    expect(tradovateAccountProfileFromRow({
      ...row,
      id: 'profile-id',
      account_size: null,
      max_loss: null,
      daily_loss_limit: null,
      consistency_pct: null,
      profit_target: null,
      status: 'active',
      created_at: '2026-08-22T11:00:00.000Z',
    } as any).mappedAccountId).toBe(mappedAccountId);
  });

  it('rozliší chybějící onboarding sloupec od NULL a zachová potvrzovací čas', () => {
    const base = normalizeTradovateAccountProfileInput({ externalAccountId: '123', accountName: 'TDFY123' });
    expect(tradovateAccountProfileToRow(base, 'user-id', 'demo', '2026-08-23T07:00:00.000Z')).not.toHaveProperty('onboarded_at');
    const confirmed = normalizeTradovateAccountProfileInput({
      externalAccountId: '123', accountName: 'TDFY123', onboardedAt: '2026-08-23T07:10:00Z',
    });
    expect(tradovateAccountProfileToRow(confirmed, 'user-id', 'demo', '2026-08-23T07:00:00.000Z')).toHaveProperty(
      'onboarded_at', '2026-08-23T07:10:00.000Z',
    );
  });

  it('odmítne neplatné limity a neznámé enumy', () => {
    const base = { externalAccountId: '1', accountName: 'A' };
    expect(() => normalizeTradovateAccountProfileInput({ ...base, maxLoss: -1 })).toThrow('max-loss-invalid');
    expect(() => normalizeTradovateAccountProfileInput({ ...base, consistencyPct: 101 })).toThrow('consistency-pct-invalid');
    expect(() => normalizeTradovateAccountProfileInput({ ...base, accountType: 'challenge' })).toThrow('account-type-invalid');
    expect(() => normalizeTradovateAccountProfileInput({ ...base, maxMini: 1.5 })).toThrow('max-mini-invalid');
  });

  it('odděluje profily od OAuth tokenu a nepouští je přímo do browseru', () => {
    expect(migration).toContain('tradovate_account_profiles_identity_unique unique');
    expect(migration).toContain('user_id, provider, environment, external_account_id');
    expect(migration).toContain('enable row level security');
    expect(migration).toContain('revoke all on table public.tradovate_account_profiles from public, anon, authenticated');
    expect(migration).toContain('grant select, insert, update, delete on table public.tradovate_account_profiles to service_role');
    expect(migration).not.toContain('encrypted_access_token');
    expect(journalLinkMigration).toContain('add column mapped_account_id uuid null');
    expect(journalLinkMigration).toContain('(user_id, mapped_account_id)');
    expect(onboardingMigration).toContain('add column onboarded_at timestamptz null');
    expect(onboardingMigration).toContain('set onboarded_at = now()');
    // Onboarding nesmí prolomit pravidlo z 20260815040436: browser tuhle
    // tabulku nikdy nečte ani nezapisuje přímo, všechno jde přes Vercel
    // funkci se service_role klíčem.
    expect(onboardingMigration).not.toContain('to authenticated');
    expect(onboardingMigration).not.toContain('create policy');
  });
});
