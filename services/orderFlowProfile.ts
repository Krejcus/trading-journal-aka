/**
 * Volume profil z order flow: součet minutových buněk do cenových řádků, POC, value area a delta.
 * Čisté výpočty pro indikátor Volume profil a natažený profil — jen zobrazení.
 */
import { tradingDayKey } from './liquidityLevels';

export interface OrderFlowProfile {
  /** Kolik ticků tvoří jeden řádek. */
  rowTicks: number;
  /** Index nejnižšího řádku (cena v ticích / rowTicks, dolů). */
  rowMin: number;
  buy: Float64Array;
  sell: Float64Array;
  /** Objem bez strany agresora (počítá se do objemu, ne do delty). */
  other: Float64Array;
  total: number;
  delta: number;
  maxVolume: number;
  maxAbsDelta: number;
  /** Řádky od `rowMin`: nejobchodovanější (POC) a okraje value area. */
  poc: number;
  val: number;
  vah: number;
}

export interface ProfileSegment {
  key: string;
  label: string;
  /** Úsek [from, to) v sekundách: první a poslední minuta s daty. */
  from: number;
  to: number;
  /** Kdy úsek podle hodin začíná (celá hodina) — i když první data přišla později. */
  nominalFrom: number;
}

export interface ProfileSessionWindow { name: string; start: number; end: number }

/** Value area: od POC se přidává vždy ten sousední řádek, který má větší objem, dokud není pokryt daný podíl. */
export function valueAreaBounds(volumes: ArrayLike<number>, poc: number, total: number, percent: number): [number, number] {
  let lo = poc; let hi = poc;
  let sum = volumes[poc] ?? 0;
  const target = total * Math.min(1, Math.max(0, percent / 100));
  while (sum < target && (lo > 0 || hi < volumes.length - 1)) {
    const up = hi < volumes.length - 1 ? volumes[hi + 1] : -1;
    const down = lo > 0 ? volumes[lo - 1] : -1;
    if (up >= down) { hi += 1; sum += up; } else { lo -= 1; sum += down; }
  }
  return [lo, hi];
}

/** Sečte buňky minut ([cena v ticích, nákup, prodej, bez strany, …]) do řádků po `rowTicks` ticích. */
export function buildOrderFlowProfile(minuteCells: Iterable<ArrayLike<number> | undefined>, rowTicks: number, valueAreaPercent = 70): OrderFlowProfile | null {
  const step = Math.max(1, Math.floor(rowTicks));
  let min = Infinity; let max = -Infinity;
  const kept: ArrayLike<number>[] = [];
  for (const cells of minuteCells) {
    if (!cells || cells.length < 4) continue;
    kept.push(cells);
    const first = Math.floor(cells[0] / step);
    const last = Math.floor(cells[cells.length - 4] / step);
    if (first < min) min = first;
    if (last > max) max = last;
  }
  if (!Number.isFinite(min)) return null;
  const rows = max - min + 1;
  const buy = new Float64Array(rows); const sell = new Float64Array(rows); const other = new Float64Array(rows);
  let total = 0; let delta = 0;
  for (const cells of kept) {
    for (let i = 0; i < cells.length; i += 4) {
      const row = Math.floor(cells[i] / step) - min;
      buy[row] += cells[i + 1]; sell[row] += cells[i + 2]; other[row] += cells[i + 3];
      total += cells[i + 1] + cells[i + 2] + cells[i + 3];
      delta += cells[i + 1] - cells[i + 2];
    }
  }
  if (total <= 0) return null;
  const volumes = new Float64Array(rows);
  let poc = 0; let maxVolume = 0; let maxAbsDelta = 0;
  for (let row = 0; row < rows; row += 1) {
    const volume = buy[row] + sell[row] + other[row];
    volumes[row] = volume;
    if (volume > maxVolume) { maxVolume = volume; poc = row; }
    const rowDelta = Math.abs(buy[row] - sell[row]);
    if (rowDelta > maxAbsDelta) maxAbsDelta = rowDelta;
  }
  const [val, vah] = valueAreaBounds(volumes, poc, total, valueAreaPercent);
  return { rowTicks: step, rowMin: min, buy, sell, other, total, delta, maxVolume, maxAbsDelta, poc, val, vah };
}

