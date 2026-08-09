import { describe, expect, it, vi } from 'vitest';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { installChartWorkspaceSync, syncedCrosshairCandle } from '../services/chartWorkspaceSync';

const candle = (time: number, close: number) => ({
  time,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 1,
});

const fakeChartApi = (visibleRange = { from: 100, to: 200 }) => {
  const crosshairHandlers: Array<(param: any) => void> = [];
  const clickHandlers: Array<(param: any) => void> = [];
  const rangeHandlers: Array<(range: any) => void> = [];
  const timeScale = {
    getVisibleRange: vi.fn(() => visibleRange),
    setVisibleRange: vi.fn(),
    subscribeVisibleTimeRangeChange: vi.fn((handler: (range: any) => void) => rangeHandlers.push(handler)),
    unsubscribeVisibleTimeRangeChange: vi.fn(),
  };
  const chart = {
    timeScale: vi.fn(() => timeScale),
    setCrosshairPosition: vi.fn(),
    clearCrosshairPosition: vi.fn(),
    subscribeCrosshairMove: vi.fn((handler: (param: any) => void) => crosshairHandlers.push(handler)),
    unsubscribeCrosshairMove: vi.fn(),
    subscribeClick: vi.fn((handler: (param: any) => void) => clickHandlers.push(handler)),
    unsubscribeClick: vi.fn(),
  };
  const series = {
    id: Symbol('series'),
    coordinateToPrice: vi.fn((coordinate: number) => coordinate * 2),
  };
  const api = {
    controller: {
      getChart: () => chart,
      getSeries: () => series,
    },
  } as unknown as ChartViewApi;
  return { api, chart, series, timeScale, crosshairHandlers, clickHandlers, rangeHandlers };
};

describe('chart workspace synchronization', () => {
  it('syncs crosshair, clicked time and date range to sibling charts', async () => {
    const left = fakeChartApi({ from: 0, to: 100 });
    const right = fakeChartApi({ from: 100, to: 200 });
    const cleanup = installChartWorkspaceSync(new Map([
      ['left', { chartApi: left.api, candles: [candle(120, 10), candle(180, 20)] }],
      ['right', { chartApi: right.api, candles: [candle(120, 30), candle(180, 40)] }],
    ]), { crosshair: true, time: true, dateRange: true });

    left.crosshairHandlers[0]({ time: 175, point: { x: 4, y: 5 } });
    expect(right.chart.setCrosshairPosition).toHaveBeenCalledWith(10, 180, right.series);
    expect(left.series.coordinateToPrice).toHaveBeenCalledWith(5);
    await Promise.resolve();
    left.crosshairHandlers[0]({});
    expect(right.chart.clearCrosshairPosition).toHaveBeenCalledOnce();

    left.clickHandlers[0]({ time: 500 });
    expect(right.timeScale.setVisibleRange).toHaveBeenCalledWith({ from: 450, to: 550 });

    left.rangeHandlers[0]({ from: 250, to: 400 });
    expect(right.timeScale.setVisibleRange).toHaveBeenLastCalledWith({ from: 250, to: 400 });

    cleanup();
    expect(left.chart.unsubscribeCrosshairMove).toHaveBeenCalledOnce();
    expect(left.chart.unsubscribeClick).toHaveBeenCalledOnce();
    expect(left.timeScale.unsubscribeVisibleTimeRangeChange).toHaveBeenCalledOnce();
  });

  it('does not attach disabled synchronization channels', () => {
    const left = fakeChartApi();
    const right = fakeChartApi();
    installChartWorkspaceSync(new Map([
      ['left', { chartApi: left.api, candles: [candle(100, 10)] }],
      ['right', { chartApi: right.api, candles: [candle(100, 20)] }],
    ]), { crosshair: false, time: false, dateRange: false });

    expect(left.chart.subscribeCrosshairMove).not.toHaveBeenCalled();
    expect(left.chart.subscribeClick).not.toHaveBeenCalled();
    expect(left.timeScale.subscribeVisibleTimeRangeChange).not.toHaveBeenCalled();
  });

  it('snaps a synchronized crosshair price to the NQ/MNQ tick size', () => {
    const left = fakeChartApi();
    const right = fakeChartApi();
    installChartWorkspaceSync(new Map([
      ['left', { chartApi: left.api, candles: [candle(100, 10)] }],
      ['right', { chartApi: right.api, candles: [candle(100, 20)] }],
    ]), { crosshair: true, time: false, dateRange: false });

    left.crosshairHandlers[0]({ time: 100, point: { x: 4, y: 5.33 } });

    expect(right.chart.setCrosshairPosition).toHaveBeenCalledWith(10.75, 100, right.series);
  });

  it('reads the latest replay candles without reinstalling sync handlers', () => {
    const left = fakeChartApi();
    const right = fakeChartApi();
    let replayCandles = [candle(100, 20)];
    installChartWorkspaceSync(new Map([
      ['left', { chartApi: left.api, getCandles: () => [candle(100, 10)] }],
      ['right', { chartApi: right.api, getCandles: () => replayCandles }],
    ]), { crosshair: true, time: false, dateRange: false });

    replayCandles = [candle(100, 20), candle(160, 21)];
    left.crosshairHandlers[0]({ time: 159, point: { x: 4, y: 5 } });

    expect(right.chart.setCrosshairPosition).toHaveBeenCalledWith(10, 160, right.series);
    expect(right.chart.subscribeCrosshairMove).toHaveBeenCalledOnce();
  });

  it('clears the crosshair in a pane scrolled to another period instead of pinning it to the edge', () => {
    const left = fakeChartApi({ from: 900, to: 1_000 });
    const right = fakeChartApi({ from: 100, to: 200 });
    installChartWorkspaceSync(new Map([
      ['left', { chartApi: left.api, candles: [candle(100, 10), candle(960, 11)] }],
      ['right', { chartApi: right.api, candles: [candle(100, 20), candle(960, 21)] }],
    ]), { crosshair: true, time: false, dateRange: false });

    left.crosshairHandlers[0]({ time: 955, point: { x: 4, y: 5 } });

    expect(right.chart.setCrosshairPosition).not.toHaveBeenCalled();
    expect(right.chart.clearCrosshairPosition).toHaveBeenCalledOnce();
  });
});

describe('cíl synchronizovaného kurzoru', () => {
  const candles = [candle(100, 10), candle(160, 11), candle(220, 12)];

  it('vrátí nejbližší svíčku, když čas leží ve výřezu i v datech', () => {
    expect(syncedCrosshairCandle({ candles, time: 159, visibleRange: { from: 100, to: 220 } }))
      .toMatchObject({ time: 160 });
  });

  it('nevrací nic, když je panel odscrollovaný jinam', () => {
    expect(syncedCrosshairCandle({ candles, time: 159, visibleRange: { from: 180, to: 220 } })).toBeNull();
  });

  it('nevrací nic pro čas mimo načtená data', () => {
    expect(syncedCrosshairCandle({ candles, time: 5_000, visibleRange: { from: 0, to: 9_000 } })).toBeNull();
    expect(syncedCrosshairCandle({ candles, time: 10, visibleRange: { from: 0, to: 9_000 } })).toBeNull();
  });

  it('nevrací nic, když graf zatím nemá viditelný rozsah', () => {
    expect(syncedCrosshairCandle({ candles, time: 160, visibleRange: null })).toBeNull();
  });
});
