import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  CopierStoreConflictError,
  emptySnapshot,
  type CopierSnapshot,
  type CopierStore,
} from './copierStore';

/**
 * Lokální crash-safe store pro řízený pilot na jednom počítači.
 *
 * Zápis probíhá do vedlejšího souboru, následuje fsync a atomický rename.
 * Současně musí pilot držet process lock; tento store sám neslibuje CAS mezi
 * dvěma různými procesy. Produkční/VPS runtime používá databázový CAS store.
 */
export function createFileCopierStore(path: string): CopierStore {
  const file = resolve(path);
  let tail: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<CopierSnapshot> => {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
      return parseSnapshot(parsed);
    } catch (error) {
      if (isMissingFile(error)) return emptySnapshot();
      throw error;
    }
  };

  return {
    load,
    async commit(snapshot, expectedRevision) {
      const operation = tail.then(async () => {
        const stored = await load();
        if (stored.revision !== expectedRevision) {
          throw new CopierStoreConflictError(expectedRevision, stored.revision);
        }
        const next = parseSnapshot({ ...snapshot, revision: expectedRevision + 1 });
        await writeAtomic(file, next);
        return next;
      });
      tail = operation.catch(() => undefined);
      return operation;
    },
  };
}

async function writeAtomic(file: string, snapshot: CopierSnapshot): Promise<void> {
  const folder = dirname(file);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(snapshot)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  const directory = await open(folder, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function parseSnapshot(value: unknown): CopierSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid file copier snapshot');
  const raw = value as Partial<CopierSnapshot>;
  if (
    !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0
    || !Number.isSafeInteger(raw.lastSequence) || Number(raw.lastSequence) < 0
    || !Array.isArray(raw.replicated)
    || !Array.isArray(raw.outbox)
    || !Array.isArray(raw.cancelOutbox)
    || !Array.isArray(raw.links)
    || !Array.isArray(raw.leaderCumQty)
    || !Array.isArray(raw.followerFillTargets)
    || !validDayRuleSafety(raw.safety)
  ) {
    throw new Error('Invalid file copier snapshot shape');
  }
  return JSON.parse(JSON.stringify({
    ...raw,
    bracketOutbox: raw.bracketOutbox ?? [],
    osoOutbox: raw.osoOutbox ?? [],
  })) as CopierSnapshot;
}

const DAY_LOCK_TRIGGERS = new Set(['manual', 'daily-loss', 'losing-trades', 'max-trades', 'window-end']);
const DAILY_RULES = new Set(['daily-loss', 'losing-trades', 'max-trades', 'window-end']);

function validDayRuleSafety(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const safety = value as Record<string, unknown>;
  if (safety.dayLockTrigger != null && !DAY_LOCK_TRIGGERS.has(String(safety.dayLockTrigger))) return false;
  if (safety.dayLockAt != null
    && (typeof safety.dayLockAt !== 'number' || !Number.isFinite(safety.dayLockAt) || safety.dayLockAt < 0)) return false;
  if (safety.dayLockSnoozedRules != null) {
    if (!Array.isArray(safety.dayLockSnoozedRules)
      || !safety.dayLockSnoozedRules.every(trigger => DAY_LOCK_TRIGGERS.has(String(trigger)))
      || new Set(safety.dayLockSnoozedRules).size !== safety.dayLockSnoozedRules.length) return false;
  }
  if (safety.dayUnlock != null) {
    if (typeof safety.dayUnlock !== 'object' || Array.isArray(safety.dayUnlock)) return false;
    const unlock = safety.dayUnlock as Record<string, unknown>;
    if (typeof unlock.at !== 'number' || !Number.isFinite(unlock.at) || unlock.at < 0
      || typeof unlock.reason !== 'string' || unlock.reason.length < 3 || unlock.reason.length > 200
      || /[\u0000-\u001f\u007f]/.test(unlock.reason)) return false;
  }
  if (safety.dailyStats == null) return true;
  if (typeof safety.dailyStats !== 'object' || Array.isArray(safety.dailyStats)) return false;
  const stats = safety.dailyStats as Record<string, unknown>;
  if (stats.tradesToday != null
    && (!Number.isSafeInteger(stats.tradesToday) || Number(stats.tradesToday) < 0)) return false;
  if (stats.windowState != null
    && stats.windowState !== 'inside' && stats.windowState !== 'outside' && stats.windowState !== 'off') return false;
  if (stats.warnedRules == null) return true;
  if (!Array.isArray(stats.warnedRules)) return false;
  const rules = stats.warnedRules.map(warning => {
    if (!warning || typeof warning !== 'object' || Array.isArray(warning)) return null;
    const record = warning as Record<string, unknown>;
    return DAILY_RULES.has(String(record.rule))
      && typeof record.current === 'number' && Number.isFinite(record.current)
      && typeof record.limit === 'number' && Number.isFinite(record.limit)
      && typeof record.at === 'number' && Number.isFinite(record.at) && record.at >= 0
      ? String(record.rule)
      : null;
  });
  return rules.every(rule => rule != null) && new Set(rules).size === rules.length;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
