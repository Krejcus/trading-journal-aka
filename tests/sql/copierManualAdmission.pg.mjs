// Skutečný PostgreSQL (ne PGlite — potřebujeme dvě souběžná spojení):
// PG_MODULE=/path/to/node_modules/pg/lib/index.js PG_URL=postgres://postgres@127.0.0.1:54329/postgres \
//   node --test tests/sql/copierManualAdmission.pg.mjs
// Atomická admission ručního vstupu/správy: dvě různé operace souběžně → jedna
// projde, druhá busy; lock_timeout; idempotence; brzda; strop; RAISE bez zápisu.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const pg = (await import(process.env.PG_MODULE ?? 'pg')).default;
const url = process.env.PG_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres';
const migration = await readFile(new URL('../../supabase/migrations/20261101120000_copier_manual_admission.sql', import.meta.url), 'utf8');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DEV1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const DEV2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const REVOKED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const FOREIGN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const CONN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONN2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const FOREIGN_CONN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEV_CONN2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
const schema = `adm_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

const clients = [];
const connect = async () => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`set search_path = ${schema}_shadow`); // nic nesmí záviset na search_path volajícího
  clients.push(client);
  return client;
};
let admin;

before(async () => {
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  // Izolovaná databáze testu: vlastní schéma public se nedá přejmenovat, takže
  // celé public uklidíme a postavíme jen tabulky, na kterých funkce stojí.
  await admin.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
    end $$;
    drop schema if exists public cascade;
    create schema public;
    grant usage on schema public to anon, authenticated, service_role;
    create table public.tradovate_oauth_connections (id uuid primary key, user_id uuid not null);
    grant select on public.tradovate_oauth_connections to service_role;
    insert into public.tradovate_oauth_connections values
      ('${CONN}', '${USER}'), ('${CONN2}', '${USER}'), ('${FOREIGN_CONN}', '${OTHER}');
    create table public.tradovate_copier_devices (
      id uuid primary key, user_id uuid not null, connection_id uuid, revoked_at timestamptz
    );
    create table public.tradovate_copier_commands (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null,
      device_id uuid not null references public.tradovate_copier_devices(id),
      connection_id uuid,
      command_type text not null check (command_type in ('copy-command', 'arm-live', 'shadow', 'disarm', 'kill-switch', 'lock-until-session-end')),
      payload jsonb not null default '{}'::jsonb,
      idempotency_key text not null check (char_length(idempotency_key) between 16 and 160),
      status text not null default 'pending' check (status in ('pending', 'claimed', 'succeeded', 'rejected', 'expired')),
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      claimed_at timestamptz, completed_at timestamptz, result jsonb, error text,
      constraint tradovate_copier_commands_expiry check (expires_at > created_at),
      constraint tradovate_copier_commands_idempotency unique (user_id, device_id, idempotency_key)
    );
    create index on public.tradovate_copier_commands (user_id, created_at desc);
    grant select, insert, update on public.tradovate_copier_commands to service_role;
    grant select on public.tradovate_copier_devices to service_role;
    insert into public.tradovate_copier_devices values
      ('${DEV1}', '${USER}', '${CONN}', null), ('${DEV2}', '${USER}', '${CONN}', null),
      ('${REVOKED}', '${USER}', '${CONN}', now()), ('${FOREIGN}', '${OTHER}', '${FOREIGN_CONN}', null),
      ('${DEV_CONN2}', '${USER}', '${CONN2}', null);
  `);
  await admin.query(migration);
});

after(async () => {
  for (const client of clients) await client.end().catch(() => undefined);
  await admin.end();
});

const reset = () => admin.query('truncate public.tradovate_copier_commands');
let seq = 0;
const opId = (prefix = 'entry') => `${prefix}:t${String(++seq).padStart(6, '0')}-${randomUUID().slice(0, 8)}`;
const entry = (operationId = opId(), hash = 'hash0001') => ({ command: { type: 'place-leader-entry', operationId, payloadHash: hash } });
const manage = (trade, action = 'move-stop', operationId = opId('manage'), hash = 'hash0002') => ({
  command: { type: 'manage-leader-order', operationId, payloadHash: hash, action, ...trade },
});

