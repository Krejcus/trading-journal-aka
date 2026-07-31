#!/usr/bin/env node
// Tradecopia → AlphaTrade sync agent.
//
// Čte read-only lokální SQLite Tradecopia desktopu (report_performance_history =
// round-trip obchody, report_order_history = ordery vč. SL/TP bracketů) a posílá
// nové řádky do Supabase edge funkce `import-trades`. Stav (poslední odeslaná id)
// drží v ~/.alphatrade/tradecopia-sync.json vedle import tokenu.
//
// Zásady:
//  - DB otevíráme VÝHRADNĚ read-only (file:...?mode=ro) přes sqlite3 CLI — žádné
//    npm závislosti, žádné zámky proti běžící Tradecopii.
//  - Interní schéma Tradecopie se může updatem změnit → každá SQL chyba je FATAL
//    a zobrazí macOS notifikaci. Tichá degradace je zakázaná.
//  - Idempotence: server dedupuje přes unique business key; při ztrátě stavu je
//    bezpečné poslat všechno znovu (viz --full).
//
// Použití:  node sync.mjs [--full] [--dry-run]

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_PATH = join(homedir(), '.alphatrade', 'tradecopia-sync.json');
const LOG_PATH = join(homedir(), '.alphatrade', 'tradecopia-sync.log');
const BATCH = 2000;
const FULL = process.argv.includes('--full');
const DRY = process.argv.includes('--dry-run');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(join(homedir(), '.alphatrade'), { recursive: true });
    appendFileSync(LOG_PATH, line + '\n');
  } catch { /* logging must never kill the sync */ }
}

function notifyFailure(msg) {
  try {
    execFileSync('osascript', ['-e',
      `display notification ${JSON.stringify(msg.slice(0, 200))} with title "AlphaTrade sync selhal"`]);
  } catch { /* headless session without UI */ }
}

function fatal(msg) {
  log(`FATAL: ${msg}`);
  notifyFailure(msg);
  process.exit(1);
}

