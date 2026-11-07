/**
 * C7 — „Zrušit vše“ = zrušit VLASTNÍ čekající vstupy, nikdy ochranu pozice
 * (3. 11. 2026, docs/reviews/trading-gaps-designs/safety.md, oponentura copier-design-critic).
 *
 * ČISTÁ logika bez IO, sdílená workerem a UI:
 * - `selectOwnPendingEntries` — worker z ní staví status `pendingOwnEntries`
 *   (vlastní přijatý ruční vstup / přikoupení ∩ otevřený příkaz leadera s nulovým fillem).
 *   Ochranné nohy pozice, nohy čekajícího vstupu (odejdou s parentem), částečně
 *   vyplněný vstup a cizí příkazy z definice vypadnou — jen se spočítají pro text potvrzení.
 * - `cancelEntryVerdict` — výsledek zrušení JEN stavem u brokera (adaptér hlásí úspěch
 *   `cancelOrder` i u vyplněného příkazu; INV-TRAD-02: zrušení s cumQty > 0 je dílčí). Fill nemusel
 *   pozici otevřít: tvar proti pozici na opačné straně má vlastní text (`opposite`).
 * - UI: dvoukrokové potvrzení s klíčem „co jsem viděl“, text potvrzení, sekvenční
 *   odeslání N× `manage-leader-order cancel-entry` (každý s vlastním `operationId`,
 *   nic se automaticky neopakuje) a výsledek po položkách; Dashboard „Zrušit příkaz“
 *   jen u vlastního čekajícího vstupu.
 *
 * Žádný nový příkaz workeru ani relaye: `cancel-entry` existuje (fáze 2a), smí i za
 * DISARMED / kill (snižuje riziko), brzda ho nezneplatní.
 */
import {
  buildLeaderOrderManageCommand,
  validateLeaderOrderManage,
  type LeaderOrderManageCommand,
  type LeaderOrderManageResult,
} from './leaderOrderManage.js';

export type PendingEntrySide = 'Buy' | 'Sell';

/** Vlastní čekající vstup leadera, který jde zrušit (`cancel-entry`). Jen zobrazení (INV-UI-01/03). */
export interface PendingOwnEntry {
  /** Klíč příkazu `cancel-entry` (`entry:…`). */
  entryOperationId: string;
  entryBrokerOrderId: string;
  symbol: string;
  side: PendingEntrySide;
  /** Počet kontraktů příkazu u brokera — `expect.quantity`. */
  quantity: number;
  orderType: 'Limit' | 'Stop';
  /** Cena příkazu u brokera (Limit = limit, Stop = stop) — `expect.price` („co jsem viděl“). */
  price: number;
  /** Čekající přikoupení do otevřené pozice. */
  scaleIn: boolean;
  createdAt: number;
}

/** Otevřené příkazy leadera, kterých se „Zrušit čekající“ nikdy nedotkne — jen pro text potvrzení. */
export interface PendingCancelContext {
  /** Příkazy bez stopy appky (Tradovate, TradingView, sledované OSO) — zruš v Tradovate nebo Flatten. */
  foreignOrders: number;
  /** SL/TP nohy otevřené pozice (vstup vyplněný) — zůstávají. */
  protectiveLegs: number;
  /** Vlastní vstup částečně vyplněný a dál pracující — neruší se (INV-TRAD-02), zavři × / Flatten. */
  partialEntries: number;
  /** Vlastní příkaz, který teď zrušit nejde (běží jeho zrušení, změnil se mimo appku, nevyřešená změna). */
  otherOwnOrders: number;
  /** Proč teď nejde zrušit nic (worker by odmítl) — tlačítko neaktivní s tímto textem. */
  blockedReason: string | null;
}

/** Podmnožina durable `CopierManualEntryRecord`, kterou C7 čte. */
export interface PendingEntryRecordView {
  operationId: string;
  status: string;
  createdAt: number;
  tag?: string;
  scaleIn?: boolean;
  bare?: boolean;
  entryBrokerOrderId?: string;
  stopBrokerOrderId?: string;
  targetBrokerOrderId?: string;
  lateEntryBrokerOrderId?: string;
  /**
   * Durable stav cíleného zrušení workerem (`cancel.status`) — jen informace; o vyloučení z nabídky
   * rozhoduje `excluded` (běžící zrušení), ne durable `sending` (oponentura C12 kolo 2, P3).
   */
  cancelStatus?: 'sending' | 'sent' | 'failed';
  request: { accountId: number; symbol: string; side: PendingEntrySide; quantity: number; orderType: string };
}

