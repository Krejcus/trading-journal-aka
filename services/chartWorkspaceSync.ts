import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { IChartApi, Time, UTCTimestamp } from 'lightweight-charts';
import type { MarketCandle } from './marketData';
import { roundNqMnqPriceToTick } from './chartPriceTick';

export interface ChartWorkspaceSyncSettings {
  symbol: boolean;
  interval: boolean;
  crosshair: boolean;
  time: boolean;
  dateRange: boolean;
}

export interface WorkspaceChartSyncControl {
  chartApi: ChartViewApi | null;
  candles?: MarketCandle[];
  getCandles?: () => MarketCandle[];
}

const currentCandles = (control: WorkspaceChartSyncControl): MarketCandle[] =>
  control.getCandles?.() ?? control.candles ?? [];

const nearestCandle = (candles: MarketCandle[], time: number) => {
  if (!candles.length) return null;
  let low = 0;
  let high = candles.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (candles[middle].time < time) low = middle + 1;
    else high = middle - 1;
  }
  if (low <= 0) return candles[0];
  if (low >= candles.length) return candles[candles.length - 1];
  return Math.abs(candles[low].time - time) < Math.abs(candles[low - 1].time - time)
    ? candles[low]
    : candles[low - 1];
};

export const installChartWorkspaceSync = (
  sourceControls: Iterable<[string, WorkspaceChartSyncControl]>,
  settings: Pick<ChartWorkspaceSyncSettings, 'crosshair' | 'time' | 'dateRange'>,
) => {
  const controls = [...sourceControls].filter(([, control]) => Boolean(control.chartApi));
  if (controls.length < 2) return () => undefined;
  const cleanups: Array<() => void> = [];
  let crosshairSyncing = false;
  let rangeSyncing = false;

  controls.forEach(([sourceId, source]) => {
    const sourceApi = source.chartApi;
    if (!sourceApi) return;
    const sourceChart = sourceApi.controller.getChart();

    if (settings.crosshair) {
      const handleCrosshair: Parameters<IChartApi['subscribeCrosshairMove']>[0] = param => {
        if (crosshairSyncing) return;
        crosshairSyncing = true;
        controls.forEach(([targetId, target]) => {
          if (targetId === sourceId || !target.chartApi) return;
          const targetChart = target.chartApi.controller.getChart();
          if (typeof param.time !== 'number' || !param.point) {
            targetChart.clearCrosshairPosition();
            return;
          }
          const candle = nearestCandle(currentCandles(target), Number(param.time));
          if (!candle) return;
          const cursorPrice = sourceApi.controller.getSeries().coordinateToPrice(param.point.y);
          if (cursorPrice === null || !Number.isFinite(cursorPrice)) return;
          targetChart.setCrosshairPosition(
            roundNqMnqPriceToTick(cursorPrice),
            candle.time as UTCTimestamp,
            target.chartApi.controller.getSeries(),
          );
        });
        queueMicrotask(() => { crosshairSyncing = false; });
      };
      sourceChart.subscribeCrosshairMove(handleCrosshair);
      cleanups.push(() => sourceChart.unsubscribeCrosshairMove(handleCrosshair));
    }

    if (settings.time) {
      const handleClick: Parameters<IChartApi['subscribeClick']>[0] = param => {
        if (typeof param.time !== 'number') return;
        const clickedTime = Number(param.time);
        controls.forEach(([targetId, target]) => {
          if (targetId === sourceId || !target.chartApi) return;
          const timeScale = target.chartApi.controller.getChart().timeScale();
          const current = timeScale.getVisibleRange();
          const targetCandles = currentCandles(target);
          const fallbackSpan = Math.max(60, targetCandles.length > 1
            ? targetCandles[targetCandles.length - 1].time - targetCandles[0].time
            : 3600);
          const span = current && typeof current.from === 'number' && typeof current.to === 'number'
            ? Number(current.to) - Number(current.from)
            : fallbackSpan;
          timeScale.setVisibleRange({
            from: (clickedTime - span / 2) as UTCTimestamp,
            to: (clickedTime + span / 2) as UTCTimestamp,
          });
        });
      };
      sourceChart.subscribeClick(handleClick);
      cleanups.push(() => sourceChart.unsubscribeClick(handleClick));
    }

    if (settings.dateRange) {
      const sourceTimeScale = sourceChart.timeScale();
      const handleRange = (range: { from: Time; to: Time } | null) => {
        if (rangeSyncing || !range || typeof range.from !== 'number' || typeof range.to !== 'number') return;
        rangeSyncing = true;
        controls.forEach(([targetId, target]) => {
          if (targetId === sourceId || !target.chartApi) return;
          target.chartApi.controller.getChart().timeScale().setVisibleRange({
            from: Number(range.from) as UTCTimestamp,
            to: Number(range.to) as UTCTimestamp,
          });
        });
        if (typeof window !== 'undefined') window.requestAnimationFrame(() => { rangeSyncing = false; });
        else setTimeout(() => { rangeSyncing = false; }, 0);
      };
      sourceTimeScale.subscribeVisibleTimeRangeChange(handleRange);
      cleanups.push(() => sourceTimeScale.unsubscribeVisibleTimeRangeChange(handleRange));
    }
  });

  return () => cleanups.forEach(cleanup => {
    try { cleanup(); } catch { /* chart already destroyed */ }
  });
};
