import { SecType } from '@stoqey/ib';
import {
  createReadOnlyIbClient,
  nextTradesRequestAt,
  pickFrontContract,
  toFrontCandidate,
  type FrontContractCandidate,
  type IbTrade,
  type ReadOnlyIbClient,
  type ReadOnlyIbHandlers,
} from './ibkrMarketData';

/**
 * Zdroj ceny z IB Gateway pro vlákno kanálu ceny (běží jen ve vlákně
 * `tv-price-stream.mjs`, INV-WORKER-04). Jen zobrazení (INV-UI-04): odsud
 * cena míří jen do podepsané zprávy kanálu, nikdy do kopírky ani úložišť.
 *
 * Drží spojení na Gateway, přední kontrakt (kontrola rollu jednou za hodinu),
 * odběr všech obchodů (`AllLast`) a kotaci (bid/ask, typ dat). `reading()`
 * vrací poslední cenu a 1m svíčku poskládanou z obchodů, nebo `null`, když
 * zdroji nejde věřit (bez spojení, výpadek, zpožděná data, dlouhé ticho) —
 * vlákno pak čte TradingView. Nikdy nevyhodí.
 */

export const IBKR_STREAM_PORT = 4001;
/** Vlastní clientId workeru; sonda používá 91. */
export const IBKR_STREAM_CLIENT_ID = 92;
/** Bez obchodu déle než tohle = zdroj se nepoužije (TV jako záloha). */
export const IBKR_STALE_MS = 15_000;
/** Vlákno smí jen na IB Gateway (live/paper), ne na TWS — tam Read-Only API nemusí být zapnuté. */
const GATEWAY_PORTS = [4001, 4002];
const CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** Souběžné přihlášení k IBKR (10197): chvíli nechat Gateway na pokoji. */
const COMPETING_SESSION_PAUSE_MS = 60_000;
const ROLL_CHECK_MS = 60 * 60_000;
const ROLL_DAYS = 8;
const MONTH_CODES = 'FGHJKMNQUVXZ';

const REQ = { trades: 2, quote: 3 } as const;
/** Žádosti o kontrakty mají vlastní rostoucí reqId; odpovědi starších se zahodí. */
const CONTRACT_REQ_BASE = 1_000;
const COMPETING_SESSION = 10197;
const CONNECTIVITY_LOST = 1100;
const CONNECTIVITY_RESTORED_DATA_LOST = 1101;
const CONNECTIVITY_RESTORED = 1102;
const SERVER_LINK_BROKEN = 2110;
/** Spojení Gateway na farmu tržních dat spadlo / je zpět. */
const DATA_FARM_BROKEN = 2103;
const DATA_FARM_OK = 2104;
/** Chyby odběru (bez předplatného, neznámý kontrakt, limit odběrů…). */
const SUBSCRIPTION_ERRORS = new Set([200, 322, 354, 10089, 10090, 10167, 10168, 10186, 10189, 10190]);
/** Chyba hodinové kontroly kontraktu: zkusit znovu za chvíli, běžící odběr nechat. */
const CONTRACT_RETRY_MS = 5 * 60_000;
/** Odběr 1m svíček: žádosti mají vlastní rostoucí reqId (odpovědi starších se zahodí). */
const BARS_REQ_BASE = 10_000_000;
const REPAIR_REQ_BASE = 20_000_000;
/** Nový odběr svíček nejdřív za tolik po minulém (pacing historických dat IBKR). */
const BARS_REQUEST_GAP_MS = 15_000;
/** Opravný dotaz na posledních 30 min: zacelí díry a odhalí mrtvý `keepUpToDate`. */
const BARS_REPAIR_EVERY_MS = 5 * 60_000;
/** Obchody chodí, ale odběr svíček mlčí déle než tohle = mrtvý odběr → nový. */
const BARS_SILENT_MS = 3 * 60_000;
const BARS_ERROR_RETRY_MS = 60_000;
/** Okno a strop svíček dne — musí odpovídat `lib/tradingViewBars.ts` (`TV_BARS_MAX`, 27 h). */
export const IBKR_BARS_MAX = 1_700;
export const IBKR_BARS_MAX_AGE_S = 27 * 60 * 60;
/** Gateway ztratila / obnovila spojení na farmu historických dat (HMDS). */
const HMDS_BROKEN = 2105;
const HMDS_OK = 2106;
/** Chyby, které odběr svíček ukončí (ostatní kódy k němu jsou jen informace). */
const BARS_FATAL_ERRORS = new Set([162, 200, 321, 322, 354, 366, 10089, 10090, 10167, 10168, 10186, 10189, 10190]);
const CONTRACT_EMPTY_RETRY_MS = 30_000;

