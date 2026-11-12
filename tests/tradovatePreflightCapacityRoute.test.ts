import { sharedReadDb, OWNER, CONNECTION } from './helpers/tradovateSharedReadDb';
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ client: null as any }));
let localDb: Awaited<ReturnType<typeof sharedReadDb>>;
beforeAll(async () => { localDb = await sharedReadDb(); database.client = localDb.client(); }, 30_000);
afterAll(async () => { await localDb?.pg.close(); });
const state = vi.hoisted(() => ({ minute: 0, hour: 0, blockedUntil: null as number | null, modes: [] as string[] }));
const accountData = vi.hoisted(() => ({
  loadTradovateAccountData: vi.fn(async (options: { beforeAccountReads?: (count: number) => Promise<void> }) => {
    await options.beforeAccountReads?.(4);
    return { capturedAt: new Date().toISOString(), accounts: Array.from({ length: 4 }, (_, id) => ({ id, balance: { coverage: { availability: 'available', count: 1 } }, risk: { statusCoverage: { availability: 'empty', count: 0 }, limitsCoverage: { availability: 'empty', count: 0 } } })), contracts: [], coverage: { accounts: { availability: 'available', count: 4 } } };
  }),
}));
vi.mock('../server/tradovateOAuthStore.js', () => ({
  readTradovateServerConfig: () => ({ environment: 'demo' }),
  requireSupabaseUserId: async () => OWNER,
  createTradovateAdminClient: () => ({
    rpc: async (_name: string, args: { p_mode: string }) => {
      if (_name === 'tradovate_shared_read_v1') return database.client.rpc(_name, args);
      state.modes.push(args.p_mode);
      return { data: { allowed: true, snapshot: { version: 1, brokerUserId: 42, serverNow: 1_000, epoch: 0, blockedUntil: state.blockedUntil,
        captchaRequired: false, evidence: null, reason: null, backgroundReservedHour: state.hour, backgroundReservedMinute: state.minute,
        policyVersion: 2, riskReservedHour: 0, riskReservedMinute: 0, controlReservedHour: 0, controlReservedMinute: 0, totalReservedHour: state.hour } }, error: null };
    },
  }),
  getValidTradovateAccessToken: async () => ({ accessToken: 'mock-only', brokerUserId: 42 }),
}));
vi.mock('../server/tradovateHistoricalProbe.js', () => ({
  probeTradovateHistoricalSync: vi.fn(async () => ({ status: 'available' })),
  unavailableTradovateHistoricalSync: vi.fn(() => ({ status: 'unavailable' })),
  notCheckedTradovateHistoricalSync: vi.fn(() => ({ status: 'not-checked' })),
}));
vi.mock('../server/tradovateAccountData.js', async importOriginal => ({
  ...await importOriginal<typeof import('../server/tradovateAccountData')>(),
  ...accountData,
}));
vi.mock('../server/tradovateSharedWorkerRead.js', () => ({ readWorkerSharedTick: async () => null }));
vi.mock('../server/tradovateLivePnl.js', async original => {
  const actual = await original<typeof import('../server/tradovateLivePnl')>();
  const { TradovateRequestControlError } = await import('../server/tradovateServerRequestControl');
  return { ...actual, loadTradovateLivePnlTick: async () => { throw new TradovateRequestControlError('tradovate-request-budget', 20_000); } };
});
vi.mock('../server/nativeCors.js', () => ({ handleNativeCors: () => false }));
import preflight, { resetTradovatePreflightCoalescingForTests } from '../api/tradovate/oauth/preflight';

const call = async (body: Record<string, unknown>) => {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  await preflight({ method: 'POST', headers: {}, body } as never, res as never);
  return { status: res.status.mock.calls.at(-1)?.[0], body: res.json.mock.calls.at(-1)?.[0] };
};

afterEach(async () => { await localDb.pg.exec('truncate public.tradovate_shared_reads'); vi.useRealTimers(); vi.clearAllMocks(); resetTradovatePreflightCoalescingForTests(); state.minute = 0; state.hour = 0; state.blockedUntil = null; state.modes = []; });

describe('preflight: poradní kontrola kapacity v trase', () => {
  it('plná minuta odmítne předem: žádné čtení účtů, typované odmítnutí rozpočtu', async () => {
    state.minute = 38;
    const result = await call({ connectionId: CONNECTION, mode: 'full', historicalProbe: false });
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'tradovate-request-budget', retryAfterMs: 20_000, notDispatched: true, captchaRequired: false, precheck: true });
    expect(accountData.loadTradovateAccountData).not.toHaveBeenCalled();
    expect(state.modes).toEqual(['read']);
  });

  it('po sdíleném odkladu a uvolnění kapacity další požadavek projde', async () => {
    state.minute = 38;
    expect((await call({ connectionId: CONNECTION, mode: 'full', historicalProbe: false })).status).toBe(503);
    state.minute = 0;
    await localDb.pg.exec("update public.tradovate_shared_reads set retry_at='-infinity'");
    expect((await call({ connectionId: CONNECTION, mode: 'full', historicalProbe: false })).status).toBe(200);
    expect(accountData.loadTradovateAccountData).toHaveBeenCalledTimes(1);
  });

  it('počet účtů z prvního čtení zpřísní první kontrolu příště', async () => {
    // 9 společných + 4 × 4 účty = 25: s 16 už rezervovanými se nevejde, i když samotných 9 ano.
    expect((await call({ connectionId: CONNECTION, mode: 'full', historicalProbe: false })).status).toBe(200);
    await localDb.pg.exec("update public.tradovate_shared_reads set fresh_until='-infinity'");
    state.minute = 16;
    accountData.loadTradovateAccountData.mockClear();
    const retained = await call({ connectionId: CONNECTION, mode: 'full', historicalProbe: false });
    expect(retained.status).toBe(200);
    expect(retained.body.sharedRead.refreshPending).toBe(true);
    expect(accountData.loadTradovateAccountData).not.toHaveBeenCalled();
  });

  it('kontrola před čteními po účtech odmítne, když se nevejdou (studená instance bez nápovědy)', async () => {
    state.minute = 30; // 9 společných se vejde, 16 na účty už ne
    const result = await call({ connectionId: CONNECTION, mode: 'full', historicalProbe: false });
    expect(accountData.loadTradovateAccountData).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(503);
    expect(result.body.error).toBe('tradovate-request-budget');
    // Společné seznamy už běžely: odmítnutí zdarma není, příznak se neposílá.
    expect(result.body.precheck).toBeUndefined();
  });

  it('cooldown nechává rozhodnout původní cestu: kontrola nemlží kódem rozpočtu', async () => {
    state.minute = 40; state.blockedUntil = 90_000;
    expect((await call({ connectionId: CONNECTION, mode: 'full', historicalProbe: false })).status).toBe(200);
    expect(accountData.loadTradovateAccountData).toHaveBeenCalledTimes(1);
  });

  it('samostatný probe kapacitu účtů nekontroluje', async () => {
    state.minute = 40;
    expect((await call({ connectionId: CONNECTION, mode: 'historical-probe' })).status).toBe(200);
    expect(state.modes).toEqual([]);
  });
});
