/**
 * Order flow v prohlížeči: objem po minutách a cenách a velké obchody, jak je posílá místní služba
 * Rithmicu (zprávy `of-snapshot`, `of`, `of-trade`). Žije mimo React — kreslicí vrstvy grafu si data
 * čtou přímo a o změně se dozvědí posluchačem.
 *
 * JEN ZOBRAZENÍ (INV-UI-04): odsud se nesmí číst cena ani kotace pro příkaz. Moduly příkazů tenhle
 * soubor neimportují; data můžou být z jiného kontraktu (NQ), než který se obchoduje (MNQ).
 */

export interface OrderFlowCapability {
  sources: Record<string, string>;
  tickSize: number;
  floors: Record<string, number>;
  keepDays: number;
}

export interface OrderFlowTrade {
  id: string;
  /** Čas burzy v ms. */
  at: number;
  side: 1 | -1;
  size: number;
  fills: number;
  /** Nejnižší, nejvyšší a průměrná cena v ticích. */
  lo: number;
  hi: number;
  price: number;
}

type Listener = () => void;

const isQuads = (value: unknown): value is number[] => Array.isArray(value) && value.length % 4 === 0 && value.every((item) => typeof item === 'number' && Number.isFinite(item));

/** Kolik posledních změn minut si pamatovat pro levné ověření, jestli je uložený profil ještě platný. */
const CHANGE_LOG = 4_096;

export function parseOrderFlowCapability(value: unknown): OrderFlowCapability | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { sources?: unknown; tickSize?: unknown; floors?: unknown; keepDays?: unknown };
  if (!raw.sources || typeof raw.sources !== 'object' || typeof raw.tickSize !== 'number' || !(raw.tickSize > 0)) return null;
  const sources: Record<string, string> = {};
  for (const [key, symbol] of Object.entries(raw.sources as Record<string, unknown>)) if (typeof symbol === 'string' && symbol) sources[key] = symbol;
  if (Object.keys(sources).length === 0) return null;
  const floors: Record<string, number> = {};
  if (raw.floors && typeof raw.floors === 'object') for (const [key, floor] of Object.entries(raw.floors as Record<string, unknown>)) if (typeof floor === 'number' && floor > 0) floors[key] = floor;
  return { sources, tickSize: raw.tickSize, floors, keepDays: typeof raw.keepDays === 'number' && raw.keepDays >= 1 ? Math.floor(raw.keepDays) : 1 };
}

export class OrderFlowStore {
  /** Zdroj a kontrakt, ze kterého data jsou (např. NQ / NQZ6); null, dokud nepřišel snímek. */
  source: string | null = null;
  symbol: string | null = null;
  tickSize = 0.25;
  floor = 1;
  /** Snímek dorazil celý — do té doby je obraz neúplný. */
  complete = false;
  /** Celé pokryté minuty jako [od, do) v sekundách (ze snímku). */
  coverage: Array<[number, number]> = [];
  /** Od kdy data tečou bez přerušení (ms), nebo null. */
  liveSince: number | null = null;
  /** Od které minuty snímek sahá. */
  from = 0;
  /** Pořadové číslo změn; roste s každou úpravou dat. */
  rev = 0;
  /** Služba ohlásila mezeru ve zprávách — odběr je potřeba přihlásit znovu. */
  needsResync = false;

  private sub: number | null = null;
  private seq = 0;
  private readonly cells = new Map<number, Int32Array>();
  private sortedMinutes: number[] | null = null;
  private tradeList: OrderFlowTrade[] = [];
  private readonly tradeIndex = new Map<string, OrderFlowTrade>();
  private tradesSorted = true;
  private readonly listeners = new Set<Listener>();
  private readonly changeLog: Array<[number, number]> = [];
  private changeFloor = 0;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Konec relace nebo změna zdroje: nic starého se nesmí tvářit jako živé. */
  reset(): void {
    this.source = null; this.symbol = null; this.complete = false; this.coverage = []; this.liveSince = null; this.from = 0;
    this.sub = null; this.seq = 0; this.needsResync = false;
    this.cells.clear(); this.sortedMinutes = null;
    this.tradeList = []; this.tradeIndex.clear(); this.tradesSorted = true;
    this.touchAll();
    this.emit();
  }

