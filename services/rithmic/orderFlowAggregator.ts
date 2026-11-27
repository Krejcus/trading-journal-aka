/**
 * Order flow z ticků Rithmicu: objem nákupů a prodejů po minutách a cenách a velké obchody
 * (dílčí obchody sečtené podle čísla příkazu agresora). JEN ZOBRAZENÍ (indikátory Bubliny
 * a Volume profil) — nic z toho nesmí vstoupit do cen pro příkazy, risk bran, day locku ani
 * rozhodování (stejné pravidlo jako u svíček, INV-UI-04).
 *
 * Čistá logika bez časovačů a bez disku. Čas minuty se bere stejně jako u svíček
 * (burza → brána Rithmicu → příjem) a opožděný obchod ze starší minuty se stejně zahodí,
 * aby součet profilu seděl na objem svíček.
 */
import type { RithmicTick } from './rithmicClient';

/** Velký obchod: [id, čas ms, strana 1 = nákup / -1 = prodej, velikost, dílčích obchodů, nejnižší, nejvyšší a průměrná cena v ticích]. */
export type OrderFlowTradeRow = [string, number, 1 | -1, number, number, number, number, number];
/** Buňky jedné minuty naplocho, vzestupně podle ceny: [cena v ticích, nákup, prodej, bez strany, …]. */
export type OrderFlowCells = number[];

export interface OrderFlowMinuteRecord {
  minute: number;
  cells: OrderFlowCells;
  /** Ceny tekly po celou minutu (jinak je minuta neúplná a profil to musí přiznat). */
  covered: boolean;
}

export interface OrderFlowAggregatorOptions {
  tickSize: number;
  /** Nejmenší sečtený příkaz, který se vede jako velký obchod (ostatní jdou jen do objemu). */
  tradeFloor: (symbol: string) => number;
  /** Jak dlouho držet minuty a velké obchody v paměti. */
  keepMs?: number;
  maxTrades?: number;
}

export interface OrderFlowStats {
  trades: number;
  volume: number;
  /** Obchody bez strany agresora (jdou do objemu, ne do delty ani bublin). */
  noSide: number;
  late: number;
  orders: number;
  /** Počet sečtených příkazů podle velikosti: 1, 2–4, 5–9, 10–19, 20–49, 50–99, 100+. */
  sizeHistogram: number[];
}

interface Group { id: string; orderId: string | null; at: number; side: 1 | -1; size: number; fills: number; lo: number; hi: number; priceSize: number; emittedSize: number }

interface SymbolState {
  formingMinute: number | null;
  forming: Map<number, [number, number, number]>;
  formingDirty: Set<number>;
  finished: Map<number, Int32Array>;
  finishedDirty: number[];
  covered: Set<number>;
  /** Poslední minuta uzavřená podle hodin (i prázdná), aby šlo poznat pokrytí v klidném trhu. */
  lastClosed: number | null;
  /** Nejnovější minuta, která už byla uzavřena (s obchody i prázdná); obchod do ní nebo starší je opožděný. */
  lastFinished: number | null;
  feedOpenSince: number | null;
  open: Group | null;
  trades: OrderFlowTradeRow[];
  dirtyTrades: Map<string, OrderFlowTradeRow>;
  persistMinutes: OrderFlowMinuteRecord[];
  persistTrades: OrderFlowTradeRow[];
  stats: OrderFlowStats;
  synthetic: number;
  /** Kolikrát už se číslo příkazu objevilo jako samostatná skupina (stejné číslo po přestávce = nová bublina). */
  seenOrders: Map<string, number>;
}

const HISTOGRAM_EDGES = [1, 2, 5, 10, 20, 50, 100];
const emptyStats = (): OrderFlowStats => ({ trades: 0, volume: 0, noSide: 0, late: 0, orders: 0, sizeHistogram: HISTOGRAM_EDGES.map(() => 0) });
const tickTimeMs = (tick: RithmicTick): number => tick.exchangeAt ?? tick.gatewayAt ?? tick.receivedAt;
const minuteOf = (ms: number): number => Math.floor(ms / 60_000) * 60;

