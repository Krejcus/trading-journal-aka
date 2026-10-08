// Standalone PostgreSQL regression: PGLITE_MODULE=/path/to/pglite/dist/index.js
// node --test tests/sql/dashboardFastNoteStrip.pg.mjs
// Rychlá cesta strip_trade_private_note_fields_fast_v1 musí dát vždy přesně
// totéž co rekurzivní strip_trade_private_note_fields_v1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');

const read = name => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const journal = await read('20260912122352_journal_position_persistence.sql');
const strip = journal.slice(journal.indexOf('create or replace function public.strip_trade_private_note_fields_v1'), journal.indexOf('-- Preserve the existing limited public RPC'));
const fast = (await read('20261008200000_dashboard_light_fast_note_strip.sql'));
const fastFn = fast.slice(fast.indexOf('create or replace function public.strip_trade_private_note_fields_fast_v1'), fast.indexOf('revoke all on function public.strip_trade_private_note_fields_fast_v1'));

const db = new PGlite();
await db.exec(strip);
await db.exec(fastFn);

const cases = [
  null,
  {},
  { setup: 'A', tags: ['x'], nested: { deep: [1, { a: 2 }] } },
  { notes: 'private' },
  { sessionPreNotes: 'a', sessionPostNotes: 'b', keep: 1 },
  { nested: { noteHistory: [1] }, list: [{ executionHistory: { x: 1 } }, { ok: true }] },
  { comment: 'text "notes" inside a value only' },
  { label: 'notes' },
  ['notes', { notes: 1 }],
  'notes',
  42,
];

test('rychlá cesta je identická s rekurzivním strip pro všechny tvary', async () => {
  for (const value of cases) {
    const { rows } = await db.query(
      `select public.strip_trade_private_note_fields_v1($1::jsonb) as slow, public.strip_trade_private_note_fields_fast_v1($1::jsonb) as fast,
         public.strip_trade_private_note_fields_v1($1::jsonb) is not distinct from public.strip_trade_private_note_fields_fast_v1($1::jsonb) as same`,
      [value == null ? null : JSON.stringify(value)],
    );
    assert.equal(rows[0].same, true, JSON.stringify(value));
  }
});

test('soukromé klíče v libovolné hloubce zmizí i rychlou cestou', async () => {
  const { rows } = await db.query(`select public.strip_trade_private_note_fields_fast_v1($1::jsonb) as v`,
    [JSON.stringify({ a: { b: [{ notes: 'x', keep: 1 }] }, noteHistory: [] })]);
  assert.deepEqual(rows[0].v, { a: { b: [{ keep: 1 }] } });
});
