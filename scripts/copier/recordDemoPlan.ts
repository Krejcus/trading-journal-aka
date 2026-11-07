/**
 * Společné čisté jádro DEMO záznamů ze 3. 11. 2026 (návrhy v
 * `docs/reviews/trading-gaps-designs/`): R16/R17 (`safety.md`), C0 výstupy
 * (`exits.md` §0.6) a R1–R7 čekající vstupy (`pending.md` §1.2).
 *
 * Scénář je seznam kroků (malé DSL), který interpret `recordDemoSession.ts`
 * provede proti DEMO účtu. Tady se nic neposílá k brokerovi: pojistky, výpočet
 * cen, odhad expozice, validace zápisů a klasifikace výsledků jsou čisté funkce,
 * aby je šlo otestovat bez sítě. Skripty spouští jen Filip.
 *
 * Pojistky (všechny fail-closed): jen DEMO, jen účet DEMO8661118 (id 61038658),
 * jen MNQ front kontrakt, bez `--confirm` jen výpis plánu, před každým scénářem
 * a každým zadáním kontrola jako `armed-gate.sh` (worker DISARMED), na začátku
 * scénáře flat bez příkazů, na konci úklid a ověřený flat, qty a expozice ≤ 2,
 * scénáře s fillem jen s `--allow-fill`, tokeny ani id účtu nikdy do výstupu.
 */
import { pickCopierMarketPrice } from '../../lib/copierMarketPrice';
import { RECORD_FILL_MAX_SLIP_RATIO, RECORD_MAX_ANCHOR_DIFF_RATIO, RECORD_TICK_SIZE } from './recordLeaderOsoPlan';

export const DEMO_RECORD_ACCOUNT_ID = 61038658;
export const DEMO_RECORD_ACCOUNT_SPEC = 'DEMO8661118';
/** Strop qty jednoho příkazu i možné pozice (vyplní-li se všechny vlastní vstupy). */
export const DEMO_RECORD_MAX_QUANTITY = 2;
/** „Daleko od trhu“ pro čekající vstupy, které se nesmí vyplnit. */
export const DEMO_FAR_RATIO = 0.015;
/** Pasivní vstup (Limit pod trhem / Stop nad trhem u Buy) aspoň tolik od trhu. */
export const DEMO_PASSIVE_MIN_RATIO = 0.0015;
/** SL/TP aspoň tolik bodů od vstupu, který se vyplní hned (exits §0.6). */
export const DEMO_MIN_BRACKET_POINTS = 40;
/** SL/TP pasivního vstupu aspoň tolik bodů od vstupu (jako přikoupení `SCALE_IN_ADD_MIN_SL_POINTS`). */
export const DEMO_PASSIVE_MIN_LEG_POINTS = 10;
/** SL nejvýš tolik od vstupu (podíl ceny) — omezené riziko. */
export const DEMO_MAX_SL_RATIO = 0.01;
/** Pracující SL/TP nesmí bez výslovného příznaku skončit blíž než tolik ticků u trhu. */
export const DEMO_MIN_SAFE_TICKS = 8;
export const DEMO_QUIET_MS = 6_000;
export const DEMO_QUIET_MAX_MS = 30_000;
export const DEMO_FILL_WAIT_MAX_MS = 180_000;

export type DemoSide = 'Buy' | 'Sell';
export type DemoLegName = 'entry' | 'sl' | 'tp';

/**
 * Cena kroku. `points` a `ratio` jsou ve směru lístku: `+` = ve směru zisku
 * (u Buy nahoru, u Sell dolů). `market` = čerstvá cena workeru v okamžiku kroku.
 */
export type DemoPriceRef =
  | { from: 'market'; points?: number; ratio?: number; marketable?: true }
  | { from: 'entry'; points: number }
  | { from: 'ticket'; ticket: string; order: DemoLegName; points?: number }
  | { from: 'current'; points: number };

export interface DemoOsoTicket {
  ticket: string;
  /** `position` = strana plánu, `opposite` = opačná (otočení, C4). */
  side?: 'position' | 'opposite';
  quantity: number;
  entry: { orderType: 'Market' } | { orderType: 'Limit' | 'Stop'; price: DemoPriceRef };
  stopLoss: DemoPriceRef;
  takeProfit: DemoPriceRef;
}

export type DemoOrderRef = { ticket: string; order: DemoLegName } | { plain: string };

export interface DemoModify {
  target: DemoOrderRef;
  price?: DemoPriceRef;
  quantity?: number;
  /** Změna typu nohy TP na Market (C2-T, `--tp-market`). */
  orderType?: 'Market';
  /** Záměrně přes trh (Stop vstup / pozastavený SL). */
  throughMarket?: true;
}

export type DemoClassifierName =
  | 'leg-resize' | 'oco-partner-after-cancel' | 'ticket-intact' | 'tp-fill' | 'relative-leg-move'
  | 'suspended-modify' | 'fill-with-modified-legs' | 'parent-qty' | 'cascade' | 'independent-pairs'
  | 'cancel-one-of-many' | 'liquidate-cancels-all' | 'through-market-entry';

export interface DemoClassify {
  name: DemoClassifierName;
  ticket?: string;
  tickets?: string[];
  order?: DemoLegName;
  quantity?: number;
  plain?: string;
}

interface DemoAfter {
  /** Pozorování po akci: posuny od jejího konce v ms. */
  observeMs?: number[];
  classify?: DemoClassify;
}

export type DemoStep =
  | ({ kind: 'place-oso'; label: string; tickets: DemoOsoTicket[]; reverseAfter?: string } & DemoAfter)
  | ({
      kind: 'place-order'; label: string; ref: string; side: 'position' | 'opposite';
      orderType: 'Market' | 'Limit'; price?: DemoPriceRef; quantity: number;
      /** Redukce pozice: qty ≤ |net|, nikdy přes nulu. */
      reducing?: true;
      /** Vědomě holý vstup bez nohou (návrh SL/TP po jedné): Market, marketable Limit, nebo Limit daleko. */
      bare?: true;
      /** Pošle se jen, když obě nohy lístku mají pozorovaně tuto qty (C2: Market až po potvrzení nohou). */
      onlyIfLegsQuantity?: { ticket: string; quantity: number };
    } & DemoAfter)
  /** Samostatná výstupní noha k vyplněné pozici: bez OCO, opačná strana, vždy aspoň `DEMO_MIN_BRACKET_POINTS` od trhu. */
  | ({ kind: 'place-exit'; label: string; ref: string; leg: 'stop' | 'limit'; points: number; quantity: number } & DemoAfter)
  /** Nohy SL + TP spojené OCO k vyplněné pozici (jako `attach-brackets`). Lístek má jen `sl` a `tp`. */
  | ({
      kind: 'place-oco'; label: string; ticket: string; slPoints: number; tpPoints: number; quantity: number;
      /** Vědomě vedle pracující nohy (měření pořadí „OCO, pak zrušit“): krátce dvojí SL. */
      overlapExit?: true;
    } & DemoAfter)
  | ({ kind: 'modify'; label: string; changes: DemoModify[] } & DemoAfter)
  | ({ kind: 'cancel'; label: string; targets: DemoOrderRef[]; onlyIfOpen?: true; abortIfFailed?: true } & DemoAfter)
  | ({ kind: 'liquidate'; label: string; ref: string } & DemoAfter)
  | { kind: 'wait-net'; label: string; net: number; timeoutMs: number; optional?: true }
  | { kind: 'wait-fill'; label: string; ticket: string; timeoutMs: number }
  | ({ kind: 'observe'; label: string } & DemoAfter)
  | { kind: 'wait-quiet'; label: string; liquidate: string; quietMs: number; maxMs: number }
  | { kind: 'require-flat'; label: string }
  | { kind: 'sleep'; label: string; ms: number };

export interface DemoScenario {
  name: string;
  /** Co scénář ověří a pro kterou položku návrhu. */
  purpose: string;
  steps: DemoStep[];
}

export interface DemoRecordPlan {
  accountId: number;
  symbol: string;
  side: DemoSide;
  marketPrice: number;
  confirm: boolean;
  allowFill: boolean;
  scenarios: DemoScenario[];
}

// ─── argumenty ──────────────────────────────────────────────────────────────

/** Hodnota přepínače; zadaný dvakrát = chyba (nejasné, který platí). */
export function cliValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv.indexOf(`--${name}`, index + 1) >= 0) throw new Error(`--${name} je zadané dvakrát`);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function cliNumber(argv: readonly string[], name: string, fallback?: number): number {
  const raw = cliValue(argv, name);
  if (raw === undefined && fallback !== undefined) return fallback;
  const parsed = Number(raw);
  if (raw === undefined || raw.startsWith('--') || !Number.isFinite(parsed)) throw new Error(`Chybí nebo je neplatné --${name}`);
  return parsed;
}

