import type { Drawing, DrawingPoint } from '@getcandlekit/charts';
import type { LiveChartPosition } from './liveChartPosition';

/**
 * Position box v LIVE grafu protažený s otevřenou pozicí (Filip 7. 11.): jen
 * zobrazení, kresba nic neodesílá a příkazy se z ní po ⚡ už neberou.
 * Box se vybere podle pozice, ne podle zařízení, ze kterého šel příkaz.
 */
export interface LivePositionBoxDrawing extends Pick<Drawing, 'id' | 'tool' | 'points'> {
  style: Drawing['style'] & { liveEndedAt?: number };
}

/** Starší plán se pozice netýká, i kdyby v něm cena vstupu ležela. */
export const LIVE_BOX_MAX_AGE_SECONDS = 4 * 3600;

const boxSide = (drawing: LivePositionBoxDrawing) => (drawing.tool === 'LongPosition'
  ? 'long'
  : drawing.tool === 'ShortPosition' ? 'short' : null);

/**
 * Box k otevřené pozici: stejný směr, vstup pozice leží mezi SL a TP boxu, box
 * ještě neukončil jiný obchod. Vyhrává nejbližší vstup, pak novější box.
 */
export function pickLivePositionBox<T extends LivePositionBoxDrawing>(
  drawings: readonly T[],
  position: { side: 'long' | 'short'; entry: number },
  nowSeconds: number,
): T | null {
  let best: T | null = null;
  for (const drawing of drawings) {
    if (boxSide(drawing) !== position.side || drawing.style.liveEndedAt != null) continue;
    if (drawing.id.startsWith('auto-') || drawing.points.length < 3) continue;
    const [entry, target, stop] = drawing.points;
    if (nowSeconds - entry.time > LIVE_BOX_MAX_AGE_SECONDS) continue;
    const low = Math.min(target.price, stop.price);
    const high = Math.max(target.price, stop.price);
    if (position.entry < low || position.entry > high) continue;
    if (!best) { best = drawing; continue; }
    const gap = Math.abs(entry.price - position.entry);
    const bestGap = Math.abs(best.points[0].price - position.entry);
    if (gap < bestGap || (gap === bestGap && entry.time > best.points[0].time)) best = drawing;
  }
  return best;
}

const withEdge = (points: readonly DrawingPoint[], time: number): DrawingPoint[] => [
  points[0],
  { ...points[1], time },
  { ...points[2], time },
];

/** Pravý okraj boxu během pozice; plánovaná šířka se nezkracuje. null = beze změny. */
export function stretchedBoxPoints(points: readonly DrawingPoint[], time: number): DrawingPoint[] | null {
  if (points.length < 3 || time <= points[0].time) return null;
  if (points[1].time >= time && points[2].time >= time) return null;
  return withEdge(points, Math.max(time, points[1].time, points[2].time));
}

/** Pravý okraj boxu po zavření pozice. null = beze změny. */
export function endedBoxPoints(points: readonly DrawingPoint[], time: number): DrawingPoint[] | null {
  if (points.length < 3 || time <= points[0].time) return null;
  if (points[1].time === time && points[2].time === time) return null;
  return withEdge(points, time);
}

/** Kresby se načítají až po připojení grafu; dřív chybějící box neznamená smazaný. */
const DRAWINGS_LOADED_AFTER_MS = 30_000;
const EXIT_EVENT_MAX_AGE_MS = 120_000;
const floorMinute = (ms: number) => Math.floor(ms / 60_000) * 60;

export interface LiveBoxLink { id: string; target: string; side: 'long' | 'short' }

export interface LiveBoxEngine {
  getDrawings(): readonly unknown[];
  setPoints(id: string, points: DrawingPoint[]): void;
  setStyle(id: string, patch: never): void;
}

export interface LiveBoxFollowDeps {
  readLink(): LiveBoxLink | null;
  writeLink(link: LiveBoxLink | null): void;
  /** Změna kresby mimo historii Zpět/Vpřed. */
  silently(change: () => void): void;
}

export interface LiveBoxFollowInput {
  now: number;
  position: Pick<LiveChartPosition, 'key' | 'summary'> | null | undefined;
  /** Skupina nebo účet v pohledu: přepnutí na jiný účet není zavření pozice. */
  target: string;
  events: readonly { kind: string; at: number }[] | null | undefined;
  panes: readonly { engine: LiveBoxEngine; since: number }[];
}

/**
 * Jeden krok protahování. Neověřený stav pozice box nikdy neukončí: čeká se na
 * ověřené „bez pozice“. Čekající příkaz bez pozice je pro box také konec.
 */
export function createLivePositionBoxFollower(deps: LiveBoxFollowDeps) {
  let sawOpen = false;
  return {
    step({ now, position, target, events, panes }: LiveBoxFollowInput): void {
      if (!panes.length || !position) return;
      const summary = position.summary;
      const open = summary?.kind === 'position';
      const flat = position.key === 'none' || summary?.kind === 'pending';
      if (!open && !flat) return;
      let link = deps.readLink();
      if (link && link.target !== target) return;
      const settled = panes.every(pane => now - pane.since >= DRAWINGS_LOADED_AFTER_MS);
      const drawingsOf = (engine: LiveBoxEngine) => engine.getDrawings() as readonly LivePositionBoxDrawing[];
      const owners = (id: string) => panes.filter(pane => drawingsOf(pane.engine).some(item => item.id === id));

      const finish = (current: LiveBoxLink) => {
        const holding = owners(current.id);
        if (!holding.length) {
          if (settled) deps.writeLink(null);
          return;
        }
        const exitAt = (events ?? []).reduce((newest, event) => (
          (event.kind === 'exit' || event.kind === 'flip') && event.at > newest ? event.at : newest
        ), 0);
        // Ve živém sledování platí čas události, jen když je z právě teď (jinak je z minulého obchodu).
        const edgeMs = sawOpen ? (now - exitAt <= EXIT_EVENT_MAX_AGE_MS ? exitAt : now) : exitAt;
        for (const { engine } of holding) {
          const drawing = drawingsOf(engine).find(item => item.id === current.id)!;
          deps.silently(() => {
            const points = edgeMs > 0 ? endedBoxPoints(drawing.points, floorMinute(edgeMs)) : null;
            if (points) engine.setPoints(drawing.id, points);
            engine.setStyle(drawing.id, { liveEndedAt: floorMinute(edgeMs || now) } as never);
          });
        }
        deps.writeLink(null);
        sawOpen = false;
      };

      if (flat) {
        if (link) finish(link);
        return;
      }
      const side = summary!.side;
      if (link && link.side !== side) {
        finish(link);
        link = deps.readLink();
        if (link) return;
      }
      if (link && !owners(link.id).length && settled) {
        deps.writeLink(null);
        link = null;
      }
      if (!link) {
        if (summary!.entry == null) return;
        for (const { engine } of panes) {
          const picked = pickLivePositionBox(drawingsOf(engine), { side, entry: summary!.entry }, now / 1000);
          if (picked) { link = { id: picked.id, target, side }; break; }
        }
        if (!link) return;
        deps.writeLink(link);
      }
      sawOpen = true;
      const id = link.id;
      for (const { engine } of owners(id)) {
        const drawing = drawingsOf(engine).find(item => item.id === id)!;
        const points = stretchedBoxPoints(drawing.points, floorMinute(now));
        if (points) deps.silently(() => engine.setPoints(id, points));
      }
    },
  };
}
