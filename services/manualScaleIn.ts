/**
 * Dokupování do otevřené pozice z grafu (docs/reviews/scale-in-design-20261102.md v4,
 * Filip 3. 11. 2026): ČISTÁ logika bez IO — model pozice leadera z vlastních lístků
 * (každé přikoupení = vlastní nativní OSO se SL/TP rovným společnému SL/TP pozice),
 * brána přikoupení, riziko celé pozice, stavová podmínka čekajícího přikoupení
 * a tvar správy po pozici. Controller sebere zmrazený stav, tady se jen počítá.
 *
 * Fáze 1: jen manual-only local-only DEMO skupina bez followerů s instalačním
 * opt-inem. Followeři / běžné skupiny = dál `account-not-flat` beze změny.
 */
import type { OrderSide, OrderStatus } from './brokerPort';

export const SCALE_IN_CAPABILITY = 'manual-entry-scale-in-v1';
/** Nohy z vlastního ACK (`manual-entry-ack`, `manual-attach-ack`) nejsou potvrzení od brokera. */
const SYNTHETIC_SOURCES = new Set(['manual-entry-ack', 'manual-attach-ack']);
const OPEN: ReadonlySet<OrderStatus> = new Set(['working', 'pending']);

/** Přikoupení smí jen manual-only local-only DEMO skupina bez followerů s opt-inem instalace. */
export function scaleInEnabled(input: {
  optIn: boolean;
  group: { manualOnly?: boolean; localOnly?: boolean; followers: readonly unknown[] } | null;
  brokerEnvironment: string | null | undefined;
}): boolean {
  return input.optIn && input.group?.manualOnly === true && input.group.localOnly === true
    && input.group.followers.length === 0 && input.brokerEnvironment === 'demo';
}

export interface ScaleInOrder {
  brokerOrderId: string;
  symbol: string;
  side: OrderSide;
  orderType: string;
  status: OrderStatus;
  quantity: number;
  filledQuantity: number;
  limitPrice?: number;
  stopPrice?: number;
  sourceVersion?: string;
}

/** Vlastní ruční vstup (durable záznam) zúžený na to, co model potřebuje. */
export interface ScaleInRecord {
  operationId: string;
  status: string;
  createdAt: number;
  accountId: number;
  symbol: string;
  side: OrderSide;
  quantity: number;
  orderType: string;
  bare: boolean;
  entryId?: string;
  stopId?: string;
  targetId?: string;
  /** Přikoupení do otevřené pozice (ne vstup z flat). */
  scaleIn: boolean;
}

export interface ScaleInTicket {
  operationId: string;
  scaleIn: boolean;
  createdAt: number;
  entryId: string;
  quantity: number;
  orderType: string;
  /**
   * Stav vstupu: `open` = čeká (i částečně vyplněný), `filled` = filly od brokera dávají
   * přesně qty lístku (nikdy jen podle stavu — Cancel+Completed s cumQty < qty je dílčí
   * zrušení, INV-TRAD-02), `ended` = zrušen / odmítnut bez fillu, `unknown` = jinak.
   */
  entry: 'open' | 'filled' | 'ended' | 'unknown';
  entryFilled: number;
  /** VWAP fillů vstupu od brokera; null = neznámý (po restartu). */
  entryAvg: number | null;
  /** Cena čekajícího vstupu (Limit/Stop) z cache streamu; null = vstup už nepracuje. */
  entryPrice: number | null;
  /**
   * Strop qty nohou do nadkrytí: živý vstup = jeho fill (Suspended nohy čekajícího vstupu se
   * nepočítají, diff P1-A); neživý = qty lístku (fill po restartu / ve výpadku WS nemusí být
   * v paměti — konzervativně, falešný poplach je bezpečný směr).
   */
  coverCap: number;
  stop: ScaleInOrder | null;
  target: ScaleInOrder | null;
}

