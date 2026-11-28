/**
 * Archiv order flow v appce: načítání dnů ze Supabase (bucket `orderflow-archive`, tabulka
 * `orderflow_archive_days`) a pohled na ně se stejným čtecím rozhraním, jaké mají kreslicí vrstvy
 * u živého order flow (`OrderFlowReadable`).
 *
 *  - `orderFlowArchive` — společná mezipaměť dnů pro celou appku (den se stáhne jednou za relaci);
 *  - `OrderFlowArchiveView` — co z ní vidí jeden graf: vybrané dny a u přehrávání/backtestu jen to,
 *    co je před kurzorem (minuta až celá, bublina až po svém konci);
 *  - `OrderFlowCombined` — LIVE graf: starší dny z archivu, od začátku snímku služby živá data.
 *
 * JEN ZOBRAZENÍ (INV-UI-04): nic odsud nesmí do cen pro příkazy.
 */
import type { OrderFlowArchiveDay } from '../services/orderFlowArchive';
import { supabase } from '../services/supabase';
import type { OrderFlowReadable, OrderFlowStore, OrderFlowTrade } from './orderFlowStore';

const BUCKET = 'orderflow-archive';
const RETRY_MS = 60_000;
const MAX_PARALLEL = 3;

export interface ArchiveTrade extends OrderFlowTrade { end: number }

export interface LoadedArchiveDay {
  date: string;
  contract: string;
  source: OrderFlowArchiveDay['source'];
  tickSize: number;
  floor: number;
  /** Seance v s [od, do). */
  session: [number, number];
  minutes: number[];
  cells: Map<number, Int32Array>;
  trades: ArchiveTrade[];
  /** Úplný objem: úseky v s. */
  coverage: Array<[number, number]>;
  /** Přesné bubliny: úseky v ms. */
  exact: Array<[number, number]>;
}

/** Převod souboru dne na tvar pro kreslení. Vadný soubor = null (nic se nekreslí, nic nespadne). */
export function loadedArchiveDay(raw: unknown): LoadedArchiveDay | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<OrderFlowArchiveDay>;
  if (d.v !== 1 || typeof d.tradeDate !== 'string' || typeof d.contract !== 'string' || !Array.isArray(d.minutes) || !Array.isArray(d.trades) || !Array.isArray(d.session)) return null;
  const cells = new Map<number, Int32Array>();
  for (const entry of d.minutes) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'number' || !Array.isArray(entry[1]) || entry[1].length % 4 !== 0) continue;
    cells.set(entry[0], Int32Array.from(entry[1] as number[]));
  }
  const trades: ArchiveTrade[] = [];
  for (const t of d.trades) {
    if (!Array.isArray(t) || t.length !== 9 || typeof t[0] !== 'string' || !t.slice(1).every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
    trades.push({ id: t[0], at: t[1], end: Math.max(t[1], t[2]), side: t[3] >= 0 ? 1 : -1, size: t[4], fills: t[5], lo: t[6], hi: t[7], price: t[8] });
  }
  trades.sort((a, b) => a.at - b.at);
  const spans = (value: unknown, scale: number): Array<[number, number]> => (Array.isArray(value) ? value : [])
    .filter((s): s is [number, number] => Array.isArray(s) && typeof s[0] === 'number' && typeof s[1] === 'number' && s[1] > s[0])
    .map(([a, b]) => [a / scale, b / scale]);
  return {
    date: d.tradeDate, contract: d.contract, source: d.source ?? 'backfill', tickSize: typeof d.tickSize === 'number' && d.tickSize > 0 ? d.tickSize : 0.25,
    floor: typeof d.tradeFloor === 'number' && d.tradeFloor > 0 ? d.tradeFloor : 1, session: [Number(d.session[0]), Number(d.session[1])],
    minutes: [...cells.keys()].sort((a, b) => a - b), cells, trades,
    coverage: spans(d.coverage, 1_000), exact: spans(d.exactBubbles, 1),
  };
}

async function gunzipJson(blob: Blob): Promise<unknown> {
  const text = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}

