/**
 * Archiv order flow po obchodních dnech (návrh docs/reviews/orderflow-history-archive-design-20261127.md, část B).
 *
 * Dva zdroje dne:
 *  - syrová historie z Rithmicu (`orderFlowBackfill.ts`, soubor OFR1): úplný objem po minutách a cenách,
 *    bubliny jen PŘIBLIŽNĚ (bez čísla agresivního příkazu — slučují se dílčí obchody téže strany v těsném sledu);
 *  - soubory živé služby (`orderFlowFeed.ts`, jsonl): bubliny PŘESNĚ podle čísla příkazu, ale jen kde služba běžela.
 * `buildOrderFlowDay` je sloučí: objem z úplnějšího zdroje, bubliny přesné tam, kde služba běžela, jinde přibližné.
 *
 * Čistá logika bez Node API (gzip řeší volající), aby šla použít ve skriptech i v appce.
 * JEN ZOBRAZENÍ (INV-UI-04): nic odsud nesmí do cen pro příkazy.
 */

/** Buňky minuty naplocho, vzestupně podle ceny: [cena v ticích, nákup, prodej, bez strany, …] — jako živá služba. */
export type OrderFlowCells = number[];

/** Velký obchod: [id, začátek ms, konec ms, strana 1/−1, velikost, dílčích, nejnižší, nejvyšší, průměr v ticích]. */
export type OrderFlowArchiveTrade = [string, number, number, 1 | -1, number, number, number, number, number];

export interface OrderFlowArchiveDay {
  v: 1;
  root: 'NQ';
  contract: string;
  /** Obchodní den jako `tradingDayKey` (18:00 New York → 17:00 New York). */
  tradeDate: string;
  tickSize: number;
  /** Seance v sekundách [od, do). */
  session: [number, number];
  source: 'live' | 'backfill' | 'merged';
  /** Nejmenší uložená bublina (zobrazovací práh se nastavuje v appce). */
  tradeFloor: number;
  /** Minuty vzestupně: [čas minuty v s, buňky]. */
  minutes: Array<[number, OrderFlowCells]>;
  /** Úseky v ms, kde je objem úplný (data tekla celou dobu). */
  coverage: Array<[number, number]>;
  /** Úseky v ms, kde jsou bubliny přesné (živá služba); jinde přibližné. */
  exactBubbles: Array<[number, number]>;
  trades: OrderFlowArchiveTrade[];
  check: { flowVolume: number; candleVolume: number | null; ratio: number | null };
}

// ── Syrová data (OFR1) ────────────────────────────────────────────────────────

export interface OrderFlowRawHeader {
  v: number;
  contract: string;
  tradeDate: string;
  tickSize: number;
  session: { start: number; end: number };
  complete: boolean;
  count: number;
  startSec: number;
  check?: { candleVolume?: number; flowVolume?: number; ratio?: number | null };
}

export interface OrderFlowRaw {
  header: OrderFlowRawHeader;
  dsec: Int32Array;
  usecs: Int32Array;
  priceTicks: Int32Array;
  size: Int32Array;
  /** 1 = agresivní kupující, −1 = prodávající, 0 = neurčeno. */
  side: Int32Array;
}

const MAGIC = [0x4f, 0x46, 0x52, 0x31]; // "OFR1"

/** Rozbalený obsah souboru OFR1 → sloupce. Hlavička v1 měla stranu obráceně (sonda 27. 11.) — opraví se. */
export function decodeOrderFlowRaw(bytes: Uint8Array): OrderFlowRaw {
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('není soubor OFR1');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len))) as OrderFlowRawHeader;
  const n = header.count;
  let off = 8 + len;
  if (bytes.length < off + n * 4 * 5) throw new Error('soubor OFR1 je zkrácený');
  const col = (): Int32Array => {
    const out = new Int32Array(n);
    for (let i = 0; i < n; i += 1) out[i] = view.getInt32(off + i * 4, true);
    off += n * 4;
    return out;
  };
  const raw: OrderFlowRaw = { header, dsec: col(), usecs: col(), priceTicks: col(), size: col(), side: col() };
  if (!(header.v >= 2)) for (let i = 0; i < n; i += 1) raw.side[i] = -raw.side[i];
  return raw;
}