export interface IbkrReading {
  /** `IBKR:MNQZ2026` — kořen se parsuje stejně jako symbol grafu TV. */
  chart: string;
  /** Kontrakt ve formátu TV (`MNQZ2026`). */
  front: string;
  last: number;
  /** [začátek minuty s, open, high, low, close] — vždy celá minuta z obchodů. */
  bar: [number, number, number, number, number];
  bid: number | null;
  ask: number | null;
  mode: 'streaming';
}

/** Svíčky dne pro hlavní vlákno: `bars` = [t, o, h, l, c, v] za sebou (Float64Array, přenositelné). */
export interface IbkrMinuteBars {
  root: string;
  /** `IBKR:MNQZ2026` */
  source: string;
  /** `MNQZ2026` */
  contract: string;
  at: number;
  bars: Float64Array;
}

export interface IbkrTrail {
  /** Začátek minuty v s (stejný jako `bar[0]` čtení). */
  minute: number;
  prices: number[];
}

/** Strop bufferu cesty mezi dvěma čteními (čte se po ~25–250 ms). */
const TRAIL_BUFFER_MAX = 256;

export interface IbkrPriceSourceStats {
  state: 'stopped' | 'connecting' | 'subscribing' | 'live' | 'paused';
  trades: number;
  reconnects: number;
  /** Poslední kód chyby Gateway (nikdy text — může nést účet). */
  lastCode: number | null;
}

export interface IbkrPriceSource {
  start(): void;
  stop(): void;
  reading(): IbkrReading | null;
  /** Úplné 1m svíčky dne předního kontraktu, nebo `null` (neúplné, výpadek, jiný kontrakt). */
  minuteBars(): IbkrMinuteBars | null;
  /**
   * Ceny obchodů rozpracované minuty od minulého volání (sousední shodné
   * sloučené) a vyprázdní je. Jen pro přehrání v grafu (INV-UI-04).
   */
  takeTrail(): IbkrTrail | null;
  stats(): IbkrPriceSourceStats;
}

export interface IbkrPriceSourceDeps {
  symbol?: string;
  port?: number;
  clientId?: number;
  createClient?: (handlers: ReadOnlyIbHandlers) => ReadOnlyIbClient;
  /** Po každém přijatém obchodu (vlákno podle toho pošle cenu hned, ne až v dalším kole). */
  onTrade?: () => void;
  now?: () => number;
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (timer: unknown) => void;
}

/** `MNQZ6` + `20261218` → `MNQZ2026` (formát `front` kanálu ceny). */
export function ibkrFrontToTv(symbol: string, candidate: Pick<FrontContractCandidate, 'localSymbol' | 'lastTradeDate'>): string | null {
  const local = candidate.localSymbol.trim().toUpperCase();
  const root = symbol.trim().toUpperCase();
  const month = local.startsWith(root) ? local.slice(root.length, root.length + 1) : '';
  const year = /^(\d{4})/.exec(candidate.lastTradeDate)?.[1];
  if (!MONTH_CODES.includes(month) || month.length !== 1 || !year) return null;
  return `${root}${month}${year}`;
}

interface MinuteBar { minute: number; open: number; high: number; low: number; close: number }

