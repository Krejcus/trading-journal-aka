/**
 * Místní exekuční služba nad Rithmic adaptérem — PROTOTYP pro měření „klik → čára" na
 * testovacím systému. Appka v prohlížeči na tomtéž počítači posílá příkazy a dostává stav
 * (pozice, pracující příkazy, ochrana) hned, jak ho adaptér zná; žádná databáze ani fronta.
 *
 * Záměrně úzké: jeden účet, povolené kontrakty, strop množství, jen demo prostředí. Není to
 * jádro kopírky a s workerem nemá nic společného. Stav pro zobrazení nikdy nic neautorizuje —
 * každý příkaz si adaptér ověřuje sám.
 */
import { BrokerRequestNotSentError, type BrokerEvent, type BrokerFill, type BrokerOrder, type OrderSide } from '../brokerPort';
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
  /** O kolik ticků za trh jde TP při částečném zavření (výchozí 8) a jak dlouho se čeká na zmenšení pozice (výchozí 3 s). */
  reduceThroughTicks?: number;
  reduceConfirmMs?: number;
  /** Poslední cena ze strany služby; reference od klienta se smí lišit nejvýš o `maxReferenceDriftTicks`. */
  serverPrice?: (symbol: string) => number | null;
  /** Nejlepší nabídka a poptávka ze strany služby (pro cenu výstupu při částečném zavření). */
  serverQuote?: (symbol: string) => { bid: number | null; ask: number | null } | null;
  maxReferenceDriftTicks?: number;
  /**
   * Název systému Rithmicu, ke kterému je adaptér přihlášený, a výslovný seznam povolených.
   * `environment === 'demo'` nestačí — na „Rithmic Paper Trading" běží i prop účty.
   */
  systemName: string;
  allowedSystems: readonly string[];
  /**
   * Obchodování na SKUTEČNÉM systému (adaptér není v demo prostředí). Bez tohoto nastavení služba mimo demo
   * odmítne vše. `problem()` se ptá před každým příkazem: bez platného souhlasu nevznikne nová expozice
   * (vstup, přikoupení); zavření, rušení a správa ochrany jdou vždy.
   */
  liveTrading?: { problem: () => string | null; requireStop: boolean };
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
  /** Poslední zavřené obchody spočítané z vyplnění brokera — JEN zobrazení (karta zavření), nic neautorizuje. */
  closes: LocalExecClose[];
}

/** Zavřený obchod: průměry z vyplnění, výsledek v bodech × kusech (bez poplatků). `reason` jen když je jistý. */
export interface LocalExecClose {
  id: string;
  at: number;
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  entryAvg: number;
  exitAvg: number;
  /** Součet (výstup − vstup) × kusy ve směru obchodu, v bodech. */
  pointsTotal: number;
  reason?: 'sl' | 'tp' | 'manual';
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
  /** Částečné zavření: jedna z více ochran pozice se zavře přes vlastní TP posunutý za trh (jeden zápis). */
  | { op: 'reduce'; clientId: string; symbol: string }
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

