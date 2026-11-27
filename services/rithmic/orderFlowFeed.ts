/**
 * Doručení order flow (objem po minutách a cenách, velké obchody) klientům místní služby.
 * JEN ZOBRAZENÍ: žádný příkaz, žádný dotaz na brokera, nic z toho nevstupuje do cen pro příkazy.
 *
 * Zásady (služba obchoduje naostro a vše běží v jedné smyčce událostí s potvrzeními příkazů):
 *  - příjem obchodu jen zařadí do fronty; počítání, skládání zpráv i disk běží v časovačích;
 *  - každý krok má strop práce (obchodů na otočku, buněk na zprávu, jeden kus snímku na otočku);
 *  - data dostane jen klient, který si o ně řekl (telefon s vypnutým indikátorem neplatí ani bajt);
 *  - buňky se posílají s CELKOVÝMI hodnotami, takže opakování ani přeskočená dávka nic nerozbije;
 *  - pomalé spojení se nezahlcuje: dávka se přeskočí a změny počkají, při velkém skluzu přijde nový snímek;
 *  - paměť i fronta zápisů na disk mají strop; při přetečení se zahazuje order flow, nikdy nic jiného;
 *  - chyba kdekoli tady vrstvu jen vypne — ceny, upozornění a příkazy běží dál.
 */
import { appendFile, readFileSync, readdir, readdirSync, rm, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RithmicTick } from './rithmicClient';
import { OrderFlowAggregator, type OrderFlowCells, type OrderFlowMinuteRecord, type OrderFlowTradeRow } from './orderFlowAggregator';

export interface OrderFlowSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(text: string): void;
}

export interface OrderFlowFeedOptions {
  /** Zdroj → kontrakt, např. { MNQ: 'MNQZ6' }. Další zdroj (NQ) jde přidat později přes `addSource`. */
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
  /** Co služba umí; null, když se vrstva po chybě vypnula (klient pak order flow nenabízí jako živý). */
  capability(): { sources: Record<string, string>; tickSize: number; floors: Record<string, number>; keepDays: number } | null;
  symbols(): string[];
  /** Přidá zdroj, jehož odběr se podařil až po startu (NQ). Vrací false, pokud už existuje. */
  addSource(source: string, symbol: string): boolean;
  /** Obchod z tickeru: jen zařadí do fronty (žádná práce v cestě cen). */
  onTick(tick: RithmicTick): void;
  /** Zpráva klienta `{ subscribe, source, days }`. Vrací chybu k odeslání klientovi, nebo null. */
  handle(socket: OrderFlowSocket, request: unknown): string | null;
  drop(socket: OrderFlowSocket): void;
  /** Ceny tečou — pro jeden kontrakt, nebo pro všechny. */
  feedOpened(at: number, symbol?: string): void;
  feedLost(): void;
  flushTrades(): void;
  flushCells(): void;
  pumpSnapshots(): void;
  advance(): void;
  metricsLine(): string;
  stop(): void;
}

const OPEN = 1;
/** Nad tímto množstvím neodeslaných bajtů se klientovi order flow nepřidává (ať nepředbíhá potvrzení příkazů). */
export const ORDER_FLOW_HIGH_WATER = 48 * 1024;
/**
 * Jedna část snímku ≈ 35 kB. Order flow jde stejným spojením jako odpovědi na příkazy, tep a cena: na slabém
 * spojení telefonu (~1 Mb/s) tak před nimi nikdy nestojí víc než zlomek sekundy dat pro zobrazení.
 */
const SNAPSHOT_CELLS_PER_PART = 1_500;
const SNAPSHOT_TRADES_PER_PART = 600;
const MAX_PENDING_CELLS = 6_000;
const MAX_PENDING_TRADES = 1_000;
const QUEUE_MAX = 100_000;
const QUEUE_PER_TURN = 4_000;
const DISK_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_STORED_TRADES = 30_000;
const DEFAULT_FLOORS: Record<string, number> = { NQ: 5, MNQ: 20, ES: 10, MES: 30 };

interface Client {
  socket: OrderFlowSocket;
  source: string;
  symbol: string;
  sub: number;
  days: number;
  seq: number;
  /** Co ještě zbývá poslat ve snímku; null = snímek hotový. */
  snapshot: { minutes: number[]; next: number; trades: OrderFlowTradeRow[]; nextTrade: number; part: number } | null;
  pendingCells: Map<number, Set<number> | null>;
  pendingCount: number;
  pendingTrades: Map<string, OrderFlowTradeRow>;
}

