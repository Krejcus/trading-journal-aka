import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sanitizeCopyGroups, type CopyGroupConfig } from './liveCopyTrading';

export interface FileCopyGroupStore {
  load(): Promise<CopyGroupConfig | null>;
  save(group: CopyGroupConfig): Promise<void>;
}

/** Atomic local persistence for the operator-owned copier configuration. */
export function createFileCopyGroupStore(path: string): FileCopyGroupStore {
  const file = resolve(path);
  let tail: Promise<unknown> = Promise.resolve();
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
        const groups = sanitizeCopyGroups([parsed]);
        if (!groups || groups.length !== 1) throw new Error('Invalid persisted copy group');
        return groups[0];
      } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
      }
    },
    async save(group) {
      const normalized = sanitizeCopyGroups([group]);
      if (!normalized || normalized.length !== 1) throw new Error('Invalid persisted copy group');
      const operation = tail.then(() => writeAtomic(file, normalized[0]));
      tail = operation.catch(() => undefined);
      return operation;
    },
  };
}

async function writeAtomic(file: string, group: CopyGroupConfig): Promise<void> {
  const folder = dirname(file);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(group)}\n`, 'utf8');
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

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