/** Podmnožina `BrokerOrder`, kterou C7 čte. */
export interface PendingOrderView {
  brokerOrderId: string;
  accountId: number;
  symbol: string;
  side: PendingEntrySide;
  orderType: string;
  status: string;
  quantity: number;
  filledQuantity: number;
  limitPrice?: number;
  stopPrice?: number;
  parentOrderId?: string;
  tag?: string;
}

const OPEN = new Set(['working', 'pending']);
const isOpen = (status: string) => OPEN.has(status);
export const PENDING_OWN_ENTRIES_MAX = 10;

/**
 * Výběr vlastních čekajících vstupů leadera (worker → status). Vstup se vybere jen když:
 * záznam je `acknowledged`, na leaderovi, Limit/Stop (Market nikdy nečeká), má id vstupu
 * i obou nohou (jinak worker odmítne `not-own-entry`); příkaz u brokera je otevřený, s fillem 0,
 * stejného symbolu, strany a typu, není to noha (`parentOrderId`) a jeho id není id žádné
 * vlastní nohy; neběží jeho zrušení ani nevyřešená změna (`excluded`).
 */
export function selectOwnPendingEntries(input: {
  leaderAccountId: number | null;
  records: readonly PendingEntryRecordView[];
  openOrders: Iterable<PendingOrderView>;
  /** true = u záznamu běží zrušení / nevyřešená změna — teď ho nenabízet. */
  excluded?: (operationId: string) => boolean;
  /** Worker by teď každé zrušení odmítl (např. nevyřešený ruční vstup). */
  blockedReason?: string | null;
}): { entries: PendingOwnEntry[]; context: PendingCancelContext } {
  const leader = input.leaderAccountId;
  const context: PendingCancelContext = {
    foreignOrders: 0, protectiveLegs: 0, partialEntries: 0, otherOwnOrders: 0, blockedReason: input.blockedReason ?? null,
  };
  if (leader == null) return { entries: [], context };
  const leaderRecords = input.records.filter(record => record.request.accountId === leader);
  const ownEntryIds = new Map<string, PendingEntryRecordView>();
  const ownLegParent = new Map<string, string | undefined>();
  const ownTags = new Set<string>();
  for (const record of leaderRecords) {
    const entryId = record.entryBrokerOrderId ?? record.lateEntryBrokerOrderId;
    if (entryId) ownEntryIds.set(entryId, record);
    if (record.stopBrokerOrderId) ownLegParent.set(record.stopBrokerOrderId, entryId);
    if (record.targetBrokerOrderId) ownLegParent.set(record.targetBrokerOrderId, entryId);
    if (record.tag) for (const suffix of ['', 's', 't']) ownTags.add(`${record.tag}${suffix}`);
  }
  const open = [...input.openOrders].filter(order => order.accountId === leader && isOpen(order.status));
  const selected = new Map<string, PendingOwnEntry>();
  for (const order of open) {
    const record = ownEntryIds.get(order.brokerOrderId);
    if (!record) continue;
    if (order.filledQuantity > 0) continue; // spočítá se níže jako částečně vyplněný
    const type = record.request.orderType;
    const price = type === 'Limit' ? order.limitPrice : type === 'Stop' ? order.stopPrice : undefined;
    const eligible = record.status === 'acknowledged'
      && (type === 'Limit' || type === 'Stop')
      && record.entryBrokerOrderId === order.brokerOrderId
      // Holý Limit/Stop nemá nohy žádné, běžný vstup vždy obě.
      && (record.bare === true
        ? !record.stopBrokerOrderId && !record.targetBrokerOrderId
        : !!record.stopBrokerOrderId && !!record.targetBrokerOrderId)
      && record.stopBrokerOrderId !== order.brokerOrderId && record.targetBrokerOrderId !== order.brokerOrderId
      // Nikdy noha: ani vazba na parent, ani id některé vlastní nohy.
      && order.parentOrderId == null && !ownLegParent.has(order.brokerOrderId)
      && order.symbol === record.request.symbol && order.side === record.request.side && order.orderType === type
      && typeof price === 'number' && Number.isFinite(price) && price > 0
      && Number.isSafeInteger(order.quantity) && order.quantity >= 1 && order.quantity <= 50
      // Oponentura C12 kolo 2 (P3): durable `cancel: sending` bez běžícího jobu (restart, incident
      // „zruš ho v Tradovate“) vstup NEvylučuje — rozhoduje `excluded` (PRÁVĚ běžící zrušení workerem);
      // jinak by na telefonu zbyl jen Flatten, ačkoli serverová brána C7 ruční zrušení pouští.
      && !(input.excluded?.(record.operationId) ?? false);
    if (!eligible || selected.has(order.brokerOrderId)) continue;
    selected.set(order.brokerOrderId, {
      entryOperationId: record.operationId, entryBrokerOrderId: order.brokerOrderId, symbol: order.symbol,
      side: order.side, quantity: order.quantity, orderType: type as 'Limit' | 'Stop', price: price!,
      scaleIn: record.scaleIn === true, createdAt: record.createdAt,
    });
  }
  for (const order of open) {
    if (selected.has(order.brokerOrderId)) continue;
    // Noha má přednost (id nohy je noha, i kdyby ho nějaký záznam vydával za vstup).
    if (ownLegParent.has(order.brokerOrderId) || (order.parentOrderId != null && ownEntryIds.has(order.parentOrderId))) {
      // Pozastavená noha vybraného čekajícího vstupu odejde s parentem (nativní OSO); ostatní chrání pozici.
      const parent = ownLegParent.get(order.brokerOrderId) ?? order.parentOrderId;
      if (parent == null || !selected.has(parent)) context.protectiveLegs += 1;
      continue;
    }
    const ownEntry = ownEntryIds.get(order.brokerOrderId);
    if (ownEntry) {
      // Zbytek holého Limit/Stop se ruší vlastní čarou s ×, ne touto cestou, a není to zákaz rušení.
      if (ownEntry.bare === true && order.filledQuantity > 0) continue;
      if (order.filledQuantity > 0) context.partialEntries += 1;
      else context.otherOwnOrders += 1;
      continue;
    }
    if (order.tag && ownTags.has(order.tag)) context.otherOwnOrders += 1;
    else context.foreignOrders += 1;
  }
  const entries = [...selected.values()].sort((left, right) => left.createdAt - right.createdAt).slice(0, PENDING_OWN_ENTRIES_MAX);
  return { entries, context };
}

