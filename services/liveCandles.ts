import { tvLiveBarsStoragePath, tvSymbolRoot } from '../lib/tradingViewBars';
import { inspectCandleSnapshot, type CandleFileProblem, type CandleValidation } from '../lib/candleSnapshotValidation';
import type { MarketCandle, MarketCandleResponse } from './marketDataCalculations';
import { provisionalResponse } from './provisionalCandles';
import { supabase } from './supabase';

/**
 * Živé 1m svíčky pro přípravu a pohled dne. Worker je 1×/min čte z grafu
 * TradingView (read-only CDP) a přepisuje jeden soubor v soukromém bucketu.
 * Databento historical má ~24 h zpoždění, takže dnešní noc a včerejší NY
 * jsou dostupné jen odsud. Jen zobrazení člověku na obrazovce — nikdy risk
 * brány, day lock, limity, kopírka ani jiná automatika (licence dat
 * TradingView je jen pro zobrazení; pravidlo v `lib/tradingViewBars.ts`).
 */

const BUCKET = 'copier-snapshots';

/**
 * Čtení starší než tohle znamená, že worker nebo TradingView neběží. Worker
 * i beze změny grafu posílá čtení nejpozději po 2 min, takže klidný trh
 * (přestávka, víkend) se za výpadek nevydává.
 */
export const LIVE_CANDLES_STALE_MS = 5 * 60_000;
/**
 * Spekulativní čtení z LIVE dashboardu čeká v paměti jen krátce. Je
 * jednorázové: první skutečný loader grafu ho spotřebuje, takže minutový poll
 * dál vždy čte nový soubor a nezůstane přilepený na staré svíčce.
 */
export const LIVE_CANDLES_WARM_TTL_MS = 45_000;

export interface LiveCandles {
  response: MarketCandleResponse;
  /** Hodiny workeru v okamžiku čtení (epoch ms). */
  capturedAt: number;
  /** Čtení je starší než `LIVE_CANDLES_STALE_MS` — graf stojí. */
  stale: boolean;
  validation?: CandleValidation;
  /** First paint may reuse preload; the hook immediately follows it with a fresh read. */
  fromWarmCache?: boolean;
}

export class LiveCandlesReadError extends Error {
  constructor(public readonly problem: CandleFileProblem) { super(problem); this.name = 'LiveCandlesReadError'; }
}

interface LiveCandlesIdentity {
  root: string;
  userId: string;
  key: string;
}

interface PendingLiveCandles {
  promise: Promise<LiveCandles | null>;
  /** Otevřený graf už stejný rozpracovaný požadavek převzal. */
  consumed: boolean;
}

const warmLiveCandles = new Map<string, { value: LiveCandles; loadedAt: number }>();
const pendingLiveCandles = new Map<string, PendingLiveCandles>();

const pruneWarmLiveCandles = (now: number): void => {
  warmLiveCandles.forEach((entry, key) => {
    if (now - entry.loadedAt > LIVE_CANDLES_WARM_TTL_MS) warmLiveCandles.delete(key);
  });
};

const liveCandlesIdentity = async (symbol: string): Promise<LiveCandlesIdentity | null> => {
  const root = tvSymbolRoot(symbol);
  if (!root) return null;
  const { data: auth } = await supabase.auth.getSession();
  const userId = auth.session?.user.id;
  return userId ? { root, userId, key: `${userId}|${root}` } : null;
};

const withCurrentStaleness = (value: LiveCandles | null, now: number): LiveCandles | null => value
  ? { ...value, stale: now - value.capturedAt > LIVE_CANDLES_STALE_MS }
  : null;

const downloadLiveCandles = async (identity: LiveCandlesIdentity, now: number): Promise<LiveCandles | null> => {
  const { data, error } = await supabase.storage.from(BUCKET).download(tvLiveBarsStoragePath(identity.userId, identity.root));
  if (error || !data) {
    const failure = error as unknown as { status?: unknown; statusCode?: unknown } | null;
    const status = Number(failure?.statusCode ?? failure?.status);
    throw new LiveCandlesReadError(status === 404 ? 'snapshot-missing' : status === 401 || status === 403 ? 'access-denied' : 'download-failed');
  }
  const text = await data.text();
  const inspected = inspectCandleSnapshot(text, identity.root, now);
  if (inspected.ok === false) throw new LiveCandlesReadError(inspected.problem);
  return parsedLiveCandles(inspected, identity.root, now);
};

