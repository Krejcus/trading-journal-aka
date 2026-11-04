/**
 * C7 v UI (4. 11. 2026): „Zrušit čekající“ (PC lišta pod grafem vedle Flatten, telefon)
 * a Dashboard „Zrušit“ u příkazu — jen zobrazení a záměr nad jádrem `lib/liveCancelPending.ts`.
 *
 * Nic tady neodesílá. Odeslání = deskový `cancelOwnPendingEntries` (N× `cancel-entry`, každý
 * s vlastním `operationId`, nic se neopakuje) přes sdílený zámek jednoho příkazu
 * (`createLiveCancelPendingRun`). Ochranné SL/TP, cizí příkazy ani částečně vyplněný vstup
 * se nikdy nenabídnou (vybírá worker, `pendingOwnEntries`; INV-MANUAL-01 C7).
 */
import {
  cancelPendingAvailability,
  cancelPendingButtonLabel,
  cancelPendingConfirmKey,
  cancelPendingConfirmText,
  dashboardCancelTarget,
  type PendingCancelContext,
  type PendingOwnEntry,
} from './liveCancelPending';

/**
 * Status přichází z workeru přes relay bez sanitizace a web s workerem se může rozjet ve verzi
 * (oponentura UI C7 kolo 1, P3 INV-UI-02 / INV-DEFAULT-02): pole s `null` prvkem, objekt místo
 * pole nebo položka bez ceny nesmí shodit render desku (a s ním OFF, Kill a Flatten). Do UI
 * projde jen položka se všemi poli, která jdou do klíče, textu a příkazu — jako nový objekt;
 * cokoli jiného vypadne (nic se nenabídne = fail-closed).
 */
export function validPendingOwnEntries(value: unknown): PendingOwnEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: PendingOwnEntry[] = [];
  for (const item of value) {
    if (item == null || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const { entryOperationId, entryBrokerOrderId, symbol, side, quantity, orderType, price } = raw;
    if (typeof entryOperationId !== 'string' || !entryOperationId.startsWith('entry:')) continue;
    if (typeof entryBrokerOrderId !== 'string' || entryBrokerOrderId.length === 0) continue;
    if (typeof symbol !== 'string' || symbol.length === 0) continue;
    if (side !== 'Buy' && side !== 'Sell') continue;
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1) continue;
    if (orderType !== 'Limit' && orderType !== 'Stop') continue;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;
    entries.push({
      entryOperationId, entryBrokerOrderId, symbol, side: side as PendingOwnEntry['side'], quantity,
      orderType: orderType as PendingOwnEntry['orderType'], price,
      scaleIn: raw.scaleIn === true,
      createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    });
  }
  return entries;
}

/**
 * Kontext potvrzení v UI: počty `null` = nejdou přečíst (co zůstává, nejde ověřit — unknown ≠ 0,
 * INV-UI-01, INV-DEFAULT-02). Jádro (`cancelPendingConfirmText`, `cancelPendingAvailability`)
 * dostane jen čitelné počty přes `corePendingCancelContext`.
 */
export interface PendingCancelContextView {
  foreignOrders: number | null;
  protectiveLegs: number | null;
  partialEntries: number | null;
  otherOwnOrders: number | null;
  blockedReason: string | null;
}

/** Kontext je, ale nejde přečíst (pole, text, číslo místo objektu): zrušení z appky zamčené. */
export const CANCEL_PENDING_CONTEXT_UNREADABLE = 'Stav čekajících příkazů nejde přečíst — zruš v Tradovate nebo Flatten.';
/** Věta potvrzení, když některý počet nejde přečíst (nikdy ho neukázat jako „nic nezůstává“). */
export const CANCEL_PENDING_REST_UNVERIFIED = 'Co zůstává (SL/TP pozice, cizí příkazy, částečně vyplněný vstup), nejde ověřit — zkontroluj Tradovate.';

/** Počet: nezáporné celé číslo; cokoli jiného (i chybějící pole — worker posílá všechna) = null. */
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * Kontext potvrzení ze statusu: jen počty a text důvodu. `null` / `undefined` = bez kontextu
 * (jako dřív). Jiný tvar než objekt (pole, text, číslo) — worker ho u neprázdné sady posílá vždy
 * jako objekt (`copierRuntimeController` `pendingCancelContext`), takže je to chyba tvaru dat —
 * = zablokováno (`CANCEL_PENDING_CONTEXT_UNREADABLE`, fail-closed; oponentura UI C7/C8 kolo 2).
 * Nečitelný počet = `null` (text pak řekne, že co zůstává, nejde ověřit).
 */
