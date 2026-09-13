import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
const mocked = vi.hoisted(() => ({ owner: vi.fn(), import: vi.fn(), config: { environment: 'demo' }, db: {} }));
vi.mock('../server/tradovateOAuthStore', () => ({
  createTradovateAdminClient: () => mocked.db, readTradovateServerConfig: () => mocked.config, requireSupabaseUserId: mocked.owner,
}));
vi.mock('../server/journalPositionImport', () => ({ importJournalPositions: mocked.import }));
vi.mock('../server/nativeCors', () => ({ handleNativeCors: () => false }));
import handler from '../api/tradovate/oauth/journal-import';

const call = async (body: unknown, method = 'POST') => {
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn() };
  await handler({ method, body, headers: { authorization: 'Bearer test-only' } } as VercelRequest, response as unknown as VercelResponse);
  return response;
};
beforeEach(() => { vi.clearAllMocks(); mocked.owner.mockResolvedValue('authenticated-owner'); mocked.config.environment = 'demo';
  mocked.import.mockResolvedValue({ accepted: true, through: 42, confirmed: 12, pending: 0, unassigned: 0 }); });
describe('journal import request trust boundary', () => {
  it('reports unresolved legacy identity as a conflict, without accepting a partial import', async () => {
    mocked.import.mockRejectedValue(new Error('journal-legacy-reference-ambiguous'));
    const response = await call({ connectionId: 'selected' });
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({ error: 'journal-legacy-reference-ambiguous' });
  });
  it('takes identity from authentication and accepts only a connection selector', async () => {
    const response = await call({ connectionId: 'selected' });
    expect(mocked.import).toHaveBeenCalledWith(mocked.db, { ownerId: 'authenticated-owner', connectionId: 'selected', environment: 'demo' });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
  it('rejects caller-supplied PnL, user identity and financial projection', async () => {
    for (const extra of [{ pnl: 1000 }, { ownerId: 'other' }, { positions: [] }]) {
      expect((await call({ connectionId: 'selected', ...extra })).status).toHaveBeenCalledWith(400);
    }
    expect(mocked.import).not.toHaveBeenCalled();
  });
  it('rejects missing authentication, non-POST and unsupported broker environment before import', async () => {
    mocked.owner.mockRejectedValue(new Error('missing-auth-token'));
    expect((await call({ connectionId: 'selected' })).status).toHaveBeenCalledWith(401);
    expect((await call({}, 'GET')).status).toHaveBeenCalledWith(405);
    mocked.config.environment = 'live';
    expect((await call({ connectionId: 'selected' })).status).toHaveBeenCalledWith(409);
    expect(mocked.import).not.toHaveBeenCalled();
  });
});
