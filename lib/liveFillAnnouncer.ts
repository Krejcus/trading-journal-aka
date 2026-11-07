import type { CopierCopyEvent } from '../services/copierRuntimeController';
import type { LiveFillMarker } from './liveFillMarkers';

/**
 * Zvuk/hlas při fillu v LIVE grafu (U7, 3. 11. 2026) — JEN zobrazení (INV-UI-01/03).
 *
 * Z událostí kopírky (`recentCopyEvents` statusu workeru — stejná data a stejná brána
 * dostupnosti jako karty obchodů) a ze šipek plnění leadera (`LiveFillMarker`, telefon)
 * vyrobí nejvýš jedno krátké české hlášení na fill: „Fill BUY 1 MNQ za 25 100,25“.
 * Nic neodesílá a nic neautorizuje; cena jen z plnění brokera, P&L jen z události
 * workeru — nikdy z ceny grafu ani TradingView (INV-UI-04).
 *
 * Pravidla (fail-silent — v nejistotě raději ticho):
 * - první načtení zdroje (i každé nové zapnutí) si události jen zapamatuje;
 * - každé id se ohlásí nejvýš jednou (`event:<id>` / `fill:<id>`); událost a plnění
 *   téhož fillu (jiný zdroj, stejná strana příkazu, ±5 s) = jedno hlášení; dílčí
 *   plnění jednoho příkazu (stejné `orderId`) = jedno hlášení. Párování je záměrně
 *   hrubé: rychlé filly na stejnou stranu do 5 s mohou splynout (raději méně hlášení,
 *   nikdy dvakrát totéž);
 * - starší než 30 s (probuzení, opožděný status) nebo „z budoucnosti“ = ticho;
 * - vypnuto, kopírka nedostupná, skrytý graf/appka, PC okno bez fokusu = ticho a
 *   události se jen zapamatují (po návratu se nic nepřehrává — v pozadí platí push);
 * - nejvýš jedno hlášení za 1,5 s; při záplavě vyhraje nejdůležitější (výstup)
 *   a čeká nejvýš jedno.
 */

export type LiveFillAnnounceMode = 'off' | 'tone' | 'voice';
export const LIVE_FILL_ANNOUNCE_MODES: readonly LiveFillAnnounceMode[] = ['off', 'tone', 'voice'];
export const LIVE_FILL_ANNOUNCE_LABELS: Readonly<Record<LiveFillAnnounceMode, string>> = { off: 'Vypnuto', tone: 'Tón', voice: 'Hlas' };
/** Volba režimu v prohlížeči (per zařízení, jako ostatní předvolby LIVE). */
export const LIVE_FILL_ANNOUNCE_STORAGE_KEY = 'at:live:fill-announce';

/** Starší událost se neohlásí (probuzení, opožděný status). */
export const LIVE_FILL_ANNOUNCE_MAX_AGE_MS = 30_000;
/** Tolerance hodin workeru/brokera „napřed“ proti prohlížeči. */
export const LIVE_FILL_ANNOUNCE_FUTURE_MS = 10_000;
/** Nejvýš jedno hlášení za 1,5 s. */
export const LIVE_FILL_ANNOUNCE_GAP_MS = 1_500;
/** Událost kopírky a plnění brokera téhož fillu se párují v tomto okně. */
export const LIVE_FILL_ANNOUNCE_PAIR_MS = 5_000;

const SEEN_MAX = 500;
const DEFAULT_ROOT = 'MNQ';

export type LiveFillCue = 'buy' | 'sell' | 'win' | 'loss' | 'flat';
export type LiveFillSource = 'event' | 'fill';
type OrderSide = 'Buy' | 'Sell';
type FillKind = 'fill' | 'entry' | 'scale-in' | 'scale-out' | 'exit' | 'flip';

