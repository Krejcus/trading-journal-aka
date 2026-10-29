import type { BacktestChartOrderLine } from '../services/backtestOrderLines';
import type { PositionDrawing } from '../services/chartPositionDrawing';
import { calculatePositionMetrics, normalizePositionSettings } from '../services/chartPositionDrawing';

/**
 * Panel objednávky živého grafu — čistý výpočet nad návrhem (jen UI).
 *
 * Nic odsud neodesílá příkaz ani nerozhoduje o riziku kopírky: čísla slouží
 * jen k zobrazení v panelu a na čarách v grafu. Cena trhu (`TicketQuote`) je
 * zatím orientační z dat grafu (kanál TV/IBKR) — typ příkazu, počet kontraktů
 * i cena Market jsou proto jen ODHAD. Krok odeslání (jádro kopírky, pravidla
 * INV-*) je musí přepočítat z kotace brokera nebo výslovné volby uživatele,
 * nikdy z této ceny (INV-UI-04).
 */

export type TicketSide = 'buy' | 'sell';
export type TicketOrderType = 'market' | 'limit' | 'stop';
export type TicketSizing = 'qty' | 'risk';
export type TicketBracketUnits = 'pts' | 'ticks' | 'usd' | 'price';
export type TicketBracket = 'sl' | 'tp';

export interface TicketInstrument {
  symbol: string;
  tickSize: number;
  /** Dolarů za 1 bod a 1 kontrakt (MNQ 2, NQ 20). */
  pointValue: number;
}

export interface TicketQuote {
  bid: number;
  ask: number;
}

