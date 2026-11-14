import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { paletteColors, type AppearanceSettings } from '../lib/appearance';
import { createBackgroundChartState, drawBackgroundChart, stepBackgroundChart, type BackgroundChartKind } from '../lib/backgroundCharts';
import { createSmokeFluid } from '../lib/smokeFluid';

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',');

/** Barvy pro přibližnou Auroru v index.html, než se načte JavaScript (žádné černé probliknutí). */
export const AURORA_BOOT_KEY = 'alphatrade_aurora_boot';

/**
 * Tři světla přesně jako skutečné pozadí: barvy a síla z Hlubin (drawDepths)
 * vynásobené průhledností a sytostí vrstvy `.aurora-bg` podle síly (CSS:
 * opacity 0.3 + 0.7·s, saturate 0.12 + 0.88·s) — start pak nezáří víc.
 */
export function bootSpots(colors: string[], dark: boolean, strength: number, dim = 1): string[] {
  const s = Math.min(1, Math.max(0, strength / 100));
  const layer = 0.3 + 0.7 * s;
  const saturation = 0.12 + 0.88 * s;
  const alphas = dark ? [0.55, 0.35, 0.4] : [0.6, 0.45, 0.5];
  const order = [0, 2, 1];
  return order.map((index, slot) => {
    const hex = colors[index] ?? colors[0];
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    // Desaturace jako CSS saturate(): míchání se šedou stejného jasu.
    const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mix = (channel: number) => Math.round(gray + (channel - gray) * saturation);
    return `${mix(r)},${mix(g)},${mix(b)},${(alphas[slot] * layer * dim).toFixed(3)}`;
  });
}

