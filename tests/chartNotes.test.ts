import { describe, expect, it } from 'vitest';
import type { DrawingObject } from '../types';
import { chartNotesOf, visibleChartNotes, withChartNotes, type ChartNote } from '../lib/chartNotes';

const legacy: DrawingObject = { id: 'old-1', type: 'line', p1: { time: 100, price: 1 }, p2: { time: 200, price: 2 } };
const note = (patch: Partial<ChartNote> = {}): ChartNote => ({ id: 'note-a', time: 1_790_000_040, price: 30_530.25, text: 'Vstup na hraně FVG', dx: 40, dy: -40, ...patch });

describe('poznámky v grafu obchodu', () => {
  it('uloží se vedle starších kreseb a přečtou zpět', () => {
    const saved = withChartNotes({ drawings: [legacy] }, [note(), note({ id: 'note-b', time: 1_790_000_100, text: 'BE' })]);
    expect(saved.drawings?.[0]).toEqual(legacy);
    expect(chartNotesOf(saved)).toEqual([note(), note({ id: 'note-b', time: 1_790_000_100, text: 'BE' })]);
  });
  it('nové uložení nahradí poznámky, starší kresby zůstanou', () => {
    const first = withChartNotes({ drawings: [legacy] }, [note(), note({ id: 'note-b', text: 'pryč' })]);
    const second = withChartNotes(first, [note({ text: 'upraveno', dx: -12.6 })]);
    expect(second.drawings?.filter(drawing => drawing.type === 'note')).toHaveLength(1);
    expect(second.drawings?.[0]).toEqual(legacy);
    expect(chartNotesOf(second)[0]).toMatchObject({ text: 'upraveno', dx: -13 });
  });
  it('prázdná poznámka se neuloží a vadná položka se přeskočí', () => {
    expect(withChartNotes({ drawings: [] }, [note({ text: '   ' })]).drawings).toEqual([]);
    const broken = [{ id: 'x', type: 'note', p1: { time: 'nope', price: 1 }, text: 'a' }] as unknown as DrawingObject[];
    expect(chartNotesOf({ drawings: broken })).toEqual([]);
    expect(chartNotesOf({ drawings: undefined })).toEqual([]);
  });
  it('bez uloženého posunu dostane bublina výchozí odstup', () => {
    const drawings = [{ id: 'n', type: 'note', p1: { time: 60, price: 5 }, text: 'x' }] as DrawingObject[];
    expect(chartNotesOf({ drawings })[0]).toMatchObject({ dx: 40, dy: -40 });
  });
  it('v přehrávání jen poznámky, ke kterým svíčky dojely', () => {
    const notes = [note({ id: 'a', time: 60 }), note({ id: 'b', time: 180 })];
    expect(visibleChartNotes(notes, 120).map(item => item.id)).toEqual(['a']);
    expect(visibleChartNotes(notes, 180).map(item => item.id)).toEqual(['a', 'b']);
    expect(visibleChartNotes(notes, null)).toHaveLength(2);
  });
});