/** Společné argumenty; účet a front kontrakt hlídá `demoPlanProblems` (vypíše všechny důvody najednou). */
export function parseDemoBaseArgs(argv: readonly string[]): Omit<DemoRecordPlan, 'scenarios'> {
  const side = cliValue(argv, 'side') ?? 'Buy';
  if (side !== 'Buy' && side !== 'Sell') throw new Error('--side musí být Buy nebo Sell');
  const symbol = (cliValue(argv, 'symbol') ?? '').trim().toUpperCase();
  if (!/^MNQ[HMUZ]\d$/.test(symbol)) throw new Error('--symbol musí být čtvrtletní kontrakt MNQ, např. MNQZ6');
  const accountId = cliNumber(argv, 'account');
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('--account musí být id účtu');
  const marketPrice = cliNumber(argv, 'market-price');
  if (!(marketPrice > 0)) throw new Error('--market-price musí být kladná cena');
  return { accountId, symbol, side, marketPrice, confirm: argv.includes('--confirm'), allowFill: argv.includes('--allow-fill') };
}

/** `--scenario a,b` nebo `all`; neznámé jméno = chyba, přesunuté jméno = chyba s odkazem. */
export function parseScenarioList(
  argv: readonly string[],
  known: readonly string[],
  elsewhere: Readonly<Record<string, string>> = {},
  aliases: Readonly<Record<string, string>> = {},
): string[] {
  const raw = (cliValue(argv, 'scenario') ?? '').trim();
  if (!raw || raw.startsWith('--')) throw new Error(`Chybí --scenario (${known.join(', ')} nebo all)`);
  const names = raw === 'all' ? [...known] : raw.split(',').map(item => item.trim()).filter(Boolean)
    .map(item => aliases[item.toLowerCase()] ?? item);
  for (const name of names) {
    if (elsewhere[name]) throw new Error(`Scénář ${name}: ${elsewhere[name]}`);
    if (!known.includes(name)) throw new Error(`Neznámý scénář ${name} (${known.join(', ')})`);
  }
  if (new Set(names).size !== names.length) throw new Error('--scenario obsahuje stejný scénář dvakrát');
  return names;
}

// ─── front kontrakt ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const QUARTER_MONTHS: ReadonlyArray<[number, string]> = [[2, 'H'], [5, 'M'], [8, 'U'], [11, 'Z']];

/** Třetí pátek měsíce (UTC půlnoc) = expirace čtvrtletního MNQ. */
export function thirdFridayUtc(year: number, monthIndex: number): number {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offset = (5 - first.getUTCDay() + 7) % 7;
  return Date.UTC(year, monthIndex, 1 + offset + 14);
}

/**
 * Front kontrakt MNQ podle kalendáře. V týdnu rolování (9 dní před expirací až
 * den po ní) vrací `null` — obchodovaný kontrakt není jednoznačný, záznam neběží.
 * Runner navíc vyžaduje shodu s `frontContract` brokera (jen čtení).
 */
export function mnqFrontContract(now: number): string | null {
  const year = new Date(now).getUTCFullYear();
  for (const candidateYear of [year, year + 1]) {
    for (const [month, code] of QUARTER_MONTHS) {
      const expiry = thirdFridayUtc(candidateYear, month);
      if (now < expiry - 9 * DAY_MS) return `MNQ${code}${candidateYear % 10}`;
      if (now < expiry + DAY_MS) return null;
    }
  }
  return null;
}

// ─── pojistky stavu workeru ─────────────────────────────────────────────────

type StatusRoot = {
  environment?: unknown;
  controller?: Record<string, unknown>;
  marketPrices?: unknown[];
  group?: { leaderAccountId?: unknown; manualOnly?: unknown; localOnly?: unknown; followers?: unknown[] } | null;
};

/** Přesně `armed-gate.sh`: projde jen `controller.armed === false`. */
export function armedGateProblems(status: unknown): string[] {
  const armed = ((status ?? {}) as StatusRoot).controller?.armed;
  return armed === false ? [] : [`ARMED GATE: kopírka NENÍ prokazatelně vypnutá (armed=${JSON.stringify(armed ?? null)}) — STOP`];
}

/**
 * Kontrola před každým scénářem a každým zadáním. Jen věci, které vlastní
 * záznam nezmění (po prvním fillu worker chce kontrolu pozic — to tady neblokuje).
 */
export function demoGateProblems(plan: Pick<DemoRecordPlan, 'accountId'>, status: unknown): string[] {
  const root = (status ?? {}) as StatusRoot;
  const controller = root.controller ?? {};
  const problems = armedGateProblems(status);
  if (controller.killSwitch === true) problems.push('kill switch je aktivní');
  const resume = controller.transportResume as { phase?: unknown } | null | undefined;
  if (resume && (resume.phase === 'waiting' || resume.phase === 'ready')) problems.push('běží automatické pokračování po výpadku');
  if (controller.manualRecovery != null
    || (controller.armPreparation as { manualRecoveryRequired?: unknown } | undefined)?.manualRecoveryRequired === true) {
    problems.push('worker čeká na ruční obnovu (incident)');
  }
  if (controller.lastError != null) problems.push('worker má lastError');
  if (root.environment !== 'demo') problems.push('worker neběží na DEMO prostředí');
  if (root.group?.manualOnly !== true || root.group?.localOnly !== true) problems.push('skupina workeru není manual-only + local-only');
  if (!Array.isArray(root.group?.followers) || root.group.followers.length !== 0) problems.push('skupina workeru má followery');
  if (root.group?.leaderAccountId !== plan.accountId) problems.push('účet není leader skupiny workeru');
  return problems;
}

/** Plná kontrola před prvním zadáním běhu (stejná přísnost jako `recordLeaderOsoProblems`). */
export function demoStartProblems(plan: Pick<DemoRecordPlan, 'accountId' | 'symbol' | 'marketPrice'>, status: unknown, now: number): string[] {
  const root = (status ?? {}) as StatusRoot;
  const controller = root.controller ?? {};
  const problems = demoGateProblems(plan, status);
  if (controller.connected !== true) problems.push('worker není připojený');
  if (controller.groupFlat !== true) problems.push('skupina není flat');
  if (controller.reconciliationRequired !== false) problems.push('worker čeká na kontrolu pozic (po minulém záznamu: npm run copier:mac -- reconcile)');
  if (Array.isArray(controller.divergentAccounts) && controller.divergentAccounts.length) problems.push('skupina má divergenci');
  if (Array.isArray(controller.workingOrderAccounts) && controller.workingOrderAccounts.length) problems.push('ve skupině jsou working orders');
  // Nevyřešený ruční vstup: holý Limit ze záznamu by worker vzal za svůj možný a vypnul by kopírku.
  const unresolved = (items: unknown) => Array.isArray(items) && items.some(item => ['sending', 'unknown'].includes((item as { status?: unknown })?.status as string));
  if (unresolved(controller.manualEntries) || unresolved(controller.unresolvedManualOrderActions)) problems.push('worker má nevyřešený ruční vstup nebo změnu obchodu');
  const anchor = demoAnchor(status, plan.symbol, now);
  if (anchor == null) problems.push('worker nemá čerstvou cenu MNQ (IBKR / TradingView)');
  else if (Math.abs(anchor - plan.marketPrice) > anchor * RECORD_MAX_ANCHOR_DIFF_RATIO) {
    problems.push(`--market-price ${plan.marketPrice} nesedí s cenou workeru ${anchor}`);
  }
  return problems;
}

export function demoAnchor(status: unknown, symbol: string, now: number): number | null {
  const prices = ((status ?? {}) as StatusRoot).marketPrices;
  return pickCopierMarketPrice(Array.isArray(prices) ? prices : [], symbol, now);
}

