/**
 * Živý graf v pozadí aplikace (Vzhled → Pozadí → Svíčky / Equity křivka).
 * Čistě ozdoba: data jsou vymyšlená náhodná procházka, nejsou to obchody
 * ani cena z trhu a nic se z nich nikde nepočítá.
 */

export type BackgroundChartKind = 'candles' | 'equity';

interface Candle { o: number; c: number; h: number; l: number }

export interface BackgroundChartState {
  candles: Candle[];
  equity: number[];
  /** Čas od poslední nové svíčky / bodu křivky (s). */
  candleAge: number;
  equityAge: number;
  /** Počet svíček od začátku — drží svislé čáry mřížky na svíčkách. */
  candleCount: number;
  lo: number; hi: number; equityLo: number; equityHi: number;
}

const CANDLE_PERIOD = 1.6;
const EQUITY_PERIOD = 0.3;
const MAX_CANDLES = 700;
const MAX_EQUITY = 1400;

export function createBackgroundChartState(random: () => number = Math.random): BackgroundChartState {
  const candles: Candle[] = [];
  let price = 21500;
  for (let i = 0; i < 300; i++) {
    const open = price;
    price += (random() - 0.48) * 14;
    candles.push({ o: open, c: price, h: Math.max(open, price) + random() * 6, l: Math.min(open, price) - random() * 6 });
  }
  const equity: number[] = [];
  let balance = 50000;
  for (let i = 0; i < 700; i++) { balance += (random() - 0.43) * 240; equity.push(balance); }
  const state: BackgroundChartState = { candles, equity, candleAge: 0, equityAge: 0, candleCount: candles.length, lo: 0, hi: 1, equityLo: 0, equityHi: 1 };
  const range = visibleRange(state);
  Object.assign(state, { lo: range.lo, hi: range.hi, equityLo: range.equityLo, equityHi: range.equityHi });
  return state;
}

function visibleRange(state: BackgroundChartState) {
  let lo = Infinity, hi = -Infinity;
  for (const candle of state.candles.slice(-110)) { lo = Math.min(lo, candle.l); hi = Math.max(hi, candle.h); }
  let equityLo = Infinity, equityHi = -Infinity;
  for (const value of state.equity.slice(-420)) { equityLo = Math.min(equityLo, value); equityHi = Math.max(equityHi, value); }
  return { lo, hi, equityLo, equityHi };
}

/** Posune graf o `dt` sekund: poslední svíčka se tvoří, po čase přibude nová; křivka dostane další bod. */
export function stepBackgroundChart(state: BackgroundChartState, dt: number, random: () => number = Math.random): void {
  if (dt <= 0) return;
  const last = state.candles[state.candles.length - 1];
  last.c += (random() - 0.49) * 2;
  last.h = Math.max(last.h, last.c);
  last.l = Math.min(last.l, last.c);
  state.candleAge += dt;
  if (state.candleAge > CANDLE_PERIOD) {
    state.candleAge = 0;
    state.candles.push({ o: last.c, c: last.c, h: last.c, l: last.c });
    state.candleCount++;
    if (state.candles.length > MAX_CANDLES) state.candles.shift();
  }
  state.equityAge += dt;
  if (state.equityAge > EQUITY_PERIOD) {
    state.equityAge = 0;
    state.equity.push(state.equity[state.equity.length - 1] + (random() - 0.43) * 240);
    if (state.equity.length > MAX_EQUITY) state.equity.shift();
  }
  // Osa se k novému rozsahu dotahuje plynule, aby graf neposkakoval.
  const range = visibleRange(state);
  state.lo += (range.lo - state.lo) * 0.06;
  state.hi += (range.hi - state.hi) * 0.06;
  state.equityLo += (range.equityLo - state.equityLo) * 0.06;
  state.equityHi += (range.equityHi - state.equityHi) * 0.06;
}

