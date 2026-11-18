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
  quantityLimits?: () => import('./rithmicQuantityLimits').RithmicQuantityLimits | null;
  /**
   * Čekající přikoupení Limitem (se samočinným zrušením po zavření pozice). Výchozí VYPNUTO: funkce má otevřené
   * nálezy z oponentury 17. 11. 2026 (výpadek během zavření, posun SL během čekání, částečné plnění přikoupení),
   * proto ji spouštěč zapíná jen na Rithmic Test.
   */
  pendingAdd?: boolean;
  /** Dělení jednoho vstupu s víc kusy (zmenšit ochranu → zavřít 1 ks). Zapíná jen spouštěč (zatím Rithmic Test). */
  entrySplit?: boolean;
  /** Výměna jedné nohy za pár SL+TP u víc kusů (zrušit → zadat pár). Pozdní dílčí vyplnění rušené nohy nejde
   *  z dat Rithmicu vyloučit, proto jen tam, kde to spouštěč výslovně zapne (Rithmic Test). */
  multiPairSwap?: boolean;
  /** Strop velikosti pozice včetně čekajících vstupů (výchozí = `maxQuantity`). */
  maxPosition?: number;
  /** Nejvyšší vzdálenost SL/TP od vstupu v tickách (výchozí 400). */
  maxProtectionTicks?: number;
  /** Jak dlouho po vyplnění se čeká na usazení pozice, než jde zadat ochrana (výchozí 1 s). */
  positionSettleMs?: number;
  /** Jak dlouho musí nesoulad samostatné ochrany s pozicí vydržet, než se ohlásí (výchozí 3 s). */
  protectiveGraceMs?: number;
  /**
   * Kolik částí s vlastní ochranou smí pozice mít (první vstup + přikoupení). Výchozí 2. Každá část je vlastní vstup
   * s ochranou na své množství, takže posun SL nebo TP znamená tolik zápisů po sobě, kolik je částí — během nich
   * má ochrana krátce dvě ceny a selhání uprostřed je incident. Vyšší strop zapíná spouštěč (zatím jen Rithmic Test).
   */
  maxProtectedParts?: number;
  /**
   * Přikoupení Marketem BEZ SL/TP do pozice, která žádnou ochranu ani příkaz nemá. Výchozí VYPNUTO; zapíná spouštěč
   * (zatím jen Rithmic Test — proti brokerovi neověřeno).
   */
  bareAdd?: boolean;
  /** O kolik ticků se smí lišit SL (a TP) mezi částmi pozice, aby šlo dál přikupovat (výchozí 8) — skluz při vyplnění. */
  scaleInSpreadTicks?: number;
  /** Celková mez posunu více noh (výchozí 10 s — pod lhůtou odpovědi appky); po ní se zbytek neposílá. */
  moveLegsTotalMs?: number;
  /** Posun více noh: další se pošle jen když předchozí noha stihla tento čas (výchozí 2 s). */
  moveLegsBudgetMs?: number;
  /** Jak dlouho čekat na potvrzení posunu vstupu s ochranou stavem (výchozí 1,5 s). */
  moveConfirmMs?: number;
  /** O kolik ticků za trh jde TP při částečném zavření (výchozí 8) a jak dlouho se čeká na zmenšení pozice (výchozí 3 s). */
  reduceThroughTicks?: number;
  reduceConfirmMs?: number;
  /** Nejdelší čekání brzdy na rozdělané částečné zavření (výchozí 2,5 s). */
  splitWaitMs?: number;
  /** Jak dlouho po nejistém výstupu dělení brzda čeká, než ho kniha pozná (výchozí 12 s). */
  splitUnknownMs?: number;
  /** Čekání po zrušení vícekusového příkazu, než se smí brát jako nevyplněný (výchozí 400 ms). */
  cancelSettleMs?: number;
  /** Poslední cena ze strany služby; reference od klienta se smí lišit nejvýš o `maxReferenceDriftTicks`. */
  serverPrice?: (symbol: string) => number | null;
  /** Nejlepší nabídka a poptávka ze strany služby (pro cenu výstupu při částečném zavření). */
  serverQuote?: (symbol: string) => { bid: number | null; ask: number | null } | null;
  /**
   * Trvalá značka „výměna ochrany běží" (soubor). Zapisuje se PŘED zrušením staré nohy a maže po potvrzeném páru
   * nebo po potvrzení obsluhou. Když služba spadne uprostřed výměny, po startu podle ní ohlásí incident — bez ní by
   * pozice zůstala bez ochrany potichu (holá pozice je jinak povolený stav).
   */
  replaceMarker?: { read: () => { symbol: string; at: number; resize?: { entryId: string; exitTag: string; expectNet: number } } | null; write: (value: { symbol: string; at: number; resize?: { entryId: string; exitTag: string; expectNet: number } } | null) => void };
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
  closeStore?: {
    load(account: string): { pending: LocalExecClose[]; closed: LocalExecClose[] } | null;
    save(account: string, state: { pending: LocalExecClose[]; closed: LocalExecClose[] }): void;
  };
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
  /** Strop částí pozice s vlastní ochranou — jen aby appka uměla říct předem, proč už přikoupit nejde. */
  maxParts: number;
  /** Smí se přikoupit Marketem bez SL/TP do pozice bez ochrany? Jen pro nabídku v appce. */
  bareAdd: boolean;
  /** Poslední zavřené obchody spočítané z vyplnění brokera — JEN zobrazení (karta zavření), nic neautorizuje. */
  closes: LocalExecClose[];
  /** Vyplnění posledního (nebo právě otevřeného) obchodu pro šipky vstupu a výstupu v grafu — JEN zobrazení. */
  marks: Array<{ symbol: string; open: boolean; fills: LocalExecFillMark[] }>;
}

export interface LocalExecFillMark { id: string; orderId: string; at: number; price: number; side: OrderSide; role: 'entry' | 'exit'; quantity: number }

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
  | { op: 'entry'; clientId: string; symbol: string; side: OrderSide; quantity: number; orderType: 'Market' | 'Limit' | 'Stop'; limitPrice?: number; triggerPrice?: number; stopPrice?: number; targetPrice?: number; referencePrice?: number; expectedPosition?: string }
  /** Samostatná ochrana otevřené pozice: BUĎ SL, NEBO TP — nikdy obojí (dva nesvázané výstupy by po vyplnění jednoho nechaly druhý pracovat). */
  | { op: 'protect'; clientId: string; symbol: string; kind: 'stop' | 'target'; price: number }
  /**
   * Změna ČEKAJÍCÍHO vlastního vstupu tak, aby SL/TP zůstaly na svých cenách: vstup se zruší a zadá znovu
   * (nová cena vstupu a/nebo nová cena SL/TP). Rithmic vzdálenosti SL/TP u čekajícího vstupu měnit neumí (změřeno).
   */
  | { op: 'replace-entry'; clientId: string; orderId: string; price?: number; stopPrice?: number; targetPrice?: number }
  /** SL i TP k pozici BEZ příkazů jedním zápisem jako svázaný pár (OCO) na celé množství pozice. */
  | { op: 'protect-pair'; clientId: string; symbol: string; stopPrice: number; targetPrice: number }
  | { op: 'move'; orderId: string; price: number }
  /** Posune VŠECHNY pracující nohy jedné role (pozice s víc ochranami) na jednu cenu; `expect` = nohy a ceny, které appka znala při odeslání (služba ověří, že se od té chvíle nezměnily — ne to, co uživatel viděl při kliku). */
  | { op: 'move-legs'; symbol: string; role: 'stop' | 'target'; price: number; expect: Array<{ orderId: string; price: number }> }
  | { op: 'cancel'; orderId: string }
  | { op: 'flatten'; clientId: string; symbol: string }
  /** Částečné zavření: jedna z více ochran pozice se zavře přes vlastní TP posunutý za trh (jeden zápis). */
  | { op: 'reduce'; clientId: string; symbol: string; expectedEntryId?: string; expectedQuantity?: number; expectedPosition?: string }
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
/**
 * Čekající přikoupení Limitem (vstup do UŽ otevřené pozice). Značka je trvalá vazba na pozici: když se pozice
 * zavře, služba takový příkaz SAMA zruší (rozhodnutí Filipa 17. 11. 2026: „ano, ať se zruší po zavření") —
 * jinak by se později vyplnil a otevřel obchod, který nikdo nezamýšlel.
 */