export interface LiveFillAnnouncement {
  /** Klíč deduplikace: `event:<id>` / `fill:<id>`. */
  key: string;
  source: LiveFillSource;
  at: number;
  /** Strana příkazu, který fill udělal (výstup z longu = Sell). */
  orderSide: OrderSide;
  /** Druh pípnutí pro režim Tón. */
  cue: LiveFillCue;
  /** Krátký text: „Fill BUY 1 MNQ za 25 100,25“. */
  text: string;
  /** Text pro hlas: česká slova, cena bez mezer mezi tisíci („Koupeno 1 MNQ za 25100,25“). */
  speech: string;
  /** Výstup 4 > otočení 3 > částečný výstup 2 > vstup/přidání 1. */
  priority: number;
  /** Cena z plnění brokera (VWAP dílčích plnění); bez spárovaného plnění null. */
  price: number | null;
  /** Důvod výstupu z události workeru; plnění bez události ho nezná. */
  exitReason?: 'sl' | 'tp' | 'manual';
}

export interface LiveFillAnnouncerInput {
  /** Hodiny prohlížeče (ms). */
  now: number;
  mode: LiveFillAnnounceMode;
  /** Stejná brána jako karty obchodů: PC `copier.available`, telefon `runtimeAvailable`. */
  available: boolean;
  /** LIVE graf je otevřený (neodchází) a stránka/appka je v popředí. */
  visible: boolean;
  /** PC: okno má fokus (mluví jen jedno okno). Telefon vždy true. */
  focused: boolean;
  /** `recentCopyEvents` ze statusu workeru; undefined = zdroj teď není (další seznam = nové první načtení). */
  events?: readonly CopierCopyEvent[] | null;
  /** Šipky plnění leadera (telefon `slots.fills`). */
  fills?: readonly LiveFillMarker[] | null;
  /** Kontrakt šipek plnění (`fillsSymbol`) — jen pro text („MNQ“). */
  fillsSymbol?: string | null;
}

export interface LiveFillAnnounceResult {
  announcement: LiveFillAnnouncement | null;
  /** Kdy zavolat `step` znovu: hlášení čeká na limit 1,5 s. Jinak null. */
  retryAt: number | null;
}

export interface LiveFillAnnouncer {
  step(input: LiveFillAnnouncerInput): LiveFillAnnounceResult;
  /** Zapomene vše (další krok = první načtení). */
  reset(): void;
}

/** Hlásí se jen se zapnutou volbou, dostupnou kopírkou, viditelným grafem a (PC) fokusem. */
export function liveFillAnnouncerActive(input: Pick<LiveFillAnnouncerInput, 'mode' | 'available' | 'visible' | 'focused'>): boolean {
  return input.mode !== 'off' && input.available === true && input.visible === true && input.focused === true;
}

export function isFreshFillTime(at: number, now: number): boolean {
  return Number.isFinite(at) && Number.isFinite(now)
    && now - at <= LIVE_FILL_ANNOUNCE_MAX_AGE_MS && at - now <= LIVE_FILL_ANNOUNCE_FUTURE_MS;
}

/** Kořen kontraktu pro text: „MNQZ6“ → „MNQ“; neznámý tvar beze změny, prázdný → MNQ. */
export function liveFillSymbolRoot(symbol: string | null | undefined): string {
  const clean = (symbol ?? '').trim().toUpperCase();
  if (!clean) return DEFAULT_ROOT;
  return /^([A-Z0-9]+?)[FGHJKMNQUVXZ]\d{1,2}$/.exec(clean)?.[1] ?? clean;
}

const NBSP = ' ';
const groupThousands = (whole: string, separator: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, separator);

/** Cena česky, deterministicky (bez ICU prohlížeče): 25100.25 → „25 100,25“ (pevná mezera). */
export function formatFillPriceCs(price: number): string {
  const [whole, fraction] = Math.abs(price).toFixed(2).split('.');
  return `${price < 0 ? '−' : ''}${groupThousands(whole, NBSP)},${fraction}`;
}

/** P&L do textu: „+45,00 $“ / „−30,50 $“. */
export function formatFillPnlCs(usd: number): string {
  const sign = usd > 0 ? '+' : usd < 0 ? '−' : '';
  const [whole, fraction] = Math.abs(usd).toFixed(2).split('.');
  return `${sign}${groupThousands(whole, NBSP)},${fraction} $`;
}

