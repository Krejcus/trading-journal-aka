import { DrawingEngine, type Drawing } from '@getcandlekit/charts';
import { describe, expect, it } from 'vitest';
import {
  getDrawingStyleDefault,
  installDrawingStyleDefaults,
  normalizeDrawingStyle,
  updateDrawingStyleAndDefault,
} from '../services/chartDrawingStyleDefaults';

const fallback = { color: '#2962ff', width: 2, dashed: false, fill: '#2962ff14' };

const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
};

const drawing = (id: string, tool: Drawing['tool']): Drawing => ({
  id,
  tool,
  points: [{ time: 1, price: 100 }, { time: 2, price: 101 }],
  style: { ...fallback },
});

describe('per-tool drawing style defaults', () => {
  it('normalizes malformed persisted values without leaking them into the engine', () => {
    expect(normalizeDrawingStyle({ color: '', width: 99, dashed: 'yes', fill: 42 }, fallback)).toEqual({
      color: fallback.color,
      width: 4,
      dashed: false,
      lineStyle: 'solid',
      fill: fallback.fill,
    });
  });

  it('remembers a changed style only for the matching tool', () => {
    const target = storage();
    const engine = new DrawingEngine();
    const line = drawing('line', 'TrendLine');
    engine.commit(line);

    updateDrawingStyleAndDefault(engine, line, { color: '#f2364580', width: 4, dashed: true }, target);

    expect(getDrawingStyleDefault('TrendLine', fallback, target)).toMatchObject({
      color: '#f2364580',
      width: 4,
      dashed: true,
    });
    expect(getDrawingStyleDefault('Rectangle', fallback, target)).toEqual({ ...fallback, lineStyle: 'solid' });
  });

  it('preserves the dotted line style independently from legacy dashed state', () => {
    const target = storage();
    const engine = new DrawingEngine();
    const line = drawing('dotted-line', 'TrendLine');
    engine.commit(line);

    updateDrawingStyleAndDefault(engine, line, { lineStyle: 'dotted', dashed: false }, target);

    expect(engine.getById(line.id)?.style).toMatchObject({ lineStyle: 'dotted', dashed: false });
    expect(getDrawingStyleDefault('TrendLine', fallback, target)).toMatchObject({ lineStyle: 'dotted', dashed: false });
  });

  it('keeps per-object text appearance and placement in style defaults', () => {
    const target = storage();
    const engine = new DrawingEngine();
    const rectangle = drawing('labelled', 'Rectangle');
    engine.commit(rectangle);

    updateDrawingStyleAndDefault(engine, rectangle, {
      text: 'Supply', textColor: '#f23645', fontSize: 16,
      textHorizontal: 'right', textVertical: 'bottom',
    }, target);

    expect(getDrawingStyleDefault('Rectangle', fallback, target)).toMatchObject({
      text: 'Supply', textColor: '#f23645', fontSize: 16,
      textHorizontal: 'right', textVertical: 'bottom',
    });
  });

  it('remembers text appearance without copying the previous text into a new annotation', () => {
    const target = storage();
    const engine = new DrawingEngine();
    const text = drawing('text', 'Text');
    text.style = { ...text.style, text: 'První poznámka', fontSize: 24 };
    engine.commit(text);

    updateDrawingStyleAndDefault(engine, text, { color: '#f23645' }, target);

    expect(getDrawingStyleDefault('Text', fallback, target)).toMatchObject({
      color: '#f23645',
      fontSize: 24,
      text: '',
    });
  });

  it('applies the remembered style before the next draft begins', () => {
    const target = storage();
    const first = new DrawingEngine();
    const rectangle = drawing('rectangle', 'Rectangle');
    first.commit(rectangle);
    updateDrawingStyleAndDefault(first, rectangle, { fill: '#00e67666', width: 3 }, target);

    const second = new DrawingEngine();
    const cleanup = installDrawingStyleDefaults(second, target);
    second.startTool('Rectangle');
    second.beginDraft('Rectangle', { time: 3, price: 102 });

    expect(second.getDraft()?.style).toMatchObject({ fill: '#00e67666', width: 3 });
    cleanup();
  });
});
