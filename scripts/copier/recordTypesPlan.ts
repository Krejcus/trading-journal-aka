/**
 * Čistá logika záznamu REC-TYPES (`docs/reviews/trading-gaps-designs/types.md` §1.2, S1–S9)
 * a R12 (`safety.md` C12 bod 6, TIF Day v denní pauze CME): pojistky, ceny scénářů,
 * payload `placeoso`, poslední síto před POSTem, klasifikace výsledků a anonymizace.
 * Skript `record-types.ts` spouští jen Filip; tady se nic neposílá k brokerovi.
 *
 * Pevně: DEMO, účet DEMO8661118 (61038658), čtvrtletní MNQ (front ověří běžec u brokera),
 * qty ≤ 2, worker DISARMED v manual-only local-only skupině bez followerů. Scénáře
 * s TrailingStop/MIT (S4–S6) jen s workerem, který má opravu C1 (`controller.unsupportedOrders`
 * ve statusu, `services/copierRuntimeController.ts`) — starý worker by na nich ztratil stream.
 */
import { pickCopierMarketPrice } from '../../lib/copierMarketPrice';
import { RECORD_PRIVATE_KEYS, RECORD_TICK_SIZE, type CleanupObservation, type RecordPlacement } from './recordLeaderOsoPlan';

export const RECORD_TYPES_ACCOUNT_ID = 61_038_658;
export const RECORD_TYPES_ACCOUNT_SPEC = 'DEMO8661118';
export const RECORD_TYPES_MAX_QTY = 2;
/** Vzdálené příkazy (nesmí se vyplnit): aspoň tolik od reference. */
export const RECORD_TYPES_FAR_RATIO = 0.015;
/** V pauze CME (bez čerstvé ceny) ještě dál. */
export const RECORD_TYPES_PAUSE_FAR_RATIO = 0.03;
/** Žádná cena v payloadu dál od reference (chybná kotva, překlep). */
export const RECORD_TYPES_MAX_PRICE_RATIO = 0.035;
/** Riziko: SL nejvýš tolik ticků od nejhorší ceny vstupu (60 t = 15 b = 30 USD na 1 MNQ). */
export const RECORD_TYPES_MAX_SL_TICKS = 60;
export const RECORD_TYPES_SL_TICKS = 40;
/** Kotva = cena workeru stará nejvýš tolik (přísnější než zobrazovací 10 s). */
export const RECORD_TYPES_ANCHOR_MAX_AGE_MS = 3_000;
/** `--market-price` vs. kotva při startu / před každým scénářem. */
export const RECORD_TYPES_START_DIFF_RATIO = 0.003;
export const RECORD_TYPES_DRIFT_RATIO = 0.015;
export const RECORD_TYPES_GTD_EXPIRE_MS = 90_000;
export const RECORD_TYPES_GTD_FILL_EXPIRE_MS = 60_000;
/** GTD `expireTime` v payloadu musí ležet v tomto okně od teď. */
export const RECORD_TYPES_GTD_MIN_MS = 30_000;
export const RECORD_TYPES_GTD_MAX_MS = 150_000;

type Side = 'Buy' | 'Sell';
export type TypesScenarioId =
  | 'stoplimit-cancel' | 'stoplimit-fill' | 'stoplimit-through'
  | 'trailing-leg' | 'mit-cancel' | 'mit-touch'
  | 'tif-readback' | 'tif-gtd-expire' | 'tif-gtd-fill'
  | 'leg-through-buy' | 'leg-through-sell'
  | 'tif-pause';

type EntryType = 'Limit' | 'StopLimit' | 'MIT';
type StopLegType = 'Stop' | 'TrailingStop';
type Tif = 'Day' | 'GTC' | 'GTD';

interface ScenarioDefinition {
  code: string;
  /** Položka návrhu, kterou záznam rozhoduje. */
  item: string;
  window: 'market' | 'pause';
  /** TrailingStop / MIT: jen s workerem s opravou C1. */
  needsUnsupportedFix: boolean;
  entryType: EntryType;
  stopLossType: StopLegType;
  /** Povolené TIF vstupu (`none` = bez pole). */
  tif: ReadonlyArray<Tif | 'none'>;
  checks: string;
}

