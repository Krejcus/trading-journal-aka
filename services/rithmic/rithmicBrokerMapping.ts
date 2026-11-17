/**
 * Čisté mapování notifikací Rithmicu na neutrální typy `BrokerPort`.
 * Bez IO a bez časovačů — stavový stroj příkazů jednoho přihlášení.
 *
 * Zásady (viz docs/reviews/rithmic-broker-v0-design-20261116.md):
 *  - typ, který neznáme, je `Unsupported` a čtení nikdy nespadne (INV-TRAD-07);
 *  - konečný stav se už neoživí a `filledQuantity` nikdy neklesá;
 *  - fill vzniká jen z burzovní notifikace FILL s vlastním ID exekuce;
 *  - snímek je baseline, nikdy živá událost ani fill (INV-TRAD-01).
 */
import type {
  BrokerFill,
  BrokerOrder,
  ObservedOrderType,
  OrderSide,
  OrderStatus,
  OrderType,
} from '../brokerPort';
import type { RithmicOrderUpdate, RithmicPriceType } from './rithmicClient';

/** Burza podle rootu kontraktu. Neznámý root = příkaz se neodešle. */
const EXCHANGE_BY_ROOT: Readonly<Record<string, string>> = {
  ES: 'CME', MES: 'CME', NQ: 'CME', MNQ: 'CME', RTY: 'CME', M2K: 'CME',
  YM: 'CBOT', MYM: 'CBOT',
  CL: 'NYMEX', MCL: 'NYMEX',
  GC: 'COMEX', MGC: 'COMEX',
};

/** `MNQZ6` → `MNQ`; null, když symbol nevypadá jako futures kontrakt. */
export function rithmicContractRoot(symbol: string): string | null {
  const match = /^([A-Z0-9]{1,4}?)([FGHJKMNQUVXZ])(\d{1,2})$/.exec(symbol);
  return match ? match[1] : null;
}

export function rithmicExchangeForSymbol(symbol: string): string | null {
  const root = rithmicContractRoot(symbol);
  return root ? EXCHANGE_BY_ROOT[root] ?? null : null;
}

const PRICE_TYPE_BY_ORDER_TYPE: Readonly<Record<OrderType, RithmicPriceType>> = {
  Market: 'MARKET',
  Limit: 'LIMIT',
  Stop: 'STOP_MARKET',
  StopLimit: 'STOP_LIMIT',
};
const ORDER_TYPE_BY_PRICE_TYPE: Readonly<Record<string, OrderType>> = {
  MARKET: 'Market',
  LIMIT: 'Limit',
  STOP_MARKET: 'Stop',
  STOP_LIMIT: 'StopLimit',
};

export const rithmicPriceType = (orderType: OrderType): RithmicPriceType => PRICE_TYPE_BY_ORDER_TYPE[orderType];
export const rithmicSide = (side: OrderSide): 'BUY' | 'SELL' => (side === 'Buy' ? 'BUY' : 'SELL');

const TERMINAL: ReadonlySet<OrderStatus> = new Set(['filled', 'canceled', 'rejected']);
const RITHMIC_PENDING: ReadonlySet<string> = new Set([
  'ORDER_RCVD_FROM_CLNT', 'OPEN_PENDING', 'ORDER_RCVD_BY_EXCH_GTWY', 'ORDER_SENT_TO_EXCH', 'TRIGGER_PENDING',
]);
const EXCHANGE_WORKING: ReadonlySet<string> = new Set(['STATUS', 'MODIFY', 'TRIGGER']);

export interface RithmicOrderDelta {
  /** Nový stav příkazu, když se něco změnilo. */
  order?: BrokerOrder;
  fill?: BrokerFill;
  /** Notifikace, kterou nejde bezpečně vyložit — volající má stav ověřit čtením. */
  attention?: string;
  /** Rithmic hlásí vyplnění, burzovní exekuce ještě nepřišla: hlídat lhůtu. */
  awaitingFill?: boolean;
  /**
   * Stav nejde určit z notifikací, musí se přečíst snímek:
   * `incomplete` = první notifikace příkazu nenesla stranu/množství/symbol;
   * `unknown-complete` = Rithmic ohlásil dokončení s důvodem, který neznáme.
   */
  needsRead?: 'incomplete' | 'unknown-complete';
}

