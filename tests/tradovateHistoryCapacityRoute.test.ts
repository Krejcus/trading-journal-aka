import { sharedReadDb, OWNER, CONNECTION } from './helpers/tradovateSharedReadDb';
// 11. 11. 2026: čtení historie ověřuje vlastnictví účtu krátkým čtením (ne plným, které stálo
// 9 + 4× účty dotazů) a před čtením má poradní kontrolu kapacity jako preflight.
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ client: null as any }));
let localDb: Awaited<ReturnType<typeof sharedReadDb>>;
beforeAll(async () => { localDb = await sharedReadDb(); database.client = localDb.client(); }, 30_000);
afterAll(async () => { await localDb?.pg.close(); });
const state = vi.hoisted(() => ({ minute: 0 }));
const accountData = vi.hoisted(() => ({
  loadTradovateAccountData: vi.fn(async (_options: { detail?: string }) => ({ capturedAt: new Date().toISOString(), accounts: [{ id: 7, name: 'DEMO7' }], contracts: [], coverage: { accounts: { availability: 'available', count: 1 } } })),
}));
const report = vi.hoisted(() => ({ requestTradovatePerformanceReport: vi.fn(async () => ({ status: 'available' })) }));
vi.mock('../server/tradovateOAuthStore.js', () => ({
  readTradovateServerConfig: () => ({ environment: 'demo' }),
  requireSupabaseUserId: async () => OWNER,
  createTradovateAdminClient: () => ({
    rpc: async (name: string, args: any) => name === 'tradovate_shared_read_v1' ? database.client.rpc(name, args) : ({ data: { allowed: true, snapshot: { version: 1, brokerUserId: 42, serverNow: 1_000, epoch: 0, blockedUntil: null,
      captchaRequired: false, evidence: null, reason: null, backgroundReservedHour: 0, backgroundReservedMinute: state.minute,
      policyVersion: 2, riskReservedHour: 0, riskReservedMinute: 0, controlReservedHour: 0, controlReservedMinute: 0, totalReservedHour: 0 } }, error: null }),
  }),
  getValidTradovateAccessToken: async () => ({ accessToken: 'mock-only', brokerUserId: 42 }),
}));
vi.mock('../server/tradovateAccountData.js', async importOriginal => ({
  ...await importOriginal<typeof import('../server/tradovateAccountData')>(),
  ...accountData,
}));
vi.mock('../server/tradovateHistoricalReport.js', () => report);
vi.mock('../server/nativeCors.js', () => ({ handleNativeCors: () => false }));
import history from '../api/tradovate/oauth/history';

const call = async (body: Record<string, unknown>) => {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  await history({ method: 'POST', headers: {}, body } as never, res as never);
  return { status: res.status.mock.calls.at(-1)?.[0], body: res.json.mock.calls.at(-1)?.[0] };
};
const body = { connectionId: CONNECTION, accountId: 7, startDate: '11/01/2026', endDate: '11/10/2026' };

afterEach(async () => { await localDb.pg.exec('truncate public.tradovate_shared_reads'); vi.clearAllMocks(); state.minute = 0; });

describe('historie: krátké čtení účtů a poradní kontrola kapacity', () => {
  it('vlastnictví účtu se ověří krátkým čtením a report se vrátí', async () => {
    const result = await call(body);
    expect(result.status).toBe(200);
    expect(accountData.loadTradovateAccountData).toHaveBeenCalledTimes(1);
    expect(accountData.loadTradovateAccountData.mock.calls[0][0]).toMatchObject({ detail: 'bootstrap' });
    expect(report.requestTradovatePerformanceReport).toHaveBeenCalledTimes(1);
  });

  it('plná minuta odmítne předem: žádné čtení, typované odmítnutí rozpočtu', async () => {
    state.minute = 38;
    const result = await call(body);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: 'tradovate-request-budget', notDispatched: true, precheck: true });
    expect(accountData.loadTradovateAccountData).not.toHaveBeenCalled();
    expect(report.requestTradovatePerformanceReport).not.toHaveBeenCalled();
  });

  it('cizí účet se odmítne bez reportu', async () => {
    const result = await call({ ...body, accountId: 8 });
    expect(result.status).toBe(403);
    expect(report.requestTradovatePerformanceReport).not.toHaveBeenCalled();
  });
});
