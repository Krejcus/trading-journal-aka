/**
 * Napodobený Rithmic server pro testy klienta (bez sítě). Kóduje NAŠE
 * předpoklady o chování R | Protocol API — skutečné chování ověřují skripty
 * proti Rithmic Test, ne tenhle soubor.
 */
import { decodeRithmicFrames, encodeRithmicFrame, type RithmicFields } from '../services/rithmic/rithmicCodec';
import type { RithmicSocketLike } from '../services/rithmic/rithmicPlant';

export interface FakeOrder {
  basketId: string;
  accountId: string;
  userTag: string;
  symbol: string;
  exchange: string;
  side: number;
  priceType: number;
  quantity: number;
  price?: number;
  triggerPrice?: number;
  status: 'open' | 'complete' | 'cancelled';
  filled: number;
  stopTicks?: number;
  targetTicks?: number;
  linked?: string;
}

export interface FakeRithmicOptions {
  accounts?: string[];
  password?: string;
  tickSize?: number;
}

export function createFakeRithmicServer(options: FakeRithmicOptions = {}) {
  const accounts = options.accounts ?? ['ACC1'];
  const password = options.password ?? 'secret';
  const tickSize = options.tickSize ?? 0.25;
  const orders = new Map<string, FakeOrder>();
  const sockets: FakeSocket[] = [];
  const received: Array<{ templateId: number; fields: RithmicFields }> = [];
  let basketSeq = 100;
  const controls = {
    /** Přijme další nový příkaz, ale spojení shodí dřív, než pošle potvrzení. */
    dropNextOrderBeforeAck: false,
    /** Na další nový příkaz neodpoví vůbec (timeout). */
    ignoreNextOrder: false,
    rejectNextOrder: false as false | string,
    frontMonth: 'ESZ6' as string | null,
  };

  class FakeSocket implements RithmicSocketLike {
    binaryType?: string;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event?: unknown) => void) | null = null;
    onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
    infra = 0;
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    push(templateId: number, fields: RithmicFields): void {
      if (this.readyState !== 1) return;
      const frame = encodeRithmicFrame(templateId, fields);
      queueMicrotask(() => {
        if (this.readyState === 1) this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
      });
    }
    send(data: Uint8Array): void {
      if (this.readyState !== 1) throw new Error('socket closed');
      for (const message of decodeRithmicFrames(data)) {
        received.push({ templateId: message.templateId, fields: message.fields });
        handle(this, message.templateId, message.fields);
      }
    }
    close(code = 1000, reason = ''): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }
    /** Pád ze strany serveru / sítě. */
    drop(code = 1006): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({ code, reason: 'dropped' }));
    }
  }

  function orderSockets(): FakeSocket[] {
    return sockets.filter((s) => s.readyState === 1 && s.infra === 2);
  }

  function notify(order: FakeOrder, exchangeType: number, rithmicType: number | null, extra: RithmicFields = {}, snapshotTo?: FakeSocket): void {
    const common: RithmicFields = {
      account_id: order.accountId,
      basket_id: order.basketId,
      user_tag: order.userTag,
      symbol: order.symbol,
      exchange: order.exchange,
      quantity: order.quantity,
      price: order.price,
      trigger_price: order.triggerPrice,
      transaction_type: order.side,
      price_type: order.priceType,
      status: order.status,
      linked_basket_ids: order.linked,
      total_fill_size: order.filled,
      total_unfilled_size: order.quantity - order.filled,
      ssboe: 1_800_000_000,
      usecs: 0,
    };
    if (snapshotTo) {
      snapshotTo.push(352, { ...common, notify_type: exchangeType, is_snapshot: true, ...extra });
      return;
    }
    for (const socket of orderSockets()) {
      if (rithmicType !== null) socket.push(351, { ...common, notify_type: rithmicType });
      socket.push(352, { ...common, notify_type: exchangeType, ...extra });
    }
  }

  function createOrder(fields: RithmicFields): FakeOrder {
    const order: FakeOrder = {
      basketId: String(++basketSeq),
      accountId: String(fields.account_id),
      userTag: String(fields.user_tag ?? ''),
      symbol: String(fields.symbol),
      exchange: String(fields.exchange),
      side: Number(fields.transaction_type),
      priceType: Number(fields.price_type),
      quantity: Number(fields.quantity),
      price: fields.price as number | undefined,
      triggerPrice: fields.trigger_price as number | undefined,
      status: 'open',
      filled: 0,
      stopTicks: fields.stop_ticks as number | undefined,
      targetTicks: fields.target_ticks as number | undefined,
    };
    orders.set(order.basketId, order);
    return order;
  }

  function fill(basketId: string, price: number): void {
    const order = orders.get(basketId);
    if (!order || order.status !== 'open') throw new Error(`fake: příkaz ${basketId} nejde vyplnit`);
    order.filled = order.quantity;
    order.status = 'complete';
    notify(order, 5, 15, { fill_price: price, fill_size: order.quantity, fill_id: `F${basketId}` });
    const opposite = order.side === 1 ? 2 : 1;
    const direction = order.side === 1 ? 1 : -1;
    const legs: FakeOrder[] = [];
    if (order.stopTicks) {
      legs.push(createOrder({
        account_id: order.accountId, user_tag: order.userTag, symbol: order.symbol, exchange: order.exchange,
        transaction_type: opposite, price_type: 4, quantity: order.quantity,
        trigger_price: price - direction * order.stopTicks * tickSize,
      }));
    }
    if (order.targetTicks) {
      legs.push(createOrder({
        account_id: order.accountId, user_tag: order.userTag, symbol: order.symbol, exchange: order.exchange,
        transaction_type: opposite, price_type: 1, quantity: order.quantity,
        price: price + direction * order.targetTicks * tickSize,
      }));
    }
    for (const leg of legs) {
      leg.linked = [order.basketId, ...legs.filter((l) => l !== leg).map((l) => l.basketId)].join(',');
      notify(leg, 1, 13, { original_basket_id: order.basketId });
    }
    if (legs.length) {
      for (const socket of orderSockets()) {
        socket.push(353, {
          account_id: order.accountId, basket_id: order.basketId,
          stop_ticks: order.stopTicks, stop_quantity: order.stopTicks ? order.quantity : undefined,
          stop_quantity_released: order.stopTicks ? order.quantity : undefined,
          target_ticks: order.targetTicks, target_quantity: order.targetTicks ? order.quantity : undefined,
          target_quantity_released: order.targetTicks ? order.quantity : undefined,
        });
      }
    }
  }

  function handle(socket: FakeSocket, templateId: number, f: RithmicFields): void {
    const userMsg = f.user_msg as string[] | undefined;
    const ok = (extra: RithmicFields = {}) => socket.push(templateId + 1, { user_msg: userMsg, rp_code: ['0'], ...extra });
    const row = (extra: RithmicFields) => socket.push(templateId + 1, { user_msg: userMsg, rq_handler_rp_code: ['0'], ...extra });
    switch (templateId) {
      case 10:
        if (f.password !== password) {
          socket.push(11, { user_msg: userMsg, rp_code: ['13', 'permission denied'] });
          return;
        }
        socket.infra = Number(f.infra_type);
        ok({ fcm_id: 'FCM', ib_id: 'IB', heartbeat_interval: 60 });
        return;
      case 12:
      case 18:
        if (templateId === 18) socket.push(19, { rp_code: ['0'] });
        return;
      case 300:
        ok({ fcm_id: 'FCM', ib_id: 'IB', user_type: 3 });
        return;
      case 302:
        for (const account of accounts) row({ fcm_id: 'FCM', ib_id: 'IB', account_id: account, account_name: `Name ${account}` });
        ok();
        return;
      case 310:
        row({ fcm_id: 'FCM', ib_id: 'IB', exchange: 'CME', trade_route: 'globex', is_default: true });
        ok();
        return;
      case 308:
      case 336:
      case 400:
      case 100:
        ok();
        return;
      case 402:
        for (const s of sockets.filter((x) => x.readyState === 1 && x.infra === 4)) {
          s.push(450, { is_snapshot: true, account_id: String(f.account_id), symbol: 'ESZ6', exchange: 'CME', net_quantity: 0 });
          s.push(451, { is_snapshot: true, account_id: String(f.account_id), account_balance: '50000', day_pnl: '0' });
        }
        ok();
        return;
      case 113:
        if (controls.frontMonth) ok({ trading_symbol: controls.frontMonth });
        else socket.push(114, { user_msg: userMsg, rp_code: ['7', 'no data'] });
        return;
      case 312:
      case 330: {
        if (controls.ignoreNextOrder) {
          controls.ignoreNextOrder = false;
          return;
        }
        if (controls.rejectNextOrder) {
          const reason = controls.rejectNextOrder;
          controls.rejectNextOrder = false;
          socket.push(templateId + 1, { user_msg: userMsg, rp_code: ['6', reason] });
          return;
        }
        const order = createOrder(f);
        if (controls.dropNextOrderBeforeAck) {
          controls.dropNextOrderBeforeAck = false;
          socket.drop();
          return;
        }
        ok({ basket_id: order.basketId, user_tag: order.userTag });
        notify(order, 1, 13);
        return;
      }
      case 314: {
        const order = orders.get(String(f.basket_id));
        if (!order || order.status !== 'open') {
          socket.push(315, { user_msg: userMsg, rp_code: ['6', 'order not found'] });
          return;
        }
        order.price = f.price as number | undefined;
        order.triggerPrice = f.trigger_price as number | undefined;
        order.quantity = Number(f.quantity);
        ok();
        notify(order, 2, 14);
        return;
      }
      case 316: {
        const order = orders.get(String(f.basket_id));
        if (!order || order.status !== 'open') {
          socket.push(317, { user_msg: userMsg, rp_code: ['6', 'order not found'] });
          return;
        }
        order.status = 'cancelled';
        ok();
        notify(order, 3, 15);
        return;
      }
      case 320:
      case 324:
        for (const order of orders.values()) {
          if (order.accountId !== String(f.account_id)) continue;
          if (templateId === 320 && order.status !== 'open') continue;
          notify(order, 1, null, {}, socket);
        }
        ok();
        return;
      default:
        socket.push(75, { user_msg: userMsg, rp_code: ['1', 'unsupported in fake'] });
    }
  }

  return {
    socketFactory: () => new FakeSocket(),
    orders,
    received,
    sockets,
    controls,
    fill,
    forceLogout(): void {
      for (const socket of sockets) if (socket.readyState === 1) socket.push(77, {});
    },
    newOrderFrames(): number {
      return received.filter((r) => r.templateId === 312 || r.templateId === 330).length;
    },
  };
}

export async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}
