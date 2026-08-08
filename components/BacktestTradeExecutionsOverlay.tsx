import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { UTCTimestamp } from 'lightweight-charts';
import type { BacktestClosedTrade, BacktestFill } from '../services/backtestTypes';
import {
  backtestExecutionMarkers,
  type BacktestExecutionMarker,
} from '../services/backtestExecutionMarkers';

interface Props {
  api: ChartViewApi;
  trades: BacktestClosedTrade[];
  fills: BacktestFill[];
  isDark: boolean;
}

interface TradeCoordinates {
  id: string;
  entryX: number;
  entryY: number;
  exitX: number;
  exitY: number;
}

interface PointerPosition {
  clientX: number;
  clientY: number;
}

interface MarkerCoordinates extends BacktestExecutionMarker {
  x: number;
  y: number;
}

const formatMoney = (value: number) => `${value >= 0 ? '+' : '−'}$${Math.abs(value).toFixed(2)}`;
const tradeColor = (pnl: number) => pnl > 0 ? '#059669' : pnl < 0 ? '#ef4444' : '#2563eb';
const distanceToSegment = (
  x: number,
  y: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) => {
  const dx = endX - startX;
  const dy = endY - startY;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(x - startX, y - startY);
  const position = Math.max(0, Math.min(1, ((x - startX) * dx + (y - startY) * dy) / lengthSquared));
  return Math.hypot(x - (startX + position * dx), y - (startY + position * dy));
};
const hoveredTradeAtPointer = (
  coordinates: TradeCoordinates[],
  pointer: PointerPosition | null,
  rect: DOMRect,
) => {
  if (!pointer) return null;
  const x = pointer.clientX - rect.left;
  const y = pointer.clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
  let nearest: TradeCoordinates | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  coordinates.forEach(point => {
    const distance = distanceToSegment(
      x,
      y,
      point.entryX,
      point.entryY,
      point.exitX,
      point.exitY,
    );
    if (distance < nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  });
  return nearest && nearestDistance <= 7 ? { id: nearest.id, x, y } : null;
};
const hoveredMarkerAtPointer = (
  markers: MarkerCoordinates[],
  pointer: PointerPosition | null,
  rect: DOMRect,
) => {
  if (!pointer) return null;
  const x = pointer.clientX - rect.left;
  const y = pointer.clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
  let nearest: MarkerCoordinates | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  markers.forEach(marker => {
    const distance = Math.hypot(x - marker.x, y - marker.y);
    if (distance < nearestDistance) {
      nearest = marker;
      nearestDistance = distance;
    }
  });
  return nearest && nearestDistance <= 9 ? { id: nearest.id, x: nearest.x, y: nearest.y } : null;
};

type HoverPoint = { id: string; x: number; y: number } | null;

/**
 * Vrátí předchozí referenci, pokud se hover fakticky nezměnil.
 *
 * Bez tohohle vznikal při každém přepočtu souřadnic nový objekt `{id, x, y}`.
 * React proto překreslil overlay, překreslení hnulo rozsahem grafu, změna
 * rozsahu spustila další přepočet — a smyčka držela hlavní vlákno desítky
 * sekund (naměřeno 29 → 59 → 103 s podle délky načtené historie).
 */
export const hoverUpdater = (next: HoverPoint) => (current: HoverPoint): HoverPoint => {
  if (!next) return current === null ? current : null;
  if (current?.id === next.id && current.x === next.x && current.y === next.y) return current;
  return next;
};
const paintTradeExecutions = (
  canvas: HTMLCanvasElement,
  coordinates: TradeCoordinates[],
  trades: BacktestClosedTrade[],
  markers: MarkerCoordinates[],
  width: number,
  height: number,
) => {
  const ratio = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(width * ratio));
  const pixelHeight = Math.max(1, Math.round(height * ratio));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const tradesById = new Map(trades.map(trade => [trade.id, trade]));
  coordinates.forEach(point => {
    const trade = tradesById.get(point.id);
    if (!trade) return;
    const color = tradeColor(trade.pnl);
    context.save();
    context.strokeStyle = color;
    context.globalAlpha = 0.68;
    context.lineWidth = 0.75;
    context.setLineDash([2, 4]);
    context.beginPath();
    context.moveTo(point.entryX, point.entryY);
    context.lineTo(point.exitX, point.exitY);
    context.stroke();
    context.restore();

  });
  markers.forEach(marker => {
    const baseY = marker.y + (marker.pointsUp ? 5 : -5);
    context.fillStyle = marker.color;
    context.beginPath();
    context.moveTo(marker.x, marker.y);
    context.lineTo(marker.x - 4, baseY);
    context.lineTo(marker.x + 4, baseY);
    context.closePath();
    context.fill();
  });
};
const exitLabel = (reason: BacktestClosedTrade['reason']) => {
  if (reason === 'stop-loss') return 'SL';
  if (reason === 'take-profit') return 'TP';
  return 'Exit';
};

