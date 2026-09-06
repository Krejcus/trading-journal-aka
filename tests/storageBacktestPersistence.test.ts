import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trade } from '../types';
import { buildTradeNoteHistoryPatch } from '../services/tradeNoteHistory';
import { stripLegacyTradeNotes } from '../services/tradeLegacyNotes';

const h = vi.hoisted(() => ({
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  accountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  legacyNotesReady: false, legacyNotes: new Map<string, any>(), privateHistories: new Map<string, any>(), rows: new Map<string, any>(), cache: new Map<string, any>(),
  insertRace: null as any, selected: [] as string[], writes: [] as any[],
  tradeReadError: false, switchOwnerOnRead: false, updateError: null as any, skipUpdate: false, galleryError: null as any, rpcMissing: false, rpcCalls: 0, auth: null as null | ((event: string, session: any) => void),
}));
vi.mock('idb-keyval', () => ({ get: async (key: string) => h.cache.get(key), set: async (key: string, value: any) => { h.cache.set(key, value); } }));
vi.mock('../services/coachMemoryService', () => ({ maybeDetectEpisodes: async () => undefined }));
vi.mock('../services/embeddingService', () => ({ embedTrade: async () => undefined }));
vi.mock('../services/supabase', () => ({ supabase: {
  auth: { onAuthStateChange: (callback: typeof h.auth) => { h.auth = callback; }, getSession: async () => ({ data: { session: { user: { id: h.userId } } } }) },
  rpc: async (name: string, args: any) => {
    if (name === 'get_trade_note_projection_v1') return h.legacyNotesReady
      ? { data: { version: 1, rows: args.p_context === 'owner' ? args.p_trade_ids.filter((id: string) => h.rows.get(id)?.user_id === h.userId).map((id: string) => ({ tradeId: id, notes: h.legacyNotes.get(id) ?? {} })) : [] }, error: null }
      : { data: null, error: { code: 'PGRST202' } };
    if (name !== 'patch_backtest_trade_review') return { data: { trades: [...h.rows.values()], user: { id: h.userId } }, error: null };
    h.rpcCalls += 1;
    if (h.rpcMissing) return { data: null, error: { code: 'PGRST202' } };
    if (h.updateError) return { data: null, error: h.updateError };
    const current = h.rows.get(args.p_trade_id);
    if (h.skipUpdate || !current || current.user_id !== args.p_owner_id) return { data: null, error: null };
    const canonical = { ...current.data, ...(h.legacyNotesReady ? h.legacyNotes.get(current.id) : {}), drawings: current.drawings ?? current.data.drawings ?? [], isPublic: current.is_public };
    for (const key of Object.keys(args.p_updates)) {
      if (JSON.stringify(canonical[key]) !== JSON.stringify(args.p_expected[key]) && JSON.stringify(canonical[key]) !== JSON.stringify(args.p_updates[key])) return { data: null, error: { code: '40001' } };
    }
    const data = { ...current.data, ...(h.legacyNotesReady ? h.legacyNotes.get(current.id) : {}), ...args.p_updates, id: current.id, accountId: current.account_id, backtestRunId: current.backtest_run_id ?? current.data.backtestRunId };
    if (h.legacyNotesReady) h.legacyNotes.set(current.id, Object.fromEntries(Object.entries(data).filter(([key]) => ['notes','sessionPreNotes','sessionPostNotes'].includes(key))));
    h.rows.set(current.id, { ...current, data: h.legacyNotesReady ? stripLegacyTradeNotes(data) : data });
    return { data: { id: current.id, data }, error: null };
  },
  from: (table: string) => {
    const q = {
      op: 'select', payload: [] as any[], opts: undefined as any, projection: '', filters: [] as Array<[string, any]>, bounds: null as [number, number] | null,
      select(projection = '*') { this.projection = projection; h.selected.push(projection); return this; },
      eq(key: string, value: any) { this.filters.push([key, value]); return this; },
      in(key: string, values: any[]) { this.filters.push([key, values]); return this; },
      order() { return this; }, limit() { return this; }, range(lo: number, hi: number) { this.bounds = [lo, hi]; return this; },
      upsert(payload: any[], opts: any) { this.op = 'upsert'; this.payload = payload; this.opts = opts; return this; },
      update(payload: any) { this.op = 'update'; this.payload = payload; return this; },
      execute(single = false) {
        if (this.projection.includes('screenshot:data->>screenshot') && h.galleryError) return { data: null, error: h.galleryError };
        if (table === 'backtest_trade_note_histories') return { data: [...h.privateHistories.entries()].map(([trade_id, history]) => ({ trade_id, history, user_id: h.userId })).filter(row => this.filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value)), error: null };
        if (table === 'accounts') return { data: [{ id: h.accountId, name: 'Backtest' }], error: null };
        if (table === 'trades' && this.op === 'select' && h.tradeReadError) {
          if (h.switchOwnerOnRead) h.auth?.('SIGNED_IN', { user: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } });
          return { data: null, error: { message: 'mock offline' } };
        }
        if (this.op === 'upsert') {
          h.writes.push({ payload: this.payload, options: this.opts });
          if (h.insertRace) { h.rows.set(h.insertRace.id, h.insertRace); h.insertRace = null; }
          const data: any[] = [];
          for (const row of this.payload) {
            if (this.opts?.ignoreDuplicates && h.rows.has(row.id)) continue;
            if (h.legacyNotesReady) {
              const notes = Object.fromEntries(Object.entries(row.data).filter(([key]) => ['notes','sessionPreNotes','sessionPostNotes'].includes(key)));
              h.legacyNotes.set(row.id, { ...(h.legacyNotes.get(row.id) ?? {}), ...notes });
              const stored = { ...row, data: stripLegacyTradeNotes(row.data) };
              h.rows.set(row.id, structuredClone(stored)); data.push({ ...stored, privateNotes: { notes: h.legacyNotes.get(row.id) } });
            } else { h.rows.set(row.id, structuredClone(row)); data.push(row); }
          }
          return { data, error: null };
        }
        let data = [...h.rows.values()].filter(row => this.filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
        if (this.op === 'update') {
          if (h.updateError) return { data: null, error: h.updateError };
          if (h.skipUpdate) return { data: null, error: null };
          data = data.map(row => ({ ...row, ...this.payload }));
          data.forEach(row => h.rows.set(row.id, row));
        }
        if (this.bounds) data = data.slice(this.bounds[0], this.bounds[1] + 1);
        // PostgREST ->> projection puts JSON values into selected root aliases.
        if (this.projection.includes('excursionAmbiguous:data->>excursionAmbiguous')) data = data.map(row => ({ ...row, ...row.data }));
        return { data: single ? data[0] ?? null : data, error: null };
      },
      single() { return Promise.resolve(this.execute(true)); }, maybeSingle() { return Promise.resolve(this.execute(true)); },
      then(resolve: any, reject: any) { return Promise.resolve(this.execute()).then(resolve, reject); },
    }; return q;
  },
} }));

