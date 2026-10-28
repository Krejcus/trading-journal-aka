import { TV_PRICE_TRAIL_MAX, type TvPriceEnvelope, type TvPricePayload, type TvPriceTrail } from '../lib/tvPriceMessage';

/**
 * Jádro kanálu ceny z TradingView (běží ve vlákně workeru, INV-WORKER-04).
 * Čte poslední svíčku a kotaci vybraného panelu a posílá podepsané zprávy
 * jen když se dívá klient (presence `pnl`/`chart`) a kanál je připojený.
 * Jen zobrazení — nic odsud nevstupuje do kopírky ani do rozhodování
 * (pravidlo v `lib/tradingViewBars.ts`, INV-UI-04).
 *
 * Všechny vstupy a výstupy jsou injektované, aby šlo chování ověřit bez
 * TV a bez sítě. Nikdy nevyhodí: chyba čtení, podpisu i odeslání = skip.
 */

export const TV_STREAM_FAST_MS = 250;
export const TV_STREAM_IDLE_CHECK_MS = 1_000;
/** I beze změny ceny aspoň 1 zpráva/s — ticho až ~3 s nesmí vypadat jako výpadek. */
export const TV_STREAM_HEARTBEAT_MS = 1_000;
export const TV_STREAM_MAX_PER_SECOND = 5;
/** Po chybě čtení se chvíli nečte (CDP mohlo spadnout; vlákno obnoví spojení). */
export const TV_STREAM_ERROR_BACKOFF_MS = 1_000;
/**
 * Okamžité posílání (`nudge`): IBKR posílá obchody v dávkách ~2×/s, dávka
 * trvá typicky 8 ms (p90 20 ms, měření 28. 10.). Čeká se 25 ms, aby šla celá
 * dávka jednou zprávou. Rozestup zpráv = strop rozložený rovnoměrně: při
 * souvislém proudu obchodů zprávy jdou po 200 ms, ne 5 naráz a pak ticho.
 */
export const TV_STREAM_NUDGE_COALESCE_MS = 25;
export const TV_STREAM_MIN_GAP_MS = 1_000 / TV_STREAM_MAX_PER_SECOND;

/**
 * Smí vlákno odeslat zprávu do kanálu? Shodné s `_canPush` realtime-js:
 * bez připojeného socketu a joinutého kanálu by `send()` tiše přešel na REST
 * POST (+ varování za každou zprávu).
 */
export const realtimeChannelCanPush = (connected: boolean, state: string | undefined): boolean =>
  connected && state === 'joined';

export interface TvStreamReading {
  chart: string;
  interval: string;
  pane: number;
  /** [čas otevření s, open, high, low, close] */
  bar: [number, number, number, number, number] | null;
  last: number | null;
  bid: number | null;
  ask: number | null;
  mode: string | null;
  /** Nové ceny obchodů rozpracované minuty od minulého čtení (jen IBKR). */
  trail?: { minute: number; prices: number[] } | null;
}

export interface TvStreamMeta {
  front: string | null;
  switchAt: number | null;
}

export interface TvPriceStreamDeps {
  /** Jedno read-only čtení vybraného panelu; `null` = panel teď není k dispozici. */
  read: () => Promise<TvStreamReading | null>;
  meta: () => TvStreamMeta;
  /** Presence: některý viditelný klient zobrazuje P&L nebo živý graf. */
  demand: () => boolean;
  /** Kanál je `joined` a po (re)joinu přišel presence `sync`. */
  ready: () => boolean;
  sign: (payload: TvPricePayload) => Promise<TvPriceEnvelope | null>;
  /** Podpis cesty ceny k podepsané zprávě; `null` = zpráva jde bez cesty. */
  signTrail?: (trail: TvPriceTrail, payload: TvPricePayload) => Promise<{ t: string; ts: string } | null>;
  /** Odeslání podepsané zprávy; `false` = neodesláno. Nesmí čekat na REST fallback. */
  publish: (envelope: TvPriceEnvelope) => Promise<boolean>;
  runId: string;
  now?: () => number;
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (timer: unknown) => void;
}