export class OrderFlowAggregator {
  private readonly tickSize: number;
  private readonly tradeFloor: (symbol: string) => number;
  private readonly keepMs: number;
  private readonly maxTrades: number;
  private readonly symbols = new Map<string, SymbolState>();
  private prunedAt = 0;

  constructor(options: OrderFlowAggregatorOptions) {
    if (!(options.tickSize > 0)) throw new Error('order flow: neplatný krok ceny');
    this.tickSize = options.tickSize;
    this.tradeFloor = options.tradeFloor;
    this.keepMs = options.keepMs ?? 7 * 86_400_000;
    this.maxTrades = Math.max(100, options.maxTrades ?? 30_000);
  }

  addSymbol(symbol: string): void {
    if (this.symbols.has(symbol)) return;
    this.symbols.set(symbol, {
      formingMinute: null, forming: new Map(), formingDirty: new Set(), finished: new Map(), finishedDirty: [], covered: new Set(),
      lastClosed: null, lastFinished: null, feedOpenSince: null, open: null, trades: [], dirtyTrades: new Map(), persistMinutes: [], persistTrades: [],
      stats: emptyStats(), synthetic: 0, seenOrders: new Map(),
    });
  }

  has(symbol: string): boolean { return this.symbols.has(symbol); }

  /**
   * Ceny začaly téct (start nebo obnova po výpadku) — pro jeden kontrakt, nebo pro všechny. Minuta, ve které
   * se to stalo, je neúplná. Kontrakt, jehož odběr se nepodařil, se za tekoucí nepovažuje.
   */
  feedOpened(at: number, symbol?: string): void {
    for (const [name, state] of this.symbols) {
      if (symbol !== undefined && name !== symbol) continue;
      state.feedOpenSince = at;
      state.lastClosed = minuteOf(at);
    }
  }

  /**
   * Výpadek cen: rozpracovaný příkaz se dokončí a rozdělaná minuta zůstane otevřená jako neúplná — když se
   * ceny vrátí ještě v téže minutě, její zbytek se dopočítá; jinak ji uzavřou hodiny (`advance`).
   */
  feedLost(): void {
    for (const [symbol, state] of this.symbols) {
      state.feedOpenSince = null;
      this.closeGroup(symbol, state);
      state.lastClosed = null;
    }
  }

  /**
   * Část obchodů se ztratila (přetečení fronty): rozdělaná minuta už není úplná. Ceny tečou dál,
   * jen pokrytí začíná znovu od teď.
   */
  breakCoverage(at: number): void {
    for (const state of this.symbols.values()) if (state.feedOpenSince !== null) state.feedOpenSince = at;
  }

