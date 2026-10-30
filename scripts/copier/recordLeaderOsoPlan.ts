/**
 * Čistá logika nahrávání fáze 0 obchodování z grafu
 * (`docs/CHART_ORDER_ENTRY_PLAN.md`): pojistky před zadáním testovacího OSO
 * na leaderovi, rozhodnutí o úklidu a anonymizace záznamu. Skript
 * `record-leader-oso.ts` spouští jen Filip; tady se nic neposílá k brokerovi.
 * Revize po `copier-design-critic` (29. 10. 2026, nálezy P1–P8).
 */
import { pickCopierMarketPrice } from '../../lib/copierMarketPrice';

export interface RecordLeaderOsoPlan {
  accountId: number;
  symbol: string;
  side: 'Buy' | 'Sell';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  marketPrice: number;
  holdMs: number;
  confirm: boolean;
  /**
   * `cancel` = Limit daleko od trhu, zrušení bez fillu (první záznam).
   * `fill` = marketable Limit, vyplní se; zaznamená přechod nohou
   * Suspended → Working, pak leadera zavře (liquidate) a ověří flat.
   */
  scenario: 'cancel' | 'fill' | 'modify-through-market' | 'market';
  /** Účet mimo skupinu workeru (např. Tradeify připojení) — nikdy follower skupiny. */
  allowNonGroupAccount: boolean;
}

/** Vstup i TP musí být aspoň tolik od trhu (podíl ceny) — žádná noha nesmí jít hned vyplnit. */
export const RECORD_MIN_DISTANCE_RATIO = 0.015;
/** `--market-price` se smí lišit od ceny z workeru nejvýš o tolik (jen zpřísnění, nic neautorizuje). */
export const RECORD_MAX_ANCHOR_DIFF_RATIO = 0.003;
export const RECORD_TICK_SIZE = 0.25;
const MAX_HOLD_MS = 15_000;
/** Fill scénář: marketable Limit nejvýš tak daleko za trhem (neplatit libovolně). */
export const RECORD_FILL_MAX_SLIP_RATIO = 0.002;
/** Fill scénář: SL od vstupu v rozmezí (nesmí se trefit během držení, riziko omezené). */
export const RECORD_FILL_SL_MIN_RATIO = 0.003;
export const RECORD_FILL_SL_MAX_RATIO = 0.01;

export function parseRecordLeaderOsoArgs(argv: readonly string[]): RecordLeaderOsoPlan {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const number = (name: string) => {
    const raw = value(name);
    const parsed = Number(raw);
    if (raw === undefined || !Number.isFinite(parsed)) throw new Error(`Chybí nebo je neplatné --${name}`);
    return parsed;
  };
  const side = value('side') ?? 'Buy';
  if (side !== 'Buy' && side !== 'Sell') throw new Error('--side musí být Buy nebo Sell');
  const symbol = (value('symbol') ?? '').trim().toUpperCase();
  // Jen micro: případná chyba stojí desetinu NQ.
  if (!/^MNQ[FGHJKMNQUVXZ]\d$/.test(symbol)) throw new Error('--symbol musí být kontrakt MNQ, např. MNQZ6');
  const accountId = number('account');
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('--account musí být id účtu');
  const holdMs = value('hold-ms') === undefined ? 4_000 : number('hold-ms');
  if (holdMs < 1_000 || holdMs > MAX_HOLD_MS) throw new Error(`--hold-ms musí být 1000–${MAX_HOLD_MS}`);
  const scenario = value('scenario') ?? 'cancel';
  if (scenario !== 'cancel' && scenario !== 'fill' && scenario !== 'modify-through-market' && scenario !== 'market') {
    throw new Error('--scenario musí být cancel, fill, modify-through-market nebo market');
  }
  return {
    accountId, symbol, side,
    entry: number('entry'), stopLoss: number('sl'), takeProfit: number('tp'),
    marketPrice: number('market-price'), holdMs,
    confirm: argv.includes('--confirm'),
    scenario,
    allowNonGroupAccount: argv.includes('--non-group-account'),
  };
}

