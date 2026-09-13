import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Trade } from '../types';
import { hydrateJournalSnapshots } from '../services/journalSnapshotHydration';

const owner = '11111111-1111-4111-8111-111111111111';
const episode = '22222222-2222-4222-8222-222222222222';
const trade = { id: '33333333-3333-4333-8333-333333333333', accountId: 'account', pnl: 19,
  copierTradeId: 'journal:position', notes: 'Keep review', screenshots: ['manual'],
  copierSnapshots: [{ kind: 'entry', at: 1, path: 'stale' }] } as Trade;
function row(index: number, overrides = {}) {
  const id = `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`;
  const at = 1_000 + index;
  return { page_key: `${trade.id}:${id}`, user_id: owner, trade_id: trade.id, journal_account_id: trade.accountId,
    snapshot_id: id, episode_id: episode, kind: 'entry', at: new Date(at).toISOString(),
    storage_path: `${owner}/${episode}/entry-${at}.png`, ...overrides };
}
function fixture(pages: Array<unknown[] | Error>, trades = [trade]) {
  const calls: Array<Record<string, unknown>> = [];
  const active = vi.fn(async () => {});
  const db = { from: (table: string) => {
    const call: Record<string, unknown> = { table }; calls.push(call);
    const q = { select: () => q, eq: (key: string, value: unknown) => { call[key] = value; return q; },
      in: (key: string, value: unknown) => { call[key] = value; return q; },
      gt: (key: string, value: unknown) => { call[key] = value; return q; }, order: () => q, limit: () => q,
      abortSignal: async () => {
        if (!pages.length) throw new Error('Unexpected page request');
        const page = pages.shift();
        return page instanceof Error ? { error: page, data: null } : { data: page, error: null };
      } };
    return q;
  } } as unknown as SupabaseClient;
  return { calls, active, read: () => hydrateJournalSnapshots(db, trades, owner, active, () => new AbortController().signal) };
}
describe('journal media enrichment', () => {
  it('reads through lower page caps, preserves review and does not copy media to other accounts', async () => {
    const follower = { ...trade, id: 'follower', accountId: 'second' };
    const f = fixture([[row(1)], [row(2)], []], [trade, follower]);
    const result = await f.read();
    expect(result[0]).toMatchObject({ pnl: 19, notes: 'Keep review', screenshots: ['manual'], copierEpisodeId: episode, copierSnapshotLoadError: false });
    expect(result[0].copierSnapshots).toHaveLength(2);
    expect(result[1].copierSnapshots).toEqual([]);
    expect(f.calls.map(c => c.page_key)).toEqual(['', row(1).page_key, row(2).page_key]);
    expect(f.calls.every(c => c.user_id === owner)).toBe(true);
  });
  it('clears obsolete automatic links when metadata is absent without changing manual media', async () => {
    const [result] = await fixture([[]]).read();
    expect(result.copierSnapshots).toEqual([]);
    expect(result.copierEpisodeId).toBeUndefined();
    expect(result.screenshots).toEqual(['manual']);
    expect(result.copierSnapshotLoadError).toBe(false);
  });
  it('does not expose a partial media page or stale images when the next request fails', async () => {
    const [result] = await fixture([[row(1)], new Error('offline')]).read();
    expect(result).toMatchObject({ pnl: 19, notes: 'Keep review', copierSnapshots: [], copierSnapshotLoadError: true });
  });
  it('rejects foreign account/owner, unsafe paths, wrong episode and duplicate keys', async () => {
    for (const bad of [{ user_id: 'other' }, { journal_account_id: 'other' }, { storage_path: 'https://external/image.png' },
      { kind: 'tv-alert' }, { episode_id: 'bad' }, { at: 'invalid' }]) {
      expect((await fixture([[row(1, bad)]]).read())[0].copierSnapshotLoadError).toBe(true);
    }
    expect((await fixture([[row(1)], [row(1)]]).read())[0].copierSnapshotLoadError).toBe(true);
  });
  it('does not swallow logout or cancellation into a harmless media error', async () => {
    const f = fixture([[row(1)]]);
    f.active.mockRejectedValue(new Error('journal-session-changed'));
    await expect(f.read()).rejects.toThrow('session-changed');
  });
  it('keeps manually created trades outside the broker media reader', async () => {
    const manual = { ...trade, copierTradeId: undefined };
    const f = fixture([], [manual]);
    expect(await f.read()).toEqual([manual]); expect(f.calls).toEqual([]);
  });
});
