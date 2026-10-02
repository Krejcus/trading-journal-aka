import type { Trade } from '../types';
import type { JournalUntakenOrder } from '../lib/journalEntryOrders';
import type { EntryOrderOutcome } from '../lib/entryOrderOutcome';
import { tvSymbolRoot } from '../lib/tradingViewBars';
import { supabase } from './supabase';

/**
 * Nevzaté obchody (zrušené vstupy s bracketem) — samostatné karty v Hodnotit.
 * Fakta zapisuje serverový import; uživatel mění jen `review`. Do statistik
 * strategie ani P&L se nepočítají.
 */
export const UNTAKEN_REASONS = ['Cena nedošla', 'Zrušil jsem předčasně', 'Setup přestal platit', 'Zaváhal jsem', 'Omyl'] as const;

export interface UntakenReview {
  reason: string;
  note?: string;
  /** Výsledek „kdybys nezrušil“ v okamžiku hodnocení (počítá ho graf ze svíček). */
  outcome?: EntryOrderOutcome | null;
  pointValue?: number;
  reviewedAt: string;
}

export interface UntakenMeta {
  connectionId: string;
  orderId: string;
  order: JournalUntakenOrder;
  review: UntakenReview | null;
}

export interface UntakenRow {
  connection_id: string;
  order_id: string;
  external_account_id: string;
  journal_account_id: string;
  placed_at: string;
  ended_at: string;
  data: JournalUntakenOrder;
  review: UntakenReview | null;
}

const TABLE = 'tradovate_journal_untaken_orders';

/** Nevzaté obchody od `sinceMs`. Bez tabulky (migrace ještě neběžela) prázdný seznam. */
export async function loadUntakenOrders(sinceMs: number): Promise<Trade[]> {
  try {
    const { data, error } = await supabase.from(TABLE)
      .select('connection_id,order_id,external_account_id,journal_account_id,placed_at,ended_at,data,review')
      .gte('placed_at', new Date(sinceMs).toISOString())
      .order('placed_at', { ascending: true })
      .limit(500);
    if (error || !data) return [];
    return (data as UntakenRow[]).flatMap(row => {
      const trade = untakenTrade(row);
      return trade ? [trade] : [];
    });
  } catch {
    return [];
  }
}

/** Uloží (nebo smaže při `null`) hodnocení nevzatého obchodu. */
export async function saveUntakenReview(meta: Pick<UntakenMeta, 'connectionId' | 'orderId'>, review: UntakenReview | null): Promise<boolean> {
  try {
    const { error } = await supabase.from(TABLE).update({ review })
      .eq('connection_id', meta.connectionId).eq('order_id', meta.orderId);
    return !error;
  } catch {
    return false;
  }
}

export const untakenTradeId = (connectionId: string, orderId: string) => `untaken:${connectionId}:${orderId}`;

/**
 * Pseudo obchod pro Hodnotit a graf: bez plnění, s jediným vstupním příkazem.
 * Graf ho pozná podle `untaken` a „kdybys nezrušil“ rovnou připne.
 */
export function untakenTrade(row: UntakenRow): Trade | null {
  const order = row.data;
  const placedAt = Date.parse(row.placed_at), endedAt = Date.parse(row.ended_at);
  if (!order?.legs?.length || !Number.isFinite(placedAt) || !Number.isFinite(endedAt)) return null;
  const price = order.legs[order.legs.length - 1].price;
  return {
    id: untakenTradeId(row.connection_id, row.order_id),
    accountId: row.journal_account_id,
    instrument: tvSymbolRoot(order.symbol) ?? order.symbol,
    symbol: order.symbol,
    direction: order.side === 'Buy' ? 'Long' : 'Short',
    pnl: 0,
    date: new Date(endedAt).toISOString(),
    timestamp: endedAt,
    entryTime: placedAt,
    entryDate: new Date(placedAt).toISOString(),
    exitDate: new Date(endedAt).toISOString(),
    entryPrice: price,
    positionSize: order.quantity ?? undefined,
    source: 'copier',
    needsReview: row.review == null,
    notes: row.review?.note ?? '',
    executionHistory: {
      connectionId: row.connection_id, environment: 'demo', accountId: Number(row.external_account_id),
      fills: [], protection: [], entryOrders: [order], gaps: [],
      grossPnl: null, fees: null, netPnl: null, complete: false, issues: [],
    },
    untaken: { connectionId: row.connection_id, orderId: row.order_id, order, review: row.review },
  } as unknown as Trade;
}

/** Měsíční souhrn hodnocených nevzatých obchodů: kolik rušení stálo / ušetřilo. */
export function untakenMonthSummary(trades: readonly Trade[], now = Date.now()) {
  const month = new Date(now);
  const from = new Date(month.getFullYear(), month.getMonth(), 1).getTime();
  const rows = trades.filter(trade => trade.untaken && (trade.timestamp ?? 0) >= from);
  let missed = 0, saved = 0;
  const reasons = new Map<string, number>();
  for (const trade of rows) {
    const review = trade.untaken!.review;
    if (review?.reason) reasons.set(review.reason, (reasons.get(review.reason) ?? 0) + 1);
    const outcome = review?.outcome;
    const quantity = trade.untaken!.order.quantity;
    if (outcome?.kind !== 'fill' || outcome.points == null || quantity == null) continue;
    const usd = outcome.points * quantity * (review?.pointValue ?? 2);
    if (usd > 0) missed += usd; else saved -= usd;
  }
  const topReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { count: rows.length, missed, saved, topReason };
}