type DayState = { kind: 'loaded'; day: LoadedArchiveDay } | { kind: 'missing' } | { kind: 'loading' } | { kind: 'error'; at: number };

/** Společná mezipaměť dnů archivu. */
class OrderFlowArchiveCache {
  private readonly states = new Map<string, DayState>();
  private readonly listeners = new Set<() => void>();
  private queue: string[] = [];
  private running = 0;

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  day(date: string): LoadedArchiveDay | undefined { const s = this.states.get(date); return s?.kind === 'loaded' ? s.day : undefined; }
  isMissing(date: string): boolean { return this.states.get(date)?.kind === 'missing'; }

  /** Zajistí načtení dnů (co už je, nebo právě jde, se nestahuje znovu; chyba se zkusí po minutě). */
  ensure(dates: readonly string[]): void {
    const now = Date.now();
    const wanted = dates.filter((date) => {
      const s = this.states.get(date);
      return !s || (s.kind === 'error' && now - s.at > RETRY_MS);
    });
    if (wanted.length === 0) return;
    for (const date of wanted) this.states.set(date, { kind: 'loading' });
    void this.lookup(wanted);
  }

  private async lookup(dates: string[]): Promise<void> {
    let rows: Array<{ trade_date: string; object_path: string; flow_volume: number }> = [];
    try {
      const { data, error } = await supabase.from('orderflow_archive_days').select('trade_date, object_path, flow_volume').in('trade_date', dates);
      if (error) throw error;
      rows = (data ?? []) as typeof rows;
    } catch {
      for (const date of dates) this.states.set(date, { kind: 'error', at: Date.now() });
      return;
    }
    // Víc kontraktů v jeden den (týden přechodu): ten s větším objemem je hlavní.
    const best = new Map<string, { object_path: string; flow_volume: number }>();
    for (const row of rows) { const prev = best.get(row.trade_date); if (!prev || row.flow_volume > prev.flow_volume) best.set(row.trade_date, row); }
    for (const date of dates) {
      const row = best.get(date);
      if (!row) this.states.set(date, { kind: 'missing' });
      else { this.paths.set(date, row.object_path); this.queue.push(date); }
    }
    this.emit();
    this.pump();
  }

  private readonly paths = new Map<string, string>();

  private pump(): void {
    while (this.running < MAX_PARALLEL && this.queue.length > 0) {
      const date = this.queue.shift()!;
      const path = this.paths.get(date);
      if (!path) continue;
      this.running += 1;
      void (async () => {
        try {
          const { data, error } = await supabase.storage.from(BUCKET).download(path);
          if (error || !data) throw error ?? new Error('no-data');
          const day = loadedArchiveDay(await gunzipJson(data));
          this.states.set(date, day ? { kind: 'loaded', day } : { kind: 'missing' });
        } catch {
          this.states.set(date, { kind: 'error', at: Date.now() });
        } finally {
          this.running -= 1;
          this.emit();
          this.pump();
        }
      })();
    }
  }

  private emit(): void { for (const l of [...this.listeners]) { try { l(); } catch { /* posluchač nesmí shodit načítání */ } } }
}

export const orderFlowArchive = new OrderFlowArchiveCache();

const lowerBound = (arr: ArrayLike<number>, x: number): number => { let lo = 0; let hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; } return lo; };

/** Co z archivu vidí jeden graf. */
export class OrderFlowArchiveView implements OrderFlowReadable {
  symbol: string | null = null;
  tickSize = 0.25;
  floor = 1;
  complete = true;
  rev = 1;
  private dates: string[] = [];
  /** Hranice přehrávání v ms (vidět je jen to, co skončilo před ní), nebo null. */
  private cutoffMs: number | null = null;
  private allMinutes: number[] = [];
  private cellsByMinute = new Map<number, Int32Array>();
  private allTrades: ArchiveTrade[] = [];
  private tradeStarts: number[] = [];
  private coverageSpans: Array<[number, number]> = [];
  private included: LoadedArchiveDay[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly cache: OrderFlowArchiveCache = orderFlowArchive) {}