/** Statické pojistky plánu (bez sítě): účet, front kontrakt, qty/expozice, souhlas s fillem. */
export function demoPlanProblems(plan: DemoRecordPlan, now: number): string[] {
  const problems: string[] = [];
  if (plan.accountId !== DEMO_RECORD_ACCOUNT_ID) problems.push(`jen DEMO účet ${DEMO_RECORD_ACCOUNT_SPEC} (id ${DEMO_RECORD_ACCOUNT_ID})`);
  const front = mnqFrontContract(now);
  if (front == null) problems.push('týden rolování MNQ — front kontrakt není jednoznačný, nahrávat mimo něj');
  else if (plan.symbol !== front) problems.push(`jen front kontrakt ${front} (zadáno ${plan.symbol})`);
  if (!(plan.marketPrice > 0)) problems.push('--market-price musí být kladná');
  if (!plan.scenarios.length) problems.push('žádný scénář');
  for (const scenario of plan.scenarios) {
    for (const problem of scenarioStructureProblems(scenario)) problems.push(`${scenario.name}: ${problem}`);
    const exposure = scenarioMaxExposure(scenario.steps);
    if (exposure > DEMO_RECORD_MAX_QUANTITY) problems.push(`${scenario.name}: možná pozice ${exposure} > ${DEMO_RECORD_MAX_QUANTITY}`);
    if (plan.confirm && scenarioFills(scenario.steps) && !plan.allowFill) {
      problems.push(`${scenario.name}: scénář vyplní příkaz (DEMO fill, poplatky, denní statistiky) — přidej --allow-fill`);
    }
  }
  return problems;
}

/** Vnitřní konzistence: qty 1–2, odkazy na existující lístky, žádný holý Market vstup mimo OSO. */
export function scenarioStructureProblems(scenario: DemoScenario): string[] {
  const problems: string[] = [];
  const tickets = new Set<string>();
  const plain = new Set<string>();
  const liquidations = new Set<string>();
  const quantityOk = (value: number) => Number.isInteger(value) && value >= 1 && value <= DEMO_RECORD_MAX_QUANTITY;
  const refOk = (ref: DemoOrderRef) => ('plain' in ref ? plain.has(ref.plain) : tickets.has(ref.ticket));
  for (const step of scenario.steps) {
    if (step.kind === 'place-oso') {
      for (const ticket of step.tickets) {
        if (tickets.has(ticket.ticket)) problems.push(`lístek ${ticket.ticket} zadán dvakrát`);
        if (!quantityOk(ticket.quantity)) problems.push(`lístek ${ticket.ticket}: qty ${ticket.quantity} mimo 1–${DEMO_RECORD_MAX_QUANTITY}`);
        for (const ref of [ticket.stopLoss, ticket.takeProfit, ...('price' in ticket.entry ? [ticket.entry.price] : [])]) {
          if (ref.from === 'ticket' && !tickets.has(ref.ticket)) problems.push(`lístek ${ticket.ticket}: odkaz na neznámý lístek ${ref.ticket}`);
          if (ref.from === 'current') problems.push(`lístek ${ticket.ticket}: „current“ jen u modify`);
        }
      }
      for (const ticket of step.tickets) tickets.add(ticket.ticket);
      if (step.reverseAfter && !liquidations.has(step.reverseAfter)) problems.push(`${step.label}: neznámé liquidate ${step.reverseAfter}`);
    } else if (step.kind === 'place-order') {
      if (!quantityOk(step.quantity)) problems.push(`${step.label}: qty ${step.quantity} mimo 1–${DEMO_RECORD_MAX_QUANTITY}`);
      if (step.orderType === 'Market' && !step.reducing && !step.bare) problems.push(`${step.label}: holý Market jen jako redukce`);
      if (step.orderType === 'Limit' && !step.price) problems.push(`${step.label}: Limit bez ceny`);
      plain.add(step.ref);
    } else if (step.kind === 'place-exit') {
      if (!quantityOk(step.quantity)) problems.push(`${step.label}: qty ${step.quantity} mimo 1–${DEMO_RECORD_MAX_QUANTITY}`);
      if (!(step.points >= DEMO_MIN_BRACKET_POINTS)) problems.push(`${step.label}: noha blíž než ${DEMO_MIN_BRACKET_POINTS} b`);
      plain.add(step.ref);
    } else if (step.kind === 'place-oco') {
      if (tickets.has(step.ticket)) problems.push(`lístek ${step.ticket} zadán dvakrát`);
      if (!quantityOk(step.quantity)) problems.push(`${step.label}: qty ${step.quantity} mimo 1–${DEMO_RECORD_MAX_QUANTITY}`);
      if (!(step.slPoints >= DEMO_MIN_BRACKET_POINTS) || !(step.tpPoints >= DEMO_MIN_BRACKET_POINTS)) problems.push(`${step.label}: noha blíž než ${DEMO_MIN_BRACKET_POINTS} b`);
      tickets.add(step.ticket);
    } else if (step.kind === 'modify') {
      for (const change of step.changes) {
        if (!refOk(change.target)) problems.push(`${step.label}: neznámý cíl`);
        if (change.quantity !== undefined && !quantityOk(change.quantity)) problems.push(`${step.label}: qty ${change.quantity} mimo 1–${DEMO_RECORD_MAX_QUANTITY}`);
        if (change.orderType === 'Market' && !('ticket' in change.target && change.target.order === 'tp')) problems.push(`${step.label}: Market jen u TP`);
      }
    } else if (step.kind === 'cancel') {
      for (const target of step.targets) if (!refOk(target)) problems.push(`${step.label}: neznámý cíl`);
    } else if (step.kind === 'liquidate') {
      liquidations.add(step.ref);
    } else if (step.kind === 'wait-quiet' && !liquidations.has(step.liquidate)) {
      problems.push(`${step.label}: neznámé liquidate ${step.liquidate}`);
    } else if (step.kind === 'wait-fill' && !tickets.has(step.ticket)) {
      problems.push(`${step.label}: neznámý lístek ${step.ticket}`);
    }
  }
  if (!scenario.steps.length) problems.push('prázdný scénář');
  return problems;
}

const isMarketableRef = (ref: DemoPriceRef | undefined) => ref?.from === 'market' && ref.marketable === true;

/**
 * Horní odhad |pozice| během scénáře: vyplní-li se každý vlastní vstup, který
 * ještě nebyl zrušen. Redukce se nepočítají (konzervativně). Liquidate zruší
 * všechny příkazy kontraktu (nahráno 3. 11., K4) a pozici zavře. Interpret
 * navíc před každým zadáním kontroluje skutečnou expozici u brokera.
 */
export function scenarioMaxExposure(steps: readonly DemoStep[]): number {
  let filled = 0;
  const pending = new Map<string, number>();
  let max = 0;
  const update = () => { max = Math.max(max, filled + [...pending.values()].reduce((sum, value) => sum + value, 0)); };
  for (const step of steps) {
    if (step.kind === 'place-oso') {
      for (const ticket of step.tickets) {
        if (ticket.entry.orderType === 'Market') filled += ticket.quantity;
        else pending.set(`t:${ticket.ticket}`, ticket.quantity);
      }
    } else if (step.kind === 'place-order' && !step.reducing) {
      if (step.orderType === 'Market') filled += step.quantity;
      else pending.set(`p:${step.ref}`, step.quantity);
    } else if (step.kind === 'modify') {
      for (const change of step.changes) {
        if (change.quantity === undefined) continue;
        const key = 'plain' in change.target ? `p:${change.target.plain}` : change.target.order === 'entry' ? `t:${change.target.ticket}` : null;
        if (key && pending.has(key)) pending.set(key, change.quantity);
      }
    } else if (step.kind === 'cancel') {
      for (const target of step.targets) {
        if ('plain' in target) pending.delete(`p:${target.plain}`);
        else if (target.order === 'entry') pending.delete(`t:${target.ticket}`);
      }
    } else if (step.kind === 'liquidate') {
      filled = 0;
      pending.clear();
    }
    update();
  }
  return max;
}

/** Vyplní scénář nějaký příkaz? (Market, marketable cena, Stop vstup přes trh, TP → Market.) */
export function scenarioFills(steps: readonly DemoStep[]): boolean {
  return steps.some(step => {
    if (step.kind === 'place-oso') {
      return step.tickets.some(ticket => ticket.entry.orderType === 'Market'
        || ('price' in ticket.entry && isMarketableRef(ticket.entry.price)));
    }
    if (step.kind === 'place-order') return step.orderType === 'Market' || isMarketableRef(step.price);
    if (step.kind === 'modify') {
      return step.changes.some(change => change.orderType === 'Market' || isMarketableRef(change.price)
        || (change.throughMarket === true && 'ticket' in change.target && change.target.order === 'entry'));
    }
    return false;
  });
}

// ─── ceny ───────────────────────────────────────────────────────────────────

const ticks = (value: number) => Math.round((value / RECORD_TICK_SIZE) * 1e6) / 1e6;
export const onDemoTick = (price: number) => Math.abs(ticks(price) - Math.round(ticks(price))) < 1e-9;
export const roundDemoTick = (price: number) => Math.round(ticks(price)) * RECORD_TICK_SIZE;

export interface DemoPriceContext {
  anchor: number | null;
  dir: 1 | -1;
  /** Cena vstupu lístku (u Market = kotva). */
  entryPrice?: number | null;
  /** Aktuální (poslední odeslaná / pozorovaná) cena měněného příkazu. */
  current?: number | null;
  ticketPrice?: (ticket: string, order: DemoLegName) => number | null;
}

