import { journalObservation, type JournalObservation } from './tradovateJournalEvidence.js';

/** Connection-wide read endpoints; never order placement or execution state. */
export const JOURNAL_ACCOUNTING_READS = [
  { type: 'fillfee', path: '/fillFee/list' },
  { type: 'fillpair', path: '/fillPair/list' },
] as const;
export const JOURNAL_HISTORY_READS = [
  ...JOURNAL_ACCOUNTING_READS,
  { type: 'order', path: '/order/list' },
  { type: 'fill', path: '/fill/list' },
  { type: 'orderversion', path: '/orderVersion/list' },
  { type: 'command', path: '/command/list' },
  { type: 'commandreport', path: '/commandReport/list' },
  { type: 'executionreport', path: '/executionReport/list' },
] as const;
export type JournalBackfillType = typeof JOURNAL_HISTORY_READS[number]['type'] | 'contract' | 'cashbalancelog';
const knownTypes = new Set<string>([...JOURNAL_HISTORY_READS.map(read => read.type), 'contract', 'cashbalancelog', 'position']);
const MAX_ROWS = 10_000;
export const JOURNAL_ACCOUNTING_MAX_BYTES = 4 * 1024 * 1024;

export async function waitJournalReceipt(receipt: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('journal-backfill-aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([receipt, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Bound the response while reading, including chunked responses without length. */
export async function readJournalResponseText(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('journal-backfill-response-too-large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = ''; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error('journal-backfill-response-too-large');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

/** Dedup is only an optimization. Eviction can repeat evidence, never suppress it.
 * A stream patch during a REST read fences that entity even at identical times.
 * Cache overflow fences the whole read because an evicted revision is unknown. */
export function createJournalAccountingBackfill(maxEntries = 100_000) {
  const known = new Map<string, { entity: JournalObservation['entity']; deleted: boolean; revision: number }>();
  let revision = 0; let epoch = 0;
  const reset = () => { known.clear(); epoch++; };
  const remember = (event: JournalObservation) => {
    if (!knownTypes.has(event.entityType) || !Number.isSafeInteger(event.entity.id) || Number(event.entity.id) <= 0) return;
    const key = `${event.entityType}:${event.entity.id}`;
    const previous = known.get(key);
    known.delete(key);
    known.set(key, { entity: { ...previous?.entity, ...event.entity },
      deleted: event.eventType.toLowerCase() === 'deleted', revision: ++revision });
    if (known.size > maxEntries) { known.delete(known.keys().next().value!); epoch++; }
  };
  const begin = () => ({ revision, epoch });
  const select = (type: JournalBackfillType, rows: unknown, start: ReturnType<typeof begin>, receivedAt: number) => {
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error('journal-backfill-invalid-list');
    const ids = new Set<number>();
    // Validate the whole response before producing evidence; duplicate IDs are ambiguous.
    const observations = rows.map(row => {
      const event = journalObservation(type, row, 'snapshot', 'Backfill', receivedAt);
      const id = event?.entity.id;
      if (!event || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || ids.has(id)) {
        throw new Error('journal-backfill-invalid-list');
      }
      ids.add(id);
      return event;
    });
    let contended = 0;
    const selected = observations.filter(event => {
      const prior = known.get(`${type}:${event.entity.id}`);
      if (start.epoch !== epoch || (prior && (prior.revision > start.revision || prior.deleted))) {
        contended++; return false;
      }
      // Compare sanitized fields in their stable allowlist order. A snapshot's
      // omitted fields do not erase known patches or imply zero fees.
      return !prior || Object.entries(event.entity).some(([key, value]) => prior.entity[key] !== value);
    });
    return { observations: selected, scanned: rows.length, contended };
  };
  const references = (type: 'order' | 'fill' | 'command' | 'position' | 'contract' | 'account') => {
    const ids = new Set<number>();
    for (const [key, value] of known) {
      if (value.deleted) continue;
      const row = value.entity;
      const id = key.startsWith(`${type}:`) ? row.id : row[`${type}Id`];
      if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ids.add(id);
    }
    return [...ids].sort((a, b) => a - b);
  };
  return { remember, begin, select, reset, references };
}
