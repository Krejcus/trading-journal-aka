import type { Account, Trade } from '../types';
import { storageService } from './storageService';
import { supabase } from './supabase';

const CURSOR_PREFIX = 'alphatrade-copier-journal-cursor-';
const ACCOUNT_PREFIX = 'alphatrade-copier-journal-account-';
const FIRST_SYNC_DAYS = 30;

export interface CopierLedgerRow {
  trade_id: string;
  symbol: string;
  side: 'Long' | 'Short';
  quantity: number;
  realized_pnl_usd: number | null;
  opened_at: string | null;
  closed_at: string;
  exit_reason: 'sl' | 'tp' | 'manual' | null;
  entry_price: number | null;
  exit_price: number | null;
  connection_id?: string | null;
}

export interface PendingCopierJournalTrade {
  id: string;
  tradeId: string;
  symbol: string;
  closedAt: string;
  pnl: number | null;
  leaderAccountId: number;
  connectionId: string | null;
}

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CopierJournalSyncDeps {
  loadRows: (userId: string, after: string) => Promise<CopierLedgerRow[]>;
  getTrades: () => Promise<Trade[]>;
  saveTrades: (trades: Trade[]) => Promise<Trade[]>;
  cursorStore: KeyValueStore;
  now: () => number;
}

export interface CopierJournalSyncOptions {
  userId: string;
  leaderAccountId: number | null;
  accounts: readonly Account[];
  /** Explicitní volba z banneru; uloží se lokálně pro další syncy tohoto leadera. */
  accountIdOverride?: string;
  deps?: Partial<CopierJournalSyncDeps>;
}

export interface CopierJournalSyncResult {
  created: Trade[];
  pending: PendingCopierJournalTrade[];
  scanned: number;
}

const browserStore: KeyValueStore = {
  getItem: key => typeof localStorage === 'undefined' ? null : localStorage.getItem(key),
  setItem: (key, value) => { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); },
};

const defaultLoadRows = async (userId: string, after: string): Promise<CopierLedgerRow[]> => {
  const { data, error } = await supabase
    .from('tradovate_copier_trades')
    .select('trade_id,symbol,side,quantity,realized_pnl_usd,opened_at,closed_at,exit_reason,entry_price,exit_price,connection_id')
    .eq('user_id', userId)
    .gt('closed_at', after)
    .order('closed_at', { ascending: true });
  if (error) throw new Error(`copier-journal-ledger-read-failed: ${error.message}`);
  return (data ?? []) as CopierLedgerRow[];
};

const defaultDeps: CopierJournalSyncDeps = {
  loadRows: defaultLoadRows,
  getTrades: () => storageService.getTrades(),
  saveTrades: trades => storageService.saveTrades(trades),
  cursorStore: browserStore,
  now: () => Date.now(),
};

const finiteOrUndefined = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** MNQU6 / NQZ25 -> MNQ / NQ; symbol bez kontraktního suffixu nechá beze změny. */
export const copierSymbolRoot = (symbol: string): string =>
  symbol.trim().toUpperCase().replace(/[FGHJKMNQUVXZ]\d{1,2}$/, '');

const validRow = (row: CopierLedgerRow): boolean =>
  typeof row.trade_id === 'string' && row.trade_id.trim().length > 0
  && typeof row.symbol === 'string' && row.symbol.trim().length > 0
  && (row.side === 'Long' || row.side === 'Short')
  && Number.isFinite(row.quantity) && row.quantity > 0
  && Number.isFinite(Date.parse(row.closed_at));