export interface RithmicOrderBookOptions {
  /** Interní číslo účtu pro text účtu Rithmicu; null = účet neznáme (událost se zahodí s `attention`). */
  accountNumber(accountId: string): number | null;
  now(): number;
}

function observedType(priceType: string): { orderType: ObservedOrderType; brokerOrderType?: string } {
  const known = ORDER_TYPE_BY_PRICE_TYPE[priceType];
  if (known) return { orderType: known };
  return { orderType: 'Unsupported', brokerOrderType: (priceType || 'UNSPECIFIED').slice(0, 32) };
}

/**
 * Příkaz, který je součástí bracketu Rithmicu (rodič s nohami nebo noha). Verze 0 brackety
 * neumí zadat ani spravovat, takže každý takový příkaz je cizí aktivní příkaz: blokuje,
 * nikdy se nekopíruje ani nemodifikuje (INV-TRAD-07), a jádro ho nesmí poslat dál jako
 * obyčejný vstup bez ochrany.
 */
function bracketKind(update: RithmicOrderUpdate): string | null {
  if (update.bracketType && update.bracketType !== 'BRACKETTYPE_UNSPECIFIED') return `BRACKET:${update.bracketType}`;
  if (update.originalBasketId && update.originalBasketId !== update.basketId) return 'BRACKET:LEG';
  if (update.linkedBasketIds) return 'BRACKET:LINKED';
  return null;
}

/**
 * Stav řádku snímku (pracující příkazy, historie dne). Na rozdíl od živé notifikace tu
 * `notify_type` nic neříká — rozhoduje text stavu. Slovník je zatím jen to, co známe;
 * neznámý text vrací null a volající snímek odmítne (raději nic než hádaný stav).
 */
export function rithmicSnapshotStatus(row: RithmicOrderUpdate, quantity: number, filledQuantity: number): OrderStatus | null {
  // Slovník změřený 16. 11. 2026 na Rithmic Test (scripts/rithmic/results):
  //   pracující: "open", "modified", "trigger pending", "modified, trigger pending"
  //   (stop čekající na spuštění je potvrzený burzou — je to pracující příkaz, ne nepotvrzený);
  //   dokončené: status "complete" + typ posledního hlášení FILL / CANCEL / REJECT,
  //   u příkazu odmítnutého Rithmicem (RMS) completion_reason "FA", burzou "R", zrušený "C", vyplněný "F".
  const status = row.status.trim().toLowerCase();
  const reason = row.completionReason.trim().toLowerCase();
  const report = row.reportType.trim().toLowerCase();
  if (status === 'open' || status === 'partial' || status === 'modified' || status === 'trigger pending' || status === 'modified, trigger pending') {
    return 'working';
  }
  if (status === 'open pending' || status === 'modify pending' || status === 'cancel pending') return 'pending';
  if (status === 'cancelled' || status === 'canceled') return 'canceled';
  if (status === 'rejected' || status === 'failed' || status === 'failure') return 'rejected';
  if (status === 'complete' || status === 'completed') {
    if (quantity > 0 && filledQuantity >= quantity) return 'filled';
    if (row.notifyType === 'CANCEL' || report === 'cancel' || reason === 'c') return 'canceled';
    if (row.notifyType === 'REJECT' || report === 'reject' || reason === 'r' || reason === 'fa') return 'rejected';
    return null;
  }
  return null;
}

/**
 * Verze příkazu je funkcí STAVU, ne zprávy: stejný stav ze živé notifikace i ze snímku
 * musí dát stejnou verzi (jádro z ní skládá signaturu a porovnává snímek se streamem),
 * a konečný stav ji už nemění.
 */
