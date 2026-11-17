/**
 * Místní exekuční služba nad Rithmic adaptérem — PROTOTYP pro měření „klik → čára" na
 * testovacím systému. Appka v prohlížeči na tomtéž počítači posílá příkazy a dostává stav
 * (pozice, pracující příkazy, ochrana) hned, jak ho adaptér zná; žádná databáze ani fronta.
 *
 * Záměrně úzké: jeden účet, povolené kontrakty, strop množství, jen demo prostředí. Není to
 * jádro kopírky a s workerem nemá nic společného. Stav pro zobrazení nikdy nic neautorizuje —
 * každý příkaz si adaptér ověřuje sám.
 */
import { BrokerRequestNotSentError, type BrokerEvent, type BrokerOrder, type OrderSide } from '../brokerPort';
import type { RithmicBrokerPort, RithmicIncident } from './rithmicBroker';
import type { BracketState } from './rithmicProtection';

export interface LocalExecConfig {
  broker: RithmicBrokerPort;
  /** Povolené kontrakty a jejich krok ceny. */
  symbols: Record<string, { tickSize: number }>;
  maxQuantity: number;
  /** Strop velikosti pozice včetně čekajících vstupů (výchozí = `maxQuantity`). */
  maxPosition?: number;
  /** Nejvyšší vzdálenost SL/TP od vstupu v tickách (výchozí 400). */
  maxProtectionTicks?: number;
  /** Jak dlouho po vyplnění se čeká na usazení pozice, než jde zadat ochrana (výchozí 1 s). */
  positionSettleMs?: number;
  /** Jak dlouho musí nesoulad samostatné ochrany s pozicí vydržet, než se ohlásí (výchozí 3 s). */
  protectiveGraceMs?: number;
  /** Posun dvou noh: druhá se pošle jen když první stihla tento čas (výchozí 2 s) — jinak by se nestihla odpověď. */
  moveLegsBudgetMs?: number;
  /** Jak dlouho čekat na potvrzení posunu vstupu s ochranou stavem (výchozí 1,5 s). */
  moveConfirmMs?: number;
  /** Poslední cena ze strany služby; reference od klienta se smí lišit nejvýš o `maxReferenceDriftTicks`. */
  serverPrice?: (symbol: string) => number | null;
  maxReferenceDriftTicks?: number;
  /**
   * Název systému Rithmicu, ke kterému je adaptér přihlášený, a výslovný seznam povolených.
   * `environment === 'demo'` nestačí — na „Rithmic Paper Trading" běží i prop účty.
   */
  systemName: string;
  allowedSystems: readonly string[];
  now?: () => number;
}

export interface LocalExecOrderView {
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  filledQuantity: number;
  status: BrokerOrder['status'];
  /** Co to je z pohledu obchodníka. */
  role: 'entry' | 'stop' | 'target' | 'other';
  /** Typ a ceny tak, jak je hlásí broker (pro zobrazení cizích příkazů). */
  orderType?: string;
  limitPrice?: number;
  stopPrice?: number;
  /** Cena čáry v grafu (limit, nebo spoušť stopu); u tržního příkazu chybí. */
  price?: number;
  /** Vstup, ke kterému noha patří. */
  entryId?: string;
  /** Jen u vstupu: Limit, nebo Stop (čeká na spuštění). Jen zobrazení. */
  entryType?: 'Limit' | 'Stop';
  /**
   * Jen u čekajícího vstupu s ochranou: kde SL/TP vzniknou, POKUD se vstup vyplní přesně za svou
   * cenu (Rithmic je počítá od ceny vyplnění). Jen zobrazení — příkazy to ještě nejsou.
   */
  plannedStop?: number;
  plannedTarget?: number;
  tag?: string;
}

export interface LocalExecState {
  seq: number;
  at: number;
  connected: boolean;
  halted: boolean;
  environment: 'demo' | 'live';
  accountId: number | null;
  positions: Array<{ symbol: string; netQuantity: number; averagePrice?: number }>;
  orders: LocalExecOrderView[];
  brackets: Array<{ entryId: string; symbol: string; state: BracketState; detail: string }>;
  incidents: Array<{ kind: string; message: string; at: number }>;
  /** Poslední odmítnuté příkazy (důvod od Rithmicu) — jen pro zobrazení. */
  rejections: Array<{ orderId: string; tag?: string; reason: string; at: number }>;
  /** Kritický incident zastavil nové vstupy; uvolní ho jen výslovné potvrzení obsluhou (`ack`). */
  blocked: string | null;
}

export type LocalExecCommand =
  /** `triggerPrice` = spoušť Stop vstupu; `stopPrice` / `targetPrice` jsou ceny SL / TP. */
  | { op: 'entry'; clientId: string; symbol: string; side: OrderSide; quantity: number; orderType: 'Market' | 'Limit' | 'Stop'; limitPrice?: number; triggerPrice?: number; stopPrice?: number; targetPrice?: number; referencePrice?: number }
  /** Samostatná ochrana otevřené pozice: BUĎ SL, NEBO TP — nikdy obojí (dva nesvázané výstupy by po vyplnění jednoho nechaly druhý pracovat). */
  | { op: 'protect'; clientId: string; symbol: string; kind: 'stop' | 'target'; price: number }
  | { op: 'move'; orderId: string; price: number }
  /** Posune VŠECHNY pracující nohy jedné role (pozice s víc ochranami) na jednu cenu; `expect` = nohy a ceny, které appka znala při odeslání (služba ověří, že se od té chvíle nezměnily — ne to, co uživatel viděl při kliku). */
  | { op: 'move-legs'; symbol: string; role: 'stop' | 'target'; price: number; expect: Array<{ orderId: string; price: number }> }
  | { op: 'cancel'; orderId: string }
  | { op: 'flatten'; clientId: string; symbol: string }
  | { op: 'ack' };

export type LocalExecResult = { ok: true; result: unknown } | { ok: false; sent: boolean | 'unknown'; error: string };