const zoneHourFormatters = new Map<string, Intl.DateTimeFormat>();
const zoneHourCache = new Map<string, number>();
/** Hodina (0–23) v daném časovém pásmu; počítá se jednou na hodinu epochy. */
export function zoneHour(timeSec: number, timeZone: string): number {
  const bucket = Math.floor(timeSec / 3_600);
  const key = `${timeZone}:${bucket}`;
  const cached = zoneHourCache.get(key);
  if (cached !== undefined) return cached;
  let formatter = zoneHourFormatters.get(timeZone);
  if (!formatter) {
    try { formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }); }
    catch { formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Prague', hour: 'numeric', hourCycle: 'h23' }); }
    zoneHourFormatters.set(timeZone, formatter);
  }
  const hour = Number(formatter.format(new Date(bucket * 3_600_000))) % 24;
  if (zoneHourCache.size > 4_000) zoneHourCache.clear();
  zoneHourCache.set(key, hour);
  return hour;
}

const dayKeyCache = new Map<number, string>();
const dayKeyOf = (minute: number): string => {
  // Obchodní den se láme v celou hodinu (18:00 NY) — stačí jednou na hodinu.
  const bucket = Math.floor(minute / 3_600);
  let key = dayKeyCache.get(bucket);
  if (key === undefined) {
    key = tradingDayKey(bucket * 3_600);
    if (dayKeyCache.size > 4_000) dayKeyCache.clear();
    dayKeyCache.set(bucket, key);
  }
  return key;
};

const inWindow = (hour: number, start: number, end: number): boolean => (start < end ? hour >= start && hour < end : hour >= start || hour < end);

/**
 * Rozdělí minuty s daty (vzestupně) na úseky profilu: po obchodních dnech, nebo po seancích
 * (hodiny v daném pásmu, jako u levelů). Minuty mimo všechny seance do žádného úseku nepatří.
 */
export function orderFlowProfileSegments(minutes: readonly number[], period: 'day' | 'session', sessions: readonly ProfileSessionWindow[], timeZone: string): ProfileSegment[] {
  const classify = (time: number): { key: string; label: string } | null => {
    const day = dayKeyOf(time);
    if (period === 'day') return { key: day, label: `${Number(day.slice(8, 10))}. ${Number(day.slice(5, 7))}.` };
    const hour = zoneHour(time, timeZone);
    const session = sessions.find((item) => inWindow(hour, item.start, item.end));
    return session ? { key: `${day}|${session.name}`, label: session.name } : null;
  };
  const out: ProfileSegment[] = [];
  let current: ProfileSegment | null = null;
  for (const minute of minutes) {
    const kind = classify(minute);
    if (!kind) { current = null; continue; }
    if (current && current.key === kind.key) { current.to = minute + 60; continue; }
    // Začátek podle hodin: jít po hodinách zpět, dokud patří do téhož úseku (nejvýš dva dny).
    let nominalFrom = Math.floor(minute / 3_600) * 3_600;
    for (let step = 0; step < 48 && classify(nominalFrom - 3_600)?.key === kind.key; step += 1) nominalFrom -= 3_600;
    current = { key: kind.key, label: kind.label, from: minute, to: minute + 60, nominalFrom };
    out.push(current);
  }
  return out;
}

/** Velikost řádku v ticích tak, aby řádek měl na obrazovce aspoň `minPixels` (pro volbu „auto“). */
export function autoRowTicks(pixelsPerTick: number, minPixels = 3): number {
  if (!(pixelsPerTick > 0)) return 4;
  for (const ticks of [1, 2, 4, 8, 20, 40, 80, 200, 400]) if (ticks * pixelsPerTick >= minPixels) return ticks;
  return 400;
}
