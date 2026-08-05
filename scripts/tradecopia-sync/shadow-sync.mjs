#!/usr/bin/env node
// Isolated Tradecopia raw/live shadow collector.
// Reads selected non-secret SQLite tables read-only and sends only changed rows
// plus the complete set of present keys to the dedicated shadow Edge Function.

import { execFileSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync,
  statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  assertSchemaCompatible, buildTableSnapshot, ENTITY_CONNECTION_COLUMNS, schemaHash,
  snapshotDigest, sqlSelectProjection,
} from './shadow-core.mjs';

const AGENT_VERSION = '1.1.0';
const CONFIG_DIR = join(homedir(), '.alphatrade');
const SHADOW_CONFIG_PATH = join(CONFIG_DIR, 'tradecopia-shadow-sync.json');
const LEGACY_CONFIG_PATH = join(CONFIG_DIR, 'tradecopia-sync.json');
const CONFIG_PATH = existsSync(SHADOW_CONFIG_PATH) ? SHADOW_CONFIG_PATH : LEGACY_CONFIG_PATH;
const STATE_PATH = join(CONFIG_DIR, 'tradecopia-shadow-state.json');
const LOG_PATH = join(CONFIG_DIR, 'tradecopia-shadow-sync.log');
const WATCH = process.argv.includes('--watch');
const DRY = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');
const RESCAN = process.argv.includes('--rescan');
const ACCEPT_SCHEMA = process.argv.includes('--accept-schema');
const intervalArg = process.argv.find(arg => arg.startsWith('--interval='));
const INTERVAL_MS = Math.max(2000, Number(intervalArg?.split('=')[1] || 5000));
const HEARTBEAT_MS = 60_000;

const TABLES = [
  { db: 'main', table: 'accounts', keyColumns: ['id'], accountColumn: 'id' },
  { db: 'main', table: 'cash_balances', keyColumns: ['account_id', 'id'], accountColumn: 'account_id' },
  { db: 'main', table: 'positions', keyColumns: ['account_id', 'id'], accountColumn: 'account_id' },
  { db: 'main', table: 'orders', keyColumns: ['id'], accountColumn: 'account_id' },
  { db: 'main', table: 'fills', keyColumns: ['id'] },
  { db: 'main', table: 'account_risk_statuses', keyColumns: ['account_id'], accountColumn: 'account_id' },
  { db: 'main', table: 'account_risk_configs', keyColumns: ['account_id'], accountColumn: 'account_id' },
  { db: 'main', table: 'order_strategies', keyColumns: ['id'], accountColumn: 'account_id' },
  { db: 'main', table: 'groups', keyColumns: ['id'] },
  { db: 'main', table: 'group_leader_accounts', keyColumns: ['id'] },
  { db: 'main', table: 'group_follower_accounts', keyColumns: ['id'] },
  { db: 'main', table: 'prop_firm_accounts', keyColumns: ['id'], accountColumn: 'trading_account_id' },
  {
    db: 'main',
    table: 'entities',
    sourceTable: 'entity_connections',
    keyColumns: ['id'],
    selectColumns: ENTITY_CONNECTION_COLUMNS,
  },
];

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(LOG_PATH, `${line}\n`);
  } catch { /* logging must not hide the original result */ }
}

function notifyFailure(message) {
  try {
    execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message.slice(0, 200))} with title "AlphaTrade shadow sync selhal"`]);
  } catch { /* no GUI */ }
}

function sqliteJson(dbPath, sql) {
  const output = execFileSync('sqlite3', ['-json', `file:${dbPath}?mode=ro`, sql], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  }).trim();
  return output ? JSON.parse(output) : [];
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeState(state) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tempPath = `${STATE_PATH}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, STATE_PATH);
}

function latestMtimeMs(path) {
  return Math.max(
    existsSync(path) ? statSync(path).mtimeMs : 0,
    existsSync(`${path}-wal`) ? statSync(`${path}-wal`).mtimeMs : 0,
  );
}

function endpointFor(edgeUrl) {
  const url = new URL(edgeUrl);
  url.pathname = url.pathname.replace(/\/import-trades\/?$/, '/tradecopia-shadow-ingest');
  return url.toString();
}

function anonKeyFor(config) {
  if (config.anonKey) return config.anonKey;
  if (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY) {
    return process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  }
  const envPath = new URL('../../.env.local', import.meta.url);
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, 'utf8').split(/\r?\n/)
      .find(value => value.trim().startsWith('VITE_SUPABASE_ANON_KEY='));
    if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  throw new Error('Chybí veřejný Supabase anon key pro gateway JWT ověření.');
}