  /**
   * Napojení na mezipaměť dnů (načtený den se hned ukáže). Vrací odpojení; jde volat opakovaně
   * (React efekt ve StrictMode se spustí, uklidí a spustí znovu).
   */
  attach(): () => void {
    const unsubscribe = this.cache.subscribe(() => {
      if (this.dates.some((d) => (this.cache.day(d) !== undefined) !== this.included.some((x) => x.date === d))) this.rebuild();
    });
    // Mezitím mohl den dorazit.
    if (this.dates.some((d) => (this.cache.day(d) !== undefined) !== this.included.some((x) => x.date === d))) this.rebuild();
    return unsubscribe;
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  /** Které obchodní dny graf ukazuje (stahují se jen ty). */
  setDates(dates: readonly string[]): void {
    const next = [...new Set(dates)].sort();
    if (next.join() === this.dates.join()) return;
    this.dates = next;
    this.cache.ensure(next);
    this.rebuild();
  }

  /** Kurzor přehrávání v ms: vidět jen minuty a bubliny, které před ním skončily. null = vše. */
  setCutoff(ms: number | null): void {
    if (ms === this.cutoffMs) return;
    this.cutoffMs = ms;
    this.bump();
  }

  /** Jsou v [fromMs, toMs] bubliny jen přibližné (den z historie, ne ze služby)? */
  approximateIn(fromMs: number, toMs: number): boolean {
    return this.included.some((day) => {
      const [a, b] = [day.session[0] * 1_000, day.session[1] * 1_000];
      if (b <= fromMs || a >= toMs) return false;
      const lo = Math.max(a, fromMs); const hi = Math.min(b, toMs);
      return !day.exact.some(([x, y]) => x <= lo && y >= hi);
    });
  }

  /** Dny ve výběru, pro které archiv nemá data. */
  missingDates(): string[] { return this.dates.filter((d) => this.cache.isMissing(d)); }
  /** Načtené dny ve výběru. */
  loadedDates(): string[] { return this.included.map((d) => d.date); }

  minutes(fromMinute = -Infinity, toMinute = Infinity): number[] {
    let to = toMinute;
    if (this.cutoffMs !== null) to = Math.min(to, Math.floor(this.cutoffMs / 1_000) - 60 + 1);
    const all = this.allMinutes;
    return all.slice(lowerBound(all, fromMinute), lowerBound(all, to));
  }

  minuteCells(minute: number): Int32Array | undefined {
    if (this.cutoffMs !== null && (minute + 60) * 1_000 > this.cutoffMs) return undefined;
    return this.cellsByMinute.get(minute);
  }

  trades(fromMs = -Infinity, toMs = Infinity): OrderFlowTrade[] {
    const all = this.allTrades;
    const out: OrderFlowTrade[] = [];
    for (let i = lowerBound(this.tradeStarts, fromMs); i < all.length && all[i].at <= toMs; i += 1) {
      if (this.cutoffMs !== null && all[i].end >= this.cutoffMs) continue;
      out.push(all[i]);
    }
    return out;
  }

  changedSince(sinceRev: number): boolean { return sinceRev < this.rev; }

  covered(fromSec: number, toSec: number): boolean {
    let end = toSec;
    if (this.cutoffMs !== null) end = Math.min(end, Math.floor(this.cutoffMs / 1_000));
    let cursor = fromSec;
    for (const [a, b] of this.coverageSpans) {
      if (b <= cursor) continue;
      if (a > cursor) break;
      cursor = b;
      if (cursor >= end) break;
    }
    return cursor >= end && end >= toSec;
  }

  private rebuild(): void {
    this.included = this.dates.map((d) => this.cache.day(d)).filter((d): d is LoadedArchiveDay => !!d);
    const last = this.included[this.included.length - 1];
    this.symbol = last ? last.contract : null;
    this.tickSize = last ? last.tickSize : 0.25;
    this.floor = this.included.reduce((m, d) => Math.max(m, d.floor), 1);
    this.cellsByMinute = new Map();
    for (const day of this.included) for (const [m, c] of day.cells) this.cellsByMinute.set(m, c);
    this.allMinutes = [...this.cellsByMinute.keys()].sort((a, b) => a - b);
    this.allTrades = this.included.flatMap((d) => d.trades).sort((a, b) => a.at - b.at);
    this.tradeStarts = this.allTrades.map((t) => t.at);
    const spans = this.included.flatMap((d) => d.coverage).sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [a, b] of spans) { const prev = merged[merged.length - 1]; if (prev && a <= prev[1]) prev[1] = Math.max(prev[1], b); else merged.push([a, b]); }
    this.coverageSpans = merged;
    this.bump();
  }

