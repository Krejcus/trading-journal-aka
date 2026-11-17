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
  /** Cena čáry v grafu (limit, nebo spoušť stopu); u tržního příkazu chybí. */
  price?: number;
  /** Vstup, ke kterému noha patří. */
  entryId?: string;
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
  | { op: 'entry'; clientId: string; symbol: string; side: OrderSide; quantity: number; orderType: 'Market' | 'Limit'; limitPrice?: number; stopPrice?: number; targetPrice?: number; referencePrice?: number }
  | { op: 'move'; orderId: string; price: number }
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
    this.changed();
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
      const role = known?.role ?? (order.orderType === 'Unsupported' ? 'other' : 'entry');
      const price = role === 'stop' ? order.stopPrice : role === 'target' ? order.limitPrice : order.limitPrice ?? order.stopPrice;
      orders.push({
        orderId: order.brokerOrderId, symbol: order.symbol, side: order.side, quantity: order.quantity, filledQuantity: order.filledQuantity,
        status: order.status, role, ...(price !== undefined ? { price } : {}),
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
          this.changed();
          return { ok: true, result: { acknowledged: true } };
        case 'entry': {
          if (this.blocked) refuse(`nové vstupy jsou zastavené, dokud nepotvrdíš incident (${this.blocked})`);
          const symbol = typeof command.symbol === 'string' ? command.symbol : '';
          const spec = this.config.symbols[symbol];
          if (!spec) return refuse(`kontrakt ${symbol || '?'} není povolený`);
          if (command.side !== 'Buy' && command.side !== 'Sell') refuse('strana musí být Buy nebo Sell');
          if (command.orderType !== 'Market' && command.orderType !== 'Limit') refuse('typ musí být Market nebo Limit');
          const side = command.side as OrderSide;
          const orderType = command.orderType as 'Market' | 'Limit';
          const quantity = command.quantity;
          if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > this.config.maxQuantity) {
            return refuse(`množství ${String(quantity)} je mimo povolený rozsah 1–${this.config.maxQuantity}`);
          }
          const clientId = typeof command.clientId === 'string' ? command.clientId : '';
          if (!CLIENT_ID.test(clientId)) refuse('clientId musí mít 1–30 znaků [A-Za-z0-9_-]');
          const tag = `ui-${clientId}`;
          // Idempotence i přes restart služby: značku nesmí nést žádný dnešní příkaz (kniha po
          // výchozím stavu zná i dokončené).
          if (this.seenClientIds.has(clientId) || [...this.orders.values()].some((order) => order.tag === tag)) refuse('příkaz s tímto clientId už byl přijat');
          for (const field of ['limitPrice', 'stopPrice', 'targetPrice', 'referencePrice'] as const) {
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
          this.seenClientIds.add(clientId);
          // Rezervace PŘED prvním čekáním; drží i při neznámém výsledku, padá jen když zápis prokazatelně neodešel.
          this.reserved.set(tag, { symbol, quantity });
          const release = <T>(promise: Promise<T>): Promise<T> => promise.catch((error: unknown) => {
            if (error instanceof BrokerRequestNotSentError) this.reserved.delete(tag);
            throw error;
          });
          const request = { tag, accountId, symbol, side, quantity, orderType, ...(orderType === 'Limit' ? { limitPrice } : {}) };
          if (stopTicks === undefined && targetTicks === undefined) {
            const ack = await release(this.broker.placeOrder(request));
            return { ok: true, result: { orderId: ack.brokerOrderId } };
          }
          const ack = await release(this.broker.placeBracket({ ...request, ...(stopTicks !== undefined ? { stopTicks } : {}), ...(targetTicks !== undefined ? { targetTicks } : {}) }));
          return { ok: true, result: { orderId: ack.entryBrokerOrderId, stopTicks, targetTicks } };
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
            await this.broker.modifyOrder(accountId, orderId, {
              quantity: order.quantity, orderType: leg.role === 'stop' ? 'Stop' : 'Limit', ...(leg.role === 'stop' ? { stopPrice: price } : { limitPrice: price }),
            });
          } else if (order.tag?.startsWith('ui-') && order.limitPrice !== undefined && order.stopPrice === undefined
            && this.broker.listBrackets(accountId).some((bracket) => bracket.entryId === orderId)) {
            // Čekající vlastní vstup s ochranou: jen cena. SL/TP jsou vzdálenosti od vyplnění, posunou se s ním.
            if (order.filledQuantity > 0) return refuse('vstup se už plní — cenu neměním');
            const server = this.config.serverPrice?.(order.symbol) ?? null;
            // Přes trh by se vyplnil jinde, než kde graf ukazuje vstup i ochranu.
            if (server !== null && (order.side === 'Buy' ? price > server : price < server)) return refuse('nová cena Limitu je přes trh — vyplnil by se hned za jinou cenu; zruš ho a použij Market');
            await this.broker.modifyOrder(accountId, orderId, { quantity: order.quantity, orderType: 'Limit', limitPrice: price });
          } else if (order.orderType === 'Limit' && order.tag?.startsWith('ui-')) {
            await this.broker.modifyOrder(accountId, orderId, { quantity: order.quantity, orderType: 'Limit', limitPrice: price });
          } else {
            return refuse('posouvat jde jen SL/TP vlastního vstupu a vlastní čekající Limit');
          }
          return { ok: true, result: { orderId } };
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
    if (!bracket || !tick || order.limitPrice === undefined || order.filledQuantity > 0) return {};
    const up = order.side === 'Buy' ? 1 : -1;
    return {
      ...(bracket.stopTicks !== undefined ? { plannedStop: order.limitPrice - up * bracket.stopTicks * tick } : {}),
      ...(bracket.targetTicks !== undefined ? { plannedTarget: order.limitPrice + up * bracket.targetTicks * tick } : {}),
    };
  }

  private isLeg(accountId: number, orderId: string): boolean {
    return this.broker.listBrackets(accountId).some((bracket) => bracket.legs.some((leg) => leg.orderId === orderId));
  }
}