const onTick = (price: number) => Math.abs(price / RECORD_TICK_SIZE - Math.round(price / RECORD_TICK_SIZE)) < 1e-9;

/**
 * Důvody, proč záznam NESMÍ běžet (prázdné = smí). Volá se před připojením
 * i znovu těsně před zadáním (mezi tím může přijít ARM nebo auto-resume).
 */
export function recordLeaderOsoProblems(plan: RecordLeaderOsoPlan, status: unknown, now: number): string[] {
  const problems: string[] = [];
  const root = (status ?? {}) as {
    controller?: Record<string, unknown>;
    marketPrices?: unknown[];
    group?: { leaderAccountId?: unknown; followers?: Array<{ accountId?: unknown }> } | null;
  };
  const controller = root.controller ?? {};
  if (controller.armed !== false) problems.push('kopírka není prokazatelně DISARMED');
  if (controller.connected !== true) problems.push('worker není připojený');
  if (controller.killSwitch === true) problems.push('kill switch je aktivní');
  if (controller.groupFlat !== true) problems.push('skupina není flat');
  if (controller.reconciliationRequired !== false) problems.push('worker čeká na kontrolu pozic');
  if (controller.lastError != null) problems.push('worker má lastError (reconcile po záznamu by ho smazal)');
  if (controller.manualRecovery != null
    || (controller.armPreparation as { manualRecoveryRequired?: unknown } | undefined)?.manualRecoveryRequired === true) {
    problems.push('worker čeká na ruční obnovu');
  }
  const resume = controller.transportResume as { phase?: unknown } | null | undefined;
  if (resume && (resume.phase === 'waiting' || resume.phase === 'ready')) problems.push('běží automatické pokračování po výpadku');
  if (Array.isArray(controller.divergentAccounts) && controller.divergentAccounts.length) problems.push('skupina má divergenci');
  if (Array.isArray(controller.workingOrderAccounts) && controller.workingOrderAccounts.length) problems.push('ve skupině jsou working orders');
  const groupMembers = [root.group?.leaderAccountId, ...(root.group?.followers ?? []).map(follower => follower.accountId)];
  if (plan.allowNonGroupAccount) {
    // Účet mimo skupinu (jiné připojení): follower skupiny by kopírce rozbil pozice.
    if (groupMembers.includes(plan.accountId)) problems.push('--non-group-account: účet je ve skupině workeru');
  } else if (root.group?.leaderAccountId !== plan.accountId) problems.push('účet není leader skupiny workeru');

  for (const [name, price] of [['entry', plan.entry], ['sl', plan.stopLoss], ['tp', plan.takeProfit]] as const) {
    if (!(price > 0) || !onTick(price)) problems.push(`--${name} není kladná cena na tick ${RECORD_TICK_SIZE}`);
  }
  // Nezávislá kotva: cena z workeru (IBKR/TV) jen ZPŘÍSŇUJE — chybí-li, záznam neběží.
  const anchor = pickCopierMarketPrice(Array.isArray(root.marketPrices) ? root.marketPrices : [], plan.symbol, now);
  if (anchor == null) problems.push('worker nemá čerstvou cenu (otevři TradingView s grafem MNQ)');
  else if (Math.abs(anchor - plan.marketPrice) > anchor * RECORD_MAX_ANCHOR_DIFF_RATIO) {
    problems.push(`--market-price ${plan.marketPrice} nesedí s cenou workeru ${anchor}`);
  }
  const market = anchor ?? plan.marketPrice;
  const distance = market * RECORD_MIN_DISTANCE_RATIO;
  // `market` (fáze 2e): OSO s Market vstupem — `--entry` = očekávaná cena (trh), brány jako u fill.
  if (plan.scenario === 'fill' || plan.scenario === 'modify-through-market' || plan.scenario === 'market') {
    const slip = market * RECORD_FILL_MAX_SLIP_RATIO;
    const slDistance = Math.abs(plan.entry - plan.stopLoss);
    if (plan.side === 'Buy') {
      if (!(plan.entry >= market && plan.entry <= market + slip)) problems.push(`fill: Buy limit musí být na trhu nebo nad ním, nejvýš o ${slip.toFixed(0)} b`);
      if (!(plan.stopLoss < plan.entry)) problems.push('SL musí být pod vstupem');
      if (!(plan.takeProfit >= market + distance)) problems.push(`TP (Sell limit) musí být aspoň ${distance.toFixed(0)} b nad trhem`);
    } else {
      if (!(plan.entry <= market && plan.entry >= market - slip)) problems.push(`fill: Sell limit musí být na trhu nebo pod ním, nejvýš o ${slip.toFixed(0)} b`);
      if (!(plan.stopLoss > plan.entry)) problems.push('SL musí být nad vstupem');
      if (!(plan.takeProfit <= market - distance)) problems.push(`TP (Buy limit) musí být aspoň ${distance.toFixed(0)} b pod trhem`);
    }
    if (!(slDistance >= market * RECORD_FILL_SL_MIN_RATIO && slDistance <= market * RECORD_FILL_SL_MAX_RATIO)) {
      problems.push(`fill: SL musí být ${(market * RECORD_FILL_SL_MIN_RATIO).toFixed(0)}–${(market * RECORD_FILL_SL_MAX_RATIO).toFixed(0)} b od vstupu`);
    }
    return problems;
  }
  if (plan.side === 'Buy') {
    if (!(plan.entry <= market - distance)) problems.push(`Buy limit musí být aspoň ${distance.toFixed(0)} b pod trhem`);
    if (!(plan.stopLoss < plan.entry)) problems.push('SL musí být pod vstupem');
    if (!(plan.takeProfit >= market + distance)) problems.push(`TP (Sell limit) musí být aspoň ${distance.toFixed(0)} b nad trhem`);
  } else {
    if (!(plan.entry >= market + distance)) problems.push(`Sell limit musí být aspoň ${distance.toFixed(0)} b nad trhem`);
    if (!(plan.stopLoss > plan.entry)) problems.push('SL musí být nad vstupem');
    if (!(plan.takeProfit <= market - distance)) problems.push(`TP (Buy limit) musí být aspoň ${distance.toFixed(0)} b pod trhem`);
  }
  return problems;
}