const candidateFromRow = (row: CopierLedgerRow, accountId: string): Trade => {
  const closedAt = Date.parse(row.closed_at);
  const openedAt = row.opened_at ? Date.parse(row.opened_at) : Number.NaN;
  const durationMinutes = Number.isFinite(openedAt)
    ? Math.max(0, Math.round((closedAt - openedAt) / 60_000))
    : 0;
  const copierTradeId = `copier-${row.trade_id.trim()}`;
  return {
    id: copierTradeId,
    copierTradeId,
    accountId,
    source: 'copier',
    signal: 'Copier',
    instrument: copierSymbolRoot(row.symbol),
    direction: row.side,
    pnl: finiteOrUndefined(row.realized_pnl_usd) ?? 0,
    positionSize: row.quantity,
    date: new Date(closedAt).toISOString(),
    timestamp: closedAt,
    ...(Number.isFinite(openedAt) ? {
      entryTime: openedAt,
      entryDate: new Date(openedAt).toISOString(),
    } : {}),
    exitDate: new Date(closedAt).toISOString(),
    entryPrice: finiteOrUndefined(row.entry_price),
    exitPrice: finiteOrUndefined(row.exit_price),
    exitReason: row.exit_reason === 'sl' || row.exit_reason === 'tp' || row.exit_reason === 'manual'
      ? row.exit_reason
      : undefined,
    needsReview: true,
    runUp: 0,
    drawdown: 0,
    durationMinutes,
    duration: `${durationMinutes}m`,
  };
};

export async function syncCopierJournal(options: CopierJournalSyncOptions): Promise<CopierJournalSyncResult> {
  const { userId, leaderAccountId, accounts } = options;
  if (!userId || leaderAccountId == null || !Number.isSafeInteger(leaderAccountId)) {
    return { created: [], pending: [], scanned: 0 };
  }
  const deps = { ...defaultDeps, ...options.deps };
  const cursorKey = `${CURSOR_PREFIX}${userId}`;
  const storedCursor = deps.cursorStore.getItem(cursorKey);
  const firstCursor = new Date(deps.now() - FIRST_SYNC_DAYS * 24 * 60 * 60_000).toISOString();
  const after = storedCursor && Number.isFinite(Date.parse(storedCursor)) ? storedCursor : firstCursor;
  const rows = (await deps.loadRows(userId, after)).filter(validRow);
  if (rows.length === 0) return { created: [], pending: [], scanned: 0 };

  const accountKey = `${ACCOUNT_PREFIX}${userId}-${leaderAccountId}`;
  if (options.accountIdOverride && accounts.some(account => account.id === options.accountIdOverride)) {
    deps.cursorStore.setItem(accountKey, options.accountIdOverride);
  }
  const explicitAccountId = options.accountIdOverride ?? deps.cursorStore.getItem(accountKey);
  const account = accounts.find(candidate => candidate.oauth?.externalAccountId === String(leaderAccountId))
    ?? accounts.find(candidate => candidate.id === explicitAccountId);

  if (!account) {
    return {
      created: [],
      scanned: rows.length,
      pending: rows.map(row => ({
        id: `copier-${row.trade_id.trim()}`,
        tradeId: row.trade_id.trim(),
        symbol: copierSymbolRoot(row.symbol),
        closedAt: row.closed_at,
        pnl: finiteOrUndefined(row.realized_pnl_usd) ?? null,
        leaderAccountId,
        connectionId: row.connection_id ?? null,
      })),
    };
  }

  const existing = await deps.getTrades();
  const existingIds = new Set(existing.flatMap(trade => [String(trade.id), trade.copierTradeId].filter(Boolean) as string[]));
  const candidates = rows
    .map(row => candidateFromRow(row, account.id))
    .filter(trade => !existingIds.has(String(trade.id)) && !existingIds.has(String(trade.copierTradeId)));
  const created = candidates.length > 0 ? await deps.saveTrades(candidates) : [];

  // Kurzor se posune až po úspěšném zápisu (nebo při čistě idempotentním průchodu).
  // Při chybě saveTrades výjimka probublá a stejná data se bezpečně načtou znovu.
  const newest = rows.reduce((latest, row) => Date.parse(row.closed_at) > Date.parse(latest) ? row.closed_at : latest, after);
  deps.cursorStore.setItem(cursorKey, newest);
  return { created, pending: [], scanned: rows.length };
}
