import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  TradovateHistoricalTrade,
  TradovateHistoryRange,
  TradovateHistoryStartBasis,
  TradovateHistorySyncResult,
} from '../lib/tradovateHistoricalTypes.js';
import {
  requestTradovatePerformanceReport,
  type TradovateHistoricalReportResult,
} from './tradovateHistoricalReport.js';

type Environment = 'demo' | 'live';

interface SyncRow {
  id: string;
  user_id: string;
  connection_id: string | null;
  environment: Environment;
  external_account_id: string;
  account_name: string;
  account_created_at: string | null;
  history_start_basis: TradovateHistoryStartBasis | null;
  requested_start: string;
  requested_end: string;
  pending_ranges: TradovateHistoryRange[];
  active_range: TradovateHistoryRange | null;
  lease_expires_at: string | null;
  status: 'pending' | 'running' | 'complete' | 'error';
  revision: number | string;
  rows_seen: number | string;
  rows_imported: number | string;
  synced_through: string | null;
  last_error: string | null;
  completed_at: string | null;
}

interface HistoricalTradeRow {
  source_key: string;
  symbol: string | null;
  buy_fill_id: number | string | null;
  sell_fill_id: number | string | null;
  quantity: number | string | null;
  buy_price: number | string | null;
  sell_price: number | string | null;
  gross_pnl: number | string | null;
  bought_at: string | null;
  sold_at: string | null;
  trade_date: string | null;
  raw_row: Record<string, string>;
}

const LEASE_MS = 45_000;
const REPORT_TIMEZONE_MINUTES = -300;

const integer = (value: number | string): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

const isoDate = (value: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error('history-date-invalid');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('history-date-invalid');
  }
  return value;
};

const mmddyyyy = (value: string): string => {
  const [year, month, day] = isoDate(value).split('-');
  return `${month}/${day}/${year}`;
};