/** Deterministický šum — prach v Hlubinách je pokaždé na stejném místě. */
const seeded = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** Prach se kreslí jednou do vlastního plátna — při pohybu světel se jen přiloží. */
function drawDust(width: number, height: number, dark: boolean): HTMLCanvasElement {
  const dust = document.createElement('canvas');
  dust.width = width; dust.height = height;
  const ctx = dust.getContext('2d');
  if (!ctx) return dust;
  const random = seeded(5);
  const specks = Math.round((width * height) / 2600);
  for (let i = 0; i < specks; i++) {
    const size = random() < 0.05 ? 1.8 : 0.8;
    ctx.fillStyle = dark ? `rgba(255,255,255,${0.06 + random() * 0.4})` : `rgba(30,41,59,${0.04 + random() * 0.14})`;
    ctx.beginPath();
    ctx.arc(random() * width, random() * height, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  return dust;
}

/**
 * Hlubiny: tři světla a prach. `time` = 0 dává přesně dosavadní stojící
 * obraz; s časem se světla pomalu posouvají. `dim` ztlumí světla pod grafem.
 */
function drawDepths(canvas: HTMLCanvasElement, colors: string[], dark: boolean, dust: HTMLCanvasElement, time = 0, dim = 1) {
  const width = dust.width, height = dust.height;
  // Světla jsou rozmazaná, ostrost by jen stála výkon — stačí hustota 1.
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  const lights: Array<[number, number, string, number]> = [
    [0.2, 0.22, colors[0], dark ? 0.55 : 0.6],
    [0.82, 0.32, colors[2], dark ? 0.35 : 0.45],
    [0.55, 0.9, colors[1], dark ? 0.4 : 0.5],
  ];
  const radius = Math.max(width, height) * 0.45;
  lights.forEach(([fx, fy, color, alpha], index) => {
    const phaseX = index * 2.1, phaseY = index * 1.3;
    const x = width * (fx + 0.09 * (Math.sin(time * 0.11 + phaseX) - Math.sin(phaseX)));
    const y = height * (fy + 0.08 * (Math.cos(time * 0.09 + phaseY) - Math.cos(phaseY)));
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(${rgb(color)},${alpha * dim})`);
    gradient.addColorStop(1, `rgba(${rgb(color)},0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  });
  ctx.drawImage(dust, 0, 0);
}

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const hasMouse = () => typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const hexToUnit = (hex: string): [number, number, number] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/**
 * Kouř za kurzorem. Vlastní pevná vrstva nad pozadím a pod obsahem; běží jen
 * na zařízení s myší a jen chvíli po pohybu — v klidu se smyčka zastaví.
 */
function SmokeLayer({ colors, strength }: { colors: string[]; strength: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ colors, strength });
  live.current = { colors, strength };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasMouse() || reducedMotion()) return;
    const resize = () => { canvas.width = Math.max(1, Math.round(window.innerWidth * 0.75)); canvas.height = Math.max(1, Math.round(window.innerHeight * 0.75)); };
    resize();
    const fluid = createSmokeFluid(canvas);
    if (!fluid) return;
    let frame = 0, last = 0, lastMove = 0;
    let pointer: [number, number] | null = null;
    const IDLE_MS = 9000;
    const tick = (now: number) => {
      frame = 0;
      if (document.hidden || now - lastMove > IDLE_MS) { fluid.clear(); fluid.resetPointer(); return; }
      const dt = Math.min(0.033, Math.max(0.001, (now - last) / 1000));
      last = now;
      const palette = live.current.colors.slice(0, 3).map(hexToUnit);
      const phase = now / 1400, index = Math.floor(phase) % palette.length, mix = phase % 1;
      const from = palette[index], to = palette[(index + 1) % palette.length];
      fluid.step(dt, pointer, [0, 1, 2].map(i => from[i] + (to[i] - from[i]) * mix) as [number, number, number], live.current.strength / 50);
      frame = requestAnimationFrame(tick);
    };
    const wake = () => { lastMove = performance.now(); if (!frame) { last = lastMove; frame = requestAnimationFrame(tick); } };
    const at = (event: PointerEvent): [number, number] => [event.clientX / window.innerWidth, 1 - event.clientY / window.innerHeight];
    const onMove = (event: PointerEvent) => { if (event.pointerType !== 'mouse') return; pointer = at(event); wake(); };
    const onDown = (event: PointerEvent) => { if (event.pointerType !== 'mouse') return; pointer = at(event); fluid.puff(pointer[0], pointer[1]); wake(); };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('resize', resize);
      fluid.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className="aurora-smoke" />;
}

/**
 * Pozadí stylu Aurora pod celou aplikací. Pevná vrstva za obsahem — obsah se
 * posouvá, pozadí stojí. S rychlostí 0 se Hlubiny vykreslí jednou (žádná
 * animace = šetří baterii a GPU pod skleněnými kartami); jinak se světla
 * pomalu posouvají. Svíčky a Equity křivka jsou ozdobný graf nad ztlumenými
 * Hlubinami, Skvrny se přelévají přes CSS, „Žádné“ nechá jen čistou barvu.
 */
export default function AppBackground({ settings, dark }: { settings: AppearanceSettings; dark: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<HTMLCanvasElement>(null);
  const colors = useMemo(() => paletteColors(settings, dark), [settings, dark]);

  // Přibližná Aurora z index.html končí, jakmile je tu skutečná; barvy si zapamatovat na příští start.
  useLayoutEffect(() => { document.documentElement.classList.remove('aurora-boot'); }, []);
  useEffect(() => {
    try { localStorage.setItem(AURORA_BOOT_KEY, JSON.stringify({ spots: bootSpots(colors, dark, settings.strength, settings.background === 'none' ? 0 : settings.background === 'candles' || settings.background === 'equity' ? 0.5 : 1) })); } catch { /* jen bez náhledu při startu */ }
  }, [colors, dark, settings.strength, settings.background]);

  const { background } = settings;
  const chartKind: BackgroundChartKind | null = background === 'candles' || background === 'equity' ? background : null;
  const usesDepths = background === 'depths' || chartKind !== null;
  // Rychlost čte smyčka z refu — posuvník ji mění bez nového spuštění efektu.
  const speedRef = useRef(settings.speed);
  speedRef.current = settings.speed;
  const moving = settings.speed > 0;

  // Layout efekt: plátno se vykreslí před prvním snímkem (jinak by jeden snímek bylo prázdné).
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!usesDepths || !canvas) return;
    const chartCanvas = chartRef.current;
    const chartCtx = chartKind && chartCanvas ? chartCanvas.getContext('2d') : null;
    const dim = chartKind ? 0.5 : 1;
    const chart = chartKind ? createBackgroundChartState() : null;
    let dust = drawDust(window.innerWidth, window.innerHeight, dark);
    let clock = 0, frame = 0, last = 0, tickCount = 0, timer = 0;

    const paintChart = (now: number) => {
      if (!chartKind || !chart || !chartCanvas || !chartCtx) return;
      const density = Math.min(2, window.devicePixelRatio || 1), width = window.innerWidth, height = window.innerHeight;
      if (chartCanvas.width !== Math.round(width * density) || chartCanvas.height !== Math.round(height * density)) {
        chartCanvas.width = Math.round(width * density); chartCanvas.height = Math.round(height * density);
      }
      chartCtx.setTransform(density, 0, 0, density, 0, 0);
      chartCtx.clearRect(0, 0, width, height);
      drawBackgroundChart(chartCtx, chart, chartKind, width, height, dark, 0.6, now);
    };
    const paint = (now: number) => { drawDepths(canvas, colors, dark, dust, clock, dim); paintChart(now); };
    paint(0);

    const animate = moving && !reducedMotion();
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (document.hidden) { last = now; return; }
      const dt = Math.min(0.05, (now - last) / 1000) * (speedRef.current / 50);
      last = now;
      clock += dt;
      if (chart) stepBackgroundChart(chart, dt);
      // Světla jsou rozmazaná a pomalá — stačí každý druhý snímek; graf jede naplno.
      tickCount++;
      if (chartKind) { if (tickCount % 30 === 0) drawDepths(canvas, colors, dark, dust, clock, dim); paintChart(now); }
      else if (tickCount % 2 === 0) drawDepths(canvas, colors, dark, dust, clock, dim);
    };
    if (animate) { last = performance.now(); frame = requestAnimationFrame(tick); }

    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { dust = drawDust(window.innerWidth, window.innerHeight, dark); paint(performance.now()); }, 150);
    };
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); window.removeEventListener('resize', onResize); };
  }, [colors, dark, usesDepths, chartKind, moving]);

  // Kouř má na tmavém pozadí světlé barvy palety a na světlém tmavé — jinak by nebyl vidět.
  const smokeColors = useMemo(() => paletteColors(settings, !dark), [settings, dark]);

  // Síla jde přes CSS proměnnou --aurora-strength (0–1), aby posuvník v Nastavení
  // mohl měnit pozadí živě bez překreslení aplikace.
  // Skvrny: 50 = dosavadní tempo, 0 = stojí.
  const blobStyle = (color: string) => ({
    background: color,
    animationPlayState: moving ? 'running' : 'paused',
    ['--aurora-drift-scale' as string]: String(50 / Math.max(5, settings.speed)),
  });
  return (
    <>
      <div aria-hidden="true" className={`aurora-bg aurora-bg--${background}`}>
        {usesDepths && <canvas ref={canvasRef} className="aurora-bg__canvas" />}
        {chartKind && <canvas ref={chartRef} className="aurora-bg__canvas" />}
        {background === 'field' && colors.map((color, index) => <i key={index} className="aurora-bg__blob" style={blobStyle(color)} />)}
        {background !== 'none' && <div className="aurora-bg__grain" />}
      </div>
      {settings.mouseEffect === 'smoke' && settings.mouseStrength > 0 && <SmokeLayer colors={smokeColors} strength={settings.mouseStrength} />}
    </>
  );
}
