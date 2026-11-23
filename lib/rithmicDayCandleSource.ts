/**
 * Dnešní svíčky grafu deníku z místní služby Rithmicu — JEN ČTENÍ a jen zobrazení (INV-UI-01).
 *
 * Zdroj se ke službě připojí stejným spojením jako LIVE graf, ale neposílá jí NIC (ani měření; spárované
 * zařízení jen svůj klíč při přihlášení): poslouchá úvodní zprávu (`hello` se svíčkami), ticky a tep.
 * Nic odsud nesmí rozhodovat o obchodu ani o riziku.
 *
 * Služba drží na jedno spárované zařízení nejvýš dvě spojení a třetí vyhodí nejstarší. Deník a LIVE graf jsou
 * různé stránky (nikdy nejsou otevřené zároveň), takže obchodní spojení zůstává samo; další pasivní čtenář
 * vedle LIVE grafu by ho mohl vyhodit — nepřidávat bez změny služby.
 *
 * Když služba neběží, zkouší se spojení jen jednou za 20 s a graf po 5 s přestane čekat.
 *
 * Stav:
 *  - `loading`      první pokus o spojení ještě nedoběhl;
 *  - `live`         služba běží a její ceny jsou čerstvé;
 *  - `stale`        svíčky jsou, ale služba mlčí, spojení spadlo nebo trh stojí;
 *  - `unavailable`  služba neběží, zařízení odmítla, nebo posílá jiný trh (zkušební Rithmic Test, jiný kontrakt).
 */
import type { MarketCandle } from '../services/marketDataCalculations';
import { futuresSymbolRoot } from '../services/futuresContractSpecs';
import type { LiveCandleFeed } from './liveCandleFeed';
import { mergeSeedCandles } from './rithmicCandleSeed';
import { RithmicLocalConnection, type RithmicLinkHandlers, type RithmicLinkOptions } from './rithmicLocalConnection';

export type RithmicDayCandleStatus = 'loading' | 'live' | 'stale' | 'unavailable';

export interface RithmicDayCandleSnapshot {
  status: RithmicDayCandleStatus;
  /** Dokončené minutové svíčky (rozpracovanou drží `feed`). */
  candles: readonly MarketCandle[];
  /** Kontrakt služby (`MNQZ6`), nebo null. */
  symbol: string | null;
  /** Kdy naposledy přišla čerstvá cena (ms), nebo null. */
  capturedAt: number | null;
}

export interface RithmicDayCandleSource {
  subscribe(listener: () => void): () => void;
  snapshot(): RithmicDayCandleSnapshot;
  feed: LiveCandleFeed;
  start(): void;
  stop(): void;
}

interface Connection { start(): void; stop(): void }

export interface RithmicDayCandleSourceOptions {
  url: string;
  auth?: RithmicLinkOptions['auth'];
  /** Kořen grafu, pro který svíčky platí (deník kreslí MNQ; NQ má stejnou cenu). */
  root?: string;
  now?: () => number;
  connect?: (options: RithmicLinkOptions) => Connection;
  /** Jen pro zkoušky: falešný socket pod skutečným spojením. */
  socketFactory?: RithmicLinkOptions['socketFactory'];
}

/** Zkušební systém Rithmicu je simulovaný trh — ke skutečné historii deníku nepatří. */
const SIMULATED_SYSTEM = 'Rithmic Test';
/** Pasivní čtenář nespěchá: s vypnutou službou jeden pokus za 20 s (obchodní spojení zkouší po 2 s). */
const RECONNECT_MS = 20_000;
/** Jak dlouho smí graf čekat na první odpověď služby, než řekne „nedostupné“ (visící spojení, spící Mac). */
const FIRST_REPLY_TIMEOUT_MS = 5_000;

const family = (root: string): string => (root === 'MNQ' || root === 'NQ' ? 'NQ' : root === 'MES' || root === 'ES' ? 'ES' : root);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function candleOf(raw: unknown): MarketCandle | null {
  if (!raw || typeof raw !== 'object') return null;
  const bar = raw as Record<string, unknown>;
  if (!finite(bar.time) || !finite(bar.open) || !finite(bar.high) || !finite(bar.low) || !finite(bar.close)) return null;
  return { time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: finite(bar.volume) ? bar.volume : 0 };
}

const EMPTY: RithmicDayCandleSnapshot = { status: 'loading', candles: [], symbol: null, capturedAt: null };