  /**
   * Skládá obchod z vyplnění, aby karta zavření ukázala výsledek a důvod. Jen zobrazení: nic z toho nevstupuje
   * do kontrol příkazů. Když začátek obchodu služba neviděla (restart s pozicí bez průměrné ceny) nebo se
   * pozice obrátila, výsledek se neuvádí vůbec — raději nic než odhad.
   */
  private onFill(fill: BrokerFill): void {
    if (!(fill.quantity > 0) || !Number.isFinite(fill.price)) return;
    const signed = fill.side === 'Buy' ? fill.quantity : -fill.quantity;
    // (Čas vyplnění z brány se s místními hodinami neporovnává — hodiny se liší; změřeno 17. 11.: karta pak nevznikla
    // vůbec. Chybnou kartu po obnově spojení hlídá potvrzení nulové pozice níže.)
    let trip = this.trips.get(fill.symbol);
    if (!trip) {
      // Pozice známá před prvním viděným vyplněním (běžně 0; po restartu může být otevřená).
      const held = this.positions.get(fill.symbol);
      const net = held?.netQuantity ?? 0;
      const sign = (net !== 0 ? Math.sign(net) : Math.sign(signed)) as 1 | -1;
      const known = net === 0 || held?.averagePrice !== undefined;
      trip = { net, sign, inQty: Math.abs(net), inValue: Math.abs(net) * (held?.averagePrice ?? 0), outQty: 0, outValue: 0, known, seen: new Set() };
      this.trips.set(fill.symbol, trip);
    }
    if (trip.seen.has(fill.fillId)) return;
    if (trip.net === 0) trip.sign = Math.sign(signed) as 1 | -1;
    trip.seen.add(fill.fillId);
    const next = trip.net + signed;
    if (Math.sign(signed) === trip.sign) { trip.inQty += fill.quantity; trip.inValue += fill.quantity * fill.price; }
    else { trip.outQty += fill.quantity; trip.outValue += fill.quantity * fill.price; }
    trip.net = next;
    // Po zavření i obratu si služba drží vlastní stav (ne knihu pozic — zpráva o pozici může být pozadu).
    const flat = { net: 0, sign: 1 as const, inQty: 0, inValue: 0, outQty: 0, outValue: 0, known: true, seen: trip.seen };
    if (next !== 0 && Math.sign(next) !== trip.sign) {
      // Obrat: výsledek původního ani nového obchodu se neuvádí.
      this.trips.set(fill.symbol, { ...flat, net: next, sign: Math.sign(next) as 1 | -1, known: false });
      return;
    }
    if (next !== 0) return;
    this.trips.set(fill.symbol, flat);
    if (!trip.known || trip.inQty !== trip.outQty || trip.inQty === 0) return;
    const entryAvg = trip.inValue / trip.inQty;
    const exitAvg = trip.outValue / trip.outQty;
    const reason = this.exitReasonOf(fill);
    const close: LocalExecClose = {
      id: `${fill.symbol}:${fill.fillId}`, at: this.now(), symbol: fill.symbol, side: trip.sign > 0 ? 'long' : 'short', quantity: trip.inQty,
      entryAvg, exitAvg, pointsTotal: (trip.outValue - trip.inValue) * trip.sign, ...(reason ? { reason } : {}),
    };
    // Výsledek jde ven, až když nulovou pozici potvrdí i zpráva o pozici: buď přišla těsně před tímto vyplněním,
    // nebo přijde vzápětí. Jinak vyplnění nepatřilo k obchodu, jak ho služba složila (např. začátek neviděla).
    const book = this.positions.get(fill.symbol)?.netQuantity ?? 0;
    if (book === 0 && this.now() - (this.lastPositionAt.get(fill.symbol) ?? 0) < 2_000) this.publishClose(close);
    else this.pendingClose.set(fill.symbol, { close, until: this.now() + 5_000 });
  }

  private readonly pendingClose = new Map<string, { close: LocalExecClose; until: number }>();
  private publishClose(close: LocalExecClose): void {
    this.closes.push(close);
    if (this.closes.length > 5) this.closes.shift();
  }