const TERMINAL: ReadonlySet<string> = new Set(['filled', 'canceled', 'rejected']);
/** Incidenty, po kterých služba nepřijme nový vstup, dokud je obsluha nepotvrdí (INV-DEFAULT-02). */
const BLOCKING: ReadonlySet<string> = new Set([
  'bracket-legs-missing', 'bracket-orphan-legs', 'flatten-cancel-unconfirmed', 'flatten-orders-remain', 'flatten-interrupted',
  'fill-missing', 'state-undetermined', 'unknown-order-in-snapshot', 'forced-logout',
]);
const CLIENT_ID = /^[A-Za-z0-9_-]{1,30}$/;
/** Značka samostatné ochrany pozice (jeden SL nebo jeden TP zadaný k už otevřené pozici). */
export const PROTECT_TAG = 'uiprot-';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export class LocalExec {
  private readonly broker: RithmicBrokerPort;
  private readonly now: () => number;
  private readonly listeners = new Set<(state: LocalExecState) => void>();
  private readonly orders = new Map<string, BrokerOrder>();
  private readonly positions = new Map<string, { netQuantity: number; averagePrice?: number }>();
  private readonly incidents: Array<{ kind: string; message: string; at: number }> = [];
  private readonly seenClientIds = new Set<string>();
  private readonly rejections: Array<{ orderId: string; tag?: string; reason: string; at: number }> = [];
  private connected = false;
  private blocked: string | null = null;
  /** Množství vstupů, které odešly (nebo právě odcházejí) a kniha je ještě nezná: značka → kontrakt a kusy. */
  private readonly reserved = new Map<string, { symbol: string; quantity: number }>();
  /** Vyplnění vlastních vstupů, která zpráva o pozici ještě nepotvrdila (pořadí událostí). */
  private fillsAhead: Array<{ symbol: string; quantity: number; at: number }> = [];
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly config: LocalExecConfig) {
    this.broker = config.broker;
    this.now = config.now ?? (() => Date.now());
  }

  /** Zapojit se na události adaptéru. Volat PŘED `broker.start()`, ať neunikne výchozí stav. */
  attach(): void {
    this.unsubscribe = this.broker.subscribe((event) => this.onEvent(event));
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Incidenty adaptéru (předat jako `onIncident` v konfiguraci adaptéru). */
  onIncident = (incident: RithmicIncident): void => {
    this.incidents.push({ kind: incident.kind, message: incident.message, at: incident.at });
    if (this.incidents.length > 30) this.incidents.shift();
    if (BLOCKING.has(incident.kind)) this.blocked = `${incident.kind}: ${incident.message}`.slice(0, 240);
    this.changed();
  };

  subscribe(listener: (state: LocalExecState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private onEvent(event: BrokerEvent): void {
    if (event.type === 'order') {
      const before = this.orders.get(event.order.brokerOrderId);
      this.orders.set(event.order.brokerOrderId, event.order);
      if (event.order.tag) this.reserved.delete(event.order.tag); // kniha příkaz zná → počítá se z ní
      // Vlastní vstup se vyplnil: dokud nepřijde zpráva o pozici, počítá se vyplněné množství zvlášť
      // (jinak by mezi vyplněním a pozicí „zmizelo" a další vstup by obešel strop).
      const grew = event.order.filledQuantity - (before?.filledQuantity ?? 0);
      if (grew > 0) this.lastFillAt.set(event.order.symbol, this.now());
      if (grew > 0 && event.order.tag?.startsWith('ui-')) this.fillsAhead.push({ symbol: event.order.symbol, quantity: grew, at: this.now() });
      if (event.order.status === 'rejected' && before?.status !== 'rejected') {
        this.rejections.push({ orderId: event.order.brokerOrderId, ...(event.order.tag ? { tag: event.order.tag } : {}), reason: event.order.rejectReason ?? 'bez důvodu', at: this.now() });
        if (this.rejections.length > 10) this.rejections.shift();
      }
    }
    else if (event.type === 'position') {
      // Rezervu za vyplnění uvolní jen zpráva s NENULOVOU pozicí (ta už vyplnění zahrnuje).
      // Nula může být opožděná zpráva z doby před vyplněním — ta nic neuvolní; zbytek vyprší časem.
      if (event.position.netQuantity !== 0) this.fillsAhead = this.fillsAhead.filter((fill) => fill.symbol !== event.position.symbol);
      this.lastPositionAt.set(event.position.symbol, this.now());
      this.positions.set(event.position.symbol, {
        netQuantity: event.position.netQuantity,
        ...(event.displayAveragePrice !== undefined ? { averagePrice: event.displayAveragePrice } : {}),
      });
    } else if (event.type === 'connection') {
      this.connected = event.connected;
      if (event.connected && event.resync) {
        // Výchozí stav po (znovu)připojení je nová pravda — staré záznamy pryč.
        this.orders.clear();
        this.positions.clear();
        this.fillsAhead = [];
        for (const order of event.resync.orders) this.orders.set(order.brokerOrderId, order);
        for (const position of event.resync.positions) this.positions.set(position.symbol, { netQuantity: position.netQuantity });
      }
    } else if (event.type !== 'fill') return;
    this.watchProtective();
    this.changed();
  }

  /**
   * Samostatná ochrana bez pozice, nebo s jiným množstvím než pozice: nic se samo neruší ani nemění
   * (ochrana se nikdy neopravuje obchodem) — jen se zastaví nové vstupy a obsluha rozhodne.
   * Nesoulad se hlásí, až když VYDRŽÍ celou lhůtu (pořadí zpráv o pozici a o příkazu není zaručené:
   * vyplnění ochrany smí na chvíli vypadat jako „příkaz bez pozice"). Lhůtu hlídá časovač, ne další
   * událost — na klidném účtu by sirotek jinak zůstal neohlášený.
   */
  /** Kontrakty, kde posun více noh skončil nejistě: další změny noh i přikoupení stojí do potvrzení obsluhou. */
  private readonly legsUncertain = new Set<string>();
  /** Právě běžící posun více noh (jeden na kontrakt). */
  private readonly legsMoving = new Set<string>();
  private readonly lastFillAt = new Map<string, number>();
  private readonly lastPositionAt = new Map<string, number>();
  private readonly protectiveMismatchSince = new Map<string, number>();
  private readonly protectiveReported = new Set<string>();
  private protectiveTimer: ReturnType<typeof setTimeout> | null = null;
  private watchProtective(): void {
    const grace = this.config.protectiveGraceMs ?? 3_000;
    let recheckIn: number | null = null;
    for (const order of this.orders.values()) {
      if (!order.tag?.startsWith(PROTECT_TAG)) continue;
      const id = order.brokerOrderId;
      if (TERMINAL.has(order.status)) { this.protectiveMismatchSince.delete(id); this.protectiveReported.delete(id); continue; }
      const net = this.positions.get(order.symbol)?.netQuantity ?? 0;
      const closes = order.side === 'Sell' ? net > 0 : net < 0;
      const open = order.quantity - order.filledQuantity;
      // Shoda obnovena → příští nesoulad se ohlásí znovu.
      if (closes && open === Math.abs(net)) { this.protectiveMismatchSince.delete(id); this.protectiveReported.delete(id); continue; }
      if (this.protectiveReported.has(id)) continue;
      const since = this.protectiveMismatchSince.get(id) ?? this.now();
      this.protectiveMismatchSince.set(id, since);
      const left = grace - (this.now() - since);
      if (left > 0) { recheckIn = recheckIn === null ? left : Math.min(recheckIn, left); continue; }
      this.protectiveReported.add(id);
      this.protectiveMismatchSince.delete(id);
      const what = net === 0 ? 'pracuje bez pozice' : !closes ? 'je na stejné straně jako pozice' : `má ${open} ks, pozice ${Math.abs(net)}`;
      const message = `ochranný příkaz ${id} (${order.symbol}) ${what} — nic neměním, zruš ho nebo zavři pozici ručně`;
      this.incidents.push({ kind: 'protective-order-mismatch', message, at: this.now() });
      if (this.incidents.length > 30) this.incidents.shift();
      this.blocked = `protective-order-mismatch: ${message}`.slice(0, 240);
    }
    // Součet ochran vstupů proti pozici: každá ochrana se hlídá sama za sebe, ale když pozici zmenší něco
    // zvenčí, obě zůstanou „chráněno" a po spuštění by pozici obrátily. Nic se samo neruší — jen blokace.
    const accountId = this.broker.accountIds()[0];
    if (accountId !== undefined) {
      const symbols = new Set(this.broker.listBrackets(accountId).filter((bracket) => !bracket.closed).map((bracket) => bracket.symbol));
      for (const symbol of symbols) {
        const key = `coverage:${symbol}`;
        // Známé ochrany se počítají i když na kontraktu pracuje příkaz, který služba nezná — neznámo neznamená „žádný přebytek".
        const legs = this.legsOf(accountId, symbol, false);
        const net = this.positions.get(symbol)?.netQuantity ?? 0;
        const open = (list: BrokerOrder[]) => list.reduce((sum, order) => sum + (order.quantity - order.filledQuantity), 0);
        const over = legs ? [legs.stops, legs.targets].some((list) => list.length > 0 && open(list) > Math.abs(net)) : false;
        if (!over) { this.protectiveMismatchSince.delete(key); this.protectiveReported.delete(key); continue; }
        if (this.protectiveReported.has(key)) continue;
        const since = this.protectiveMismatchSince.get(key) ?? this.now();
        this.protectiveMismatchSince.set(key, since);
        const left = grace - (this.now() - since);
        if (left > 0) { recheckIn = recheckIn === null ? left : Math.min(recheckIn, left); continue; }
        this.protectiveReported.add(key);
        this.protectiveMismatchSince.delete(key);
        const message = `SL/TP na ${symbol} mají dohromady víc kusů než pozice (${Math.abs(net)}) — po spuštění by pozici obrátily; nic neměním, zavři pozici nebo příkazy zruš`;
        this.incidents.push({ kind: 'protection-exceeds-position', message, at: this.now() });
        if (this.incidents.length > 30) this.incidents.shift();
        this.blocked = `protection-exceeds-position: ${message}`.slice(0, 240);
      }
    }
    if (recheckIn !== null && !this.protectiveTimer) {
      this.protectiveTimer = setTimeout(() => {
        this.protectiveTimer = null;
        this.watchProtective();
        this.changed();
      }, recheckIn + 5);
      (this.protectiveTimer as { unref?: () => void }).unref?.();
    }
  }

  /** Stav se rozesílá hned v další mikroúloze — víc změn z jedné zprávy serveru = jedna zpráva appce. */
  private changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const state = this.state();
      for (const listener of [...this.listeners]) {
        try {
          listener(state);
        } catch {
          // posluchač nesmí shodit službu
        }
      }
    }, 0);
  }

  state(): LocalExecState {
    const accountId = this.broker.accountIds()[0] ?? null;
    const brackets = accountId === null ? [] : this.broker.listBrackets(accountId);
    const roleOf = new Map<string, { role: 'entry' | 'stop' | 'target'; entryId: string }>();
    for (const bracket of brackets) {
      roleOf.set(bracket.entryId, { role: 'entry', entryId: bracket.entryId });
      // Noha bez známého typu se ukáže jako „other" — čára bez role, posun ji odmítne.
      for (const leg of bracket.legs) if (leg.role !== 'unknown') roleOf.set(leg.orderId, { role: leg.role, entryId: bracket.entryId });
    }
    const orders: LocalExecOrderView[] = [];
    for (const order of this.orders.values()) {
      if (TERMINAL.has(order.status)) continue;
      const known = roleOf.get(order.brokerOrderId);
      // Samostatná ochrana pozice se ukazuje jako SL/TP, ne jako vstup.
      const protective = order.tag?.startsWith(PROTECT_TAG) ? (order.orderType === 'Stop' ? 'stop' as const : order.orderType === 'Limit' ? 'target' as const : 'other' as const) : null;
      // Vstup je jen VLASTNÍ příkaz (značka ui-). Cokoli zadané jinde (jiná platforma) je „other": graf to ukáže
      // jako cizí příkaz jen pro zobrazení, nikdy jako vstup, SL nebo TP této appky.
      const own = order.tag?.startsWith('ui-') === true;
      const role = known?.role ?? protective ?? (own && order.orderType !== 'Unsupported' ? 'entry' : 'other');
      // Vstup: Stop se kreslí na spoušti (burza k němu může hlásit i ochranný limit), Limit na limitní ceně.
      const price = role === 'stop' ? order.stopPrice : role === 'target' ? order.limitPrice : order.stopPrice ?? order.limitPrice;
      orders.push({
        orderId: order.brokerOrderId, symbol: order.symbol, side: order.side, quantity: order.quantity, filledQuantity: order.filledQuantity,
        status: order.status, role, ...(price !== undefined ? { price } : {}),
        orderType: order.orderType, ...(order.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}), ...(order.stopPrice !== undefined ? { stopPrice: order.stopPrice } : {}),
        ...(role === 'entry' && price !== undefined ? { entryType: order.stopPrice !== undefined ? 'Stop' as const : 'Limit' as const } : {}),
        ...(known && known.role !== 'entry' ? { entryId: known.entryId } : {}), ...(order.tag ? { tag: order.tag } : {}),
        ...this.planned(order, brackets.find((bracket) => bracket.entryId === order.brokerOrderId)),
      });
    }
    return {
      seq: (this.seq += 1),
      at: this.now(),
      connected: this.connected && this.broker.isConnected(),
      halted: this.broker.isHalted(),
      environment: this.broker.environment,
      accountId,
      positions: [...this.positions].filter(([, p]) => p.netQuantity !== 0).map(([symbol, p]) => ({ symbol, ...p })),
      orders,
      brackets: accountId === null ? [] : brackets.filter((b) => !b.closed).map((b) => ({ entryId: b.entryId, symbol: b.symbol, ...this.broker.bracketState(accountId, b.entryId) })),
      incidents: [...this.incidents],
      rejections: [...this.rejections],
      blocked: this.blocked,
    };
  }

  /** Pracující nohy vlastních neuzavřených vstupů s ochranou na kontraktu, podle role. Null = role některého příkazu neznám. */
  private legsOf(accountId: number, symbol: string, strict = true): { stops: BrokerOrder[]; targets: BrokerOrder[]; brackets: Array<{ entryId: string; stopTicks?: number; targetTicks?: number }> } | null {
    const brackets = this.broker.listBrackets(accountId).filter((bracket) => bracket.symbol === symbol && !bracket.closed);
    const stops: BrokerOrder[] = [];
    const targets: BrokerOrder[] = [];
    const known = new Set<string>();
    for (const bracket of brackets) {
      known.add(bracket.entryId);
      for (const leg of bracket.legs) {
        const order = this.orders.get(leg.orderId);
        if (!order || TERMINAL.has(order.status)) continue;
        if (leg.role === 'unknown') { if (strict) return null; continue; }
        known.add(leg.orderId);
        (leg.role === 'stop' ? stops : targets).push(order);
      }
    }
    // Každý pracující příkaz kontraktu musí být známý (vstup nebo noha vlastní ochrany).
    for (const order of this.orders.values()) {
      if (strict && order.symbol === symbol && !TERMINAL.has(order.status) && !known.has(order.brokerOrderId)) return null;
    }
    return { stops, targets, brackets };
  }

  /**
   * Proč teď NEJDE přikoupit (null = jde). První verze: jen do pozice, kterou CELOU kryjí vlastní
   * vstupy s ochranou (každý ve stavu „chráněno"), se SL i TP na jedné ceně, a přikoupení nese
   * přesně tytéž ceny. Nic se po vyplnění nesrovnává — každá část má vlastní ochranu na své množství.
   */
  private scaleInProblem(accountId: number, symbol: string, side: OrderSide, stopPrice: number | undefined, targetPrice: number | undefined, ownTag: string | null): string | null {
    const net = this.positions.get(symbol)?.netQuantity ?? 0;
    if (net === 0) return 'pozice se mezitím zavřela — přikoupení neodesílám';
    if ((side === 'Buy') !== (net > 0)) return 'vstup proti otevřené pozici nejde — pozici zavři';
    if ([...this.reserved].some(([reservedTag, item]) => item.symbol === symbol && reservedTag !== ownTag)) return 'na cestě je jiný příkaz tohoto kontraktu — přikoupení teď nejde';
    this.fillsAhead = this.fillsAhead.filter((fill) => this.now() - fill.at < 5_000);
    if (this.fillsAhead.some((fill) => fill.symbol === symbol)) return 'pozice se právě mění (čerstvé vyplnění) — přikup za okamžik';
    const filledAt = this.lastFillAt.get(symbol);
    if (filledAt !== undefined && ((this.lastPositionAt.get(symbol) ?? 0) < filledAt || this.now() - filledAt < (this.config.positionSettleMs ?? 1_000))) {
      return 'pozice se právě mění (čerstvé vyplnění) — přikup za okamžik';
    }
    // Jiný vstup s ochranou, o kterém broker ještě nedal vědět (i z doby před restartem služby).
    if (this.broker.unresolvedBracketTags(accountId, symbol).some((pendingTag) => pendingTag !== ownTag)) return 'jiný vstup s ochranou ještě není potvrzený — přikoupení teď nejde';
    if (this.legsUncertain.has(symbol)) return 'poslední posun SL/TP skončil nejistě — nejdřív ověř ceny u brokera a potvrď incident';
    const legs = this.legsOf(accountId, symbol);
    if (!legs) return 'na kontraktu pracuje příkaz, který služba nezná — přikoupení nejde';
    if (legs.brackets.length === 0) return 'pozice nemá SL a TP ze vstupu — přikoupit jde jen do pozice se SL i TP';
    // Dřívější obchody, které už skončily (jen ještě nejsou trvale uzavřené), se nepočítají.
    legs.brackets = legs.brackets.filter((bracket) => this.broker.bracketState(accountId, bracket.entryId).state !== 'done');
    if (legs.brackets.length === 0) return 'pozice nemá SL a TP ze vstupu — přikoupit jde jen do pozice se SL i TP';
    for (const bracket of legs.brackets) {
      if (bracket.stopTicks === undefined || bracket.targetTicks === undefined) return 'pozice nemá SL i TP — přikoupit jde jen do pozice se SL i TP';
      const state = this.broker.bracketState(accountId, bracket.entryId).state;
      if (state !== 'protected') return state === 'entry-working' ? 'čeká jiný vstup — přikoupení teď nejde' : 'ochrana pozice není úplná — přikoupení nejde';
    }
    // Právě jedna potvrzená noha každého druhu na ochranu, na opačné straně než pozice; nic navíc ani nepotvrzeného.
    const exitSide: OrderSide = net > 0 ? 'Sell' : 'Buy';
    for (const list of [legs.stops, legs.targets]) {
      if (list.length !== legs.brackets.length || list.some((order) => order.status !== 'working' || order.side !== exitSide)) return 'ochrana pozice není v očekávaném tvaru — přikoupení nejde';
    }
    const open = (list: BrokerOrder[]) => list.reduce((sum, order) => sum + (order.quantity - order.filledQuantity), 0);
    if (open(legs.stops) !== Math.abs(net) || open(legs.targets) !== Math.abs(net)) return 'SL/TP nekryjí celou pozici — přikoupení nejde';
    const stopAt = new Set(legs.stops.map((order) => order.stopPrice));
    const targetAt = new Set(legs.targets.map((order) => order.limitPrice));
    if (stopAt.size !== 1 || targetAt.size !== 1) return 'SL nebo TP pozice má víc cen — nejdřív je srovnej posunem';
    if (stopPrice === undefined || targetPrice === undefined || !stopAt.has(stopPrice) || !targetAt.has(targetPrice)) {
      return `přikoupení musí mít SL a TP pozice (SL ${[...stopAt][0]}, TP ${[...targetAt][0]})`;
    }
    return null;
  }

  /** Cena musí ležet na mřížce kroku kontraktu — nic se tiše nezaokrouhluje. */
  private onGrid(price: number, tickSize: number): boolean {
    const steps = price / tickSize;
    return Math.abs(steps - Math.round(steps)) < 1e-6;
  }

  /** Vykoná příkaz z appky. Nikdy nic neopakuje; `sent` říká, zda zápis mohl odejít. */
  async execute(raw: LocalExecCommand): Promise<LocalExecResult> {
    const refuse = (message: string): never => {
      throw new BrokerRequestNotSentError(message);
    };
    try {
      const command = raw as unknown as Record<string, unknown>;
      if (!command || typeof command !== 'object') refuse('příkaz není objekt');
      if (!this.config.allowedSystems.includes(this.config.systemName)) refuse(`systém ${this.config.systemName} není pro místní službu povolený`);
      if (this.broker.environment !== 'demo') refuse('místní služba je povolená jen pro testovací prostředí');
      const accountId = this.broker.accountIds()[0];
      if (accountId === undefined) return refuse('adaptér nemá účet (není připojený)');
      switch (command.op) {
        case 'ack':
          this.blocked = null;
          // Nejistý zápis ochrany, který se v knize neobjevil, nesmí blokovat další ochranu navždy:
          // obsluha potvrzením říká, že stav u brokera zkontrolovala.
          for (const [reservedTag] of this.reserved) {
            if (reservedTag.startsWith(PROTECT_TAG) && ![...this.orders.values()].some((order) => order.tag === reservedTag)) this.reserved.delete(reservedTag);
          }
          this.legsUncertain.clear();
          // Trvající nesoulad ochrany se po potvrzení ohlásí znovu (po lhůtě) — potvrzení ho neschová.
          this.protectiveReported.clear();
          this.watchProtective();
          this.changed();
          return { ok: true, result: { acknowledged: true } };
        case 'entry': {
          if (this.blocked) refuse(`nové vstupy jsou zastavené, dokud nepotvrdíš incident (${this.blocked})`);
          const symbol = typeof command.symbol === 'string' ? command.symbol : '';
          const spec = this.config.symbols[symbol];
          if (!spec) return refuse(`kontrakt ${symbol || '?'} není povolený`);
          if (command.side !== 'Buy' && command.side !== 'Sell') refuse('strana musí být Buy nebo Sell');
          if (command.orderType !== 'Market' && command.orderType !== 'Limit' && command.orderType !== 'Stop') refuse('typ musí být Market, Limit nebo Stop');
          const side = command.side as OrderSide;
          const orderType = command.orderType as 'Market' | 'Limit' | 'Stop';
          const quantity = command.quantity;
          if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > this.config.maxQuantity) {
            return refuse(`množství ${String(quantity)} je mimo povolený rozsah 1–${this.config.maxQuantity}`);
          }
          // Pracující samostatná ochrana = pozice se hlídá jedním výstupem; další vstup by ji rozešel s pozicí
          // (opačný by pozici zavřel a ochrana by zůstala sama, stejnosměrný by kryla jen zčásti).
          if ([...this.orders.values()].some((order) => order.symbol === symbol && !TERMINAL.has(order.status) && order.tag?.startsWith(PROTECT_TAG))
            || [...this.reserved].some(([reservedTag, item]) => item.symbol === symbol && reservedTag.startsWith(PROTECT_TAG))) {
            return refuse('pozice má samostatný SL/TP — další vstup teď nejde; nejdřív pozici zavři nebo ochranu zruš');
          }
          const clientId = typeof command.clientId === 'string' ? command.clientId : '';
          if (!CLIENT_ID.test(clientId)) refuse('clientId musí mít 1–30 znaků [A-Za-z0-9_-]');
          const tag = `ui-${clientId}`;
          // Idempotence i přes restart služby: značku nesmí nést žádný dnešní příkaz (kniha po
          // výchozím stavu zná i dokončené).
          if (this.seenClientIds.has(clientId) || [...this.orders.values()].some((order) => order.tag === tag)) refuse('příkaz s tímto clientId už byl přijat');
          for (const field of ['limitPrice', 'triggerPrice', 'stopPrice', 'targetPrice', 'referencePrice'] as const) {
            const value = command[field];
            if (value === undefined) continue;
            if (!finite(value) || value <= 0) refuse(`${field} musí být kladné číslo (nebo chybět)`);
            if (!this.onGrid(value as number, spec.tickSize)) refuse(`${field} ${String(value)} neleží na kroku ceny ${spec.tickSize}`);
          }
          const limitPrice = command.limitPrice as number | undefined;
          const stopPrice = command.stopPrice as number | undefined;
          const targetPrice = command.targetPrice as number | undefined;
          const server = this.config.serverPrice?.(symbol) ?? null;
          const maxDrift = this.config.maxReferenceDriftTicks ?? 20;
          let reference: number;
          if (orderType === 'Limit') {
            if (limitPrice === undefined) return refuse('Limit bez ceny');
            reference = limitPrice;
            // Limit přes trh by se vyplnil jinde, než odkud se počítá SL/TP.
            if (server !== null && (stopPrice !== undefined || targetPrice !== undefined) && (side === 'Buy' ? limitPrice > server : limitPrice < server)) {
              refuse('Limit se SL/TP je přes trh — vyplnil by se za jinou cenu, než od které se počítá ochrana; použij Market');
            }
          } else if (orderType === 'Stop') {
            // Stop vstup (změřeno 17. 11. 2026: Rithmic přijme STOP_MARKET i se serverovou ochranou).
            const trigger = command.triggerPrice as number | undefined;
            if (trigger === undefined) return refuse('Stop bez spouštěcí ceny');
            if (server === null) return refuse('služba nemá čerstvou cenu — Stop vstup neodesílám (mohl by se spustit hned)');
            // Spoušť musí být ZA trhem ve směru vstupu; jinak by se příkaz spustil okamžitě jako Market.
            if (side === 'Buy' ? trigger <= server : trigger >= server) return refuse('spoušť Stopu je na špatné straně trhu — spustil by se hned; použij Market nebo Limit');
            reference = trigger;
          } else {
            const fromClient = command.referencePrice as number | undefined;
            if (stopPrice !== undefined || targetPrice !== undefined) {
              // Vzdálenost SL/TP u Marketu se počítá JEN od ceny služby — cena z appky je jen kontrola.
              if (server === null) refuse('služba nemá čerstvou cenu, od které by spočítala vzdálenost SL/TP — vstup neodesílám');
              if (server !== null && fromClient !== undefined && Math.abs(fromClient - server) / spec.tickSize > maxDrift) {
                refuse(`cena v appce (${fromClient}) se liší od ceny služby (${server}) o víc než ${maxDrift} ticků — vstup neodesílám`);
              }
            }
            reference = server ?? fromClient ?? 0;
          }
          const maxTicks = this.config.maxProtectionTicks ?? 400;
          const ticks = (price: number | undefined, sign: 1 | -1, name: string): number | undefined => {
            if (price === undefined) return undefined;
            const distance = Math.round(((price - reference) * sign) / spec.tickSize);
            if (distance < 1) refuse(`${name} je na špatné straně vstupu nebo příliš blízko`);
            if (distance > maxTicks) refuse(`${name} je ${distance} ticků od vstupu — víc než povolených ${maxTicks}`);
            return distance;
          };
          const up: 1 | -1 = side === 'Buy' ? 1 : -1;
          const stopTicks = ticks(stopPrice, up === 1 ? -1 : 1, 'SL');
          const targetTicks = ticks(targetPrice, up, 'TP');
          // Strop pozice: otevřená pozice + čekající vstupy + tento.
          const open = Math.abs(this.positions.get(symbol)?.netQuantity ?? 0);
          const waiting = [...this.orders.values()].filter((order) => order.symbol === symbol && !TERMINAL.has(order.status) && order.tag?.startsWith('ui-') && !this.isLeg(accountId, order.brokerOrderId))
            .reduce((sum, order) => sum + (order.quantity - order.filledQuantity), 0);
          // + vstupy na cestě, které kniha ještě nezná (souběžná volání nesmí strop obejít).
          const onTheWay = [...this.reserved].filter(([reservedTag, item]) => item.symbol === symbol && ![...this.orders.values()].some((order) => order.tag === reservedTag))
            .reduce((sum, [, item]) => sum + item.quantity, 0);
          const maxPosition = this.config.maxPosition ?? this.config.maxQuantity;
          this.fillsAhead = this.fillsAhead.filter((fill) => this.now() - fill.at < 5_000);
          const ahead = this.fillsAhead.filter((fill) => fill.symbol === symbol).reduce((sum, fill) => sum + fill.quantity, 0);
          if (open + ahead + waiting + onTheWay + quantity > maxPosition) refuse(`pozice by přesáhla strop ${maxPosition} (otevřeno ${open + ahead}, čeká ${waiting + onTheWay})`);
          // Přikoupení do otevřené pozice: jen za přísných podmínek (viz `scaleInProblem`); ověří se teď
          // a znovu těsně před zápisem (adaptér mezitím čeká na uložení záměru).
          // Jeden vlastní vstup najednou: při čekajícím nebo právě odesílaném vstupu další nejde (jinak by se
          // čekající vstup později vyplnil do cizí pozice, nebo po jejím zavření otevřel nezamýšlený obchod).
          if (waiting + onTheWay > 0) return refuse('čeká jiný vstup — další jde až po jeho vyplnění nebo zrušení');
          // Přikoupení = jakákoli existující nebo právě vznikající expozice (i vyplnění, které pozice ještě nehlásí).
          const adding = (this.positions.get(symbol)?.netQuantity ?? 0) !== 0 || ahead > 0;
          if (adding) {
            if (orderType !== 'Market') return refuse('přikoupení jde zatím jen Marketem');
            const problem = this.scaleInProblem(accountId, symbol, side, stopPrice, targetPrice, null);
            if (problem) return refuse(problem);
          }
          this.seenClientIds.add(clientId);
          // Rezervace PŘED prvním čekáním; drží i při neznámém výsledku, padá jen když zápis prokazatelně neodešel.
          this.reserved.set(tag, { symbol, quantity });
          const release = <T>(promise: Promise<T>): Promise<T> => promise.catch((error: unknown) => {
            if (error instanceof BrokerRequestNotSentError) this.reserved.delete(tag);
            throw error;
          });
          const request = { tag, accountId, symbol, side, quantity, orderType, ...(orderType === 'Limit' ? { limitPrice } : {}), ...(orderType === 'Stop' ? { stopPrice: command.triggerPrice as number } : {}) };
          if (stopTicks === undefined && targetTicks === undefined) {
            const ack = await release(this.broker.placeOrder(request));
            return { ok: true, result: { orderId: ack.brokerOrderId } };
          }
          const ack = await release(this.broker.placeBracket({
            ...request, ...(stopTicks !== undefined ? { stopTicks } : {}), ...(targetTicks !== undefined ? { targetTicks } : {}),
            ...(adding ? { guard: () => this.scaleInProblem(accountId, symbol, side, stopPrice, targetPrice, tag) } : {}),
          }));
          return { ok: true, result: { orderId: ack.entryBrokerOrderId, stopTicks, targetTicks } };
        }
        case 'protect': {
          // Ochrana snižuje riziko → smí i při zastavených vstupech. Vždy JEN jeden výstupní příkaz na pozici.
          const symbol = typeof command.symbol === 'string' ? command.symbol : '';
          const spec = this.config.symbols[symbol];
          if (!spec) return refuse(`kontrakt ${symbol || '?'} není povolený`);
          if (command.kind !== 'stop' && command.kind !== 'target') refuse('ochrana musí být stop nebo target');
          const kind = command.kind as 'stop' | 'target';
          const clientId = typeof command.clientId === 'string' ? command.clientId : '';
          if (!CLIENT_ID.test(clientId)) refuse('clientId musí mít 1–30 znaků [A-Za-z0-9_-]');
          const tag = `${PROTECT_TAG}${clientId}`;
          if (this.seenClientIds.has(clientId) || [...this.orders.values()].some((order) => order.tag === tag)) refuse('příkaz s tímto clientId už byl přijat');
          const price = command.price;
          if (!finite(price) || price <= 0) return refuse('ochrana bez platné ceny');
          if (!this.onGrid(price, spec.tickSize)) refuse(`cena ${price} neleží na kroku ceny ${spec.tickSize}`);
          const net = this.positions.get(symbol)?.netQuantity ?? 0;
          if (net === 0) return refuse('není otevřená pozice — ochranu není k čemu přidat');
          const quantity = Math.abs(net);
          if (quantity > (this.config.maxPosition ?? this.config.maxQuantity)) return refuse(`pozice ${quantity} je nad stropem služby — ochranu nezadávám`);
          // Jakýkoli jiný pracující příkaz kontraktu (noha vstupu, jiná ochrana, čekající vstup, zavírání) = ne:
          // dva nesvázané výstupy by po vyplnění jednoho nechaly druhý otevřít opačnou pozici.
          const working = [...this.orders.values()].filter((order) => order.symbol === symbol && !TERMINAL.has(order.status));
          if (working.length > 0) return refuse('pozice už má pracující příkaz (SL/TP nebo čekající vstup) — přidat jde jen jeden SL nebo jeden TP k pozici bez příkazů');
          if ([...this.reserved.values()].some((item) => item.symbol === symbol)) return refuse('na cestě je jiný příkaz tohoto kontraktu — ochranu teď nezadávám');
          // Vstup s ochranou, jehož nohy ještě nedorazily (nebo se neví): nohy jsou výstup → další by byl druhý.
          if (this.broker.listBrackets(accountId).some((bracket) => bracket.symbol === symbol && !bracket.closed)) {
            return refuse('pozice patří ke vstupu s ochranou (jeho SL/TP se právě zakládají nebo hlídají) — další ochranu nezadávám');
          }
          // Těsně po vyplnění může být místní pozice ještě stará (např. právě vyplněná ochrana): počkat na zprávu
          // o pozici, která přišla až PO posledním vyplnění, a na krátké usazení.
          const filledAt = this.lastFillAt.get(symbol);
          if (filledAt !== undefined && ((this.lastPositionAt.get(symbol) ?? 0) < filledAt || this.now() - filledAt < (this.config.positionSettleMs ?? 1_000))) {
            return refuse('pozice se právě mění (čerstvé vyplnění) — ochranu zadej za okamžik');
          }
          const server = this.config.serverPrice?.(symbol) ?? null;
          if (server === null) return refuse('služba nemá čerstvou cenu — ochranu nezadávám (spustila by se možná hned)');
          const long = net > 0;
          // SL na ztrátové straně trhu, TP na ziskové; jinak by se příkaz spustil/vyplnil okamžitě.
          const below = price < server;
          if (kind === 'stop' ? long !== below : long === below) return refuse(kind === 'stop' ? 'SL je na špatné straně trhu — spustil by se hned' : 'TP je na špatné straně trhu — vyplnil by se hned');
          const distance = Math.round(Math.abs(price - server) / spec.tickSize);
          if (distance < 1) return refuse('ochrana je příliš blízko trhu');
          if (distance > (this.config.maxProtectionTicks ?? 400)) return refuse(`ochrana je ${distance} ticků od trhu — víc než povolených ${this.config.maxProtectionTicks ?? 400}`);
          this.seenClientIds.add(clientId);
          this.reserved.set(tag, { symbol, quantity: 0 });
          let ack;
          try {
            ack = await this.broker.placeOrder({
              tag, accountId, symbol, side: long ? 'Sell' : 'Buy', quantity,
              orderType: kind === 'stop' ? 'Stop' : 'Limit', ...(kind === 'stop' ? { stopPrice: price } : { limitPrice: price }),
            });
          } catch (error) {
            if (error instanceof BrokerRequestNotSentError) this.reserved.delete(tag);
            throw error;
          }
          return { ok: true, result: { orderId: ack.brokerOrderId, quantity } };
        }
        case 'move': {
          const orderId = typeof command.orderId === 'string' ? command.orderId : '';
          const order = this.orders.get(orderId);
          if (!order || TERMINAL.has(order.status)) return refuse(`příkaz ${orderId || '?'} nepracuje`);
          const spec = this.config.symbols[order.symbol];
          if (!spec) return refuse(`kontrakt ${order.symbol} není povolený`);
          const price = command.price;
          if (!finite(price) || price <= 0) return refuse('posun bez platné ceny');
          if (!this.onGrid(price, spec.tickSize)) refuse(`cena ${price} neleží na kroku ceny ${spec.tickSize}`);
          // Posouvat jde jen to, co služba sama zná: nohu vlastního vstupu (podle její role)
          // a vlastní obyčejný Limit. Nic jiného — typ cizího příkazu by se změnou přepsal.
          const leg = this.broker.listBrackets(accountId).flatMap((bracket) => bracket.legs).find((item) => item.orderId === orderId);
          if (leg) {
            if (leg.role !== 'stop' && leg.role !== 'target') return refuse('u nohy ještě není znám typ — posun neodesílám');
            // Pozice s víc ochranami: role se posouvá celá (`move-legs`), jinak by se ceny rozešly bez vědomí obsluhy.
            if (this.legsUncertain.has(order.symbol) || this.legsMoving.has(order.symbol)) return refuse('posun SL/TP na tomto kontraktu právě běží nebo skončil nejistě — ověř ceny u brokera a potvrď incident');
            const siblings = this.legsOf(accountId, order.symbol);
            if (!siblings) return refuse('na kontraktu pracuje příkaz, který služba nezná — posun neodesílám');
            if ((leg.role === 'stop' ? siblings.stops : siblings.targets).length > 1) return refuse('pozice má víc ochran — posun jde jen pro všechny najednou');
            await this.broker.modifyOrder(accountId, orderId, {
              quantity: order.quantity, orderType: leg.role === 'stop' ? 'Stop' : 'Limit', ...(leg.role === 'stop' ? { stopPrice: price } : { limitPrice: price }),
            });
          } else if (order.tag?.startsWith('ui-') && (order.limitPrice !== undefined || order.stopPrice !== undefined)
            && (this.broker.listBrackets(accountId).some((bracket) => bracket.entryId === orderId) || order.orderType === 'Stop')) {
            // Čekající vlastní vstup s ochranou (Limit i Stop) a vlastní holý Stop: mění se jen jeho cena.
            // SL/TP jsou vzdálenosti od vyplnění, posunou se s ním.
            const stopEntry = order.stopPrice !== undefined;
            const bracketed = this.broker.listBrackets(accountId).some((bracket) => bracket.entryId === orderId);
            if (order.filledQuantity > 0) return refuse('vstup se už plní — cenu neměním');
            // Částečné plnění během změny není změřené → zatím jen 1 kontrakt (ten se částečně nevyplní).
            if (order.quantity !== 1) return refuse('posun čekajícího vstupu jde zatím jen u 1 kontraktu');
            const server = this.config.serverPrice?.(order.symbol) ?? null;
            if (server === null) return refuse('služba nemá čerstvou cenu — posun vstupu neodesílám');
            if (stopEntry) {
              // Spoušť musí zůstat ZA trhem ve směru vstupu, jinak by se Stop spustil hned.
              if (order.side === 'Buy' ? price <= server : price >= server) return refuse('nová spoušť Stopu je na špatné straně trhu — spustil by se hned');
            } else if (order.side === 'Buy' ? price > server : price < server) {
              // Přes trh by se vyplnil jinde, než kde graf ukazuje vstup i ochranu.
              return refuse('nová cena Limitu je přes trh — vyplnil by se hned za jinou cenu; zruš ho a použij Market');
            }
            await this.broker.modifyOrder(accountId, orderId, { quantity: order.quantity, orderType: stopEntry ? 'Stop' : 'Limit', ...(stopEntry ? { stopPrice: price } : { limitPrice: price }) });
            // Úspěch až podle stavu: nová cena je v knize A (u vstupu s ochranou) příkaz ochranu dál nese. Zachování
            // ochrany po změně stojí na měření z 17. 11. 2026 — kdyby ji Rithmic zahodil, musí se to poznat hned.
            const deadline = this.now() + (this.config.moveConfirmMs ?? 1_500);
            for (;;) {
              const current = this.orders.get(orderId);
              if (current && (stopEntry ? current.stopPrice : current.limitPrice) === price) {
                if (!bracketed) break;
                if (current.brokerOrderType?.startsWith('BRACKET:') && this.broker.listBrackets(accountId).some((bracket) => bracket.entryId === orderId)) break;
                this.blocked = `bracket-lost-after-move: vstup ${orderId} po posunu nenese ochranu — zkontroluj a případně ho zruš`.slice(0, 240);
                this.changed();
                return { ok: false, sent: 'unknown', error: 'vstup po posunu nenese SL/TP — nové vstupy stojí, zkontroluj příkaz u brokera' };
              }
              if (this.now() >= deadline) return { ok: false, sent: 'unknown', error: 'posun vstupu nebyl potvrzen stavem — ověř cenu příkazu' };
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          } else if (order.tag?.startsWith(PROTECT_TAG) && (order.orderType === 'Stop' || order.orderType === 'Limit')) {
            // Samostatná ochrana: jen cena, typ ani množství se nemění. Stejné meze jako při zadání.
            const server = this.config.serverPrice?.(order.symbol) ?? null;
            if (server === null) return refuse('služba nemá čerstvou cenu — ochranu neposouvám');
            const closesLong = order.side === 'Sell';
            const below = price < server;
            if (order.orderType === 'Stop' ? closesLong !== below : closesLong === below) return refuse('nová cena ochrany je na špatné straně trhu — spustila by se hned');
            const distance = Math.round(Math.abs(price - server) / spec.tickSize);
            if (distance < 1) return refuse('ochrana je příliš blízko trhu');
            if (distance > (this.config.maxProtectionTicks ?? 400)) return refuse(`ochrana je ${distance} ticků od trhu — víc než povolených ${this.config.maxProtectionTicks ?? 400}`);
            await this.broker.modifyOrder(accountId, orderId, {
              quantity: order.quantity, orderType: order.orderType, ...(order.orderType === 'Stop' ? { stopPrice: price } : { limitPrice: price }),
            });
          } else if (order.orderType === 'Limit' && order.tag?.startsWith('ui-')) {
            await this.broker.modifyOrder(accountId, orderId, { quantity: order.quantity, orderType: 'Limit', limitPrice: price });
          } else {
            return refuse('posouvat jde jen SL/TP vlastního vstupu a vlastní čekající Limit');
          }
          return { ok: true, result: { orderId } };
        }
        case 'move-legs': {
          const symbol = typeof command.symbol === 'string' ? command.symbol : '';
          const spec = this.config.symbols[symbol];
          if (!spec) return refuse(`kontrakt ${symbol || '?'} není povolený`);
          if (command.role !== 'stop' && command.role !== 'target') refuse('role musí být stop nebo target');
          const role = command.role as 'stop' | 'target';
          const price = command.price;
          if (!finite(price) || price <= 0) return refuse('posun bez platné ceny');
          if (!this.onGrid(price, spec.tickSize)) refuse(`cena ${price} neleží na kroku ceny ${spec.tickSize}`);
          const server = this.config.serverPrice?.(symbol) ?? null;
          if (server === null) return refuse('služba nemá čerstvou cenu — ochranu neposouvám');
          const net0 = this.positions.get(symbol)?.netQuantity ?? 0;
          if (net0 === 0) return refuse('není otevřená pozice');
          const long = net0 > 0;
          const below = price < server;
          if (role === 'stop' ? long !== below : long === below) return refuse('nová cena ochrany je na špatné straně trhu — spustila by se hned');
          const distance = Math.round(Math.abs(price - server) / spec.tickSize);
          if (distance < 1) return refuse('ochrana je příliš blízko trhu');
          if (distance > (this.config.maxProtectionTicks ?? 400)) return refuse(`ochrana je ${distance} ticků od trhu — víc než povolených ${this.config.maxProtectionTicks ?? 400}`);
          const priceOf = (order: BrokerOrder) => (role === 'stop' ? order.stopPrice : order.limitPrice);
          if (this.legsUncertain.has(symbol)) return refuse('poslední posun SL/TP skončil nejistě — ověř ceny u brokera a potvrď incident');
          if (this.legsMoving.has(symbol)) return refuse('jiný posun SL/TP právě běží');
          const legsNow = () => {
            const all = this.legsOf(accountId, symbol);
            return all ? (role === 'stop' ? all.stops : all.targets) : null;
          };
          const list = legsNow();
          if (!list) return refuse('na kontraktu pracuje příkaz, který služba nezná — posun neodesílám');
          if (list.length === 0) return refuse(`pozice nemá ${role === 'stop' ? 'SL' : 'TP'}`);
          if (list.length > 2) return refuse('víc než dvě ochrany — posun neodesílám');
          if (list.some((order) => order.status !== 'working')) return refuse('některá noha ještě není potvrzená burzou — posun neodesílám');
          // „Co jsem viděl": přesně tyto nohy na těchto cenách (ne jen jedna cena — změna druhé nohy by se schovala).
          const expected = Array.isArray(command.expect) ? command.expect as Array<{ orderId?: unknown; price?: unknown }> : null;
          if (!expected || expected.length !== list.length || !list.every((order) => expected.some((item) => item.orderId === order.brokerOrderId && item.price === priceOf(order)))) {
            return refuse('stav se mezitím změnil — čáry už neodpovídají příkazům u brokera');
          }
          const ids = list.map((order) => order.brokerOrderId);
          const fillMark = this.lastFillAt.get(symbol);
          const startedAt = this.now();
          const budget = this.config.moveLegsBudgetMs ?? 2_000;
          const moved: string[] = [];
          const stop = (sent: false | 'unknown', why: string): LocalExecResult => {
            // Nejistý výsledek zastaví další změny noh i přikoupení, dokud ho obsluha nepotvrdí.
            if (sent === 'unknown') {
              this.legsUncertain.add(symbol);
              this.blocked = `move-legs-uncertain: ${why}`.slice(0, 240);
              this.changed();
            }
            return { ok: false, sent, error: `${moved.length ? `posunuto: ${moved.join(', ')}; ` : ''}${why} — zbytek neodesílám, zkontroluj ceny SL/TP` };
          };
          this.legsMoving.add(symbol);
          try {
            for (const legId of ids) {
              const current = this.orders.get(legId);
              if (current && priceOf(current) === price && current.status === 'working') continue; // už na ceně
              // Před KAŽDÝM zápisem: stejné nohy, stejná pozice, žádné nové vyplnění, dost času.
              const again = legsNow();
              const netNow = this.positions.get(symbol)?.netQuantity ?? 0;
              if (!current || TERMINAL.has(current.status) || !again || again.length !== ids.length || !again.every((order) => ids.includes(order.brokerOrderId))
                || netNow !== net0 || this.lastFillAt.get(symbol) !== fillMark) {
                return stop(moved.length ? 'unknown' : false, 'pozice nebo ochrana se během posunu změnila');
              }
              if (moved.length > 0 && this.now() - startedAt > budget) return stop('unknown', 'první noha trvala příliš dlouho');
              // Trh se mezi nohami hýbe: stranu a vzdálenost ověřit znovu z čerstvé ceny, jinak by zápis mohl ochranu hned spustit.
              const fresh = this.config.serverPrice?.(symbol) ?? null;
              const freshBelow = fresh !== null && price < fresh;
              if (fresh === null || (role === 'stop' ? long !== freshBelow : long === freshBelow) || Math.round(Math.abs(price - fresh) / spec.tickSize) < 1) {
                return stop(moved.length ? 'unknown' : false, 'cena trhu se mezitím dostala za novou cenu ochrany');
              }
              try {
                await this.broker.modifyOrder(accountId, legId, { quantity: current.quantity, orderType: role === 'stop' ? 'Stop' : 'Limit', ...(role === 'stop' ? { stopPrice: price } : { limitPrice: price }) });
              } catch (error) {
                const notSent = error instanceof BrokerRequestNotSentError;
                // Po první chybě konec — další zápis po neodeslaném nebo nejistém by šel naslepo.
                return stop(notSent && moved.length === 0 ? false : 'unknown', `noha ${legId}: ${error instanceof Error ? error.message : String(error)}`);
              }
              const deadline = this.now() + (this.config.moveConfirmMs ?? 1_500);
              for (;;) {
                const after = this.orders.get(legId);
                if (after && priceOf(after) === price) break;
                if (this.now() >= deadline) return stop('unknown', `noha ${legId}: posun nebyl potvrzen stavem`);
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              moved.push(legId);
            }
            // Závěrem znovu: všechny původní nohy pracují na nové ceně.
            const final = legsNow();
            if (!final || final.length !== ids.length || !final.every((order) => ids.includes(order.brokerOrderId) && priceOf(order) === price && order.status === 'working')
              || (this.positions.get(symbol)?.netQuantity ?? 0) !== net0 || this.lastFillAt.get(symbol) !== fillMark) {
              return stop('unknown', 'po posunu nohy neodpovídají očekávání');
            }
            return { ok: true, result: { moved, unchanged: ids.length - moved.length } };
          } finally {
            this.legsMoving.delete(symbol);
          }
        }
        case 'cancel': {
          const orderId = typeof command.orderId === 'string' ? command.orderId : '';
          if (!this.orders.has(orderId)) return refuse(`příkaz ${orderId || '?'} neznám`);
          await this.broker.cancelOrder(accountId, orderId);
          return { ok: true, result: { orderId } };
        }
        case 'flatten': {
          const symbol = typeof command.symbol === 'string' ? command.symbol : '';
          if (!this.config.symbols[symbol]) return refuse(`kontrakt ${symbol || '?'} není povolený`);
          const clientId = typeof command.clientId === 'string' ? command.clientId : '';
          if (!CLIENT_ID.test(clientId)) refuse('clientId musí mít 1–30 znaků [A-Za-z0-9_-]');
          const result = await this.broker.liquidatePosition({ tag: `uiflat-${clientId}`, accountId, symbol });
          return { ok: true, result };
        }
        default:
          return refuse('neznámý příkaz');
      }
    } catch (error) {
      const sent = error instanceof BrokerRequestNotSentError ? false : 'unknown';
      return { ok: false, sent, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private planned(order: BrokerOrder, bracket: { stopTicks?: number; targetTicks?: number } | undefined): { plannedStop?: number; plannedTarget?: number } {
    const tick = this.config.symbols[order.symbol]?.tickSize;
    // Limit: od limitní ceny; Stop vstup: od spouště (skutečné vyplnění může být o skluz dál).
    const base = order.stopPrice ?? order.limitPrice;
    if (!bracket || !tick || base === undefined || order.filledQuantity > 0) return {};
    const up = order.side === 'Buy' ? 1 : -1;
    return {
      ...(bracket.stopTicks !== undefined ? { plannedStop: base - up * bracket.stopTicks * tick } : {}),
      ...(bracket.targetTicks !== undefined ? { plannedTarget: base + up * bracket.targetTicks * tick } : {}),
    };
  }

  private isLeg(accountId: number, orderId: string): boolean {
    return this.broker.listBrackets(accountId).some((bracket) => bracket.legs.some((leg) => leg.orderId === orderId));
  }
}
