import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Rozhodování noční zálohy (scripts/backup/nightly.sh) s falešnou zálohou, falešným pmset a falešným časem.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const stamp = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function setup(options: { lastBackupHoursAgo: number | null; awake: boolean; hour: number; weekday: number; backupExit?: number; createsBackup?: boolean; force?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'nightly-'));
  dirs.push(dir);
  const scripts = join(dir, 'scripts');
  const root = join(dir, 'backups');
  mkdirSync(join(scripts, 'backup'), { recursive: true });
  mkdirSync(root, { recursive: true });
  cpSync('scripts/backup/nightly.sh', join(scripts, 'backup/nightly.sh'));
  cpSync('scripts/backup/lib.sh', join(scripts, 'backup/lib.sh'));
  if (options.lastBackupHoursAgo != null) mkdirSync(join(root, stamp(options.lastBackupHoursAgo)));
  // Falešná záloha: zapíše, že běžela, případně vytvoří novou zálohu, a skončí zadaným kódem.
  writeFileSync(join(scripts, 'backup-supabase.sh'), `#!/bin/bash\necho ran >> "${dir}/ran"\n${options.createsBackup === false ? '' : `mkdir -p "${root}/$(date -u +%Y%m%dT%H%M%SZ)"\n`}exit ${options.backupExit ?? 0}\n`);
  chmodSync(join(scripts, 'backup-supabase.sh'), 0o755);
  const pmset = join(dir, 'pmset');
  writeFileSync(pmset, `#!/bin/bash\necho "Current System Capabilities are: CPU ${options.awake ? 'Graphics Audio ' : ''}Network"\n`);
  chmodSync(pmset, 0o755);
  // Falešné date: jen pro hodinu a den v týdnu (nightly.sh i lib.sh se ptají na +%H, +%M, +%u); jinak skutečné.
  const date = join(dir, 'date');
  writeFileSync(date, `#!/bin/bash\ncase "$*" in\n  "+%H") echo ${String(options.hour).padStart(2, '0')} ;;\n  "+%M") echo 30 ;;\n  "+%u") echo ${options.weekday} ;;\n  *) exec /bin/date "$@" ;;\nesac\n`);
  chmodSync(date, 0o755);
  if (options.force) { mkdirSync(join(root, '.nightly-state'), { recursive: true }); writeFileSync(join(root, '.nightly-state/force-once'), ''); }
  const result = spawnSync('/bin/bash', [join(scripts, 'backup/nightly.sh')], {
    env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin`, BACKUP_ROOT: root, BACKUP_PMSET: pmset, BACKUP_DATE: date, BACKUP_NO_NOTIFY: '1' },
    encoding: 'utf8',
  });
  const runs = existsSync(join(root, 'nightly-runs.log')) ? readFileSync(join(root, 'nightly-runs.log'), 'utf8') : '';
  return { code: result.status, ran: existsSync(join(dir, 'ran')), runs, root };
}

describe.skipIf(process.platform !== 'darwin')('noční záloha: kdy se spustí', () => {
  it('v noci s Macem vzhůru a zálohou starou den se spustí a zapíše OK', () => {
    const t = setup({ lastBackupHoursAgo: 24, awake: true, hour: 3, weekday: 2 });
    expect(t.ran).toBe(true);
    expect(t.code).toBe(0);
    expect(t.runs).toMatch(/\tOK\t/);
  });
  it('dnešní záloha už je: hodinová kontrola skončí potichu', () => {
    const t = setup({ lastBackupHoursAgo: 5, awake: true, hour: 3, weekday: 2 });
    expect(t.ran).toBe(false);
    expect(t.runs).toBe('');
  });
  it('Mac jen krátce probuzený (DarkWake): záloha se nespustí, zapíše jeden SKIP', () => {
    const t = setup({ lastBackupHoursAgo: 30, awake: false, hour: 3, weekday: 2 });
    expect(t.ran).toBe(false);
    expect(t.runs).toMatch(/\tSKIP\tMac spí/);
  });
  it('mimo noc se nedohání dřív než po 26 h, pak ano (víkend, bez obchodní doby)', () => {
    expect(setup({ lastBackupHoursAgo: 22, awake: true, hour: 23, weekday: 6 }).ran).toBe(false);
    expect(setup({ lastBackupHoursAgo: 27, awake: true, hour: 10, weekday: 6 }).ran).toBe(true);
  });
  it('obchodní doba: dohání se až se zálohou starší než 44 h', () => {
    const waiting = setup({ lastBackupHoursAgo: 30, awake: true, hour: 10, weekday: 2 });
    expect(waiting.ran).toBe(false);
    expect(waiting.runs).toMatch(/\tSKIP\tobchodní doba/);
    expect(setup({ lastBackupHoursAgo: 50, awake: true, hour: 10, weekday: 2 }).ran).toBe(true);
  });
  it('spadlé spojení (kód 2 bez nové zálohy) je FAIL, ne „Storage neúplný“', () => {
    const t = setup({ lastBackupHoursAgo: 30, awake: true, hour: 4, weekday: 2, backupExit: 2, createsBackup: false });
    expect(t.ran).toBe(true);
    expect(t.runs).toMatch(/\tFAIL\tkód 2: spojení s databází spadlo/);
    const partial = setup({ lastBackupHoursAgo: 30, awake: true, hour: 4, weekday: 2, backupExit: 2 });
    expect(partial.runs).toMatch(/\tPARTIAL\t.*Storage neúplný/);
  });
  it('vynucený běh (--run-now) projde i s čerstvou zálohou a značku spotřebuje', () => {
    const t = setup({ lastBackupHoursAgo: 1, awake: true, hour: 15, weekday: 2, force: true });
    expect(t.ran).toBe(true);
    expect(existsSync(join(t.root, '.nightly-state/force-once'))).toBe(false);
  });
  it('žádná záloha zatím neexistuje: spustí se hned, jak je Mac vzhůru', () => {
    expect(setup({ lastBackupHoursAgo: null, awake: true, hour: 12, weekday: 7 }).ran).toBe(true);
  });
});