export function validPendingCancelContext(value: unknown): PendingCancelContextView | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { foreignOrders: null, protectiveLegs: null, partialEntries: null, otherOwnOrders: null, blockedReason: CANCEL_PENDING_CONTEXT_UNREADABLE };
  }
  const raw = value as Record<string, unknown>;
  return {
    foreignOrders: count(raw.foreignOrders),
    protectiveLegs: count(raw.protectiveLegs),
    partialEntries: count(raw.partialEntries),
    otherOwnOrders: count(raw.otherOwnOrders),
    // Důvod blokace jen jako neprázdný text (objekt by shodil render); jiný tvar = zablokováno obecně.
    blockedReason: raw.blockedReason == null ? null
      : typeof raw.blockedReason === 'string' && raw.blockedReason.trim().length > 0 ? raw.blockedReason.slice(0, 240)
        : 'Worker teď zrušení odmítá (důvod nejde přečíst).',
  };
}

/** Některý počet kontextu nejde přečíst. */
export const pendingCancelContextUnverified = (context: PendingCancelContextView | null): boolean => (
  context != null && (context.foreignOrders == null || context.protectiveLegs == null || context.partialEntries == null || context.otherOwnOrders == null)
);

/** Kontext pro jádro: jen čitelné počty (nečitelný = 0 — jádro ho jen nezmíní; větu přidá `liveCancelPendingConfirmText`). */
const corePendingCancelContext = (context: PendingCancelContextView | null): PendingCancelContext | null => (context ? {
  foreignOrders: context.foreignOrders ?? 0,
  protectiveLegs: context.protectiveLegs ?? 0,
  partialEntries: context.partialEntries ?? 0,
  otherOwnOrders: context.otherOwnOrders ?? 0,
  blockedReason: context.blockedReason,
} : null);

/**
 * Text potvrzení „Zrušit čekající“: jádro (`cancelPendingConfirmText` — kolik a čeho, co VĚDOMĚ
 * zůstává); nečitelný počet = navíc věta, že co zůstává, nejde ověřit (unknown ≠ 0).
 */
export function liveCancelPendingConfirmText(entries: readonly PendingOwnEntry[], context: PendingCancelContextView | null): string {
  const text = cancelPendingConfirmText(entries, corePendingCancelContext(context));
  return pendingCancelContextUnverified(context) ? `${text} ${CANCEL_PENDING_REST_UNVERIFIED}` : text;
}

/** Co lišta / telefon ukáže; `null` = tlačítko vůbec ne (starý worker, nic čekajícího). */
export interface LiveCancelPendingView {
  entries: readonly PendingOwnEntry[];
  /** Klíč dvoukroku = přesně ta sada, kterou uživatel vidí (id, cena, počet). */
  key: string;
  label: string;
  /** Text potvrzení: kolik a čeho, co VĚDOMĚ zůstává. */
  confirmText: string;
  enabled: boolean;
  reason: string | null;
}

/**
 * Tlačítko „Zrušit čekající“: jen když availability jádra říká `show` (capability, aspoň jeden
 * vlastní čekající vstup). Neaktivní s důvodem nad zastaralým / obnoveným stavem, bez relaye
 * a při blokaci workeru; přehrávání v grafu = neaktivní (bez ovládání). Vstup ze statusu se
 * sanitizuje (`validPendingOwnEntries`); jakákoli chyba výpočtu = `null` (nic se nenabídne).
 */
export function liveCancelPendingView(input: {
  capability: boolean;
  statusFresh: boolean;
  restored: boolean;
  relayConnected: boolean;
  entries: unknown;
  context: unknown;
  replay?: boolean;
}): LiveCancelPendingView | null {
  try {
    const entries = validPendingOwnEntries(input.entries);
    const context = validPendingCancelContext(input.context);
    const availability = cancelPendingAvailability({ ...input, entries, context: corePendingCancelContext(context) });
    if (!availability.show) return null;
    const base = {
      entries, key: cancelPendingConfirmKey(entries), label: cancelPendingButtonLabel(entries),
      confirmText: liveCancelPendingConfirmText(entries, context),
    };
    if (input.replay) return { ...base, enabled: false, reason: 'Přehrávání v grafu — zrušení čekajících jen v živém grafu.' };
    return { ...base, enabled: availability.enabled, reason: availability.reason };
  } catch {
    return null;
  }
}

/**
 * Desk těsně před odesláním: každá položka sady, kterou uživatel potvrdil, musí být pořád
 * v čerstvém statusu se stejným id, cenou a počtem (`cancelPendingConfirmKey`). Jinak nic
 * neodejde (vyplnění, posun, nový záznam mezi kliky a odesláním). `null` = smí.
 */
