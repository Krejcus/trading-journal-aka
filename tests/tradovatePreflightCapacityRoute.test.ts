import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ minute: 0, hour: 0, blockedUntil: null as number | null, modes: [] as string[] }));
const accountData = vi.hoisted(() => ({
  loadTradovateAccountData: vi.fn(async (options: { beforeAccountReads?: (count: number) => Promise<void> }) => {
    await options.beforeAccountReads?.(4);
    return { accounts: [], contracts: [] };
  }),
}));
vi.mock('../server/tradovateOAuthStore.js', () => ({
  readTradovateServerConfig: () => ({ environment: 'demo' }),
  requireSupabaseUserId: async () => 'mock-user',
  createTradovateAdminClient: () => ({
    rpc: async (_name: string, args: { p_mode: string }) => {
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
vi.mock('../server/nativeCors.js', () => ({ handleNativeCors: () => false }));
import preflight, { resetTradovatePreflightCoalescingForTests } from '../api/tradovate/oauth/preflight';

const call = async (body: Record<string, unknown>) => {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  await preflight({ method: 'POST', headers: {}, body } as never, res as never);
  return { status: res.status.mock.calls.at(-1)?.[0], body: res.json.mock.calls.at(-1)?.[0] };
};

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); resetTradovatePreflightCoalescingForTests(); state.minute = 0; state.hour = 0; state.blockedUntil = null; state.modes = []; });

describe('preflight: poradní kontrola kapacity v trase', () => {
  it('plná minuta odmítne předem: žádné čtení účtů, typované odmítnutí rozpočtu', async () => {
    state.minute = 38;
    const result = await call({ connectionId: 'c1', mode: 'full', historicalProbe: false });
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'tradovate-request-budget', retryAfterMs: 20_000, notDispatched: true, captchaRequired: false, precheck: true });
    expect(accountData.loadTradovateAccountData).not.toHaveBeenCalled();
    expect(state.modes).toEqual(['read']);
  });

  it('odmítnutí se nepamatuje: po uvolnění další požadavek projde', async () => {
    state.minute = 38;
    expect((await call({ connectionId: 'c2', mode: 'full', historicalProbe: false })).status).toBe(503);
    state.minute = 0;
    expect((await call({ connectionId: 'c2', mode: 'full', historicalProbe: false })).status).toBe(200);
    expect(accountData.loadTradovateAccountData).toHaveBeenCalledTimes(1);
  });

  it('počet účtů z prvního čtení zpřísní první kontrolu příště', async () => {
    // 9 společných + 4 × 4 účty = 25: s 16 už rezervovanými se nevejde, i když samotných 9 ano.
    expect((await call({ connectionId: 'c3', mode: 'full', historicalProbe: false })).status).toBe(200);
    resetCoalescingOnly();
    state.minute = 16;
    accountData.loadTradovateAccountData.mockClear();
    expect((await call({ connectionId: 'c3', mode: 'full', historicalProbe: false })).status).toBe(503);
    expect(accountData.loadTradovateAccountData).not.toHaveBeenCalled();
  });

  it('kontrola před čteními po účtech odmítne, když se nevejdou (studená instance bez nápovědy)', async () => {
    state.minute = 30; // 9 společných se vejde, 16 na účty už ne
    const result = await call({ connectionId: 'c4', mode: 'full', historicalProbe: false });
    expect(accountData.loadTradovateAccountData).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(503);
    expect(result.body.error).toBe('tradovate-request-budget');
    // Společné seznamy už běžely: odmítnutí zdarma není, příznak se neposílá.
    expect(result.body.precheck).toBeUndefined();
  });

  it('cooldown nechává rozhodnout původní cestu: kontrola nemlží kódem rozpočtu', async () => {
    state.minute = 40; state.blockedUntil = 90_000;
    expect((await call({ connectionId: 'c5', mode: 'full', historicalProbe: false })).status).toBe(200);
    expect(accountData.loadTradovateAccountData).toHaveBeenCalledTimes(1);
  });

  it('samostatný probe kapacitu účtů nekontroluje', async () => {
    state.minute = 40;
    expect((await call({ connectionId: 'c6', mode: 'historical-probe' })).status).toBe(200);
    expect(state.modes).toEqual([]);
  });
});

/** Zapomene jen sdílené výsledky; nápověda počtu účtů má zůstat. */
function resetCoalescingOnly(): void { vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ['Date'] }); }