function stateVersion(order: Omit<BrokerOrder, 'sourceVersion'>): string {
  // U konečného stavu se vyplněné množství do verze nepočítá: pozdní dílčí fill po zrušení
  // by jinak změnil signaturu a jádro by vydalo druhé `canceled`. Fill sám se vydá zvlášť.
  const filled = TERMINAL.has(order.status) && order.status !== 'filled' ? '' : order.filledQuantity;
  return [order.status, order.orderType, order.quantity, order.limitPrice ?? '', order.stopPrice ?? '', filled].join(':');
}

/**
 * Notifikace, které smějí změnit tvar existujícího příkazu (cena, množství, typ).
 * Jen burza: dva zdroje s různými razítky (351 a 352) by při opožděné zprávě vrátily starou cenu.
 */
function confirmsShape(update: RithmicOrderUpdate): boolean {
  return update.source === 'exchange' && (update.notifyType === 'STATUS' || update.notifyType === 'MODIFY' || update.notifyType === 'TRIGGER');
}

export class RithmicOrderBook {
  private readonly options: RithmicOrderBookOptions;
  private readonly orders = new Map<string, BrokerOrder>();
  private readonly fillIds = new Set<string>();
  /**
   * Kolik kusů příkazu už jádro „ví": součet vyslaných fillů, u příkazu z výchozího stavu
   * jeho množství ve snímku (filly ze snímku se nevysílají). Rozdíl proti vyplněnému množství
   * = exekuce, která jádru chybí.
   */
  private readonly accounted = new Map<string, number>();
  /** Kolik kusů Rithmic ohlásil jako vyplněné, aniž by zpráva nesla množství (COMPLETE s důvodem F). */
  private readonly owed = new Map<string, number>();
  /**
   * Kolik kusů prokazatelně vyplnila burza, ale zpráva o exekuci byla nepoužitelná (FILL bez ID,
   * ceny nebo množství). Lepkavý počet: přičítá se k mezeře a maže ho jen nový výchozí stav
   * nebo `reset()` — nikdy zrušení příkazu ani fill jiné exekuce.
   */
  private readonly proven = new Map<string, number>();

  constructor(options: RithmicOrderBookOptions) {
    this.options = options;
  }

  private key(accountId: number, basketId: string): string {
    return `${accountId}:${basketId}`;
  }

  get(accountId: number, brokerOrderId: string): BrokerOrder | null {
    const order = this.orders.get(this.key(accountId, brokerOrderId));
    return order ? { ...order } : null;
  }

  list(accountId: number): BrokerOrder[] {
    return [...this.orders.values()].filter((o) => o.accountId === accountId).map((o) => ({ ...o }));
  }

  /**
   * Kolik vyplněných kusů příkazu jádro ještě nedostalo jako fill (0 = nic nechybí).
   * Kladné číslo znamená čekat na exekuci z burzy; když nepřijde, je ztracená.
   */
  fillGap(accountId: number, brokerOrderId: string): number {
    const key = this.key(accountId, brokerOrderId);
    const order = this.orders.get(key);
    if (!order) return 0;
    // Dluh nikdy nepřesáhne aktuální množství příkazu (odhad ze staršího, většího množství).
    const owed = Math.min(this.owed.get(key) ?? 0, order.quantity);
    // Ztracené kusy (`proven`) se přičítají: doručený fill JINÉ exekuce je nesmí vyrovnat.
    return Math.max(0, Math.max(order.filledQuantity, owed) - (this.accounted.get(key) ?? 0)) + (this.proven.get(key) ?? 0);
  }

