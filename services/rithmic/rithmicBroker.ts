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
import { quantityLimits, type RithmicQuantityLimits } from './rithmicQuantityLimits';
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
  type OrderSide,
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
  /**
   * Prodleva obnovy se vrací na minimum až po relaci, která vydržela aspoň takto dlouho (výchozí 60 s).
   * Spojení, které se přihlásí a hned spadne, by jinak zkoušelo každé 2 s — a každé přihlášení posílá
   * dotaz na účty, který Rithmic počítá do tvrdého limitu (18. 11. 2026 vypnul uživatele po 2000 dotazech).
   */
  stableSessionMs?: number;
  /**
   * Zavolá se PŘED každým přihlášením k příkazům. `false` = rozpočet přihlášení je vyčerpán: adaptér se
   * zastaví s incidentem a sám se už nepřipojí (ruční spuštění). Bez této volby se přihlášení nepočítají.
   */
  loginAllowed?: () => boolean;
  /**
   * Rithmic oznámil změnu účtu (šablona 358) na spojení této relace. Jen signál: volající si limity přečte znovu
   * (se svým rozestupem a rozpočtem). Zpráva pro jiný účet, než má tato relace, se nepředává.
   */
  onAccountUpdate?: () => void;
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
  /** Jak dlouho po odeslání zavření se další zavření neposílá, ani když pozice ještě trvá (výchozí 1,5 s). */
  exitSettleMs?: number;
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
  accountName(accountId: number): string | null;
  readQuantityLimits(accountId: number, product: string): Promise<RithmicQuantityLimits | null>;
  /**
   * Zmenší ochranu vlastního vstupu na `quantity` kusů (jedna změna množství TP nohy; burza změní obě nohy —
   * změřeno 17. 11. 2026). Záměr se uloží před zápisem. Vrátí se až po potvrzení obou noh stavem. Po návratu
   * MUSÍ volající zavolat `endBracketResize` (s počtem kusů, které prokazatelně zavřel mimo nohy, nebo 0).
   */
  beginBracketResize(accountId: number, entryBrokerOrderId: string, quantity: number): Promise<void>;
  endBracketResize(accountId: number, entryBrokerOrderId: string, exitedQuantity: number): Promise<void>;
  /** Pozice ze snímku a potvrzených exekucí. Při chybějícím údaji vrací null. */
  executionNet(accountId: number, symbol: string): number | null;
  /** Průměrná vstupní cena z posledního snímku pozic — JEN zobrazení (čára pozice po obnově spojení). */
  snapshotAveragePrice(accountId: number, symbol: string): number | null;
  /**
   * Uzavřený (realizovaný) P&L účtu z PnL streamu Rithmicu (closed_position_pnl, bez dotazu navíc) — JEN zobrazení
   * v liště grafu. Nic se podle něj nerozhoduje (žádné brány, limity ani příkazy). Null = zatím nepřišel.
   */
  accountClosedPnl?(accountId: number): { closedPnl: number | null; at: number } | null;
  placeBracket(request: BrokerBracketRequest): Promise<BrokerBracketAck>;
  /**
   * Dva výstupní příkazy svázané burzou (OCO): SL (Stop) a TP (Limit) na stejné množství. Vyplnění nebo
   * zrušení jednoho ruší druhý na serveru (změřeno 17. 11. 2026). Jeden zápis; nejistý výsledek se neopakuje.
   */
  placeExitPair(request: { accountId: number; symbol: string; side: OrderSide; quantity: number; stop: { tag: string; stopPrice: number }; target: { tag: string; limitPrice: number } }): Promise<{ stopOrderId: string; targetOrderId: string }>;
  liquidatePosition(request: BrokerLiquidateRequest): Promise<BrokerLiquidateResult>;
  /** Stav serverové ochrany vlastního vstupu (jen čtení paměti; pozice z živých zpráv). */
  bracketState(accountId: number, entryBrokerOrderId: string): { state: BracketState; detail: string };
  /** Značky neuzavřených záměrů vstupu s ochranou, u kterých ještě není znám příkaz u brokera (jen čtení paměti). */
  unresolvedBracketTags(accountId: number, symbol: string): string[];
  /** Vlastní vstupy s ochranou a jejich nohy (jen pro zobrazení). */
  listBrackets(accountId: number): Array<{ tag: string; symbol: string; entryId: string; closed: boolean; stopTicks?: number; targetTicks?: number; legs: Array<{ orderId: string; role: 'stop' | 'target' | 'unknown' }> }>;
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
  const fillSeenAt = new Map<string, number>();
  /** Zavření odešlo a odpověď nepřišla (`účet:kontrakt`) — dokud požadavek nedoběhne, nic dalšího. */
  /**
   * Zavření pozice odešlo a jeho výsledek ještě NEPOTVRDIL STAV (`účet:kontrakt`). Odpověď
   * serveru nestačí — zavírací příkaz se vyplní až po ní. Dokud záznam trvá, nové příkazy na
   * kontraktu neprojdou a další zavření se řídí pravidly v `runFlatten`.
   */
  const closing = new Map<string, { tag: string; sentAt: number; requestDone: boolean; accepted: boolean }>();
  /**
   * Pozice dopočítaná z vyplnění: výchozí stav po připojení + součet doručených exekucí.
   * Dva nezávislé zdroje (order spojení a PnL spojení) — když se shodnou, živé pozici lze
   * věřit i tehdy, když její zpráva dorazila o chvíli dřív než zpráva o vyplnění.
   * `null` = dopočet neplatí (exekuce bez údajů, vyplnění nalezené až snímkem).
   */
  const expectedNet = new Map<string, number | null>();
  /** Příkazy (`účet:příkaz`), které měly ve výchozím stavu relace nenulové vyplnění. */
  const baselineFilled = new Set<string>();
  /** Zápisy na cestě (značka → `účet:kontrakt`): odeslané, ale ještě nepotvrzené ani v knize. */
  const inflight = new Map<string, { key: string; at: number; uncertain: boolean }>();
  /** Značky příkazů zadaných AŽ PO posledním zavírání — jen ty nejsou „zbytek po zavření". */
  const postFlattenTags = new Map<string, Set<string>>();
  /** Kolikrát po sobě kontrola ochrany nedokázala stav určit. */
  const bracketUnknown = new Map<string, number>();
  /** Roste s každým začátkem zavírání na klíči — zápis rozhodnutý před ním už neplatí. */
  const flattenGeneration = new Map<string, number>();
  /** Značky volání připojených k běžící operaci (dostanou stejný trvalý záznam). */
  const joinedTags = new Map<string, FlattenRecord[]>();
  const bracketReported = new Map<string, string>();
  /** Podezřelý stav z první kontroly; incident vznikne, až ho druhá kontrola potvrdí. */
  const bracketSuspect = new Map<string, string>();
  /** Běžící zavírání (`účet:kontrakt`). Po dobu běhu se na kontraktu nepřijímají nové příkazy. */
  const flattening = new Map<string, Promise<BrokerLiquidateResult>>();
  /** Příkazy rušené zavíráním — jejich CANCELLATION_FAILED (sestra už skončila) není incident. */
  const flattenCancelIds = new Set<string>();

  let state: State = 'idle';
  let client: RithmicClient | null = null;
  let epoch = 0;
  let everConnected = false;
  let reconnectDelay = config.reconnectMinMs ?? 2_000;
  /** Kdy se naposledy povedlo složit relaci; null = od té doby už byla prodleva vyhodnocena. */
  let connectedAt: number | null = null;
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
  const livePositions = new Map<string, number | null>();
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
  /** Průměrná vstupní cena z posledního snímku pozic. JEN zobrazení — nikdy do kontrol ani do ochrany. */
  const snapshotAverage = new Map<string, number>();
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
  const serialRead = <T>(run: () => Promise<T>, label = 'čtení'): Promise<T> => {
    const queuedAt = now();
    const timed = async (): Promise<T> => {
      const startedAt = now();
      try {
        return await run();
      } finally {
        // Diagnostika: čtení jdou za sebou, takže jedno pomalé zdrží všechna další (i brzdu).
        const took = now() - startedAt;
        if (took > 1_000 || startedAt - queuedAt > 1_000) incident('attention', `pomalé čtení (${label}): ${took} ms, ve frontě ${startedAt - queuedAt} ms`);
      }
    };
    const next = readChain.then(timed, timed);
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
    queuedPositionRead.clear();
    bracketSuspect.clear();
    bracketReported.clear();
    bracketUnknown.clear();
    inflight.clear();
    for (const entry of bracketTimers.values()) clearTimeout(entry.timer);
    bracketTimers.clear();
    fillSeenAt.clear();
    expectedNet.clear();
    baselineFilled.clear();
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
    if (account !== undefined && update.basketId && (delta.fill || delta.awaitingFill || (update.notifyType === 'FILL' && !delta.duplicateFill))) {
      const symbol = update.symbol || book.get(account, update.basketId)?.symbol;
      if (symbol) {
        const fillKey = `${account}:${symbol}`;
        fillSeenAt.set(fillKey, (eventSeq += 1));
        // Dopočet pozice: jen z úplné exekuce; cokoli jiného (FILL bez údajů, jen „vyplněno"
        // od Rithmicu) dopočet zneplatní do další obnovy stavu.
        // Kontrakt, který výchozí stav neuváděl, začíná na 0 (výchozí stav je autoritativní).
        const known = expectedNet.has(fillKey) ? expectedNet.get(fillKey) : state === 'connected' ? 0 : null;
        // Exekuce příkazu, který byl vyplněný (i zčásti) už ve výchozím stavu, může být opožděná
        // a v pozici z výchozího stavu už zahrnutá → nepočítá se a dopočet zneplatní.
        const ambiguous = baselineFilled.has(`${account}:${update.basketId}`);
        if (delta.fill && !ambiguous && known !== null && known !== undefined) {
          expectedNet.set(fillKey, known + (delta.fill.side === 'Buy' ? delta.fill.quantity : -delta.fill.quantity));
        } else if (delta.fill || update.notifyType === 'FILL') {
          // Exekuce, kterou nejde jednoznačně započítat (bez údajů, už zahrnutá, nesedí množství).
          expectedNet.set(fillKey, null);
        }
        // Samotné „vyplněno" od Rithmicu (bez exekuce) dopočet nemění — exekuce z burzy teprve přijde;
        // kdyby nepřišla, adaptér se pro chybějící exekuci odpojí a dopočet začne znovu.
        // Pozice, která přišla těsně PŘED touto exekucí a s dopočtem sedí, je tím potvrzená.
        if (delta.fill && livePositions.get(fillKey) === 0 && validExpectedNet(account, symbol) === 0) strongZero(account, symbol);
      }
      // Vyplnění vstupu, který už byl uzavřený (zrušení × vyplnění): západka padá.
      if (protection.bracketByEntry(account, update.basketId) && protection.reopenBracket(account, update.basketId)) void saveProtection();
    }
    if (update.userTag && delta.order) inflight.delete(update.userTag); // příkaz je v knize
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
      // Průměrná cena ze snímku — jen pro zobrazení (čára pozice po obnově spojení i na klidném trhu).
      if (position.avgOpenFillPrice !== null && position.netQuantity) snapshotAverage.set(`${account}:${position.symbol}`, position.avgOpenFillPrice);
      else snapshotAverage.delete(`${account}:${position.symbol}`);
      return;
    }
    if (position.netQuantity === null) {
      positionSeq.set(account, (positionSeq.get(account) ?? 0) + 1);
      livePositions.set(`${account}:${position.symbol}`, null);
      incident('attention', `pozice ${position.symbol} bez množství — neznámá, ne nulová`);
      return;
    }
    const positionKey = `${account}:${position.symbol}`;
    if (livePositions.get(positionKey) !== position.netQuantity) {
      livePositions.set(positionKey, position.netQuantity);
      positionSeq.set(account, (positionSeq.get(account) ?? 0) + 1);
      for (const intent of protection.bracketsFor(account, position.symbol)) {
        if (intent.entryId && intent.closedAt === undefined) scheduleBracketCheck(source, account, intent.entryId);
      }
    }
    // Nula, která sedí s dopočtem z exekucí, je silná: uzavře skončené vstupy a vyřeší zavírání.
    if (position.netQuantity === 0 && validExpectedNet(account, position.symbol) === 0) strongZero(account, position.symbol);
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
    if (connectedAt !== null) {
      if (now() - connectedAt >= (config.stableSessionMs ?? 60_000)) reconnectDelay = config.reconnectMinMs ?? 2_000;
      connectedAt = null;
    }
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
      const readStartedAt = now();
      const rows = await source.showOrders(text);
      if (client !== source) throw new Error('Rithmic: spojení spadlo během čtení příkazů');
      const newer = touchedSince(sinceSeq);
      const result = book.replaceFromSnapshot(account, rows, newer, { baseline: options.baseline });
      if (!options.baseline) {
        // Vyplnění, které poznal až snímek (živá zpráva chyběla), je vyplnění jako každé jiné:
        // živé pozici se přestane věřit a rozdělaný důkaz stavu neplatí.
        for (const order of result.changed) {
          if (order.filledQuantity <= 0) continue;
          fillSeenAt.set(`${account}:${order.symbol}`, (eventSeq += 1));
          expectedNet.set(`${account}:${order.symbol}`, null);
          if (protection.bracketByEntry(account, order.brokerOrderId) && protection.reopenBracket(account, order.brokerOrderId)) void saveProtection();
        }
      }
      // Vazby noh na rodiče nese snímek celé — po restartu je odjinud nezjistíme.
      const seenTags = new Set<string>();
      const changedIds = new Set(result.changed.map((order) => order.brokerOrderId));
      for (const row of rows) {
        if (numberByText.get(row.accountId) !== account) continue;
        if (row.userTag) seenTags.add(row.userTag);
        // Vazby se učí z každého řádku, ale kontrola ochrany se plánuje jen když snímek příkaz
        // opravdu ZMĚNIL. Jinak by si kontrola, která sama čte snímek, plánovala další kontrolu
        // dokola a nikdy nedošla k výsledku.
        const seen = protection.observe(account, row);
        if (seen.bound) void saveProtection();
        if (seen.entryId && changedIds.has(row.basketId)) scheduleBracketCheck(source, account, seen.entryId);
      }
      // Snímek zápis „na cestě" vyřeší: buď ho obsahuje, nebo — když začal aspoň 2 s po odeslání —
      // dokládá, že příkaz nevznikl.
      for (const [tag, entry] of [...inflight]) {
        if (!entry.key.startsWith(`${account}:`)) continue;
        if (seenTags.has(tag) || readStartedAt - entry.at >= 2_000) inflight.delete(tag);
      }
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
    }, 'příkazy');
  }

  /**
   * Čtení pozic, které ještě čeká ve frontě (nezačalo) — další zájemci ho sdílejí. Čtení, které
   * začne až po žádosti, je pro žadatele vždy dost čerstvé; bez sdílení by desítky kontrol
   * ochrany po jedné změně pozice zaplnily frontu na sekundy a zdržely i zavírání pozice.
   */
  const queuedPositionRead = new Map<number, { source: RithmicClient; promise: Promise<BrokerPosition[]> }>();

  function readPositions(source: RithmicClient, account: number): Promise<BrokerPosition[]> {
    const queued = queuedPositionRead.get(account);
    if (queued && queued.source === source) return queued.promise;
    const promise: Promise<BrokerPosition[]> = serialRead(async () => {
      if (queuedPositionRead.get(account)?.promise === promise) queuedPositionRead.delete(account);
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
    }, 'pozice');
    queuedPositionRead.set(account, { source, promise });
    return promise;
  }

  async function connectOnce(): Promise<void> {
    if (state === 'halted') throw new Error('Rithmic: adaptér je zastavený');
    if (client) throw new Error('Rithmic: připojování už běží');
    if (config.loginAllowed && !config.loginAllowed()) {
      incident('state-undetermined', 'rozpočet přihlášení k Rithmicu je vyčerpán (ochrana před tvrdým limitem dotazů) — adaptér je zastavený, je nutné ruční spuštění');
      halt();
      throw new Error('Rithmic: rozpočet přihlášení je vyčerpán');
    }
    const created: RithmicClient = new RithmicClient({
      url: config.url,
      credentials: config.credentials,
      socketFactory: config.socketFactory,
      now,
      requestTimeoutMs: config.requestTimeoutMs,
      events: {
        onOrderUpdate: (update) => handleOrderUpdate(created, update),
        onAccountUpdate: (update) => {
          if (client !== created) return;
          if (update.accountId && !created.accounts.some((account) => account.accountId === update.accountId)) return;
          config.onAccountUpdate?.();
        },
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
      closing.clear();
      for (const id of accountIds) {
        // Výchozí bod dopočtu pozice: co výchozí stav neuvádí, je 0.
        for (const order of book.list(id)) {
          expectedNet.set(`${id}:${order.symbol}`, 0);
          if (order.filledQuantity > 0) baselineFilled.add(`${id}:${order.brokerOrderId}`);
        }
        for (const row of positions) if (row.accountId === id) expectedNet.set(`${id}:${row.symbol}`, row.netQuantity);
        if (protection.resolveAllExits(id)) void saveProtection();
        // Snímek pozic může být za snímkem příkazů pozadu. Kontrakt, kde vlastní vstup má podle
        // příkazů ještě expozici, ale pozice je 0, je rozpor → dopočtu se tam nevěří.
        const recheck = new Set<string>();
        for (const intent of protection.bracketsFor(id)) {
          if (!intent.entryId || intent.closedAt !== undefined) continue;
          const entry = book.get(id, intent.entryId);
          if (!entry || entry.filledQuantity === 0) continue;
          const legFills = protection.legsOf(id, intent.entryId).reduce((sum, leg) => sum + (book.get(id, leg.orderId)?.filledQuantity ?? 0), 0);
          if (entry.filledQuantity - legFills - (intent.exitedOutside ?? 0) > 0) {
            recheck.add(intent.symbol);
            if ((expectedNet.get(`${id}:${intent.symbol}`) ?? 0) === 0) expectedNet.set(`${id}:${intent.symbol}`, null);
          }
        }
        // Druhé, pozdější čtení rozhodne (a dopočet ukotví): vstup zavřený za výpadku se tím
        // uzavře, místo aby při první cizí pozici spustil falešný poplach.
        for (const symbol of recheck) {
          const later = setTimeout(() => {
            if (client !== created) return;
            void contractProof(created, id, symbol, config.flattenStepMs ?? 1_000).then(() => {
              if (client !== created) return;
              for (const intent of protection.bracketsFor(id, symbol)) if (intent.entryId && intent.closedAt === undefined) scheduleBracketCheck(created, id, intent.entryId);
            });
          }, Math.min(config.legsWaitMs ?? 3_000, 1_500));
          (later as { unref?: () => void }).unref?.();
        }
      }
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
      // Prodleva se na minimum vrátí až po relaci, která vydržela (viz scheduleReconnect).
      connectedAt = now();
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

  /** Stav kontraktu je znám: dřívější zavření je tím vyřešené (v paměti i v trvalém záznamu). */
  function resolveClosing(account: number, symbol: string): void {
    const had = closing.delete(`${account}:${symbol}`);
    if (protection.hasUnresolvedExit(account, symbol) || had) {
      protection.resolveExits(account, symbol);
      void saveProtection();
    }
  }
  /**
   * SILNÁ nula: nulová pozice doložená dvěma zdroji (živá zpráva + dopočet z exekucí, nebo
   * stabilní důkaz čtením). Uzavře skončené vlastní vstupy a vyřeší probíhající zavírání.
   * Nic slabšího (jedna zpráva, jedno čtení, pořadí doručení) tyhle účinky nemá.
   */
  function strongZero(account: number, symbol: string): void {
    resolveClosing(account, symbol);
    let latched = false;
    for (const intent of protection.bracketsFor(account, symbol)) {
      if (!intent.entryId || intent.closedAt !== undefined) continue;
      const result = protection.bracketState(account, intent.entryId, (id) => book.get(account, id), 0, true);
      if (!result.latch) continue;
      protection.closeBracket(account, intent.entryId);
      bracketReported.delete(`${account}:${intent.entryId}`);
      bracketSuspect.delete(`${account}:${intent.entryId}`);
      latched = true;
    }
    if (latched) void saveProtection();
  }

  /**
   * Dopočet pozice z exekucí, jen když platí: nebyl zneplatněn a u žádného příkazu kontraktu
   * nechybí exekuce (vyplněné množství větší než součet doručených fillů — např. „vyplněno" od
   * Rithmicu, ke kterému exekuce z burzy teprve přijde). Jinak `null`.
   */
  function validExpectedNet(account: number, symbol: string): number | null {
    const key = `${account}:${symbol}`;
    // Kontrakt, který výchozí stav relace neuváděl, začíná na 0 (výchozí stav je autoritativní).
    const expected = expectedNet.has(key) ? expectedNet.get(key) : state === 'connected' ? 0 : null;
    if (expected === null || expected === undefined) return null;
    for (const order of book.list(account)) {
      if (order.symbol === symbol && book.fillGap(account, order.brokerOrderId) > 0) return null;
    }
    return expected;
  }

  /**
   * Živé pozici se věří JEN když sedí s dopočtem z exekucí (dva nezávislé zdroje). Když dopočet
   * neplatí nebo s ní nesedí, vrací `undefined` a rozhodnout musí čtení.
   */
  function trustedLivePosition(account: number, symbol: string): number | undefined {
    const key = `${account}:${symbol}`;
    const live = livePositions.get(key);
    return typeof live === 'number' && validExpectedNet(account, symbol) === live ? live : undefined;
  }

  /** Čistá pozice kontraktu: důvěryhodná živá hodnota, jinak čtením. `null` = neznámá. */
  async function netPosition(source: RithmicClient, account: number, symbol: string): Promise<number | null> {
    const live = trustedLivePosition(account, symbol);
    if (live !== undefined) return live;
    try {
      const rows = await readPositions(source, account);
      if (client !== source) return null;
      const read = rows.find((row) => row.symbol === symbol)?.netQuantity ?? 0;
      // Jedno čtení, které platnému dopočtu z exekucí odporuje, není odpověď (snímek může být pozadu).
      const expected = validExpectedNet(account, symbol);
      return expected !== null && expected !== read ? null : read;
    } catch {
      return null;
    }
  }

  /**
   * Po každé změně vstupu, nohy nebo pozice: do `legsWaitMs` OD POSLEDNÍ změny musí ochrana
   * sedět (nejdéle 3× `legsWaitMs` od první). Adaptér nic nedostavuje ani nezavírá
   * (INV-OUTBOX-03) — jen hlásí. Stav se hlásí jednou, dokud se nezmění.
   */
  function scheduleBracketCheck(source: RithmicClient, account: number, entryId: string, retry = false, quick = false): void {
    const key = `${account}:${entryId}`;
    if (client !== source) return;
    const wait = config.legsWaitMs ?? 3_000;
    const running = bracketTimers.get(key);
    const firstAt = running?.firstAt ?? now();
    if (running) clearTimeout(running.timer);
    // Strop omezuje jen celkové odkládání; kontrola nikdy neběží dřív než minimální odstup od
    // poslední změny (nohy vznikají ~40 ms po vyplnění, snímek pozic může být o chvíli pozadu).
    // `quick` = potvrzující kontrola: jen minimální odstup, ne celá lhůta znovu.
    const delay = quick ? Math.min(wait, 400) : Math.max(Math.min(wait, 400), Math.min(wait, firstAt + 3 * wait - now()));
    const timer = setTimeout(() => {
      const mine = bracketTimers.get(key);
      bracketTimers.delete(key);
      void (async () => {
        if (client !== source || state !== 'connected') return;
        const intent = protection.bracketByEntry(account, entryId);
        if (!intent) return;
        // Během zavírání pozice jsou nohy zrušené úmyslně — vyhodnotit až po něm.
        if (flattening.has(`${account}:${intent.symbol}`)) {
          scheduleBracketCheck(source, account, entryId, Boolean(mine?.retried));
          return;
        }
        const orderOf = (id: string): BrokerOrder | undefined => book.get(account, id);
        const fillKey = `${account}:${intent.symbol}`;
        const fillsBefore = fillSeenAt.get(fillKey) ?? 0;
        // Dopočet z exekucí neplatí → jediná cesta, jak ho znovu ukotvit (a případně bracket uzavřít),
        // je stabilní důkaz čtením. Jinak stačí důvěryhodná živá hodnota nebo jedno čtení pozice.
        let net: number | null;
        if (validExpectedNet(account, intent.symbol) === null) {
          const proof = await contractProof(source, account, intent.symbol, config.flattenStepMs ?? 1_000);
          net = proof.stable ? proof.net : null;
        } else {
          net = await netPosition(source, account, intent.symbol);
          // Silná nula platí podle STAVU, ne jen v okamžiku zprávy: bracket, jehož nohy skončily
          // až po ní, se uzavře při kontrole.
          if (net === 0 && trustedLivePosition(account, intent.symbol) === 0) strongZero(account, intent.symbol);
        }
        if (client !== source) return;
        if (protection.bracketByEntry(account, entryId)?.closedAt !== undefined && !protection.legsOf(account, entryId).some((leg) => { const o = book.get(account, leg.orderId); return o && !TERMINAL.has(o.status); })) return;
        // Během čtení přišla další změna a čeká novější kontrola — tahle už nic nehlásí.
        if (bracketTimers.has(key)) return;
        // Vyplnění během čtení pozice: přečtená hodnota k novému stavu příkazů nepatří → znovu.
        if ((fillSeenAt.get(fillKey) ?? 0) !== fillsBefore) {
          scheduleBracketCheck(source, account, entryId, Boolean(mine?.retried));
          return;
        }
        // Natrvalo uzavírá jen silná nula (`strongZero`); kontrola sama bracket z nuly nezavírá.
        const result = protection.bracketState(account, entryId, orderOf, net, false);
        if (result.latch) {
          protection.closeBracket(account, entryId);
          bracketReported.delete(key);
          bracketSuspect.delete(key);
          bracketUnknown.delete(key);
          void saveProtection();
          return;
        }
        const filled = (orderOf(entryId)?.filledQuantity ?? 0) > 0;
        if (result.state === 'unknown' && filled) {
          // Ochranu nejde ověřit (pozici nejde přečíst). Nezahazovat: omezeně opakovat, pak ohlásit.
          const tries = (bracketUnknown.get(key) ?? 0) + 1;
          bracketUnknown.set(key, tries);
          if (tries <= 3) {
            scheduleBracketCheck(source, account, entryId, true, true);
            return;
          }
          if (bracketReported.get(key) !== 'unverifiable') {
            bracketReported.set(key, 'unverifiable');
            incident('bracket-legs-missing', `vstup ${entryId} (${intent.symbol}): ochranu pozice nejde ověřit (${result.detail}) — zkontroluj SL/TP ručně`);
          }
          // Dál zkoušet pomalu (plná lhůta), dokud stav nepůjde určit — i bez další události.
          if (tries <= 40) scheduleBracketCheck(source, account, entryId, true);
          return;
        }
        // Neznámý stav není zdravý stav: podezření ani hlášení se jím nemažou.
        if (result.state === 'unknown') return;
        bracketUnknown.delete(key);
        // Noha ještě čeká na potvrzení burzy: jedna další kontrola místo předčasného poplachu.
        if (result.state === 'unprotected' && !mine?.retried && protection.hasPendingLegs(account, entryId, orderOf)) {
          scheduleBracketCheck(source, account, entryId, true);
          return;
        }
        const bad = result.state === 'unprotected' || result.state === 'orphan-legs';
        if (!bad) {
          // Zdravý stav podezření i dřívější hlášení maže (příští zhoršení se ohlásí znovu).
          bracketSuspect.delete(key);
          bracketReported.delete(key);
          return;
        }
        if (bracketReported.get(key) === result.state) return;
        // Poplach až když STAV (ne text detailu) potvrdí druhá kontrola po krátkém odstupu:
        // jedno čtení pozice může být o chvíli pozadu za vyplněním.
        if (bracketSuspect.get(key) !== result.state) {
          bracketSuspect.set(key, result.state);
          scheduleBracketCheck(source, account, entryId, true, true);
          return;
        }
        bracketSuspect.delete(key);
        bracketReported.set(key, result.state);
        if (result.state === 'unprotected') {
          incident('bracket-legs-missing', `vstup ${entryId} (${intent.symbol}) má pozici bez úplné ochrany: ${result.detail} — nic se nedostavuje, rozhodni ručně`);
        } else {
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
  /**
   * Zápis na cestě na kontraktu: čerstvě odeslaný (do 3 s čeká na první zprávu), nebo s NEZNÁMÝM
   * výsledkem — ten platí, dokud ho nevyřeší zpráva se značkou, snímek, nebo nová relace.
   */
  function writeOnTheWay(key: string): boolean {
    return [...inflight.values()].some((entry) => entry.key === key && (entry.uncertain || now() - entry.at < 3_000));
  }

  function assertNotFlattening(accountId: number, symbol: string, what: string): void {
    if (flattening.has(`${accountId}:${symbol}`)) {
      throw new BrokerRequestNotSentError(`Rithmic: na ${symbol} právě běží zavírání pozice — ${what} neodesílám`);
    }
    // I z trvalého záznamu (po restartu, než ho vyřeší výchozí stav).
    if (closing.has(`${accountId}:${symbol}`) || protection.hasUnresolvedExit(accountId, symbol)) {
      throw new BrokerRequestNotSentError(`Rithmic: zavření pozice ${symbol} odešlo a stav ho ještě nepotvrdil — ${what} neodesílám`);
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
    const readNet = async (): Promise<number | null> => {
      const positions = await limited(readPositions(active, accountId), stepMs);
      return positions.ok ? positions.value.find((row) => row.symbol === symbol)?.netQuantity ?? 0 : null;
    };
    let net = await readNet();
    const expected = validExpectedNet(accountId, symbol);
    let confirmed = net !== null;
    if (net !== null && expected !== net) {
      // Čtení dopočtu z exekucí odporuje, nebo dopočet neplatí (není s čím srovnat): snímek pozic
      // může být pozadu. Rozhodne druhé čtení po odstupu — teprve dvě shodná čtení jsou důkaz.
      await sleepMs(Math.min(300, stepMs));
      const again = await readNet();
      confirmed = again !== null && again === net;
      net = again;
    }
    const working = book.list(accountId).filter((o) => o.symbol === symbol && !TERMINAL.has(o.status)).map((o) => o.brokerOrderId);
    // Příkaz, kterému chybí exekuce (vyplněno víc, než kolik fillů dorazilo), znamená, že pozice
    // se právě mění způsobem, který neznáme — žádné čtení pak není důkaz.
    const missingExecution = book.list(accountId).some((o) => o.symbol === symbol && book.fillGap(accountId, o.brokerOrderId) > 0);
    const stable = confirmed && !missingExecution && (fillSeenAt.get(key) ?? 0) === before;
    if (client === active && orders.ok && stable && net !== null) {
      // Stabilní důkaz dopočet ukotví (i opraví, když se rozešel).
      expectedNet.set(key, net);
      if (net === 0) strongZero(accountId, symbol);
    }
    return { net, ordersOk: orders.ok, stable, working };
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
    const inflightHere = (): boolean => writeOnTheWay(key);
    // „Flat" neplatí, dokud je na kontraktu zápis na cestě (odeslaný vstup, který kniha ještě nezná).
    const flat = (proof: Awaited<ReturnType<typeof contractProof>>): boolean =>
      proof.ordersOk && proof.stable && proof.net === 0 && proof.working.length === 0 && !awaitingLegs()
      && !inflightHere();
    const settleMs = config.exitSettleMs ?? 1_500;
    /** Pracující tržní příkaz BEZ značky = zavírací příkaz (jen ten Rithmic vytváří neoznačený) se ještě nevyplnil.
     *  Stejně se počítá výstup dělení vstupu (`ui-red-`): dokud pracuje, druhé zavření by pozici mohlo obrátit. */
    const exitOrderWorking = (): boolean => book.list(accountId).some((o) => o.symbol === symbol && !TERMINAL.has(o.status) && o.orderType === 'Market' && (!o.tag || o.tag.startsWith('ui-red-')));
    /** Návrat bez jediného zápisu: záznam operace se zahodí, ať stejná značka smí zavřít později. */
    const abandon = async (result: BrokerLiquidateResult): Promise<BrokerLiquidateResult> => {
      protection.dropFlatten(request.tag);
      for (const alias of joinedTags.get(key) ?? []) protection.dropFlatten(alias.tag);
      await limited(saveProtection(), 300);
      return result;
    };
    const fillsAtStart = fillSeenAt.get(key) ?? 0;
    const proveFlat = (proof: Awaited<ReturnType<typeof contractProof>>): boolean => flat(proof);

    // 1) Rozhodnutí, zda vůbec smíme zavřít, padne DŘÍV, než se sáhne na ochranu.
    const prior = closing.get(key);
    const priorDurable = protection.hasUnresolvedExit(accountId, symbol, request.tag);
    if (prior || priorDurable) {
      // Dřívější zavření odešlo a stav ho nepotvrdil. Druhé zavření souběžně s prvním by mohlo
      // pozici otočit → nejdřív stav přečíst.
      const proof = await contractProof(active, accountId, symbol, stepMs);
      if (proveFlat(proof)) return finish({ status: 'already-flat' });
      const age = prior ? now() - prior.sentAt : Number.POSITIVE_INFINITY;
      // Druhé zavření může pozici otočit jen dokud je první fyzicky „ve vzduchu": požadavek běží,
      // jeho příkaz se ještě nevyplnil, nebo to nejde zjistit. Po tu dobu se nezavírá a na ochranu
      // se nesahá. Doba je PEVNĚ omezená (timeout požadavku + doba na vyplnění) — pak brzda vždy
      // pokračuje běžnou cestou: zruší vše pracující (i visící zavírací příkaz) a zavře znovu.
      const hardCapMs = settleMs + (config.requestTimeoutMs ?? 10_000);
      // „Doběhl" znamená PŘIJATOU odpověď; vypršení času bez odpovědi je pořád neznámý výsledek.
      const inTheAir = !prior?.requestDone || !prior.accepted || age < settleMs || exitOrderWorking() || !proof.ordersOk || proof.net === null;
      if (prior && age < hardCapMs && inTheAir) {
        if (proof.net === null) incident('flatten-orders-remain', `${symbol}: předchozí zavření právě probíhá a pozici teď nejde přečíst — další neposílám`);
        return abandon({ status: 'indeterminate', reason: 'předchozí zavření pozice právě probíhá — další neposílám' });
      }
      // Předchozí zavření doběhlo a pozici nezavřelo (nebo uplynul pevný strop): zavírá se znovu.
      // Záznam o předchozím zavření se NEmaže tady — nahradí ho až skutečně odeslané nové zavření,
      // nebo ho vyřeší prokázaná nula. Když se nové zavření nakonec nepošle, blokace trvá.
      if (proof.net === null) incident('attention', `${symbol}: pozici po dřívějším zavření nejde přečíst — zavírám znovu`);
    } else if (!inflightHere() && trustedLivePosition(accountId, symbol) !== undefined && trustedLivePosition(accountId, symbol) !== 0) {
      // Živá pozice novější než poslední vyplnění, nenulová a nic není na cestě: čtení by jen
      // zdržovalo. (Zavření je stavové — kdyby pozice mezitím zmizela, nic nevznikne.)
    } else if (proveFlat(await contractProof(active, accountId, symbol, stepMs))) {
      return finish({ status: 'already-flat' });
    }

    // 2) Zrušení: nejvýš dvě kola. Druhé je jen pro příkazy, které vznikly až během prvního
    // (nohy vstupu vyplněného pod rukama, vstup, který byl na cestě) — tentýž se neruší dvakrát.
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
      // Vstup odeslaný těsně před zavíráním ještě nemusí být v knize — počkat, až se objeví.
      if (inflightHere()) await waitUntil(() => !inflightHere(), 300);
      if (!working().some((id) => !canceled.has(id))) break;
    }
    const unconfirmed = [...canceled].filter((id) => !isDone(id));
    const stillInflight = inflightHere();

    // 3) Po zrušení noh je pozice bez ochrany — do zavření co nejkratší cesta. Čte se jen tehdy,
    // když živé pozici nejde věřit: něco se vyplnilo, zrušení není potvrzené, nebo je zápis na cestě.
    const live = trustedLivePosition(accountId, symbol);
    const fast = live !== undefined && live !== 0 && !unconfirmed.length && !stillInflight && (fillSeenAt.get(key) ?? 0) === fillsAtStart;
    const proof = fast ? null : await contractProof(active, accountId, symbol, stepMs);
    const net = proof ? proof.net : live!;
    if (proof && net === 0) {
      // Pozici zavřelo něco jiného (např. vyplněná noha) — nic neposíláme a netvrdíme, že my.
      if (proveFlat(proof)) return finish({ status: 'already-flat' });
      incident('flatten-orders-remain', `${symbol}: pozice se čte jako 0, ale ${proof.stable ? `příkazy ${proof.working.join(', ') || '(stav nejde přečíst)'} dál pracují nebo to nejde ověřit` : 'během ověřování přišlo vyplnění — stav není prokázaný'}`);
      return finish({ status: 'indeterminate', reason: 'pozice je 0, ale stav kontraktu není prokázaný' });
    }

    // Zavírací příkaz z dřívějška pořád pracuje (zrušení se nepotvrdilo): brzda už na burze leží.
    // Druhé zavření by se po uvolnění vyplnilo také a pozici otočilo.
    if (exitOrderWorking()) {
      incident('flatten-orders-remain', `${symbol}: dřívější zavírací příkaz stále pracuje a nejde zrušit — další zavření neposílám`);
      // Tahle operace zavření neodeslala: její záznam se zahodí, blokace po dřívějším zavření zůstává.
      return abandon({ status: 'indeterminate', reason: 'dřívější zavírací příkaz stále pracuje' });
    }

    // 4) Zavření. Fáze na disk PŘED odesláním; záznam „zavírání probíhá" trvá, dokud výsledek
    // nepotvrdí STAV (nulová pozice), ne odpověď serveru.
    await recordPhase('exit-sent');
    postFlattenTags.set(key, new Set());
    const mine = { tag: request.tag, sentAt: now(), requestDone: false, accepted: false };
    closing.set(key, mine);
    /** Zbytek po zavření = cokoli pracujícího, co nebylo zadáno až po něm (podle značky vstupu). */
    const leftovers = (): string[] => working().filter((id) => {
      const parent = protection.legOf(accountId, id)?.parentId;
      const tag = book.get(accountId, id)?.tag || (parent ? book.get(accountId, parent)?.tag : undefined);
      return !(tag && postFlattenTags.get(key)?.has(tag));
    });
    // Stav mohl výsledek potvrdit dřív, než se sem vrátíme (nulová pozice přišla živě) — pak je hotovo.
    const pendingPhase = (): FlattenRecord['phase'] => (closing.get(key) === mine ? 'exit-sent' : 'done');
    const sending = active.exitPosition(text, symbol, exchange);
    void sending.then(
      () => 'accepted' as const,
      (error: unknown) => (error instanceof RithmicRequestError && error.outcome !== 'unknown' ? ('refused' as const) : ('unknown' as const)),
    ).then((how) => {
      mine.requestDone = true;
      mine.accepted = how === 'accepted';
      // Výslovné odmítnutí nebo neodeslání: zavření neproběhlo, není co potvrzovat.
      if (how === 'refused' && closing.get(key) === mine) resolveClosing(accountId, symbol);
      else if (how === 'unknown' && closing.get(key) === mine) {
        incident('flatten-orders-remain', `${symbol}: zavření pozice zůstalo bez odpovědi — nové příkazy na kontraktu stojí; ověř stav, případně zavři znovu`);
      }
    });
    const exit = await limited(sending, stepMs * 2);
    // Kontrola po zavření — i při nejistém výsledku: potvrdit výsledek stavem a najít zbytky.
    const check = setTimeout(() => {
      void (async () => {
        if (client !== active) {
          incident('flatten-orders-remain', `${symbol}: spojení spadlo před kontrolou po zavření pozice — ověř pozici a příkazy`);
          return;
        }
        let after = await contractProof(active, accountId, symbol, stepMs * 2);
        for (let attempt = 0; attempt < 2 && client === active && (!after.ordersOk || after.net === null); attempt += 1) {
          await sleepMs(config.flattenPostCheckMs ?? 1_500);
          after = await contractProof(active, accountId, symbol, stepMs * 2);
        }
        if (client !== active) return;
        if (!after.ordersOk || after.net === null) {
          incident('flatten-orders-remain', `${symbol}: po zavření pozice nejde přečíst stav — nové příkazy na kontraktu stojí, dokud se stav nepotvrdí`);
          return;
        }
        if (after.net === 0 && after.stable) {
          // (silnou nulu už zapsal sám důkaz)
        } else if (after.net !== 0 && closing.get(key) === mine && (!mine.accepted || now() - mine.sentAt < settleMs)) {
          // Zavření nemá potvrzené přijetí (odpověď nepřišla), nebo je příliš čerstvé: výsledek není
          // znám. Blokace trvá; další zavření pustí až pevný strop v `runFlatten`.
          incident('flatten-orders-remain', `${symbol}: zavření pozice nemá potvrzený výsledek a pozice ${after.net} trvá — nové příkazy na kontraktu stojí`);
        } else if (after.net !== 0 && closing.get(key) === mine) {
          if (exitOrderWorking()) {
            // Zavírací příkaz ještě pracuje: výsledek není znám, blokace trvá (druhé zavření by pozici otočilo).
            incident('flatten-orders-remain', `${symbol}: zavírací příkaz se zatím nevyplnil, pozice ${after.net} trvá — nové příkazy na kontraktu stojí`);
          } else {
            // Požadavek doběhl, žádný zavírací příkaz nepracuje a pozice trvá: zavření ji nezavřelo.
            resolveClosing(accountId, symbol);
            incident('flatten-orders-remain', `${symbol}: po zavření pozice zůstává pozice ${after.net} — zavření ji nezavřelo`);
          }
        }
        if (leftovers().length) incident('flatten-orders-remain', `${symbol}: po zavření pozice dál pracují příkazy ${leftovers().join(', ')}`);
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
      return finish({ status: 'indeterminate', reason: 'odpověď na zavření pozice nepřišla — výsledek je neznámý' }, pendingPhase());
    }
    // Přijato ≠ zavřeno: trvalý záznam zůstává „odesláno", dokud výsledek nepotvrdí stav.
    return finish({ status: 'submitted' }, pendingPhase());
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
    accountName: account => textByNumber.get(account) ?? null,
    async readQuantityLimits(account, product) {
      const active = activeClient();
      const name = accountText(account, false);
      const [accountRows, productRows] = await Promise.all([active.accountRmsInfo(), active.productRmsInfo(name)]);
      if (client !== active) return null;
      const identity = active.accounts.find(item => item.accountId === name);
      return identity ? quantityLimits(name, product, accountRows, productRows, identity) : null;
    },
    async beginBracketResize(accountId, entryId, quantity) {
      const active = activeClient();
      const text = accountText(accountId, true);
      const intent = protection.bracketByEntry(accountId, entryId);
      if (!intent || intent.closedAt !== undefined) throw new BrokerRequestNotSentError(`Rithmic: vstup ${entryId} nemá hlídanou ochranu`);
      const exchange = rithmicExchangeForSymbol(intent.symbol);
      if (!exchange) throw new BrokerRequestNotSentError(`Rithmic: neznámá burza pro symbol ${intent.symbol}`);
      const legsNow = () => protection.legsOf(accountId, entryId).map((leg) => book.get(accountId, leg.orderId)).filter((order): order is BrokerOrder => order !== undefined && !TERMINAL.has(order.status));
      const stopLeg = legsNow().find((order) => order.stopPrice !== undefined);
      const targetLeg = legsNow().find((order) => order.stopPrice === undefined && order.limitPrice !== undefined);
      if (legsNow().length !== 2 || !stopLeg || !targetLeg || stopLeg.status !== 'working' || targetLeg.status !== 'working') throw new BrokerRequestNotSentError('Rithmic: ochrana nemá právě jeden pracující SL a TP');
      const current = targetLeg.quantity;
      if (stopLeg.quantity !== current || stopLeg.filledQuantity !== 0 || targetLeg.filledQuantity !== 0) throw new BrokerRequestNotSentError('Rithmic: nohy ochrany nemají shodné nevyplněné množství');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity >= current) throw new BrokerRequestNotSentError(`Rithmic: ochranu ${current} ks nejde zmenšit na ${quantity}`);
      assertNotFlattening(accountId, intent.symbol, 'zmenšení ochrany');
      if (!protection.beginResize(accountId, entryId, quantity)) throw new BrokerRequestNotSentError('Rithmic: zmenšení ochrany už běží');
      if (!(await saveProtection())) {
        protection.endResize(accountId, entryId, 0);
        throw new BrokerRequestNotSentError('Rithmic: záznam o zmenšení ochrany nejde uložit — neodesílám');
      }
      const still = book.get(accountId, targetLeg.brokerOrderId);
      if (client !== active || !still || still.status !== 'working' || still.quantity !== current || still.filledQuantity !== 0) {
        protection.endResize(accountId, entryId, 0);
        void saveProtection();
        throw new BrokerRequestNotSentError('Rithmic: ochrana se během ukládání změnila — neodesílám');
      }
      try {
        await active.modifyOrder({ accountId: text, basketId: targetLeg.brokerOrderId, symbol: intent.symbol, exchange, quantity, priceType: 'LIMIT', price: targetLeg.limitPrice });
      } catch (error) {
        // Prokazatelně odmítnuto = ochrana je beze změny; jinak zůstává záměr a rozhodne volající (incident).
        if (error instanceof RithmicRequestError && error.outcome !== 'unknown') { protection.endResize(accountId, entryId, 0); void saveProtection(); }
        return rethrowWrite(error, 'zmenšení ochrany');
      }
      const deadline = now() + (config.confirmWaitMs ?? 1_500);
      for (;;) {
        const stop = book.get(accountId, stopLeg.brokerOrderId);
        const target = book.get(accountId, targetLeg.brokerOrderId);
        if (stop?.status === 'working' && target?.status === 'working' && stop.quantity === quantity && target.quantity === quantity && stop.filledQuantity === 0 && target.filledQuantity === 0) return;
        if (now() >= deadline || client !== active) throw new Error('Rithmic: zmenšení ochrany není potvrzené stavem obou noh');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async endBracketResize(accountId, entryId, exitedQuantity) {
      protection.endResize(accountId, entryId, exitedQuantity);
      const saved = await saveProtection();
      const active = client;
      if (active) scheduleBracketCheck(active, accountId, entryId);
      // Neuložený záznam = po pádu by ochrana počítala s jinou expozicí; volající to musí ohlásit, ne vrátit úspěch.
      if (!saved) throw new Error('Rithmic: záznam ochrany po dělení vstupu nejde uložit');
    },
    snapshotAveragePrice: (account, symbol) => snapshotAverage.get(`${account}:${symbol}`) ?? null,
    accountClosedPnl: (account) => {
      const pnl = accountPnl.get(account);
      return pnl ? { closedPnl: pnl.closedPnl, at: pnl.receivedAt } : null;
    },
    executionNet: (account, symbol) => livePositions.get(`${account}:${symbol}`) === null ? null : validExpectedNet(account, symbol),
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
      const orderKey = `${request.accountId}:${request.symbol}`;
      postFlattenTags.get(orderKey)?.add(request.tag);
      inflight.set(request.tag, { key: orderKey, at: now(), uncertain: false });
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
          ...(request.goodTillCancel ? { duration: 'GTC' as const } : {}),
        });
        // „Přijato" = Rithmic příkaz eviduje. Odmítnutí RMS nebo burzou přijde jako událost `order`.
        return { brokerOrderId: ack.basketId, accepted: true, definitive: true };
      } catch (error) {
        if (error instanceof RithmicRequestError && error.outcome !== 'unknown') inflight.delete(request.tag);
        else if (inflight.has(request.tag)) inflight.get(request.tag)!.uncertain = true;
        return rethrowWrite(error, 'nový příkaz');
      }
    },

    async placeExitPair(request) {
      const active = activeClient();
      const text = accountText(request.accountId, true);
      const exchange = rithmicExchangeForSymbol(request.symbol);
      if (!exchange) throw new BrokerRequestNotSentError(`Rithmic: neznámá burza pro symbol ${request.symbol}`);
      if (!active.hasTradeRoute(exchange)) throw new BrokerRequestNotSentError(`Rithmic: účet nemá trade route pro ${exchange}`);
      const tags = [request.stop.tag, request.target.tag];
      if (!tags[0] || !tags[1] || tags[0] === tags[1]) throw new BrokerRequestNotSentError('Rithmic: svázaný pár potřebuje dvě různé značky');
      for (const tag of tags) if (protection.hasTag(request.accountId, tag)) throw new BrokerRequestNotSentError(`Rithmic: značku ${tag} už nese vstup s ochranou`);
      if (!(Number.isInteger(request.quantity) && request.quantity > 0)) throw new BrokerRequestNotSentError('Rithmic: svázaný pár bez platného množství');
      if (![request.stop.stopPrice, request.target.limitPrice].every((price) => Number.isFinite(price) && price > 0)) throw new BrokerRequestNotSentError('Rithmic: svázaný pár bez platných cen');
      assertNotFlattening(request.accountId, request.symbol, 'nová ochrana');
      const orderKey = `${request.accountId}:${request.symbol}`;
      for (const tag of tags) { postFlattenTags.get(orderKey)?.add(tag); inflight.set(tag, { key: orderKey, at: now(), uncertain: false }); }
      try {
        const side = rithmicSide(request.side);
        const ack = await active.placeOcoOrder({
          accountId: text,
          legs: [
            { userTag: request.stop.tag, symbol: request.symbol, exchange, side, quantity: request.quantity, priceType: 'STOP_MARKET', triggerPrice: request.stop.stopPrice },
            { userTag: request.target.tag, symbol: request.symbol, exchange, side, quantity: request.quantity, priceType: 'LIMIT', price: request.target.limitPrice },
          ],
        });
        return { stopOrderId: ack.basketIds[0], targetOrderId: ack.basketIds[1] };
      } catch (error) {
        for (const tag of tags) {
          if (error instanceof RithmicRequestError && error.outcome !== 'unknown') inflight.delete(tag);
          else if (inflight.has(tag)) inflight.get(tag)!.uncertain = true;
        }
        return rethrowWrite(error, 'svázaná ochrana');
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
      const brakeMoved = (flattenGeneration.get(brakeKey) ?? 0) !== brakeGeneration || flattening.has(brakeKey) || closing.has(brakeKey) || protection.hasUnresolvedExit(request.accountId, request.symbol);
      if (client !== active || brakeMoved) {
        protection.dropBracket(request.tag);
        void saveProtection();
        throw new BrokerRequestNotSentError(brakeMoved ? `Rithmic: na ${request.symbol} mezitím začalo zavírání pozice — vstup neodesílám` : 'Rithmic: spojení není připravené');
      }
      // Podmínka volajícího až teď: mezi rozhodnutím a zápisem se čekalo na uložení záměru.
      const guarded = request.guard?.() ?? null;
      if (guarded) {
        protection.dropBracket(request.tag);
        void saveProtection();
        throw new BrokerRequestNotSentError(`Rithmic: ${guarded}`);
      }
      postFlattenTags.get(brakeKey)?.add(request.tag);
      inflight.set(request.tag, { key: brakeKey, at: now(), uncertain: false });
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
          ...(request.goodTillCancel ? { duration: 'GTC' as const } : {}),
        });
        const intent = protection.bracketsFor(request.accountId).find((b) => b.tag === request.tag);
        if (intent && !intent.entryId) {
          intent.entryId = ack.basketId;
          void saveProtection();
        }
        // „Přijato" = Rithmic vstup eviduje. Odmítnutí RMS nebo burzou přijde jako událost `order`.
        // Ze zápisů „na cestě" ho vyřadí až jeho první zpráva v knize (odpověď ji může předběhnout).
        return { entryBrokerOrderId: ack.basketId, accepted: true, definitive: true };
      } catch (error) {
        if (error instanceof RithmicRequestError && error.outcome === 'rejected') inflight.delete(request.tag);
        if (error instanceof RithmicRequestError && error.outcome === 'not-sent') {
          inflight.delete(request.tag);
          protection.dropBracket(request.tag);
          void saveProtection();
        } else {
          if (inflight.has(request.tag) && !(error instanceof RithmicRequestError && error.outcome === 'rejected')) inflight.get(request.tag)!.uncertain = true;
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

    unresolvedBracketTags(accountId: number, symbol: string): string[] {
      return protection.bracketsFor(accountId).filter((intent) => intent.symbol === symbol && intent.closedAt === undefined && !intent.entryId).map((intent) => intent.tag);
    },

    listBrackets(accountId: number) {
      return protection.bracketsFor(accountId).flatMap((intent) => (intent.entryId
        ? [{ tag: intent.tag, symbol: intent.symbol, entryId: intent.entryId, closed: intent.closedAt !== undefined,
          ...(intent.stopTicks !== undefined ? { stopTicks: intent.stopTicks } : {}), ...(intent.targetTicks !== undefined ? { targetTicks: intent.targetTicks } : {}), legs: protection.legsOf(accountId, intent.entryId).map((leg) => ({
          orderId: leg.orderId,
          role: (book.get(accountId, leg.orderId)?.stopPrice !== undefined ? 'stop' : book.get(accountId, leg.orderId)?.limitPrice !== undefined ? 'target' : leg.role) as 'stop' | 'target' | 'unknown',
        })) }]
        : []));
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
        const onTheWay = writeOnTheWay(key);
        if (proof.ordersOk && proof.stable && proof.net === 0 && proof.working.length === 0 && !onTheWay) {
          // Stav je prokázaný — nejistota po dřívějším zavření končí.
          return { status: 'already-flat' };
        }
        return { status: 'indeterminate', reason: `zavření se značkou ${request.tag} už proběhlo (fáze ${earlier.phase}) — neopakuji, ověř stav` };
      }
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
      // Noha VLASTNÍHO vstupu s ochranou: smí se měnit jen cena (změřeno: změna vazbu na sestru
      // zachová). Množství řídí server podle vstupu — jiné by nohu rozešlo se sestrou.
      const leg = protection.legOf(accountId, brokerOrderId);
      const ownLeg = leg && protection.bracketByEntry(accountId, leg.parentId) ? leg : undefined;
      // ČEKAJÍCÍ vlastní vstup s ochranou (Limit, nic vyplněno): smí se měnit jen cena. Změřeno 17. 11. 2026
      // (scripts/rithmic/measureBracketEntryMove.ts): 314 zachová basket, značku i vzdálenosti SL/TP v tickách.
      const ownEntry = !ownLeg && known.brokerOrderType?.startsWith('BRACKET:') === true ? protection.bracketByEntry(accountId, brokerOrderId) : undefined;
      if (ownEntry) {
        if (known.filledQuantity > 0) throw new BrokerRequestNotSentError(`Rithmic: vstup ${brokerOrderId} se už plní — cenu neměním`);
        // Stop vstup (spoušť bez limitní ceny) i Limit: mění se jen ta jedna cena. Změřeno 17. 11. 2026 pro oba typy.
        const stopEntry = known.stopPrice !== undefined;
        if (!stopEntry && known.limitPrice === undefined) throw new BrokerRequestNotSentError(`Rithmic: vstup ${brokerOrderId} nemá cenu — neměním`);
        if (changes.orderType !== (stopEntry ? 'Stop' : 'Limit')) throw new BrokerRequestNotSentError(`Rithmic: vstup s ochranou ${brokerOrderId} je ${stopEntry ? 'Stop' : 'Limit'}, typ se nemění`);
        if (stopEntry ? changes.limitPrice !== undefined : changes.stopPrice !== undefined) throw new BrokerRequestNotSentError('Rithmic: u vstupu s ochranou se mění jen jeho vlastní cena');
        if (changes.quantity !== known.quantity) throw new BrokerRequestNotSentError(`Rithmic: množství vstupu s ochranou se nemění (má ${known.quantity}, požadováno ${changes.quantity})`);
        const nextEntry = stopEntry ? changes.stopPrice : changes.limitPrice;
        if (typeof nextEntry !== 'number' || !Number.isFinite(nextEntry)) throw new BrokerRequestNotSentError('Rithmic: změna vstupu bez nové ceny');
      }
      if (known.orderType === 'Unsupported' && !ownLeg && !ownEntry) {
        throw new BrokerRequestNotSentError(`Rithmic: příkaz ${brokerOrderId} je typu, který adaptér nemění (${known.brokerOrderType ?? 'neznámý'})`);
      }
      if (TERMINAL.has(known.status)) throw new BrokerRequestNotSentError(`Rithmic: příkaz ${brokerOrderId} už skončil, změnu neodesílám`);
      let priceType = ownEntry ? (known.stopPrice !== undefined ? 'STOP_MARKET' as const : 'LIMIT' as const) : rithmicPriceType(changes.orderType);
      let price = changes.limitPrice;
      let triggerPrice = changes.stopPrice;
      if (ownLeg) {
        if (known.stopPrice === undefined && known.limitPrice === undefined && ownLeg.role === 'unknown') {
          throw new BrokerRequestNotSentError(`Rithmic: u nohy ${brokerOrderId} ještě není znám typ — změnu neodesílám`);
        }
        const isStop = known.stopPrice !== undefined || ownLeg.role === 'stop';
        if (changes.quantity !== known.quantity) throw new BrokerRequestNotSentError(`Rithmic: množství nohy ochrany se nemění (má ${known.quantity}, požadováno ${changes.quantity})`);
        if (changes.orderType !== (isStop ? 'Stop' : 'Limit')) throw new BrokerRequestNotSentError(`Rithmic: noha ochrany ${brokerOrderId} je ${isStop ? 'Stop' : 'Limit'}, typ se nemění`);
        const next = isStop ? changes.stopPrice : changes.limitPrice;
        if (typeof next !== 'number' || !Number.isFinite(next)) throw new BrokerRequestNotSentError('Rithmic: změna nohy ochrany bez nové ceny');
        priceType = isStop ? 'STOP_MARKET' : 'LIMIT';
        price = isStop ? undefined : next;
        triggerPrice = isStop ? next : undefined;
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
          priceType,
          price,
          triggerPrice,
        });
        // Po změně nohy se ochrana vyhodnotí znovu (vazba, množství, stav).
        if (ownLeg) scheduleBracketCheck(active, accountId, ownLeg.parentId);
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
