import { liveRepeatClick, type LiveClickState } from './liveClickGate';
import { LEADER_ENTRY_MARKET_QUOTE_MAX_AGE_MS, type LiveEntryPreviewDraft } from './leaderEntryPreview';
import { livePhoneBareMarket, livePhoneSheetEntry, type LivePhoneQuote } from './livePhoneOrders';
import { snapToTick, type TicketDraft, type TicketInstrument, type TicketSide } from './liveOrderTicket';

/**
 * Holý Market (bez SL/TP) a „Přidat SL/TP“ — sdílená příprava pro PC panel
 * i telefon (U4/U2, 3. 11. 2026). Čistý výpočet: nic odsud neodesílá příkaz,
 * jen připraví záměr (návrh / vstup `attach`) pro stávající callbacky desku
 * (`placeLeaderEntry`, `attachBrackets`). Jedinou autoritou zůstávají brány
 * workeru (`executeManualEntry`, `prepareAttachBrackets`); tady jsou jen UI
 * pojistky, které smí být přísnější, nikdy volnější (INV-UI-01/02, INV-MANUAL-01).
 *
 * Holý Market jen tam, kde worker inzeruje `manual-entry-bare-v1` (manual-only
 * DEMO skupina) — bez capability ho UI vůbec nenabídne. Kotace je z kanálu ceny
 * grafu: kontrakt jen ze zdroje IBKR, cena jen jako `referencePrice` (odhad,
 * INV-UI-04); worker vše přepočítá ze své kotace IBKR.
 */

/** Kotace pro holý Market a attach: stejný tvar jako telefonní lišta (`symbol` jen z IBKR, `at` = příchod ticku). */
export type LiveBareQuote = LivePhoneQuote;

/** Stejná hranice jako telefonní lišta a worker: Market jen z kotace mladší než 5 s. */
export const LIVE_BARE_QUOTE_MAX_AGE_MS = LEADER_ENTRY_MARKET_QUOTE_MAX_AGE_MS;
/**
 * Nohy holé pozice odeslané s výsledkem přijato / neznámo: dokud se stav nezmění, nic se nenabízí znovu.
 * Po této době rozhoduje zase status workeru (ten druhé OCO stejně nepustí).
 */
export const LIVE_ATTACH_SENT_HOLD_MS = 30_000;

/** Text blokace zastaralé ceny: se skutečným stářím, ať je z hlášky vidět, jak velký výpadek byl. */
export const liveQuoteStaleText = (quoteAt: number | null, now: number): string => (
  quoteAt == null ? 'Cena není čerstvá (zatím žádná) — nic se neodeslalo.'
    : `Cena není čerstvá (stará ${(Math.max(0, now - quoteAt) / 1000).toFixed(1).replace('.', ',')} s, limit ${LIVE_BARE_QUOTE_MAX_AGE_MS / 1000} s) — nic se neodeslalo.`
);

// ── Záznam holého vstupu ve statusu workeru ─────────────────────────────────

/** Minimum z `controller.manualEntries` statusu workeru, které rozhodne o „Přidat SL/TP“. */
export interface LiveBareEntryRecord {
  operationId: string;
  status: string;
  createdAt: number;
  symbol: string;
  side?: 'Buy' | 'Sell';
  quantity?: number;
  /** Holý Market bez SL/TP (worker posílá jen `true`). */
  bare?: boolean;
  /** Nohy už doplněné. */
  protected?: boolean;
  /** false = leader na symbolu od fillu zplochl. */
  open?: boolean;
}

/**
 * Vlastní holý vstup, ke kterému jde doplnit SL/TP — vytknuté z desku
 * (`TradovateLiveDesk.tsx`, `phoneTrade`). Jen NEJNOVĚJŠÍ ruční vstup vůbec
 * (ne nejnovější holý) a jen otevřený: starý holý záznam nesmí „adoptovat“
 * pozici jiného vstupu (oponentura P1-3; worker totéž vrací jako `entry-closed`).
 */
