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
  // Spadlý test s drženou transakcí nesmí zaseknout ostatní (truncate by čekal navždy).
  await client.query(`set idle_in_transaction_session_timeout = '5s'`);
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
      delivery_id uuid,
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
// Brzda × admission × claim_v2: skutečně souběžně, deterministicky přes držené
// transakce. Brzda (insert + supersede) je jeden commit pod zámkem admission;
// claim_v2 vydá čekající brzdu přednostně.
const BRAKE = `select * from public.enqueue_tradovate_copier_brake($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`;
const brakeArgs = (type = 'disarm', key = randomUUID(), now = new Date(), device = DEV1, connection = CONN, user = USER) =>
  [user, device, connection, type, '{}', key, now, new Date(now.getTime() + 600_000)];
const brake = async (client, ...rest) => (await asService(client, BRAKE, brakeArgs(...rest))).rows[0];
const CLAIM = 'select * from public.claim_tradovate_copier_command_v2($1, $2)';
const claim = async (client, device = DEV1) => (await asService(client, CLAIM, [device, randomUUID()])).rows[0] ?? null;
const statusOf = async id => (await admin.query('select status, error from public.tradovate_copier_commands where id = $1', [id])).rows[0];
const rawBrake = async (type = 'disarm', createdAt = new Date()) => (await admin.query(`
  insert into public.tradovate_copier_commands (user_id, device_id, command_type, payload, idempotency_key, status, created_at, expires_at)
  values ($1, $2, $3, '{}'::jsonb, $4, 'pending', $5, $5::timestamptz + interval '10 minutes') returning id`,
  [USER, DEV1, type, randomUUID(), createdAt])).rows[0];

test('brzda během rozběhnuté admission: počká na zámek, pak čekající vstup zneplatní v témže commitu', async () => {
  await reset();
  const a = await connect();
  const b = await connect();
  await a.query('begin');
  const admitted = (await asServiceInTx(a, entry())).rows[0];
  let done = false;
  const pending = brake(b, 'kill-switch', randomUUID(), new Date(Date.now() + 5)).then(row => { done = true; return row; });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(done, false, 'brzda musí čekat na commit admission');
  await a.query('commit');
  const row = await pending;
  assert.equal(row.result_code, 'inserted');
  assert.equal(row.superseded_manual, 1);
  assert.deepEqual(await statusOf(admitted.id), { status: 'expired', error: 'superseded-by-brake' });
});

test('P0: claim_v2 souběžně s brzdou — dokud brzda necommitne, starší vstup nejde vyzvednout; po commitu přijde brzda, vstup je pryč', async () => {
  await reset();
  const a = await connect();
  const b = await connect();
  const w = await connect();
  const admitted = await admit(a, entry());
  assert.equal(admitted.result_code, 'inserted');
  await b.query('begin');
  await b.query('set local role service_role');
  const held = (await b.query(BRAKE, brakeArgs('disarm', randomUUID(), new Date(Date.now() + 5)))).rows[0];
  assert.equal(held.superseded_manual, 1);
  // Brzda i supersede jsou v jedné necommitnuté transakci: řádek vstupu je zamčený
  // (SKIP LOCKED ho přeskočí) a brzda ještě není vidět → worker nedostane nic.
  assert.equal(await claim(w), null);
  await b.query('commit');
  const first = await claim(w);
  assert.equal(first.id, held.id);
  assert.equal(first.command_type, 'disarm');
  assert.equal(await claim(w), null);
  assert.deepEqual(await statusOf(admitted.id), { status: 'expired', error: 'superseded-by-brake' });
});

test('claim_v2 drží starší vstup (vyzvednut DŘÍV, než brzda vznikla): brzda počká na jeho commit a claimed nezmění', async () => {
  await reset();
  const a = await connect();
  const b = await connect();
  const w = await connect();
  const admitted = await admit(a, entry());
  await w.query('begin');
  await w.query('set local role service_role');
  const claimed = (await w.query(CLAIM, [DEV1, randomUUID()])).rows[0];
  assert.equal(claimed.id, admitted.id);
  let done = false;
  const pending = brake(b, 'disarm', randomUUID(), new Date(Date.now() + 5)).then(row => { done = true; return row; });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(done, false, 'supersede čeká na zámek řádku, který claim drží');
  await w.query('commit');
  const row = await pending;
  assert.equal(row.superseded_manual, 0);
  assert.equal((await statusOf(admitted.id)).status, 'claimed'); // vykoná worker; brzda je ve frontě hned za ním
});

