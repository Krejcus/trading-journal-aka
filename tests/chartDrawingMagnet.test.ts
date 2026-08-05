import { describe, expect, it, vi } from 'vitest';
import {
  createDrawingMagnetResolver,
  installDrawingMagnet,
  setDrawingMagnetSettings,
} from '../services/chartDrawingMagnet';

const candles = [
  { time: 60, open: 100, high: 105, low: 95, close: 102, volume: 1 },
  { time: 120, open: 102, high: 108, low: 101, close: 107, volume: 1 },
];

const projector = {
  timeToX: (time: number) => time / 60,
  priceToY: (price: number) => price,
};

describe('drawing magnet', () => {
  it('weak mode snaps only inside the pixel tolerance', () => {
    setDrawingMagnetSettings({ mode: 'weak', snapToIndicators: false });
    const resolve = createDrawingMagnetResolver({ candles }, projector);
    expect(resolve({ time: 60, price: 101.4 })).toEqual({ time: 60, price: 102 });
    expect(resolve({ time: 60, price: 140 })).toEqual({ time: 60, price: 140 });
  });

  it('strong mode always chooses the closest OHLC anchor', () => {
    setDrawingMagnetSettings({ mode: 'strong', snapToIndicators: false });
    const resolve = createDrawingMagnetResolver({ candles }, projector);
    expect(resolve({ time: 60, price: 140 })).toEqual({ time: 120, price: 108 });
  });

  it('moves the crosshair callback to the resolved snap point', () => {
    const onSnap = vi.fn();
    setDrawingMagnetSettings({ mode: 'weak', snapToIndicators: false });
    const resolve = createDrawingMagnetResolver({ candles }, { ...projector, onSnap });
    resolve({ time: 60, price: 101.4 });
    expect(onSnap).toHaveBeenCalledWith({ time: 60, price: 102 });
  });

  it('snaps the very first anchor passed to beginDraft', () => {
    setDrawingMagnetSettings({ mode: 'weak', snapToIndicators: false });
    const beginDraft = vi.fn();
    const engine = {
      beginDraft,
      updateDraftEnd: vi.fn(),
      appendDraftPoint: vi.fn(),
      commit: vi.fn(),
      getDraft: vi.fn(() => null),
      getById: vi.fn(),
      setPoints: vi.fn(),
    };
    const restore = installDrawingMagnet(
      engine,
      createDrawingMagnetResolver({ candles }, projector),
    );

    engine.beginDraft('TrendLine', { time: 60, price: 101.4 });

    expect(beginDraft).toHaveBeenCalledWith('TrendLine', { time: 60, price: 102 });
    restore();
  });

  it('snaps the final clicked anchor before committing a draft', () => {
    setDrawingMagnetSettings({ mode: 'weak', snapToIndicators: false });
    const commit = vi.fn();
    const engine = {
      beginDraft: vi.fn(),
      updateDraftEnd: vi.fn(),
      appendDraftPoint: vi.fn(),
      commit,
      getDraft: vi.fn(() => ({
        points: [
          { time: 60, price: 102 },
          { time: 120, price: 107 },
        ],
      })),
      getById: vi.fn(),
      setPoints: vi.fn(),
    };
    const restore = installDrawingMagnet(
      engine,
      createDrawingMagnetResolver({ candles }, projector),
    );

    engine.commit({
      id: 'manual-trend-line',
      tool: 'TrendLine',
      points: [
        { time: 60, price: 102 },
        { time: 120, price: 107.4 },
      ],
    });

    expect(commit).toHaveBeenCalledWith({
      id: 'manual-trend-line',
      tool: 'TrendLine',
      points: [
        { time: 60, price: 102 },
        { time: 120, price: 107 },
      ],
    });
    restore();
  });

  it('does not alter generated drawings when they are committed', () => {
    setDrawingMagnetSettings({ mode: 'strong', snapToIndicators: false });
    const commit = vi.fn();
    const engine = {
      beginDraft: vi.fn(),
      updateDraftEnd: vi.fn(),
      appendDraftPoint: vi.fn(),
      commit,
      getDraft: vi.fn(() => ({ points: [{ time: 60, price: 102 }] })),
      getById: vi.fn(),
      setPoints: vi.fn(),
    };
    const restore = installDrawingMagnet(
      engine,
      createDrawingMagnetResolver({ candles }, projector),
    );
    const drawing = {
      id: 'auto-risk-box',
      points: [{ time: 90, price: 103.3 }],
    };

    engine.commit(drawing);

    expect(commit).toHaveBeenCalledWith(drawing);
    restore();
  });

  it('adds visible indicator plots only when indicator snapping is enabled', () => {
    const resolve = createDrawingMagnetResolver({
      candles,
      indicatorSeries: [[{ time: 60, value: 101.25 }]],
      indicatorSegments: [{ startTime: 60, endTime: 120, price: 101.5 }],
    }, projector);
    setDrawingMagnetSettings({ mode: 'weak', snapToIndicators: false });
    expect(resolve({ time: 60, price: 101.3 })).toEqual({ time: 60, price: 102 });
    setDrawingMagnetSettings({ mode: 'weak', snapToIndicators: true });
    expect(resolve({ time: 60, price: 101.3 })).toEqual({ time: 60, price: 101.25 });
  });

  it('snaps a moved anchor without deforming the untouched anchor', () => {
    setDrawingMagnetSettings({ mode: 'weak', snapToIndicators: false });
    const setPoints = vi.fn();
    const previous = [{ time: 60, price: 102 }, { time: 120, price: 107 }];
    const engine = {
      beginDraft: vi.fn(),
      updateDraftEnd: vi.fn(),
      appendDraftPoint: vi.fn(),
      commit: vi.fn(),
      getDraft: vi.fn(() => null),
      getById: vi.fn(() => ({ points: previous })),
      setPoints,
    };
    const restore = installDrawingMagnet(engine, createDrawingMagnetResolver({ candles }, projector));

    engine.setPoints('manual-line', [previous[0], { time: 120, price: 107.4 }]);

    expect(setPoints).toHaveBeenCalledWith('manual-line', [previous[0], { time: 120, price: 107 }]);
    restore();
  });

  it('keeps a whole-object drag rigid instead of snapping every anchor independently', () => {
    setDrawingMagnetSettings({ mode: 'strong', snapToIndicators: false });
    const setPoints = vi.fn();
    const previous = [{ time: 60, price: 102 }, { time: 120, price: 107 }];
    const moved = [{ time: 90, price: 103.4 }, { time: 150, price: 108.4 }];
    const engine = {
      beginDraft: vi.fn(),
      updateDraftEnd: vi.fn(),
      appendDraftPoint: vi.fn(),
      commit: vi.fn(),
      getDraft: vi.fn(() => null),
      getById: vi.fn(() => ({ points: previous })),
      setPoints,
    };
    const restore = installDrawingMagnet(engine, createDrawingMagnetResolver({ candles }, projector));

    engine.setPoints('manual-line', moved);

    expect(setPoints).toHaveBeenCalledWith('manual-line', moved);
    restore();
  });
});