export function newestOpenBareEntry<T extends LiveBareEntryRecord>(
  entries: readonly T[] | null | undefined,
  symbol: string | null | undefined,
): T | null {
  if (!entries || !symbol) return null;
  const newest = entries.reduce<T | null>((latest, entry) => (!latest || entry.createdAt > latest.createdAt ? entry : latest), null);
  return newest && newest.status === 'acknowledged' && newest.bare === true && newest.protected !== true
    && newest.open !== false && newest.symbol === symbol ? newest : null;
}

// ── Holý Market: brány a návrh ──────────────────────────────────────────────

/** Co UI o holém Marketu ví (vše z čerstvého stavu desku; nic z toho neautorizuje příkaz). */
export interface LiveBareMarketGate {
  /**
   * Brána desku: čerstvý neobnovený stav, zapnutá kopírka (ne shadow), žádný
   * rozpracovaný vstup, relay (telefon `LivePhoneTradeBridge.blockedReason`).
   * PC sem přidá svoje (cíl = skupina, worker umí odeslání). Null = smí.
   */
  blockedReason: string | null;
  /** Worker inzeruje nativní Market (`manual-entry-market-v1`). */
  marketSupported: boolean;
  /** Worker inzeruje holý Market (`manual-entry-bare-v1`). */
  bareSupported: boolean;
  /** Strop ručního vstupu skupiny (`manualEntryContractCap`). */
  maxContracts: number;
  quote: LiveBareQuote | null;
  /** Leader má na symbolu pozici nebo čekající vstup — holý Market jen z flat (worker `account-not-flat`). */
  positionOpen: boolean;
  now: number;
}

const contractsWord = (count: number) => (count === 1 ? 'kontrakt' : count >= 2 && count <= 4 ? 'kontrakty' : 'kontraktů');

/**
 * Proč holý Market teď nejde (null = UI ho pustí k tlačítku). Pořadí a texty
 * jako telefonní lišta (`LivePhoneChart` `sendBlocked(true)` → bare → strop),
 * navíc kontrola pozice, kterou lišta nechává workeru.
 */
export function liveBareMarketBlockReason(gate: LiveBareMarketGate, quantity: number): string | null {
  if (gate.blockedReason) return gate.blockedReason;
  if (!gate.marketSupported) return 'Worker zatím neumí Market.';
  if (!gate.quote || !(gate.now - gate.quote.at <= LIVE_BARE_QUOTE_MAX_AGE_MS)) return liveQuoteStaleText(gate.quote?.at ?? null, gate.now);
  if (!gate.quote.symbol) return 'Kontrakt není ověřený (cena není z IBKR) — nic se neodeslalo.';
  if (!gate.bareSupported) return 'Worker zatím neumí Market bez SL/TP.';
  if (!Number.isSafeInteger(quantity) || quantity < 1) return 'Neplatný počet kontraktů.';
  if (quantity > gate.maxContracts) return `Strop ručního vstupu je ${gate.maxContracts} ${contractsWord(gate.maxContracts)}.`;
  if (gate.positionOpen) return 'V pozici holý Market nejde — přikoupení jen se SL a TP pozice, jinak zavři ×.';
  return null;
}

/** Záměr holého Marketu (lišta / tlačítko): stejný tvar jako telefonní lišta, nebo proč ne. */
export function liveBareMarketIntent(gate: LiveBareMarketGate, side: TicketSide, quantity: number): LiveEntryPreviewDraft | { error: string } {
  const blocked = liveBareMarketBlockReason(gate, quantity);
  if (blocked) return { error: blocked };
  return livePhoneBareMarket(side, quantity, gate.quote!);
}

/** Návrh panelu = holý Limit nebo Stop (bez SL i TP)? */
export const isBarePendingTicketDraft = (draft: Pick<TicketDraft, 'type' | 'stopLoss' | 'takeProfit'>): boolean => (
  draft.type !== 'market' && draft.stopLoss == null && draft.takeProfit == null
);

/**
 * Proč holý Limit/Stop teď nejde (null = UI ho pustí k tlačítku). Jen do stropu skupiny, jen z flat a s čerstvou
 * cenou IBKR. Přes trh a vzdálenost Stopu rozhodne worker podle své kotace těsně před odesláním.
 */