  private bump(): void {
    this.rev += 1;
    for (const l of [...this.listeners]) { try { l(); } catch { /* posluchač nesmí shodit graf */ } }
  }
}

/** Kódování revize spojení: živá část × 2^20 + archiv (archiv se mění zřídka). */
const ARCHIVE_REV_SPAN = 1_048_576;

/**
 * LIVE graf: minuty a bubliny před začátkem snímku služby z archivu, od něj ze služby. Bez snímku služby
 * (služba neběží) jen archiv. Revize se kóduje po částech, aby živý tik nepřepočítával profily starších dnů.
 */
export class OrderFlowCombined implements OrderFlowReadable {
  constructor(private readonly live: OrderFlowStore, private readonly archive: OrderFlowArchiveView) {}

  /** Od které minuty (s) platí živá data. */
  private boundary(): number { return this.live.complete && this.live.symbol ? this.live.from : Infinity; }
  get symbol(): string | null { return this.live.symbol ?? this.archive.symbol; }
  get tickSize(): number { return this.live.symbol ? this.live.tickSize : this.archive.tickSize; }
  get floor(): number { return Math.max(this.live.symbol ? this.live.floor : 1, this.archive.symbol ? this.archive.floor : 1); }
  get complete(): boolean { return this.live.complete || this.archive.symbol !== null; }
  get rev(): number { return this.live.rev * ARCHIVE_REV_SPAN + (this.archive.rev % ARCHIVE_REV_SPAN); }

  subscribe(listener: () => void): () => void {
    const a = this.live.subscribe(listener); const b = this.archive.subscribe(listener);
    return () => { a(); b(); };
  }

  minutes(fromMinute = -Infinity, toMinute = Infinity): number[] {
    const boundary = this.boundary();
    const older = fromMinute < boundary ? this.archive.minutes(fromMinute, Math.min(toMinute, boundary)) : [];
    const newer = toMinute > boundary ? this.live.minutes(Math.max(fromMinute, boundary), toMinute) : [];
    return older.length === 0 ? newer : newer.length === 0 ? older : older.concat(newer);
  }

  minuteCells(minute: number): Int32Array | undefined {
    return minute >= this.boundary() ? this.live.minuteCells(minute) : this.archive.minuteCells(minute);
  }

  trades(fromMs = -Infinity, toMs = Infinity): OrderFlowTrade[] {
    const boundaryMs = this.boundary() * 1_000;
    const older = fromMs < boundaryMs ? this.archive.trades(fromMs, Math.min(toMs, boundaryMs - 1)) : [];
    const newer = toMs >= boundaryMs ? this.live.trades(Math.max(fromMs, boundaryMs), toMs) : [];
    return older.length === 0 ? newer : newer.length === 0 ? older : older.concat(newer);
  }

  changedSince(sinceRev: number, fromMinute: number, toMinute: number): boolean {
    const liveRev = Math.floor(sinceRev / ARCHIVE_REV_SPAN);
    const archiveRev = sinceRev % ARCHIVE_REV_SPAN;
    const boundary = this.boundary();
    return (toMinute > boundary && this.live.changedSince(liveRev, Math.max(fromMinute, boundary), toMinute))
      || (fromMinute < boundary && archiveRev !== this.archive.rev % ARCHIVE_REV_SPAN);
  }

  covered(fromSec: number, toSec: number): boolean {
    const boundary = this.boundary();
    if (toSec <= boundary) return this.archive.covered(fromSec, toSec);
    if (fromSec >= boundary) return this.live.covered(fromSec, toSec);
    return this.archive.covered(fromSec, boundary) && this.live.covered(boundary, toSec);
  }
}
