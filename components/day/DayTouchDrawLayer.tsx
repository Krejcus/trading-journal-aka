import React, { useEffect, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { Drawing, DrawingPoint, DrawingStyle } from '@getcandlekit/charts';
import { priceText } from './DayPrimitives';
import { pathGroupOf, pathSegmentId } from '../../lib/dayChartTools';

/**
 * Dotykové kreslení pro CandleKit na telefonu. Řadič kreslení v CandleKit
 * poslouchá jen myš (`mousedown`/`mousemove`/`mouseup`), a iOS při
 * `touch-action: none` žádné náhradní události myši neposílá — prstem se
 * tedy nic nenakreslí. Tahle vrstva překládá dotyky na volání řadiče
 * (`onDown`/`onMove`/`onUp` se souřadnicemi vůči prvku grafu), takže
 * nástroje, magnet, výběr i přesun kresby fungují stejně jako myší.
 *
 * Ovládání jako mobilní TradingView: s nástrojem v ruce se objeví
 * crosshair, tah prstem ho posouvá jako touchpad (bod není pod prstem),
 * klepnutí potvrdí bod v místě crosshairu a rozdělaná kresba se táhne za
 * ním. Bez nástroje klepnutí na kresbu vybere a tah ji přesune; jinde se
 * graf normálně posouvá. Dva prsty vždy patří grafu (pinch).
 *
 * Cesta (`pathActive`, TradingView Path): klepnutí = bod, další klepnutí
 * = zlom, dvojklep = konec. Úseky jsou samostatné
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
  getDrawings: () => readonly Drawing[];
  setPoints: (id: string, points: DrawingPoint[]) => void;
  onChange: (listener: () => void) => () => void;
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
  hitTest?: (x: number, y: number) => { id: string; kind: string; anchorIndex?: number } | null;
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

    // Kurzor (crosshair) jako v mobilním TradingView: tah prstem ho posouvá
    // relativně (touchpad), takže bod není schovaný pod prstem; klepnutí
    // potvrdí bod v místě kurzoru. Souřadnice vůči prvku grafu.
    let cursor: { x: number; y: number } | null = null;
    let touching = false;
    let touchStart: { x: number; y: number } | null = null;
    let touchLast: { x: number; y: number } | null = null;
    let moved = false;
    /** Dotyk patří kreslení / kresbě — graf nesmí posouvat. */
    let captured = false;
    /** Dotyk táhne existující kresbu (řadič, bez kurzoru). */
    let dragging = false;

    // Cesta: skupina, poslední bod, index úseku, poslední klepnutí (dvojklep).
    const pathGroup = engine.newDrawingId().replace(/[^a-z0-9]/gi, '').slice(-12) || String(Date.now());
    let pathLast: DrawingPoint | null = null;
    let pathIndex = 0;
    let lastTap: { at: number; x: number; y: number } | null = null;
    /** Crosshair se od posledního bodu cesty pohnul (klepnutí bez posunu = konec, jako TV). */
    let cursorMovedSincePoint = false;

    const offset = (touch: Touch) => {
      const rect = element.getBoundingClientRect();
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    };
    const clamp = (point: { x: number; y: number }) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.max(0, Math.min(rect.width - 60, point.x)), y: Math.max(0, Math.min(rect.height - 30, point.y)) };
    };
    const unproject = (point: { x: number; y: number }): DrawingPoint | null => (typeof controller.unproject === 'function' ? controller.unproject(point.x, point.y) : null);
    const showCrosshair = (point: { x: number; y: number } | null) => {
      if (!point) { setCrosshair(null); return; }
      const box = containerRef.current?.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      if (!box) return;
      const price = series?.coordinateToPrice(point.y);
      setCrosshair({ x: point.x + rect.left - box.left, y: point.y + rect.top - box.top, price: price == null ? null : priceText(Number(price)) });
    };
    const block = (event: TouchEvent) => { event.preventDefault(); event.stopPropagation(); };
    const drawingMode = () => pathActive || Boolean(engine.getActiveTool());

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
      pathLast = null; pathIndex = 0; lastTap = null; cursor = null;
      showCrosshair(null);
      onPathEnd?.();
    };

    /** Rozdělaná kresba sleduje kurzor. */
    const followCursor = () => {
      if (!cursor) return;
      if (pathActive) {
        const data = unproject(cursor);
        if (data && engine.getDraft()) engine.updateDraftEnd(data);
      } else if (engine.getActiveTool()) {
        controller.onMove(fakeEvent(cursor.x, cursor.y));
      }
      showCrosshair(cursor);
    };
    /** Klepnutí: bod v místě kurzoru. */
    const placeAtCursor = () => {
      if (!cursor) return;
      if (pathActive) {
        const data = unproject(cursor);
        if (!data) return;
        if (!pathLast) { pathLast = data; beginPathDraft(data); }
        else commitPathSegment(data);
        return;
      }
      const tool = engine.getActiveTool();
      if (!tool) return;
      controller.onDown(fakeEvent(cursor.x, cursor.y));
      if (!engine.getDraft()) {
        // Kresba hotová: nástroj z ruky (desktopové „kreslit dál“ by ho vrátilo), kurzor pryč.
        if (engine.getActiveTool()) engine.stopTool();
        cursor = null;
        showCrosshair(null);
        onPathEnd?.();
      }
    };

    // ── Úprava hotové cesty: úseky drží pohromadě ───────────────────────
    // Řadič táhne jen zasažený úsek; tady se dorovnají sousední úseky
    // (zlom = společný bod) nebo, při tahu celým úsekem, celá cesta.
    let pathDrag: { id: string; group: string; index: number; kind: string; anchorIndex: number; before: DrawingPoint[] } | null = null;
    const segmentIndex = (id: string) => Number(id.split(':')[2]);
    const startDrag = (point: { x: number; y: number }, event: TouchEvent) => {
      const hit = typeof controller.hitTest === 'function' ? controller.hitTest(point.x, point.y) : null;
      const down = fakeEvent(point.x, point.y);
      controller.onDown(down);
      captured = down.handled; dragging = captured;
      pathDrag = null;
      const group = pathGroupOf(hit?.id);
      const drawing = hit && group ? engine.getById(hit.id) : undefined;
      if (captured && hit && group && drawing) {
        pathDrag = { id: hit.id, group, index: segmentIndex(hit.id), kind: hit.kind, anchorIndex: hit.anchorIndex ?? 0, before: drawing.points.map(item => ({ ...item })) };
      }
      if (captured) block(event);
      return captured;
    };
    const syncPathDrag = () => {
      if (!pathDrag) return;
      const current = engine.getById(pathDrag.id);
      if (!current) return;
      if (pathDrag.kind === 'anchor') {
        const moved = current.points[pathDrag.anchorIndex];
        const neighbourId = pathSegmentId(pathDrag.group, pathDrag.anchorIndex === 0 ? pathDrag.index - 1 : pathDrag.index + 1);
        const neighbour = engine.getById(neighbourId);
        if (neighbour && moved) {
          const points = neighbour.points.slice();
          points[pathDrag.anchorIndex === 0 ? 1 : 0] = { ...moved };
          engine.setPoints(neighbourId, points);
        }
        return;
      }
      const dt = current.points[0].time - pathDrag.before[0].time;
      const dp = current.points[0].price - pathDrag.before[0].price;
      if (!dt && !dp) return;
      for (const drawing of engine.getDrawings()) {
        if (drawing.id === pathDrag.id || pathGroupOf(drawing.id) !== pathDrag.group) continue;
        engine.setPoints(drawing.id, drawing.points.map(item => ({ time: item.time + dt, price: item.price + dp })));
      }
      pathDrag.before = current.points.map(item => ({ ...item }));
    };

    // Nástroj v ruce = crosshair hned (uprostřed grafu), ne až po prvním dotyku.
    const ensureCursor = () => {
      if (touching) return;
      if (drawingMode()) {
        if (!cursor) {
          const rect = element.getBoundingClientRect();
          cursor = clamp({ x: rect.width / 2 - 30, y: rect.height / 2 });
          followCursor();
        }
      } else if (cursor) {
        cursor = null;
        showCrosshair(null);
      }
    };
    const offEngine = engine.onChange(ensureCursor);
    ensureCursor();

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        // Druhý prst: pinch patří grafu, rozdělaný tah ukončíme bez změny.
        if (touching && dragging) controller.onUp();
        touching = false; captured = false; dragging = false;
        return;
      }
      if (engine.isLocked()) return;
      const point = offset(event.touches[0]);
      touching = true; touchStart = point; touchLast = point; moved = false; dragging = false;

      if (drawingMode()) {
        // S crosshairem nic nevybíráme: dotyk jen posouvá crosshair (jako TV).
        captured = true;
        if (!cursor) cursor = clamp(point);
        followCursor();
        block(event);
        return;
      }
      startDrag(point, event);
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!touching || event.touches.length !== 1 || !captured) return;
      const point = offset(event.touches[0]);
      if (touchStart && Math.hypot(point.x - touchStart.x, point.y - touchStart.y) > TAP_TOLERANCE_PX) moved = true;
      if (dragging) {
        controller.onMove(fakeEvent(point.x, point.y));
        syncPathDrag();
      } else if (cursor && touchLast) {
        cursor = clamp({ x: cursor.x + point.x - touchLast.x, y: cursor.y + point.y - touchLast.y });
        cursorMovedSincePoint = true;
        followCursor();
      }
      touchLast = point;
      block(event);
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!touching) return;
      touching = false;
      if (!captured) return;
      block(event);
      if (dragging) {
        controller.onUp();
        // Myš by hover zrušila odjetím; prst neodjíždí, úchyty by zůstaly svítit.
        controller.onLeave?.();
        dragging = false; captured = false; pathDrag = null;
        return;
      }
      captured = false;
      if (moved) return; // tah jen posunul kurzor
      const now = Date.now();
      const doubleTap = pathActive && (
        (lastTap && now - lastTap.at < DOUBLE_TAP_MS && touchLast && Math.hypot(touchLast.x - lastTap.x, touchLast.y - lastTap.y) < DOUBLE_TAP_PX)
        // Druhé klepnutí na stejný bod (crosshair se nepohnul) ukončí cestu i při pomalém dvojkliku.
        || (pathIndex > 0 && !cursorMovedSincePoint));
      if (doubleTap) { endPath(); return; }
      placeAtCursor();
      cursorMovedSincePoint = false;
      if (touchLast) lastTap = { at: now, x: touchLast.x, y: touchLast.y };
    };

    const onTouchCancel = () => {
      if (!touching) return;
      if (dragging) controller.onUp();
      touching = false; captured = false; dragging = false;
    };

    const options: AddEventListenerOptions = { capture: true, passive: false };
    element.addEventListener('touchstart', onTouchStart, options);
    element.addEventListener('touchmove', onTouchMove, options);
    element.addEventListener('touchend', onTouchEnd, options);
    element.addEventListener('touchcancel', onTouchCancel, options);
    return () => {
      offEngine();
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