/** Cena pro hlas: bez mezer mezi tisíci (syntéza by je četla jako dvě čísla), „,00“ pryč. */
export function spokenFillPrice(price: number): string {
  const [whole, fraction] = Math.abs(price).toFixed(2).split('.');
  return `${price < 0 ? 'minus ' : ''}${whole}${fraction === '00' ? '' : `,${fraction}`}`;
}

/** P&L pro hlas v celých dolarech: „plus 45 dolarů“, „minus 1 dolar“, „0 dolarů“. */
export function spokenFillPnl(usd: number): string {
  const amount = Math.round(Math.abs(usd));
  const unit = amount === 1 ? 'dolar' : amount >= 2 && amount <= 4 ? 'dolary' : 'dolarů';
  const sign = amount === 0 ? '' : usd > 0 ? 'plus ' : 'minus ';
  return `${sign}${amount} ${unit}`;
}

interface Candidate {
  key: string;
  source: LiveFillSource;
  at: number;
  orderSide: OrderSide;
  kind: FillKind;
  quantity: number;
  /** Strana pozice po události (jen otočení). */
  positionSide: 'Long' | 'Short';
  root: string;
  /** Plnění brokera: dílčí plnění jednoho příkazu = jedno hlášení. */
  orderId?: string;
  /** Σ qty a Σ qty×cena plnění, která k hlášení patří (VWAP). */
  fillQty: number;
  fillNotional: number;
  /** Cena přímo z události (u fillů ji worker dnes neposílá). */
  eventPrice: number | null;
  pnlUsd: number | null;
  exitReason?: 'sl' | 'tp' | 'manual';
}

const PRIORITY: Record<FillKind, number> = { exit: 4, flip: 3, 'scale-out': 2, entry: 1, 'scale-in': 1, fill: 1 };
const FILL_EVENT_KINDS = new Set<CopierCopyEvent['kind']>(['entry', 'scale-in', 'scale-out', 'exit', 'flip']);
const positiveFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function eventCandidate(event: CopierCopyEvent): Candidate | null {
  if (!FILL_EVENT_KINDS.has(event.kind) || !positiveFinite(event.quantity) || !Number.isFinite(event.at)) return null;
  const kind = event.kind as Exclude<FillKind, 'fill'>;
  const long = event.side === 'Long';
  // `side` je strana pozice po události (u výstupu před ní): vstup/přidání/otočení na long = Buy,
  // částečný i úplný výstup z longu = Sell.
  const reducing = kind === 'scale-out' || kind === 'exit';
  const orderSide: OrderSide = (long !== reducing) ? 'Buy' : 'Sell';
  return {
    key: `event:${event.id}`,
    source: 'event',
    at: event.at,
    orderSide,
    kind,
    quantity: event.quantity,
    positionSide: long ? 'Long' : 'Short',
    root: liveFillSymbolRoot(event.symbol),
    fillQty: 0,
    fillNotional: 0,
    eventPrice: positiveFinite(event.price) ? event.price : null,
    pnlUsd: reducing || kind === 'flip' ? finiteOrNull(event.pnlUsd) : null,
    ...(event.exitReason ? { exitReason: event.exitReason } : {}),
  };
}

function fillCandidate(fill: LiveFillMarker, symbol: string | null | undefined): Candidate | null {
  if (!fill.id || !positiveFinite(fill.price) || !positiveFinite(fill.quantity) || !Number.isFinite(fill.at)) return null;
  if (fill.side !== 'Buy' && fill.side !== 'Sell') return null;
  return {
    key: `fill:${fill.id}`,
    source: 'fill',
    at: fill.at,
    orderSide: fill.side,
    kind: 'fill',
    quantity: fill.quantity,
    positionSide: fill.side === 'Buy' ? 'Long' : 'Short',
    root: liveFillSymbolRoot(symbol),
    orderId: fill.orderId,
    fillQty: fill.quantity,
    fillNotional: fill.quantity * fill.price,
    eventPrice: null,
    pnlUsd: null,
  };
}

const candidatePrice = (candidate: Candidate): number | null => (candidate.fillQty > 0
  ? candidate.fillNotional / candidate.fillQty
  : candidate.eventPrice);

