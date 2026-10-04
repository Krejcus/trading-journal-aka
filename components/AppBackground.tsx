import { useEffect, useMemo, useRef } from 'react';
import { paletteColors, type AppearanceSettings } from '../lib/appearance';

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',');

/** Deterministický šum — prach v Hlubinách je pokaždé na stejném místě. */
const seeded = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function drawDepths(canvas: HTMLCanvasElement, colors: string[], dark: boolean) {
  const width = window.innerWidth, height = window.innerHeight;
  // Světla jsou rozmazaná, ostrost by jen stála výkon — stačí hustota 1.
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  const lights: Array<[number, number, string, number]> = [
    [0.2, 0.22, colors[0], dark ? 0.55 : 0.6],
    [0.82, 0.32, colors[2], dark ? 0.35 : 0.45],
    [0.55, 0.9, colors[1], dark ? 0.4 : 0.5],
  ];
  const radius = Math.max(width, height) * 0.45;
  for (const [fx, fy, color, alpha] of lights) {
    const gradient = ctx.createRadialGradient(width * fx, height * fy, 0, width * fx, height * fy, radius);
    gradient.addColorStop(0, `rgba(${rgb(color)},${alpha})`);
    gradient.addColorStop(1, `rgba(${rgb(color)},0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
  const random = seeded(5);
  const specks = Math.round((width * height) / 2600);
  for (let i = 0; i < specks; i++) {
    const size = random() < 0.05 ? 1.8 : 0.8;
    ctx.fillStyle = dark ? `rgba(255,255,255,${0.06 + random() * 0.4})` : `rgba(30,41,59,${0.04 + random() * 0.14})`;
    ctx.beginPath();
    ctx.arc(random() * width, random() * height, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Pozadí stylu Aurora pod celou aplikací. Pevná vrstva za obsahem — obsah se
 * posouvá, pozadí stojí. Hlubiny se vykreslí jednou (žádná animace = šetří
 * baterii a GPU pod skleněnými kartami); Barevné pole se pomalu přelévá.
 */
export default function AppBackground({ settings, dark }: { settings: AppearanceSettings; dark: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colors = useMemo(() => paletteColors(settings, dark), [settings, dark]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (settings.background !== 'depths' || !canvas) return;
    drawDepths(canvas, colors, dark);
    let timer = 0;
    const onResize = () => { window.clearTimeout(timer); timer = window.setTimeout(() => drawDepths(canvas, colors, dark), 150); };
    window.addEventListener('resize', onResize);
    return () => { window.clearTimeout(timer); window.removeEventListener('resize', onResize); };
  }, [colors, dark, settings.background]);

  // Síla jde přes CSS proměnnou --aurora-strength (0–1), aby posuvník v Nastavení
  // mohl měnit pozadí živě bez překreslení aplikace.
  return (
    <div aria-hidden="true" className={`aurora-bg aurora-bg--${settings.background}`}>
      {settings.background === 'depths'
        ? <canvas ref={canvasRef} className="aurora-bg__canvas" />
        : colors.map((color, index) => <i key={index} className="aurora-bg__blob" style={{ background: color }} />)}
      <div className="aurora-bg__grain" />
    </div>
  );
}