export interface LeaderPositionModel {
  symbol: string;
  /** Pozice ze streamu (kladná = long); null = cache nemá ověřený záznam (≠ flat). */
  net: number | null;
  /** Strana vstupu pozice (`Buy` = long), null při flat / neznámé. */
  side: OrderSide | null;
  /** Vlastní lístky aktuální pozice: vstup čeká, nebo aspoň jedna noha žije. */
  tickets: ScaleInTicket[];
  /** Lístky přikoupení, jejichž vstup ještě čeká (včetně částečně vyplněného). */
  pendingAdds: ScaleInTicket[];
  /** Otevřené příkazy na symbolu, které nejsou vstupem ani nohou vlastního lístku. */
  foreignOrders: ScaleInOrder[];
  /** Σ qty pracujících nohou potvrzených streamem (ne syntetické z ACK). */
  stopCovered: number;
  targetCovered: number;
  /** Nejochrannější SL (long = nejvyšší) a nejbližší TP (long = nejnižší) ze živých nohou; null = žádná. */
  stopPrice: number | null;
  targetPrice: number | null;
  stopUniform: boolean;
  targetUniform: boolean;
  /** Některá noha je jen syntetická z ACK nebo ve stavu pending (Suspended). */
  unconfirmedLegs: boolean;
  /** Σ vyplněného qty vlastních lístků (vyplněné i částečně vyplněné vstupy). */
  ownFilled: number;
  /** Σ otevřené expozice lístků: fill vstupu − filly jeho nohou (dílčí TP/SL už pozici zmenšily). */
  ownOpen: number;
  /** Některá noha má dílčí fill (broker jí sám mění qty) — jen zavřít / brzdy. */
  legsPartiallyFilled: boolean;
  /** SL nohy jsou prosté Stop a TP nohy prosté Limit (INV-TRAD-07: typ z Tradovate, který appka nezná, se nemodifikuje). */
  legTypesOk: boolean;
  /**
   * Σ zbytků vlastních nohou, každá nejvýš do `coverCap` lístku — nadkrytí pozice. Suspended
   * nohy nevyplněného čekajícího vstupu se nepočítají (oponentura diffu, P1-A).
   */
  stopOpenQuantity: number;
  targetOpenQuantity: number;
}

/**
 * Model pozice leadera na symbolu z vlastních lístků a cache streamu. Lístek patří
 * aktuální pozici, dokud jeho vstup čeká nebo aspoň jedna jeho noha žije; po zavření
 * pozice (nohy zrušené / vyplněné) z modelu vypadne sám.
 */