function describe(candidate: Candidate): LiveFillAnnouncement {
  const { kind, quantity, root, pnlUsd } = candidate;
  const price = candidatePrice(candidate);
  const action = candidate.orderSide === 'Buy' ? 'BUY' : 'SELL';
  const priceText = price != null ? ` za ${formatFillPriceCs(price)}` : '';
  const priceSpoken = price != null ? ` za ${spokenFillPrice(price)}` : '';
  const pnlText = pnlUsd != null ? ` · ${formatFillPnlCs(pnlUsd)}` : '';
  const pnlSpoken = pnlUsd != null ? `, ${spokenFillPnl(pnlUsd)}` : '';
  const done = candidate.orderSide === 'Buy' ? 'Koupeno' : 'Prodáno';
  let text: string;
  let speech: string;
  switch (kind) {
    case 'scale-in':
      text = `Přidáno ${action} ${quantity} ${root}${priceText}`;
      speech = `Přidáno ${quantity} ${root}${priceSpoken}`;
      break;
    case 'scale-out':
      text = `Část ${action} ${quantity} ${root}${priceText}${pnlText}`;
      speech = `Částečný výstup ${quantity} ${root}${pnlSpoken}`;
      break;
    case 'exit': {
      const label = candidate.exitReason === 'tp' ? 'TP' : candidate.exitReason === 'sl' ? 'SL' : 'Zavřeno';
      const spoken = candidate.exitReason === 'tp' ? 'TP zasažen' : candidate.exitReason === 'sl' ? 'SL zasažen' : 'Pozice zavřena';
      text = `${label} ${action} ${quantity} ${root}${priceText}${pnlText}`;
      speech = `${spoken}${pnlSpoken}`;
      break;
    }
    case 'flip': {
      const side = candidate.positionSide === 'Long' ? 'LONG' : 'SHORT';
      text = `Otočeno na ${side} ${quantity} ${root}${priceText}${pnlText}`;
      speech = `Pozice otočena na ${side.toLowerCase()} ${quantity} ${root}`;
      break;
    }
    default:
      text = `Fill ${action} ${quantity} ${root}${priceText}`;
      speech = `${done} ${quantity} ${root}${priceSpoken}`;
  }
  const cue: LiveFillCue = pnlUsd != null
    ? (pnlUsd > 0 ? 'win' : pnlUsd < 0 ? 'loss' : 'flat')
    : kind === 'exit'
      ? (candidate.exitReason === 'tp' ? 'win' : candidate.exitReason === 'sl' ? 'loss' : 'flat')
      : kind === 'scale-out' ? 'flat' : candidate.orderSide === 'Buy' ? 'buy' : 'sell';
  return {
    key: candidate.key,
    source: candidate.source,
    at: candidate.at,
    orderSide: candidate.orderSide,
    cue,
    text,
    speech,
    priority: PRIORITY[kind],
    price,
    ...(candidate.exitReason ? { exitReason: candidate.exitReason } : {}),
  };
}

/** Událost kopírky → hlášení (jen filly: vstup, přidání, část, výstup, otočení); jinak null. */
export function copyEventAnnouncement(event: CopierCopyEvent): LiveFillAnnouncement | null {
  const candidate = eventCandidate(event);
  return candidate ? describe(candidate) : null;
}

/** Plnění brokera (šipka) → hlášení „Fill BUY 1 MNQ za 25 100,25“; neplatné plnění null. */
export function fillMarkerAnnouncement(fill: LiveFillMarker, symbol?: string | null): LiveFillAnnouncement | null {
  const candidate = fillCandidate(fill, symbol);
  return candidate ? describe(candidate) : null;
}

const pairs = (a: { source: LiveFillSource; orderSide: OrderSide; at: number }, b: { source: LiveFillSource; orderSide: OrderSide; at: number }) =>
  a.source !== b.source && a.orderSide === b.orderSide && Math.abs(a.at - b.at) <= LIVE_FILL_ANNOUNCE_PAIR_MS;

