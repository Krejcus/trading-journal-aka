import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { JournalEvidence, JournalObservation } from '../lib/tradovateJournalEvidence.js';

export interface JournalRecorderHealth {
  state: 'recording' | 'degraded';
  pending: number | null;
  lastPersistedAt: number | null;
  lastUploadedAt: number | null;
  error: string | null;
}

/** Durable append-only evidence + separately acknowledged upload cursor. */
export async function createFileJournalEvidenceStore(options: {
  path: string;
  connectionId: string;
  environment: 'demo' | 'live';
  maxQueued?: number;
  onError?: (error: Error) => void;
}) {
  await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
  const handle = await open(options.path, 'a+', 0o600);
  const cursorPath = `${options.path}.cursor`;
  let cursor = 0;
  try { cursor = Number(await readFile(cursorPath, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await handle.close(); throw error; }
  }
  const stat = await handle.stat();
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > stat.size) {
    await handle.close(); throw new Error('journal-invalid-upload-cursor');
  }
  // A torn final append must never join the next JSON object or get acknowledged.
  if (stat.size > 0) {
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, stat.size - 1);
    if (byte[0] !== 10) { await handle.close(); throw new Error('journal-truncated-tail-needs-recovery'); }
    if (cursor > 0) {
      await handle.read(byte, 0, 1, cursor - 1);
      if (byte[0] !== 10) { await handle.close(); throw new Error('journal-invalid-upload-cursor'); }
    }
  }
  const sessionId = randomUUID();
  let sequence = 0;
  let closed = false;
  let queueSize = 0;
  let tail = Promise.resolve();
  let uploading: Promise<void> | null = null;
  let lostFrom: number | null = null;
  let writeFailed = false;
  // Existing backlog count is unknown without scanning the complete file.
  const health: JournalRecorderHealth = { state: 'recording', pending: stat.size > cursor ? null : 0, lastPersistedAt: null, lastUploadedAt: null, error: null };
  const fail = (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    health.state = 'degraded'; health.error = error.message;
    try { options.onError?.(error); } catch { /* Independent from execution. */ }
  };
  const envelope = (observation: JournalObservation): JournalEvidence => {
    const event = { ...observation, connectionId: options.connectionId, environment: options.environment, sessionId, sequence: ++sequence };
    const id = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    return { ...event, id };
  };
  const persist = async (event: JournalEvidence) => {
    await handle.appendFile(`${JSON.stringify(event)}\n`, 'utf8');
    await handle.datasync();
    health.lastPersistedAt = event.receivedAt;
    if (health.pending != null) health.pending += 1;
  };
  const record = (observation: JournalObservation) => {
    if (closed || writeFailed) return Promise.resolve(false);
    if (queueSize >= (options.maxQueued ?? 10_000)) {
      lostFrom ??= observation.receivedAt;
      fail(new Error('journal-queue-full-history-incomplete'));
      return Promise.resolve(false);
    }
    const event = envelope(observation);
    queueSize += 1;
    const persisted = tail.then(async () => {
      if (writeFailed) return false;
      if (lostFrom != null) {
        const from = lostFrom;
        await persist(envelope({ entityType: 'connection', entity: { state: 'recording-gap', reason: 'local-write-failed' },
          source: 'transport', eventType: 'Observed', receivedAt: from }));
        lostFrom = null;
      }
      await persist(event);
      return true;
    }).catch(error => {
      // A failed append may have written only part of a JSON record. Latch the
      // recorder until restart/recovery; never append into an uncertain tail.
      writeFailed = true; lostFrom ??= event.receivedAt; fail(error); return false;
    }).finally(() => { queueSize -= 1; });
    tail = persisted.then(() => undefined);
    return persisted;
  };
  const flush = (upload: (events: JournalEvidence[]) => Promise<void>): Promise<void> => {
    if (uploading) return uploading;
    uploading = (async () => {
      await tail;
      // Bounded read: no whole-history load on each flush or on worker startup.
      const buffer = Buffer.alloc(256 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);
      const end = buffer.lastIndexOf(10, bytesRead - 1);
      if (bytesRead === 0) { health.pending = queueSize; return; }
      if (end < 0) throw new Error('journal-invalid-or-oversized-record');
      const lines: string[] = [];
      let batchBytes = 2; // JSON array brackets; the API limit counts UTF-8 bytes.
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        const size = Buffer.byteLength(line) + (lines.length ? 1 : 0);
        if (lines.length === 100 || batchBytes + size > 250_000) break;
        lines.push(line); batchBytes += size;
      }
      if (!lines.length) throw new Error('journal-invalid-or-oversized-record');
      const events = lines.map(line => JSON.parse(line) as JournalEvidence);
      await upload(events);
      const next = cursor + Buffer.byteLength(`${lines.join('\n')}\n`);
      // Rename after remote durable ACK: a lost response safely replays identical ids.
      const tmp = `${cursorPath}.${sessionId}.tmp`;
      await writeFile(tmp, String(next), { mode: 0o600 });
      await rename(tmp, cursorPath);
      cursor = next;
      health.lastUploadedAt = Date.now();
      if (health.pending != null) health.pending = Math.max(queueSize, health.pending - events.length);
    })().catch(error => { fail(error); throw error; }).finally(() => { uploading = null; });
    return uploading;
  };
  return {
    record, flush,
    health: (): JournalRecorderHealth => ({ ...health }),
    async close() {
      closed = true;
      await tail;
      await uploading?.catch(() => undefined);
      await handle.close();
    },
  };
}