import { storageService } from '../services/storageService';
const trade = (): Trade => ({ id: crypto.randomUUID(), accountId: h.accountId, backtestRunId: crypto.randomUUID(), instrument: 'MNQ', pnl: 100, direction: 'Long', date: '2026-01-01T10:00:00.000Z', timestamp: Date.UTC(2026, 0, 1, 10), notes: 'generated', excursionAmbiguous: true } as Trade);
const row = (item: Trade) => ({ id: item.id, account_id: item.accountId, user_id: h.userId, instrument: item.instrument, pnl: item.pnl, direction: item.direction, date: item.date, timestamp: item.timestamp, data: { ...item }, drawings: [] });
beforeEach(() => {
  h.legacyNotesReady = false; h.legacyNotes.clear(); h.tradeReadError = false; h.switchOwnerOnRead = false; h.privateHistories.clear(); h.rows.clear(); h.cache.clear(); h.insertRace = null; h.selected = []; h.writes = [];
  h.galleryError = null; h.updateError = null; h.skipUpdate = false; h.rpcMissing = false; h.rpcCalls = 0;
  h.auth?.('SIGNED_IN', { user: { id: h.userId } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});

describe('backtest insert-only journal persistence', () => {
  it('does not overwrite a previously reviewed row', async () => {
    const item = trade(); h.rows.set(String(item.id), row({ ...item, notes: 'user review', screenshots: ['https://example.test/review.png'] }));
    expect(await storageService.saveTrades([item], { insertOnly: true })).toEqual([]);
    expect(h.rows.get(String(item.id)).data.notes).toBe('user review');
    expect(h.writes).toEqual([]);
  });

  it('uses server insert-only conflict handling when a second tab wins after the lookup', async () => {
    const item = trade(); h.insertRace = row({ ...item, notes: 'concurrent review' });
    expect(await storageService.saveTrades([item], { insertOnly: true })).toEqual([]);
    expect(h.writes[0].options).toEqual({ onConflict: 'id', ignoreDuplicates: true });
    expect(h.rows.get(String(item.id)).data.notes).toBe('concurrent review');
  });

  it('returns new server-confirmed rows and preserves standard editing behavior', async () => {
    const item = trade();
    const saved = await storageService.saveTrades([item], { insertOnly: true });
    expect(saved).toHaveLength(1); expect(saved[0].id).toBe(item.id);
    await storageService.saveTrades([{ ...item, notes: 'intentional edit' }]);
    expect(h.rows.get(String(item.id)).data.notes).toBe('intentional edit');
    expect(h.writes[1].options).toBeUndefined();
  });
});

describe('backtest excursion ambiguity read parity', () => {
  it('retains the flag through dashboard RPC, projected list and full detail reads', async () => {
    const item = trade(); h.rows.set(String(item.id), row(item));
    expect((await storageService.getDashboardData()).trades[0].excursionAmbiguous).toBe(true);
    expect((await storageService.getTrades())[0].excursionAmbiguous).toBe(true);
    expect((await storageService.getTradeById(String(item.id)))?.excursionAmbiguous).toBe(true);
    expect(h.selected.some(projection => projection.includes('excursionAmbiguous:data->>excursionAmbiguous'))).toBe(true);
  });
});

describe('backtest review persistence', () => {
  it('roundtrips full notes, manual tags and generated provenance through every read path', async () => {
    const item = trade(); h.rows.set(String(item.id), row(item));
    const updates = { notes: 'A'.repeat(2000) + 'Důvod uvedený až v dodatečném review.', tags: ['Moje pravidlo'], htfConfluence: ['u PDH', 'u mé rezistence'], autoConfluence: { htf: ['u PDH'], ltf: [] } };
    await storageService.updateTrade(item.id, updates);
    expect((await storageService.getDashboardData()).trades[0]).toMatchObject(updates);
    expect((await storageService.getTrades())[0]).toMatchObject(updates);
    expect(await storageService.getTradeById(String(item.id))).toMatchObject(updates);
    expect(h.selected.some(projection => projection.includes('autoConfluence:data->autoConfluence'))).toBe(true);
  });

  it('rejects a zero-row update instead of claiming the review was saved', async () => {
    const item = trade(); h.rows.set(String(item.id), row(item)); h.skipUpdate = true;
    await expect(storageService.updateTrade(item.id, { notes: 'unsaved' })).rejects.toThrow('nebylo potvrzeno');
    expect(h.rows.get(String(item.id)).data.notes).toBe('generated');
    expect(h.cache.size).toBe(0);
  });

  it('leaves notes intact when the server rejects the update', async () => {
    const item = trade(); h.rows.set(String(item.id), row(item)); h.updateError = new Error('offline');
    await expect(storageService.updateTrade(item.id, { notes: 'unsaved' })).rejects.toThrow('offline');
    expect(h.rows.get(String(item.id)).data.notes).toBe('generated');
  });
});


describe('gallery prerequisite failure vs empty', () => {
  it('throws on failed SELECT instead of representing failure as an empty gallery', async () => {
    h.galleryError = { message: 'gallery transport unavailable' };
    await expect(storageService.getTradeScreenshots(['missing'])).rejects.toThrow('gallery transport unavailable');
    h.galleryError = null;
    expect((await storageService.getTradeScreenshots(['missing'])).size).toBe(0);
  });
});


describe('backtest activation and owner scope', () => {
  it('leaves unrelated live updateTrade paths usable when the new RPC is absent', async () => {
    const item = trade(); delete item.backtestRunId; h.rows.set(String(item.id), row(item)); h.rpcMissing = true;
    await storageService.updateTrade(item.id, { notes: 'live edit' });
    expect(h.rpcCalls).toBe(0);
    expect(h.rows.get(String(item.id)).data.notes).toBe('live edit');
  });
  it('dispatches backtest drawing saves through the atomic patch and keeps notes', async () => {
    const item = trade(); item.notes = 'review to preserve'; h.rows.set(String(item.id), row(item));
    await storageService.updateTradeDrawings(item.id, [{ id: 'drawing-1' }]);
    expect(h.rpcCalls).toBe(1);
    expect(h.rows.get(String(item.id)).data.notes).toBe('review to preserve');
    expect(h.rows.get(String(item.id)).data.drawings).toEqual([{ id: 'drawing-1' }]);
  });
  it('returns authoritative identity in a fresh prepared snapshot', async () => {
    const item = trade(); h.rows.set(String(item.id), { ...row(item), data: { ...item, id: 'wrong', accountId: 'wrong' } });
    const snapshot = await storageService.prepareBacktestTradeReview(item.id);
    expect(snapshot.data.id).toBe(item.id); expect(snapshot.data.accountId).toBe(item.accountId); expect(snapshot.data.backtestRunId).toBe(item.backtestRunId);
  });
  it('stops a backtest edit when the atomic database capability is missing', async () => {
    const item = trade(); h.rows.set(String(item.id), row(item)); h.rpcMissing = true;
    await expect(storageService.updateTrade(item.id, { notes: 'draft' })).rejects.toThrow('není aktivované');
    expect(h.rows.get(String(item.id)).data.notes).toBe('generated');
  });
  it('does not send an old-owner prepared review after sign out', async () => {
    const item = trade(); h.rows.set(String(item.id), row(item));
    const snapshot = await storageService.prepareBacktestTradeReview(item.id);
    h.auth?.('SIGNED_OUT', null);
    const before = h.rpcCalls;
    await expect(storageService.updateBacktestTradeReview(item.id, { notes: 'draft' }, snapshot)).rejects.toThrow('Účet');
    expect(h.rpcCalls).toBe(before);
    expect(h.rows.get(String(item.id)).data.notes).toBe('generated');
  });
  it('passes the editor baseline and rejects a stale note even if the fresh save read sees the newer value', async () => {
    const item = trade(); item.notes = 'changed remotely'; h.rows.set(String(item.id), row(item));
    await expect(storageService.updateTrade(item.id, { notes: 'my draft' }, { notes: 'editor baseline' })).rejects.toThrow('jiné okno');
    expect(h.rows.get(String(item.id)).data.notes).toBe('changed remotely');
  });
});


describe('backtest screenshot maintenance is also atomic', () => {
  it('preserves a note changed during an image upload', async () => {
    const item = trade(); item.screenshot = 'data:image/png;base64,mock'; h.rows.set(String(item.id), row(item));
    const upload = vi.spyOn(storageService, 'uploadScreenshot').mockImplementation(async () => {
      const current = h.rows.get(String(item.id)); current.data.notes = 'new note during upload';
      return 'https://cdn/uploaded.jpg';
    });
    const result = await storageService.migrateScreenshotsToStorage();
    expect(result.migrated).toBe(1); expect(result.failed).toBe(0);
    expect(h.rows.get(String(item.id)).data.notes).toBe('new note during upload');
    expect(h.rows.get(String(item.id)).data.screenshot).toBe('https://cdn/uploaded.jpg');
    expect(upload).toHaveBeenCalledWith(item.screenshot, item.id, h.userId);
  });
  it('does not upload a backtest image if the database patch is not activated', async () => {
    const item = trade(); item.screenshot = 'data:image/png;base64,mock'; h.rows.set(String(item.id), row(item)); h.rpcMissing = true;
    const upload = vi.spyOn(storageService, 'uploadScreenshot').mockResolvedValue('https://cdn/new.jpg');
    upload.mockClear();
    const result = await storageService.migrateScreenshotsToStorage();
    expect(result.failed).toBe(1); expect(upload).not.toHaveBeenCalled();
    expect(h.rows.get(String(item.id)).data.screenshot).toBe(item.screenshot);
  });
});


describe('private history ordinary write guard', () => {
  const ledger = () => buildTradeNoteHistoryPatch({ before: 'Private plan', during: '', after: '' }, undefined,
    { marketTime: 60, maxRevealedMarketTime: 60, entryMarketTime: 120, closedTradeReview: false },
    { operationId: 'private1', clientCapturedAt: 1000 }).history;
  it('rejects new imported history before any trade write, including legacy nested snapshots', async () => {
    for (const item of [{ ...trade(), noteHistory: ledger() }, { ...trade(), data: { noteHistory: ledger() } } as Trade]) {
      await expect(storageService.saveTrades([item])).rejects.toThrow('Import nového obchodu');
    }
    expect(h.writes).toEqual([]); expect(h.rows.size).toBe(0);
  });
  it('never exposes another account ledger from dashboard cache or a late failed list request', async () => {
    const item = { ...trade(), noteHistory: ledger() };
    h.cache.set(`alphatrade_trades_${h.userId}`, [item]);
    h.cache.set(`alphatrade_user_profile_${h.userId}`, { id: h.userId });
    h.auth?.('SIGNED_IN', { user: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } });
    expect((await storageService.getCachedDashboardData(h.userId))?.trades[0]).not.toHaveProperty('noteHistory');
    h.auth?.('SIGNED_IN', { user: { id: h.userId } });
    h.tradeReadError = true; h.switchOwnerOnRead = true;
    expect((await storageService.getTrades())[0]).not.toHaveProperty('noteHistory');
  });
  it('bulk saves keep confirmed private history out of the public blob and return the private value', async () => {
    const item = trade(); const history = ledger();
    h.rows.set(String(item.id), row(item)); h.privateHistories.set(String(item.id), history);
    const staleDraft = { ...history, revision: 999 };
    const [saved] = await storageService.saveTrades([{ ...item, noteHistory: staleDraft, notes: 'ordinary edit' }]);
    expect(h.rows.get(String(item.id)).data).not.toHaveProperty('noteHistory');
    expect(saved.noteHistory).toEqual(history);
    expect((await storageService.getTradeById(String(item.id)))?.noteHistory).toEqual(history);
    expect((await storageService.getTrades())[0].noteHistory).toEqual(history);
    expect((await storageService.getTradesWithDataByAccounts([h.accountId]))[0].noteHistory).toEqual(history);
  });
});


describe('activated legacy private note storage', () => {
  it('returns committed private notes from insert and hydrates owner reads/export after raw fields disappear', async () => {
    h.legacyNotesReady = true;
    const item = { ...trade(), notes: 'private saved', sessionPreNotes: 'private before' };
    const [saved] = await storageService.saveTrades([item]);
    expect(saved.notes).toBe('private saved');
    expect(h.rows.get(String(item.id)).data).not.toHaveProperty('notes');
    expect(h.selected).toContain('*, privateNotes:trade_private_notes(notes)');
    expect((await storageService.getTrades())[0].notes).toBe('private saved');
    expect((await storageService.getTradeById(String(item.id)))?.notes).toBe('private saved');
    expect((await storageService.getTradesWithDataByAccounts([h.accountId]))[0].sessionPreNotes).toBe('private before');
    await storageService.updateTrade(item.id, { notes: 'private edited' });
    expect(h.rows.get(String(item.id)).data).not.toHaveProperty('notes');
    expect(h.legacyNotes.get(String(item.id)).notes).toBe('private edited');
  });
});