export function liveBarePendingBlockReason(gate: LiveBareMarketGate, quantity: number): string | null {
  if (gate.blockedReason) return gate.blockedReason;
  if (!gate.quote || !(gate.now - gate.quote.at <= LIVE_BARE_QUOTE_MAX_AGE_MS)) return liveQuoteStaleText(gate.quote?.at ?? null, gate.now);
  if (!gate.quote.symbol) return 'Kontrakt není ověřený (cena není z IBKR) — nic se neodeslalo.';
  if (!Number.isSafeInteger(quantity) || quantity < 1) return 'Neplatný počet kontraktů.';
  if (quantity > gate.maxContracts) return `Strop ručního vstupu je ${gate.maxContracts} ${contractsWord(gate.maxContracts)}.`;
  if (gate.positionOpen) return 'V pozici Limit ani Stop bez SL/TP nejdou — jen z flat.';
  return null;
}

/** Návrh panelu = holý Market (Market bez SL i TP)? */
export const isBareTicketDraft = (draft: Pick<TicketDraft, 'type' | 'stopLoss' | 'takeProfit'>): boolean => (
  draft.type === 'market' && draft.stopLoss == null && draft.takeProfit == null
);

/**
 * Nohy návrhu panelu: jedna noha nikdy (payload by worker odmítl), Limit/Stop
 * obě, nebo s capability ani jednu, Market bez obou jen s capability. Null = nohy jsou v pořádku.
 */
export function liveTicketLegsProblem(draft: Pick<TicketDraft, 'type' | 'stopLoss' | 'takeProfit'>, bareSupported: boolean, barePendingSupported = false, bareLimitSupported = false): string | null {
  const hasStop = draft.stopLoss != null;
  const hasTarget = draft.takeProfit != null;
  if (hasStop !== hasTarget) return 'Vyplň SL i TP, nebo u Marketu ani jedno.';
  if (hasStop) return null;
  if (draft.type !== 'market') return barePendingSupported || (draft.type === 'limit' && bareLimitSupported) ? null : 'Limit a Stop potřebují SL i TP.';
  return bareSupported ? null : 'Worker zatím neumí Market bez SL/TP — doplň SL i TP.';
}

/**
 * Okamžitý holý Limit/Stop z menu pravého tlačítka: stejná brána a tvar jako tlačítko panelu.
 * Worker při odeslání znovu projde všechny brány.
 */
export function liveInstantBareOrder(input: {
  side: TicketSide; type: 'limit' | 'stop'; price: number; quantity: number;
  instrument: TicketInstrument; gate: LiveBareMarketGate;
}): LiveEntryPreviewDraft | { error: string } {
  const blocked = liveBarePendingBlockReason(input.gate, input.quantity);
  if (blocked) return { error: blocked };
  return livePhoneSheetEntry({
    side: input.side, type: input.type, price: input.price, sizing: 'qty', quantity: input.quantity, riskUsd: 0, stopLoss: null, takeProfit: null,
  }, input.instrument, input.gate.quote!);
}

/**
 * PC panel: holý Market z návrhu — stejný tvar jako list telefonu
 * (`livePhoneSheetEntry`), tedy i jako lišta. Velikost jen v kontraktech:
 * bez SL nejde velikost podle rizika (ticketQuantity by dala 0).
 */
export function liveTicketBareEntry(draft: TicketDraft, instrument: TicketInstrument, quote: LiveBareQuote): LiveEntryPreviewDraft | { error: string } {
  if (!isBareTicketDraft(draft) && !isBarePendingTicketDraft(draft)) return { error: 'Bez SL/TP je jen návrh bez SL i TP.' };
  if (draft.sizing !== 'qty') return { error: 'Bez SL/TP jen v kontraktech — bez SL nejde velikost podle rizika.' };
  return livePhoneSheetEntry(draft, instrument, quote);
}

// ── Dvoukrok smazání šablony (obchodní příkazy jdou jedním klikem, `lib/liveClickGate`) ──────────────────

/** Druhý klik nejdřív za 350 ms (dvojklik se nepočítá) a nejpozději do 4 s. */
export const LIVE_CONFIRM_MIN_MS = 350;
export const LIVE_CONFIRM_WINDOW_MS = 4_000;

