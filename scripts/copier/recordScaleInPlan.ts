/**
 * Čistá logika fáze 0 dokupování (`docs/reviews/scale-in-design-20261102.md` §4):
 * pojistky před zadáním a rozhodnutí o úklidu. Skript `record-scale-in.ts` smí
 * běžet jen na DEMO manual-only skupině bez followerů za DISARMED (Filip 3. 11.
 * 2026: „na demu je to čistě tvé“); tady se nic neposílá k brokerovi.
 */
import { recordLeaderOsoProblems, RECORD_TICK_SIZE, type RecordLeaderOsoPlan } from './recordLeaderOsoPlan';
import {
  DEMO_FAR_RATIO,
  DEMO_MAX_SL_RATIO,
  DEMO_MIN_BRACKET_POINTS,
  cliNumber,
  cliValue,
  parseDemoBaseArgs,
  type DemoPriceRef,
  type DemoRecordPlan,
  type DemoScenario,
} from './recordDemoPlan';

export interface RecordScaleInPlan {
  accountId: number;
  symbol: string;
  side: 'Buy' | 'Sell';
  marketPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** Čekající přikoupení (Limit) mezi trhem a SL — během záznamu se nesmí vyplnit. */
  addLimit: number;
  confirm: boolean;
  /**
   * `basic` = základ 1 + přikoupení 1 + posun + čekající Limit + liquidate (3. 11. ráno);
   * `five` = základ 1 + Market přikoupení 2, 1, 1 (pozice 5 ve 4 lístcích) + souběžný posun
   * všech 4 SL a 4 TP + liquidate (oponentura v4, P2-4).
   */
  scenario: 'basic' | 'five';
}

/** Market přikoupení scénáře `five` (základ 1 + tyto = 5 = strop DEMO). */
export const SCALE_IN_FIVE_ADDS = [2, 1, 1] as const;

/** Čekající přikoupení aspoň tolik od trhu (podíl ceny) a aspoň tolik bodů od SL. */
export const SCALE_IN_ADD_MIN_DISTANCE_RATIO = 0.0015;
export const SCALE_IN_ADD_MIN_SL_POINTS = 10;
/** Posun obou SL a TP při souběžném modify (dál od trhu — nic se nespustí). */
export const SCALE_IN_MODIFY_POINTS = 1;

export function parseRecordScaleInArgs(argv: readonly string[]): RecordScaleInPlan {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const number = (name: string) => {
    const raw = value(name);
    const parsed = Number(raw);
    if (raw === undefined || !Number.isFinite(parsed)) throw new Error(`Chybí nebo je neplatné --${name}`);
    return parsed;
  };
  const side = value('side') ?? 'Buy';
  if (side !== 'Buy' && side !== 'Sell') throw new Error('--side musí být Buy nebo Sell');
  const symbol = (value('symbol') ?? '').trim().toUpperCase();
  if (!/^MNQ[FGHJKMNQUVXZ]\d$/.test(symbol)) throw new Error('--symbol musí být kontrakt MNQ, např. MNQZ6');
  const accountId = number('account');
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('--account musí být id účtu');
  const scenario = value('scenario') ?? 'basic';
  if (scenario !== 'basic' && scenario !== 'five') throw new Error('--scenario musí být basic nebo five');
  return {
    accountId, symbol, side,
    marketPrice: number('market-price'), stopLoss: number('sl'), takeProfit: number('tp'), addLimit: number('add-limit'),
    confirm: argv.includes('--confirm'), scenario,
  };
}

const onTick = (price: number) => Math.abs(price / RECORD_TICK_SIZE - Math.round(price / RECORD_TICK_SIZE)) < 1e-9;