  /** Složí příkaz z jedné notifikace nebo řádku snímku; null, když chybí účet nebo ID. */
  compose(update: RithmicOrderUpdate, previous: BrokerOrder | null, shapeFromUpdate = true): BrokerOrder | null {
    const accountId = this.options.accountNumber(update.accountId);
    if (accountId === null || !update.basketId) return null;
    // Požadovaná (nepotvrzená) změna z 351 *_RCVD_* nesmí přepsat tvar existujícího příkazu.
    const shape = shapeFromUpdate || !previous;
    const bracket = bracketKind(update);
    const wasBracket = previous?.orderType === 'Unsupported' && previous.brokerOrderType?.startsWith('BRACKET:');
    const type: { orderType: ObservedOrderType; brokerOrderType?: string } = bracket
      ? { orderType: 'Unsupported', brokerOrderType: bracket.slice(0, 32) }
      : wasBracket
        ? { orderType: 'Unsupported', brokerOrderType: previous!.brokerOrderType }
        : update.priceType && shape
          ? observedType(update.priceType)
          : previous
            ? { orderType: previous.orderType, brokerOrderType: previous.brokerOrderType }
            : observedType('');
    const quantity = (shape ? update.quantity : null) ?? previous?.quantity ?? 0;
    const reportedFill = update.totalFillSize ?? 0;
    const filledQuantity = Math.max(previous?.filledQuantity ?? 0, reportedFill);
    return {
      tag: update.userTag || previous?.tag || '',
      brokerOrderId: update.basketId,
      accountId,
      symbol: update.symbol || previous?.symbol || '',
      side: update.side === 'BUY' ? 'Buy' : update.side === 'SELL' ? 'Sell' : previous?.side ?? 'Buy',
      orderType: type.orderType,
      ...(type.brokerOrderType ? { brokerOrderType: type.brokerOrderType } : {}),
      quantity,
      filledQuantity,
      // U STOP_MARKET burza hlásí v `price` ochranný limit (změřeno: 20 ticků za spouští) — není to
      // limitní cena příkazu a jádro by z jejích změn dělalo falešné úpravy.
      // Vstup s ochranou má typ „Unsupported" — Stop se u něj pozná podle tvaru (spoušť bez limitní ceny).
      ...(/^STOP_MARKET$/i.test(update.priceType) || (!update.priceType && (previous?.orderType === 'Stop' || (previous?.stopPrice !== undefined && previous.limitPrice === undefined)))
        ? {}
        : shape && update.price !== null ? { limitPrice: update.price } : previous?.limitPrice !== undefined ? { limitPrice: previous.limitPrice } : {}),
      ...(shape && update.triggerPrice !== null ? { stopPrice: update.triggerPrice } : previous?.stopPrice !== undefined ? { stopPrice: previous.stopPrice } : {}),
      // parentOrderId / linkedOrderId záměrně nevyplňujeme: jádro jimi rozlišuje vstup od SL/TP
      // a význam polí original_basket_id / linked_basket_ids u Rithmicu není změřený.
      status: previous?.status ?? 'pending',
      sourceVersion: '',
      ...(previous?.rejectReason ? { rejectReason: previous.rejectReason } : {}),
      updatedAt: update.gatewayAt ?? this.options.now(),
    };
  }

