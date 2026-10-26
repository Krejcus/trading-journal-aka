import type { LiveAccount } from '../services/tradecopiaLiveService';
import type { TradeCardModel } from './liveTradeCard';
import { tradovateContractRoot, tradovateValuePerPoint } from './tradovateLivePnl';
import type { TvPricePayload } from './tvPriceMessage';
import type { TvPriceFeedView, TvPriceSample } from './tvPriceStore';

/**
 * Realtime otevřený P&L = kotva brokera + pohyb ceny z TradingView od kotvy
 * (krok 4 návrhu `docs/reviews/tv-price-channel-design-20261026.md`, bod B).
 * **Jen zobrazení (INV-UI-04)**: výsledek smí vykreslit jen listová
 * komponenta `components/LiveOpenPnlValue.tsx`; nikdy nesmí do
 * `unrealizedPnl`/`openPnL`, marks, způsobilosti, limitů/DLL, ARM, příkazů,
 * widgetu, sdílených karet, žurnálu ani do storage.
 *
 * Kotva zůstává brokerova (`live-pnl` po 3 s). Výchozí cena pohybu je ta
 * cena TV z okna kotvy, která nejlíp odpovídá marku brokera (čas kotvy je
 * jen odhad — v trendu by cena přesně v `anchorAt` posouvala číslo až
 * o šířku okna). Pohyb se počítá jen když projdou všechny kontroly; jinak
 * `live: false` a zobrazí se jen kotva:
 * 1. mark kotvy leží v rozsahu cen TV v okně kotvy ± 1 bod a okno samo
 *    není širší než 2 body;
 * 2. kontrakt za grafem TV (`front`) je kontrakt pozice;
 * 3. `streaming`, 1m panel, svíčka z aktuální minuty (předchozí jen prvních
 *    10 s nové minuty, než přijde první obchod);
 * 4. kotva ≤ 10 s, zpráva TV ≤ 2 s (čerstvost hlídá store), podpis ověřen
 *    (do storu jdou jen ověřené zprávy);
 * 5. stejný kořen kontraktu a strop pohybu od kotvy.
 * Body a strop jsou nastavené pro NQ/MNQ (stejná cena indexu); jiné kořeny
 * zůstávají u kotvy.
 */

export interface TvLivePnlLeg {
  /** Kontrakt pozice u brokera (`MNQZ6`). */
  symbol: string;
  /** Kontrakty se znaménkem (long > 0). */
  netPosition: number;
  averagePrice: number;
  /** Hrubý otevřený P&L té pozice v kotvě (broker nebo odhad z marku brokera). */
  grossPnl: number;
  /** Čas kotvy v ms (hodiny serveru; worker i server jdou podle NTP). */
  anchorAt: number;
}

export type TvLivePnlBlock =
  | 'no-position'
  | 'tv-stale'
  | 'tv-mode'
  | 'tv-bar-old'
  | 'unsupported-root'
  | 'root-mismatch'
  | 'contract-mismatch'
  | 'invalid-leg'
  | 'anchor-old'
  | 'anchor-ahead'
  | 'no-tv-at-anchor'
  | 'anchor-window-wide'
  | 'anchor-mismatch'
  | 'move-cap';

export type TvLivePnlResult = { live: true; deltaUsd: number } | { live: false; reason: TvLivePnlBlock };

export const TV_PNL_ANCHOR_MAX_AGE_MS = 10_000;
/** Kotva smí být o kus „novější“ než poslední zpráva TV (rozdíl hodin, latence). */
export const TV_PNL_ANCHOR_AHEAD_MS = 1_000;
export const TV_PNL_ANCHOR_WINDOW_MS = 1_000;
export const TV_PNL_WINDOW_MAX_RANGE_POINTS = 2;
export const TV_PNL_ANCHOR_TOLERANCE_POINTS = 1;
/** Svíčka předchozí minuty se uzná jen tak dlouho po začátku nové minuty. */
export const TV_PNL_PREVIOUS_BAR_GRACE_MS = 10_000;
/** Strop pohybu od kotvy: základ + body za sekundu stáří kotvy (NQ ve špičce). */
export const TV_PNL_MOVE_BASE_POINTS = 5;
export const TV_PNL_MOVE_POINTS_PER_SECOND = 6;

/** Kořeny se stejnou cenou (mikro a plný kontrakt jednoho indexu). */
const PRICE_FAMILY: Record<string, string> = { NQ: 'NQ', MNQ: 'NQ' };
const MONTH = '[FGHJKMNQUVXZ]';