test('priorita brzd v claim_v2: brzda vložená mimo RPC (záloha) se vydá před starším čekajícím vstupem i ARMem', async () => {
  await reset();
  const a = await connect();
  const w = await connect();
  await seed([{ user_id: USER, device_id: DEV1, command_type: 'arm-live', payload: {}, idempotency_key: randomUUID(),
    status: 'pending', created_at: ago(300), expires_at: new Date(Date.now() + 30_000).toISOString() }]);
  const admitted = await admit(a, entry());
  const fallback = await rawBrake('lock-until-session-end', new Date(Date.now() + 5));
  assert.equal((await claim(w)).id, fallback.id);
  const next = await claim(w);
  assert.equal(next.command_type, 'arm-live'); // ostatní dál FIFO
  assert.equal((await claim(w)).id, admitted.id);
});

test('priorita: starší risk-redukční Flatten (follower do konce obchodu) zůstane PŘED novější brzdou; brzda před starším nerisk-redukčním', async () => {
  await reset();
  const w = await connect();
  const row = (type, inner, createdAt) => ({ user_id: USER, device_id: DEV1, command_type: type,
    payload: inner ? { command: inner } : {}, idempotency_key: randomUUID(), status: 'pending',
    created_at: createdAt, expires_at: new Date(Date.now() + 30_000).toISOString() });
  await seed([
    row('copy-command', { type: 'update-group' }, ago(400)),
    row('copy-command', { type: 'flatten-follower-trade', groupId: 'g', accountId: 200 }, ago(300)),
    row('copy-command', { type: 'flatten-account', groupId: 'g', accountId: 300 }, ago(250)),
    row('copy-command', null, ago(500)), // bez command.type: výraz řazení NULL nesmí předběhnout brzdu
  ]);
  const late = await rawBrake('disarm', new Date(Date.now() - 100));
  const order = [];
  for (let next = await claim(w); next; next = await claim(w)) order.push(next.command_type === 'copy-command' ? (next.payload.command?.type ?? 'copy-command:?') : next.command_type);
  assert.deepEqual(order, ['flatten-follower-trade', 'flatten-account', 'disarm', 'copy-command:?', 'update-group']); // bez typu = běžná FIFO
  assert.ok(late.id);
});

test('brzda: superseduje ARM/SHADOW téhož zařízení a ruční příkazy celého uživatele; cancel-entry, novější vstup a cizí uživatel zůstávají', async () => {
  await reset();
  const client = await connect();
  const arm = (k, device = DEV1, type = 'arm-live') => ({ user_id: USER, device_id: device, command_type: type, payload: {}, idempotency_key: k,
    status: 'pending', created_at: ago(200), expires_at: new Date(Date.now() + 30_000).toISOString() });
  await seed([arm(randomUUID()), arm(randomUUID(), DEV1, 'shadow'), arm(randomUUID(), DEV2)]);
  const ids = {};
  ids.entry = (await admit(client, entry(), { device: DEV2 })).id;
  ids.cancel = (await admit(client, manage({ entryOperationId: 'entry:t-trade-sup1' }, 'cancel-entry'))).id;
  ids.close = (await admit(client, manage({ entryOperationId: 'entry:t-trade-sup2' }, 'close-position'))).id;
  await seed([{ user_id: OTHER, device_id: FOREIGN, command_type: 'copy-command', payload: entry(), idempotency_key: opId(),
    status: 'pending', created_at: ago(100), expires_at: new Date(Date.now() + 14_000).toISOString() }]);
  const row = await brake(client, 'disarm', randomUUID(), new Date(Date.now() + 5));
  assert.equal(row.superseded_arms, 2);
  assert.equal(row.superseded_manual, 2);
  assert.equal((await statusOf(ids.entry)).status, 'expired');
  assert.equal((await statusOf(ids.close)).status, 'expired');
  assert.equal((await statusOf(ids.cancel)).status, 'pending');
  const remaining = (await admin.query(`select command_type, device_id from public.tradovate_copier_commands where status = 'pending' and command_type = 'arm-live'`)).rows;
  assert.deepEqual(remaining, [{ command_type: 'arm-live', device_id: DEV2 }]);
  assert.equal(Number((await admin.query(`select count(*) from public.tradovate_copier_commands where user_id = $1 and status = 'pending'`, [OTHER])).rows[0].count), 1);
  // Vstup s created_at po brzdě (posun hodin) přežije, ale ve FIFO leží až za ní.
  await reset();
  const early = await rawBrake('disarm', new Date(Date.now() - 800));
  const later = await admit(client, entry());
  assert.equal(later.result_code, 'inserted');
  assert.equal((await claim(await connect())).id, early.id);
});

