/**
 * C0 DEMO conformance výstupů z pozice (`docs/reviews/trading-gaps-designs/exits.md`
 * §0.6 + posudek critic P3): čisté scénáře pro `record-exits.ts`. Kvůli stropu
 * qty ≤ 2 jsou scénáře zmenšené (resize 3→2 je tady 2→1). Nic se tu neposílá.
 *
 * Překryvy (nahrává se jednou):
 * - `split-limit` (dva čekající Limit OSO z flat, C3) = R6 v `record-pending.ts --scenario multi-pending`;
 * - R7 `per-ticket-exit` (pending) = `tp-fill --placement sequential` tady.
 * - `stop-hit` se nenahrává: nedeterministický a SL 10 ticků porušuje pojistku SL ≥ 40 b.
 */
import {
  DEMO_MIN_BRACKET_POINTS,
  DEMO_MAX_SL_RATIO,
  DEMO_QUIET_MAX_MS,
  DEMO_QUIET_MS,
  cliNumber,
  cliValue,
  parseDemoBaseArgs,
  parseScenarioList,
  type DemoOsoTicket,
  type DemoPriceRef,
  type DemoRecordPlan,
  type DemoScenario,
  type DemoStep,
} from './recordDemoPlan';

export const EXITS_SCENARIOS = ['resize', 'resize-one-leg', 'ticket-cancel', 'tp-fill', 'reverse'] as const;
export type ExitsScenarioName = typeof EXITS_SCENARIOS[number];

export const EXITS_ELSEWHERE: Readonly<Record<string, string>> = {
  'split-limit': 'nahrává se jednou jako R6 — spusť record-pending.ts --scenario multi-pending',
  'stop-hit': 'nenahrává se (nedeterministický; SL 10 ticků porušuje pojistku SL ≥ 40 b)',
};

export const EXITS_REVERSE_MAX_REPEAT = 5;
export const EXITS_GAP_MIN_MS = 300;
export const EXITS_GAP_MAX_MS = 6_000;
/** TP2 v `tp-fill` je o tolik dál než TP1. */
export const EXITS_TP2_EXTRA_POINTS = 20;
/** Vlastní SL přikoupení v `tp-fill --placement sequential` (C18c) je o tolik dál. */
export const EXITS_ADD_SL_EXTRA_POINTS = 4;
/** Marketable TP: o tolik za trh (Buy: Sell Limit 2 b pod trhem). */
export const EXITS_MARKETABLE_POINTS = 2;

export interface RecordExitsOptions {
  slPoints: number;
  tpPoints: number;
  tpMarket: boolean;
  placement: 'concurrent' | 'sequential';
  repeat: number;
  tickets: 1 | 2;
  gapMs: number | null;
}

export function parseRecordExitsArgs(argv: readonly string[]): DemoRecordPlan & { options: RecordExitsOptions } {
  const base = parseDemoBaseArgs(argv);
  const names = parseScenarioList(argv, EXITS_SCENARIOS, EXITS_ELSEWHERE) as ExitsScenarioName[];
  const slPoints = cliNumber(argv, 'sl-points', DEMO_MIN_BRACKET_POINTS);
  const tpPoints = cliNumber(argv, 'tp-points', DEMO_MIN_BRACKET_POINTS);
  if (!(slPoints >= DEMO_MIN_BRACKET_POINTS) || !(slPoints <= base.marketPrice * DEMO_MAX_SL_RATIO)) {
    throw new Error(`--sl-points musí být ${DEMO_MIN_BRACKET_POINTS}–${Math.floor(base.marketPrice * DEMO_MAX_SL_RATIO)}`);
  }
  if (!(tpPoints >= DEMO_MIN_BRACKET_POINTS) || !(tpPoints <= base.marketPrice * 0.02)) throw new Error(`--tp-points musí být ${DEMO_MIN_BRACKET_POINTS}–${Math.floor(base.marketPrice * 0.02)}`);
  for (const [name, value] of [['sl-points', slPoints], ['tp-points', tpPoints]] as const) {
    if (Math.abs(value * 4 - Math.round(value * 4)) > 1e-9) throw new Error(`--${name} musí být na tick 0,25`);
  }
  const placement = cliValue(argv, 'placement') ?? 'concurrent';
  if (placement !== 'concurrent' && placement !== 'sequential') throw new Error('--placement musí být concurrent nebo sequential');
  const repeat = cliNumber(argv, 'repeat', 3);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > EXITS_REVERSE_MAX_REPEAT) throw new Error(`--repeat musí být 1–${EXITS_REVERSE_MAX_REPEAT}`);
  const tickets = cliNumber(argv, 'tickets', 1);
  if (tickets !== 1 && tickets !== 2) throw new Error('--tickets musí být 1 nebo 2');
  const gapRaw = cliValue(argv, 'gap-ms');
  const gapMs = gapRaw === undefined ? null : cliNumber(argv, 'gap-ms');
  if (gapMs != null && (!Number.isInteger(gapMs) || gapMs < EXITS_GAP_MIN_MS || gapMs > EXITS_GAP_MAX_MS)) {
    throw new Error(`--gap-ms musí být ${EXITS_GAP_MIN_MS}–${EXITS_GAP_MAX_MS}`);
  }
  const options: RecordExitsOptions = { slPoints, tpPoints, tpMarket: argv.includes('--tp-market'), placement, repeat, tickets, gapMs };
  return { ...base, options, scenarios: names.map(name => exitsScenario(name, options)) };
}

