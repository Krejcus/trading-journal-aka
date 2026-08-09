import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  Rectangle,
  TextAnnotation,
  TrendLine,
  type Drawing,
} from 'lightweight-charts-drawing';
import { Activity, AlertTriangle, BarChart3, LocateFixed, Loader2, Maximize2, Minimize2, RefreshCw } from 'lucide-react';
import { Trade } from '../types';
import CandleKitTradeChart from './CandleKitTradeChart';
import AlphaTradeChartWorkspace from './AlphaTradeChartWorkspace';
import ChartTimeframePicker from './ChartTimeframePicker';
import {
  aggregateCandles,
  calculateIndicators,
  calculateMarketStructure,
  findEntryFairValueGap,
  findEntryStructureEvent,
  findFairValueGaps,
  loadMarketCandles,
  marketDataWindowForEntry,
  MARKET_TIMEFRAME_MINUTES,
  MarketDataError,
  resolveMarketSymbol,
  type MarketCandle,
  type MarketTimeframe,
} from '../services/marketData';
import { ALPHATRADE_CHART_STYLE as chartStyle } from '../services/chartVisualStyle';
import { formatNqMnqTickPrice } from '../services/chartPriceTick';
import { chartAxisTickLabel, chartCrosshairTimeLabel } from '../services/chartTimeAxisFormat';

interface TradeMarketChartProps {
  trade: Trade;
  isDark: boolean;
}

const TRADE_CONTEXT_BARS: Record<MarketTimeframe, { before: number; after: number }> = {
  '1m': { before: 45, after: 45 },
  '5m': { before: 48, after: 24 },
  '15m': { before: 32, after: 16 },
  '30m': { before: 24, after: 10 },
  '1h': { before: 24, after: 8 },
  '4h': { before: 12, after: 4 },
  '1d': { before: 8, after: 2 },
};

const asUnix = (value: number | string | undefined, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value > 10_000_000_000 ? value / 1000 : value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(fallback / 1000);
};

const nearestCandleTime = (candles: MarketCandle[], target: number): UTCTimestamp => {
  let nearest = candles[0]?.time || target;
  let distance = Math.abs(nearest - target);
  for (const candle of candles) {
    const nextDistance = Math.abs(candle.time - target);
    if (nextDistance < distance) {
      nearest = candle.time;
      distance = nextDistance;
    }
  }
  return nearest as UTCTimestamp;
};

const fvgVisualStartTime = (candles: MarketCandle[], confirmationTime: number): UTCTimestamp => {
  const confirmationIndex = nearestCandleIndex(candles, confirmationTime);
  return (candles[Math.max(0, confirmationIndex - 1)]?.time || confirmationTime) as UTCTimestamp;
};

const nearestCandleIndex = (candles: MarketCandle[], target: number): number => {
  let nearestIndex = 0;
  let distance = Math.abs((candles[0]?.time || target) - target);
  for (let index = 1; index < candles.length; index += 1) {
    const nextDistance = Math.abs(candles[index].time - target);
    if (nextDistance < distance) {
      nearestIndex = index;
      distance = nextDistance;
    }
  }
  return nearestIndex;
};

const focusChartOnTrade = (
  chart: IChartApi | null,
  candles: MarketCandle[],
  timeframe: MarketTimeframe,
  entryUnix: number,
  exitUnix: number,
) => {
  if (!chart || candles.length === 0) return;
  const context = TRADE_CONTEXT_BARS[timeframe];
  const entryIndex = nearestCandleIndex(candles, entryUnix);
  const exitIndex = nearestCandleIndex(candles, exitUnix);
  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, entryIndex - context.before),
    to: Math.min(candles.length - 1, Math.max(entryIndex, exitIndex) + context.after),
  });
};