const dayOf = (minute: number): string => new Date(minute * 1_000).toISOString().slice(0, 10);

export function createOrderFlowFeed(options: OrderFlowFeedOptions): OrderFlowFeed {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const keepDays = Math.min(14, Math.max(1, options.keepDays ?? 7));
  const sources: Record<string, string> = {};
  const floors: Record<string, number> = {};
  const sourceOf = new Map<string, string>();
  const aggregator = new OrderFlowAggregator({
    tickSize: options.tickSize,
    tradeFloor: (symbol) => floors[sourceOf.get(symbol) ?? ''] ?? 5,
    keepMs: keepDays * 86_400_000,
    maxTrades: MAX_STORED_TRADES,
  });

  const clients = new Map<OrderFlowSocket, Client>();
  const requestLog = new Map<OrderFlowSocket, number[]>();
  const limitNotified = new Set<OrderFlowSocket>();
  let subCounter = 0;
  let disabled = false;
  let queue: RithmicTick[] = [];
  let queueHead = 0;
  let snapshotTurn = 0;
  const counters = { bytes: 0, skipped: 0, resyncs: 0, maxWorkMs: 0, droppedTicks: 0, droppedDiskBytes: 0, since: now() };

  const fail = (label: string, error: unknown): void => {
    // Chyba order flow nesmí nikdy ohrozit ceny ani příkazy: vrstva se vypne a služba běží dál.
    disabled = true;
    queue = []; queueHead = 0;
    log(`[order flow] VYPNUTO po chybě v kroku „${label}“: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    // Odběratelé se to musí dozvědět — zamrzlý profil se nesmí tvářit jako živý (INV-UI-01).
    const text = JSON.stringify({ type: 'of-error', message: 'order flow se ve službě po chybě vypnul' });
    for (const client of clients.values()) { try { if (client.socket.readyState === OPEN) client.socket.send(text); } catch { /* spojení už je pryč */ } }
    clients.clear();
  };
  const guard = (label: string, work: () => void): void => {
    if (disabled) return;
    const started = performance.now();
    try { work(); } catch (error) { fail(label, error); }
    const took = performance.now() - started;
    if (took > counters.maxWorkMs) counters.maxWorkMs = took;
  };
  const send = (client: Client, message: unknown): void => {
    const text = JSON.stringify(message);
    counters.bytes += text.length;
    // Zavírající se spojení smí odeslání odmítnout — jen tenhle klient o odběr přijde, vrstva běží dál.
    try { client.socket.send(text); } catch { clients.delete(client.socket); }
  };
  const ready = (client: Client): boolean => client.socket.readyState === OPEN && client.socket.bufferedAmount < ORDER_FLOW_HIGH_WATER;

  // ── Disk: denní soubory, aby profil přežil restart služby (mezipaměť zobrazení, ne záznam deníku) ──
  const filePrefix = `orderflow-${options.slug ?? 'local'}-`;
  const fileName = (symbol: string, minute: number) => `${filePrefix}${symbol}-${dayOf(minute)}.jsonl`;
  /** Rozebere název souboru; cizí soubory (jiná předpona, jiný tvar) vrací null. */
  const parseFileName = (name: string): { symbol: string; date: string } | null => {
    if (!name.startsWith(filePrefix) || !name.endsWith('.jsonl')) return null;
    const match = /^([A-Z0-9]{1,12})-(\d{4}-\d{2}-\d{2})$/.exec(name.slice(filePrefix.length, -'.jsonl'.length));
    return match ? { symbol: match[1], date: match[2] } : null;
  };
  const cutoffDate = (): string => dayOf(Math.floor((now() - (keepDays + 1) * 86_400_000) / 1_000));
  let chain: Promise<void> = Promise.resolve();
  let queuedBytes = 0;
  let diskWarned = false;
  const diskWarn = (text: string): void => { if (!diskWarned) { diskWarned = true; log(`[order flow] ${text}`); } };
  const append = (path: string, text: string): void => {
    if (queuedBytes + text.length > DISK_QUEUE_MAX_BYTES) {
      // Pomalý nebo plný disk: zahodit order flow, nehromadit paměť obchodující služby.
      counters.droppedDiskBytes += text.length;
      diskWarn(`disk nestíhá (${Math.round(queuedBytes / 1024)} kB ve frontě) — část order flow se neuloží; po restartu bude profil pro ten úsek neúplný`);
      return;
    }
    queuedBytes += text.length;
    chain = chain.then(() => new Promise<void>((resolve) => {
      const done = (error?: unknown) => { queuedBytes -= text.length; if (error) diskWarn(`zápis na disk nejde (${error instanceof Error ? error.message : String(error)}; ${path})`); resolve(); };
      try { appendFile(path, text, { mode: 0o600 }, (error) => done(error ?? undefined)); } catch (error) { done(error); }
    })).catch(() => undefined);
  };
  const persist = (): void => {
    if (!options.dir) { for (const symbol of sourceOf.keys()) aggregator.takePersist(symbol); return; }
    const batches = new Map<string, string[]>();
    const line = (symbol: string, minute: number, text: string) => {
      const path = join(options.dir!, fileName(symbol, minute));
      const list = batches.get(path);
      if (list) list.push(text); else batches.set(path, [text]);
    };
    for (const symbol of sourceOf.keys()) {
      const { minutes, trades } = aggregator.takePersist(symbol);
      for (const record of minutes) line(symbol, record.minute, JSON.stringify({ m: record.minute, v: record.covered ? 1 : 0, c: record.cells }));
      for (const row of trades) line(symbol, Math.floor(row[1] / 1_000), JSON.stringify({ t: row }));
    }
    // Jeden zápis na soubor a otočku, ne jeden na řádek.
    for (const [path, lines] of batches) append(path, `${lines.join('\n')}\n`);
  };

  /** Uložený stav všech kontraktů nalezených na disku; kontrakt si ho vezme, až se stane zdrojem. */
  const stored = new Map<string, { minutes: OrderFlowMinuteRecord[]; trades: OrderFlowTradeRow[] }>();
  let storedAt = now();
  const load = (): void => {
    if (!options.dir) return;
    const started = performance.now();
    const cutoff = cutoffDate();
    const cutoffMinute = Math.floor((now() - keepDays * 86_400_000) / 60_000) * 60;
    let names: string[] = [];
    try { names = readdirSync(options.dir).sort(); } catch { return; }
    for (const name of names) {
      const parsed = parseFileName(name);
      if (!parsed) continue;
      if (parsed.date < cutoff) { try { rmSync(join(options.dir, name), { force: true }); } catch { /* úklid není podmínkou */ } continue; }
      let text = '';
      try { text = readFileSync(join(options.dir, name), 'utf8'); } catch { continue; }
      let entry = stored.get(parsed.symbol);
      if (!entry) { entry = { minutes: [], trades: [] }; stored.set(parsed.symbol, entry); }
      let start = 0;
      while (start < text.length) {
        let end = text.indexOf('\n', start);
        if (end < 0) end = text.length;
        if (end > start) {
          try {
            const record = JSON.parse(text.slice(start, end)) as { m?: unknown; v?: unknown; c?: unknown; t?: unknown };
            if (typeof record.m === 'number' && Array.isArray(record.c) && record.c.every((value) => Number.isInteger(value))) {
              if (record.m >= cutoffMinute) entry.minutes.push({ minute: record.m, covered: record.v === 1, cells: record.c as number[] });
            } else if (Array.isArray(record.t) && record.t.length === 8 && typeof record.t[0] === 'string' && record.t.slice(1).every((value) => typeof value === 'number' && Number.isFinite(value))) {
              entry.trades.push(record.t as OrderFlowTradeRow);
              // Strop už při čtení: rušný týden nesmí nafouknout paměť při startu.
              if (entry.trades.length > MAX_STORED_TRADES * 2) entry.trades.splice(0, entry.trades.length - MAX_STORED_TRADES);
            }
          } catch { /* poškozený řádek (např. nedopsaný při pádu) se přeskočí */ }
        }
        start = end + 1;
      }
    }
    storedAt = now();
    const took = Math.round(performance.now() - started);
    if (stored.size > 0) log(`[order flow] z disku načteno za ${took} ms: ${[...stored.entries()].map(([symbol, entry]) => `${symbol} ${entry.minutes.length} minut, ${entry.trades.length} velkých obchodů`).join(' · ')}`);
  };
  let prunedAt = now();
  const pruneFiles = (): void => {
    if (!options.dir) return;
    const dir = options.dir;
    const cutoff = cutoffDate();
    readdir(dir, (error, names) => {
      if (error) return;
      for (const name of names) {
        const parsed = parseFileName(name);
        if (parsed && parsed.date < cutoff) rm(join(dir, name), { force: true }, () => undefined);
      }
    });
  };

  const registerSource = (source: string, symbol: string): boolean => {
    if (!/^[A-Z0-9]{1,12}$/.test(symbol) || Object.prototype.hasOwnProperty.call(sources, source) || sourceOf.has(symbol)) return false;
    sources[source] = symbol;
    floors[source] = Math.max(1, Math.floor(options.floors?.[source] ?? DEFAULT_FLOORS[source] ?? 5));
    sourceOf.set(symbol, source);
    aggregator.addSymbol(symbol);
    const saved = stored.get(symbol);
    if (saved) { aggregator.restore(symbol, saved.minutes, saved.trades, now()); stored.delete(symbol); }
    return true;
  };

  // Načtení z disku je jediná delší synchronní práce a běží jen tady — při vytvoření, tedy při startu
  // služby před přihlášením odběru cen a před prvním příkazem.
  try { load(); } catch (error) { log(`[order flow] načtení z disku selhalo (${error instanceof Error ? error.message : String(error)}) — začíná se od teď`); }
  for (const [source, symbol] of Object.entries(options.sources)) registerSource(source, symbol);

  const drainQueue = (limit: number): void => {
    const end = Math.min(queue.length, queueHead + limit);
    for (; queueHead < end; queueHead += 1) aggregator.onTick(queue[queueHead]);
    if (queueHead >= queue.length) { queue = []; queueHead = 0; }
    else if (queueHead > 8_192) { queue = queue.slice(queueHead); queueHead = 0; }
  };

  const startSnapshot = (client: Client): void => {
    const from = now() - client.days * 86_400_000;
    client.pendingCells.clear();
    client.pendingCount = 0;
    client.pendingTrades.clear();
    client.seq = 0;
    // Od nejnovějšího: to, co je v grafu právě vidět, dorazí první; starší dny se doplní za tím.
    client.snapshot = {
      minutes: aggregator.minutes(client.symbol, Math.floor(from / 60_000) * 60).reverse(), next: 0,
      trades: aggregator.tradesSince(client.symbol, from).slice().reverse(), nextTrade: 0, part: 0,
    };
  };

  const pumpClient = (client: Client): void => {
    const snapshot = client.snapshot;
    if (!snapshot) return;
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

  const feed: OrderFlowFeed = {
    capability: () => (disabled ? null : { sources: { ...sources }, tickSize: options.tickSize, floors: { ...floors }, keepDays }),
    symbols: () => [...sourceOf.keys()],
    addSource(source, symbol) {
      if (disabled) return false;
      let added = false;
      guard('nový zdroj', () => { added = registerSource(source, symbol); });
      return added;
    },
    onTick(tick) {
      if (disabled || tick.kind !== 'trade' || tick.isSnapshot || !sourceOf.has(tick.symbol)) return;
      if (queue.length - queueHead >= QUEUE_MAX) { counters.droppedTicks += 1; return; }
      queue.push(tick);
    },
    handle(socket, request) {
      const at = now();
      const body = request && typeof request === 'object' ? request as { subscribe?: unknown; source?: unknown; days?: unknown } : null;
      // Odhlášení se vyhoví vždy a hned — nesmí ho zadržet strop ani stav vrstvy.
      if (body && body.subscribe === false) { clients.delete(socket); return null; }
      // Každý pokus se počítá ještě před kontrolou obsahu; nad strop se odpoví jen jednou.
      const attempts = (requestLog.get(socket) ?? []).filter((time) => at - time < 10_000);
      if (attempts.length >= 6) {
        requestLog.set(socket, attempts);
        if (limitNotified.has(socket)) return null;
        limitNotified.add(socket);
        return 'příliš mnoho změn odběru order flow za krátkou dobu';
      }
      attempts.push(at);
      requestLog.set(socket, attempts);
      limitNotified.delete(socket);
      if (!body || body.subscribe !== true) return 'neplatná žádost o order flow';
      if (disabled) return 'order flow je po chybě vypnutý';
      const source = typeof body.source === 'string' ? body.source : '';
      const symbol = Object.prototype.hasOwnProperty.call(sources, source) ? sources[source] : undefined;
      if (!symbol) return `neznámý zdroj order flow „${source.slice(0, 12)}“`;
      const days = typeof body.days === 'number' && Number.isFinite(body.days) ? Math.min(keepDays, Math.max(1, Math.floor(body.days))) : 1;
      subCounter += 1;
      const client: Client = { socket, source, symbol, sub: subCounter, days, seq: 0, snapshot: null, pendingCells: new Map(), pendingCount: 0, pendingTrades: new Map() };
      clients.set(socket, client);
      guard('snímek', () => startSnapshot(client));
      return null;
    },
    drop(socket) { clients.delete(socket); requestLog.delete(socket); limitNotified.delete(socket); },
    feedOpened(at, symbol) { guard('obnova cen', () => aggregator.feedOpened(at, symbol)); },
    feedLost() { guard('výpadek cen', () => { drainQueue(Infinity); aggregator.feedLost(); }); },
    flushTrades() {
      guard('velké obchody', () => {
        drainQueue(QUEUE_PER_TURN);
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
        drainQueue(QUEUE_PER_TURN);
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
    pumpSnapshots() {
      guard('snímek', () => {
        // Jeden kus jednomu klientovi na otočku (střídavě): skládání zprávy nesmí zdržet potvrzení příkazů.
        const waiting = [...clients.values()].filter((client) => client.snapshot && ready(client));
        if (waiting.length === 0) return;
        snapshotTurn = (snapshotTurn + 1) % waiting.length;
        pumpClient(waiting[snapshotTurn]);
      });
    },
    advance() {
      guard('hodiny', () => {
        const at = now();
        aggregator.advance(at);
        if (at - prunedAt > 6 * 3_600_000) { prunedAt = at; pruneFiles(); }
        // Uložený stav kontraktů, které se zdrojem nestaly (např. kontrakt před rolováním), po chvíli uvolnit.
        if (stored.size > 0 && at - storedAt > 300_000) stored.clear();
      });
    },
    metricsLine() {
      try {
        const at = now();
        const seconds = Math.max(1, (at - counters.since) / 1_000);
        const parts = [...sourceOf.entries()].map(([symbol, source]) => {
          const stats = aggregator.takeStats(symbol);
          return `${source} ${(stats.trades / seconds).toFixed(1)} obch./s · ${stats.orders} příkazů [${stats.sizeHistogram.join(' ')}]${stats.noSide ? ` · bez strany ${stats.noSide}` : ''}${stats.late ? ` · opožděných ${stats.late}` : ''}`;
        });
        const line = `[order flow] ${disabled ? 'VYPNUTO · ' : ''}${parts.join(' | ')} | odběratelů ${clients.size} · ${Math.round(counters.bytes / seconds)} B/s · nejdelší krok ${counters.maxWorkMs.toFixed(1)} ms${counters.skipped ? ` · přeskočeno ${counters.skipped}` : ''}${counters.resyncs ? ` · nových snímků ${counters.resyncs}` : ''}${counters.droppedTicks ? ` · ZAHOZENO obchodů ${counters.droppedTicks}` : ''}${counters.droppedDiskBytes ? ` · neuloženo ${Math.round(counters.droppedDiskBytes / 1024)} kB` : ''}`;
        counters.bytes = 0; counters.skipped = 0; counters.resyncs = 0; counters.maxWorkMs = 0; counters.droppedTicks = 0; counters.droppedDiskBytes = 0; counters.since = at;
        return line;
      } catch (error) {
        return `[order flow] výpis selhal (${error instanceof Error ? error.message : String(error)})`;
      }
    },
    stop() { for (const timer of timers) clearInterval(timer); clients.clear(); requestLog.clear(); limitNotified.clear(); },
  };

  const timers: Array<ReturnType<typeof setInterval>> = [];
  if (options.timers !== false) {
    timers.push(setInterval(feed.flushTrades, 16), setInterval(feed.pumpSnapshots, 25), setInterval(feed.flushCells, 250), setInterval(feed.advance, 1_000));
    for (const timer of timers) timer.unref();
  }
  return feed;
}
