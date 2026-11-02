import type { LiveEntryPreviewDraft } from './leaderEntryPreview';
import type { LeaderEntryPlaceResult } from './leaderEntryPlace';
import type { LeaderOrderManageResult } from './leaderOrderManage';
import { snapToTick, ticketQuantity, type TicketDraft, type TicketInstrument } from './liveOrderTicket';

/**
 * LIVE obchodování z telefonu (2. 11. 2026): převod lišty Koupit/Prodat a listu
 * objednávky na stejný příkaz `place-leader-entry`, jaký posílá panel na PC
 * (stejný relay, admission, idempotence i brány workeru). Nic tady neodesílá.
 */

/** Kotace z kanálu ceny grafu: kontrakt jen ze zdroje IBKR, `at` = kdy tick přišel. */
export interface LivePhoneQuote { symbol: string | null; bid: number; ask: number; at: number }

/** Co telefonní graf dostane z LIVE desku (jen funkce a zobrazení, žádný stav kopírky k rozhodování). */
export interface LivePhoneTradeBridge {
  /** Null = odeslat jde; jinak proč ne (čerstvost stavu, kopírka vypnutá, rozpracovaný vstup…). */
  blockedReason: string | null;
  marketSupported: boolean;
  bareSupported: boolean;
  maxContracts: number;
  /** Front kontrakt podle brokera (čerstvý) — jen pro Limit/Stop z listu, když cena není z IBKR. */
  frontContract: string | null;
  place: (draft: LiveEntryPreviewDraft, operationId: string) => Promise<LeaderEntryPlaceResult>;
  /** Pozice leadera na MNQ (z workeru); `bareEntryOperationId` = vlastní holý Market bez nohou. */
  position: LivePhonePosition | null;
  attach: (input: { entryOperationId: string; symbol: string; quantity: number; expectPrice: number; stopLoss: number; takeProfit: number }) => Promise<LeaderOrderManageResult>;
  /** Flatten celé manual-only skupiny (jediný DEMO účet) safety cestou; vrací text výsledku. */
  flatten: () => Promise<string>;
}

/** Lišta nad grafem: otevřená pozice, nebo jen čekající vstup (`pending` — zatím žádná pozice). */
export interface LivePhonePosition {
  side: 'long' | 'short';
  quantity: number;
  symbol: string;
  bareEntryOperationId: string | null;
  pending: { type: string | null; price: number | null } | null;
}

/**
 * Souhrn grafu leadera → lišta. Čekající vstup (kind `pending`) se nesmí tvářit jako pozice
 * (DEMO 2. 11.: Limit z listu ukázal „LONG 1“) a nikdy nenabízí „Přidat SL/TP“.
 */
export function livePhonePosition(
  summary: { kind: 'position' | 'pending'; side: 'long' | 'short'; entry: number | null; entryType: string | null } | null,
  leader: { quantity: number } | null,
  symbol: string | null,
  bareEntryOperationId: string | null,
): LivePhonePosition | null {
  if (!summary || !leader || !symbol) return null;
  const pending = summary.kind === 'pending';
  return {
    side: summary.side, quantity: leader.quantity, symbol,
    bareEntryOperationId: pending ? null : bareEntryOperationId,
    pending: pending ? { type: summary.entryType, price: summary.entry } : null,
  };
}

export const livePhoneOperationId = (): string => `entry:${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

/** Lišta: holý Market bez SL/TP (Filip 1. 11.: „je to fakt fakt objednávka“). */
export function livePhoneBareMarket(side: 'buy' | 'sell', quantity: number, quote: LivePhoneQuote): LiveEntryPreviewDraft | { error: string } {
  if (!quote.symbol) return { error: 'Kontrakt není ověřený (cena není z IBKR) — nic se neodeslalo.' };
  if (!Number.isSafeInteger(quantity) || quantity < 1) return { error: 'Neplatný počet kontraktů.' };
  return {
    symbol: quote.symbol, side: side === 'buy' ? 'Buy' : 'Sell', quantity, orderType: 'Market',
    referencePrice: side === 'buy' ? quote.ask : quote.bid, quoteReceivedAt: Math.round(quote.at),
  };
}

/** List objednávky: Limit/Stop/Market se SL+TP; Market smí i bez obou (holý). */
export function livePhoneSheetEntry(draft: TicketDraft, instrument: TicketInstrument, quote: LivePhoneQuote): LiveEntryPreviewDraft | { error: string } {
  if (!quote.symbol) return { error: 'Kontrakt není ověřený (cena není z IBKR) — nic se neodeslalo.' };
  const quantity = ticketQuantity(draft, instrument, { bid: quote.bid, ask: quote.ask });
  if (!Number.isSafeInteger(quantity) || quantity < 1) return { error: 'Neplatný počet kontraktů.' };
  const hasStop = draft.stopLoss != null;
  const hasTarget = draft.takeProfit != null;
  if (hasStop !== hasTarget) return { error: 'Vyplň SL i TP (nebo u Marketu ani jedno).' };
  if (!hasStop && draft.type !== 'market') return { error: 'Limit a Stop potřebují SL i TP.' };
  const side = draft.side === 'buy' ? 'Buy' as const : 'Sell' as const;
  const legs = hasStop ? { stopLoss: snapToTick(draft.stopLoss!, instrument.tickSize), takeProfit: snapToTick(draft.takeProfit!, instrument.tickSize) } : {};
  return draft.type === 'market'
    ? { symbol: quote.symbol, side, quantity, orderType: 'Market', referencePrice: draft.side === 'buy' ? quote.ask : quote.bid, quoteReceivedAt: Math.round(quote.at), ...legs }
    : { symbol: quote.symbol, side, quantity, orderType: draft.type === 'stop' ? 'Stop' : 'Limit', price: snapToTick(draft.price, instrument.tickSize), ...legs };
}

/** Krátký text výsledku od workeru pro hlášku nad grafem. HTTP 200 ≠ fill: „Přijato“ = broker vzal příkaz. */
export function livePhonePlacedText(result: LeaderEntryPlaceResult): string {
  if (result.status === 'acknowledged') return result.reason ?? 'Broker příkaz přijal — pozice se ukáže po vyplnění.';
  if (result.status === 'blocked') return `Neodesláno: ${result.blockers[0]?.text ?? 'worker příkaz zastavil'}`;
  if (result.status === 'rejected') return result.reason ?? 'Broker příkaz odmítl.';
  return result.reason ?? 'Výsledek neznámý — zkontroluj pozici, nic neopakuj.';
}
