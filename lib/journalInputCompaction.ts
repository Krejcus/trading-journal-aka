import { latestJournalEvidence, orderedJournalEvidence, type JournalEvidence } from './tradovateJournalEvidence.js';

/** These observations have temporal meaning beyond their latest entity value:
 * net-position anchors, fill activity during snapshots, gaps and snapshot rows. */
const retainedTypes = new Set(['position','fill','connection','positionsnapshot']);
export function journalInputMode(event: JournalEvidence): 'retained' | 'entity' | 'watermark' {
  if (retainedTypes.has(event.entityType) || event.entity.id == null) return 'retained';
  return event.entityType === 'journalbackfill' ? 'watermark' : 'entity';
}
export function journalInputKey(event: JournalEvidence): string {
  return `${event.entityType}:${event.entity.id}`;
}
export interface JournalInputEntity {
  key: string;
  /** Derived merged state, not a replacement raw observation or upload payload. */
  latest: JournalEvidence;
  orderedThrough: JournalEvidence;
}
export function compareJournalInputOrder(a: JournalEvidence,b: JournalEvidence): number {
  return a.receivedAt-b.receivedAt || a.sessionId.localeCompare(b.sessionId) || a.sequence-b.sequence || a.id.localeCompare(b.id);
}

/** A late insertion can change which later patches were accepted by broker
 * timestamp. Rebuild only that entity from raw evidence instead of guessing. */
export async function compactJournalInputEntities(events: readonly JournalEvidence[], previous: readonly JournalInputEntity[],
  rebuild: (key: string) => Promise<readonly JournalEvidence[]>) {
  const old = new Map(previous.map(row=>[row.key,row]));
  const grouped = new Map<string,JournalEvidence[]>();
  for (const event of events) if (journalInputMode(event)==='entity') {
    const key=journalInputKey(event), rows=grouped.get(key) ?? [];
    rows.push(event); grouped.set(key,rows);
  }
  const updates: JournalInputEntity[]=[];
  for (const [key,rows] of grouped) {
    const ordered=orderedJournalEvidence(rows), stored=old.get(key);
    const late=stored && compareJournalInputOrder(ordered[0],stored.orderedThrough)<0;
    const input=late ? [...await rebuild(key)] : [...(stored ? [stored.latest] : []),...ordered];
    if (!input.length || input.some(event=>journalInputMode(event)!=='entity' || journalInputKey(event)!==key)) throw new Error('journal-input-entity-mismatch');
    const latest=latestJournalEvidence(input).get(key);
    if (!latest) throw new Error('journal-input-entity-incomplete');
    const orderedThrough=late ? orderedJournalEvidence(input).at(-1)! : ordered.at(-1)!;
    updates.push({ key,latest,orderedThrough });
  }
  return updates;
}

/** Preserve the receipt watermark even if the last raw observation was a stale
 * entity patch or coverage-only metadata. Never overwrite a merged entity with
 * its same-ID unmerged raw counterpart. */
export function journalCompactedEvidence(retained: readonly JournalEvidence[], entities: readonly JournalInputEntity[], watermark: JournalEvidence | null) {
  const events=[...retained,...entities.map(row=>row.latest)];
  if (watermark && !events.some(event=>event.receivedAt>=watermark.receivedAt)) events.push(watermark);
  return events;
}