/** Rozběhnuté „Opravdu?“: klíč akce a kdy padl první klik. */
export interface LiveConfirmState { key: string; at: number }

/**
 * Klik na tlačítko s potvrzením. `send: true` jen pro druhý klik se STEJNÝM
 * klíčem v okně [350 ms, 4 s); cokoli jiného jen (znovu) ukáže „Opravdu?“.
 * Příliš rychlý klik nic neodešle a kotvu posune na sebe: pauza 350 ms se počítá
 * od POSLEDNÍHO kliku, takže ani trojklik / „bušení“ do tlačítka nic nepotvrdí.
 */
export function liveConfirmClick(state: LiveConfirmState | null, key: string, now: number): { send: boolean; next: LiveConfirmState | null } {
  if (state && state.key === key && now < state.at + LIVE_CONFIRM_WINDOW_MS) {
    if (now - state.at >= LIVE_CONFIRM_MIN_MS) return { send: true, next: null };
    return { send: false, next: { key, at: now } };
  }
  return { send: false, next: { key, at: now } };
}

/** Ukazuje tlačítko právě „Opravdu?“ pro tento klíč? */
export const liveConfirmAsking = (state: LiveConfirmState | null, key: string, now: number): boolean => (
  state != null && state.key === key && now < state.at + LIVE_CONFIRM_WINDOW_MS
);

/**
 * Klíč holého Marketu proti dvojkliku: akce + kontrakt + strana + počet. Cena v klíči
 * není, u Marketu jede s každým tickem; worker ji znovu porovná s IBKR (posun ≤ 8 ticků).
 */
export function liveBareConfirmKey(draft: Pick<LiveEntryPreviewDraft, 'symbol' | 'side' | 'quantity' | 'orderType' | 'stopLoss' | 'takeProfit'> & { price?: number }): string {
  const bare = draft.stopLoss === undefined && draft.takeProfit === undefined;
  if (bare && draft.orderType !== 'Market') return `bare-pending:${draft.orderType}:${draft.symbol}:${draft.side}:${draft.quantity}:${draft.price}`;
  return `${bare ? 'bare-market' : 'entry'}:${draft.symbol}:${draft.side}:${draft.quantity}`;
}

/** Text výstražného tlačítka holého Marketu (PC panel). */
export function liveBareMarketButtonLabel(side: TicketSide, quantity: number, type: 'MARKET' | 'LIMIT' | 'STOP' = 'MARKET'): string {
  return `${side === 'buy' ? 'Koupit' : 'Prodat'} ${quantity} ${type} · BEZ SL/TP`;
}

/** Návrh pro worker = holý vstup (bez SL i TP)? Stejný výklad jako `liveBareConfirmKey`. */
export const isBarePreviewDraft = (draft: Pick<LiveEntryPreviewDraft, 'stopLoss' | 'takeProfit'>): boolean => (
  draft.stopLoss == null && draft.takeProfit == null
);

export const LIVE_BARE_POSITION_UNVERIFIED = 'Pozice není ověřená — holý Market teď nejde.';

/**
 * Pozice pro bránu holého Marketu z PC panelu (oponentura vlny B, unknown ≠ flat):
 * souhrn nebo čekající vstup leadera = ne flat; neověřené čtení (`issue`, např. stav
 * starší než 45 s, chybějící účet, rozjetí) i úplně chybějící data = NEZNÁMO, tedy
 * taky ne flat — s vlastním textem. Autoritou zůstává worker (`account-not-flat`).
 */
export function liveTicketBarePosition(
  position: { summary: unknown; issue: string | null } | null | undefined,
  leaderPosition: unknown,
): { open: boolean; reason: string | null } {
  if (!position || position.issue != null) return { open: true, reason: LIVE_BARE_POSITION_UNVERIFIED };
  if (position.summary != null || leaderPosition != null) return { open: true, reason: null };
  return { open: false, reason: null };
}

/**
 * Klik na výstražné tlačítko holého Marketu (PC `sendDirect`). Brána se vyhodnotí v okamžiku
 * kliku (kotace ≤ 3 s, flat, strop, brána desku); první klik odesílá, dvojklik se spolkne.
 */
