// Skutečný PostgreSQL: kompaktní ACK smí ukončit jen dva horké ruční příkazy,
// pouze pro přesnou delivery a přesný běh workeru. Opakování je idempotentní.
// PG_MODULE=/path/to/node_modules/pg/lib/index.js PG_URL=postgres://postgres@127.0.0.1:54329/postgres \
//   node --test tests/sql/copierHotCommandCompactAck.pg.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pg = (await import(process.env.PG_MODULE ?? 'pg')).default;
const url = process.env.PG_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres';
const migration = await readFile(new URL(
  '../../supabase/migrations/20261104164250_copier_hot_command_compact_ack.sql', import.meta.url,
), 'utf8');

const DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DELIVERY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMMAND = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STARTED = '2026-11-04T16:28:34.000Z';
let admin;

before(async () => {
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
    end $$;
    drop schema if exists public cascade;
    create schema public;
    grant usage on schema public to anon, authenticated, service_role;
    create table public.tradovate_copier_device_runtime (
      device_id uuid primary key,
      started_at timestamptz not null
    );
    create table public.tradovate_copier_commands (
      id uuid primary key,
      device_id uuid not null,
      delivery_id uuid,
      command_type text not null,
      payload jsonb not null default '{}'::jsonb,
      status text not null,
      result jsonb,
      error text,
      completed_at timestamptz
    );
    -- SELECT ... FOR UPDATE requires UPDATE as well; production's heartbeat
    -- role already owns both privileges on this table.
    grant select, update on public.tradovate_copier_device_runtime to service_role;
    grant select, update on public.tradovate_copier_commands to service_role;
  `);
  await admin.query(migration);
});

after(async () => admin.end());

beforeEach(async () => {
  await admin.query('truncate public.tradovate_copier_commands, public.tradovate_copier_device_runtime');
  await admin.query('insert into public.tradovate_copier_device_runtime values ($1, $2)', [DEVICE, STARTED]);
});

const ACK = `select public.complete_tradovate_copier_hot_command_v3(
  $1, $2, $3, $4::jsonb, $5, $6
) as accepted`;
const seed = (type = 'place-leader-entry', status = 'claimed') => admin.query(`
  insert into public.tradovate_copier_commands
    (id, device_id, delivery_id, command_type, payload, status)
  values ($1, $2, $3, 'copy-command', jsonb_build_object('command', jsonb_build_object('type', $4::text)), $5)
`, [COMMAND, DEVICE, DELIVERY, type, status]);
const ack = async (overrides = {}) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('set role service_role');
  try {
    return (await client.query(ACK, [
      overrides.device ?? DEVICE,
      overrides.delivery ?? DELIVERY,
      overrides.command ?? COMMAND,
      JSON.stringify(overrides.result ?? { ok: true }),
      overrides.error ?? null,
      overrides.started ?? STARTED,
    ])).rows[0].accepted;
  } finally {
    await client.end();
  }
};

test('správný horký příkaz se atomicky ukončí bez přepsání runtime', async () => {
  await seed();
  assert.equal(await ack(), true);
  const row = (await admin.query(
    'select status, result, error, completed_at from public.tradovate_copier_commands where id = $1', [COMMAND],
  )).rows[0];
  assert.equal(row.status, 'succeeded');
  assert.deepEqual(row.result, { ok: true });
  assert.equal(row.error, null);
  assert.ok(row.completed_at instanceof Date);
  assert.equal((await admin.query(
    'select started_at from public.tradovate_copier_device_runtime where device_id = $1', [DEVICE],
  )).rows[0].started_at.toISOString(), STARTED);
});

test('ztracená HTTP odpověď: totožné opakování projde a completed_at se neposune', async () => {
  await seed('manage-leader-order');
  assert.equal(await ack(), true);
  const first = (await admin.query(
    'select completed_at from public.tradovate_copier_commands where id = $1', [COMMAND],
  )).rows[0].completed_at;
  assert.equal(await ack(), true);
  const second = (await admin.query(
    'select completed_at from public.tradovate_copier_commands where id = $1', [COMMAND],
  )).rows[0].completed_at;
  assert.equal(second.getTime(), first.getTime());
  assert.equal(await ack({ result: { ok: false } }), false);
});

test('jiný běh workeru, delivery, stav nebo typ selže zavřeně', async () => {
  await seed();
  assert.equal(await ack({ started: '2026-11-04T16:29:00.000Z' }), false);
  assert.equal(await ack({ delivery: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }), false);
  await admin.query("update public.tradovate_copier_commands set status = 'pending' where id = $1", [COMMAND]);
  assert.equal(await ack(), false);
  await admin.query('delete from public.tradovate_copier_commands');
  await seed('flatten-group');
  assert.equal(await ack(), false);
});

test('chybějící typ příkazu ani chybějící runtime řádek neprojdou', async () => {
  await admin.query(`
    insert into public.tradovate_copier_commands (id, device_id, delivery_id, command_type, payload, status)
    values ($1, $2, $3, 'copy-command', '{}'::jsonb, 'claimed')
  `, [COMMAND, DEVICE, DELIVERY]);
  assert.equal(await ack(), false);
  await admin.query('delete from public.tradovate_copier_commands');
  await seed();
  await admin.query('delete from public.tradovate_copier_device_runtime');
  assert.equal(await ack(), false);
  assert.equal((await admin.query('select status from public.tradovate_copier_commands')).rows[0].status, 'claimed');
});

test('opakování rejected a jiné pořadí klíčů v jsonb jsou totožný výsledek', async () => {
  await seed();
  assert.equal(await ack({ result: { a: 1, b: 2 }, error: 'broker-rejected' }), true);
  assert.equal((await admin.query('select status from public.tradovate_copier_commands')).rows[0].status, 'rejected');
  assert.equal(await ack({ result: { b: 2, a: 1 }, error: 'broker-rejected' }), true);
  assert.equal(await ack({ result: { a: 1, b: 2 } }), false);
});

test('dvě spojení: opakování čeká na nepotvrzený ACK a potom vrátí shodu', async () => {
  await seed();
  const holder = new pg.Client({ connectionString: url });
  await holder.connect();
  await holder.query('set role service_role');
  const args = [DEVICE, DELIVERY, COMMAND, JSON.stringify({ ok: true }), null, STARTED];
  try {
    await holder.query('begin');
    assert.equal((await holder.query(ACK, args)).rows[0].accepted, true);
    const repeat = ack();
    await new Promise(resolve => setTimeout(resolve, 200));
    await holder.query('commit');
    assert.equal(await repeat, true);
    // Bez potvrzení do 2 s skončí opakování chybou lock_timeout, ne čekáním bez konce.
    await admin.query('truncate public.tradovate_copier_commands');
    await seed();
    await holder.query('begin');
    await holder.query(ACK, args);
    await assert.rejects(ack(), error => error.code === '55P03');
    await holder.query('rollback');
  } finally {
    await holder.end();
  }
});

test('anon ani authenticated funkci nespustí; invoker a prázdný search_path zůstávají', async () => {
  for (const role of ['anon', 'authenticated']) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`set role ${role}`);
    await assert.rejects(client.query(ACK, [DEVICE, DELIVERY, COMMAND, '{}', null, STARTED]), error => error.code === '42501');
    await client.end();
  }
  const fn = (await admin.query(`
    select prosecdef, proconfig
    from pg_proc
    where proname = 'complete_tradovate_copier_hot_command_v3'
  `)).rows[0];
  assert.equal(fn.prosecdef, false);
  assert.deepEqual(fn.proconfig, ['search_path=""', 'lock_timeout=2s']);
});