export function createIbkrPriceSource(deps: IbkrPriceSourceDeps = {}): IbkrPriceSource {
  const symbol = (deps.symbol ?? 'MNQ').toUpperCase();
  const now = deps.now ?? Date.now;
  const schedule = deps.setTimeoutImpl ?? ((callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  });
  const cancel = deps.clearTimeoutImpl ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const port = deps.port ?? IBKR_STREAM_PORT;
  if (!GATEWAY_PORTS.includes(port)) throw new Error(`zdroj ceny smí jen na IB Gateway (${GATEWAY_PORTS.join(', ')})`);
  const createClient = deps.createClient ?? (handlers => createReadOnlyIbClient(
    { port, clientId: deps.clientId ?? IBKR_STREAM_CLIENT_ID }, handlers));

  const stats: IbkrPriceSourceStats = { state: 'stopped', trades: 0, reconnects: 0, lastCode: null };
  let running = false;
  let client: ReadOnlyIbClient | null = null;
  let connected = false;
  let lost = false;
  /** Po 1101 (data mezitím chyběla) platí až nový odběr — žádné hlášení „OK“ to neshodí. */
  let awaitingResubscribe = false;
  let marketDataType: number | null = null;
  let candidates: FrontContractCandidate[] = [];
  let front: FrontContractCandidate | null = null;
  let frontTv: string | null = null;
  let subscribed: FrontContractCandidate | null = null;
  let subscribedAtSec = 0;
  let lastTradesRequestAt: number | null = null;
  let last: IbTrade | null = null;
  let bar: MinuteBar | null = null;
  let bid: number | null = null;
  let ask: number | null = null;
  let trail: IbkrTrail | null = null;
  let failures = 0;
  let contractReqId = CONTRACT_REQ_BASE;
  let rollTimer: unknown = null;
  const history = new Map<number, [number, number, number, number, number, number]>();
  let barsReqId = BARS_REQ_BASE;
  let repairReqId = REPAIR_REQ_BASE;
  let barsActive = false;
  let barsComplete = false;
  let barsConId: number | null = null;
  let barsLastUpdateAt = 0;
  let lastBarsRequestAt: number | null = null;
  let hmdsBroken = false;
  let barsTimer: unknown = null;
  let repairTimer: unknown = null;
  const timers = new Set<unknown>();

  const later = (ms: number, callback: () => void) => {
    const timer = schedule(() => {
      timers.delete(timer);
      if (!running) return;
      try { callback(); } catch { /* zdroj nikdy nevyhodí */ }
    }, ms);
    timers.add(timer);
  };

  const clearTimers = () => {
    for (const timer of timers) cancel(timer);
    timers.clear();
  };

  const forgetData = () => {
    marketDataType = null;
    last = null;
    bar = null;
    trail = null;
    bid = null;
    ask = null;
  };

  const contract = (candidate: FrontContractCandidate) => ({ conId: candidate.conId, exchange: 'CME' });

  const replaceTimer = (current: unknown, ms: number, callback: () => void): unknown => {
    if (current !== null) { cancel(current); timers.delete(current); }
    const timer = schedule(() => {
      timers.delete(timer);
      if (!running) return;
      try { callback(); } catch { /* zdroj nikdy nevyhodí */ }
    }, ms);
    timers.add(timer);
    return timer;
  };

  const forgetBars = () => {
    if (barsActive && client) { try { client.cancelMinuteBars(barsReqId); } catch { /* best effort */ } }
    // Opravný dotaz v letu patří starému odběru (třeba kontraktu před rollem): jeho odpověď zahodit.
    repairReqId += 1;
    barsActive = false;
    barsComplete = false;
    barsConId = null;
    history.clear();
  };

  /** Nový odběr 1m svíček ('2 D' + keepUpToDate) předního kontraktu; nejdřív 15 s po minulém. */
  function startBars() {
    if (!running || !client || !connected || !front) return;
    const wait = (lastBarsRequestAt ?? -Infinity) + BARS_REQUEST_GAP_MS - now();
    if (wait > 0) { barsTimer = replaceTimer(barsTimer, wait, startBars); return; }
    forgetBars();
    const target = front;
    barsReqId += 1;
    barsActive = true;
    barsConId = target.conId;
    lastBarsRequestAt = now();
    barsLastUpdateAt = now();
    client.requestMinuteBars(barsReqId, contract(target), '2 D', true);
    repairTimer = replaceTimer(repairTimer, BARS_REPAIR_EVERY_MS, repairBars);
  }

  /** Opravný dotaz na posledních 30 min; mrtvý odběr (obchody chodí, svíčky ne) = nový odběr. */
  function repairBars() {
    repairTimer = replaceTimer(repairTimer, BARS_REPAIR_EVERY_MS, repairBars);
    if (!running || !client || !connected || !barsActive || barsConId === null) return;
    const tradesFlowing = last !== null && now() - last.receivedAt <= 90_000;
    if (tradesFlowing && now() - barsLastUpdateAt > BARS_SILENT_MS) { startBars(); return; }
    if (!barsComplete) return;
    repairReqId += 1;
    // Na kontrakt aktivního odběru, ne na právě vybraný přední (roll mezi tím).
    client.requestMinuteBars(repairReqId, { conId: barsConId, exchange: 'CME' }, '1800 S', false);
  }

  const storeBar = (bar: { time: number; open: number; high: number; low: number; close: number; volume: number }) => {
    const { time, open, high, low, close } = bar;
    if (![time, open, high, low, close].every(Number.isFinite) || time % 60 !== 0 || !(low > 0) || high < low) return;
    history.set(time, [time, open, high, low, close, Number.isFinite(bar.volume) && bar.volume >= 0 ? bar.volume : 0]);
    // Ořez rovnou při ukládání: mapa nesmí růst s délkou spojení.
    if (history.size > IBKR_BARS_MAX + 120) {
      const oldest = Math.floor(now() / 1_000) - IBKR_BARS_MAX_AGE_S;
      const times = [...history.keys()].sort((a, b) => a - b);
      for (const [index, minute] of times.entries()) {
        if (minute < oldest || index < times.length - IBKR_BARS_MAX) history.delete(minute);
      }
    }
  };

  const unsubscribe = () => {
    if (subscribed && client) {
      try { client.cancelTrades(REQ.trades); } catch { /* best effort */ }
      try { client.cancelVolume(REQ.quote); } catch { /* best effort */ }
    }
    subscribed = null;
    forgetData();
  };

  const subscribe = () => {
    if (!running || !client || !connected || !front) return;
    const wait = nextTradesRequestAt(lastTradesRequestAt) - now();
    if (wait > 0) { later(wait, subscribe); return; }
    if (subscribed) unsubscribe();
    const target = front;
    stats.lastCode = null;
    lastTradesRequestAt = now();
    subscribedAtSec = Math.floor(now() / 1_000);
    subscribed = target;
    lost = false;
    awaitingResubscribe = false;
    stats.state = 'subscribing';
    client.subscribeTrades(REQ.trades, contract(target));
    client.subscribeVolume(REQ.quote, contract(target));
    // Svíčky dne patří ke stejnému kontraktu a po výpadku (1101) se stahují znovu.
    startBars();
  };

  const clearRollTimer = () => {
    if (rollTimer !== null) { cancel(rollTimer); timers.delete(rollTimer); }
    rollTimer = null;
  };

  /** Jediný řetěz kontroly kontraktu (další dotaz za `ms`); teardown ho ruší. */
  const scheduleContracts = (ms: number) => {
    clearRollTimer();
    const timer = schedule(() => {
      timers.delete(timer);
      if (rollTimer === timer) rollTimer = null;
      if (!running) return;
      try { requestContracts(); } catch { /* zdroj nikdy nevyhodí */ }
    }, ms);
    timers.add(timer);
    rollTimer = timer;
  };

  /** Dotaz na kontrakty hned; každá žádost má nové reqId (odpovědi starších se zahodí). */
  function requestContracts() {
    clearRollTimer();
    if (!running || !client || !connected) return;
    candidates = [];
    contractReqId += 1;
    client.requestContractDetails(contractReqId, { symbol, secType: SecType.FUT, exchange: 'CME', currency: 'USD' });
    scheduleContracts(ROLL_CHECK_MS);
  }

  const teardown = () => {
    // Odložené akce (odběr po 15 s, obnova po chybě, kontrola kontraktu) patří starému spojení.
    clearTimers();
    rollTimer = null;
    barsTimer = null;
    repairTimer = null;
    barsActive = false;
    barsComplete = false;
    barsConId = null;
    hmdsBroken = false;
    history.clear();
    const current = client;
    client = null;
    connected = false;
    subscribed = null;
    awaitingResubscribe = false;
    forgetData();
    if (current) { try { current.disconnect(); } catch { /* best effort */ } }
  };

  const reconnectLater = (ms?: number) => {
    teardown();
    if (!running) return;
    if (ms === undefined) stats.state = 'connecting';
    const delay = ms ?? Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(failures, 5));
    failures += 1;
    later(delay, connect);
  };

  const onCode = (code: number, reqId: number) => {
    if (!Number.isFinite(code)) return;
    if (code === COMPETING_SESSION) {
      stats.lastCode = code;
      stats.state = 'paused';
      reconnectLater(COMPETING_SESSION_PAUSE_MS);
      return;
    }
    if (code === CONNECTIVITY_LOST || code === SERVER_LINK_BROKEN || code === DATA_FARM_BROKEN) {
      stats.lastCode = code;
      lost = true;
      return;
    }
    if (code === CONNECTIVITY_RESTORED_DATA_LOST) {
      // Data mezitím chyběla: stará cena se nesmí tvářit živě až do nového odběru.
      stats.lastCode = code;
      awaitingResubscribe = true;
      subscribe();
      return;
    }
    if (code === CONNECTIVITY_RESTORED || code === DATA_FARM_OK) {
      lost = false;
      // Kód výpadku po obnově neplatí (jinak by hlášení dalšího výpadku uvedlo starý důvod).
      if (stats.lastCode === CONNECTIVITY_LOST || stats.lastCode === SERVER_LINK_BROKEN || stats.lastCode === DATA_FARM_BROKEN) stats.lastCode = null;
      return;
    }
    if (code === HMDS_BROKEN) {
      stats.lastCode = code;
      hmdsBroken = true;
      return;
    }
    if (code === HMDS_OK) {
      // 2106 chodí i po každém připojení; nový odběr jen po skutečném výpadku.
      if (hmdsBroken) { hmdsBroken = false; startBars(); }
      return;
    }
    if (reqId === barsReqId && reqId > BARS_REQ_BASE) {
      stats.lastCode = code;
      if (!BARS_FATAL_ERRORS.has(code)) return;
      forgetBars();
      barsTimer = replaceTimer(barsTimer, BARS_ERROR_RETRY_MS, startBars);
      return;
    }
    if (reqId === repairReqId && reqId > REPAIR_REQ_BASE) return;
    if (reqId === contractReqId && reqId >= CONTRACT_REQ_BASE) {
      stats.lastCode = code;
      scheduleContracts(CONTRACT_RETRY_MS);
      return;
    }
    if (SUBSCRIPTION_ERRORS.has(code) && (reqId === REQ.trades || reqId === REQ.quote)) {
      stats.lastCode = code;
      unsubscribe();
      stats.state = 'paused';
      later(RECONNECT_MAX_MS, () => { if (front) subscribe(); else requestContracts(); });
    }
  };

  const handlers: ReadOnlyIbHandlers = {
    onConnected: () => {
      connected = true;
      failures = 0;
      stats.state = 'subscribing';
      client?.requestRealtimeData();
      requestContracts();
    },
    onDisconnected: () => {
      if (!running) return;
      stats.reconnects += 1;
      reconnectLater();
    },
    onError: (code, reqId) => onCode(code, reqId),
    onInfo: code => onCode(code, -1),
    onMarketDataType: (reqId, type) => {
      if (reqId === REQ.quote) marketDataType = type;
    },
    onContractDetails: (reqId, details) => {
      if (reqId !== contractReqId) return;
      const candidate = toFrontCandidate(details);
      if (candidate) candidates.push(candidate);
    },
    onContractDetailsEnd: reqId => {
      if (reqId !== contractReqId) return;
      const picked = pickFrontContract(candidates, now(), ROLL_DAYS);
      const tv = picked ? ibkrFrontToTv(symbol, picked) : null;
      // Prázdná odpověď (Gateway se teprve spojuje s farmou definic): zkusit brzy znovu.
      if (!picked || !tv) { scheduleContracts(CONTRACT_EMPTY_RETRY_MS); return; }
      const changed = picked.conId !== front?.conId;
      front = picked;
      frontTv = tv;
      if (changed || !subscribed) subscribe();
    },
    onTick: (reqId, trade) => {
      if (reqId !== REQ.trades || !subscribed || !(trade.price > 0) || !Number.isFinite(trade.time)) return;
      stats.trades += 1;
      stats.state = 'live';
      last = trade;
      const minute = Math.floor(trade.time / 60) * 60;
      if (!bar || minute > bar.minute) {
        bar = { minute, open: trade.price, high: trade.price, low: trade.price, close: trade.price };
      } else if (minute === bar.minute) {
        bar.high = Math.max(bar.high, trade.price);
        bar.low = Math.min(bar.low, trade.price);
        bar.close = trade.price;
      }
      // Cesta jen rozpracované minuty: nová minuta začíná prázdná, opožděný obchod do ní nepatří.
      if (minute === bar.minute) {
        if (!trail || trail.minute !== minute) trail = { minute, prices: [] };
        if (trail.prices[trail.prices.length - 1] !== trade.price) trail.prices.push(trade.price);
        if (trail.prices.length > TRAIL_BUFFER_MAX) trail.prices.splice(0, trail.prices.length - TRAIL_BUFFER_MAX);
      }
      try { deps.onTrade?.(); } catch { /* zdroj nikdy nevyhodí */ }
    },
    onBar: (reqId, bar) => {
      if (barsActive && (reqId === barsReqId || reqId === repairReqId)) storeBar(bar);
    },
    onBarsEnd: reqId => {
      if (reqId !== barsReqId || !barsActive) return;
      barsComplete = true;
      barsLastUpdateAt = now();
    },
    onBarUpdate: (reqId, bar) => {
      if (reqId !== barsReqId || !barsActive) return;
      storeBar(bar);
      barsLastUpdateAt = now();
    },
    onQuote: (reqId, side, price) => {
      if (reqId !== REQ.quote || !subscribed) return;
      const value = price > 0 ? price : null;
      if (side === 'bid') bid = value; else ask = value;
    },
  };

  function connect() {
    if (!running) return;
    teardown();
    stats.state = 'connecting';
    let created: ReadOnlyIbClient | null = null;
    // Události starého spojení (pozdní disconnect po teardownu) se zahodí.
    const current = <A extends unknown[]>(handler?: (...args: A) => void) =>
      (...args: A) => { if (created && client === created) { try { handler?.(...args); } catch { /* nikdy nevyhodí */ } } };
    const bound: ReadOnlyIbHandlers = {
      onConnected: current(handlers.onConnected),
      onDisconnected: current(handlers.onDisconnected),
      onError: current(handlers.onError),
      onInfo: current(handlers.onInfo),
      onMarketDataType: current(handlers.onMarketDataType),
      onContractDetails: current(handlers.onContractDetails),
      onContractDetailsEnd: current(handlers.onContractDetailsEnd),
      onTick: current(handlers.onTick),
      onQuote: current(handlers.onQuote),
      onBar: current(handlers.onBar),
      onBarsEnd: current(handlers.onBarsEnd),
      onBarUpdate: current(handlers.onBarUpdate),
    };
    try {
      created = createClient(bound);
      client = created;
      client.connect();
    } catch {
      reconnectLater();
      return;
    }
    const attempt = client;
    later(CONNECT_TIMEOUT_MS, () => { if (client === attempt && !connected) reconnectLater(); });
  }

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      connect();
    },
    stop() {
      running = false;
      clearTimers();
      if (client && subscribed) unsubscribe();
      teardown();
      stats.state = 'stopped';
    },
    reading() {
      try {
        if (!running || !connected || lost || awaitingResubscribe || !subscribed || !last || !frontTv || marketDataType !== 1) return null;
        if (subscribed.conId !== front?.conId) return null;
        if (now() - last.receivedAt > IBKR_STALE_MS) return null;
        // Čtení až s první celou minutou po odběru — dřív by svíčka neměla skutečné
        // open/high/low a klient by P&L i svíčku stejně zahodil (vlákno zatím čte TV).
        const fullBar = bar && bar.minute >= Math.ceil(subscribedAtSec / 60) * 60 ? bar : null;
        if (!fullBar) return null;
        const quoteValid = bid !== null && ask !== null && bid <= ask;
        return {
          chart: `IBKR:${frontTv}`,
          front: frontTv,
          last: last.price,
          bar: [fullBar.minute, fullBar.open, fullBar.high, fullBar.low, fullBar.close],
          bid: quoteValid ? bid : null,
          ask: quoteValid ? ask : null,
          mode: 'streaming',
        };
      } catch {
        return null;
      }
    },
    minuteBars() {
      try {
        if (!running || !connected || lost || awaitingResubscribe || hmdsBroken || !barsComplete || !frontTv) return null;
        if (barsConId === null || barsConId !== front?.conId) return null;
        const at = now();
        const oldest = Math.floor(at / 1_000) - IBKR_BARS_MAX_AGE_S;
        const rows = [...history.values()].filter(row => row[0] >= oldest).sort((a, b) => a[0] - b[0]).slice(-IBKR_BARS_MAX);
        if (!rows.length) return null;
        const bars = new Float64Array(rows.length * 6);
        rows.forEach((row, index) => bars.set(row, index * 6));
        return { root: symbol, source: `IBKR:${frontTv}`, contract: frontTv, at, bars };
      } catch {
        return null;
      }
    },
    takeTrail() {
      const taken = trail;
      trail = null;
      return taken && taken.prices.length ? taken : null;
    },
    stats: () => ({ ...stats }),
  };
}