  onTick(tick: RithmicTick): void {
    if (tick.kind !== 'trade' || tick.isSnapshot) return;
    const state = this.symbols.get(tick.symbol);
    if (!state) return;
    const price = tick.tradePrice;
    const size = tick.tradeSize;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return;
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return;
    const ms = tickTimeMs(tick);
    const minute = minuteOf(ms);
    if ((state.formingMinute !== null && minute < state.formingMinute) || (state.lastFinished !== null && minute <= state.lastFinished)) { state.stats.late += 1; return; }
    if (state.formingMinute !== null && minute > state.formingMinute) this.finishMinute(tick.symbol, state);
    if (state.formingMinute === null) state.formingMinute = minute;

    const key = Math.round(price / this.tickSize);
    let cell = state.forming.get(key);
    if (!cell) { cell = [0, 0, 0]; state.forming.set(key, cell); }
    const side = tick.aggressor === 'buy' ? 1 : tick.aggressor === 'sell' ? -1 : 0;
    cell[side === 1 ? 0 : side === -1 ? 1 : 2] += size;
    state.formingDirty.add(key);
    state.stats.trades += 1;
    state.stats.volume += size;

    if (side === 0) {
      state.stats.noSide += 1;
      this.closeGroup(tick.symbol, state);
      return;
    }
    const orderId = tick.aggressorOrderId || null;
    const open = state.open;
    if (open && orderId !== null && open.orderId === orderId && open.side === side) {
      open.size += size; open.fills += 1; open.priceSize += key * size;
      if (key < open.lo) open.lo = key;
      if (key > open.hi) open.hi = key;
      return;
    }
    this.closeGroup(tick.symbol, state);
    state.synthetic += 1;
    let id = orderId ?? `x${ms}-${state.synthetic}`;
    if (orderId !== null) {
      // Totéž číslo příkazu po přestávce (jiný příkaz mezi tím): nová bublina s vlastním id, ne přepis té první.
      const seen = state.seenOrders.get(orderId) ?? 0;
      if (seen > 0) id = `${orderId}#${seen + 1}`;
      if (state.seenOrders.size > 20_000) state.seenOrders.clear();
      state.seenOrders.set(orderId, seen + 1);
    }
    state.open = { id, orderId, at: ms, side, size, fills: 1, lo: key, hi: key, priceSize: key * size, emittedSize: 0 };
  }

  /**
   * Posun podle hodin: uzavře minuty, které už skončily (i ty bez obchodu), aby šlo říct,
   * které minuty jsou pokryté celé. Volá se jednou za sekundu.
   */
  advance(now: number): void {
    const done = minuteOf(now - 2_000) - 60;
    for (const [symbol, state] of this.symbols) {
      if (state.formingMinute !== null && state.formingMinute <= done) this.finishMinute(symbol, state);
      if (state.feedOpenSince === null || state.lastClosed === null) continue;
      // Nejvýš den dozadu — delší mezera znamená chybu hodin, ne klidný trh.
      if (done - state.lastClosed > 86_400) state.lastClosed = done - 60;
      while (state.lastClosed < done) {
        const minute = state.lastClosed + 60;
        state.lastClosed = minute;
        if (state.lastFinished === null || minute > state.lastFinished) state.lastFinished = minute;
        if (state.finished.has(minute) || state.covered.has(minute)) continue;
        if (state.feedOpenSince <= minute * 1_000) {
          state.covered.add(minute);
          state.persistMinutes.push({ minute, cells: [], covered: true });
        }
      }
    }
    if (now - this.prunedAt > 3_600_000) { this.prunedAt = now; this.prune(now); }
  }

  /** Velké obchody změněné od posledního volání (nové i doplněné dalším dílčím obchodem). */
  drainTrades(symbol: string): OrderFlowTradeRow[] {
    const state = this.symbols.get(symbol);
    if (!state) return [];
    const open = state.open;
    if (open && open.size >= this.tradeFloor(symbol) && open.emittedSize !== open.size) this.emit(state, open);
    if (state.dirtyTrades.size === 0) return [];
    const rows = [...state.dirtyTrades.values()];
    state.dirtyTrades.clear();
    return rows;
  }

  /** Buňky změněné od posledního volání: celá dokončená minuta (`keys: null`), nebo vybrané ceny rozdělané minuty. */
  drainCells(symbol: string): Array<{ minute: number; keys: number[] | null }> {
    const state = this.symbols.get(symbol);
    if (!state) return [];
    const out: Array<{ minute: number; keys: number[] | null }> = state.finishedDirty.map((minute) => ({ minute, keys: null }));
    state.finishedDirty = [];
    if (state.formingMinute !== null && state.formingDirty.size > 0) {
      out.push({ minute: state.formingMinute, keys: [...state.formingDirty] });
      state.formingDirty.clear();
    }
    return out;
  }

