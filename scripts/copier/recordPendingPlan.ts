/**
 * R1–R7 z `docs/reviews/trading-gaps-designs/pending.md` §1.2 (čekající vstupy,
 * Suspended nohy, víc čekajících OSO): čisté scénáře pro `record-pending.ts`.
 * Nic se tu neposílá. Strop qty ≤ 2 mění R5 (2 → 1 → 2 místo 2 → 3 → 1) a R6
 * (dva čekající vstupy místo tří). C5e (OCO breakout) se nenahrává (zamítnuto).
 *
 * Překryvy (nahrává se jednou):
 * - R6a + R6c + exits `split-limit` = `multi-pending` (kolo A souběžně stejná cena
 *   a různé TP, kolo B souběžně dvě ceny a stejné SL/TP);
 * - R6b (liquidate se dvěma čekajícími přikoupeními) potřebuje možnou pozici 3 —
 *   se stropem 2 nejde; liquidate s jedním čekajícím přikoupením je nahraný
 *   (K4, `record-scale-in --scenario basic`) a znovu v `pending-modify`;
 * - R7 = `record-exits.ts --scenario tp-fill --placement sequential`.
 */
import {
  DEMO_FAR_RATIO,
  DEMO_FILL_WAIT_MAX_MS,
  DEMO_MAX_SL_RATIO,
  DEMO_MIN_BRACKET_POINTS,
  cliNumber,
  parseDemoBaseArgs,
  parseScenarioList,
  type DemoOsoTicket,
  type DemoPriceRef,
  type DemoRecordPlan,
  type DemoScenario,
} from './recordDemoPlan';

export const PENDING_SCENARIOS = [
  'move-entry-limit', 'move-entry-stop', 'move-suspended-legs', 'suspended-legs-then-fill', 'parent-qty', 'multi-pending',
] as const;
export type PendingScenarioName = typeof PENDING_SCENARIOS[number];

export const PENDING_ALIASES: Readonly<Record<string, string>> = {
  r1: 'move-entry-limit', r2: 'move-entry-stop', r3: 'move-suspended-legs', r4: 'suspended-legs-then-fill',
  r5: 'parent-qty', r6: 'multi-pending', r6a: 'multi-pending', r6c: 'multi-pending', r7: 'per-ticket-exit', r6b: 'liquidate-pending',
};

export const PENDING_ELSEWHERE: Readonly<Record<string, string>> = {
  'per-ticket-exit': 'R7 se nahrává jednou — spusť record-exits.ts --scenario tp-fill --placement sequential',
  'liquidate-pending': 'R6b potřebuje možnou pozici 3 (strop 2); liquidate s čekajícím přikoupením nahrává record-scale-in --scenario pending-modify',
  'oco-breakout': 'C5e je zamítnuté — nenahrává se',
};

/** Posun rodiče / nohou v bodech (pending.md R1–R4). */
export const PENDING_MOVE_POINTS = 4;
/** Druhá příčka žebříku je o tolik dál od trhu. */
export const PENDING_LADDER_STEP_POINTS = 10;
/** Stop vstup přes trh: o tolik bodů za kotvou (R2). */
export const PENDING_THROUGH_MARKET_POINTS = 10;
/** SL čekajícího Stop vstupu posunutý mezi trh a vstup (R3): polovina vzdálenosti vstupu. */
export const PENDING_SUSPENDED_SL_RATIO = DEMO_FAR_RATIO / 2;

export interface RecordPendingOptions {
  slPoints: number;
  tpPoints: number;
  fillWaitMs: number;
}

