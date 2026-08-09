import { DrawingController, DrawingEngine, DrawingPrimitive, type DrawingStyle } from '@getcandlekit/charts';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPositionRuntimeInterval,
  calculatePositionMetrics,
  installPositionDrawingDefaults,
  normalizePositionSettings,
  positionInitialTicksForVisibleRange,
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

  it('sizes a newly armed position from the visible vertical price range', () => {
    expect(positionInitialTicksForVisibleRange({ from: 29_800, to: 29_920 }, 0.25)).toBe(48);
    expect(positionInitialTicksForVisibleRange({ from: 29_800, to: 29_805 }, 0.25)).toBe(8);
    expect(positionInitialTicksForVisibleRange(null, 0.25)).toBeNull();

    const engine = new DrawingEngine();
    installPositionDrawingDefaults(engine, 'MNQ', 60, () => ({ from: 29_800, to: 29_920 }));
    engine.startTool('LongPosition');

    expect(normalizePositionSettings(
      (engine.getDefaultStyle() as DrawingStyle & { position?: unknown }).position,
    ).initialTicks).toBe(48);
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

  it('defaults every individual position statistic to visible and preserves opt-outs', () => {
    expect(normalizePositionSettings({})).toMatchObject({
      showTargetPercent: true,
      showTargetTicks: true,
      showTargetAmount: true,
      showTargetPnl: true,
      showOpenPnl: true,
      showQuantity: true,
      showRiskReward: true,
      showStopPercent: true,
      showStopTicks: true,
      showStopAmount: true,
      showStopPnl: true,
    });
    expect(normalizePositionSettings({ showTargetAmount: false, showRiskReward: false })).toMatchObject({
      showTargetAmount: false,
      showRiskReward: false,
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
    const priceAxisViews = primitive.priceAxisViews();
    expect(priceAxisViews.map(view => view.text())).toEqual(['28050.00', '28000.00', '27975.00']);
    expect(priceAxisViews.map(view => view.backColor())).toEqual(['#26a69a', '#787b86', '#ef5350']);
  });

  it('lets long position statistics expand from the box center while prices live on the axis', () => {
    const engine = new DrawingEngine();
    const drawing = position();
    drawing.points[1].time = 220;
    drawing.points[2].time = 220;
    engine.commit(drawing);
    const primitive = new DrawingPrimitive(engine);
    primitive.attached({
      chart: { timeScale: () => ({ timeToCoordinate: (time: number) => time }) },
      series: { priceToCoordinate: (price: number) => price },
      requestUpdate: vi.fn(),
    } as never);
    engine.select('position');
    primitive.updateAllViews();
    const context = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      fill: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), ellipse: vi.fn(), closePath: vi.fn(), arc: vi.fn(),
      translate: vi.fn(), rotate: vi.fn(), setLineDash: vi.fn(), fillText: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
      strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: 'butt', font: '', textAlign: 'left', textBaseline: 'alphabetic',
    };

    primitive.paneViews()[0].renderer().draw({
      useBitmapCoordinateSpace: (draw: (scope: unknown) => void) => draw({
        context, bitmapSize: { width: 800, height: 600 }, horizontalPixelRatio: 1, verticalPixelRatio: 1,
      }),
    } as never);

    const statisticBackgrounds = context.fillRect.mock.calls.slice(2, 5);
    expect(statisticBackgrounds).toHaveLength(3);
    expect(statisticBackgrounds.some(([, , width]) => width > 62)).toBe(true);
    expect(context.fillText.mock.calls.some(([text]) => String(text).endsWith('…'))).toBe(false);
    expect(context.fillText.mock.calls.some(([text]) => text === '28050.00')).toBe(false);
    expect(primitive.priceAxisViews()).toHaveLength(3);
  });

  it('centers selected statistic labels and omits unchecked fields', () => {
    const engine = new DrawingEngine();
    const drawing = position();
    drawing.points[1].time = 300;
    drawing.points[2].time = 300;
    drawing.points[2].price = 27_970;
    drawing.style.position = normalizePositionSettings({
      ...drawing.style.position,
      priceLabels: false,
      showTargetPercent: false,
      showTargetTicks: true,
      showTargetAmount: false,
      showTargetPnl: false,
      showOpenPnl: false,
      showQuantity: true,
      showRiskReward: false,
      showStopPercent: false,
      showStopTicks: false,
      showStopAmount: false,
      showStopPnl: false,
    });
    engine.commit(drawing);
    engine.select('position');
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
      translate: vi.fn(), rotate: vi.fn(), setLineDash: vi.fn(), fillText: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
      strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: 'butt', font: '', textAlign: 'left', textBaseline: 'alphabetic',
    };

    primitive.paneViews()[0].renderer().draw({
      useBitmapCoordinateSpace: (draw: (scope: unknown) => void) => draw({
        context, bitmapSize: { width: 800, height: 600 }, horizontalPixelRatio: 1, verticalPixelRatio: 1,
      }),
    } as never);

    expect(context.fillText).toHaveBeenCalledWith('Target: 200t', 200, expect.any(Number));
    expect(context.fillText).toHaveBeenCalledWith('Qty: 1.67', 200, expect.any(Number));
    expect(context.fillText.mock.calls.some(([text]) => String(text).includes('Amount'))).toBe(false);
    expect(context.fillText.mock.calls.some(([text]) => String(text).includes('Risk/reward'))).toBe(false);
    expect(context.fillText.mock.calls.some(([text]) => String(text).startsWith('Stop'))).toBe(false);
    expect(primitive.priceAxisViews()).toEqual([]);
  });

  it('publishes colored target, entry and stop labels on the price axis and hides them when disabled', () => {
    const engine = new DrawingEngine();
    const drawing = position('ShortPosition');
    drawing.style.position = normalizePositionSettings({
      ...drawing.style.position,
      priceLabels: true,
      targetColor: '#11aa2280',
      lineColor: '#2962ff80',
      stopColor: '#ee334480',
      textColor: '#ffffff',
    });
    engine.commit(drawing);
    const primitive = new DrawingPrimitive(engine);
    primitive.attached({
      chart: { timeScale: () => ({ timeToCoordinate: (time: number) => time }) },
      series: { priceToCoordinate: (price: number) => price - 27_000 },
      requestUpdate: vi.fn(),
    } as never);

    primitive.updateAllViews();

    const labels = primitive.priceAxisViews();
    expect(labels.map(view => view.text())).toEqual(['27950.00', '28000.00', '28025.00']);
    expect(labels.map(view => view.coordinate())).toEqual([950, 1_000, 1_025]);
    expect(labels.map(view => view.backColor())).toEqual(['#11aa22', '#2962ff', '#ee3344']);
    expect(labels.map(view => view.textColor())).toEqual(['#ffffff', '#ffffff', '#ffffff']);

    engine.setStyle('position', {
      position: normalizePositionSettings({ ...drawing.style.position, priceLabels: false }),
    } as DrawingStyle);
    primitive.updateAllViews();

    expect(primitive.priceAxisViews()).toEqual([]);
  });

  it('rounds and offsets short-position labels away from their price lines', () => {
    const engine = new DrawingEngine();
    engine.commit(position('ShortPosition'));
    engine.select('position');
    const primitive = new DrawingPrimitive(engine);
    primitive.attached({
      chart: { timeScale: () => ({ timeToCoordinate: (time: number) => time }) },
      series: { priceToCoordinate: (price: number) => 30_000 - price },
      requestUpdate: vi.fn(),
    } as never);
    primitive.updateAllViews();
    const context = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      fill: vi.fn(), fillRect: vi.fn(), roundRect: vi.fn(), strokeRect: vi.fn(), ellipse: vi.fn(), closePath: vi.fn(), arc: vi.fn(),
      translate: vi.fn(), rotate: vi.fn(), setLineDash: vi.fn(), fillText: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
      strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: 'butt', font: '', textAlign: 'left', textBaseline: 'alphabetic',
    };

    primitive.paneViews()[0].renderer().draw({
      useBitmapCoordinateSpace: (draw: (scope: unknown) => void) => draw({
        context, bitmapSize: { width: 800, height: 3_000 }, horizontalPixelRatio: 1, verticalPixelRatio: 1,
      }),
    } as never);

    expect(context.roundRect).toHaveBeenCalledTimes(3);
    const [target, entry, stop] = context.roundRect.mock.calls;
    expect(target[1]).toBeGreaterThan(2_050);
    expect(entry[1]).toBeGreaterThan(2_000);
    expect(stop[1] + stop[3]).toBeLessThan(1_975);
    expect(target[4]).toBe(3);
    expect(Math.max(target[2], entry[2], stop[2])).toBeGreaterThan(150);
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

  it('places the width handle on the right and TP/SL handles on the left edge', () => {
    const engine = new DrawingEngine();
    engine.commit(position());
    const primitive = new DrawingPrimitive(engine) as any;
    primitive.attached({
      chart: { timeScale: () => ({ timeToCoordinate: (time: number) => time }) },
      series: { priceToCoordinate: (price: number) => price },
      requestUpdate: vi.fn(),
    } as never);

    primitive.updateAllViews();

    expect(primitive.shapes[0].handles).toEqual([
      { x: 200, y: 28_000 },
      { x: 100, y: 28_050 },
      { x: 100, y: 27_975 },
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
    controller.unproject = vi.fn((x: number, _y: number, drawingId?: string) => (
      drawingId === 'position' && x === 320
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

describe('applyPositionRuntimeInterval — interval podle panelu, ne podle vzniku', () => {
  // Minimální engine: `applyPositionRuntimeInterval` zapisuje přes `setStyle`,
  // aby úprava vyvolala překreslení.
  const engineWith = (drawings: PositionDrawing[]) => ({
    getDrawings: () => drawings,
    setStyle: (id: string, patch: Record<string, unknown>) => {
      const found = drawings.find(drawing => drawing.id === id);
      if (found) found.style = { ...found.style, ...patch };
    },
  } as unknown as DrawingEngine);

  it('přepíše interval zděděný z panelu, kde kresba vznikla', () => {
    const drawing = position();
    drawing.style.position = normalizePositionSettings({ intervalSeconds: 60 });

    // Kresba z 1m panelu se zrcadlí na 5m: bez srovnání by ji knihovna
    // extrapolovala pětkrát širší.
    const changed = applyPositionRuntimeInterval(engineWith([drawing]), 300);

    expect(changed).toBe(true);
    expect(drawing.style.position?.intervalSeconds).toBe(300);
  });

  it('zachová ostatní nastavení pozice', () => {
    const drawing = position();
    drawing.style.position = normalizePositionSettings({
      intervalSeconds: 60, risk: 250, accountSize: 75_000, initialBars: 9,
    });

    applyPositionRuntimeInterval(engineWith([drawing]), 300);

    expect(drawing.style.position).toMatchObject({
      intervalSeconds: 300, risk: 250, accountSize: 75_000, initialBars: 9,
    });
  });

  it('je idempotentní — druhý průchod už nic nemění', () => {
    const drawing = position();
    drawing.style.position = normalizePositionSettings({ intervalSeconds: 300 });

    expect(applyPositionRuntimeInterval(engineWith([drawing]), 300)).toBe(false);
  });

  it('nesahá na kresby, které nejsou pozice', () => {
    const trend = {
      id: 'trend',
      tool: 'TrendLine',
      points: [{ time: 100, price: 1 }],
      style: { color: '#fff', width: 1, dashed: false, fill: null },
    } as unknown as PositionDrawing;

    expect(applyPositionRuntimeInterval(engineWith([trend]), 300)).toBe(false);
    expect((trend.style as { position?: unknown }).position).toBeUndefined();
  });

  it('nesmyslný interval ignoruje místo aby kresbu rozbil', () => {
    const drawing = position();
    drawing.style.position = normalizePositionSettings({ intervalSeconds: 60 });

    expect(applyPositionRuntimeInterval(engineWith([drawing]), 0)).toBe(false);
    expect(applyPositionRuntimeInterval(engineWith([drawing]), Number.NaN)).toBe(false);
    expect(drawing.style.position?.intervalSeconds).toBe(60);
  });

  it('bez enginu nespadne', () => {
    expect(applyPositionRuntimeInterval(null, 300)).toBe(false);
  });
});