export interface CleanupObservation {
  /** Nové příkazy leadera od začátku záznamu (před ním žádné otevřené nebyly). */
  orders: Array<{ id: string; status: string; filledQuantity: number; side?: string; parentOrderId?: string }> | null;
  /** Absolutní součet pozic leadera; `null` = čtení selhalo. */
  netPosition: number | null;
}

/**
 * Co víme o zadání: nic neodešlo, ACK s id všech tří příkazů, nebo výsledek
 * nejistý (výjimka, timeout, ACK bez id, signál během požadavku).
 */
export type RecordPlacement =
  | { kind: 'not-sent' }
  | { kind: 'acknowledged'; entryId: string; legIds: string[] }
  /** `entrySide`: bez id z ACK se vstup pozná jen podle strany (nohy mohou přijít bez `parentId`). */
  | { kind: 'uncertain'; entrySide: 'Buy' | 'Sell' };

export type CleanupDecision =
  | { kind: 'unverified'; reason: string }
  | { kind: 'filled'; reason: string }
  | { kind: 'cancel'; ids: string[] }
  | { kind: 'clean' };

const OPEN = new Set(['working', 'pending']);
const TERMINAL_UNFILLED = new Set(['canceled', 'rejected']);

/**
 * Úklid smí rušit jen tehdy, když se nic nevyplnilo: jakýkoli fill nebo
 * pozice = nohy (ochrana) zůstanou a skript hlasitě skončí chybou. V jednom
 * kole se ruší jen vstup (rodič); nohy až po novém čtení, které ukáže vstup
 * zrušený bez fillu — `cancelOrder` doběhne i u vstupu, který se mezitím
 * vyplnil. „Čisto“ jen po ACK s id, která jsou pozorovaně zrušená.
 */