/** Do `target` přidá plnění/část z `part` (qty u stejného druhu, VWAP z plnění). */
function absorbPrice(target: Candidate, part: Candidate): Candidate {
  return {
    ...target,
    at: Math.max(target.at, part.at),
    fillQty: target.fillQty + part.fillQty,
    fillNotional: target.fillNotional + part.fillNotional,
  };
}

/** Dílčí plnění jednoho příkazu = jedno hlášení (qty součet, cena VWAP). */
function mergeFillsByOrder(pool: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (const candidate of pool) {
    const index = candidate.source === 'fill' && candidate.orderId
      ? out.findIndex(item => item.source === 'fill' && item.orderId === candidate.orderId)
      : -1;
    if (index < 0) { out.push(candidate); continue; }
    const merged = absorbPrice(out[index], candidate);
    out[index] = { ...merged, quantity: out[index].quantity + candidate.quantity };
  }
  return out;
}

/** Vstup + přidání na stejnou stranu v jednom kole (dílčí plnění Marketu) = jeden vstup. */
function mergeEntryScaleIns(pool: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (const candidate of pool) {
    const index = candidate.source === 'event' && candidate.kind === 'scale-in'
      ? out.findIndex(item => item.source === 'event' && item.kind === 'entry' && item.orderSide === candidate.orderSide)
      : -1;
    if (index < 0) { out.push(candidate); continue; }
    const merged = absorbPrice(out[index], candidate);
    out[index] = { ...merged, quantity: out[index].quantity + candidate.quantity };
  }
  return out;
}

/** Plnění spárované s událostí téhož fillu jí dodá cenu; samo se neohlásí. */
function pairEventsWithFills(pool: Candidate[]): { pool: Candidate[]; paired: Candidate[] } {
  const events = pool.filter(item => item.source === 'event');
  let fills = pool.filter(item => item.source === 'fill');
  const paired: Candidate[] = [];
  const merged = events.map(event => {
    const matches = fills.filter(fill => pairs(event, fill));
    if (!matches.length) return event;
    fills = fills.filter(fill => !matches.includes(fill));
    paired.push(...matches);
    return matches.reduce(absorbPrice, event);
  });
  return { pool: [...merged, ...fills], paired };
}

const better = (a: Candidate, b: Candidate) =>
  PRIORITY[a.kind] !== PRIORITY[b.kind] ? PRIORITY[a.kind] > PRIORITY[b.kind] : a.at >= b.at;

/**
 * Ohlášený nebo záplavou vyřazený fill, jehož protějšek z druhého zdroje ještě
 * nedorazil (`open`): ten protějšek se pak neohlásí podruhé. Každý záznam pohltí
 * nejvýš jeden protějšek.
 */
interface ConsumedFill { source: LiveFillSource; orderSide: OrderSide; at: number; until: number; open: boolean }

