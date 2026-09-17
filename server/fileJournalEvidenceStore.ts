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
  /** Observations waiting for the next durable batch. */
  queued: number;
  maxQueued: number;
  /** Position-relevant observations lost to a full queue; each loss opens a recording gap. */
  dropped: number;
  /** Command-history observations lost to a full queue; positions stay provable, so no gap. */
  droppedLowPriority: number;
  /** Identical REST snapshot re-observations skipped; not a history loss. */
  deduplicated: number;
  /** `receivedAt` of the first lost observation of the most recent recording gap. */
  lastGapAt: number | null;
  lastGapReason: string | null;
  /** Duration of the most recent append + datasync batch. */
  lastWriteMs: number | null;
  batches: number;
}

/**
 * Broker entities whose loss changes reconstructed positions or protection.
 * They keep queueing past the soft limit; only the hard limit declares a gap.
 */
const POSITION_CRITICAL = new Set(['fill', 'order', 'orderversion', 'executionreport', 'position', 'positionsnapshot', 'fillpair', 'fillfee', 'cashbalancelog', 'copylink', 'contract', 'connection', 'journalbackfill']);
/** Capture metadata carries its own identity per capture; never deduplicated. */
const NEVER_DEDUPLICATED = new Set(['positionsnapshot', 'journalbackfill', 'connection']);
const HARD_LIMIT_FACTOR = 4;
const MAX_BATCH_LINES = 2_000;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const DEDUPE_MEMORY = 200_000;

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
  const maxQueued = options.maxQueued ?? 10_000;
  let sequence = 0;
  let closed = false;
  let uploading: Promise<void> | null = null;
  let lostFrom: number | null = null;
  let lostReason: string | null = null;
  let lossReported = false;
  let writeFailed = false;
  // Existing backlog count is unknown without scanning the complete file.
  const health: JournalRecorderHealth = {
    state: 'recording', pending: stat.size > cursor ? null : 0, lastPersistedAt: null, lastUploadedAt: null, error: null,
    queued: 0, maxQueued, dropped: 0, droppedLowPriority: 0, deduplicated: 0, lastGapAt: null, lastGapReason: null, lastWriteMs: null, batches: 0,
  };
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

  // One durable batch per drain: a single append and a single datasync cover
  // every queued observation, so bursts (reconnect resync) no longer pay one
  // fsync per row. Each caller still resolves only after its own bytes are durable.
  type Queued = { observation: JournalObservation; resolve: (persisted: boolean) => void };
  const queue: Queued[] = [];
  let draining: Promise<void> | null = null;
  const settle = (rows: Queued[], persisted: boolean) => { for (const row of rows) row.resolve(persisted); };
  const drain = async () => {
    while (queue.length > 0 && !writeFailed) {
      const batch: Queued[] = [];
      const lines: string[] = [];
      let bytes = 0;
      const gapAt = lostFrom, gapReason = lostReason;
      if (gapAt != null) {
        // The marker precedes the first observation recorded after the loss.
        const marker = envelope({ entityType: 'connection', entity: { state: 'recording-gap', reason: gapReason ?? 'local-write-failed' },
          source: 'transport', eventType: 'Observed', receivedAt: gapAt });
        lines.push(JSON.stringify(marker)); bytes += lines[0].length + 1;
      }
      while (queue.length > 0 && batch.length < MAX_BATCH_LINES && bytes < MAX_BATCH_BYTES) {
        const row = queue.shift()!;
        batch.push(row);
        const line = JSON.stringify(envelope(row.observation));
        lines.push(line); bytes += line.length + 1;
      }
      health.queued = queue.length;
      const started = Date.now();
      try {
        await handle.appendFile(`${lines.join('\n')}\n`, 'utf8');
        await handle.datasync();
      } catch (error) {
        // A failed append may have written only part of a JSON record. Latch the
        // recorder until restart/recovery; never append into an uncertain tail.
        writeFailed = true;
        lostFrom ??= batch[0]?.observation.receivedAt ?? Date.now(); lostReason = 'local-write-failed';
        health.dropped += batch.length + queue.length;
        settle(batch, false); settle(queue.splice(0), false); health.queued = 0;
        fail(error);
        return;
      }
      if (gapAt != null) {
        lostFrom = null; lostReason = null; lossReported = false;
        health.lastGapAt = gapAt; health.lastGapReason = gapReason;
      }
      health.lastWriteMs = Date.now() - started;
      health.batches += 1;
      health.lastPersistedAt = batch.at(-1)?.observation.receivedAt ?? health.lastPersistedAt;
      if (health.pending != null) health.pending += lines.length;
      settle(batch, true);
    }
  };
  const schedule = (): Promise<void> => {
    if (draining) return draining;
    draining = drain().finally(() => { draining = null; if (queue.length > 0 && !writeFailed) void schedule(); });
    return draining;
  };
  const settled = async () => { while (draining) await draining; };

  // REST snapshots re-observe every entity on each poll and after each
  // reconnect. An unchanged entity adds nothing to the projection, so only its
  // first observation (and every later change) is recorded.
  const lastSnapshot = new Map<string, string>();
  const snapshotKey = (observation: JournalObservation): { key: string; shape: string } | null => {
    if (observation.source !== 'snapshot' || NEVER_DEDUPLICATED.has(observation.entityType) || observation.entity.id == null) return null;
    return { key: `${observation.entityType}:${String(observation.entity.id)}`, shape: `${observation.eventType}\n${JSON.stringify(observation.entity)}` };
  };
  const reportLoss = (observation: JournalObservation, reason: string) => {
    if (lossReported) return;
    lossReported = true;
    fail(new Error(`journal-queue-full-history-incomplete: ${reason} from ${new Date(observation.receivedAt).toISOString()}`));
  };
  const record = (observation: JournalObservation): Promise<boolean> => {
    if (closed || writeFailed) return Promise.resolve(false);
    const snapshot = snapshotKey(observation);
    if (snapshot && lastSnapshot.get(snapshot.key) === snapshot.shape) { health.deduplicated += 1; return Promise.resolve(true); }
    const critical = POSITION_CRITICAL.has(observation.entityType);
    if (queue.length >= maxQueued * (critical ? HARD_LIMIT_FACTOR : 1)) {
      if (critical) {
        health.dropped += 1;
        if (lostFrom == null) { lostFrom = observation.receivedAt; lostReason = 'queue-full'; }
      } else {
        // Command history is secondary evidence; losing it must not mark
        // reconstructed positions as incomplete.
        health.droppedLowPriority += 1;
      }
      reportLoss(observation, critical ? 'queue-full' : 'queue-full-low-priority');
      return Promise.resolve(false);
    }
    if (snapshot) {
      if (lastSnapshot.size >= DEDUPE_MEMORY) lastSnapshot.clear();
      lastSnapshot.set(snapshot.key, snapshot.shape);
    }
    return new Promise<boolean>(resolve => {
      queue.push({ observation, resolve });
      health.queued = queue.length;
      void schedule();
    });
  };
  const flush = (upload: (events: JournalEvidence[]) => Promise<void>): Promise<void> => {
    if (uploading) return uploading;
    uploading = (async () => {
      await settled();
      // Bounded read: no whole-history load on each flush or on worker startup.
      const buffer = Buffer.alloc(256 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);
      const end = buffer.lastIndexOf(10, bytesRead - 1);
      if (bytesRead === 0) { health.pending = queue.length; return; }
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
      // A durable remote ACK proves the pipeline works again; a stale upload
      // error must not keep the recorder reported as degraded.
      if (!writeFailed && lostFrom == null) { health.state = 'recording'; health.error = null; }
      if (health.pending != null) health.pending = Math.max(queue.length, health.pending - events.length);
    })().catch(error => { fail(error); throw error; }).finally(() => { uploading = null; });
    return uploading;
  };
  return {
    record, flush,
    health: (): JournalRecorderHealth => ({ ...health }),
    async close() {
      closed = true;
      await settled();
      await uploading?.catch(() => undefined);
      await handle.close();
    },
  };
}
