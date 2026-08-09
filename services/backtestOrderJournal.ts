import {
  positionEventOwnerId,
  type PendingOrderPriceField,
} from './backtestEngine';
import type {
  BacktestClosedTrade,
  BacktestInstrument,
  BacktestOrderEvent,
} from './backtestTypes';

/**
 * Analytika nad append-only journalem objednávek.
 *
 * Objednávka i pozice drží jen svůj poslední stav. Všechno, co se dá říct
 * o tom, jak se s obchodem *zacházelo* — kolikrát se hýbalo se stopkou, jestli
 * se utahovala nebo povolovala, kolik vstupů skončilo zrušením — se dá zjistit
 * výhradně odsud.
 */

const MOVE_KINDS = new Set<BacktestOrderEvent['kind']>([
  'stop-moved', 'target-moved', 'position-stop-moved', 'position-target-moved',
]);

const STOP_KINDS = new Set<BacktestOrderEvent['kind']>(['stop-moved', 'position-stop-moved']);
const TARGET_KINDS = new Set<BacktestOrderEvent['kind']>(['target-moved', 'position-target-moved']);

export interface TradeManagementStats {
  /** Kolikrát se posunul stop loss (čekající objednávka i otevřená pozice). */
  stopMoves: number;
  targetMoves: number;
  entryMoves: number;
  /** Posuny stopky blíž ke vstupu — utahování rizika. */
  stopTightened: number;
  /** Posuny stopky dál od vstupu — povolení rizika. Klasický leak. */
  stopLoosened: number;
  targetPulledIn: number;
  targetPushedOut: number;
  stopCleared: number;
  targetCleared: number;
  /** Stopka skončila na vstupu (±0,25 bodu) — breakeven. */
  movedToBreakeven: boolean;
  /** Částečný výstup před uzavřením zbytku. */
  partialExits: number;
  /**
   * Souhrnná nálepka kompatibilní s `Trade.management` z AlphaBridge:
   * fixed | be_runner | trail | partial_runner.
   */
  label: string;
}

const emptyManagement = (): TradeManagementStats => ({
  stopMoves: 0, targetMoves: 0, entryMoves: 0,
  stopTightened: 0, stopLoosened: 0,
  targetPulledIn: 0, targetPushedOut: 0,
  stopCleared: 0, targetCleared: 0,
  movedToBreakeven: false, partialExits: 0,
  label: 'fixed',
});

/**
 * Události, které patří jednomu uzavřenému obchodu.
 *
 * Okno [entryTime, exitTime] samo nestačí: objednávka mohla ležet v trhu
 * hodinu a několikrát se posouvat, než ji cena sebrala. Proto se navíc dohledá
 * objednávka, jejíž fill vstup vytvořil, a přiberou se všechny její události.
 */
export const tradeJournalEvents = (
  events: readonly BacktestOrderEvent[],
  trade: Pick<BacktestClosedTrade, 'instrument' | 'entryTime' | 'exitTime'>,
): BacktestOrderEvent[] => {
  const sameInstrument = events.filter(event => event.instrument === trade.instrument);
  const entryOrderIds = new Set(
    sameInstrument
      .filter(event => event.kind === 'filled' && event.marketTime === trade.entryTime)
      .map(event => event.orderId),
  );
  return sameInstrument
    .filter(event => entryOrderIds.has(event.orderId)
      || (event.marketTime >= trade.entryTime && event.marketTime <= trade.exitTime))
    .sort((left, right) => left.marketTime - right.marketTime);
};

const BREAKEVEN_TOLERANCE = 0.25;

export const tradeManagementStats = (
  events: readonly BacktestOrderEvent[],
  trade: Pick<BacktestClosedTrade, 'instrument' | 'entryTime' | 'exitTime' | 'entryPrice' | 'direction'>,
): TradeManagementStats => {
  const scoped = tradeJournalEvents(events, trade);
  const stats = emptyManagement();
  const long = trade.direction === 'Long';
  let lastStopPrice: number | undefined;

  scoped.forEach(event => {
    // Fill uvnitř okna obchodu (ne vstupní ani výstupní) = odebrání části pozice.
    if (event.kind === 'filled' && event.marketTime > trade.entryTime && event.marketTime < trade.exitTime) {
      stats.partialExits += 1;
    }
    if (event.kind === 'entry-moved') stats.entryMoves += 1;
    if (event.kind === 'stop-cleared' || event.kind === 'position-stop-cleared') stats.stopCleared += 1;
    if (event.kind === 'target-cleared' || event.kind === 'position-target-cleared') stats.targetCleared += 1;
    if (!MOVE_KINDS.has(event.kind)) return;
    const price = event.price;
    const previous = event.previousPrice;
    if (STOP_KINDS.has(event.kind)) {
      stats.stopMoves += 1;
      if (Number.isFinite(price as number)) lastStopPrice = Number(price);
      if (Number.isFinite(price as number) && Number.isFinite(previous as number)) {
        // Utažení = stopka se přiblížila ke vstupu, tedy nahoru u longu.
        const tightened = long ? Number(price) > Number(previous) : Number(price) < Number(previous);
        if (tightened) stats.stopTightened += 1;
        else stats.stopLoosened += 1;
      }
    }
    if (TARGET_KINDS.has(event.kind)) {
      stats.targetMoves += 1;
      if (Number.isFinite(price as number) && Number.isFinite(previous as number)) {
        const pulledIn = long ? Number(price) < Number(previous) : Number(price) > Number(previous);
        if (pulledIn) stats.targetPulledIn += 1;
        else stats.targetPushedOut += 1;
      }
    }
  });

  stats.movedToBreakeven = Number.isFinite(lastStopPrice as number)
    && Math.abs(Number(lastStopPrice) - trade.entryPrice) <= BREAKEVEN_TOLERANCE;

  if (stats.stopMoves >= 2 && stats.stopTightened >= 2) stats.label = 'trail';
  else if (stats.movedToBreakeven) stats.label = 'be_runner';
  else if (stats.partialExits > 0) stats.label = 'partial_runner';
  else if (stats.stopMoves > 0 || stats.targetMoves > 0) stats.label = 'adjusted';
  return stats;
};

