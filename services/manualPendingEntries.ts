/**
 * C12 — automatické zrušení VLASTNÍHO čekajícího vstupu z appky (z flat i přikoupení)
 * (4. 11. 2026, docs/reviews/trading-gaps-designs/safety.md, oponentura copier-design-critic).
 *
 * ČISTÁ logika bez IO; controller sebere zmrazený stav a rozhodne o JEDNOM cíleném
 * pokusu (`cancelOwnManualEntry`), výsledek pak ověří stavem u brokera (C7 `cancelEntryOutcome`).
 * - `pendingOwnEntryViolation` — tvrdé podmínky, za kterých čekající vlastní vstup smí
 *   existovat (jen pod živým ARM, mimo brzdy, v okně, mimo denní pauzu CME…). Přechodné
 *   brány (spojení, ingress, resync) sem nepatří — ty controller řeší ODKLADEM.
 * - `pendingEntryPreReadDecision` — čerstvé REST čtení vstupu těsně před zrušením
 *   (oponentura P1): zrušit jen vstup, který u brokera opravdu čeká s fillem 0; dílčí
 *   fill = NERUŠIT (zbytek by šel s nohami, kaskáda NEOVĚŘENÁ — stejně jako C16).
 * - `pendingEntryAutoCancelAt` — kdy se vstup sám zruší z časových pravidel (jen zobrazení).
 */
import { cancelEntryTargetProblem } from '../lib/liveCancelPending';
import type { OrderSide } from './brokerPort';

export type PendingOwnEntryKind = 'add' | 'from-flat';

/** Ustálení „pozice mimo appku“ (Position může předběhnout Fill — oponentura P1c). */
export const PENDING_ENTRY_OUTSIDE_SETTLE_MS = 2_000;

export interface PendingOwnEntryViolationInput {
  kind: PendingOwnEntryKind;
  armed: boolean;
  shadowMode: boolean;
  killSwitch: boolean;
  dayLockPending: boolean;
  dayLocked: boolean;
  pauseActive: boolean;
  managementOnly: boolean;
  leaderIneligible: boolean;
  /** Obchodní okno teď a za rezervu (`off` = vypnuté = uvnitř). */
  windowNow: 'inside' | 'outside' | 'off';
  windowAfterReserve: 'inside' | 'outside' | 'off';
  /** Uvnitř [16:00 − rezerva, 17:00) CT — denní pauza CME (`cmeDailyHaltWindow`). */
  cmeHaltWindow: boolean;
  now: number;
  sessionEndAt: number;
  armExpiresAt: number | null;
  reserveMs: number;
  /** Pozice leadera na symbolu ze streamu; null = neznámá (neznámá není flat). */
  net: number | null;
  side: OrderSide;
  /** Jen přikoupení: fill v jiné epizodě deníku než základ. */
  episodeMismatch: boolean;
  /** Jen z flat: vyplněné množství vstupu v cache (dílčí fill vysvětluje pozici). */
  entryFilled?: number;
  /** Jen z flat: pozice mimo appku trvá ≥ ustálení bez nezpracovaných eventů leadera. */
  outsidePositionSettled?: boolean;
}

/**
 * Proč vlastní čekající vstup nesmí dál existovat (= důvod jednoho cíleného zrušení), nebo null.
 * Čekající vstup smí existovat jen pod živým ARM (nový text INV-BRAKE-01); neznámá pozice
 * není flat — nic se neruší, čeká se na sync.
 */
export function pendingOwnEntryViolation(input: PendingOwnEntryViolationInput): string | null {
  if (!input.armed || input.shadowMode) return 'kopírka je vypnutá';
  if (input.killSwitch) return 'kill switch';
  if (input.dayLockPending || input.dayLocked) return 'denní zámek';
  if (input.pauseActive) return 'pauza pravidlem dne';
  if (input.managementOnly) return 'kopírka jen spravuje';
  if (input.leaderIneligible) return 'leader nesmí nové vstupy';
  if (input.windowNow === 'outside' || (input.windowNow === 'inside' && input.windowAfterReserve === 'outside')) return 'konec obchodního okna';
  if (input.cmeHaltWindow) return 'denní pauza CME (16:00–17:00 CT)';
  if (input.sessionEndAt - input.now < input.reserveMs) return 'konec broker session (17:00 CT)';
  if (input.armExpiresAt != null && input.armExpiresAt - input.now < input.reserveMs) return 'vyprší zapnutí kopírky';
  if (input.kind === 'add') {
    if (input.episodeMismatch) return 'přikoupení otevřelo nový obchod';
    if (input.net == null) return null;
    if (input.net === 0) return 'pozice je zavřená';
    if ((input.net > 0) !== (input.side === 'Buy')) return 'pozice je na druhé straně';
    return null;
  }
  // Z flat: pozice na symbolu bez fillu vstupu = pozice mimo appku — až po ustálení.
  if (input.net == null || input.net === 0) return null;
  if ((input.entryFilled ?? 0) > 0) return null;
  return input.outsidePositionSettled === true ? 'pozice mimo appku' : null;
}