/**
 * Absolutní cena na tick. Ceny od trhu se zaokrouhlí směrem od kotvy (vzdálený
 * vstup zůstane aspoň tak daleko, marketable cena aspoň tak agresivní).
 */
export function resolveDemoPrice(ref: DemoPriceRef, context: DemoPriceContext): number {
  if (ref.from === 'market') {
    if (context.anchor == null || !(context.anchor > 0)) throw new Error('chybí čerstvá cena workeru');
    const raw = context.anchor + context.dir * ((ref.points ?? 0) + (ref.ratio ?? 0) * context.anchor);
    const scaled = ticks(raw);
    const rounded = raw > context.anchor ? Math.ceil(scaled) : raw < context.anchor ? Math.floor(scaled) : Math.round(scaled);
    return rounded * RECORD_TICK_SIZE;
  }
  const base = ref.from === 'entry' ? context.entryPrice
    : ref.from === 'current' ? context.current
      : context.ticketPrice?.(ref.ticket, ref.order) ?? null;
  if (base == null || !(base > 0)) throw new Error(`chybí výchozí cena (${ref.from})`);
  return roundDemoTick(base + context.dir * (ref.points ?? 0));
}

export interface ResolvedOso {
  side: DemoSide;
  quantity: number;
  entryType: 'Market' | 'Limit' | 'Stop';
  entry: number | null;
  stopLoss: number;
  takeProfit: number;
  marketable: boolean;
}

/** Pojistky jednoho OSO před zadáním (ceny už absolutní, kotva čerstvá). */
export function osoPlacementProblems(oso: ResolvedOso, anchor: number): string[] {
  const problems: string[] = [];
  const dir = oso.side === 'Buy' ? 1 : -1;
  if (!Number.isInteger(oso.quantity) || oso.quantity < 1 || oso.quantity > DEMO_RECORD_MAX_QUANTITY) problems.push(`qty ${oso.quantity} mimo 1–${DEMO_RECORD_MAX_QUANTITY}`);
  for (const [name, price] of [['vstup', oso.entry], ['SL', oso.stopLoss], ['TP', oso.takeProfit]] as const) {
    if (price != null && (!(price > 0) || !onDemoTick(price))) problems.push(`${name} ${price} není kladná cena na tick`);
  }
  const reference = oso.entry ?? anchor;
  // Vstup, který se vyplní hned (Market, marketable Limit): nohy ≥ 40 b. Pasivní vstup: ≥ 10 b (jako přikoupení).
  const minLeg = oso.entryType === 'Market' || oso.marketable ? DEMO_MIN_BRACKET_POINTS : DEMO_PASSIVE_MIN_LEG_POINTS;
  if (!(dir * (reference - oso.stopLoss) >= minLeg)) problems.push(`SL musí být aspoň ${minLeg} b na ochranné straně vstupu`);
  if (!(dir * (oso.takeProfit - reference) >= minLeg)) problems.push(`TP musí být aspoň ${minLeg} b na ziskové straně vstupu`);
  if (Math.abs(reference - oso.stopLoss) > anchor * DEMO_MAX_SL_RATIO) problems.push(`SL dál než ${(anchor * DEMO_MAX_SL_RATIO).toFixed(0)} b od vstupu`);
  if (oso.entryType === 'Market') {
    if (!(dir * (oso.takeProfit - anchor) >= minLeg)) problems.push(`TP Marketu musí být aspoň ${minLeg} b od trhu`);
    if (!(dir * (anchor - oso.stopLoss) >= minLeg)) problems.push(`SL Marketu musí být aspoň ${minLeg} b od trhu`);
    return problems;
  }
  const entry = oso.entry as number;
  if (oso.marketable) {
    if (oso.entryType !== 'Limit') problems.push('marketable vstup jen jako Limit');
    // Buy: nejvýš 0,2 % nad trhem (neplatit libovolně), nejvýš 0,15 % pod ním (jinak to není „na trhu“).
    const aggressive = dir * (entry - anchor);
    if (!(aggressive <= anchor * RECORD_FILL_MAX_SLIP_RATIO + 1e-9 && aggressive >= -anchor * DEMO_PASSIVE_MIN_RATIO - 1e-9)) {
      problems.push('marketable vstup daleko od trhu');
    }
    return problems;
  }
  // Pasivní vstup: Buy Limit pod trhem / Buy Stop nad trhem (Sell zrcadlově), aspoň 0,15 % daleko.
  const passiveSign = oso.entryType === 'Limit' ? -dir : dir;
  if (!(passiveSign * (entry - anchor) >= anchor * DEMO_PASSIVE_MIN_RATIO - 1e-9)) {
    problems.push(`${oso.entryType} vstup musí být aspoň ${(anchor * DEMO_PASSIVE_MIN_RATIO).toFixed(0)} b na pasivní straně trhu`);
  }
  return problems;
}

/** Holý příkaz: jen redukce Marketem (qty ≤ |net|), nebo pasivní Limit daleko od trhu. */
export function plainOrderProblems(input: {
  side: DemoSide; orderType: 'Market' | 'Limit'; price: number | null; quantity: number; reducing: boolean; anchor: number | null;
  /** Vědomě holý vstup (krok `bare`): Market smí, Limit smí i marketable. */
  bare?: boolean; marketable?: boolean;
}): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > DEMO_RECORD_MAX_QUANTITY) problems.push(`qty ${input.quantity} mimo 1–${DEMO_RECORD_MAX_QUANTITY}`);
  if (input.orderType === 'Market') {
    if (!input.reducing && !input.bare) problems.push('holý Market jen jako redukce');
    return problems;
  }
  if (input.bare && input.marketable) {
    if (input.price == null || !(input.price > 0) || !onDemoTick(input.price)) problems.push('Limit bez platné ceny na tick');
    return problems;
  }
  if (input.price == null || !(input.price > 0) || !onDemoTick(input.price)) problems.push('Limit bez platné ceny na tick');
  else if (input.anchor == null) problems.push('chybí čerstvá cena workeru');
  else {
    const passive = input.side === 'Buy' ? input.anchor - input.price : input.price - input.anchor;
    if (!(passive >= input.anchor * DEMO_FAR_RATIO - RECORD_TICK_SIZE)) problems.push(`holý Limit musí být aspoň ${(input.anchor * DEMO_FAR_RATIO).toFixed(0)} b na pasivní straně trhu`);
  }
  return problems;
}

/**
 * Pojistka samostatné výstupní nohy: jen na ochranné nebo ziskové straně trhu, aspoň
 * `DEMO_MIN_BRACKET_POINTS` od čerstvé ceny, aby se při záznamu sama nespustila.
 */
export function exitOrderProblems(input: { side: DemoSide; leg: 'stop' | 'limit'; price: number | null; quantity: number; anchor: number | null }): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > DEMO_RECORD_MAX_QUANTITY) problems.push(`qty ${input.quantity} mimo 1–${DEMO_RECORD_MAX_QUANTITY}`);
  if (input.anchor == null) return [...problems, 'chybí čerstvá cena workeru'];
  if (input.price == null || !(input.price > 0) || !onDemoTick(input.price)) return [...problems, 'noha bez platné ceny na tick'];
  const dir = input.side === 'Buy' ? 1 : -1;
  const gain = (input.price - input.anchor) * dir;
  if (input.leg === 'stop' ? gain > -DEMO_MIN_BRACKET_POINTS : gain < DEMO_MIN_BRACKET_POINTS) problems.push(`noha musí být aspoň ${DEMO_MIN_BRACKET_POINTS} b od trhu na správné straně`);
  return problems;
}

export interface DemoModifyCheck {
  order: DemoLegName;
  /** Strana lístku (pozice), ne strana nohy. */
  side: DemoSide;
  entryType: 'Market' | 'Limit' | 'Stop';
  /** Pozorovaný stav příkazu; `null` = nečetl se (rychlá cesta R4). */
  status: string | null;
  /** Bez pozorování: noha lístku s Limit/Stop vstupem se bere jako Suspended (kontrola vůči vstupu). */
  assumeSuspended?: boolean;
  /** Aktuální cena vstupu lístku (u nohou). */
  entryPrice?: number | null;
  newPrice: number | null;
  newQuantity: number;
  toMarket: boolean;
  anchor: number | null;
  throughMarket: boolean;
  marketable: boolean;
}