export interface TicketDraft {
  side: TicketSide;
  type: TicketOrderType;
  /** Limit/stop cena; u Market se ignoruje a bere se strana trhu. */
  price: number;
  sizing: TicketSizing;
  quantity: number;
  /** Riziko na obchod v $, když `sizing === 'risk'`. */
  riskUsd: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface TicketMetrics {
  /** Cena vstupu, se kterou se počítá (u Market strana trhu). */
  entry: number;
  quantity: number;
  /** Záporné číslo — ztráta při SL na jeden účet. */
  stopLossUsd: number | null;
  takeProfitUsd: number | null;
  stopLossPoints: number | null;
  takeProfitPoints: number | null;
  riskReward: number | null;
}

export type TicketProblemLevel = 'error' | 'warning';
export interface TicketProblem {
  level: TicketProblemLevel;
  text: string;
}

const direction = (side: TicketSide) => (side === 'buy' ? 1 : -1);

export const snapToTick = (price: number, tickSize: number): number => (
  Math.round(price / tickSize) * tickSize
);

/** Strana trhu, za kterou se Market vyplní: nákup za ask, prodej za bid. */
export const marketPrice = (side: TicketSide, quote: TicketQuote): number => (
  side === 'buy' ? quote.ask : quote.bid
);

export const ticketEntry = (draft: TicketDraft, quote: TicketQuote): number => (
  draft.type === 'market' ? marketPrice(draft.side, quote) : draft.price
);

/**
 * Počet kontraktů. Podle rizika se zaokrouhluje dolů — futures nejdou dělit
 * a zaokrouhlení nahoru by tiše zvětšilo riziko nad zadanou částku.
 */
export const ticketQuantity = (draft: TicketDraft, instrument: TicketInstrument, quote: TicketQuote): number => {
  if (draft.sizing === 'qty') return Math.max(0, Math.floor(draft.quantity));
  if (draft.stopLoss == null) return 0;
  const perContract = Math.abs(ticketEntry(draft, quote) - draft.stopLoss) * instrument.pointValue;
  if (!(perContract > 0) || !(draft.riskUsd > 0)) return 0;
  return Math.floor(draft.riskUsd / perContract + 1e-9);
};

export const ticketMetrics = (draft: TicketDraft, instrument: TicketInstrument, quote: TicketQuote): TicketMetrics => {
  const entry = ticketEntry(draft, quote);
  const quantity = ticketQuantity(draft, instrument, quote);
  const d = direction(draft.side);
  const stopLossPoints = draft.stopLoss == null ? null : (draft.stopLoss - entry) * d;
  const takeProfitPoints = draft.takeProfit == null ? null : (draft.takeProfit - entry) * d;
  const usd = (points: number | null) => (points == null ? null : points * quantity * instrument.pointValue);
  const stopLossUsd = usd(stopLossPoints);
  const takeProfitUsd = usd(takeProfitPoints);
  const riskReward = stopLossPoints != null && takeProfitPoints != null && stopLossPoints < 0 && takeProfitPoints > 0
    ? takeProfitPoints / -stopLossPoints
    : null;
  return { entry, quantity, stopLossUsd, takeProfitUsd, stopLossPoints, takeProfitPoints, riskReward };
};

/**
 * Typ příkazu podle strany trhu — stejné pravidlo jako Quick Order backtestu
 * (services/backtestQuickOrder.ts): nákup pod trhem = limit, nad trhem = stop,
 * u prodeje obráceně, na ceně = market.
 */
export const inferTicketOrderType = (
  side: TicketSide,
  price: number,
  quote: TicketQuote,
  tickSize: number,
): TicketOrderType => {
  const market = marketPrice(side, quote);
  if (Math.abs(price - market) < tickSize / 2) return 'market';
  if (side === 'buy') return price < market ? 'limit' : 'stop';
  return price > market ? 'limit' : 'stop';
};

/** Limit na špatné straně trhu by se vyplnil hned jako Market. */
export const limitIsMarketable = (draft: TicketDraft, quote: TicketQuote): boolean => (
  draft.type === 'limit' && (draft.side === 'buy' ? draft.price >= quote.ask : draft.price <= quote.bid)
);

/** Stop na špatné straně trhu by se spustil hned. */
export const stopIsTriggered = (draft: TicketDraft, quote: TicketQuote): boolean => (
  draft.type === 'stop' && (draft.side === 'buy' ? draft.price <= quote.ask : draft.price >= quote.bid)
);

export interface TicketDayLimit {
  limitUsd: number;
  /** Dnešní výsledek cílového účtu (záporný = ztráta). */
  dayPnlUsd: number;
}

export const ticketProblems = (
  draft: TicketDraft,
  instrument: TicketInstrument,
  quote: TicketQuote,
  dayLimit: TicketDayLimit | null,
): TicketProblem[] => {
  const problems: TicketProblem[] = [];
  const m = ticketMetrics(draft, instrument, quote);
  if (m.stopLossPoints != null && m.stopLossPoints >= 0) problems.push({ level: 'error', text: 'Stop loss je na špatné straně vstupu.' });
  if (m.takeProfitPoints != null && m.takeProfitPoints <= 0) problems.push({ level: 'error', text: 'Take profit je na špatné straně vstupu.' });
  if (limitIsMarketable(draft, quote)) {
    problems.push({ level: 'warning', text: `Limit je ${draft.side === 'buy' ? 'nad' : 'pod'} trhem — vyplní se hned jako Market.` });
  }
  if (stopIsTriggered(draft, quote)) {
    problems.push({ level: 'error', text: `Stop je ${draft.side === 'buy' ? 'pod' : 'nad'} trhem — spustil by se hned.` });
  }
  if (m.quantity < 1) {
    problems.push({
      level: 'error',
      text: draft.sizing === 'risk'
        ? (draft.stopLoss == null ? 'Pro velikost podle rizika zapni stop loss.' : 'Riziko nestačí ani na 1 kontrakt.')
        : 'Počet kontraktů musí být aspoň 1.',
    });
  }
  if (draft.stopLoss == null) problems.push({ level: 'warning', text: 'Bez stop lossu.' });
  // Jen u Limit/Stop: vstup zadal uživatel. U Market by ztráta při SL stála
  // na ceně z kanálu TV/IBKR a ta do limitů nesmí (INV-UI-04).
  if (dayLimit && m.stopLossUsd != null && draft.type !== 'market') {
    const left = dayLimit.limitUsd + dayLimit.dayPnlUsd;
    if (-m.stopLossUsd > left) {
      problems.push({ level: 'warning', text: `Ztráta při SL (${Math.round(-m.stopLossUsd)} $) je víc, než zbývá do denního limitu (${Math.round(Math.max(0, left))} $).` });
    }
  }
  return problems;
};

/** Hodnota závorky v jednotkách pole panelu (body / ticky / $ / cena). */
export const bracketDisplayValue = (
  draft: TicketDraft,
  which: TicketBracket,
  units: TicketBracketUnits,
  instrument: TicketInstrument,
  quote: TicketQuote,
): number | null => {
  const price = which === 'sl' ? draft.stopLoss : draft.takeProfit;
  if (price == null) return null;
  if (units === 'price') return price;
  const points = Math.abs(price - ticketEntry(draft, quote));
  if (units === 'pts') return points;
  if (units === 'ticks') return Math.round(points / instrument.tickSize);
  return points * Math.max(1, ticketQuantity(draft, instrument, quote)) * instrument.pointValue;
};

/** Opačný převod: hodnota z pole panelu → cena závorky zarovnaná na tick. */
export const bracketPriceFromInput = (
  draft: TicketDraft,
  which: TicketBracket,
  units: TicketBracketUnits,
  value: number,
  instrument: TicketInstrument,
  quote: TicketQuote,
): number | null => {
  if (!Number.isFinite(value)) return null;
  const entry = ticketEntry(draft, quote);
  // SL leží proti směru obchodu, TP po směru.
  const sign = which === 'tp' ? direction(draft.side) : -direction(draft.side);
  const distance = units === 'price' ? null
    : units === 'ticks' ? Math.abs(value) * instrument.tickSize
      : units === 'usd' ? Math.abs(value) / (instrument.pointValue * Math.max(1, ticketQuantity(draft, instrument, quote)))
        : Math.abs(value);
  const price = distance == null ? value : entry + sign * distance;
  return snapToTick(price, instrument.tickSize);
};

export const LIVE_DRAFT_ID = 'live-draft';
const DRAFT_COLOR = '#8b5cf6';
const SL_COLOR = '#ef4444';
const TP_COLOR = '#0f9f8f';

const signedUsd = (value: number) => `${value >= 0 ? '+' : '−'}$${Math.abs(value).toFixed(2)}`;
const typeKey = (type: TicketOrderType) => (type === 'market' ? 'MKT' : type === 'limit' ? 'LIMIT' : 'STOP');

/**
 * Čáry návrhu do grafu (vstup, SL, TP) — tvar čar backtestu, aby je kreslil
 * stejný overlay. `accountTag` = štítek samostatného účtu („T3“), u skupiny
 * nic. Popisky se přepočítají už během tažení (`labelAt`).
 */
export const liveDraftChartLines = (
  draft: TicketDraft,
  instrument: TicketInstrument,
  quote: TicketQuote,
  accountTag?: string,
): BacktestChartOrderLine[] => {
  const entry = ticketEntry(draft, quote);
  const quantity = ticketQuantity(draft, instrument, quote);
  const tag = accountTag ? ` ${accountTag}` : '';
  const entryKey = (side: TicketSide) => `${side === 'buy' ? 'BUY' : 'SELL'} ${quantity} ${typeKey(draft.type)}${tag}`;
  const bracketLabel = (kind: 'stopLoss' | 'takeProfit', at: number, from = entry) => {
    const points = (at - from) * direction(draft.side);
    // „návrh“ i na závorkách — červená SL čára nesmí vypadat jako ochrana
    // skutečné pozice (živé čáry pozice graf zatím nekreslí).
    return `${kind === 'stopLoss' ? 'SL' : 'TP'}  ${signedUsd(points * quantity * instrument.pointValue)} · ${Math.abs(at - from).toFixed(2)} b · návrh`;
  };
  const addable = [
    draft.stopLoss == null ? 'stopLoss' : null,
    draft.takeProfit == null ? 'takeProfit' : null,
  ].filter(Boolean) as Array<'stopLoss' | 'takeProfit'>;
  const lines: BacktestChartOrderLine[] = [{
    id: `${LIVE_DRAFT_ID}:entry`, ownerId: LIVE_DRAFT_ID, ownerType: 'order', kind: 'entry',
    price: entry, color: DRAFT_COLOR,
    label: `${entryKey(draft.side)}  ${entry.toFixed(2)} · návrh`,
    // Market jede s cenou trhu — čára vstupu se netáhne, jen závorky.
    draggable: draft.type !== 'market', cancellable: true, cancelAction: 'cancel-order',
    addableBrackets: addable.length ? addable : undefined,
    labelAt: next => `${entryKey(draft.side)}  ${next.toFixed(2)} · návrh`,
    bracketLabelAt: (kind, next) => bracketLabel(kind, next),
  }];
  for (const kind of ['stopLoss', 'takeProfit'] as const) {
    const value = kind === 'stopLoss' ? draft.stopLoss : draft.takeProfit;
    if (value == null) continue;
    lines.push({
      id: `${LIVE_DRAFT_ID}:${kind}`, ownerId: LIVE_DRAFT_ID, ownerType: 'order', kind,
      price: value, color: kind === 'stopLoss' ? SL_COLOR : TP_COLOR,
      label: bracketLabel(kind, value),
      labelAt: next => bracketLabel(kind, next),
      draggable: true, cancellable: true, cancelAction: 'remove-bracket',
    });
  }
  return lines;
};

/** Výchozí vzdálenost nového SL/TP v bodech (TP = 2R). */
export const DEFAULT_STOP_POINTS = 12;

/** SL nebo TP přidaný k návrhu: na zadanou cenu, jinak výchozí vzdálenost (TP 2R). */
export const withBracket = (
  draft: TicketDraft,
  which: TicketBracket,
  instrument: TicketInstrument,
  quote: TicketQuote,
  requested?: number,
): TicketDraft => {
  const entry = ticketEntry(draft, quote);
  const d = direction(draft.side);
  const fallback = which === 'sl' ? entry - d * DEFAULT_STOP_POINTS : entry + d * DEFAULT_STOP_POINTS * 2;
  const price = snapToTick(requested != null && Number.isFinite(requested) ? requested : fallback, instrument.tickSize);
  return which === 'sl' ? { ...draft, stopLoss: price } : { ...draft, takeProfit: price };
};

/** Nový návrh na ceně (pravý klik do grafu, tlačítko strany) s výchozími závorkami. */
export const newTicketDraft = (
  side: TicketSide,
  type: TicketOrderType,
  price: number,
  instrument: TicketInstrument,
  quote: TicketQuote,
  base?: Pick<TicketDraft, 'sizing' | 'quantity' | 'riskUsd'>,
): TicketDraft => {
  const draft: TicketDraft = {
    side,
    type,
    price: snapToTick(type === 'market' ? marketPrice(side, quote) : price, instrument.tickSize),
    sizing: base?.sizing ?? 'qty',
    quantity: base?.quantity ?? 1,
    riskUsd: base?.riskUsd ?? 200,
    stopLoss: null,
    takeProfit: null,
  };
  return withBracket(withBracket(draft, 'sl', instrument, quote), 'tp', instrument, quote);
};

/**
 * Změna strany ponechá vzdálenosti závorek, jen je zrcadlí kolem vstupu —
 * jinak by SL long návrhu po přepnutí na short ležel na špatné straně.
 */
export const withSide = (draft: TicketDraft, side: TicketSide, quote: TicketQuote, instrument: TicketInstrument): TicketDraft => {
  if (side === draft.side) return draft;
  const entry = ticketEntry(draft, quote);
  const mirror = (value: number | null) => (value == null ? null : snapToTick(2 * entry - value, instrument.tickSize));
  return { ...draft, side, stopLoss: mirror(draft.stopLoss), takeProfit: mirror(draft.takeProfit) };
};

/**
 * Posun vstupu tažením čáry nebo v poli ceny. Se Shiftem (`moveBrackets`)
 * jedou SL a TP o stejný kus (jako v TradingView).
 */
export const withEntryPrice = (draft: TicketDraft, price: number, instrument: TicketInstrument, moveBrackets = false): TicketDraft => {
  const next = snapToTick(price, instrument.tickSize);
  if (!moveBrackets) return { ...draft, price: next };
  const delta = next - draft.price;
  const shift = (value: number | null) => (value == null ? null : snapToTick(value + delta, instrument.tickSize));
  return { ...draft, price: next, stopLoss: shift(draft.stopLoss), takeProfit: shift(draft.takeProfit) };
};

export interface PositionBoxOrderDraft {
  draft: TicketDraft;
  /** Kolik kontraktů dá zadané riziko boxu (pro toast a kontrolu). */
  quantity: number;
}

/**
 * ⚡ z position boxu: stejná pravidla jako backtestový Quick Order, ale jen
 * NÁVRH do panelu — nikdy se neodesílá sám (Filip 29. 10.: bez potvrzení by
 * vznikalo moc omylů). Velikost jde podle rizika boxu, ne podle pákového
 * omezení nástroje, aby panel ukázal stejné „riziko $“, jaké je v boxu.
 */
export const draftFromPositionBox = (
  drawing: Pick<PositionDrawing, 'points' | 'style' | 'tool'>,
  instrument: TicketInstrument,
  quote: TicketQuote,
): PositionBoxOrderDraft => {
  const metrics = calculatePositionMetrics(drawing);
  if (!metrics) throw new Error('Position box nemá kompletní vstup, TP a SL.');
  const side: TicketSide = drawing.tool === 'LongPosition' ? 'buy' : 'sell';
  const validGeometry = side === 'buy'
    ? metrics.target > metrics.entry && metrics.stop < metrics.entry
    : metrics.target < metrics.entry && metrics.stop > metrics.entry;
  if (!validGeometry) {
    throw new Error(side === 'buy'
      ? 'Long box musí mít TP nad vstupem a SL pod vstupem.'
      : 'Short box musí mít TP pod vstupem a SL nad vstupem.');
  }
  const settings = normalizePositionSettings(drawing.style.position);
  const riskUsd = settings.riskMode === 'percent' ? settings.accountSize * settings.risk / 100 : settings.risk;
  const price = snapToTick(metrics.entry, instrument.tickSize);
  const type = inferTicketOrderType(side, price, quote, instrument.tickSize);
  const draft: TicketDraft = {
    side,
    type,
    price,
    sizing: 'risk',
    quantity: Math.max(1, Math.floor(metrics.quantity + 1e-9)),
    riskUsd,
    stopLoss: snapToTick(metrics.stop, instrument.tickSize),
    takeProfit: snapToTick(metrics.target, instrument.tickSize),
  };
  return { draft, quantity: ticketQuantity(draft, instrument, quote) };
};