/** Rodina ceny kořene (`MNQ`/`NQ` → `NQ`); jiné kořeny nepodporujeme. */
export const tvPriceFamily = (root: string | null | undefined): string | null => (root ? PRICE_FAMILY[root.toUpperCase()] ?? null : null);

/**
 * Svíčka zprávy je z aktuální minuty (předchozí jen prvních
 * `TV_PNL_PREVIOUS_BAR_GRACE_MS` nové minuty, než přijde první obchod).
 */
export const tvBarIsCurrent = (latest: Pick<TvPricePayload, 'at' | 'bar'>): boolean => {
  const minuteStart = Math.floor(latest.at / 60_000) * 60;
  const previousBarAllowed = latest.at - minuteStart * 1_000 <= TV_PNL_PREVIOUS_BAR_GRACE_MS;
  return latest.bar != null && latest.bar[0] >= minuteStart - (previousBarAllowed ? 60 : 0);
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Kořen symbolu grafu TV: `CME_MINI:MNQ1!` → `MNQ`, `CME_MINI:MNQZ2026` → `MNQ`. */
export const tvChartRoot = (chart: string): string | null => {
  const ticker = chart.slice(chart.lastIndexOf(':') + 1).trim().toUpperCase();
  return ticker.match(/^([A-Z0-9]+?)\d+!$/)?.[1]
    ?? ticker.match(new RegExp(`^([A-Z0-9]+?)${MONTH}\\d{2,4}$`))?.[1]
    ?? null;
};

/** `MNQZ2026` (TV) ↔ `MNQZ6` / `MNQZ26` (Tradovate): stejná rodina ceny, měsíc i rok. */
export const tvFrontMatchesContract = (front: string, contract: string): boolean => {
  const tv = front.trim().toUpperCase().match(new RegExp(`^([A-Z0-9]+?)(${MONTH})(\\d{4})$`));
  const broker = contract.trim().toUpperCase().match(new RegExp(`^([A-Z0-9]+?)(${MONTH})(\\d{1,2})$`));
  if (!tv || !broker) return false;
  const tvFamily = PRICE_FAMILY[tv[1]];
  if (!tvFamily || tvFamily !== PRICE_FAMILY[broker[1]] || tv[2] !== broker[2]) return false;
  return Number(tv[3]) % 10 ** broker[3].length === Number(broker[3]);
};

/** Cena platná v čase `at` (poslední vzorek s `at` ≤ čas); `-1` = žádný. */
const sampleIndexAt = (samples: readonly TvPriceSample[], at: number): number => {
  let low = 0;
  let high = samples.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (samples[middle].at <= at) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
};

const legDelta = (leg: TvLivePnlLeg, feed: TvPriceFeedView, last: number, latestAt: number): TvLivePnlResult => {
  const valuePerPoint = tradovateValuePerPoint(leg.symbol);
  if (!finite(leg.averagePrice) || !finite(leg.grossPnl) || !finite(leg.anchorAt) || !finite(leg.netPosition)
    || leg.netPosition === 0 || valuePerPoint == null) return { live: false, reason: 'invalid-leg' };
  const age = latestAt - leg.anchorAt;
  if (age > TV_PNL_ANCHOR_MAX_AGE_MS) return { live: false, reason: 'anchor-old' };
  if (age < -TV_PNL_ANCHOR_AHEAD_MS) return { live: false, reason: 'anchor-ahead' };
  const samples = feed.samples;
  const atAnchor = sampleIndexAt(samples, leg.anchorAt);
  if (atAnchor < 0) return { live: false, reason: 'no-tv-at-anchor' };
  // Okno kotvy: cena platná na jeho začátku + všechny změny do jeho konce.
  const windowStart = leg.anchorAt - TV_PNL_ANCHOR_WINDOW_MS;
  const windowEnd = Math.min(leg.anchorAt + TV_PNL_ANCHOR_WINDOW_MS, latestAt);
  const first = Math.max(0, sampleIndexAt(samples, windowStart));
  const mark = leg.averagePrice + leg.grossPnl / (leg.netPosition * valuePerPoint);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  // Výchozí cena: v okně nejbližší marku brokera; při shodě ta platná v čase kotvy.
  let base = samples[atAnchor].price;
  for (let index = first; index < samples.length && samples[index].at <= windowEnd; index += 1) {
    const price = samples[index].price;
    low = Math.min(low, price);
    high = Math.max(high, price);
    if (Math.abs(price - mark) < Math.abs(base - mark)) base = price;
  }
  if (high - low > TV_PNL_WINDOW_MAX_RANGE_POINTS) return { live: false, reason: 'anchor-window-wide' };
  if (mark < low - TV_PNL_ANCHOR_TOLERANCE_POINTS || mark > high + TV_PNL_ANCHOR_TOLERANCE_POINTS) {
    return { live: false, reason: 'anchor-mismatch' };
  }
  const move = last - base;
  const cap = TV_PNL_MOVE_BASE_POINTS + TV_PNL_MOVE_POINTS_PER_SECOND * Math.max(0, age) / 1_000;
  if (Math.abs(move) > cap) return { live: false, reason: 'move-cap' };
  return { live: true, deltaUsd: move * leg.netPosition * valuePerPoint };
};

/**
 * Pohyb otevřeného P&L od kotvy v USD (poplatky se nemění, takže platí pro
 * hrubou i čistou částku). Projít musí všechny nohy, jinak se nemíchá.
 */
export function tvLivePnlDelta(legs: readonly TvLivePnlLeg[] | null | undefined, feed: TvPriceFeedView): TvLivePnlResult {
  if (!legs || legs.length === 0) return { live: false, reason: 'no-position' };
  const latest = feed.latest;
  if (!feed.fresh || !latest) return { live: false, reason: 'tv-stale' };
  if (latest.interval !== '1' || latest.mode !== 'streaming' || latest.last == null) return { live: false, reason: 'tv-mode' };
  if (!tvBarIsCurrent(latest)) return { live: false, reason: 'tv-bar-old' };
  const chartFamily = tvPriceFamily(tvChartRoot(latest.chart));
  if (!chartFamily) return { live: false, reason: 'unsupported-root' };
  let deltaUsd = 0;
  for (const leg of legs) {
    const root = tradovateContractRoot(leg.symbol);
    if (!root || PRICE_FAMILY[root] !== chartFamily) return { live: false, reason: 'root-mismatch' };
    if (!latest.front || !tvFrontMatchesContract(latest.front, leg.symbol)) return { live: false, reason: 'contract-mismatch' };
    const result = legDelta(leg, feed, latest.last, latest.at);
    if (!result.live) return result;
    deltaUsd += result.deltaUsd;
  }
  return { live: true, deltaUsd };
}

/**
 * Noha účtu z řádku LIVE: jen ověřené čtení pozic, jediná otevřená pozice
 * (P&L účtu = P&L té pozice) a kotva, která není „stale“.
 */
export function liveAccountTvLegs(
  account: Pick<LiveAccount, 'positions' | 'unrealizedPnl' | 'unrealizedPnlSource' | 'unrealizedPnlUpdatedAt'> | undefined,
  positionsVerified: boolean,
): TvLivePnlLeg[] | null {
  if (!account || !positionsVerified || account.unrealizedPnlSource === 'stale' || !finite(account.unrealizedPnl)) return null;
  const open = account.positions.filter(position => position.netPosition !== 0);
  if (open.length !== 1 || open[0].netPrice == null) return null;
  const anchorAt = Date.parse(account.unrealizedPnlUpdatedAt ?? '');
  if (!Number.isFinite(anchorAt)) return null;
  return [{ symbol: open[0].symbol, netPosition: open[0].netPosition, averagePrice: open[0].netPrice, grossPnl: account.unrealizedPnl, anchorAt }];
}

/** Nohy karty obchodu skupiny: každý účet v obchodu, jinak nic (součet se nemíchá). */
export function tradeCardTvLegs(card: TradeCardModel | null | undefined): TvLivePnlLeg[] | null {
  if (!card || card.kind !== 'position' || card.openPnl == null || card.accounts.length === 0) return null;
  const legs: TvLivePnlLeg[] = [];
  for (const account of card.accounts) {
    const anchorAt = Date.parse(account.openPnlAsOf ?? '');
    if (account.openPnl == null || account.entry == null || account.quantity <= 0 || !Number.isFinite(anchorAt)) return null;
    legs.push({
      symbol: card.symbol,
      netPosition: account.quantity * card.direction,
      averagePrice: account.entry,
      grossPnl: account.openPnl + (account.fees ?? 0),
      anchorAt,
    });
  }
  return legs;
}