const ADMIT = `select * from public.admit_tradovate_copier_manual_command($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`;
const args = (payload, overrides = {}) => {
  const now = overrides.now ?? new Date();
  return [
    overrides.user ?? USER, overrides.device ?? DEV1, 'connection' in overrides ? overrides.connection : CONN, 'operationId' in overrides ? overrides.operationId : payload.command.operationId,
    JSON.stringify(payload), now, overrides.expiresAt ?? new Date(now.getTime() + 15_000),
    overrides.entryInterval ?? 3_000, overrides.manageInterval ?? 2_000, overrides.entryCap ?? 100, overrides.manageCap ?? 100,
  ];
};
const asService = async (client, sql, params) => {
  await client.query('set role service_role');
  try { return await client.query(sql, params); } finally { await client.query('reset role'); }
};
const admit = async (client, payload, overrides) => (await asService(client, ADMIT, args(payload, overrides))).rows[0];
const count = async () => Number((await admin.query('select count(*) from public.tradovate_copier_commands')).rows[0].count);
const seed = (rows) => admin.query(`
  insert into public.tradovate_copier_commands (user_id, device_id, command_type, payload, idempotency_key, status, created_at, expires_at)
  select * from jsonb_to_recordset($1::jsonb) as r(user_id uuid, device_id uuid, command_type text, payload jsonb,
    idempotency_key text, status text, created_at timestamptz, expires_at timestamptz)`, [JSON.stringify(rows)]);
const ago = ms => new Date(Date.now() - ms).toISOString();

test('dvě spojení, dvě RŮZNÉ operace téhož uživatele: první drží zámek, druhá čeká a vrátí entry-busy', async () => {
  await reset();
  const a = await connect();
  const b = await connect();
  await a.query('begin');
  const first = (await asServiceInTx(a, entry())).rows[0];
  assert.equal(first.result_code, 'inserted');
  let secondDone = false;
  const second = admit(b, entry(), {}).then(row => { secondDone = true; return row; });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(secondDone, false, 'druhá admission musí čekat na zámek první transakce');
  await a.query('commit');
  assert.equal((await second).result_code, 'entry-busy');
  assert.equal(await count(), 1);
});

async function asServiceInTx(client, payload, overrides) {
  await client.query('set local role service_role');
  return client.query(ADMIT, args(payload, overrides));
}

test('souběžně bez explicitní transakce (PC + telefon, dvě zařízení): vždy přesně 1 inserted + 1 entry-busy', async () => {
  for (let round = 0; round < 10; round += 1) {
    await reset();
    const a = await connect();
    const b = await connect();
    const results = await Promise.all([admit(a, entry(), { device: DEV1 }), admit(b, entry(), { device: DEV2 })]);
    assert.deepEqual(results.map(row => row.result_code).sort(), ['entry-busy', 'inserted']);
    assert.equal(await count(), 1);
  }
});

test('lock_timeout 2 s platí i pro advisory zámek: čekající admission skončí chybou, nic nevloží', async () => {
  await reset();
  const a = await connect();
  const b = await connect();
  await a.query('begin');
  await asServiceInTx(a, entry());
  const started = Date.now();
  await assert.rejects(admit(b, entry()), error => error.code === '55P03');
  assert.ok(Date.now() - started >= 1_900);
  await a.query('rollback');
  assert.equal(await count(), 0);
});

test('stejné operationId: shodný otisk = existing (i z jiného zařízení, s původním device_id), jiný = entry-conflict', async () => {
  await reset();
  const client = await connect();
  const operationId = opId();
  const inserted = await admit(client, entry(operationId, 'hashsame1'), { device: DEV1 });
  assert.equal(inserted.result_code, 'inserted');
  const again = await admit(client, entry(operationId, 'hashsame1'), { device: DEV2 });
  assert.equal(again.result_code, 'existing');
  assert.equal(again.id, inserted.id);
  assert.equal(again.device_id, DEV1);
  const conflict = await admit(client, entry(operationId, 'hashdiff1'), { device: DEV1 });
  assert.equal(conflict.result_code, 'entry-conflict');
  assert.equal(conflict.id, null);
  assert.equal(await count(), 1);
});

test('existing má přednost před busy i brzdou (opakovaný POST po výpadku sítě)', async () => {
  await reset();
  const client = await connect();
  const operationId = opId();
  await admit(client, entry(operationId));
  await seed([{ user_id: USER, device_id: DEV1, command_type: 'disarm', payload: {}, idempotency_key: randomUUID(),
    status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString() }]);
  assert.equal((await admit(client, entry(operationId))).result_code, 'existing');
});