export interface TvPriceStreamStats {
  state: 'idle' | 'streaming' | 'stopped';
  reads: number;
  sends: number;
  skippedRateCap: number;
  errors: number;
  lastSendAt: number | null;
}

export interface TvPriceStream {
  start(): void;
  stop(): void;
  /**
   * Zdroj má nová data (dávka obchodů IBKR): přečíst a poslat hned, ne až
   * v dalším kole po 250 ms. Strop zpráv i podpis platí stejně; mimo
   * streamování nic nedělá. Nikdy nevyhodí.
   */
  nudge(): void;
  stats(): TvPriceStreamStats;
}

/**
 * Co je „změna“, kvůli které se posílá hned. Bid/ask se posílají v každé
 * zprávě, ale samy zprávu nevyvolají: appka je nezobrazuje a jejich změny
 * (u IBKR ~4×/s) by ubraly ze stropu zpráv obchodům.
 */
const signature = (reading: TvStreamReading) =>
  `${reading.chart}|${reading.interval}|${reading.pane}|${reading.bar?.join(',') ?? '-'}|${reading.last}|${reading.mode}`;

export function createTvPriceStream(deps: TvPriceStreamDeps): TvPriceStream {
  const now = deps.now ?? Date.now;
  const schedule = deps.setTimeoutImpl ?? ((callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  });
  const cancel = deps.clearTimeoutImpl ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const stats: TvPriceStreamStats = { state: 'idle', reads: 0, sends: 0, skippedRateCap: 0, errors: 0, lastSendAt: null };
  let timer: unknown = null;
  let timerDue = 0;
  let stopped = true;
  let inFlight = false;
  /** `nudge` během čtení: po něm se čte znovu hned (s ohledem na rozestup). */
  let nudged = false;
  /** Po chybě čtení/odeslání `nudge` nečte dřív než po prodlevě (žádná smyčka pokusů). */
  let backoffUntil = 0;
  /** Ceny obchodů od minulé odeslané zprávy (rozpracovaná minuta) — cesta pro přehrání v grafu. */
  let pendingTrail: { minute: number; prices: number[] } | null = null;
  /** Po nečinnosti zahodit cestu prvního čtení (nashromážděná ve zdroji, nikdo ji neviděl). */
  let dropNextTrail = false;

  const collectTrail = (reading: TvStreamReading) => {
    const minute = reading.bar?.[0];
    if (minute === undefined || (pendingTrail && pendingTrail.minute !== minute)) pendingTrail = null;
    const fresh = reading.trail;
    if (dropNextTrail) { dropNextTrail = false; return; }
    if (minute === undefined || !fresh || fresh.minute !== minute) return;
    pendingTrail ??= { minute, prices: [] };
    for (const price of fresh.prices) {
      if (pendingTrail.prices[pendingTrail.prices.length - 1] !== price) pendingTrail.prices.push(price);
    }
    if (pendingTrail.prices.length > TV_PRICE_TRAIL_MAX) pendingTrail.prices.splice(0, pendingTrail.prices.length - TV_PRICE_TRAIL_MAX);
  };

  /** Cesta k odesílané zprávě: jen s víc než jednou cenou a končící její poslední cenou. */
  const trailFor = async (payload: TvPricePayload): Promise<{ t: string; ts: string } | null> => {
    const trail = pendingTrail;
    if (!deps.signTrail || !trail || trail.prices.length < 2 || !payload.bar || trail.minute !== payload.bar[0]) return null;
    if (trail.prices[trail.prices.length - 1] !== payload.last) return null;
    try {
      return await deps.signTrail({ v: 1, runId: payload.runId, seq: payload.seq, minute: trail.minute, path: trail.prices.slice() }, payload);
    } catch {
      return null;
    }
  };
  let seq = 0;
  let lastSignature: string | null = null;
  const sendTimes: number[] = [];

  const next = (ms: number) => {
    if (stopped) return;
    timerDue = now() + ms;
    timer = schedule(() => { timer = null; void tick(); }, ms);
  };

  /** Prodleva čtení po `nudge`: doběhnutí dávky a rozestup od poslední zprávy. */
  const nudgeDelay = () => Math.max(
    TV_STREAM_NUDGE_COALESCE_MS,
    stats.lastSendAt === null ? 0 : TV_STREAM_MIN_GAP_MS - (now() - stats.lastSendAt),
  );

  const withinRateCap = (at: number) => {
    while (sendTimes.length && at - sendTimes[0] >= 1_000) sendTimes.shift();
    return sendTimes.length < TV_STREAM_MAX_PER_SECOND;
  };

  const tick = async () => {
    if (stopped) return;
    let ready = false;
    let wanted = false;
    try {
      ready = deps.ready();
      wanted = deps.demand();
    } catch {
      stats.errors += 1;
    }
    if (!ready || !wanted) {
      stats.state = 'idle';
      // Po návratu poslechu se pošle hned i neměnná cena (klient potřebuje první zprávu).
      lastSignature = null;
      pendingTrail = null;
      dropNextTrail = true;
      next(TV_STREAM_IDLE_CHECK_MS);
      return;
    }
    stats.state = 'streaming';
    if (inFlight) { next(TV_STREAM_FAST_MS); return; }
    inFlight = true;
    const startedAt = now();
    let delay = TV_STREAM_FAST_MS;
    try {
      const reading = await deps.read();
      stats.reads += 1;
      if (stopped || !reading) return;
      collectTrail(reading);
      const at = now();
      const current = signature(reading);
      const heartbeatDue = stats.lastSendAt === null || at - stats.lastSendAt >= TV_STREAM_HEARTBEAT_MS;
      if (current === lastSignature && !heartbeatDue) return;
      if (!withinRateCap(at)) { stats.skippedRateCap += 1; return; }
      const meta = deps.meta();
      const payload: TvPricePayload = {
        v: 1, seq, runId: deps.runId, chart: reading.chart, interval: reading.interval, pane: reading.pane,
        front: meta.front, switchAt: meta.switchAt, mode: reading.mode, bar: reading.bar,
        last: reading.last, bid: reading.bid, ask: reading.ask, at: Math.round(at),
      };
      const signed = await deps.sign(payload);
      if (stopped || !signed) return;
      const trailPart = await trailFor(payload);
      if (stopped || !deps.ready()) return;
      const envelope: TvPriceEnvelope = trailPart ? { ...signed, ...trailPart } : signed;
      if (await deps.publish(envelope)) {
        pendingTrail = null;
        seq += 1;
        sendTimes.push(at);
        stats.sends += 1;
        stats.lastSendAt = at;
        lastSignature = current;
      }
    } catch {
      stats.errors += 1;
      delay = TV_STREAM_ERROR_BACKOFF_MS;
      backoffUntil = now() + TV_STREAM_ERROR_BACKOFF_MS;
    } finally {
      inFlight = false;
      let wait = Math.max(0, delay - (now() - startedAt));
      // Po chybě čtení platí prodleva i pro `nudge` (CDP/zdroj se zotavuje).
      if (nudged && delay !== TV_STREAM_ERROR_BACKOFF_MS) wait = Math.min(wait, nudgeDelay());
      nudged = false;
      next(wait);
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      stats.state = 'idle';
      next(0);
    },
    stop() {
      stopped = true;
      stats.state = 'stopped';
      if (timer !== null) cancel(timer);
      timer = null;
    },
    nudge() {
      try {
        if (stopped || stats.state !== 'streaming' || now() < backoffUntil) return;
        // Jeden řetěz časovačů: během čtení se jen poznamená, pak se čte znovu.
        if (inFlight) { nudged = true; return; }
        const wait = nudgeDelay();
        // Čtení naplánované dřív (dávka už čeká nebo běžné kolo) přečte i tahle data.
        if (timer !== null && timerDue <= now() + wait) return;
        if (timer !== null) cancel(timer);
        timer = null;
        next(wait);
      } catch {
        stats.errors += 1;
      }
    },
    stats: () => ({ ...stats }),
  };
}