export function decideRecordCleanup(observation: CleanupObservation, placement: RecordPlacement): CleanupDecision {
  if (observation.orders == null || observation.netPosition == null) {
    return { kind: 'unverified', reason: 'stav leadera nejde přečíst' };
  }
  if (observation.netPosition !== 0 || observation.orders.some(order => order.filledQuantity > 0 || order.status === 'filled')) {
    return { kind: 'filled', reason: 'vstup nebo noha se vyplnila — ochrana zůstává, zkontroluj leadera v Tradovate' };
  }
  const legIds = new Set(placement.kind === 'acknowledged' ? placement.legIds : []);
  const entryId = placement.kind === 'acknowledged' ? placement.entryId : null;
  const isParent = (order: { id: string; side?: string; parentOrderId?: string }) =>
    order.id === entryId || (!order.parentOrderId && !legIds.has(order.id)
      && (placement.kind !== 'uncertain' || order.side === placement.entrySide));
  const open = observation.orders.filter(order => OPEN.has(order.status));
  const openParents = open.filter(isParent);
  if (openParents.length) return { kind: 'cancel', ids: openParents.map(order => order.id) };
  if (open.length) {
    // Nohy jen když je vstup prokazatelně zrušený bez fillu.
    const entry = entryId == null ? null : observation.orders.find(order => order.id === entryId);
    if (entryId != null && (!entry || !TERMINAL_UNFILLED.has(entry.status))) {
      return { kind: 'unverified', reason: 'nohy běží, ale zrušení vstupu není potvrzené' };
    }
    return { kind: 'cancel', ids: open.map(order => order.id) };
  }
  if (placement.kind === 'uncertain') return { kind: 'unverified', reason: 'výsledek zadání nejistý — zkontroluj Tradovate' };
  if (placement.kind === 'acknowledged') {
    const own = [placement.entryId, ...placement.legIds];
    if (!own.every(id => observation.orders!.some(order => order.id === id && TERMINAL_UNFILLED.has(order.status)))) {
      return { kind: 'unverified', reason: 'zadané příkazy nejsou pozorovaně zrušené' };
    }
  }
  return { kind: 'clean' };
}

/**
 * Scénář `modify-through-market` (fáze 2a, P4): po fillu se SL posune o tolik
 * bodů ZA vstup (u longu nad, u shortu pod) — tedy přes trh. Zaznamená se,
 * jestli ho Tradovate odmítne, nebo hned spustí. Pak běžný úklid fillu.
 */
export const RECORD_THROUGH_MARKET_POINTS = 20;
export function throughMarketStopPrice(plan: Pick<RecordLeaderOsoPlan, 'side' | 'entry'>): number {
  return plan.side === 'Buy' ? plan.entry + RECORD_THROUGH_MARKET_POINTS : plan.entry - RECORD_THROUGH_MARKET_POINTS;
}

export type FillCleanupDecision =
  | { kind: 'unverified'; reason: string }
  /** Pozice je otevřená: zavřít ji (liquidate zruší i nohy). Nohy se nad pozicí nikdy neruší samostatně. */
  | { kind: 'liquidate' }
  | { kind: 'cancel'; ids: string[] }
  | { kind: 'clean' };

/**
 * Úklid fill scénáře. Otevřená pozice = zavřít (ochrana do té doby zůstává).
 * Flat: nevyplněný vstup zrušit; nohy rušit jen nad ověřeně flat účtem
 * a vstupem, který už nepracuje. „Čisto“ jen po ACK s id: flat a nic otevřeného.
 */