/** Sloupce → obsah souboru OFR1 (před zabalením). */
export function encodeOrderFlowRaw(header: Omit<OrderFlowRawHeader, 'count' | 'startSec'> & Record<string, unknown>, rows: {
  sec: ArrayLike<number>; usecs: ArrayLike<number>; priceTicks: ArrayLike<number>; size: ArrayLike<number>; side: ArrayLike<number>;
}, startSec: number): Uint8Array {
  const n = rows.sec.length;
  const head = new TextEncoder().encode(JSON.stringify({ ...header, count: n, startSec, columns: ['dsec', 'usecs', 'priceTicks', 'size', 'side'] }));
  const out = new Uint8Array(8 + head.length + n * 4 * 5);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, head.length, true);
  out.set(head, 8);
  let off = 8 + head.length;
  const put = (get: (i: number) => number) => { for (let i = 0; i < n; i += 1) view.setInt32(off + i * 4, get(i), true); off += n * 4; };
  put((i) => rows.sec[i] - startSec);
  put((i) => rows.usecs[i]);
  put((i) => rows.priceTicks[i]);
  put((i) => rows.size[i]);
  put((i) => rows.side[i]);
  return out;
}

// ── Ze syrových dat ───────────────────────────────────────────────────────────

export interface ApproxGroupingOptions {
  /** Do jaké mezery (µs) se dílčí obchody téže strany slučují vždy. Změřeno 28. 11.: 10 µs. */
  gapUs?: number;
  /** Do jaké mezery (µs) se slučují, když cena pokračuje směrem příkazu (průjezd více cen). Změřeno: 100 µs. */
  sweepUs?: number;
  /** Nejmenší uložená bublina. */
  floor?: number;
}

export interface OrderFlowFromRaw {
  minutes: Map<number, OrderFlowCells>;
  trades: OrderFlowArchiveTrade[];
  volume: number;
}

/** Minuty a přibližné bubliny ze syrové historie (jen obchody uvnitř seance). */
export function orderFlowFromRaw(raw: OrderFlowRaw, options: ApproxGroupingOptions = {}): OrderFlowFromRaw {
  const gapUs = options.gapUs ?? 10;
  const sweepUs = options.sweepUs ?? 100;
  const floor = options.floor ?? 5;
  const { start, end } = raw.header.session;
  const cellsByMinute = new Map<number, Map<number, [number, number, number]>>();
  const trades: OrderFlowArchiveTrade[] = [];
  let volume = 0;
  let open: { startUs: number; lastUs: number; side: 1 | -1; size: number; fills: number; lo: number; hi: number; priceSize: number } | null = null;
  let synthetic = 0;
  const close = () => {
    if (open && open.size >= floor) {
      synthetic += 1;
      trades.push([`h${Math.floor(open.startUs / 1_000)}-${synthetic}`, Math.floor(open.startUs / 1_000), Math.floor(open.lastUs / 1_000), open.side, open.size, open.fills, open.lo, open.hi, Math.round(open.priceSize / open.size)]);
    }
    open = null;
  };
  for (let i = 0; i < raw.header.count; i += 1) {
    const sec = raw.header.startSec + raw.dsec[i];
    if (sec < start || sec >= end) continue;
    const size = raw.size[i];
    const price = raw.priceTicks[i];
    if (!(size > 0) || !(price > 0)) continue;
    volume += size;
    const minute = Math.floor(sec / 60) * 60;
    let cells = cellsByMinute.get(minute);
    if (!cells) { cells = new Map(); cellsByMinute.set(minute, cells); }
    let cell = cells.get(price);
    if (!cell) { cell = [0, 0, 0]; cells.set(price, cell); }
    const side = raw.side[i];
    cell[side === 1 ? 0 : side === -1 ? 1 : 2] += size;
    if (side !== 1 && side !== -1) { close(); continue; }
    const us = sec * 1_000_000 + raw.usecs[i];
    const current = open as typeof open;
    const continues = current !== null && current.side === side && (us - current.lastUs <= gapUs
      || (us - current.lastUs <= sweepUs && (side === 1 ? price > current.hi : price < current.lo)));
    if (current && continues) {
      current.size += size; current.fills += 1; current.priceSize += price * size; current.lastUs = us;
      if (price < current.lo) current.lo = price;
      if (price > current.hi) current.hi = price;
      continue;
    }
    close();
    open = { startUs: us, lastUs: us, side, size, fills: 1, lo: price, hi: price, priceSize: price * size };
  }
  close();
  const minutes = new Map<number, OrderFlowCells>();
  for (const minute of [...cellsByMinute.keys()].sort((a, b) => a - b)) minutes.set(minute, flatten(cellsByMinute.get(minute)!));
  return { minutes, trades, volume };
}