const market = (points: number): DemoPriceRef => ({ from: 'market', points });
const marketOso = (ticket: string, quantity: number, options: RecordExitsOptions, extra: { tpExtra?: number; slExtra?: number; side?: 'position' | 'opposite' } = {}): DemoOsoTicket => ({
  ticket, quantity, ...(extra.side ? { side: extra.side } : {}),
  entry: { orderType: 'Market' },
  stopLoss: market(-(options.slPoints + (extra.slExtra ?? 0))),
  takeProfit: market(options.tpPoints + (extra.tpExtra ?? 0)),
});
const liquidateAll = (ref = 'liq'): DemoStep => ({
  kind: 'liquidate', label: 'liquidate', ref, observeMs: [500, 2_000], classify: { name: 'liquidate-cancels-all' },
});

export function exitsScenario(name: ExitsScenarioName, options: RecordExitsOptions): DemoScenario {
  switch (name) {
    case 'resize':
      return {
        name,
        purpose: 'C2: přijme Tradovate modifyorder s jinou orderQty u nohy OSO (2→1)? Změní partnera OCO? Nechá Market redukce nohy beze změny?',
        steps: [
          { kind: 'place-oso', label: 'Market OSO 2', tickets: [marketOso('t1', 2, options)] },
          { kind: 'wait-net', label: 'vstup vyplněn', net: 2, timeoutMs: 10_000 },
          { kind: 'observe', label: 'tvar po vstupu' },
          {
            kind: 'modify', label: 'SL 2→1 a TP 2→1 souběžně (ceny beze změny)',
            changes: [{ target: { ticket: 't1', order: 'sl' }, quantity: 1 }, { target: { ticket: 't1', order: 'tp' }, quantity: 1 }],
            observeMs: [300, 1_500], classify: { name: 'leg-resize', ticket: 't1', quantity: 1 },
          },
          {
            kind: 'place-order', label: 'Market redukce 1 (jen po potvrzených nohách)', ref: 'r1', side: 'opposite', orderType: 'Market',
            quantity: 1, reducing: true, onlyIfLegsQuantity: { ticket: 't1', quantity: 1 },
          },
          { kind: 'wait-net', label: 'pozice 1', net: 1, timeoutMs: 10_000, optional: true },
          { kind: 'observe', label: 'nohy po Market redukci', observeMs: [500, 2_000], classify: { name: 'ticket-intact', ticket: 't1', quantity: 1 } },
          liquidateAll(),
        ],
      };
    case 'resize-one-leg':
      return {
        name,
        purpose: 'C2 (critic P3): modify jen SL 2→1 — upraví Tradovate sám qty partnera TP?',
        steps: [
          { kind: 'place-oso', label: 'Market OSO 2', tickets: [marketOso('t1', 2, options)] },
          { kind: 'wait-net', label: 'vstup vyplněn', net: 2, timeoutMs: 10_000 },
          { kind: 'observe', label: 'tvar po vstupu' },
          {
            kind: 'modify', label: 'jen SL 2→1', changes: [{ target: { ticket: 't1', order: 'sl' }, quantity: 1 }],
            observeMs: [300, 1_500, 4_000], classify: { name: 'leg-resize', ticket: 't1', order: 'sl', quantity: 1 },
          },
          liquidateAll(),
        ],
      };
    case 'ticket-cancel':
      return {
        name,
        purpose: 'C2: zruší zrušení jedné nohy OCO i partnera? Co vrátí cancel už zrušeného příkazu? Zůstane lístek 1 beze změny po Market redukci?',
        steps: [
          { kind: 'place-oso', label: 'lístek 1: Market OSO 1', tickets: [marketOso('t1', 1, options)] },
          { kind: 'wait-net', label: 'lístek 1 vyplněn', net: 1, timeoutMs: 10_000 },
          { kind: 'place-oso', label: 'lístek 2: Market OSO 1', tickets: [marketOso('t2', 1, options)] },
          { kind: 'wait-net', label: 'lístek 2 vyplněn', net: 2, timeoutMs: 10_000 },
          { kind: 'observe', label: 'tvar 2 lístků' },
          {
            kind: 'cancel', label: 'zrušit jen SL lístku 2', targets: [{ ticket: 't2', order: 'sl' }],
            observeMs: [300, 1_500, 4_000], classify: { name: 'oco-partner-after-cancel', ticket: 't2', order: 'sl' },
          },
          { kind: 'cancel', label: 'zrušit znovu už zrušený SL lístku 2', targets: [{ ticket: 't2', order: 'sl' }], observeMs: [500] },
          { kind: 'cancel', label: 'zrušit zbytek lístku 2 (TP, pokud běží)', targets: [{ ticket: 't2', order: 'tp' }], onlyIfOpen: true, observeMs: [500] },
          { kind: 'place-order', label: 'Market redukce 1', ref: 'r1', side: 'opposite', orderType: 'Market', quantity: 1, reducing: true },
          { kind: 'wait-net', label: 'pozice 1', net: 1, timeoutMs: 10_000, optional: true },
          { kind: 'observe', label: 'lístek 1 po redukci', observeMs: [500, 2_000], classify: { name: 'ticket-intact', ticket: 't1', quantity: 1 } },
          liquidateAll(),
        ],
      };
    case 'tp-fill': {
      const sequential = options.placement === 'sequential';
      const filled = sequential ? 't2' : 't1';
      const other = sequential ? 't1' : 't2';
      const t1 = marketOso('t1', 1, options);
      const t2 = marketOso('t2', 1, options, { tpExtra: EXITS_TP2_EXTRA_POINTS, ...(sequential ? { slExtra: EXITS_ADD_SL_EXTRA_POINTS } : {}) });
      const placement: DemoStep[] = sequential
        ? [
            { kind: 'place-oso', label: 'základ: Market OSO 1', tickets: [t1] },
            { kind: 'wait-net', label: 'základ vyplněn', net: 1, timeoutMs: 10_000 },
            { kind: 'place-oso', label: 'přikoupení: Market OSO 1 s vlastním SL/TP', tickets: [t2] },
          ]
        : [{ kind: 'place-oso', label: 'dva Market OSO 1 souběžně (TP1, TP2 o 20 b dál)', tickets: [t1, t2] }];
      return {
        name,
        purpose: sequential
          ? 'C18c / R7: přikoupení s vlastními nohami — fill jeho TP zruší jen jeho SL, nohy základu beze změny, pozice 1'
          : 'C3: dva OSO z flat souběžně (parentId/ocoId) — fill TP1 zruší jen SL1 (za jak dlouho), SL2/TP2 beze změny, pozice 1',
        steps: [
          ...placement,
          { kind: 'wait-net', label: 'oba lístky vyplněny', net: 2, timeoutMs: 10_000 },
          { kind: 'observe', label: 'tvar 2 lístků', observeMs: [0, 1_000] },
          {
            kind: 'modify',
            label: options.tpMarket ? `TP lístku ${filled} → Market (C2-T)` : `TP lístku ${filled} → marketable (trh − 2 b)`,
            changes: [options.tpMarket
              ? { target: { ticket: filled, order: 'tp' }, orderType: 'Market' }
              : { target: { ticket: filled, order: 'tp' }, price: { from: 'market', points: -EXITS_MARKETABLE_POINTS, marketable: true } }],
          },
          { kind: 'wait-net', label: 'pozice 1 po fillu TP', net: 1, timeoutMs: 10_000, optional: true },
          {
            kind: 'observe', label: 'po fillu TP', observeMs: [0, 250, 1_000, 3_000],
            classify: { name: 'tp-fill', ticket: filled, tickets: [other], quantity: 1 },
          },
          liquidateAll(),
        ],
      };
    }
    case 'reverse':
      return reverseScenario(options);
  }
}

