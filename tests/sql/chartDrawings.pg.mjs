// Standalone PostgreSQL regression: PGLITE_MODULE=/path/to/pglite/dist/index.js
// node --test tests/sql/chartDrawings.pg.mjs
// Kresby v grafech: jen vlastník, starší úprava nepřepíše novější, automatické
// vrstvy a úprava „z budoucnosti“ se do tabulky nedostanou.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');

const migration = await readFile(new URL('../../supabase/migrations/20261017100000_chart_drawings.sql', import.meta.url), 'utf8');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key);
  insert into auth.users values ('${A}'), ('${B}');
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid() to authenticated;
`);
await db.exec(migration);

const drawing = (price = 1) => JSON.stringify({ id: 'dw_1', tool: 'TrendLine', points: [{ time: 1, price }], style: {} });
const as = async (uid, sql, params = []) => {
  await db.exec(`set test.uid = '${uid}'; set role authenticated;`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role;'); }
};
const upsert = (uid, editedAt, price) => as(uid,
  `insert into public.chart_drawings (id, day, start_time, end_time, drawing, edited_at)
   values ('dw_1', '2026-10-15', '2026-10-15T08:00Z', '2026-10-15T08:10Z', $1::jsonb, $2)
   on conflict (user_id, id) do update set drawing = excluded.drawing, edited_at = excluded.edited_at, deleted_at = excluded.deleted_at`,
  [drawing(price), editedAt]);

test('vlastník zapíše a čte, cizí uživatel kresbu nevidí', async () => {
  await upsert(A, '2026-10-15T08:00Z', 1);
  assert.equal((await as(A, 'select count(*)::int as n from public.chart_drawings')).rows[0].n, 1);
  assert.equal((await as(B, 'select count(*)::int as n from public.chart_drawings')).rows[0].n, 0);
  await assert.rejects(() => as(B, `insert into public.chart_drawings (user_id, id, day, start_time, end_time, drawing) values ('${A}', 'x', '2026-10-15', now(), now(), '{"points":[]}')`));
});

test('starší úprava nepřepíše novější', async () => {
  await upsert(A, '2026-10-15T09:00Z', 2);
  await upsert(A, '2026-10-15T08:30Z', 3);
  const { rows } = await as(A, `select drawing->'points'->0->>'price' as price from public.chart_drawings where id = 'dw_1'`);
  assert.equal(rows[0].price, '2');
});

test('úprava z budoucnosti se ořízne na teď', async () => {
  await upsert(A, '2099-01-01T00:00Z', 4);
  const { rows } = await as(A, `select edited_at <= now() as ok, drawing->'points'->0->>'price' as price from public.chart_drawings where id = 'dw_1'`);
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].price, '4');
});

test('automatické vrstvy a cizí trh tabulka odmítne', async () => {
  await assert.rejects(() => as(A, `insert into public.chart_drawings (id, day, start_time, end_time, drawing) values ('auto-risk-1', '2026-10-15', now(), now(), '{"points":[]}')`));
  await assert.rejects(() => as(A, `insert into public.chart_drawings (id, market, day, start_time, end_time, drawing) values ('dw_es', 'ES', '2026-10-15', now(), now(), '{"points":[]}')`));
  await assert.rejects(() => as(A, `insert into public.chart_drawings (id, day, start_time, end_time, drawing) values ('dw_bad', '2026-10-15', now(), now(), '{"x":1}')`));
});
