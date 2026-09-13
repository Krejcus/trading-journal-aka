import type { Account, Trade } from '../types';
import type { TradovateOAuthStatus } from './tradovateOAuthConnection';
import type { JournalImportResult } from '../server/journalPositionImport';
import { isEvidenceJournalTrade, isRetiredJournalTrade } from '../lib/journalTradeFacts';
import { changedTradeFields } from './tradePatch';

export interface JournalConnectionSync {
  connectionId: string;
  state: 'processing' | 'ready' | 'empty' | 'pending' | 'stale' | 'unavailable' | 'unsupported';
  through: number;
  targetThrough?: number;
  pending: number;
  unassigned: number;
  reason?: string;
}
export interface JournalSyncReport { connections: JournalConnectionSync[]; completedAt: number }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function parseJournalImportResult(value: unknown): JournalImportResult {
  if (!value || typeof value !== 'object') throw new Error('journal-import-invalid-response');
  const row = value as JournalImportResult;
  const processing = row.accepted === false && row.processing === true;
  if (![row.through, row.confirmed, row.pending, row.unassigned].every(count)
    || (row.accepted !== true && !(row.accepted === false && row.stale === true) && !processing)
    || (row.accepted === true && (row.stale === true || row.processing === true))
    || (processing && (row.stale === true || row.unchanged === true || !count(row.targetThrough)
      || row.targetThrough! < row.through || row.confirmed + row.pending + row.unassigned !== 0))
    || (row.through === 0 && row.confirmed + row.pending + row.unassigned > 0)) throw new Error('journal-import-invalid-response');
  return { accepted: row.accepted, stale: row.stale === true, through: row.through,
    ...(processing ? { processing: true, targetThrough: row.targetThrough } : {}),
    confirmed: row.confirmed, pending: row.pending, unassigned: row.unassigned };
}

/** One import per historical connection, never per current leader/follower.
 * All financial values are calculated server-side from immutable evidence. */
export async function syncJournalConnections(options: {
  accounts: readonly Account[];
  isCurrent: () => boolean;
  signal: AbortSignal;
  loadStatus: () => Promise<TradovateOAuthStatus>;
  importConnection: (connectionId: string, signal: AbortSignal) => Promise<unknown>;
  loadTrades: () => Promise<Trade[]>;
}): Promise<{ report: JournalSyncReport; trades: Trade[] | null }> {
  const active = () => { if (options.signal.aborted || !options.isCurrent()) throw new Error('journal-session-changed'); };
  active();
  const status = await options.loadStatus(); active();
  const scopes = new Map<string, 'demo' | 'live'>();
  for (const connection of status.connections) {
    if (!uuid.test(connection.id)) throw new Error('journal-connection-invalid');
    scopes.set(connection.id, connection.environment);
  }
  // Preserve access to a disconnected historical connection still referenced
  // by an account. Nothing here acquires or refreshes a broker token.
  for (const account of options.accounts) if (account.oauth?.provider === 'tradovate') {
    const { connectionId, environment } = account.oauth;
    if (!uuid.test(connectionId) || (scopes.has(connectionId) && scopes.get(connectionId) !== environment)) throw new Error('journal-connection-invalid');
    scopes.set(connectionId, environment);
  }
  if (scopes.size > 250) throw new Error('journal-import-partition-required');
  const connections: JournalConnectionSync[] = [];
  let accepted = false;
  for (const [connectionId, environment] of scopes) {
    active();
    if (environment !== 'demo') {
      connections.push({ connectionId, state: 'unsupported', through: 0, pending: 0, unassigned: 0 }); continue;
    }
    try {
      const result = parseJournalImportResult(await options.importConnection(connectionId, options.signal)); active();
      accepted ||= result.accepted;
      connections.push({ connectionId, through: result.through, pending: result.pending, unassigned: result.unassigned,
        ...(result.processing ? { targetThrough: result.targetThrough } : {}),
        state: result.processing ? 'processing' : !result.accepted ? 'stale' : result.through === 0 ? 'empty' : result.pending || result.unassigned ? 'pending' : 'ready' });
    } catch (error) {
      active();
      const message = error instanceof Error ? error.message : '';
      const reason = ['journal-legacy-reference-ambiguous', 'journal-legacy-connection-unavailable', 'journal-import-partition-required']
        .find(code => message.includes(code));
      connections.push({ connectionId, state: 'unavailable', through: 0, pending: 0, unassigned: 0, reason });
    }
  }
  active();
  // Even a zero-result import can invalidate a former trade. A complete read
  // must remove it from financial arrays, instead of retaining a stale P&L.
  const trades = accepted ? await options.loadTrades() : null; active();
  return { report: { connections, completedAt: Date.now() }, trades };
}

const factFields = new Set(['id', 'accountId', 'instrument', 'direction', 'pnl', 'entryPrice', 'exitPrice',
  'riskAmount', 'targetAmount', 'entryTime', 'entryDate', 'timestamp', 'date', 'exitDate', 'positionSize', 'durationMinutes', 'duration',
  'groupId', 'isMaster', 'stopLoss', 'takeProfit', 'pnlEstimated', 'copierTradeId', 'source',
  'copierSnapshots', 'copierEpisodeId', 'copierSnapshotLoadError', 'journalSupersededBy', 'journalLegacyCopierTradeId', 'journalLegacyAccountId', 'executionHistory']);

/** Apply only journal membership/facts; do not overwrite a concurrently edited
 * review, manual trade, new local insert or explicit local deletion. */
export function mergeImportedJournalTrades(current: Trade[], before: readonly Trade[], incoming: readonly Trade[]): Trade[] {
  const baseline = new Map(before.map(trade => [String(trade.id), trade]));
  const now = new Map(current.map(trade => [String(trade.id), trade]));
  const imported = new Map(incoming.filter(isEvidenceJournalTrade).map(trade => [String(trade.id), trade]));
  const incomingIds = new Set(incoming.map(trade => String(trade.id)));
  const result = current.flatMap(trade => {
    const id = String(trade.id);
    const next = imported.get(id);
    if (next) {
      const previous = baseline.get(id);
      const localReview = Object.fromEntries(Object.entries(changedTradeFields(previous ?? {}, trade)).filter(([key]) => !factFields.has(key)));
      return [{ ...next, ...localReview } as Trade];
    }
    if (isRetiredJournalTrade(trade) || (baseline.has(id) && (isEvidenceJournalTrade(trade) || trade.source === 'copier')
      && !incomingIds.has(id))) return [];
    return [trade];
  });
  for (const [id, trade] of imported) {
    if (now.has(id) || baseline.has(id)) continue;
    result.push(trade);
  }
  return result.sort((a, b) => b.timestamp - a.timestamp);
}
