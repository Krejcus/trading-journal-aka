import React, { useEffect, useRef } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { ALERT_FIRE_MS, drawAlertFire, type AlertFireCanvas } from '../lib/alertFireEffect';

/**
 * Spuštění upozornění na cenu v LIVE grafu PC (Filip 7. 11. 2026, náhled
 * mockups/alert-fire-breakout.html): na poslední svíčce prsten, doleva světelná vlna, k ceně
 * rozsvícená čára. Jen kreslení nad grafem, bere polohu z grafu po snímcích, nic neovládá.
 */
export default function AlertFireEffect({ api, price, color, width, height, noRing = false }: {
  api: ChartViewApi;
  price: number;
  color: string;
  width: number;
  height: number;
  noRing?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || width <= 0 || height <= 0) return undefined;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    // Poslední skutečná svíčka; budoucí prázdná místa osy ji nesmí nahradit.
    let lastTime: unknown = null;
    try {
      const data = api.controller.getSeries().data();
      for (let index = data.length - 1; index >= 0; index -= 1) {
        if ('close' in data[index]) { lastTime = data[index].time; break; }
      }
    } catch { /* graf se přepíná: vlna půjde od pravého okraje, bez prstenu */ }
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const ms = now - started;
      ctx.clearRect(0, 0, width, height);
      if (ms >= ALERT_FIRE_MS) return;
      try {
        const y = api.controller.getSeries().priceToCoordinate(price);
        const x = lastTime == null ? null : api.controller.getChart().timeScale().timeToCoordinate(lastTime as never);
        if (y != null) drawAlertFire(ctx as AlertFireCanvas, { width, y, pointX: x, ms, color, reduced, noRing });
      } catch { /* graf se přepíná */ }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
    // Jedno spuštění = jeden běh; při změně velikosti panelu se plátno přizpůsobí znovu.
  }, [api, color, height, noRing, price, width]);
  return <canvas ref={canvasRef} aria-hidden data-alert-fire style={{ position: 'absolute', left: 0, top: 0, width, height, pointerEvents: 'none' }} />;
}
