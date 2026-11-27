/**
 * Doručení order flow (objem po minutách a cenách, velké obchody) klientům místní služby.
 * JEN ZOBRAZENÍ: žádný příkaz, žádný dotaz na brokera, nic z toho nevstupuje do cen pro příkazy.
 *
 * Zásady:
 *  - data dostane jen klient, který si o ně řekl (telefon s vypnutým indikátorem neplatí ani bajt);
 *  - buňky se posílají s CELKOVÝMI hodnotami, takže opakování ani přeskočená dávka nic nerozbije;
 *  - pomalé spojení se nezahlcuje: dávka se přeskočí a změny počkají, při velkém skluzu přijde nový snímek;
 *  - snímek odchází po kouscích mezi jinou prací, aby dlouhé skládání zprávy nezdrželo smyčku,
 *    ve které běží i potvrzení příkazů.
 */
import { appendFile, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RithmicTick } from './rithmicClient';
import { OrderFlowAggregator, type OrderFlowCells, type OrderFlowMinuteRecord, type OrderFlowTradeRow } from './orderFlowAggregator';

export interface OrderFlowSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(text: string): void;
}

export interface OrderFlowFeedOptions {
  /** Zdroj → kontrakt, např. { NQ: 'NQZ6', MNQ: 'MNQZ6' }. */
  sources: Record<string, string>;
  tickSize: number;
  /** Nejmenší sečtený příkaz vedený jako velký obchod, podle zdroje. */
  floors?: Record<string, number>;
  keepDays?: number;
  now?: () => number;
  /** Složka pro denní soubory; bez ní se nic neukládá. */
  dir?: string;
  slug?: string;
  log?: (line: string) => void;
  /** Vlastní časovače (výchozí ano); testy volají kroky ručně. */
  timers?: boolean;
}

export interface OrderFlowFeed {
  capability(): { sources: Record<string, string>; tickSize: number; floors: Record<string, number>; keepDays: number };
  symbols(): string[];
  onTick(tick: RithmicTick): void;
  /** Zpráva klienta `{ subscribe, source, days }`. Vrací chybu k vypsání, nebo null. */
  handle(socket: OrderFlowSocket, request: unknown): string | null;
  drop(socket: OrderFlowSocket): void;
  feedOpened(at: number): void;
  feedLost(): void;
  flushTrades(): void;
  flushCells(): void;
  pumpSnapshots(): void;
  advance(): void;
  metricsLine(): string;
  stop(): void;
}

const OPEN = 1;
/** Nad tímto množstvím neodeslaných bajtů se klientovi další order flow nepřidává. */
export const ORDER_FLOW_HIGH_WATER = 512 * 1024;
const SNAPSHOT_CELLS_PER_PART = 12_000;
const SNAPSHOT_TRADES_PER_PART = 3_000;
const MAX_PENDING_CELLS = 20_000;
const MAX_PENDING_TRADES = 2_000;
const DEFAULT_FLOORS: Record<string, number> = { NQ: 5, MNQ: 20, ES: 10, MES: 30 };

interface Client {
  socket: OrderFlowSocket;
  source: string;
  symbol: string;
  sub: number;
  days: number;
  seq: number;
  /** Minuty, které ještě zbývá poslat ve snímku; null = snímek hotový. */
  snapshot: { minutes: number[]; next: number; trades: OrderFlowTradeRow[]; nextTrade: number; part: number } | null;
  pendingCells: Map<number, Set<number> | null>;
  pendingCount: number;
  pendingTrades: Map<string, OrderFlowTradeRow>;
  requests: number[];
}

const dayOf = (minute: number): string => new Date(minute * 1_000).toISOString().slice(0, 10);

