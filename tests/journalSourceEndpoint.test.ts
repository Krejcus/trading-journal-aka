import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
const mocked = vi.hoisted(() => ({ owner: vi.fn(), rpc: vi.fn(), abort: vi.fn(), config: { environment: 'demo' } }));
vi.mock('../server/tradovateOAuthStore', () => ({
  createTradovateAdminClient: () => ({ rpc: mocked.rpc }), readTradovateServerConfig: () => mocked.config, requireSupabaseUserId: mocked.owner,
}));
vi.mock('../server/nativeCors', () => ({ handleNativeCors: () => false }));
import handler from '../api/tradovate/oauth/journal-sources';
const owner = '11111111-1111-4111-8111-111111111111';
const connection = '33333333-3333-4333-8333-333333333333';
const call = async (body: unknown, method = 'POST') => {
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn() };
  await handler({ method, body, headers: { authorization: 'Bearer fictional' } } as VercelRequest, response as unknown as VercelResponse);
  return response;
};
beforeEach(() => {
  vi.clearAllMocks(); mocked.owner.mockResolvedValue(owner);
  mocked.rpc.mockReturnValue({ abortSignal: mocked.abort });
  mocked.abort.mockResolvedValue({ data: { connections: [] }, error: null });
});
describe('source availability authentication boundary', () => {
  it('passes only the verified user and bounded selectors to the read RPC', async () => {
    const result = await call({ connectionIds: [connection] });
    expect(result.status).toHaveBeenCalledWith(200);
    expect(result.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(mocked.owner).toHaveBeenCalledWith('Bearer fictional', mocked.config);
    expect(mocked.rpc).toHaveBeenCalledWith('read_journal_source_status', { p_user_id: owner, p_connection_ids: [connection] });
    expect(mocked.abort.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });
  it('rejects supplied identity, extra fields, invalid ids and oversized batches before reading', async () => {
    for (const body of [{ connectionIds: [connection], userId: owner }, { connectionIds: [connection], pnl: 1 },
      { connectionIds: [] }, { connectionIds: [connection, connection] }, { connectionIds: ['invalid'] },
      { connectionIds: Array.from({ length: 26 }, () => connection) }, null]) {
      expect((await call(body)).status).toHaveBeenCalledWith(400);
    }
    expect(mocked.rpc).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated calls and unsupported methods', async () => {
    mocked.owner.mockRejectedValue(new Error('invalid-auth-token'));
    expect((await call({ connectionIds: [connection] })).status).toHaveBeenCalledWith(401);
    expect((await call({}, 'DELETE')).status).toHaveBeenCalledWith(405);
    expect(mocked.rpc).not.toHaveBeenCalled();
  });
  it('returns generic scope and read failures without server details', async () => {
    mocked.abort.mockResolvedValue({ data: null, error: { code: '42501', message: 'private-details' } });
    expect((await call({ connectionIds: [connection] })).status).toHaveBeenCalledWith(404);
    mocked.abort.mockRejectedValue(new Error('private-details'));
    const result = await call({ connectionIds: [connection] });
    expect(result.status).toHaveBeenCalledWith(502);
    expect(result.json).toHaveBeenCalledWith({ error: 'journal-source-unavailable' });
  });
});