export function leaderPositionModel(input: {
  symbol: string;
  leaderAccountId: number;
  net: number | null;
  records: readonly ScaleInRecord[];
  liveOrders: ReadonlyMap<string, ScaleInOrder>;
  /** Poslední pozorovaný stav příkazu (i ukončeného) podle id. */
  observedStatus: (brokerOrderId: string) => OrderStatus | undefined;
  /** Součet fillů vstupu od brokera (qty a VWAP); null = neznámé. */
  fills: (brokerOrderId: string) => { quantity: number; avg: number } | null;
}): LeaderPositionModel {
  const { symbol, net } = input;
  const open = (id: string | undefined) => {
    if (!id) return null;
    const order = input.liveOrders.get(id);
    return order && OPEN.has(order.status) ? order : null;
  };
  const tickets: ScaleInTicket[] = [];
  for (const record of input.records) {
    if (record.status !== 'acknowledged' || record.accountId !== input.leaderAccountId || record.symbol !== symbol) continue;
    // Holý Market z lišty telefonu je lístkem až s doplněnými nohami („Přidat SL/TP“ = OCO na celou jeho
    // pozici); bez nohou do pozice nepatří a brána ho vidí jako nekrytou část (3. 11., telefon).
    if (!record.entryId || !record.stopId || !record.targetId) continue;
    const entryLive = open(record.entryId);
    const stop = open(record.stopId);
    const target = open(record.targetId);
    if (!entryLive && !stop && !target) continue;
    const observed = input.observedStatus(record.entryId);
    const fill = input.fills(record.entryId);
    const entry: ScaleInTicket['entry'] = entryLive ? 'open'
      : fill != null && fill.quantity === record.quantity ? 'filled'
        : fill == null && (observed === 'canceled' || observed === 'rejected') ? 'ended'
          : 'unknown';
    tickets.push({
      operationId: record.operationId, scaleIn: record.scaleIn, createdAt: record.createdAt, entryId: record.entryId,
      quantity: record.quantity, orderType: record.orderType, entry,
      entryFilled: Math.max(entryLive?.filledQuantity ?? 0, fill?.quantity ?? 0),
      entryAvg: fill != null && fill.quantity > 0 && Number.isFinite(fill.avg) ? fill.avg : null,
      entryPrice: entryLive ? entryLive.limitPrice ?? entryLive.stopPrice ?? null : null,
      coverCap: entryLive ? entryLive.filledQuantity : record.quantity,
      stop, target,
    });
  }
  tickets.sort((left, right) => left.createdAt - right.createdAt);
  const own = new Set<string>();
  for (const ticket of tickets) {
    own.add(ticket.entryId);
    if (ticket.stop) own.add(ticket.stop.brokerOrderId);
    if (ticket.target) own.add(ticket.target.brokerOrderId);
  }
  const foreignOrders = [...input.liveOrders.values()]
    .filter(order => order.symbol === symbol && OPEN.has(order.status) && !own.has(order.brokerOrderId));
  const side: OrderSide | null = net == null || net === 0 ? null : net > 0 ? 'Buy' : 'Sell';
  const long = side === 'Buy';
  // Krytí jen nohami potvrzenými streamem, pracujícími a bez dílčího fillu (P1-6 oponentury v4).
  const confirmed = (order: ScaleInOrder | null) => order != null && order.status === 'working' && order.filledQuantity === 0
    && !SYNTHETIC_SOURCES.has(order.sourceVersion ?? '');
  const stops = tickets.map(ticket => ticket.stop).filter((order): order is ScaleInOrder => order != null);
  const targets = tickets.map(ticket => ticket.target).filter((order): order is ScaleInOrder => order != null);
  const stopPrices = stops.map(order => order.stopPrice).filter((value): value is number => typeof value === 'number');
  const targetPrices = targets.map(order => order.limitPrice).filter((value): value is number => typeof value === 'number');
  const pick = (values: number[], highest: boolean) => (values.length ? (highest ? Math.max(...values) : Math.min(...values)) : null);
  return {
    symbol, net, side, tickets,
    pendingAdds: tickets.filter(ticket => ticket.scaleIn && ticket.entry === 'open'),
    foreignOrders,
    stopCovered: stops.filter(confirmed).reduce((sum, order) => sum + order.quantity, 0),
    targetCovered: targets.filter(confirmed).reduce((sum, order) => sum + order.quantity, 0),
    // Nejochrannější SL: long nejvyšší, short nejnižší; nejbližší TP: long nejnižší, short nejvyšší.
    stopPrice: pick(stopPrices, long),
    targetPrice: pick(targetPrices, !long),
    stopUniform: stopPrices.length === stops.length && new Set(stopPrices).size <= 1,
    targetUniform: targetPrices.length === targets.length && new Set(targetPrices).size <= 1,
    unconfirmedLegs: [...stops, ...targets].some(order => !confirmed(order)),
    ownFilled: tickets.reduce((sum, ticket) => sum + ticket.entryFilled, 0),
    ownOpen: tickets.reduce((sum, ticket) => sum + Math.max(0, ticket.entryFilled - (ticket.stop?.filledQuantity ?? 0) - (ticket.target?.filledQuantity ?? 0)), 0),
    legsPartiallyFilled: [...stops, ...targets].some(order => order.filledQuantity > 0),
    legTypesOk: stops.every(order => order.orderType === 'Stop') && targets.every(order => order.orderType === 'Limit'),
    stopOpenQuantity: legOpen(tickets, 'stop'),
    targetOpenQuantity: legOpen(tickets, 'target'),
  };
}

