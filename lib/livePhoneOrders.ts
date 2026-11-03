import type { LiveEntryPreviewDraft } from './leaderEntryPreview';
import type { LeaderEntryPlaceResult } from './leaderEntryPlace';
import type { LeaderOrderManageAction, LeaderOrderManageResult } from './leaderOrderManage';
import { snapToTick, ticketQuantity, type TicketDraft, type TicketInstrument } from './liveOrderTicket';
import type { LiveTicketScaleIn } from './liveScaleIn';

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
  /**
   * Správa obchodu leadera z čar v grafu (posun SL/TP, BE, × zavřít/zrušit) — stejná
   * cesta jako PC `onManageEntry`. Zatím nenapojeno: bez ní jsou čáry jen zobrazení.
   */
  manage?: (action: LeaderOrderManageAction, expectPrice: number, newPrice?: number) => Promise<LeaderOrderManageResult>;
  /** × u pozice: worker umí zavřít a kopírka je čerstvě zapnutá (ne shadow) — jako PC. */
  closeSupported?: boolean;
  /** Průměrný vstup leadera od workeru (BE). */
  entryAvg?: number | null;
  /** Přikoupení do otevřené pozice (worker `manual-entry-scale-in-v1`): SL/TP pozice a stav. */
  scaleIn?: LiveTicketScaleIn | null;
}

/**
 * Návrh z listu na stranu otevřené pozice = přikoupení: převezme SL/TP pozice (worker
 * jiné nepustí) a strop platí na celou pozici. Jen příprava návrhu — rozhoduje worker.
 */
export function livePhoneScaleInDraft(draft: TicketDraft, scaleIn: LiveTicketScaleIn | null | undefined): TicketDraft {
  if (!scaleIn || draft.side !== scaleIn.side || scaleIn.stopLoss == null || scaleIn.targetPrice == null) return draft;
  return { ...draft, stopLoss: scaleIn.stopLoss, takeProfit: scaleIn.targetPrice };
}

/** Důvod, proč přikoupení z listu nejde (strop celé pozice, Limit/Stop jen po 1, čekající přikoupení). */
export function livePhoneScaleInBlocked(draft: TicketDraft, quantity: number, scaleIn: LiveTicketScaleIn | null | undefined, maxContracts: number): string | null {
  if (!scaleIn) return null;
  if (draft.side !== scaleIn.side) return 'V pozici jde jen přikoupit na její stranu — zavři ji ×.';
  if (scaleIn.pendingAdd) return 'Předchozí přikoupení ještě čeká — nejdřív ať se vyplní, nebo ho zruš.';
  // Upravené SL/TP se nikdy tiše nepřepíšou na SL/TP pozice (P1-B) — nic neodejde.
  const tick = (value: number | null) => (value == null ? null : snapToTick(value, 0.25));
  if (scaleIn.stopLoss == null || scaleIn.targetPrice == null || tick(draft.stopLoss) !== scaleIn.stopLoss || tick(draft.takeProfit) !== scaleIn.targetPrice) {
    return `Přikoupení musí mít SL a TP pozice (SL ${scaleIn.stopLoss?.toFixed(2) ?? '?'}, TP ${scaleIn.targetPrice?.toFixed(2) ?? '?'}) — vrať je, nic se neodeslalo.`;
  }
  if (draft.type !== 'market' && quantity > 1) return 'Čekající přikoupení (Limit/Stop) jde zatím jen po 1 kontraktu — větší množství Marketem.';
  if (scaleIn.quantity + quantity > maxContracts) return `Pozice by měla ${scaleIn.quantity + quantity} kontraktů — strop účtu je ${maxContracts}.`;
  return scaleIn.canAdd ? null : scaleIn.reason ?? 'Přikoupení teď nejde.';
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

/**
 * Správa obchodu z čar telefonu (2. 11. 2026) — PŘESNĚ podmínky PC grafu:
 * `manage` jen s capability workeru a jediným vlastním obchodem leadera (PC `onManageEntry`),
 * × u pozice jen za dostupného runtime, zapnuté kopírky a ne shadow (PC `canClose`),
 * průměr pro BE jen když graf ukazuje stav pollu (PC `manageEntryAvgPrice`).
 */
export function livePhoneManageFields<M>(input: {
  manageSupported: boolean;
  closeCapability: boolean;
  ownEntry: { entryAvgPrice?: number | null } | null | undefined;
  manage: M;
  runtimeAvailable: boolean;
  armed: boolean;
  shadowMode: boolean;
  chartShowsPoll: boolean;
}): { manage?: M; closeSupported: boolean; entryAvg: number | null } {
  return {
    ...(input.manageSupported && input.ownEntry ? { manage: input.manage } : {}),
    closeSupported: input.closeCapability && input.runtimeAvailable && input.armed && !input.shadowMode,
    entryAvg: input.chartShowsPoll ? input.ownEntry?.entryAvgPrice ?? null : null,
  };
}