export const ADD_TAG = 'ui-add-';
export const ADD_CLIENT_PREFIX = 'add-';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Značka vlastního VSTUPU. Výstup dělení vstupu (`ui-red-`) vstup není: nepočítá se do rezervy ani mezi čekající vstupy. */
const isEntryTag = (order: { tag?: string; orderType?: string }): boolean => order.tag?.startsWith('ui-') === true && !(order.tag.startsWith('ui-red-') && order.orderType === 'Market');

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
  private readonly reserved = new Map<string, { symbol: string; quantity: number; bareMarket?: boolean }>();
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
      const after = this.broker.executionNet(fill.accountId, fill.symbol);
      const net = after === null ? 0 : after - signed;
      const sign = (net !== 0 ? Math.sign(net) : Math.sign(signed)) as 1 | -1;
      const known = after !== null && (net === 0 || (held?.netQuantity === net && held.averagePrice !== undefined));
      trip = { net, sign, inQty: Math.abs(net), inValue: Math.abs(net) * (held?.averagePrice ?? 0), outQty: 0, outValue: 0, known, seen: new Set() };
      this.trips.set(fill.symbol, trip);
    }
    if (trip.seen.has(fill.fillId)) return;
    if (trip.net === 0) trip.sign = Math.sign(signed) as 1 | -1;
    trip.seen.add(fill.fillId);
    // Šipky v grafu: nový obchod (z nuly) smaže šipky předchozího; vyplnění ve směru obchodu = vstup, proti = výstup.
    if (trip.net === 0) this.marks.set(fill.symbol, { open: true, fills: [] });
    const mark = this.marks.get(fill.symbol) ?? { open: true, fills: [] };
    mark.fills.push({ id: fill.fillId, orderId: fill.brokerOrderId, at: fill.filledAt, price: fill.price, side: fill.side, role: Math.sign(signed) === trip.sign ? 'entry' : 'exit', quantity: fill.quantity });
    if (mark.fills.length > 60) mark.fills.shift();
    mark.open = trip.net + signed !== 0;
    this.marks.set(fill.symbol, mark);
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
    else this.pendingClose.set(fill.symbol, [...(this.pendingClose.get(fill.symbol) ?? []), close]);
    this.saveCloses();
  }

  private loadedCloseAccount: string | null = null;
  private saveCloses(): void {
    if (!this.loadedCloseAccount || !this.config.closeStore) return;
    try {
      this.config.closeStore.save(this.loadedCloseAccount, { closed: this.closes, pending: [...this.pendingClose.values()].flat() });
    } catch { this.onIncident({ kind: 'attention', at: this.now(), message: 'Výsledky obchodů se nepodařilo uložit na disk.' }); }
  }
  private readonly pendingClose = new Map<string, LocalExecClose[]>();
  private publishClose(close: LocalExecClose): void {
    if (this.closes.some(item => item.id === close.id)) return;
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
    if (tag?.startsWith('ui-') || tag?.startsWith('uiflat-')) return 'manual';
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
      if (grew > 0 && isEntryTag(event.order)) this.fillsAhead.push({ symbol: event.order.symbol, quantity: grew, at: this.now() });
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
      if (waiting && event.position.netQuantity === 0) {
        this.pendingClose.delete(event.position.symbol);
        for (const close of waiting) this.publishClose(close);
        this.saveCloses();
      }
      const known = this.positions.get(event.position.symbol);
      this.positions.set(event.position.symbol, {
        netQuantity: event.position.netQuantity,
        ...(event.displayAveragePrice !== undefined ? { averagePrice: event.displayAveragePrice } : {}),
      });
      // Na živém trhu chodí stejná zpráva o pozici mnohokrát za sekundu (průběžný výsledek). Když se nic nezměnilo,
      // stav se znovu neposílá a hlídače neběží (jejich časovače běží dál samy).
      if (known && known.netQuantity === event.position.netQuantity && known.averagePrice === event.displayAveragePrice && waiting === undefined) return;
    } else if (event.type === 'connection') {
      this.connected = event.connected;
      if (event.connected && event.resync) {
        // Služba minule skončila uprostřed výměny ochrany: ohlásit (jednou), nic nezadávat — rozhoduje člověk.
        if (!this.markerChecked) {
          this.markerChecked = true;
          let pending: { symbol: string; at: number; resize?: { entryId: string; exitTag: string; expectNet: number } } | null = null;
          try { pending = this.config.replaceMarker?.read() ?? null; } catch { pending = null; }
          if (pending) {
            const message = `služba skončila uprostřed výměny ochrany na ${pending.symbol} — pozice může být BEZ ochrany nebo s jinou, než čekáš; ověř u brokera, pak potvrď`;
            this.incidents.push({ kind: 'protect-replace-interrupted', message, at: this.now() });
            this.blocked = `protect-replace-interrupted: ${message}`.slice(0, 240);
            this.legsUncertain.add(pending.symbol);
            // Přerušené dělení vstupu: výstup se dohledá v knize a záznam ochrany se dopíše (nic se neodesílá).
            if (pending.resize) this.pendingResize.set(pending.symbol, { ...pending.resize, at: this.now() });
          }
        }
        // Výchozí stav po (znovu)připojení je nová pravda — staré záznamy pryč.
        this.orders.clear();
        this.positions.clear();
        this.fillsAhead = [];
        const name = this.broker.accountName(this.broker.accountIds()[0]);
        if (name && name !== this.loadedCloseAccount) {
          this.loadedCloseAccount = name;
          this.pendingClose.clear();
          this.closes.length = 0;
          try {
            const saved = this.config.closeStore?.load(name);
            for (const close of saved?.closed ?? []) this.publishClose(close);
            for (const close of saved?.pending ?? []) this.pendingClose.set(close.symbol, [...(this.pendingClose.get(close.symbol) ?? []), close]);
          } catch { this.onIncident({ kind: 'attention', at: this.now(), message: 'Uložené výsledky obchodů se nepodařilo načíst.' }); }
        }
        for (const [symbol, closes] of this.pendingClose) {
          if (!event.resync.positions.some(position => position.symbol === symbol && position.netQuantity !== 0)) {
            for (const close of closes) this.publishClose(close);
            this.pendingClose.delete(symbol);
            this.saveCloses();
          }
        }
        this.trips.clear(); // v mezeře mohla uniknout vyplnění → výsledek by nebyl pravdivý
        for (const order of event.resync.orders) this.orders.set(order.brokerOrderId, order);
        for (const position of event.resync.positions) {
          // Průměrná cena ze snímku jen pro zobrazení čáry pozice (živá zpráva o pozici může na klidném trhu chybět).
          const average = position.netQuantity !== 0 ? this.broker.snapshotAveragePrice(position.accountId, position.symbol) : null;
          this.positions.set(position.symbol, { netQuantity: position.netQuantity, ...(average !== null ? { averagePrice: average } : {}) });
        }
        // Šipky v grafu: v mezeře se obchod mohl zavřít — staré šipky by tvrdily, že je otevřený.
        this.marks.clear();
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
  private readonly marks = new Map<string, { open: boolean; fills: LocalExecFillMark[] }>();
  /** Kolikrát služba poslala zavření kontraktu — výměna vstupu si číslo pamatuje a po brzdě nepokračuje. */
  private readonly flattenCount = new Map<string, number>();
  private consentWatchAt = 0;
  /** ID vstupu, pro který právě běží zkouška nanečisto (jen synchronní úsek `execute`, nikdy přes `await`). */
  private replaceDryRun: string | null = null;
  private markerChecked = false;
  private setReplaceMarker(value: { symbol: string; at: number; resize?: { entryId: string; exitTag: string; expectNet: number } } | null): boolean {
    try { this.config.replaceMarker?.write(value); return true; } catch { return false; }
  }
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

  /**
   * Autoritativní čtení zrušeného příkazu: null = zrušen s nulovým plněním; jinak důvod, proč to doložit nejde.
   * Čtení navíc (jen u víc kusů) — zpráva o zrušení sama pozdní dílčí vyplnění nevylučuje.
   */
  private async canceledUnfilled(accountId: number, orderId: string): Promise<string | null> {
    try {
      const lookup = await this.broker.findOrderById(accountId, orderId);
      if (lookup.completeness !== 'authoritative' || !lookup.order) return 'jeho konečný stav nejde ověřit';
      if (lookup.order.status !== 'canceled') return `jeho stav je ${lookup.order.status}`;
      if (lookup.order.filledQuantity !== 0) return `vyplnilo se z něj ${lookup.order.filledQuantity} ks`;
      // Snímek nemusí nést vyplněné množství a zpráva o vyplnění může dorazit až po zrušení: chvíli počkat
      // a ověřit znovu knihu, čerstvá vyplnění a shodu pozice s vyplněními. (Zmírnění, ne důkaz — viz runbook.)
      const symbol = lookup.order.symbol;
      const before = this.positions.get(symbol)?.netQuantity ?? 0;
      await new Promise((resolve) => setTimeout(resolve, this.config.cancelSettleMs ?? 400));
      const again = this.orders.get(orderId);
      if (again && again.filledQuantity !== 0) return `vyplnilo se z něj ${again.filledQuantity} ks`;
      if ((this.positions.get(symbol)?.netQuantity ?? 0) !== before) return 'pozice se po zrušení změnila';
      if (this.broker.executionNet(accountId, symbol) !== before) return 'pozice nesouhlasí s vyplněními';
      return null;
    } catch (error) {
      return `jeho konečný stav nejde ověřit (${error instanceof Error ? error.message : String(error)})`;
    }
  }

  private isLive(): boolean {
    return this.config.liveTrading !== undefined || this.config.systemName !== 'Rithmic Test' || this.broker.environment !== 'demo';
  }

  private consentEndedReported = false;
  /** Souhlas se skutečným účtem skončil a vlastní vstupy dál čekají: ohlásit (jednou), nic nerušit — rozhoduje člověk. */
  private watchConsent(): void {
    if (!this.config.liveTrading) return;
    // Jen hlídání (ohlášení skončeného souhlasu): soubor se nečte při každé události. Před obchodním zápisem se
    // souhlas ověřuje vždy znovu a bez mezipaměti.
    if (this.now() - this.consentWatchAt < 2_000) return;
    this.consentWatchAt = this.now();
    if (this.consentProblem() === null) { this.consentEndedReported = false; return; }
    const accountId = this.broker.accountIds()[0];
    const legIds = new Set(accountId === undefined ? [] : this.broker.listBrackets(accountId).flatMap((bracket) => bracket.legs.map((leg) => leg.orderId)));
    const waiting = [...this.orders.values()].filter((order) => !TERMINAL.has(order.status) && isEntryTag(order) && !legIds.has(order.brokerOrderId));
    if (waiting.length === 0) { this.consentEndedReported = false; return; }
    if (this.consentEndedReported) return;
    this.consentEndedReported = true;
    this.incidents.push({ kind: 'consent-ended-entries-working', message: `souhlas se skutečným účtem skončil a čeká ${waiting.length} vstup(ů) — zruš je, jinak se mohou vyplnit`, at: this.now() });
    if (this.incidents.length > 20) this.incidents.shift();
  }

  /** Pravidelná kontrola souhlasu (volá server): vypršení se musí ohlásit i na klidném účtu. */
  checkConsent(): void {
    const before = this.incidents.length;
    this.consentWatchAt = 0; // výslovná pravidelná kontrola se neomezuje
    this.watchConsent();
    if (this.incidents.length !== before) this.changed();
  }

  /** Částečné zavření jednoho vstupu, jehož výstup nebyl do lhůty potvrzen: dokončí se podle stavu výstupního příkazu. */
  /** Poslední zápis posunu SL/TP na kontraktu — dělení vstupu nesmí vyjít z ceny, kterou posun teprve mění. */
  private readonly lastLegWriteAt = new Map<string, number>();
  private readonly splitRunning = new Map<string, Promise<void>>();
  private readonly pendingResize = new Map<string, { entryId: string; exitTag: string; expectNet: number; at?: number }>();
  private watchPendingResize(): void {
    const accountId = this.broker.accountIds()[0];
    if (accountId === undefined) return;
    for (const [symbol, item] of this.pendingResize) {
      const exit = [...this.orders.values()].find((order) => order.tag === item.exitTag);
      if (!exit) continue;
      // Vyplněný výstup je prokázané vyplnění mimo nohy — zapíše se vždy, ať je pozice mezitím jakákoli
      // (např. zbylý kus mezitím zavřel SL); jinak by záznam ochrany zůstal navždy s expozicí navíc.
      if (exit.status === 'filled') {
        this.pendingResize.delete(symbol);
        void this.broker.endBracketResize(accountId, item.entryId, exit.filledQuantity).then(() => { this.clearResizeMarker(item.exitTag); }).catch(() => undefined);
      } else if (exit.status === 'rejected' || exit.status === 'canceled') {
        this.pendingResize.delete(symbol);
        void this.broker.endBracketResize(accountId, item.entryId, exit.filledQuantity).then(() => { this.clearResizeMarker(item.exitTag); }).catch(() => undefined);
      }
    }
  }
  /** Značku smaže jen tehdy, když patří právě tomuto dělení (nesmí smazat značku jiné, běžící výměny ochrany). */
  private clearResizeMarker(exitTag: string): void {
    try { if (this.config.replaceMarker?.read()?.resize?.exitTag === exitTag) this.setReplaceMarker(null); } catch { /* značka zůstane → ohlásí se při startu */ }
  }
  private readonly addCancelTried = new Set<string>();
  private readonly addFlatSince = new Map<string, number>();
  private addTimer: ReturnType<typeof setTimeout> | null = null;
  private automation = false;
  /** Povolí samočinné zápisy služby (dnes jen zrušení čekajícího přikoupení). Volá spouštěč po potvrzení účtu. */
  enableAutomation(): void {
    this.automation = true;
    this.watchPendingAdds();
  }
  /**
   * Pozice se zavřela a čekající přikoupení dál pracuje → zrušit (jeden zápis na příkaz, nic se neopakuje).
   * Zavření musí být potvrzené z obou stran: pozice podle brokera i podle potvrzených vyplnění je nula.
   * Když zrušení neprojde, je to incident a nové vstupy stojí — čekající přikoupení se může vyplnit.
   */
  private watchPendingAdds(): void {
    const accountId = this.broker.accountIds()[0];
    // Samočinný zápis jen když ho spouštěč výslovně povolil (až po potvrzení účtu obsluhou; v režimu jen pro čtení nikdy).
    if (accountId === undefined || !this.connected || !this.automation || this.config.pendingAdd !== true) return;
    for (const order of this.orders.values()) {
      if (TERMINAL.has(order.status) || !order.tag?.startsWith(ADD_TAG) || this.addCancelTried.has(order.brokerOrderId)) continue;
      if ((this.positions.get(order.symbol)?.netQuantity ?? 0) !== 0) { this.addFlatSince.delete(order.brokerOrderId); continue; }
      if (this.broker.executionNet(accountId, order.symbol) !== 0) {
        // Kniha říká nula, potvrzená vyplnění ještě ne: zkusit znovu vlastním časovačem (na klidném účtu jiná událost
        // nepřijde). Když se to do 5 s nesrovná, je to incident — přikoupení pracuje a pozice nejspíš není.
        const since = this.addFlatSince.get(order.brokerOrderId) ?? this.now();
        this.addFlatSince.set(order.brokerOrderId, since);
        if (this.now() - since >= 5_000) {
          this.addCancelTried.add(order.brokerOrderId);
          const message = `pozice na ${order.symbol} vypadá zavřená, ale potvrzená vyplnění to nedokládají — čekající přikoupení ${order.brokerOrderId} dál pracuje; ověř stav a zruš ho ručně`;
          this.incidents.push({ kind: 'pending-add-unresolved', message, at: this.now() });
          if (this.incidents.length > 30) this.incidents.shift();
          this.blocked = `pending-add-unresolved: ${message}`.slice(0, 240);
          this.changed();
        } else if (!this.addTimer) {
          this.addTimer = setTimeout(() => { this.addTimer = null; this.watchPendingAdds(); }, 500);
          (this.addTimer as { unref?: () => void }).unref?.();
        }
        continue;
      }
      this.addCancelTried.add(order.brokerOrderId);
      const report = (detail: string): void => {
        const message = `pozice na ${order.symbol} je zavřená, ale čekající přikoupení ${order.brokerOrderId} se nepodařilo zrušit (${detail}) — zruš ho ručně, jinak může otevřít novou pozici`;
        this.incidents.push({ kind: 'pending-add-cancel-failed', message, at: this.now() });
        if (this.incidents.length > 30) this.incidents.shift();
        this.blocked = `pending-add-cancel-failed: ${message}`.slice(0, 240);
        this.changed();
      };
      void this.broker.cancelOrder(accountId, order.brokerOrderId).then(async () => {
        // Přijetí požadavku není zrušení: úspěch až podle stavu příkazu.
        const deadline = this.now() + (this.config.moveConfirmMs ?? 1_500);
        for (;;) {
          const current = this.orders.get(order.brokerOrderId);
          if (current && TERMINAL.has(current.status)) {
            if (current.status === 'canceled' && current.filledQuantity === 0) {
              this.incidents.push({ kind: 'pending-add-cancelled', message: `pozice na ${order.symbol} se zavřela — čekající přikoupení jsem zrušil`, at: this.now() });
              if (this.incidents.length > 30) this.incidents.shift();
              this.changed();
            } else report('přikoupení se mezitím vyplnilo — zkontroluj pozici a její SL/TP');
            return;
          }
          if (this.now() >= deadline) { report('zrušení není potvrzené'); return; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }, (error: unknown) => report(error instanceof Error ? error.message : String(error)));
    }
  }

  private watchProtective(): void {
    this.watchConsent();
    this.watchPendingAdds();
    this.watchPendingResize();
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
      const own = isEntryTag(order);
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
      marks: [...this.marks].map(([symbol, mark]) => ({ symbol, open: mark.open, fills: [...mark.fills] })),
      rejections: [...this.rejections],
      blocked: this.blocked,
      maxParts: this.maxParts(),
      bareAdd: this.config.bareAdd === true,
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

  private positionMatches(accountId: number, symbol: string, expected: unknown): boolean {
    if (expected === undefined) return true; // Older local clients do not send the displayed position.
    if (typeof expected !== 'string') return false;
    const net = this.positions.get(symbol)?.netQuantity ?? 0;
    const ids = net === 0 ? [] : this.broker.listBrackets(accountId)
      .filter(b => b.symbol === symbol && !b.closed && this.broker.bracketState(accountId, b.entryId).state === 'protected')
      .map(b => b.entryId);
    return expected === JSON.stringify([net, ids.sort()]);
  }

  /**
   * Proč teď NEJDE přikoupit (null = jde). Jen do pozice, kterou CELOU kryjí vlastní vstupy s ochranou (každý ve
   * stavu „chráněno"), se SL i TP částí nejvýš o skluz od sebe, a přikoupení nese jednu z těchto cen. Nic se po
   * vyplnění nesrovnává — každá část má vlastní ochranu na své množství. Zvlášť (vypínač `bareAdd`): pozice bez
   * jakékoli ochrany a příkazu jde zvětšit Marketem bez SL/TP.
   */
  private scaleInProblem(accountId: number, symbol: string, side: OrderSide, stopPrice: number | undefined, targetPrice: number | undefined, ownTag: string | null, orderType: string = 'Market', bareRun = false): string | null {
    const net = this.positions.get(symbol)?.netQuantity ?? 0;
    if (net === 0) return 'pozice se mezitím zavřela — přikoupení neodesílám';
    if ((side === 'Buy') !== (net > 0)) return 'vstup proti otevřené pozici nejde — pozici zavři';
    // Rychlá řada tržních vstupů bez SL/TP (viz `onlyBareMarkets`): nečeká se na usazení pozice ani na předchozí příkaz.
    if (bareRun) return this.onlyBareMarkets(symbol, ownTag) ? null : 'na kontraktu mezitím přibyl jiný příkaz — přikoupení neodesílám';
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
    // Posun více noh trvá u víc částí i sekundy: nová část by vznikla na staré ceně a posun by skončil incidentem.
    if (this.legsMoving.has(symbol)) return 'posun SL/TP právě běží — přikup, až doběhne';
    const legs = this.legsOf(accountId, symbol);
    if (!legs) return 'na kontraktu pracuje příkaz, který služba nezná — přikoupení nejde';
    // Dřívější obchody, které už skončily (jen ještě nejsou trvale uzavřené), se nepočítají. Při zkoušce výměny
    // čekajícího přikoupení se nepočítá ani nahrazovaný vstup (do skutečného zápisu bude zrušený).
    legs.brackets = legs.brackets.filter((bracket) => bracket.entryId !== this.replaceDryRun && this.broker.bracketState(accountId, bracket.entryId).state !== 'done');
    if (legs.brackets.length === 0) {
      // Holá pozice (žádný pracující příkaz na kontraktu — to už ověřil `legsOf`): přikoupení bez SL/TP ji jen zvětší.
      // Ochrana se pak zadává na CELOU pozici (pár SL+TP), takže není co srovnávat. Se SL/TP by vznikla pozice
      // chráněná jen zčásti — to služba nepustí.
      if (this.config.bareAdd !== true) return 'pozice nemá SL a TP ze vstupu — přikoupit jde jen do pozice se SL i TP';
      if (stopPrice !== undefined || targetPrice !== undefined) return 'pozice nemá SL a TP — přikoupit do ní jde jen bez SL/TP (ochranu pak přidej na celou pozici)';
      // Čekající přikoupení bez ochrany služba zatím neumí vyměnit ani posunout → jen Market.
      if (orderType !== 'Market') return 'do pozice bez SL/TP jde přikoupit jen Marketem';
      if (legs.stops.length > 0 || legs.targets.length > 0
        || [...this.orders.values()].some((order) => order.symbol === symbol && !TERMINAL.has(order.status) && order.brokerOrderId !== this.replaceDryRun && (ownTag === null || order.tag !== ownTag))) {
        return 'na kontraktu pracují příkazy — přikoupit bez SL/TP jde jen do pozice bez příkazů';
      }
      if (this.broker.executionNet(accountId, symbol) !== net) return 'pozice zatím nesouhlasí s vyplněními — přikup za okamžik';
      return null;
    }
    // Strop částí (každá s vlastní ochranou): posun SL/TP znamená tolik zápisů po sobě, kolik je částí.
    const maxParts = this.maxParts();
    if (legs.brackets.length >= maxParts) return `pozice už má ${legs.brackets.length} ${legs.brackets.length === 1 ? 'část' : legs.brackets.length < 5 ? 'části' : 'částí'} — další přikoupení služba nepustí (strop ${maxParts})`;
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
    // Ochrana části se u burzy počítá od ceny VYPLNĚNÍ, takže přikoupení Marketem skončí o skluz vedle (změřeno).
    // Malý rozptyl cen mezi částmi proto další přikoupení nezastaví; větší rozdíl ano (nejdřív srovnat posunem).
    const tolerance = (this.config.scaleInSpreadTicks ?? 8) * (this.config.symbols[symbol]?.tickSize ?? 0) + 1e-9;
    const tight = (set: Set<number | undefined>): boolean => {
      const values = [...set].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      return values.length === set.size && values.length > 0 && Math.max(...values) - Math.min(...values) <= tolerance;
    };
    if (!tight(stopAt) || !tight(targetAt)) return 'SL nebo TP částí pozice se liší víc, než dovoluje skluz — nejdřív je srovnej posunem';
    if (stopPrice === undefined || targetPrice === undefined || !stopAt.has(stopPrice) || !targetAt.has(targetPrice)) {
      return `přikoupení musí mít SL a TP pozice (SL ${[...stopAt].join(' / ')}, TP ${[...targetAt].join(' / ')})`;
    }
    return null;
  }

  /**
   * Je na kontraktu jen řada vlastních tržních vstupů bez SL/TP (nebo vůbec nic)? Žádná ochrana, žádný čekající
   * Limit/Stop, žádný cizí příkaz, žádná výměna ochrany na cestě. Jen tehdy smí další takový vstup odejít hned.
   */
  private onlyBareMarkets(symbol: string, ownTag: string | null = null): boolean {
    if (this.legsMoving.has(symbol) || this.legsUncertain.has(symbol)) return false;
    for (const order of this.orders.values()) {
      if (order.symbol !== symbol || TERMINAL.has(order.status)) continue;
      if (order.orderType !== 'Market' || !order.tag?.startsWith('ui-') || order.tag.startsWith(ADD_TAG) || order.tag.startsWith('ui-red-')) return false;
    }
    for (const [tag, item] of this.reserved) {
      if (item.symbol !== symbol || tag === ownTag) continue;
      if (item.bareMarket !== true) return false;
    }
    return true;
  }

  /** Strop částí pozice s vlastní ochranou (viz `maxProtectedParts`). */
  private maxParts(): number {
    const value = this.config.maxProtectedParts;
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? Math.min(value, 50) : 2;
  }

  /** Cena musí ležet na mřížce kroku kontraktu — nic se tiše nezaokrouhluje. */
  private onGrid(price: number, tickSize: number): boolean {
    const steps = price / tickSize;
    return Math.abs(steps - Math.round(steps)) < 1e-6;
  }

  /** Vykoná příkaz z appky. Nikdy nic neopakuje; `sent` říká, zda zápis mohl odejít. */
  async execute(raw: LocalExecCommand): Promise<LocalExecResult> {
    // Zápisy do SL/TP (posun, přidání, výměna) se počítají po celou dobu běhu: dělení vstupu nesmí začít,
    // dokud některý z nich nemá známý výsledek (opožděná změna by ochraně vrátila původní množství).
    const op = (raw as unknown as { op?: unknown } | null)?.op;
    const legOp = op === 'move' || op === 'move-legs' || op === 'protect' || op === 'protect-pair';
    if (legOp) this.legOpsInFlight += 1;
    try {
      const result = await this.executeInner(raw);
      // Zápis do SL/TP s neznámým výsledkem: dokud ho obsluha nepotvrdí, dělení vstupu neprojde.
      if (legOp && 'sent' in result && result.sent === 'unknown') this.legWriteUnknown = true;
      return result;
    } catch (error) {
      if (legOp && !(error instanceof BrokerRequestNotSentError)) this.legWriteUnknown = true;
      throw error;
    } finally { if (legOp) { this.legOpsInFlight -= 1; this.lastLegOpAt = this.now(); } }
  }
  private legWriteUnknown = false;
  private legOpsInFlight = 0;
  private lastLegOpAt = 0;
  private async executeInner(raw: LocalExecCommand): Promise<LocalExecResult> {
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
        if (consentProblem !== null && (command.op === 'entry' || command.op === 'replace-entry')) refuse(`obchodování na skutečném účtu je vypnuté: ${consentProblem}`);
      }
      const accountId = this.broker.accountIds()[0];
      if (accountId === undefined) return refuse('adaptér nemá účet (není připojený)');
      switch (command.op) {
        case 'ack':
          this.blocked = null;
          // Nejistý zápis (ochrany i vstupu), který se v knize neobjevil, nesmí blokovat další ochranu navždy:
          // obsluha potvrzením říká, že stav u brokera zkontrolovala. Rezervace vstupu by jinak do restartu služby
          // bránila zadat ochranu holé pozici („na cestě je jiný příkaz").
          for (const [reservedTag] of this.reserved) {
            if (![...this.orders.values()].some((order) => order.tag === reservedTag)) this.reserved.delete(reservedTag);
          }
          this.legsUncertain.clear();
          this.legWriteUnknown = false;
          this.setReplaceMarker(null);
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
          if (clientId.startsWith('red-')) refuse('clientId red-… je vyhrazený pro částečné zavření');
          const tag = `ui-${clientId}`;
          // Idempotence i přes restart služby: značku nesmí nést žádný dnešní příkaz (kniha po
          // výchozím stavu zná i dokončené).
          if (this.seenClientIds.has(clientId) || [...this.orders.values()].some((order) => order.tag === tag)) refuse('příkaz s tímto clientId už byl přijat');
          for (const field of ['limitPrice', 'triggerPrice', 'stopPrice', 'targetPrice', 'referencePrice'] as const) {
            const value = command[field];
            if (value === undefined) continue;
            if (!finite(value) || value <= 0) refuse(`${field} musí být kladné číslo (nebo chybět)`);
            // Referenční cena z appky je jen kontrola odchylky a může být i středem nabídky a poptávky (mimo krok).
            if (field !== 'referencePrice' && !this.onGrid(value as number, spec.tickSize)) refuse(`${field} ${String(value)} neleží na kroku ceny ${spec.tickSize}`);
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
            // Bez ceny služby nejde ověřit, že Limit není přes trh (pak by nohy vznikly od limitní ceny, ne od vyplnění —
            // změřeno 17. 11.: burza SL odmítla a pozice zůstala bez ochrany). Na skutečném účtu platí pro každý vstup.
            if (server === null && (live || stopPrice !== undefined || targetPrice !== undefined)) return refuse('služba nemá čerstvou cenu — vstup neodesílám');
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
            if (server === null && live) return refuse('služba nemá čerstvou cenu — vstup neodesílám');
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
          const net = this.positions.get(symbol)?.netQuantity ?? 0;
          const accountProblem = () => {
            if (!this.positionMatches(accountId, symbol, command.expectedPosition)) return 'Pozice se od zobrazení změnila — vstup neodešel.';
            if (this.config.quantityLimits && (
              [...this.positions].some(([other, position]) => other !== symbol && position.netQuantity !== 0)
              || [...this.orders.values()].some(order => order.symbol !== symbol && !TERMINAL.has(order.status))
            )) return 'Na účtu je další kontrakt s pozicí nebo příkazem. Zbývající společný limit RMS není ověřený.';
            if (this.broker.executionNet(accountId, symbol) !== net || (this.positions.get(symbol)?.netQuantity ?? 0) !== net) {
              return 'Pozice a potvrzená vyplnění se zatím neshodují — nový vstup neodesílám.';
            }
            const other = [...this.orders.values()].some(order => order.symbol === symbol && !TERMINAL.has(order.status)
              && !order.tag?.startsWith('ui-') && !this.isLeg(accountId, order.brokerOrderId));
            return other ? 'na kontraktu pracuje příkaz zadaný jinde — nový vstup neodesílám' : null;
          };
          const problem = accountProblem();
          if (problem) return refuse(problem);
          const open = Math.abs(net);
          const waiting = [...this.orders.values()].filter((order) => order.symbol === symbol && !TERMINAL.has(order.status) && isEntryTag(order) && !this.isLeg(accountId, order.brokerOrderId)
            // Zkouška nanečisto před výměnou vstupu: nahrazovaný vstup se nepočítá (do skutečného zápisu bude zrušený).
            && order.brokerOrderId !== this.replaceDryRun)
            .reduce((sum, order) => sum + (order.quantity - order.filledQuantity), 0);
          // + vstupy na cestě, které kniha ještě nezná (souběžná volání nesmí strop obejít).
          const onTheWay = [...this.reserved].filter(([reservedTag, item]) => item.symbol === symbol && ![...this.orders.values()].some((order) => order.tag === reservedTag))
            .reduce((sum, [, item]) => sum + item.quantity, 0);
          const rmsProblem = () => {
            if (!this.config.quantityLimits) return null;
            const limits = this.config.quantityLimits();
            if (!limits) return 'Limity účtu a produktu RMS nejsou ověřené.';
            if (quantity > limits.order) return `Příkaz přesahuje limit RMS ${limits.order} ks.`;
            const cap = side === 'Buy' ? limits.buy : limits.sell;
            return open + waiting + onTheWay + quantity > cap ? `Pozice by přesáhla limit RMS ${cap} ks.` : null;
          };
          const sizeProblem = rmsProblem();
          if (sizeProblem) return refuse(sizeProblem);
          const maxPosition = this.config.maxPosition ?? this.config.maxQuantity;
          if (open + waiting + onTheWay + quantity > maxPosition) refuse(`pozice by přesáhla strop ${maxPosition} (otevřeno ${open}, čeká ${waiting + onTheWay})`);
          // Přikoupení do otevřené pozice: jen za přísných podmínek (viz `scaleInProblem`); ověří se teď
          // a znovu těsně před zápisem (adaptér mezitím čeká na uložení záměru).
          // Jeden vlastní vstup najednou: při čekajícím nebo právě odesílaném vstupu další nejde (jinak by se
          // čekající vstup později vyplnil do cizí pozice, nebo po jejím zavření otevřel nezamýšlený obchod).
          // Výjimka — rychlé vstupy Marketem BEZ SL/TP za sebou (lišta, Filip 18. 11. 2026): když na kontraktu není
          // nic jiného než takové tržní příkazy (žádná ochrana, žádný čekající vstup), další smí odejít hned, i když
          // předchozí ještě není vyplněný nebo se pozice teprve hlásí. Tržní příkaz nečeká a nemá ochranu, kterou by
          // šlo rozhodit; stropy (pozice, RMS) výše počítají i příkazy na cestě.
          const bareRun = this.config.bareAdd === true && orderType === 'Market' && stopPrice === undefined && targetPrice === undefined
            && this.onlyBareMarkets(symbol);
          if (waiting + onTheWay > 0 && !bareRun) return refuse('čeká jiný vstup — další jde až po jeho vyplnění nebo zrušení');
          // Přikoupení = jakákoli existující nebo právě vznikající expozice (i vyplnění, které pozice ještě nehlásí).
          const adding = net !== 0;
          if (adding) {
            if (orderType === 'Stop') return refuse('přikoupení jde Marketem nebo Limitem');
            const problem = this.scaleInProblem(accountId, symbol, side, stopPrice, targetPrice, null, orderType, bareRun);
            if (problem) return refuse(problem);
          }
          // Čekající přikoupení musí nést značku vazby na pozici (a nic jiného ji nést nesmí) — podle ní se po zavření
          // pozice samo ruší.
          const pendingAdd = adding && orderType === 'Limit';
          if (pendingAdd && this.config.pendingAdd !== true) return refuse('přikoupení Limitem je zatím jen na testovacím účtu — v pozici přikup Marketem');
          if (clientId.startsWith(ADD_CLIENT_PREFIX) !== pendingAdd) {
            return refuse(pendingAdd ? 'čekající přikoupení musí být označené jako přikoupení (clientId add-…)' : 'označení přikoupení (add-…) patří jen Limitu do otevřené pozice');
          }
          // Jen ověření (výměna čekajícího vstupu): všechny kontroly prošly, nic se neodesílá.
          if (this.replaceDryRun !== null) return { ok: true, result: { dryRun: true } };
          this.seenClientIds.add(clientId);
          // Rezervace PŘED prvním čekáním; drží i při neznámém výsledku, padá jen když zápis prokazatelně neodešel.
          this.reserved.set(tag, { symbol, quantity, bareMarket: orderType === 'Market' && stopPrice === undefined && targetPrice === undefined });
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
          const marketProblem = (): string | null => {
            const latest = this.config.serverPrice?.(symbol) ?? null;
            if (latest === null) return 'služba nemá čerstvou cenu před odesláním';
            if (orderType === 'Limit' && (side === 'Buy' ? reference > latest : reference < latest)) return 'Limit se před odesláním dostal přes trh';
            if (orderType === 'Stop' && (side === 'Buy' ? reference <= latest : reference >= latest)) return 'spoušť Stopu již před odesláním překročil trh';
            if (orderType === 'Market' && Math.abs(reference - latest) > maxDrift * spec.tickSize) return 'cena se před odesláním příliš změnila';
            return null;
          };
          const ack = await release(this.broker.placeBracket({
            // Platnost zůstává DENNÍ (i pro SL/TP): na konci seance burza příkazy zruší a pozice zůstane bez ochrany
            // (změřeno 17. 11. 2026 ve 23:00 SEČ) — to služba ohlásí incidentem a obrazovka na to předem upozorní.
            // Ochrana platná do zrušení by byla horší: když propka pozici před koncem seance zavře sama, SL/TP by
            // zůstaly pracovat bez pozice a v další seanci by mohly otevřít nový obchod (oponentura 17. 11.).
            ...request, ...(stopTicks !== undefined ? { stopTicks } : {}), ...(targetTicks !== undefined ? { targetTicks } : {}),
            guard: () => consentNow() ?? rmsProblem() ?? accountProblem() ?? marketProblem()
              ?? (adding ? this.scaleInProblem(accountId, symbol, side, stopPrice, targetPrice, tag, orderType, bareRun) : null),
          }));
          return { ok: true, result: { orderId: ack.entryBrokerOrderId, stopTicks, targetTicks } };
        }
        case 'replace-entry': {
          const orderId = typeof command.orderId === 'string' ? command.orderId : '';
          const order = this.orders.get(orderId);
          if (!order || TERMINAL.has(order.status)) return refuse(`vstup ${orderId || '?'} už nepracuje`);
          if (!order.tag?.startsWith('ui-') || this.isLeg(accountId, orderId)) return refuse('měnit takto jde jen vlastní čekající vstup');
          if (order.filledQuantity > 0) return refuse('vstup se už plní — neměním ho');
          const clientId = typeof command.clientId === 'string' ? command.clientId : '';
          if (!CLIENT_ID.test(clientId)) refuse('clientId musí mít 1–30 znaků [A-Za-z0-9_-]');
          const spec = this.config.symbols[order.symbol];
          if (!spec) return refuse(`kontrakt ${order.symbol} není povolený`);
          const bracket = this.broker.listBrackets(accountId).find((item) => item.entryId === orderId);
          const stopEntry = order.stopPrice !== undefined;
          const current = stopEntry ? order.stopPrice : order.limitPrice;
          if (current === undefined || (order.stopPrice !== undefined && order.limitPrice !== undefined)) return refuse('vstup má typ, který takto měnit neumím — zruš ho a zadej znovu');
          if (bracket ? order.orderType !== 'Unsupported' : order.orderType !== (stopEntry ? 'Stop' : 'Limit')) return refuse('vstup má jiný typ, než s jakým vznikl — zruš ho a zadej znovu');
          const planned = this.planned(order, bracket);
          const pick = (value: unknown, fallback: number | undefined): number | undefined => (value === undefined ? fallback : value as number);
          const price = pick(command.price, current)!;
          const stopPrice = pick(command.stopPrice, planned.plannedStop);
          const targetPrice = pick(command.targetPrice, planned.plannedTarget);
          for (const value of [price, stopPrice, targetPrice]) if (value !== undefined && (!finite(value) || value <= 0)) return refuse('změna vstupu bez platné ceny');
          if (price === current && stopPrice === planned.plannedStop && targetPrice === planned.plannedTarget) return refuse('nic se nemění');
          // SL/TP nejde přidat ani odebrat — jen posunout to, co vstup má.
          if ((command.stopPrice !== undefined && planned.plannedStop === undefined) || (command.targetPrice !== undefined && planned.plannedTarget === undefined)) return refuse('vstup tuhle ochranu nemá — nejde ji takto přidat');
          // Čekající přikoupení si vazbu na pozici (značku) nese i po výměně.
          const nextClientId = order.tag.startsWith(ADD_TAG) ? `${ADD_CLIENT_PREFIX}${clientId.slice(0, 26)}` : clientId;
          if (!order.tag.startsWith(ADD_TAG) && clientId.startsWith(ADD_CLIENT_PREFIX)) return refuse('označení přikoupení (add-…) sem nepatří');
          const next = {
            op: 'entry' as const, clientId: nextClientId, symbol: order.symbol, side: order.side, quantity: order.quantity, orderType: stopEntry ? 'Stop' as const : 'Limit' as const,
            ...(stopEntry ? { triggerPrice: price } : { limitPrice: price }),
            ...(stopPrice !== undefined ? { stopPrice } : {}), ...(targetPrice !== undefined ? { targetPrice } : {}),
          };
          // Stav brzdy se pamatuje hned na začátku (ještě před prvním čekáním).
          const brake = this.flattenCount.get(order.symbol) ?? 0;
          // 1) Zkouška nanečisto: nový vstup musí projít VŠEMI kontrolami dřív, než se starý zruší. Běží celá
          //    synchronně (bez čekání), takže příznak neuvidí žádný jiný příkaz.
          this.replaceDryRun = orderId;
          let dry: Promise<LocalExecResult>;
          try { dry = this.execute(next as unknown as LocalExecCommand); } finally { this.replaceDryRun = null; }
          const check = await dry;
          if (!check.ok) return check;
          // 2) Zrušit starý vstup a počkat na potvrzení stavem. Pozice neexistuje, takže se nic neodkrývá.
          await this.broker.cancelOrder(accountId, orderId);
          const deadline = this.now() + (this.config.moveConfirmMs ?? 1_500);
          for (;;) {
            const old = this.orders.get(orderId);
            if (old && TERMINAL.has(old.status)) {
              if (old.status !== 'canceled' || old.filledQuantity > 0) return { ok: false, sent: 'unknown', error: 'vstup se mezitím vyplnil — neměním ho; zkontroluj pozici a její SL/TP' };
              // Víc kusů: zpráva o zrušení může přijít dřív než pozdní dílčí vyplnění. Nový vstup na celé množství
              // se zadá jen po autoritativním čtení, které potvrdí zrušení s nulovým plněním.
              if (order.quantity > 1) {
                const problem = await this.canceledUnfilled(accountId, orderId);
                if (problem) return { ok: false, sent: 'unknown', error: `původní vstup je zrušený, ale ${problem} — nový nezadávám; zkontroluj pozici` };
              }
              break;
            }
            if (this.now() >= deadline) return { ok: false, sent: 'unknown', error: 'zrušení původního vstupu není potvrzené — nový nezadávám; ověř, co u brokera čeká' };
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          // Mezitím někdo stiskl brzdu (Zavřít pozici): po zavření se nový vstup NEZADÁVÁ — vrátil by obchod do trhu.
          if ((this.flattenCount.get(order.symbol) ?? 0) !== brake) return { ok: false, sent: false, error: 'mezitím proběhlo Zavřít pozici — původní vstup je zrušený a nový jsem nezadal' };
          // 3) Nový vstup běžnou cestou (všechny kontroly znovu, proti čerstvé ceně). Když neprojde, žádný vstup nečeká.
          const placed = await this.execute(next as unknown as LocalExecCommand);
          if (placed.ok) return { ok: true, result: { ...(placed.result as Record<string, unknown>), replaced: orderId } };
          const failed = placed as { ok: false; sent: false | 'unknown'; error?: string };
          // Nový vstup prokazatelně neodešel → stav je jistý (starý zrušen, nic nečeká): žádná „neznámá" karta, jen hláška.
          if (failed.sent === false) return { ok: false, sent: false, error: `původní vstup je zrušený a nový neodešel (${failed.error ?? 'neznámý důvod'}) — teď nečeká žádný vstup, zadej ho znovu` };
          return { ok: false, sent: 'unknown', error: `původní vstup je zrušený a nový má neznámý výsledek (${failed.error ?? 'neznámý důvod'}) — ověř u brokera, co čeká` };
        }
        case 'protect-pair': {
          // Ochrana snižuje riziko → smí i při zastavených vstupech. Jeden zápis: dva příkazy svázané burzou.
          const symbol = typeof command.symbol === 'string' ? command.symbol : '';
          const spec = this.config.symbols[symbol];
          if (!spec) return refuse(`kontrakt ${symbol || '?'} není povolený`);
          const clientId = typeof command.clientId === 'string' ? command.clientId : '';
          if (!CLIENT_ID.test(clientId)) refuse('clientId musí mít 1–30 znaků [A-Za-z0-9_-]');
          const stopTag = `${PROTECT_TAG}${clientId.slice(0, 26)}-s`;
          const targetTag = `${PROTECT_TAG}${clientId.slice(0, 26)}-t`;
          if (this.seenClientIds.has(clientId) || [...this.orders.values()].some((order) => order.tag === stopTag || order.tag === targetTag)) refuse('příkaz s tímto clientId už byl přijat');
          const stopPrice = command.stopPrice;
          const targetPrice = command.targetPrice;
          if (!finite(stopPrice) || !finite(targetPrice) || stopPrice <= 0 || targetPrice <= 0) return refuse('pár SL+TP bez platných cen');
          if (!this.onGrid(stopPrice, spec.tickSize) || !this.onGrid(targetPrice, spec.tickSize)) refuse(`ceny neleží na kroku ceny ${spec.tickSize}`);
          const net = this.positions.get(symbol)?.netQuantity ?? 0;
          if (net === 0) return refuse('není otevřená pozice — ochranu není k čemu přidat');
          // Množství páru = celá pozice. Pozice musí sedět s potvrzenými vyplněními (jinak by pár mohl mít jiný počet kusů).
          const pairQuantity = Math.abs(net);
          if (pairQuantity > (this.config.maxPosition ?? this.config.maxQuantity)) return refuse(`pozice ${pairQuantity} je nad stropem služby — ochranu nezadávám`);
          const pairLimits = this.config.quantityLimits?.();
          // Ochrana jen snižuje expozici: když limity právě nejsou známé (čtou se řídce kvůli limitu dotazů Rithmicu),
          // pár se NEODMÍTÁ — jinak by holá pozice nešla ochránit. Limit na příkaz vynutí RMS u Rithmicu.
          if (pairLimits && pairQuantity > pairLimits.order) return refuse(`ochrana na ${pairQuantity} ks přesahuje limit RMS ${pairLimits.order} ks na příkaz`);
          if (this.broker.executionNet(accountId, symbol) !== net) return refuse('pozice zatím nesouhlasí s vyplněními — ochranu zadej za okamžik');
          if ([...this.orders.values()].some((order) => order.symbol === symbol && !TERMINAL.has(order.status))) return refuse('pozice už má pracující příkazy — pár SL+TP jde přidat jen k pozici bez příkazů');
          if ([...this.reserved.values()].some((item) => item.symbol === symbol)) return refuse('na cestě je jiný příkaz tohoto kontraktu — ochranu teď nezadávám');
          if (this.legsMoving.has(symbol)) return refuse('změna ochrany na tomto kontraktu právě běží — počkej na výsledek');
          if (this.legsUncertain.has(symbol)) return refuse('poslední změna ochrany skončila nejistě — ověř u brokera, co na pozici pracuje, a potvrď incident');
          if (this.broker.listBrackets(accountId).some((bracket) => bracket.symbol === symbol && !bracket.closed)) return refuse('pozice patří ke vstupu s ochranou — další ochranu nezadávám');
          const filledAt = this.lastFillAt.get(symbol);
          if (filledAt !== undefined && ((this.lastPositionAt.get(symbol) ?? 0) < filledAt || this.now() - filledAt < (this.config.positionSettleMs ?? 1_000))) {
            return refuse('pozice se právě mění (čerstvé vyplnění) — ochranu zadej za okamžik');
          }
          const server = this.config.serverPrice?.(symbol) ?? null;
          if (server === null) return refuse('služba nemá čerstvou cenu — ochranu nezadávám');
          const long = net > 0;
          if (long ? !(stopPrice < server && server < targetPrice) : !(targetPrice < server && server < stopPrice)) return refuse('SL musí být na ztrátové a TP na ziskové straně trhu');
          const limit = this.config.maxProtectionTicks ?? 400;
          for (const price of [stopPrice, targetPrice]) {
            if (Math.round(Math.abs(price - server) / spec.tickSize) > limit) return refuse(`ochrana je dál než povolených ${limit} ticků od trhu`);
          }
          this.seenClientIds.add(clientId);
          this.legsMoving.add(symbol);
          this.reserved.set(stopTag, { symbol, quantity: 0 });
          try {
            let pair;
            try {
              pair = await this.broker.placeExitPair({ accountId, symbol, side: long ? 'Sell' : 'Buy', quantity: pairQuantity, stop: { tag: stopTag, stopPrice }, target: { tag: targetTag, limitPrice: targetPrice } });
            } catch (error) {
              if (error instanceof BrokerRequestNotSentError) throw error; // nic neodešlo, pozice je ve stejném stavu jako předtím
              // Výsledek není znám: na burze může pracovat pár, o kterém služba neví → další ochrana až po potvrzení.
              const message = `výsledek zadání páru SL+TP není znám (${error instanceof Error ? error.message : String(error)}) — ověř u brokera, jakou ochranu pozice má`;
              this.incidents.push({ kind: 'protect-pair-uncertain', message, at: this.now() });
              this.blocked = `protect-pair-uncertain: ${message}`.slice(0, 240);
              this.legsUncertain.add(symbol);
              this.changed();
              return { ok: false, sent: 'unknown', error: message };
            }
            const deadline = this.now() + (this.config.moveConfirmMs ?? 1_500);
            for (;;) {
              const byTag = (wanted: string) => [...this.orders.values()].find((order) => order.tag === wanted && [pair.stopOrderId, pair.targetOrderId].includes(order.brokerOrderId));
              const stop = byTag(stopTag);
              const target = byTag(targetTag);
              if (stop?.status === 'working' && target?.status === 'working' && stop.orderType === 'Stop' && target.orderType === 'Limit' && stop.quantity === pairQuantity && target.quantity === pairQuantity) {
                return { ok: true, result: { stopOrderId: stop.brokerOrderId, targetOrderId: target.brokerOrderId, quantity: pairQuantity, paired: true } };
              }
              if (this.now() >= deadline || (stop && TERMINAL.has(stop.status)) || (target && TERMINAL.has(target.status))) {
                this.legsUncertain.add(symbol);
                return { ok: false, sent: 'unknown', error: 'pár SL+TP není potvrzený stavem (nebo ho burza nepřijala) — ověř u brokera, jakou ochranu pozice má' };
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          } finally {
            this.legsMoving.delete(symbol);
            this.reserved.delete(stopTag);
          }
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
            // Víc kusů: pozice musí před výměnou i po zrušení staré nohy sedět s potvrzenými vyplněními. Kdyby se stará
            // noha během rušení částečně vyplnila, pozice se změní a nový pár se nezadá.
            if (this.broker.executionNet(accountId, symbol) !== net) return refuse('pozice zatím nesouhlasí s vyplněními — ochranu zadej za okamžik');
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
              // 0) Trvalá značka před prvním zápisem; když ji nejde uložit, výměna se nezačne.
              // Víc kusů: stará noha se nesmí dát částečně vyplnit — trh musí být od její ceny dost daleko (8 kroků),
              // jinak by pozdní dílčí vyplnění dalo nový pár na víc kusů, než pozice má.
              if (quantity > 1) {
                if (this.config.multiPairSwap !== true) return refuse('výměna SL/TP za pár u víc kusů je na tomto účtu vypnutá — zadej SL i TP najednou, nebo po jednom kusu');
                const near = this.config.serverPrice?.(symbol) ?? null;
                const oldPrice = pairWith.stopPrice ?? pairWith.limitPrice;
                const tick = this.config.symbols[symbol]?.tickSize ?? 0;
                if (near === null || oldPrice === undefined || tick <= 0 || Math.abs(near - oldPrice) < 8 * tick) return refuse('trh je blízko stávající ochrany — výměnu u víc kusů teď neodesílám');
              }
              if (!this.setReplaceMarker({ symbol, at: this.now() })) return refuse('značku výměny ochrany nejde uložit — nic neměním');
              // 1) Zrušit původní nohu a POČKAT na potvrzení stavem. Bez potvrzení se pár nezadává (hrozily by dvě ochrany).
              try {
                await this.broker.cancelOrder(accountId, pairWith.brokerOrderId);
              } catch (error) {
                // Prokazatelně neodesláno = nic se nezměnilo. Cokoli jiného: stará ochrana mohla zmizet → incident.
                if (error instanceof BrokerRequestNotSentError) { this.setReplaceMarker(null); throw error; }
                return fail('protect-replace-uncertain', `zrušení původního ${kind === 'stop' ? 'TP' : 'SL'} skončilo nejistě (${error instanceof Error ? error.message : String(error)}) — nový pár nezadávám; ověř u brokera, jakou ochranu pozice má`);
              }
              const deadline = this.now() + (this.config.moveConfirmMs ?? 1_500);
              for (;;) {
                const old = this.orders.get(pairWith.brokerOrderId);
                if (old && TERMINAL.has(old.status)) {
                  if (old.status !== 'canceled' || old.filledQuantity > 0) return fail('protect-replace-interrupted', `původní ${kind === 'stop' ? 'TP' : 'SL'} se mezitím vyplnil — druhou ochranu nezadávám, zkontroluj pozici`);
                  // Víc kusů: pozdní dílčí vyplnění staré nohy by dalo pár na víc kusů, než pozice má (obrat pozice).
                  if (quantity > 1) {
                    const problem = await this.canceledUnfilled(accountId, pairWith.brokerOrderId);
                    if (problem) return fail('protect-replace-interrupted', `původní ${kind === 'stop' ? 'TP' : 'SL'} je zrušený, ale ${problem} — nový pár nezadávám, zkontroluj pozici a její ochranu`);
                  }
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
              const stillOk = netNow === net && this.broker.executionNet(accountId, symbol) === net && others.length === 0 && !elsewhere && fresh !== null && (long ? stopPrice < fresh && fresh < targetPrice : targetPrice < fresh && fresh < stopPrice);
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
                  this.setReplaceMarker(null);
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
            this.lastLegWriteAt.set(order.symbol, this.now());
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
            this.lastLegWriteAt.set(order.symbol, this.now());
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
            this.lastLegWriteAt.set(order.symbol, this.now());
            await this.broker.modifyOrder(accountId, orderId, {
              quantity: order.quantity, orderType: order.orderType, ...(order.orderType === 'Stop' ? { stopPrice: price } : { limitPrice: price }),
            });
          } else if (order.orderType === 'Limit' && order.tag?.startsWith('ui-')) {
            this.lastLegWriteAt.set(order.symbol, this.now());
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
          // Posun existujících noh nezávisí na stropu pro NOVÉ části (strop se mohl po restartu snížit) — jen na pevné mezi.
          if (list.length > 50) return refuse(`příliš mnoho ochran (${list.length}) — posun neodesílám`);
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
          let legStartedAt = startedAt;
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
              // Mez na JEDNU nohu (předchozí nesmí trvat déle než rozpočet) a celková mez pod lhůtou odpovědi appky.
              if (moved.length > 0 && (this.now() - legStartedAt > budget || this.now() - startedAt > (this.config.moveLegsTotalMs ?? 10_000))) return stop('unknown', 'posun předchozích noh trval příliš dlouho');
              legStartedAt = this.now();
              // Trh se mezi nohami hýbe: stranu a vzdálenost ověřit znovu z čerstvé ceny, jinak by zápis mohl ochranu hned spustit.
              const fresh = this.config.serverPrice?.(symbol) ?? null;
              const freshBelow = fresh !== null && price < fresh;
              if (fresh === null || (role === 'stop' ? long !== freshBelow : long === freshBelow) || Math.round(Math.abs(price - fresh) / spec.tickSize) < 1) {
                return stop(moved.length ? 'unknown' : false, 'cena trhu se mezitím dostala za novou cenu ochrany');
              }
              try {
                this.lastLegWriteAt.set(symbol, this.now());
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
          if (!target.tag || !(target.tag.startsWith('ui-') || target.tag.startsWith(PROTECT_TAG) || target.tag.startsWith('uiflat-'))) return refuse('rušit jde jen příkaz zadaný z této appky — cizí příkaz zruš tam, kde vznikl (nebo zavři pozici)');
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
          // Rozdělané částečné zavření (ochrana zmenšená, výstup 1 ks na cestě) se nejdřív nechá doběhnout (nejdéle pár sekund):
          // zavření vedle pracujícího výstupu by mohlo pozici obrátit.
          this.flattenSentAt.set(symbol, this.now());
          // Každé zavření zneplatní rozdělanou výměnu čekajícího vstupu (nový vstup po brzdě už neodejde).
          this.flattenCount.set(symbol, (this.flattenCount.get(symbol) ?? 0) + 1);
          // Brzda čeká nejvýš 2,5 s; pak pokračuje — obrat hlídá adaptér (pracující výstup dělení = výstupní příkaz).
          const running = this.splitRunning.get(symbol);
          // Výstup dělení s neznámým výsledkem, který kniha ještě nezná: zavření celé pozice vedle něj by ji mohlo obrátit.
          // Po dobu, kdy se může ještě objevit (lhůta požadavku), brzda neodešle a řekne proč; pak už ano.
          if (running) await Promise.race([running, new Promise<void>((resolve) => setTimeout(resolve, this.config.splitWaitMs ?? 2_500))]);
          // Kontrola AŽ po čekání (dělení mohlo mezitím skončit nejistotou): výstup s neznámým výsledkem, který kniha
          // ještě nezná → brzda neodešle a řekne proč. Po lhůtě požadavku (12 s) už se objevit nemůže a brzda jde.
          const unsettled = this.pendingResize.get(symbol);
          if ((running && this.splitRunning.has(symbol))
            || (unsettled && ![...this.orders.values()].some((order) => order.tag === unsettled.exitTag) && this.now() - (unsettled.at ?? 0) < (this.config.splitUnknownMs ?? 12_000))) {
            return refuse('zavření 1 ks ještě nemá známý výsledek — Zavřít by teď mohlo pozici obrátit; zkus to za pár sekund');
          }
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
          if (this.seenClientIds.has(`reduce:${reduceId}`) || [...this.orders.values()].some((order) => order.tag === `ui-red-${reduceId}`)) refuse('příkaz s tímto clientId už byl přijat');
          const net0 = this.positions.get(symbol)?.netQuantity ?? 0;
          if (!this.positionMatches(accountId, symbol, command.expectedPosition)) return refuse('Zobrazená pozice se změnila — částečné zavření neodešlo.');
          if (this.broker.executionNet(accountId, symbol) !== net0) return refuse('Pozice zatím nesouhlasí s vyplněními — částečné zavření neodešlo.');
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
          // JEDEN vstup s víc kusy: nejdřív se zmenší jeho ochrana o 1 ks (jedna změna, burza změní obě nohy), pak se
          // 1 ks zavře Marketem. Mezi oběma zápisy je ten kus krátce bez ochrany; opačné pořadí by nechalo ochranu na
          // víc kusů, než pozice má (při zásahu SL obrat). Každé selhání po zmenšení = incident, nic se neopakuje.
          if (parts.length === 1 && parts[0].quantity >= 2) {
            const part = parts[0];
            if (this.config.entrySplit !== true) return refuse('částečné zavření jednoho vstupu s víc kusy je na tomto účtu zatím vypnuté');
            if (part.quantity !== Math.abs(net0) || legs.stops.length !== 1 || legs.targets.length !== 1) return refuse('SL/TP nekryjí přesně celou pozici — částečné zavření nejde');
            if (command.expectedEntryId !== part.entryId
              || (command.expectedQuantity !== undefined && command.expectedQuantity !== 1)) return refuse('Část pozice se od zobrazení změnila (nebo chybí označení vstupu) — částečné zavření neodešlo.');
            const parent = this.orders.get(part.entryId);
            if (parent && !TERMINAL.has(parent.status)) return refuse('vstup se ještě dovyplňuje — částečné zavření až po něm');
            if (this.blocked !== null) return refuse('služba je zablokovaná incidentem — nejdřív ho ověř a potvrď');
            if (this.legWriteUnknown) return refuse('poslední změna SL/TP nemá známý výsledek — ověř ochranu a potvrď, pak teprve částečné zavření');
            if (this.legOpsInFlight > 0 || this.now() - this.lastLegOpAt < 1_500 || this.now() - (this.lastLegWriteAt.get(symbol) ?? 0) < 1_500) return refuse('ochrana se právě posouvá — částečné zavření za okamžik');
            const market = this.config.serverPrice?.(symbol) ?? null;
            if (market === null) return refuse('služba nemá čerstvou cenu — částečné zavření neodesílám');
            if (net0 > 0 ? market <= part.stop.stopPrice! : market >= part.stop.stopPrice!) return refuse('trh je u SL — částečné zavření neodesílám');
            const exitTag = `ui-red-${reduceId}`;
            if (!this.setReplaceMarker({ symbol, at: this.now(), resize: { entryId: part.entryId, exitTag, expectNet: net0 - Math.sign(net0) } })) return refuse('značku změny ochrany nejde uložit — nic neměním');
            this.seenClientIds.add(`reduce:${reduceId}`);
            this.legsMoving.add(symbol);
            let splitEnd: () => void = () => undefined;
            this.splitRunning.set(symbol, new Promise<void>((resolve) => { splitEnd = resolve; }));
            this.reserved.set(exitTag, { symbol, quantity: 0 });
            const left = part.quantity - 1;
            const fail = (kindOf: string, message: string): LocalExecResult => {
              this.incidents.push({ kind: kindOf, message, at: this.now() });
              if (this.incidents.length > 30) this.incidents.shift();
              this.blocked = `${kindOf}: ${message}`.slice(0, 240);
              this.legsUncertain.add(symbol);
              this.changed();
              return { ok: false, sent: 'unknown', error: message };
            };
            try {
              try {
                await this.broker.beginBracketResize(accountId, part.entryId, left);
              } catch (error) {
                if (error instanceof BrokerRequestNotSentError) { this.setReplaceMarker(null); throw error; }
                // Záměr se ukončí hned: sedí-li nohy na původním množství, je vše při starém; jsou-li už menší,
                // ohlásí se ochrana jako neúplná (pravda). Jinak by další pokus navždy končil „zmenšení už běží".
                await this.broker.endBracketResize(accountId, part.entryId, 0).catch(() => undefined);
                return fail('reduce-resize-uncertain', `zmenšení ochrany na ${left} ks není potvrzené (${error instanceof Error ? error.message : String(error)}) — ověř u brokera množství SL a TP; pozici jsem nezavíral`);
              }
              // Stav se během zmenšování nesměl změnit; jinak se 1 ks nezavírá (ochrana je už menší → ohlásit).
              if ((this.positions.get(symbol)?.netQuantity ?? 0) !== net0 || this.broker.executionNet(accountId, symbol) !== net0) {
                await this.broker.endBracketResize(accountId, part.entryId, 0).catch(() => undefined);
                return fail('reduce-protection-reduced', `ochrana je zmenšená na ${left} ks, ale pozice se mezitím změnila — 1 ks jsem nezavřel; zkontroluj pozici a její ochranu`);
              }
              let ack;
              try {
                ack = await this.broker.placeOrder({ tag: exitTag, accountId, symbol, side: exitSide, quantity: 1, orderType: 'Market' });
              } catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                if (error instanceof BrokerRequestNotSentError) {
                  await this.broker.endBracketResize(accountId, part.entryId, 0).catch(() => undefined);
                  return fail('reduce-exit-failed', `ochrana kryje ${left} ks, ale zavření 1 ks neodešlo (${text}) — 1 ks je BEZ ochrany: zavři celou pozici (Zavřít), nebo ten kus zavři u brokera`);
                }
                this.pendingResize.set(symbol, { entryId: part.entryId, exitTag, expectNet: net0 - Math.sign(net0), at: this.now() });
                return fail('reduce-exit-uncertain', `ochrana kryje ${left} ks a výsledek zavření 1 ks není znám (${text}) — ověř pozici u brokera`);
              }
              const deadline = this.now() + (this.config.reduceConfirmMs ?? 3_000);
              for (;;) {
                const exit = this.orders.get(ack.brokerOrderId);
                const net = this.positions.get(symbol)?.netQuantity ?? 0;
                if (exit?.status === 'filled' && exit.filledQuantity === 1 && net === net0 - Math.sign(net0) && this.broker.executionNet(accountId, symbol) === net) {
                  try { await this.broker.endBracketResize(accountId, part.entryId, 1); }
                  catch { return fail('reduce-record-failed', `1 ks je zavřený a ochrana kryje ${left} ks, ale záznam ochrany nejde uložit — po restartu služby by hlásila chybnou ochranu; ověř disk a stav u brokera`); }
                  // Úspěch až s doloženou ochranou zbytku (nohy mohly mezitím zaniknout, např. koncem seance).
                  const legOk = (id: string) => { const leg = this.orders.get(id); return leg !== undefined && leg.status === 'working' && leg.quantity - leg.filledQuantity === left; };
                  if (this.broker.bracketState(accountId, part.entryId).state !== 'protected' || !legOk(part.stop.brokerOrderId) || !legOk(part.target.brokerOrderId)) {
                    this.setReplaceMarker({ symbol, at: this.now() }); // výstup je už zapsaný — po restartu se nesmí připsat znovu
                    return fail('reduce-protection-missing', `1 ks je zavřený, ale ochrana zbylých ${left} ks není potvrzená — ověř SL a TP u brokera`);
                  }
                  this.setReplaceMarker(null);
                  return { ok: true, result: { orderId: ack.brokerOrderId, quantity: 1, split: true } };
                }
                if (net !== 0 && Math.sign(net) !== Math.sign(net0)) {
                  this.pendingResize.set(symbol, { entryId: part.entryId, exitTag, expectNet: net0 - Math.sign(net0), at: this.now() });
                  return fail('reduce-reversed', `po zavření 1 ks je pozice OPAČNÁ (${net} ks) — něco ji mezitím zavřelo jinde; pozice je BEZ ochrany, zavři ji (Zavřít)`);
                }
                if (exit?.status === 'rejected' || exit?.status === 'canceled') {
                  await this.broker.endBracketResize(accountId, part.entryId, 0).catch(() => undefined);
                  return fail('reduce-exit-failed', `ochrana kryje ${left} ks, ale zavření 1 ks burza nepřijala — 1 ks je BEZ ochrany: zavři celou pozici (Zavřít), nebo ten kus zavři u brokera`);
                }
                if (this.now() >= deadline) {
                  // Výstup může ještě doběhnout: dokončení (nebo neúspěch) dohlídá hlídač podle stavu příkazu.
                  this.pendingResize.set(symbol, { entryId: part.entryId, exitTag, expectNet: net0 - Math.sign(net0), at: this.now() });
                  return fail('reduce-exit-uncertain', `ochrana kryje ${left} ks, ale zavření 1 ks není potvrzené — ověř pozici u brokera`);
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
            } finally {
              this.legsMoving.delete(symbol);
              this.reserved.delete(exitTag);
              this.splitRunning.delete(symbol);
              splitEnd();
            }
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
          if ((command.expectedEntryId !== undefined && command.expectedEntryId !== chosen.entryId)
            || (command.expectedQuantity !== undefined && command.expectedQuantity !== chosen.quantity)) {
            return refuse('Část pozice se od zobrazení změnila — částečné zavření neodešlo.');
          }
          const remaining = parts.filter(part => part !== chosen);
          const remainingIds = new Set(remaining.flatMap(part => [part.stop.brokerOrderId, part.target.brokerOrderId]));
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
              if (exit?.status === 'filled' && exit.filledQuantity === chosen.quantity
                && this.orders.get(chosen.stop.brokerOrderId)?.status === 'canceled'
                && net === net0 - Math.sign(net0) * chosen.quantity && this.broker.executionNet(accountId, symbol) === net
                && remaining.every(part => this.broker.bracketState(accountId, part.entryId).state === 'protected'
                  && [part.stop, part.target].every(previous => {
                    const current = this.orders.get(previous.brokerOrderId);
                    return current?.status === 'working' && current.side === previous.side && current.quantity === part.quantity
                      && current.filledQuantity === 0 && current.stopPrice === previous.stopPrice && current.limitPrice === previous.limitPrice;
                  }))
                && ![...this.orders.values()].some(order => order.symbol === symbol && !TERMINAL.has(order.status) && !remainingIds.has(order.brokerOrderId))) {
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
                if (exit?.status === 'filled') {
                  const message = 'Výstup se vyplnil, ale zrušení sesterského SL nebo ochrana zbytku pozice nejsou potvrzené. Ověř pozici a příkazy u brokera.';
                  this.blocked = message;
                  this.incidents.push({ kind: 'reduce-protection-uncertain', at: this.now(), message });
                  this.changed();
                  return { ok: false, sent: 'unknown', error: message };
                }
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
