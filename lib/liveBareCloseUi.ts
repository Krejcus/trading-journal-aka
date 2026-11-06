/**
 * C8 v UI (4. 11. 2026): × zavřít vlastní holý Market bez SL/TP v ručním DEMO.
 *
 * Jen výběr nabídky, klíč tlačítka a pravdivé texty výsledku — nic tady neodesílá.
 * Status `bareLeaderTrade` je jen zobrazení (INV-UI-01/03): o zavření rozhoduje
 * worker (`lib/manualBareClose.ts` — sólo skupina, ARMED ∧ ¬shadow ∧ ¬kill, tvar
 * u brokera, lot deníku, na symbolu nic nepracuje). Odeslání jde výhradně deskovou
 * cestou správy leadera (`buildLeaderOrderManageCommand` + `bareCloseManageFields`
 * → relay `copy-command`) přes sdílený zámek jednoho příkazu (`createLiveBareCloseRun`).
 */
import type { LeaderOrderManageResult } from './leaderOrderManage';
import { CANCEL_PENDING_NOT_SENT_PATTERN } from './liveCancelPending';
import type { BareLeaderTrade } from './manualBareClose';

export interface LiveBareCloseNotice { tone: 'ok' | 'bad' | 'warn'; text: string; at: number }

/** Nabídka × u holé pozice: co uživatel vidí (trade), klíč tlačítka a zda teď smí. */
export interface LiveBareCloseOffer {
  trade: BareLeaderTrade;
  /** Klíč potvrzení: akce + id cíle (`entryOperationId`) + tvar (kontrakt, strana, počet). */
  key: string;
  enabled: boolean;
  /** Proč teď ne (tlačítko neaktivní s tímto textem); null = smí. */
  reason: string | null;
}

/** Klíč × holé pozice: jiný vstup, kontrakt, strana nebo počet = změněná nabídka (`lib/liveClickGate`). */
export const liveBareCloseKey = (trade: Pick<BareLeaderTrade, 'entryOperationId' | 'symbol' | 'side' | 'quantity'>): string => (
  `close-bare:${trade.entryOperationId}:${trade.symbol}:${trade.side}:${trade.quantity}`
);

/** Id čáry vstupu holé pozice v grafu PC — nese id cíle, takže je i v klíči × a Shift+X. */
export const LIVE_BARE_LINE_PREFIX = 'live-position:entry:bare:';
export const liveBareLineId = (entryOperationId: string): string => `${LIVE_BARE_LINE_PREFIX}${entryOperationId}`;
/** `entryOperationId` z id čáry holé pozice; jiná čára = null. */
export const liveBareLineEntryId = (lineId: string): string | null => (
  lineId.startsWith(LIVE_BARE_LINE_PREFIX) && lineId.length > LIVE_BARE_LINE_PREFIX.length ? lineId.slice(LIVE_BARE_LINE_PREFIX.length) : null
);

const validTrade = (trade: BareLeaderTrade): boolean => (
  typeof trade.entryOperationId === 'string' && trade.entryOperationId.startsWith('entry:')
  && typeof trade.symbol === 'string' && trade.symbol.length > 0
  && (trade.side === 'Buy' || trade.side === 'Sell')
  && Number.isSafeInteger(trade.quantity) && trade.quantity >= 1
  && typeof trade.referencePrice === 'number' && Number.isFinite(trade.referencePrice) && trade.referencePrice > 0
);

/** Stejný holý obchod (vše, co jde do příkazu i do klíče). */
export function sameBareTrade(left: BareLeaderTrade | null | undefined, right: BareLeaderTrade | null | undefined): boolean {
  return left != null && right != null && left.entryOperationId === right.entryOperationId && left.symbol === right.symbol
    && left.side === right.side && left.quantity === right.quantity && left.referencePrice === right.referencePrice;
}

/**
 * Má UI nabídnout × u holé pozice? `null` = vůbec ne (starý worker bez capability, žádný holý
 * obchod, spravovatelný obchod s nohami na grafu, pozice leadera neznámá nebo nesedí s Marketem —
 * unknown ≠ flat, zůstává Flatten). Jinak nabídka; `enabled: false` s důvodem nad zastaralým nebo
 * obnoveným stavem, bez relaye a mimo zapnutou kopírku (ne shadow, ne kill — jako worker `not-armed`).
 */
