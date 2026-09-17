// Standalone PostgreSQL regression: PGLITE_MODULE=/path/to/pglite/dist/index.js
// node --test tests/sql/journalImportLease.pg.mjs
// Isolated in-memory database; never connects to a broker or Supabase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');

const owner = '11111111-1111-4111-8111-111111111111';
const connection = '22222222-2222-4222-8222-222222222222';
const a = '33333333-3333-4333-8333-333333333333';
const b = '44444444-4444-4444-8444-444444444444';
const migration = await readFile(new URL('../../supabase/migrations/20260917190000_journal_import_lease.sql', import.meta.url), 'utf8');
const db = new PGlite();
await db.exec('create role anon; create role authenticated; create role service_role;');
await db.exec(migration);
const claim = async (holder, ttl = 120000) => (await db.query(
  'select public.claim_journal_import_lease($1,$2,$3,$4) as ok', [owner, connection, holder, ttl])).rows[0].ok;
const release = holder => db.query('select public.release_journal_import_lease($1,$2,$3)', [owner, connection, holder]);

test('one importer per connection: the second claim waits, the holder may re-claim', async () => {
  assert.equal(await claim(a), true);
  assert.equal(await claim(b), false);
  assert.equal(await claim(a), true);
});
test('only the holder can release; afterwards another importer takes over', async () => {
  await release(b);
  assert.equal(await claim(b), false);
  await release(a);
  assert.equal(await claim(b), true);
  await release(b);
});
test('an expired lease from a dead holder is taken over', async () => {
  assert.equal(await claim(a), true);
  await db.query('update public.tradovate_journal_import_leases set lease_until = now() - interval \'1 second\'');
  assert.equal(await claim(b), true);
  assert.equal(await claim(a), false);
  await release(b);
});
test('rejects an unbounded or missing ttl', async () => {
  await assert.rejects(claim(a, 500), /invalid-journal-lease/);
  await assert.rejects(claim(a, 600000), /invalid-journal-lease/);
  await assert.rejects(db.query('select public.claim_journal_import_lease($1,$2,null,120000)', [owner, connection]), /invalid-journal-lease/);
});
