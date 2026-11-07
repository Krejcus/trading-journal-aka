/**
 * DEMO záznam pro volitelné SL/TP (`docs/reviews/instant-legs-design-20261106.md`): holý Limit,
 * samostatná noha, přidání druhé nohy, zrušení jedné nohy OCO a čekající Limit. Čisté scénáře pro
 * `record-legs.ts`, nic se tu neposílá. Nohy jsou aspoň 40 b od trhu, aby se samy nespustily.
 */
import {
  DEMO_FAR_RATIO,
  DEMO_MIN_BRACKET_POINTS,
  DEMO_MAX_SL_RATIO,
  cliNumber,
  parseDemoBaseArgs,
  parseScenarioList,
  type DemoPriceRef,
  type DemoRecordPlan,
  type DemoScenario,
  type DemoStep,
} from './recordDemoPlan';

export const LEGS_SCENARIOS = [
  'bare-limit-cancel', 'bare-limit-cancel-race', 'bare-limit-fill-oco', 'bare-market-liquidate', 'limit-replace',
  'lone-stop-liquidate', 'lone-limit-liquidate', 'lone-stop-opposite-close', 'lone-stop-then-oco', 'lone-stop-cancel-then-oco',
  'lone-limit-cancel-then-oco', 'oco-cancel-sl', 'oco-cancel-tp', 'pending-leg-cancel',
] as const;
export type LegsScenarioName = typeof LEGS_SCENARIOS[number];

export interface RecordLegsOptions { slPoints: number; tpPoints: number }

export function parseRecordLegsArgs(argv: readonly string[]): DemoRecordPlan & { options: RecordLegsOptions } {
  const base = parseDemoBaseArgs(argv);
  const names = parseScenarioList(argv, LEGS_SCENARIOS, {}) as LegsScenarioName[];
  const slPoints = cliNumber(argv, 'sl-points', DEMO_MIN_BRACKET_POINTS);
  const tpPoints = cliNumber(argv, 'tp-points', DEMO_MIN_BRACKET_POINTS);
  if (!(slPoints >= DEMO_MIN_BRACKET_POINTS) || !(slPoints <= base.marketPrice * DEMO_MAX_SL_RATIO)) {
    throw new Error(`--sl-points musí být ${DEMO_MIN_BRACKET_POINTS}–${Math.floor(base.marketPrice * DEMO_MAX_SL_RATIO)}`);
  }
  if (!(tpPoints >= DEMO_MIN_BRACKET_POINTS) || !(tpPoints <= base.marketPrice * 0.02)) throw new Error('--tp-points mimo rozsah');
  for (const [name, value] of [['sl-points', slPoints], ['tp-points', tpPoints]] as const) {
    if (Math.abs(value * 4 - Math.round(value * 4)) > 1e-9) throw new Error(`--${name} musí být na tick 0,25`);
  }
  const options = { slPoints, tpPoints };
  return { ...base, options, scenarios: names.map(name => legsScenario(name, options)) };
}

const FAR: DemoPriceRef = { from: 'market', ratio: -DEMO_FAR_RATIO };
const bareMarket: DemoStep = { kind: 'place-order', label: 'holý Market 1', ref: 'bare', side: 'position', orderType: 'Market', quantity: 1, bare: true };
const filled: DemoStep = { kind: 'wait-net', label: 'pozice 1', net: 1, timeoutMs: 10_000 };
const liquidate = (ref = 'liq'): DemoStep => ({ kind: 'liquidate', label: 'liquidate', ref, observeMs: [500, 2_000], classify: { name: 'liquidate-cancels-all' } });

