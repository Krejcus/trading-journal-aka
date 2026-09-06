import { describe, expect, it, vi } from 'vitest';
import { confirmConnectionTradeNotes, hydrateLegacyTradeNotes, privateNotesFromSavedRow, readConnectionTradeNoteConsent, stripLegacyTradeNotes, tradeNotesStorageReady } from '../services/tradeLegacyNotes';

describe('server-authorized legacy note projection', () => {
  it('replaces cached/private-looking fields with only fields explicitly returned by the server', async () => {
    const rpc = vi.fn(async () => ({ data: { version: 1, rows: [{ tradeId: 'a', notes: { notes: 'approved', noteHistory: { secret: true }, unsafe: 'ignored' } }] }, error: null }));
    const rows = await hydrateLegacyTradeNotes({ rpc }, [{ id: 'a', notes: 'old', data: { notes: 'nested' } }, { id: 'b', notes: 'denied' }], 'connection', () => true);
    expect(rows).toEqual([{ id: 'a', notes: 'approved', data: {} }, { id: 'b' }]);
    expect(rpc).toHaveBeenCalledWith('get_trade_note_projection_v1', { p_trade_ids: ['a','b'], p_context: 'connection' });
  });
  it('preserves an explicit clear and never resurrects an older cached note', async () => {
    const rpc = vi.fn(async () => ({ data: { version: 1, rows: [{ tradeId: 'a', notes: { notes: null, sessionPreNotes: '' } }] }, error: null }));
    expect(await hydrateLegacyTradeNotes({ rpc }, [{ id: 'a', notes: 'old', sessionPreNotes: 'old' }], 'owner', () => true)).toEqual([{ id: 'a', notes: null, sessionPreNotes: '' }]);
  });
  it('allows old-server own notes but never trusts a foreign cached note without server support', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'PGRST202' } }));
    const rows = [{ id: 'a', notes: 'old', data: { sessionPostNotes: 'secret' } }];
    expect(await hydrateLegacyTradeNotes({ rpc }, rows, 'owner', () => true)).toEqual(rows);
    expect(await hydrateLegacyTradeNotes({ rpc }, rows, 'connection', () => true)).toEqual([{ id: 'a', data: {} }]);
  });
  it('fails a request that crosses an auth change and never returns its notes', async () => {
    const rpc = vi.fn(async () => ({ data: { version: 1, rows: [{ tradeId: 'a', notes: { notes: 'A secret' } }] }, error: null }));
    let calls = 0;
    await expect(hydrateLegacyTradeNotes({ rpc }, [{ id: 'a' }], 'owner', () => ++calls === 1)).rejects.toThrow('Účet');
  });
  it('does not fall back to old notes on a real transport failure or malformed response', async () => {
    await expect(hydrateLegacyTradeNotes({ rpc: async () => ({ error: { code: '500' } }) }, [{ id: 'a', notes: 'stale' }], 'owner', () => true)).rejects.toThrow('bezpečně');
    await expect(hydrateLegacyTradeNotes({ rpc: async () => ({ data: { version: 1, rows: [{ tradeId: 'a', notes: { notes: { object: 'legacy' } } }] } }) }, [{ id: 'a' }], 'owner', () => true)).rejects.toThrow('soukromém úložišti');
  });
  it('batches long exports and discards out-of-batch records', async () => {
    const rpc = vi.fn(async (_name: string, args: any) => ({ data: { version: 1, rows: [...args.p_trade_ids.map((id: string) => ({ tradeId: id, notes: { notes: id } })), { tradeId: 'unrequested', notes: { notes: 'secret' } }] } }));
    const result = await hydrateLegacyTradeNotes({ rpc }, Array.from({ length: 205 }, (_, i) => ({ id: String(i) })), 'owner', () => true);
    expect(rpc).toHaveBeenCalledTimes(3); expect(result).toHaveLength(205); expect(result[204]).toEqual({ id: '204', notes: '204' });
  });
  it('checks storage support before writes and reads the committed owner relation', async () => {
    expect(await tradeNotesStorageReady({ rpc: async () => ({ error: { code: 'PGRST202' } }) })).toBe(false);
    expect(await tradeNotesStorageReady({ rpc: async () => ({ data: { version: 1, rows: [] } }) })).toBe(true);
    await expect(tradeNotesStorageReady({ rpc: async () => ({ error: { code: '500' } }) })).rejects.toThrow('nebyly odeslány');
    expect(privateNotesFromSavedRow({ privateNotes: { notes: { notes: 'committed', sessionPostNotes: null, legacy_fragments: 'never' } } })).toEqual({ notes: 'committed', sessionPostNotes: null });
    expect(privateNotesFromSavedRow({ privateNotes: [{ notes: { notes: '' } }] })).toEqual({ notes: '' });
  });
});

describe('receiver note sharing confirmation', () => {
  it('passes the exact displayed permissions as CAS and accepts the request atomically', async () => {
    const rpc = vi.fn(async () => ({ data: { version: 1, confirmed: true, enabled: true } }));
    const permissions = { canSeeReviewNotes: true, allowedAccountIds: ['account'] };
    expect(await confirmConnectionTradeNotes({ rpc }, 'connection', permissions, true)).toMatchObject({ confirmed: true });
    expect(rpc).toHaveBeenCalledWith('confirm_connection_trade_notes_v1', { p_connection_id: 'connection', p_expected_permissions: permissions, p_accept: true });
  });
  it('checks the displayed permission snapshot when reading confirmation status', async () => {
    const rpc = vi.fn(async () => ({ data: { version: 1, confirmed: false, enabled: true } }));
    const permissions = { canSeeReviewNotes: true, allowedAccountIds: ['new-account'] };
    expect(await readConnectionTradeNoteConsent({ rpc }, 'c', permissions)).toMatchObject({ confirmed: false });
    expect(rpc).toHaveBeenCalledWith('get_connection_trade_note_consent_v1', { p_connection_id: 'c', p_expected_permissions: permissions });
  });
  it('surfaces missing activation and stale consent instead of sending a legacy fallback update', async () => {
    const rpc = vi.fn(async () => ({ error: { code: 'PGRST202' } }));
    await expect(confirmConnectionTradeNotes({ rpc }, 'c', {})).rejects.toThrow('není aktivovaná');
    expect(rpc).toHaveBeenCalledTimes(1);
    await expect(confirmConnectionTradeNotes({ rpc: async () => ({ error: { code: '40001' } }) }, 'c', {})).rejects.toThrow('jiné okno');
    await expect(readConnectionTradeNoteConsent({ rpc }, 'c')).rejects.toThrow('není aktivovaná');
  });
  it('recursive note stripping preserves the separate owner history for its own hydration layer', () => {
    expect(stripLegacyTradeNotes({ notes: 'secret', data: [{ sessionPostNotes: 'secret', tags: ['keep'] }], noteHistory: { version: 1 } })).toEqual({ data: [{ tags: ['keep'] }], noteHistory: { version: 1 } });
  });
});
