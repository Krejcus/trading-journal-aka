import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeTradovateAccountProfileInput } from '../server/tradovateAccountProfiles';

const migration = readFileSync(
  new URL('../supabase/migrations/20260815040436_tradovate_account_profiles.sql', import.meta.url),
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
    });
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
  });
});
