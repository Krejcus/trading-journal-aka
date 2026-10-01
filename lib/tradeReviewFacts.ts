import type { Trade } from '../types.js';
import type { TradeExecutionHistory } from './tradeExecutionHistory.js';

/** Krok „Průběh obchodu“: čas a cena z plnění a objednávek Tradovate. */
export interface ReviewStep {
  at: number;
  kind: 'entry' | 'sl' | 'tp' | 'exit' | 'order' | 'cancel';
  label: string;
  price: number;
}

export interface ReviewFacts {
  long: boolean;
  entryPrice: number | null;
  exitPrice: number | null;
  entryAt: number;
  exitAt: number;
  /** Pohyb v bodech ve směru obchodu. */
  move: number | null;
  /** SL/TP z první potvrzené objednávky (plán z brokera), jinak z řádku obchodu. */
  brokerSL: number | null;
  brokerTP: number | null;
  exitKind: 'sl' | 'tp' | 'manual';
  steps: ReviewStep[];
}

/** Důvody „mimo plán“ — rychlá volba, text doplňuje popis. */
export const REVIEW_INVALID_REASONS = [
  'Bez setupu', 'FOMO / honění', 'Revenge', 'Pozdní vstup',
  'Posunutý SL', 'Velikost nad plán', 'Mimo seanci', 'Omyl · fat finger',
] as const;

/** Tick podle kořene kontraktu — záloha, když výstup nejde spárovat s objednávkou. */
const TICK: Record<string, number> = { NQ: 0.25, MNQ: 0.25, ES: 0.25, MES: 0.25, YM: 1, MYM: 1, RTY: 0.1, M2K: 0.1, GC: 0.1, MGC: 0.1, CL: 0.01, MCL: 0.01 };
const tickOf = (trade: Trade) => {
  const symbol = String(trade.symbol || trade.instrument || '').toUpperCase();
  const root = Object.keys(TICK).sort((a, b) => b.length - a.length).find(key => symbol.startsWith(key));
  return root ? TICK[root] : 0.25;
};
const positive = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function averagePrice(fills: readonly { price: number; quantity: number; allocatedQuantity?: number }[]): number | null {
  let qty = 0; let sum = 0;
  for (const fill of fills) {
    const q = Number(fill.allocatedQuantity ?? fill.quantity) || 0;
    if (!(q > 0) || !Number.isFinite(fill.price)) continue;
    qty += q; sum += fill.price * q;
  }
  return qty > 0 ? sum / qty : null;
}

export function tradeEntryMs(trade: Pick<Trade, 'entryTime' | 'timestamp' | 'date'> & { entryDate?: unknown }): number {
  const fromDate = typeof trade.entryDate === 'string' ? Date.parse(trade.entryDate) : NaN;
  if (Number.isFinite(fromDate)) return fromDate;
  const fromTime = trade.entryTime != null ? new Date(trade.entryTime).getTime() : NaN;
  if (Number.isFinite(fromTime)) return fromTime;
  return trade.timestamp || Date.parse(trade.date);
}

/**
 * Fakta pro hodnocení: plnění a ochrana z historie Tradovate, se zálohou na
 * uložené hodnoty řádku (starší obchody bez historie).
 */