const BacktestTradeExecutionsOverlay: React.FC<Props> = ({ api, trades, fills, isDark }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tradesRef = useRef(trades);
  const coordinatesRef = useRef<TradeCoordinates[]>([]);
  const markerCoordinatesRef = useRef<MarkerCoordinates[]>([]);
  const pointerRef = useRef<PointerPosition | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const [hovered, setHovered] = useState<{ id: string; x: number; y: number } | null>(null);
  const [hoveredMarker, setHoveredMarker] = useState<{ id: string; x: number; y: number } | null>(null);
  tradesRef.current = trades;

  // Markery závisí jen na fillech, ne na rozsahu grafu. Dřív se přepočítávaly
  // uvnitř `update`, tedy při každé změně viditelného rozsahu — při scrollu
  // desetkrát za snímek.
  const executionMarkers = useMemo(() => backtestExecutionMarkers(fills), [fills]);
  const executionMarkersRef = useRef(executionMarkers);
  executionMarkersRef.current = executionMarkers;

  useEffect(() => {
    let frame = 0;
    const chart = api.controller.getChart();
    const series = api.controller.getSeries();
    const update = () => {
      frame = 0;
      const next = tradesRef.current.flatMap<TradeCoordinates>(trade => {
        const entryX = chart.timeScale().timeToCoordinate(trade.entryTime as UTCTimestamp);
        const exitX = chart.timeScale().timeToCoordinate(trade.exitTime as UTCTimestamp);
        const entryY = series.priceToCoordinate(trade.entryPrice);
        const exitY = series.priceToCoordinate(trade.exitPrice);
        if (entryX === null || exitX === null || entryY === null || exitY === null) return [];
        return [{
          id: trade.id,
          entryX,
          entryY,
          exitX,
          exitY,
        }];
      });
      const markerCoordinates = executionMarkersRef.current.flatMap<MarkerCoordinates>(marker => {
        const x = chart.timeScale().timeToCoordinate(marker.time as UTCTimestamp);
        const y = series.priceToCoordinate(marker.price);
        if (x === null || y === null) return [];
        return [{ ...marker, x, y }];
      });
      coordinatesRef.current = next;
      markerCoordinatesRef.current = markerCoordinates;
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect && canvasRef.current) {
        paintTradeExecutions(
          canvasRef.current,
          next,
          tradesRef.current,
          markerCoordinates,
          rect.width,
          rect.height,
        );
        // Hover patří pointeru, ne rozsahu grafu — `update` ho proto řeší jen
        // tehdy, když kurzor nad grafem opravdu je (scroll pod nehybným
        // kurzorem mu podsune jiné svíčky). Přes `hoverUpdater` navíc projde
        // jen skutečná změna, takže překreslení už nespustí další `update`.
        if (pointerRef.current) {
          const nextMarker = hoveredMarkerAtPointer(markerCoordinates, pointerRef.current, rect);
          setHoveredMarker(hoverUpdater(nextMarker));
          setHovered(hoverUpdater(nextMarker ? null : hoveredTradeAtPointer(next, pointerRef.current, rect)));
        }
      }
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    refreshRef.current = schedule;
    // The logical-range callback runs after Lightweight Charts updates its
    // scale, so update synchronously to avoid a one-frame detached overlay.
    chart.timeScale().subscribeVisibleLogicalRangeChange(update);
    const observer = new ResizeObserver(update);
    if (rootRef.current?.parentElement) observer.observe(rootRef.current.parentElement);
    window.addEventListener('pointermove', schedule, true);
    const handleWheel = (event: WheelEvent) => {
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      // The line is about to move under a stationary cursor. Clear the stale
      // tooltip immediately; the scheduled coordinate pass restores it only
      // if the line still remains under the cursor after zoom/pan.
      setHovered(null);
      setHoveredMarker(null);
      schedule();
    };
    window.addEventListener('wheel', handleWheel, { capture: true, passive: true });
    update();
    return () => {
      refreshRef.current = null;
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(update);
      window.removeEventListener('pointermove', schedule, true);
      window.removeEventListener('wheel', handleWheel, true);
    };
  }, [api]);

  useEffect(() => { refreshRef.current?.(); }, [fills, trades]);

  useEffect(() => {
    const updatePassiveHover = (event: PointerEvent) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      const nextMarker = hoveredMarkerAtPointer(markerCoordinatesRef.current, pointerRef.current, rect);
      setHoveredMarker(hoverUpdater(nextMarker));
      setHovered(hoverUpdater(nextMarker ? null : hoveredTradeAtPointer(coordinatesRef.current, pointerRef.current, rect)));
    };
    window.addEventListener('pointermove', updatePassiveHover, { capture: true, passive: true });
    return () => window.removeEventListener('pointermove', updatePassiveHover, true);
  }, []);

  const hoveredTrade = hovered ? trades.find(trade => trade.id === hovered.id) : undefined;
  const hoveredExecutionMarker = hoveredMarker
    ? executionMarkers.find(marker => marker.id === hoveredMarker.id)
    : undefined;

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-[114] overflow-hidden" data-backtest-trade-executions>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
      {hoveredMarker && hoveredExecutionMarker && (
        <div
          role="tooltip"
          data-backtest-execution-marker-tooltip
          className={`absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+9px)] whitespace-nowrap rounded-[4px] border px-2 py-1 text-[10px] font-bold shadow-lg ${isDark ? 'border-white/10 bg-[#151a22] text-white' : 'border-slate-200 bg-white text-slate-800'}`}
          style={{ left: hoveredMarker.x, top: hoveredMarker.y }}
        >
          {hoveredExecutionMarker.side.toUpperCase()} {hoveredExecutionMarker.quantity} {hoveredExecutionMarker.instrument}
          <span className="mx-1.5 text-slate-400">·</span>
          {hoveredExecutionMarker.price.toFixed(2)}
        </div>
      )}
      {hovered && hoveredTrade && (
        <div
          role="tooltip"
          className={`absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+10px)] whitespace-nowrap rounded-[4px] border px-2.5 py-1.5 text-[10px] font-bold shadow-lg ${isDark ? 'border-white/10 bg-[#151a22] text-white' : 'border-slate-200 bg-white text-slate-800'}`}
          style={{ left: hovered.x, top: hovered.y }}
        >
          <span>Entry {hoveredTrade.entryPrice.toFixed(2)}</span>
          <span className="mx-1.5 text-slate-400">→</span>
          <span>{exitLabel(hoveredTrade.reason)} {hoveredTrade.exitPrice.toFixed(2)}</span>
          <span className={`ml-2 ${hoveredTrade.pnl > 0 ? 'text-emerald-500' : hoveredTrade.pnl < 0 ? 'text-rose-500' : 'text-blue-500'}`}>
            P&amp;L {formatMoney(hoveredTrade.pnl)}
          </span>
        </div>
      )}
    </div>
  );
};

export default BacktestTradeExecutionsOverlay;
