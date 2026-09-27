import type { DrawingObject, Trade } from '../types';

/**
 * Poznámky v grafu obchodu. Bod je připíchnutý k času (otevření 1m svíčky,
 * unix s) a ceně; bublina s textem je od něj posunutá o `dx/dy` pixelů, takže
 * při zoomu drží stejný odstup.
 *
 * Ukládají se do `trade.drawings` (serverový sloupec, který Tradovate obchody
 * smějí měnit) jako položky `type: 'note'`. Ostatní (starší) kresby v poli
 * zůstávají beze změny.
 */
export interface ChartNote {
  id: string;
  time: number;
  price: number;
  text: string;
  dx: number;
  dy: number;
}

export const CHART_NOTE_MAX_LENGTH = 2000;
export const DEFAULT_NOTE_OFFSET = { dx: 40, dy: -40 };

const finite = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

export function chartNotesOf(trade: Pick<Trade, 'drawings'> | null | undefined): ChartNote[] {
  const drawings = Array.isArray(trade?.drawings) ? trade!.drawings : [];
  return drawings.flatMap(drawing => {
    if (!drawing || drawing.type !== 'note' || typeof drawing.text !== 'string' || !drawing.text.trim()) return [];
    const time = Number(drawing.p1?.time);
    const price = Number(drawing.p1?.price);
    if (!Number.isFinite(time) || !Number.isFinite(price)) return [];
    return [{
      id: String(drawing.id),
      time,
      price,
      text: drawing.text,
      dx: finite(drawing.offset?.dx, DEFAULT_NOTE_OFFSET.dx),
      dy: finite(drawing.offset?.dy, DEFAULT_NOTE_OFFSET.dy),
    }];
  }).sort((a, b) => a.time - b.time);
}

export function chartNoteDrawing(note: ChartNote): DrawingObject {
  return {
    id: note.id,
    type: 'note',
    p1: { time: note.time, price: note.price },
    text: note.text.slice(0, CHART_NOTE_MAX_LENGTH),
    offset: { dx: Math.round(note.dx), dy: Math.round(note.dy) },
  };
}

/** Obchod s novými poznámkami; ostatní kresby zůstanou, prázdné poznámky zmizí. */
export function withChartNotes<T extends Pick<Trade, 'drawings'>>(trade: T, notes: readonly ChartNote[]): T {
  const others = (Array.isArray(trade.drawings) ? trade.drawings : []).filter(drawing => drawing?.type !== 'note');
  const kept = notes.filter(note => note.text.trim()).map(chartNoteDrawing);
  return { ...trade, drawings: [...others, ...kept] };
}

/** Viditelné poznámky: v přehrávání jen ty, ke kterým svíčky už dojely. */
export function visibleChartNotes(notes: readonly ChartNote[], replayCursor: number | null): ChartNote[] {
  return replayCursor == null ? [...notes] : notes.filter(note => note.time <= replayCursor);
}

export const newChartNoteId = () => `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
