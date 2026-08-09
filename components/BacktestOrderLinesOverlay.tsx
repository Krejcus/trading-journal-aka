import React, { useEffect, useRef, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { BacktestChartOrderLine, BacktestChartOrderLineKind } from '../services/backtestOrderLines';

interface Props {
  api: ChartViewApi;
  lines: BacktestChartOrderLine[];
  onChange: (line: BacktestChartOrderLine, kind: BacktestChartOrderLineKind, price: number) => void;
  onCancel: (line: BacktestChartOrderLine) => void;
  onAddBracket?: (
    line: BacktestChartOrderLine,
    kind: Exclude<BacktestChartOrderLineKind, 'entry'>,
    price?: number,
  ) => void;
}

const sameCoordinates = (left: Record<string, number>, right: Record<string, number>) => {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every(key => left[key] === right[key]);
};

const BacktestOrderLinesOverlay: React.FC<Props> = ({ api, lines, onChange, onCancel, onAddBracket }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef(lines);
  const dragRef = useRef<{
    id: string;
    bracketKind?: Exclude<BacktestChartOrderLineKind, 'entry'>;
    moved?: boolean;
  } | null>(null);
  const suppressBracketClickRef = useRef<Exclude<BacktestChartOrderLineKind, 'entry'> | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const [coordinates, setCoordinates] = useState<Record<string, number>>({});
  const [priceScaleWidth, setPriceScaleWidth] = useState(64);
  const [bracketDragPreview, setBracketDragPreview] = useState<{
    anchorLineId: string;
    kind: Exclude<BacktestChartOrderLineKind, 'entry'>;
    top: number;
  } | null>(null);
  linesRef.current = lines;

  useEffect(() => {
    let frame = 0;
    const chart = api.controller.getChart();
    const series = api.controller.getSeries();
    const update = () => {
      frame = 0;
      const next: Record<string, number> = {};
      linesRef.current.forEach(line => {
        const coordinate = series.priceToCoordinate(line.price);
        if (coordinate !== null) next[line.id] = Math.round(coordinate * 2) / 2;
      });
      setCoordinates(current => sameCoordinates(current, next) ? current : next);
      setPriceScaleWidth(current => {
        const nextWidth = Math.max(54, chart.priceScale('right').width());
        return current === nextWidth ? current : nextWidth;
      });
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    refreshRef.current = schedule;
    const rangeHandler = () => schedule();
    chart.timeScale().subscribeVisibleLogicalRangeChange(rangeHandler);
    const observer = new ResizeObserver(schedule);
    if (rootRef.current?.parentElement) observer.observe(rootRef.current.parentElement);
    window.addEventListener('pointermove', schedule, true);
    window.addEventListener('wheel', schedule, true);
    update();
    return () => {
      refreshRef.current = null;
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(rangeHandler);
      window.removeEventListener('pointermove', schedule, true);
      window.removeEventListener('wheel', schedule, true);
    };
  }, [api]);

  useEffect(() => { refreshRef.current?.(); }, [lines]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const dragging = dragRef.current;
      const root = rootRef.current;
      if (!dragging || !root) return;
      event.preventDefault();
      const line = linesRef.current.find(item => item.id === dragging.id);
      if (!line) return;
      const raw = api.controller.getSeries().coordinateToPrice(event.clientY - root.getBoundingClientRect().top);
      if (raw === null || !Number.isFinite(raw)) return;
      const snapped = Math.round(raw / 0.25) * 0.25;
      const previewKind = dragging.bracketKind ?? (line.kind === 'entry' ? undefined : line.kind);
      if (previewKind) {
        const anchor = linesRef.current.find(item =>
          item.ownerId === line.ownerId && item.ownerType === line.ownerType && item.kind === 'entry');
        const previewTop = api.controller.getSeries().priceToCoordinate(snapped);
        if (anchor && previewTop !== null) {
          setBracketDragPreview({ anchorLineId: anchor.id, kind: previewKind, top: previewTop });
        }
      }
      if (dragging.bracketKind) {
        dragging.moved = true;
        onAddBracket?.(line, dragging.bracketKind, snapped);
      } else {
        onChange(line, line.kind, snapped);
      }
    };
    const stop = () => {
      const dragging = dragRef.current;
      if (dragging?.bracketKind && dragging.moved) suppressBracketClickRef.current = dragging.bracketKind;
      dragRef.current = null;
      setBracketDragPreview(null);
    };
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', stop, true);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
    };
  }, [api, onAddBracket, onChange]);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-[115] overflow-hidden" data-backtest-order-lines>
      {bracketDragPreview && Number.isFinite(coordinates[bracketDragPreview.anchorLineId]) && (
        <div
          className="pointer-events-none absolute left-0"
          data-backtest-bracket-drag-preview
          style={{
            right: priceScaleWidth,
            top: Math.min(coordinates[bracketDragPreview.anchorLineId], bracketDragPreview.top),
            height: Math.abs(coordinates[bracketDragPreview.anchorLineId] - bracketDragPreview.top),
            backgroundColor: bracketDragPreview.kind === 'takeProfit'
              ? 'rgba(16, 185, 129, 0.10)'
              : 'rgba(244, 63, 94, 0.10)',
          }}
        />
      )}
      {lines.map(line => {
        const top = coordinates[line.id];
        if (!Number.isFinite(top)) return null;
        const filledLabel = line.filledLabel === true;
        return (
          <div key={line.id} className="absolute left-0 h-0" style={{ right: priceScaleWidth, top }}>
            <div className="absolute inset-x-0 top-0 border-t border-dashed opacity-90" style={{ borderColor: line.color }} />
            <div
              role={line.draggable ? 'button' : undefined}
              aria-label={line.draggable ? `Posunout ${line.label} ${line.price.toFixed(2)}` : undefined}
              tabIndex={line.draggable ? 0 : undefined}
              className={`pointer-events-auto absolute right-1 top-0 flex h-[22px] -translate-y-1/2 items-center gap-[3px] text-[9px] font-black ${line.draggable ? 'cursor-ns-resize' : 'cursor-default'}`}
              onPointerDown={event => {
                if (!line.draggable || (event.target as HTMLElement).closest('[data-order-line-control]')) return;
                event.preventDefault();
                event.stopPropagation();
                dragRef.current = { id: line.id };
                if (line.kind !== 'entry') {
                  const anchor = linesRef.current.find(item =>
                    item.ownerId === line.ownerId && item.ownerType === line.ownerType && item.kind === 'entry');
                  if (anchor) setBracketDragPreview({ anchorLineId: anchor.id, kind: line.kind, top });
                }
              }}
            >
              {line.addableBrackets?.map(kind => (
                <button
                  key={kind}
                  type="button"
                  data-order-line-control
                  className={`flex h-full min-w-7 cursor-ns-resize items-center justify-center rounded-[3px] border px-1.5 text-[9px] font-black text-white shadow-sm ${kind === 'stopLoss' ? 'border-rose-600 bg-rose-500 hover:bg-rose-600' : 'border-emerald-700 bg-emerald-600 hover:bg-emerald-700'}`}
                  onPointerDown={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    suppressBracketClickRef.current = null;
                    dragRef.current = { id: line.id, bracketKind: kind, moved: false };
                    setBracketDragPreview({ anchorLineId: line.id, kind, top });
                  }}
                  onClick={event => {
                    event.stopPropagation();
                    if (suppressBracketClickRef.current === kind) {
                      suppressBracketClickRef.current = null;
                      return;
                    }
                    onAddBracket?.(line, kind);
                  }}
                  aria-label={kind === 'stopLoss' ? 'Nastavit nebo posunout stop loss' : 'Nastavit nebo posunout take profit'}
                  title={kind === 'stopLoss' ? 'Táhni pro nastavení SL' : 'Táhni pro nastavení TP'}
                >{kind === 'stopLoss' ? 'SL' : 'TP'}</button>
              ))}
              <div
                className={`flex h-full items-center overflow-hidden rounded-[3px] border shadow-sm ${filledLabel ? 'text-white' : 'bg-white'}`}
                style={{
                  borderColor: line.color,
                  backgroundColor: filledLabel ? line.color : undefined,
                  color: filledLabel ? '#ffffff' : line.color,
                }}
              >
                <span className="whitespace-nowrap px-2">{line.label}</span>
                {line.cancellable && (
                  <button
                    type="button"
                    data-order-line-control
                    className={`flex h-full w-6 items-center justify-center border-l text-sm leading-none ${filledLabel ? 'hover:bg-black/10' : 'hover:bg-slate-100'}`}
                    style={{ borderColor: filledLabel ? 'rgba(255,255,255,0.45)' : line.color }}
                    onPointerDown={event => event.stopPropagation()}
                    onClick={event => { event.stopPropagation(); onCancel(line); }}
                    aria-label={line.cancelAction === 'close-position'
                      ? 'Zavřít pozici'
                      : line.cancelAction === 'remove-bracket'
                        ? `Odstranit ${line.kind === 'stopLoss' ? 'stop loss' : 'take profit'}`
                        : 'Zrušit čekající příkaz'}
                  >×</button>
                )}
              </div>
            </div>
            {line.kind !== 'entry' && (
              <div
                className="absolute top-0 flex h-[20px] -translate-y-1/2 items-center justify-center px-1 text-[9px] font-black text-white"
                style={{ left: '100%', width: priceScaleWidth, backgroundColor: line.color }}
                data-backtest-order-price-label
              >
                {line.price.toFixed(2)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default BacktestOrderLinesOverlay;
