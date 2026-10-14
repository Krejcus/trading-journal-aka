import React, { useEffect, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { Drawing, DrawingPoint, DrawingStyle } from '@getcandlekit/charts';
import { priceText } from './DayPrimitives';
import { pathSegmentId } from '../../lib/dayChartTools';

/**
 * Dotykové kreslení pro CandleKit na telefonu. Řadič kreslení v CandleKit
 * poslouchá jen myš (`mousedown`/`mousemove`/`mouseup`), a iOS při
 * `touch-action: none` žádné náhradní události myši neposílá — prstem se
 * tedy nic nenakreslí. Tahle vrstva překládá dotyky na volání řadiče
 * (`onDown`/`onMove`/`onUp` se souřadnicemi vůči prvku grafu), takže
 * nástroje, magnet, výběr i přesun kresby fungují stejně jako myší.
 *
 * Nástroje CandleKit: klepnutí položí první bod, tah natáhne a puštění
 * dokončí; klepnutí bez tahu nechá kresbu otevřenou pro druhé klepnutí.
 * Bez nástroje klepnutí na kresbu vybere, tah vybranou kresbu přesune;
 * jinde se graf normálně posouvá. Dva prsty vždy patří grafu (pinch).
 *
 * Cesta (`pathActive`, TradingView Path): klepnutí = bod, další klepnutí
 * nebo tah = další úsek (zlom), dvojklep = konec. Úseky jsou samostatné
 * kresby CandleKit (`TrendLine`, poslední `Arrow`) se společnou skupinou
 * v ID, takže se dají smazat a obarvit najednou.
 */

interface EngineLike {
  getActiveTool: () => string | null;
  getDraft: () => Drawing | null;
  cancelDraft: () => void;
  isLocked: () => boolean;
  stopTool: () => void;
  startTool: (tool: string) => void;
  beginDraft: (tool: string, point: DrawingPoint) => void;
  updateDraftEnd: (point: DrawingPoint) => void;
  commit: (drawing: Drawing) => void;
  remove: (id: string) => void;
  getById: (id: string) => Drawing | undefined;
  getDefaultStyle: () => DrawingStyle;
  select: (id: string | null) => void;
  newDrawingId: () => string;
}

interface ControllerLike {
  engine: EngineLike;
  onDown: (event: FakeMouseEvent) => void;
  onMove: (event: FakeMouseEvent) => void;
  onUp: () => void;
  onLeave?: () => void;
  hitTest?: (x: number, y: number) => unknown;
  unproject?: (x: number, y: number) => DrawingPoint | null;
}

interface FakeMouseEvent {
  offsetX: number;
  offsetY: number;
  handled: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

const TAP_TOLERANCE_PX = 8;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 24;

const fakeEvent = (offsetX: number, offsetY: number): FakeMouseEvent => {
  const event: FakeMouseEvent = {
    offsetX, offsetY, handled: false,
    preventDefault: () => { event.handled = true; },
    stopPropagation: () => { event.handled = true; },
  };
  return event;
};

export default function DayTouchDrawLayer({ chartApi, containerRef, enabled, pathActive = false, pathStyle, onPathEnd }: {
  chartApi: ChartViewApi | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Jen v režimu kreslení; mimo něj se dotyky grafu nedotýkají. */
  enabled: boolean;
  /** Virtuální nástroj „cesta“ je zapnutý (nástroje CandleKit jsou vypnuté). */
  pathActive?: boolean;
  /** Barva a tloušťka úseků cesty. */
  pathStyle?: { color: string; width: number };
  /** Dvojklep ukončil cestu — rodič vypne chip. */
  onPathEnd?: () => void;
}) {
  const [crosshair, setCrosshair] = useState<{ x: number; y: number; price: string | null } | null>(null);

  useEffect(() => {
    if (!enabled || !chartApi) return;
    const controller = chartApi.drawing as unknown as ControllerLike | undefined;
    if (!controller || typeof controller.onDown !== 'function') return;
    const { engine } = controller;
    let element: HTMLElement;
    let series: { coordinateToPrice: (y: number) => number | null } | null = null;
    try {
      element = chartApi.controller.getChart().chartElement();
      series = chartApi.controller.getSeries();
    } catch { return; }

    let touching = false;
    let start: { x: number; y: number } | null = null;
    let last: { x: number; y: number } | null = null;
    let moved = false;
    /** Druhé klepnutí dokončuje otevřenou kresbu (po klepnutí bez tahu). */
    let finishOnEnd = false;
    /** Dotyk zasáhl kresbu nebo nástroj — graf nesmí posouvat. */
    let captured = false;

    // Cesta: skupina, poslední bod, index úseku, poslední klepnutí (dvojklep).
    const pathGroup = engine.newDrawingId().replace(/[^a-z0-9]/gi, '').slice(-12) || String(Date.now());
    let pathLast: DrawingPoint | null = null;
    let pathIndex = 0;
    let lastTap: { at: number; x: number; y: number } | null = null;

    const offset = (touch: Touch) => {
      const rect = element.getBoundingClientRect();
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    };
    const unproject = (point: { x: number; y: number }): DrawingPoint | null => (typeof controller.unproject === 'function' ? controller.unproject(point.x, point.y) : null);
    const showCrosshair = (point: { x: number; y: number }) => {
      const box = containerRef.current?.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      if (!box) return;
      const price = series?.coordinateToPrice(point.y);
      setCrosshair({ x: point.x + rect.left - box.left, y: point.y + rect.top - box.top, price: price == null ? null : priceText(Number(price)) });
    };
    const reset = () => { touching = false; start = null; last = null; moved = false; captured = false; setCrosshair(null); };
    const block = (event: TouchEvent) => { event.preventDefault(); event.stopPropagation(); };

    // ── Cesta ────────────────────────────────────────────────────────────
    const segmentStyle = (): DrawingStyle => ({ ...engine.getDefaultStyle(), color: pathStyle?.color ?? engine.getDefaultStyle().color, width: pathStyle?.width ?? 2, fill: null });
    const samePoint = (a: DrawingPoint, b: DrawingPoint) => a.time === b.time && a.price === b.price;
    const beginPathDraft = (from: DrawingPoint) => {
      if (engine.getActiveTool() !== 'Arrow') engine.startTool('Arrow');
      engine.beginDraft('Arrow', from);
    };
    /** Uzavře úsek do bodu `to`: předchozí úsek ztratí šipku, nový ji dostane. */
    const commitPathSegment = (to: DrawingPoint) => {
      if (!pathLast || samePoint(pathLast, to)) return;
      if (pathIndex > 0) {
        const previousId = pathSegmentId(pathGroup, pathIndex);
        const previous = engine.getById(previousId);
        if (previous) { engine.remove(previousId); engine.commit({ ...previous, tool: 'TrendLine' }); }
      }
      pathIndex += 1;
      engine.commit({ id: pathSegmentId(pathGroup, pathIndex), tool: 'Arrow', points: [pathLast, to], style: segmentStyle() });
      pathLast = to;
      beginPathDraft(to);
      engine.select(null);
    };
    const endPath = () => {
      if (engine.getDraft()) engine.cancelDraft();
      if (engine.getActiveTool()) engine.stopTool();
      pathLast = null; pathIndex = 0; lastTap = null;
      onPathEnd?.();
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        // Druhý prst: pinch patří grafu, rozdělaný tah ukončíme bez změny.
        if (touching) { if (!pathActive) controller.onUp(); reset(); }
        return;
      }
      if (engine.isLocked()) return;
      const point = offset(event.touches[0]);
      touching = true; start = point; last = point; moved = false;

      if (pathActive) {
        const data = unproject(point);
        if (!data) { reset(); return; }
        captured = true;
        if (!pathLast) { pathLast = data; beginPathDraft(data); }
        else if (engine.getDraft()) engine.updateDraftEnd(data);
        else beginPathDraft(pathLast);
        showCrosshair(point);
        block(event);
        return;
      }

      const tool = engine.getActiveTool();
      if (tool) {
        // Prst na existující kresbě má přednost před novou kresbou: vybere
        // a táhne (TradingView se chová stejně). Nástroj se tím vypne.
        const hit = !engine.getDraft() && typeof controller.hitTest === 'function' ? controller.hitTest(point.x, point.y) : null;
        if (hit) {
          engine.stopTool();
          const down = fakeEvent(point.x, point.y);
          controller.onDown(down);
          captured = down.handled;
          if (captured) block(event);
          return;
        }
        captured = true;
        if (engine.getDraft()) {
          // Druhé klepnutí: konec kresby jde pod prst, dokončí se při puštění.
          controller.onMove(fakeEvent(point.x, point.y));
          finishOnEnd = true;
        } else {
          controller.onDown(fakeEvent(point.x, point.y));
          finishOnEnd = false;
        }
        showCrosshair(point);
        block(event);
        return;
      }
      const down = fakeEvent(point.x, point.y);
      controller.onDown(down);
      captured = down.handled;
      if (captured) block(event);
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!touching || event.touches.length !== 1) return;
      const point = offset(event.touches[0]);
      if (start && Math.hypot(point.x - start.x, point.y - start.y) > TAP_TOLERANCE_PX) moved = true;
      last = point;
      if (!captured) return;
      if (pathActive) {
        const data = unproject(point);
        if (data && engine.getDraft()) engine.updateDraftEnd(data);
        showCrosshair(point);
        block(event);
        return;
      }
      controller.onMove(fakeEvent(point.x, point.y));
      if (engine.getActiveTool()) showCrosshair(point);
      block(event);
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!touching) return;
      if (pathActive && captured && last) {
        const now = Date.now();
        const doubleTap = !moved && lastTap && now - lastTap.at < DOUBLE_TAP_MS && Math.hypot(last.x - lastTap.x, last.y - lastTap.y) < DOUBLE_TAP_PX;
        if (doubleTap) {
          endPath();
        } else {
          const data = unproject(last);
          // První klepnutí bez tahu jen položí začátek; tah nebo další klepnutí uzavře úsek.
          if (data && (moved || pathIndex > 0 || (pathLast && !samePoint(pathLast, data)))) commitPathSegment(data);
          lastTap = { at: now, x: last.x, y: last.y };
        }
        block(event);
        reset();
        return;
      }
      const tool = engine.getActiveTool();
      if (captured && tool && engine.getDraft() && last && (moved || finishOnEnd)) {
        // Tah nebo druhé klepnutí: řadič dokončí kresbu stejně jako druhý klik myší.
        controller.onDown(fakeEvent(last.x, last.y));
        finishOnEnd = false;
      }
      if (captured && !tool) {
        controller.onUp();
        // Myš by hover zrušila odjetím; prst neodjíždí, úchyty by zůstaly svítit.
        controller.onLeave?.();
      }
      // Desktopová volba „kreslit dál“ nástroj po dokončení znovu nasadí; na
      // telefonu chceme jednu kresbu na výběr nástroje (klepnutí pak vybírá).
      if (captured && tool && !engine.getDraft() && engine.getActiveTool()) engine.stopTool();
      if (captured) block(event);
      reset();
    };

    const onTouchCancel = () => {
      if (!touching) return;
      if (pathActive) {
        if (engine.getDraft()) engine.cancelDraft();
        if (pathLast) beginPathDraft(pathLast);
      } else {
        if (engine.getDraft()) engine.cancelDraft();
        controller.onUp();
        finishOnEnd = false;
      }
      reset();
    };

    const options: AddEventListenerOptions = { capture: true, passive: false };
    element.addEventListener('touchstart', onTouchStart, options);
    element.addEventListener('touchmove', onTouchMove, options);
    element.addEventListener('touchend', onTouchEnd, options);
    element.addEventListener('touchcancel', onTouchCancel, options);
    return () => {
      element.removeEventListener('touchstart', onTouchStart, options);
      element.removeEventListener('touchmove', onTouchMove, options);
      element.removeEventListener('touchend', onTouchEnd, options);
      element.removeEventListener('touchcancel', onTouchCancel, options);
      if (engine.getDraft()) engine.cancelDraft();
      if (pathActive && engine.getActiveTool() === 'Arrow') engine.stopTool();
      setCrosshair(null);
    };
  }, [chartApi, containerRef, enabled, onPathEnd, pathActive, pathStyle]);

  if (!crosshair) return null;
  return (
    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 21 }}>
      <div style={{ position: 'absolute', left: crosshair.x, top: 0, bottom: 0, width: 0, borderLeft: '1px dashed rgba(129,140,248,0.8)' }} />
      <div style={{ position: 'absolute', top: crosshair.y, left: 0, right: 0, height: 0, borderTop: '1px dashed rgba(129,140,248,0.8)' }} />
      {crosshair.price && (
        <span className="dj-mono" style={{ position: 'absolute', left: Math.max(6, crosshair.x - 120), top: Math.max(6, crosshair.y - 34), padding: '3px 8px', borderRadius: 7, fontSize: 12, fontWeight: 700, color: '#0b0f19', background: '#c7d2fe', whiteSpace: 'nowrap' }}>{crosshair.price}</span>
      )}
    </div>
  );
}