export interface OrderDeliberation {
  orderId: string;
  /** Kolik replay sekund uplynulo od předchozí události než přišla objednávka. */
  marketGapSeconds: number | null;
  /** Kolik reálných sekund uživatel nad rozhodnutím strávil. */
  wallClockSeconds: number | null;
}

/**
 * Jak dlouho se uživatel rozmýšlel před každou objednávkou.
 *
 * Dvě čísla vedle sebe: `marketGapSeconds` říká, kolik trhu proběhlo, zatímco
 * `wallClockSeconds` říká, jak dlouho se u toho sedělo. Krátký market gap
 * s dlouhým wall clockem je rozvaha, opačný poměr je klikání naslepo v rychlém
 * přehrávání.
 */
export const orderDeliberations = (events: readonly BacktestOrderEvent[]): OrderDeliberation[] => {
  const ordered = [...events].sort((left, right) => left.marketTime - right.marketTime);
  const result: OrderDeliberation[] = [];
  let previous: BacktestOrderEvent | null = null;
  ordered.forEach(event => {
    if (event.kind === 'created') {
      const marketGapSeconds = previous ? event.marketTime - previous.marketTime : null;
      const wallClockSeconds = previous?.recordedAt !== undefined && event.recordedAt !== undefined
        ? (event.recordedAt - previous.recordedAt) / 1_000
        : null;
      result.push({ orderId: event.orderId, marketGapSeconds, wallClockSeconds });
    }
    previous = event;
  });
  return result;
};

export interface JournalRunSummary {
  ordersCreated: number;
  ordersFilled: number;
  ordersCancelled: number;
  /** Podíl zadaných vstupů, které skončily zrušením (0–1). */
  cancelRate: number;
  stopMoves: number;
  targetMoves: number;
  stopLoosened: number;
  /** Dny v přehrávaném rozsahu, kdy nepadla ani jedna objednávka. */
  noTradeDays: string[];
  tradedDays: string[];
}

const dayKeyOf = (unixSeconds: number, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(unixSeconds * 1_000));
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
};

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Souhrn celé session včetně dnů, kdy se neobchodovalo.
 *
 * Negativní prostor je v backtestu stejně cenný jako obchody: den, který jsi
 * celý prohlédl a nechal být, je doklad disciplíny, ne chybějící data. Živý
 * feed z AlphaBridge o něm nevěděl vůbec.
 */
export const journalRunSummary = (
  events: readonly BacktestOrderEvent[],
  range: { startSeconds: number; endSeconds: number },
  timeZone: string,
): JournalRunSummary => {
  const created = events.filter(event => event.kind === 'created');
  const cancelled = events.filter(event => event.kind === 'cancelled');
  const filled = events.filter(event => event.kind === 'filled');
  const traded = new Set(created.map(event => dayKeyOf(event.marketTime, timeZone)));
  const covered: string[] = [];
  const seen = new Set<string>();
  const last = Math.max(range.startSeconds, range.endSeconds);
  for (let time = range.startSeconds; time <= last; time += DAY_SECONDS) {
    const key = dayKeyOf(time, timeZone);
    if (seen.has(key)) continue;
    seen.add(key);
    covered.push(key);
  }
  const endKey = dayKeyOf(last, timeZone);
  if (!seen.has(endKey)) covered.push(endKey);
  return {
    ordersCreated: created.length,
    ordersFilled: filled.length,
    ordersCancelled: cancelled.length,
    cancelRate: created.length ? cancelled.length / created.length : 0,
    stopMoves: events.filter(event => STOP_KINDS.has(event.kind)).length,
    targetMoves: events.filter(event => TARGET_KINDS.has(event.kind)).length,
    stopLoosened: events.reduce((sum, event) => {
      if (!STOP_KINDS.has(event.kind)) return sum;
      if (!Number.isFinite(event.price as number) || !Number.isFinite(event.previousPrice as number)) return sum;
      // Bez směru obchodu se u samostatné události nedá říct, jestli šlo
      // o utažení; `side` na události ho ale nese.
      const long = event.side === 'buy';
      const loosened = long ? Number(event.price) < Number(event.previousPrice) : Number(event.price) > Number(event.previousPrice);
      return loosened ? sum + 1 : sum;
    }, 0),
    tradedDays: covered.filter(day => traded.has(day)),
    noTradeDays: covered.filter(day => !traded.has(day)),
  };
};

/** Re-export, ať konzumenti journalu nemusí sahat do enginu. */
export { positionEventOwnerId };
export type { PendingOrderPriceField };

/** Instrumenty, které se v journalu objevily. */
export const journalInstruments = (events: readonly BacktestOrderEvent[]): BacktestInstrument[] =>
  [...new Set(events.map(event => event.instrument))];
