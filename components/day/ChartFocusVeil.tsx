import React, { useEffect, useRef } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { focusRectForDrawing, focusRectForPrice, type FocusRect } from '../../services/chartFocusRect';

/**
 * Zaostření na vybranou věc (telefon): okolí grafu ztmavne, vybraná kresba
 * nebo čára upozornění zůstane v jasném „okně“. Jen zobrazení — vrstva
 * nechytá dotyky (`pointer-events: none`) a ovládací čáry obchodu leží nad
 * ní, takže nic, čím se snižuje riziko, neztmaví ani nezakryje (INV-UI-02).
 *
 * Okno se počítá v každém snímku ze souřadnic grafu: posun, zoom i tah
 * úchytu ho vedou bez překreslování Reactu.
 */

export type ChartFocusTarget = { kind: 'drawing'; id: string } | { kind: 'price'; price: number };

interface DrawingLike { tool: string; points: readonly { time: number; price: number }[] }

export default function ChartFocusVeil({ api, target, isDark }: {
  api: ChartViewApi | null;
  target: ChartFocusTarget | null;
  isDark: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const holeRef = useRef<HTMLDivElement | null>(null);
  const targetKey = target ? (target.kind === 'drawing' ? `d:${target.id}` : `p:${target.price}`) : null;

  useEffect(() => {
    const root = rootRef.current;
    const hole = holeRef.current;
    if (!api || !target || !root || !hole) return undefined;
    let frame = 0;
    let last = '';
    const measure = (): { rect: FocusRect; width: number; height: number; left: number; top: number } | null => {
      try {
        const chart = api.controller.getChart();
        const series = api.controller.getSeries();
        const element = chart.chartElement();
        const box = root.parentElement?.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        if (!box) return null;
        const width = bounds.width - chart.priceScale('right').width();
        const height = bounds.height - chart.timeScale().height();
        let rect: FocusRect | null;
        if (target.kind === 'price') {
          rect = focusRectForPrice(series.priceToCoordinate(target.price), width, height);
        } else {
          const engine = api.drawing?.engine as { getById?: (id: string) => DrawingLike | undefined } | undefined;
          const drawing = engine?.getById?.(target.id);
          if (!drawing) return null;
          const points = drawing.points.map(point => ({
            x: chart.timeScale().timeToCoordinate(point.time as never),
            y: series.priceToCoordinate(point.price),
          }));
          rect = focusRectForDrawing(drawing.tool, points, width, height);
        }
        return rect ? { rect, width, height, left: bounds.left - box.left, top: bounds.top - box.top } : null;
      } catch { return null; }
    };
    const tick = () => {
      frame = window.requestAnimationFrame(tick);
      const next = measure();
      const key = next ? `${next.left}|${next.top}|${next.width}|${next.height}|${next.rect.left}|${next.rect.top}|${next.rect.width}|${next.rect.height}` : '';
      if (key === last) return;
      last = key;
      if (!next) { root.style.display = 'none'; return; }
      root.style.display = 'block';
      root.style.left = `${next.left}px`;
      root.style.top = `${next.top}px`;
      root.style.width = `${next.width}px`;
      root.style.height = `${next.height}px`;
      hole.style.left = `${next.rect.left}px`;
      hole.style.top = `${next.rect.top}px`;
      hole.style.width = `${next.rect.width}px`;
      hole.style.height = `${next.rect.height}px`;
    };
    tick();
    return () => window.cancelAnimationFrame(frame);
  }, [api, targetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!api || !target) return null;
  const wash = isDark ? 'rgba(3, 6, 16, 0.6)' : 'rgba(226, 232, 240, 0.72)';
  return (
    <div ref={rootRef} aria-hidden="true" data-chart-focus-veil style={{ position: 'absolute', display: 'none', overflow: 'hidden', pointerEvents: 'none', zIndex: 4, animation: 'dj-focus-in .2s ease both' }}>
      <div
        ref={holeRef}
        data-chart-focus-hole
        style={{ position: 'absolute', boxSizing: 'border-box', borderRadius: 12, border: `1px solid ${isDark ? 'rgba(165, 180, 252, 0.4)' : 'rgba(79, 70, 229, 0.35)'}`, boxShadow: `0 0 0 4000px ${wash}` }}
      />
    </div>
  );
}