export function createOrderFlowFeed(options: OrderFlowFeedOptions): OrderFlowFeed {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const keepDays = Math.min(14, Math.max(1, options.keepDays ?? 7));
  const sources = { ...options.sources };
  const floors: Record<string, number> = {};
  const sourceOf = new Map<string, string>();
  for (const [source, symbol] of Object.entries(sources)) {
    floors[source] = Math.max(1, Math.floor(options.floors?.[source] ?? DEFAULT_FLOORS[source] ?? 5));
    sourceOf.set(symbol, source);
  }
  const aggregator = new OrderFlowAggregator({
    tickSize: options.tickSize,
    tradeFloor: (symbol) => floors[sourceOf.get(symbol) ?? ''] ?? 5,
    keepMs: keepDays * 86_400_000,
  });
  for (const symbol of sourceOf.keys()) aggregator.addSymbol(symbol);

  const clients = new Map<OrderFlowSocket, Client>();
  let subCounter = 0;
  let disabled = false;
  const counters = { bytes: 0, messages: 0, skipped: 0, resyncs: 0, maxWorkMs: 0, since: now() };
  const timed = (work: () => void): void => {
    const started = performance.now();
    work();
    const took = performance.now() - started;
    if (took > counters.maxWorkMs) counters.maxWorkMs = took;
  };
  const send = (client: Client, message: unknown): void => {
    const text = JSON.stringify(message);
    counters.bytes += text.length;
    counters.messages += 1;
    // Zavírající se spojení smí odeslání odmítnout — jen tenhle klient o odběr přijde, vrstva běží dál.
    try { client.socket.send(text); } catch { clients.delete(client.socket); }
  };
  const ready = (client: Client): boolean => client.socket.readyState === OPEN && client.socket.bufferedAmount < ORDER_FLOW_HIGH_WATER;

  // ── Disk: denní soubory, aby profil přežil restart služby (mezipaměť zobrazení, ne záznam deníku) ──
  const prefix = (symbol: string) => `orderflow-${options.slug ?? 'local'}-${symbol}-`;
  let chain: Promise<void> = Promise.resolve();
  let warned = false;
  const append = (symbol: string, minute: number, line: string): void => {
    if (!options.dir) return;
    const path = join(options.dir, `${prefix(symbol)}${dayOf(minute)}.jsonl`);
    const warn = (error: unknown) => { if (!warned) { warned = true; log(`[order flow] zápis na disk nejde (${error instanceof Error ? error.message : String(error)}; ${path})`); } };
    chain = chain.then(() => new Promise<void>((resolve) => {
      try { appendFile(path, line, { mode: 0o600 }, (error) => { if (error) warn(error); resolve(); }); } catch (error) { warn(error); resolve(); }
    })).catch(() => undefined);
  };
  const persist = (): void => {
    for (const symbol of sourceOf.keys()) {
      const { minutes, trades } = aggregator.takePersist(symbol);
      for (const record of minutes) append(symbol, record.minute, `${JSON.stringify({ m: record.minute, v: record.covered ? 1 : 0, c: record.cells })}\n`);
      for (const row of trades) append(symbol, Math.floor(row[1] / 1_000), `${JSON.stringify({ t: row })}\n`);
    }
  };
  const load = (): void => {
    if (!options.dir) return;
    const at = now();
    const cutoff = dayOf(Math.floor((at - (keepDays + 1) * 86_400_000) / 1_000));
    let names: string[] = [];
    try { names = readdirSync(options.dir); } catch { return; }
    for (const symbol of sourceOf.keys()) {
      const head = prefix(symbol);
      const minutes: OrderFlowMinuteRecord[] = [];
      const trades: OrderFlowTradeRow[] = [];
      for (const name of names.sort()) {
        const date = name.startsWith(head) && name.endsWith('.jsonl') ? name.slice(head.length, -'.jsonl'.length) : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (date < cutoff) { try { rmSync(join(options.dir, name), { force: true }); } catch { /* úklid není podmínkou */ } continue; }
        let text = '';
        try { text = readFileSync(join(options.dir, name), 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            const record = JSON.parse(line) as { m?: unknown; v?: unknown; c?: unknown; t?: unknown };
            if (typeof record.m === 'number' && Array.isArray(record.c) && record.c.every((value) => Number.isInteger(value))) {
              minutes.push({ minute: record.m, covered: record.v === 1, cells: record.c as number[] });
            } else if (Array.isArray(record.t) && record.t.length === 8 && typeof record.t[0] === 'string' && record.t.slice(1).every((value) => typeof value === 'number' && Number.isFinite(value))) {
              trades.push(record.t as OrderFlowTradeRow);
            }
          } catch { /* poškozený řádek (např. nedopsaný při pádu) se přeskočí */ }
        }
      }
      aggregator.restore(symbol, minutes, trades, at);
      if (minutes.length || trades.length) log(`[order flow] ${symbol}: z disku ${minutes.length} minut a ${trades.length} velkých obchodů`);
    }
  };
  try { load(); } catch (error) { log(`[order flow] načtení z disku selhalo (${error instanceof Error ? error.message : String(error)}) — začíná se od teď`); }

  const startSnapshot = (client: Client): void => {
    const from = now() - client.days * 86_400_000;
    client.pendingCells.clear();
    client.pendingCount = 0;
    client.pendingTrades.clear();
    client.seq = 0;
    client.snapshot = {
      minutes: aggregator.minutes(client.symbol, Math.floor(from / 60_000) * 60), next: 0,
      trades: aggregator.tradesSince(client.symbol, from), nextTrade: 0, part: 0,
    };
  };

  const pumpClient = (client: Client): void => {
    const snapshot = client.snapshot;
    if (!snapshot || !ready(client)) return;
    const minutes: Array<[number, OrderFlowCells]> = [];
    let cells = 0;
    while (snapshot.next < snapshot.minutes.length && cells < SNAPSHOT_CELLS_PER_PART) {
      const minute = snapshot.minutes[snapshot.next];
      snapshot.next += 1;
      const flat = aggregator.cells(client.symbol, minute);
      if (flat.length === 0) continue;
      minutes.push([minute, flat]);
      cells += flat.length / 4;
    }
    const trades = cells < SNAPSHOT_CELLS_PER_PART ? snapshot.trades.slice(snapshot.nextTrade, snapshot.nextTrade + SNAPSHOT_TRADES_PER_PART) : [];
    snapshot.nextTrade += trades.length;
    const last = snapshot.next >= snapshot.minutes.length && snapshot.nextTrade >= snapshot.trades.length;
    const first = snapshot.part === 0;
    const from = Math.floor((now() - client.days * 86_400_000) / 60_000) * 60;
    send(client, {
      type: 'of-snapshot', sub: client.sub, source: client.source, symbol: client.symbol, part: snapshot.part, last,
      ...(first ? { reset: true, tickSize: options.tickSize, floor: floors[client.source], from } : {}),
      ...(last ? { coverage: aggregator.coverage(client.symbol, from), liveSince: aggregator.liveSince(client.symbol) } : {}),
      minutes, trades,
    });
    snapshot.part += 1;
    if (last) client.snapshot = null;
  };

  const resync = (client: Client): void => {
    counters.resyncs += 1;
    startSnapshot(client);
  };

  const sendCells = (client: Client): void => {
    if (client.snapshot || client.pendingCount === 0) return;
    if (!ready(client)) { counters.skipped += 1; return; }
    const cells: Array<[number, OrderFlowCells]> = [];
    for (const [minute, keys] of client.pendingCells) {
      const flat = aggregator.cells(client.symbol, minute, keys);
      if (flat.length > 0) cells.push([minute, flat]);
    }
    client.pendingCells.clear();
    client.pendingCount = 0;
    if (cells.length === 0) return;
    client.seq += 1;
    send(client, { type: 'of', sub: client.sub, seq: client.seq, cells });
  };

  const sendTrades = (client: Client): void => {
    if (client.snapshot || client.pendingTrades.size === 0) return;
    if (!ready(client)) { counters.skipped += 1; return; }
    const trades = [...client.pendingTrades.values()];
    client.pendingTrades.clear();
    client.seq += 1;
    send(client, { type: 'of-trade', sub: client.sub, seq: client.seq, trades });
  };

  const guard = (label: string, work: () => void): void => {
    if (disabled) return;
    try { timed(work); } catch (error) {
      // Chyba order flow nesmí nikdy ohrozit ceny ani příkazy: vrstva se vypne a služba běží dál.
      disabled = true;
      log(`[order flow] VYPNUTO po chybě v kroku „${label}“: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
  };

  const feed: OrderFlowFeed = {
    capability: () => ({ sources: { ...sources }, tickSize: options.tickSize, floors: { ...floors }, keepDays }),
    symbols: () => [...sourceOf.keys()],
    onTick(tick) {
      if (disabled) return;
      try { aggregator.onTick(tick); } catch (error) {
        disabled = true;
        log(`[order flow] VYPNUTO po chybě při zpracování obchodu: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
    },
    handle(socket, request) {
      if (disabled) return 'order flow je po chybě vypnutý';
      if (!request || typeof request !== 'object') return 'neplatná zpráva order flow';
      const body = request as { subscribe?: unknown; source?: unknown; days?: unknown };
      const at = now();
      const existing = clients.get(socket);
      const requests = (existing?.requests ?? []).filter((time) => at - time < 10_000);
      if (requests.length >= 6) return 'příliš mnoho změn odběru order flow za krátkou dobu';
      requests.push(at);
      if (body.subscribe !== true) {
        if (existing) clients.set(socket, { ...existing, requests, source: '', symbol: '', snapshot: null, pendingCells: new Map(), pendingCount: 0, pendingTrades: new Map() });
        return null;
      }
      const source = typeof body.source === 'string' ? body.source : '';
      const symbol = Object.prototype.hasOwnProperty.call(sources, source) ? sources[source] : undefined;
      if (!symbol) return `neznámý zdroj order flow „${source.slice(0, 12)}“`;
      const days = typeof body.days === 'number' && Number.isFinite(body.days) ? Math.min(keepDays, Math.max(1, Math.floor(body.days))) : 1;
      subCounter += 1;
      const client: Client = { socket, source, symbol, sub: subCounter, days, seq: 0, snapshot: null, pendingCells: new Map(), pendingCount: 0, pendingTrades: new Map(), requests };
      clients.set(socket, client);
      guard('snímek', () => startSnapshot(client));
      return null;
    },
    drop(socket) { clients.delete(socket); },
    feedOpened(at) { guard('obnova cen', () => aggregator.feedOpened(at)); },
    feedLost() { guard('výpadek cen', () => aggregator.feedLost()); },
    flushTrades() {
      guard('velké obchody', () => {
        for (const symbol of sourceOf.keys()) {
          const rows = aggregator.drainTrades(symbol);
          if (rows.length === 0) continue;
          for (const client of clients.values()) {
            if (client.symbol !== symbol) continue;
            // I během snímku: změny se nasbírají a odejdou hned po něm (snímek byl pořízen dřív).
            for (const row of rows) client.pendingTrades.set(row[0], row);
            if (client.pendingTrades.size > MAX_PENDING_TRADES) resync(client); else sendTrades(client);
          }
        }
        // Kdo minule nestíhal, dostane zbytek, jakmile se mu fronta uvolní.
        for (const client of clients.values()) if (client.pendingTrades.size > 0) sendTrades(client);
      });
    },
    flushCells() {
      guard('buňky', () => {
        for (const symbol of sourceOf.keys()) {
          const changes = aggregator.drainCells(symbol);
          if (changes.length === 0) continue;
          for (const client of clients.values()) {
            if (client.symbol !== symbol) continue;
            for (const change of changes) {
              const current = client.pendingCells.get(change.minute);
              if (change.keys === null) { client.pendingCells.set(change.minute, null); client.pendingCount += 1; continue; }
              if (current === null) continue;
              const set = current ?? new Set<number>();
              if (!current) client.pendingCells.set(change.minute, set);
              for (const key of change.keys) if (!set.has(key)) { set.add(key); client.pendingCount += 1; }
            }
            if (client.pendingCount > MAX_PENDING_CELLS) resync(client);
          }
        }
        for (const client of clients.values()) sendCells(client);
        persist();
      });
    },
    pumpSnapshots() { guard('snímek', () => { for (const client of clients.values()) if (client.snapshot) pumpClient(client); }); },
    advance() { guard('hodiny', () => aggregator.advance(now())); },
    metricsLine() {
      const at = now();
      const seconds = Math.max(1, (at - counters.since) / 1_000);
      const parts = [...sourceOf.entries()].map(([symbol, source]) => {
        const stats = aggregator.takeStats(symbol);
        return `${source} ${(stats.trades / seconds).toFixed(1)} obch./s · ${stats.orders} příkazů [${stats.sizeHistogram.join(' ')}]${stats.noSide ? ` · bez strany ${stats.noSide}` : ''}${stats.late ? ` · opožděných ${stats.late}` : ''}`;
      });
      const line = `[order flow] ${disabled ? 'VYPNUTO · ' : ''}${parts.join(' | ')} | odběratelů ${[...clients.values()].filter((client) => client.symbol).length} · ${Math.round(counters.bytes / seconds)} B/s · nejdelší krok ${counters.maxWorkMs.toFixed(1)} ms${counters.skipped ? ` · přeskočeno ${counters.skipped}` : ''}${counters.resyncs ? ` · nových snímků ${counters.resyncs}` : ''}`;
      counters.bytes = 0; counters.messages = 0; counters.skipped = 0; counters.resyncs = 0; counters.maxWorkMs = 0; counters.since = at;
      return line;
    },
    stop() { for (const timer of timers) clearInterval(timer); clients.clear(); },
  };

  const timers: Array<ReturnType<typeof setInterval>> = [];
  if (options.timers !== false) {
    timers.push(setInterval(feed.flushTrades, 16), setInterval(feed.pumpSnapshots, 25), setInterval(feed.flushCells, 250), setInterval(feed.advance, 1_000));
    for (const timer of timers) timer.unref();
  }
  return feed;
}
