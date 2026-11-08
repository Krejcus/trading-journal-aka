import type { DrawingEngine } from '@getcandlekit/charts';
import { isPositionDrawing, type PositionDrawing } from './chartPositionDrawing';

/** Capture the exact manual drawing. A later ACK must never remove a changed
 * or replacement drawing, nor a generated position. No order is sent here. */
export function positionBoxAcknowledgement(engine: DrawingEngine, source: PositionDrawing, linkedEngines: () => readonly DrawingEngine[] = () => []): () => void {
  const id = source.id;
  const tool = source.tool;
  const points = source.points.map(point => ({ ...point }));
  return () => {
    if (id.startsWith('auto-')) return;
    const copies = [...new Set([engine, ...linkedEngines()])].flatMap(api => {
      const current = api.getById(id);
      return current ? [{ api, current }] : [];
    });
    // A change in any linked pane wins over a delayed acknowledgement.
    if (copies.some(({ current }) => !isPositionDrawing(current) || current.tool !== tool
      || current.points.length !== points.length
      || current.points.some((point, i) => point.time !== points[i].time || point.price !== points[i].price))) return;
    // Remove every linked copy in the same turn. A React remount can otherwise
    // merge a stale copy from another pane before deferred drawing sync runs.
    copies.forEach(({ api }) => api.remove(id));
  };
}

/** The source is captured when the user sends, before awaiting the result.
 * Rejected/unknown/blocked/throw paths intentionally preserve the drawing. */
export async function withPositionBoxAcknowledgement<T extends { status: string }>(
  send: () => Promise<T>,
  source: (() => void) | null | undefined,
): Promise<T> {
  const result = await send();
  if (result.status === 'acknowledged') {
    try { source?.(); } catch { /* A closed chart must not change a successful broker result. */ }
  }
  return result;
}