export function liveBareSendClick(input: {
  gate: LiveBareMarketGate;
  last: LiveClickState | null;
  draft: Pick<LiveEntryPreviewDraft, 'symbol' | 'side' | 'quantity' | 'orderType' | 'stopLoss' | 'takeProfit'> & { price?: number };
}): { send: boolean; next: LiveClickState | null; blocked: string | null } {
  const blocked = input.draft.orderType === 'Market'
    ? liveBareMarketBlockReason(input.gate, input.draft.quantity)
    : liveBarePendingBlockReason(input.gate, input.draft.quantity);
  if (blocked) return { send: false, next: input.last, blocked };
  const step = liveRepeatClick(input.last, liveBareConfirmKey(input.draft), input.gate.now);
  return { send: step.send, next: step.next, blocked: null };
}

export const LIVE_PREVIEW_PLACE_BARE = 'Vstup bez SL/TP odešle jen velké tlačítko panelu.';

/**
 * Klik „Odeslat“ v Náhledu (PC `PreviewSection`): první klik odesílá, dvojklik se spolkne (klíč =
 * id odeslání náhledu + celý návrh včetně ceny). Holý Market odtud nikdy (jde jen přes
 * `liveBareSendClick`). Čerstvost náhledu a brána panelu se kontrolují v okamžiku kliku.
 * Worker při odeslání znovu projde všechny brány.
 */
export function livePreviewPlaceClick(input: {
  last: LiveClickState | null;
  draft: Pick<LiveEntryPreviewDraft, 'stopLoss' | 'takeProfit'>;
  operationId: string | null | undefined;
  previewKey: string;
  receivedAt: number | null | undefined;
  blockedReason: string | null;
  freshMs: number;
  now: number;
}): { send: boolean; next: LiveClickState | null; reason: string | null } {
  if (isBarePreviewDraft(input.draft)) return { send: false, next: input.last, reason: LIVE_PREVIEW_PLACE_BARE };
  if (input.blockedReason) return { send: false, next: input.last, reason: input.blockedReason };
  if (!input.operationId || !input.previewKey) return { send: false, next: input.last, reason: 'Náhled chybí — zkontroluj znovu.' };
  const age = input.receivedAt == null ? Number.NaN : input.now - input.receivedAt;
  if (!(age >= 0 && age <= input.freshMs)) return { send: false, next: input.last, reason: 'Náhled už není čerstvý — zkontroluj znovu.' };
  const step = liveRepeatClick(input.last, `place:${input.operationId}:${input.previewKey}`, input.now);
  return { send: step.send, next: step.next, reason: null };
}

// ── „Přidat SL/TP“ k holému vstupu ─────────────────────────────────────────

/** Worker `MANUAL_ATTACH_MIN_TICKS`: nohy aspoň tolik ticků od trhu na správné straně. */
export const LIVE_ATTACH_MIN_TICKS = 8;
/** Výchozí nohy bez šablony: SL 10 b, TP 20 b od trhu (jako list telefonu). */
export const LIVE_ATTACH_DEFAULT_STOP_POINTS = 10;
export const LIVE_ATTACH_DEFAULT_TARGET_POINTS = 20;

/** Vstup deskového `attachBrackets` (stejný tvar jako `LivePhoneTradeBridge.attach`). */
export interface LiveAttachInput {
  groupLimitStateHash?: string | null;
  entryOperationId: string;
  symbol: string;
  quantity: number;
  expectPrice: number;
  stopLoss: number;
  takeProfit: number;
}

/** Cena, za kterou by se pozice zavřela: long = bid, short = ask (jako worker `exitSide`). */
export const liveAttachMarket = (side: 'long' | 'short', quote: Pick<LiveBareQuote, 'bid' | 'ask'>): number => (
  side === 'long' ? quote.bid : quote.ask
);