test('brzda idempotentně: stejný klíč = existing (jeden řádek, supersede znovu bez škody); jiný typ se stejným klíčem = RAISE', async () => {
  await reset();
  const client = await connect();
  const key = randomUUID();
  const first = await brake(client, 'disarm', key);
  const again = await brake(client, 'disarm', key);
  assert.equal(first.result_code, 'inserted');
  assert.equal(again.result_code, 'existing');
  assert.equal(again.id, first.id);
  assert.equal(await count(), 1);
  await assert.rejects(brake(client, 'kill-switch', key), /copier-brake-idempotency-conflict/);
});

test('brzda: RAISE na neplatné argumenty a nesourodé zařízení; hodiny NEověřuje (brzda nesmí selhat na posunu hodin)', async () => {
  await reset();
  const client = await connect();
  await assert.rejects(brake(client, 'arm-live'), /copier-brake-invalid-arguments/);
  await assert.rejects(brake(client, 'disarm', randomUUID(), new Date(), DEV_CONN2), /copier-brake-device-invalid/);
  await assert.rejects(brake(client, 'disarm', randomUUID(), new Date(), REVOKED), /copier-brake-device-invalid/);
  assert.equal((await brake(client, 'disarm', randomUUID(), new Date(Date.now() - 60_000))).result_code, 'inserted');
});

test('brzda: cizí connection a cizí user = RAISE connection-invalid, nic se nezapíše (devices.connection_id je od 20261004120000 nullable, vlastnictví negarantuje)', async () => {
  await reset();
  const client = await connect();
  // Cizí user s připojením pravého vlastníka: zastaví ho už kontrola připojení.
  await assert.rejects(brake(client, 'disarm', randomUUID(), new Date(), DEV1, CONN, OTHER), /copier-brake-connection-invalid/);
  // Chyba párování: zařízení uživatele ukazuje na CIZÍ connection. Kontrola na
  // devices by prošla — zastavit to musí vlastnictví tradovate_oauth_connections.
  const BUGGED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9';
  await admin.query(`insert into public.tradovate_copier_devices values ('${BUGGED}', '${USER}', '${FOREIGN_CONN}', null)`);
  try {
    await assert.rejects(brake(client, 'disarm', randomUUID(), new Date(), BUGGED, FOREIGN_CONN), /copier-brake-connection-invalid/);
  } finally {
    await admin.query(`delete from public.tradovate_copier_devices where id = '${BUGGED}'`);
  }
  assert.equal(await count(), 0);
  // Vlastní druhé připojení se správně spárovaným zařízením dál projde.
  assert.equal((await brake(client, 'disarm', randomUUID(), new Date(), DEV_CONN2, CONN2)).result_code, 'inserted');
});

test('brzda při držené admission déle než 500 ms: lock timeout (relay pak jde zálohou), nic nevloží', async () => {
  await reset();
  const a = await connect();
  const b = await connect();
  await a.query('begin');
  await asServiceInTx(a, entry());
  await assert.rejects(brake(b, 'disarm'), error => error.code === '55P03');
  await a.query('rollback');
  assert.equal(await count(), 0);
});

test('oprávnění brzdového RPC a claim_v2: authenticated/anon nevolají; claim_v2 má jen změněné řazení', async () => {
  const client = await connect();
  for (const role of ['authenticated', 'anon']) {
    await client.query(`set role ${role}`);
    await assert.rejects(client.query(BRAKE, brakeArgs()), error => error.code === '42501');
    await client.query('reset role');
  }
  const def = (await admin.query(`select pg_get_functiondef('public.claim_tradovate_copier_command_v2(uuid, uuid)'::regprocedure) as d`)).rows[0].d;
  assert.match(def, /'flatten-account', 'flatten-group', 'flatten-follower-trade'\)\), false\) DESC,\s+created_at, id/i);
});
