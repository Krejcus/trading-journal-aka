// Standalone PostgreSQL regression: PGLITE_MODULE=/path/to/pglite/dist/index.js
// node --test tests/sql/syncChanges.pg.mjs
// Záznam změn pro delta sync obchodů: každý zdroj složeného obchodu se zaloguje,
// prázdný zápis a holá změna revize ne; kurzor, epocha, horizont a úklid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');

const migration = (await readFile(new URL('../../supabase/migrations/20261025220000_sync_changes_v1.sql', import.meta.url), 'utf8'))
  // PGlite nemá logickou replikaci; publikaci ověřuje produkce.
  .replace(/alter publication supabase_realtime[^;]*;/, '');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const T1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const T2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const E1 = 'eeeeeeee-0000-4000-8000-000000000001';
const ACC = 'cccccccc-0000-4000-8000-000000000001';

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid() to authenticated;
  grant usage on schema public to authenticated;
  create table public.trades (id uuid primary key, user_id uuid not null, account_id uuid, pnl numeric, data jsonb, journal_projection_status text);
  create table public.tradovate_journal_positions (user_id uuid not null, position_id text not null, trade_id uuid, journal_account_id uuid,
    status text, facts jsonb, history jsonb, revision int8 not null default 1, primary key (user_id, position_id));
  create table public.trade_private_notes (trade_id uuid primary key, user_id uuid not null, notes jsonb);
  create table public.backtest_trade_note_histories (trade_id uuid primary key, user_id uuid not null, history jsonb);
  create table public.copier_trade_snapshots (id uuid primary key default gen_random_uuid(), user_id uuid not null, episode_id uuid not null, kind text);
  create table public.tradovate_copier_trades (id uuid primary key default gen_random_uuid(), user_id uuid not null, episode_id uuid, trade_id text);
  create table public.snapshot_links (user_id uuid, trade_id uuid, episode_id uuid);
  create view public.journal_trade_snapshots with (security_invoker = true) as select user_id, trade_id, episode_id from public.snapshot_links;
  grant select on public.journal_trade_snapshots, public.snapshot_links to authenticated;
  create table public.profiles (id uuid primary key, email text, full_name text, avatar_url text, role text, preferences jsonb);
  create table public.accounts (id uuid primary key, user_id uuid, name text);
  create table public.daily_preps (id uuid primary key default gen_random_uuid(), user_id uuid, date text, data jsonb);
  create table public.daily_reviews (id uuid primary key default gen_random_uuid(), user_id uuid, date text, data jsonb);
  create table public.weekly_focus (id uuid primary key default gen_random_uuid(), user_id uuid, week_iso text, goals jsonb);