  /** Zpracuje zprávu služby. Vrací true, pokud byla určená order flow (ať už něco změnila, nebo ne). */
  apply(message: Record<string, unknown>): boolean {
    const type = message.type;
    if (type !== 'of-snapshot' && type !== 'of' && type !== 'of-trade') return false;
    const sub = typeof message.sub === 'number' ? message.sub : null;
    if (sub === null) return true;
    if (type === 'of-snapshot') {
      if (message.reset === true) {
        this.cells.clear(); this.sortedMinutes = null;
        this.tradeList = []; this.tradeIndex.clear(); this.tradesSorted = true;
        this.sub = sub; this.seq = 0; this.complete = false; this.needsResync = false; this.coverage = []; this.liveSince = null;
        this.source = typeof message.source === 'string' ? message.source : null;
        this.symbol = typeof message.symbol === 'string' ? message.symbol : null;
        if (typeof message.tickSize === 'number' && message.tickSize > 0) this.tickSize = message.tickSize;
        this.floor = typeof message.floor === 'number' && message.floor > 0 ? message.floor : 1;
        this.from = typeof message.from === 'number' ? message.from : 0;
        this.touchAll();
      } else if (sub !== this.sub) return true;
      this.applyMinutes(message.minutes, true);
      this.applyTrades(message.trades);
      if (message.last === true) {
        this.complete = true;
        this.coverage = Array.isArray(message.coverage)
          ? (message.coverage as unknown[]).filter((range): range is [number, number] => Array.isArray(range) && range.length === 2 && range.every((item) => typeof item === 'number'))
          : [];
        this.liveSince = typeof message.liveSince === 'number' ? message.liveSince : null;
      }
      this.emit();
      return true;
    }
    if (sub !== this.sub) return true;
    const seq = typeof message.seq === 'number' ? message.seq : null;
    if (seq === null || seq !== this.seq + 1) {
      // Chybí zpráva: obraz už nemusí sedět. Nedomýšlet — vyžádat nový snímek.
      if (!this.needsResync) { this.needsResync = true; this.emit(); }
      return true;
    }
    this.seq = seq;
    if (type === 'of') this.applyMinutes(message.cells, false); else this.applyTrades(message.trades);
    this.emit();
    return true;
  }

