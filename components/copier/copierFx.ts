// Animace kopírky (jen zobrazení): světelné komety z vypínače k dlaždicím při zapnutí / vypnutí
// a plynulé dopočítání čísel při přepnutí SL/TP skupina ↔ účet.
import { useEffect, useRef, useState } from 'react';

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Komety z `sources` (knoflík vypínače) k `tiles`; zapnutí zeleně ven, vypnutí oranžově zpět. */
export function playCopierEnergy(on: boolean, sources: Array<HTMLElement | null | undefined>, tiles: HTMLElement[]): void {
  if (typeof document === 'undefined' || reduced()) return;
  let cv = document.getElementById('cp-fx') as HTMLCanvasElement | null;
  if (!cv) { cv = document.createElement('canvas'); cv.id = 'cp-fx'; cv.className = 'cp-fx'; document.body.appendChild(cv); }
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = window.innerWidth, H = window.innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vis = (r: DOMRect) => r.width > 0 && r.bottom > 0 && r.top < H && r.right > 0 && r.left < W;
  const src = sources.filter((x): x is HTMLElement => Boolean(x)).map(el => {
    const k = (el.querySelector('.kn') as HTMLElement | null) ?? el;
    const r = k.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, ok: vis(r), host: el };
  }).filter(x => x.ok);
  if (!src.length) return;
  const col = on ? '52,211,153' : '245,158,11';
  const beams = tiles.map(el => ({ el, r: el.getBoundingClientRect() })).filter(x => vis(x.r)).map(({ el, r }) => {
    const sp = src.reduce((best, s) => (Math.hypot(s.x - r.x, s.y - r.y) < Math.hypot(best.x - r.x, best.y - r.y) ? s : best), src[0]);
    const tx = r.x + r.width / 2, ty = r.y + r.height / 2, d = Math.hypot(tx - sp.x, ty - sp.y) || 1;
    const mx = (sp.x + tx) / 2, my = (sp.y + ty) / 2, bend = Math.min(140, d * 0.28) * (tx < sp.x ? 1 : -1);
    return { el, r, sx: sp.x, sy: sp.y, tx, ty, d, cx: mx + (-(ty - sp.y) / d) * bend, cy: my + ((tx - sp.x) / d) * bend - d * 0.12, t0: 0, dur: 0, hit: false };
  }).sort((a, b) => a.d - b.d);
  beams.forEach((b, i) => { b.t0 = on ? 120 + i * 16 : (beams.length - i) * 12; b.dur = 420 + b.d * 0.45; });
  if (!on) beams.forEach(b => { b.el.classList.remove('cp-hit', 'cp-dimfx'); void b.el.offsetWidth; b.el.classList.add('cp-dimfx'); window.setTimeout(() => b.el.classList.remove('cp-dimfx'), 1100); });
  const pt = (b: typeof beams[number], k: number) => { const u = 1 - k; return [u * u * b.sx + 2 * u * k * b.cx + k * k * b.tx, u * u * b.sy + 2 * u * k * b.cy + k * k * b.ty] as const; };
  const rings: Array<{ x: number; y: number; t: number; w: number; h: number }> = [];
  const parts: Array<{ x: number; y: number; vx: number; vy: number; t: number }> = [];
  const t0 = performance.now(), end = Math.max(0, ...beams.map(b => b.t0 + b.dur)) + 700;
  const prev = (playCopierEnergy as unknown as { raf?: number }).raf; if (prev) cancelAnimationFrame(prev);
  const frame = (now: number) => {
    const el = now - t0; ctx.clearRect(0, 0, W, H); ctx.globalCompositeOperation = 'lighter';
    for (const b of beams) {
      const raw = (el - b.t0) / b.dur; if (raw <= 0) continue;
      const ease = 1 - Math.pow(1 - Math.min(1, raw), 3), head = on ? ease : 1 - ease, tail = on ? Math.max(0, head - 0.28) : Math.min(1, head + 0.28);
      if (raw < 1.25) {
        const N = 14, fade = Math.max(0, 1 - Math.max(0, raw - 1) * 4);
        for (let j = 0; j < N; j++) {
          const [x1, y1] = pt(b, tail + (head - tail) * (j / N)), [x2, y2] = pt(b, tail + (head - tail) * ((j + 1) / N));
          ctx.strokeStyle = `rgba(${col},${(j / N) * 0.9 * fade})`; ctx.lineWidth = 1 + (j / N) * 2.2;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }
        if (raw < 1) {
          const [hx, hy] = pt(b, head), gr = ctx.createRadialGradient(hx, hy, 0, hx, hy, 12);
          gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(0.3, `rgba(${col},.8)`); gr.addColorStop(1, `rgba(${col},0)`);
          ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(hx, hy, 12, 0, 7); ctx.fill();
        }
      }
      if (raw >= 1 && !b.hit) {
        b.hit = true;
        if (on) {
          b.el.classList.remove('cp-hit', 'cp-dimfx'); void b.el.offsetWidth; b.el.classList.add('cp-hit'); window.setTimeout(() => b.el.classList.remove('cp-hit'), 1000);
          rings.push({ x: b.tx, y: b.ty, t: el, w: b.r.width, h: b.r.height });
          for (let q = 0; q < 7; q++) { const a = Math.random() * 6.28, v = 0.05 + Math.random() * 0.09; parts.push({ x: b.tx, y: b.ty, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: el }); }
        } else rings.push({ x: b.sx, y: b.sy, t: el, w: 26, h: 26 });
      }
    }
    for (const r of rings) {
      const k = (el - r.t) / 520; if (k > 1) continue;
      ctx.strokeStyle = `rgba(${col},${(1 - k) * 0.75})`; ctx.lineWidth = 2 * (1 - k) + 0.5;
      const ww = r.w / 2 + k * 14, hh = r.h / 2 + k * 14;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(r.x - ww, r.y - hh, ww * 2, hh * 2, Math.min(14, hh)); else ctx.rect(r.x - ww, r.y - hh, ww * 2, hh * 2);
      ctx.stroke();
    }
    for (const p of parts) {
      const k = (el - p.t) / 650; if (k > 1) continue; const dt = el - p.t;
      ctx.fillStyle = `rgba(${col},${(1 - k) * 0.9})`; ctx.beginPath(); ctx.arc(p.x + p.vx * dt, p.y + p.vy * dt + k * k * 10, 1.6 * (1 - k) + 0.4, 0, 7); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    if (el < end) (playCopierEnergy as unknown as { raf?: number }).raf = requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, W, H);
  };
  (playCopierEnergy as unknown as { raf?: number }).raf = requestAnimationFrame(frame);
}

/** Číslo, které při změně `key` (režim) plynule dojede z předchozí hodnoty; jinak se ukáže hned. */
export function useTweenOnKey(value: number | null, key: string, ms = 520): number | null {
  const [shown, setShown] = useState(value);
  const last = useRef(value), lastKey = useRef(key), raf = useRef(0), busy = useRef(false);
  useEffect(() => {
    const from = last.current;
    if (key !== lastKey.current && from != null && value != null && !reduced()) {
      lastKey.current = key; busy.current = true; cancelAnimationFrame(raf.current);
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
        setShown(from + (value - from) * e);
        if (k < 1) raf.current = requestAnimationFrame(step); else { busy.current = false; last.current = value; }
      };
      raf.current = requestAnimationFrame(step);
      return;
    }
    lastKey.current = key;
    if (!busy.current) { last.current = value; setShown(value); }
  }, [value, key, ms]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return shown;
}