/**
 * Rada u částečně vyplněného vstupu (oponentura C7 kolo 2, P3): × (`close-position`) chce vstup vyplněný
 * PŘESNĚ na qty a částečnou pozici odmítne (`shape`) — jediná cesta z appky je Flatten.
 */
export const PARTIAL_CLOSE_HINT = 'zavři ji Flattenem (× u částečně vyplněné pozice nejde).';

/**
 * Worker před `cancel-entry` (oponentura C7 kolo 2, P3 „nikdy nohu“): cíl musí být opravdu vstup —
 * nevěří jen id ze záznamu (chyba mapování ACK, poškozený store). Noha má `parentOrderId` nebo je id
 * některé známé ochranné nohy; u vlastního vstupu navíc strana a typ = záznam. `null` = cíl je vstup.
 *
 * Kolo 3 (P3, obrana do hloubky, INV-BRAKE-01/02): uživatelův samostatný ochranný příkaz z Tradovate
 * (bez parentu, žádný záznam ho nezná, strana i typ můžou sedět) prozradí jen pozice — příkaz na
 * OPAČNÉ straně, než je otevřená pozice leadera, by ji zmenšil = ochrana, ne vstup. Přikoupení je vždy
 * na stejné straně a běžný vstup jde jen z flat, takže legitimní zrušení to neblokuje.
 */
export function cancelEntryTargetProblem(input: {
  order: { brokerOrderId: string; side: string; orderType: string; parentOrderId?: string | null };
  /** Strana a typ ze záznamu vlastního vstupu; u sledovaného obchodu (2b) `null`. */
  expected: { side: string; orderType: string } | null;
  /** Id všech známých ochranných nohou (vlastní záznamy, OSO/bracket outboxy). */
  legIds: ReadonlySet<string>;
  /** Pozice leadera na symbolu se znaménkem (cache streamu); `null` / 0 = žádná známá pozice. */
  leaderNet?: number | null;
}): string | null {
  if (input.order.parentOrderId != null) return 'Cíl zrušení je noha jiného příkazu (má parent) — nic se nezrušilo.';
  if (input.legIds.has(input.order.brokerOrderId)) return 'Cíl zrušení je ochranná noha (SL/TP) — nic se nezrušilo.';
  if (input.expected && (input.order.side !== input.expected.side || input.order.orderType !== input.expected.orderType)) {
    return 'Cíl zrušení nesedí se vstupem (strana / typ) — nic se nezrušilo.';
  }
  const net = input.leaderNet ?? 0;
  if (net !== 0 && (input.order.side === 'Buy') !== (net > 0)) {
    return `Cíl zrušení by zmenšil otevřenou pozici leadera (${net}) — je to ochrana, ne vstup; nic se nezrušilo, zkontroluj ho v Tradovate.`;
  }
  return null;
}

