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
  /** Bez výslovného povolení služba odmítne všechno mimo demo prostředí. */
  allowLive?: boolean;
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
}

export type LocalExecCommand =
  | { op: 'entry'; clientId: string; symbol: string; side: OrderSide; quantity: number; orderType: 'Market' | 'Limit'; limitPrice?: number; stopPrice?: number; targetPrice?: number; referencePrice?: number }
  | { op: 'move'; orderId: string; price: number }
  | { op: 'cancel'; orderId: string }
  | { op: 'flatten'; clientId: string; symbol: string };

export type LocalExecResult = { ok: true; result: unknown } | { ok: false; sent: boolean | 'unknown'; error: string };

const TERMINAL: ReadonlySet<string> = new Set(['filled', 'canceled', 'rejected']);

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
      if (event.order.status === 'rejected' && before?.status !== 'rejected') {
        this.rejections.push({ orderId: event.order.brokerOrderId, ...(event.order.tag ? { tag: event.order.tag } : {}), reason: event.order.rejectReason ?? 'bez důvodu', at: this.now() });
        if (this.rejections.length > 10) this.rejections.shift();
      }
    }
    else if (event.type === 'position') {
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
      for (const leg of bracket.legs) roleOf.set(leg.orderId, { role: leg.role, entryId: bracket.entryId });
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
    };
  }

  /** Vykoná příkaz z appky. Nikdy nic neopakuje; `sent` říká, zda zápis mohl odejít. */
  async execute(command: LocalExecCommand): Promise<LocalExecResult> {
    try {
      if (this.broker.environment !== 'demo' && !this.config.allowLive) throw new BrokerRequestNotSentError('místní služba je povolená jen pro testovací prostředí');
      const accountId = this.broker.accountIds()[0];
      if (accountId === undefined) throw new BrokerRequestNotSentError('adaptér nemá účet (není připojený)');
      switch (command.op) {
        case 'entry': {
          const spec = this.config.symbols[command.symbol];
          if (!spec) throw new BrokerRequestNotSentError(`kontrakt ${command.symbol} není povolený`);
          if (!Number.isInteger(command.quantity) || command.quantity < 1 || command.quantity > this.config.maxQuantity) {
            throw new BrokerRequestNotSentError(`množství ${command.quantity} je mimo povolený rozsah 1–${this.config.maxQuantity}`);
          }
          if (!command.clientId || this.seenClientIds.has(command.clientId)) throw new BrokerRequestNotSentError('příkaz s tímto clientId už byl přijat');
          const reference = command.orderType === 'Limit' ? command.limitPrice : command.referencePrice;
          const ticks = (price: number | undefined, sign: 1 | -1): number | undefined => {
            if (price === undefined) return undefined;
            if (typeof reference !== 'number' || !Number.isFinite(reference)) throw new BrokerRequestNotSentError('chybí cena, od které se počítá vzdálenost SL/TP');
            const distance = Math.round(((price - reference) * sign) / spec.tickSize);
            if (distance < 1) throw new BrokerRequestNotSentError('SL/TP je na špatné straně vstupu nebo příliš blízko');
            return distance;
          };
          const up: 1 | -1 = command.side === 'Buy' ? 1 : -1;
          const stopTicks = ticks(command.stopPrice, up === 1 ? -1 : 1);
          const targetTicks = ticks(command.targetPrice, up);
          if (command.orderType === 'Limit' && (typeof command.limitPrice !== 'number' || !Number.isFinite(command.limitPrice))) throw new BrokerRequestNotSentError('Limit bez ceny');
          this.seenClientIds.add(command.clientId);
          const request = {
            tag: `ui-${command.clientId}`.slice(0, 40), accountId, symbol: command.symbol, side: command.side, quantity: command.quantity,
            orderType: command.orderType, ...(command.orderType === 'Limit' ? { limitPrice: command.limitPrice } : {}),
          };
          if (stopTicks === undefined && targetTicks === undefined) {
            const ack = await this.broker.placeOrder(request);
            return { ok: true, result: { orderId: ack.brokerOrderId } };
          }
          const ack = await this.broker.placeBracket({ ...request, ...(stopTicks !== undefined ? { stopTicks } : {}), ...(targetTicks !== undefined ? { targetTicks } : {}) });
          return { ok: true, result: { orderId: ack.entryBrokerOrderId, stopTicks, targetTicks } };
        }
        case 'move': {
          const order = this.orders.get(command.orderId);
          if (!order || TERMINAL.has(order.status)) throw new BrokerRequestNotSentError(`příkaz ${command.orderId} nepracuje`);
          if (!Number.isFinite(command.price)) throw new BrokerRequestNotSentError('posun bez ceny');
          const isStop = order.stopPrice !== undefined && order.orderType !== 'Limit';
          await this.broker.modifyOrder(accountId, command.orderId, {
            quantity: order.quantity, orderType: isStop ? 'Stop' : 'Limit', ...(isStop ? { stopPrice: command.price } : { limitPrice: command.price }),
          });
          return { ok: true, result: { orderId: command.orderId } };
        }
        case 'cancel': {
          await this.broker.cancelOrder(accountId, command.orderId);
          return { ok: true, result: { orderId: command.orderId } };
        }
        case 'flatten': {
          if (!this.config.symbols[command.symbol]) throw new BrokerRequestNotSentError(`kontrakt ${command.symbol} není povolený`);
          if (!command.clientId) throw new BrokerRequestNotSentError('zavření bez clientId');
          const result = await this.broker.liquidatePosition({ tag: `ui-flat-${command.clientId}`.slice(0, 40), accountId, symbol: command.symbol });
          return { ok: true, result };
        }
        default:
          throw new BrokerRequestNotSentError('neznámý příkaz');
      }
    } catch (error) {
      const sent = error instanceof BrokerRequestNotSentError ? false : 'unknown';
      return { ok: false, sent, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