  /** Důvod zavření podle příkazu, který pozici dovřel: noha ochrany = SL/TP, vlastní příkaz = ručně, cizí = neuvádí se. */
  private exitReasonOf(fill: BrokerFill): 'sl' | 'tp' | 'manual' | null {
    const order = this.orders.get(fill.brokerOrderId);
    for (const accountId of this.broker.accountIds()) {
      const leg = this.broker.listBrackets(accountId).flatMap((bracket) => bracket.legs).find((item) => item.orderId === fill.brokerOrderId);
      if (leg) return leg.role === 'stop' ? 'sl' : leg.role === 'target' ? 'tp' : null;
    }
    const tag = fill.tag || order?.tag;
    if (tag?.startsWith(PROTECT_TAG)) return order?.orderType === 'Stop' ? 'sl' : order?.orderType === 'Limit' ? 'tp' : null;
    if (tag?.startsWith('ui')) return 'manual';
    const flat = this.flattenSentAt.get(fill.symbol);
    return flat !== undefined && this.now() - flat < 15_000 ? 'manual' : null;
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
      const waiting = this.pendingClose.get(event.position.symbol);
      if (waiting) {
        this.pendingClose.delete(event.position.symbol);
        if (event.position.netQuantity === 0 && this.now() <= waiting.until) this.publishClose(waiting.close);
      }
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
        this.pendingClose.clear();
        this.trips.clear(); // v mezeře mohla uniknout vyplnění → výsledek by nebyl pravdivý
        for (const order of event.resync.orders) this.orders.set(order.brokerOrderId, order);
        for (const position of event.resync.positions) this.positions.set(position.symbol, { netQuantity: position.netQuantity });
      }
    } else if (event.type === 'fill') this.onFill(event.fill);
    else return;
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
  /** Rozpracovaný obchod složený z vyplnění (jen pro kartu zavření). `known` = vstupní cena je celá podložená. */
  private readonly trips = new Map<string, { net: number; sign: 1 | -1; inQty: number; inValue: number; outQty: number; outValue: number; known: boolean; seen: Set<string> }>();
  private readonly closes: LocalExecClose[] = [];
  /** Kdy služba naposledy poslala zavření kontraktu — vyplnění krátce poté je „ručně" (příkaz zavření nenese značku). */
  private readonly flattenSentAt = new Map<string, number>();
  private readonly lastPositionAt = new Map<string, number>();
  private readonly protectiveMismatchSince = new Map<string, number>();
  private readonly protectiveReported = new Set<string>();
  private protectiveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Stav souhlasu; chyba při zjišťování = souhlas neplatí (nikdy výjimka — ta by zablokovala i zavření). */
  private consentProblem(): string | null {
    if (!this.config.liveTrading) return null;
    try { return this.config.liveTrading.problem(); } catch (error) { return `souhlas nejde ověřit (${error instanceof Error ? error.message : String(error)})`; }
  }

  private isLive(): boolean {
    return this.config.liveTrading !== undefined || this.config.systemName !== 'Rithmic Test' || this.broker.environment !== 'demo';
  }

  private consentEndedReported = false;
  /** Souhlas se skutečným účtem skončil a vlastní vstupy dál čekají: ohlásit (jednou), nic nerušit — rozhoduje člověk. */
  private watchConsent(): void {
    if (!this.config.liveTrading) return;
    if (this.consentProblem() === null) { this.consentEndedReported = false; return; }
    const accountId = this.broker.accountIds()[0];
    const legIds = new Set(accountId === undefined ? [] : this.broker.listBrackets(accountId).flatMap((bracket) => bracket.legs.map((leg) => leg.orderId)));
    const waiting = [...this.orders.values()].filter((order) => !TERMINAL.has(order.status) && order.tag?.startsWith('ui-') === true && !legIds.has(order.brokerOrderId));
    if (waiting.length === 0) { this.consentEndedReported = false; return; }
    if (this.consentEndedReported) return;
    this.consentEndedReported = true;
    this.incidents.push({ kind: 'consent-ended-entries-working', message: `souhlas se skutečným účtem skončil a čeká ${waiting.length} vstup(ů) — zruš je, jinak se mohou vyplnit`, at: this.now() });
    if (this.incidents.length > 20) this.incidents.shift();
  }

  /** Pravidelná kontrola souhlasu (volá server): vypršení se musí ohlásit i na klidném účtu. */
  checkConsent(): void {
    const before = this.incidents.length;
    this.watchConsent();
    if (this.incidents.length !== before) this.changed();
  }

  private watchProtective(): void {
    this.watchConsent();
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
      closes: [...this.closes],
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
      // Skutečný účet = cokoli jiného než Rithmic Test. Prostředí adaptéru nestačí: na „Rithmic Paper Trading"
      // (pro adaptér demo) běží i účty propek.
      const live = this.isLive();
      let consentProblem: string | null = null;
      if (live) {
        if (!this.config.liveTrading) refuse('místní služba je povolená jen pro testovací prostředí');
        consentProblem = this.consentProblem();
        if (consentProblem !== null && command.op === 'entry') refuse(`obchodování na skutečném účtu je vypnuté: ${consentProblem}`);
      }
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
          if (live && this.config.liveTrading!.requireStop && stopPrice === undefined) refuse('na skutečném účtu musí mít každý vstup SL');
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
          // Souhlas se skutečným účtem se ověřuje znovu těsně před zápisem (mezitím mohl vypršet nebo být odvolán).
          const consentNow = (): string | null => { const problem = live ? this.consentProblem() : null; return problem === null ? null : `obchodování na skutečném účtu je vypnuté: ${problem}`; };
          if (stopTicks === undefined && targetTicks === undefined) {
            const late = consentNow();
            if (late) { this.reserved.delete(tag); return refuse(late); }
            const ack = await release(this.broker.placeOrder(request));
            return { ok: true, result: { orderId: ack.brokerOrderId } };
          }
          const ack = await release(this.broker.placeBracket({
            ...request, ...(stopTicks !== undefined ? { stopTicks } : {}), ...(targetTicks !== undefined ? { targetTicks } : {}),
            guard: () => consentNow() ?? (adding ? this.scaleInProblem(accountId, symbol, side, stopPrice, targetPrice, tag) : null),
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
          // Druhá noha k pozici, která už má JEDNU samostatnou ochranu opačného druhu: původní se zruší a obě se
          // zadají znovu jako svázaný pár (OCO) — vyplnění jedné pak druhou zruší burza. Jiný tvar = odmítnout.
          const exitSide: OrderSide = net > 0 ? 'Sell' : 'Buy';
          const lone = working.length === 1 ? working[0] : null;
          const pairWith = lone && lone.tag?.startsWith(PROTECT_TAG) && lone.status === 'working' && lone.side === exitSide
            && lone.filledQuantity === 0 && lone.quantity === quantity && lone.orderType === (kind === 'stop' ? 'Limit' : 'Stop')
            && (kind === 'stop' ? lone.limitPrice : lone.stopPrice) !== undefined ? lone : null;
          if (working.length > 0 && !pairWith) {
            return refuse(working.some((order) => order.tag?.startsWith(PROTECT_TAG) && order.orderType === (kind === 'stop' ? 'Stop' : 'Limit'))
              ? `pozice už ${kind === 'stop' ? 'SL' : 'TP'} má — posuň ho, nepřidávej druhý`
              : 'pozice už má pracující příkazy (SL/TP ze vstupu nebo čekající vstup) — další ochranu nezadávám');
          }
          if ([...this.reserved.values()].some((item) => item.symbol === symbol)) return refuse('na cestě je jiný příkaz tohoto kontraktu — ochranu teď nezadávám');
          // Běžící výměna ochrany (nebo posun noh) má knihu na okamžik prázdnou — další ochrana by byla třetí, nesvázaný výstup.
          if (this.legsMoving.has(symbol)) return refuse('změna ochrany na tomto kontraktu právě běží — počkej na výsledek');
          // Poslední změna ochrany skončila nejistě (na burze může pracovat pár, o kterém služba neví) → další ochrana by
          // mohla být třetí, nesvázaný výstup. Nejdřív ověřit stav a potvrdit incident.
          if (this.legsUncertain.has(symbol)) return refuse('poslední změna ochrany skončila nejistě — ověř u brokera, co na pozici pracuje, a potvrď incident');
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
          if (pairWith) {
            // Zrušená stará noha s částečným plněním by dala pár na víc kusů, než pozice má → zatím jen 1 kontrakt
            // (ten se částečně nevyplní).
            if (quantity !== 1) return refuse('druhou ochranu k pozici jde zatím přidat jen u 1 kontraktu');
            const stopPrice = kind === 'stop' ? price : pairWith.stopPrice!;
            const targetPrice = kind === 'target' ? price : pairWith.limitPrice!;
            // Obě ceny musí dávat smysl i spolu a stávající noha musí být pořád na své straně trhu (jinak by se
            // nový pár spustil hned).
            if (long ? !(stopPrice < server && server < targetPrice) : !(targetPrice < server && server < stopPrice)) return refuse('SL a TP musí ležet na opačných stranách trhu — stávající ochrana je už u ceny');
            if (this.legsUncertain.has(symbol) || this.legsMoving.has(symbol)) return refuse('změna ochrany na tomto kontraktu právě běží nebo skončila nejistě — ověř stav a potvrď incident');
            this.seenClientIds.add(clientId);
            this.legsMoving.add(symbol);
            // Rezervace kontraktu po celou výměnu: vstup, přikoupení ani jiná ochrana mezitím neprojdou.
            this.reserved.set(tag, { symbol, quantity: 0 });
            const fail = (kindOf: string, message: string): LocalExecResult => {
              // Od zrušení původní ochrany je každý nedokončený krok stav, který musí vidět a potvrdit člověk.
              this.incidents.push({ kind: kindOf, message, at: this.now() });
              if (this.incidents.length > 30) this.incidents.shift();
              this.blocked = `${kindOf}: ${message}`.slice(0, 240);
              this.legsUncertain.add(symbol);
              this.changed();
              return { ok: false, sent: 'unknown', error: message };
            };
            try {
              // 1) Zrušit původní nohu a POČKAT na potvrzení stavem. Bez potvrzení se pár nezadává (hrozily by dvě ochrany).
              try {
                await this.broker.cancelOrder(accountId, pairWith.brokerOrderId);
              } catch (error) {
                // Prokazatelně neodesláno = nic se nezměnilo. Cokoli jiného: stará ochrana mohla zmizet → incident.
                if (error instanceof BrokerRequestNotSentError) throw error;
                return fail('protect-replace-uncertain', `zrušení původního ${kind === 'stop' ? 'TP' : 'SL'} skončilo nejistě (${error instanceof Error ? error.message : String(error)}) — nový pár nezadávám; ověř u brokera, jakou ochranu pozice má`);
              }
              const deadline = this.now() + (this.config.moveConfirmMs ?? 1_500);
              for (;;) {
                const old = this.orders.get(pairWith.brokerOrderId);
                if (old && TERMINAL.has(old.status)) {
                  if (old.status !== 'canceled' || old.filledQuantity > 0) return fail('protect-replace-interrupted', `původní ${kind === 'stop' ? 'TP' : 'SL'} se mezitím vyplnil — druhou ochranu nezadávám, zkontroluj pozici`);
                  break;
                }
                if (this.now() >= deadline) return fail('protect-replace-uncertain', `zrušení původního ${kind === 'stop' ? 'TP' : 'SL'} není potvrzené — nový pár nezadávám; ověř u brokera, jakou ochranu pozice má`);
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
              // 2) Stav se během čekání nesměl změnit: stejná pozice, žádný jiný příkaz, cena pořád mezi SL a TP.
              const netNow = this.positions.get(symbol)?.netQuantity ?? 0;
              const others = [...this.orders.values()].filter((order) => order.symbol === symbol && !TERMINAL.has(order.status));
              const fresh = this.config.serverPrice?.(symbol) ?? null;
              const elsewhere = [...this.reserved].some(([reservedTag, item]) => item.symbol === symbol && reservedTag !== tag);
              const stillOk = netNow === net && others.length === 0 && !elsewhere && fresh !== null && (long ? stopPrice < fresh && fresh < targetPrice : targetPrice < fresh && fresh < stopPrice);
              if (!stillOk) return fail('protection-removed', `původní ochrana je zrušená a nový pár SL+TP neodešel (stav se mezitím změnil) — pozice ${netNow === 0 ? 'je zavřená' : 'je BEZ ochrany: přidej SL nebo ji zavři'}`);
              // 3) Jeden zápis: svázaný pár. Neodeslaný i nejistý výsledek = pozice může být bez ochrany → incident, nic se neopakuje.
              const stopTag = `${PROTECT_TAG}${clientId.slice(0, 26)}-s`;
              const targetTag = `${PROTECT_TAG}${clientId.slice(0, 26)}-t`;
              let pair;
              try {
                pair = await this.broker.placeExitPair({ accountId, symbol, side: exitSide, quantity, stop: { tag: stopTag, stopPrice }, target: { tag: targetTag, limitPrice: targetPrice } });
              } catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                return fail('protection-removed', error instanceof BrokerRequestNotSentError
                  ? `původní ochrana je zrušená a nový pár SL+TP neodešel (${text}) — pozice je BEZ ochrany: přidej SL nebo ji zavři`
                  : `původní ochrana je zrušená a výsledek nového páru SL+TP není znám (${text}) — ověř u brokera, jakou ochranu pozice má`);
              }
              // 4) Úspěch až podle stavu: obě nohy pracují.
              const confirmBy = this.now() + (this.config.moveConfirmMs ?? 1_500);
              for (;;) {
                // Role se berou podle ZNAČEK a typu v knize, ne podle pořadí ID v odpovědi (to burza nezaručuje).
                const byTag = (wanted: string) => [...this.orders.values()].find((order) => order.tag === wanted && [pair.stopOrderId, pair.targetOrderId].includes(order.brokerOrderId));
                const stop = byTag(stopTag);
                const target = byTag(targetTag);
                if (stop?.status === 'working' && target?.status === 'working') {
                  if (stop.orderType !== 'Stop' || target.orderType !== 'Limit' || stop.stopPrice !== stopPrice || target.limitPrice !== targetPrice || stop.quantity !== quantity || target.quantity !== quantity) {
                    return fail('protect-replace-uncertain', 'nový pár SL+TP má jiný tvar, než byl zadán — ověř u brokera ceny a typy obou příkazů');
                  }
                  return { ok: true, result: { orderId: kind === 'stop' ? stop.brokerOrderId : target.brokerOrderId, quantity, paired: true } };
                }
                if ((stop && TERMINAL.has(stop.status)) || (target && TERMINAL.has(target.status))) return fail('protection-removed', 'nový pár SL+TP burza nepřijala (nebo se hned spustil) — zkontroluj pozici a její ochranu');
                if (this.now() >= confirmBy) return fail('protect-replace-uncertain', 'nový pár SL+TP není potvrzený stavem — ověř u brokera, jakou ochranu pozice má');
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
            } finally {
              this.legsMoving.delete(symbol);
              this.reserved.delete(tag);
            }
          }
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
          } else if (consentProblem !== null && !order.tag?.startsWith(PROTECT_TAG)) {
            // Bez platného souhlasu se čekající vstup nesmí přitáhnout k trhu (vyplnění by byl nový obchod). Zrušit jde vždy.
            return refuse(`obchodování na skutečném účtu je vypnuté: ${consentProblem} — čekající vstup jde jen zrušit`);
          } else if (order.tag?.startsWith('ui-') && (order.limitPrice !== undefined || order.stopPrice !== undefined)
            && (this.broker.listBrackets(accountId).some((bracket) => bracket.entryId === orderId) || order.orderType === 'Stop')) {
            // Čekající vlastní vstup s ochranou (Limit i Stop) a vlastní holý Stop: mění se jen jeho cena.
            // SL/TP jsou vzdálenosti od vyplnění, posunou se s ním.
            const stopEntry = order.stopPrice !== undefined;
            // Typ se nemění: Stop má jen spoušť, Limit jen limitní cenu. Cokoli jiného (např. Stop Limit po zásahu jinde) neposouvám.
            const bracketed = this.broker.listBrackets(accountId).some((bracket) => bracket.entryId === orderId);
            // (Vstup s ochranou má v knize typ „bracket"; holý vstup svůj skutečný typ.)
            if ((order.stopPrice !== undefined && order.limitPrice !== undefined) || order.orderType !== (bracketed ? 'Unsupported' : stopEntry ? 'Stop' : 'Limit')) {
              return refuse('vstup má jiný typ, než s jakým vznikl — neposouvám ho (zruš ho a zadej znovu)');
            }
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
            if (this.legsMoving.has(order.symbol)) return refuse('změna ochrany na tomto kontraktu právě běží — počkej na výsledek');
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
          const target = this.orders.get(orderId);
          if (!target) return refuse(`příkaz ${orderId || '?'} neznám`);
          // Jen vlastní příkazy (vstup `ui-`, samostatná ochrana `uiprot-`). Příkaz zadaný jinde služba neruší —
          // to, že ho graf jen zobrazuje, je pojistka obrazovky, ne služby. Brzda (`flatten`) ruší na kontraktu vše.
          if (!target.tag?.startsWith('ui')) return refuse('rušit jde jen příkaz zadaný z této appky — cizí příkaz zruš tam, kde vznikl (nebo zavři pozici)');
          // Svázaný pár SL+TP: zrušení jedné nohy zruší na burze OBĚ → u otevřené pozice by zmizela celá ochrana.
          // Rozhoduje značka nohy páru (`-s` / `-t`), ne to, jestli služba sestru zrovna vidí (zpráva o ní může být pozadu).
          if (target.tag.startsWith(PROTECT_TAG) && (this.positions.get(target.symbol)?.netQuantity ?? 0) !== 0
            && (/-[st]$/.test(target.tag) || [...this.orders.values()].some((order) => order !== target && order.symbol === target.symbol && !TERMINAL.has(order.status) && order.tag?.startsWith(PROTECT_TAG)))) {
            return refuse('SL a TP jsou svázané — zrušením jednoho by zmizely oba; posuň je, nebo zavři pozici');
          }
          await this.broker.cancelOrder(accountId, orderId);
          return { ok: true, result: { orderId } };
        }
        case 'flatten': {
          const symbol = typeof command.symbol === 'string' ? command.symbol : '';
          if (!this.config.symbols[symbol]) return refuse(`kontrakt ${symbol || '?'} není povolený`);
          const clientId = typeof command.clientId === 'string' ? command.clientId : '';
          if (!CLIENT_ID.test(clientId)) refuse('clientId musí mít 1–30 znaků [A-Za-z0-9_-]');
          this.flattenSentAt.set(symbol, this.now());
          let result;
          try { result = await this.broker.liquidatePosition({ tag: `uiflat-${clientId}`, accountId, symbol }); } catch (error) {
            // Zavření prokazatelně neodešlo → pozdější vyplnění se mu nepřipíše jako „ručně".
            if (error instanceof BrokerRequestNotSentError) this.flattenSentAt.delete(symbol);
            throw error;
          }
          if ((result as { status?: string }).status === 'rejected') this.flattenSentAt.delete(symbol);
          return { ok: true, result };
        }
        case 'reduce': {
          const symbol = typeof command.symbol === 'string' ? command.symbol : '';
          const spec = this.config.symbols[symbol];
          if (!spec) return refuse(`kontrakt ${symbol || '?'} není povolený`);
          const reduceId = typeof command.clientId === 'string' ? command.clientId : '';
          if (!CLIENT_ID.test(reduceId)) refuse('clientId musí mít 1–30 znaků [A-Za-z0-9_-]');
          // Stejná zpráva podruhé (opakované doručení) nesmí zavřít další část.
          if (this.seenClientIds.has(`reduce:${reduceId}`)) refuse('příkaz s tímto clientId už byl přijat');
          const net0 = this.positions.get(symbol)?.netQuantity ?? 0;
          if (Math.abs(net0) < 2) return refuse('částečně zavřít jde jen pozici s aspoň 2 kontrakty');
          if (this.legsUncertain.has(symbol) || this.legsMoving.has(symbol)) return refuse('posun SL/TP na tomto kontraktu právě běží nebo skončil nejistě — ověř ceny u brokera a potvrď incident');
          if ([...this.reserved.values()].some((item) => item.symbol === symbol)) return refuse('na cestě je jiný příkaz tohoto kontraktu');
          this.fillsAhead = this.fillsAhead.filter((fill) => this.now() - fill.at < 5_000);
          const filledAt = this.lastFillAt.get(symbol);
          if (this.fillsAhead.some((fill) => fill.symbol === symbol)
            || (filledAt !== undefined && ((this.lastPositionAt.get(symbol) ?? 0) < filledAt || this.now() - filledAt < (this.config.positionSettleMs ?? 1_000)))) {
            return refuse('pozice se právě mění (čerstvé vyplnění) — zkus to za okamžik');
          }
          if (this.broker.unresolvedBracketTags(accountId, symbol).length > 0) return refuse('jiný vstup s ochranou ještě není potvrzený');
          const legs = this.legsOf(accountId, symbol);
          if (!legs) return refuse('na kontraktu pracuje příkaz, který služba nezná — částečné zavření nejde');
          const exitSide: OrderSide = net0 > 0 ? 'Sell' : 'Buy';
          // Každá ochrana: stav „chráněno", právě jeden pracující SL a TP na výstupní straně se shodným zbývajícím množstvím.
          const parts: Array<{ entryId: string; stop: BrokerOrder; target: BrokerOrder; quantity: number }> = [];
          for (const bracket of this.broker.listBrackets(accountId).filter((item) => item.symbol === symbol && !item.closed)) {
            const state = this.broker.bracketState(accountId, bracket.entryId).state;
            if (state === 'done') continue;
            if (state !== 'protected') return refuse(state === 'entry-working' ? 'čeká jiný vstup — částečné zavření teď nejde' : 'ochrana pozice není úplná — částečné zavření nejde');
            const working = (role: 'stop' | 'target') => bracket.legs.filter((leg) => leg.role === role).map((leg) => this.orders.get(leg.orderId))
              .filter((order): order is BrokerOrder => order !== undefined && !TERMINAL.has(order.status));
            const stops = working('stop');
            const targets = working('target');
            if (stops.length !== 1 || targets.length !== 1) return refuse('částečně zavřít jde jen pozici, kde má každý vstup SL i TP');
            const [stop] = stops;
            const [target] = targets;
            const left = target.quantity - target.filledQuantity;
            if (stop.status !== 'working' || target.status !== 'working' || stop.side !== exitSide || target.side !== exitSide
              || stop.filledQuantity !== 0 || target.filledQuantity !== 0 || left !== stop.quantity - stop.filledQuantity || left < 1
              || stop.stopPrice === undefined || target.limitPrice === undefined) {
              return refuse('ochrana pozice není v očekávaném tvaru — částečné zavření nejde');
            }
            parts.push({ entryId: bracket.entryId, stop, target, quantity: left });
          }
          if (parts.length < 2) return refuse('pozice má jen jednu ochranu — částečně zavřít nejde, jen celou');
          if (parts.reduce((sum, part) => sum + part.quantity, 0) !== Math.abs(net0) || legs.stops.length !== parts.length || legs.targets.length !== parts.length) {
            return refuse('SL/TP nekryjí přesně celou pozici — částečné zavření nejde');
          }
          const server = this.config.serverPrice?.(symbol) ?? null;
          if (server === null) return refuse('služba nemá čerstvou cenu — částečné zavření neodesílám');
          // Zavře se ochrana s MÉNĚ ochranným SL (dál od trhu); při shodě ta novější. Zbytek tak nese menší riziko.
          const long = net0 > 0;
          const chosen = [...parts].sort((a, b) => (long ? a.stop.stopPrice! - b.stop.stopPrice! : b.stop.stopPrice! - a.stop.stopPrice!) || (a.entryId < b.entryId ? 1 : -1))[0];
          const through = (this.config.reduceThroughTicks ?? 8) * spec.tickSize;
          // Výstup se počítá od strany knihy, do které jde (prodej od nabídky kupců, nákup od nabídky prodejců) —
          // poslední obchod může ležet jinde (změřeno 17. 11.: od posledního obchodu se na pomalém trhu nevyplnil hned).
          // Kotace dál než 40 ticků od ceny služby se nebere (stará).
          const quote = this.config.serverQuote?.(symbol) ?? null;
          const side = long ? quote?.bid : quote?.ask;
          // Bez čerstvé kotace se nezkouší naslepo: výstup by mohl zůstat viset (TP blíž trhu, výsledek neznámý).
          if (typeof side !== 'number' || !Number.isFinite(side) || Math.abs(side - server) > 40 * spec.tickSize) return refuse('služba nemá čerstvou nabídku a poptávku — částečné zavření neodesílám (jde zavřít celou pozici)');
          const base = long ? Math.min(side, server) : Math.max(side, server);
          const price = Math.round((long ? base - through : base + through) / spec.tickSize) * spec.tickSize;
          if (!(price > 0) || !this.onGrid(price, spec.tickSize)) return refuse('cenu výstupu nejde spočítat');
          // SL té ochrany nesmí být už za touto cenou (trh je u SL) — pak ať rozhodne SL nebo celé zavření.
          if (long ? price <= chosen.stop.stopPrice! : price >= chosen.stop.stopPrice!) return refuse('trh je příliš blízko SL — částečné zavření neodesílám');
          this.seenClientIds.add(`reduce:${reduceId}`);
          this.legsMoving.add(symbol);
          try {
            await this.broker.modifyOrder(accountId, chosen.target.brokerOrderId, { quantity: chosen.target.quantity, orderType: 'Limit', limitPrice: price });
            const deadline = this.now() + (this.config.reduceConfirmMs ?? 3_000);
            for (;;) {
              const net = this.positions.get(symbol)?.netQuantity ?? 0;
              // Úspěch = vyplnil se PRÁVĚ tento výstup a pozice tomu odpovídá. Samotný pokles pozice nestačí —
              // mohl ho způsobit SL jiné části, zatímco tento výstup dál pracuje u trhu.
              const exit = this.orders.get(chosen.target.brokerOrderId);
              if (exit?.status === 'filled' && Math.sign(net) === Math.sign(net0) && Math.abs(net) === Math.abs(net0) - chosen.quantity) {
                return { ok: true, result: { orderId: chosen.target.brokerOrderId, quantity: chosen.quantity, price } };
              }
              if (this.now() >= deadline) {
                // Nic se neopakuje ani nevrací zpět. Buď výstup ještě pracuje u trhu, nebo se pozice změnila jinak
                // (SL, ruční zásah) — obojí musí vidět a posoudit obsluha.
                const order = this.orders.get(chosen.target.brokerOrderId);
                const working = order !== undefined && !TERMINAL.has(order.status);
                // Nejistý krok nad ochranou → další posuny noh a přikoupení stojí do potvrzení obsluhou
                // (stejné pravidlo jako u posunu více noh). Zavření pozice jde vždy.
                this.legsUncertain.add(symbol);
                this.changed();
                return { ok: false, sent: 'unknown', error: working && net === net0
                  ? 'výstup je u trhu, ale ještě se nevyplnil — sleduj pozici (TP té části je teď blíž trhu)'
                  : 'pozice se změnila jinak, než odpovídá částečnému zavření — ověř stav' };
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          } finally {
            this.legsMoving.delete(symbol);
          }
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