function legOpen(tickets: readonly ScaleInTicket[], leg: 'stop' | 'target'): number {
  return tickets.reduce((sum, ticket) => {
    const order = ticket[leg];
    return order ? sum + Math.min(Math.max(0, order.quantity - order.filledQuantity), ticket.coverCap) : sum;
  }, 0);
}

/** Vlastní nohy kryjí víc kontraktů, než má pozice (např. ruční částečné zavření) — po ustálení incident. */
export function positionOverCovered(model: LeaderPositionModel): boolean {
  if (model.net == null || model.tickets.length === 0) return false;
  const net = Math.abs(model.net);
  return model.stopOpenQuantity > net || model.targetOpenQuantity > net;
}

export interface ScaleInIntent {
  mode: 'add';
  side: OrderSide;
  /** |pozice|, kterou uživatel viděl. */
  quantity: number;
  /** Vstupy vlastních lístků pozice, které uživatel viděl (seřazené). */
  ticketEntryIds: string[];
}

export interface ScaleInIssue { code: string; text: string }

/**
 * Brána přikoupení (místo `account-not-flat`, jen `position.mode === 'add'`). Vše
 * musí platit; čeho se týká, ví jen tato funkce — controller sbírá fakta.
 */
export function scaleInAddBlockers(input: {
  enabled: boolean;
  command: { symbol: string; side: OrderSide; quantity: number; orderType: string; stopLoss?: number; takeProfit?: number; position: ScaleInIntent };
  model: LeaderPositionModel;
  /** Pozice nebo otevřené příkazy leadera na jiném symbolu. */
  otherSymbolExposure: boolean;
  /** Deník: otevřený lot na symbolu (signed net) — null = žádný. */
  lotNet: number | null;
  /** Epocha expozice leadera na symbolu ve fázi `open` se stejným znaménkem a `lastLeaderNet` = net. */
  epochMatches: boolean;
  /** Rozpracovaná správa této pozice (`sending`/`unknown`) nebo běžící zápis. */
  manageBusy: boolean;
  cap: number;
}): ScaleInIssue[] {
  const issues: ScaleInIssue[] = [];
  const add = (code: string, text: string) => issues.push({ code, text });
  const { command, model } = input;
  const intent = command.position;
  if (!input.enabled) { add('scale-in-off', 'Přikoupení do pozice je zapnuté jen pro ruční DEMO účet (instalace).'); return issues; }
  if (command.stopLoss === undefined || command.takeProfit === undefined) add('scale-in-bare', 'Přikoupení musí mít SL i TP pozice.');
  // Dílčí fill Limit/Stop OSO s qty > 1 u Tradovate neověřený (nohy Suspended, broker mění qty) —
  // čekající přikoupení jen po 1 kontraktu; Market se vyplní celý hned (oponentura v4, P1-3 var. A).
  if (command.orderType !== 'Market' && command.quantity > 1) add('scale-in-limit-qty', 'Čekající přikoupení (Limit/Stop) jde zatím jen po 1 kontraktu — větší množství Marketem.');
  if (model.net == null) { add('scale-in-position-unverified', 'Pozice leadera není ověřená — přikoupení teď nejde.'); return issues; }
  if (model.net === 0) { add('scale-in-flat', 'Pozice je mezitím zavřená — nic se neodeslalo.'); return issues; }
  const net = Math.abs(model.net);
  if (model.side !== command.side) add('scale-in-opposite', 'Přikoupit jde jen na stranu pozice (ne zmenšit ani otočit).');
  const seen = [...intent.ticketEntryIds].sort();
  const actual = model.tickets.map(ticket => ticket.entryId).sort();
  if (intent.side !== command.side || intent.quantity !== net || seen.length !== actual.length || seen.some((id, index) => id !== actual[index])) {
    add('intent-position-changed', 'Pozice se od zobrazení změnila — obnov panel.');
  }
  if (model.pendingAdds.length > 0) add('scale-in-pending', 'Předchozí přikoupení ještě čeká — nejdřív ať se vyplní, nebo ho zruš.');
  if (model.tickets.some(ticket => ticket.entry !== 'filled' && !(ticket.scaleIn && ticket.entry === 'open'))) {
    add('scale-in-entry-open', 'Vstup pozice není plně vyplněný — přikoupení teď nejde.');
  }
  if (model.tickets.length === 0 || model.ownOpen !== net) {
    add('scale-in-foreign-position', 'Pozice obsahuje kontrakty mimo lístky z appky — přikoupení jen přes Tradovate.');
  }
  if (model.unconfirmedLegs || model.legsPartiallyFilled || model.stopCovered !== net || model.targetCovered !== net) {
    add('scale-in-uncovered', 'SL a TP nekryjí celou pozici (nebo je broker ještě nepotvrdil) — přikoupení teď nejde.');
  }
  if (!model.stopUniform || !model.targetUniform) add('scale-in-legs-diverged', 'SL nebo TP pozice nejsou na jedné ceně — nejdřív je sjednoť.');
  if (!model.legTypesOk) add('leg-type', 'SL nebo TP pozice má u brokera jiný typ (např. trailing z Tradovate) — přikoupení z appky nejde.');
  if (command.stopLoss !== model.stopPrice || command.takeProfit !== model.targetPrice) {
    add('scale-in-brackets-mismatch', 'SL a TP přikoupení musí být stejné jako SL a TP pozice.');
  }
  if (model.foreignOrders.length > 0) add('scale-in-foreign-orders', 'Na symbolu pracuje příkaz mimo lístky z appky.');
  if (input.otherSymbolExposure) add('account-not-flat', 'Leader má pozici nebo příkaz na jiném symbolu.');
  if (input.lotNet !== model.net) add('scale-in-journal', 'Deník obchodu nesedí s pozicí u brokera — přikoupení teď nejde.');
  if (!input.epochMatches) add('scale-in-epoch', 'Kopírka ještě nemá pozici potvrzenou jako otevřený obchod — zkus to za chvíli.');
  if (input.manageBusy) add('scale-in-manage-busy', 'Běží změna SL/TP pozice — počkej na její výsledek.');
  const pendingSame = model.pendingAdds.reduce((sum, ticket) => sum + Math.max(0, ticket.quantity - ticket.entryFilled), 0);
  if (net + pendingSame + command.quantity > input.cap) {
    add('manual-cap', `Pozice by měla ${net + pendingSame + command.quantity} kontraktů — strop účtu je ${input.cap}.`);
  }
  return issues;
}