const flatten = (cells: Map<number, [number, number, number]>): OrderFlowCells => {
  const out: number[] = [];
  for (const price of [...cells.keys()].sort((a, b) => a - b)) { const c = cells.get(price)!; out.push(price, c[0], c[1], c[2]); }
  return out;
};

// ── Ze souborů živé služby ────────────────────────────────────────────────────

export interface OrderFlowFromService {
  /** Poslední záznam každé minuty (restart služby minutu zapíše znovu se sečteným objemem). */
  minutes: Map<number, OrderFlowCells>;
  /** Minuty, ve kterých ceny tekly celou dobu. */
  covered: Set<number>;
  /** Přesné bubliny: [id, čas ms, strana, velikost, dílčích, lo, hi, průměr]. */
  trades: Array<[string, number, 1 | -1, number, number, number, number, number]>;
}

/** Obsah jednoho nebo více denních souborů služby (`{m,v,c}` a `{t}` po řádcích). Vadné řádky se přeskočí. */
export function parseServiceOrderFlow(texts: readonly string[]): OrderFlowFromService {
  const minutes = new Map<number, OrderFlowCells>();
  const covered = new Set<number>();
  const trades = new Map<string, OrderFlowFromService['trades'][number]>();
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line) continue;
      let row: { m?: unknown; v?: unknown; c?: unknown; t?: unknown };
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row.m === 'number' && Array.isArray(row.c) && row.c.length % 4 === 0 && row.c.every((x) => typeof x === 'number')) {
        minutes.set(row.m, row.c as number[]);
        if (row.v === 1) covered.add(row.m); else covered.delete(row.m);
      } else if (Array.isArray(row.t) && row.t.length === 8 && typeof row.t[0] === 'string' && typeof row.t[1] === 'number' && (row.t[2] === 1 || row.t[2] === -1)) {
        const t = row.t as OrderFlowFromService['trades'][number];
        trades.set(`${t[0]}@${t[1]}`, t);
      }
    }
  }
  return { minutes, covered, trades: [...trades.values()].sort((a, b) => a[1] - b[1]) };
}

// ── Sloučení do dne ───────────────────────────────────────────────────────────

/** Souvislé úseky z množiny minut (s) → [od ms, do ms). */
export function minuteSpans(minutes: Iterable<number>): Array<[number, number]> {
  const sorted = [...minutes].sort((a, b) => a - b);
  const spans: Array<[number, number]> = [];
  for (const m of sorted) {
    const last = spans[spans.length - 1];
    if (last && last[1] === m * 1_000) last[1] = (m + 60) * 1_000;
    else spans.push([m * 1_000, (m + 60) * 1_000]);
  }
  return spans;
}

const inSpans = (ms: number, spans: ReadonlyArray<[number, number]>): boolean => spans.some(([a, b]) => ms >= a && ms < b);
const cellsVolume = (cells: OrderFlowCells): number => { let s = 0; for (let i = 0; i < cells.length; i += 4) s += cells[i + 1] + cells[i + 2] + cells[i + 3]; return s; };