`);
await db.exec(migration);

const as = async (uid, sql, params = []) => {
  await db.exec(`set test.uid = '${uid}'; set role authenticated;`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role;'); }
};
const changes = async (uid, cursor, epoch = 1) => (await as(uid, 'select public.sync_trade_changes_v1($1, $2) as r', [cursor, epoch])).rows[0].r;
const logged = async () => (await db.query('select user_id, entity, entity_id from public.sync_changes order by id')).rows;
const clear = () => db.exec('delete from public.sync_changes');

test('každý zdroj složeného obchodu zaloguje ID obchodu, smazání i přesun', async () => {
  await clear();
  await db.exec(`insert into public.trades (id, user_id, account_id, pnl, data) values ('${T1}', '${A}', '${ACC}', 10, '{}')`);
  await db.exec(`insert into public.trade_private_notes values ('${T1}', '${A}', '{"a":1}')`);
  await db.exec(`insert into public.backtest_trade_note_histories values ('${T1}', '${A}', '{"h":[]}')`);
  await db.exec(`insert into public.tradovate_journal_positions (user_id, position_id, trade_id, journal_account_id, status, facts, history)
    values ('${A}', 'p1', '${T1}', '${ACC}', 'confirmed', '{"pnl":10}', '{}')`);
  await db.exec(`update public.tradovate_journal_positions set trade_id = '${T2}' where position_id = 'p1'`);
  await db.exec(`delete from public.trades where id = '${T1}'`);
  const rows = (await logged()).map(row => `${row.entity}:${row.entity_id}`);
  assert.deepEqual(rows, [`trade:${T1}`, `trade:${T1}`, `trade:${T1}`, `trade:${T1}`, `trade:${T2}`, `trade:${T1}`, `trade:${T1}`]);
});

test('prázdný zápis ani holá změna revize projekce se nelogují; změna faktů ano', async () => {
  await db.exec(`insert into public.trades (id, user_id, account_id, pnl, data) values ('${T1}', '${A}', '${ACC}', 10, '{}') on conflict do nothing`);
  await clear();
  await db.exec(`update public.trades set pnl = 10 where id = '${T1}'`);
  await db.exec(`update public.tradovate_journal_positions set revision = revision + 1 where position_id = 'p1'`);
  assert.equal((await logged()).length, 0);
  await db.exec(`update public.tradovate_journal_positions set facts = '{"pnl":11}' where position_id = 'p1'`);
  assert.deepEqual((await logged()).map(row => row.entity_id), [T2]);
});

test('snapshot a záznam kopírky logují epizodu; RPC ji přeloží na propojený obchod', async () => {
  await clear();
  await db.exec(`insert into public.snapshot_links values ('${A}', '${T2}', '${E1}')`);
  const start = await changes(A, null);
  assert.equal(start.reset, true);
  await db.exec(`insert into public.copier_trade_snapshots (user_id, episode_id, kind) values ('${A}', '${E1}', 'exit')`);
  await db.exec(`insert into public.tradovate_copier_trades (user_id, episode_id, trade_id) values ('${A}', '${E1}', 'f1')`);
  await db.exec(`insert into public.tradovate_copier_trades (user_id, episode_id, trade_id) values ('${A}', null, 'f2')`);
  assert.deepEqual((await logged()).map(row => row.entity), ['episode', 'episode']);
  const delta = await changes(A, start.cursor);
  assert.equal(delta.reset, false);
  assert.deepEqual(delta.trade_ids, [T2]);
});

test('kurzor: jen změny vlastníka od kurzoru; cizí uživatel je nevidí', async () => {
  await clear();
  const start = await changes(A, null);
  await db.exec(`insert into public.trades (id, user_id, account_id, pnl, data) values ('${T2}', '${B}', '${ACC}', 5, '{}')`);
  await db.exec(`update public.trades set pnl = 12 where id = '${T1}'`);
  const delta = await changes(A, start.cursor);
  assert.deepEqual(delta.trade_ids, [T1]);
  assert.deepEqual((await changes(B, start.cursor)).trade_ids, [T2]);
  // Další volání od nového kurzoru: nic nového.
  assert.deepEqual((await changes(A, delta.cursor)).trade_ids, []);
  assert.equal((await as(B, 'select count(*)::int as n from public.sync_changes where user_id = $1', [A])).rows[0].n, 0);
});

test('reset: jiná epocha, vadný kurzor, kurzor z budoucnosti (obnova DB) a za horizontem úklidu', async () => {
  const start = await changes(A, null);
  assert.equal((await changes(A, start.cursor, 2)).reset, true);
  assert.equal((await changes(A, 'nope')).reset, true);
  assert.equal((await changes(A, '999999999999')).reset, true);
  await db.exec(`insert into public.trade_private_notes values ('${T2}', '${A}', '{}') on conflict (trade_id) do update set notes = '{"x":1}'`);
  await db.exec(`update public.sync_changes set created_at = now() - interval '4 days'`);
  const removed = (await db.query('select public.sync_prune_v1() as n')).rows[0].n;
  assert.ok(removed > 0);
  assert.equal((await changes(A, start.cursor)).reset, true);
  assert.equal((await db.query('select count(*)::int as n from public.sync_changes')).rows[0].n, 0);
});

test('úklid a zápis do záznamu nejsou pro klienta dostupné', async () => {
  await assert.rejects(as(A, 'select public.sync_prune_v1()'));
  await assert.rejects(as(A, `insert into public.sync_changes (user_id, entity, entity_id) values ('${A}', 'trade', 'x')`));
  await assert.rejects(as(A, 'update public.sync_meta set epoch = 5'));
});

test('dashboard bez obchodů vrací jen data vlastníka', async () => {
  await db.exec(`insert into public.profiles (id, email, role, preferences) values ('${A}', 'a@x', 'admin', '{"p":1}'), ('${B}', 'b@x', 'friend', '{}')`);
  await db.exec(`insert into public.accounts values ('${ACC}', '${A}', 'Lucid'), (gen_random_uuid(), '${B}', 'Other')`);
  const meta = (await as(A, 'select public.get_dashboard_meta_v1() as m')).rows[0].m;
  assert.equal(meta.user.id, A);
  assert.equal(meta.accounts.length, 1);
  assert.equal('trades' in meta, false);
  assert.deepEqual(meta.preferences, { p: 1 });
});