/** Předvyplněné nohy: ze šablony (body od trhu), jinak 10/20 b. Jen návrh do formuláře. */
export function liveAttachDefaults(
  side: 'long' | 'short',
  market: number,
  tickSize: number,
  template?: { stopPoints: number; targetPoints: number } | null,
): { stopLoss: number; takeProfit: number } {
  const d = side === 'long' ? 1 : -1;
  const stop = template && template.stopPoints > 0 ? template.stopPoints : LIVE_ATTACH_DEFAULT_STOP_POINTS;
  const target = template && template.targetPoints > 0 ? template.targetPoints : LIVE_ATTACH_DEFAULT_TARGET_POINTS;
  return { stopLoss: snapToTick(market - d * stop, tickSize), takeProfit: snapToTick(market + d * target, tickSize) };
}

/** Proč nohy neprojdou (≥ 8 ticků od trhu na správné straně, stejně jako worker); null = v pořádku. */
export function liveAttachProblem(side: 'long' | 'short', market: number, stopLoss: number, takeProfit: number, tickSize: number): string | null {
  if (![market, stopLoss, takeProfit].every(Number.isFinite)) return 'Vyplň SL i TP.';
  const gap = LIVE_ATTACH_MIN_TICKS * tickSize - 1e-9;
  const ok = side === 'long'
    ? stopLoss <= market - gap && takeProfit >= market + gap
    : stopLoss >= market + gap && takeProfit <= market - gap;
  return ok ? null : `SL i TP musí být aspoň ${LIVE_ATTACH_MIN_TICKS} ticků od trhu na správné straně (trh ${market.toFixed(2)}).`;
}

/**
 * Záměr „Odeslat SL a TP“ k vlastnímu holému vstupu, nebo proč ne. Bez brány
 * zapnutí kopírky: attach snižuje riziko a smí i za DISARMED (INV-MANUAL-01);
 * čerstvost stavu hlídá deskový callback. Množství = množství holého vstupu
 * (worker ho porovná s `expect.quantity`), cena = trh z čerstvé kotace IBKR téhož kontraktu.
 */
export function liveAttachIntent(input: {
  bareEntry: Pick<LiveBareEntryRecord, 'operationId' | 'symbol' | 'side' | 'quantity'> | null;
  /** Pozice leadera na symbolu grafu; `pending` = jen čekající vstup (žádná pozice). */
  position: { side: 'long' | 'short'; quantity: number; symbol: string; pending?: unknown } | null;
  quote: LiveBareQuote | null;
  stopLoss: number | null;
  takeProfit: number | null;
  tickSize: number;
  now: number;
}): { attach: LiveAttachInput } | { error: string } {
  const { bareEntry, position, quote } = input;
  if (!bareEntry) return { error: 'Nohy jde doplnit jen k vlastnímu přijatému Marketu bez SL/TP.' };
  const side = bareEntry.side === 'Buy' ? 'long' : bareEntry.side === 'Sell' ? 'short' : null;
  const quantity = bareEntry.quantity;
  if (!position || position.pending || side == null || position.side !== side || position.symbol !== bareEntry.symbol
    || quantity == null || !Number.isSafeInteger(quantity) || quantity < 1 || position.quantity !== quantity) {
    return { error: 'Pozice nesedí s Marketem (jiný počet nebo strana, nebo je zavřená) — nic se neodeslalo.' };
  }
  if (!quote || !(input.now - quote.at <= LIVE_BARE_QUOTE_MAX_AGE_MS)) return { error: liveQuoteStaleText(quote?.at ?? null, input.now) };
  if (quote.symbol !== bareEntry.symbol) return { error: 'Cena není z IBKR pro kontrakt pozice — nohy teď nejde ověřit.' };
  if (input.stopLoss == null || input.takeProfit == null) return { error: 'Vyplň SL i TP.' };
  const stopLoss = snapToTick(input.stopLoss, input.tickSize);
  const takeProfit = snapToTick(input.takeProfit, input.tickSize);
  const market = liveAttachMarket(side, quote);
  const problem = liveAttachProblem(side, market, stopLoss, takeProfit, input.tickSize);
  if (problem) return { error: problem };
  return { attach: { entryOperationId: bareEntry.operationId, symbol: bareEntry.symbol, quantity, expectPrice: market, stopLoss, takeProfit } };
}