export function buildOrderFlowDay(input: {
  contract: string;
  tradeDate: string;
  tickSize: number;
  session: [number, number];
  raw?: OrderFlowRaw | null;
  service?: OrderFlowFromService | null;
  grouping?: ApproxGroupingOptions;
}): OrderFlowArchiveDay {
  const [start, end] = input.session;
  const floor = input.grouping?.floor ?? 5;
  const inSession = (minute: number) => minute >= start && minute < end;
  const fromRaw = input.raw ? orderFlowFromRaw(input.raw, input.grouping) : null;
  const rawComplete = !!input.raw?.header.complete;
  const service = input.service ?? null;
  // Minuta služby platí za úplnou, jen když to o sobě tvrdí A (je-li historie) objem sedí s historií.
  // Změřeno 28. 11.: uspaný Mac na baterii nechal službu označit minuty spánku jako pokryté s nulou obchodů.
  const liveCovered = service ? [...service.covered].filter((m) => {
    if (!inSession(m)) return false;
    if (!fromRaw) return true;
    const liveVolume = cellsVolume(service.minutes.get(m) ?? []);
    const rawVolume = cellsVolume(fromRaw.minutes.get(m) ?? []);
    return Math.abs(liveVolume - rawVolume) <= Math.max(3, rawVolume * 0.01);
  }) : [];
  const exactBubbles = minuteSpans(liveCovered);

  // Objem: úplná historie má přednost; jinak živé minuty.
  const minutes = new Map<number, OrderFlowCells>();
  if (fromRaw && rawComplete) for (const [m, c] of fromRaw.minutes) minutes.set(m, c);
  else {
    if (fromRaw) for (const [m, c] of fromRaw.minutes) minutes.set(m, c);
    if (service) for (const [m, c] of service.minutes) if (inSession(m) && service.covered.has(m)) minutes.set(m, c);
  }
  const coverage: Array<[number, number]> = rawComplete ? [[start * 1_000, end * 1_000]] : exactBubbles.map(([a, b]) => [a, b]);

  // Bubliny: přesné ze služby uvnitř jejích úseků, jinde přibližné z historie.
  const trades: OrderFlowArchiveTrade[] = [];
  if (service) {
    for (const t of service.trades) {
      if (t[3] < floor || !inSpans(t[1], exactBubbles)) continue;
      trades.push([t[0], t[1], t[1], t[2], t[3], t[4], t[5], t[6], t[7]]);
    }
  }
  if (fromRaw) for (const t of fromRaw.trades) if (!inSpans(t[1], exactBubbles)) trades.push(t);
  trades.sort((a, b) => a[1] - b[1]);

  let flowVolume = 0;
  for (const cells of minutes.values()) flowVolume += cellsVolume(cells);
  const candleVolume = typeof input.raw?.header.check?.candleVolume === 'number' ? input.raw.header.check.candleVolume : null;
  return {
    v: 1, root: 'NQ', contract: input.contract, tradeDate: input.tradeDate, tickSize: input.tickSize, session: [start, end],
    source: fromRaw && service && exactBubbles.length > 0 ? 'merged' : fromRaw ? 'backfill' : 'live',
    tradeFloor: floor,
    minutes: [...minutes.entries()].sort((a, b) => a[0] - b[0]),
    coverage, exactBubbles, trades,
    check: { flowVolume, candleVolume, ratio: candleVolume ? Math.round((flowVolume / candleVolume) * 10_000) / 100 : null },
  };
}

// ── Kalendář: obchodní den a kontrakt ─────────────────────────────────────────

const NY_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const nyOffsetMin = (ms: number): number => {
  const p = Object.fromEntries(NY_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / 60_000) * 60_000) / 60_000;
};
/** UTC sekundy pro místní čas New York. */
const nyToSec = (y: number, m: number, d: number, h: number): number => {
  const guess = Date.UTC(y, m - 1, d, h);
  let ms = guess - nyOffsetMin(guess) * 60_000;
  ms = guess - nyOffsetMin(ms) * 60_000;
  return Math.floor(ms / 1_000);
};

/** Seance obchodního dne D (jako `tradingDayKey` appky): 18:00 New York dne D−1 → 17:00 New York dne D, v s. */
export function tradingSession(tradeDate: string): [number, number] {
  const [y, m, d] = tradeDate.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return [nyToSec(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), 18), nyToSec(y, m, d, 17)];
}

/** Obchodní dny (po–pá) v rozsahu [from, to] včetně. */
export function tradeDatesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const QUARTER_CODES: Record<number, string> = { 3: 'H', 6: 'M', 9: 'U', 12: 'Z' };
const thirdFridayMs = (year: number, month: number): number => {
  const first = new Date(Date.UTC(year, month - 1, 1));
  return Date.UTC(year, month - 1, 1 + ((5 - first.getUTCDay() + 7) % 7) + 14);
};
/** Hlavní kontrakt NQ pro obchodní den: přechod 8 dní před expirací (3. pátek čtvrtletního měsíce). */
export function nqFrontContract(tradeDate: string): string {
  const t = Date.parse(`${tradeDate}T12:00:00Z`);
  const d = new Date(t);
  for (let k = 0; k < 8; k += 1) {
    const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + k;
    const year = Math.floor(total / 12); const month = (total % 12) + 1;
    if (!QUARTER_CODES[month]) continue;
    if (t < thirdFridayMs(year, month) - 8 * 86_400_000) return `NQ${QUARTER_CODES[month]}${year % 10}`;
  }
  throw new Error(`kontrakt pro ${tradeDate} nenalezen`);
}