test('RAISE bez zápisu: NULL, mimo rozsah, staré/budoucí p_now, neznámý typ, manage bez klíče, cizí/odvolané zařízení', async () => {
  await reset();
  const client = await connect();
  const now = new Date();
  const cases = [
    [entry(), { operationId: null }, /copier-admission-invalid-arguments/],
    [entry(), { entryCap: 0 }, /copier-admission-invalid-arguments/],
    [entry(), { manageInterval: 0 }, /copier-admission-invalid-arguments/],
    [entry(), { now, expiresAt: new Date(now.getTime() + 15_001) }, /copier-admission-invalid-arguments/],
    [entry(), { now, expiresAt: now }, /copier-admission-invalid-arguments/],
    [entry(), { now: new Date(Date.now() - 3_000) }, /copier-admission-clock-skew/],
    [entry(), { now: new Date(Date.now() + 3_000) }, /copier-admission-clock-skew/],
    [{ command: { type: 'flatten-group', operationId: 'entry:t-unknown-01', payloadHash: 'x1234567' } }, { operationId: 'entry:t-unknown-01' }, /copier-admission-unsupported-command/],
    [{ command: { type: 'place-leader-entry', operationId: 'entry:t-nohash-001' } }, {}, /copier-admission-invalid-payload/],
    [entry(), { operationId: 'entry:t-mismatch-01' }, /copier-admission-invalid-payload/],
    [{ command: { type: 'manage-leader-order', operationId: 'manage:t-nokey-0001', payloadHash: 'x1234567', action: 'move-stop' } }, {}, /copier-admission-invalid-payload/],
    [entry(), { device: FOREIGN }, /copier-admission-device-invalid/],
    [entry(), { device: REVOKED }, /copier-admission-device-invalid/],
    [entry(), { connection: null }, /copier-admission-invalid-arguments/],
    // Nesourodá trojice: zařízení z jiného připojení téhož uživatele, cizí připojení, cizí uživatel.
    [entry(), { device: DEV_CONN2 }, /copier-admission-device-invalid/],
    [entry(), { connection: FOREIGN_CONN }, /copier-admission-connection-invalid/],
    [entry(), { connection: CONN2 }, /copier-admission-device-invalid/],
    [entry(), { user: OTHER, device: FOREIGN }, /copier-admission-connection-invalid/],
  ];
  for (const [payload, overrides, expected] of cases) {
    await assert.rejects(admit(client, payload, overrides), error => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /not-found$/);
      return true;
    });
  }
  assert.equal(await count(), 0);
});

test('brzda novější než p_now − 500 ms → superseded-by-brake (i z jiného zařízení); cancel-entry projde; starší brzda ne', async () => {
  await reset();
  const client = await connect();
  await seed([{ user_id: USER, device_id: DEV2, command_type: 'kill-switch', payload: {}, idempotency_key: randomUUID(),
    status: 'succeeded', created_at: ago(200), expires_at: new Date(Date.now() + 600_000).toISOString() }]);
  assert.equal((await admit(client, entry())).result_code, 'superseded-by-brake');
  assert.equal((await admit(client, manage({ entryOperationId: 'entry:t-trade-0001' }, 'close-position'))).result_code, 'superseded-by-brake');
  assert.equal((await admit(client, manage({ entryOperationId: 'entry:t-trade-0001' }, 'cancel-entry'))).result_code, 'inserted');
  await reset();
  await seed([{ user_id: USER, device_id: DEV1, command_type: 'disarm', payload: {}, idempotency_key: randomUUID(),
    status: 'succeeded', created_at: ago(1_000), expires_at: new Date(Date.now() + 600_000).toISOString() }]);
  assert.equal((await admit(client, entry())).result_code, 'inserted');
});

test('busy: vstup per UŽIVATEL přes zařízení; správa per obchod s rozestupem 2 s; visící claimed > 2 min neblokuje', async () => {
  await reset();
  const client = await connect();
  assert.equal((await admit(client, entry(), { device: DEV1 })).result_code, 'inserted');
  assert.equal((await admit(client, entry(), { device: DEV2 })).result_code, 'entry-busy');
  const tradeX = { entryOperationId: 'entry:t-trade-x001' };
  const tradeY = { leaderEntryOrderId: '123456789' };
  assert.equal((await admit(client, manage(tradeX))).result_code, 'inserted');
  assert.equal((await admit(client, manage(tradeX))).result_code, 'entry-busy');
  assert.equal((await admit(client, manage(tradeY))).result_code, 'inserted');
  await reset();
  await seed([{ user_id: USER, device_id: DEV1, command_type: 'copy-command', payload: entry(), idempotency_key: opId(),
    status: 'claimed', created_at: ago(121_000), expires_at: ago(106_000) }]);
  assert.equal((await admit(client, entry())).result_code, 'inserted');
  await reset();
  // Rozestup: dokončený vstup před 2,5 s blokuje, před 3,5 s už ne.
  await seed([{ user_id: USER, device_id: DEV1, command_type: 'copy-command', payload: entry(), idempotency_key: opId(),
    status: 'succeeded', created_at: ago(2_500), expires_at: new Date(Date.now() + 12_000).toISOString() }]);
  assert.equal((await admit(client, entry())).result_code, 'entry-busy');
  await reset();
  await seed([{ user_id: USER, device_id: DEV1, command_type: 'copy-command', payload: entry(), idempotency_key: opId(),
    status: 'succeeded', created_at: ago(3_500), expires_at: new Date(Date.now() + 11_000).toISOString() }]);
  assert.equal((await admit(client, entry())).result_code, 'inserted');
});