  /** Živá notifikace. Snímky sem nepatří (viz `replaceFromSnapshot`). */
  apply(update: RithmicOrderUpdate): RithmicOrderDelta {
    if (update.isSnapshot) return {};
    const accountId = this.options.accountNumber(update.accountId);
    if (accountId === null) return { attention: `notifikace pro neznámý účet ${update.accountId || '(prázdný)'}` };
    if (!update.basketId) return { attention: `notifikace ${update.source}:${update.notifyType} bez basket_id` };
    const key = this.key(accountId, update.basketId);
    const previous = this.orders.get(key) ?? null;
    if (update.source === 'exchange' && (update.notifyType === 'NOT_MODIFIED' || update.notifyType === 'NOT_CANCELLED')) {
      return { attention: `${update.notifyType} u příkazu ${update.basketId}: ${update.text || 'bez důvodu'}` };
    }
    if (update.source === 'rithmic' && (update.notifyType === 'MODIFICATION_FAILED' || update.notifyType === 'CANCELLATION_FAILED')) {
      return { attention: `${update.notifyType} u příkazu ${update.basketId}: ${update.text || 'bez důvodu'}` };
    }
    // Pořadí neurčujeme podle času: 351 a 352 razítkují různé procesy a čas brány se nesmí
    // míchat s místními hodinami. Proti návratu staršího stavu chrání to, že tvar mění jen
    // burzovní potvrzení (352), konečný stav se neoživí a fill se deduplikuje podle ID.
    const next = this.compose(update, previous, confirmsShape(update));
    if (!next) return { attention: `notifikaci ${update.source}:${update.notifyType} nejde složit` };
    if (!previous && (update.side === null || !(next.quantity > 0) || !next.symbol)) {
      // Stranu, množství ani symbol si nedomýšlíme: neúplný příkaz se nevyšle, stav se musí dočíst.
      return { attention: `první notifikace příkazu ${update.basketId} je neúplná (strana/množství/symbol)`, needsRead: 'incomplete' };
    }
    const delta: RithmicOrderDelta = {};
    const wasTerminal = previous ? TERMINAL.has(previous.status) : false;
    let status: OrderStatus = previous?.status ?? 'pending';

    if (update.source === 'exchange') {
      if (update.notifyType === 'FILL') {
        const size = update.fillSize ?? 0;
        if (update.fillId && size > 0 && update.fillPrice !== null) {
          const fillKey = `${accountId}:${update.fillId}`;
          if (!this.fillIds.has(fillKey)) {
            this.fillIds.add(fillKey);
            this.accounted.set(key, (this.accounted.get(key) ?? 0) + size);
            next.filledQuantity = Math.max(next.filledQuantity, (previous?.filledQuantity ?? 0) + (update.totalFillSize === null ? size : 0));
            delta.fill = {
              // Jádro deduplikuje filly jen podle fillId napříč účty — proto s účtem.
              fillId: `rithmic:${accountId}:${update.fillId}`,
              tag: next.tag,
              brokerOrderId: next.brokerOrderId,
              accountId,
              symbol: next.symbol,
              side: next.side,
              quantity: size,
              price: update.fillPrice,
              filledAt: update.gatewayAt ?? this.options.now(),
            };
          }
          if (!wasTerminal) status = next.quantity > 0 && next.filledQuantity >= next.quantity ? 'filled' : 'working';
        } else {
          // Bez exekuce nevydáme fill ani konečný stav, ale pozice se změnila: zapíšeme, že jádru
          // exekuce chybí (`fillGap`), aby to volající nenechal být.
          const before = previous?.filledQuantity ?? 0;
          next.filledQuantity = before;
          this.proven.set(key, (this.proven.get(key) ?? 0) + Math.max(update.fillSize ?? 0, 1));
          delta.attention = `FILL u příkazu ${update.basketId} bez ID, ceny nebo množství exekuce`;
        }
      } else if (update.notifyType === 'CANCEL') {
        if (!wasTerminal) status = 'canceled';
      } else if (update.notifyType === 'REJECT') {
        if (!wasTerminal) {
          status = 'rejected';
          next.rejectReason = (update.text || 'Rithmic: příkaz odmítnut').slice(0, 300);
        }
      } else if (EXCHANGE_WORKING.has(update.notifyType)) {
        if (!wasTerminal) status = 'working';
      }
    } else if (!wasTerminal) {
      if (RITHMIC_PENDING.has(update.notifyType)) {
        if (status !== 'working') status = 'pending';
      } else if (update.notifyType === 'COMPLETE') {
        // Důvody změřené na Rithmic Test: FA = odmítl Rithmic (RMS; burza příkaz neviděla),
        // R = odmítla burza, C = zrušeno, F = vyplněno.
        const reason = update.completionReason.trim().toUpperCase();
        if (reason === 'FA' || reason === 'R') {
          status = 'rejected';
          next.rejectReason = (update.text || (reason === 'FA' ? 'Rithmic: odmítnuto (RMS)' : 'Rithmic: odmítnuto burzou')).slice(0, 300);
        } else if (reason === 'C') {
          status = 'canceled';
        } else if (next.quantity > 0 && next.filledQuantity >= next.quantity) {
          status = 'filled';
        } else if (reason === 'F') {
          // Vyplněno podle Rithmicu, ale exekuce z burzy ještě nedorazila: stav neposouváme,
          // jen si zapíšeme, že jádru dlužíme exekuce na celé množství (viz `fillGap`).
          // Množství bere ze zprávy samotné (může být menší než to, které kniha zná z dřívějška).
          this.owed.set(key, update.quantity ?? next.quantity);
          delta.awaitingFill = true;
        } else {
          delta.attention = `COMPLETE u příkazu ${update.basketId} s neznámým důvodem (${update.completionReason || update.status || 'neuvedeno'})`;
          delta.needsRead = 'unknown-complete';
        }
      }
    }
    next.status = status;
    if (!wasTerminal && (status === 'canceled' || status === 'rejected')) {
      // Konečný stav z burzy nebo od Rithmicu: odhad „bude vyplněno celé" už neplatí.
      // Prokázaná exekuce (`proven`) zůstává.
      this.owed.delete(key);
    }
    if (wasTerminal && previous) {
      // Konečný stav se neoživí a jeho verze se nemění (jinak by jádro vydalo druhé
      // `canceled`/`rejected`); propíše se jen vyšší vyplněné množství.
      const filledQuantity = next.filledQuantity;
      for (const key of Object.keys(next) as Array<keyof BrokerOrder>) delete next[key];
      Object.assign(next, previous, { filledQuantity });
    }
    next.sourceVersion = stateVersion(next);
    const changed = wasTerminal && previous
      ? previous.filledQuantity !== next.filledQuantity
      : !previous ||
      previous.status !== next.status ||
      previous.filledQuantity !== next.filledQuantity ||
      previous.quantity !== next.quantity ||
      previous.limitPrice !== next.limitPrice ||
      previous.stopPrice !== next.stopPrice ||
      previous.orderType !== next.orderType;
    if (changed || delta.fill) {
      this.orders.set(key, next);
      delta.order = { ...next };
    }
    return delta;
  }

