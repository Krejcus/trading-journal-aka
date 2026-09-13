/** Isolated verification: pass a temporary directory containing pinned PGlite
 * and fake-indexeddb dependencies. No app credentials or remote DB are read. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournalEvidenceCache } from '../services/journalEvidenceCache';
import type { JournalEvidencePage, JournalFeedScope } from '../lib/journalEvidenceFeed';
import type { JournalEvidence } from '../lib/tradovateJournalEvidence';
import { createClient } from '@supabase/supabase-js';
import { readJournalEvidencePage } from '../server/journalEvidenceRead';

if (!process.argv[2]) throw new Error('Pass an isolated verification dependency directory.');
const requireVerification = createRequire(resolve(process.argv[2], 'package.json'));
const { PGlite } = requireVerification('@electric-sql/pglite');
const idb = requireVerification('fake-indexeddb');
const root = fileURLToPath(new URL('../', import.meta.url));
const db = new PGlite();
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const connection = '33333333-3333-4333-8333-333333333333';
const device = '44444444-4444-4444-8444-444444444444';
const scope: JournalFeedScope = { ownerId: owner, connectionId: connection, environment: 'demo' };
const event = (sequence: number): JournalEvidence => ({
  id: sequence.toString(16).padStart(64, '0'), entityType: 'fill', entity: { id: sequence, qty: 1, price: 20_000 },
  source: 'stream', eventType: 'Created', receivedAt: 1_000 + sequence, sequence,
  connectionId: connection, environment: 'demo', sessionId: '55555555-5555-4555-8555-555555555555',
});
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, service_role;
    create table public.tradovate_oauth_connections (id uuid primary key, user_id uuid not null references auth.users, environment text not null);
    create table public.tradovate_copier_devices (id uuid primary key, user_id uuid not null references auth.users,
      connection_id uuid not null references public.tradovate_oauth_connections, environment text not null, revoked_at timestamptz);
    grant all on public.tradovate_oauth_connections, public.tradovate_copier_devices to service_role;
  `);
  await db.query('insert into auth.users values ($1), ($2)', [owner, other]);
  await db.query('insert into public.tradovate_oauth_connections values ($1, $2, $3)', [connection, owner, 'demo']);
  await db.query('insert into public.tradovate_copier_devices values ($1, $2, $3, $4, null)', [device, owner, connection, 'demo']);
  for (const filename of ['20260912100450_tradovate_journal_evidence.sql', '20260912115949_journal_trade_projection.sql']) {
    await db.exec(await readFile(resolve(root, 'supabase/migrations', filename), 'utf8'));
  }
  await db.exec('set role service_role');
  const append = (events: JournalEvidence[], userId = owner) => db.query(
    'select public.append_tradovate_journal_evidence($1, $2, $3, $4::jsonb) as ack',
    [userId, connection, device, JSON.stringify(events)]);
  const rows = [event(1), event(2)];
  assert.deepEqual((await append(rows)).rows[0].ack, { accepted: true, ids: rows.map(row => row.id) });
  await append(rows);
  assert.equal((await db.query('select count(*)::int as count from public.tradovate_journal_evidence')).rows[0].count, 2);
  // Exercise the actual Supabase read query builder against local SQL. This
  // fetch implementation never opens a network connection.
  const localApi = createClient('http://127.0.0.1:9913', 'fictional-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input) => {
      const url = new URL(String(input));
      const table = url.pathname.split('/').at(-1)!;
      assert.ok(['tradovate_journal_evidence', 'tradovate_oauth_connections'].includes(table));
      const values: string[] = [];
      const conditions: string[] = [];
      for (const [key, value] of url.searchParams) {
        if (['select', 'order', 'limit'].includes(key)) continue;
        assert.ok(['id', 'user_id', 'connection_id', 'environment', 'ingest_id'].includes(key));
        const separator = value.indexOf('.');
        const operator = { eq: '=', gt: '>', lte: '<=' }[value.slice(0, separator)];
        assert.ok(operator); values.push(value.slice(separator + 1)); conditions.push(`${key} ${operator} $${values.length}`);
      }
      const columns = url.searchParams.get('select');
      assert.ok(['id', 'ingest_id,evidence'].includes(columns!));
      const order = url.searchParams.get('order');
      assert.ok(order == null || ['ingest_id.asc', 'ingest_id.desc'].includes(order));
      const limit = Number(url.searchParams.get('limit') ?? 1000); assert.ok(Number.isInteger(limit) && limit <= 1000);
      const sql = `select ${columns} from public.${table} where ${conditions.join(' and ')}${order ? ` order by ingest_id ${order.endsWith('desc') ? 'desc' : 'asc'}` : ''} limit ${limit}`;
      const response = await db.query(sql, values);
      return new Response(JSON.stringify(response.rows), { headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const readPage = await readJournalEvidencePage(localApi, scope, 0);
  assert.equal(readPage.hasMore, false); assert.equal(readPage.rows.length, 2);
  assert.deepEqual(readPage.rows.map(row => row.event.entity), rows.map(row => row.entity));
  assert.equal((await readJournalEvidencePage(localApi, scope, readPage.next)).rows.length, 0);
  await assert.rejects(readJournalEvidencePage(localApi, { ...scope, ownerId: other }, 0), /connection-not-found/);
  await assert.rejects(readJournalEvidencePage(localApi, scope, 0, readPage.through + 1), /invalid-journal-cursor/);
  await assert.rejects(append([event(3)], other), /invalid-journal-connection/);
  await assert.rejects(append([{ ...event(3), connectionId: '66666666-6666-4666-8666-666666666666' }]), /invalid-journal-connection/);
  await assert.rejects(append([{ ...event(2), id: 'f'.repeat(64) }]), /duplicate key/);
  // A later invalid event rolls back the whole batch, including its first row.
  await assert.rejects(append([event(3), { ...event(4), sequence: -1 }]), /check constraint/);
  assert.equal((await db.query('select count(*)::int as count from public.tradovate_journal_evidence')).rows[0].count, 2);
  await db.query('update public.tradovate_copier_devices set revoked_at = now() where id = $1', [device]);
  await assert.rejects(append([event(3)]), /invalid-journal-device/);
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [owner]);
  assert.equal((await db.query('select count(*)::int as count from public.tradovate_journal_evidence')).rows[0].count, 2);
  await assert.rejects(append([event(3)]), /permission denied/);
  await assert.rejects(db.query('delete from public.tradovate_journal_evidence'), /permission denied/);
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [other]);
  assert.equal((await db.query('select count(*)::int as count from public.tradovate_journal_evidence')).rows[0].count, 0);
  await db.exec('set role anon');
  await assert.rejects(db.query('select * from public.tradovate_journal_evidence'), /permission denied/);
  console.log('PASS: SQL creation, exact ACK, idempotency, owner/device scope, paged Supabase reads, revoked device, batch rollback, RLS and grants.');
} finally { await db.close(); }

Object.defineProperty(globalThis, 'indexedDB', { value: new idb.IDBFactory(), configurable: true });
Object.defineProperty(globalThis, 'IDBKeyRange', { value: idb.IDBKeyRange, configurable: true });
const cacheA = createJournalEvidenceCache();
const cacheB = createJournalEvidenceCache();
const page = (after: number, ids: number[], through: number, hasMore: boolean): JournalEvidencePage => ({
  scope, after, through, next: hasMore ? ids.at(-1)! : through, hasMore, rows: ids.map(cursor => ({ cursor, event: event(cursor) })),
});
await cacheA.commit(scope, page(0, [1], 2, true));
assert.deepEqual(await cacheA.snapshot(scope), { through: 0, events: [] });
await cacheB.commit(scope, page(1, [2], 2, false));
assert.deepEqual((await cacheA.snapshot(scope)).events, [event(1), event(2)]);
await assert.rejects(cacheA.commit(scope, page(0, [1], 2, true)), /concurrent-update/);
assert.deepEqual(await cacheA.snapshot({ ...scope, ownerId: other }), { through: 0, events: [] });
const originalPut = idb.IDBObjectStore.prototype.put;
idb.IDBObjectStore.prototype.put = function (value: { cursor?: number }, ...args: unknown[]) {
  if (this.name === 'events' && value.cursor === 4) throw new DOMException('Simulated quota failure', 'QuotaExceededError');
  return originalPut.call(this, value, ...args);
};
try { await assert.rejects(cacheA.commit(scope, page(2, [3, 4], 4, false)), /quota failure/); }
finally { idb.IDBObjectStore.prototype.put = originalPut; }
assert.deepEqual(await cacheB.checkpoint(scope), { next: 2, through: null, completeThrough: 2 });
assert.deepEqual((await cacheB.snapshot(scope)).events, [event(1), event(2)]);
await cacheA.commit(scope, page(2, [3, 4], 4, false));
assert.equal((await cacheB.snapshot(scope)).events.length, 4);
const race = await Promise.allSettled([cacheA.commit(scope, page(4, [5], 5, false)), cacheB.commit(scope, page(4, [5], 5, false))]);
assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
assert.equal(race.filter(result => result.status === 'rejected').length, 1);
assert.equal((await cacheA.snapshot(scope)).events.length, 5);
console.log('PASS: IndexedDB atomic page/cursor, withheld partial snapshot, two cache instances, owner isolation, quota rollback and retry.');