/**
 * Riziko jednoho lístku při SL (Filip 3. 11., rozhodnutí 4): `max(0, směr·(VWAP − SL)) × qty`
 * — SL za BE = 0, ale zamčený zisk jednoho lístku nesnižuje riziko jiného. Body bez skluzu/poplatků.
 */
export function scaleInExistingRiskPoints(input: { side: OrderSide; avgPrice: number; stopLoss: number; quantity: number }): number {
  const direction = input.side === 'Buy' ? 1 : -1;
  return Math.max(0, direction * (input.avgPrice - input.stopLoss)) * input.quantity;
}

/**
 * Riziko stávající pozice při novém společném SL: součet po lístcích z VWAP jejich fillů
 * (ne ze smíšeného průměru pozice — P1-2 oponentury v4) × zbývající qty jejich SL nohy.
 * null = některý lístek nemá známý VWAP nebo SL nohu (riziko nejde spočítat → blokace).
 */
export function scaleInPositionLossPoints(model: LeaderPositionModel, stopLoss: number): number | null {
  if (model.side == null) return null;
  let total = 0;
  for (const ticket of model.tickets) {
    if (ticket.entry === 'open' && ticket.entryFilled === 0) continue;
    if (ticket.entryAvg == null || !ticket.stop) return null;
    total += scaleInExistingRiskPoints({ side: model.side, avgPrice: ticket.entryAvg, stopLoss, quantity: Math.max(0, ticket.stop.quantity - ticket.stop.filledQuantity) });
  }
  return total;
}