/**
 * Vstup se při rušení vyplnil, ale leader je na symbolu ověřeně flat a nic nepracuje (oponentura C7 kolo 2,
 * P3): obchod mezitím skončil (SL/TP, Flatten, uživatel) — pravdivý text bez „pozice je otevřená“ a bez
 * incidentu; kauzalita se netvrdí.
 */
export function cancelEntryFilledFlatReason(outcome: { code: 'entry-filled' | 'entry-partially-filled'; filled: number }): string {
  return `${outcome.code === 'entry-filled' ? `Vstup se vyplnil (${outcome.filled}) dřív, než ho broker zrušil` : `Vstup se z části vyplnil (${outcome.filled}), zbytek zrušen`}`
    + ' — pozice už je zavřená a nic nepracuje (ověřeno čtením; příčina neověřena).';
}

/**
 * Oponentura C12 kolo 5 (P2, INV-UI-03): tvar zrušeného vstupu. `opposite` = vlastní vstup z flat se rušil
 * proti pozici leadera na OPAČNÉ straně (pozice mimo appku, durable `cancel.opposite` z předčtení) — jeho
 * fill pozici zmenšil, zavřel nebo otočil; text nesmí tvrdit „pozice je otevřená“. Jen text, ochranu
 * rozhoduje kontrola nohou a pozice (`legsProtectionProblem` + `fillPositionProblem`).
 */
export type CancelEntryShape = { opposite?: boolean };
/** Tvar fillu vstupu proti pozici na opačné straně (bez tvrzení „pozice je otevřená“). */
export const OPPOSITE_FILL_SHAPE = 'šel proti pozici leadera na opačné straně, takže ji zmenšil, zavřel nebo otočil; jeho SL/TP mohou pracovat bez pozice jako nové vstupy';
const OPPOSITE_FILL_NOTE = `${OPPOSITE_FILL_SHAPE} — ověřuji čtením.`;

/** Výsledek zrušení vstupu podle stavu u brokera (worker; INV-MODE-02 duch, INV-TRAD-02). */
export type CancelEntryVerdict =
  | { status: 'acknowledged'; code: 'canceled'; reason: string }
  | { status: 'rejected'; code: 'entry-filled' | 'entry-partially-filled'; reason: string; filled: number }
  | { status: 'waived'; code: 'entry-ended'; reason: string };

/**
 * Stav vstupu po zrušení → výsledek. `null` = zatím nerozhodnuto (příkaz dál pracuje / není vidět).
 * Úspěch jen `canceled` s nulovým fillem; jakýkoli fill = zrušení nemělo (plný) účinek a pozice
 * je otevřená — nikdy „zrušeno“.
 */
export function cancelEntryVerdict(
  order: { status: string; quantity: number; filledQuantity: number } | null | undefined,
  options: CancelEntryShape = {},
): CancelEntryVerdict | null {
  if (!order || isOpen(order.status)) return null;
  const filled = Math.max(0, order.filledQuantity);
  if (order.status === 'filled' || (filled > 0 && filled >= order.quantity)) {
    const qty = Math.max(filled, order.quantity);
    return { status: 'rejected', code: 'entry-filled', filled: qty,
      reason: options.opposite
        ? `Vstup se vyplnil (${qty}) dřív, než ho broker zrušil — ${OPPOSITE_FILL_NOTE}`
        : `Vstup se vyplnil (${qty}) dřív, než ho broker zrušil — pozice je otevřená; zavři ji × nebo Flattenem.` };
  }
  if (filled > 0) {
    return { status: 'rejected', code: 'entry-partially-filled', filled,
      reason: options.opposite
        ? `Vstup se z části vyplnil (${filled}/${order.quantity}), zbytek zrušen — ${OPPOSITE_FILL_NOTE}`
        : `Vstup se z části vyplnil (${filled}/${order.quantity}), zbytek zrušen — pozice ${filled} je otevřená; ${PARTIAL_CLOSE_HINT}` };
  }
  if (order.status === 'canceled') return { status: 'acknowledged', code: 'canceled', reason: 'zrušení potvrzeno stavem u brokera' };
  return { status: 'waived', code: 'entry-ended', reason: `vstup skončil bez vyplnění (${order.status})` };
}

