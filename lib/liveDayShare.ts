import type { LiveDaySummary, LiveDayRowState } from './liveDaySummary';

export const LIVE_DAY_SHARE_PREVIEW_BUCKET = 'live-day-share-previews';
export const LIVE_DAY_SHARE_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LiveDayShareTheme = 'dark' | 'light' | 'oled';

export interface PublicLiveDayShare {
  token: string;
  tradeDate: string;
  owner: { name: string; avatar?: string | null };
  summary: LiveDaySummary;
  trades: number | null;
  losingTrades: number | null;
  theme: LiveDayShareTheme;
  createdAt: string;
}

const finiteOrNull = (value: unknown): number | null =>
  value == null ? null : typeof value === 'number' && Number.isFinite(value) ? value : null;

const nonNegativeIntegerOrNull = (value: unknown): number | null =>
  value == null ? null : Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

/** Public snapshots never contain a complete broker account identifier. */
export function redactLiveDayAccountName(name: string, index: number): string {
  const clean = name.trim();
  if (clean.length <= 8) return `Účet ${index + 1}`;
  return `${clean.slice(0, 4)}••••${clean.slice(-4)}`;
}

export function publicLiveDaySummary(summary: LiveDaySummary): LiveDaySummary {
  return {
    ...summary,
    rows: summary.rows.map((row, index) => ({
      ...row,
      accountId: index + 1,
      name: redactLiveDayAccountName(row.name, index),
    })),
  };
}

/** Public JSON accepts only compact HTTPS avatars; inline data images stay in the private app. */
export function publicLiveDayAvatar(value: string | null | undefined): string | null {
  const clean = value?.trim();
  if (!clean || clean.length > 2_000) return null;
  try {
    const url = new URL(clean);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export function currentLiveDayShareTheme(root: Element = document.documentElement): LiveDayShareTheme {
  if (root.classList.contains('light-theme')) return 'light';
  if (root.classList.contains('oled-theme')) return 'oled';
  return 'dark';
}

const rowState = (value: unknown): LiveDayRowState | null =>
  value === 'confirmed' || value === 'no-trades' || value === 'unconfirmed' ? value : null;

/** Fail closed when a public response is malformed or contains an oversized payload. */
export function normalizePublicLiveDayShare(value: unknown): PublicLiveDayShare | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const token = typeof record.token === 'string' ? record.token : '';
  const tradeDate = typeof record.tradeDate === 'string' ? record.tradeDate : '';
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : '';
  const theme = record.theme;
  const owner = record.owner && typeof record.owner === 'object' ? record.owner as Record<string, unknown> : null;
  const summary = record.summary && typeof record.summary === 'object' ? record.summary as Record<string, unknown> : null;
  if (!LIVE_DAY_SHARE_TOKEN_PATTERN.test(token)
    || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)
    || !Number.isFinite(Date.parse(createdAt))
    || (theme !== 'dark' && theme !== 'light' && theme !== 'oled')
    || !owner || typeof owner.name !== 'string' || !owner.name.trim() || owner.name.length > 100
    || !summary || !Array.isArray(summary.rows) || summary.rows.length > 50) return null;

  const rows = summary.rows.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const row = candidate as Record<string, unknown>;
    const state = rowState(row.state);
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const firm = row.firm == null ? null : typeof row.firm === 'string' ? row.firm.trim().slice(0, 80) : null;
    const rowValue = finiteOrNull(row.value);
    if (!state || !name || name.length > 80 || (row.value != null && rowValue == null)) return [];
    return [{
      accountId: index + 1,
      name,
      firm,
      value: rowValue,
      state,
      stale: row.stale === true,
    }];
  });
  if (rows.length !== summary.rows.length) return null;

  const accountCount = nonNegativeIntegerOrNull(summary.accountCount);
  const confirmedCount = nonNegativeIntegerOrNull(summary.confirmedCount);
  const noTradeCount = nonNegativeIntegerOrNull(summary.noTradeCount);
  const unconfirmedCount = nonNegativeIntegerOrNull(summary.unconfirmedCount);
  const confirmed = finiteOrNull(summary.confirmed);
  if (accountCount == null || confirmedCount == null || noTradeCount == null || unconfirmedCount == null
    || accountCount !== rows.length || (summary.confirmed != null && confirmed == null)) return null;

  const trades = nonNegativeIntegerOrNull(record.trades);
  const losingTrades = nonNegativeIntegerOrNull(record.losingTrades);
  if ((record.trades != null && trades == null) || (record.losingTrades != null && losingTrades == null)
    || (trades != null && losingTrades != null && losingTrades > trades)) return null;

  const avatar = typeof owner.avatar === 'string' ? publicLiveDayAvatar(owner.avatar) : null;
  return {
    token,
    tradeDate,
    owner: { name: owner.name.trim(), avatar },
    summary: {
      rows,
      confirmed,
      confirmedCount,
      accountCount,
      partial: summary.partial === true,
      stale: summary.stale === true,
      noTradeCount,
      unconfirmedCount,
    },
    trades,
    losingTrades,
    theme,
    createdAt,
  };
}

export function liveDayShareMoney(value: number | null): string {
  if (value == null) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}$${Math.abs(Math.round(value)).toLocaleString('cs-CZ')}`;
}