/**
 * Stavová podmínka čekajícího přikoupení (§3.5): smí existovat jen když platí
 * všechny tvrdé podmínky. Vrací důvod zrušení, nebo null. Přechodné brány
 * (vlastní korelace OSO, ticho po eventu, čekající ingress) ho NEruší; neznámá
 * pozice (chybějící cache) není flat — nic se neruší, čeká se na sync.
 */
export function pendingAddViolation(input: {
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
  now: number;
  sessionEndAt: number;
  armExpiresAt: number | null;
  reserveMs: number;
  /** Pozice ze streamu; null = neznámá. */
  net: number | null;
  side: OrderSide;
  /** Přikoupení se vyplnilo v jiné epizodě deníku než základ (otevřelo nový obchod). */
  episodeMismatch: boolean;
}): string | null {
  if (!input.armed || input.shadowMode) return 'kopírka je vypnutá';
  if (input.killSwitch) return 'kill switch';
  if (input.dayLockPending || input.dayLocked) return 'denní zámek';
  if (input.pauseActive) return 'pauza pravidlem dne';
  if (input.managementOnly) return 'kopírka jen spravuje';
  if (input.leaderIneligible) return 'leader nesmí nové vstupy';
  if (input.windowNow === 'outside' || (input.windowNow === 'inside' && input.windowAfterReserve === 'outside')) return 'konec obchodního okna';
  if (input.sessionEndAt - input.now < input.reserveMs) return 'konec broker session (17:00 CT)';
  if (input.armExpiresAt != null && input.armExpiresAt - input.now < input.reserveMs) return 'vyprší zapnutí kopírky';
  if (input.episodeMismatch) return 'přikoupení otevřelo nový obchod';
  if (input.net == null) return null;
  if (input.net === 0) return 'pozice je zavřená';
  if ((input.net > 0) !== (input.side === 'Buy')) return 'pozice je na druhé straně';
  return null;
}

/**
 * Správa po pozici (§3.6): čistý tvar pro posun SL / TP / BE celé pozice.
 * Čekající nebo nevyřešené přikoupení = jen zavřít / zrušit přikoupení / brzdy.
 */