/** Výsledek `cancel-entry` podle stavu vstupu u brokera včetně odmítnutí a neúčinného zrušení (worker). */
export type CancelEntryOutcome =
  | (CancelEntryVerdict & { open?: false })
  /** Vstup dál pracuje s dílčím fillem (zrušení odmítnuté / bez účinku): pozice je otevřená, stav není konečný. */
  | { status: 'rejected'; code: 'entry-partially-filled'; reason: string; filled: number; open: true }
  /** Vstup dál čeká s nulovým fillem: zrušení odmítnuté nebo bez účinku — nic se automaticky neopakuje. */
  | { status: 'rejected'; code: 'cancel-not-effective'; reason: string; open: true }
  /** Broker zrušení odmítl, ale vstup už je zrušený s nulovým fillem — ne tímto příkazem (kauzalita se netvrdí). */
  | { status: 'waived'; code: 'canceled-elsewhere'; reason: string; open?: false };

/**
 * C7 (oponentura diffu, P2): výsledek zrušení VŽDY stavem — i když broker zrušení odmítl („TooLateToCancel“
 * je nejčastější podoba závodu „vstup se vyplnil během rušení“). `brokerRejection` = definitivní odmítnutí
 * brokerem; `settled` = zápis skončil a od záznamu uplynula doba ustálení (vstup, který dál pracuje, pak
 * znamená „zrušení se neprojevilo“). `null` = zatím nerozhodnuto (příkaz nejde přečíst / může se ještě zrušit).
 */
export function cancelEntryOutcome(
  order: { status: string; quantity: number; filledQuantity: number } | null | undefined,
  context: { settled: boolean; brokerRejection?: string | null } & CancelEntryShape,
): CancelEntryOutcome | null {
  if (!order) return null;
  const rejection = context.brokerRejection ? context.brokerRejection.slice(0, 120) : null;
  if (!isOpen(order.status)) {
    const verdict = cancelEntryVerdict(order, { opposite: context.opposite });
    if (!verdict) return null;
    if (verdict.status === 'acknowledged' && rejection) {
      return { status: 'waived', code: 'canceled-elsewhere', reason: `vstup už je zrušený — ne tímto příkazem (broker zrušení odmítl: ${rejection})` };
    }
    return verdict;
  }
  if (!rejection && !context.settled) return null;
  const why = rejection ? `Broker zrušení odmítl (${rejection})` : 'Zrušení se u brokera neprojevilo';
  const filled = Math.max(0, order.filledQuantity);
  if (filled > 0) {
    return { status: 'rejected', code: 'entry-partially-filled', filled, open: true,
      reason: context.opposite
        ? `${why} — vstup je z části vyplněný (${filled}/${order.quantity}) a dál pracuje; ${OPPOSITE_FILL_NOTE}`
        : `${why} — vstup je z části vyplněný (${filled}/${order.quantity}) a dál pracuje; pozice ${filled} je otevřená, ${PARTIAL_CLOSE_HINT}` };
  }
  return { status: 'rejected', code: 'cancel-not-effective', open: true,
    reason: `${why} — vstup dál čeká; nic se automaticky neopakuje, zruš ho znovu nebo v Tradovate.` };
}

export type ProtectiveLegView = { status: string; quantity: number; filledQuantity: number; side?: string; symbol?: string };

/**
 * Proč nohy po vyplnění vstupu během zrušení pozici prokazatelně nechrání; `null` = chrání.
 * Chrání jen PŘESNĚ (oponentura diffu, P2): obě nohy `working`, otevřené množství každé = vyplněné
 * množství, opačná strana a stejný symbol jako vstup. Přerostlá noha (TP 2 nad pozicí 1, dílčí
 * kaskáda NEOVĚŘENÁ) by po vyplnění otočila pozici — není ochrana. Noha chybí, skončila, je
 * pozastavená nebo nejde přečíst = ochrana nepotvrzená.
 */
export function legsProtectionProblem(
  legs: ReadonlyArray<ProtectiveLegView | null>,
  filled: number,
  entry?: { side: string; symbol: string } | null,
): string | null {
  if (legs.length !== 2) return 'nohy neznámé';
  if (legs.some(leg => leg == null)) return 'noha nejde přečíst';
  const known = legs as ReadonlyArray<ProtectiveLegView>;
  const ended = known.find(leg => leg.status !== 'working');
  if (ended) return `noha ${ended.status}`;
  if (entry && known.some(leg => (leg.side != null && leg.side === entry.side) || (leg.symbol != null && leg.symbol !== entry.symbol))) {
    return 'noha nesedí se vstupem (strana / symbol)';
  }
  const open = known.map(leg => leg.quantity - leg.filledQuantity);
  if (open.some(quantity => quantity !== filled)) return `nohy nesedí s pozicí (qty ${open.join('/')} vs fill ${filled})`;
  return null;
}