export function liveBareCloseOffer(input: {
  /** `supportsCopierManualOrderCloseBare(agentStatus)`. */
  capability: boolean;
  /** `controller.bareLeaderTrade` (jen zobrazení). */
  trade: BareLeaderTrade | null | undefined;
  /** Na grafu je spravovatelný obchod s nohami (`ownManualEntry`) — × patří jemu. */
  managedTrade: boolean;
  statusFresh: boolean;
  restored: boolean;
  relayConnected: boolean;
  armed: boolean;
  shadowMode: boolean;
  killSwitch: boolean;
  /** Pozice leadera skupiny workeru na symbolu grafu (desk `chartLeaderPosition`); null = neznámá / žádná. */
  position: { side: 'long' | 'short'; quantity: number; symbol: string; pending: unknown } | null | undefined;
}): LiveBareCloseOffer | null {
  if (!input.capability || input.managedTrade) return null;
  const trade = input.trade;
  if (!trade || !validTrade(trade)) return null;
  const position = input.position;
  if (!position || position.pending != null || position.symbol !== trade.symbol || position.quantity !== trade.quantity
    || position.side !== (trade.side === 'Buy' ? 'long' : 'short')) return null;
  const key = liveBareCloseKey(trade);
  if (!input.statusFresh || input.restored) return { trade, key, enabled: false, reason: 'Stav kopírky se ověřuje — zavřít jde až nad čerstvým stavem.' };
  if (!input.relayConnected) return { trade, key, enabled: false, reason: 'Zavření jde jen přes relay — chybí připojení k workeru.' };
  if (!input.armed || input.shadowMode || input.killSwitch) {
    return { trade, key, enabled: false, reason: 'Zavřít jde jen za zapnuté kopírky (ne shadow, ne kill) — holou pozici zavři Flattenem.' };
  }
  return { trade, key, enabled: true, reason: null };
}

/** Text tlačítka (PC panel, telefon). */
export function liveBareCloseLabel(trade: Pick<BareLeaderTrade, 'side' | 'quantity'>): string {
  return `Zavřít ${trade.side === 'Buy' ? 'LONG' : 'SHORT'} ${trade.quantity} · bez SL/TP`;
}

const NOT_THIS_COMMAND = /ne tímto příkazem|příčina neověřena/;

/**
 * Výsledek workeru → pravdivý text (INV-MODE-02: rozhoduje stav u brokera, ne odpověď).
 * `acknowledged` = ověřeně flat; `waived` (worker hlásí jako `acknowledged` s důvodem
 * „ne tímto příkazem“) = flat, ale kauzalita neověřena; `rejected` = broker nic neprovedl;
 * `unknown` = „Neověřeno — zkontroluj Tradovate“, NIKDY „zavřeno“; `blocked` = neodesláno.
 */
export function liveBareCloseResultNotice(result: LeaderOrderManageResult | null | undefined, at: number): LiveBareCloseNotice {
  if (!result || result.type !== 'leader-order-managed' || result.action !== 'close-position') {
    return { tone: 'warn', text: 'Neověřeno — zkontroluj Tradovate (výsledek zavření chybí). Nic se neopakuje.', at };
  }
  const reason = result.reason ? result.reason.slice(0, 160) : null;
  switch (result.status) {
    case 'acknowledged':
      if (reason && NOT_THIS_COMMAND.test(reason)) return { tone: 'warn', text: `Leader je flat — ne tímto příkazem (${reason}).`, at };
      return { tone: 'ok', text: 'Holá pozice zavřena — ověřeno stavem u brokera.', at };
    case 'blocked': {
      const why = result.blockers.map(issue => issue.text).join(' ');
      return { tone: 'bad', text: `Neodesláno: ${why || 'nic se neodeslalo.'}`, at };
    }
    case 'rejected':
      return { tone: 'bad', text: `Broker zavření odmítl${reason ? ` (${reason})` : ''} — zkontroluj pozici v Tradovate, případně zavři Flattenem. Nic se neopakuje.`, at };
    default:
      return { tone: 'warn', text: 'Neověřeno — zkontroluj Tradovate (pozice může trvat). Nic se neopakuje.', at };
  }
}

/**
 * Výjimka z odeslání: prokazatelně neodeslané (zámek, čerstvost, relay, rozestup) = „Neodesláno“;
 * cokoli jiného (timeout relaye, ztracený výsledek) = „Neověřeno — zkontroluj Tradovate“.
 */
export function liveBareCloseErrorNotice(reason: unknown, at: number): LiveBareCloseNotice {
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'chyba';
  if (CANCEL_PENDING_NOT_SENT_PATTERN.test(message)) return { tone: 'bad', text: `Neodesláno: ${message.slice(0, 160)}`, at };
  return { tone: 'warn', text: `Neověřeno — zkontroluj Tradovate (${message.slice(0, 120)}). Nic se neopakuje.`, at };
}