const shiftDate = (value: string, days: number): string => {
  const parsed = new Date(`${isoDate(value)}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
};

const previousCalendarYear = (value: string): string => {
  const parsed = new Date(`${isoDate(value)}T00:00:00.000Z`);
  const month = parsed.getUTCMonth();
  parsed.setUTCFullYear(parsed.getUTCFullYear() - 1);
  // JavaScript rolls 29 February into March in a non-leap year.
  if (parsed.getUTCMonth() !== month) parsed.setUTCDate(0);
  return parsed.toISOString().slice(0, 10);
};

export const resolveTradovateHistoryWindow = (options: {
  endDate: string;
  accountCreatedAt?: string | null;
}): { startDate: string; accountCreatedAt: string | null; basis: TradovateHistoryStartBasis } => {
  const endDate = isoDate(options.endDate);
  const parsedCreatedAt = typeof options.accountCreatedAt === 'string'
    ? Date.parse(options.accountCreatedAt)
    : Number.NaN;
  const normalizedCreatedAt = Number.isFinite(parsedCreatedAt)
    ? new Date(parsedCreatedAt).toISOString()
    : null;
  const createdDate = normalizedCreatedAt?.slice(0, 10) ?? null;
  if (createdDate && createdDate <= endDate) {
    return { startDate: createdDate, accountCreatedAt: normalizedCreatedAt, basis: 'account_created_at' };
  }
  return { startDate: previousCalendarYear(endDate), accountCreatedAt: null, basis: 'rolling_12_months' };
};

export const splitTradovateHistoryRange = (range: TradovateHistoryRange): [TradovateHistoryRange, TradovateHistoryRange] | null => {
  const start = Date.parse(`${isoDate(range.startDate)}T00:00:00.000Z`);
  const end = Date.parse(`${isoDate(range.endDate)}T00:00:00.000Z`);
  if (start >= end) return null;
  const totalDays = Math.round((end - start) / 86_400_000);
  const leftEnd = shiftDate(range.startDate, Math.floor(totalDays / 2));
  return [
    { startDate: range.startDate, endDate: leftEnd },
    { startDate: shiftDate(leftEnd, 1), endDate: range.endDate },
  ];
};

export const isTradovateRangeTooLongDiagnostic = (diagnostic: string | null): boolean =>
  diagnostic != null && /(?:too\s+long\s+range|range\s+(?:is\s+)?too\s+long)/i.test(diagnostic);

const normalizeHeader = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const numeric = (value: string | undefined): number | null => {
  if (value == null || !value.trim()) return null;
  const parenthesized = /^\s*\(.*\)\s*$/.test(value);
  const normalized = value.replace(/[$,%()\s]/g, '').replace(/,/g, '');
  // Tradovate reports have used both -$783.00 and $-783.00. Detect the
  // sign after removing presentation characters so neither form is flipped.
  const negative = parenthesized || normalized.startsWith('-');
  const parsed = Number(normalized.replace(/^-/, ''));
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : null;
};

const timestamp = (value: string | undefined): string | null => {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(trimmed);
  if (!match) return null;
  let hour = Number(match[4]);
  const meridiem = match[7]?.toUpperCase();
  if (meridiem === 'AM' && hour === 12) hour = 0;
  if (meridiem === 'PM' && hour !== 12) hour += 12;
  const localAsUtc = Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2]), hour, Number(match[5]), Number(match[6] ?? 0));
  const parsed = new Date(localAsUtc - REPORT_TIMEZONE_MINUTES * 60_000);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

const canonicalRow = (row: Record<string, string>): string => JSON.stringify(
  Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))),
);

const field = (row: Record<string, string>, aliases: string[]): string | undefined => {
  const lookup = new Map(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
  return aliases.map(normalizeHeader).map(alias => lookup.get(alias)).find(value => value != null);
};

const directionalGrossPnl = (
  reported: number | null,
  buyPrice: number | null,
  sellPrice: number | null,
): number | null => {
  if (reported == null || buyPrice == null || sellPrice == null || buyPrice === sellPrice) return reported;
  if (reported < 0) return reported;
  // Some Performance rows expose an unsigned magnitude. The economic sign is
  // contract-agnostic: every paired trade earns when sellPrice > buyPrice.
  return Math.abs(reported) * Math.sign(sellPrice - buyPrice);
};

export const normalizeTradovatePerformanceRows = (
  columns: string[],
  rows: string[][],
): TradovateHistoricalTrade[] => rows.map(values => {
  const rawRow = Object.fromEntries(columns.map((column, index) => [column, values[index] ?? '']));
  const buyFillId = numeric(field(rawRow, ['buyFillId', 'buy fill id']));
  const sellFillId = numeric(field(rawRow, ['sellFillId', 'sell fill id']));
  const quantity = numeric(field(rawRow, ['qty', 'quantity']));
  const boughtAt = timestamp(field(rawRow, ['boughtTimestamp', 'buyTimestamp', 'bought at', 'open time']));
  const soldAt = timestamp(field(rawRow, ['soldTimestamp', 'sellTimestamp', 'sold at', 'close time']));
  const symbol = field(rawRow, ['symbol', 'contract', 'contract name'])?.trim() || null;
  const buyPrice = numeric(field(rawRow, ['buyPrice', 'buy price']));
  const sellPrice = numeric(field(rawRow, ['sellPrice', 'sell price']));
  const reportedPnl = numeric(field(rawRow, ['pnl', 'p&l', 'grossPnl', 'gross p&l']));
  const stableIdentity = buyFillId != null && sellFillId != null
    ? `fills:${buyFillId}:${sellFillId}:${quantity ?? ''}`
    : canonicalRow(rawRow);
  return {
    sourceKey: createHash('sha256').update(stableIdentity).digest('hex'),
    symbol,
    buyFillId,
    sellFillId,
    quantity,
    buyPrice,
    sellPrice,
    grossPnl: directionalGrossPnl(reportedPnl, buyPrice, sellPrice),
    boughtAt,
    soldAt,
    tradeDate: (soldAt ?? boughtAt)?.slice(0, 10) ?? null,
    rawRow,
  };
});

const syncResult = (row: SyncRow, accountId: number): TradovateHistorySyncResult => ({
  syncId: row.id,
  accountId,
  accountName: row.account_name,
  accountCreatedAt: row.account_created_at,
  historyStartBasis: row.history_start_basis ?? 'rolling_12_months',
  status: row.status,
  requestedStart: row.requested_start,
  requestedEnd: row.requested_end,
  pendingRangeCount: row.pending_ranges.length + (row.active_range ? 1 : 0),
  rowsSeen: integer(row.rows_seen),
  rowsImported: integer(row.rows_imported),
  syncedThrough: row.synced_through,
  lastError: row.last_error,
  completedAt: row.completed_at,
});

const loadSync = async (options: {
  db: SupabaseClient;
  userId: string;
  environment: Environment;
  externalAccountId: string;
}): Promise<SyncRow | null> => {
  const { data, error } = await options.db
    .from('tradovate_history_syncs')
    .select('*')
    .eq('user_id', options.userId)
    .eq('environment', options.environment)
    .eq('external_account_id', options.externalAccountId)
    .eq('report_name', 'Performance')
    .maybeSingle<SyncRow>();
  if (error) throw new Error(`Tradovate history state load failed: ${error.message}`);
  return data;
};

const ensureSync = async (options: {
  db: SupabaseClient;
  userId: string;
  connectionId: string;
  environment: Environment;
  accountId: number;
  accountName: string;
  accountCreatedAt: string | null;
  historyStartBasis: TradovateHistoryStartBasis;
  startDate: string;
  endDate: string;
  now: number;
}): Promise<SyncRow> => {
  const externalAccountId = String(options.accountId);
  const requestedStart = isoDate(options.startDate);
  const requestedEnd = isoDate(options.endDate);
  if (requestedStart > requestedEnd) throw new Error('history-date-order-invalid');
  const existing = await loadSync({ ...options, externalAccountId });
  if (!existing) {
    const timestampNow = new Date(options.now).toISOString();
    const { data, error } = await options.db.from('tradovate_history_syncs').insert({
      id: randomUUID(),
      user_id: options.userId,
      connection_id: options.connectionId,
      environment: options.environment,
      external_account_id: externalAccountId,
      account_name: options.accountName,
      account_created_at: options.accountCreatedAt,
      history_start_basis: options.historyStartBasis,
      requested_start: requestedStart,
      requested_end: requestedEnd,
      pending_ranges: [{ startDate: requestedStart, endDate: requestedEnd }],
      status: 'pending',
      started_at: timestampNow,
      updated_at: timestampNow,
    }).select('*').single<SyncRow>();
    if (error || !data) throw new Error(`Tradovate history state create failed: ${error?.message ?? 'missing-row'}`);
    return data;
  }

  const pending = [...existing.pending_ranges];
  let changed = false;
  let nextStart = existing.requested_start;
  let nextEnd = existing.requested_end;
  const replaceEmptyLegacyWindow = integer(existing.rows_imported) === 0
    && requestedStart !== existing.requested_start
    && (existing.account_created_at == null || options.historyStartBasis === 'account_created_at');
  if (replaceEmptyLegacyWindow) {
    pending.splice(0, pending.length, { startDate: requestedStart, endDate: requestedEnd });
    nextStart = requestedStart;
    nextEnd = requestedEnd;
    changed = true;
  }
  if (!replaceEmptyLegacyWindow && requestedStart < existing.requested_start) {
    pending.unshift({ startDate: requestedStart, endDate: shiftDate(existing.requested_start, -1) });
    nextStart = requestedStart;
    changed = true;
  }
  if (!replaceEmptyLegacyWindow && requestedEnd > existing.requested_end) {
    pending.push({ startDate: shiftDate(existing.requested_end, 1), endDate: requestedEnd });
    nextEnd = requestedEnd;
    changed = true;
  }
  if (existing.status === 'error' && pending.length === 0 && !existing.active_range) {
    pending.push({ startDate: nextStart, endDate: nextEnd });
    changed = true;
  }
  const identityChanged = existing.connection_id !== options.connectionId
    || existing.account_name !== options.accountName
    || existing.account_created_at !== options.accountCreatedAt
    || existing.history_start_basis !== options.historyStartBasis;
  if (!changed && !identityChanged) {
    return existing;
  }
  const { data, error } = await options.db.from('tradovate_history_syncs').update({
    connection_id: options.connectionId,
    account_name: options.accountName,
    account_created_at: options.accountCreatedAt,
    history_start_basis: options.historyStartBasis,
    requested_start: nextStart,
    requested_end: nextEnd,
    pending_ranges: pending,
    active_range: replaceEmptyLegacyWindow ? null : existing.active_range,
    lease_expires_at: replaceEmptyLegacyWindow ? null : existing.lease_expires_at,
    status: pending.length > 0 ? 'pending' : existing.status,
    rows_seen: replaceEmptyLegacyWindow ? 0 : integer(existing.rows_seen),
    synced_through: replaceEmptyLegacyWindow ? null : existing.synced_through,
    last_error: changed ? null : existing.last_error,
    completed_at: changed ? null : existing.completed_at,
    revision: integer(existing.revision) + 1,
    updated_at: new Date(options.now).toISOString(),
  }).eq('id', existing.id).eq('revision', integer(existing.revision)).select('*').maybeSingle<SyncRow>();
  if (error) throw new Error(`Tradovate history state update failed: ${error.message}`);
  return data ?? (await loadSync({ ...options, externalAccountId })) ?? existing;
};

const recoverExpiredLease = (row: SyncRow, now: number): { pending: TradovateHistoryRange[]; active: TradovateHistoryRange | null } => {
  if (!row.active_range) return { pending: row.pending_ranges, active: null };
  const expires = Date.parse(row.lease_expires_at ?? '');
  if (Number.isFinite(expires) && expires > now) return { pending: row.pending_ranges, active: row.active_range };
  return { pending: [row.active_range, ...row.pending_ranges], active: null };
};

const claimNextRange = async (db: SupabaseClient, row: SyncRow, now: number): Promise<{ row: SyncRow; range: TradovateHistoryRange } | null> => {
  const recovered = recoverExpiredLease(row, now);
  if (recovered.active) return null;
  const [range, ...pending] = recovered.pending;
  if (!range) return null;
  const { data, error } = await db.from('tradovate_history_syncs').update({
    pending_ranges: pending,
    active_range: range,
    lease_expires_at: new Date(now + LEASE_MS).toISOString(),
    status: 'running',
    revision: integer(row.revision) + 1,
    updated_at: new Date(now).toISOString(),
  }).eq('id', row.id).eq('revision', integer(row.revision)).select('*').maybeSingle<SyncRow>();
  if (error) throw new Error(`Tradovate history range claim failed: ${error.message}`);
  return data ? { row: data, range } : null;
};

const persistTrades = async (options: {
  db: SupabaseClient;
  userId: string;
  environment: Environment;
  accountId: number;
  accountName: string;
  accountCreatedAt?: string | null;
  trades: TradovateHistoricalTrade[];
  now: number;
}): Promise<number> => {
  if (options.trades.length === 0) return 0;
  const updatedAt = new Date(options.now).toISOString();
  const rows = options.trades.map(trade => ({
    user_id: options.userId,
    environment: options.environment,
    external_account_id: String(options.accountId),
    account_name: options.accountName,
    source_report: 'Performance',
    source_key: trade.sourceKey,
    symbol: trade.symbol,
    buy_fill_id: trade.buyFillId,
    sell_fill_id: trade.sellFillId,
    quantity: trade.quantity,
    buy_price: trade.buyPrice,
    sell_price: trade.sellPrice,
    gross_pnl: trade.grossPnl,
    bought_at: trade.boughtAt,
    sold_at: trade.soldAt,
    trade_date: trade.tradeDate,
    raw_row: trade.rawRow,
    updated_at: updatedAt,
  }));
  const { error } = await options.db.from('tradovate_historical_trades').upsert(rows, {
    onConflict: 'user_id,environment,external_account_id,source_report,source_key',
  });
  if (error) throw new Error(`Tradovate historical trade save failed: ${error.message}`);
  return rows.length;
};

const finishRange = async (options: {
  db: SupabaseClient;
  row: SyncRow;
  range: TradovateHistoryRange;
  report: TradovateHistoricalReportResult;
  imported: number;
  split?: TradovateHistoryRange[];
  now: number;
}): Promise<SyncRow> => {
  const pending = [...(options.split ?? []), ...options.row.pending_ranges];
  const completed = pending.length === 0;
  const { data, error } = await options.db.from('tradovate_history_syncs').update({
    pending_ranges: pending,
    active_range: null,
    lease_expires_at: null,
    status: completed ? 'complete' : 'pending',
    rows_seen: integer(options.row.rows_seen) + (options.split ? 0 : options.report.rowCount),
    rows_imported: integer(options.row.rows_imported) + options.imported,
    synced_through: options.split ? options.row.synced_through : [options.row.synced_through, options.range.endDate].filter(Boolean).sort().at(-1) ?? null,
    last_error: null,
    completed_at: completed ? new Date(options.now).toISOString() : null,
    revision: integer(options.row.revision) + 1,
    updated_at: new Date(options.now).toISOString(),
  }).eq('id', options.row.id).eq('revision', integer(options.row.revision)).select('*').single<SyncRow>();
  if (error || !data) throw new Error(`Tradovate history range finish failed: ${error?.message ?? 'missing-row'}`);
  return data;
};

const failRange = async (options: {
  db: SupabaseClient;
  row: SyncRow;
  range: TradovateHistoryRange;
  diagnostic: string;
  now: number;
}): Promise<SyncRow> => {
  const { data, error } = await options.db.from('tradovate_history_syncs').update({
    pending_ranges: [options.range, ...options.row.pending_ranges],
    active_range: null,
    lease_expires_at: null,
    status: 'error',
    last_error: options.diagnostic.slice(0, 500),
    revision: integer(options.row.revision) + 1,
    updated_at: new Date(options.now).toISOString(),
  }).eq('id', options.row.id).eq('revision', integer(options.row.revision)).select('*').single<SyncRow>();
  if (error || !data) throw new Error(`Tradovate history range failure save failed: ${error?.message ?? 'missing-row'}`);
  return data;
};

export async function runTradovatePerformanceBackfillStep(options: {
  db: SupabaseClient;
  userId: string;
  connectionId: string;
  environment: Environment;
  accessToken: string;
  accountId: number;
  accountName: string;
  accountCreatedAt?: string | null;
  startDate?: string;
  endDate?: string;
  now?: number;
  fetchImpl?: typeof fetch;
  requestReport?: typeof requestTradovatePerformanceReport;
}): Promise<TradovateHistorySyncResult> {
  const now = options.now ?? Date.now();
  const endDate = options.endDate ?? new Date(now).toISOString().slice(0, 10);
  const window = resolveTradovateHistoryWindow({ endDate, accountCreatedAt: options.accountCreatedAt });
  const startDate = options.startDate ?? window.startDate;
  let row = await ensureSync({
    ...options,
    accountCreatedAt: window.accountCreatedAt,
    historyStartBasis: window.basis,
    startDate,
    endDate,
    now,
  });
  if (row.status === 'complete' && row.pending_ranges.length === 0 && !row.active_range) {
    return syncResult(row, options.accountId);
  }
  const claim = await claimNextRange(options.db, row, now);
  if (!claim) return syncResult(row, options.accountId);
  row = claim.row;
  const report = await (options.requestReport ?? requestTradovatePerformanceReport)({
    environment: options.environment,
    accessToken: options.accessToken,
    accountId: options.accountId,
    accountSpec: options.accountName,
    startDate: mmddyyyy(claim.range.startDate),
    endDate: mmddyyyy(claim.range.endDate),
    fetchImpl: options.fetchImpl,
    timeoutMs: 12_000,
  });
  if (report.status === 'available') {
    const split = report.truncated ? splitTradovateHistoryRange(claim.range) : null;
    if (report.truncated && !split) {
      row = await failRange({ db: options.db, row, range: claim.range, diagnostic: 'single-day-report-too-large', now });
      return syncResult(row, options.accountId);
    }
    if (split) {
      row = await finishRange({ db: options.db, row, range: claim.range, report, imported: 0, split, now });
      return syncResult(row, options.accountId);
    }
    const trades = normalizeTradovatePerformanceRows(report.columns, report.rows);
    const imported = await persistTrades({ ...options, trades, now });
    row = await finishRange({ db: options.db, row, range: claim.range, report, imported, now });
    return syncResult(row, options.accountId);
  }
  if (report.diagnostic === 'timeout' || isTradovateRangeTooLongDiagnostic(report.diagnostic)) {
    const split = splitTradovateHistoryRange(claim.range);
    if (split) {
      row = await finishRange({ db: options.db, row, range: claim.range, report, imported: 0, split, now });
      return syncResult(row, options.accountId);
    }
  }
  row = await failRange({
    db: options.db,
    row,
    range: claim.range,
    diagnostic: `${report.status}${report.httpStatus ? ` HTTP ${report.httpStatus}` : ''}${report.diagnostic ? `: ${report.diagnostic}` : ''}`,
    now,
  });
  return syncResult(row, options.accountId);
}

const nullableNumber = (value: number | string | null): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const historicalTrade = (row: HistoricalTradeRow): TradovateHistoricalTrade => {
  // Repair rows persisted before the $-123 sign parser fix without requiring
  // a destructive backfill. raw_row is the immutable reporting evidence.
  const rawPnl = numeric(field(row.raw_row ?? {}, ['pnl', 'p&l', 'grossPnl', 'gross p&l']));
  const buyPrice = nullableNumber(row.buy_price);
  const sellPrice = nullableNumber(row.sell_price);
  return {
    sourceKey: row.source_key,
    symbol: row.symbol,
    buyFillId: nullableNumber(row.buy_fill_id),
    sellFillId: nullableNumber(row.sell_fill_id),
    quantity: nullableNumber(row.quantity),
    buyPrice,
    sellPrice,
    grossPnl: directionalGrossPnl(rawPnl ?? nullableNumber(row.gross_pnl), buyPrice, sellPrice),
    boughtAt: row.bought_at,
    soldAt: row.sold_at,
    tradeDate: row.trade_date,
    rawRow: row.raw_row,
  };
};

export async function loadTradovateHistorySnapshot(options: {
  db: SupabaseClient;
  userId: string;
  environment: Environment;
  accountId: number;
  limit?: number;
}): Promise<{ sync: TradovateHistorySyncResult | null; trades: TradovateHistoricalTrade[] }> {
  const externalAccountId = String(options.accountId);
  const [sync, trades] = await Promise.all([
    loadSync({ ...options, externalAccountId }),
    options.db.from('tradovate_historical_trades')
      .select('source_key,symbol,buy_fill_id,sell_fill_id,quantity,buy_price,sell_price,gross_pnl,bought_at,sold_at,trade_date,raw_row')
      .eq('user_id', options.userId)
      .eq('environment', options.environment)
      .eq('external_account_id', externalAccountId)
      .order('sold_at', { ascending: false })
      .limit(Math.min(Math.max(options.limit ?? 500, 1), 2_000)),
  ]);
  if (trades.error) throw new Error(`Tradovate historical trades load failed: ${trades.error.message}`);
  return {
    sync: sync ? syncResult(sync, options.accountId) : null,
    trades: ((trades.data ?? []) as HistoricalTradeRow[]).map(historicalTrade),
  };
}