/**
 * Oponentura C12 kolo 5 (P2, INV-TRAD-02 / INV-DEFAULT-02): nohy kryjí fill jen tehdy, když fill vstupu
 * pozici OTEVŘEL nebo zvětšil — pozice leadera na symbolu má znaménko strany vstupu a |net| ≥ fill. Fill
 * vstupu proti pozici na opačné straně ji zavřel / zmenšil / otočil a nohy (opačná strana vstupu) by pak
 * pozici zvětšily nebo otevřely novou: nejsou ochrana, i když qty sedí. `null` = pozice fill kryje;
 * `net` null (pozice nejde ověřit) nebo neznámá strana = problém (fail-closed). Čisté, bez IO.
 */
export function fillPositionProblem(input: { net: number | null; filled: number; side: string | null | undefined }): string | null {
  if (input.side !== 'Buy' && input.side !== 'Sell') return 'strana vstupu neznámá';
  if (input.net == null || !Number.isFinite(input.net)) return 'pozice leadera nejde ověřit';
  const signed = input.side === 'Buy' ? input.net : -input.net;
  if (signed > 0 && signed >= input.filled) return null;
  return `pozice leadera ${input.net} nekryje fill ${input.side === 'Buy' ? 'BUY' : 'SELL'} ${input.filled}`;
}

/** Nohy přesně kryjí vyplněné množství (viz `legsProtectionProblem`). */
export function legsProtectFill(
  legs: ReadonlyArray<ProtectiveLegView | null>,
  filled: number,
  entry?: { side: string; symbol: string } | null,
): boolean {
  return legsProtectionProblem(legs, filled, entry) == null;
}

// ── UI ──────────────────────────────────────────────────────────────────────

/** Dvoukrok: druhé klepnutí nejdřív po 350 ms (dvojklik se nepočítá) a nejpozději do 4 s. */
export const CANCEL_PENDING_CONFIRM_MIN_MS = 350;
export const CANCEL_PENDING_CONFIRM_WINDOW_MS = 4_000;

/** Klíč potvrzení = přesně ta sada vstupů, kterou uživatel viděl (id, cena, počet). */
export function cancelPendingConfirmKey(entries: readonly PendingOwnEntry[]): string {
  if (entries.length === 0) return '';
  return `cancel-pending:${entries.map(entry => `${entry.entryOperationId}@${entry.entryBrokerOrderId}:${entry.price}x${entry.quantity}`).sort().join('|')}`;
}

export interface CancelPendingConfirmState { key: string; armedAt: number }

/**
 * Krok dvoukrokového potvrzení. Potvrdí jen druhé klepnutí se STEJNÝM klíčem v okně
 * [350 ms, 4 s]; změna sady mezi klepnutími (vyplnění, nový vstup) = znovu první krok.
 */
export function cancelPendingConfirmStep(
  state: CancelPendingConfirmState | null,
  input: { key: string; now: number },
): { confirmed: boolean; next: CancelPendingConfirmState | null } {
  if (!input.key) return { confirmed: false, next: null };
  if (state && state.key === input.key) {
    const elapsed = input.now - state.armedAt;
    if (elapsed >= 0 && elapsed < CANCEL_PENDING_CONFIRM_MIN_MS) return { confirmed: false, next: state };
    if (elapsed >= CANCEL_PENDING_CONFIRM_MIN_MS && elapsed <= CANCEL_PENDING_CONFIRM_WINDOW_MS) return { confirmed: true, next: null };
  }
  return { confirmed: false, next: { key: input.key, armedAt: input.now } };
}

const plural = (count: number, one: string, few: string, many: string) => (count === 1 ? one : count >= 2 && count <= 4 ? few : many);

export function cancelPendingButtonLabel(entries: readonly PendingOwnEntry[]): string {
  return `Zrušit čekající (${entries.length})`;
}

/** Text potvrzení: co se zruší a co VĚDOMĚ zůstává. */
export function cancelPendingConfirmText(entries: readonly PendingOwnEntry[], context: PendingCancelContext | null | undefined): string {
  // Věta o pozici jen když nějaká ochranná noha opravdu je (oponentura diffu, P3); jinak nohy čekajícího vstupu odejdou s ním.
  const many = entries.length > 1;
  const legs = context && context.protectiveLegs > 0 ? 'SL/TP otevřené pozice zůstávají.' : many ? 'Jejich SL/TP se zruší s nimi.' : 'Jeho SL/TP se zruší s ním.';
  const parts = [`Zrušit ${entries.length} ${plural(entries.length, 'čekající vstup', 'čekající vstupy', 'čekajících vstupů')}? ${legs}`];
  if (context && context.foreignOrders > 0) parts.push(`Cizí příkazy: ${context.foreignOrders} — zruš v Tradovate nebo Flatten.`);
  if (context && context.partialEntries > 0) parts.push('Částečně vyplněný vstup se neruší — zavři × / Flatten.');
  return parts.join(' ');
}