/** Pojistky jednoho modify. Přes trh / marketable jen s výslovným příznakem kroku. */
export function modifyProblems(check: DemoModifyCheck): string[] {
  const problems: string[] = [];
  const dir = check.side === 'Buy' ? 1 : -1;
  if (!Number.isInteger(check.newQuantity) || check.newQuantity < 1 || check.newQuantity > DEMO_RECORD_MAX_QUANTITY) problems.push(`qty ${check.newQuantity} mimo 1–${DEMO_RECORD_MAX_QUANTITY}`);
  if (check.status != null && check.status !== 'working' && check.status !== 'pending') problems.push(`příkaz už neběží (${check.status})`);
  if (check.toMarket) {
    if (check.order !== 'tp') problems.push('změna na Market jen u TP');
    return problems;
  }
  if (check.newPrice == null || !(check.newPrice > 0) || !onDemoTick(check.newPrice)) { problems.push('nová cena není na tick'); return problems; }
  if (check.anchor == null) { problems.push('chybí čerstvá cena workeru'); return problems; }
  const safe = DEMO_MIN_SAFE_TICKS * RECORD_TICK_SIZE;
  // Pozastavená noha se spustí až po fillu vstupu: rozhoduje strana vůči vstupu, ne vůči trhu.
  const suspended = check.status === 'pending' || (check.status == null && check.assumeSuspended === true);
  const entry = check.entryPrice ?? null;
  if (check.order === 'sl') {
    // Buy: SL (Sell Stop) pod trhem a pod vstupem; přes ně jen pozastavená noha s příznakem.
    const crossesMarket = !(dir * (check.anchor - check.newPrice) >= safe);
    const crossesEntry = suspended && entry != null && !(dir * (entry - check.newPrice) >= safe);
    if (crossesMarket || crossesEntry) {
      if (!check.throughMarket) problems.push('SL u trhu/vstupu nebo přes ně bez příznaku throughMarket');
      else if (check.status !== 'pending') problems.push('SL přes trh jen u pozorovaně pozastavené (Suspended) nohy');
    }
  } else if (check.order === 'tp') {
    const reference = suspended && entry != null ? entry : check.anchor;
    if (!(dir * (check.newPrice - reference) >= safe) && !check.marketable) problems.push('TP u trhu/vstupu bez příznaku marketable');
    if (check.marketable && !(dir * (check.anchor - check.newPrice) <= check.anchor * RECORD_FILL_MAX_SLIP_RATIO)) problems.push('marketable TP daleko za trhem');
  } else {
    const passiveSign = check.entryType === 'Limit' ? -dir : dir;
    const passiveDistance = passiveSign * (check.newPrice - check.anchor);
    if (check.entryType === 'Limit' && passiveDistance < check.anchor * DEMO_PASSIVE_MIN_RATIO - 1e-9 && !check.marketable) {
      problems.push('Limit vstup u trhu bez příznaku marketable');
    }
    if (check.entryType === 'Limit' && check.marketable && !(-passiveDistance <= check.anchor * RECORD_FILL_MAX_SLIP_RATIO + 1e-9)) {
      problems.push('marketable Limit vstup daleko za trhem');
    }
    if (check.entryType === 'Stop' && passiveDistance < check.anchor * DEMO_PASSIVE_MIN_RATIO - 1e-9 && !check.throughMarket) {
      problems.push('Stop vstup u trhu nebo přes trh bez příznaku throughMarket');
    }
    if (check.entryType === 'Market') problems.push('Market vstup se nemění');
  }
  return problems;
}

/**
 * Skutečná expozice u brokera před zadáním (fail-closed): |net| + zbytek
 * otevřených vlastních vstupů + nový ≤ 2. Redukce smí jen do nuly.
 */
export function exposureProblem(input: {
  netPosition: number | null;
  openEntries: ReadonlyArray<{ quantity: number; filledQuantity: number }> | null;
  addQuantity: number;
  reducing: boolean;
}): string | null {
  if (input.netPosition == null || input.openEntries == null) return 'stav účtu nejde přečíst — nic se neposílá';
  const net = Math.abs(input.netPosition);
  if (input.reducing) return input.addQuantity <= net ? null : `redukce ${input.addQuantity} > pozice ${net}`;
  const open = input.openEntries.reduce((sum, order) => sum + Math.max(0, order.quantity - order.filledQuantity), 0);
  const total = net + open + input.addQuantity;
  return total <= DEMO_RECORD_MAX_QUANTITY ? null : `možná pozice ${total} > ${DEMO_RECORD_MAX_QUANTITY} (pozice ${net}, čekající ${open}, nový ${input.addQuantity})`;
}

/**
 * Suchý průchod scénářem při dané ceně: každé zadání a každý modify projde
 * stejnými pojistkami jako v interpretu (nominální průběh: Market a marketable
 * vstup se vyplní, pasivní vstup ne, liquidate zruší vše). Prázdné = scénář je
 * při této ceně proveditelný. Interpret ho volá před `--confirm` i během něj.
 */