/** Důvody, proč záznam NESMÍ běžet (prázdné = smí); volá se před připojením i těsně před prvním zadáním. */
export function recordScaleInProblems(plan: RecordScaleInPlan, status: unknown, now: number): string[] {
  const root = (status ?? {}) as {
    environment?: unknown;
    group?: { manualOnly?: unknown; localOnly?: unknown; followers?: unknown[] } | null;
  };
  // Pojistky Market vstupu (DISARMED, flat, cena workeru, SL/TP pásma) jsou stejné jako u záznamu OSO.
  const base: RecordLeaderOsoPlan = {
    accountId: plan.accountId, symbol: plan.symbol, side: plan.side,
    entry: plan.marketPrice, stopLoss: plan.stopLoss, takeProfit: plan.takeProfit, marketPrice: plan.marketPrice,
    holdMs: 1_000, confirm: plan.confirm, scenario: 'market', allowNonGroupAccount: false,
  };
  const problems = recordLeaderOsoProblems(base, status, now);
  if (root.environment !== 'demo') problems.push('worker neběží na DEMO prostředí');
  if (root.group?.manualOnly !== true || root.group?.localOnly !== true) problems.push('skupina workeru není manual-only + local-only');
  if (!Array.isArray(root.group?.followers) || root.group.followers.length !== 0) problems.push('skupina workeru má followery');
  if (!(plan.addLimit > 0) || !onTick(plan.addLimit)) problems.push(`--add-limit není kladná cena na tick ${RECORD_TICK_SIZE}`);
  const minDistance = plan.marketPrice * SCALE_IN_ADD_MIN_DISTANCE_RATIO;
  if (plan.side === 'Buy') {
    if (!(plan.addLimit <= plan.marketPrice - minDistance)) problems.push(`přikoupení (Buy limit) musí být aspoň ${minDistance.toFixed(0)} b pod trhem`);
    if (!(plan.addLimit >= plan.stopLoss + SCALE_IN_ADD_MIN_SL_POINTS)) problems.push(`přikoupení musí být aspoň ${SCALE_IN_ADD_MIN_SL_POINTS} b nad SL`);
  } else {
    if (!(plan.addLimit >= plan.marketPrice + minDistance)) problems.push(`přikoupení (Sell limit) musí být aspoň ${minDistance.toFixed(0)} b nad trhem`);
    if (!(plan.addLimit <= plan.stopLoss - SCALE_IN_ADD_MIN_SL_POINTS)) problems.push(`přikoupení musí být aspoň ${SCALE_IN_ADD_MIN_SL_POINTS} b pod SL`);
  }
  return problems;
}

/** SL a TP posunuté dál od trhu (souběžné modify obou nohou nesmí nic spustit). */
export function scaleInLoosened(plan: Pick<RecordScaleInPlan, 'side' | 'stopLoss' | 'takeProfit'>): { stopLoss: number; takeProfit: number } {
  const direction = plan.side === 'Buy' ? 1 : -1;
  return {
    stopLoss: plan.stopLoss - direction * SCALE_IN_MODIFY_POINTS,
    takeProfit: plan.takeProfit + direction * SCALE_IN_MODIFY_POINTS,
  };
}

export interface ScaleInObservation {
  /** Nové příkazy leadera od začátku záznamu; `null` = čtení selhalo. */
  orders: Array<{ id: string; status: string; filledQuantity: number; parentOrderId?: string }> | null;
  /** Absolutní součet pozic leadera; `null` = čtení selhalo. */
  netPosition: number | null;
}

export type ScaleInCleanupDecision =
  | { kind: 'unverified'; reason: string }
  | { kind: 'liquidate' }
  | { kind: 'cancel'; ids: string[] }
  | { kind: 'clean' };

// `pending` zahrnuje i Suspended (pozastavené nohy čekajícího vstupu).
const OPEN = new Set(['working', 'pending']);

/**
 * Úklid: otevřená pozice = zavřít (ochrana do té doby zůstává). Flat: zrušit
 * nejdřív čekající vstupy (vlastní id vstupů z ACK), nohy až v dalším kole nad
 * stále flat účtem. „Čisto“ = flat a žádný vlastní příkaz otevřený.
 */
export function decideScaleInCleanup(observation: ScaleInObservation, entryIds: ReadonlySet<string>): ScaleInCleanupDecision {
  if (observation.orders == null || observation.netPosition == null) return { kind: 'unverified', reason: 'stav leadera nejde přečíst' };
  if (observation.netPosition !== 0) return { kind: 'liquidate' };
  const open = observation.orders.filter(order => OPEN.has(order.status));
  const entries = open.filter(order => entryIds.has(order.id));
  if (entries.length) return { kind: 'cancel', ids: entries.map(order => order.id) };
  if (open.length) return { kind: 'cancel', ids: open.map(order => order.id) };
  return { kind: 'clean' };
}

// ─── R16 / R17 (`docs/reviews/trading-gaps-designs/safety.md` C16 bod 6, C17 bod 6) ─────────
// Běží přes společný interpret `recordDemoSession.ts` (pojistky v `recordDemoPlan.ts`): jen
// DEMO8661118, MNQ front, DISARMED gate před scénářem i každým zadáním, expozice ≤ 2,
// `--allow-fill` (oba scénáře se vyplní). `basic` a `five` výše zůstávají beze změny.

export const SCALE_IN_DEMO_SCENARIOS = ['foreign-close', 'pending-modify'] as const;
export type ScaleInDemoScenarioName = typeof SCALE_IN_DEMO_SCENARIOS[number];

