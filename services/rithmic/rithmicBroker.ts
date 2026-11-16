/**
 * Adaptér Rithmicu pro `BrokerPort` — verze 1 (jednotlivé příkazy, bez bracketu).
 * Návrh, měření a oponentura: docs/reviews/rithmic-broker-v1-design-20261116.md,
 * docs/reviews/rithmic-feasibility-results-20261116.md.
 *
 * NENÍ zapojený do workeru. Podmínky zapojení (z oponentury): ne za `brokerRouter`
 * (maskuje chybějící metody a má reconnect lhůtu), automatické pokračování po
 * výpadku vypnuté, jediná instance vynucená vstupním bodem, ověřené typy sloupců
 * pro čísla účtů, testy s jádrem.
 *
 * Zásady:
 *  - zápis se nikdy neopakuje; cokoli jiného než potvrzení s číslem příkazu nebo
 *    prokazatelné neodeslání je neznámý výsledek (výjimka) a jádro ho dohledává;
 *  - událost `error` se NEvysílá pro obchodní selhání (jádro ji čte jako ztrátu
 *    transportu a zakládá automatické pokračování) — ta jdou přes `onIncident`;
 *  - výchozí stav jádru se předá jako události `order` PŘED `connected: true`;
 *    filly ze snímku se nevysílají nikdy;
 *  - obnovuje se jen přihlášení; stav, který nejde určit, a vynucené odhlášení
 *    adaptér zastaví bez automatické obnovy.
 */
import {
  BrokerRequestNotSentError,
  type BrokerAccountCapability,
  type BrokerAccountRiskSnapshot,
  type BrokerCancelConfirmation,
  type BrokerEnvironment,
  type BrokerEvent,
  type BrokerBracketAck,
  type BrokerBracketRequest,
  type BrokerLiquidateRequest,
  type BrokerLiquidateResult,
  type BrokerModifyConfirmation,
  type BrokerOrder,
  type BrokerOrderAck,
  type BrokerOrderLookup,
  type BrokerOrderRequest,
  type BrokerOrderStateLookup,
  type BrokerPort,
  type BrokerPosition,
  type BrokerResyncSnapshot,
  type OrderType,
} from '../brokerPort';
import type { RithmicAccountRegistry } from './rithmicAccountRegistry';
import { RithmicOrderBook, rithmicExchangeForSymbol, rithmicPriceType, rithmicSide } from './rithmicBrokerMapping';
import {
  RithmicClient,
  RithmicRequestError,
  type RithmicAccountPnl,
  type RithmicInstrumentPosition,
  type RithmicOrderUpdate,
  type RithmicPlantName,
} from './rithmicClient';
import type { RithmicCloseInfo, RithmicCredentials, RithmicSocketFactory } from './rithmicPlant';
import { RithmicProtection, memoryProtectionStore, type BracketState, type FlattenRecord, type ProtectionStore } from './rithmicProtection';

/** Systémy bez skutečných peněz. Cokoli jiného je `live`. (Na Paper běží i prop účty.) */
export const RITHMIC_DEMO_SYSTEMS: readonly string[] = ['Rithmic Test', 'Rithmic Paper Trading'];

export type RithmicIncidentKind =
  | 'attention'
  | 'cancel-failed'
  | 'modify-failed'
  | 'late-snapshot-row'
  | 'unknown-order-in-snapshot'
  | 'fill-missing'
  | 'state-undetermined'
  | 'forced-logout'
  | 'accounts-changed'
  | 'reconnect-failed'
  /** Pozice trvá a serverová ochrana (SL/TP) chybí nebo nesedí. Adaptér nic nedostavuje. */
  | 'bracket-legs-missing'
  /** Pozice je 0, ale noha bracketu dál pracuje. */
  | 'bracket-orphan-legs'
  /** Zavření pozice odešlo, i když zrušení příkazů nešlo potvrdit. */
  | 'flatten-cancel-unconfirmed'
  /** Po zavírání na kontraktu dál něco pracuje (nebo to nejde ověřit). */
  | 'flatten-orders-remain'
  /** Minulý běh skončil uprostřed zavírání — nic se neopakuje, je nutná kontrola stavu. */
  | 'flatten-interrupted';

export interface RithmicIncident {
  kind: RithmicIncidentKind;
  message: string;
  at: number;
}

export interface RithmicBrokerConfig {
  url: string;
  credentials: RithmicCredentials;
  socketFactory: RithmicSocketFactory;
  registry: RithmicAccountRegistry;
  /** Obchodní selhání a stavy, které nejdou jádru říct přes `BrokerEvent`. */
  onIncident?: (incident: RithmicIncident) => void;
  now?: () => number;
  requestTimeoutMs?: number;
  /** Jak dlouho čekat na konečný stav rušeného příkazu, než se vrátí „ověř čtením". */
  confirmWaitMs?: number;
  /** Jak dlouho čekat na exekuci z burzy poté, co Rithmic ohlásil vyplnění. */
  fillWaitMs?: number;
  riskSnapshotMaxAgeMs?: number;
  /** Oba planty musí mít zprávu ze serveru v tomto okně, aby se vyslal `heartbeat`. */
  heartbeatWindowMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Kolikrát se adaptér smí sám odpojit kvůli stavu během `selfDropWindowMs` (výchozí 5 za 10 min). */
  maxSelfDrops?: number;
  selfDropWindowMs?: number;
  /**
   * Po tolika LOGICKÝCH selháních obnovy v řadě se adaptér zastaví (výchozí 5). Výpadky
   * spojení se do stropu nepočítají — ty se zkoušejí dál bez omezení.
   */
  maxReconnectFailures?: number;
  /** Trvalý záznam vstupů s ochranou a operací zavírání. Bez něj jen v paměti (testy). */
  protectionStore?: ProtectionStore;
  /** Do kdy po vyplnění vstupu musí pracovat všechny požadované nohy (výchozí 3 s). */
  legsWaitMs?: number;
  /** Časový strop jednoho kroku zavírání (čtení, odeslání) — výchozí 1 s. */
  flattenStepMs?: number;
  /** Jak dlouho zavírání čeká na konečný stav rušených příkazů (výchozí 1 s). */
  flattenCancelWaitMs?: number;
  /** Za jak dlouho po zavření se jednou ověří, že na kontraktu nic nepracuje (výchozí 1,5 s). */
  flattenPostCheckMs?: number;
  /** Do kdy se musí vstup s ochranou spárovat se záznamem, jinak incident (výchozí 15 s). */
  bracketBindWaitMs?: number;
}

export interface RithmicBrokerPort extends BrokerPort {
  /** První připojení; vyhodí chybu, když se nepodaří (další pokusy běží samy). */
  start(): Promise<void>;
  stop(): void;
  isConnected(): boolean;
  /** Zastaveno bez automatické obnovy (vynucené odhlášení, neurčitelný stav). */
  isHalted(): boolean;
  accountIds(): number[];
  placeBracket(request: BrokerBracketRequest): Promise<BrokerBracketAck>;
  liquidatePosition(request: BrokerLiquidateRequest): Promise<BrokerLiquidateResult>;
  /** Stav serverové ochrany vlastního vstupu (jen čtení paměti; pozice z živých zpráv). */
  bracketState(accountId: number, entryBrokerOrderId: string): { state: BracketState; detail: string };
}

type State = 'idle' | 'connecting' | 'connected' | 'down' | 'halted';
const TERMINAL: ReadonlySet<string> = new Set(['filled', 'canceled', 'rejected']);
const BASELINE_ATTEMPTS = 3;
const POSITION_READ_ATTEMPTS = 3;