export const TYPES_SCENARIOS: Readonly<Record<TypesScenarioId, ScenarioDefinition>> = {
  'stoplimit-cancel': { code: 'S1', item: 'C10-STOPLIMIT', window: 'market', needsUnsupportedFix: false, entryType: 'StopLimit', stopLossType: 'Stop', tif: ['none'],
    checks: 'Buy StopLimit OSO 1,5 % nad trhem: přijetí, verze (orderType/price/stopPrice), nohy Suspended, kaskáda zrušení' },
  'stoplimit-fill': { code: 'S2', item: 'C10-STOPLIMIT', window: 'market', needsUnsupportedFix: false, entryType: 'StopLimit', stopLossType: 'Stop', tif: ['none'],
    checks: 'Buy StopLimit stop = trh + 1 t, limit + 8 t: přechod při spuštění (nová verze? změna typu? = i S2b), fill, nohy → Working' },
  'stoplimit-through': { code: 'S3', item: 'C10-STOPLIMIT', window: 'market', needsUnsupportedFix: false, entryType: 'StopLimit', stopLossType: 'Stop', tif: ['none'],
    checks: 'Buy StopLimit se stopem 8 t pod trhem (už přes trh): odmítnutí vs. spuštěný ležící limit (blocker entry-trigger-side); může se vyplnit' },
  'trailing-leg': { code: 'S4', item: 'C10-TRAIL + fixture C1', window: 'market', needsUnsupportedFix: true, entryType: 'Limit', stopLossType: 'TrailingStop', tif: ['none'],
    checks: 'marketable Buy Limit + SL TrailingStop (pegDifference): přijetí nohy, znaménko pegDifference, posun trailu ve streamu, OCO s TP, kaskáda liquidate' },
  'mit-cancel': { code: 'S5', item: 'C10-MIT + fixture C1', window: 'market', needsUnsupportedFix: true, entryType: 'MIT', stopLossType: 'Stop', tif: ['none'],
    checks: 'Buy MIT 1,5 % pod trhem: přijetí, typ a pole spouště v rámcích, nohy Suspended, zrušení' },
  'mit-touch': { code: 'S6', item: 'C10-MIT', window: 'market', needsUnsupportedFix: true, entryType: 'MIT', stopLossType: 'Stop', tif: ['none'],
    checks: 'Buy MIT 4 t nad trhem (už „dotčený“): okamžité spuštění vs. odmítnutí; fill; nohy' },
  'tif-readback': { code: 'S7', item: 'TIF-b + R12a', window: 'market', needsUnsupportedFix: false, entryType: 'Limit', stopLossType: 'Stop', tif: ['none', 'Day', 'GTC'],
    checks: 'tři vzdálené Limit OSO postupně (bez TIF, Day, GTC): kde Tradovate TIF vrací, výchozí TIF vstupu i NOHOU' },
  'tif-gtd-expire': { code: 'S8', item: 'TIF-b', window: 'market', needsUnsupportedFix: false, entryType: 'Limit', stopLossType: 'Stop', tif: ['GTD'],
    checks: 'vzdálený Limit OSO GTD (teď + 90 s): řetězec ordStatus při vypršení, kaskáda nohou, executionReport' },
  'tif-gtd-fill': { code: 'S8b', item: 'TIF-b (critic P2)', window: 'market', needsUnsupportedFix: false, entryType: 'Limit', stopLossType: 'Stop', tif: ['GTD'],
    checks: 'marketable Buy Limit GTD (teď + 60 s) se vyplní: přežijí SL/TP expireTime rodiče?' },
  'leg-through-buy': { code: 'S9a', item: 'C14', window: 'market', needsUnsupportedFix: false, entryType: 'Limit', stopLossType: 'Stop', tif: ['none'],
    checks: 'Buy Limit trh + 8 t, SL Stop trh + 2 t (nad fillem): SL přes trh při aktivaci — Rejected / hned spuštěn / Working' },
  'leg-through-sell': { code: 'S9b', item: 'C14', window: 'market', needsUnsupportedFix: false, entryType: 'Limit', stopLossType: 'Stop', tif: ['none'],
    checks: 'zrcadlově Sell Limit trh − 8 t, SL Stop trh − 2 t' },
  'tif-pause': { code: 'R12d', item: 'C12 (TIF Day v pauze CME)', window: 'pause', needsUnsupportedFix: false, entryType: 'Limit', stopLossType: 'Stop', tif: ['Day', 'none'],
    checks: 'v pauze 16:00–17:00 CT: přijme broker Limit OSO s TIF Day / bez TIF, a přijme zrušení?' },
};

export const TYPES_SCENARIO_ORDER: readonly TypesScenarioId[] = [
  'stoplimit-cancel', 'stoplimit-fill', 'stoplimit-through', 'trailing-leg', 'mit-cancel', 'mit-touch',
  'tif-readback', 'tif-gtd-expire', 'tif-gtd-fill', 'leg-through-buy', 'leg-through-sell', 'tif-pause',
];
/** `--scenario all` = vše v obchodní době (pauza má jiné okno, jen samostatně). */
export const TYPES_ALL: readonly TypesScenarioId[] = TYPES_SCENARIO_ORDER.filter(id => TYPES_SCENARIOS[id].window === 'market');

export interface RecordTypesPlan {
  accountId: number;
  symbol: string;
  marketPrice: number;
  quantity: number;
  scenarios: TypesScenarioId[];
  confirm: boolean;
  /** `offset` = pegDifference = stopPrice − trh (Sell trailing = záporné); `flip` = opačné znaménko. NEOVĚŘENO, proto volba. */
  trailPeg: 'offset' | 'flip';
  /** Spoušť MIT v poli `price` (výchozí) nebo `stopPrice`. NEOVĚŘENO, proto volba. */
  mitTrigger: 'price' | 'stopPrice';
}

const VALUE_FLAGS = new Set(['account', 'symbol', 'market-price', 'qty', 'scenario', 'trail-peg', 'mit-trigger', 'environment']);
const BOOLEAN_FLAGS = new Set(['confirm']);

export function parseRecordTypesArgs(argv: readonly string[]): RecordTypesPlan {
  // Neznámá volba (překlep `--confrim`, `--live`, …) = nic se nespustí.
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const name = arg.startsWith('--') ? arg.slice(2) : null;
    if (name != null && BOOLEAN_FLAGS.has(name)) continue;
    if (name != null && VALUE_FLAGS.has(name)) {
      if (argv[index + 1] === undefined || argv[index + 1].startsWith('--')) throw new Error(`Chybí hodnota --${name}`);
      index += 1;
      continue;
    }
    throw new Error(`Neznámý argument ${arg} — záznam běží jen s výslovnými volbami`);
  }
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if ((value('environment') ?? 'demo') !== 'demo') throw new Error('Jen DEMO: --environment musí být demo');
  const accountId = Number(value('account'));
  if (accountId !== RECORD_TYPES_ACCOUNT_ID) throw new Error(`--account musí být ${RECORD_TYPES_ACCOUNT_ID} (${RECORD_TYPES_ACCOUNT_SPEC})`);
  const symbol = (value('symbol') ?? '').trim().toUpperCase();
  if (!/^MNQ[HMUZ]\d$/.test(symbol)) throw new Error('--symbol musí být čtvrtletní kontrakt MNQ, např. MNQZ6');
  const marketPrice = Number(value('market-price'));
  if (!(Number.isFinite(marketPrice) && marketPrice > 0)) throw new Error('Chybí nebo je neplatné --market-price');
  const quantity = Number(value('qty') ?? '1');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > RECORD_TYPES_MAX_QTY) throw new Error(`--qty musí být 1–${RECORD_TYPES_MAX_QTY}`);
  const rawScenario = value('scenario');
  if (!rawScenario) throw new Error(`Chybí --scenario (all nebo seznam: ${TYPES_SCENARIO_ORDER.join(', ')})`);
  const requested = rawScenario === 'all' ? [...TYPES_ALL] : rawScenario.split(',').map(item => item.trim()).filter(Boolean);
  for (const item of requested) {
    if (!TYPES_SCENARIO_ORDER.includes(item as TypesScenarioId)) throw new Error(`Neznámý scénář ${item}`);
  }
  const scenarios = TYPES_SCENARIO_ORDER.filter(id => requested.includes(id));
  if (scenarios.length === 0) throw new Error('Žádný scénář');
  if (scenarios.includes('tif-pause') && scenarios.length > 1) throw new Error('tif-pause běží jen samostatně (jiné časové okno)');
  const trailPeg = value('trail-peg') ?? 'offset';
  if (trailPeg !== 'offset' && trailPeg !== 'flip') throw new Error('--trail-peg musí být offset nebo flip');
  const mitTrigger = value('mit-trigger') ?? 'price';
  if (mitTrigger !== 'price' && mitTrigger !== 'stopPrice') throw new Error('--mit-trigger musí být price nebo stopPrice');
  return { accountId, symbol, marketPrice, quantity, scenarios, confirm: argv.includes('--confirm'), trailPeg, mitTrigger };
}

