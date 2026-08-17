import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  TradovateAccountProfile,
  TradovateAccountProfileInput,
  TradovateProfileAccountType,
  TradovateProfileDrawdownType,
  TradovateProfileEnvironment,
  TradovateProfileStatus,
} from '../lib/tradovateAccountProfileTypes.js';

interface ProfileRow {
  id: string;
  provider: 'tradovate';
  environment: TradovateProfileEnvironment;
  external_account_id: string;
  account_name: string;
  display_name: string | null;
  prop_firm: string | null;
  plan_name: string | null;
  account_type: TradovateProfileAccountType | null;
  account_size: number | string | null;
  drawdown_type: TradovateProfileDrawdownType | null;
  max_loss: number | string | null;
  daily_loss_limit: number | string | null;
  consistency_pct: number | string | null;
  profit_target: number | string | null;
  max_mini: number | null;
  max_micro: number | null;
  status: TradovateProfileStatus;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

const accountTypes = new Set<TradovateProfileAccountType>(['evaluation', 'funded', 'live']);
const drawdownTypes = new Set<TradovateProfileDrawdownType>(['trailing', 'eod_trailing', 'static', 'none']);

const cleanText = (value: unknown, label: string, maxLength: number, required = false): string | null => {
  if (value == null) {
    if (required) throw new Error(`${label}-required`);
    return null;
  }
  if (typeof value !== 'string') throw new Error(`${label}-invalid`);
  const cleaned = value.trim();
  if (!cleaned) {
    if (required) throw new Error(`${label}-required`);
    return null;
  }
  if (cleaned.length > maxLength) throw new Error(`${label}-too-long`);
  return cleaned;
};

const cleanNumber = (value: unknown, label: string, maximum = 1_000_000_000): number | null => {
  if (value == null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${label}-invalid`);
  }
  return value;
};

const cleanInteger = (value: unknown, label: string): number | null => {
  const cleaned = cleanNumber(value, label, 100_000);
  if (cleaned != null && !Number.isInteger(cleaned)) throw new Error(`${label}-invalid`);
  return cleaned;
};

export function normalizeTradovateAccountProfileInput(value: unknown): TradovateAccountProfileInput {
  if (!value || typeof value !== 'object') throw new Error('profile-invalid');
  const input = value as Record<string, unknown>;
  const accountType = input.accountType == null || input.accountType === '' ? null : input.accountType;
  const drawdownType = input.drawdownType == null || input.drawdownType === '' ? null : input.drawdownType;
  if (accountType != null && (typeof accountType !== 'string' || !accountTypes.has(accountType as TradovateProfileAccountType))) {
    throw new Error('account-type-invalid');
  }
  if (drawdownType != null && (typeof drawdownType !== 'string' || !drawdownTypes.has(drawdownType as TradovateProfileDrawdownType))) {
    throw new Error('drawdown-type-invalid');
  }
  return {
    externalAccountId: cleanText(input.externalAccountId, 'external-account-id', 120, true)!,
    accountName: cleanText(input.accountName, 'account-name', 160, true)!,
    displayName: cleanText(input.displayName, 'display-name', 160),
    propFirm: cleanText(input.propFirm, 'prop-firm', 160),
    planName: cleanText(input.planName, 'plan-name', 160),
    accountType: accountType as TradovateProfileAccountType | null,
    accountSize: cleanNumber(input.accountSize, 'account-size'),
    drawdownType: drawdownType as TradovateProfileDrawdownType | null,
    maxLoss: cleanNumber(input.maxLoss, 'max-loss'),
    dailyLossLimit: cleanNumber(input.dailyLossLimit, 'daily-loss-limit'),
    consistencyPct: cleanNumber(input.consistencyPct, 'consistency-pct', 100),
    profitTarget: cleanNumber(input.profitTarget, 'profit-target'),
    maxMini: cleanInteger(input.maxMini, 'max-mini'),
    maxMicro: cleanInteger(input.maxMicro, 'max-micro'),
  };
}

const nullableNumber = (value: number | string | null): number | null => {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const fromRow = (row: ProfileRow): TradovateAccountProfile => ({
  id: row.id,
  provider: row.provider,
  environment: row.environment,
  externalAccountId: row.external_account_id,
  accountName: row.account_name,
  displayName: row.display_name,
  propFirm: row.prop_firm,
  planName: row.plan_name,
  accountType: row.account_type,
  accountSize: nullableNumber(row.account_size),
  drawdownType: row.drawdown_type,
  maxLoss: nullableNumber(row.max_loss),
  dailyLossLimit: nullableNumber(row.daily_loss_limit),
  consistencyPct: nullableNumber(row.consistency_pct),
  profitTarget: nullableNumber(row.profit_target),
  maxMini: row.max_mini,
  maxMicro: row.max_micro,
  status: row.status,
  lastSeenAt: row.last_seen_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export async function listTradovateAccountProfiles(
  db: SupabaseClient,
  userId: string,
  environment: TradovateProfileEnvironment,
): Promise<TradovateAccountProfile[]> {
  const { data, error } = await db
    .from('tradovate_account_profiles')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'tradovate')
    .eq('environment', environment)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(`Tradovate account profiles load failed: ${error.message}`);
  return ((data ?? []) as ProfileRow[]).map(fromRow);
}

export async function saveTradovateAccountProfiles(options: {
  db: SupabaseClient;
  userId: string;
  environment: TradovateProfileEnvironment;
  profiles: unknown;
  now?: number;
}): Promise<TradovateAccountProfile[]> {
  if (!Array.isArray(options.profiles) || options.profiles.length === 0 || options.profiles.length > 100) {
    throw new Error('profiles-invalid');
  }
  const normalized = options.profiles.map(normalizeTradovateAccountProfileInput);
  const uniqueIds = new Set(normalized.map(profile => profile.externalAccountId));
  if (uniqueIds.size !== normalized.length) throw new Error('duplicate-external-account-id');
  const timestamp = new Date(options.now ?? Date.now()).toISOString();
  const rows = normalized.map(profile => ({
    user_id: options.userId,
    provider: 'tradovate',
    environment: options.environment,
    external_account_id: profile.externalAccountId,
    account_name: profile.accountName,
    display_name: profile.displayName,
    prop_firm: profile.propFirm,
    plan_name: profile.planName,
    account_type: profile.accountType,
    account_size: profile.accountSize,
    drawdown_type: profile.drawdownType,
    max_loss: profile.maxLoss,
    daily_loss_limit: profile.dailyLossLimit,
    consistency_pct: profile.consistencyPct,
    profit_target: profile.profitTarget,
    max_mini: profile.maxMini,
    max_micro: profile.maxMicro,
    status: 'active',
    last_seen_at: timestamp,
    updated_at: timestamp,
  }));
  const { error } = await options.db.from('tradovate_account_profiles').upsert(rows, {
    onConflict: 'user_id,provider,environment,external_account_id',
  });
  if (error) throw new Error(`Tradovate account profiles save failed: ${error.message}`);
  return listTradovateAccountProfiles(options.db, options.userId, options.environment);
}