/** Tlačítko jen s capability workeru, nad čerstvým neobnoveným stavem a s relay trasou (INV-UI-01/02). */
export function cancelPendingAvailability(input: {
  capability: boolean;
  statusFresh: boolean;
  restored: boolean;
  relayConnected: boolean;
  entries: readonly PendingOwnEntry[] | null | undefined;
  context: PendingCancelContext | null | undefined;
}): { show: boolean; enabled: boolean; reason: string | null } {
  const entries = input.entries ?? [];
  if (!input.capability || entries.length === 0) return { show: false, enabled: false, reason: null };
  if (!input.statusFresh || input.restored) return { show: true, enabled: false, reason: 'Stav kopírky se ověřuje…' };
  if (!input.relayConnected) return { show: true, enabled: false, reason: 'Zrušení jde jen přes relay — chybí připojení k workeru.' };
  if (input.context?.blockedReason) return { show: true, enabled: false, reason: input.context.blockedReason };
  return { show: true, enabled: true, reason: null };
}

/**
 * Dashboard „Zrušit příkaz“ (dřív `cancel-order`, worker ho odmítá): jen u vlastního
 * čekajícího vstupu leadera → `cancel-entry`. Jinde `null` = tlačítko se neukáže.
 * Stejné brány jako `cancelPendingAvailability` (oponentura C7 kolo 2, INV-FRESH-03 / INV-UI-01/02):
 * jen nad čerstvým neobnoveným statusem a s relay trasou — zastaralý status mutaci nenabídne.
 */
export function dashboardCancelTarget(
  order: { accountId: number; orderId: number | string },
  input: {
    capability: boolean;
    leaderAccountId: number | null | undefined;
    entries: readonly PendingOwnEntry[] | null | undefined;
    statusFresh: boolean;
    restored: boolean;
    relayConnected: boolean;
  },
): PendingOwnEntry | null {
  if (!input.capability || !input.statusFresh || input.restored || !input.relayConnected) return null;
  if (input.leaderAccountId == null || order.accountId !== input.leaderAccountId) return null;
  return (input.entries ?? []).find(entry => entry.entryBrokerOrderId === String(order.orderId)) ?? null;
}

/** `cancel-entry` pro jeden vstup (bez `operationId` validace — tu dělá `validateLeaderOrderManage`). */
export function buildCancelPendingCommand(
  entry: PendingOwnEntry,
  context: { groupId: string; leaderAccountId: number; operationId: string },
): LeaderOrderManageCommand {
  return buildLeaderOrderManageCommand({
    groupId: context.groupId, operationId: context.operationId, leaderAccountId: context.leaderAccountId,
    entryOperationId: entry.entryOperationId, symbol: entry.symbol, action: 'cancel-entry',
    expect: { price: entry.price, quantity: entry.quantity },
  });
}

export type CancelPendingOutcome =
  | 'canceled'
  | 'filled'
  | 'partially-filled'
  | 'not-pending'
  | 'blocked'
  | 'rejected'
  | 'unknown'
  | 'failed';

export interface CancelPendingItemResult {
  entry: PendingOwnEntry;
  operationId: string;
  outcome: CancelPendingOutcome;
  text: string;
  result?: LeaderOrderManageResult;
}

/** Výsledek workeru → výsledek položky (pravdivě: fill nikdy není „zrušeno“). */
export function classifyCancelPendingResult(result: LeaderOrderManageResult | null | undefined): { outcome: CancelPendingOutcome; text: string } {
  if (!result || result.type !== 'leader-order-managed' || result.action !== 'cancel-entry') {
    return { outcome: 'unknown', text: 'Výsledek zrušení chybí — zkontroluj leadera v Tradovate.' };
  }
  const codes = result.blockers.map(blocker => blocker.code);
  const firstText = result.blockers[0]?.text ?? result.reason ?? '';
  if (codes.includes('entry-filled')) return { outcome: 'filled', text: firstText };
  if (codes.includes('entry-partially-filled')) return { outcome: 'partially-filled', text: firstText };
  switch (result.status) {
    case 'acknowledged': return { outcome: 'canceled', text: result.reason && !/potvrzeno/.test(result.reason) ? `Zrušeno (${result.reason}).` : 'Zrušeno.' };
    case 'blocked':
      if (codes.includes('entry-not-pending')) return { outcome: 'not-pending', text: firstText || 'Vstup už nečeká — nic se nezrušilo.' };
      return { outcome: 'blocked', text: firstText || 'Nic se neodeslalo.' };
    case 'rejected': return { outcome: 'rejected', text: result.reason ?? (firstText || 'Broker zrušení odmítl.') };
    default: return { outcome: 'unknown', text: result.reason ?? 'Výsledek zrušení není potvrzený — ověřuji u brokera, zkontroluj leadera v Tradovate.' };
  }
}

