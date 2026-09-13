/** Execute the actual owner-only source RPC locally, without remote traffic. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { readJournalSourceStatus } from '../services/journalSourceStatus';

if (!process.argv[2]) throw new Error('Pass isolated verification dependencies.');
const requireVerification = createRequire(resolve(process.argv[2], 'package.json'));
const { PGlite } = requireVerification('@electric-sql/pglite');
const db = new PGlite();
const root = fileURLToPath(new URL('../', import.meta.url));
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const connection = '33333333-3333-4333-8333-333333333333';
const live = '33333333-3333-4333-8333-333333333334';
const foreign = '33333333-3333-4333-8333-333333333335';
const device = '44444444-4444-4444-8444-444444444444';
const at = Date.parse('2026-09-10T13:30:00Z');
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, service_role;
    create table public.tradovate_oauth_connections(id uuid primary key, user_id uuid not null references auth.users, environment text not null);
    create table public.tradovate_copier_devices(id uuid primary key);
    alter table public.tradovate_oauth_connections enable row level security;
    revoke all on public.tradovate_oauth_connections from public, anon, authenticated;
    grant select on public.tradovate_oauth_connections to service_role;`);
  await db.query('insert into auth.users values ($1),($2)', [owner, other]);
  await db.query('insert into public.tradovate_oauth_connections values ($1,$2,\'demo\'),($3,$2,\'live\'),($4,$5,\'demo\')', [connection, owner, live, foreign, other]);
  await db.query('insert into public.tradovate_copier_devices values ($1)', [device]);
  for (const filename of ['20260912100450_tradovate_journal_evidence.sql', '20260912174837_journal_source_status.sql']) {
    await db.exec(await readFile(resolve(root, 'supabase/migrations', filename), 'utf8'));
  }
  let sequence = 0;
  const append = async (connectionId: string, environment: string, type: string, metadata: object, time = at, user = owner) => {
    sequence++;
    await db.query(`insert into public.tradovate_journal_evidence
      (user_id,connection_id,device_id,event_id,environment,session_id,sequence,entity_type,received_at,evidence)
      values($1,$2,$3,$4,$5,$3,$6,'journalbackfill',$7,$8::jsonb)`,
    [user, connectionId, device, String(sequence).padStart(64, '0'), environment, sequence, new Date(time).toISOString(),
      JSON.stringify({ entity: { entityType: type, ...metadata, secret: 'must-not-be-returned' } })]);
  };
  const observed = { kind: 'observed', startedAt: at - 500, completedAt: at, scanned: 12, recorded: 2, contended: 0, scope: 'available-list' };
  // Newer failure is inserted before an older success to exercise upload order.
  await append(connection, 'demo', 'orderversion', { kind: 'unavailable', startedAt: at - 500, completedAt: at });
  await append(connection, 'demo', 'orderversion', { ...observed, startedAt: at - 2500, completedAt: at - 2000 }, at - 2000);
  await append(connection, 'demo', 'fill', observed);
  await append(connection, 'demo', 'contract', { ...observed, scope: 'known-parents', requested: 100, remaining: 105 });
  await append(connection, 'live', 'fill', { ...observed, recorded: 11 }); // mismatched environment must not win
  await append(connection, 'demo', 'unknown', observed);
  await append(live, 'live', 'fill', { ...observed, scanned: 0, recorded: 0 });
  await append(foreign, 'demo', 'fill', observed, at, other);
  await db.exec('set role service_role');
  let verifiedOwner: string | null = owner;
  const rpc = (ids: string[] | null) => db.query('select public.read_journal_source_status($1::uuid,$2::uuid[]) as data', [verifiedOwner, ids]);
  const localClient = createClient('http://127.0.0.1:9915', 'fictional', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url, init) => {
      assert.equal(new URL(String(url)).pathname, '/rest/v1/rpc/read_journal_source_status');
      const args = JSON.parse(String(init?.body));
      return Response.json((await rpc(args.p_connection_ids)).rows[0].data);
    } },
  });
  const readBatch = async (ids: readonly string[], signal: AbortSignal) => {
    const { data, error } = await localClient.rpc('read_journal_source_status', { p_user_id: verifiedOwner, p_connection_ids: ids }).abortSignal(signal);
    if (error) throw error;
    return data;
  };
  const result = await readJournalSourceStatus(readBatch, owner, [connection, live], () => true);
  assert.equal(result.length, 2);
  const demo = result.find(row => row.connectionId === connection)!;
  assert.equal(demo.sources.length, 10);
  assert.equal(demo.sources.find(row => row.type === 'orderversion')!.metadata!.kind, 'unavailable');
  assert.equal(demo.sources.find(row => row.type === 'fill')!.metadata!.recorded, 2);
  assert.equal(demo.sources.find(row => row.type === 'fillfee')!.metadata, null);
  assert.equal(demo.sources.find(row => row.type === 'contract')!.metadata!.remaining, 105);
  assert.equal(result.find(row => row.connectionId === live)!.sources.find(row => row.type === 'fill')!.metadata!.scanned, 0);
  assert.ok(!JSON.stringify((await rpc([connection])).rows).includes('must-not-be-returned'));
  for (const scope of [[foreign], [connection, foreign], [connection, connection], [], null, [null], Array.from({ length: 26 }, () => connection)]) {
    await assert.rejects(rpc(scope as string[] | null), /journal-source-invalid-scope/);
  }
  verifiedOwner = other;
  await assert.rejects(rpc([connection]), /journal-source-invalid-scope/);
  assert.equal((await rpc([foreign])).rows[0].data.connections.length, 1);
  verifiedOwner = null;
  await assert.rejects(rpc([foreign]), /journal-source-invalid-scope/);
  await db.exec('set role anon');
  await assert.rejects(rpc([connection]), /permission denied/);
  await db.exec('set role authenticated');
  await assert.rejects(rpc([connection]), /permission denied/);
  await assert.rejects(db.query('select * from public.tradovate_oauth_connections'), /permission denied/);
  await db.exec('reset role');
  const security = (await db.query(`select p.prosecdef, p.provolatile, p.proconfig,
    has_function_privilege('anon',p.oid,'execute') as anon_execute,
    has_function_privilege('authenticated',p.oid,'execute') as browser_execute,
    has_function_privilege('service_role',p.oid,'execute') as server_execute
    from pg_proc p where p.oid='public.read_journal_source_status(uuid,uuid[])'::regprocedure`)).rows[0];
  assert.equal(security.prosecdef, false); assert.equal(security.provolatile, 's');
  assert.equal(security.anon_execute, false); assert.equal(security.browser_execute, false); assert.equal(security.server_execute, true);
  assert.ok(security.proconfig.includes('search_path=public, pg_temp'));
  console.log('PASS: actual SQL and owner client; 10 sources per connection; late uploads, environment, missing source, bounded scope, private fields, owner/anonymous isolation.');
} finally { await db.close(); }
