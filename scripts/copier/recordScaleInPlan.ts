/**
 * Čistá logika fáze 0 dokupování (`docs/reviews/scale-in-design-20261102.md` §4):
 * pojistky před zadáním a rozhodnutí o úklidu. Skript `record-scale-in.ts` smí
 * běžet jen na DEMO manual-only skupině bez followerů za DISARMED (Filip 3. 11.
 * 2026: „na demu je to čistě tvé“); tady se nic neposílá k brokerovi.
 */
import { recordLeaderOsoProblems, RECORD_TICK_SIZE, type RecordLeaderOsoPlan } from './recordLeaderOsoPlan';

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
