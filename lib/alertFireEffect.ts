/**
 * Kreslení spuštění upozornění (schválený náhled mockups/alert-fire-breakout.html, „1 · Prsten“ + vlna B).
 * Čistá funkce nad 2D plátnem: nic nečte z grafu ani neovládá.
 */

/** Celá animace; musí sedět na `FLASH_MS` v `LivePcPriceAlerts`. */
export const ALERT_FIRE_MS = 3_200;
const WAVE_MS = 1_750;
const WAVE_FADE_MS = 500;
const WAVE_REACH = 92;

export type AlertFireCanvas = Pick<CanvasRenderingContext2D,
  'clearRect' | 'beginPath' | 'arc' | 'moveTo' | 'lineTo' | 'stroke' | 'fill' | 'fillRect' | 'createLinearGradient' | 'createRadialGradient'
  | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'shadowColor' | 'shadowBlur'>;

export interface AlertFireFrame {
  width: number;
  y: number;
  /** Poslední svíčka; `null` nebo mimo výřez = vlna od pravého okraje, bez prstenu. */
  pointX: number | null;
  ms: number;
  color: string;
  /** Omezené animace: bez pohybu, jen klidný prsten. */
  reduced?: boolean;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const backOut = (t: number) => 1 + 2.9 * (t - 1) ** 3 + 1.9 * (t - 1) ** 2;

/** `#rrggbb` → `r,g,b` pro `rgba()`; nesmysl spadne na jantarovou. */
export function alertFireRgb(color: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return '245,181,61';
  const n = Number.parseInt(match[1], 16);
  return `${n >> 16},${(n >> 8) & 255},${n & 255}`;
}

/** Čelo vlny: od bodu (kousek za ním) přes levý okraj, ať doběhne až ven. */
export function alertWaveFront(t: number, startX: number): number {
  const progress = clamp01(t);
  return startX + 40 - (Math.sin(progress * Math.PI / 2) * 0.4 + progress * 0.6) * (startX + 160);
}

/** Bod průrazu: jen uvnitř výřezu grafu. */
export function alertFirePoint(pointX: number | null, width: number): number | null {
  return pointX != null && Number.isFinite(pointX) && pointX >= 0 && pointX <= width ? pointX : null;
}

function drawRing(ctx: AlertFireCanvas, px: number, y: number, ms: number, rgb: string, reduced: boolean) {
  const hold = clamp01(ms / 140) * (ms < 2_400 ? 1 : clamp01(1 - (ms - 2_400) / 800));
  if (hold <= 0) return;
  if (!reduced) {
    const haloAlpha = 0.26 * clamp01(1 - ms / 1_300);
    if (haloAlpha > 0) {
      const glow = ctx.createRadialGradient(px, y, 0, px, y, 34);
      glow.addColorStop(0, `rgba(${rgb},${haloAlpha})`);
      glow.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(px - 34, y - 34, 68, 68);
    }
    for (const delay of [0, 190]) {
      const t = clamp01((ms - delay) / 950);
      if (t <= 0 || t >= 1) continue;
      ctx.beginPath();
      ctx.arc(px, y, 5 + easeOut(t) * 27, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${rgb},${0.85 * (1 - t) ** 1.4})`;
      ctx.lineWidth = 1.4 - t;
      ctx.stroke();
    }
  }
  const pop = reduced ? 1 : backOut(clamp01(ms / 320));
  ctx.shadowColor = `rgba(${rgb},${hold})`;
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.arc(px, y, Math.max(0.5, 5.5 * pop), 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${rgb},${hold})`;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(px, y, 1.4, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,255,255,${hold})`;
  ctx.fill();
}

function drawWave(ctx: AlertFireCanvas, startX: number, y: number, ms: number, rgb: string) {
  if (ms >= WAVE_MS + WAVE_FADE_MS) return;
  const t = Math.min(1, ms / WAVE_MS);
  const front = alertWaveFront(t, startX);
  const fade = ms > WAVE_MS ? 1 - (ms - WAVE_MS) / WAVE_FADE_MS : 1;
  const decay = (1 - t * 0.78) * fade;
  const from = Math.max(0, front - WAVE_REACH * 1.6);
  const to = Math.min(startX, front + WAVE_REACH * 1.6);
  if (to <= from) return;
  const gradient = ctx.createLinearGradient(from, 0, to, 0);
  const mid = clamp01((front - from) / (to - from));
  gradient.addColorStop(0, `rgba(${rgb},0)`);
  gradient.addColorStop(Math.max(0, mid - 0.12), `rgba(${rgb},${0.75 * decay})`);
  gradient.addColorStop(mid, `rgba(255,244,214,${decay})`);
  gradient.addColorStop(Math.min(1, mid + 0.12), `rgba(${rgb},${0.75 * decay})`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  ctx.beginPath();
  ctx.moveTo(from, y);
  ctx.lineTo(to, y);
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 2;
  ctx.shadowColor = `rgba(${rgb},${0.8 * decay})`;
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawToAxis(ctx: AlertFireCanvas, startX: number, width: number, y: number, ms: number, rgb: string) {
  if (ms >= 2_600 || width <= startX) return;
  const alpha = ms < 1_400 ? Math.min(1, ms / 200) : 1 - (ms - 1_400) / 1_200;
  const gradient = ctx.createLinearGradient(startX, 0, width, 0);
  gradient.addColorStop(0, `rgba(255,244,214,${alpha})`);
  gradient.addColorStop(1, `rgba(${rgb},${alpha * 0.8})`);
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(startX, y);
  ctx.lineTo(width, y);
  ctx.stroke();
}

export function drawAlertFire(ctx: AlertFireCanvas, frame: AlertFireFrame): void {
  const rgb = alertFireRgb(frame.color);
  const point = alertFirePoint(frame.pointX, frame.width);
  const startX = point ?? frame.width;
  if (!frame.reduced) {
    drawWave(ctx, startX, frame.y, frame.ms, rgb);
    drawToAxis(ctx, startX, frame.width, frame.y, frame.ms, rgb);
  }
  if (point != null) drawRing(ctx, point, frame.y, frame.ms, rgb, frame.reduced === true);
}