export function parseRecordPendingArgs(argv: readonly string[]): DemoRecordPlan & { options: RecordPendingOptions } {
  const base = parseDemoBaseArgs(argv);
  const names = parseScenarioList(argv, PENDING_SCENARIOS, PENDING_ELSEWHERE, PENDING_ALIASES) as PendingScenarioName[];
  const slPoints = cliNumber(argv, 'sl-points', DEMO_MIN_BRACKET_POINTS);
  const tpPoints = cliNumber(argv, 'tp-points', DEMO_MIN_BRACKET_POINTS);
  if (!(slPoints >= DEMO_MIN_BRACKET_POINTS) || !(slPoints <= base.marketPrice * DEMO_MAX_SL_RATIO)) {
    throw new Error(`--sl-points musí být ${DEMO_MIN_BRACKET_POINTS}–${Math.floor(base.marketPrice * DEMO_MAX_SL_RATIO)}`);
  }
  if (!(tpPoints >= DEMO_MIN_BRACKET_POINTS) || !(tpPoints <= base.marketPrice * 0.02)) throw new Error(`--tp-points musí být ${DEMO_MIN_BRACKET_POINTS}–${Math.floor(base.marketPrice * 0.02)}`);
  for (const [name, value] of [['sl-points', slPoints], ['tp-points', tpPoints]] as const) {
    if (Math.abs(value * 4 - Math.round(value * 4)) > 1e-9) throw new Error(`--${name} musí být na tick 0,25`);
  }
  const fillWaitMs = cliNumber(argv, 'fill-wait-ms', DEMO_FILL_WAIT_MAX_MS);
  if (!Number.isInteger(fillWaitMs) || fillWaitMs < 10_000 || fillWaitMs > DEMO_FILL_WAIT_MAX_MS) throw new Error(`--fill-wait-ms musí být 10000–${DEMO_FILL_WAIT_MAX_MS}`);
  const options: RecordPendingOptions = { slPoints, tpPoints, fillWaitMs };
  return { ...base, options, scenarios: names.map(name => pendingScenario(name, options)) };
}

const farLimit: DemoPriceRef = { from: 'market', ratio: -DEMO_FAR_RATIO };
const farStop: DemoPriceRef = { from: 'market', ratio: DEMO_FAR_RATIO };
const pendingOso = (ticket: string, entry: DemoOsoTicket['entry'], options: RecordPendingOptions, quantity = 1, tpExtra = 0): DemoOsoTicket => ({
  ticket, quantity, entry,
  stopLoss: { from: 'entry', points: -options.slPoints },
  takeProfit: { from: 'entry', points: options.tpPoints + tpExtra },
});