export function reviewFacts(trade: Trade, history?: TradeExecutionHistory | null): ReviewFacts {
  const long = String(trade.direction).toLowerCase() === 'long';
  const entryFills = (history?.fills ?? []).filter(fill => fill.role === 'entry').sort((a, b) => a.at - b.at);
  const exitFills = (history?.fills ?? []).filter(fill => fill.role === 'exit').sort((a, b) => a.at - b.at);
  const entryPrice = averagePrice(entryFills) ?? positive(trade.entryPrice);
  const exitPrice = averagePrice(exitFills) ?? positive(trade.exitPrice);
  const entryAt = entryFills[0]?.at ?? tradeEntryMs(trade);
  const exitAt = exitFills.at(-1)?.at ?? (trade.timestamp || Date.parse(trade.date));
  const move = entryPrice != null && exitPrice != null ? (exitPrice - entryPrice) * (long ? 1 : -1) : null;

  const protection = (history?.protection ?? [])
    .filter(event => event.status === 'confirmed' && event.operation !== 'cancel' && event.price != null && Number.isFinite(event.price))
    .filter(event => event.at <= exitAt + 1000)
    .sort((a, b) => a.at - b.at);
  const steps: ReviewStep[] = [];
  if (entryPrice != null) steps.push({ at: entryAt, kind: 'entry', label: 'Vstup', price: entryPrice });
  const last: Record<'sl' | 'tp', number | null> = { sl: null, tp: null };
  for (const event of protection) {
    const price = event.price as number;
    const previous = last[event.kind];
    if (previous != null && Math.abs(previous - price) < 1e-9) continue;
    const name = event.kind === 'sl' ? 'SL' : 'TP';
    steps.push({ at: Math.max(event.at, entryAt), kind: event.kind, label: previous == null ? `${name} zadán` : `${name} posunut`, price });
    last[event.kind] = price;
  }
  // Pro porovnání s výstupem platí jen ochrana, která v okamžiku výstupu ještě stála.
  const active: Record<'sl' | 'tp', number | null> = { sl: null, tp: null };
  for (const event of [...(history?.protection ?? [])].filter(item => item.at <= exitAt + 1000).sort((a, b) => a.at - b.at)) {
    if (event.status === 'cancelled' || event.operation === 'cancel') active[event.kind] = null;
    else if (event.status === 'confirmed' && event.price != null && Number.isFinite(event.price)) active[event.kind] = event.price;
  }
  const firstSL = protection.find(event => event.kind === 'sl')?.price ?? positive(trade.stopLoss);
  const firstTP = protection.find(event => event.kind === 'tp')?.price ?? positive(trade.takeProfit);
  // Nejdřív podle objednávky, která výstup vyplnila (stop-market může uklouznout o víc ticků).
  const exitOrders = new Set(exitFills.map(fill => String(fill.orderId)));
  const byOrder = (history?.protection ?? []).find(event => exitOrders.has(String(event.orderId)))?.kind;
  const tolerance = tickOf(trade) + 1e-9;
  const near = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) <= tolerance;
  const hasHistory = Boolean(history?.protection?.length);
  const slRef = hasHistory ? active.sl : firstSL;
  const tpRef = hasHistory ? active.tp : firstTP;
  const exitKind: ReviewFacts['exitKind'] = byOrder ?? (near(exitPrice, slRef) ? 'sl' : near(exitPrice, tpRef) ? 'tp' : 'manual');
  if (exitPrice != null) {
    steps.push({ at: exitAt, kind: 'exit', label: exitKind === 'sl' ? 'Výstup · SL' : exitKind === 'tp' ? 'Výstup · TP' : 'Výstup · ručně', price: exitPrice });
  }
  // Vstupní limity/stopy: zadání, posuny a zrušené pokusy (vyplnění = „Vstup“).
  for (const order of history?.entryOrders ?? []) {
    const name = `${order.side} ${order.type}`;
    order.legs.forEach((leg, index) => steps.push({ at: leg.at, kind: 'order', label: `${name} ${index ? 'posunut' : 'zadán'}`, price: leg.price }));
    const last = order.legs[order.legs.length - 1];
    if (order.end?.kind === 'cancel' && last) steps.push({ at: order.end.at, kind: 'cancel', label: `${name} zrušen`, price: last.price });
  }
  steps.sort((a, b) => a.at - b.at);
  return { long, entryPrice, exitPrice, entryAt, exitAt, move, brokerSL: firstSL ?? null, brokerTP: firstTP ?? null, exitKind, steps };
}