/** Bez `--confirm` se nikdy nic neposílá, ani když všechny pojistky projdou. */
export const recordTypesMayPlace = (plan: Pick<RecordTypesPlan, 'confirm'>, problems: readonly string[]): boolean =>
  plan.confirm === true && problems.length === 0;

// ---------------------------------------------------------------------------
// Čas CME (America/Chicago, DST přes Intl)

const CHICAGO = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function chicagoClock(now: number): { weekday: number; minute: number } {
  const parts = Object.fromEntries(CHICAGO.formatToParts(new Date(now)).map(part => [part.type, part.value]));
  return { weekday: WEEKDAYS.indexOf(parts.weekday), minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

/** Scénáře s trhem končí s rezervou před pauzou 16:00 CT (S8 drží až ~2 min). */
const MARKET_GUARD_START = 15 * 60 + 45;
const MARKET_REOPEN = 17 * 60 + 5;
const PAUSE_START = 16 * 60;
const PAUSE_LAST_START = 16 * 60 + 50;

export function scenarioWindowProblem(window: 'market' | 'pause', now: number): string | null {
  const { weekday, minute } = chicagoClock(now);
  if (window === 'pause') {
    if (weekday < 1 || weekday > 4) return 'scénář pauzy jen Po–Čt (denní pauza CME), ne v pátek ani o víkendu';
    if (minute < PAUSE_START || minute >= PAUSE_LAST_START) return 'scénář pauzy smí začít jen 16:00–16:50 CT (denní pauza CME)';
    return null;
  }
  if (weekday === 6 || (weekday === 0 && minute < MARKET_REOPEN) || (weekday === 5 && minute >= MARKET_GUARD_START)) {
    return 'trh je zavřený (víkend) — scénáře s trhem jen v obchodní době';
  }
  if (minute >= MARKET_GUARD_START && minute < MARKET_REOPEN) return 'blízko denní pauzy CME (15:45–17:05 CT) — scénáře s trhem neběží';
  return null;
}

// ---------------------------------------------------------------------------
// Pojistky stavu workeru

/** Reference cen: čerstvá cena workeru (≤ 3 s); v pauze (bez obchodů) `--market-price`. */
export function recordTypesReference(
  plan: Pick<RecordTypesPlan, 'symbol' | 'marketPrice'>,
  status: unknown,
  now: number,
  window: 'market' | 'pause',
): { price: number | null; source: 'worker' | 'market-price'; anchor: number | null } {
  const rows = (status as { marketPrices?: unknown } | null)?.marketPrices;
  const fresh = (Array.isArray(rows) ? rows : []).filter(row => {
    const at = (row as { at?: unknown } | null)?.at;
    return typeof at === 'number' && Math.abs(now - at) <= RECORD_TYPES_ANCHOR_MAX_AGE_MS;
  });
  const anchor = pickCopierMarketPrice(fresh, plan.symbol, now);
  if (window === 'pause') return { price: plan.marketPrice, source: 'market-price', anchor };
  return { price: anchor, source: 'worker', anchor };
}

export type RecordTypesStage = { kind: 'start' } | { kind: 'scenario'; scenario: TypesScenarioId };

/**
 * Důvody, proč záznam NESMÍ běžet (prázdné = smí). `start`: plná kontrola workeru před
 * připojením. `scenario`: před každým scénářem / zadáním — DISARMED (jako `armed-gate.sh`),
 * bez auto-resume, stejná sólo skupina, okno, kotva a u S4–S6 oprava C1. Po prvním scénáři
 * worker čeká na kontrolu pozic (cizí příkaz leadera ji zneplatní), proto se to už nežádá.
 */
export function recordTypesStatusProblems(plan: RecordTypesPlan, status: unknown, now: number, stage: RecordTypesStage): string[] {
  const problems: string[] = [];
  const root = (status ?? {}) as {
    environment?: unknown;
    controller?: Record<string, unknown>;
    group?: { leaderAccountId?: unknown; manualOnly?: unknown; localOnly?: unknown; followers?: unknown } | null;
  };
  const controller = root.controller ?? {};
  if (plan.accountId !== RECORD_TYPES_ACCOUNT_ID) problems.push(`jen účet ${RECORD_TYPES_ACCOUNT_ID} (${RECORD_TYPES_ACCOUNT_SPEC})`);
  if (!/^MNQ[HMUZ]\d$/.test(plan.symbol)) problems.push('jen čtvrtletní kontrakt MNQ');
  if (!Number.isInteger(plan.quantity) || plan.quantity < 1 || plan.quantity > RECORD_TYPES_MAX_QTY) problems.push(`qty jen 1–${RECORD_TYPES_MAX_QTY}`);
  if (root.environment !== 'demo') problems.push('worker neběží na DEMO prostředí');
  if (controller.armed !== false) problems.push('kopírka není prokazatelně DISARMED');
  const resume = controller.transportResume as { phase?: unknown } | null | undefined;
  if (resume && (resume.phase === 'waiting' || resume.phase === 'ready')) problems.push('běží automatické pokračování po výpadku');
  if (root.group?.leaderAccountId !== plan.accountId) problems.push('účet není leader skupiny workeru');
  if (root.group?.manualOnly !== true || root.group?.localOnly !== true) problems.push('skupina workeru není manual-only + local-only');
  if (!Array.isArray(root.group?.followers) || root.group.followers.length !== 0) problems.push('skupina workeru má followery');
  if (stage.kind === 'start') {
    if (controller.connected !== true) problems.push('worker není připojený');
    if (controller.killSwitch === true) problems.push('kill switch je aktivní');
    if (controller.groupFlat !== true) problems.push('skupina není flat');
    if (controller.reconciliationRequired !== false) problems.push('worker čeká na kontrolu pozic');
    if (controller.lastError != null) problems.push('worker má lastError (reconcile po záznamu by ho smazal)');
    if (controller.manualRecovery != null
      || (controller.armPreparation as { manualRecoveryRequired?: unknown } | undefined)?.manualRecoveryRequired === true) {
      problems.push('worker čeká na ruční obnovu');
    }
    if (Array.isArray(controller.divergentAccounts) && controller.divergentAccounts.length) problems.push('skupina má divergenci');
    if (Array.isArray(controller.workingOrderAccounts) && controller.workingOrderAccounts.length) problems.push('ve skupině jsou working orders');
  }
  const scenarios = stage.kind === 'start' ? plan.scenarios : [stage.scenario];
  if (scenarios.length === 0 || scenarios.some(id => !TYPES_SCENARIOS[id])) return [...problems, 'žádný nebo neznámý scénář'];
  if (scenarios.some(id => TYPES_SCENARIOS[id].needsUnsupportedFix)) {
    // KRITICKÉ: TrailingStop/MIT starému workeru shodí stream až do konce session (oponentura P1).
    if (!Array.isArray(controller.unsupportedOrders)) {
      problems.push('worker nemá opravu C1 (status bez controller.unsupportedOrders) — TrailingStop/MIT (S4–S6) by mu shodily stream; nasaď worker s opravou a spusť znovu');
    } else if (controller.unsupportedOrders.length) problems.push('worker už hlásí cizí nepodporovaný příkaz (unsupportedOrders) — nejdřív ho vyřeš');
  }
  const window = TYPES_SCENARIOS[scenarios[0]].window;
  const windowProblem = scenarioWindowProblem(window, now);
  if (windowProblem) problems.push(windowProblem);
  const reference = recordTypesReference(plan, status, now, window);
  if (window === 'market') {
    if (reference.anchor == null) problems.push(`worker nemá čerstvou cenu ${plan.symbol} (≤ ${RECORD_TYPES_ANCHOR_MAX_AGE_MS / 1000} s; otevři graf MNQ)`);
    else {
      const ratio = stage.kind === 'start' ? RECORD_TYPES_START_DIFF_RATIO : RECORD_TYPES_DRIFT_RATIO;
      if (Math.abs(reference.anchor - plan.marketPrice) > plan.marketPrice * ratio) {
        problems.push(`--market-price ${plan.marketPrice} nesedí s cenou workeru ${reference.anchor} (tolerance ${(ratio * 100).toFixed(1)} %)`);
      }
    }
  } else if (reference.anchor != null && Math.abs(reference.anchor - plan.marketPrice) > plan.marketPrice * RECORD_TYPES_START_DIFF_RATIO) {
    problems.push(`--market-price ${plan.marketPrice} nesedí s cenou workeru ${reference.anchor}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Scénáře → konkrétní příkazy

export interface TypesEntry {
  side: Side;
  orderType: EntryType;
  /** Limit / limit StopLimitu / spoušť MIT. */
  price: number;
  /** Spoušť StopLimitu. */
  stopPrice?: number;
  timeInForce?: Tif;
  expireAt?: number;
}
export interface TypesLeg {
  side: Side;
  orderType: 'Stop' | 'Limit' | 'TrailingStop';
  price?: number;
  stopPrice?: number;
  pegDifference?: number;
}
export interface TypesPlacement {
  label: string;
  entry: TypesEntry;
  stopLoss: TypesLeg;
  takeProfit: TypesLeg;
  /** `hold` = podržet a uklidit; `fill` = čekat na fill (≤ 10 s), pak podržet; `expire` = sledovat do expireTime + rezerva. */
  flow: 'hold' | 'fill' | 'expire';
  holdMs: number;
  afterExpireMs: number;
  /** REST čtení order / orderVersion / executionReport vlastních id (TIF). */
  readback: boolean;
}

const TICK = RECORD_TICK_SIZE;
const ticks = (count: number) => count * TICK;
const tickNearest = (price: number) => Math.round(price / TICK) * TICK;
const tickUp = (price: number) => Math.ceil(price / TICK - 1e-9) * TICK;
const tickDown = (price: number) => Math.floor(price / TICK + 1e-9) * TICK;
const opposite = (side: Side): Side => (side === 'Buy' ? 'Sell' : 'Buy');
const stopLeg = (entrySide: Side, stopPrice: number): TypesLeg => ({ side: opposite(entrySide), orderType: 'Stop', stopPrice });
const targetLeg = (entrySide: Side, price: number): TypesLeg => ({ side: opposite(entrySide), orderType: 'Limit', price });

/**
 * Příkazy scénáře z reference (cena workeru těsně před zadáním; v pauze `--market-price`).
 * Běžec volá znovu před každým zadáním (čerstvá reference i `now` pro GTD).
 */
export function buildTypesPlacements(
  scenario: TypesScenarioId,
  reference: number,
  options: Pick<RecordTypesPlan, 'trailPeg'>,
  now: number,
): TypesPlacement[] {
  const r = tickNearest(reference);
  const farUp = tickUp(r * (1 + RECORD_TYPES_FAR_RATIO));
  const farDown = tickDown(r * (1 - RECORD_TYPES_FAR_RATIO));
  const base = { flow: 'hold' as const, holdMs: 4_000, afterExpireMs: 0, readback: false };
  const farLimit = (label: string, price: number, timeInForce?: Tif): TypesPlacement => ({
    ...base, label, holdMs: 2_000, readback: true,
    entry: { side: 'Buy', orderType: 'Limit', price, ...(timeInForce ? { timeInForce } : {}) },
    stopLoss: stopLeg('Buy', price - ticks(RECORD_TYPES_SL_TICKS)),
    takeProfit: targetLeg('Buy', price + ticks(160)),
  });
  switch (scenario) {
    case 'stoplimit-cancel': {
      const stop = farUp;
      const limit = stop + ticks(2);
      return [{ ...base, label: 'Buy StopLimit 1,5 % nad trhem',
        entry: { side: 'Buy', orderType: 'StopLimit', stopPrice: stop, price: limit },
        stopLoss: stopLeg('Buy', stop - ticks(RECORD_TYPES_SL_TICKS)), takeProfit: targetLeg('Buy', limit + ticks(160)) }];
    }
    case 'stoplimit-fill': {
      const stop = r + ticks(1);
      return [{ ...base, flow: 'fill', label: 'Buy StopLimit na trhu (stop + 1 t, limit + 8 t)',
        entry: { side: 'Buy', orderType: 'StopLimit', stopPrice: stop, price: stop + ticks(8) },
        stopLoss: stopLeg('Buy', r - ticks(RECORD_TYPES_SL_TICKS)), takeProfit: targetLeg('Buy', farUp) }];
    }
    case 'stoplimit-through':
      return [{ ...base, label: 'Buy StopLimit se stopem 8 t pod trhem',
        entry: { side: 'Buy', orderType: 'StopLimit', stopPrice: r - ticks(8), price: r - ticks(6) },
        stopLoss: stopLeg('Buy', r - ticks(48)), takeProfit: targetLeg('Buy', farUp) }];
    case 'trailing-leg': {
      const stopPrice = r - ticks(RECORD_TYPES_SL_TICKS);
      const offset = stopPrice - r;
      return [{ ...base, flow: 'fill', holdMs: 15_000, label: 'marketable Buy Limit + TrailingStop SL',
        entry: { side: 'Buy', orderType: 'Limit', price: r + ticks(2) },
        stopLoss: { side: 'Sell', orderType: 'TrailingStop', stopPrice, pegDifference: options.trailPeg === 'flip' ? -offset : offset },
        takeProfit: targetLeg('Buy', farUp) }];
    }
    case 'mit-cancel':
      return [{ ...base, label: 'Buy MIT 1,5 % pod trhem',
        entry: { side: 'Buy', orderType: 'MIT', price: farDown },
        stopLoss: stopLeg('Buy', farDown - ticks(RECORD_TYPES_SL_TICKS)), takeProfit: targetLeg('Buy', farDown + ticks(160)) }];
    case 'mit-touch':
      return [{ ...base, flow: 'fill', holdMs: 2_000, label: 'Buy MIT 4 t nad trhem (dotčený)',
        entry: { side: 'Buy', orderType: 'MIT', price: r + ticks(4) },
        stopLoss: stopLeg('Buy', r - ticks(RECORD_TYPES_SL_TICKS)), takeProfit: targetLeg('Buy', farUp) }];
    case 'tif-readback':
      return [farLimit('Limit bez TIF', farDown), farLimit('Limit TIF Day', farDown, 'Day'), farLimit('Limit TIF GTC', farDown, 'GTC')];
    case 'tif-gtd-expire':
      return [{ ...farLimit('Limit GTD + 90 s', farDown), flow: 'expire', holdMs: 0, afterExpireMs: 20_000,
        entry: { side: 'Buy', orderType: 'Limit', price: farDown, timeInForce: 'GTD', expireAt: now + RECORD_TYPES_GTD_EXPIRE_MS } }];
    case 'tif-gtd-fill':
      return [{ ...base, flow: 'expire', holdMs: 0, afterExpireMs: 10_000, readback: true, label: 'marketable Buy Limit GTD + 60 s',
        entry: { side: 'Buy', orderType: 'Limit', price: r + ticks(2), timeInForce: 'GTD', expireAt: now + RECORD_TYPES_GTD_FILL_EXPIRE_MS },
        stopLoss: stopLeg('Buy', r - ticks(RECORD_TYPES_SL_TICKS)), takeProfit: targetLeg('Buy', farUp) }];
    case 'leg-through-buy':
      return [{ ...base, flow: 'fill', holdMs: 0, label: 'Buy Limit + 8 t, SL + 2 t (nad fillem)',
        entry: { side: 'Buy', orderType: 'Limit', price: r + ticks(8) },
        stopLoss: stopLeg('Buy', r + ticks(2)), takeProfit: targetLeg('Buy', farUp) }];
    case 'leg-through-sell':
      return [{ ...base, flow: 'fill', holdMs: 0, label: 'Sell Limit − 8 t, SL − 2 t (pod fillem)',
        entry: { side: 'Sell', orderType: 'Limit', price: r - ticks(8) },
        stopLoss: stopLeg('Sell', r - ticks(2)), takeProfit: targetLeg('Sell', farDown) }];
    case 'tif-pause': {
      const price = tickDown(r * (1 - RECORD_TYPES_PAUSE_FAR_RATIO));
      return [{ ...farLimit('Limit TIF Day v pauze', price, 'Day'), holdMs: 5_000 }, { ...farLimit('Limit bez TIF v pauze', price), holdMs: 5_000 }];
    }
  }
}

// ---------------------------------------------------------------------------
// Payload `placeoso` a poslední síto

export interface TypesLegPayload {
  action: Side;
  orderType: string;
  price?: number;
  stopPrice?: number;
  pegDifference?: number;
  clOrdId: string;
}
export interface TypesOsoPayload {
  accountSpec: string;
  accountId: number;
  action: Side;
  symbol: string;
  orderQty: number;
  orderType: string;
  price?: number;
  stopPrice?: number;
  timeInForce?: string;
  expireTime?: string;
  clOrdId: string;
  isAutomated: true;
  bracket1: TypesLegPayload;
  bracket2: TypesLegPayload;
}

export function buildTypesOsoPayload(
  placement: TypesPlacement,
  context: { accountId: number; accountSpec: string; symbol: string; quantity: number; tag: string; mitTrigger: RecordTypesPlan['mitTrigger'] },
): TypesOsoPayload {
  const { entry } = placement;
  const trigger = entry.orderType === 'MIT' && context.mitTrigger === 'stopPrice'
    ? { stopPrice: entry.price }
    : { price: entry.price, ...(entry.stopPrice != null ? { stopPrice: entry.stopPrice } : {}) };
  const leg = (value: TypesLeg, suffix: string): TypesLegPayload => ({
    action: value.side,
    orderType: value.orderType,
    ...(value.price != null ? { price: value.price } : {}),
    ...(value.stopPrice != null ? { stopPrice: value.stopPrice } : {}),
    ...(value.pegDifference != null ? { pegDifference: value.pegDifference } : {}),
    clOrdId: `${context.tag}${suffix}`,
  });
  return {
    accountSpec: context.accountSpec,
    accountId: context.accountId,
    action: entry.side,
    symbol: context.symbol,
    orderQty: context.quantity,
    orderType: entry.orderType,
    ...trigger,
    ...(entry.timeInForce ? { timeInForce: entry.timeInForce } : {}),
    ...(entry.expireAt != null ? { expireTime: new Date(entry.expireAt).toISOString() } : {}),
    clOrdId: context.tag,
    isAutomated: true,
    bracket1: leg(placement.stopLoss, 's'),
    bracket2: leg(placement.takeProfit, 't'),
  };
}

const onTick = (price: number) => Math.abs(price / TICK - Math.round(price / TICK)) < 1e-9;

/**
 * Poslední síto těsně před POSTem (prázdné = smí). Nezávislé na builderu: účet, symbol, qty,
 * typy vázané na scénář, ceny na tick a blízko reference, SL na ochranné straně s omezeným
 * rizikem, TP na ziskové straně, TIF jen povolený, GTD jen v krátkém okně.
 */
export function typesPayloadProblems(
  payload: TypesOsoPayload,
  context: { plan: RecordTypesPlan; scenario: TypesScenarioId; reference: number; now: number },
): string[] {
  const problems: string[] = [];
  const definition = TYPES_SCENARIOS[context.scenario];
  if (payload.accountId !== RECORD_TYPES_ACCOUNT_ID || context.plan.accountId !== RECORD_TYPES_ACCOUNT_ID) problems.push('payload: jiný účet než DEMO8661118');
  if (payload.accountSpec !== RECORD_TYPES_ACCOUNT_SPEC) problems.push('payload: accountSpec není DEMO8661118');
  if (payload.symbol !== context.plan.symbol || !/^MNQ[HMUZ]\d$/.test(payload.symbol)) problems.push('payload: jiný symbol než plánovaný MNQ');
  if (!Number.isInteger(payload.orderQty) || payload.orderQty < 1 || payload.orderQty > RECORD_TYPES_MAX_QTY) problems.push(`payload: qty mimo 1–${RECORD_TYPES_MAX_QTY}`);
  if (payload.isAutomated !== true) problems.push('payload: isAutomated musí být true');
  if (payload.action !== 'Buy' && payload.action !== 'Sell') problems.push('payload: neplatná strana');
  const exit = payload.action === 'Buy' ? 'Sell' : 'Buy';
  if (payload.bracket1?.action !== exit || payload.bracket2?.action !== exit) problems.push('payload: nohy musí být opačné strany než vstup');
  if (payload.orderType !== definition.entryType) problems.push(`payload: vstup ${payload.orderType} nepatří do ${context.scenario}`);
  if (payload.bracket1?.orderType !== definition.stopLossType) problems.push(`payload: SL ${payload.bracket1?.orderType} nepatří do ${context.scenario}`);
  if (payload.bracket2?.orderType !== 'Limit') problems.push('payload: TP musí být Limit');
  const prices: Array<[string, number | undefined]> = [
    ['price', payload.price], ['stopPrice', payload.stopPrice],
    ['SL price', payload.bracket1?.price], ['SL stopPrice', payload.bracket1?.stopPrice],
    ['TP price', payload.bracket2?.price], ['TP stopPrice', payload.bracket2?.stopPrice],
  ];
  for (const [name, price] of prices) {
    if (price === undefined) continue;
    if (!(Number.isFinite(price) && price > 0) || !onTick(price)) problems.push(`payload: ${name} není kladná cena na tick ${TICK}`);
    else if (Math.abs(price - context.reference) > context.reference * RECORD_TYPES_MAX_PRICE_RATIO) problems.push(`payload: ${name} je dál než ${RECORD_TYPES_MAX_PRICE_RATIO * 100} % od reference`);
  }
  // Nejhorší cena vstupu: limit (Limit, StopLimit), spoušť (MIT; skluz kryje rezerva rizika).
  const worst = payload.orderType === 'MIT' ? (payload.price ?? payload.stopPrice) : payload.price;
  if (worst === undefined) problems.push('payload: vstup bez ceny');
  if (payload.orderType === 'MIT' && (payload.price === undefined) === (payload.stopPrice === undefined)) problems.push('payload: MIT nese spoušť právě v jednom poli');
  if (payload.orderType === 'StopLimit') {
    if (payload.stopPrice === undefined || payload.price === undefined) problems.push('payload: StopLimit potřebuje stopPrice i price');
    else if ((payload.action === 'Buy' ? payload.price < payload.stopPrice : payload.price > payload.stopPrice)
      || Math.abs(payload.price - payload.stopPrice) > ticks(20)) problems.push('payload: limit StopLimitu musí být 0–20 t za spouští');
  } else if (payload.orderType !== 'MIT' && payload.stopPrice !== undefined) problems.push('payload: stopPrice jen u StopLimit/MIT');
  const stopLevel = payload.bracket1?.stopPrice;
  if (stopLevel === undefined || payload.bracket1?.price !== undefined) problems.push('payload: SL musí mít jen stopPrice');
  if (worst !== undefined && stopLevel !== undefined) {
    const risk = payload.action === 'Buy' ? worst - stopLevel : stopLevel - worst;
    if (!(risk > 0)) problems.push('payload: SL není na ochranné straně vstupu');
    else if (risk > ticks(RECORD_TYPES_MAX_SL_TICKS)) problems.push(`payload: SL dál než ${RECORD_TYPES_MAX_SL_TICKS} t od vstupu (riziko)`);
  }
  const target = payload.bracket2?.price;
  if (worst !== undefined && (target === undefined || (payload.action === 'Buy' ? target <= worst : target >= worst))) problems.push('payload: TP není na ziskové straně vstupu');
  const peg = payload.bracket1?.pegDifference;
  if (payload.bracket1?.orderType === 'TrailingStop') {
    if (peg === undefined || !Number.isFinite(peg) || peg === 0 || !onTick(Math.abs(peg)) || Math.abs(peg) > ticks(RECORD_TYPES_MAX_SL_TICKS)) {
      problems.push(`payload: pegDifference musí být nenulový, na tick a nejvýš ${RECORD_TYPES_MAX_SL_TICKS} t`);
    }
  } else if (peg !== undefined) problems.push('payload: pegDifference jen u TrailingStop');
  if (payload.bracket2?.pegDifference !== undefined) problems.push('payload: TP bez pegDifference');
  const tif = (payload.timeInForce ?? 'none') as Tif | 'none';
  if (!definition.tif.includes(tif)) problems.push(`payload: TIF ${tif} nepatří do ${context.scenario}`);
  if (tif === 'GTD') {
    const expireAt = Date.parse(payload.expireTime ?? '');
    if (!Number.isFinite(expireAt) || expireAt < context.now + RECORD_TYPES_GTD_MIN_MS || expireAt > context.now + RECORD_TYPES_GTD_MAX_MS) {
      problems.push(`payload: GTD expireTime musí být za ${RECORD_TYPES_GTD_MIN_MS / 1000}–${RECORD_TYPES_GTD_MAX_MS / 1000} s`);
    }
  } else if (payload.expireTime !== undefined) problems.push('payload: expireTime jen s GTD');
  for (const key of ['timeInForce', 'expireTime'] as const) {
    if ((payload.bracket1 as unknown as Record<string, unknown>)?.[key] !== undefined
      || (payload.bracket2 as unknown as Record<string, unknown>)?.[key] !== undefined) problems.push(`payload: nohy bez ${key} (výchozí TIF nohou je předmět záznamu)`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Klasifikace výsledků

export type TypesOsoResult =
  | { result: 'accepted'; entryId: string; stopId: string; targetId: string }
  | { result: 'partial'; entryId: string; stopId: string | null; targetId: string | null; reason: string }
  | { result: 'rejected'; reason: string }
  | { result: 'ambiguous'; reason: string };

const positiveId = (value: unknown): string | null =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null);

/** Odpověď `POST /order/placeoso` (`undefined` = výjimka / timeout = nejisté). */
export function classifyTypesOsoResponse(response: unknown): TypesOsoResult {
  if (response == null || typeof response !== 'object') return { result: 'ambiguous', reason: 'bez odpovědi (výjimka nebo timeout)' };
  const value = response as { orderId?: unknown; oso1Id?: unknown; oso2Id?: unknown; failureReason?: unknown; failureText?: unknown };
  const entryId = positiveId(value.orderId);
  const stopId = positiveId(value.oso1Id);
  const targetId = positiveId(value.oso2Id);
  const failureText = typeof value.failureText === 'string' ? value.failureText.trim() : '';
  const failureReason = typeof value.failureReason === 'string' && value.failureReason !== 'Success' ? value.failureReason : '';
  const reason = failureText || failureReason;
  if (entryId && stopId && targetId) return { result: 'accepted', entryId, stopId, targetId };
  if (entryId) return { result: 'partial', entryId, stopId, targetId, reason: reason || 'ACK bez id obou nohou' };
  if (reason) return { result: 'rejected', reason };
  return { result: 'ambiguous', reason: 'odpověď bez orderId i bez důvodu' };
}

/**
 * HTTP chyba `placeoso`: 4xx validace (neznámé pole, typ) = jisté odmítnutí bez příkazu;
 * 408/425/429, 5xx a síť = nejisté (příkaz mohl vzniknout) → `null`, úklid čeká a ověří.
 */
export function definitiveHttpRejection(status: number | undefined, body: string): { failureText: string } | null {
  if (status === undefined || status < 400 || status >= 500 || status === 408 || status === 425 || status === 429) return null;
  return { failureText: `HTTP ${status}: ${redactSecrets(body).slice(0, 300) || 'bez těla'}` };
}

/** Úklid: „čisto“ jen po ACK se všemi id nebo jistém odmítnutí; jinak nejisté. */
export function placementFromTypesResult(result: TypesOsoResult, entrySide: Side): RecordPlacement {
  if (result.result === 'accepted') return { kind: 'acknowledged', entryId: result.entryId, legIds: [result.stopId, result.targetId] };
  if (result.result === 'rejected') return { kind: 'not-sent' };
  return { kind: 'uncertain', entrySide };
}

export type TypesObservation = CleanupObservation;
export type TypesOrderOutcome = 'working' | 'pending' | 'filled' | 'canceled' | 'rejected' | 'missing' | 'unknown';

export function typesOrderOutcome(observation: TypesObservation | null | undefined, id: string | null): TypesOrderOutcome {
  if (!observation?.orders) return 'unknown';
  if (!id) return 'missing';
  const order = observation.orders.find(item => item.id === id);
  if (!order) return 'missing';
  return (['working', 'pending', 'filled', 'canceled', 'rejected'] as const).find(status => status === order.status) ?? 'unknown';
}

export interface TypesPlacementVerdict {
  entry: TypesOrderOutcome;
  stopLoss: TypesOrderOutcome;
  takeProfit: TypesOrderOutcome;
  /** Stav SL hned po fillu vstupu (S9, S4). */
  stopLossAtActivation?: TypesOrderOutcome;
  summary: string;
}

/**
 * Krátké shrnutí pro člověka; rozhodují surové rámce v záznamu. `afterFill` = snímek hned
 * po zjištění fillu, `last` = poslední snímek PŘED úklidem.
 */
export function typesPlacementVerdict(
  scenario: TypesScenarioId,
  result: TypesOsoResult,
  snapshots: { afterFill?: TypesObservation | null; last: TypesObservation | null },
): TypesPlacementVerdict {
  const ids = result.result === 'accepted' || result.result === 'partial'
    ? { entry: result.entryId, stop: result.stopId, target: result.targetId }
    : { entry: null, stop: null, target: null };
  const entry = typesOrderOutcome(snapshots.last, ids.entry);
  const stopLoss = typesOrderOutcome(snapshots.last, ids.stop);
  const takeProfit = typesOrderOutcome(snapshots.last, ids.target);
  const verdict = (summary: string, extra: Partial<TypesPlacementVerdict> = {}): TypesPlacementVerdict =>
    ({ entry, stopLoss, takeProfit, ...extra, summary });
  if (result.result === 'rejected') return verdict(`broker OSO odmítl: ${result.reason}`);
  if (result.result === 'ambiguous') return verdict(`výsledek zadání nejistý: ${result.reason}`);
  const activated = snapshots.afterFill ? typesOrderOutcome(snapshots.afterFill, ids.entry) === 'filled' : false;
  const atActivation = snapshots.afterFill ? typesOrderOutcome(snapshots.afterFill, ids.stop) : undefined;
  switch (scenario) {
    case 'leg-through-buy':
    case 'leg-through-sell': {
      if (!activated) return verdict('vstup se nevyplnil — o větvi C14 nerozhoduje', { stopLossAtActivation: atActivation });
      const text: Record<TypesOrderOutcome, string> = {
        rejected: 'SL přes trh při aktivaci ODMÍTNUT (C14 větev B — holá pozice)',
        filled: 'SL přes trh se při aktivaci hned SPUSTIL (C14 větev A)',
        working: 'SL přes trh zůstal Working (neočekávané)',
        pending: 'SL po fillu stále Suspended',
        canceled: 'SL po fillu zrušen',
        missing: 'SL ve stavu chybí', unknown: 'stav SL neznámý',
      };
      return verdict(text[atActivation ?? 'unknown'], { stopLossAtActivation: atActivation });
    }
    case 'stoplimit-through':
      return verdict(entry === 'rejected' ? 'StopLimit se spouští přes trh: ODMÍTNUT'
        : entry === 'working' ? 'přijat a pracuje (spuštěný ležící limit?) — rozhodnou verze v rámcích'
          : entry === 'pending' ? 'přijat jako čekající' : entry === 'filled' ? 'vyplnil se (trh klesl na limit)' : `vstup ${entry}`);
    case 'mit-touch':
      return verdict(entry === 'rejected' ? 'MIT přes trh ODMÍTNUT'
        : entry === 'filled' ? 'MIT přes trh se hned spustil a vyplnil' : entry === 'working' ? 'MIT přes trh čeká (nespustil se)' : `vstup ${entry}`);
    case 'stoplimit-fill':
      return verdict(activated || entry === 'filled' ? 'StopLimit se spustil a vyplnil' : `StopLimit se v čase nevyplnil (vstup ${entry})`);
    case 'trailing-leg':
      return verdict(!activated ? `vstup se nevyplnil (vstup ${entry})`
        : stopLoss === 'working' ? 'TrailingStop noha po fillu Working' : `TrailingStop noha po fillu: ${stopLoss}`,
      { stopLossAtActivation: atActivation });
    case 'tif-gtd-expire':
      return verdict(entry === 'canceled' ? 'GTD rodič vypršel u brokera (canceled/Expired) ještě před úklidem'
        : entry === 'working' ? 'GTD rodič do expireTime + 20 s nevypršel' : `GTD rodič: ${entry}`);
    case 'tif-gtd-fill':
      if (!activated && entry !== 'filled') return verdict(`vstup se nevyplnil (vstup ${entry}) — jako S8`);
      return verdict(stopLoss === 'working' && takeProfit === 'working' ? 'nohy přežily expireTime rodiče'
        : stopLoss === 'canceled' || takeProfit === 'canceled' ? 'noha zanikla po expireTime rodiče — TIF se přenáší, pozice bez ochrany!'
          : `nohy po expireTime: SL ${stopLoss}, TP ${takeProfit}`);
    default:
      return verdict(`vstup ${entry}, SL ${stopLoss}, TP ${takeProfit}`);
  }
}

// ---------------------------------------------------------------------------
// Anonymizace a tajemství

/** Payload do záznamu: bez accountSpec a clOrdId, účet jako zástupné id. */
export function sanitizeTypesPayload(payload: TypesOsoPayload, placeholderAccountId = 1001): Record<string, unknown> {
  const strip = (value: object) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'clOrdId' && key !== 'accountSpec'));
  return {
    ...strip(payload),
    accountId: placeholderAccountId,
    bracket1: strip(payload.bracket1),
    bracket2: strip(payload.bracket2),
  };
}

/** REST řádky (`/order/item`, `/orderVersion/deps`, …): bez soukromých klíčů, účty přemapované. */
export function sanitizeRestRows(rows: unknown, accountMap: ReadonlyMap<number, number>): Array<Record<string, unknown>> {
  return (Array.isArray(rows) ? rows : rows == null ? [] : [rows])
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .map(row => Object.fromEntries(Object.entries(row)
      .filter(([key]) => !RECORD_PRIVATE_KEYS.test(key))
      .map(([key, value]) => [key, key === 'accountId' ? (accountMap.get(Number(value)) ?? 0) : value])));
}

/** Text chyby do konzole a záznamu nikdy nesmí nést token. */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***')
    .replace(/"(accessToken|mdAccessToken|token|refreshToken)"\s*:\s*"[^"]*"/gi, '"$1":"***"')
    .replace(/conn:[0-9a-f-]+/gi, 'conn:x');
}

/** Plán pro dry-run: ukázkové ceny z `--market-price` (skutečné se počítají z ceny workeru těsně před zadáním). */
export function describeTypesPlan(plan: RecordTypesPlan, now: number): string {
  const format = (value: number | undefined) => (value === undefined ? '—' : value.toFixed(2));
  const lines = [
    `Plán REC-TYPES: DEMO ${RECORD_TYPES_ACCOUNT_SPEC} (${plan.accountId}), ${plan.symbol}, qty ${plan.quantity}, ukázková reference ${plan.marketPrice}`
      + ` (trail-peg ${plan.trailPeg}, MIT spoušť v ${plan.mitTrigger}):`,
  ];
  for (const id of plan.scenarios) {
    const definition = TYPES_SCENARIOS[id];
    lines.push(`- ${definition.code} ${id} [${definition.item}]${definition.needsUnsupportedFix ? ' (jen s opravou C1 ve workeru)' : ''}: ${definition.checks}`);
    for (const placement of buildTypesPlacements(id, plan.marketPrice, plan, now)) {
      const { entry, stopLoss, takeProfit } = placement;
      lines.push(`    ${placement.label}: ${entry.side} ${entry.orderType} ${entry.stopPrice !== undefined ? `stop ${format(entry.stopPrice)} / ` : ''}${format(entry.price)}`
        + `${entry.timeInForce ? ` ${entry.timeInForce}` : ''}; SL ${stopLoss.orderType} ${format(stopLoss.stopPrice)}`
        + `${stopLoss.pegDifference !== undefined ? ` peg ${stopLoss.pegDifference}` : ''}; TP ${format(takeProfit.price)}`);
    }
  }
  lines.push(`Riziko: SL nejvýš ${RECORD_TYPES_MAX_SL_TICKS} t od vstupu = ${RECORD_TYPES_MAX_SL_TICKS * TICK * 2 * plan.quantity} USD na scénář (+ skluz liquidate). Po každém scénáři úklid a ověření flat bez příkazů.`);
  return lines.join('\n');
}