export function dryRunScenario(scenario: DemoScenario, side: DemoSide, anchor: number): string[] {
  const problems: string[] = [];
  type SimTicket = {
    side: DemoSide; dir: 1 | -1; entryType: 'Market' | 'Limit' | 'Stop'; prices: DemoTicketPrices;
    entryStatus: string; legStatus: string; quantities: Record<DemoLegName, number>;
  };
  const tickets = new Map<string, SimTicket>();
  const sideOf = (which: 'position' | 'opposite' | undefined): DemoSide => (which === 'opposite' ? (side === 'Buy' ? 'Sell' : 'Buy') : side);
  const ticketPrice = (name: string, order: DemoLegName) => tickets.get(name)?.prices[order] ?? null;
  for (const step of scenario.steps) {
    try {
      if (step.kind === 'place-oso') {
        for (const ticket of step.tickets) {
          const ticketSide = sideOf(ticket.side);
          const dir: 1 | -1 = ticketSide === 'Buy' ? 1 : -1;
          const entry = 'price' in ticket.entry ? resolveDemoPrice(ticket.entry.price, { anchor, dir, ticketPrice }) : null;
          const context = { anchor, dir, entryPrice: entry ?? anchor, ticketPrice };
          const oso: ResolvedOso = {
            side: ticketSide, quantity: ticket.quantity, entryType: ticket.entry.orderType, entry,
            stopLoss: resolveDemoPrice(ticket.stopLoss, context), takeProfit: resolveDemoPrice(ticket.takeProfit, context),
            marketable: isMarketableRef('price' in ticket.entry ? ticket.entry.price : undefined),
          };
          for (const problem of osoPlacementProblems(oso, anchor)) problems.push(`${step.label} / ${ticket.ticket}: ${problem}`);
          const immediate = oso.entryType === 'Market' || oso.marketable;
          tickets.set(ticket.ticket, {
            side: ticketSide, dir, entryType: oso.entryType, prices: { entry: entry ?? anchor, sl: oso.stopLoss, tp: oso.takeProfit },
            entryStatus: immediate ? 'filled' : 'working', legStatus: immediate ? 'working' : 'pending',
            quantities: { entry: ticket.quantity, sl: ticket.quantity, tp: ticket.quantity },
          });
        }
      } else if (step.kind === 'place-order') {
        const orderSide = sideOf(step.side);
        const price = step.price ? resolveDemoPrice(step.price, { anchor, dir: orderSide === 'Buy' ? 1 : -1, ticketPrice }) : null;
        for (const problem of plainOrderProblems({ side: orderSide, orderType: step.orderType, price, quantity: step.quantity, reducing: step.reducing === true, anchor, bare: step.bare === true, marketable: isMarketableRef(step.price) })) {
          problems.push(`${step.label}: ${problem}`);
        }
      } else if (step.kind === 'place-exit') {
        const dir = side === 'Buy' ? 1 : -1;
        const price = roundDemoTick(anchor + dir * (step.leg === 'stop' ? -step.points : step.points));
        for (const problem of exitOrderProblems({ side, leg: step.leg, price, quantity: step.quantity, anchor })) problems.push(`${step.label}: ${problem}`);
      } else if (step.kind === 'place-oco') {
        const dir: 1 | -1 = side === 'Buy' ? 1 : -1;
        const prices = { sl: roundDemoTick(anchor - dir * step.slPoints), tp: roundDemoTick(anchor + dir * step.tpPoints) };
        for (const [leg, price] of [['stop', prices.sl], ['limit', prices.tp]] as const) {
          for (const problem of exitOrderProblems({ side, leg, price, quantity: step.quantity, anchor })) problems.push(`${step.label}: ${problem}`);
        }
        tickets.set(step.ticket, {
          side, dir, entryType: 'Market', prices: { entry: anchor, ...prices }, entryStatus: 'filled', legStatus: 'working',
          quantities: { entry: step.quantity, sl: step.quantity, tp: step.quantity },
        });
      } else if (step.kind === 'modify') {
        for (const change of step.changes) {
          if ('plain' in change.target) continue;
          const ticket = tickets.get(change.target.ticket);
          if (!ticket) { problems.push(`${step.label}: neznámý lístek ${change.target.ticket}`); continue; }
          const order = change.target.order;
          const current = ticket.prices[order] ?? null;
          const newPrice = change.orderType === 'Market' ? null : change.price
            ? resolveDemoPrice(change.price, { anchor, dir: ticket.dir, current, ticketPrice, entryPrice: ticket.prices.entry })
            : current;
          const marketable = change.orderType === 'Market' || isMarketableRef(change.price);
          for (const problem of modifyProblems({
            order, side: ticket.side, entryType: ticket.entryType, status: order === 'entry' ? ticket.entryStatus : ticket.legStatus,
            entryPrice: ticket.prices.entry ?? null, newPrice, newQuantity: change.quantity ?? ticket.quantities[order],
            toMarket: change.orderType === 'Market', anchor, throughMarket: change.throughMarket === true, marketable,
          })) problems.push(`${step.label} / ${change.target.ticket}.${order}: ${problem}`);
          if (newPrice != null) ticket.prices[order] = newPrice;
          if (change.quantity !== undefined) ticket.quantities[order] = change.quantity;
          if (order === 'entry' && (marketable || change.throughMarket)) { ticket.entryStatus = 'filled'; ticket.legStatus = 'working'; }
          if (order === 'tp' && marketable) ticket.legStatus = 'closed';
        }
      } else if (step.kind === 'cancel') {
        for (const target of step.targets) {
          if ('plain' in target) continue;
          const ticket = tickets.get(target.ticket);
          if (ticket && target.order === 'entry' && ticket.entryStatus === 'working') { ticket.entryStatus = 'canceled'; ticket.legStatus = 'canceled'; }
        }
      } else if (step.kind === 'liquidate') {
        for (const ticket of tickets.values()) {
          if (ticket.entryStatus === 'working') ticket.entryStatus = 'canceled';
          ticket.legStatus = 'canceled';
        }
      }
    } catch (reason) {
      problems.push(`${step.label}: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }
  return problems;
}

// ─── pozorování a klasifikace ───────────────────────────────────────────────

export interface DemoObservedOrder {
  id: string;
  status: string;
  side?: string;
  type?: string;
  quantity: number;
  filledQuantity: number;
  limitPrice?: number;
  stopPrice?: number;
  parentOrderId?: string;
  ocoId?: string;
  linkedOrderId?: string;
}

export interface DemoObservation {
  orders: DemoObservedOrder[] | null;
  netPosition: number | null;
}

export interface DemoTicketIds { entry?: string; sl?: string; tp?: string }
export interface DemoTicketPrices { entry?: number | null; sl?: number; tp?: number }

export interface DemoClassifyInput {
  before?: DemoObservation | null;
  after: DemoObservation;
  tickets: Readonly<Record<string, DemoTicketIds>>;
  plain?: Readonly<Record<string, string>>;
  /** Výsledky akce kroku po id (modify/cancel). */
  results?: ReadonlyArray<{ id: string; ok: boolean; error?: string; confirmedBy?: string | null }>;
  /** Poslední odeslané ceny lístků. */
  expected?: Readonly<Record<string, DemoTicketPrices>>;
  /** Ceny při zadání. */
  placed?: Readonly<Record<string, DemoTicketPrices>>;
}

export interface DemoFinding {
  classifier: DemoClassifierName;
  verdict: string;
  detail: Record<string, unknown>;
}

const OPEN_STATUSES = new Set(['working', 'pending']);
const isOpen = (order: DemoObservedOrder | undefined) => order != null && OPEN_STATUSES.has(order.status);
const isFilled = (order: DemoObservedOrder | undefined) => order != null && (order.status === 'filled' || order.filledQuantity > 0);
export const demoOrderPrice = (order: DemoObservedOrder | undefined): number | undefined =>
  order == null ? undefined : order.type === 'Stop' ? order.stopPrice ?? order.limitPrice : order.limitPrice ?? order.stopPrice;
const find = (observation: DemoObservation | null | undefined, id: string | undefined) =>
  id == null ? undefined : observation?.orders?.find(order => order.id === id);
const brief = (order: DemoObservedOrder | undefined) => order == null ? null : ({
  status: order.status, quantity: order.quantity, filled: order.filledQuantity, price: demoOrderPrice(order) ?? null,
  ...(order.parentOrderId ? { parentOrderId: order.parentOrderId } : {}),
  ...(order.ocoId ? { ocoId: order.ocoId } : {}),
});

/** Pomocná podmínka C2: obě nohy lístku otevřené s qty `quantity`. */
export function legsQuantityMatch(observation: DemoObservation, ids: DemoTicketIds | undefined, quantity: number): boolean {
  const sl = find(observation, ids?.sl);
  const tp = find(observation, ids?.tp);
  return isOpen(sl) && isOpen(tp) && sl!.quantity === quantity && tp!.quantity === quantity;
}

/** Klasifikace výsledku kroku z pozorovaného stavu u brokera (nikdy z předpokladu). */
export function classifyDemo(spec: DemoClassify, input: DemoClassifyInput): DemoFinding {
  const result = (verdict: string, detail: Record<string, unknown> = {}): DemoFinding => ({ classifier: spec.name, verdict, detail });
  if (input.after.orders == null || input.after.netPosition == null) return result('unreadable');
  const ids = (name: string | undefined) => (name ? input.tickets[name] : undefined) ?? {};
  const own = ids(spec.ticket);
  const leg = (name: 'entry' | 'sl' | 'tp', ticket: DemoTicketIds = own, observation: DemoObservation | null | undefined = input.after) => find(observation, ticket[name]);
  const errorOf = (id: string | undefined) => input.results?.find(item => item.id === id && !item.ok)?.error;

  switch (spec.name) {
    case 'leg-resize': {
      const sl = leg('sl');
      const tp = leg('tp');
      const detail = { sl: brief(sl), tp: brief(tp) };
      if (!sl || !tp) return result('leg-missing', detail);
      const quantity = spec.quantity ?? 1;
      const changed = (order: DemoObservedOrder) => isOpen(order) && order.quantity === quantity;
      if (spec.order === 'sl' || spec.order === 'tp') {
        const [modified, partner] = spec.order === 'sl' ? [sl, tp] : [tp, sl];
        if (!changed(modified)) return result('not-resized', detail);
        return result(changed(partner) ? 'partner-followed' : 'partner-unchanged', detail);
      }
      if (changed(sl) && changed(tp)) return result('resized', detail);
      return result(changed(sl) || changed(tp) ? 'one-resized' : 'not-resized', detail);
    }
    case 'oco-partner-after-cancel': {
      const canceledName = spec.order === 'tp' ? 'tp' : 'sl';
      const canceled = leg(canceledName);
      const partner = leg(canceledName === 'sl' ? 'tp' : 'sl');
      const detail = { canceled: brief(canceled), partner: brief(partner), error: errorOf(own[canceledName]) ?? null };
      if (isOpen(canceled)) return result('cancel-not-applied', detail);
      if (!partner) return result('partner-missing', detail);
      if (isOpen(partner)) return result('partner-open', detail);
      return result(partner.status === 'canceled' ? 'partner-canceled' : `partner-${partner.status}`, detail);
    }
    case 'ticket-intact': {
      const expected = input.expected?.[spec.ticket ?? ''] ?? {};
      const quantity = spec.quantity ?? 1;
      const diffs: string[] = [];
      for (const name of ['sl', 'tp'] as const) {
        const order = leg(name);
        if (!isOpen(order)) diffs.push(`${name} neběží`);
        else {
          if (order!.quantity !== quantity) diffs.push(`${name} qty ${order!.quantity}`);
          if (expected[name] != null && demoOrderPrice(order) !== expected[name]) diffs.push(`${name} cena ${demoOrderPrice(order)}`);
        }
      }
      return result(diffs.length ? 'changed' : 'intact', { sl: brief(leg('sl')), tp: brief(leg('tp')), diffs, net: input.after.netPosition });
    }
    case 'tp-fill': {
      const tp = leg('tp');
      const sl = leg('sl');
      const others = (spec.tickets ?? []).map(name => ({ name, sl: leg('sl', ids(name)), tp: leg('tp', ids(name)) }));
      const detail = {
        tp: brief(tp), sl: brief(sl), net: input.after.netPosition,
        others: Object.fromEntries(others.map(item => [item.name, { sl: brief(item.sl), tp: brief(item.tp) }])),
      };
      if (!isFilled(tp)) return result('tp-not-filled', detail);
      if (isOpen(sl)) return result('own-sl-still-open', detail);
      const intact = others.every(item => {
        const expected = input.expected?.[item.name] ?? {};
        const legOk = (order: DemoObservedOrder | undefined, price: number | undefined) =>
          isOpen(order) && (price == null || demoOrderPrice(order) === price);
        return legOk(item.sl, expected.sl) && legOk(item.tp, expected.tp);
      });
      if (!intact) return result('other-ticket-changed', detail);
      if (spec.quantity != null && Math.abs(input.after.netPosition) !== spec.quantity) return result('net-unexpected', detail);
      return result('only-own-sl-canceled', detail);
    }
    case 'relative-leg-move': {
      const price = (name: 'entry' | 'sl' | 'tp', observation: DemoObservation | null | undefined) => demoOrderPrice(leg(name, own, observation));
      const delta = (name: 'entry' | 'sl' | 'tp') => {
        const after = price(name, input.after);
        const before = price(name, input.before);
        return after == null || before == null ? null : roundDemoTick(after - before);
      };
      const entry = delta('entry');
      const sl = delta('sl');
      const tp = delta('tp');
      const detail = {
        entryDelta: entry, slDelta: sl, tpDelta: tp,
        entry: brief(leg('entry')), sl: brief(leg('sl')), tp: brief(leg('tp')),
        legsStillPending: leg('sl')?.status === 'pending' && leg('tp')?.status === 'pending',
        error: errorOf(own.entry) ?? null,
      };
      if (entry == null || sl == null || tp == null) return result('unreadable', detail);
      if (entry === 0) return result('entry-not-moved', detail);
      if (sl === entry && tp === entry) return result('moved-by-delta', detail);
      if (sl === 0 && tp === 0) return result('legs-unchanged', detail);
      return result('mixed', detail);
    }
    case 'suspended-modify': {
      const names = spec.order === 'sl' || spec.order === 'tp' ? [spec.order] : (['sl', 'tp'] as const);
      const expected = input.expected?.[spec.ticket ?? ''] ?? {};
      const legs = names.map(name => {
        const order = leg(name);
        const error = errorOf(own[name]);
        const verdict = error && demoOrderPrice(order) !== expected[name] ? 'rejected'
          : demoOrderPrice(order) !== expected[name] ? 'unconfirmed'
            : order?.status === 'pending' ? 'accepted-pending' : `accepted-${order?.status ?? 'missing'}`;
        return { name, verdict, order: brief(order), expected: expected[name] ?? null, error: error ?? null };
      });
      const verdicts = [...new Set(legs.map(item => item.verdict))];
      return result(verdicts.length === 1 ? verdicts[0] : 'mixed', { legs });
    }
    case 'fill-with-modified-legs': {
      const entry = leg('entry');
      const expected = input.expected?.[spec.ticket ?? ''] ?? {};
      const placed = input.placed?.[spec.ticket ?? ''] ?? {};
      const sl = leg('sl');
      const tp = leg('tp');
      const detail = { entry: brief(entry), sl: brief(sl), tp: brief(tp), expected, placed, net: input.after.netPosition };
      if (!isFilled(entry)) return result('not-filled', detail);
      if (sl?.status !== 'working' || tp?.status !== 'working') return result('filled-legs-not-working', detail);
      if (demoOrderPrice(sl) === expected.sl && demoOrderPrice(tp) === expected.tp) {
        return result(expected.sl === placed.sl && expected.tp === placed.tp ? 'filled-unmodified' : 'filled-new-prices', detail);
      }
      if (demoOrderPrice(sl) === placed.sl && demoOrderPrice(tp) === placed.tp) return result('filled-old-prices', detail);
      return result('filled-other-prices', detail);
    }
    case 'parent-qty': {
      const quantity = spec.quantity ?? 1;
      const entry = leg('entry');
      const legsAfter = [leg('sl'), leg('tp')];
      const legsBefore = [leg('sl', own, input.before), leg('tp', own, input.before)];
      const detail = { entry: brief(entry), sl: brief(legsAfter[0]), tp: brief(legsAfter[1]), error: errorOf(own.entry) ?? null };
      if (entry?.quantity !== quantity) return result(errorOf(own.entry) ? 'rejected' : 'entry-not-changed', detail);
      if (legsAfter.every(order => order?.quantity === quantity)) return result('legs-follow', detail);
      if (legsAfter.every((order, index) => order != null && order.quantity === legsBefore[index]?.quantity)) return result('legs-unchanged', detail);
      return result('mixed', detail);
    }
    case 'cascade': {
      const entry = leg('entry');
      const legs = [leg('sl'), leg('tp')];
      const detail = { entry: brief(entry), sl: brief(legs[0]), tp: brief(legs[1]), net: input.after.netPosition };
      if (isOpen(entry)) return result('parent-open', detail);
      if (isFilled(entry)) return result('parent-filled', detail);
      if (legs.every(order => order?.status === 'canceled')) return result('legs-canceled', detail);
      if (legs.some(isOpen)) return result('legs-open', detail);
      return result('legs-other', detail);
    }
    case 'independent-pairs': {
      const names = spec.tickets ?? (spec.ticket ? [spec.ticket] : []);
      const all = names.flatMap(name => [ids(name).entry, ids(name).sl, ids(name).tp]);
      const detail = Object.fromEntries(names.map(name => [name, {
        entry: brief(leg('entry', ids(name))), sl: brief(leg('sl', ids(name))), tp: brief(leg('tp', ids(name))),
      }]));
      if (all.some(id => id == null)) return result('missing-ids', detail);
      if (new Set(all).size !== all.length) return result('shared-ids', detail);
      const shapeOk = names.every(name => leg('entry', ids(name))?.status === 'working'
        && leg('sl', ids(name))?.status === 'pending' && leg('tp', ids(name))?.status === 'pending');
      return result(shapeOk ? 'independent' : 'unexpected-status', detail);
    }
    case 'cancel-one-of-many': {
      const canceled = ['entry', 'sl', 'tp'].map(name => leg(name as 'entry' | 'sl' | 'tp'));
      const others = (spec.tickets ?? []).map(name => ({
        name,
        orders: (['entry', 'sl', 'tp'] as const).map(part => ({ part, after: leg(part, ids(name)), before: leg(part, ids(name), input.before) })),
      }));
      const detail = {
        canceled: { entry: brief(canceled[0]), sl: brief(canceled[1]), tp: brief(canceled[2]) },
        others: Object.fromEntries(others.map(item => [item.name, Object.fromEntries(item.orders.map(order => [order.part, brief(order.after)]))])),
      };
      if (canceled.some(isOpen)) return result('own-still-open', detail);
      const touched = others.some(item => item.orders.some(order => !isOpen(order.after)
        || order.after!.status !== (order.before?.status ?? order.after!.status)
        || demoOrderPrice(order.after) !== (demoOrderPrice(order.before) ?? demoOrderPrice(order.after))));
      return result(touched ? 'others-touched' : 'only-own-canceled', detail);
    }
    case 'liquidate-cancels-all': {
      const open = input.after.orders.filter(order => OPEN_STATUSES.has(order.status));
      const foreignId = spec.plain ? input.plain?.[spec.plain] : undefined;
      const detail = {
        net: input.after.netPosition,
        open: open.map(order => ({ id: order.id, status: order.status, type: order.type ?? null })),
        ...(foreignId ? { foreign: brief(find(input.after, foreignId)) } : {}),
      };
      if (input.after.netPosition !== 0) return result('position-open', detail);
      return result(open.length ? 'open-left' : 'all-canceled', detail);
    }
    case 'through-market-entry': {
      const entry = leg('entry');
      const error = errorOf(own.entry);
      const detail = { entry: brief(entry), net: input.after.netPosition, error: error ?? null, before: brief(leg('entry', own, input.before)) };
      if (input.after.netPosition !== 0 || isFilled(entry)) return result('triggered', detail);
      if (error && demoOrderPrice(entry) === demoOrderPrice(leg('entry', own, input.before))) return result('rejected-unchanged', detail);
      if (isOpen(entry)) return result('accepted-working', detail);
      return result('other', detail);
    }
  }
  return result('unknown-classifier');
}

// ─── analýza časové osy (C4) ────────────────────────────────────────────────

export interface DemoTimelineEntity { t: number; entityType: string; eventType?: string; entity: Record<string, unknown> }

const entityOrderId = (item: DemoTimelineEntity): string | null => {
  const raw = item.entityType === 'order' ? item.entity.id : item.entity.orderId;
  return raw == null ? null : String(raw);
};

/** „Ocas“ eventů po liquidate: kdy přišel poslední event leadera a kdy se pohnul cashBalance. */
export function liquidationTail(timeline: readonly DemoTimelineEntity[], fromT: number, toT: number) {
  const window = timeline.filter(item => item.t >= fromT && item.t <= toT);
  const byType: Record<string, number[]> = {};
  for (const item of window) (byType[item.entityType] ??= []).push(item.t - fromT);
  const last = window.at(-1);
  return {
    entities: window.length,
    lastEventMs: last ? last.t - fromT : null,
    byType,
    firstCashBalanceMs: byType.cashBalance?.[0] ?? null,
    lastPositionMs: byType.position?.at(-1) ?? null,
  };
}

/**
 * Otočení (C4): po prvním eventu nového vstupu nesmí přijít event starého
 * příkazu (zavření). Position eventy jsou sdílené — jen se počítají.
 */
export function reverseOrdering(
  timeline: readonly DemoTimelineEntity[],
  oldIds: ReadonlySet<string>,
  newIds: ReadonlySet<string>,
  sentT: number,
) {
  const after = timeline.filter(item => item.t >= sentT);
  const firstNew = after.find(item => {
    const id = entityOrderId(item);
    return id != null && newIds.has(id);
  });
  if (!firstNew) return { verdict: 'no-new-events' as const, firstNewEventMs: null, oldAfterNew: [], positionAfterNew: 0 };
  const later = after.filter(item => item.t >= firstNew.t && item !== firstNew);
  const oldAfterNew = later.filter(item => {
    const id = entityOrderId(item);
    return id != null && oldIds.has(id) && !newIds.has(id);
  }).map(item => ({ ms: item.t - sentT, entityType: item.entityType }));
  return {
    verdict: oldAfterNew.length ? 'old-after-new' as const : 'separated' as const,
    firstNewEventMs: firstNew.t - sentT,
    oldAfterNew,
    positionAfterNew: later.filter(item => item.entityType === 'position').length,
  };
}

// ─── anonymizace ────────────────────────────────────────────────────────────

const PRIVATE_KEYS = /^(userId|senderId|userSessionId|name|email|nickname|accountSpec|username|connectionId|tag|clOrdId)$/i;

/** Entity leadera navíc k `sanitizeRecordedFrame` (cashBalance pro časování realizovaného P&L, exits P2). */
export function leaderExtraEntities(
  data: string,
  accountMap: ReadonlyMap<number, number>,
  leaderPlaceholder: number,
  types: readonly string[] = ['cashBalance'],
): Array<{ entityType: string; eventType: string; entity: Record<string, unknown> }> {
  if (!data.startsWith('a[')) return [];
  let messages: unknown[];
  try { messages = JSON.parse(data.slice(1)); } catch { return []; }
  const out: Array<{ entityType: string; eventType: string; entity: Record<string, unknown> }> = [];
  for (const message of messages) {
    const item = message as { e?: unknown; d?: { entityType?: unknown; eventType?: unknown; entity?: Record<string, unknown> } };
    if (item.e !== 'props' || !item.d?.entity || typeof item.d.entityType !== 'string' || !types.includes(item.d.entityType)) continue;
    if (accountMap.get(Number(item.d.entity.accountId)) !== leaderPlaceholder) continue;
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item.d.entity)) {
      if (PRIVATE_KEYS.test(key)) continue;
      clean[key] = key === 'accountId' ? leaderPlaceholder : value;
    }
    out.push({ entityType: item.d.entityType, eventType: String(item.d.eventType ?? ''), entity: clean });
  }
  return out;
}

const JWT_LIKE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

/** Text do konzole a do záznamu: bez tokenů, bez id spojení, bez identifikátorů účtů. */
export function redactDemoText(text: string, identifiers: readonly (string | number)[] = []): string {
  let out = text
    .replace(JWT_LIKE, '[token]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [token]')
    .replace(/(access_?token|accessToken|mdAccessToken|password|secret)(["':=\s]+)[^"',\s}]+/gi, '$1$2[token]')
    .replace(/conn:[0-9a-f-]+/gi, 'conn:x');
  for (const identifier of identifiers.map(String).filter(value => value.length >= 4)) {
    out = out.split(identifier).join('[účet]');
  }
  return out;
}

/** Poslední síto: serializovaný záznam nesmí obsahovat nic, co vypadá jako token. */
export function containsSecret(serialized: string): boolean {
  return new RegExp(JWT_LIKE.source).test(serialized) || /Bearer\s+[A-Za-z0-9._-]{8,}/i.test(serialized);
}

// ─── popis plánu (dry-run) ──────────────────────────────────────────────────

const refText = (ref: DemoPriceRef | undefined): string => {
  if (!ref) return '';
  const signed = (value: number) => (value >= 0 ? `+${value}` : String(value));
  if (ref.from === 'market') {
    return `trh${ref.ratio ? ` ${signed(ref.ratio * 100)} %` : ''}${ref.points ? ` ${signed(ref.points)} b` : ''}${ref.marketable ? ' (marketable)' : ''}`;
  }
  if (ref.from === 'entry') return `vstup ${signed(ref.points)} b`;
  if (ref.from === 'current') return `nyní ${signed(ref.points)} b`;
  return `${ref.ticket}.${ref.order}${ref.points ? ` ${signed(ref.points)} b` : ''}`;
};
const targetText = (target: DemoOrderRef) => ('plain' in target ? target.plain : `${target.ticket}.${target.order}`);

export function describeDemoStep(step: DemoStep): string {
  switch (step.kind) {
    case 'place-oso':
      return `${step.label}: ${step.tickets.map(ticket => `${ticket.ticket} ${ticket.side === 'opposite' ? 'opačně ' : ''}${ticket.quantity}× ${
        ticket.entry.orderType}${'price' in ticket.entry ? ` @ ${refText(ticket.entry.price)}` : ''}, SL ${refText(ticket.stopLoss)}, TP ${refText(ticket.takeProfit)}`).join(' | ')}`;
    case 'place-order':
      return `${step.label}: ${step.ref} ${step.side === 'opposite' ? 'opačná strana' : 'strana pozice'} ${step.quantity}× ${step.orderType}${step.price ? ` @ ${refText(step.price)}` : ''}${step.reducing ? ' (redukce)' : ''}`;
    case 'place-exit':
      return `${step.label}: ${step.ref} samostatný ${step.leg === 'stop' ? 'Stop' : 'Limit'} ${step.quantity}× ${step.points} b od trhu`;
    case 'place-oco':
      return `${step.label}: ${step.ticket} OCO ${step.quantity}×, SL ${step.slPoints} b, TP ${step.tpPoints} b od trhu`;
    case 'modify':
      return `${step.label}: ${step.changes.map(change => `${targetText(change.target)}${change.price ? ` → ${refText(change.price)}` : ''}${change.quantity ? ` qty ${change.quantity}` : ''}${change.orderType ? ' → Market' : ''}${change.throughMarket ? ' (přes trh)' : ''}`).join(', ')}`;
    case 'cancel':
      return `${step.label}: zrušit ${step.targets.map(targetText).join(', ')}${step.onlyIfOpen ? ' (jen otevřené)' : ''}`;
    case 'liquidate': return `${step.label}: liquidateposition`;
    case 'wait-net': return `${step.label}: čekat na pozici ${step.net} (≤ ${step.timeoutMs} ms${step.optional ? ', nepovinné' : ''})`;
    case 'wait-fill': return `${step.label}: čekat na fill ${step.ticket} (≤ ${step.timeoutMs} ms)`;
    case 'observe': return `${step.label}: pozorovat`;
    case 'wait-quiet': return `${step.label}: zapisovat do ${step.quietMs} ms ticha (≤ ${step.maxMs} ms)`;
    case 'require-flat': return `${step.label}: REST flat bez příkazů, jinak konec`;
    case 'sleep': return `${step.label}: pauza ${step.ms} ms`;
  }
  return 'neznámý krok';
}

export function describeDemoPlan(plan: DemoRecordPlan): string[] {
  const lines = [`Plán: ${plan.side} ${plan.symbol}, trh ~${plan.marketPrice}, ${plan.scenarios.length} scénář(e); před každým zadáním ARMED gate, na konci každého úklid a ověřený flat.`];
  for (const scenario of plan.scenarios) {
    lines.push(`• ${scenario.name} — ${scenario.purpose} [max. pozice ${scenarioMaxExposure(scenario.steps)}${scenarioFills(scenario.steps) ? ', VYPLNÍ SE (--allow-fill)' : ', bez fillu'}]`);
    scenario.steps.forEach((step, index) => lines.push(`   ${index + 1}. ${describeDemoStep(step)}`));
  }
  return lines;
}
