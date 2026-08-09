import { DrawingEngine, DrawingPrimitive, type Drawing, type DrawingToolId } from '@getcandlekit/charts';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const rendererFor = (engine: DrawingEngine) => {
  const primitive = new DrawingPrimitive(engine);
  primitive.attached({
    chart: { timeScale: () => ({ timeToCoordinate: (time: number) => time }) },
    series: { priceToCoordinate: (price: number) => price },
    requestUpdate: vi.fn(),
  } as never);
  primitive.updateAllViews();
  return primitive.paneViews()[0].renderer();
};

const bitmapTarget = (context: Record<string, unknown>) => ({
  useBitmapCoordinateSpace: (draw: (scope: unknown) => void) => draw({
    context,
    bitmapSize: { width: 800, height: 600 },
    horizontalPixelRatio: 1,
    verticalPixelRatio: 1,
  }),
});

const canvasContext = () => ({
  save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
  fill: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), ellipse: vi.fn(), closePath: vi.fn(), arc: vi.fn(),
  translate: vi.fn(), rotate: vi.fn(),
  setLineDash: vi.fn(), fillText: vi.fn(), measureText: vi.fn(() => ({ width: 20 })),
  strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: 'butt', font: '', textAlign: 'left', textBaseline: 'alphabetic',
});