async function postJson(url, token, anonKey, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      'x-import-token': token,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

function collect(config, state) {
  const logsPath = config.dbPath;
  const mainPath = logsPath.replace('tradecopia-desktop-logs.db', 'tradecopia-desktop.db');
  if (!existsSync(mainPath)) throw new Error(`Hlavní Tradecopia DB nenalezena: ${mainPath}`);
  const paths = { main: mainPath, logs: logsPath };
  const schemas = {};
  const tables = [];
  const nextHashes = {};
  const rowCounts = {};
  const tableDigests = {};
  let changedTotal = 0;

  for (const tableConfig of TABLES) {
    const dbPath = paths[tableConfig.db];
    const columns = sqliteJson(dbPath, `PRAGMA table_info("${tableConfig.table}");`);
    if (!columns.length) throw new Error(`Chybí povinná tabulka ${tableConfig.db}.${tableConfig.table}`);
    const columnNames = new Set(columns.map(column => column.name));
    for (const keyColumn of tableConfig.keyColumns) {
      if (!columnNames.has(keyColumn)) throw new Error(`Schema drift: ${tableConfig.table} nemá klíč ${keyColumn}`);
    }
    const selectedColumns = tableConfig.selectColumns ?? columns.map(column => column.name);
    for (const selectedColumn of selectedColumns) {
      if (!columnNames.has(selectedColumn)) throw new Error(`Schema drift: ${tableConfig.table} nemá bezpečný sloupec ${selectedColumn}`);
    }
    const sourceTable = tableConfig.sourceTable ?? tableConfig.table;
    const projection = sqlSelectProjection(selectedColumns);
    const rows = sqliteJson(dbPath, `SELECT ${projection} FROM "${tableConfig.table}";`);
    const tableKey = `${tableConfig.db}.${sourceTable}`;
    const selectedSet = new Set(selectedColumns);
    schemas[tableKey] = columns
      .filter(column => selectedSet.has(column.name))
      .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
    const snapshotConfig = { ...tableConfig, table: sourceTable };
    const snapshot = buildTableSnapshot(snapshotConfig, rows, RESCAN ? {} : (state.hashes?.[tableKey] || {}));
    nextHashes[tableKey] = snapshot.hashes;
    rowCounts[tableKey] = rows.length;
    tableDigests[tableKey] = snapshotDigest(snapshot.hashes);
    changedTotal += snapshot.changedRows.length;
    tables.push({
      source_db: tableConfig.db,
      source_table: sourceTable,
      present_keys: snapshot.presentKeys,
      rows: snapshot.changedRows,
    });
  }

  return {
    mainPath, logsPath, schemas, tables, nextHashes, rowCounts, tableDigests, changedTotal,
    schemaHash: schemaHash(schemas),
    mainDbMtimeMs: latestMtimeMs(mainPath),
    logsDbMtimeMs: latestMtimeMs(logsPath),
  };
}

async function runOnce(config, state) {
  const collected = collect(config, state);
  const anonKey = anonKeyFor(config);
  assertSchemaCompatible(state.schemaHash, collected.schemaHash, ACCEPT_SCHEMA);

  if (VERIFY) {
    const status = await postJson(endpointFor(config.edgeUrl), config.importToken, anonKey, { action: 'status' });
    const mismatches = [];
    for (const [table, localCount] of Object.entries(collected.rowCounts)) {
      const remoteCount = status.tables?.[table]?.present ?? 0;
      if (remoteCount !== localCount) mismatches.push(`${table}: local ${localCount}, remote ${remoteCount}`);
      const remoteDigest = status.tables?.[table]?.digest ?? null;
      if (remoteDigest !== collected.tableDigests[table]) mismatches.push(`${table}: obsahový hash se neshoduje`);
    }
    if (status.latest_run?.schema_hash !== collected.schemaHash) mismatches.push('schema_hash se neshoduje');
    const ageMs = status.latest_run?.completed_at ? Date.now() - new Date(status.latest_run.completed_at).getTime() : Infinity;
    if (ageMs > 120_000) mismatches.push(`poslední dokončený sync je starý ${Math.round(ageMs / 1000)} s`);
    if (mismatches.length) throw new Error(`VERIFY selhal: ${mismatches.join('; ')}`);
    log(`VERIFY OK — ${Object.keys(collected.rowCounts).length} tabulek, stáří ${Math.round(ageMs / 1000)} s, schema ${collected.schemaHash.slice(0, 12)}.`);
    return state;
  }

  const now = Date.now();
  const shouldSend = collected.changedTotal > 0 || !state.lastSuccessAt || now - state.lastSuccessAt >= HEARTBEAT_MS;
  if (DRY || !shouldSend) {
    log(`${DRY ? 'DRY-RUN' : 'Beze změny'} — ${Object.values(collected.rowCounts).reduce((sum, count) => sum + count, 0)} řádků, ${collected.changedTotal} změn, schema ${collected.schemaHash.slice(0, 12)}.`);
    return state;
  }

  const capturedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const result = await postJson(endpointFor(config.edgeUrl), config.importToken, anonKey, {
    run: {
      id: runId, agent_version: AGENT_VERSION, captured_at: capturedAt,
      main_db_mtime_ms: collected.mainDbMtimeMs,
      logs_db_mtime_ms: collected.logsDbMtimeMs,
      schema_hash: collected.schemaHash,
      schemas: collected.schemas,
      row_counts: collected.rowCounts,
    },
    tables: collected.tables,
  });
  const nextState = {
    version: 1,
    schemaHash: collected.schemaHash,
    hashes: collected.nextHashes,
    lastSuccessAt: now,
    lastRunId: result.run_id,
  };
  writeState(nextState);
  const remoteChanges = Object.values(result.changed_counts || {}).reduce((sum, counts) =>
    sum + Number(counts.inserted || 0) + Number(counts.updated || 0) + Number(counts.deleted || 0), 0);
  log(`OK — run ${runId}, kandidátů ${collected.changedTotal}, skutečných změn ${remoteChanges}, schema ${collected.schemaHash.slice(0, 12)}.`);
  return nextState;
}

if (!existsSync(CONFIG_PATH)) throw new Error(`Chybí konfigurace ${CONFIG_PATH}`);
const config = readJson(CONFIG_PATH, {});
for (const key of ['edgeUrl', 'importToken', 'dbPath']) if (!config[key]) throw new Error(`V konfiguraci chybí ${key}`);
let state = readJson(STATE_PATH, { version: 1, hashes: {} });

try {
  if (WATCH) {
    log(`Watch spuštěn — interval ${INTERVAL_MS} ms, ${TABLES.length} povolených tabulek.`);
    while (true) {
      state = await runOnce(config, state);
      await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
    }
  } else {
    state = await runOnce(config, state);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`FATAL: ${message}`);
  notifyFailure(message);
  process.exitCode = 1;
}