  /**
   * Baseline účtu ze snímku pracujících příkazů. Nevysílá události ani filly.
   * Příkazy, které ve snímku nejsou a máme je jako aktivní, se NEoznačí za
   * zrušené — chybění v seznamu není důkaz konce (INV-RECON-03); jen se vrátí.
   */
  /**
   * Složí příkaz z řádku snímku včetně stavu. Vrací null u řádku jiného účtu nebo bez ID;
   * vyhodí chybu, když stav nejde určit — neúplně pochopený snímek se nesmí použít.
   */
  composeSnapshotRow(accountId: number, row: RithmicOrderUpdate): BrokerOrder | null {
    if (this.options.accountNumber(row.accountId) !== accountId || !row.basketId) return null;
    const previous = this.orders.get(this.key(accountId, row.basketId)) ?? null;
    if (previous && TERMINAL.has(previous.status)) {
      // Konečný stav se snímkem nemění (ani jeho verze); smí jen vzrůst vyplněné množství.
      const filledQuantity = Math.max(previous.filledQuantity, row.totalFillSize ?? 0);
      const kept = { ...previous, filledQuantity };
      kept.sourceVersion = stateVersion(kept);
      return kept;
    }
    const next = this.compose(row, previous);
    if (!next) return null;
    if (!previous && (row.side === null || !(next.quantity > 0) || !next.symbol)) {
      throw new Error(`Rithmic: řádek snímku příkazu ${row.basketId} je neúplný (strana/množství/symbol)`);
    }
    const status = rithmicSnapshotStatus(row, next.quantity, next.filledQuantity);
    if (status === null) {
      throw new Error(`Rithmic: stav příkazu ${row.basketId} ve snímku nejde určit (status "${row.status}", důvod "${row.completionReason}")`);
    }
    next.status = status;
    if (status === 'rejected' && row.text) next.rejectReason = row.text.slice(0, 300);
    next.sourceVersion = stateVersion(next);
    return next;
  }