/**
 * C4: „ocas“ eventů po liquidateposition. Bez `--gap-ms` každé opakování
 * zapisuje až do 6 s ticha. S `--gap-ms X` jde po X ms od liquidate (a po REST
 * flat bez příkazů) Market OSO opačně — záznam ukáže, jestli po prvním eventu
 * nového vstupu přišel ještě event zavření; poslední liquidate měří ocas.
 */
function reverseScenario(options: RecordExitsOptions): DemoScenario {
  const steps: DemoStep[] = [];
  const tickets = (rep: number, side: 'position' | 'opposite') => Array.from({ length: options.tickets }, (_, index) =>
    marketOso(`r${rep}t${index + 1}`, 1, options, { side }));
  const sideOf = (rep: number): 'position' | 'opposite' => (options.gapMs != null && rep % 2 === 0 ? 'opposite' : 'position');
  const tail = (rep: number): DemoStep[] => [
    { kind: 'wait-quiet', label: `opakování ${rep}: ocas eventů`, liquidate: `liq${rep}`, quietMs: DEMO_QUIET_MS, maxMs: DEMO_QUIET_MAX_MS },
    { kind: 'require-flat', label: `opakování ${rep}: REST flat bez příkazů` },
    { kind: 'observe', label: `opakování ${rep}: po ocasu`, classify: { name: 'liquidate-cancels-all' } },
  ];
  steps.push(
    { kind: 'place-oso', label: 'opakování 1: Market OSO', tickets: tickets(1, 'position') },
    { kind: 'wait-net', label: 'opakování 1: vyplněno', net: options.tickets, timeoutMs: 10_000 },
  );
  for (let rep = 1; rep <= options.repeat; rep += 1) {
    steps.push({ kind: 'liquidate', label: `opakování ${rep}: liquidate`, ref: `liq${rep}` });
    if (rep === options.repeat) { steps.push(...tail(rep)); break; }
    if (options.gapMs == null) {
      steps.push(...tail(rep),
        { kind: 'place-oso', label: `opakování ${rep + 1}: Market OSO`, tickets: tickets(rep + 1, 'position') },
        { kind: 'wait-net', label: `opakování ${rep + 1}: vyplněno`, net: options.tickets, timeoutMs: 10_000 });
    } else {
      steps.push(
        { kind: 'sleep', label: `opakování ${rep}: mezera ${options.gapMs} ms`, ms: options.gapMs },
        { kind: 'require-flat', label: `opakování ${rep}: REST flat bez příkazů před opačným vstupem` },
        { kind: 'place-oso', label: `opakování ${rep + 1}: Market OSO opačně`, tickets: tickets(rep + 1, sideOf(rep + 1)), reverseAfter: `liq${rep}` },
        { kind: 'wait-net', label: `opakování ${rep + 1}: vyplněno`, net: options.tickets, timeoutMs: 10_000 },
      );
    }
  }
  return {
    name: 'reverse',
    purpose: options.gapMs == null
      ? `C4: ocas eventů po liquidate (${options.repeat}×, ${options.tickets} lístek/lístky), kdy se pohne cashBalance`
      : `C4: otočení po ${options.gapMs} ms (${options.repeat}×, ${options.tickets} lístek/lístky) — žádný event zavření po prvním eventu nového vstupu`,
    steps,
  };
}