/** Podmnožina `BrokerOrder` z autoritativního REST čtení vstupu. */
export interface PendingEntryReadOrder {
  brokerOrderId: string;
  symbol: string;
  side: string;
  orderType: string;
  status: string;
  quantity: number;
  filledQuantity: number;
  parentOrderId?: string | null;
  /** clOrdId z REST čtení (adaptér ho bere z příkazu, který příkaz založil); chybí = neznámý. */
  tag?: string;
}

export type PendingEntryPreRead =
  /**
   * Vstup u brokera čeká s fillem 0 a je to opravdu vstup — smí se zrušit (jeden pokus). `opposite` =
   * vlastní vstup z flat proti pozici leadera na opačné straně (kolo 4, P2) — durable do `cancel.opposite`
   * kvůli pravdivým textům po fillu během rušení (kolo 5, P2).
   */
  | { kind: 'cancel'; opposite?: true }
  /** Čtení nerozhodlo (nečitelné / neautoritativní) — nic se neruší, další ČTENÍ až po odstupu. */
  | { kind: 'unreadable' }
  /** Vstup už nečeká a nic se nevyplnilo — není co rušit. */
  | { kind: 'ended'; status: string }
  /** Vstup se mezitím (plně / z části a skončil) vyplnil — pozice je otevřená; nic se neruší. */
  | { kind: 'filled'; filled: number }
  /** Vstup dál čeká s dílčím fillem — zbytek se automaticky NERUŠÍ (INV-TRAD-02, C16). */
  | { kind: 'partial'; filled: number; quantity: number }
  /** Cíl není vstup (noha, jiná strana/typ, ochrana pozice) — nic se neruší. */
  | { kind: 'not-entry'; problem: string };

const OPEN = new Set(['working', 'pending']);

/**
 * Rozhodnutí z čerstvého REST čtení vstupu těsně před automatickým zrušením (oponentura C12 P1):
 * cache streamu může být pozadu (fill / Position před Fill), proto se ruší jen podle autoritativního
 * stavu. Stejná obrana „nikdy nohu, nikdy ochranu“ jako ruční `cancel-entry` (C7).
 */
export function pendingEntryPreReadDecision(input: {
  /** null = čtení selhalo nebo nebylo autoritativní. */
  order: PendingEntryReadOrder | null;
  expected: { side: string; orderType: string; symbol: string; tag?: string };
  legIds: ReadonlySet<string>;
  leaderNet: number | null;
  /**
   * Druh vlastního záznamu. Jen `from-flat` smí zrušit vlastní vstup proti pozici na opačné straně
   * (oponentura kolo 4, P2); bez údaje (a u přikoupení) platí konzervativní `not-entry`.
   */
  kind?: PendingOwnEntryKind;
  /**
   * Oponentura C12 kolo 5 (P3, A1): záložní důkaz vlastnictví, když REST čtení clOrdId (`tag`) NEVRÁTÍ
   * (adaptér ho skládá z `/command/deps`, u nativního `placeOSO` parentu NEOVĚŘENO): obě nohy ze záznamu
   * (id z ACK) ohraničeně přečtené autoritativně a obě mají `parentOrderId` = tento vstup. Uživatelův
   * samostatný ochranný příkaz takové děti nemá. Platí JEN bez tagu — tag, který nesedí, se nepřebíjí.
   */
  legsProveOwnership?: boolean;
}): PendingEntryPreRead {
  const { order } = input;
  if (!order) return { kind: 'unreadable' };
  if (order.symbol !== input.expected.symbol) return { kind: 'not-entry', problem: 'Cíl zrušení nesedí se vstupem (symbol) — nic se nezrušilo.' };
  // Oponentura C12 kolo 1 (P3): vlastní vstup (není noha, strana i typ = záznam) proti pozici leadera na
  // opačné straně (pozice mimo appku z flat, otočená pozice u přikoupení) není „ochrana“ — vlastní text.
  const net = input.leaderNet ?? 0;
  const ownShape = order.parentOrderId == null && !input.legIds.has(order.brokerOrderId)
    && order.side === input.expected.side && order.orderType === input.expected.orderType;
  const ownOpposite = ownShape && net !== 0 && (order.side === 'Buy') !== (net > 0);
  // Oponentura C12 kolo 4 (P2, INV-BRAKE-01): vlastní vstup Z FLAT proti pozici na opačné straně (ta vznikla
  // až po něm mimo appku — vstup z flat jinak projít nemůže) není ochrana, je to vlastní OSO, jehož nohy
  // by po zavření pozice otevřely novou pozici. Zruší se stejně jako na stejné straně (níž: jen čekající
  // s fillem 0; dílčí fill = incident). Tvar nestačí (poškozený záznam s id uživatelova ochranného příkazu
  // má stejný tvar — C7 „nikdy ochrana“): vlastnictví dokazuje clOrdId z REST čtení = tag záznamu; bez
  // clOrdId (kolo 5, P3) obě nohy záznamu s `parentOrderId` = vstup (`legsProveOwnership`). Tag, který
  // nesedí, se nohami nepřebíjí. Přikoupení (otočená pozice) a neprokázané vlastnictví = incident bez zrušení.
  const tagKnown = order.tag != null && order.tag !== '';
  const provenOwn = tagKnown ? order.tag === input.expected.tag : input.legsProveOwnership === true;
  if (ownOpposite && !(input.kind === 'from-flat' && provenOwn)) {
    return {
      kind: 'not-entry',
      problem: `Pozice leadera je na opačné straně (${net}) — vstup by ji zmenšil nebo otočil; nic se nezrušilo, zruš ho v Tradovate.`,
    };
  }
  const problem = cancelEntryTargetProblem({
    order: { brokerOrderId: order.brokerOrderId, side: order.side, orderType: order.orderType, parentOrderId: order.parentOrderId ?? null },
    expected: { side: input.expected.side, orderType: input.expected.orderType },
    legIds: input.legIds,
    // Dílčí fill vlastního vstupu vysvětluje pozici na stejné straně; ochrana = opačná strana
    // (kromě vlastního vstupu z flat proti pozici mimo appku — výše).
    leaderNet: ownOpposite ? null : input.leaderNet,
  });
  if (problem) return { kind: 'not-entry', problem };
  const filled = Math.max(0, order.filledQuantity);
  if (OPEN.has(order.status)) {
    if (filled > 0) return { kind: 'partial', filled, quantity: order.quantity };
    return ownOpposite ? { kind: 'cancel', opposite: true } : { kind: 'cancel' };
  }
  if (order.status === 'filled' || filled > 0) return { kind: 'filled', filled: Math.max(filled, order.status === 'filled' ? order.quantity : 0) };
  return { kind: 'ended', status: order.status };
}