/** Přikoupení přes trh u pozastaveného SL (R17 bod 5): o tolik bodů za kotvou. */
export const SCALE_IN_THROUGH_MARKET_POINTS = 10;
/** Marketable posun čekajícího přikoupení k trhu (R17 bod 4). */
export const SCALE_IN_MARKETABLE_POINTS = 2;
/** SL základu je o tolik dál než čekající přikoupení (rezerva na pohyb trhu mezi zadáními). */
export const SCALE_IN_DEMO_SL_BEYOND_ADD_POINTS = 40;

export function isScaleInDemoScenario(argv: readonly string[]): boolean {
  return (SCALE_IN_DEMO_SCENARIOS as readonly string[]).includes(cliValue(argv, 'scenario') ?? '');
}

export interface ScaleInDemoOptions { addPoints: number; slPoints: number; tpPoints: number }

const ceilTick = (value: number) => Math.ceil(value / RECORD_TICK_SIZE - 1e-9) * RECORD_TICK_SIZE;
const onTickValue = (value: number) => Math.abs(value / RECORD_TICK_SIZE - Math.round(value / RECORD_TICK_SIZE)) < 1e-9;

/**
 * `--scenario foreign-close|pending-modify` + `--account --symbol --side --market-price`;
 * volitelně `--add-points` (výchozí 0,16 % trhu), `--sl-points` (přikoupení + 40), `--tp-points` (80).
 */
export function parseScaleInDemoArgs(argv: readonly string[]): DemoRecordPlan & { options: ScaleInDemoOptions } {
  const base = parseDemoBaseArgs(argv);
  const name = cliValue(argv, 'scenario') as ScaleInDemoScenarioName;
  if (!(SCALE_IN_DEMO_SCENARIOS as readonly string[]).includes(name)) throw new Error(`--scenario musí být ${SCALE_IN_DEMO_SCENARIOS.join(' nebo ')}`);
  const addPoints = cliNumber(argv, 'add-points', ceilTick(Math.max(DEMO_MIN_BRACKET_POINTS, base.marketPrice * (SCALE_IN_ADD_MIN_DISTANCE_RATIO + 0.0001))));
  const slPoints = cliNumber(argv, 'sl-points', addPoints + SCALE_IN_DEMO_SL_BEYOND_ADD_POINTS);
  const tpPoints = cliNumber(argv, 'tp-points', 2 * DEMO_MIN_BRACKET_POINTS);
  for (const [flag, value] of [['add-points', addPoints], ['sl-points', slPoints], ['tp-points', tpPoints]] as const) {
    if (!onTickValue(value)) throw new Error(`--${flag} musí být na tick ${RECORD_TICK_SIZE}`);
  }
  if (!(addPoints >= base.marketPrice * SCALE_IN_ADD_MIN_DISTANCE_RATIO)) {
    throw new Error(`--add-points musí být aspoň ${Math.ceil(base.marketPrice * SCALE_IN_ADD_MIN_DISTANCE_RATIO)} (0,15 % trhu)`);
  }
  if (!(slPoints - addPoints >= 2 * SCALE_IN_ADD_MIN_SL_POINTS)) throw new Error(`--sl-points musí být aspoň o ${2 * SCALE_IN_ADD_MIN_SL_POINTS} b dál než --add-points`);
  if (!(slPoints >= DEMO_MIN_BRACKET_POINTS && slPoints <= base.marketPrice * DEMO_MAX_SL_RATIO)) {
    throw new Error(`--sl-points musí být ${DEMO_MIN_BRACKET_POINTS}–${Math.floor(base.marketPrice * DEMO_MAX_SL_RATIO)}`);
  }
  if (!(tpPoints >= DEMO_MIN_BRACKET_POINTS && tpPoints <= base.marketPrice * 0.02)) throw new Error(`--tp-points musí být ${DEMO_MIN_BRACKET_POINTS}–${Math.floor(base.marketPrice * 0.02)}`);
  const options = { addPoints, slPoints, tpPoints };
  return { ...base, options, scenarios: [scaleInDemoScenario(name, options)] };
}

const fromMarket = (points: number): DemoPriceRef => ({ from: 'market', points });

