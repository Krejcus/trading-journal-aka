/**
 * Automatické doplňování archivu order flow (launchd jednou za hodinu, instaluje install-orderflow-sync.sh).
 * Každý běh:
 *   1. historie z Rithmicu pro dokončené obchodní dny posledních 2 týdnů, které na disku chybí —
 *      JEN KDYŽ SLUŽBA NEBĚŽÍ (stejné přihlášení; stahovač si bere zámek služby, druhé přihlášení by službu
 *      odhlásilo a ta se sama nepřipojí). Když služba běží, krok se přeskočí a zkusí se v dalším běhu;
 *   2. sestavení dnů (historie + soubory služby; den jen ze služby má přesné bubliny, objem kde běžela);
 *   3. nahrání změněných dnů do Supabase (účelový klíč z Klíčenky).
 * Nic z toho nezasahuje do běžící obchodní služby. Výstup jde do launchd logu.
 *
 *   node orderflow-sync.mjs [--dry-run]       (zabalené v ~/Library/Application Support/AlphaTrade/orderflow-sync)
 *   npx tsx scripts/rithmic/orderFlowArchiveSync.ts --config <config.json> [--dry-run]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nqFrontContract, tradeDatesBetween, tradingSession } from '../../services/orderFlowArchive';

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = arg('config') ?? join(HERE, 'config.json');
const DRY = process.argv.includes('--dry-run');
const WINDOW_DAYS = 14;
const SETTLE_MS = 10 * 60_000;

interface SyncConfig {
  system: string;
  user: string;
  supabaseUrl: string;
  anonKey: string;
  /** Složka, kam služba ukládá denní soubory order flow. */
  liveDir: string;
  /** Spouštěné skripty: zabalené .mjs vedle tohoto skriptu, nebo přes tsx z repa (ladění). */
  scripts?: { backfill: string[]; build: string[]; upload: string[] };
  log?: string;
}

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const say = (text: string) => console.log(`[${stamp()}] ${text}`);

const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as SyncConfig;
for (const key of ['system', 'user', 'supabaseUrl', 'anonKey', 'liveDir'] as const) if (!config[key]) { say(`chybí ${key} v ${CONFIG}`); process.exit(2); }
// Log nesmí růst donekonečna (launchd ho jen připojuje).
if (config.log && existsSync(config.log) && statSync(config.log).size > 2_000_000) { try { truncateSync(config.log, 0); } catch { /* nevadí */ } }

// Jeden běh najednou.
const BASE = join(homedir(), 'Library', 'Application Support', 'AlphaTrade', 'rithmic');
const runLock = join(BASE, 'orderflow-sync.lock');
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
try { const pid = Number(readFileSync(runLock, 'utf8')); if (Number.isInteger(pid) && pid > 0 && alive(pid)) { say(`předchozí běh ještě běží (${pid}) — končím`); process.exit(0); } } catch { /* zámek není */ }
writeFileSync(runLock, String(process.pid));
process.on('exit', () => { try { if (readFileSync(runLock, 'utf8') === String(process.pid)) rmSync(runLock); } catch { /* už není */ } });

/** Běží obchodní služba pro stejný systém a uživatele? (stejný zámek jako devTradeServer.ts) */
const serviceRunning = (): number | null => {
  const lock = join(BASE, `service-${Buffer.from(JSON.stringify([config.system, config.user])).toString('base64url')}.lock`);
  try { const pid = Number(readFileSync(lock, 'utf8').trim()); return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null; } catch { return null; }
};

const scripts = config.scripts ?? {
  backfill: [process.execPath, join(HERE, 'backfill.mjs')],
  build: [process.execPath, join(HERE, 'build.mjs')],
  upload: [process.execPath, join(HERE, 'upload.mjs')],
};
const run = (name: string, cmd: string[], args: string[], env: Record<string, string> = {}): number => {
  say(`${name}: ${args.join(' ')}`);
  if (DRY) return 0;
  const result = spawnSync(cmd[0], [...cmd.slice(1), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 45 * 60_000 });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(/\r/g, '\n').split('\n').filter((l) => l.trim() && !/ UTC: \d+ obchodů za /.test(l));
  for (const line of out.slice(-40)) console.log(`   ${line}`);
  if (result.error) say(`${name}: ${result.error.message}`);
  return result.status ?? 1;
};

// Dokončené obchodní dny okna, po kontraktech.
const now = Date.now();
const today = new Date(now).toISOString().slice(0, 10);
const from = new Date(now - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
const days = tradeDatesBetween(from, new Date(now + 86_400_000).toISOString().slice(0, 10))
  .filter((d) => tradingSession(d)[1] * 1_000 + SETTLE_MS < now);
const byContract = new Map<string, string[]>();
for (const d of days) { const c = nqFrontContract(d); byContract.set(c, [...(byContract.get(c) ?? []), d]); }
say(`dny ${days[0] ?? '—'} … ${days[days.length - 1] ?? '—'} (${days.length}), kontrakty ${[...byContract.keys()].join(', ') || '—'}, dnes ${today}`);

// 1. Historie z Rithmicu — jen chybějící dny a jen bez běžící služby.
const manifest = (() => { try { return JSON.parse(readFileSync(join(BASE, 'orderflow-raw', 'manifest.json'), 'utf8')) as Record<string, { complete?: boolean }>; } catch { return {}; } })();
const missing = days.filter((d) => !manifest[`${nqFrontContract(d)}/${d}`]?.complete);
const service = serviceRunning();
if (missing.length === 0) say('historie: všechny dny okna jsou stažené');
else if (service !== null) say(`historie: chybí ${missing.join(', ')} — služba běží (${service}), stáhne se, až nepoběží`);
else {
  for (const [contract, list] of byContract) {
    const need = list.filter((d) => missing.includes(d));
    if (need.length === 0) continue;
    const code = run('historie', scripts.backfill, ['--system', config.system, '--user', config.user, '--contract', contract, '--from', need[0], '--to', need[need.length - 1], '--max-requests', '400']);
    if (code !== 0) say(`historie ${contract}: skončila kódem ${code}`);
  }
}

// 2. Sestavení a 3. nahrání (pro všechny kontrakty okna).
for (const [contract, list] of byContract) {
  run('sestavení', scripts.build, ['--contract', contract, '--from', list[0], '--to', list[list.length - 1], '--live-dir', config.liveDir]);
}
const uploadCode = run('nahrání', scripts.upload, [], { ORDERFLOW_SUPABASE_URL: config.supabaseUrl, ORDERFLOW_SUPABASE_ANON_KEY: config.anonKey });
say(`hotovo${uploadCode === 0 ? '' : ` (nahrání skončilo kódem ${uploadCode})`}`);