  /** Aktuální celkové hodnoty buněk minuty (všech, nebo jen vybraných cen). */
  cells(symbol: string, minute: number, keys: Iterable<number> | null = null): OrderFlowCells {
    const state = this.symbols.get(symbol);
    if (!state) return [];
    const out: OrderFlowCells = [];
    if (state.formingMinute === minute) {
      const wanted = keys === null ? [...state.forming.keys()].sort((a, b) => a - b) : [...keys].sort((a, b) => a - b);
      for (const key of wanted) { const cell = state.forming.get(key); if (cell) out.push(key, cell[0], cell[1], cell[2]); }
      return out;
    }
    const flat = state.finished.get(minute);
    if (!flat) return out;
    if (keys === null) return Array.from(flat);
    const wanted = new Set(keys);
    for (let i = 0; i < flat.length; i += 4) if (wanted.has(flat[i])) out.push(flat[i], flat[i + 1], flat[i + 2], flat[i + 3]);
    return out;
  }

  /** Minuty s daty od `fromMinute` vzestupně (dokončené i rozdělaná). */
  minutes(symbol: string, fromMinute: number): number[] {
    const state = this.symbols.get(symbol);
    if (!state) return [];
    const out: number[] = [];
    for (const minute of state.finished.keys()) if (minute >= fromMinute) out.push(minute);
    if (state.formingMinute !== null && state.formingMinute >= fromMinute && !state.finished.has(state.formingMinute)) out.push(state.formingMinute);
    return out.sort((a, b) => a - b);
  }

  tradesSince(symbol: string, fromMs: number): OrderFlowTradeRow[] {
    const state = this.symbols.get(symbol);
    if (!state) return [];
    return state.trades.filter((row) => row[1] >= fromMs);
  }

  /** Souvislé úseky celých pokrytých minut jako [od, do) v sekundách. */
  coverage(symbol: string, fromMinute: number): Array<[number, number]> {
    const state = this.symbols.get(symbol);
    if (!state) return [];
    const sorted = [...state.covered].filter((minute) => minute >= fromMinute).sort((a, b) => a - b);
    const out: Array<[number, number]> = [];
    for (const minute of sorted) {
      const last = out[out.length - 1];
      if (last && last[1] === minute) last[1] = minute + 60; else out.push([minute, minute + 60]);
    }
    return out;
  }

  /** Od kdy teď ceny tečou bez přerušení (ms), nebo null při výpadku. */
  liveSince(symbol: string): number | null { return this.symbols.get(symbol)?.feedOpenSince ?? null; }

  /** Co se má zapsat na disk od posledního volání (dokončené minuty a uzavřené velké obchody). */
  takePersist(symbol: string): { minutes: OrderFlowMinuteRecord[]; trades: OrderFlowTradeRow[] } {
    const state = this.symbols.get(symbol);
    if (!state) return { minutes: [], trades: [] };
    const out = { minutes: state.persistMinutes, trades: state.persistTrades };
    state.persistMinutes = [];
    state.persistTrades = [];
    return out;
  }

  /** Načtení uloženého stavu po startu služby. Nic z toho se znovu nezapisuje ani neposílá jako změna. */
  restore(symbol: string, minutes: OrderFlowMinuteRecord[], trades: OrderFlowTradeRow[], now: number): void {
    const state = this.symbols.get(symbol);
    if (!state) return;
    const cutoffMinute = minuteOf(now - this.keepMs);
    for (const record of minutes) {
      if (!Number.isInteger(record.minute) || record.minute < cutoffMinute || record.cells.length % 4 !== 0) continue;
      if (record.cells.length > 0) state.finished.set(record.minute, Int32Array.from(record.cells));
      if (record.covered) state.covered.add(record.minute); else state.covered.delete(record.minute);
    }
    const byId = new Map<string, OrderFlowTradeRow>();
    for (const row of state.trades) byId.set(row[0], row);
    for (const row of trades) if (row[1] >= now - this.keepMs) byId.set(row[0], row);
    state.trades = [...byId.values()].sort((a, b) => a[1] - b[1]).slice(-this.maxTrades);
  }