export function legsScenario(name: LegsScenarioName, options: RecordLegsOptions): DemoScenario {
  const { slPoints, tpPoints } = options;
  const oco: DemoStep = { kind: 'place-oco', label: 'SL + TP spojené OCO', ticket: 't1', slPoints, tpPoints, quantity: 1, observeMs: [300, 1_500] };
  switch (name) {
    case 'bare-limit-cancel':
      return {
        name,
        purpose: 'Holý Limit: tvar eventů proti ACK (P1-1 korelátor) a zrušení před fillem.',
        steps: [
          { kind: 'place-order', label: 'holý Limit 1 daleko', ref: 'lim', side: 'position', orderType: 'Limit', price: FAR, quantity: 1, bare: true, observeMs: [0, 300, 1_500, 6_000] },
          { kind: 'cancel', label: 'zrušit Limit', targets: [{ plain: 'lim' }], observeMs: [300, 1_500] },
          { kind: 'require-flat', label: 'flat bez příkazů' },
        ],
      };
    case 'bare-limit-cancel-race':
      return {
        name,
        purpose: 'Holý marketable Limit a okamžité zrušení: závod × proti fillu, pořadí Fill a Canceled, co vrátí cancelOrder.',
        steps: [
          { kind: 'place-order', label: 'holý marketable Limit 1', ref: 'lim', side: 'position', orderType: 'Limit', price: { from: 'market', points: 2, marketable: true }, quantity: 1, bare: true },
          { kind: 'cancel', label: 'hned zrušit', targets: [{ plain: 'lim' }], observeMs: [300, 1_500] },
          liquidate(),
        ],
      };
    case 'bare-market-liquidate':
      return {
        name,
        purpose: 'Liquidate holé pozice bez nohou: tvar a čas.',
        steps: [bareMarket, filled, { kind: 'observe', label: 'tvar', observeMs: [500] }, liquidate()],
      };
    case 'bare-limit-fill-oco':
      return {
        name,
        purpose: 'Holý Limit se vyplní a hned dostane OCO: latence attach po fillu, cesta „worker pošle nohy až po fillu“.',
        steps: [
          { kind: 'place-order', label: 'holý marketable Limit 1', ref: 'lim', side: 'position', orderType: 'Limit', price: { from: 'market', points: 2, marketable: true }, quantity: 1, bare: true },
          filled,
          { kind: 'observe', label: 'tvar po fillu', observeMs: [0, 500] },
          oco,
          liquidate(),
        ],
      };
    case 'limit-replace':
      return {
        name,
        purpose: 'Přidání nohou k čekajícímu Limitu oklikou: zrušit a založit OSO. Časy zrušení a ACK OSO; cena se přepočítá, místo ve frontě ani fill v díře to neměří.',
        steps: [
          { kind: 'place-order', label: 'holý Limit 1 daleko', ref: 'lim', side: 'position', orderType: 'Limit', price: FAR, quantity: 1, bare: true, observeMs: [500] },
          { kind: 'cancel', label: 'zrušit Limit', targets: [{ plain: 'lim' }], abortIfFailed: true },
          {
            kind: 'place-oso', label: 'Limit OSO',
            tickets: [{ ticket: 't1', quantity: 1, entry: { orderType: 'Limit', price: FAR }, stopLoss: { from: 'entry', points: -slPoints }, takeProfit: { from: 'entry', points: tpPoints } }],
            observeMs: [300, 1_500],
          },
          { kind: 'cancel', label: 'zrušit vstup OSO', targets: [{ ticket: 't1', order: 'entry' }], observeMs: [500, 2_000], classify: { name: 'cascade', ticket: 't1' } },
          { kind: 'require-flat', label: 'flat bez příkazů' },
        ],
      };
    case 'lone-stop-liquidate':
    case 'lone-limit-liquidate': {
      const leg = name === 'lone-stop-liquidate' ? 'stop' : 'limit';
      return {
        name,
        purpose: `Zruší liquidate samostatný ${leg === 'stop' ? 'Stop' : 'Limit'} bez OCO, nebo zůstane viset? Tvar eventů proti korelátorům.`,
        steps: [
          bareMarket, filled,
          { kind: 'place-exit', label: `samostatný ${leg === 'stop' ? 'SL' : 'TP'}`, ref: 'leg', leg, points: leg === 'stop' ? slPoints : tpPoints, quantity: 1, observeMs: [0, 300, 2_000] },
          liquidate(),
        ],
      };
    }
    case 'lone-stop-opposite-close':
      return {
        name,
        purpose: 'Pozice se zavře opačným Marketem: zůstane samostatný Stop pracovat a mohl by otevřít novou pozici?',
        steps: [
          bareMarket, filled,
          { kind: 'place-exit', label: 'samostatný SL', ref: 'leg', leg: 'stop', points: slPoints, quantity: 1, observeMs: [500] },
          { kind: 'place-order', label: 'opačný Market 1', ref: 'close', side: 'opposite', orderType: 'Market', quantity: 1, reducing: true },
          { kind: 'wait-net', label: 'flat', net: 0, timeoutMs: 10_000 },
          { kind: 'observe', label: 'Stop po zavření', observeMs: [300, 2_000] },
          { kind: 'cancel', label: 'zrušit zbylý Stop', targets: [{ plain: 'leg' }], onlyIfOpen: true, observeMs: [500] },
        ],
      };
    case 'lone-stop-then-oco':
      return {
        name,
        purpose: 'Přijme broker OCO vedle pracujícího Stopu? Délka dvojího SL. Nespouštět kolem zpráv: při pohybu 40 b by se mohla pozice otočit (úklid ji zavře).',
        steps: [
          bareMarket, filled,
          { kind: 'place-exit', label: 'samostatný SL', ref: 'leg', leg: 'stop', points: slPoints, quantity: 1 },
          { kind: 'place-oco', label: 'OCO vedle SL', ticket: 't1', slPoints, tpPoints, quantity: 1, overlapExit: true },
          { kind: 'cancel', label: 'zrušit starý SL', targets: [{ plain: 'leg' }], observeMs: [300, 1_500] },
          { kind: 'observe', label: 'zůstává jen OCO', observeMs: [0, 1_000] },
          liquidate(),
        ],
      };
    case 'lone-stop-cancel-then-oco':
    case 'lone-limit-cancel-then-oco': {
      const leg = name === 'lone-stop-cancel-then-oco' ? 'stop' : 'limit';
      return {
        name,
        purpose: `Přidání druhé nohy v pořadí zrušit a založit (${leg === 'stop' ? 'SL' : 'TP'} → SL + TP): délka díry bez nohy.`,
        steps: [
          bareMarket, filled,
          { kind: 'place-exit', label: `samostatný ${leg === 'stop' ? 'SL' : 'TP'}`, ref: 'leg', leg, points: leg === 'stop' ? slPoints : tpPoints, quantity: 1, observeMs: [500] },
          { kind: 'cancel', label: 'zrušit starou nohu', targets: [{ plain: 'leg' }], abortIfFailed: true },
          { kind: 'place-oco', label: 'SL + TP spojené OCO', ticket: 't1', slPoints, tpPoints, quantity: 1, observeMs: [300, 1_500] },
          liquidate(),
        ],
      };
    }
    case 'oco-cancel-sl':
    case 'oco-cancel-tp': {
      const order = name === 'oco-cancel-sl' ? 'sl' : 'tp';
      return {
        name,
        purpose: `× na ${order === 'sl' ? 'SL' : 'TP'}: zruší zrušení jedné nohy OCO i partnera?`,
        steps: [
          bareMarket, filled, oco,
          {
            kind: 'cancel', label: `zrušit jen ${order === 'sl' ? 'SL' : 'TP'}`, targets: [{ ticket: 't1', order }],
            observeMs: [300, 1_500, 4_000], classify: { name: 'oco-partner-after-cancel', ticket: 't1', order },
          },
          liquidate(),
        ],
      };
    }
    case 'pending-leg-cancel':
      return {
        name,
        purpose: '× na noze čekajícího Limitu OSO: co se stane se vstupem a partnerem?',
        steps: [
          {
            kind: 'place-oso', label: 'Limit OSO daleko',
            tickets: [{ ticket: 't1', quantity: 1, entry: { orderType: 'Limit', price: FAR }, stopLoss: { from: 'entry', points: -slPoints }, takeProfit: { from: 'entry', points: tpPoints } }],
            observeMs: [500],
          },
          {
            kind: 'cancel', label: 'zrušit jen TP čekajícího vstupu', targets: [{ ticket: 't1', order: 'tp' }],
            observeMs: [300, 1_500, 4_000], classify: { name: 'oco-partner-after-cancel', ticket: 't1', order: 'tp' },
          },
          { kind: 'cancel', label: 'zrušit vstup', targets: [{ ticket: 't1', order: 'entry' }], onlyIfOpen: true, observeMs: [500, 2_000] },
          { kind: 'cancel', label: 'zrušit zbylé SL', targets: [{ ticket: 't1', order: 'sl' }], onlyIfOpen: true, observeMs: [500] },
          { kind: 'require-flat', label: 'flat bez příkazů' },
        ],
      };
  }
}
