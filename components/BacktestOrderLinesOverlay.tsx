import React, { useEffect, useRef, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { orderLineLabelParts, type BacktestChartOrderLine, type BacktestChartOrderLineKind } from '../services/backtestOrderLines';
import type { ChartOrderLineLabels } from '../services/chartSettings';

interface Props {
  api: ChartViewApi;
  lines: BacktestChartOrderLine[];
  showPriceLabels?: boolean;
  /** Štítky SL/TP: body od vstupu + P&L, nebo jen P&L. */
  labelMode?: ChartOrderLineLabels;
  isDark?: boolean;
  /** `startLine` = čára v okamžiku chycení (živé příkazy posílají „co jsem viděl“ ze začátku tahu). */
  onChange: (line: BacktestChartOrderLine, kind: BacktestChartOrderLineKind, price: number, startLine?: BacktestChartOrderLine) => void;
  onCancel: (line: BacktestChartOrderLine) => void;
  /** Tlačítka `line.actions` (např. BE u živé pozice). */
  onAction?: (line: BacktestChartOrderLine, actionId: string) => void;
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

/**
 * Tenký štítek Aurora: mléčné sklo s vlastní výplní (Chrome nemusí kreslit
 * backdrop blur), obrys a typ v barvě čáry, čísla neutrální, P&L barevně.
 */
const OrderLineBadge: React.FC<{
  label: string;
  kind: BacktestChartOrderLineKind;
  color: string;
  isDark: boolean;
  labelMode: ChartOrderLineLabels;
  children?: React.ReactNode;
}> = ({ label, kind, color, isDark, labelMode, children }) => {
  const parts = orderLineLabelParts(label);
  const muted = isDark ? '#8391a7' : '#64748b';
  const showPoints = kind === 'entry' || labelMode === 'points-pnl';
  return (
    <div
      className="flex h-[19px] items-center gap-[7px] whitespace-nowrap rounded-[4px] border pl-[7px] pr-[2px] text-[10.5px] font-medium backdrop-blur-md backdrop-saturate-150"
      style={{
        borderColor: `${color}61`,
        backgroundColor: isDark ? 'rgba(13, 18, 26, 0.86)' : 'rgba(255, 255, 255, 0.9)',
        boxShadow: `0 4px 12px -8px ${color}bf, inset 0 1px 0 rgba(255, 255, 255, ${isDark ? 0.06 : 0.5})`,
        color: isDark ? '#e2e8f0' : '#0f172a',
      }}
      data-order-line-badge
    >
      <span className="font-semibold tracking-[0.02em]" style={{ color }}>{parts.key}</span>
      {parts.price && <span className="font-mono" style={{ color: muted }}>{parts.price}</span>}
      {showPoints && parts.points && <span className="font-mono" style={{ color: muted }}>{parts.points}</span>}
      {parts.pnl && <span className="font-mono font-semibold" style={{ color }}>{parts.pnl}</span>}
      {parts.note && <span style={{ color: muted }}>{parts.note}</span>}
      {children ?? <span className="w-[3px]" />}
    </div>
  );
};

const CONFIRM_MS = 4_000;

const BacktestOrderLinesOverlay: React.FC<Props> = ({ api, lines, showPriceLabels = true, labelMode = 'points-pnl', isDark = false, onChange, onCancel, onAction, onAddBracket }) => {
  // Dvoukrokové potvrzení živých akcí (× / BE): první klik „Opravdu?“, druhý do 4 s odešle.
  // window.confirm prohlížeč v appce potichu blokuje (29. 10.).
  const [confirming, setConfirming] = useState<{ key: string; until: number } | null>(null);
  useEffect(() => {
    if (!confirming) return undefined;
    const timer = window.setTimeout(() => setConfirming(null), Math.max(0, confirming.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [confirming]);
  const confirmed = (key: string, needsConfirm: boolean | undefined) => {
    if (!needsConfirm) return true;
    const now = Date.now();
    // Dvojklik se nepočítá jako potvrzení: druhý klik až po 350 ms.
    if (confirming?.key === key && confirming.until > now && now - (confirming.until - CONFIRM_MS) >= 350) { setConfirming(null); return true; }
    if (confirming?.key === key && confirming.until > now) return false;
    setConfirming({ key, until: now + CONFIRM_MS });
    return false;
  };
  const asking = (key: string) => confirming?.key === key;
  const rootRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef(lines);
  const lineElementsRef = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<{
    id: string;
    bracketKind?: Exclude<BacktestChartOrderLineKind, 'entry'>;
    moved?: boolean;
    lastPrice?: number;
    startY?: number;
    startLine?: BacktestChartOrderLine;
  } | null>(null);
  const suppressBracketClickRef = useRef<Exclude<BacktestChartOrderLineKind, 'entry'> | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const [coordinates, setCoordinates] = useState<Record<string, number>>({});
  const [priceScaleWidth, setPriceScaleWidth] = useState(64);
  const [bracketDragPreview, setBracketDragPreview] = useState<{
    anchorLineId: string;
    kind: Exclude<BacktestChartOrderLineKind, 'entry'>;
    top: number;
    /** Cena taženého nového SL/TP (u tažení existující čáry ji nese dragOverride). */
    price?: number;
  } | null>(null);
  // Tažení čáry žije jen v overlays — commit do enginu (a render celého
  // workspace) proběhne jednou při puštění. Změna stavu enginu na každý pixel
  // znamenala překreslení všech panelů na každý pohyb myši.
  const [dragOverride, setDragOverride] = useState<{ lineId: string; top: number; price: number } | null>(null);
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
    // Posun/zoom grafu překresluje canvas synchronně; kdyby čáry čekaly na
    // React render, viditelně by za position boxem zaostávaly. Proto se top
    // nastaví přímo na DOM hned v handleru a React stav jen dorovná stejné
    // hodnoty.
    const positionNow = () => {
      linesRef.current.forEach(line => {
        if (dragRef.current && !dragRef.current.bracketKind && dragRef.current.id === line.id) return;
        const element = lineElementsRef.current.get(line.id);
        if (!element) return;
        const coordinate = series.priceToCoordinate(line.price);
        if (coordinate !== null) element.style.top = `${Math.round(coordinate * 2) / 2}px`;
      });
    };
    refreshRef.current = schedule;
    const rangeHandler = () => {
      positionNow();
      schedule();
    };
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
      if (!dragging.moved && dragging.startY !== undefined && Math.abs(event.clientY - dragging.startY) < (line.dragDeadZonePx ?? 0)) return;
      const raw = api.controller.getSeries().coordinateToPrice(event.clientY - root.getBoundingClientRect().top);
      if (raw === null || !Number.isFinite(raw)) return;
      const snapped = Math.round(raw / 0.25) * 0.25;
      const top = api.controller.getSeries().priceToCoordinate(snapped);
      dragging.moved = true;
      dragging.lastPrice = snapped;
      const previewKind = dragging.bracketKind ?? (line.kind === 'entry' ? undefined : line.kind);
      if (previewKind && top !== null) {
        const anchor = linesRef.current.find(item =>
          item.ownerId === line.ownerId && item.ownerType === line.ownerType && item.kind === 'entry');
        if (anchor) setBracketDragPreview({ anchorLineId: anchor.id, kind: previewKind, top, price: dragging.bracketKind ? snapped : undefined });
      }
      if (!dragging.bracketKind && top !== null) {
        setDragOverride({ lineId: line.id, top: Math.round(top * 2) / 2, price: snapped });
      }
    };
    const finish = (commit: boolean) => {
      const dragging = dragRef.current;
      dragRef.current = null;
      setBracketDragPreview(null);
      setDragOverride(null);
      if (!dragging || !commit || !dragging.moved || dragging.lastPrice === undefined) return;
      const line = linesRef.current.find(item => item.id === dragging.id);
      if (!line) return;
      if (dragging.bracketKind) {
        suppressBracketClickRef.current = dragging.bracketKind;
        onAddBracket?.(line, dragging.bracketKind, dragging.lastPrice);
      } else {
        onChange(line, line.kind, dragging.lastPrice, dragging.startLine);
      }
    };
    const stop = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', cancel, true);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', cancel, true);
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
      {bracketDragPreview?.price !== undefined && (() => {
        // Nový SL/TP tažený z tlačítka: čára i popisek s P&L jedou s myší.
        const anchor = lines.find(item => item.id === bracketDragPreview.anchorLineId);
        const color = bracketDragPreview.kind === 'stopLoss' ? '#ef4444' : '#0f9f8f';
        const label = anchor?.bracketLabelAt?.(bracketDragPreview.kind, bracketDragPreview.price)
          ?? `${bracketDragPreview.kind === 'stopLoss' ? 'SL' : 'TP'}  ${bracketDragPreview.price.toFixed(2)}`;
        return (
          <div className="pointer-events-none absolute left-0 h-0" style={{ right: priceScaleWidth, top: bracketDragPreview.top }} data-backtest-bracket-ghost>
            <div className="absolute inset-x-0 top-0 border-t border-dashed" style={{ borderColor: color }} />
            <div className="absolute right-1 top-0 -translate-y-1/2">
              <OrderLineBadge label={label} kind={bracketDragPreview.kind} color={color} isDark={isDark} labelMode={labelMode} />
            </div>
            {showPriceLabels && (
              <div className="absolute top-0 flex h-[20px] -translate-y-1/2 items-center justify-center px-1 text-[9px] font-black text-white" style={{ left: '100%', width: priceScaleWidth, backgroundColor: color }}>
                {bracketDragPreview.price.toFixed(2)}
              </div>
            )}
          </div>
        );
      })()}
      {lines.map(line => {
        const dragged = dragOverride?.lineId === line.id;
        const top = dragged ? dragOverride.top : coordinates[line.id];
        const shownPrice = dragged ? dragOverride.price : line.price;
        if (!Number.isFinite(top)) return null;
        return (
          <div
            key={line.id}
            ref={element => {
              if (element) lineElementsRef.current.set(line.id, element);
              else lineElementsRef.current.delete(line.id);
            }}
            className="absolute left-0 h-0"
            style={{ right: priceScaleWidth, top }}
          >
            <div className="absolute inset-x-0 top-0 border-t border-dashed opacity-90" style={{ borderColor: line.color }} />
            <div
              role={line.draggable ? 'button' : undefined}
              aria-label={line.draggable ? `Posunout ${line.label} ${line.price.toFixed(2)}` : undefined}
              tabIndex={line.draggable ? 0 : undefined}
              className={`pointer-events-auto absolute right-1 top-0 flex h-[19px] -translate-y-1/2 items-center gap-[4px] ${line.draggable ? 'cursor-ns-resize' : 'cursor-default'}`}
              onPointerDown={event => {
                if (!line.draggable || (event.target as HTMLElement).closest('[data-order-line-control]')) return;
                event.preventDefault();
                event.stopPropagation();
                dragRef.current = { id: line.id, startY: event.clientY, startLine: line };
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
                  className={`flex h-full cursor-ns-resize items-center justify-center whitespace-nowrap rounded-[4px] border border-dashed px-[6px] text-[9.5px] font-semibold ${isDark ? 'hover:bg-white/10' : 'hover:bg-slate-900/5'}`}
                  style={{
                    color: kind === 'stopLoss' ? '#ef4444' : '#0f9f8f',
                    borderColor: kind === 'stopLoss' ? '#ef4444' : '#0f9f8f',
                    backgroundColor: isDark ? 'rgba(13, 18, 26, 0.86)' : 'rgba(255, 255, 255, 0.9)',
                  }}
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
                >{kind === 'stopLoss' ? '+ SL' : '+ TP'}</button>
              ))}
              <OrderLineBadge
                label={dragged && line.labelAt ? line.labelAt(shownPrice) : line.label}
                kind={line.kind}
                color={line.color}
                isDark={isDark}
                labelMode={labelMode}
              >
                {line.actions?.map(action => (
                  <button
                    key={action.id}
                    type="button"
                    data-order-line-control
                    disabled={action.disabled}
                    title={action.title}
                    className={`flex h-[15px] items-center justify-center rounded-[3px] border px-[5px] text-[9.5px] font-bold leading-none disabled:cursor-not-allowed disabled:opacity-40 ${isDark ? 'border-white/15 text-slate-200 hover:bg-white/10' : 'border-slate-300 text-slate-700 hover:bg-slate-900/[0.06]'}`}
                    onPointerDown={event => event.stopPropagation()}
                    onClick={event => {
                      event.stopPropagation();
                      if (action.disabled || !confirmed(`${line.id}:${action.id}`, action.confirm)) return;
                      onAction?.(line, action.id);
                    }}
                    aria-label={action.title ?? action.label}
                  >{asking(`${line.id}:${action.id}`) ? 'Opravdu?' : action.label}</button>
                ))}
                {line.cancellable && (
                  <button
                    type="button"
                    data-order-line-control
                    className={`flex h-[15px] min-w-[15px] items-center justify-center rounded-[3px] text-[11px] leading-none ${asking(`${line.id}:cancel`) ? 'px-[5px] text-[9.5px] font-bold text-rose-400' : ''} ${isDark ? 'text-slate-400 hover:bg-white/10' : 'text-slate-500 hover:bg-slate-900/[0.06]'}`}
                    onPointerDown={event => event.stopPropagation()}
                    onClick={event => {
                      event.stopPropagation();
                      if (!confirmed(`${line.id}:cancel`, line.confirmCancel)) return;
                      onCancel(line);
                    }}
                    aria-label={line.cancelAction === 'close-position'
                      ? 'Zavřít pozici'
                      : line.cancelAction === 'remove-bracket'
                        ? `Odstranit ${line.kind === 'stopLoss' ? 'stop loss' : 'take profit'}`
                        : 'Zrušit čekající příkaz'}
                  >{asking(`${line.id}:cancel`) ? 'Opravdu?' : '×'}</button>
                )}
              </OrderLineBadge>
            </div>
            {showPriceLabels && line.kind !== 'entry' && (
              <div
                className="absolute top-0 flex h-[20px] -translate-y-1/2 items-center justify-center px-1 text-[9px] font-black text-white"
                style={{ left: '100%', width: priceScaleWidth, backgroundColor: line.color }}
                data-backtest-order-price-label
              >
                {shownPrice.toFixed(2)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default BacktestOrderLinesOverlay;
