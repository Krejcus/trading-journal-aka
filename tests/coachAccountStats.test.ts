/**
 * Regresní test bugu „3 vs 37 obchodů" — kouč u účtu s kopírkou viděl přes
 * get_stats(account=X) jen zlomek obchodů, zatímco list_accounts hlásil plný počet.
 *
 * Příčina: getStats volal collapseCopies PŘED filtrem účtu. Sloučený obchod nese
 * accountId MASTERA, takže kopie fan-outnuté na účet X (master jinde) z filtru
 * zmizely. PO opravě se s account filtrem počítají raw řádky daného účtu —
 * konzistentně s list_accounts a s Lab (ta filtruje účet před dedupem odjakživa).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/supabase', () => {
  const makeChain = () => {
    const c: any = {};
    const self = () => c;
    for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'gt', 'lt',
      'order', 'limit', 'filter', 'not', 'or', 'contains', 'is', 'update',
      'upsert', 'delete', 'insert']) c[m] = self;
    c.single = () => Promise.resolve({ data: null, error: null });
    c.maybeSingle = () => Promise.resolve({ data: null, error: null });
    c.then = (res: any) => Promise.resolve({ data: [], error: null }).then(res);
    return c;
  };
  return {
    supabase: {
      supabaseUrl: 'http://mock.supabase.local',
      auth: {
        getSession: async () => ({ data: { session: { access_token: 't', user: { id: 'u1' } } } }),
        getUser: async () => ({ data: { user: { id: 'u1' } } }),
      },
      from: () => makeChain(),
      functions: { invoke: async () => ({ data: null, error: null }) },
    },
  };
});

import { executeTool } from '../services/coachTools';

const accounts = [
  { id: 'a-master', name: 'Tradeify 1', type: 'Funded', status: 'Active' },
  { id: 'a-lucid', name: 'Lucid Funded', type: 'Funded', status: 'Active' },
] as any[];

// 5 rozhodnutí: 4× master na Tradeify 1 + kopie na Lucid, 1× master přímo na
// Lucidu (přesně scénář, kdy dřív get_stats(account=Lucid) vrátil 1 místo 5).
const trades: any[] = [];
for (let i = 0; i < 4; i++) {
  trades.push({ id: `m${i}`, accountId: 'a-master', isMaster: true, groupId: `g${i}`, pnl: 100, riskAmount: 50, date: `2026-07-0${i + 1}`, direction: 'Long', instrument: 'NQ' });
  trades.push({ id: `c${i}`, accountId: 'a-lucid', masterTradeId: `m${i}`, groupId: `g${i}`, pnl: 90, riskAmount: 45, date: `2026-07-0${i + 1}`, direction: 'Long', instrument: 'NQ' });
}
trades.push({ id: 'm9', accountId: 'a-lucid', isMaster: true, groupId: 'g9', pnl: -80, riskAmount: 40, date: '2026-07-09', direction: 'Short', instrument: 'NQ' });

const ctx = { trades, accounts, preps: [], reviews: [], scope: 'live' } as any;

describe('get_stats s account filtrem — konzistence s list_accounts (bug 3 vs 37)', () => {
  it('get_stats(account=Lucid) počítá všechny kopie na účtu, ne jen mastery', async () => {
    const stats: any = await executeTool('get_stats', { account: 'Lucid' }, ctx);
    expect(stats.totalTrades).toBe(5); // před fixem: 1
    expect(stats.totalPnL).toBe(4 * 90 - 80);
  });

  it('get_stats(account=…) a list_accounts vrací stejný počet i PnL', async () => {
    const stats: any = await executeTool('get_stats', { account: 'Lucid Funded' }, ctx);
    const list: any = await executeTool('list_accounts', {}, ctx);
    const lucid = list.accounts.find((a: any) => a.name === 'Lucid Funded');
    expect(stats.totalTrades).toBe(lucid.tradeCount);
    expect(stats.totalPnL).toBe(lucid.netPnl);
  });

  it('get_stats BEZ filtru dál slučuje kopie do rozhodnutí ($ přes účty)', async () => {
    const stats: any = await executeTool('get_stats', {}, ctx);
    expect(stats.totalTrades).toBe(5); // 5 rozhodnutí, ne 9 řádků
    expect(stats.totalPnL).toBe(4 * (100 + 90) - 80);
  });

  it('group_by=account drží per-účet atribuci (beze změny chování)', async () => {
    const res: any = await executeTool('get_stats', { group_by: 'account' }, ctx);
    const lucid = res.groups.find((g: any) => g.group === 'Lucid Funded');
    const master = res.groups.find((g: any) => g.group === 'Tradeify 1');
    expect(lucid.stats.totalTrades).toBe(5);
    expect(master.stats.totalTrades).toBe(4);
  });
});
