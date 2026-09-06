import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Execute only the actual pure data-loading slice. No Edge Function imports,
// environment credentials, server listener, remote endpoint or AI calls run.
const source = readFileSync(new URL('../supabase/functions/mcp-server/index.ts', import.meta.url), 'utf8');
const start = source.indexOf('function mapTrade(');
const end = source.indexOf('  return data;\n}', source.indexOf('async function loadCore()')) + '  return data;\n}'.length;
const js = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
type Page = { data?: Array<Record<string, any>>; error?: { code: string; message: string } };
function fixture(privatePage: (offset: number) => Page) {
  const calls: Array<{ table: string; columns?: string; scope?: [string, string]; order?: string; range?: [number, number] }> = [];
  const db = { from(table: string) {
    const call: typeof calls[number] = { table }; calls.push(call);
    return {
      select(columns: string) { call.columns = columns; return this; },
      eq(key: string, value: string) { call.scope = [key, value]; return this; },
      order(column: string) { call.order = column; return this; },
      async range(lo: number, hi: number): Promise<Page> {
        call.range = [lo, hi];
        if (table === 'trade_private_notes') return privatePage(lo);
        return { data: table === 'trades' ? [{ id: 'trade', data: { notes: 'legacy', noteHistory: { never: 'share' }, tags: ['keep'] } }] : [] };
      },
    };
  } };
  const load = new Function('db', 'USER_ID', `${js}; return loadCore;`)(db, 'synthetic-owner') as () => Promise<any>;
  return { load, calls };
}
it('actual MCP loader scopes every page and hydrates only supported legacy fields', async () => {
  const f = fixture(offset => ({ data: offset === 0 ? Array.from({ length: 1000 }, (_, i) => ({ trade_id: i === 0 ? 'trade' : String(i), notes: { notes: i === 0 ? 'private owner note' : 'other', noteHistory: { secret: true }, legacy_fragments: ['never'] } })) : [] }));
  const core = await f.load();
  expect(core.trades[0]).toMatchObject({ notes: 'private owner note', tags: ['keep'] });
  expect(core.trades[0]).not.toHaveProperty('noteHistory');
  expect(core.trades[0]).not.toHaveProperty('legacy_fragments');
  expect(f.calls.filter(call => call.table === 'trade_private_notes').map(call => call.range)).toEqual([[0, 999], [1000, 1999]]);
  expect(f.calls.every(call => call.scope?.[0] === 'user_id' && call.scope[1] === 'synthetic-owner')).toBe(true);
});
it('actual MCP loader preserves old-owner notes only for a missing table', async () => {
  const old = fixture(() => ({ error: { code: 'PGRST205', message: 'missing table' } }));
  expect((await old.load()).trades[0].notes).toBe('legacy');
  expect((await old.load()).trades[0]).not.toHaveProperty('noteHistory');
  const migrated = fixture(() => ({ data: [] }));
  expect((await migrated.load()).trades[0]).not.toHaveProperty('notes');
});
it('actual MCP loader propagates private-note transport failure instead of returning stale legacy text', async () => {
  const f = fixture(() => ({ error: { code: '500', message: 'transport unavailable' } }));
  await expect(f.load()).rejects.toThrow('Private trade notes: transport unavailable');
});