export function decideFillCleanup(observation: CleanupObservation, placement: RecordPlacement): FillCleanupDecision {
  if (observation.orders == null || observation.netPosition == null) {
    return { kind: 'unverified', reason: 'stav leadera nejde přečíst' };
  }
  if (observation.netPosition !== 0) return { kind: 'liquidate' };
  const open = observation.orders.filter(order => OPEN.has(order.status));
  const entryId = placement.kind === 'acknowledged' ? placement.entryId : null;
  const legIds = new Set(placement.kind === 'acknowledged' ? placement.legIds : []);
  const openParents = open.filter(order => order.id === entryId || (!order.parentOrderId && !legIds.has(order.id)
    && (placement.kind !== 'uncertain' || order.side === placement.entrySide)));
  if (openParents.length) return { kind: 'cancel', ids: openParents.map(order => order.id) };
  if (open.length) return { kind: 'cancel', ids: open.map(order => order.id) };
  if (placement.kind === 'uncertain') return { kind: 'unverified', reason: 'výsledek zadání nejistý — zkontroluj Tradovate' };
  return { kind: 'clean' };
}

/** Přemapované id leadera v záznamu; ostatní účty připojení do záznamu nepatří. */
export const LEADER_PLACEHOLDER_ID = 1001;

const PRIVATE_KEYS = /^(userId|senderId|userSessionId|name|email|nickname|accountSpec|username|connectionId|tag|clOrdId)$/i;

/**
 * Anonymizace „povolené ponechat“: z rámce zůstanou jen `props` entity
 * vlastních příkazů (a jejich commandů / reportů / fillů), soukromé klíče se
 * vyhodí, id účtů se přemapují. Vše ostatní (sync celé session, jiné účty)
 * se zahodí.
 */
export function sanitizeRecordedFrame(
  data: string,
  context: { orderIds: Set<number>; commandIds: Set<number>; accountMap: Map<number, number> },
): Array<{ entityType: string; eventType: string; entity: Record<string, unknown> }> {
  if (!data.startsWith('a[')) return [];
  let messages: unknown[];
  try { messages = JSON.parse(data.slice(1)); } catch { return []; }
  const out: Array<{ entityType: string; eventType: string; entity: Record<string, unknown> }> = [];
  for (const message of messages) {
    const item = message as { e?: unknown; d?: { entityType?: unknown; eventType?: unknown; entity?: Record<string, unknown> } };
    if (item.e !== 'props' || !item.d?.entity || typeof item.d.entityType !== 'string') continue;
    const entity = item.d.entity;
    const type = item.d.entityType;
    const id = Number(entity.id);
    const orderId = Number(entity.orderId);
    const parentId = Number(entity.parentId);
    const commandId = Number(entity.commandId);
    let keep = false;
    if (type === 'order' && (context.orderIds.has(id) || context.orderIds.has(parentId))) { context.orderIds.add(id); keep = true; }
    else if (type === 'command' && context.orderIds.has(orderId)) { context.commandIds.add(id); keep = true; }
    else if (type === 'commandReport' && context.commandIds.has(commandId)) keep = true;
    else if (['orderVersion', 'executionReport', 'fill', 'orderStrategy'].includes(type) && context.orderIds.has(orderId)) keep = true;
    else if (type === 'position' && context.accountMap.get(Number(entity.accountId)) === LEADER_PLACEHOLDER_ID) keep = true;
    if (!keep) continue;
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entity)) {
      if (PRIVATE_KEYS.test(key)) continue;
      clean[key] = key === 'accountId' ? (context.accountMap.get(Number(value)) ?? 0) : value;
    }
    out.push({ entityType: type, eventType: String(item.d.eventType ?? ''), entity: clean });
  }
  return out;
}

/** Poslední síto před zápisem: výstup nesmí obsahovat žádný známý identifikátor. */
export function leakedIdentifiers(serialized: string, identifiers: readonly (string | number)[]): string[] {
  return identifiers
    .map(String)
    .filter(value => value.length >= 4)
    .filter(value => new RegExp(`(?<![\\w.])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`).test(serialized));
}
