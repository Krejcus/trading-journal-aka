import { describe, expect, it, vi } from 'vitest';
import { mergeImportedJournalTrades, parseJournalImportResult, syncJournalConnections } from '../services/journalImportSync';
import type { Account, Trade } from '../types';
import type { TradovateOAuthStatus } from '../services/tradovateOAuthConnection';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const accepted = { accepted: true, through: 42, confirmed: 12, pending: 0, unassigned: 0 };
const row = (id: string, values: Partial<Trade> = {}) => ({ id, timestamp: 1000, source: 'copier', copierTradeId: `journal:${id}`, pnl: 19, notes: 'saved review', ...values } as Trade);
function fixture() {
  const accounts = Array.from({ length: 12 }, (_, index) => ({ id: String(index), oauth: {
    provider: 'tradovate', environment: 'demo', connectionId: first, externalAccountId: String(index + 1), firm: null,
  } } as Account));
  const status = { environment: 'demo', connected: true, connections: [{ id: first, environment: 'demo', connected: true }] } as TradovateOAuthStatus;
  const abort = new AbortController();
  const options = { accounts, signal: abort.signal, isCurrent: () => true, loadStatus: vi.fn(async () => status),
    importConnection: vi.fn(async (): Promise<unknown> => accepted), loadTrades: vi.fn(async () => [row('a')]) };
  return { options, status, abort };
}
describe('new journal synchronization and cutover', () => {
  it('imports one historical connection once for twelve accounts, without current copier configuration', async () => {
    const f = fixture(); const result = await syncJournalConnections(f.options);
    expect(f.options.importConnection).toHaveBeenCalledTimes(1);
    expect(f.options.importConnection).toHaveBeenCalledWith(first, f.abort.signal);
    expect(result.report.connections).toMatchObject([{ connectionId: first, state: 'ready', through: 42 }]);
    expect(result.trades).toEqual([row('a')]);
  });
  it('keeps disconnected historical accounts and does not hide an independent connection failure', async () => {
    const f = fixture(); f.options.accounts.push({ ...f.options.accounts[0], oauth: { ...f.options.accounts[0].oauth!, connectionId: second } });
    f.options.importConnection.mockRejectedValueOnce(new Error('journal-legacy-reference-ambiguous')).mockResolvedValueOnce(accepted);
    const result = await syncJournalConnections(f.options);
    expect(f.options.importConnection).toHaveBeenCalledTimes(2);
    expect(result.report.connections).toMatchObject([{ state: 'unavailable', reason: 'journal-legacy-reference-ambiguous' }, { state: 'ready' }]);
    expect(result.trades).not.toBeNull();
  });
  it('distinguishes empty evidence, pending accounting, stale acknowledgement and unsupported environment', async () => {
    for (const [response, state] of [
      [{ ...accepted, through: 0, confirmed: 0 }, 'empty'],
      [{ ...accepted, pending: 1 }, 'pending'],
      [{ ...accepted, unassigned: 2 }, 'pending'],
      [{ ...accepted, accepted: false, stale: true }, 'stale'],
    ] as const) {
      const f = fixture(); f.options.importConnection.mockResolvedValue(response);
      expect((await syncJournalConnections(f.options)).report.connections[0].state).toBe(state);
      if (state === 'stale') expect(f.options.loadTrades).not.toHaveBeenCalled();
    }
    const f = fixture(); f.status.connections[0].environment = 'live'; f.options.accounts = [];
    expect((await syncJournalConnections(f.options)).report.connections[0].state).toBe('unsupported');
    expect(f.options.importConnection).not.toHaveBeenCalled();
  });
  it('reports durable processing without loading or publishing partial financial results', async () => {
    const f = fixture();
    const response = { accepted: false, processing: true, through: 250, targetThrough: 2000, confirmed: 0, pending: 0, unassigned: 0 };
    f.options.importConnection.mockResolvedValue(response);
    const result = await syncJournalConnections(f.options);
    expect(result.report.connections).toMatchObject([{ state: 'processing', through: 250, targetThrough: 2000 }]);
    expect(result.trades).toBeNull();
    expect(f.options.loadTrades).not.toHaveBeenCalled();
    for (const invalid of [{ ...response, targetThrough: 249 }, { ...response, targetThrough: undefined },
      { ...response, confirmed: 1 }, { ...response, stale: true }, { ...response, unchanged: true }, { ...response, accepted: true }]) {
      expect(() => parseJournalImportResult(invalid)).toThrow('invalid-response');
    }
  });
  it('fences account changes and cancellation, including after the saved trades arrive', async () => {
    const f = fixture(); f.options.loadTrades.mockImplementation(async () => { f.abort.abort(); return [row('a')]; });
    await expect(syncJournalConnections(f.options)).rejects.toThrow('session-changed');
    const g = fixture(); g.options.loadStatus.mockImplementation(async () => { g.options.isCurrent = () => false; return g.status; });
    await expect(syncJournalConnections(g.options)).rejects.toThrow('session-changed');
    expect(g.options.importConnection).not.toHaveBeenCalled();
  });
  it('requires a valid server ACK and never converts missing facts to a zero result', () => {
    for (const value of [{}, { accepted: true }, { ...accepted, pending: -1 }, { ...accepted, through: NaN }, { ...accepted, accepted: false }]) {
      expect(() => parseJournalImportResult(value)).toThrow('invalid-response');
    }
  });
  it('applies fact corrections while preserving local review edits and manual trades', () => {
    const before = [row('a', { riskAmount: 123, targetAmount: 456 }), row('manual', { source: undefined, copierTradeId: undefined })];
    const current = [{ ...before[0], notes: 'edited during import', pnl: 999, riskAmount: 789 }, { ...before[1], notes: 'manual edit' }];
    const result = mergeImportedJournalTrades(current, before, [{ ...before[0], pnl: 38, accountId: 'verified', riskAmount: undefined, targetAmount: undefined }, before[1]]);
    expect(result.find(trade => trade.id === 'a')).toMatchObject({ pnl: 38, accountId: 'verified', notes: 'edited during import' });
    expect(result.find(trade => trade.id === 'a')?.riskAmount).toBeUndefined();
    expect(result.find(trade => trade.id === 'a')?.targetAmount).toBeUndefined();
    expect(result.find(trade => trade.id === 'manual')?.notes).toBe('manual edit');
  });
  it('accepts fresh media links and errors as read facts while preserving concurrent notes', () => {
    const before = row('a', { copierSnapshots: [{ kind: 'entry', at: 1, path: 'old' }] });
    const current = { ...before, notes: 'new note', copierSnapshots: [{ kind: 'exit', at: 2, path: 'unverified' }], copierSnapshotLoadError: false };
    const incoming = { ...before, copierSnapshots: [], copierSnapshotLoadError: true };
    const result = mergeImportedJournalTrades([current], [before], [incoming]);
    expect(result[0]).toMatchObject({ notes: 'new note', copierSnapshots: [], copierSnapshotLoadError: true });
  });
  it('removes invalidated and superseded results, adopts legacy UUID and does not resurrect local deletions', () => {
    const before = [row('deleted'), row('invalidated'), row('legacy', { copierTradeId: 'copier-9' }), row('duplicate', { copierTradeId: 'copier-9' })];
    const current = before.slice(1);
    const result = mergeImportedJournalTrades(current, before, [row('deleted'), row('legacy'), row('new')]);
    expect(result.map(trade => trade.id)).toEqual(['legacy', 'new']);
    expect(result[0].copierTradeId).toBe('journal:legacy');
  });
  it('does not remove manual or newly inserted local rows when an import yields no confirmed results', () => {
    const manual = row('manual', { source: undefined, copierTradeId: undefined });
    const newlyInserted = row('new');
    expect(mergeImportedJournalTrades([manual, newlyInserted], [manual], [])).toEqual([manual, newlyInserted]);
  });
});