/** IBKR bez platného čtení déle než tohle → záloha TV. */
export const IBKR_FALLBACK_AFTER_MS = 3_000;
/** Zpět na IBKR až po souvislé době s platným čtením (žádné cukání mezi zdroji). */
export const IBKR_RETURN_AFTER_MS = 5_000;

export interface PriceSourceSwitch {
  active: 'tv' | 'ibkr';
  okSince: number | null;
  missingSince: number | null;
}

export const initialPriceSourceSwitch = (): PriceSourceSwitch => ({ active: 'tv', okSince: null, missingSince: null });

/**
 * Výběr zdroje ve vlákně podle toho, zda má IBKR platné čtení. Start vždy na
 * TV; na IBKR až po `IBKR_RETURN_AFTER_MS` souvislé dostupnosti, zpět na TV
 * po `IBKR_FALLBACK_AFTER_MS` bez čtení. `changed` = vlákno založí nový běh.
 */
export function nextPriceSource(state: PriceSourceSwitch, ibkrAvailable: boolean, at: number): { state: PriceSourceSwitch; changed: boolean } {
  const okSince = ibkrAvailable ? state.okSince ?? at : null;
  const missingSince = ibkrAvailable ? null : state.missingSince ?? at;
  const active: 'tv' | 'ibkr' = state.active === 'ibkr'
    ? (ibkrAvailable || at - (missingSince ?? at) < IBKR_FALLBACK_AFTER_MS ? 'ibkr' : 'tv')
    : (ibkrAvailable && at - (okSince ?? at) >= IBKR_RETURN_AFTER_MS ? 'ibkr' : 'tv');
  return { state: { active, okSince, missingSince }, changed: active !== state.active };
}