describe('AlphaTrade CandleKit drawing extensions', () => {
  it('renders dotted manual drawings with a rounded dot dash pattern', () => {
    const engine = new DrawingEngine();
    engine.commit({
      id: 'dotted', tool: 'TrendLine',
      points: [{ time: 10, price: 20 }, { time: 40, price: 50 }],
      style: { color: '#2962ff', width: 2, dashed: false, lineStyle: 'dotted', fill: null },
    });
    const context = canvasContext();

    rendererFor(engine).draw(bitmapTarget(context) as never);

    expect(context.setLineDash).toHaveBeenCalledWith([1.5, 3]);
    expect(context.lineCap).toBe('round');
  });

  it('creates text in one click and renders every line', () => {
    const engine = new DrawingEngine();
    expect(engine.pointsNeeded('Text')).toBe(1);
    engine.commit({
      id: 'text', tool: 'Text', points: [{ time: 100, price: 200 }],
      style: { color: '#f23645', width: 1, dashed: false, fill: null, text: 'První\nDruhý', fontSize: 18 },
    });
    const context = canvasContext();

    rendererFor(engine).draw(bitmapTarget(context) as never);

    expect(context.fillText).toHaveBeenCalledTimes(2);
    expect(context.fillText).toHaveBeenNthCalledWith(1, 'První', 100, expect.any(Number));
    expect(context.fillText).toHaveBeenNthCalledWith(2, 'Druhý', 100, 200);
    expect(context.font).toContain('18px');
  });

  it('renders an independently styled and positioned label on a drawing object', () => {
    const engine = new DrawingEngine();
    engine.commit({
      id: 'labelled-rectangle', tool: 'Rectangle',
      points: [{ time: 100, price: 100 }, { time: 300, price: 300 }],
      style: {
        color: '#2962ff', width: 1, dashed: false, fill: '#2962ff14',
        text: 'Supply', textColor: '#f23645', fontSize: 16,
        textHorizontal: 'right', textVertical: 'bottom',
      },
    });
    engine.select(null);
    const context = canvasContext();

    rendererFor(engine).draw(bitmapTarget(context) as never);

    expect(context.fillText).toHaveBeenCalledWith('Supply', 296, 296);
    expect(context.fillStyle).toBe('#f23645');
    expect(context.textAlign).toBe('right');
    expect(context.textBaseline).toBe('bottom');
  });

  it('keeps Backspace and Delete inside editable drawing settings fields', () => {
    const patch = readFileSync('patches/@getcandlekit+charts+0.1.0.patch', 'utf8');

    expect(patch).toContain('target.closest(\'input, textarea, select, [contenteditable="true"], [role="textbox"]\')');
    expect(patch).toContain('if (e.key === "Delete" || e.key === "Backspace")');
  });

  it('keeps every drawing interactive in future whitespace after a clean dependency install', () => {
    const patch = readFileSync('patches/@getcandlekit+charts+0.1.0.patch', 'utf8');

    expect(patch).toContain('coordinateToDrawingTime = (chart, x, referenceTime, intervalSeconds = 60, fallbackReferenceTime = null)');
    expect(patch).toContain('anchorTime = fallbackReferenceTime');
    expect(patch).toContain('seriesIntervalSeconds = (series, fallback = 60)');
    expect(patch).toContain('const dp = this.unproject(e.offsetX, e.offsetY, this.drag.id)');
    expect(patch).toContain('if (drawing?.points[0])');
    expect(patch).toContain('this.engine.setPoints(this.drag.id, points, dp)');
  });

  it('rotates trendline labels with the line while keeping reversed lines readable', () => {
    const engine = new DrawingEngine();
    engine.commit({
      id: 'angled-label', tool: 'TrendLine',
      points: [{ time: 300, price: 300 }, { time: 100, price: 100 }],
      style: {
        color: '#9c27b0', width: 1, dashed: false, fill: null,
        text: 'Trend', textHorizontal: 'center', textVertical: 'top',
      },
    });
    engine.select(null);
    const context = canvasContext();

    rendererFor(engine).draw(bitmapTarget(context) as never);

    expect(context.rotate).toHaveBeenCalledTimes(1);
    expect(context.rotate).toHaveBeenCalledWith(expect.closeTo(Math.PI / 4, 6));
    expect(context.translate).toHaveBeenCalledWith(
      expect.closeTo(202.828, 3),
      expect.closeTo(197.172, 3),
    );
    expect(context.fillText).toHaveBeenCalledWith('Trend', 0, 0);
  });

  it('splits a middle-aligned trendline around its label without painting over the chart', () => {
    const engine = new DrawingEngine();
    engine.commit({
      id: 'middle-label-gap', tool: 'TrendLine',
      points: [{ time: 100, price: 100 }, { time: 300, price: 300 }],
      style: {
        color: '#9c27b0', width: 1, dashed: false, fill: null,
        text: 'Trend', fontSize: 12,
        textHorizontal: 'center', textVertical: 'middle',
      },
    });
    engine.select(null);
    const context = canvasContext();

    rendererFor(engine).draw(bitmapTarget(context) as never);

    expect(context.moveTo).toHaveBeenCalledTimes(2);
    expect(context.lineTo).toHaveBeenCalledTimes(2);
    expect(context.lineTo).toHaveBeenNthCalledWith(
      1,
      expect.closeTo(190.101, 3),
      expect.closeTo(190.101, 3),
    );
    expect(context.moveTo).toHaveBeenNthCalledWith(
      2,
      expect.closeTo(209.899, 3),
      expect.closeTo(209.899, 3),
    );
    expect(context.fillRect).not.toHaveBeenCalled();
  });

  it.each([
    ['HorizontalLine', [{ time: 400, price: 200 }], 2],
    ['HorizontalRay', [{ time: 100, price: 200 }], 2],
    ['Ray', [{ time: 100, price: 200 }, { time: 300, price: 200 }], 2],
    ['ExtendedLine', [{ time: 100, price: 200 }, { time: 300, price: 200 }], 2],
    ['Arrow', [{ time: 100, price: 200 }, { time: 300, price: 200 }], 3],
  ] as const)('splits the middle label on %s', (tool, points, expectedStrokes) => {
    const engine = new DrawingEngine();
    engine.commit({
      id: `middle-${tool}`, tool: tool as DrawingToolId,
      points: points.map(point => ({ ...point })),
      style: {
        color: '#2962ff', width: 1, dashed: false, fill: null,
        text: 'Label', fontSize: 12,
        textHorizontal: 'center', textVertical: 'middle',
      },
    } as Drawing);
    engine.select(null);
    const context = canvasContext();

    rendererFor(engine).draw(bitmapTarget(context) as never);

    expect(context.stroke).toHaveBeenCalledTimes(expectedStrokes);
  });

  it('splits vertical and cross lines only where their middle label intersects', () => {
    const vertical = new DrawingEngine();
    vertical.commit({
      id: 'middle-vertical', tool: 'VerticalLine', points: [{ time: 400, price: 200 }],
      style: {
        color: '#2962ff', width: 1, dashed: false, fill: null,
        text: 'Label', fontSize: 12,
        textHorizontal: 'center', textVertical: 'middle',
      },
    });
    vertical.select(null);
    const verticalContext = canvasContext();
    rendererFor(vertical).draw(bitmapTarget(verticalContext) as never);

    const cross = new DrawingEngine();
    cross.commit({
      id: 'middle-cross', tool: 'CrossLine', points: [{ time: 400, price: 300 }],
      style: {
        color: '#2962ff', width: 1, dashed: false, fill: null,
        text: 'Label', fontSize: 12,
        textHorizontal: 'center', textVertical: 'middle',
      },
    });
    cross.select(null);
    const crossContext = canvasContext();
    rendererFor(cross).draw(bitmapTarget(crossContext) as never);

    expect(verticalContext.stroke).toHaveBeenCalledTimes(2);
    expect(crossContext.stroke).toHaveBeenCalledTimes(4);
  });

  it('moves a right-aligned arrowhead before its middle label', () => {
    const engine = new DrawingEngine();
    engine.commit({
      id: 'right-arrow-label', tool: 'Arrow',
      points: [{ time: 100, price: 200 }, { time: 300, price: 200 }],
      style: {
        color: '#2962ff', width: 1, dashed: false, fill: null,
        text: 'Label', fontSize: 12,
        textHorizontal: 'right', textVertical: 'middle',
      },
    });
    engine.select(null);
    const context = canvasContext();

    rendererFor(engine).draw(bitmapTarget(context) as never);

    expect(context.lineTo).toHaveBeenNthCalledWith(1, 276, 200);
    expect(context.moveTo).not.toHaveBeenCalledWith(300, 200);
  });

  it('splits Fibonacci levels around middle-aligned level labels', () => {
    const engine = new DrawingEngine();
    engine.commit({
      id: 'middle-fib-label', tool: 'FibRetracement',
      points: [{ time: 100, price: 100 }, { time: 300, price: 300 }],
      style: {
        color: '#2962ff', width: 1, dashed: false, fill: null,
        fib: {
          levels: [{ value: 0.5, visible: true, color: '#2962ff', opacity: 100 }],
          extend: 'none', trendLineVisible: false, backgroundVisible: false,
          showLevels: true, showPrices: false,
          labelsPosition: 'right', labelsVertical: 'middle', fontSize: 12,
        },
      },
    } as Drawing);
    engine.select(null);
    const context = canvasContext();

    rendererFor(engine).draw(bitmapTarget(context) as never);

    expect(context.moveTo).toHaveBeenCalledWith(100, 200);
    expect(context.lineTo).toHaveBeenCalledWith(272, 200);
    expect(context.fillText).toHaveBeenCalledWith('0.5', 296, 200);
  });
});
