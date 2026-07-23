import { afterEach, describe, expect, it, vi } from 'vitest';

const rpcRows = [
  { id: 'old-live', type: 'observation', content: 'starý live poznatek', metadata: {}, importance: 5 },
  { id: 'live', type: 'observation', content: 'live poznatek', metadata: { scope: 'live' }, importance: 5 },
  { id: 'backtest', type: 'observation', content: 'backtest poznatek', metadata: { scope: 'backtest' }, importance: 5 },
  { id: 'global', type: 'commitment', content: 'globální závazek', metadata: { scope: 'global' }, importance: 9 },
];

vi.mock('../services/supabase', () => ({
  supabase: {
    supabaseUrl: 'http://mock.supabase.local',
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'token' } } }),
      getUser: async () => ({ data: { user: { id: 'u1' } } }),
    },
    rpc: vi.fn(async () => ({ data: rpcRows, error: null })),
    from: vi.fn(() => ({
      select: () => ({
        in: async (_column: string, ids: string[]) => ({
          data: rpcRows.filter(row => ids.includes(row.id)), error: null,
        }),
      }),
    })),
  },
}));

afterEach(() => vi.unstubAllGlobals());

describe('AI coach memory scope', () => {
  it('live recall nepustí backtest paměť a zachová staré live + global záznamy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 })));
    const { recallMemory } = await import('../services/coachMemoryService');
    const rows = await recallMemory({ query: 'disciplína', scope: 'live', limit: 10 });
    expect(rows.map(r => r.id)).toEqual(['old-live', 'live', 'global']);
  });

  it('backtest recall nepustí live ani starou nescopeovanou paměť, global závazek ano', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 })));
    const { recallMemory } = await import('../services/coachMemoryService');
    const rows = await recallMemory({ query: 'disciplína', scope: 'backtest', limit: 10 });
    expect(rows.map(r => r.id)).toEqual(['backtest', 'global']);
  });
});
