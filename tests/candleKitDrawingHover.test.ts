import { describe, expect, it, vi } from 'vitest';
import {
  DrawingController,
  DrawingEngine,
  DrawingPrimitive,
  type Drawing,
} from '@getcandlekit/charts';

const trendLine = (id: string): Drawing => ({
  id,
  tool: 'TrendLine',
  points: [
    { time: 10, price: 20 },
    { time: 30, price: 40 },
  ],
  style: {
    color: '#2962ff',
    width: 1,
    dashed: false,
    fill: 'transparent',
  },
});

describe('CandleKit drawing hover editing', () => {
  it('hit-tests hover before asking the time scale to resolve future whitespace', () => {
    const engine = new DrawingEngine();
    engine.commit(trendLine('manual-line'));
    const controller = new DrawingController({ engine }) as any;
    controller.hitTest = vi.fn(() => ({ id: 'manual-line', kind: 'move', anchorIndex: 0 }));
    controller.unproject = vi.fn(() => null);
    controller.setCursor = vi.fn();
    controller.primitive = { setHovered: vi.fn() };

    controller.onMove({ offsetX: 500, offsetY: 100 });

    expect(controller.hitTest).toHaveBeenCalledWith(500, 100);
    expect(controller.unproject).not.toHaveBeenCalled();
    expect(controller.primitive.setHovered).toHaveBeenCalledWith('manual-line', null);
  });

  it('moves an ordinary rectangle whose whole body is beyond the last candle', () => {
    const engine = new DrawingEngine();
    engine.commit({
      id: 'future-rectangle',
      tool: 'Rectangle',
      points: [{ time: 700, price: 100 }, { time: 1_060, price: 200 }],
      style: { color: '#2962ff', width: 1, dashed: false, fill: '#2962ff22' },
    });
    engine.select(null);
    const controller = new DrawingController({ engine }) as any;
    controller.chart = {
      applyOptions: vi.fn(),
      timeScale: () => ({
        timeToCoordinate: (time: number) => time === 100 ? 50 : null,
        coordinateToTime: () => null,
        logicalToCoordinate: (logical: number) => logical * 8,
      }),
    };
    controller.series = {
      data: () => [{ time: 40 }, { time: 100 }],
      priceToCoordinate: (price: number) => price,
      coordinateToPrice: (price: number) => price,
    };
    controller.setCursor = vi.fn();
    controller.primitive = { setHovered: vi.fn() };

    controller.onDown({
      offsetX: 150,
      offsetY: 150,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    expect(engine.getSelectedId()).toBe('future-rectangle');
    expect(controller.drag).toMatchObject({ id: 'future-rectangle', kind: 'move' });

    controller.onMove({ offsetX: 158, offsetY: 160 });

    expect(engine.getById('future-rectangle')?.points).toEqual([
      { time: 760, price: 110 },
      { time: 1_120, price: 210 },
    ]);
  });

  it('hit-tests unselected anchors before the drawing body', () => {
    const engine = new DrawingEngine();
    engine.commit(trendLine('manual-line'));
    engine.select(null);
    const controller = new DrawingController({ engine }) as any;
    controller.project = (point: { time: number; price: number }) => ({ x: point.time, y: point.price });

    expect(controller.hitTest(11, 20)).toEqual({
      id: 'manual-line',
      kind: 'anchor',
      anchorIndex: 0,
    });
    expect(controller.hitTest(20, 30)).toEqual({
      id: 'manual-line',
      kind: 'move',
      anchorIndex: 0,
    });
  });

  it('does not expose generated drawings as hover-editable objects', () => {
    const engine = new DrawingEngine();
    engine.commit(trendLine('auto-entry-line'));
    engine.select(null);
    const controller = new DrawingController({ engine }) as any;
    controller.project = (point: { time: number; price: number }) => ({ x: point.time, y: point.price });

    expect(controller.hitTest(10, 20)).toBeNull();
    expect(controller.hitTest(20, 30)).toBeNull();
  });

  it('renders handles for a hovered drawing without selecting it', () => {
    const engine = new DrawingEngine();
    engine.commit(trendLine('manual-line'));
    engine.select(null);
    const primitive = new DrawingPrimitive(engine) as any;
    primitive.chart = {};
    primitive.series = {};
    primitive.requestUpdate = vi.fn();
    primitive.project = (point: { time: number; price: number }) => ({ x: point.time, y: point.price });

    primitive.setHovered('manual-line');
    primitive.updateAllViews();

    expect(primitive.requestUpdate).toHaveBeenCalledOnce();
    expect(primitive.shapes[0]).toMatchObject({ selected: false, hovered: true });
  });

  it('uses the default arrow for anchors and move for the drawing body', () => {
    const engine = new DrawingEngine();
    const controller = new DrawingController({ engine }) as any;
    const setHovered = vi.fn();
    controller.el = { style: { cursor: '' } };
    controller.primitive = { setHovered };
    controller.hitTest = vi.fn()
      .mockReturnValueOnce({ id: 'line', kind: 'anchor', anchorIndex: 0 })
      .mockReturnValueOnce({ id: 'line', kind: 'move', anchorIndex: 0 })
      .mockReturnValueOnce(null);

    controller.updateHover(10, 20);
    expect(controller.el.style.cursor).toBe('default');
    expect(setHovered).toHaveBeenNthCalledWith(1, 'line', 0);
    controller.updateHover(20, 30);
    expect(controller.el.style.cursor).toBe('move');
    controller.updateHover(100, 100);
    expect(controller.el.style.cursor).toBe('default');
    expect(setHovered).toHaveBeenNthCalledWith(2, 'line', null);
    expect(setHovered).toHaveBeenLastCalledWith(null, null);
  });

  it('subtly enlarges only the hovered anchor circle', () => {
    const engine = new DrawingEngine();
    engine.commit(trendLine('manual-line'));
    engine.select(null);
    const primitive = new DrawingPrimitive(engine) as any;
    primitive.chart = {};
    primitive.series = {};
    primitive.requestUpdate = vi.fn();
    primitive.project = (point: { time: number; price: number }) => ({ x: point.time, y: point.price });
    primitive.setHovered('manual-line', 1);
    primitive.updateAllViews();

    const arcs: Array<{ x: number; y: number; radius: number }> = [];
    const context = {
      save() {},
      restore() {},
      setLineDash() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fill() {},
      arc(x: number, y: number, radius: number) { arcs.push({ x, y, radius }); },
    };
    primitive.paneViews()[0].renderer().draw({
      useBitmapCoordinateSpace(callback: (scope: unknown) => void) {
        callback({
          context,
          bitmapSize: { width: 200, height: 200 },
          horizontalPixelRatio: 1,
          verticalPixelRatio: 1,
        });
      },
    });

    expect(arcs).toEqual([
      { x: 10, y: 20, radius: 3.5 },
      { x: 30, y: 40, radius: 4.5 },
    ]);
    expect(context).toMatchObject({ lineWidth: 1.5 });
  });

  it('keeps the default arrow cursor while dragging an anchor', () => {
    const engine = new DrawingEngine();
    engine.commit(trendLine('manual-line'));
    const controller = new DrawingController({ engine }) as any;
    controller.el = { style: { cursor: '' } };
    controller.primitive = { setHovered: vi.fn() };
    controller.hitTest = vi.fn(() => ({ id: 'manual-line', kind: 'anchor', anchorIndex: 0 }));
    controller.unproject = vi.fn(() => ({ time: 10, price: 20 }));
    controller.suppressPan = vi.fn();

    controller.onDown({
      offsetX: 10,
      offsetY: 20,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    expect(controller.el.style.cursor).toBe('default');
    expect(controller.primitive.setHovered).toHaveBeenCalledWith('manual-line', 0);
  });
});