export function createLiveFillAnnouncer(): LiveFillAnnouncer {
  const seen = new Set<string>();
  /** Příkazy, jejichž plnění už zaznělo (dílčí plnění téhož příkazu mlčí). */
  const consumedOrders = new Set<string>();
  const ready: Record<LiveFillSource, boolean> = { event: false, fill: false };
  let lastAnnouncedAt: number | null = null;
  let pending: Candidate | null = null;
  let consumed: ConsumedFill[] = [];

  const rememberIn = (set: Set<string>, key: string) => {
    set.add(key);
    if (set.size > SEEN_MAX) set.delete(set.values().next().value!);
  };
  const consumeOrder = (candidate: Candidate) => {
    if (candidate.source === 'fill' && candidate.orderId) rememberIn(consumedOrders, candidate.orderId);
  };
  /** Událost bez spárovaného plnění i samotné plnění čekají na protějšek; spárovaná událost už ho má. */
  const consume = (candidate: Candidate, now: number) => {
    consumeOrder(candidate);
    consumed.push({
      source: candidate.source, orderSide: candidate.orderSide, at: candidate.at,
      until: now + LIVE_FILL_ANNOUNCE_MAX_AGE_MS,
      open: candidate.source === 'fill' || candidate.fillQty === 0,
    });
  };
  /** Protějšek už zpracovaného fillu (stejný příkaz, nebo otevřený záznam z druhého zdroje) = ticho. */
  const isCounterpart = (candidate: Candidate): boolean => {
    if (candidate.source === 'fill' && candidate.orderId && consumedOrders.has(candidate.orderId)) return true;
    const record = consumed.find(item => item.open && pairs(item, candidate));
    if (!record) return false;
    record.open = false;
    consumeOrder(candidate);
    return true;
  };
  const none: LiveFillAnnounceResult = { announcement: null, retryAt: null };

  return {
    step(input) {
      const now = input.now;
      consumed = consumed.filter(item => item.until >= now);
      const active = liveFillAnnouncerActive(input);
      const fresh: Candidate[] = [];
      const absorb = <T>(source: LiveFillSource, list: readonly T[] | null | undefined, id: (item: T) => string, toCandidate: (item: T) => Candidate | null) => {
        if (!list) { ready[source] = false; return; }
        // První seznam zdroje (nebo první po vypnutí/skrytí) = staré události: jen zapamatovat.
        const baseline = !active || !ready[source];
        for (const item of list) {
          const key = `${source}:${id(item)}`;
          if (seen.has(key)) continue;
          rememberIn(seen, key);
          if (baseline) continue;
          const candidate = toCandidate(item);
          if (candidate && isFreshFillTime(candidate.at, now)) fresh.push(candidate);
        }
        ready[source] = active;
      };
      absorb('event', input.events, event => event.id, eventCandidate);
      absorb('fill', input.fills, fill => fill.id, fill => fillCandidate(fill, input.fillsSymbol));
      if (!active) {
        pending = null;
        return none;
      }
      const unseen = fresh.filter(candidate => !isCounterpart(candidate));
      const grouped = mergeEntryScaleIns(mergeFillsByOrder(pending ? [pending, ...unseen] : unseen));
      const { pool: paired, paired: absorbed } = pairEventsWithFills(grouped);
      for (const fill of absorbed) consumeOrder(fill);
      const pool = paired.filter(candidate => isFreshFillTime(candidate.at, now));
      for (const candidate of paired) if (!pool.includes(candidate)) consume(candidate, now);
      if (!pool.length) {
        pending = null;
        return none;
      }
      // Záplava: zazní jen nejdůležitější, ostatní se zapamatují jako zpracované.
      const best = pool.reduce((winner, candidate) => (better(candidate, winner) ? candidate : winner));
      for (const candidate of pool) if (candidate !== best) consume(candidate, now);
      if (lastAnnouncedAt != null && now - lastAnnouncedAt < LIVE_FILL_ANNOUNCE_GAP_MS) {
        pending = best;
        return { announcement: null, retryAt: lastAnnouncedAt + LIVE_FILL_ANNOUNCE_GAP_MS };
      }
      pending = null;
      consume(best, now);
      lastAnnouncedAt = now;
      return { announcement: describe(best), retryAt: null };
    },
    reset() {
      seen.clear();
      consumedOrders.clear();
      ready.event = false;
      ready.fill = false;
      lastAnnouncedAt = null;
      pending = null;
      consumed = [];
    },
  };
}

/** Úložiště volby (localStorage nebo náhrada v testech). */
export interface LiveFillAnnounceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Neznámá hodnota = Vypnuto (zvuk je volitelný doplněk, nikdy nezapnutý sám od sebe). */
export function parseLiveFillAnnounceMode(raw: unknown): LiveFillAnnounceMode {
  return raw === 'tone' || raw === 'voice' ? raw : 'off';
}

export function readLiveFillAnnounceMode(storage: LiveFillAnnounceStorage | null | undefined): LiveFillAnnounceMode {
  try { return parseLiveFillAnnounceMode(storage?.getItem(LIVE_FILL_ANNOUNCE_STORAGE_KEY)); } catch { return 'off'; }
}

export function writeLiveFillAnnounceMode(storage: LiveFillAnnounceStorage | null | undefined, mode: LiveFillAnnounceMode): void {
  try { storage?.setItem(LIVE_FILL_ANNOUNCE_STORAGE_KEY, parseLiveFillAnnounceMode(mode)); } catch { /* jen bez paměti volby */ }
}
