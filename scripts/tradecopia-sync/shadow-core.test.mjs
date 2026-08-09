import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSchemaCompatible, buildTableSnapshot, canonicalJson, ENTITY_CONNECTION_COLUMNS,
  normalizeIso, schemaHash, snapshotDigest, sourceKey, sqlSelectProjection,
} from './shadow-core.mjs';

test('canonical JSON is stable across object key order', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
});

test('source key supports composite primary keys', () => {
  assert.equal(sourceKey({ account_id: 12, id: 8 }, ['account_id', 'id']), 'account_id=12|id=8');
});

test('snapshot emits only changed rows while preserving all present keys', () => {
  const config = { db: 'main', table: 'accounts', keyColumns: ['id'], accountColumn: 'id' };
  const first = buildTableSnapshot(config, [{ id: 1, balance: 50_000 }, { id: 2, balance: 50_100 }]);
  const second = buildTableSnapshot(config, [{ id: 1, balance: 50_000 }, { id: 2, balance: 50_200 }], first.hashes);
  assert.deepEqual(second.presentKeys, ['id=1', 'id=2']);
  assert.equal(second.changedRows.length, 1);
  assert.equal(second.changedRows[0].source_key, 'id=2');
});

test('schema fingerprint changes when a column changes', () => {
  assert.notEqual(schemaHash({ accounts: [{ name: 'id' }] }), schemaHash({ accounts: [{ name: 'id' }, { name: 'balance' }] }));
});

test('invalid timestamps become null', () => {
  assert.equal(normalizeIso('not-a-date'), null);
  assert.equal(normalizeIso(null), null);
});

test('safe entity projection never selects OAuth or personal fields', () => {
  const projection = sqlSelectProjection(ENTITY_CONNECTION_COLUMNS);
  assert.match(projection, /"is_connected"/);
  assert.doesNotMatch(projection, /auth_token|email|address/i);
});

test('duplicate source keys fail instead of silently overwriting data', () => {
  const config = { db: 'main', table: 'accounts', keyColumns: ['id'], accountColumn: 'id' };
  assert.throws(
    () => buildTableSnapshot(config, [{ id: 1, balance: 50_000 }, { id: 1, balance: 50_100 }]),
    /duplicitní klíč/,
  );
});

test('snapshot digest is order independent and changes with any payload hash', () => {
  const first = snapshotDigest({ 'id=2': 'b'.repeat(64), 'id=1': 'a'.repeat(64) });
  assert.equal(first, snapshotDigest({ 'id=1': 'a'.repeat(64), 'id=2': 'b'.repeat(64) }));
  assert.notEqual(first, snapshotDigest({ 'id=1': 'a'.repeat(64), 'id=2': 'c'.repeat(64) }));
});

test('schema drift is fail-closed until explicitly accepted', () => {
  assert.doesNotThrow(() => assertSchemaCompatible('a'.repeat(64), 'a'.repeat(64)));
  assert.throws(() => assertSchemaCompatible('a'.repeat(64), 'b'.repeat(64)), /Schema drift detekován/);
  assert.doesNotThrow(() => assertSchemaCompatible('a'.repeat(64), 'b'.repeat(64), true));
});