  /** Minuty s daty v rozsahu [fromMinute, toMinute), vzestupně. */
  minutes(fromMinute = -Infinity, toMinute = Infinity): number[] {
    if (!this.sortedMinutes) this.sortedMinutes = [...this.cells.keys()].sort((a, b) => a - b);
    const all = this.sortedMinutes;
    if (fromMinute === -Infinity && toMinute === Infinity) return all;
    let lo = 0; let hi = all.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid] < fromMinute) lo = mid + 1; else hi = mid; }
    const start = lo; hi = all.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid] < toMinute) lo = mid + 1; else hi = mid; }
    return all.slice(start, lo);
  }

  /** Buňky minuty naplocho [cena v ticích, nákup, prodej, bez strany, …], nebo undefined. */
  minuteCells(minute: number): Int32Array | undefined { return this.cells.get(minute); }

  /** Velké obchody v čase [fromMs, toMs], vzestupně podle času. */
  trades(fromMs = -Infinity, toMs = Infinity): OrderFlowTrade[] {
    if (!this.tradesSorted) { this.tradeList.sort((a, b) => a.at - b.at); this.tradesSorted = true; }
    const all = this.tradeList;
    if (fromMs === -Infinity && toMs === Infinity) return all;
    let lo = 0; let hi = all.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid].at < fromMs) lo = mid + 1; else hi = mid; }
    const start = lo; hi = all.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid].at <= toMs) lo = mid + 1; else hi = mid; }
    return all.slice(start, lo);
  }

  /**
   * Změnila se od `sinceRev` některá minuta v [fromMinute, toMinute)? Když už si to store nepamatuje
   * (příliš dávno, nebo přišel snímek), odpoví opatrně ano.
   */
  changedSince(sinceRev: number, fromMinute: number, toMinute: number): boolean {
    if (sinceRev >= this.rev) return false;
    if (sinceRev < this.changeFloor) return true;
    for (let i = this.changeLog.length - 1; i >= 0; i -= 1) {
      const [rev, minute] = this.changeLog[i];
      if (rev <= sinceRev) break;
      if (minute >= fromMinute && minute < toMinute) return true;
    }
    return false;
  }

  /** Je celý úsek [fromSec, toSec) pokrytý daty bez díry? */
  covered(fromSec: number, toSec: number): boolean {
    let cursor = fromSec;
    for (const [start, end] of this.coverage) {
      if (end <= cursor) continue;
      if (start > cursor) break;
      cursor = end;
      if (cursor >= toSec) return true;
    }
    // Za snímkem pokračuje živý tok: od začátku první celé minuty po `liveSince`.
    if (this.liveSince !== null && this.complete && !this.needsResync) {
      const liveFrom = Math.ceil(this.liveSince / 60_000) * 60;
      if (liveFrom <= cursor) return true;
    }
    return cursor >= toSec;
  }

  private applyMinutes(value: unknown, whole: boolean): void {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'number' || !isQuads(entry[1])) continue;
      const minute = entry[0];
      const incoming = entry[1];
      const existing = this.cells.get(minute);
      if (!existing) this.sortedMinutes = null;
      this.cells.set(minute, whole || !existing ? Int32Array.from(incoming) : mergeCells(existing, incoming));
      this.touch(minute);
    }
  }

  private applyTrades(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const row of value) {
      if (!Array.isArray(row) || row.length !== 8 || typeof row[0] !== 'string' || !row.slice(1).every((item) => typeof item === 'number' && Number.isFinite(item))) continue;
      const [id, at, side, size, fills, lo, hi, price] = row as [string, number, number, number, number, number, number, number];
      const next: OrderFlowTrade = { id, at, side: side >= 0 ? 1 : -1, size, fills, lo, hi, price };
      const existing = this.tradeIndex.get(id);
      if (existing) Object.assign(existing, next);
      else {
        const last = this.tradeList[this.tradeList.length - 1];
        if (last && last.at > at) this.tradesSorted = false;
        this.tradeList.push(next);
        this.tradeIndex.set(id, next);
      }
      this.rev += 1;
    }
  }

  private touch(minute: number): void {
    this.rev += 1;
    this.changeLog.push([this.rev, minute]);
    if (this.changeLog.length > CHANGE_LOG) {
      const dropped = this.changeLog.splice(0, CHANGE_LOG / 2);
      this.changeFloor = dropped[dropped.length - 1][0];
    }
  }

  private touchAll(): void {
    this.rev += 1;
    this.changeLog.length = 0;
    this.changeFloor = this.rev;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* posluchač nesmí shodit příjem */ } }
  }
}

/** Sloučí změněné buňky (celkové hodnoty) do buněk minuty; výsledek zůstává seřazený podle ceny. */
export function mergeCells(existing: Int32Array, incoming: number[]): Int32Array {
  const byKey = new Map<number, [number, number, number]>();
  for (let i = 0; i < existing.length; i += 4) byKey.set(existing[i], [existing[i + 1], existing[i + 2], existing[i + 3]]);
  for (let i = 0; i < incoming.length; i += 4) byKey.set(incoming[i], [incoming[i + 1], incoming[i + 2], incoming[i + 3]]);
  const keys = [...byKey.keys()].sort((a, b) => a - b);
  const out = new Int32Array(keys.length * 4);
  keys.forEach((key, index) => { const cell = byKey.get(key)!; out.set([key, cell[0], cell[1], cell[2]], index * 4); });
  return out;
}
