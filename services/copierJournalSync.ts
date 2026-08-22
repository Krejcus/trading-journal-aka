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
  episode_id?: string | null;
  connection_id?: string | null;
}

export interface CopierSnapshotRow {
  episode_id: string;
  kind: string;
  at: string;
  storage_path: string;
}

export interface PendingCopierJournalTrade {
  id: string;
  tradeId: string;
  symbol: string;
  closedAt: string;
  pnl: number | null;
  leaderAccountId: number;
  connectionId: string | null;
  followers: CopierJournalFollower[];
}

export interface CopierJournalFollower {
  accountId: number;
  multiplier: number;
}

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CopierJournalSyncDeps {
  loadRows: (userId: string, after: string) => Promise<CopierLedgerRow[]>;
  loadSnapshots: (userId: string, episodeIds: string[]) => Promise<CopierSnapshotRow[]>;
  getTrades: () => Promise<Trade[]>;
  saveTrades: (trades: Trade[]) => Promise<Trade[]>;
  updateTrade: (tradeId: string | number, updates: Partial<Trade>) => Promise<void>;
  cursorStore: KeyValueStore;
  now: () => number;
}

export interface CopierJournalSyncOptions {
  userId: string;
  leaderAccountId: number | null;
  accounts: readonly Account[];
  followers: readonly CopierJournalFollower[];
  /** Explicitní volba z banneru; uloží se lokálně pro další syncy tohoto leadera. */
  accountIdOverride?: string;
  deps?: Partial<CopierJournalSyncDeps>;
}

export interface CopierJournalSyncResult {
  created: Trade[];
  pending: PendingCopierJournalTrade[];
  scanned: number;
  skippedFollowers: number;
  updated: Trade[];
}

const browserStore: KeyValueStore = {
  getItem: key => typeof localStorage === 'undefined' ? null : localStorage.getItem(key),
  setItem: (key, value) => { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); },
};

const defaultLoadRows = async (userId: string, after: string): Promise<CopierLedgerRow[]> => {
  const { data, error } = await supabase
    .from('tradovate_copier_trades')
    .select('trade_id,symbol,side,quantity,realized_pnl_usd,opened_at,closed_at,exit_reason,entry_price,exit_price,episode_id,connection_id')
    .eq('user_id', userId)
    .gt('closed_at', after)
    .order('closed_at', { ascending: true });
  if (error) throw new Error(`copier-journal-ledger-read-failed: ${error.message}`);
  return (data ?? []) as CopierLedgerRow[];
};

const defaultLoadSnapshots = async (userId: string, episodeIds: string[]): Promise<CopierSnapshotRow[]> => {
  if (episodeIds.length === 0) return [];
  const { data, error } = await supabase
    .from('copier_trade_snapshots')
    .select('episode_id,kind,at,storage_path')
    .eq('user_id', userId)
    .in('episode_id', episodeIds)
    .order('at', { ascending: true });
  if (error) throw new Error(`copier-journal-snapshot-read-failed: ${error.message}`);
  return (data ?? []) as CopierSnapshotRow[];
};

