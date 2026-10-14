import React, { useEffect, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { priceText } from './DayPrimitives';

/**
 * Dotykové kreslení pro CandleKit na telefonu. Řadič kreslení v CandleKit
 * poslouchá jen myš (`mousedown`/`mousemove`/`mouseup`), a iOS při
 * `touch-action: none` žádné náhradní události myši neposílá — prstem se
 * tedy nic nenakreslí. Tahle vrstva překládá dotyky na volání řadiče
 * (`onDown`/`onMove`/`onUp` se souřadnicemi vůči prvku grafu), takže
 * nástroje, magnet, výběr i přesun kresby fungují stejně jako myší.
 *
 * Ovládání jako v mobilním TradingView: klepnutí položí první bod,
 * tah natáhne kresbu a puštění ji dokončí; samotné klepnutí nechá
 * kresbu otevřenou a druhé klepnutí ji dokončí. Bez aktivního nástroje
 * klepnutí na kresbu vybere, tah vybranou kresbu přesune; jinde se graf
 * normálně posouvá. Dva prsty vždy patří grafu (pinch).
 */

interface ControllerLike {
  engine: {
    getActiveTool: () => string | null;
    getDraft: () => unknown;
    cancelDraft: () => void;
    isLocked: () => boolean;
    stopTool: () => void;
  };
  onDown: (event: FakeMouseEvent) => void;
  onMove: (event: FakeMouseEvent) => void;
  onUp: () => void;
  hitTest?: (x: number, y: number) => unknown;
}

interface FakeMouseEvent {
  offsetX: number;
  offsetY: number;
  handled: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

const TAP_TOLERANCE_PX = 8;

const fakeEvent = (offsetX: number, offsetY: number): FakeMouseEvent => {
  const event: FakeMouseEvent = {
    offsetX, offsetY, handled: false,
    preventDefault: () => { event.handled = true; },
    stopPropagation: () => { event.handled = true; },
  };
  return event;
};

export default function DayTouchDrawLayer({ chartApi, containerRef, enabled }: {
  chartApi: ChartViewApi | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Jen v režimu kreslení; mimo něj se dotyky grafu nedotýkají. */
  enabled: boolean;
}) {
  const [crosshair, setCrosshair] = useState<{ x: number; y: number; price: string | null } | null>(null);

  useEffect(() => {
    if (!enabled || !chartApi) return;
    const controller = chartApi.drawing as unknown as ControllerLike | undefined;
    if (!controller || typeof controller.onDown !== 'function') return;
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

    const offset = (touch: Touch) => {
      const rect = element.getBoundingClientRect();
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    };
    const showCrosshair = (point: { x: number; y: number }) => {
      const box = containerRef.current?.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      if (!box) return;
      const price = series?.coordinateToPrice(point.y);
      setCrosshair({ x: point.x + rect.left - box.left, y: point.y + rect.top - box.top, price: price == null ? null : priceText(Number(price)) });
    };
    const reset = () => { touching = false; start = null; last = null; moved = false; captured = false; setCrosshair(null); };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        // Druhý prst: pinch patří grafu, rozdělaný tah ukončíme bez změny.
        if (touching) { controller.onUp(); reset(); }
        return;
      }
      if (controller.engine.isLocked()) return;
      const point = offset(event.touches[0]);
      const tool = controller.engine.getActiveTool();
      touching = true; start = point; last = point; moved = false;
      if (tool) {
        // Prst na existující kresbě má přednost před novou kresbou: vybere
        // a táhne (TradingView se chová stejně). Nástroj se tím vypne.
        const hit = !controller.engine.getDraft() && typeof controller.hitTest === 'function' ? controller.hitTest(point.x, point.y) : null;
        if (hit) {
          controller.engine.stopTool();
          const down = fakeEvent(point.x, point.y);
          controller.onDown(down);
          captured = down.handled;
          if (captured) { event.preventDefault(); event.stopPropagation(); }
          return;
        }
        captured = true;
        if (controller.engine.getDraft()) {
          // Druhé klepnutí: konec kresby jde pod prst, dokončí se při puštění.
          controller.onMove(fakeEvent(point.x, point.y));
          finishOnEnd = true;
        } else {
          controller.onDown(fakeEvent(point.x, point.y));
          finishOnEnd = false;
        }
        showCrosshair(point);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const down = fakeEvent(point.x, point.y);
      controller.onDown(down);
      captured = down.handled;
      if (captured) { event.preventDefault(); event.stopPropagation(); }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!touching || event.touches.length !== 1) return;
      const point = offset(event.touches[0]);
      if (start && Math.hypot(point.x - start.x, point.y - start.y) > TAP_TOLERANCE_PX) moved = true;
      last = point;
      if (!captured) return;
      controller.onMove(fakeEvent(point.x, point.y));
      if (controller.engine.getActiveTool()) showCrosshair(point);
      event.preventDefault();
      event.stopPropagation();
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (!touching) return;
      const tool = controller.engine.getActiveTool();
      if (captured && tool && controller.engine.getDraft() && last && (moved || finishOnEnd)) {
        // Tah nebo druhé klepnutí: řadič dokončí kresbu stejně jako druhý klik myší.
        controller.onDown(fakeEvent(last.x, last.y));
        finishOnEnd = false;
      }
      if (captured && !tool) controller.onUp();
      if (captured) { event.preventDefault(); event.stopPropagation(); }
      reset();
    };
    const onTouchCancel = () => {
      if (!touching) return;
      if (controller.engine.getDraft()) controller.engine.cancelDraft();
      controller.onUp();
      finishOnEnd = false;
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
      if (controller.engine.getDraft()) controller.engine.cancelDraft();
      setCrosshair(null);
    };
  }, [chartApi, containerRef, enabled]);

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
