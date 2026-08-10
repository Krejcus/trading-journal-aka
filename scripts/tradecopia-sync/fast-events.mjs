#!/usr/bin/env node
// Low-latency TradeCopia event collector. It reads only an explicit safe
// projection from the local SQLite database and sends semantic, deduplicable
// events to AlphaTrade. It never sends OAuth tokens or personal profile data.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { deriveFastEvents } from './fast-event-core.mjs';

const AGENT_VERSION = '1.0.0';
const CONFIG_DIR = join(homedir(), '.alphatrade');
const CONFIG_PATH = join(CONFIG_DIR, 'tradecopia-fast-events.json');
const LEGACY_CONFIG_PATH = join(CONFIG_DIR, 'tradecopia-sync.json');
const STATE_PATH = join(CONFIG_DIR, 'tradecopia-fast-event-state.json');
const LOG_PATH = join(CONFIG_DIR, 'tradecopia-fast-events.log');
const DEFAULT_NOTIFY_URL = 'https://alphatrade-mentor-15.vercel.app/api/tradecopia-events';
const WATCH = process.argv.includes('--watch');
const DRY = process.argv.includes('--dry-run');
const RESET_BASELINE = process.argv.includes('--reset-baseline');
const intervalArg = process.argv.find(arg => arg.startsWith('--interval='));
const debounceArg = process.argv.find(arg => arg.startsWith('--debounce='));
const SAFETY_INTERVAL_MS = Math.max(500, Number(intervalArg?.split('=')[1] || 1000));
const DEBOUNCE_MS = Math.max(100, Number(debounceArg?.split('=')[1] || 450));

const readJson = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(LOG_PATH, `${line}\n`);
  } catch { /* logging must not hide collector failures */ }
}

function sqliteJson(dbPath, sql) {
  const output = execFileSync('sqlite3', ['-json', `file:${dbPath}?mode=ro`, sql], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }).trim();
  return output ? JSON.parse(output) : [];
}

function collect(mainPath) {
  return {
    accounts: sqliteJson(mainPath, 'SELECT id, entity_id, name, balance, realized_pn_l, week_realized_pn_l, updated_at FROM accounts;'),
    positions: sqliteJson(mainPath, 'SELECT id, account_id, net_pos, net_price, realized_pl, unrealized_pl, symbol, timestamp, updated_at FROM positions;'),
    orders: sqliteJson(mainPath, 'SELECT id, account_id, action, order_type, quantity, price, stop_price, status, placed_timestamp, updated_timestamp, order_strategy_id, group_tag, symbol, parent_id, linked_id, replicated_at, created_at, updated_at FROM orders;'),
    fills: sqliteJson(mainPath, 'SELECT id, order_id, timestamp, action, quantity, price, created_at, updated_at FROM fills;'),
    connections: sqliteJson(mainPath, 'SELECT id, name, status, organization, type, platform_id, is_connected, disconnected_at, disconnect_reason, updated_at FROM entities;'),
    feeds: sqliteJson(mainPath, 'SELECT id, account_id, connection_type, connection_status, update_interval, updated_at FROM feeds;'),
    groups: sqliteJson(mainPath, 'SELECT id, name, status, updated_at FROM groups;'),
    groupLeaders: sqliteJson(mainPath, 'SELECT id, group_id, account_name, updated_at FROM group_leader_accounts;'),
    groupFollowers: sqliteJson(mainPath, 'SELECT id, group_id, scale, account_name, replicate, replication_disable_reason, replicate_at_fill, updated_at FROM group_follower_accounts;'),
    riskStatuses: sqliteJson(mainPath, 'SELECT account_id, max_net_liq, admin_action, admin_action_reason, liquidate_only, updated_at FROM account_risk_statuses;'),
    autoLiquidations: sqliteJson(mainPath, 'SELECT account_id, trailing_max_drawdown, trailing_max_drawdown_limit, trailing_max_drawdown_mode, daily_loss_alert FROM user_account_auto_liqs;'),
  };
}