export function pendingScenario(name: PendingScenarioName, options: RecordPendingOptions): DemoScenario {
  switch (name) {
    case 'move-entry-limit':
      return {
        name,
        purpose: 'R1 (C5a): posun ceny rodiče OSO (Limit) −4/+8 b — posunou se Suspended nohy relativně o Δ? stream-replaced? zrušení rodiče zruší nohy',
        steps: [
          { kind: 'place-oso', label: 'Buy Limit 1 daleko (1,5 %)', tickets: [pendingOso('t1', { orderType: 'Limit', price: farLimit }, options)], observeMs: [500] },
          {
            kind: 'modify', label: 'rodič −4 b', changes: [{ target: { ticket: 't1', order: 'entry' }, price: { from: 'current', points: -PENDING_MOVE_POINTS } }],
            observeMs: [300, 1_500], classify: { name: 'relative-leg-move', ticket: 't1' },
          },
          {
            kind: 'modify', label: 'rodič +8 b', changes: [{ target: { ticket: 't1', order: 'entry' }, price: { from: 'current', points: 2 * PENDING_MOVE_POINTS } }],
            observeMs: [300, 1_500], classify: { name: 'relative-leg-move', ticket: 't1' },
          },
          { kind: 'cancel', label: 'zrušit rodiče', targets: [{ ticket: 't1', order: 'entry' }], observeMs: [500, 2_000], classify: { name: 'cascade', ticket: 't1' } },
        ],
      };
    case 'move-entry-stop':
      return {
        name,
        purpose: 'R2 (C5a): Stop vstup — relativní posun nohou ±4 b; posun přes trh: InvalidPrice, nebo spuštění (pak liquidate)',
        steps: [
          { kind: 'place-oso', label: 'Stop vstup 1 daleko (1,5 %)', tickets: [pendingOso('t1', { orderType: 'Stop', price: farStop }, options)], observeMs: [500] },
          {
            kind: 'modify', label: 'Stop −4 b', changes: [{ target: { ticket: 't1', order: 'entry' }, price: { from: 'current', points: -PENDING_MOVE_POINTS } }],
            observeMs: [300, 1_500], classify: { name: 'relative-leg-move', ticket: 't1' },
          },
          {
            kind: 'modify', label: 'Stop +4 b', changes: [{ target: { ticket: 't1', order: 'entry' }, price: { from: 'current', points: PENDING_MOVE_POINTS } }],
            observeMs: [300, 1_500], classify: { name: 'relative-leg-move', ticket: 't1' },
          },
          {
            kind: 'modify', label: 'Stop přes trh (trh − 10 b u Buy)',
            changes: [{ target: { ticket: 't1', order: 'entry' }, price: { from: 'market', points: -PENDING_THROUGH_MARKET_POINTS }, throughMarket: true }],
            observeMs: [300, 1_500, 3_000], classify: { name: 'through-market-entry', ticket: 't1' },
          },
          { kind: 'cancel', label: 'zrušit vstup (pokud běží)', targets: [{ ticket: 't1', order: 'entry' }], onlyIfOpen: true, observeMs: [500, 2_000], classify: { name: 'cascade', ticket: 't1' } },
          { kind: 'liquidate', label: 'liquidate (pokud se vstup spustil)', ref: 'liq', observeMs: [500, 2_000], classify: { name: 'liquidate-cancels-all' } },
        ],
      };
    case 'move-suspended-legs':
      return {
        name,
        purpose: 'R3 (C5b): modify Suspended SL/TP čekajícího Limit vstupu (zvlášť i souběžně); SL čekajícího Stop vstupu mezi trh a vstup; zrušení rodiče zruší nohy s novou cenou',
        steps: [
          {
            kind: 'place-oso', label: 'Limit vstup 1 daleko', tickets: [pendingOso('t1', { orderType: 'Limit', price: farLimit }, options)],
            observeMs: [500], classify: { name: 'independent-pairs', tickets: ['t1'] },
          },
          {
            kind: 'modify', label: 'Suspended SL −4 b', changes: [{ target: { ticket: 't1', order: 'sl' }, price: { from: 'current', points: -PENDING_MOVE_POINTS } }],
            observeMs: [300, 1_500], classify: { name: 'suspended-modify', ticket: 't1', order: 'sl' },
          },
          {
            kind: 'modify', label: 'Suspended TP +4 b', changes: [{ target: { ticket: 't1', order: 'tp' }, price: { from: 'current', points: PENDING_MOVE_POINTS } }],
            observeMs: [300, 1_500], classify: { name: 'suspended-modify', ticket: 't1', order: 'tp' },
          },
          {
            kind: 'modify', label: 'Suspended SL −4 b a TP +4 b souběžně',
            changes: [
              { target: { ticket: 't1', order: 'sl' }, price: { from: 'current', points: -PENDING_MOVE_POINTS } },
              { target: { ticket: 't1', order: 'tp' }, price: { from: 'current', points: PENDING_MOVE_POINTS } },
            ],
            observeMs: [300, 1_500], classify: { name: 'suspended-modify', ticket: 't1' },
          },
          { kind: 'place-oso', label: 'Stop vstup 1 daleko', tickets: [pendingOso('t2', { orderType: 'Stop', price: farStop }, options)], observeMs: [500] },
          {
            kind: 'modify', label: 'Suspended SL Stop vstupu mezi trh a vstup (přes trh, dokud je Suspended)',
            changes: [{ target: { ticket: 't2', order: 'sl' }, price: { from: 'market', ratio: PENDING_SUSPENDED_SL_RATIO }, throughMarket: true }],
            observeMs: [300, 1_500], classify: { name: 'suspended-modify', ticket: 't2', order: 'sl' },
          },
          { kind: 'cancel', label: 'zrušit rodiče t1', targets: [{ ticket: 't1', order: 'entry' }], observeMs: [500, 2_000], classify: { name: 'cascade', ticket: 't1' } },
          { kind: 'cancel', label: 'zrušit rodiče t2', targets: [{ ticket: 't2', order: 'entry' }], observeMs: [500, 2_000], classify: { name: 'cascade', ticket: 't2' } },
        ],
      };
    case 'suspended-legs-then-fill':
      return {
        name,
        purpose: 'R4 (C5b): Limit na trhu, hned modify Suspended SL/TP, po fillu pracují nohy s NOVOU cenou a qty 1? (bez fillu neprůkazné)',
        steps: [
          { kind: 'place-oso', label: 'Limit 1 na trhu', tickets: [pendingOso('t1', { orderType: 'Limit', price: { from: 'market', points: 0, marketable: true } }, options)] },
          {
            kind: 'modify', label: 'hned SL −4 b a TP +4 b (Suspended)',
            changes: [
              { target: { ticket: 't1', order: 'sl' }, price: { from: 'current', points: -PENDING_MOVE_POINTS } },
              { target: { ticket: 't1', order: 'tp' }, price: { from: 'current', points: PENDING_MOVE_POINTS } },
            ],
          },
          { kind: 'wait-fill', label: 'čekat na fill', ticket: 't1', timeoutMs: options.fillWaitMs },
          { kind: 'observe', label: 'po fillu', observeMs: [500, 2_000], classify: { name: 'fill-with-modified-legs', ticket: 't1' } },
          { kind: 'cancel', label: 'zrušit vstup (pokud se nevyplnil)', targets: [{ ticket: 't1', order: 'entry' }], onlyIfOpen: true, observeMs: [500] },
          { kind: 'liquidate', label: 'liquidate', ref: 'liq', observeMs: [500, 2_000], classify: { name: 'liquidate-cancels-all' } },
        ],
      };
    case 'parent-qty':
      return {
        name,
        purpose: 'R5 (C5c, jen poznání): orderQty rodiče OSO 2→1→2 — jdou qty Suspended nohou s rodičem?',
        steps: [
          { kind: 'place-oso', label: 'Limit 2 daleko', tickets: [pendingOso('t1', { orderType: 'Limit', price: farLimit }, options, 2)], observeMs: [500] },
          {
            kind: 'modify', label: 'rodič qty 2→1', changes: [{ target: { ticket: 't1', order: 'entry' }, quantity: 1 }],
            observeMs: [300, 1_500], classify: { name: 'parent-qty', ticket: 't1', quantity: 1 },
          },
          {
            kind: 'modify', label: 'rodič qty 1→2', changes: [{ target: { ticket: 't1', order: 'entry' }, quantity: 2 }],
            observeMs: [300, 1_500], classify: { name: 'parent-qty', ticket: 't1', quantity: 2 },
          },
          { kind: 'cancel', label: 'zrušit rodiče', targets: [{ ticket: 't1', order: 'entry' }], observeMs: [500, 2_000], classify: { name: 'cascade', ticket: 't1' } },
        ],
      };
    case 'multi-pending': {
      const ladderSl: DemoPriceRef = { from: 'market', ratio: -DEMO_FAR_RATIO, points: -(PENDING_LADDER_STEP_POINTS + options.slPoints) };
      const ladderTp: DemoPriceRef = { from: 'market', ratio: -DEMO_FAR_RATIO, points: options.tpPoints };
      return {
        name,
        purpose: 'R6a+R6c (C18a/b, C5d) = exits split-limit (C3): dva OSO z flat souběžně — nezávislé páry, zrušení jednoho zruší jen jeho nohy, ACK/pořadí/429',
        steps: [
          {
            kind: 'place-oso', label: 'kolo A: dva Limit OSO souběžně, stejná cena, TP2 o 20 b dál',
            tickets: [
              pendingOso('a1', { orderType: 'Limit', price: farLimit }, options),
              pendingOso('a2', { orderType: 'Limit', price: farLimit }, options, 1, 20),
            ],
            observeMs: [500, 1_500], classify: { name: 'independent-pairs', tickets: ['a1', 'a2'] },
          },
          {
            kind: 'cancel', label: 'kolo A: zrušit vstup a1', targets: [{ ticket: 'a1', order: 'entry' }],
            observeMs: [500, 2_000], classify: { name: 'cancel-one-of-many', ticket: 'a1', tickets: ['a2'] },
          },
          { kind: 'cancel', label: 'kolo A: zrušit vstup a2', targets: [{ ticket: 'a2', order: 'entry' }], observeMs: [500, 2_000], classify: { name: 'cascade', ticket: 'a2' } },
          {
            kind: 'place-oso', label: 'kolo B: žebřík dvou Limit OSO souběžně (o 10 b), stejné SL/TP',
            tickets: [
              { ticket: 'b1', quantity: 1, entry: { orderType: 'Limit', price: farLimit }, stopLoss: ladderSl, takeProfit: ladderTp },
              { ticket: 'b2', quantity: 1, entry: { orderType: 'Limit', price: { ...farLimit, points: -PENDING_LADDER_STEP_POINTS } }, stopLoss: ladderSl, takeProfit: ladderTp },
            ],
            observeMs: [500, 1_500], classify: { name: 'independent-pairs', tickets: ['b1', 'b2'] },
          },
          {
            kind: 'cancel', label: 'kolo B: zrušit bližší příčku b1', targets: [{ ticket: 'b1', order: 'entry' }],
            observeMs: [500, 2_000], classify: { name: 'cancel-one-of-many', ticket: 'b1', tickets: ['b2'] },
          },
          { kind: 'cancel', label: 'kolo B: zrušit b2', targets: [{ ticket: 'b2', order: 'entry' }], observeMs: [500, 2_000], classify: { name: 'cascade', ticket: 'b2' } },
        ],
      };
    }
  }
}
