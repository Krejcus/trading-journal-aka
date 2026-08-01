import { createHash } from 'node:crypto';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeIso(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function sourceKey(row, keyColumns) {
  return keyColumns.map(column => `${column}=${String(row[column] ?? '')}`).join('|');
}

export function buildTableSnapshot(config, rows, previousHashes = {}) {
  const presentKeys = [];
  const presentKeySet = new Set();
  const changedRows = [];
  const hashes = {};
  for (const row of rows) {
    const key = sourceKey(row, config.keyColumns);
    if (!key || presentKeySet.has(key)) throw new Error(`Neplatný nebo duplicitní klíč ${config.db}.${config.table}:${key}`);
    const hash = sha256Hex(canonicalJson(row));
    presentKeys.push(key);
    presentKeySet.add(key);
    hashes[key] = hash;
    if (previousHashes[key] !== hash) {
      const accountValue = config.accountColumn ? row[config.accountColumn] : null;
      changedRows.push({
        source_key: key,
        account_ext_id: accountValue != null && accountValue !== '' && Number.isFinite(Number(accountValue))
          ? Number(accountValue)
          : null,
        source_updated_at: normalizeIso(row.updated_at ?? row.timestamp ?? row.updated_timestamp ?? row.placed_timestamp),
        payload_hash: hash,
        payload: row,
      });
    }
  }
  return { presentKeys, changedRows, hashes };
}

export function schemaHash(schemas) {
  return sha256Hex(canonicalJson(schemas));
}

export function snapshotDigest(hashes) {
  return sha256Hex(JSON.stringify(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right))));
}

export function assertSchemaCompatible(previousHash, nextHash, acceptSchema = false) {
  if (previousHash && previousHash !== nextHash && !acceptSchema) {
    throw new Error(`Schema drift detekován (${previousHash.slice(0, 8)} → ${nextHash.slice(0, 8)}). Zkontroluj změny a spusť jednou s --accept-schema.`);
  }
}
