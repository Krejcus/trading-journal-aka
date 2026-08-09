import { describe, expect, it } from 'vitest';
import { DrawingEngine, DrawingPrimitive, type Drawing } from '@getcandlekit/charts';

const renderLevelY = (firstY: number, secondY: number, reverse = false) => {
  const engine = new DrawingEngine();
  const drawing: Drawing = {
    id: `fib-${firstY}-${secondY}-${reverse}`,
    tool: 'FibRetracement',
    points: [
      { time: 10, price: firstY },
      { time: 20, price: secondY },
    ],
    style: {
      color: '#2962ff',
      width: 1,
      dashed: false,
      fill: 'transparent',
      fib: {
        levels: [{ value: 0.705, visible: true, color: '#2962ff', opacity: 100 }],
        reverse,
        extend: 'none',
        trendLineVisible: false,
        backgroundVisible: false,
        showLevels: false,
        showPrices: false,
      },
    },
  } as Drawing;
  engine.commit(drawing);

  const primitive = new DrawingPrimitive(engine) as any;
  primitive.chart = {};
  primitive.series = {};
  primitive.project = (point: { time: number; price: number }) => ({ x: point.time, y: point.price });
  primitive.updateAllViews();

  const horizontalLines: number[] = [];
  let moveY = 0;
  const context = {
    save() {},
    restore() {},
    setLineDash() {},
    beginPath() {},
    moveTo(_x: number, y: number) { moveY = y; },
    lineTo(_x: number, y: number) {
      if (Math.abs(y - moveY) < 0.001) horizontalLines.push(y);
    },
    stroke() {},
    fillRect() {},
    fillText() {},
    rect() {},
    arc() {},
    fill() {},
  };
  const target = {
    useBitmapCoordinateSpace(callback: (scope: unknown) => void) {
      callback({
        context,
        bitmapSize: { width: 200, height: 200 },
        horizontalPixelRatio: 1,
        verticalPixelRatio: 1,
      });
    },
  };

  primitive.paneViews()[0].renderer().draw(target);
  return horizontalLines[0];
};

describe('CandleKit Fibonacci direction', () => {
  it('places a 0.705 retracement near the first anchor by default', () => {
    expect(renderLevelY(100, 0)).toBeCloseTo(70.5);
    expect(renderLevelY(0, 100)).toBeCloseTo(29.5);
  });

  it('flips the retracement direction only when Reverse is enabled', () => {
    expect(renderLevelY(100, 0, true)).toBeCloseTo(29.5);
  });
});
