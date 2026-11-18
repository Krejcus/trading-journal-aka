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
  status: 'open' | 'complete' | 'cancelled' | 'rms-rejected';
  filled: number;
  stopTicks?: number;
  targetTicks?: number;
  linked?: string;
  /** Platnost z požadavku: 1 = do konce dne, 2 = do zrušení (GTC). */
  duration?: number;
  /** Svázaný pár (OCO): společný klíč obou příkazů. */
  oco?: string;
  /** Rodič nohy bracketu (original_basket_id). */
  parent?: string;
  /** Číselný BracketType (6 = TARGET_AND_STOP_STATIC); nesou ho rodič i nohy. */
  bracketType?: number;
}

export interface FakeRithmicOptions {
  accounts?: string[];
  password?: string;
  tickSize?: number;
  exitPrice?: () => number;
  /** Čas zpráv o příkazech v sekundách (výchozí pevná hodnota kvůli opakovatelným testům). */
  nowSeconds?: () => number;
}

export function createFakeRithmicServer(options: FakeRithmicOptions = {}) {
  const accounts = options.accounts ?? ['ACC1'];
  const password = options.password ?? 'secret';
  const tickSize = options.tickSize ?? 0.25;
  const orders = new Map<string, FakeOrder>();
  /** `účet|symbol` → čistá pozice */
  const positions = new Map<string, number>();
  /** Průměrná cena otevřené pozice (vážený průměr vstupů; zmenšení ji nemění) — jako u skutečného brokera. */
  const averages = new Map<string, number>();
  const sockets: FakeSocket[] = [];
  const received: Array<{ templateId: number; fields: RithmicFields }> = [];
  let basketSeq = 100;
  /** Háček pro testy závodů: zavolá se při každém přijatém požadavku, před jeho zpracováním. */
  const heldExits: string[] = [];
  const hooks: { onRequest?: (templateId: number, fields: RithmicFields, socket: FakeSocket) => void } = {};
  const controls = {
    /** Přijme další nový příkaz, ale spojení shodí dřív, než pošle potvrzení. */
    dropNextOrderBeforeAck: false,
    /** Na další nový příkaz neodpoví vůbec (timeout). */
    ignoreNextOrder: false,
    rejectNextOrder: false as false | string,
    /** Další příkaz Rithmic přijme (vrátí basket_id) a hned odmítne na RMS — jen 351, žádná burza. */
    rmsRejectNextOrder: false as false | string,
    frontMonth: 'ESZ6' as string | null,
    /** Server přestane odpovídat na heartbeat (tiché spojení bez zavření). */
    silent: false,
    /** FCM, který vrátí seznam účtů (302) — změna za běhu = jiná identita účtu. */
    accountFcm: 'FCM',
    /** Dotaz na RMS (304) selže. */
    rmsFails: false,
    /** Na snímek příkazů (320) server neodpoví (timeout). */
    ignoreShowOrders: false,
    /** Text stavu, který snímek vrátí u pracujících příkazů (pro test nevyložitelného řádku). */
    openStatusText: 'open',
    /** Stav účtu v RMS (dotaz 304). */
    rmsStatus: 'active',
    /** Zrušení neexistujícího příkazu vrátí „ok" (změřené chování). */
    cancelUnknownOk: true,
    /** Snímek pozic neobsahuje řádek účtu (451) — není to důkaz stavu. */
    pnlWithoutAccountRow: false,
    /** Snímek pozic pošle řádek bez množství. */
    positionWithoutQuantity: false,
    /** Seznam účtů vrátí stejný účet dvakrát. */
    duplicateAccount: false,
    /** Po vyplnění vstupu bracketu nohy nevzniknou vůbec / vznikne jen TP. */
    legsNeverAppear: false,
    onlyTargetLeg: false,
    /** Nohy vzniknou, ale žádná zpráva nenese vazbu na rodiče. */
    legsWithoutLink: false,
    /** Nenormální případ: po vyplnění nohy sestra dál pracuje (osiřelá noha). */
    sisterStaysAfterFill: false,
    /** Živé zprávy o pozici (450) po vyplnění nepřijdou — PnL spojení je pozadu za order spojením. */
    muteLivePositions: false,
    /** Zavření (3504) server přijme a příkaz vytvoří, ale vyplní ho až `releaseExit()`. */
    delayExitFill: false,
    /** Zrušení odpoví „ok", ale příkaz pracuje dál. */
    cancelStuck: false,
    /** Zavření pozice (3504): 'ignore' = bez odpovědi, text = odmítnutí. */
    exitPosition: 'ok' as 'ok' | 'ignore' | string,
    /** Snímek P&L bez řádků pozic i bez ukončení (pro test neúplného snímku). */
    pnlSnapshotFails: false,
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
        hooks.onRequest?.(message.templateId, message.fields, this);
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
      status: order.status === 'open' ? (snapshotTo ? controls.openStatusText : 'open') : 'complete',
      linked_basket_ids: order.linked,
      original_basket_id: order.parent,
      bracket_type: order.bracketType,
      total_fill_size: order.filled,
      total_unfilled_size: order.quantity - order.filled,
      ssboe: options.nowSeconds?.() ?? 1_800_000_000,
      usecs: 0,
    };
    if (snapshotTo) {
      snapshotTo.push(352, { ...common, notify_type: exchangeType, is_snapshot: true, ...extra });
      return;
    }
    for (const socket of orderSockets()) {
      if (rithmicType !== null) {
        // Změřeno: COMPLETE nese důvod F (vyplněno) nebo C (zrušeno).
        const reason = rithmicType === 15 ? (exchangeType === 5 ? 'F' : exchangeType === 3 ? 'C' : undefined) : undefined;
        socket.push(351, { ...common, notify_type: rithmicType, ...(reason ? { completion_reason: reason } : {}) });
      }
      socket.push(352, { ...common, notify_type: exchangeType, ...extra });
    }
  }

  function rithmicFields(order: FakeOrder): RithmicFields {
    return {
      account_id: order.accountId, basket_id: order.basketId, user_tag: order.userTag, symbol: order.symbol, exchange: order.exchange,
      quantity: order.quantity, price: order.price, transaction_type: order.side, price_type: order.priceType, ssboe: options.nowSeconds?.() ?? 1_800_000_000, usecs: 0,
    };
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
      duration: typeof fields.duration === 'number' ? fields.duration : undefined,
      quantity: Number(fields.quantity),
      price: fields.price as number | undefined,
      triggerPrice: fields.trigger_price as number | undefined,
      status: 'open',
      filled: 0,
      stopTicks: fields.stop_ticks as number | undefined,
      targetTicks: fields.target_ticks as number | undefined,
      bracketType: fields.bracket_type as number | undefined,
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
    const posKey = `${order.accountId}|${order.symbol}`;
    const before = positions.get(posKey) ?? 0;
    const net = before + (order.side === 1 ? order.quantity : -order.quantity);
    positions.set(posKey, net);
    const grows = before === 0 || Math.sign(net) !== Math.sign(before) || Math.abs(net) > Math.abs(before);
    const average = net === 0 ? price
      : before === 0 || Math.sign(net) !== Math.sign(before) ? price
      : grows ? ((averages.get(posKey) ?? price) * Math.abs(before) + price * order.quantity) / Math.abs(net)
      : averages.get(posKey) ?? price;
    averages.set(posKey, average);
    for (const s of controls.muteLivePositions ? [] : sockets.filter((x) => x.readyState === 1 && x.infra === 4)) {
      s.push(450, { account_id: order.accountId, symbol: order.symbol, exchange: order.exchange, net_quantity: net, avg_open_fill_price: average });
    }
    // Změřeno: vyplnění jedné nohy bracketu zruší její sestru.
    if ((order.parent || order.oco) && !controls.sisterStaysAfterFill) {
      for (const sister of [...orders.values()].filter((o) => (order.parent ? o.parent === order.parent : o.oco === order.oco) && o !== order && o.status === 'open')) {
        sister.status = 'cancelled';
        notify(sister, 3, 15);
      }
    }
    const opposite = order.side === 1 ? 2 : 1;
    const direction = order.side === 1 ? 1 : -1;
    const legs: FakeOrder[] = [];
    if (controls.legsNeverAppear) return;
    // Změřeno (scénář H): nohy nenesou user_tag; množství = množství vstupu.
    if (order.stopTicks && !controls.onlyTargetLeg) {
      legs.push(createOrder({
        account_id: order.accountId, symbol: order.symbol, exchange: order.exchange,
        transaction_type: opposite, price_type: 4, quantity: order.quantity,
        trigger_price: price - direction * order.stopTicks * tickSize,
      }));
    }
    if (order.targetTicks) {
      legs.push(createOrder({
        account_id: order.accountId, symbol: order.symbol, exchange: order.exchange,
        transaction_type: opposite, price_type: 1, quantity: order.quantity,
        price: price + direction * order.targetTicks * tickSize,
      }));
    }
    for (const leg of legs) {
      leg.bracketType = order.bracketType ?? 6;
      // První zpráva nohy nese jen bracket_type; vazby až od druhé.
      for (const socket of orderSockets()) socket.push(351, { ...rithmicFields(leg), bracket_type: leg.bracketType, notify_type: 1, status: 'Order received from client' });
    }
    for (const leg of legs) {
      if (!controls.legsWithoutLink) {
        leg.parent = order.basketId;
        leg.linked = legs.map((l) => l.basketId).join(',');
      }
      for (const socket of orderSockets()) {
        socket.push(351, { ...rithmicFields(leg), bracket_type: leg.bracketType, original_basket_id: leg.parent, linked_basket_ids: leg.linked, notify_type: 4, status: 'open pending' });
      }
      notify(leg, 1, leg.priceType === 4 ? 18 : 13);
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
        if (templateId === 18 && !controls.silent) socket.push(19, { rp_code: ['0'] });
        return;
      case 300:
        ok({ fcm_id: 'FCM', ib_id: 'IB', user_type: 3 });
        return;
      case 302:
        for (const account of accounts) row({ fcm_id: controls.accountFcm, ib_id: 'IB', account_id: account, account_name: `Name ${account}` });
        if (controls.duplicateAccount) row({ fcm_id: 'FCM2', ib_id: 'IB', account_id: accounts[0], account_name: 'dup' });
        ok();
        return;
      case 304:
        if (controls.rmsFails) {
          socket.push(305, { user_msg: userMsg, rp_code: ['6', 'rms unavailable'] });
          return;
        }
        for (const account of accounts) row({ fcm_id: 'FCM', ib_id: 'IB', account_id: account, status: controls.rmsStatus, presence_bits: 139, buy_limit: 20, sell_limit: 20, max_order_quantity: 40 });
        ok();
        return;
      case 306:
        row({ fcm_id: 'FCM', ib_id: 'IB', account_id: f.account_id, product_code: 'MNQ', presence_bits: 11, buy_limit: 10, sell_limit: 10, max_order_quantity: 10 });
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
        if (controls.pnlSnapshotFails) {
          socket.push(403, { user_msg: userMsg, rp_code: ['6', 'snapshot unavailable'] });
          return;
        }
        for (const [key, net] of positions) {
          const [accountId, symbol] = key.split('|');
          if (accountId !== String(f.account_id)) continue;
          socket.push(450, { is_snapshot: true, account_id: accountId, symbol, exchange: 'CME', ...(controls.positionWithoutQuantity ? {} : { net_quantity: net }) });
        }
        if (!controls.pnlWithoutAccountRow) {
          socket.push(451, { is_snapshot: true, account_id: String(f.account_id), account_balance: '50000', day_pnl: '0', closed_position_pnl: '125.5', open_position_pnl: '-12.5' });
        }
        ok();
        return;
      case 113:
        if (controls.frontMonth) ok({ trading_symbol: controls.frontMonth });
        else socket.push(114, { user_msg: userMsg, rp_code: ['7', 'no data'] });
        return;
      case 328: {
        // Svázaný pár (změřeno 17. 11. 2026): dvě ID v odpovědi, obě nohy nesou vazbu i vlastní značku.
        if (controls.rejectNextOrder) {
          const reason = controls.rejectNextOrder;
          controls.rejectNextOrder = false;
          socket.push(329, { user_msg: userMsg, rp_code: ['6', reason] });
          return;
        }
        if (controls.ignoreNextOrder) { controls.ignoreNextOrder = false; return; }
        const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
        const pair = [0, 1].map((i) => createOrder({
          account_id: f.account_id, user_tag: list(f.user_tag)[i], symbol: list(f.symbol)[i], exchange: list(f.exchange)[i],
          transaction_type: list(f.transaction_type)[i], price_type: list(f.price_type)[i], quantity: Number(list(f.quantity_64)[i]), duration: list(f.duration)[i],
          ...(Number(list(f.price_type)[i]) === 1 ? { price: list(f.price)[i] } : { trigger_price: list(f.trigger_price)[i] }),
        } as RithmicFields));
        const key = `oco${pair[0].basketId}`;
        for (const order of pair) { order.oco = key; order.linked = pair.map((o) => o.basketId).join(','); }
        row({ basket_id: pair.map((o) => o.basketId), user_tag: pair.map((o) => o.userTag) });
        ok();
        for (const order of pair) notify(order, 1, 13);
        return;
      }
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
        // Změřeno: basket_id je v datovém řádku odpovědi, konečná odpověď ho nenese.
        row({ basket_id: order.basketId, user_tag: order.userTag });
        ok();
        if (controls.rmsRejectNextOrder) {
          const reason = controls.rmsRejectNextOrder;
          controls.rmsRejectNextOrder = false;
          order.status = 'rms-rejected';
          for (const s of orderSockets()) {
            s.push(351, { ...rithmicFields(order), notify_type: 1, status: 'Order received from client' });
            s.push(351, { ...rithmicFields(order), notify_type: 15, status: 'complete', completion_reason: 'FA', text: reason });
          }
          return;
        }
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
        const quantityChanged = order.quantity !== Number(f.quantity);
        order.quantity = Number(f.quantity);
        // Rithmic Test, measureLegQuantity: resizing an active bracket leg also resizes its sister.
        if (quantityChanged && order.parent) {
          for (const sibling of orders.values()) {
            if (sibling !== order && sibling.parent === order.parent && sibling.status === 'open') {
              sibling.quantity = order.quantity;
              notify(sibling, 2, 14);
            }
          }
        }
        ok();
        notify(order, 2, 14);
        return;
      }
      case 316: {
        const order = orders.get(String(f.basket_id));
        if (!order || order.status !== 'open') {
          if (controls.cancelUnknownOk) {
            ok();
            // Změřeno: zrušení už dokončeného příkazu = „ok" a pak 351 CANCELLATION_FAILED.
            if (order) for (const s of orderSockets()) s.push(351, { account_id: order.accountId, basket_id: order.basketId, transaction_type: order.side, notify_type: 17, status: 'Cancellation Failed', text: 'Cancellation rejected by the Order Management System' });
          } else socket.push(317, { user_msg: userMsg, rp_code: ['6', 'order not found'] });
          return;
        }
        ok();
        if (controls.cancelStuck) return;
        // Změřeno: zrušení jedné nohy bracketu zruší i sestru.
        const group = order.parent ? [...orders.values()].filter((o) => o.parent === order.parent && o.status === 'open')
          : order.oco ? [...orders.values()].filter((o) => o.oco === order.oco && o.status === 'open') : [order];
        for (const member of [order, ...group.filter((o) => o !== order)]) {
          member.status = 'cancelled';
          notify(member, 3, 15);
        }
        return;
      }
      case 3504: {
        if (controls.exitPosition === 'ignore') return;
        if (controls.exitPosition !== 'ok') {
          socket.push(3505, { user_msg: userMsg, rp_code: ['6', controls.exitPosition] });
          return;
        }
        ok();
        // Změřeno: na flat účtu nevznikne nic; jinak samostatný MARKET bez značky a bez vazby.
        const posKey = `${String(f.account_id)}|${String(f.symbol)}`;
        const net = positions.get(posKey) ?? 0;
        if (net === 0) return;
        const exit = createOrder({ account_id: f.account_id, symbol: f.symbol, exchange: f.exchange, transaction_type: net > 0 ? 2 : 1, price_type: 2, quantity: Math.abs(net) });
        notify(exit, 1, 13);
        if (controls.delayExitFill) heldExits.push(exit.basketId);
        else fill(exit.basketId, options.exitPrice?.() ?? 7000);
        return;
      }
      case 320:
        if (controls.ignoreShowOrders) return;
        // Změřeno: 320 vrací pracující i dnešní dokončené; odmítnuté na RMS jen jako 351.
        for (const order of orders.values()) {
          if (order.accountId !== String(f.account_id)) continue;
          if (order.status === 'rms-rejected') {
            socket.push(351, { ...rithmicFields(order), is_snapshot: true, notify_type: 15, status: 'complete', completion_reason: 'FA', text: 'Rejected at RMS' });
            continue;
          }
          notify(order, order.status === 'cancelled' ? 3 : order.filled >= order.quantity && order.quantity > 0 ? 5 : 1, null, {}, socket);
        }
        ok();
        return;
      case 324:
        // Změřeno: historie pro dnešní den vrací prázdno.
        socket.push(325, { user_msg: userMsg, rp_code: ['7', 'no data'] });
        return;
      default:
        socket.push(75, { user_msg: userMsg, rp_code: ['1', 'unsupported in fake'] });
    }
  }

  return {
    socketFactory: () => new FakeSocket(),
    hooks,
    /** Živá zpráva o pozici z PnL plantu (průběžný P&L posílá stejné množství opakovaně). */
    pushLivePosition(accountId: string, symbol: string, net: number): void {
      for (const s of sockets.filter((x) => x.readyState === 1 && x.infra === 4)) {
        s.push(450, { account_id: accountId, symbol, exchange: 'CME', net_quantity: net });
      }
    },
    /** Živá burzovní notifikace o příkazu (pro testy závodů). */
    /** Vyplní zavírací příkazy zadržené přes `delayExitFill`. */
    releaseExit(): void {
      for (const id of heldExits.splice(0)) fill(id, options.exitPrice?.() ?? 7000);
    },
    notifyLive(basketId: string, exchangeType: number, extra: RithmicFields = {}): void {
      const order = orders.get(basketId);
      if (!order) throw new Error(`fake: příkaz ${basketId} neexistuje`);
      notify(order, exchangeType, null, extra);
    },
    orders,
    positions,
    received,
    sockets,
    controls,
    fill,
    forceLogout(): void {
      for (const socket of sockets) if (socket.readyState === 1) socket.push(77, {});
    },
    newOrderFrames(): number {
      return received.filter((r) => r.templateId === 312 || r.templateId === 330 || r.templateId === 328).length;
    },
  };
}

export async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}
