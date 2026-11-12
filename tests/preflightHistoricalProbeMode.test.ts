import { sharedReadDb, OWNER, CONNECTION } from './helpers/tradovateSharedReadDb';
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ client: null as any }));
let db: Awaited<ReturnType<typeof sharedReadDb>>;
beforeAll(async () => { db = await sharedReadDb(); database.client = db.client(); }, 30_000);
afterAll(async () => { await db?.pg.close(); });
vi.mock('../server/tradovateServerRequestControl.js', async original => ({...await original<typeof import('../server/tradovateServerRequestControl')>(), assertTradovateBackgroundCapacity: async()=>{}}));
const probe = vi.hoisted(() => ({
  probeTradovateHistoricalSync: vi.fn(async () => ({ status: 'available' })),
  unavailableTradovateHistoricalSync: vi.fn(() => ({ status: 'unavailable' })),
  notCheckedTradovateHistoricalSync: vi.fn(() => ({ status: 'not-checked' })),
}));
const accountData = vi.hoisted(() => ({ loadTradovateAccountData: vi.fn(async () => ({ capturedAt: new Date().toISOString(), accounts: [], contracts: [], coverage: { accounts: { availability: 'empty', count: 0 } } })) }));
vi.mock('../server/tradovateOAuthStore.js', () => ({
  readTradovateServerConfig: () => ({ environment: 'demo' }),
  requireSupabaseUserId: async () => OWNER,
  createTradovateAdminClient: () => database.client,
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

afterEach(async () => { vi.clearAllMocks(); await db.pg.exec('truncate public.tradovate_shared_reads'); });

describe('preflight: probe historických reportů mimo kritickou cestu LIVE', () => {
  it('úplné čtení s historicalProbe=false nečeká na probe a vrátí „not-checked“', async () => {
    const body = await call({ connectionId: CONNECTION, mode: 'full', historicalProbe: false });
    expect(probe.probeTradovateHistoricalSync).not.toHaveBeenCalled();
    expect(accountData.loadTradovateAccountData).toHaveBeenCalledWith(expect.objectContaining({ detail: 'full' }));
    expect(body.historicalSync).toEqual({ status: 'not-checked' });
  });

  it('běžné úplné čtení probe dál obsahuje', async () => {
    const body = await call({ connectionId: CONNECTION, mode: 'full' });
    expect(probe.probeTradovateHistoricalSync).toHaveBeenCalledTimes(1);
    expect(body.historicalSync).toEqual({ status: 'available' });
  });

  it('samostatný probe nečte účty', async () => {
    const body = await call({ connectionId: CONNECTION, mode: 'historical-probe' });
    expect(accountData.loadTradovateAccountData).not.toHaveBeenCalled();
    expect(body).toEqual({ connectionId: CONNECTION, environment: 'demo', historicalSync: { status: 'available' } });
  });

  it('čtení bez probe převezme čerstvé úplné čtení s probe (jedna dávka na login)', async () => {
    await call({ connectionId: CONNECTION, mode: 'full' });
    const body = await call({ connectionId: CONNECTION, mode: 'full', historicalProbe: false });
    expect(accountData.loadTradovateAccountData).toHaveBeenCalledTimes(1);
    expect(body.historicalSync).toEqual({ status: 'available' });
  });

  it('doplnění probe použije společný účet bez druhého úplného čtení', async () => {
    await call({ connectionId: CONNECTION, mode: 'full', historicalProbe: false });
    const body = await call({ connectionId: CONNECTION, mode: 'full' });
    expect(accountData.loadTradovateAccountData).toHaveBeenCalledTimes(1);
    expect(body.historicalSync).toEqual({ status: 'available' });
  });

  it('běžící full s probe se nesdílí — studený start na probe nečeká', async () => {
    let release!: () => void;
    probe.probeTradovateHistoricalSync.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ status: 'available' }); }));
    const slow = call({ connectionId: CONNECTION, mode: 'full' });
    await Promise.resolve();
    const body = await call({ connectionId: CONNECTION, mode: 'full', historicalProbe: false });
    expect(body.historicalSync).toEqual({ status: 'not-checked' });
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    release();
    await slow;
  });
});
