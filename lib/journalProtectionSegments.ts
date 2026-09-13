import type { TradeExecutionHistory } from './tradeExecutionHistory.js';
import type { JournalProtectionEvent } from './tradovateJournalEvidence.js';

export interface JournalProtectionSegment {
  orderId: string;
  kind: 'sl' | 'tp';
  from: number;
  to: number;
  price: number;
  nextPrice: number | null;
  receivedTime: boolean;
}

/** A rejected request leaves the last confirmed level unchanged. Contradictory
 * evidence, cancellation, recording gaps and unknown exposure end the line. */
export function journalProtectionSegments(history: TradeExecutionHistory): JournalProtectionSegment[] {
  const fills = history.fills;
  const end = history.position
    ? history.position.closedAt ?? history.position.observedThrough
    : Math.max(...fills.filter(fill => fill.role === 'exit').map(fill => fill.at));
  if (end == null || !Number.isFinite(end)) return [];
  const orders = new Map<string, JournalProtectionEvent[]>();
  for (const event of history.protection) {
    if (!['confirmed', 'cancelled', 'uncertain'].includes(event.status) || event.at > end) continue;
    const rows = orders.get(event.orderId) ?? []; rows.push(event); orders.set(event.orderId, rows);
  }
  const segments: JournalProtectionSegment[] = [];
  for (const [orderId, events] of orders) {
    events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const states: Array<{ at: number; event: JournalProtectionEvent | null }> = [];
    for (let index = 0; index < events.length;) {
      const at = events[index].at;
      const bucket: JournalProtectionEvent[] = [];
      while (index < events.length && events[index].at === at) bucket.push(events[index++]);
      const first = bucket[0];
      const consistent = bucket.every(event => event.status === first.status && event.price === first.price
        && event.quantity === first.quantity && event.kind === first.kind);
      states.push({ at, event: consistent && first.status === 'confirmed' && first.price != null ? first : null });
    }
    for (let index = 0; index < states.length; index++) {
      const event = states[index].event;
      if (!event || event.price == null) continue;
      const next = states[index + 1];
      let to = next?.at ?? end;
      if (history.gaps.some(gap => gap.from <= event.at && (gap.to ?? Infinity) > event.at)) continue;
      const gap = history.gaps.filter(gap => gap.from >= event.at && gap.from <= to).sort((a, b) => a.from - b.from)[0];
      if (gap) to = gap.from;
      if (to < event.at) continue;
      segments.push({ orderId, kind: event.kind, from: event.at, to, price: event.price,
        nextPrice: !gap && next?.at === to ? next.event?.price ?? null : null,
        receivedTime: event.timeSource === 'received' });
    }
  }
  return segments.sort((a, b) => a.from - b.from || a.orderId.localeCompare(b.orderId));
}