export function cancelPendingSeenProblem(seen: readonly PendingOwnEntry[], shown: unknown): string | null {
  if (seen.length === 0) return 'Nebylo co zrušit — nic se neodeslalo.';
  const current = new Set(validPendingOwnEntries(shown).map(entry => cancelPendingConfirmKey([entry])));
  if (seen.some(entry => !current.has(cancelPendingConfirmKey([entry])))) return 'Čekající vstupy se mezitím změnily — nic se neodeslalo.';
  return null;
}

/** Dashboard u příkazu: zrušit vlastní čekající vstup / zamčeno s vysvětlením / nic. */
export type DashboardOrderCancelView =
  | { kind: 'cancel'; entry: PendingOwnEntry; key: string }
  | { kind: 'locked'; reason: string }
  | { kind: 'hidden' };

export const DASHBOARD_CANCEL_OLD_WORKER = 'Worker zatím neumí cílené zrušení z appky — příkaz zruš v Tradovate (nebo Flatten).';
export const DASHBOARD_CANCEL_NOT_OWN = 'Z appky jde zrušit jen vlastní čekající vstup leadera — SL/TP pozice ani cizí příkaz ne (zruš v Tradovate nebo Flatten).';
export const DASHBOARD_CANCEL_VERIFYING = 'Stav kopírky se ověřuje — zrušit jde až nad čerstvým stavem přes relay.';
export const DASHBOARD_CANCEL_NOT_WORKER_GROUP = 'Zrušit jde jen u skupiny, kterou řídí worker — příkaz zruš v Tradovate (nebo Flatten).';
export const DASHBOARD_CANCEL_UNREADABLE = 'Stav čekajících vstupů nejde přečíst — příkaz zruš v Tradovate (nebo Flatten).';

/** Vstup Dashboardu (desk → přehled); `otherGroup` = skupina, kterou neřídí worker. */
export interface DashboardOrderCancelInput {
  capability: boolean;
  leaderAccountId: number | null | undefined;
  entries: unknown;
  /** `controller.pendingCancelContext` — `blockedReason` = worker teď každé zrušení odmítne. */
  context?: unknown;
  statusFresh: boolean;
  restored: boolean;
  relayConnected: boolean;
  otherGroup?: boolean;
}

/**
 * Přehled: skupina workeru dostane vstup desku beze změny, jiná skupina týž vstup s `otherGroup`
 * (tlačítko zamčené s pravdivým textem, ne „worker neumí“). Bez vstupu desku = null.
 */
export function dashboardPendingCancelForGroup<T extends { otherGroup?: boolean }>(
  cancel: T | null | undefined,
  groupId: string,
  workerGroupId: string | null | undefined,
): T | null {
  if (!cancel) return null;
  return workerGroupId != null && groupId === workerGroupId ? cancel : { ...cancel, otherGroup: true };
}

/**
 * Dashboard „Zrušit“ (dřív `cancel-order`, worker ho odmítá): jen `dashboardCancelTarget` jádra
 * (vlastní čekající vstup leadera nad čerstvým neobnoveným statusem s relayem) a jen když worker
 * zrušení teď neblokuje (`blockedReason`). Starý worker bez capability = zamčeno s vysvětlením,
 * skupina mimo worker = vlastní text; nepracující příkaz = nic. Chyba výpočtu = zamčeno.
 */
export function dashboardOrderCancelView(
  order: { accountId: number | null; id: number | string; working: boolean },
  input: DashboardOrderCancelInput | null | undefined,
): DashboardOrderCancelView {
  if (!order.working) return { kind: 'hidden' };
  if (!input) return { kind: 'locked', reason: DASHBOARD_CANCEL_OLD_WORKER };
  if (input.otherGroup) return { kind: 'locked', reason: DASHBOARD_CANCEL_NOT_WORKER_GROUP };
  if (!input.capability) return { kind: 'locked', reason: DASHBOARD_CANCEL_OLD_WORKER };
  try {
    const entries = validPendingOwnEntries(input.entries);
    const entry = order.accountId == null ? null : dashboardCancelTarget({ accountId: order.accountId, orderId: order.id }, { ...input, entries });
    if (entry) {
      const blockedReason = validPendingCancelContext(input.context)?.blockedReason ?? null;
      if (blockedReason) return { kind: 'locked', reason: blockedReason };
      return { kind: 'cancel', entry, key: cancelPendingConfirmKey([entry]) };
    }
    if (!input.statusFresh || input.restored || !input.relayConnected) return { kind: 'locked', reason: DASHBOARD_CANCEL_VERIFYING };
    return { kind: 'locked', reason: DASHBOARD_CANCEL_NOT_OWN };
  } catch {
    return { kind: 'locked', reason: DASHBOARD_CANCEL_UNREADABLE };
  }
}