export function positionManageBlockers(input: {
  action: 'move-stop' | 'move-target' | 'close-position';
  model: LeaderPositionModel;
  expect: { price: number; quantity: number };
  unresolvedEntry: boolean;
}): ScaleInIssue[] {
  const issues: ScaleInIssue[] = [];
  const add = (code: string, text: string) => issues.push({ code, text });
  const { model } = input;
  if (model.net == null || model.net === 0 || model.side == null) { add('shape', 'Pozice leadera je zavřená nebo neověřená.'); return issues; }
  const net = Math.abs(model.net);
  if (input.expect.quantity !== net) add('order-changed', 'Pozice se od zobrazení změnila — obnov panel.');
  if (model.tickets.length === 0) add('shape', 'Pozice nemá vlastní lístky z appky — spravuj ji v Tradovate nebo zavři Flattenem.');
  if (model.foreignOrders.length > 0) add('other-orders', 'Leader má na symbolu i jiný pracující příkaz.');
  // Liquidate zavře celý kontrakt: kontrakty mimo lístky (přikoupené v Tradovate) jen Flatten (P2-3).
  if (model.ownOpen !== net) add('shape', 'Pozice obsahuje kontrakty mimo lístky z appky — spravuj ji v Tradovate nebo zavři Flattenem.');
  if (input.action === 'close-position') {
    // Zavření (liquidate) zruší i čekající přikoupení a jeho nohy (fáze 0, 3. 11.).
    if (input.expect.price !== model.stopPrice) add('order-changed', 'Obchod se od zobrazení změnil — obnov panel.');
    return issues;
  }
  if (input.unresolvedEntry) add('manual-entry-unresolved', 'Ruční vstup má neznámý výsledek — posun až po jeho vyřešení.');
  if (model.pendingAdds.length > 0) add('scale-in-pending', 'Čeká přikoupení — posun SL/TP až po jeho vyplnění nebo zrušení.');
  if (model.tickets.some(ticket => ticket.entry !== 'filled')) add('shape', 'Vstup pozice není plně vyplněný — posun teď nejde.');
  if (model.unconfirmedLegs || model.legsPartiallyFilled || model.stopCovered !== net || model.targetCovered !== net) {
    add('shape', 'SL a TP nekryjí celou pozici (nebo je broker ještě nepotvrdil) — posun z appky teď nejde.');
  }
  // Běžný posun jen z jedné ceny; rozjeté nohy = žádné tiché sjednocení (P2-6 oponentury v4).
  if (!model.stopUniform || !model.targetUniform) add('legs-diverged', 'SL nebo TP pozice nejsou na jedné ceně — sjednoť je v Tradovate, nebo pozici zavři.');
  if (!model.legTypesOk) add('leg-type', 'SL nebo TP pozice má u brokera jiný typ (např. trailing z Tradovate) — posun z appky nejde, jen zavřít.');
  const current = input.action === 'move-stop' ? model.stopPrice : model.targetPrice;
  if (current == null || input.expect.price !== current) add('order-changed', 'Příkaz se od zobrazení změnil — obnov panel.');
  return issues;
}

/**
 * Ořez durable záznamů ručních vstupů (nejstarší první, `records` seřazené podle vzniku):
 * odstraní jen nechráněné, dokud jich je víc než `keep`. Chráněné = nevyřešené nebo lístek
 * otevřené pozice se živým vstupem či nohou (správa po pozici je potřebuje, P2-7).
 */
export function trimManualEntryRecords<T>(records: readonly T[], keep: number, protect: (record: T) => boolean): T[] {
  let excess = records.length - keep;
  return records.filter(record => {
    if (excess > 0 && !protect(record)) { excess -= 1; return false; }
    return true;
  });
}

/** Stav hlídání nadkrytí na symbolu: začátek měření (ms), `incident` (vyhlášen) nebo `warned` (upozornění za DISARMED). */
export type OverCoverState = number | 'incident' | 'warned';

/**
 * Krok hlídání nadkrytí (Filip 3. 11.: incident jen za zapnuté kopírky; oponentura kola 3):
 * ustálené nadkrytí za ARMED = incident (jednou); za DISARMED = jedno upozornění a stav `warned`.
 * Nadkrytí, které z DISARMED přetrvá do ARMED (např. automatické pokračování po výpadku), vyhlásí
 * incident hned po uklidnění — upozornění ho nesmí schovat. Přechod (rozpracované eventy, správa)
 * zahodí jen rozběhnuté měření, nikdy vyhlášený stav.
 */
export function overCoverStep(state: OverCoverState | undefined, input: {
  overCovered: boolean; transient: boolean; armed: boolean; now: number; settleMs: number;
}): { next: OverCoverState | undefined; action: 'none' | 'incident' | 'warn' } {
  if (!input.overCovered) return { next: undefined, action: 'none' };
  if (state === 'incident') return { next: state, action: 'none' };
  if (state === 'warned') {
    return input.armed && !input.transient ? { next: 'incident', action: 'incident' } : { next: state, action: 'none' };
  }
  if (input.transient) return { next: undefined, action: 'none' };
  const since = state ?? input.now;
  if (input.now - since < input.settleMs) return { next: since, action: 'none' };
  return input.armed ? { next: 'incident', action: 'incident' } : { next: 'warned', action: 'warn' };
}