export function createRithmicBroker(config: RithmicBrokerConfig): RithmicBrokerPort {
  const now = config.now ?? (() => Date.now());
  const system = config.credentials.systemName;
  const environment: BrokerEnvironment = RITHMIC_DEMO_SYSTEMS.includes(system) ? 'demo' : 'live';
  const listeners = new Set<(event: BrokerEvent) => void>();
  const numberByText = new Map<string, number>();
  const textByNumber = new Map<number, string>();
  /** Úplná identita účtů přihlášení (účet|FCM|IB) — pro kontrolu, že se nezměnila. */
  let sessionIdentity = '';
  const book = new RithmicOrderBook({ accountNumber: (id) => numberByText.get(id) ?? null, now });
  const accountPnl = new Map<number, RithmicAccountPnl>();
  const orderWaiters = new Set<(update: RithmicOrderUpdate) => void>();
  const fillTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const aliveAt: Partial<Record<RithmicPlantName, number>> = {};
  const protection = new RithmicProtection(config.protectionStore ?? memoryProtectionStore(), now);
  let protectionLoaded = false;
  let interruptedFlattens: FlattenRecord[] = [];
  /** Časovače kontroly ochrany (`účet:vstup`) a naposledy ohlášený stav (ať se incident neopakuje). */
  const bracketTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; firstAt: number; retried: boolean }>();
  /**
   * Pořadí událostí kvůli stáří živé pozice: pozice z PnL spojení může přijít později než
   * vyplnění z order spojení. Živá hodnota platí jen když je novější než poslední vyplnění
   * na kontraktu; jinak se čte.
   */
  let eventSeq = 0;
  const positionSeenAt = new Map<string, number>();
  const fillSeenAt = new Map<string, number>();
  /** Zavření odešlo a odpověď nepřišla (`účet:kontrakt`) — dokud požadavek nedoběhne, nic dalšího. */
  const exitUncertain = new Map<string, { tag: string; settled: boolean }>();
  /** Roste s každým začátkem zavírání na klíči — zápis rozhodnutý před ním už neplatí. */
  const flattenGeneration = new Map<string, number>();
  /** Značky volání připojených k běžící operaci (dostanou stejný trvalý záznam). */
  const joinedTags = new Map<string, FlattenRecord[]>();
  const bracketReported = new Map<string, string>();
  /** Běžící zavírání (`účet:kontrakt`). Po dobu běhu se na kontraktu nepřijímají nové příkazy. */
  const flattening = new Map<string, Promise<BrokerLiquidateResult>>();
  /** Příkazy rušené zavíráním — jejich CANCELLATION_FAILED (sestra už skončila) není incident. */
  const flattenCancelIds = new Set<string>();

  let state: State = 'idle';
  let client: RithmicClient | null = null;
  let epoch = 0;
  let everConnected = false;
  let reconnectDelay = config.reconnectMinMs ?? 2_000;
  let reconnectFailures = 0;
  let transportFailures = 0;
  let selfDrops: number[] = [];
  /** Kniha byla před tímto připojením vymazána (ruční spuštění) — mezera je celá neověřená. */
  let bookWasReset = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHeartbeatAt = 0;
  /** Roste s každou živou notifikací příkazu; baseline podle něj pozná změnu pod rukama. */
  let liveSeq = 0;
  /**
   * Čítač SKUTEČNÝCH změn pozice na účet (jiné množství než poslední živá hodnota). Čtení
   * pozic podle něj pozná zastaralý snímek; průběžné zprávy o P&L beze změny množství ani
   * změny jiného účtu čtení neruší.
   */
  const positionSeq = new Map<number, number>();
  const livePositions = new Map<string, number>();
  /** Běžící dohledání stavu (účet:příkaz) — nejvýš jedno, ať se čtení nevrší před Flatten. */
  const resolving = new Set<string>();
  /** Po zastavení nebo `stop()` začíná další `start()` s čistou knihou. */
  let freshBookOnStart = false;
  /**
   * Kdy (podle `liveSeq`) naposledy změnila stav příkazu v knize živá notifikace. Čtení si
   * pamatuje `liveSeq` svého začátku a řádek snímku nepřepíše příkaz změněný později —
   * každé čtení má vlastní hranici, takže další čtení ve frontě ochranu neruší.
   */
  const touchedAt = new Map<string, number>();
  const touchedSince = (seq: number): Set<string> => {
    const out = new Set<string>();
    for (const [basketId, at] of touchedAt) if (at > seq) out.add(basketId);
    return out;
  };
  let snapshotDirty = false;
  /** Známé příkazy před výpadkem (jen diagnostika `resync.complete`). */
  let beforeOutage: Map<string, string> | null = null;
  let positionCollector: { account: number; rows: Map<string, number | null>; accountRow: boolean } | null = null;
  let readChain: Promise<unknown> = Promise.resolve();

  const currentState = (): State => state;

  const emit = (event: BrokerEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // posluchač nesmí shodit adaptér
      }
    }
  };
  const incident = (kind: RithmicIncidentKind, message: string): void => {
    try {
      config.onIncident?.({ kind, message, at: now() });
    } catch {
      // hlášení incidentu nesmí shodit adaptér
    }
  };
  const serialRead = <T>(run: () => Promise<T>): Promise<T> => {
    const next = readChain.then(run, run);
    readChain = next.catch(() => undefined);
    return next;
  };
  const knownOrders = (): Map<string, string> => {
    const map = new Map<string, string>();
    for (const account of textByNumber.keys()) {
      for (const order of book.list(account)) map.set(`${account}:${order.brokerOrderId}`, `${order.status}:${order.filledQuantity}`);
    }
    return map;
  };

  // ---- chybějící exekuce ---------------------------------------------------
  /**
   * Hlídá, že ke každému vyplněnému kusu dorazila exekuce z burzy. Volá se po každé
   * změně příkazu (živé i ze snímku). Časovač se ruší až když nechybí nic — dílčí
   * fill ho nezastaví.
   */
  function watchFillGap(source: RithmicClient, account: number, basketId: string): void {
    const key = `${account}:${basketId}`;
    const gap = book.fillGap(account, basketId);
    const running = fillTimers.get(key);
    if (gap === 0) {
      if (running) {
        clearTimeout(running);
        fillTimers.delete(key);
      }
      return;
    }
    if (running || state !== 'connected') return;
    const timer = setTimeout(() => {
      fillTimers.delete(key);
      if (client !== source) return;
      const missing = book.fillGap(account, basketId);
      if (missing === 0) return;
      // Jádro o těchto kusech neví → odpojit a nechat ho projít plnou obnovou.
      incident('fill-missing', `příkaz ${basketId} je vyplněný o ${missing} ks víc, než kolik exekucí dorazilo z burzy`);
      dropAndReconnect();
    }, config.fillWaitMs ?? 5_000);
    (timer as { unref?: () => void }).unref?.();
    fillTimers.set(key, timer);
  }

  /** Všechno, co patří jedné relaci. Volá se při každém konci relace — i nezdařeného připojení. */
  function clearSessionState(): void {
    clearFillTimers();
    touchedAt.clear();
    accountPnl.clear();
    livePositions.clear();
    positionSeq.clear();
    resolving.clear();
    for (const entry of bracketTimers.values()) clearTimeout(entry.timer);
    bracketTimers.clear();
    positionSeenAt.clear();
    fillSeenAt.clear();
    aliveAt.order = undefined;
    aliveAt.pnl = undefined;
  }

  function clearFillTimers(): void {
    for (const timer of fillTimers.values()) clearTimeout(timer);
    fillTimers.clear();
  }

  // ---- příjem ze serveru ---------------------------------------------------
  function handleOrderUpdate(source: RithmicClient, update: RithmicOrderUpdate): void {
    if (client !== source) return;
    const account = numberByText.get(update.accountId);
    if (update.isSnapshot) {
      // Řádek snímku mimo svůj požadavek (změřeno: nenastává). Nevíme, ke kterému čtení patří
      // ani jak je starý, takže jím NIKDY nepřepisujeme příkaz, který kniha zná. Neznámý příkaz
      // znamená, že nám něco uniklo → čistá obnova.
      snapshotDirty = true;
      incident('late-snapshot-row', `řádek snímku příkazu ${update.basketId} dorazil mimo svůj požadavek`);
      if (state === 'connected' && account !== undefined && update.basketId && !book.get(account, update.basketId)) {
        incident('unknown-order-in-snapshot', `opožděný řádek snímku nese neznámý příkaz ${update.basketId} — odpojuji k plné obnově`);
        dropAndReconnect();
      }
      return;
    }
    liveSeq += 1;
    for (const waiter of [...orderWaiters]) waiter(update);
    if (update.source === 'rithmic' && (update.notifyType === 'CANCELLATION_FAILED' || update.notifyType === 'MODIFICATION_FAILED')) {
      const expected = update.notifyType === 'CANCELLATION_FAILED' && account !== undefined && flattenCancelIds.has(`${account}:${update.basketId}`);
      if (!expected) incident(update.notifyType === 'CANCELLATION_FAILED' ? 'cancel-failed' : 'modify-failed', `${update.notifyType} u příkazu ${update.basketId}: ${update.text || 'bez důvodu'}`);
      return;
    }
    // Evidence ochrany PŘED vysláním události: posluchač může na událost hned reagovat zápisem.
    const seen = account !== undefined ? protection.observe(account, update) : null;
    if (seen?.bound) void saveProtection();
    const delta = book.apply(update);
    // „Živá je novější" platí jen když kniha zprávu opravdu uplatnila.
    if ((delta.order || delta.fill) && update.basketId) touchedAt.set(update.basketId, liveSeq);
    if (account !== undefined && update.basketId && (delta.fill || delta.awaitingFill || update.notifyType === 'FILL')) {
      const symbol = update.symbol || book.get(account, update.basketId)?.symbol;
      if (symbol) fillSeenAt.set(`${account}:${symbol}`, (eventSeq += 1));
    }
    if (delta.order) emit({ type: 'order', order: delta.order, receivedAt: update.receivedAt });
    if (delta.fill) emit({ type: 'fill', fill: delta.fill, receivedAt: update.receivedAt });
    if (client !== source) return; // posluchač mohl adaptér zastavit
    if (account !== undefined && update.basketId) watchFillGap(source, account, update.basketId);
    if (account !== undefined && seen?.entryId) scheduleBracketCheck(source, account, seen.entryId);
    if (delta.needsRead && account !== undefined) {
      const resolveKey = `${account}:${update.basketId}`;
      if (!resolving.has(resolveKey)) {
        resolving.add(resolveKey);
        void resolveByRead(source, account, update.basketId, delta.needsRead, delta.attention ?? '').finally(() => resolving.delete(resolveKey));
      }
    }
    else if (delta.attention) incident('attention', delta.attention);
  }

  /**
   * Co snímek změnil proti knize, se za běhu musí dostat k jádru: jinak by pozdější živá
   * notifikace téhož přechodu (už konečný stav) nevyslala nic a jádro by změnu nevidělo.
   * Vysílá se jen `order` u příkazů, které kniha ZNALA; vyšší vyplněné množství hlídá
   * `watchFillGap`.
   *
   * Příkaz poprvé nalezený ve snímku za běhu se NEvysílá: jádro by z něj udělalo nový vstup
   * ke zkopírování (INV-TRAD-01: stav ze snímku není nový obchod). Znamená, že nám jeho živé
   * notifikace unikly → odpojit a nechat jádro projít plnou obnovou, kde je součástí výchozího stavu.
   */
  function publishSnapshotChanges(source: RithmicClient, account: number, changed: readonly BrokerOrder[], added: ReadonlySet<string>): void {
    if (state !== 'connected') return; // při skládání výchozího stavu se vše vyšle najednou na konci
    for (const order of changed) {
      if (client !== source) return;
      if (added.has(order.brokerOrderId)) continue;
      emit({ type: 'order', order, receivedAt: now() });
      watchFillGap(source, account, order.brokerOrderId);
    }
    if (added.size && client === source) {
      incident('unknown-order-in-snapshot', `snímek obsahuje příkaz ${[...added].join(', ')}, který adaptér živě neviděl — odpojuji k plné obnově`);
      dropAndReconnect();
    }
  }

  /** Stav nejde určit z notifikací: přečíst snímek (s jedním opakováním), jinak zastavit. */
  async function resolveByRead(
    source: RithmicClient,
    account: number,
    basketId: string,
    why: 'incomplete' | 'unknown-complete',
    detail: string,
  ): Promise<void> {
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // Čtení samo vyšle, co snímek změnil (konečný stav, nově poznaný příkaz).
        await readOrders(source, account);
        if (client !== source) return;
        const order = book.get(account, basketId);
        if (!order) throw new Error('příkaz ve snímku není');
        if (why === 'unknown-complete' && !TERMINAL.has(order.status)) throw new Error(detail || 'stav po čtení není konečný');
        return;
      } catch (error) {
        if (client !== source) return;
        lastError = (error as Error).message;
      }
    }
    incident('state-undetermined', `stav příkazu ${basketId} nejde určit: ${lastError} — adaptér je zastavený, je nutné ruční spuštění`);
    halt();
  }

  function handlePosition(source: RithmicClient, position: RithmicInstrumentPosition): void {
    if (client !== source) return;
    const account = numberByText.get(position.accountId);
    if (account === undefined || !position.symbol) return;
    if (position.isSnapshot) {
      if (positionCollector && positionCollector.account === account) positionCollector.rows.set(position.symbol, position.netQuantity);
      return;
    }
    if (position.netQuantity === null) {
      positionSeq.set(account, (positionSeq.get(account) ?? 0) + 1);
      livePositions.delete(`${account}:${position.symbol}`);
      positionSeenAt.delete(`${account}:${position.symbol}`);
      incident('attention', `pozice ${position.symbol} bez množství — neznámá, ne nulová`);
      return;
    }
    const positionKey = `${account}:${position.symbol}`;
    positionSeenAt.set(positionKey, (eventSeq += 1));
    if (livePositions.get(positionKey) !== position.netQuantity) {
      livePositions.set(positionKey, position.netQuantity);
      positionSeq.set(account, (positionSeq.get(account) ?? 0) + 1);
      for (const intent of protection.bracketsFor(account, position.symbol)) {
        if (intent.entryId && intent.closedAt === undefined) scheduleBracketCheck(source, account, intent.entryId);
      }
    }
    emit({
      type: 'position',
      position: { accountId: account, symbol: position.symbol, netQuantity: position.netQuantity },
      ...(position.avgOpenFillPrice !== null && position.netQuantity !== 0 ? { displayAveragePrice: position.avgOpenFillPrice } : {}),
    });
  }

  function handleAccountPnl(source: RithmicClient, pnl: RithmicAccountPnl): void {
    if (client !== source) return;
    const account = numberByText.get(pnl.accountId);
    if (account === undefined) return;
    accountPnl.set(account, pnl);
    if (pnl.isSnapshot && positionCollector && positionCollector.account === account) positionCollector.accountRow = true;
  }

  function handleAlive(source: RithmicClient, plant: RithmicPlantName, at: number): void {
    if (client !== source) return;
    aliveAt[plant] = at;
    if (state !== 'connected') return;
    const window = config.heartbeatWindowMs ?? 90_000;
    const order = aliveAt.order ?? 0;
    const pnl = aliveAt.pnl ?? 0;
    // Jen ze zprávy serveru a jen když žijí oba planty; nejvýš jednou za sekundu.
    if (at - order <= window && at - pnl <= window && at - lastHeartbeatAt >= 1_000) {
      lastHeartbeatAt = at;
      emit({ type: 'heartbeat', at });
    }
  }

  // ---- spojení -------------------------------------------------------------
  function teardown(source: RithmicClient): boolean {
    if (client !== source) return false;
    const wasConnected = state === 'connected';
    if (wasConnected) beforeOutage = knownOrders();
    client = null;
    epoch += 1;
    clearSessionState();
    try {
      source.close();
    } catch {
      // zbylé planty už mohou být zavřené
    }
    if (wasConnected) emit({ type: 'connection', connected: false, at: now() });
    return true;
  }

  function handleClosed(source: RithmicClient, info: RithmicCloseInfo): void {
    if (!teardown(source)) return;
    if (info.forcedLogout) {
      state = 'halted';
      incident('forced-logout', 'vynucené odhlášení (pravděpodobně druhé přihlášení stejným účtem) — spojení se samo neobnoví');
      return;
    }
    state = 'down';
    scheduleReconnect();
  }

  /**
   * Odpojení z vlastního rozhodnutí (chybějící exekuce, neznámý příkaz ve snímku, změna účtů).
   * Opakuje-li se příčina, vedlo by to k přihlašování každých pár sekund bez konce → po
   * několika odpojeních v krátkém okně se adaptér zastaví.
   */
  function dropAndReconnect(): void {
    const active = client;
    if (!active || !teardown(active)) return;
    const at = now();
    const windowMs = config.selfDropWindowMs ?? 10 * 60_000;
    selfDrops = selfDrops.filter((t) => at - t < windowMs);
    selfDrops.push(at);
    if (selfDrops.length > (config.maxSelfDrops ?? 5)) {
      incident('state-undetermined', `adaptér se ${selfDrops.length}× za sebou sám odpojil kvůli stavu — je zastavený, je nutné ruční spuštění`);
      halt();
      return;
    }
    state = 'down';
    scheduleReconnect();
  }

  function halt(): void {
    const active = client;
    if (active) teardown(active);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearFillTimers();
    freshBookOnStart = true;
    state = 'halted';
  }

  function scheduleReconnect(): void {
    if (state !== 'down' || reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, config.reconnectMaxMs ?? 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (state !== 'down') return;
      connectOnce().catch((error) => {
        if (currentState() !== 'down') return; // zastaveno nebo už připojeno jinou cestou
        if (isTransportFailure(error)) {
          // Výpadek sítě nebo Rithmicu může trvat hodiny (víkend): zkoušet dál na horní prodlevě,
          // nezastavovat — po návratu se adaptér musí připojit sám, i kvůli brzdám.
          transportFailures += 1;
          if (transportFailures === 1 || transportFailures % 10 === 0) {
            incident('reconnect-failed', `spojení se nedaří obnovit (${transportFailures}×): ${(error as Error).message}`);
          }
          scheduleReconnect();
          return;
        }
        // Logické selhání (odmítnuté přihlášení, žádný účet, výchozí stav nejde složit nebo vyložit)
        // se opakováním nespraví a časté přihlašování může účet zamknout → strop a zastavení.
        reconnectFailures += 1;
        incident('reconnect-failed', `obnovení spojení selhalo (${reconnectFailures}×): ${(error as Error).message}`);
        if (reconnectFailures >= (config.maxReconnectFailures ?? 5)) {
          incident('state-undetermined', 'obnovení spojení opakovaně selhává na stavu, ne na síti — adaptér je zastavený, je nutné ruční spuštění');
          halt();
          return;
        }
        scheduleReconnect();
      });
    }, delay);
    (reconnectTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Selhalo spojení (síť, Rithmic nedostupný, pád během skládání), ne stav? Cokoli, co
   * neumíme zařadit, bereme jako logické selhání — to je přísnější (počítá se do stropu).
   */
  function isTransportFailure(error: unknown): boolean {
    if (error instanceof RithmicRequestError) return error.outcome !== 'rejected';
    const message = error instanceof Error ? error.message : '';
    return /spojení se nepodařilo otevřít|vypršel čas na otevření|spojení zavřeno při otevírání|spojení spadlo|připojování bylo mezitím zrušeno/.test(message);
  }

  interface OrdersRead {
    /** Příkazy, které snímek skutečně obsahoval (ne zbytky v paměti). */
    orders: BrokerOrder[];
    missingActive: BrokerOrder[];
    seenIds: Set<string>;
  }

  /**
   * Snímek příkazů účtu do knihy. Příkaz, který během čtení změnila živá notifikace, snímek
   * nepřepíše. `baseline` = skládání výchozího stavu (nic se nevysílá, chybějící pracující
   * příkaz neřeší výjimkou, ale volající).
   */
  function readOrders(source: RithmicClient, account: number, options: { baseline?: boolean; sinceSeq?: number } = {}): Promise<OrdersRead> {
    return serialRead(async () => {
      const text = textByNumber.get(account);
      if (text === undefined) throw new Error(`Rithmic: účet ${account} není v aktuálním přihlášení`);
      // Hranice tohoto čtení: cokoli živě změněného po ní je novější než snímek.
      const sinceSeq = options.sinceSeq ?? liveSeq;
      if (!options.baseline) snapshotDirty = false;
      const rows = await source.showOrders(text);
      if (client !== source) throw new Error('Rithmic: spojení spadlo během čtení příkazů');
      const newer = touchedSince(sinceSeq);
      const result = book.replaceFromSnapshot(account, rows, newer, { baseline: options.baseline });
      // Vazby noh na rodiče nese snímek celé — po restartu je odjinud nezjistíme.
      for (const row of rows) if (numberByText.get(row.accountId) === account) observeProtection(source, account, row);
      // Živě změněný příkaz se do výsledku čtení počítá se svým novějším stavem z knihy.
      const orders = book.list(account).filter((order) => result.seenIds.has(order.brokerOrderId) || newer.has(order.brokerOrderId));
      if (!options.baseline) {
        publishSnapshotChanges(source, account, result.changed, result.added);
        if (client !== source) throw new Error('Rithmic: čtení příkazů odhalilo stav, kvůli kterému se adaptér odpojil — výsledek neplatí');
        if (result.missingActive.length) {
          const ids = result.missingActive.map((o) => o.brokerOrderId).join(', ');
          incident('state-undetermined', `snímek neobsahuje příkaz ${ids}, který kniha vede jako pracující — čtení příkazů selhává, dokud se to nevyřeší (zastavit a znovu spustit)`);
          throw new Error(`Rithmic: snímek neobsahuje pracující příkaz ${ids}`);
        }
      }
      return { orders, missingActive: result.missingActive, seenIds: result.seenIds };
    });
  }

  function readPositions(source: RithmicClient, account: number): Promise<BrokerPosition[]> {
    return serialRead(async () => {
      const text = textByNumber.get(account);
      if (text === undefined) throw new Error(`Rithmic: účet ${account} není v aktuálním přihlášení`);
      for (let attempt = 0; attempt < POSITION_READ_ATTEMPTS; attempt += 1) {
        const seqBefore = positionSeq.get(account) ?? 0;
        const collector = { account, rows: new Map<string, number | null>(), accountRow: false };
        positionCollector = collector;
        try {
          await source.requestPnlSnapshot(text);
        } finally {
          positionCollector = null;
        }
        if (client !== source) throw new Error('Rithmic: spojení spadlo během čtení pozic');
        // Živá změna pozice během čtení: snímek může být starší než právě vyslaná událost.
        if ((positionSeq.get(account) ?? 0) !== seqBefore) continue;
        // Změřeno: řádky dorazí před ukončením požadavku. Bez řádku účtu není snímek důkaz.
        if (!collector.accountRow) throw new Error('Rithmic: snímek pozic je neúplný (chybí řádek účtu)');
        const out: BrokerPosition[] = [];
        for (const [symbol, netQuantity] of collector.rows) {
          if (netQuantity === null) throw new Error(`Rithmic: pozice ${symbol} bez množství — neznámá, ne nulová`);
          out.push({ accountId: account, symbol, netQuantity });
        }
        return out;
      }
      throw new Error('Rithmic: pozice se během čtení opakovaně měnily — zkus znovu');
    });
  }

  async function connectOnce(): Promise<void> {
    if (state === 'halted') throw new Error('Rithmic: adaptér je zastavený');
    if (client) throw new Error('Rithmic: připojování už běží');
    const created: RithmicClient = new RithmicClient({
      url: config.url,
      credentials: config.credentials,
      socketFactory: config.socketFactory,
      now,
      requestTimeoutMs: config.requestTimeoutMs,
      events: {
        onOrderUpdate: (update) => handleOrderUpdate(created, update),
        onInstrumentPosition: (position) => handlePosition(created, position),
        onAccountPnl: (pnl) => handleAccountPnl(created, pnl),
        onAlive: (plant, at) => handleAlive(created, plant, at),
        onAttention: (message) => incident('attention', message),
        onPlantClosed: (_plant, info) => handleClosed(created, info),
      },
    });
    /** Po každém čekání: patří tahle relace ještě nám? (stop/start nebo pád mezitím) */
    const mine = (): void => {
      if (client !== created) throw new Error('připojování bylo mezitím zrušeno');
    };
    client = created;
    state = 'connecting';
    book.clearOwed();
    try {
      await created.connect(['order', 'pnl']);
      mine();
      if (created.accounts.length === 0) throw new Error('přihlášení nemá žádný účet');
      if (!protectionLoaded) {
        // Bez záznamu o vstupech a zavírání se nepřipojujeme: nevěděli bychom, co minulý běh rozdělal.
        const interrupted = await protection.load();
        mine();
        interruptedFlattens = interrupted;
        protectionLoaded = true;
      }
      const numbers = new Map<string, number>();
      for (const account of created.accounts) {
        const id = await config.registry.ensure({ system, fcmId: account.fcmId, ibId: account.ibId, accountId: account.accountId });
        mine();
        numbers.set(account.accountId, id);
      }
      numberByText.clear();
      textByNumber.clear();
      for (const [text, id] of numbers) {
        numberByText.set(text, id);
        textByNumber.set(id, text);
      }
      sessionIdentity = created.accounts.map((a) => `${a.accountId}|${a.fcmId}|${a.ibId}`).sort().join(',');
      const accountIds = [...textByNumber.keys()];
      for (const text of textByNumber.values()) {
        await created.subscribePnl(text);
        mine();
      }

      let positions: BrokerPosition[] = [];
      let baselineSeq = liveSeq;
      let seen = new Set<string>();
      let missing: BrokerOrder[] = [];
      let settled = false;
      for (let attempt = 0; attempt < BASELINE_ATTEMPTS && !settled; attempt += 1) {
        const seqBefore = liveSeq;
        baselineSeq = seqBefore;
        snapshotDirty = false;
        positions = [];
        seen = new Set();
        missing = [];
        for (const id of accountIds) {
          const read = await readOrders(created, id, { baseline: true, sinceSeq: seqBefore });
          mine();
          for (const basketId of read.seenIds) seen.add(`${id}:${basketId}`);
          missing.push(...read.missingActive);
          positions.push(...(await readPositions(created, id)));
          mine();
        }
        // Živá notifikace nebo opožděný řádek během skládání: stav se pod snímkem hnul, znovu.
        settled = liveSeq === seqBefore && !snapshotDirty;
      }
      if (!settled) throw new Error('výchozí stav se nepodařilo složit bez souběžné změny');
      if (missing.length) {
        // Příkaz, který jsme znali jako pracující, po obnově ve snímku není a jeho osud neznáme
        // (typicky přelom obchodního dne). Opakované přihlašování to nezmění → zastavit.
        incident('state-undetermined', `po připojení chybí dříve pracující příkaz ${missing.map((o) => o.brokerOrderId).join(', ')} — adaptér je zastavený, je nutné ruční spuštění`);
        halt();
        throw new Error('Rithmic: chybí dříve pracující příkaz, stav nejde určit');
      }

      // Výchozí stav PŘED `connected: true`: jádro si z něj uloží signatury a nic nekopíruje.
      const newer = touchedSince(baselineSeq);
      const orders = accountIds.flatMap((id) => book.list(id).filter((order) => seen.has(`${id}:${order.brokerOrderId}`) || newer.has(order.brokerOrderId)));
      for (const order of orders) {
        emit({ type: 'order', order, receivedAt: now() });
        mine(); // posluchač mohl adaptér zastavit
      }

      const reconnected = everConnected;
      let complete = true;
      let failureReason: string | undefined;
      if (reconnected && beforeOutage) {
        const after = knownOrders();
        const changed = [...after].filter(([key, value]) => seen.has(key) && beforeOutage!.get(key) !== value).map(([key]) => key);
        const gone = [...beforeOutage.keys()].filter((key) => !seen.has(key));
        if (changed.length || gone.length) {
          // Filly z mezery Rithmic nedává; rozdíl je jediná stopa, že se v ní něco stalo.
          complete = false;
          failureReason = `gap-fills-unverified: změněno nebo nové ${changed.length}, chybí ${gone.length}`;
        }
      }
      if (bookWasReset) {
        // Po ručním spuštění s čistou knihou není s čím porovnat: netvrdit, že se nic nestalo.
        complete = false;
        failureReason = 'book-reset: stav před zastavením nebyl porovnán';
      }
      const resync: BrokerResyncSnapshot = {
        accountIds, positions, orders, gapFills: [], complete, ...(failureReason ? { failureReason } : {}),
      };
      state = 'connected';
      everConnected = true;
      // Úplná obnova stavu (výchozí snímek příkazů i pozic) nejistotu po zavření ukončuje.
      exitUncertain.clear();
      for (const record of interruptedFlattens.splice(0)) {
        incident('flatten-interrupted', `minulý běh skončil uprostřed zavírání ${record.symbol} (značka ${record.tag}) — nic se neopakuje, zkontroluj pozici a příkazy`);
      }
      // Ochrana se vyhodnotí i z výchozího stavu: po restartu žádná živá zpráva nepřijde.
      for (const id of accountIds) {
        for (const intent of protection.bracketsFor(id)) {
          if (intent.entryId && intent.closedAt === undefined) scheduleBracketCheck(created, id, intent.entryId);
        }
      }
      beforeOutage = null;
      bookWasReset = false;
      reconnectFailures = 0;
      transportFailures = 0;
      reconnectDelay = config.reconnectMinMs ?? 2_000;
      emit({
        type: 'connection', connected: true, at: now(),
        ...(reconnected ? { reconnected: true, resynced: true } : {}),
        resync,
      });
      // Dluh exekucí vzniklý během připojování (hlídání se tehdy neozbrojuje) nesmí zůstat bez dozoru.
      // Jen příkazy z nového výchozího stavu: starý konečný příkaz, který snímek už nevrací,
      // by svou zastaralou mezerou vyvolával odpojení dokola.
      for (const order of orders) {
        if (client !== created) return;
        watchFillGap(created, order.accountId, order.brokerOrderId);
      }
    } catch (error) {
      // Uklízí jen ten, komu relace ještě patří; cizí (novější) relaci se nesahá na stav.
      if (client === created) {
        client = null;
        epoch += 1;
        clearSessionState();
        created.close();
        if (state === 'connecting') state = 'down';
      } else {
        try {
          created.close();
        } catch {
          // už zavřeno
        }
      }
      throw error;
    }
  }

  // ---- serverová ochrana (bracket) -------------------------------------------
  const saveProtection = async (): Promise<boolean> => {
    try {
      await protection.save();
      return true;
    } catch (error) {
      incident('attention', `záznam ochrany a zavírání se nepodařilo uložit: ${(error as Error).message}`);
      return false;
    }
  };

  function observeProtection(source: RithmicClient, account: number, update: RithmicOrderUpdate): void {
    const seen = protection.observe(account, update);
    if (seen.bound) void saveProtection();
    if (seen.entryId) scheduleBracketCheck(source, account, seen.entryId);
  }

  /** Živá pozice, jen když je novější než poslední vyplnění na kontraktu; jinak `undefined`. */
  function trustedLivePosition(account: number, symbol: string): number | undefined {
    const key = `${account}:${symbol}`;
    const live = livePositions.get(key);
    if (live === undefined) return undefined;
    return (positionSeenAt.get(key) ?? 0) > (fillSeenAt.get(key) ?? 0) ? live : undefined;
  }

  /** Čistá pozice kontraktu: důvěryhodná živá hodnota, jinak čtením. `null` = neznámá. */
  async function netPosition(source: RithmicClient, account: number, symbol: string): Promise<number | null> {
    const live = trustedLivePosition(account, symbol);
    if (live !== undefined) return live;
    try {
      const rows = await readPositions(source, account);
      if (client !== source) return null;
      return rows.find((row) => row.symbol === symbol)?.netQuantity ?? 0;
    } catch {
      return null;
    }
  }

  /**
   * Po každé změně vstupu, nohy nebo pozice: do `legsWaitMs` OD POSLEDNÍ změny musí ochrana
   * sedět (nejdéle 3× `legsWaitMs` od první). Adaptér nic nedostavuje ani nezavírá
   * (INV-OUTBOX-03) — jen hlásí. Stav se hlásí jednou, dokud se nezmění.
   */
  function scheduleBracketCheck(source: RithmicClient, account: number, entryId: string, retry = false): void {
    const key = `${account}:${entryId}`;
    if (client !== source) return;
    const wait = config.legsWaitMs ?? 3_000;
    const running = bracketTimers.get(key);
    const firstAt = running?.firstAt ?? now();
    if (running) clearTimeout(running.timer);
    // Strop omezuje jen celkové odkládání; kontrola nikdy neběží dřív než minimální odstup od
    // poslední změny (nohy vznikají ~40 ms po vyplnění, snímek pozic může být o chvíli pozadu).
    const delay = Math.max(Math.min(wait, 400), Math.min(wait, firstAt + 3 * wait - now()));
    const timer = setTimeout(() => {
      const mine = bracketTimers.get(key);
      bracketTimers.delete(key);
      void (async () => {
        if (client !== source || state !== 'connected') return;
        const intent = protection.bracketByEntry(account, entryId);
        if (!intent) return;
        const orderOf = (id: string): BrokerOrder | undefined => book.get(account, id);
        const fillKey = `${account}:${intent.symbol}`;
        const fillsBefore = fillSeenAt.get(fillKey) ?? 0;
        const net = await netPosition(source, account, intent.symbol);
        if (client !== source) return;
        // Během čtení přišla další změna a čeká novější kontrola — tahle už nic nehlásí.
        if (bracketTimers.has(key)) return;
        // Vyplnění během čtení pozice: přečtená hodnota k novému stavu příkazů nepatří → znovu.
        if ((fillSeenAt.get(fillKey) ?? 0) !== fillsBefore) {
          scheduleBracketCheck(source, account, entryId, Boolean(mine?.retried));
          return;
        }
        const result = protection.bracketState(account, entryId, orderOf, net, trustedLivePosition(account, intent.symbol) !== undefined);
        if (result.latch) {
          protection.closeBracket(account, entryId);
          bracketReported.delete(key);
          void saveProtection();
          return;
        }
        // Noha ještě čeká na potvrzení burzy: jedna další kontrola místo předčasného poplachu.
        if (result.state === 'unprotected' && !mine?.retried && protection.hasPendingLegs(account, entryId, orderOf)) {
          scheduleBracketCheck(source, account, entryId, true);
          return;
        }
        const signature = `${result.state}:${result.detail}`;
        if (bracketReported.get(key) === signature) return;
        bracketReported.set(key, signature);
        if (result.state === 'unprotected') {
          incident('bracket-legs-missing', `vstup ${entryId} (${intent.symbol}) má pozici bez úplné ochrany: ${result.detail} — nic se nedostavuje, rozhodni ručně`);
        } else if (result.state === 'orphan-legs') {
          incident('bracket-orphan-legs', `vstup ${entryId} (${intent.symbol}): ${result.detail}`);
        }
      })();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    bracketTimers.set(key, { timer, firstAt, retried: retry || Boolean(running?.retried) });
  }

  /** Záměr, ke kterému se do rozumné doby nenašel vstup, nikdo nehlídá — ohlásit. */
  function watchUnboundBracket(account: number, tag: string): void {
    const timer = setTimeout(() => {
      const intent = protection.bracketsFor(account).find((b) => b.tag === tag);
      if (intent && !intent.entryId) incident('attention', `vstup s ochranou se značkou ${tag} se nepodařilo dohledat — jeho ochranu nikdo nehlídá, ověř stav`);
    }, config.bracketBindWaitMs ?? 15_000);
    (timer as { unref?: () => void }).unref?.();
  }

  // ---- zavírání pozice --------------------------------------------------------
  const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  /** Krok s časovým stropem: brzda nesmí viset na jednom čtení. Chyba ani vypršení nevyhazují. */
  async function limited<T>(run: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; error: unknown; timedOut: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ ok: false; error: unknown; timedOut: boolean }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: new Error('vypršel čas kroku'), timedOut: true }), ms);
    });
    try {
      return await Promise.race([
        run.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error, timedOut: false })),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function waitUntil(done: () => boolean, ms: number): Promise<boolean> {
    const until = now() + ms;
    for (;;) {
      if (done()) return true;
      if (now() >= until) return false;
      await sleepMs(Math.min(15, Math.max(1, until - now())));
    }
  }
  function assertNotFlattening(accountId: number, symbol: string, what: string): void {
    if (flattening.has(`${accountId}:${symbol}`)) {
      throw new BrokerRequestNotSentError(`Rithmic: na ${symbol} právě běží zavírání pozice — ${what} neodesílám`);
    }
    if (exitUncertain.has(`${accountId}:${symbol}`)) {
      throw new BrokerRequestNotSentError(`Rithmic: zavření pozice ${symbol} odešlo a výsledek ještě není znám — ${what} neodesílám`);
    }
  }

  /**
   * Jednotný důkaz stavu kontraktu: příkazy i pozice přečtené tak, že se mezi tím nic
   * nevyplnilo. Pozice ze snímku PnL spojení může být starší než vyplnění z order spojení —
   * po čerstvém vyplnění se před čtením krátce čeká. `stable: false` = během důkazu přišlo
   * vyplnění, výsledek nic nedokazuje.
   */
  async function contractProof(active: RithmicClient, accountId: number, symbol: string, stepMs: number): Promise<{ net: number | null; ordersOk: boolean; stable: boolean; working: string[] }> {
    const key = `${accountId}:${symbol}`;
    const before = fillSeenAt.get(key) ?? 0;
    const orders = await limited(readOrders(active, accountId), stepMs);
    if (trustedLivePosition(accountId, symbol) === undefined && fillSeenAt.has(key)) await sleepMs(Math.min(150, stepMs));
    const positions = await limited(readPositions(active, accountId), stepMs);
    const net = positions.ok ? positions.value.find((row) => row.symbol === symbol)?.netQuantity ?? 0 : null;
    const working = book.list(accountId).filter((o) => o.symbol === symbol && !TERMINAL.has(o.status)).map((o) => o.brokerOrderId);
    return { net, ordersOk: orders.ok, stable: (fillSeenAt.get(key) ?? 0) === before, working };
  }

  /**
   * Zrušit pracující příkazy kontraktu → krátce ověřit → zavřít pozici stavovým požadavkem.
   * Brzda: čtení ani ověření zavření nevetují — neposílá se jen při PROKÁZANĚ nulové pozici.
   * Žádný zápis se neopakuje. Flat adaptér netvrdí; potvrzuje volající stavem (INV-MODE-02).
   */
  async function runFlatten(active: RithmicClient, request: BrokerLiquidateRequest, text: string, exchange: string): Promise<BrokerLiquidateResult> {
    const { accountId, symbol } = request;
    const stepMs = config.flattenStepMs ?? 1_000;
    const record: FlattenRecord = { tag: request.tag, accountId, symbol, phase: 'started', at: now() };
    protection.addFlatten(record);
    const key = `${accountId}:${symbol}`;
    /**
     * Fáze na disk. Brzda na záznam NEČEKÁ donekonečna (strop 300 ms) a jeho selhání ji
     * nezastaví — pak ale po pádu procesu neplatí ochrana proti opakování téže značky,
     * a proto se to hlásí.
     */
    const recordPhase = async (phase: FlattenRecord['phase'], result?: string): Promise<void> => {
      for (const row of [record, ...(joinedTags.get(key) ?? [])]) {
        row.phase = phase;
        if (result !== undefined) row.result = result;
      }
      const saved = await limited(saveProtection(), 300);
      if (!('value' in saved) || saved.value !== true) {
        incident('attention', `zavírání ${symbol}: fáze „${phase}" není uložená — po pádu procesu nebude tato operace chráněná proti opakování`);
      }
    };
    const finish = async (result: BrokerLiquidateResult, phase: FlattenRecord['phase'] = 'done'): Promise<BrokerLiquidateResult> => {
      await recordPhase(phase, result.status);
      return result;
    };
    await recordPhase('started');
    const working = (): string[] => book.list(accountId).filter((o) => o.symbol === symbol && !TERMINAL.has(o.status)).map((o) => o.brokerOrderId);
    const netFrom = (read: Awaited<ReturnType<typeof limited<BrokerPosition[]>>>): number | null =>
      read.ok ? read.value.find((row) => row.symbol === symbol)?.netQuantity ?? 0 : null;

    // Vlastní vstup vyplněný bez viditelných noh: nohy vznikají ~40 ms po vyplnění.
    const awaitingLegs = (): boolean => protection.bracketsFor(accountId, symbol).some((intent) => {
      if (!intent.entryId || intent.closedAt !== undefined) return false;
      const entry = book.get(accountId, intent.entryId);
      return Boolean(entry && entry.filledQuantity > 0 && protection.legsOf(accountId, intent.entryId).length === 0);
    });
    const flat = (proof: Awaited<ReturnType<typeof contractProof>>): boolean =>
      proof.ordersOk && proof.stable && proof.net === 0 && proof.working.length === 0 && !awaitingLegs();
    if (flat(await contractProof(active, accountId, symbol, stepMs))) {
      protection.resolveExits(accountId, symbol);
      exitUncertain.delete(key);
      return finish({ status: 'already-flat' });
    }

    // Zrušení: nejvýš dvě kola. Druhé je jen pro příkazy, které vznikly až během prvního
    // (nohy vstupu vyplněného pod rukama) — tentýž příkaz se neruší dvakrát.
    await recordPhase('canceling');
    const canceled = new Set<string>();
    const isDone = (id: string): boolean => {
      const order = book.get(accountId, id);
      return !order || TERMINAL.has(order.status);
    };
    for (let round = 0; round < 2; round += 1) {
      const targets = working().filter((id) => !canceled.has(id));
      if (targets.length) {
        for (const id of targets) {
          canceled.add(id);
          flattenCancelIds.add(`${accountId}:${id}`);
        }
        await limited(Promise.all(targets.map((id) => active.cancelOrder(text, id).catch(() => undefined))), stepMs);
        await waitUntil(() => targets.every(isDone), config.flattenCancelWaitMs ?? 1_000);
      }
      if (round === 1) break;
      // Zavřít teď by nohy nechalo pracovat na flat účtu → krátce na ně počkat a zrušit je ve 2. kole.
      if (awaitingLegs()) await waitUntil(() => !awaitingLegs(), Math.min(config.legsWaitMs ?? 3_000, 500));
      if (!working().some((id) => !canceled.has(id))) break;
    }
    const unconfirmed = [...canceled].filter((id) => !isDone(id));

    const proof = await contractProof(active, accountId, symbol, stepMs);
    const net = proof.net;
    if (net === 0) {
      // Pozici zavřelo něco jiného (např. vyplněná noha) — nic neposíláme a netvrdíme, že my.
      if (flat(proof)) {
        protection.resolveExits(accountId, symbol);
        exitUncertain.delete(key);
        return finish({ status: 'already-flat' });
      }
      incident('flatten-orders-remain', `${symbol}: pozice se čte jako 0, ale ${proof.stable ? `příkazy ${proof.working.join(', ') || '(stav nejde přečíst)'} dál pracují nebo to nejde ověřit` : 'během ověřování přišlo vyplnění — stav není prokázaný'}`);
      return finish({ status: 'indeterminate', reason: 'pozice je 0, ale stav kontraktu není prokázaný' });
    }
    // Dřívější zavření s neznámým výsledkem (i z minulého běhu): další se smí poslat jen proti
    // PŘEČTENÉ nenulové pozici. Bez čtení by šlo o druhé zavření naslepo.
    if (net === null && (exitUncertain.has(key) || protection.hasUnresolvedExit(accountId, symbol, request.tag))) {
      incident('flatten-orders-remain', `${symbol}: dřívější zavření má neznámý výsledek a pozici teď nejde přečíst — další zavření neposílám`);
      return finish({ status: 'indeterminate', reason: 'dřívější zavření má neznámý výsledek a pozici nejde přečíst' });
    }
    const earlierExit = exitUncertain.get(key);
    if (earlierExit && !earlierExit.settled) {
      // Brzda mezitím udělala, co šlo (čtení, zrušení příkazů); druhé zavření souběžně s prvním
      // by mohlo pozici otočit.
      return finish({ status: 'indeterminate', reason: 'předchozí zavření pozice je ještě na cestě — další neposílám, příkazy kontraktu jsou zrušené' });
    }
    // Zápis fáze PŘED odesláním: po restartu se tatáž operace nesmí poslat znovu.
    await recordPhase('exit-sent');
    // Dokud tenhle požadavek nedoběhne (odpovědí, nebo vypršením v klientovi), nesmí na
    // kontraktu odejít nic dalšího — ani zavření s jinou značkou (dvojí zavření = obrat pozice).
    const latch = { tag: request.tag, settled: false };
    exitUncertain.set(key, latch);
    const sending = active.exitPosition(text, symbol, exchange);
    void sending.then(
      () => 'answered' as const,
      (error: unknown) => (error instanceof RithmicRequestError && error.outcome !== 'unknown' ? ('answered' as const) : ('unknown' as const)),
    ).then((how) => {
      latch.settled = true;
      // Odpověď (i odmítnutí) nejistotu ukončí. Bez odpovědi zůstává: nové příkazy na kontraktu
      // neprojdou, dokud další zavírání nepřečte stav (to se smí spustit, protože požadavek doběhl).
      if (how === 'answered' && exitUncertain.get(key) === latch) exitUncertain.delete(key);
      else if (exitUncertain.get(key) === latch) incident('flatten-orders-remain', `${symbol}: zavření pozice zůstalo bez odpovědi — nové příkazy na kontraktu jsou zastavené, ověř stav a zavření zopakuj s novou značkou`);
    });
    const exit = await limited(sending, stepMs * 2);
    // Jedno kontrolní čtení po zavření — i při nejistém výsledku. Cokoli pracujícího je kritické.
    const check = setTimeout(() => {
      void (async () => {
        if (client !== active) {
          incident('flatten-orders-remain', `${symbol}: spojení spadlo před kontrolou po zavření pozice — ověř pozici a příkazy`);
          return;
        }
        const after = await limited(readOrders(active, accountId), stepMs * 2);
        if (client !== active) return;
        if (!after.ok || working().length) {
          incident('flatten-orders-remain', `${symbol}: po zavření pozice ${after.ok ? `dál pracují příkazy ${working().join(', ')}` : 'nejde přečíst stav příkazů'}`);
        }
      })();
    }, config.flattenPostCheckMs ?? 1_500);
    (check as { unref?: () => void }).unref?.();
    if (unconfirmed.length) {
      incident('flatten-cancel-unconfirmed', `${symbol}: zrušení příkazů ${unconfirmed.join(', ')} není potvrzené — mohou dál pracovat (zavření pozice: ${'error' in exit ? 'bez potvrzení' : 'přijato'})`);
    }
    if ('error' in exit) {
      if (!exit.timedOut && exit.error instanceof RithmicRequestError && exit.error.outcome === 'rejected') {
        const code = /^\d+$/.test(exit.error.rpCode[0] ?? '') ? ` (kód ${exit.error.rpCode[0]})` : '';
        return finish({ status: 'rejected', reason: `Rithmic zavření pozice odmítl${code}` });
      }
      if (!exit.timedOut && exit.error instanceof RithmicRequestError && exit.error.outcome === 'not-sent') {
        return finish({ status: 'rejected', reason: 'požadavek na zavření se nepodařilo odeslat' });
      }
      return finish({ status: 'indeterminate', reason: 'odpověď na zavření pozice nepřišla — výsledek je neznámý' }, 'exit-sent');
    }
    return finish({ status: 'submitted' });
  }

  // ---- pomocné pro port ----------------------------------------------------
  function activeClient(): RithmicClient {
    if (!client || state !== 'connected') throw new BrokerRequestNotSentError('Rithmic: spojení není připravené');
    return client;
  }

  function accountText(accountId: number, forWrite: boolean): string {
    const text = textByNumber.get(accountId);
    if (text !== undefined) return text;
    const message = `Rithmic: účet ${accountId} není v aktuálním přihlášení`;
    throw forWrite ? new BrokerRequestNotSentError(message) : new Error(message);
  }

  /** Chyba zápisu → kontrakt portu. Žádný chybový kód není změřený jako „příkaz nevznikl". */
  function rethrowWrite(error: unknown, what: string): never {
    if (error instanceof RithmicRequestError && error.outcome === 'not-sent') throw new BrokerRequestNotSentError(error.message);
    // Jen číselný kód: text serveru (např. „rejected at RMS") se do výjimky nesmí dostat,
    // jádro podle slov „rejected/odmít" v textu rozlišuje definitivní odmítnutí.
    const code = error instanceof RithmicRequestError && /^\d+$/.test(error.rpCode[0] ?? '') ? ` (kód ${error.rpCode[0]})` : '';
    throw new Error(`Rithmic: výsledek operace „${what}" je neznámý${code} — ověř stav čtením`);
  }

  function waitForTerminal(accountId: number, brokerOrderId: string): { promise: Promise<boolean>; cancel: () => void } {
    const text = textByNumber.get(accountId);
    let done: (value: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      done = resolve;
    });
    const finish = (value: boolean): void => {
      clearTimeout(timer);
      orderWaiters.delete(waiter);
      done(value);
    };
    const waiter = (update: RithmicOrderUpdate): void => {
      if (update.accountId !== text || update.basketId !== brokerOrderId) return;
      // Kniha zprávu uplatní hned po čekatelích; podívat se až po ní.
      queueMicrotask(() => {
        const order = book.get(accountId, brokerOrderId);
        if (order && (order.status === 'canceled' || order.status === 'filled')) finish(true);
      });
    };
    const timer = setTimeout(() => finish(false), config.confirmWaitMs ?? 1_500);
    orderWaiters.add(waiter);
    return { promise, cancel: () => finish(false) };
  }

  const port: RithmicBrokerPort = {
    environment,

    async start(): Promise<void> {
      if (state !== 'idle' && state !== 'halted') throw new Error('Rithmic: adaptér už běží');
      state = 'idle';
      reconnectFailures = 0;
      transportFailures = 0;
      if (freshBookOnStart) {
        // Ruční spuštění po zastavení: obsluha stav potvrdila, začíná se s čistou knihou
        // (jinak by tentýž chybějící příkaz adaptér zastavil znovu).
        book.reset();
        beforeOutage = null;
        freshBookOnStart = false;
        bookWasReset = everConnected;
        selfDrops = [];
      }
      try {
        await connectOnce();
      } catch (error) {
        // `connectOnce` stav mění; čteme ho přes funkci, aby ho překladač nepovažoval za 'idle'.
        if (currentState() === 'down') scheduleReconnect();
        throw error;
      }
    },

    stop(): void {
      halt();
      state = 'idle';
    },

    isConnected: () => state === 'connected',
    isHalted: () => state === 'halted',
    accountIds: () => [...textByNumber.keys()],
    routeEpoch: () => epoch,

    async placeOrder(request: BrokerOrderRequest): Promise<BrokerOrderAck> {
      const active = activeClient();
      const text = accountText(request.accountId, true);
      const exchange = rithmicExchangeForSymbol(request.symbol);
      if (!exchange) throw new BrokerRequestNotSentError(`Rithmic: neznámá burza pro symbol ${request.symbol}`);
      if (!active.hasTradeRoute(exchange)) throw new BrokerRequestNotSentError(`Rithmic: účet nemá trade route pro ${exchange}`);
      if (!request.tag) throw new BrokerRequestNotSentError('Rithmic: příkaz bez značky');
      if (protection.hasTag(request.accountId, request.tag)) throw new BrokerRequestNotSentError(`Rithmic: značku ${request.tag} už nese vstup s ochranou`);
      assertNotFlattening(request.accountId, request.symbol, 'nový příkaz');
      try {
        const ack = await active.placeOrder({
          accountId: text,
          userTag: request.tag,
          symbol: request.symbol,
          exchange,
          side: rithmicSide(request.side),
          quantity: request.quantity,
          priceType: rithmicPriceType(request.orderType),
          price: request.limitPrice,
          triggerPrice: request.stopPrice,
        });
        // „Přijato" = Rithmic příkaz eviduje. Odmítnutí RMS nebo burzou přijde jako událost `order`.
        return { brokerOrderId: ack.basketId, accepted: true, definitive: true };
      } catch (error) {
        return rethrowWrite(error, 'nový příkaz');
      }
    },

    async placeBracket(request: BrokerBracketRequest): Promise<BrokerBracketAck> {
      const active = activeClient();
      const text = accountText(request.accountId, true);
      const exchange = rithmicExchangeForSymbol(request.symbol);
      if (!exchange) throw new BrokerRequestNotSentError(`Rithmic: neznámá burza pro symbol ${request.symbol}`);
      if (!active.hasTradeRoute(exchange)) throw new BrokerRequestNotSentError(`Rithmic: účet nemá trade route pro ${exchange}`);
      if (!request.tag) throw new BrokerRequestNotSentError('Rithmic: příkaz bez značky');
      for (const ticks of [request.stopTicks, request.targetTicks]) {
        if (ticks !== undefined && !(Number.isInteger(ticks) && ticks > 0)) throw new BrokerRequestNotSentError('Rithmic: vzdálenost SL/TP musí být kladný celý počet ticků');
      }
      if (request.stopTicks === undefined && request.targetTicks === undefined) throw new BrokerRequestNotSentError('Rithmic: vstup s ochranou bez SL i TP');
      if (protection.bracketsFor(request.accountId).some((b) => b.tag === request.tag)) {
        throw new BrokerRequestNotSentError(`Rithmic: vstup se značkou ${request.tag} už byl odeslán — neopakuji`);
      }
      assertNotFlattening(request.accountId, request.symbol, 'nový vstup');
      const brakeKey = `${request.accountId}:${request.symbol}`;
      const brakeGeneration = flattenGeneration.get(brakeKey) ?? 0;
      // Záměr se ukládá PŘED odesláním: po restartu podle něj poznáme, jaká ochrana měla vzniknout.
      protection.addBracket({
        tag: request.tag, accountId: request.accountId, symbol: request.symbol, side: request.side, quantity: request.quantity,
        ...(request.stopTicks !== undefined ? { stopTicks: request.stopTicks } : {}),
        ...(request.targetTicks !== undefined ? { targetTicks: request.targetTicks } : {}),
        createdAt: now(),
      });
      if (!(await saveProtection())) {
        protection.dropBracket(request.tag);
        throw new BrokerRequestNotSentError('Rithmic: záznam o vstupu s ochranou nejde uložit — neodesílám');
      }
      // Během ukládání mohlo začít (i skončit) zavírání pozice — vstup rozhodnutý před ním neplatí.
      const brakeMoved = (flattenGeneration.get(brakeKey) ?? 0) !== brakeGeneration || flattening.has(brakeKey) || exitUncertain.has(brakeKey);
      if (client !== active || brakeMoved) {
        protection.dropBracket(request.tag);
        void saveProtection();
        throw new BrokerRequestNotSentError(brakeMoved ? `Rithmic: na ${request.symbol} mezitím začalo zavírání pozice — vstup neodesílám` : 'Rithmic: spojení není připravené');
      }
      try {
        const ack = await active.placeBracketOrder({
          accountId: text,
          userTag: request.tag,
          symbol: request.symbol,
          exchange,
          side: rithmicSide(request.side),
          quantity: request.quantity,
          priceType: rithmicPriceType(request.orderType),
          price: request.limitPrice,
          triggerPrice: request.stopPrice,
          stopTicks: request.stopTicks,
          targetTicks: request.targetTicks,
        });
        const intent = protection.bracketsFor(request.accountId).find((b) => b.tag === request.tag);
        if (intent && !intent.entryId) {
          intent.entryId = ack.basketId;
          void saveProtection();
        }
        // „Přijato" = Rithmic vstup eviduje. Odmítnutí RMS nebo burzou přijde jako událost `order`.
        return { entryBrokerOrderId: ack.basketId, accepted: true, definitive: true };
      } catch (error) {
        if (error instanceof RithmicRequestError && error.outcome === 'not-sent') {
          protection.dropBracket(request.tag);
          void saveProtection();
        } else {
          watchUnboundBracket(request.accountId, request.tag);
        }
        return rethrowWrite(error, 'nový vstup s ochranou');
      }
    },

    bracketState(accountId: number, entryBrokerOrderId: string): { state: BracketState; detail: string } {
      const intent = protection.bracketByEntry(accountId, entryBrokerOrderId);
      const net = intent ? trustedLivePosition(accountId, intent.symbol) ?? null : null;
      const { state: bracket, detail } = protection.bracketState(accountId, entryBrokerOrderId, (id) => book.get(accountId, id), net);
      return { state: bracket, detail };
    },

    async liquidatePosition(request: BrokerLiquidateRequest): Promise<BrokerLiquidateResult> {
      const key = `${request.accountId}:${request.symbol}`;
      // Druhé volání během běhu se připojí k běžící operaci — nic nového neodesílá.
      const running = flattening.get(key);
      if (running) {
        // Připojená značka dostane stejný trvalý záznam — její pozdější opakování nic neodešle.
        if (request.tag && !protection.flattenByTag(request.tag)) {
          const alias: FlattenRecord = { tag: request.tag, accountId: request.accountId, symbol: request.symbol, phase: 'started', at: now() };
          protection.addFlatten(alias);
          joinedTags.set(key, [...(joinedTags.get(key) ?? []), alias]);
          // Záznam připojené značky musí být na disku dřív, než volající dostane výsledek.
          const result = await running;
          await saveProtection();
          return result;
        }
        return running;
      }
      const active = activeClient();
      const text = accountText(request.accountId, true);
      const exchange = rithmicExchangeForSymbol(request.symbol);
      if (!exchange) throw new BrokerRequestNotSentError(`Rithmic: neznámá burza pro symbol ${request.symbol}`);
      if (!request.tag) throw new BrokerRequestNotSentError('Rithmic: zavření bez značky');
      const earlier = protection.flattenByTag(request.tag);
      if (earlier) {
        // Tatáž operace už proběhla (i v minulém běhu): jen dočíst stav, nikdy znovu neposílat.
        const proof = await contractProof(active, request.accountId, request.symbol, config.flattenStepMs ?? 1_000);
        if (proof.ordersOk && proof.stable && proof.net === 0 && proof.working.length === 0) {
          // Stav je prokázaný — nejistota po dřívějším zavření končí.
          protection.resolveExits(request.accountId, request.symbol);
          exitUncertain.delete(key);
          void saveProtection();
          return { status: 'already-flat' };
        }
        return { status: 'indeterminate', reason: `zavření se značkou ${request.tag} už proběhlo (fáze ${earlier.phase}) — neopakuji, ověř stav` };
      }
      // Předchozí požadavek doběhl bez odpovědi: nová operace začíná čtením stavu, nejistota končí.
      // Dokud je ještě na cestě, nové zavírání smí číst a rušit, ale další zavření NEPOŠLE (viz runFlatten).
      if (exitUncertain.get(key)?.settled) exitUncertain.delete(key);
      flattenGeneration.set(key, (flattenGeneration.get(key) ?? 0) + 1);
      const run = runFlatten(active, request, text, exchange).finally(() => {
        flattening.delete(key);
        joinedTags.delete(key);
        // Úklid jen příkazů TÉTO operace (ty, které jsou v okamžiku konce v seznamu účtu).
        const mine = [...flattenCancelIds].filter((id) => id.startsWith(`${request.accountId}:`));
        const clear = setTimeout(() => {
          for (const id of mine) flattenCancelIds.delete(id);
        }, 5_000);
        (clear as { unref?: () => void }).unref?.();
      });
      flattening.set(key, run);
      return run;
    },

    async cancelOrder(accountId: number, brokerOrderId: string): Promise<void | BrokerCancelConfirmation> {
      const active = activeClient();
      const text = accountText(accountId, true);
      const known = book.get(accountId, brokerOrderId);
      // Noha se známou vazbou, nebo příkaz bracketu, u kterého vazbu ještě neznáme (první zpráva
      // nohy ji nenese) — konzervativně stejně. Vlastní vstup je běžné zrušení.
      let maybeLeg = Boolean(protection.legOf(accountId, brokerOrderId));
      if (!maybeLeg && known?.brokerOrderType?.startsWith('BRACKET:') && !protection.bracketByEntry(accountId, brokerOrderId)) {
        // Bracket bez známé vazby: buď cizí/starý VSTUP (ruší se běžně), nebo noha, jejíž první
        // zpráva vazbu ještě nenesla. Snímek vazby nese celé → rozhodne čtení; když selže, odmítnout.
        try {
          await readOrders(active, accountId);
        } catch {
          throw new BrokerRequestNotSentError(`Rithmic: u příkazu ${brokerOrderId} nejde ověřit, zda není nohou serverové ochrany — zrušení neodesílám`);
        }
        if (client !== active) throw new BrokerRequestNotSentError('Rithmic: spojení není připravené');
        maybeLeg = Boolean(protection.legOf(accountId, brokerOrderId));
      }
      if (maybeLeg) {
        // Změřeno: zrušení jedné nohy zruší i sestru → pozice by zůstala bez ochrany. Povoleno
        // jen při prokazatelně nulové pozici (úklid osiřelé nohy); jinak přes zavření pozice.
        const symbol = known?.symbol;
        // Po čerstvém vyplnění může být i snímek pozic o chvíli pozadu → krátce počkat.
        if (symbol && trustedLivePosition(accountId, symbol) === undefined && fillSeenAt.has(`${accountId}:${symbol}`)) await sleepMs(150);
        const net = symbol ? await netPosition(active, accountId, symbol) : null;
        if (net !== 0) {
          throw new BrokerRequestNotSentError(`Rithmic: příkaz ${brokerOrderId} je noha serverové ochrany — zrušení by zrušilo i druhou nohu a pozice (${net ?? 'neznámá'}) by zůstala bez ochrany`);
        }
        if (client !== active) throw new BrokerRequestNotSentError('Rithmic: spojení není připravené');
      }
      const waiter = waitForTerminal(accountId, brokerOrderId);
      try {
        // Změřeno: odpověď „ok" přijde i pro neexistující příkaz — sama nic nedokazuje.
        await active.cancelOrder(text, brokerOrderId);
      } catch (error) {
        waiter.cancel();
        return rethrowWrite(error, 'zrušení příkazu');
      }
      if (!(await waiter.promise)) return undefined;
      const order = book.get(accountId, brokerOrderId);
      if (!order || (order.status !== 'canceled' && order.status !== 'filled')) return undefined;
      return { confirmedBy: 'stream-terminal', order };
    },

    async modifyOrder(
      accountId: number,
      brokerOrderId: string,
      changes: { quantity: number; orderType: OrderType; limitPrice?: number; stopPrice?: number },
    ): Promise<void | BrokerModifyConfirmation> {
      const active = activeClient();
      const text = accountText(accountId, true);
      const known = book.get(accountId, brokerOrderId);
      if (!known) throw new BrokerRequestNotSentError(`Rithmic: příkaz ${brokerOrderId} neznám, změnu neodesílám`);
      if (known.orderType === 'Unsupported') {
        throw new BrokerRequestNotSentError(`Rithmic: příkaz ${brokerOrderId} je typu, který adaptér nemění (${known.brokerOrderType ?? 'neznámý'})`);
      }
      const exchange = rithmicExchangeForSymbol(known.symbol);
      if (!exchange) throw new BrokerRequestNotSentError(`Rithmic: neznámá burza pro symbol ${known.symbol}`);
      assertNotFlattening(accountId, known.symbol, 'změnu příkazu');
      try {
        await active.modifyOrder({
          accountId: text,
          basketId: brokerOrderId,
          symbol: known.symbol,
          exchange,
          quantity: changes.quantity,
          priceType: rithmicPriceType(changes.orderType),
          price: changes.limitPrice,
          triggerPrice: changes.stopPrice,
        });
      } catch (error) {
        return rethrowWrite(error, 'změna příkazu');
      }
      // Burzovní potvrzení nejde přiřadit konkrétnímu požadavku → jádro ověří čtením.
      return undefined;
    },

    async listAccountCapabilities(accountIds: readonly number[]): Promise<BrokerAccountCapability[]> {
      const active = activeClient();
      const fresh = await active.fetchAccounts();
      // Identitu tvoří účet + FCM + IB; prázdná nebo jiná odpověď = nevíme, čí účty obsluhujeme.
      if (fresh.map((a) => `${a.accountId}|${a.fcmId}|${a.ibId}`).sort().join(',') !== sessionIdentity) {
        incident('accounts-changed', 'seznam účtů se od přihlášení změnil — odpojuji a přihlásím se znovu');
        dropAndReconnect();
        throw new Error('Rithmic: seznam účtů se změnil, způsobilost nejde potvrdit');
      }
      const rms = await active.accountRmsInfo();
      const statusByAccount = new Map<string, string>();
      for (const row of rms) {
        if (typeof row.account_id === 'string' && row.account_id) statusByAccount.set(row.account_id, typeof row.status === 'string' ? row.status.trim().toLowerCase() : '');
      }
      return accountIds.map((accountId) => {
        const text = textByNumber.get(accountId);
        return {
          accountId,
          active: text !== undefined,
          // Trade route se čte při přihlášení (ne při každém dotazu) a v1 obchoduje jen burzy z pevné tabulky.
          canTrade: text !== undefined && statusByAccount.get(text) === 'active' && active.hasTradeRoute('CME'),
        };
      });
    },

    async listAccountRiskSnapshots(accountIds: readonly number[]): Promise<BrokerAccountRiskSnapshot[]> {
      const active = activeClient();
      const maxAge = config.riskSnapshotMaxAgeMs ?? 15_000;
      const out: BrokerAccountRiskSnapshot[] = [];
      for (const accountId of accountIds) {
        accountText(accountId, false);
        let pnl = accountPnl.get(accountId);
        if (!pnl || now() - pnl.receivedAt > maxAge) {
          await readPositions(active, accountId);
          pnl = accountPnl.get(accountId);
        }
        // Bez čerstvého snímku P&L není co vracet: samé `null` s čerstvým časem by vypadalo jako odpověď.
        if (!pnl || now() - pnl.receivedAt > maxAge) throw new Error(`Rithmic: čerstvý snímek P&L účtu ${accountId} není k dispozici`);
        out.push({
          accountId,
          at: pnl.receivedAt,
          realizedPnlUsd: pnl.closedPnl,
          realizedTradeDate: null,
          openPnlUsd: pnl.openPnl,
          // Rithmic tyto hodnoty v použitelném tvaru neposílá — nikdy je nenahrazovat nulou.
          netLiq: null,
          minNetLiq: null,
          dailyLossAutoLiq: null,
          trailingMaxDrawdown: null,
          cashBalanceUsd: pnl.accountBalance,
        });
      }
      return out;
    },

    async listPositions(accountId: number): Promise<BrokerPosition[]> {
      const active = activeClient();
      accountText(accountId, false);
      return readPositions(active, accountId);
    },

    async listOrders(accountId: number): Promise<BrokerOrder[]> {
      const active = activeClient();
      accountText(accountId, false);
      return (await readOrders(active, accountId)).orders;
    },

    async findOrdersByTag(accountId: number, tag: string): Promise<BrokerOrderLookup> {
      const active = activeClient();
      accountText(accountId, false);
      // Jen příkazy, které snímek skutečně obsahoval — zbytek v paměti není důkaz.
      const orders = (await readOrders(active, accountId)).orders.filter((order) => order.tag === tag);
      // Nalezený příkaz z úplného snímku je kladný důkaz; „nenalezeno" autoritu nemá.
      return { orders, completeness: orders.length ? 'authoritative' : 'eventual', observedAt: now() };
    },

    async findOrderById(accountId: number, brokerOrderId: string): Promise<BrokerOrderStateLookup> {
      const active = activeClient();
      accountText(accountId, false);
      const order = (await readOrders(active, accountId)).orders.find((o) => o.brokerOrderId === brokerOrderId) ?? null;
      return { order, completeness: order ? 'authoritative' : 'eventual', observedAt: now() };
    },

    subscribe(listener: (event: BrokerEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return port;
}
