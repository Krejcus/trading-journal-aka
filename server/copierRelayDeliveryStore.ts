import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface RelayDelivery {
  version: 1;
  session: string;
  deliveryId: string;
  phase: 'polling' | 'executing' | 'completed';
  commandId?: string;
  result?: unknown;
  error?: string;
}
export interface RelayDeliveryStore {
  read(): Promise<RelayDelivery | null>;
  write(value: RelayDelivery | null): Promise<void>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function validateRelayDelivery(value: unknown): RelayDelivery {
  const row = value as RelayDelivery | null;
  if (!row || row.version !== 1 || !uuid.test(row.session) || !uuid.test(row.deliveryId)
    || !['polling', 'executing', 'completed'].includes(row.phase)
    || (row.phase !== 'polling' && !uuid.test(row.commandId ?? ''))
    || (row.phase === 'polling' && (row.commandId !== undefined || row.result !== undefined || row.error !== undefined))
    || (row.error !== undefined && typeof row.error !== 'string')) throw new Error('relay-delivery-checkpoint-invalid');
  return row;
}

/** One serial relay per device; reuse the runtime's exclusive process lock.
 * Corrupt/unreadable checkpoints fail closed, never reset to an empty queue. */
export function fileRelayDeliveryStore(path: string): RelayDeliveryStore {
  return {
    async read() {
      let text: string;
      try { text = await readFile(path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      if (text.length > 4_000_000) throw new Error('relay-delivery-checkpoint-too-large');
      const value: unknown = JSON.parse(text);
      return value === null ? null : validateRelayDelivery(value);
    },
    async write(value) {
      if (value !== null) validateRelayDelivery(value);
      const serialized = JSON.stringify(value);
      if (serialized.length > 4_000_000) throw new Error('relay-delivery-checkpoint-too-large');
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(serialized); await file.sync(); }
        finally { await file.close(); }
        await rename(temp, path);
        const directory = await open(dirname(path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    },
  };
}