const TradeMarketChart: React.FC<TradeMarketChartProps> = ({ trade, isDark }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [timeframe, setTimeframe] = useState<MarketTimeframe>('1m');
  const [root, setRoot] = useState<'MNQ' | 'NQ'>('MNQ');
  const [rawCandles, setRawCandles] = useState<MarketCandle[]>([]);
  const [providerSymbol, setProviderSymbol] = useState('');
  const [estimatedCostUsd, setEstimatedCostUsd] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [showFvg, setShowFvg] = useState(false);
  const [showLevels, setShowLevels] = useState(false);
  const [showStructure, setShowStructure] = useState(false);
  const [chartEngine, setChartEngine] = useState<'candlekit' | 'classic'>('candlekit');
  const [isFullscreen, setIsFullscreen] = useState(false);

  const entryMs = useMemo(() => {
    if (typeof trade.entryTime === 'number' && trade.entryTime > 0) return trade.entryTime;
    if (trade.entryDate) {
      const parsed = Date.parse(trade.entryDate);
      if (Number.isFinite(parsed)) return parsed;
    }
    const exit = trade.timestamp || Date.parse(trade.date) || Date.now();
    return exit - Math.max(0, Number(trade.durationMinutes) || 0) * 60_000;
  }, [trade]);
  const exitMs = useMemo(() => trade.timestamp || Date.parse(trade.exitDate || trade.date) || entryMs, [trade, entryMs]);
  const marketSymbol = useMemo(() => resolveMarketSymbol(root, trade.symbol || trade.instrument), [root, trade.symbol, trade.instrument]);

  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    const appRoot = document.getElementById('root');
    const previousRootVisibility = appRoot?.style.visibility || '';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[data-chart-overlay-menu]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setIsFullscreen(false);
    };
    document.body.style.overflow = 'hidden';
    if (appRoot) appRoot.style.visibility = 'hidden';
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      if (appRoot) appRoot.style.visibility = previousRootVisibility;
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isFullscreen]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRawCandles([]);
    setEstimatedCostUsd(null);
    if (entryMs > Date.now() - 24 * 60 * 60 * 1000) {
      setError({ code: 'data-not-yet-historical', message: 'Databento historical feed zpřístupní tento obchod přibližně 24 hodin po trhu.' });
      setLoading(false);
      return () => { cancelled = true; };
    }
    const { start, end } = marketDataWindowForEntry(entryMs);
    loadMarketCandles({ symbol: marketSymbol, start, end }).then(response => {
      if (cancelled) return;
      setRawCandles(response.candles);
      setProviderSymbol(response.sourceSymbol || response.symbol);
      setEstimatedCostUsd(typeof response.estimatedCostUsd === 'number' ? response.estimatedCostUsd : null);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      const marketError = reason instanceof MarketDataError ? reason : new MarketDataError(reason instanceof Error ? reason.message : 'Neznámá chyba tržních dat.');
      setError({ code: marketError.code, message: marketError.message });
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [entryMs, exitMs, marketSymbol, retry]);

  const candles = useMemo(() => aggregateCandles(rawCandles, timeframe), [rawCandles, timeframe]);
  const indicators = useMemo(() => calculateIndicators(candles), [candles]);
  const fvgs = useMemo(() => {
    const from = Math.floor(entryMs / 1000) - 8 * 3600;
    return findFairValueGaps(candles.filter(candle => candle.time >= from));
  }, [candles, entryMs]);
  const structureEvents = useMemo(() => {
    const from = Math.floor(entryMs / 1000) - 200 * 60;
    const to = Math.floor(Math.max(entryMs, exitMs) / 1000) + 30 * 60;
    return calculateMarketStructure(rawCandles)
      .filter(event => event.breakTime >= from && event.pivotTime <= to);
  }, [rawCandles, entryMs, exitMs]);
  const entryFvg = useMemo(() => {
    const entryMappedToFvg = trade.entryMap?.entryFvg === true
      || trade.ltfConfluence?.some(tag => /entry.*fvg/i.test(tag));
    if (!entryMappedToFvg) return null;
    const entryUnix = Math.floor(entryMs / 1000);
    return findEntryFairValueGap(
      findFairValueGaps(rawCandles.filter(candle => candle.time >= entryUnix - 8 * 3600 && candle.time <= entryUnix)),
      entryUnix,
      Number(trade.entryPrice),
      String(trade.direction).toLowerCase() === 'long' ? 'long' : 'short',
    );
  }, [rawCandles, entryMs, trade]);
  const displayedEntryFvg = useMemo(() => {
    if (!entryFvg) return null;
    const from = Math.floor(entryMs / 1000) - 8 * 3600;
    return findFairValueGaps(rawCandles.filter(candle => candle.time >= from))
      .find(gap => gap.startTime === entryFvg.startTime) ?? entryFvg;
  }, [entryFvg, entryMs, rawCandles]);
  const entryStructure = useMemo(() => {
    const mappedType = String(trade.entryMap?.structureType || '').toUpperCase();
    const tagType = trade.ltfConfluence?.find(tag => /^(choch|bos)\b/i.test(tag));
    const desiredType = mappedType === 'CHOCH' || /^choch\b/i.test(tagType || '')
      ? 'CHoCH'
      : mappedType === 'BOS' || /^bos\b/i.test(tagType || '')
        ? 'BOS'
        : null;
    if (!desiredType) return null;
    return findEntryStructureEvent(
      structureEvents,
      Math.floor(entryMs / 1000),
      String(trade.direction).toLowerCase() === 'long' ? 'long' : 'short',
      desiredType,
    );
  }, [structureEvents, entryMs, trade]);

  useEffect(() => {
    if (chartEngine !== 'classic' || !containerRef.current || candles.length === 0) return;
    const background = isDark ? '#090d12' : '#ffffff';
    const text = isDark ? '#8794a5' : '#64748b';
    const border = isDark ? 'rgba(148,163,184,0.07)' : 'rgba(100,116,139,0.10)';
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: { background: { type: ColorType.Solid, color: background }, textColor: text, fontFamily: chartStyle.fontFamily },
      grid: { vertLines: { color: 'transparent' }, horzLines: { color: 'transparent' } },
      rightPriceScale: { borderColor: border, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: {
        borderColor: border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 8,
        minBarSpacing: 0.5,
        lockVisibleTimeRangeOnResize: true,
        rightBarStaysOnScroll: true,
        shiftVisibleRangeOnNewBar: false,
        tickMarkFormatter: (time: Time, tickMarkType: number) => chartAxisTickLabel(Number(time), tickMarkType),
      },
      localization: {
        locale: 'cs-CZ',
        timeFormatter: (time: Time) => chartCrosshairTimeLabel(Number(time)),
        priceFormatter: formatNqMnqTickPrice,
      },
      crosshair: { vertLine: { color: 'rgba(148,163,184,0.45)' }, horzLine: { color: 'rgba(148,163,184,0.45)' } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: {
        axisPressedMouseMove: true,
        axisDoubleClickReset: false,
        mouseWheel: true,
        pinch: true,
      },
      kineticScroll: { mouse: true, touch: true },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: isDark ? chartStyle.bullBodyDark : chartStyle.bullBodyLight,
      downColor: chartStyle.bear,
      borderVisible: true,
      borderUpColor: isDark ? chartStyle.bullLineDark : chartStyle.bullLineLight,
      borderDownColor: chartStyle.bear,
      wickUpColor: isDark ? chartStyle.bullLineDark : chartStyle.bullLineLight,
      wickDownColor: chartStyle.bear,
      priceFormat: { type: 'price', precision: 2, minMove: 0.25 },
    });
    candleSeriesRef.current = candleSeries;
    candleSeries.setData(candles.map(candle => ({ ...candle, time: candle.time as UTCTimestamp })));

    const addLine = (data: Array<{ time: number; value: number }>, color: string, width: 1 | 2 = 1, style = LineStyle.Solid) => {
      const series = chart.addSeries(LineSeries, {
        color, lineWidth: width, lineStyle: style, priceLineVisible: false,
        lastValueVisible: false, crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null,
      });
      series.setData(data.map(item => ({ time: item.time as UTCTimestamp, value: item.value })));
      return series;
    };
    addLine(indicators.vwap, chartStyle.vwap, 2);
    addLine(indicators.upperDeviation, chartStyle.vwapDeviation, 1);
    addLine(indicators.lowerDeviation, chartStyle.vwapDeviation, 1);
    if (showLevels) {
      addLine(indicators.pdh, chartStyle.priorDay, 1);
      addLine(indicators.pdl, chartStyle.priorDay, 1);
      addLine(indicators.pwh, chartStyle.priorWeek, 1);
      addLine(indicators.pwl, chartStyle.priorWeek, 1);
      addLine(indicators.dayOpen, chartStyle.dayOpen, 1);
      addLine(indicators.weekOpen, chartStyle.weekOpen, 1);
      addLine(indicators.sessionHigh, chartStyle.sessionHigh, 1, LineStyle.Dotted);
      addLine(indicators.sessionLow, chartStyle.sessionLow, 1, LineStyle.Dotted);
    }

    const entryTime = nearestCandleTime(candles, asUnix(trade.entryTime || trade.entryDate, entryMs));
    const exitTime = nearestCandleTime(candles, asUnix(trade.timestamp || trade.exitDate, exitMs));
    const isLongTrade = String(trade.direction).toLowerCase() === 'long';
    createSeriesMarkers(candleSeries, [
      {
        time: entryTime,
        position: isLongTrade ? 'belowBar' : 'aboveBar',
        color: chartStyle.entry, shape: isLongTrade ? 'arrowUp' : 'arrowDown',
        text: entryFvg ? 'ENTRY FVG' : 'ENTRY',
      },
      {
        time: exitTime,
        position: isLongTrade ? 'aboveBar' : 'belowBar',
        color: chartStyle.exit, shape: isLongTrade ? 'arrowDown' : 'arrowUp',
        text: 'EXIT',
      },
    ]);

    const chartElement = containerRef.current;
    const chartDrawings: Drawing[] = [];
    const attachDrawing = <T extends Drawing>(drawing: T): T => {
      drawing.attach(candleSeries, chart, chartElement);
      chartDrawings.push(drawing);
      return drawing;
    };

    const entry = Number(trade.entryPrice);
    const stop = Number(trade.stopLoss);
    const target = Number(trade.takeProfit);
    const riskEnd = nearestCandleTime(candles, Math.max(
      exitTime as number,
      entryTime as number + Math.max(10, MARKET_TIMEFRAME_MINUTES[timeframe]) * 60,
    ));
    if (Number.isFinite(entry) && entry > 0 && Number.isFinite(stop) && stop > 0) {
      attachDrawing(new Rectangle(
        `trade-risk-${trade.id}`,
        [{ time: entryTime, price: entry }, { time: riskEnd, price: stop }],
        { lineColor: chartStyle.positionRiskBorder, lineWidth: 1, fillColor: chartStyle.positionRiskFill },
        { locked: true, filled: true, showDimensions: false },
      ));
      attachDrawing(new TextAnnotation(
        `trade-stop-label-${trade.id}`,
        [{ time: riskEnd, price: stop }],
        { labelColor: '#64748b', lineColor: '#64748b' },
        {
          locked: true,
          text: `SL ${stop.toFixed(2)}`,
          fontSize: 10,
          fontWeight: '600',
          backgroundColor: isDark ? 'rgba(9,13,18,0.82)' : 'rgba(255,255,255,0.9)',
          borderColor: 'transparent',
          padding: 2,
        },
      ));
      if (Number.isFinite(target) && target > 0) {
        const risk = Math.abs(entry - stop);
        const rr = risk > 0 ? Math.abs(target - entry) / risk : 0;
        attachDrawing(new Rectangle(
          `trade-target-${trade.id}`,
          [{ time: entryTime, price: entry }, { time: riskEnd, price: target }],
          { lineColor: chartStyle.positionTargetBorder, lineWidth: 1, fillColor: chartStyle.positionTargetFill },
          { locked: true, filled: true, showDimensions: false },
        ));
        attachDrawing(new TextAnnotation(
          `trade-target-label-${trade.id}`,
          [{ time: riskEnd, price: target }],
          { labelColor: '#4a74cc', lineColor: '#4a74cc' },
          {
            locked: true,
            text: `TP ${target.toFixed(2)} · ${rr.toFixed(2)}R`,
            fontSize: 10,
            fontWeight: '600',
            backgroundColor: isDark ? 'rgba(9,13,18,0.82)' : 'rgba(255,255,255,0.9)',
            borderColor: 'transparent',
            padding: 2,
          },
        ));
      }
      attachDrawing(new TrendLine(
        `trade-entry-line-${trade.id}`,
        [{ time: entryTime, price: entry }, { time: riskEnd, price: entry }],
        { lineColor: chartStyle.entry, lineWidth: 1 },
        { locked: true },
      ));
    }

    if (showFvg || entryFvg) {
      const visibleFrom = Math.floor(entryMs / 1000) - 6 * 3600;
      const visibleTo = Math.floor(Math.max(exitMs, entryMs) / 1000) + 3 * 3600;
      const visibleGaps = showFvg
        ? fvgs.filter(gap => gap.endTime >= visibleFrom && gap.startTime <= visibleTo).slice(-64)
        : [];
      if (displayedEntryFvg && !visibleGaps.some(gap => gap.startTime === displayedEntryFvg.startTime)) visibleGaps.push(displayedEntryFvg);
      visibleGaps
        .forEach((gap, index) => {
          const isEntryGap = gap === displayedEntryFvg;
          const activeFill = gap.direction === 'bullish'
            ? (isEntryGap
              ? (gap.touched ? chartStyle.entryBullishFvgTouchedFill : chartStyle.entryBullishFvgFill)
              : (gap.touched ? chartStyle.bullishFvgTouchedFill : chartStyle.bullishFvgFill))
            : (isEntryGap
              ? (gap.touched ? chartStyle.entryBearishFvgTouchedFill : chartStyle.entryBearishFvgFill)
              : (gap.touched ? chartStyle.bearishFvgTouchedFill : chartStyle.bearishFvgFill));
          const attachFvgSegment = (
            suffix: string,
            startTime: number,
            endTime: number,
            top: number,
            bottom: number,
            fillColor: string,
          ) => attachDrawing(new Rectangle(
            `${isEntryGap ? 'entry-' : ''}fvg-${gap.startTime}-${index}-${suffix}`,
            [
              { time: nearestCandleTime(candles, startTime), price: top },
              { time: nearestCandleTime(candles, endTime), price: bottom },
            ],
            { lineColor: 'transparent', lineWidth: 1, fillColor },
            { locked: true, filled: true, showDimensions: false, zIndex: -1 },
          ));

          let stageStart = fvgVisualStartTime(candles, gap.startTime);
          let stageTop = gap.top;
          let stageBottom = gap.bottom;
          gap.mitigationSteps.forEach((step, stepIndex) => {
            attachFvgSegment(`active-${stepIndex}`, stageStart, step.time, stageTop, stageBottom, activeFill);
            stageStart = step.time as UTCTimestamp;
            stageTop = step.remainingTop;
            stageBottom = step.remainingBottom;
          });
          attachFvgSegment('active-last', stageStart, gap.endTime, stageTop, stageBottom, activeFill);
          gap.mitigationSteps.forEach((step, stepIndex) => {
            attachFvgSegment(
              `filled-${stepIndex}`,
              step.time,
              gap.endTime,
              step.filledTop,
              step.filledBottom,
              chartStyle.fvgMitigatedFill,
            );
          });
        });
    }

    const visibleStructureEvents = structureEvents.filter(event => (showStructure && timeframe === '1m') || event === entryStructure);
    if (visibleStructureEvents.length > 0) {
      visibleStructureEvents.forEach((event, index) => {
        const color = event.direction === 'bullish' ? chartStyle.bullishStructure : chartStyle.bearishStructure;
        const lineColor = event.direction === 'bullish'
          ? chartStyle.bullishStructureLine
          : chartStyle.bearishStructureLine;
        attachDrawing(new TrendLine(
          `structure-line-${event.breakTime}-${index}`,
          [
            { time: event.pivotTime as UTCTimestamp, price: event.price },
            { time: event.breakTime as UTCTimestamp, price: event.price },
          ],
          { lineColor, lineWidth: 1 },
          { locked: true },
        ));
        const labelTime = nearestCandleTime(candles, Math.floor((event.pivotTime + event.breakTime) / 2));
        attachDrawing(new TextAnnotation(
          `structure-label-${event.breakTime}-${index}`,
          [{ time: labelTime, price: event.price }],
          { labelColor: color, lineColor: color },
          {
            locked: true,
            text: event.type,
            fontSize: 10,
            fontWeight: '600',
            backgroundColor: 'transparent',
            borderColor: 'transparent',
            padding: 0,
          },
        ));
      });
    }

    const isOnRightPriceScale = (clientX: number) => {
      const rect = chartElement.getBoundingClientRect();
      const interactiveWidth = Math.max(64, chart.priceScale('right').width());
      return clientX >= rect.right - interactiveWidth;
    };
    let priceWheelFrame: number | null = null;
    let pendingPriceWheelDelta = 0;
    let pendingPriceWheelAnchorY = 0;
    const handlePriceScaleWheel = (event: WheelEvent) => {
      if (!isOnRightPriceScale(event.clientX)) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = chartElement.getBoundingClientRect();
      pendingPriceWheelDelta = Math.max(-240, Math.min(240, pendingPriceWheelDelta + event.deltaY));
      pendingPriceWheelAnchorY = event.clientY - rect.top;
      if (priceWheelFrame !== null) return;
      priceWheelFrame = window.requestAnimationFrame(() => {
        priceWheelFrame = null;
        const priceScale = chart.priceScale('right');
        const range = priceScale.getVisibleRange();
        const delta = pendingPriceWheelDelta;
        pendingPriceWheelDelta = 0;
        if (!range || delta === 0) return;
        const span = range.to - range.from;
        const anchor = candleSeries.coordinateToPrice(pendingPriceWheelAnchorY) ?? (range.from + range.to) / 2;
        const anchorRatio = span > 0 ? Math.max(0, Math.min(1, (anchor - range.from) / span)) : 0.5;
        const zoomFactor = Math.exp(Math.max(-0.24, Math.min(0.24, delta * 0.0015)));
        const nextSpan = Math.max(5, Math.min(20_000, span * zoomFactor));
        if (priceScale.options().autoScale) priceScale.setAutoScale(false);
        priceScale.setVisibleRange({
          from: anchor - nextSpan * anchorRatio,
          to: anchor + nextSpan * (1 - anchorRatio),
        });
      });
    };
    const handlePriceScaleDoubleClick = (event: MouseEvent) => {
      if (!isOnRightPriceScale(event.clientX)) return;
      event.preventDefault();
      event.stopPropagation();
      if (priceWheelFrame !== null) {
        window.cancelAnimationFrame(priceWheelFrame);
        priceWheelFrame = null;
        pendingPriceWheelDelta = 0;
      }
      chart.priceScale('right').setAutoScale(true);
    };
    chartElement.addEventListener('wheel', handlePriceScaleWheel, { passive: false, capture: true });
    chartElement.addEventListener('dblclick', handlePriceScaleDoubleClick, true);

    const resizeObserver = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      chart.applyOptions({ width: rect.width, height: rect.height });
    });
    resizeObserver.observe(containerRef.current);

    const entryUnix = asUnix(trade.entryTime || trade.entryDate, entryMs);
    const exitUnix = asUnix(trade.timestamp || trade.exitDate, exitMs);
    focusChartOnTrade(chart, candles, timeframe, entryUnix, exitUnix);

    return () => {
      resizeObserver.disconnect();
      chartElement.removeEventListener('wheel', handlePriceScaleWheel, true);
      chartElement.removeEventListener('dblclick', handlePriceScaleDoubleClick, true);
      if (priceWheelFrame !== null) window.cancelAnimationFrame(priceWheelFrame);
      chartDrawings.forEach(drawing => drawing.detach());
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, [candles, indicators, fvgs, structureEvents, displayedEntryFvg, entryFvg, entryStructure, timeframe, showFvg, showLevels, showStructure, chartEngine, isDark, trade, entryMs, exitMs]);

  const setupMessage = error?.code === 'provider-not-configured' || error?.code === 'endpoint-unavailable'
    ? 'Graf je připravený. Pro reálné CME svíčky zbývá nastavit DATABENTO_API_KEY v Supabase Edge Function secrets.'
    : error?.message;

  const chartContent = (
    <div className={`${isFullscreen ? 'fixed inset-0 z-[300] min-h-0' : 'h-full min-h-[360px]'} flex flex-col ${isDark ? 'bg-[#090d12]' : 'bg-white'}`}>
      <div className={`h-11 shrink-0 flex items-center justify-between gap-3 px-3 border-b ${isDark ? 'border-white/5 bg-black/20' : 'border-slate-200 bg-slate-50'}`}>
        <div className="flex items-center gap-2 min-w-0">
          <BarChart3 size={14} className="text-emerald-500 shrink-0" />
          <div className="flex rounded-lg overflow-hidden border border-white/10 shrink-0">
            {(['MNQ', 'NQ'] as const).map(option => (
              <button key={option} onClick={() => setRoot(option)} className={`px-2 py-1 text-[9px] font-black transition-colors ${root === option ? 'bg-emerald-500 text-white' : 'text-slate-500 hover:text-slate-300'}`}>{option}</button>
            ))}
          </div>
          <span className="hidden md:inline text-[9px] font-mono text-slate-500 truncate">{providerSymbol || marketSymbol} · CME</span>
          {isFullscreen && <span className="hidden md:inline text-[8px] font-black uppercase tracking-[0.18em] text-violet-400">Workspace</span>}
          <div className="hidden lg:flex rounded-lg overflow-hidden border border-white/10 shrink-0">
            <button
              type="button"
              onClick={() => setChartEngine('candlekit')}
              className={`px-2 py-1 text-[8px] font-black uppercase tracking-wider transition-colors ${chartEngine === 'candlekit' ? 'bg-violet-500 text-white' : 'text-slate-500 hover:text-slate-300'}`}
            >
              CandleKit
            </button>
            <button
              type="button"
              onClick={() => setChartEngine('classic')}
              className={`px-2 py-1 text-[8px] font-black uppercase tracking-wider transition-colors ${chartEngine === 'classic' ? 'bg-slate-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
            >
              Původní
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setShowFvg(value => !value)} className={`px-2 py-1 rounded-md text-[8px] font-black uppercase tracking-wider border ${showFvg ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25' : 'text-slate-500 border-white/10'}`}>FVG</button>
          <button onClick={() => setShowLevels(value => !value)} className={`px-2 py-1 rounded-md text-[8px] font-black uppercase tracking-wider border ${showLevels ? 'text-blue-400 bg-blue-500/10 border-blue-500/25' : 'text-slate-500 border-white/10'}`}>Levels</button>
          {timeframe === '1m' && <button onClick={() => setShowStructure(value => !value)} className={`px-2 py-1 rounded-md text-[8px] font-black uppercase tracking-wider border ${showStructure ? 'text-teal-400 bg-teal-500/10 border-teal-500/25' : 'text-slate-500 border-white/10'}`}>CHoCH/BOS</button>}
          <ChartTimeframePicker value={timeframe} onChange={setTimeframe} isDark={isDark} compact />
          <button
            type="button"
            onClick={() => setIsFullscreen(value => !value)}
            className={`p-1.5 rounded-lg border transition-colors ${isDark ? 'border-white/10 text-slate-400 hover:bg-white/10 hover:text-white' : 'border-slate-200 text-slate-500 hover:bg-white hover:text-slate-900'}`}
            title={isFullscreen ? 'Zavřít fullscreen (Esc)' : 'Otevřít fullscreen workspace'}
            aria-label={isFullscreen ? 'Zavřít fullscreen graf' : 'Otevřít fullscreen graf'}
          >
            {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        {chartEngine === 'candlekit' && candles.length > 0 ? (
          <CandleKitTradeChart
            trade={trade}
            candles={candles}
            rawCandles={rawCandles}
            timeframe={timeframe}
            entryMs={entryMs}
            exitMs={exitMs}
            showFvg={showFvg}
            showLevels={showLevels}
            showStructure={showStructure}
            isDark={isDark}
            compactMode
            onToggleFvg={() => setShowFvg(value => !value)}
            onToggleLevels={() => setShowLevels(value => !value)}
            onToggleStructure={() => setShowStructure(value => !value)}
          />
        ) : (
          <div ref={containerRef} className="absolute inset-0" />
        )}
        {chartEngine === 'classic' && !loading && !error && (
          <button
            onClick={() => focusChartOnTrade(
              chartRef.current,
              candles,
              timeframe,
              asUnix(trade.entryTime || trade.entryDate, entryMs),
              asUnix(trade.timestamp || trade.exitDate, exitMs),
            )}
            className={`absolute left-3 top-3 z-20 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border backdrop-blur-md text-[8px] font-black uppercase tracking-wider shadow-sm transition-colors ${isDark ? 'bg-black/65 border-white/10 text-slate-300 hover:text-white' : 'bg-white/85 border-slate-200 text-slate-600 hover:text-slate-900'}`}
            title="Vrátit graf na vstup obchodu"
            aria-label="Vycentrovat na obchod"
          >
            <LocateFixed size={11} /> Obchod
          </button>
        )}
        {loading && (
          <div className={`absolute inset-0 z-20 flex flex-col items-center justify-center ${isDark ? 'bg-[#090d12]' : 'bg-white'}`}>
            <Loader2 size={28} className="animate-spin text-emerald-500" />
            <p className="mt-3 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Načítám reálné MNQ svíčky</p>
          </div>
        )}
        {!loading && error && (
          <div className={`absolute inset-0 z-20 flex items-center justify-center p-8 ${isDark ? 'bg-[#090d12]' : 'bg-white'}`}>
            <div className="max-w-md text-center">
              {error.code === 'data-not-yet-historical' ? <Activity size={34} className="mx-auto text-blue-400" /> : <AlertTriangle size={34} className="mx-auto text-amber-400" />}
              <p className={`mt-4 text-sm font-black ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{setupMessage}</p>
              <p className="mt-2 text-[10px] leading-relaxed text-slate-500">Žádná náhradní ani syntetická data se nezobrazují, aby analýza nebyla zavádějící.</p>
              <button onClick={() => setRetry(value => value + 1)} className="mt-4 inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-500/10 text-blue-400 text-[10px] font-black uppercase tracking-wider hover:bg-blue-500/20">
                <RefreshCw size={12} /> Zkusit znovu
              </button>
            </div>
          </div>
        )}
        {!loading && !error && !trade.stopLoss && (
          <div className="absolute left-3 bottom-8 z-20 px-2 py-1 rounded-lg bg-amber-500/90 text-black text-[9px] font-black shadow-lg">
            Risk box chybí: původní SL není uložený
          </div>
        )}
      </div>
      <div className={`h-7 shrink-0 px-3 flex items-center gap-4 border-t text-[8px] font-bold uppercase tracking-wider ${isDark ? 'border-white/5 text-slate-600' : 'border-slate-200 text-slate-400'}`}>
        <span className="text-amber-500">VWAP ±1σ</span><span className="text-blue-400">PDH / PDL</span><span className="text-violet-400">PWH / PWL</span><span>Časy Praha</span><span className="ml-auto">Databento · GLBX.MDP3{estimatedCostUsd !== null ? ` · request ≤ $${estimatedCostUsd.toFixed(4)}` : ''}</span>
      </div>
    </div>
  );

  return isFullscreen
    ? createPortal(
      <AlphaTradeChartWorkspace
        trade={trade}
        entryMs={entryMs}
        exitMs={exitMs}
        initialRoot={root}
        initialCandles={rawCandles}
        isDark={isDark}
        onClose={() => setIsFullscreen(false)}
      />,
      document.body,
    )
    : chartContent;
};

export default TradeMarketChart;
