import { afterEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  probeTradovateHistoricalSync: vi.fn(async () => ({ status: 'available' })),
  unavailableTradovateHistoricalSync: vi.fn(() => ({ status: 'unavailable' })),
  notCheckedTradovateHistoricalSync: vi.fn(() => ({ status: 'not-checked' })),
}));
const accountData = vi.hoisted(() => ({ loadTradovateAccountData: vi.fn(async () => ({ accounts: [], contracts: [] })) }));
vi.mock('../server/tradovateOAuthStore.js', () => ({
  readTradovateServerConfig: () => ({ environment: 'demo' }),
  requireSupabaseUserId: async () => 'mock-user',
  createTradovateAdminClient: () => ({}),
  getValidTradovateAccessToken: async () => ({ accessToken: 'mock-only' }),
}));
vi.mock('../server/tradovateHistoricalProbe.js', () => probe);
vi.mock('../server/tradovateAccountData.js', async importOriginal => ({
  ...await importOriginal<typeof import('../server/tradovateAccountData')>(),
  ...accountData,
}));
vi.mock('../server/nativeCors.js', () => ({ handleNativeCors: () => false }));
import preflight from '../api/tradovate/oauth/preflight';

const response = () => {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};
const call = async (body: Record<string, unknown>) => {
  const res = response();
  await preflight({ method: 'POST', headers: {}, body } as never, res as never);
  return res.json.mock.calls.at(-1)?.[0];
};

afterEach(() => vi.clearAllMocks());

describe('preflight: probe historických reportů mimo kritickou cestu LIVE', () => {
  it('úplné čtení s historicalProbe=false nečeká na probe a vrátí „not-checked“', async () => {
    const body = await call({ connectionId: 'skip-probe', mode: 'full', historicalProbe: false });
    expect(probe.probeTradovateHistoricalSync).not.toHaveBeenCalled();
    expect(accountData.loadTradovateAccountData).toHaveBeenCalledWith(expect.objectContaining({ detail: 'full' }));
    expect(body.historicalSync).toEqual({ status: 'not-checked' });
  });

  it('běžné úplné čtení probe dál obsahuje', async () => {
    const body = await call({ connectionId: 'with-probe', mode: 'full' });
    expect(probe.probeTradovateHistoricalSync).toHaveBeenCalledTimes(1);
    expect(body.historicalSync).toEqual({ status: 'available' });
  });

  it('samostatný probe nečte účty', async () => {
    const body = await call({ connectionId: 'probe-only', mode: 'historical-probe' });
    expect(accountData.loadTradovateAccountData).not.toHaveBeenCalled();
    expect(body).toEqual({ connectionId: 'probe-only', environment: 'demo', historicalSync: { status: 'available' } });
  });

  it('čtení bez probe převezme čerstvé úplné čtení s probe (jedna dávka na login)', async () => {
    await call({ connectionId: 'shared', mode: 'full' });
    const body = await call({ connectionId: 'shared', mode: 'full', historicalProbe: false });
    expect(accountData.loadTradovateAccountData).toHaveBeenCalledTimes(1);
    expect(body.historicalSync).toEqual({ status: 'available' });
  });

  it('úplné čtení s probe nikdy nepřevezme výsledek bez probe', async () => {
    await call({ connectionId: 'one-way', mode: 'full', historicalProbe: false });
    const body = await call({ connectionId: 'one-way', mode: 'full' });
    expect(accountData.loadTradovateAccountData).toHaveBeenCalledTimes(2);
    expect(body.historicalSync).toEqual({ status: 'available' });
  });
});
