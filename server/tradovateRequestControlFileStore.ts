import { mkdir, open, readFile, rename, lstat, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TradovateRequestControlDurableState, TradovateRequestControlStore } from '../services/tradovateRequestControlGovernor';

function validate(value: unknown, brokerUserId: number): TradovateRequestControlDurableState {
  const row = value as TradovateRequestControlDurableState;
  if (!row || row.version !== 1 || row.brokerUserId !== brokerUserId || !Number.isFinite(row.savedAt) || !Number.isFinite(row.remainingMs) || row.remainingMs < 0
    || typeof row.captchaRequired !== 'boolean' || row.blockedUntil != null && !Number.isFinite(row.blockedUntil)
    || row.reason !== null && typeof row.reason !== 'string' || row.evidence !== null && !['raw-429', 'retry-after', 'p-time', 'captcha'].includes(row.evidence)) throw new Error('request-control-state-corrupt');
  return row;
}

/** Separate service-level state, never a group snapshot or token file. */
export function createTradovateRequestControlFileStore(serviceRoot: string): TradovateRequestControlStore {
  const root = resolve(serviceRoot, 'request-control');
  const path = (id: number) => { if (!Number.isSafeInteger(id) || id <= 0) throw new Error('request-control-broker-identity-missing'); return resolve(root, `broker-user-${id}.json`); };
  return {
    async load(id) {
      const file = path(id);
      try {
        const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('request-control-state-not-regular-file');
        return validate(JSON.parse(await readFile(file, 'utf8')), id);
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    async save(state) {
      validate(state, state.brokerUserId);
      const file = path(state.brokerUserId);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await chmod(dirname(file), 0o700);
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file); await chmod(file, 0o600);
      const directory = await open(dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
    },
  };
}