const money = (value: number) => `$${Math.round(value).toLocaleString('cs-CZ').replace(/\s/g, ' ')}`;
const FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/** Vykreslí graf přes celé plátno (souřadnice v CSS pixelech, plátno už má nastavené měřítko). */
export function drawBackgroundChart(
  ctx: CanvasRenderingContext2D, state: BackgroundChartState, kind: BackgroundChartKind,
  width: number, height: number, dark: boolean, alpha: number, nowMs: number,
): void {
  const ink = dark ? '#9aa6bd' : '#4b5670';
  const grid = dark ? 'rgba(255,255,255,.07)' : 'rgba(15,23,42,.08)';
  const UP = dark ? '#26a69a' : '#089981', DOWN = dark ? '#ef5350' : '#e0433f';
  const small = width < 420;
  const axis = small ? 0 : 62;
  const plotW = width - axis, plotH = height - (small ? 0 : 24);
  const isEquity = kind === 'equity';
  const lo = isEquity ? state.equityLo : state.lo, hi = isEquity ? state.equityHi : state.hi;
  const pad = (hi - lo) * 0.12;
  const Y = (value: number) => ((hi + pad - value) / (hi - lo + 2 * pad)) * plotH;

  ctx.save();
  ctx.font = FONT;
  ctx.lineWidth = 1;
  const rawStep = (hi - lo) / 5;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(m => m >= rawStep) ?? rawStep;
  for (let value = Math.ceil((lo - pad) / step) * step; value < hi + pad; value += step) {
    const y = Math.round(Y(value)) + 0.5;
    ctx.strokeStyle = grid;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    if (axis) {
      ctx.fillStyle = ink;
      ctx.globalAlpha = Math.min(1, alpha * 1.3);
      ctx.fillText(isEquity ? money(value) : value.toFixed(0), plotW + 8, Y(value) + 4);
      ctx.globalAlpha = 1;
    }
  }
  const label = (text: string, y: number, color: string) => {
    if (!axis) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha * 1.8);
    ctx.fillStyle = color;
    ctx.fillRect(plotW, y - 9, axis, 18);
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${FONT}`;
    ctx.fillText(text, plotW + 6, y + 4);
    ctx.restore();
  };

  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, plotW, plotH); ctx.clip();
  let tag: [string, number, string];
  if (!isEquity) {
    const slot = small ? 8 : 12;
    const shift = state.candleAge / CANDLE_PERIOD;
    const count = Math.min(Math.ceil(plotW / slot) + 2, state.candles.length);
    for (let j = 0; j < count; j++) {
      if ((state.candleCount - j) % 12 !== 0) continue;
      const x = Math.round(plotW - slot * (j + shift) + slot / 2) + 0.5;
      ctx.strokeStyle = grid;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke();
    }
    ctx.globalAlpha = alpha;
    const bodyW = Math.round(slot * 0.66);
    for (let j = 0; j < count; j++) {
      const candle = state.candles[state.candles.length - 1 - j];
      const x = plotW - slot * (j + shift) + slot / 2 - 1;
      ctx.strokeStyle = ctx.fillStyle = candle.c >= candle.o ? UP : DOWN;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, Y(candle.h)); ctx.lineTo(Math.round(x) + 0.5, Y(candle.l)); ctx.stroke();
      ctx.fillRect(Math.round(x - bodyW / 2) + 0.5, Math.min(Y(candle.o), Y(candle.c)), bodyW, Math.max(1, Math.abs(Y(candle.o) - Y(candle.c))));
    }
    const last = state.candles[state.candles.length - 1];
    const color = last.c >= last.o ? UP : DOWN;
    ctx.strokeStyle = color;
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(0, Y(last.c)); ctx.lineTo(plotW, Y(last.c)); ctx.stroke();
    ctx.setLineDash([]);
    tag = [last.c.toFixed(2), Y(last.c), color];
  } else {
    const spacing = small ? 2 : 3;
    const shift = state.equityAge / EQUITY_PERIOD;
    const length = state.equity.length;
    const count = Math.min(Math.ceil(plotW / spacing) + 2, length);
    const endX = plotW - (small ? 10 : 26);
    const last = state.equity[length - 1], previous = state.equity[length - 2];
    const tip = previous + (last - previous) * shift;
    let top = -Infinity;
    ctx.beginPath();
    ctx.moveTo(endX, Y(tip));
    for (let j = 1; j < count; j++) {
      const value = state.equity[length - 1 - j];
      ctx.lineTo(endX - spacing * (j - 1 + shift), Y(value));
      top = Math.max(top, value);
    }
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = UP; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineTo(-10, plotH); ctx.lineTo(endX, plotH); ctx.closePath();
    const fill = ctx.createLinearGradient(0, 0, 0, plotH);
    fill.addColorStop(0, `${UP}55`); fill.addColorStop(1, `${UP}00`);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = ink;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, Y(top)); ctx.lineTo(plotW, Y(top)); ctx.stroke();
    ctx.setLineDash([]);
    if (!small) { ctx.fillStyle = ink; ctx.fillText(`maximum ${money(top)}`, 10, Y(top) - 6); }
    const pulse = (nowMs / 1200) % 1;
    ctx.fillStyle = UP;
    ctx.globalAlpha = alpha * (1 - pulse);
    ctx.beginPath(); ctx.arc(endX, Y(tip), 4 + pulse * 14, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = Math.min(1, alpha * 2);
    ctx.beginPath(); ctx.arc(endX, Y(tip), 4, 0, Math.PI * 2); ctx.fill();
    tag = [money(tip), Y(tip), UP];
  }
  ctx.restore();
  label(...tag);
  ctx.restore();
}