export function scaleInDemoScenario(name: ScaleInDemoScenarioName, options: ScaleInDemoOptions): DemoScenario {
  const marketTicket = (ticket: string) => ({
    ticket, quantity: 1, entry: { orderType: 'Market' as const },
    stopLoss: fromMarket(-options.slPoints), takeProfit: fromMarket(options.tpPoints),
  });
  const pendingAdd = (ticket: string, base: string) => ({
    ticket, quantity: 1, entry: { orderType: 'Limit' as const, price: fromMarket(-options.addPoints) },
    stopLoss: { from: 'ticket' as const, ticket: base, order: 'sl' as const },
    takeProfit: { from: 'ticket' as const, ticket: base, order: 'tp' as const },
  });
  if (name === 'foreign-close') {
    return {
      name,
      purpose: 'R16 (C16): pozice 1 s OSO + cizí Limit daleko na stejném kontraktu (mimo záznamy appky) — zruší liquidate i cizí Limit?',
      steps: [
        { kind: 'place-oso', label: 'základ: Market OSO 1', tickets: [marketTicket('base')] },
        { kind: 'wait-net', label: 'základ vyplněn', net: 1, timeoutMs: 10_000 },
        {
          kind: 'place-order', label: 'cizí Limit 1 daleko (1,5 %) na stejném kontraktu', ref: 'f1', side: 'position', orderType: 'Limit',
          price: { from: 'market', ratio: -DEMO_FAR_RATIO }, quantity: 1, observeMs: [500, 1_500],
        },
        {
          kind: 'liquidate', label: 'liquidate s cizím Limitem', ref: 'liq', observeMs: [500, 2_000, 4_000],
          classify: { name: 'liquidate-cancels-all', plain: 'f1' },
        },
      ],
    };
  }
  return {
    name,
    purpose: 'R17 (C17): souběžný modify nohou základu i Suspended nohou čekajícího přikoupení; po fillu nohy s novou cenou; Suspended SL přes trh; modify + zrušení přikoupení; liquidate',
    steps: [
      { kind: 'place-oso', label: 'fáze 1: základ Market OSO 1', tickets: [marketTicket('base')] },
      { kind: 'wait-net', label: 'základ vyplněn', net: 1, timeoutMs: 10_000 },
      {
        kind: 'place-oso', label: 'čekající přikoupení Limit 1 se SL/TP základu', tickets: [pendingAdd('a1', 'base')],
        observeMs: [500, 1_500], classify: { name: 'independent-pairs', tickets: ['a1'] },
      },
      {
        kind: 'modify', label: 'souběžně SL/TP základu i Suspended nohy přikoupení o 1 b dál',
        changes: [
          { target: { ticket: 'base', order: 'sl' }, price: { from: 'current', points: -1 } },
          { target: { ticket: 'base', order: 'tp' }, price: { from: 'current', points: 1 } },
          { target: { ticket: 'a1', order: 'sl' }, price: { from: 'current', points: -1 } },
          { target: { ticket: 'a1', order: 'tp' }, price: { from: 'current', points: 1 } },
        ],
        observeMs: [300, 1_500], classify: { name: 'suspended-modify', ticket: 'a1' },
      },
      {
        kind: 'modify', label: 'přikoupení k trhu (marketable, vyplní se)',
        changes: [{ target: { ticket: 'a1', order: 'entry' }, price: { from: 'market', points: SCALE_IN_MARKETABLE_POINTS, marketable: true } }],
      },
      { kind: 'wait-net', label: 'přikoupení vyplněno (pozice 2)', net: 2, timeoutMs: 10_000, optional: true },
      { kind: 'observe', label: 'nohy přikoupení po fillu', observeMs: [500, 2_000], classify: { name: 'fill-with-modified-legs', ticket: 'a1' } },
      { kind: 'liquidate', label: 'fáze 1: liquidate', ref: 'liq1', observeMs: [500, 2_000], classify: { name: 'liquidate-cancels-all' } },
      { kind: 'require-flat', label: 'fáze 1: REST flat bez příkazů' },
      { kind: 'place-oso', label: 'fáze 2: základ Market OSO 1', tickets: [marketTicket('base2')] },
      { kind: 'wait-net', label: 'základ 2 vyplněn', net: 1, timeoutMs: 10_000 },
      { kind: 'place-oso', label: 'čekající přikoupení 2', tickets: [pendingAdd('a2', 'base2')], observeMs: [500] },
      {
        kind: 'modify', label: 'Suspended SL přikoupení přes trh (u Buy trh + 10 b)',
        changes: [{ target: { ticket: 'a2', order: 'sl' }, price: fromMarket(SCALE_IN_THROUGH_MARKET_POINTS), throughMarket: true }],
        observeMs: [300, 1_500], classify: { name: 'suspended-modify', ticket: 'a2', order: 'sl' },
      },
      {
        kind: 'modify', label: 'Suspended TP přikoupení +1 b', changes: [{ target: { ticket: 'a2', order: 'tp' }, price: { from: 'current', points: 1 } }],
        observeMs: [300, 1_500], classify: { name: 'suspended-modify', ticket: 'a2', order: 'tp' },
      },
      { kind: 'cancel', label: 'zrušit přikoupení', targets: [{ ticket: 'a2', order: 'entry' }], observeMs: [500, 2_000], classify: { name: 'cascade', ticket: 'a2' } },
      { kind: 'liquidate', label: 'fáze 2: liquidate', ref: 'liq2', observeMs: [500, 2_000], classify: { name: 'liquidate-cancels-all' } },
    ],
  };
}
