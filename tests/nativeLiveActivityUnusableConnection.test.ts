import { beforeEach, describe, expect, it, vi } from 'vitest';

const tokenState = vi.hoisted(() => ({ failing: new Set<string>(), calls: [] as string[] }));
vi.mock('../server/tradovateOAuthStore', async importOriginal => ({
  ...(await importOriginal<typeof import('../server/tradovateOAuthStore')>()),
  listConnectedTradovateConnectionIds: async () => ['lucid', 'broken'],
  getValidTradovateAccessToken: async ({ connectionId }: { connectionId: string }) => {
    tokenState.calls.push(connectionId);
    if (tokenState.failing.has(connectionId)) throw new Error('tradovate-request-identity-unavailable');
    return { accessToken: connectionId, expiresAt: '2099-01-01T00:00:00Z', apiHosts: null, brokerUserId: 1, fetchImpl: fetchFor(connectionId) };
  },
}));

const lists: Record<string, Record<string, unknown>> = {
  lucid: {
    '/position/list': [], '/order/list': [], '/orderVersion/list': [], '/userAccountAutoLiq/list': [], '/contract/items': [],
    '/cashBalance/list': [
      { accountId: 10, timestamp: '2026-11-09T08:00:00Z', amount: 50_000, realizedPnL: 30 },
      { accountId: 11, timestamp: '2026-11-09T08:00:00Z', amount: 50_000, realizedPnL: -10 },
    ],
    '/account/list': [{ id: 10, name: 'Leader' }, { id: 11, name: 'Follower' }],
  },
  broken: {},
};
function fetchFor(connectionId: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname.replace('/v1', '');
    const body = lists[connectionId]?.[path];
    return body == null ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(body));
  }) as typeof fetch;
}

const { createNativeBrokerSnapshotLoader } = await import('../server/nativeLiveActivityUpdater');
const runtime = (accounts: number[]) => ({
  device_id: 'd', user_id: 'u', connection_id: 'lucid', last_seen_at: '', started_at: '',
  status: { group: { leaderAccountId: accounts[0], followers: accounts.slice(1).map(accountId => ({ accountId })) } },
}) as never;
const loader = () => createNativeBrokerSnapshotLoader({
  db: {} as never, config: { environment: 'demo' } as never, now: 1,
});

describe('Live Activity a nepoužitelné připojení (9. 11. 2026)', () => {
  beforeEach(() => { tokenState.failing.clear(); tokenState.calls.length = 0; });

  it('připojení bez účtů skupiny, které nejde načíst, snímek skupiny neshodí', async () => {
    tokenState.failing.add('broken');
    const snapshot = await loader()(runtime([10, 11]));
    expect(tokenState.calls.sort()).toEqual(['broken', 'lucid']);
    expect(snapshot).toMatchObject({ realizedPnl: 20 });
    expect(snapshot?.accounts.map(account => account.accountId)).toEqual([10, 11]);
  });

  it('účet skupiny, který zbylá připojení nevidí, snímek dál zastaví', async () => {
    tokenState.failing.add('broken');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(loader()(runtime([10, 11, 12]))).resolves.toBeNull();
    expect(String(errors.mock.calls[0]?.[1])).toBe('tradovate-live-activity-incomplete-group');
    errors.mockRestore();
  });

  it('bez jediného použitelného připojení zůstává původní chyba', async () => {
    tokenState.failing.add('broken'); tokenState.failing.add('lucid');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(loader()(runtime([10, 11]))).resolves.toBeNull();
    expect(String(errors.mock.calls[0]?.[1])).toBe('tradovate-request-identity-unavailable');
    errors.mockRestore();
  });
});
