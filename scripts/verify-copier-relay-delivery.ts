/** Run against an isolated PGlite installation; never contacts Supabase/broker. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
if (!process.argv[2]) throw new Error('Pass the isolated verification dependency directory');
const require = createRequire(resolve(process.argv[2], 'package.json'));
const { PGlite } = require('@electric-sql/pglite');
const db = new PGlite();
const owner = randomUUID(), device = randomUUID(), otherDevice = randomUUID(), connection = randomUUID();
const snapshot = (armed: boolean, startedAt = '2026-09-13T10:00:00Z') => ({ startedAt, nonce: 'must-not-persist', controller: { armed } });
let checks = 0;
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users (id uuid primary key);
    create table public.tradovate_oauth_connections (id uuid primary key);
    create table public.tradovate_copier_devices (id uuid primary key, user_id uuid, connection_id uuid,
      environment text, revoked_at timestamptz);`);
  await db.exec(await readFile(new URL('../supabase/migrations/20260817180000_tradovate_copier_command_relay.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20260913154140_copier_relay_recoverable_delivery.sql', import.meta.url), 'utf8'));
  await db.query('insert into auth.users values ($1)', [owner]);
  await db.query('insert into tradovate_oauth_connections values ($1)', [connection]);
  await db.query("insert into tradovate_copier_devices values ($1,$2,$3,'demo',null),($4,$2,$3,'demo',null)", [device, owner, connection, otherDevice]);
  await db.exec('grant all on all tables in schema public to service_role; set role service_role');
  const enqueue = async (age = 0, state = 'pending') => {
    const id = randomUUID();
    await db.query(`insert into tradovate_copier_commands (id,user_id,device_id,connection_id,command_type,payload,idempotency_key,status,created_at,expires_at)
      values ($1::uuid,$2,$3,$4,'disarm','{}',$1::text,$5,now()-($6::int * interval '1 second'),now()+interval '30 seconds'-($6::int * interval '1 second'))`, [id, owner, device, connection, state, age]);
    return id;
  };
  const claim = async (delivery: string, target = device) => (await db.query('select * from claim_tradovate_copier_command_v2($1,$2)', [target, delivery])).rows;
  const heartbeat = async (revision: number, armed: boolean, startedAt?: string) => db.query('select heartbeat_tradovate_copier_v2($1,$2,$3)', [device, snapshot(armed, startedAt), revision]);
  const complete = async (id: string, delivery: string, revision = 3, result: unknown = { ok: true }, target = device) =>
    (await db.query('select complete_tradovate_copier_command_v2($1,$2,$3,$4,null,$5,$6) as accepted', [target, delivery, id, result, snapshot(false), revision])).rows[0].accepted;
  const legacyUnknown = await enqueue(0, 'claimed');
  const expired = await enqueue(60);
  const first = await enqueue(); const second = await enqueue(); const delivery = randomUUID();
  // Ties are ordered by UUID, so inspect the actual first reservation.
  const claimed = (await claim(delivery))[0]; assert.ok([first, second].includes(claimed.id)); checks++;
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => claim(delivery)));
  assert.ok(concurrent.every(rows => rows[0].id === claimed.id)); checks++;
  const remaining = (await claim(randomUUID()))[0]; assert.notEqual(remaining.id, claimed.id); checks++;
  const oldRows = (await db.query('select id,status,delivery_id from tradovate_copier_commands where id in ($1,$2)', [legacyUnknown, expired])).rows;
  assert.equal(oldRows.find((r: any) => r.id === legacyUnknown).status, 'claimed');
  assert.equal(oldRows.find((r: any) => r.id === legacyUnknown).delivery_id, null);
  assert.equal(oldRows.find((r: any) => r.id === expired).status, 'expired'); checks++;
  await heartbeat(1, true); assert.equal(await complete(claimed.id, delivery), true); checks++;
  const completedAt = (await db.query('select completed_at from tradovate_copier_commands where id=$1', [claimed.id])).rows[0].completed_at;
  assert.equal(await complete(claimed.id, delivery, 4), true);
  assert.deepEqual((await db.query('select completed_at from tradovate_copier_commands where id=$1', [claimed.id])).rows[0].completed_at, completedAt); checks++;
  assert.equal(await complete(claimed.id, delivery, 4, { ok: false }), false); checks++;
  assert.equal(await complete(claimed.id, delivery, 4, { ok: true }, otherDevice), false); checks++;
  assert.equal(await complete(claimed.id, randomUUID()), false); checks++;
  await heartbeat(2, true);
  let runtime = (await db.query('select status,relay_revision from tradovate_copier_device_runtime where device_id=$1', [device])).rows[0];
  assert.equal(runtime.status.controller.armed, false); assert.equal(runtime.relay_revision, 3); assert.equal(runtime.status.nonce, ''); checks++;
  await heartbeat(1, false, '2026-09-13T11:00:00Z'); await heartbeat(999, true);
  runtime = (await db.query('select status from tradovate_copier_device_runtime where device_id=$1', [device])).rows[0];
  assert.equal(runtime.status.controller.armed, false); checks++;
  assert.equal((await claim(delivery))[0].status, 'succeeded'); checks++;
  assert.equal(await complete(remaining.id, remaining.delivery_id), false); checks++;
  assert.equal((await db.query('select status from tradovate_copier_commands where id=$1', [remaining.id])).rows[0].status, 'claimed'); checks++;
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`reset role; set role ${role}`);
    await assert.rejects(claim(randomUUID()), /permission denied/); checks++;
    await assert.rejects(heartbeat(99, true), /permission denied/); checks++;
    await assert.rejects(complete(claimed.id, delivery), /permission denied/); checks++;
  }
  console.log(JSON.stringify({ checks, result: 'passed', engine: 'PGlite 0.5.8', note: 'SQL behavior and role checks; single-backend concurrency, not remote deployment proof' }));
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } finally { await db.close(); }