export function createRithmicDayCandleSource(options: RithmicDayCandleSourceOptions): RithmicDayCandleSource {
  const now = options.now ?? Date.now;
  const wantedFamily = family((options.root ?? 'MNQ').trim().toUpperCase());
  const listeners = new Set<() => void>();
  const feedListeners = new Set<() => void>();
  let snapshot: RithmicDayCandleSnapshot = EMPTY;
  /** Zdroj svíček (systém, účet, kontrakt): jiný zdroj svíčky nahradí, stejný je spojí. */
  let scope: string | null = null;
  /** Služba posílá trh tohoto grafu (správný kontrakt, ne zkušební systém). */
  let accepted = false;
  let linkOpen = false;
  let feedLive = false;
  let forming: MarketCandle | null = null;
  let lastPrice: number | null = null;
  let firstReplyTimer: ReturnType<typeof setTimeout> | null = null;

  const publish = (next: Partial<RithmicDayCandleSnapshot>) => {
    const merged = { ...snapshot, ...next };
    if (merged.status === snapshot.status && merged.candles === snapshot.candles && merged.symbol === snapshot.symbol && merged.capturedAt === snapshot.capturedAt) return;
    snapshot = merged;
    for (const listener of [...listeners]) listener();
  };
  const notifyFeed = () => { for (const listener of [...feedListeners]) listener(); };
  /** Čas poslední čerstvé ceny po minutách: tep chodí každou sekundu a deník se kvůli němu nemá překreslovat. */
  const stamp = () => Math.floor(now() / 60_000) * 60_000;
  const status = (): RithmicDayCandleStatus => (!accepted ? 'unavailable' : linkOpen && feedLive ? 'live' : 'stale');
  const dropLive = () => {
    feedLive = false;
    if (forming !== null || lastPrice !== null) { forming = null; lastPrice = null; notifyFeed(); }
  };

  const feed: LiveCandleFeed = {
    subscribe(listener) {
      feedListeners.add(listener);
      return () => { feedListeners.delete(listener); };
    },
    current: root => (accepted && feedLive && family(root.trim().toUpperCase()) === wantedFamily ? forming : null),
    lastPrice: root => (accepted && feedLive && family(root.trim().toUpperCase()) === wantedFamily ? lastPrice : null),
    front: () => (accepted ? snapshot.symbol : null),
    // Důkaz stejného kontraktu jen když poslední svíčky grafu dala tatáž služba (jinak navazuje na historii
    // jiného zdroje a pojistka skoku ceny zůstává zapnutá).
    contractMatchesData: () => accepted && snapshot.candles.length > 0,
  };

  const handlers: RithmicLinkHandlers = {
    onLink(state) {
      linkOpen = state === 'open';
      if (linkOpen) return; // stav určí až `hello` z nového spojení
      dropLive();
      // Služba neběží (první pokus selhal) → graf nečeká donekonečna; se svíčkami zůstává poslední obraz jako starý.
      if (state === 'closed') publish({ status: accepted ? 'stale' : 'unavailable' });
    },
    onSessionReset() {
      dropLive();
      if (accepted) publish({ status: 'stale' });
    },
    onSilent(silent) {
      if (!silent) return;
      dropLive();
      if (accepted) publish({ status: 'stale' });
    },
    onUncertain() { /* zdroj neposílá žádné příkazy */ },
    onAuthFailed() {
      accepted = false;
      dropLive();
      publish({ status: 'unavailable', candles: [], symbol: null, capturedAt: null });
    },
    onMessage(message) {
      if (message.type === 'hello') {
        const symbol = typeof message.symbol === 'string' ? message.symbol : '';
        const system = typeof message.system === 'string' ? message.system : '';
        const nextScope = JSON.stringify([system, message.account ?? null, symbol]);
        const fits = Boolean(symbol) && Boolean(system) && system !== SIMULATED_SYSTEM && family(futuresSymbolRoot(symbol)) === wantedFamily;
        if (!fits) {
          accepted = false;
          scope = null;
          dropLive();
          publish({ status: 'unavailable', candles: [], symbol: null, capturedAt: null });
          return;
        }
        const bars = (Array.isArray(message.bars) ? message.bars : []).map(candleOf).filter((bar): bar is MarketCandle => bar !== null);
        const sameSource = accepted && scope === nextScope;
        scope = nextScope;
        accepted = true;
        const price = finite(message.price) ? message.price : null;
        feedLive = message.feed === true && price !== null;
        // Poslední svíčka úvodní zprávy je rozpracovaná minuta: patří do živé svíčky, ne mezi dokončené.
        const minute = Math.floor(now() / 60_000) * 60;
        const last = bars.at(-1) ?? null;
        const open = feedLive && last !== null && last.time >= minute ? last : null;
        const finished = open ? bars.slice(0, -1) : bars;
        forming = open;
        lastPrice = feedLive ? price : null;
        publish({
          status: status(),
          candles: mergeSeedCandles(snapshot.candles, finished, sameSource),
          symbol,
          capturedAt: feedLive ? stamp() : snapshot.capturedAt,
        });
        notifyFeed();
        return;
      }
      if (!accepted) return;
      if (message.type === 'beat') {
        const live = message.feed === true;
        if (!live) dropLive(); else feedLive = true;
        publish({ status: status(), capturedAt: live ? stamp() : snapshot.capturedAt });
        return;
      }
      if (message.type !== 'tick' || message.symbol !== snapshot.symbol) return;
      const bar = candleOf(message.bar);
      const price = finite(message.price) ? message.price : null;
      if (price === null && bar === null) return;
      const previous = forming;
      feedLive = true;
      if (price !== null) lastPrice = price;
      if (bar) forming = bar;
      // Nová minuta: dokončená svíčka se zapíše mezi svíčky dne (jednou za minutu, ne při každém ticku).
      if (previous && bar && bar.time > previous.time) {
        const kept = snapshot.candles.filter(candle => candle.time < previous.time);
        publish({ status: status(), candles: [...kept, previous], capturedAt: stamp() });
      } else if (snapshot.status !== 'live') {
        publish({ status: status(), capturedAt: stamp() });
      }
      notifyFeed();
    },
  };

  const connection: Connection = (options.connect ?? (linkOptions => new RithmicLocalConnection(linkOptions)))({
    url: options.url,
    auth: options.auth,
    handlers,
    now,
    socketFactory: options.socketFactory,
    reconnectMs: RECONNECT_MS,
    measure: false,
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => snapshot,
    feed,
    start: () => {
      connection.start();
      if (firstReplyTimer === null) firstReplyTimer = setTimeout(() => {
        firstReplyTimer = null;
        if (snapshot.status === 'loading') publish({ status: 'unavailable' });
      }, FIRST_REPLY_TIMEOUT_MS);
    },
    stop: () => {
      if (firstReplyTimer !== null) { clearTimeout(firstReplyTimer); firstReplyTimer = null; }
      connection.stop();
      linkOpen = false;
      dropLive();
    },
  };
}