test('denní strop 100: 101. vstup odmítnut; zavření obchodu přes strop správy projde, posun SL ne; cizí uživatel se nepočítá', async () => {
  await reset();
  const client = await connect();
  const old = (payload, user = USER, device = DEV1) => ({ user_id: user, device_id: device, command_type: 'copy-command', payload,
    idempotency_key: payload.command.operationId, status: 'succeeded', created_at: ago(3_600_000), expires_at: ago(3_585_000) });
  await seed(Array.from({ length: 99 }, () => old(entry())));
  await seed(Array.from({ length: 5 }, () => old(entry(), OTHER, FOREIGN)));
  assert.equal((await admit(client, entry())).result_code, 'inserted');
  await admin.query(`update public.tradovate_copier_commands set created_at = now() - interval '1 hour', expires_at = now() - interval '59 minutes'`);
  assert.equal((await admit(client, entry())).result_code, 'entry-daily-cap');
  await seed(Array.from({ length: 100 }, () => old(manage({ entryOperationId: 'entry:t-trade-0099' }))));
  assert.equal((await admit(client, manage({ entryOperationId: 'entry:t-trade-0100' }, 'move-stop'))).result_code, 'entry-daily-cap');
  assert.equal((await admit(client, manage({ entryOperationId: 'entry:t-trade-0100' }, 'close-position'))).result_code, 'inserted');
});

test('force_generic_plan: obecný plán dává stejné výsledky (poučení 14. 10.)', async () => {
  await reset();
  const client = await connect();
  await client.query('set plan_cache_mode = force_generic_plan');
  for (let index = 0; index < 7; index += 1) {
    const row = await admit(client, entry(), { device: index % 2 ? DEV2 : DEV1 });
    assert.equal(row.result_code, index === 0 ? 'inserted' : 'entry-busy');
  }
  const operationId = opId();
  await reset();
  await admit(client, entry(operationId, 'hashgen01'));
  assert.equal((await admit(client, entry(operationId, 'hashgen01'))).result_code, 'existing');
  await client.query('reset plan_cache_mode');
});

test('oprávnění: authenticated ani anon funkci nevolají; search_path volajícího nic nemění', async () => {
  const client = await connect();
  for (const role of ['authenticated', 'anon']) {
    await client.query(`set role ${role}`);
    await assert.rejects(client.query(ADMIT, args(entry())), error => error.code === '42501');
    await client.query('reset role');
  }
  const settings = (await admin.query(`select proconfig, prosecdef from pg_proc where proname = 'admit_tradovate_copier_manual_command'`)).rows[0];
  assert.equal(settings.prosecdef, false);
  assert.deepEqual(settings.proconfig.sort(), ['lock_timeout=2s', 'search_path=""']);
});

// ---------------------------------------------------------------------------
// Brzda × admission: skutečně souběžné vložení, deterministicky přes držené
// transakce. Garantovaný výsledek: po supersede brzdy nezůstane čekající
// vstup s created_at ≤ brzda; pozdější vstup brzdu vidí (superseded) nebo
// leží ve FIFO za ní (worker: brake-after-request / not-armed).
const SUPERSEDE = 'select public.supersede_tradovate_copier_manual_commands($1, $2) as n';
const insertBrake = async (client, type = 'disarm', createdAt = new Date()) => (await client.query(`
  insert into public.tradovate_copier_commands (user_id, device_id, command_type, payload, idempotency_key, status, created_at, expires_at)
  values ($1, $2, $3, '{}'::jsonb, $4, 'pending', $5, $5::timestamptz + interval '10 minutes') returning id, created_at`,
  [USER, DEV1, type, randomUUID(), createdAt])).rows[0];
const statusOf = async id => (await admin.query('select status, error from public.tradovate_copier_commands where id = $1', [id])).rows[0];

