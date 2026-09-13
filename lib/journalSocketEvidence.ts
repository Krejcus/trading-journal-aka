import type { JournalObservation } from './tradovateJournalEvidence.js';

/** Explicit names are required by user/syncrequest; unknown names fail silently. */
export const JOURNAL_SOCKET_ENTITY_TYPES = [
  'contract', 'order', 'fill', 'position', 'command', 'executionReport', 'commandReport',
  'orderVersion', 'fillFee', 'fillPair', 'cashBalanceLog',
] as const;
const brokerTypes = new Set<string>(JOURNAL_SOCKET_ENTITY_TYPES.map(type => type.toLowerCase()));
const collections = new Map(JOURNAL_SOCKET_ENTITY_TYPES.map(type => [`${type}s`, type]));

type Visitor = (type: string, entity: unknown, source: JournalObservation['source'], eventType: string) => void;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only evidence actually present in a broker message. Empty/missing collections
 * do not establish flat positions, historical coverage, or completed sync. */
export function visitJournalSocketEvidence(message: unknown, visit: Visitor, depth = 0): void {
  if (!record(message) || depth > 16) return;
  const props = (payload: unknown, source: JournalObservation['source']) => {
    for (const item of Array.isArray(payload) ? payload : [payload]) {
      if (!record(item) || typeof item.entityType !== 'string') continue;
      const type = item.entityType.toLowerCase();
      if (!brokerTypes.has(type) || !record(item.entity)) continue;
      visit(type, item.entity, source, typeof item.eventType === 'string' ? item.eventType : 'Observed');
    }
  };
  // Failed responses and penalty payloads cannot establish successful snapshots.
  if (typeof message.s === 'number' && message.s !== 200) return;
  if (record(message.d) && Object.hasOwn(message.d, 'p-ticket')) return;
  if (message.e === 'props') {
    props(message.d, 'stream');
  } else if (message.i === 1 && message.s === 200) {
    if (Array.isArray(message.d)) props(message.d, 'snapshot');
    else if (record(message.d)) {
      for (const [key, type] of collections) {
        const entities = message.d[key];
        if (!Array.isArray(entities)) continue;
        for (const entity of entities) if (record(entity)) visit(type, entity, 'snapshot', 'Observed');
      }
    }
  } else if (Array.isArray(message.d)) {
    for (const item of message.d) visitJournalSocketEvidence(item, visit, depth + 1);
  }
}