const defaultDeps: CopierJournalSyncDeps = {
  loadRows: defaultLoadRows,
  loadSnapshots: defaultLoadSnapshots,
  getTrades: () => storageService.getTrades(),
  saveTrades: trades => storageService.saveTrades(trades),
  updateTrade: (tradeId, updates) => storageService.updateTrade(tradeId, updates),
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

const copierLogicalId = (tradeId: string): string => `copier-${tradeId.trim()}`;
const copierGroupId = (tradeId: string): string => `copier-group-${tradeId.trim()}`;
const followerLogicalId = (tradeId: string, followerAccountId: number): string =>
  `copier-${tradeId.trim()}-${followerAccountId}`;

const candidateFromRow = (row: CopierLedgerRow, accountId: string, snapshots: CopierSnapshotRow[]): Trade => {
  const closedAt = Date.parse(row.closed_at);
  const openedAt = row.opened_at ? Date.parse(row.opened_at) : Number.NaN;
  const durationMinutes = Number.isFinite(openedAt)
    ? Math.max(0, Math.round((closedAt - openedAt) / 60_000))
    : 0;
  const rawTradeId = row.trade_id.trim();
  const copierTradeId = copierLogicalId(rawTradeId);
  return {
    id: copierTradeId,
    copierTradeId,
    groupId: copierGroupId(rawTradeId),
    isMaster: true,
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
    ...(snapshots.length > 0 ? {
      copierSnapshots: snapshots.map(snapshot => ({
        kind: snapshot.kind,
        at: Date.parse(snapshot.at),
        path: snapshot.storage_path,
      })).filter(snapshot => Number.isFinite(snapshot.at)),
    } : {}),
    needsReview: true,
    runUp: 0,
    drawdown: 0,
    durationMinutes,
    duration: `${durationMinutes}m`,
  };
};

const rawTradeIdFromMaster = (trade: Trade): string | null => {
  const logicalId = trade.copierTradeId ?? (String(trade.id).startsWith('copier-') ? String(trade.id) : '');
  return logicalId.startsWith('copier-') && logicalId.length > 'copier-'.length
    ? logicalId.slice('copier-'.length)
    : null;
};

const followerCopyFromMaster = (
  master: Trade,
  rawTradeId: string,
  accountId: string,
  follower: CopierJournalFollower,
): Trade => {
  const multiplier = follower.multiplier;
  const logicalId = followerLogicalId(rawTradeId, follower.accountId);
  const scaledQuantity = Math.round((master.positionSize ?? 0) * multiplier);
  return {
    id: logicalId,
    copierTradeId: logicalId,
    accountId,
    source: 'copier',
    signal: 'Copier',
    instrument: master.instrument,
    direction: master.direction,
    pnl: master.pnl * multiplier,
    pnlEstimated: true,
    positionSize: multiplier > 0 ? Math.max(1, scaledQuantity) : scaledQuantity,
    date: master.date,
    timestamp: master.timestamp,
    entryTime: master.entryTime,
    entryDate: master.entryDate,
    exitDate: master.exitDate,
    entryPrice: master.entryPrice,
    exitPrice: master.exitPrice,
    exitReason: master.exitReason,
    groupId: copierGroupId(rawTradeId),
    masterTradeId: master.id,
    runUp: 0,
    drawdown: 0,
    durationMinutes: master.durationMinutes,
    duration: master.duration,
  };
};

export async function syncCopierJournal(options: CopierJournalSyncOptions): Promise<CopierJournalSyncResult> {
  const { userId, leaderAccountId, accounts, followers } = options;
  if (!userId || leaderAccountId == null || !Number.isSafeInteger(leaderAccountId)) {
    return { created: [], pending: [], scanned: 0, skippedFollowers: 0, updated: [] };
  }
  const deps = { ...defaultDeps, ...options.deps };
  const cursorKey = `${CURSOR_PREFIX}${userId}`;
  const storedCursor = deps.cursorStore.getItem(cursorKey);
  const firstCursor = new Date(deps.now() - FIRST_SYNC_DAYS * 24 * 60 * 60_000).toISOString();
  const after = storedCursor && Number.isFinite(Date.parse(storedCursor)) ? storedCursor : firstCursor;
  const rows = (await deps.loadRows(userId, after)).filter(validRow);
  const episodeIds = [...new Set(rows.flatMap(row => row.episode_id ? [row.episode_id] : []))];
  const snapshotRows = await deps.loadSnapshots(userId, episodeIds);
  const snapshotsByEpisode = new Map<string, CopierSnapshotRow[]>();
  for (const snapshot of snapshotRows) {
    const list = snapshotsByEpisode.get(snapshot.episode_id) ?? [];
    list.push(snapshot);
    snapshotsByEpisode.set(snapshot.episode_id, list);
  }

  const existing = await deps.getTrades();
  const existingIds = new Set(existing.flatMap(trade => [String(trade.id), trade.copierTradeId].filter(Boolean) as string[]));
  const created: Trade[] = [];
  const updated: Trade[] = [];
  let skippedFollowers = 0;

  const buildMissingCopies = (master: Trade, rawTradeId: string): Trade[] => {
    const copies: Trade[] = [];
    const seenFollowers = new Set<number>();
    for (const follower of followers) {
      if (seenFollowers.has(follower.accountId)) continue;
      seenFollowers.add(follower.accountId);
      const logicalId = followerLogicalId(rawTradeId, follower.accountId);
      if (existingIds.has(logicalId)) continue;
      const journalAccount = accounts.find(candidate =>
        candidate.oauth?.externalAccountId === String(follower.accountId));
      if (!journalAccount) {
        skippedFollowers += 1;
        continue;
      }
      copies.push(followerCopyFromMaster(master, rawTradeId, journalAccount.id, follower));
      existingIds.add(logicalId);
    }
    return copies;
  };

  // Starší copier mastery za posledních 30 dní pouze doplníme o seskupení.
  // Reflexe ani jiná uživatelská pole se touto aktualizací nikdy nepřepisují.
  const healingCutoff = deps.now() - FIRST_SYNC_DAYS * 24 * 60 * 60_000;
  const healingMasters = existing.filter(trade =>
    trade.source === 'copier'
    && trade.masterTradeId == null
    && trade.timestamp >= healingCutoff
    && rawTradeIdFromMaster(trade) != null);
  const healingCopies: Trade[] = [];
  for (const master of healingMasters) {
    const rawTradeId = rawTradeIdFromMaster(master)!;
    const healingUpdate: Partial<Trade> = {};
    if (!master.groupId) healingUpdate.groupId = copierGroupId(rawTradeId);
    if (master.isMaster == null) healingUpdate.isMaster = true;
    const healedMaster = Object.keys(healingUpdate).length > 0 ? { ...master, ...healingUpdate } : master;
    if (Object.keys(healingUpdate).length > 0) {
      await deps.updateTrade(master.id, healingUpdate);
      updated.push(healedMaster);
    }
    healingCopies.push(...buildMissingCopies(healedMaster, rawTradeId));
  }
  if (healingCopies.length > 0) created.push(...await deps.saveTrades(healingCopies));

  const accountKey = `${ACCOUNT_PREFIX}${userId}-${leaderAccountId}`;
  if (options.accountIdOverride && accounts.some(account => account.id === options.accountIdOverride)) {
    deps.cursorStore.setItem(accountKey, options.accountIdOverride);
  }
  const explicitAccountId = options.accountIdOverride ?? deps.cursorStore.getItem(accountKey);
  const account = accounts.find(candidate => candidate.oauth?.externalAccountId === String(leaderAccountId))
    ?? accounts.find(candidate => candidate.id === explicitAccountId);

  if (!account) {
    return {
      created,
      updated,
      skippedFollowers,
      scanned: rows.length,
      pending: rows.map(row => ({
        id: copierLogicalId(row.trade_id),
        tradeId: row.trade_id.trim(),
        symbol: copierSymbolRoot(row.symbol),
        closedAt: row.closed_at,
        pnl: finiteOrUndefined(row.realized_pnl_usd) ?? null,
        leaderAccountId,
        connectionId: row.connection_id ?? null,
        followers: [...followers],
      })),
    };
  }

  const masterCandidates = rows
    .map(row => candidateFromRow(row, account.id,
      row.episode_id ? (snapshotsByEpisode.get(row.episode_id) ?? []) : []))
    .filter(trade => !existingIds.has(String(trade.id)) && !existingIds.has(String(trade.copierTradeId)));
  const savedMasters = masterCandidates.length > 0 ? await deps.saveTrades(masterCandidates) : [];
  created.push(...savedMasters);
  for (const master of savedMasters) {
    if (master.copierTradeId) existingIds.add(master.copierTradeId);
  }

  const rowByLogicalId = new Map(rows.map(row => [copierLogicalId(row.trade_id), row]));
  const newCopies = savedMasters.flatMap(master => {
    const row = master.copierTradeId ? rowByLogicalId.get(master.copierTradeId) : undefined;
    return row ? buildMissingCopies(master, row.trade_id.trim()) : [];
  });
  if (newCopies.length > 0) created.push(...await deps.saveTrades(newCopies));

  // Kurzor se posune až po úspěšném zápisu (nebo při čistě idempotentním průchodu).
  // Při chybě saveTrades výjimka probublá a stejná data se bezpečně načtou znovu.
  const newest = rows.reduce((latest, row) => Date.parse(row.closed_at) > Date.parse(latest) ? row.closed_at : latest, after);
  deps.cursorStore.setItem(cursorKey, newest);
  return { created, updated, pending: [], scanned: rows.length, skippedFollowers };
}
