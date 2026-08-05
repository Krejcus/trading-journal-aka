import { DrawingController, DrawingEngine, DrawingPrimitive, type DrawingStyle } from '@getcandlekit/charts';
import { describe, expect, it, vi } from 'vitest';
import {
  calculatePositionMetrics,
  installPositionDrawingDefaults,
  normalizePositionSettings,
  type PositionDrawing,
} from '../services/chartPositionDrawing';

const position = (tool: PositionDrawing['tool'] = 'LongPosition'): PositionDrawing => ({
  id: 'position',
  tool,
  points: [
    { time: 100, price: 28_000 },
    { time: 200, price: tool === 'LongPosition' ? 28_050 : 27_950 },
    { time: 200, price: tool === 'LongPosition' ? 27_975 : 28_025 },
  ],
  style: {
    color: '#787b86', width: 1, dashed: false, fill: null,
    position: normalizePositionSettings({ risk: 100, accountSize: 50_000, pointValue: 2 }),
  },
});

describe('TradingView-like Long/Short position drawings', () => {
  it('creates the complete symmetric box immediately from the first click', () => {
    const engine = new DrawingEngine();
    engine.setDefaultStyle({
      ...engine.getDefaultStyle(),
      position: normalizePositionSettings({ intervalSeconds: 60, initialBars: 6, initialTicks: 40, tickSize: 0.25 }),
    } as DrawingStyle);
    engine.commit({
      id: 'long', tool: 'LongPosition',
      points: [{ time: 10, price: 100 }],
      style: engine.getDefaultStyle(),
    });
    engine.commit({
      id: 'short', tool: 'ShortPosition',
      points: [{ time: 30, price: 100 }],
      style: engine.getDefaultStyle(),
    });

    expect(engine.pointsNeeded('LongPosition')).toBe(1);
    expect(engine.getById('long')?.points).toEqual([
      { time: 10, price: 100 }, { time: 370, price: 110 }, { time: 370, price: 90 },
    ]);
    expect(engine.getById('short')?.points).toEqual([
      { time: 30, price: 100 }, { time: 390, price: 90 }, { time: 390, price: 110 },
    ]);
  });

  it('snaps every position level to the MNQ/NQ quarter tick', () => {
    const engine = new DrawingEngine();
    engine.setDefaultStyle({
      ...engine.getDefaultStyle(),
      position: normalizePositionSettings({ tickSize: 0.25 }),
    } as DrawingStyle);
    engine.commit({
      id: 'snapped', tool: 'LongPosition',
      points: [{ time: 10, price: 28_000.13 }, { time: 20, price: 28_000.19 }],
      style: engine.getDefaultStyle(),
    });

    expect(engine.getById('snapped')?.points.map(point => point.price)).toEqual([28_000.25, 28_000.5, 28_000]);
    engine.setPoints('snapped', [
      { time: 10, price: 28_000.11 }, { time: 20, price: 28_001.12 }, { time: 20, price: 27_999.88 },
    ]);
    expect(engine.getById('snapped')?.points.map(point => point.price)).toEqual([28_000, 28_001, 27_999.75]);
  });

  it('uses MNQ and NQ point values when a new position tool is armed', () => {
    const mnq = new DrawingEngine();
    const nq = new DrawingEngine();
    installPositionDrawingDefaults(mnq, 'MNQ');
    installPositionDrawingDefaults(nq, 'NQ');
    mnq.startTool('LongPosition');
    nq.startTool('ShortPosition');

    expect(normalizePositionSettings((mnq.getDefaultStyle() as DrawingStyle & { position?: unknown }).position).pointValue).toBe(2);
    expect(normalizePositionSettings((nq.getDefaultStyle() as DrawingStyle & { position?: unknown }).position).pointValue).toBe(20);
  });

  it('calculates TradingView-style risk, quantity, R multiple and account amounts', () => {
    const metrics = calculatePositionMetrics(position());

    expect(metrics).toMatchObject({
      targetTicks: 200,
      stopTicks: 100,
      riskReward: 2,
      riskUsd: 100,
      targetPnl: 200,
      stopPnl: -100,
      quantity: 2,
      targetAmount: 50_200,
      stopAmount: 49_900,
    });
  });

  it('caps position size by available leveraged buying power', () => {
    const drawing = position();
    drawing.style.position = normalizePositionSettings({
      accountSize: 1_000,
      leverage: 1,
      risk: 1_000,
      pointValue: 2,
      lotSize: 1,
    });

    const metrics = calculatePositionMetrics(drawing);

    expect(metrics?.quantity).toBeCloseTo(1_000 / (28_000 * 2));
    expect(metrics?.riskUsd).toBeCloseTo((1_000 / (28_000 * 2)) * 25 * 2);
    expect(metrics?.stopAmount).toBeCloseTo(1_000 - (1_000 / (28_000 * 2)) * 25 * 2);
  });

  it('renders separate target and stop fills, three levels and live statistics', () => {
    const engine = new DrawingEngine();
    engine.commit(position());
    const primitive = new DrawingPrimitive(engine);
    primitive.attached({
      chart: { timeScale: () => ({ timeToCoordinate: (time: number) => time }) },
      series: { priceToCoordinate: (price: number) => price },
      requestUpdate: vi.fn(),
    } as never);
    primitive.updateAllViews();
    const context = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      fill: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), ellipse: vi.fn(), closePath: vi.fn(), arc: vi.fn(),
      translate: vi.fn(), rotate: vi.fn(), setLineDash: vi.fn(), fillText: vi.fn(), measureText: vi.fn(() => ({ width: 20 })),
      strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: 'butt', font: '', textAlign: 'left', textBaseline: 'alphabetic',
    };

    primitive.paneViews()[0].renderer().draw({
      useBitmapCoordinateSpace: (draw: (scope: unknown) => void) => draw({
        context, bitmapSize: { width: 800, height: 600 }, horizontalPixelRatio: 1, verticalPixelRatio: 1,
      }),
    } as never);

    expect(context.fillRect.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(context.stroke.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(context.fillText).toHaveBeenCalledWith(expect.stringContaining('Risk/reward ratio: 2.00'), expect.any(Number), expect.any(Number));
  });

  it('survives engine export/import with all three prices and financial settings', () => {
    const source = new DrawingEngine();
    source.commit(position('ShortPosition'));
    const restored = new DrawingEngine();
    restored.import(source.export());

    expect(restored.getById('position')).toEqual(source.getById('position'));
  });

  it('uses the right entry handle only for width and left handles only for target/stop', () => {
    const engine = new DrawingEngine();
    engine.commit(position());
    const controller = new DrawingController({ engine }) as unknown as {
      drag: { id: string; kind: 'anchor'; anchorIndex: number; last: { time: number; price: number } };
      unproject: () => { time: number; price: number };
      setCursor: () => void;
      onMove: (event: { offsetX: number; offsetY: number }) => void;
    };
    controller.drag = { id: 'position', kind: 'anchor', anchorIndex: 0, last: { time: 200, price: 28_000 } };
    controller.unproject = () => ({ time: 260, price: 28_060 });
    controller.setCursor = () => {};

    controller.onMove({ offsetX: 0, offsetY: 0 });

    expect(engine.getById('position')?.points.map(point => point.time)).toEqual([100, 260, 260]);

    controller.drag = { id: 'position', kind: 'anchor', anchorIndex: 1, last: { time: 100, price: 28_050 } };
    controller.unproject = () => ({ time: 999, price: 28_075 });
    controller.onMove({ offsetX: 0, offsetY: 0 });

    expect(engine.getById('position')?.points).toEqual([
      { time: 100, price: 28_000 },
      { time: 260, price: 28_075 },
      { time: 260, price: 27_975 },
    ]);
  });

  it('projects the right edge into future whitespace beyond the last candle', () => {
    const engine = new DrawingEngine();
    const drawing = position();
    drawing.points[1].time = 700;
    drawing.points[2].time = 700;
    drawing.style.position = normalizePositionSettings({ intervalSeconds: 60 });
    engine.commit(drawing);
    const primitive = new DrawingPrimitive(engine) as unknown as {
      attached: (param: unknown) => void;
      updateAllViews: () => void;
      shapes: Array<{ anchors: Array<{ x: number | null; y: number | null }>; handles: Array<{ x: number | null; y: number | null }> }>;
    };
    primitive.attached({
      chart: { timeScale: () => ({
        timeToCoordinate: (time: number) => time === 100 ? 50 : null,
        logicalToCoordinate: (logical: number) => logical * 8,
      }) },
      series: { priceToCoordinate: (price: number) => price },
      requestUpdate: vi.fn(),
    } as never);

    primitive.updateAllViews();

    expect(primitive.shapes[0].anchors[1].x).toBe(130);
    expect(primitive.shapes[0].handles[0].x).toBe(130);
  });

  it('renders a position whose entry and right edge are both beyond the last candle', () => {
    const engine = new DrawingEngine();
    const drawing = position();
    drawing.points = [
      { time: 700, price: 28_000 },
      { time: 1_060, price: 28_050 },
      { time: 1_060, price: 27_975 },
    ];
    drawing.style.position = normalizePositionSettings({ intervalSeconds: 60 });
    engine.commit(drawing);
    const primitive = new DrawingPrimitive(engine) as any;
    primitive.attached({
      chart: { timeScale: () => ({
        timeToCoordinate: (time: number) => time === 100 ? 50 : null,
        logicalToCoordinate: (logical: number) => logical * 8,
      }) },
      series: {
        data: () => [{ time: 100, open: 1, high: 1, low: 1, close: 1 }],
        priceToCoordinate: (price: number) => price,
      },
      requestUpdate: vi.fn(),
    } as never);

    primitive.updateAllViews();

    expect(primitive.shapes[0].anchors[0].x).toBe(130);
    expect(primitive.shapes[0].anchors[1].x).toBe(178);
    expect(primitive.shapes[0].handles[0].x).toBe(178);
  });

  it('starts moving an unselected position from future whitespace on the first pointer down', () => {
    const engine = new DrawingEngine();
    engine.commit(position());
    engine.select(null);
    const controller = new DrawingController({ engine }) as any;
    controller.hitTest = vi.fn(() => ({ id: 'position', kind: 'move', anchorIndex: 0 }));
    controller.unproject = vi.fn((_x: number, _y: number, drawingId?: string) => (
      drawingId === 'position'
        ? { time: 240, price: 28_010 }
        : { time: 300, price: 28_020 }
    ));
    controller.suppressPan = vi.fn();
    controller.setCursor = vi.fn();
    controller.primitive = { setHovered: vi.fn() };

    controller.onDown({
      offsetX: 320,
      offsetY: 180,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    expect(controller.unproject).toHaveBeenCalledWith(320, 180, 'position');
    expect(engine.getSelectedId()).toBe('position');
    expect(controller.drag).toMatchObject({ id: 'position', kind: 'move' });

    controller.onMove({ offsetX: 350, offsetY: 200 });

    expect(engine.getById('position')?.points).toEqual([
      { time: 160, price: 28_010 },
      { time: 260, price: 28_060 },
      { time: 260, price: 27_985 },
    ]);
  });

  it('creates a new position when its first click is in future whitespace', () => {
    const engine = new DrawingEngine();
    engine.setDefaultStyle({
      ...engine.getDefaultStyle(),
      position: normalizePositionSettings({ intervalSeconds: 60, initialBars: 6, initialTicks: 40 }),
    } as DrawingStyle);
    engine.startTool('LongPosition');
    const controller = new DrawingController({ engine }) as any;
    controller.chart = {
      applyOptions: vi.fn(),
      timeScale: () => ({
        coordinateToTime: () => null,
        timeToCoordinate: (time: number) => time === 1_000 ? 100 : null,
        logicalToCoordinate: (logical: number) => logical * 10,
      }),
    };
    controller.series = {
      coordinateToPrice: (price: number) => price,
      data: () => [{ time: 1_000, open: 1, high: 1, low: 1, close: 1 }],
    };

    controller.onDown({
      offsetX: 130,
      offsetY: 28_000,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    const created = engine.getDrawings()[0];
    expect(created.points).toEqual([
      { time: 1_180, price: 28_000 },
      { time: 1_540, price: 28_010 },
      { time: 1_540, price: 27_990 },
    ]);
  });
});