function databaseMtime(path) {
  return Math.max(
    existsSync(path) ? statSync(path).mtimeMs : 0,
    existsSync(`${path}-wal`) ? statSync(`${path}-wal`).mtimeMs : 0,
    existsSync(`${path}-shm`) ? statSync(`${path}-shm`).mtimeMs : 0,
  );
}

async function postEvents(config, events) {
  const response = await fetch(config.notifyUrl || DEFAULT_NOTIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-import-token': config.importToken },
    body: JSON.stringify({ agentVersion: AGENT_VERSION, capturedAt: new Date().toISOString(), events }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(`HTTP ${response.status}: ${result.error || 'notify-failed'}`);
  return result;
}

const config = readJson(existsSync(CONFIG_PATH) ? CONFIG_PATH : LEGACY_CONFIG_PATH, {});
for (const key of ['importToken', 'dbPath']) if (!config[key]) throw new Error(`V konfiguraci chybí ${key}`);
config.notifyUrl ||= process.env.TRADECOPIA_NOTIFY_URL || DEFAULT_NOTIFY_URL;
const mainPath = config.dbPath.replace('tradecopia-desktop-logs.db', 'tradecopia-desktop.db');
if (!existsSync(mainPath)) throw new Error(`TradeCopia databáze nenalezena: ${mainPath}`);

let state = readJson(STATE_PATH, null);
let lastMtime = databaseMtime(mainPath);

async function runOnce() {
  const snapshot = collect(mainPath);
  if (!state?.snapshot || RESET_BASELINE) {
    state = { version: 1, snapshot, capturedAt: new Date().toISOString() };
    if (!DRY) writePrivateJson(STATE_PATH, state);
    log(`Baseline připraven — ${snapshot.accounts.length} účtů, ${snapshot.positions.length} pozic, ${snapshot.orders.length} příkazů.`);
    return;
  }

  const events = deriveFastEvents(state.snapshot, snapshot);
  if (DRY) {
    log(`DRY-RUN — ${events.length} událostí: ${events.map(event => event.type).join(', ') || 'žádná'}.`);
    return;
  }
  if (events.length) {
    const result = await postEvents(config, events);
    log(`OK — ${events.length} událostí, ${Number(result.sent || 0)} push, ${Number(result.deduped || 0)} duplicit.`);
  }
  state = { version: 1, snapshot, capturedAt: new Date().toISOString() };
  writePrivateJson(STATE_PATH, state);
}

if (!WATCH) {
  await runOnce();
} else {
  log(`Fast event collector spuštěn — debounce ${DEBOUNCE_MS} ms, safety ${SAFETY_INTERVAL_MS} ms.`);
  let running = false;
  let pending = false;
  let timer = null;
  const execute = async () => {
    if (running) { pending = true; return; }
    running = true;
    try { await runOnce(); }
    catch (error) { log(`CHYBA: ${error instanceof Error ? error.message : String(error)}`); }
    finally {
      running = false;
      if (pending) { pending = false; schedule(); }
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void execute(); }, DEBOUNCE_MS);
  };
  const directory = dirname(mainPath);
  const filename = mainPath.split('/').at(-1);
  const watcher = watch(directory, (_event, changed) => {
    const name = changed ? String(changed) : '';
    if (name === filename || name === `${filename}-wal` || name === `${filename}-shm`) schedule();
  });
  const safety = setInterval(() => {
    const next = databaseMtime(mainPath);
    if (next > lastMtime) { lastMtime = next; schedule(); }
  }, SAFETY_INTERVAL_MS);
  process.on('SIGTERM', () => { watcher.close(); clearInterval(safety); process.exit(0); });
  process.on('SIGINT', () => { watcher.close(); clearInterval(safety); process.exit(0); });
  await execute();
}