const startLiveCandlesRequest = (identity: LiveCandlesIdentity, now: number, preload: boolean): PendingLiveCandles => {
  const entry = {} as PendingLiveCandles;
  entry.consumed = !preload;
  entry.promise = downloadLiveCandles(identity, now).finally(() => {
    if (pendingLiveCandles.get(identity.key) === entry) pendingLiveCandles.delete(identity.key);
  });
  pendingLiveCandles.set(identity.key, entry);
  return entry;
};

/** Rozparsuje uložený soubor; vadný obsah = `null`, nikdy výjimka. */
export function parseLiveCandlesFile(text: string, root: string, now = Date.now()): LiveCandles | null {
  const inspected = inspectCandleSnapshot(text, root, now);
  return inspected.ok ? parsedLiveCandles(inspected, root, now) : null;
}

function parsedLiveCandles(body: Extract<ReturnType<typeof inspectCandleSnapshot>, { ok: true }>, root: string, now: number): LiveCandles {
  return {
    response: provisionalResponse(body.bars, root, body.source),
    capturedAt: body.at,
    stale: now - body.at > LIVE_CANDLES_STALE_MS,
    validation: body.validation,
  };
}

/** Poslední živé čtení pro kořen (MNQ i NQ sdílí jeden soubor). */
export async function loadLiveCandles(symbol: string, now = Date.now()): Promise<LiveCandles | null> {
  const identity = await liveCandlesIdentity(symbol);
  if (!identity) return null;
  pruneWarmLiveCandles(now);
  const warm = warmLiveCandles.get(identity.key);
  if (warm) {
    warmLiveCandles.delete(identity.key);
    if (now - warm.loadedAt <= LIVE_CANDLES_WARM_TTL_MS) return { ...withCurrentStaleness(warm.value, now)!, fromWarmCache: true };
  }
  const pending = pendingLiveCandles.get(identity.key);
  if (pending) {
    const fromPreload = !pending.consumed;
    pending.consumed = true;
    const value = await pending.promise;
    warmLiveCandles.delete(identity.key);
    const current = withCurrentStaleness(value, now);
    return current && fromPreload ? { ...current, fromWarmCache: true } : current;
  }
  return startLiveCandlesRequest(identity, now, false).promise;
}

/**
 * Připraví první svíčky pro očekávané otevření LIVE grafu. Cache je pouze
 * paměťová, oddělená podle přihlášeného uživatele a spotřebuje ji jen první
 * `loadLiveCandles`; P&L ani copier ji nikdy nečtou.
 */
export async function preloadLiveCandles(symbol: string, now = Date.now()): Promise<void> {
  const identity = await liveCandlesIdentity(symbol);
  if (!identity) return;
  pruneWarmLiveCandles(now);
  const warm = warmLiveCandles.get(identity.key);
  if (warm && now - warm.loadedAt <= LIVE_CANDLES_WARM_TTL_MS) return;
  if (warm) warmLiveCandles.delete(identity.key);
  const pending = pendingLiveCandles.get(identity.key);
  if (pending) {
    await pending.promise.catch(() => undefined);
    return;
  }
  const entry = startLiveCandlesRequest(identity, now, true);
  const value = await entry.promise.catch(() => null);
  if (value && !entry.consumed) warmLiveCandles.set(identity.key, { value, loadedAt: now });
}

/**
 * Sešije historii (Databento) s živým čtením: historie platí, dokud ji
 * máme, živé svíčky doplní jen čas za její poslední svíčkou. Rozpracovaná
 * poslední minuta živého čtení tak nikdy nepřepíše dokončenou historickou.
 */
export function stitchLiveCandles(historical: readonly MarketCandle[], live: readonly MarketCandle[]): MarketCandle[] {
  const lastHistorical = historical.length ? historical[historical.length - 1].time : -Infinity;
  return [...historical, ...live.filter(candle => candle.time > lastHistorical)];
}