/** R z plánu: plánovaný SL (jinak první SL z brokera). Mění jen R, nikdy P&L. */
export function reviewR(facts: ReviewFacts, plannedSL?: number | null, plannedTP?: number | null): { r: number | null; rr: number | null } {
  const sl = plannedSL ?? facts.brokerSL;
  const tp = plannedTP ?? facts.brokerTP;
  if (facts.entryPrice == null || sl == null || planSideError(facts, sl, null)) return { r: null, rr: null };
  const risk = Math.abs(facts.entryPrice - sl);
  if (!(risk > 0)) return { r: null, rr: null };
  return {
    r: facts.move != null ? facts.move / risk : null,
    rr: tp != null && !planSideError(facts, null, tp) ? Math.abs(tp - facts.entryPrice) / risk : null,
  };
}

/** SL musí být pod vstupem u longu (nad u shortu), TP naopak — překlep jinak dá věrohodné R. */
export function planSideError(facts: Pick<ReviewFacts, 'long' | 'entryPrice'>, plannedSL?: number | null, plannedTP?: number | null): 'sl' | 'tp' | null {
  if (facts.entryPrice == null) return null;
  const dir = facts.long ? 1 : -1;
  if (plannedSL != null && (facts.entryPrice - plannedSL) * dir <= 0) return 'sl';
  if (plannedTP != null && (plannedTP - facts.entryPrice) * dir <= 0) return 'tp';
  return null;
}

const isInvalid = (trade: Trade) => trade.executionStatus === 'Invalid' || trade.planAdherence === 'No' || trade.isValid === false;

/** Kolik stojí nedisciplína v měsíci: obchody mimo plán, jejich P&L a nejčastější důvod. */
export function monthlyInvalidSummary(trades: readonly Trade[], now = Date.now()): { count: number; pnl: number; topReason: string | null } {
  const month = new Date(now);
  const from = new Date(month.getFullYear(), month.getMonth(), 1).getTime();
  const to = new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime();
  const reasons = new Map<string, number>();
  let count = 0; let pnl = 0;
  for (const trade of trades) {
    const at = trade.timestamp || Date.parse(trade.date);
    if (!(at >= from && at < to) || !isInvalid(trade)) continue;
    count += 1; pnl += Number(trade.pnl) || 0;
    for (const reason of trade.invalidReasons ?? []) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const topReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { count, pnl, topReason };
}

/**
 * Hodnoty pro „Vrátit“ po uložení hodnocení. Pole, které předtím chybělo, se
 * nevrací na `null` (pole by v UI chybělo jako pole, trigger by `null` stav
 * u `executionStatus` zahodil) — vrací se neutrální „bez hodnocení“.
 */
export function undoPatch(before: Trade, patch: Partial<Trade>): Partial<Trade> {
  const source = before as unknown as Record<string, unknown>;
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => {
    const previous = source[key];
    if (previous !== undefined) return [key, previous];
    if (key === 'executionStatus') return [key, 'Valid'];
    if (key === 'isValid') return [key, true];
    if (Array.isArray(value)) return [key, []];
    if (key === 'notes' || key === 'invalidNote') return [key, ''];
    return [key, null];
  })) as Partial<Trade>;
}

/**
 * „Tlustá čára“ (Filip, 1. 10. 2026): fronta Hodnotit a její odznak počítají
 * jen obchody uzavřené od 1. 10. 2026 (půlnoc Praha). Starší neohodnocené
 * obchody se nehodnotí — měsíc starý obchod už nemá smysl rozebírat. Jednotlivě
 * jdou otevřít dál z detailu v Historii.
 */
export const REVIEW_QUEUE_SINCE_MS = Date.parse('2026-09-30T22:00:00Z');

export function inReviewQueue(trade: Pick<Trade, 'needsReview' | 'source' | 'timestamp' | 'date'>): boolean {
  if (trade.needsReview !== true || trade.source !== 'copier') return false;
  const closedAt = trade.timestamp || Date.parse(trade.date);
  return Number.isFinite(closedAt) && closedAt >= REVIEW_QUEUE_SINCE_MS;
}