  /** Čísla do výpisu služby; volání je vynuluje. */
  takeStats(symbol: string): OrderFlowStats {
    const state = this.symbols.get(symbol);
    if (!state) return emptyStats();
    const out = state.stats;
    state.stats = emptyStats();
    return out;
  }

  private finishMinute(_symbol: string, state: SymbolState): void {
    // Rozpracovaný příkaz se s minutou NEuzavírá: dílčí obchody jednoho příkazu můžou padnout přes její hranu.
    const minute = state.formingMinute;
    if (minute === null) return;
    // Minuta už uložená z dřívějšího běhu služby (restart uprostřed minuty): objem se sečte, nepřepíše.
    const earlier = state.finished.get(minute);
    if (earlier) {
      for (let i = 0; i < earlier.length; i += 4) {
        const cell = state.forming.get(earlier[i]);
        if (cell) { cell[0] += earlier[i + 1]; cell[1] += earlier[i + 2]; cell[2] += earlier[i + 3]; }
        else state.forming.set(earlier[i], [earlier[i + 1], earlier[i + 2], earlier[i + 3]]);
      }
    }
    const keys = [...state.forming.keys()].sort((a, b) => a - b);
    const flat = new Int32Array(keys.length * 4);
    keys.forEach((key, index) => { const cell = state.forming.get(key)!; flat.set([key, cell[0], cell[1], cell[2]], index * 4); });
    const covered = !earlier && state.feedOpenSince !== null && state.feedOpenSince <= minute * 1_000;
    state.finished.set(minute, flat);
    if (covered) state.covered.add(minute); else state.covered.delete(minute);
    state.finishedDirty.push(minute);
    state.persistMinutes.push({ minute, cells: Array.from(flat), covered });
    state.forming = new Map();
    state.formingDirty.clear();
    state.formingMinute = null;
    if (state.lastFinished === null || minute > state.lastFinished) state.lastFinished = minute;
    if (state.lastClosed !== null && minute > state.lastClosed) state.lastClosed = minute;
  }

  private closeGroup(symbol: string, state: SymbolState): void {
    const open = state.open;
    if (!open) return;
    state.open = null;
    state.stats.orders += 1;
    let bucket = 0;
    for (let i = 0; i < HISTOGRAM_EDGES.length; i += 1) if (open.size >= HISTOGRAM_EDGES[i]) bucket = i;
    state.stats.sizeHistogram[bucket] += 1;
    if (open.size < this.tradeFloor(symbol)) return;
    if (open.emittedSize !== open.size) this.emit(state, open);
    state.persistTrades.push(this.row(open));
  }

  private row(group: Group): OrderFlowTradeRow {
    return [group.id, group.at, group.side, group.size, group.fills, group.lo, group.hi, Math.round(group.priceSize / group.size)];
  }

  private emit(state: SymbolState, group: Group): void {
    const row = this.row(group);
    group.emittedSize = group.size;
    const last = state.trades[state.trades.length - 1];
    if (last && last[0] === row[0]) state.trades[state.trades.length - 1] = row;
    else {
      state.trades.push(row);
      if (state.trades.length > this.maxTrades) state.trades.splice(0, Math.ceil(this.maxTrades / 10));
    }
    state.dirtyTrades.set(row[0], row);
  }

  private prune(now: number): void {
    const cutoffMs = now - this.keepMs;
    const cutoffMinute = minuteOf(cutoffMs);
    for (const state of this.symbols.values()) {
      for (const minute of state.finished.keys()) if (minute < cutoffMinute) state.finished.delete(minute);
      for (const minute of state.covered) if (minute < cutoffMinute) state.covered.delete(minute);
      const firstKept = state.trades.findIndex((row) => row[1] >= cutoffMs);
      if (firstKept > 0) state.trades.splice(0, firstKept); else if (firstKept < 0 && state.trades.length > 0) state.trades = [];
    }
  }
}