function sqliteJson(dbPath, sql) {
  // mode=ro: nikdy nezamkne ani nezmutuje DB běžící Tradecopie
  const out = execFileSync('sqlite3', ['-json', `file:${dbPath}?mode=ro`, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const trimmed = out.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

// ── Config ──
if (!existsSync(CONFIG_PATH)) fatal(`Chybí konfigurace ${CONFIG_PATH}`);
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
for (const key of ['edgeUrl', 'importToken', 'dbPath']) {
  if (!config[key]) fatal(`V konfiguraci chybí "${key}"`);
}
if (!existsSync(config.dbPath)) fatal(`Tradecopia DB nenalezena: ${config.dbPath}`);

const lastTradeId = FULL ? 0 : (config.lastTradeId || 0);
const lastOrderId = FULL ? 0 : (config.lastOrderId || 0);

// Levná zkratka: Tradecopia zapisuje reporty jen při syncu (párkrát denně), takže
// beze změny mtime nemá smysl otevírat SQLite ani skenovat řádky. Heartbeat se
// pošle dál — UI potřebuje vědět, že agent žije.
// Hlavní DB (vedle logs DB) drží názvy aktuálně připojených účtů — report
// tabulky je nemají. Odpojené/staré účty název nemají nikde (zbyl jen broker id).
const mainDbPath = config.dbPath.replace('tradecopia-desktop-logs.db', 'tradecopia-desktop.db');
const dbMtime = statSync(config.dbPath).mtimeMs;
const accountsDbMtime = existsSync(mainDbPath) ? statSync(mainDbPath).mtimeMs : 0;
const dbUnchanged = !FULL
  && config.lastDbMtime === dbMtime
  && config.lastAccountsDbMtime === accountsDbMtime;

// ── Read new rows (schema drift = loud failure) ──
let trades = [], orders = [], accountNames = [], accounts = [];
try {
  if (existsSync(mainDbPath)) {
    accounts = sqliteJson(mainDbPath, `SELECT id AS account_id, name, entity_id FROM accounts;`);
  }
} catch (e) {
  // Názvy jsou nice-to-have — jejich výpadek nesmí zastavit import obchodů.
  log(`WARN: čtení názvů účtů selhalo: ${e.message}`);
}
if (dbUnchanged) {
  try {
    await fetch(config.edgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-import-token': config.importToken },
      body: JSON.stringify({ trades: [], orders: [], accounts }),
    });
  } catch { /* heartbeat je best-effort */ }
  log('DB beze změny — jen heartbeat.');
  process.exit(0);
}

try {
  trades = sqliteJson(config.dbPath, `
    SELECT id, entity_id, account_id, symbol, qty, buy_price, sell_price, pnl,
           bought_timestamp, sold_timestamp, duration, platform, pair_id
    FROM report_performance_history
    WHERE id > ${Number(lastTradeId)}
    ORDER BY id
    LIMIT ${BATCH};`);
  orders = sqliteJson(config.dbPath, `
    SELECT id, entity_id, account_id, account_name, broker_order_id, symbol, side,
           order_type, quantity, filled_qty, price, stop_price, avg_fill_price,
           status, platform, placed_at
    FROM report_order_history
    WHERE id > ${Number(lastOrderId)}
    ORDER BY id
    LIMIT ${BATCH};`);
  accountNames = sqliteJson(config.dbPath, `
    SELECT DISTINCT account_id, account_name FROM report_order_history
    WHERE account_name IS NOT NULL;`);
} catch (e) {
  fatal(`SQLite čtení selhalo (změna schématu po updatu Tradecopie?): ${e.message}`);
}
if (trades.length === 0 && orders.length === 0) {
  // Heartbeat: server si poznamená last_used_at (UI vidí, že agent žije) a
  // z accounts aktualizuje, které účty jsou v Tradecopii stále připojené.
  try {
    await fetch(config.edgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-import-token': config.importToken },
      body: JSON.stringify({ trades: [], orders: [], accounts }),
    });
  } catch { /* heartbeat je best-effort */ }
  config.lastDbMtime = dbMtime;
  config.lastAccountsDbMtime = accountsDbMtime;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  log('Nic nového (heartbeat odeslán).');
  process.exit(0);
}

// Performance history nemá account_name — doplň primárně z hlavní accounts
// tabulky (aktuální účty), sekundárně z order history mapy (historie).
const nameByAccount = new Map(accountNames.map(a => [a.account_id, a.account_name]));
for (const a of accounts) if (a.name) nameByAccount.set(a.account_id, a.name);
for (const t of trades) t.account_name = nameByAccount.get(t.account_id) || null;

log(`Odesílám ${trades.length} obchodů, ${orders.length} orderů (od trade id ${lastTradeId}, order id ${lastOrderId})…`);
if (DRY) {
  log('Dry-run — nic neodesláno.');
  process.exit(0);
}

// ── Push to edge function ──
let result;
try {
  const res = await fetch(config.edgeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-import-token': config.importToken,
    },
    body: JSON.stringify({ trades, orders, accounts }),
  });
  result = await res.json().catch(() => ({}));
  if (!res.ok || !result.ok) fatal(`Server odmítl import (HTTP ${res.status}): ${JSON.stringify(result)}`);
} catch (e) {
  fatal(`Odeslání selhalo: ${e.message}`);
}

// ── Persist state only AFTER successful upload ──
config.lastTradeId = trades.length ? trades[trades.length - 1].id : config.lastTradeId || 0;
config.lastOrderId = orders.length ? orders[orders.length - 1].id : config.lastOrderId || 0;
// mtime ulož jen když je dávka dojetá — jinak by zbytek řádků čekal na další zápis do DB.
if (trades.length < BATCH && orders.length < BATCH) config.lastDbMtime = dbMtime;
config.lastAccountsDbMtime = accountsDbMtime;
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

log(`OK — server upsertnul ${result.trades_upserted} obchodů, ${result.orders_upserted} orderů. Stav: trade id ${config.lastTradeId}, order id ${config.lastOrderId}.`);

// Batch plný → další dávka hned (launchd interval nečekáme). Stav už je uložený,
// takže pokračování NIKDY nejede s --full (to by resetovalo id na 0 a zacyklilo se).
if (trades.length === BATCH || orders.length === BATCH) {
  log('Plná dávka — pokračuji další dávkou…');
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [process.argv[1]], { stdio: 'inherit' });
  process.exit(r.status || 0);
}