/** Chyba relaye/agenta, u které je prokázané, že se nic neodeslalo (stejné vzory jako `LiveTradingScreen`). */
export const CANCEL_PENDING_NOT_SENT_PATTERN = /entry-busy|entry-superseded|entry-not-admitted|manage-daily-cap|entry-daily-cap|Chybí cesta|není čerstvě ověřený|nic se neodeslalo/;

/**
 * Sekvenční odeslání N× `cancel-entry` (desk: PC panel, Dashboard i telefon). Každá položka
 * má vlastní `operationId`; chyba jedné nezastaví ostatní (každé zrušení snižuje riziko),
 * ale nic se automaticky neopakuje. Neplatný příkaz se neodešle.
 */
export async function cancelOwnPendingEntries(input: {
  entries: readonly PendingOwnEntry[];
  groupId: string;
  leaderAccountId: number;
  /** Nové id `manage:…` pro každou položku (např. `manage:${uuid.slice(0, 24)}`). */
  newOperationId: () => string;
  /** Jedno odeslání přes relay (`copy-command`); vrací výsledek workeru. */
  send: (command: LeaderOrderManageCommand) => Promise<LeaderOrderManageResult | null | undefined>;
}): Promise<CancelPendingItemResult[]> {
  const results: CancelPendingItemResult[] = [];
  const seen = new Set<string>();
  for (const entry of input.entries) {
    if (seen.has(entry.entryOperationId)) continue;
    seen.add(entry.entryOperationId);
    const operationId = input.newOperationId();
    let command: LeaderOrderManageCommand;
    try {
      command = validateLeaderOrderManage(buildCancelPendingCommand(entry, { groupId: input.groupId, leaderAccountId: input.leaderAccountId, operationId }));
    } catch {
      results.push({ entry, operationId, outcome: 'failed', text: 'Neplatný příkaz zrušení — nic se neodeslalo.' });
      continue;
    }
    try {
      const result = await input.send(command);
      const verdict = classifyCancelPendingResult(result);
      results.push({ entry, operationId, ...verdict, ...(result ? { result } : {}) });
    } catch (error) {
      // Výjimka může přijít i po převzetí workerem (relay timeout, ztracený ACK) — „neodesláno“ jen u
      // prokazatelně neodeslaných vzorů (stejné jako LiveTradingScreen), jinak výsledek neznámý.
      const message = error instanceof Error ? error.message : String(error);
      results.push(CANCEL_PENDING_NOT_SENT_PATTERN.test(message)
        ? { entry, operationId, outcome: 'blocked', text: `Neodesláno (${message.slice(0, 160)}).` }
        : { entry, operationId, outcome: 'unknown', text: `Výsledek neznámý (${message.slice(0, 160)}) — zkontroluj leadera v Tradovate.` });
    }
  }
  return results;
}

/** Souhrn po položkách (toast / řádek pod tlačítkem). */
export function cancelPendingSummary(results: readonly CancelPendingItemResult[]): { tone: 'ok' | 'warn' | 'error'; text: string } {
  if (results.length === 0) return { tone: 'warn', text: 'Nebylo co zrušit.' };
  const canceled = results.filter(item => item.outcome === 'canceled').length;
  const opened = results.filter(item => item.outcome === 'filled' || item.outcome === 'partially-filled');
  const problems = results.filter(item => item.outcome !== 'canceled' && item.outcome !== 'filled' && item.outcome !== 'partially-filled');
  const parts = [`Zrušeno ${canceled} z ${results.length}.`];
  for (const item of [...opened, ...problems]) parts.push(item.text);
  const tone = opened.length > 0 || results.some(item => item.outcome === 'unknown' || item.outcome === 'failed') ? 'error'
    : canceled === results.length ? 'ok' : 'warn';
  return { tone, text: parts.join(' ') };
}