  /**
   * Baseline účtu ze snímku pracujících příkazů. Nevysílá události ani filly.
   * `skip` = příkazy, ke kterým během čtení přišla živá notifikace (ta je novější).
   * Příkazy, které ve snímku nejsou a máme je jako aktivní, se NEoznačí za
   * zrušené — chybění v seznamu není důkaz konce (INV-RECON-03); jen se vrátí.
   */
  replaceFromSnapshot(
    accountId: number,
    rows: readonly RithmicOrderUpdate[],
    skip: ReadonlySet<string> = new Set(),
    options: { baseline?: boolean } = {},
  ): { orders: BrokerOrder[]; missingActive: BrokerOrder[]; changed: BrokerOrder[]; added: Set<string>; seenIds: Set<string> } {
    const composed: BrokerOrder[] = [];
    const seenIds = new Set<string>();
    for (const row of rows) {
      if (this.options.accountNumber(row.accountId) !== accountId || !row.basketId) continue;
      seenIds.add(row.basketId);
      if (skip.has(row.basketId)) continue;
      const next = this.composeSnapshotRow(accountId, row);
      if (next) composed.push(next);
    }
    // Zapisuje se až po úspěšném složení všech řádků: chyba nenechá knihu napůl přepsanou.
    const changed: BrokerOrder[] = [];
    /** Příkazy, které kniha před tímto snímkem neznala. */
    const added = new Set<string>();
    if (options.baseline) {
      // Nový výchozí stav srovná ztracené kusy u všech příkazů účtu — i u konečných, které
      // snímek už nevrací (jinak by je probudila pozdní notifikace). Příkaz živě dotčený
      // během skládání (`skip`) si je nechává.
      const prefix = `${accountId}:`;
      for (const key of [...this.proven.keys()]) {
        if (key.startsWith(prefix) && !skip.has(key.slice(prefix.length))) this.proven.delete(key);
      }
    }
    for (const next of composed) {
      const key = this.key(accountId, next.brokerOrderId);
      const previous = this.orders.get(key);
      if (options.baseline) {
        // Výchozí stav (první i po obnově) je pro jádro nová pravda: vyplněné množství přebírá
        // ze snímku — i u příkazu, který kniha znala před výpadkem. Dluh ohlášený živě BĚHEM
        // tohoto připojování (`owed`) se tím nemaže: snímek ho buď potvrdí vyšším vyplněním,
        // nebo zůstane a po připojení ho dořeší hlídání. Starý dluh maže `clearOwed()`.
        this.accounted.set(key, next.filledQuantity);
        this.proven.delete(key);
      } else {
        // Příkaz poprvé viděný až za běhu takovou výjimku nemá — jeho exekuce jádru chybí.
        if (!previous) {
          this.accounted.set(key, 0);
          added.add(next.brokerOrderId);
        }
        if (next.status === 'canceled' || next.status === 'rejected') this.owed.delete(key);
      }
      if (
        !previous ||
        previous.status !== next.status ||
        previous.filledQuantity !== next.filledQuantity ||
        previous.quantity !== next.quantity ||
        previous.limitPrice !== next.limitPrice ||
        previous.stopPrice !== next.stopPrice ||
        previous.orderType !== next.orderType
      ) {
        changed.push({ ...next });
      }
      this.orders.set(key, next);
    }
    const missingActive: BrokerOrder[] = [];
    for (const order of this.orders.values()) {
      if (order.accountId !== accountId || seenIds.has(order.brokerOrderId) || TERMINAL.has(order.status)) continue;
      missingActive.push({ ...order });
    }
    // `orders` jsou jen příkazy, které snímek skutečně obsahoval (ne zbytky v paměti).
    const orders = this.list(accountId).filter((order) => seenIds.has(order.brokerOrderId));
    return { orders, missingActive, changed, added, seenIds };
  }

  /** Nová relace: dluhy exekucí z minulého spojení neplatí, pravdu dá nový výchozí stav. */
  clearOwed(): void {
    this.owed.clear();
  }

  /** Zahodí všechno (ruční nové spuštění po zastavení: obsluha stav potvrdila). */
  reset(): void {
    this.orders.clear();
    this.fillIds.clear();
    this.accounted.clear();
    this.owed.clear();
    this.proven.clear();
  }
}