/**
 * Oponentura C12 kolo 5 (P3, A1): potřebuje předčtení záložní důkaz vlastnictví z nohou? Jen vlastní
 * vstup z flat (tvar vlastního vstupu, ne noha) proti pozici na opačné straně, u kterého REST čtení
 * clOrdId nevrátilo — jinak se nic dalšího nečte (sdílený rate-limit rozpočet).
 */
export function pendingEntryNeedsLegOwnershipProof(input: {
  order: PendingEntryReadOrder | null;
  expected: { side: string; orderType: string; symbol: string };
  legIds: ReadonlySet<string>;
  leaderNet: number | null;
  kind?: PendingOwnEntryKind;
}): boolean {
  const { order } = input;
  if (!order || input.kind !== 'from-flat' || (order.tag != null && order.tag !== '')) return false;
  const net = input.leaderNet ?? 0;
  return order.symbol === input.expected.symbol && order.parentOrderId == null && !input.legIds.has(order.brokerOrderId)
    && order.side === input.expected.side && order.orderType === input.expected.orderType
    && net !== 0 && (order.side === 'Buy') !== (net > 0);
}

/**
 * Kdy se čekající vstup sám zruší podle časových pravidel (jen zobrazení PC panelu / telefonní
 * lišty — INV-UI-01/03; nic neautorizuje). Nejbližší z: začátek rezervy před denní pauzou CME,
 * před vypršením ARM. Konec obchodního okna se tu nepočítá (okno má víc slotů) — zruší ho revize.
 */
export function pendingEntryAutoCancelAt(input: {
  now: number;
  reserveMs: number;
  /** Začátek denní pauzy CME (16:00 CT téhož obchodního dne). */
  cmeHaltStartAt: number;
  armExpiresAt: number | null;
}): { at: number; reason: 'cme-halt' | 'arm-expiry' } | null {
  const candidates: Array<{ at: number; reason: 'cme-halt' | 'arm-expiry' }> = [];
  if (Number.isFinite(input.cmeHaltStartAt)) candidates.push({ at: input.cmeHaltStartAt - input.reserveMs, reason: 'cme-halt' });
  if (input.armExpiresAt != null && Number.isFinite(input.armExpiresAt)) candidates.push({ at: input.armExpiresAt - input.reserveMs, reason: 'arm-expiry' });
  const future = candidates.filter(candidate => candidate.at > input.now).sort((left, right) => left.at - right.at);
  return future[0] ?? null;
}
