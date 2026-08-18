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
  ) {
    throw new Error('Invalid file copier snapshot shape');
  }
  return JSON.parse(JSON.stringify({
    ...raw,
    bracketOutbox: raw.bracketOutbox ?? [],
    osoOutbox: raw.osoOutbox ?? [],
  })) as CopierSnapshot;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