test('brzda během rozběhnuté admission: supersede počká na zámek a čekající vstup zneplatní', async () => {
  await reset();
  const a = await connect();
  const c = await connect();
  await a.query('begin');
  const admitted = (await asServiceInTx(a, entry())).rows[0];
  assert.equal(admitted.result_code, 'inserted');
  const brake = await insertBrake(admin, 'kill-switch', new Date(Date.now() + 5));
  let superseded = false;
  const supersede = asService(c, SUPERSEDE, [USER, brake.id]).then(result => { superseded = true; return result.rows[0].n; });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(superseded, false, 'supersede musí čekat na commit admission');
  await a.query('commit');
  assert.equal(await supersede, 1);
  assert.deepEqual(await statusOf(admitted.id), { status: 'expired', error: 'superseded-by-brake' });
});

test('brzda vložená (necommitnutá) před admission: admission ji nevidí a vloží, supersede po commitu brzdy vstup zneplatní', async () => {
  await reset();
  const b = await connect();
  const a = await connect();
  await b.query('begin');
  const brake = (await b.query(`
    insert into public.tradovate_copier_commands (user_id, device_id, command_type, payload, idempotency_key, status, created_at, expires_at)
    values ($1, $2, 'disarm', '{}'::jsonb, $3, 'pending', now() + interval '50 milliseconds', now() + interval '10 minutes') returning id`,
  [USER, DEV1, randomUUID()])).rows[0];
  const admitted = await admit(a, entry());
  assert.equal(admitted.result_code, 'inserted');
  await b.query('commit');
  assert.equal((await asService(a, SUPERSEDE, [USER, brake.id])).rows[0].n, 1);
  assert.equal((await statusOf(admitted.id)).status, 'expired');
});

test('brzda commitnutá i zpracovaná před admission: admission vrátí superseded-by-brake, nic nevloží', async () => {
  await reset();
  const client = await connect();
  const brake = await insertBrake(admin, 'lock-until-session-end');
  assert.equal((await asService(client, SUPERSEDE, [USER, brake.id])).rows[0].n, 0);
  assert.equal((await admit(client, entry())).result_code, 'superseded-by-brake');
  assert.equal(await count(), 1);
});

test('vstup s created_at po brzdě (posun hodin) supersede přežije, ale ve FIFO leží až za brzdou', async () => {
  await reset();
  const client = await connect();
  const brake = await insertBrake(admin, 'disarm', new Date(Date.now() - 800));
  const admitted = await admit(client, entry());
  assert.equal(admitted.result_code, 'inserted');
  assert.equal((await asService(client, SUPERSEDE, [USER, brake.id])).rows[0].n, 0);
  const fifo = (await admin.query(`select id from public.tradovate_copier_commands where status = 'pending' order by created_at, id`)).rows.map(row => row.id);
  assert.deepEqual(fifo, [brake.id, admitted.id]);
});

test('supersede: zrušení vstupu zůstává, posun/zavření a vstup jdou pryč; jiný uživatel ani starší brzda se nedotknou; cizí brzda = RAISE', async () => {
  await reset();
  const client = await connect();
  const trade = { entryOperationId: 'entry:t-trade-sup1' };
  const ids = {};
  ids.entry = (await admit(client, entry())).id;
  ids.cancel = (await admit(client, manage(trade, 'cancel-entry'))).id;
  ids.close = (await admit(client, manage({ entryOperationId: 'entry:t-trade-sup2' }, 'close-position'))).id;
  await seed([{ user_id: OTHER, device_id: FOREIGN, command_type: 'copy-command', payload: entry(), idempotency_key: opId(),
    status: 'pending', created_at: ago(100), expires_at: new Date(Date.now() + 14_000).toISOString() }]);
  const brake = await insertBrake(admin, 'disarm', new Date(Date.now() + 5));
  assert.equal((await asService(client, SUPERSEDE, [USER, brake.id])).rows[0].n, 2);
  assert.equal((await statusOf(ids.entry)).status, 'expired');
  assert.equal((await statusOf(ids.close)).status, 'expired');
  assert.equal((await statusOf(ids.cancel)).status, 'pending');
  assert.equal(Number((await admin.query(`select count(*) from public.tradovate_copier_commands where user_id = $1 and status = 'pending'`, [OTHER])).rows[0].count), 1);
  await assert.rejects(asService(client, SUPERSEDE, [OTHER, brake.id]), /copier-supersede-brake-invalid/);
  await assert.rejects(asService(client, SUPERSEDE, [USER, ids.entry]), /copier-supersede-brake-invalid/);
});
