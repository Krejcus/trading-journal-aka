import { describe, expect, it } from 'vitest';
import {
  DEMO_RECORD_ACCOUNT_ID,
  armedGateProblems,
  classifyDemo,
  containsSecret,
  demoGateProblems,
  demoPlanProblems,
  demoStartProblems,
  describeDemoPlan,
  dryRunScenario,
  exposureProblem,
  leaderExtraEntities,
  liquidationTail,
  mnqFrontContract,
  modifyProblems,
  osoPlacementProblems,
  parseScenarioList,
  plainOrderProblems,
  redactDemoText,
  resolveDemoPrice,
  reverseOrdering,
  scenarioFills,
  scenarioMaxExposure,
  scenarioStructureProblems,
  thirdFridayUtc,
  type DemoClassifyInput,
  type DemoModifyCheck,
  type DemoObservedOrder,
  type DemoRecordPlan,
  type DemoScenario,
  type DemoStep,
} from '../scripts/copier/recordDemoPlan';

const NOW = Date.UTC(2026, 10, 3, 15, 0);
const ANCHOR = 28_000;
const status = (controller: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  environment: 'demo',
  controller: {
    armed: false, connected: true, killSwitch: false, groupFlat: true, reconciliationRequired: false,
    lastError: null, manualRecovery: null, transportResume: null, divergentAccounts: [], workingOrderAccounts: [],
    ...controller,
  },
  group: { leaderAccountId: DEMO_RECORD_ACCOUNT_ID, manualOnly: true, localOnly: true, followers: [] },
  marketPrices: [{ symbol: 'MNQZ6', price: ANCHOR, at: NOW - 1_000 }],
  ...extra,
});
const marketOso: DemoStep = {
  kind: 'place-oso', label: 'Market', tickets: [{ ticket: 't1', quantity: 1, entry: { orderType: 'Market' }, stopLoss: { from: 'market', points: -40 }, takeProfit: { from: 'market', points: 40 } }],
};
/** Lístek Market OSO kroku (typově přes člen unie `place-oso`, ne přes `never[]`). */
const marketTicket = (marketOso as Extract<DemoStep, { kind: 'place-oso' }>).tickets[0];
const scenario = (steps: DemoStep[]): DemoScenario => ({ name: 'x', purpose: 'test', steps });
const plan = (patch: Partial<DemoRecordPlan> = {}): DemoRecordPlan => ({
  accountId: DEMO_RECORD_ACCOUNT_ID, symbol: 'MNQZ6', side: 'Buy', marketPrice: ANCHOR, confirm: false, allowFill: false,
  scenarios: [scenario([marketOso, { kind: 'liquidate', label: 'liq', ref: 'liq' }])], ...patch,
});

describe('front kontrakt MNQ', () => {
  it('třetí pátek a front podle kalendáře, týden rolování = null', () => {
    expect(new Date(thirdFridayUtc(2026, 11)).toISOString().slice(0, 10)).toBe('2026-12-18');
    expect(mnqFrontContract(NOW)).toBe('MNQZ6');
    expect(mnqFrontContract(Date.UTC(2026, 11, 12))).toBeNull();
    expect(mnqFrontContract(Date.UTC(2026, 11, 21))).toBe('MNQH7');
    expect(mnqFrontContract(Date.UTC(2026, 0, 5))).toBe('MNQH6');
  });
});

describe('ARMED gate a stav workeru', () => {
  it('přesně jako armed-gate.sh: projde jen armed === false', () => {
    expect(armedGateProblems(status())).toEqual([]);
    for (const armed of [true, undefined, null, 'false']) expect(armedGateProblems(status({ armed })).join()).toContain('STOP');
    expect(armedGateProblems(null).join()).toContain('STOP');
  });

  it.each([
    [{ armed: true }, {}, 'ARMED GATE'], [{ killSwitch: true }, {}, 'kill'], [{ transportResume: { phase: 'waiting' } }, {}, 'pokračování'],
    [{ manualRecovery: { id: 'x' } }, {}, 'ruční obnovu'], [{ lastError: 'x' }, {}, 'lastError'],
    [{}, { environment: 'live' }, 'DEMO'], [{}, { group: { leaderAccountId: DEMO_RECORD_ACCOUNT_ID, manualOnly: true, localOnly: true, followers: [{}] } }, 'followery'],
    [{}, { group: { leaderAccountId: 7, manualOnly: true, localOnly: true, followers: [] } }, 'leader'],
    [{}, { group: { leaderAccountId: DEMO_RECORD_ACCOUNT_ID, manualOnly: false, localOnly: true, followers: [] } }, 'manual-only'],
  ])('gate %o %o zastaví', (controller, extra, reason) => {
    expect(demoGateProblems(plan(), status(controller, extra)).join(' ')).toContain(reason);
  });

  it('gate neblokuje kontrolu pozic vyvolanou vlastním záznamem, start ano', () => {
    const afterFill = status({ reconciliationRequired: true, groupFlat: false });
    expect(demoGateProblems(plan(), afterFill)).toEqual([]);
    expect(demoStartProblems(plan(), afterFill, NOW).join(' ')).toContain('kontrolu pozic');
  });

  it('start: čerstvá cena workeru a shoda s --market-price', () => {
    expect(demoStartProblems(plan(), status(), NOW)).toEqual([]);
    expect(demoStartProblems(plan(), status({}, { marketPrices: [] }), NOW).join(' ')).toContain('čerstvou cenu');
    expect(demoStartProblems(plan({ marketPrice: 28_300 }), status(), NOW).join(' ')).toContain('nesedí');
  });
});

describe('statické pojistky plánu', () => {
  it('jen DEMO8661118, jen front kontrakt, mimo rolování', () => {
    expect(demoPlanProblems(plan(), NOW)).toEqual([]);
    expect(demoPlanProblems(plan({ accountId: 12345 }), NOW).join(' ')).toContain('DEMO8661118');
    expect(demoPlanProblems(plan({ symbol: 'MNQH7' }), NOW).join(' ')).toContain('front kontrakt MNQZ6');
    expect(demoPlanProblems(plan(), Date.UTC(2026, 11, 14)).join(' ')).toContain('rolování');
  });

  it('fill bez --allow-fill: dry-run projde, --confirm ne', () => {
    expect(demoPlanProblems(plan({ confirm: false }), NOW)).toEqual([]);
    expect(demoPlanProblems(plan({ confirm: true }), NOW).join(' ')).toContain('--allow-fill');
    expect(demoPlanProblems(plan({ confirm: true, allowFill: true }), NOW)).toEqual([]);
  });

  it('možná pozice > 2 a qty > 2 se odmítne', () => {
    const three = scenario([marketOso, { ...marketOso, tickets: [{ ...marketTicket, ticket: 't2', quantity: 2 }] } as DemoStep]);
    expect(scenarioMaxExposure(three.steps)).toBe(3);
    expect(demoPlanProblems(plan({ scenarios: [three] }), NOW).join(' ')).toContain('možná pozice 3');
    const big = scenario([{ ...marketOso, tickets: [{ ...marketTicket, quantity: 3 }] } as DemoStep]);
    expect(scenarioStructureProblems(big).join(' ')).toContain('qty 3');
  });

  it('expozice: zrušený vstup a liquidate ji snižují, redukce se nepočítá', () => {
    const steps: DemoStep[] = [
      { kind: 'place-oso', label: 'a', tickets: [{ ticket: 'a', quantity: 2, entry: { orderType: 'Limit', price: { from: 'market', ratio: -0.015 } }, stopLoss: { from: 'entry', points: -40 }, takeProfit: { from: 'entry', points: 40 } }] },
      { kind: 'cancel', label: 'c', targets: [{ ticket: 'a', order: 'entry' }] },
      marketOso,
      { kind: 'place-order', label: 'r', ref: 'r', side: 'opposite', orderType: 'Market', quantity: 1, reducing: true },
      { kind: 'liquidate', label: 'l', ref: 'l' },
      { ...marketOso, tickets: [{ ...marketTicket, ticket: 't9', quantity: 2 }] } as DemoStep,
    ];
    expect(scenarioMaxExposure(steps)).toBe(2);
    expect(scenarioFills(steps)).toBe(true);
    expect(scenarioFills([steps[0], steps[1]])).toBe(false);
  });

  it('struktura: odkaz na neznámý lístek, holý Market vstup, current při zadání', () => {
    expect(scenarioStructureProblems(scenario([{ kind: 'cancel', label: 'c', targets: [{ ticket: 'zz', order: 'entry' }] }])).join()).toContain('neznámý');
    expect(scenarioStructureProblems(scenario([{ kind: 'place-order', label: 'm', ref: 'm', side: 'position', orderType: 'Market', quantity: 1 }])).join()).toContain('redukce');
    expect(scenarioStructureProblems(scenario([{ ...marketOso, tickets: [{ ...marketTicket, stopLoss: { from: 'current', points: -1 } }] } as DemoStep])).join()).toContain('current');
  });

  it('seznam scénářů: all, aliasy, přesunuté a neznámé jméno', () => {
    expect(parseScenarioList(['--scenario', 'all'], ['a', 'b'])).toEqual(['a', 'b']);
    expect(parseScenarioList(['--scenario', 'R1'], ['a'], {}, { r1: 'a' })).toEqual(['a']);
    expect(() => parseScenarioList(['--scenario', 'c'], ['a'], { c: 'jinde' })).toThrow('jinde');
    expect(() => parseScenarioList(['--scenario', 'zz'], ['a'])).toThrow('Neznámý');
    expect(() => parseScenarioList([], ['a'])).toThrow('--scenario');
    expect(() => parseScenarioList(['--scenario', 'a,a'], ['a'])).toThrow('dvakrát');
  });
});

describe('ceny a pojistky zápisů', () => {
  it('cena od trhu se zaokrouhlí od kotvy, Sell zrcadlově', () => {
    expect(resolveDemoPrice({ from: 'market', ratio: -0.015 }, { anchor: 28_000.6, dir: 1 })).toBe(27_580.5);
    expect(resolveDemoPrice({ from: 'market', ratio: -0.015 }, { anchor: 28_000.6, dir: -1 })).toBe(28_420.75);
    expect(resolveDemoPrice({ from: 'market', points: -40 }, { anchor: ANCHOR, dir: -1 })).toBe(28_040);
    expect(resolveDemoPrice({ from: 'entry', points: -40 }, { anchor: ANCHOR, dir: 1, entryPrice: 27_500 })).toBe(27_460);
    expect(resolveDemoPrice({ from: 'current', points: -4 }, { anchor: null, dir: -1, current: 100 })).toBe(104);
    expect(resolveDemoPrice({ from: 'ticket', ticket: 'b', order: 'sl', points: -1 }, { anchor: null, dir: 1, ticketPrice: () => 27_900 })).toBe(27_899);
    expect(() => resolveDemoPrice({ from: 'market' }, { anchor: null, dir: 1 })).toThrow('čerstvá cena');
  });

  it('OSO: Market se SL/TP ≥ 40 b, pasivní vstup na pasivní straně, marketable u trhu', () => {
    const market = { side: 'Buy' as const, quantity: 1, entryType: 'Market' as const, entry: null, stopLoss: 27_960, takeProfit: 28_040, marketable: false };
    expect(osoPlacementProblems(market, ANCHOR)).toEqual([]);
    expect(osoPlacementProblems({ ...market, stopLoss: 27_970 }, ANCHOR).join()).toContain('SL');
    expect(osoPlacementProblems({ ...market, quantity: 3 }, ANCHOR).join()).toContain('qty 3');
    expect(osoPlacementProblems({ ...market, takeProfit: 28_040.1 }, ANCHOR).join()).toContain('tick');
    expect(osoPlacementProblems({ ...market, stopLoss: 27_700 }, ANCHOR).join()).toContain('SL dál');
    const limit = { ...market, entryType: 'Limit' as const, entry: 27_580, stopLoss: 27_540, takeProfit: 27_620 };
    expect(osoPlacementProblems(limit, ANCHOR)).toEqual([]);
    expect(osoPlacementProblems({ ...limit, entry: 27_990, stopLoss: 27_950, takeProfit: 28_100 }, ANCHOR).join()).toContain('pasivní');
    expect(osoPlacementProblems({ ...limit, entryType: 'Stop' }, ANCHOR).join()).toContain('pasivní');
    expect(osoPlacementProblems({ ...limit, entry: ANCHOR, stopLoss: 27_960, takeProfit: 28_040, marketable: true }, ANCHOR)).toEqual([]);
    expect(osoPlacementProblems({ ...limit, entry: 28_100, stopLoss: 28_060, takeProfit: 28_140, marketable: true }, ANCHOR).join()).toContain('marketable');
    const sell = { ...market, side: 'Sell' as const, stopLoss: 28_040, takeProfit: 27_960 };
    expect(osoPlacementProblems(sell, ANCHOR)).toEqual([]);
  });

  it('holý příkaz: Market jen redukce, Limit jen daleko', () => {
    expect(plainOrderProblems({ side: 'Buy', orderType: 'Market', price: null, quantity: 1, reducing: false, anchor: ANCHOR }).join()).toContain('redukce');
    expect(plainOrderProblems({ side: 'Sell', orderType: 'Market', price: null, quantity: 1, reducing: true, anchor: ANCHOR })).toEqual([]);
    expect(plainOrderProblems({ side: 'Buy', orderType: 'Limit', price: 27_580, quantity: 1, reducing: false, anchor: ANCHOR })).toEqual([]);
    expect(plainOrderProblems({ side: 'Buy', orderType: 'Limit', price: 27_900, quantity: 1, reducing: false, anchor: ANCHOR }).join()).toContain('pasivní');
  });

  const check = (patch: Partial<DemoModifyCheck>): string[] => modifyProblems({
    order: 'sl', side: 'Buy', entryType: 'Market', status: 'working', newPrice: 27_950, newQuantity: 1, toMarket: false,
    anchor: ANCHOR, throughMarket: false, marketable: false, ...patch,
  });

  it('modify SL: přes trh jen s příznakem a jen pozorovaně Suspended', () => {
    expect(check({})).toEqual([]);
    expect(check({ newPrice: 28_010 }).join()).toContain('throughMarket');
    expect(check({ newPrice: 28_010, throughMarket: true }).join()).toContain('Suspended');
    expect(check({ newPrice: 28_010, throughMarket: true, status: 'pending', entryType: 'Limit', entryPrice: 27_955 })).toEqual([]);
    expect(check({ newPrice: 28_010, throughMarket: true, status: null, assumeSuspended: true }).join()).toContain('Suspended');
    expect(check({ status: 'canceled' }).join()).toContain('neběží');
    expect(check({ newQuantity: 3 }).join()).toContain('qty 3');
  });

  it('modify Suspended nohy se měří vůči vstupu, pracující vůči trhu', () => {
    // TP čekajícího Buy Limitu daleko pod trhem: pod trhem, ale nad vstupem → smí.
    expect(check({ order: 'tp', entryType: 'Limit', status: 'pending', entryPrice: 27_580, newPrice: 27_624 })).toEqual([]);
    expect(check({ order: 'tp', entryType: 'Limit', status: null, assumeSuspended: true, entryPrice: 27_580, newPrice: 27_624 })).toEqual([]);
    expect(check({ order: 'tp', status: 'working', newPrice: 27_624 }).join()).toContain('marketable');
    expect(check({ order: 'sl', entryType: 'Limit', status: 'pending', entryPrice: 27_580, newPrice: 27_579 }).join()).toContain('throughMarket');
  });

  it('modify TP a vstupu: marketable / přes trh jen s příznakem, Market jen u TP', () => {
    expect(check({ order: 'tp', newPrice: 27_998 }).join()).toContain('marketable');
    expect(check({ order: 'tp', newPrice: 27_998, marketable: true })).toEqual([]);
    expect(check({ order: 'tp', newPrice: 27_000, marketable: true }).join()).toContain('daleko');
    expect(check({ order: 'tp', toMarket: true, newPrice: null })).toEqual([]);
    expect(check({ order: 'sl', toMarket: true, newPrice: null }).join()).toContain('Market jen u TP');
    expect(check({ order: 'entry', entryType: 'Limit', newPrice: 28_002 }).join()).toContain('marketable');
    expect(check({ order: 'entry', entryType: 'Limit', newPrice: 28_002, marketable: true })).toEqual([]);
    expect(check({ order: 'entry', entryType: 'Stop', newPrice: 27_990 }).join()).toContain('throughMarket');
    expect(check({ order: 'entry', entryType: 'Stop', newPrice: 27_990, throughMarket: true })).toEqual([]);
    expect(check({ order: 'entry', entryType: 'Market', newPrice: 28_000 }).join()).toContain('Market vstup');
    expect(check({ anchor: null }).join()).toContain('čerstvá cena');
  });

  it('skutečná expozice u brokera: ≤ 2, redukce jen do nuly, nečitelný stav = stop', () => {
    expect(exposureProblem({ netPosition: 1, openEntries: [], addQuantity: 1, reducing: false })).toBeNull();
    expect(exposureProblem({ netPosition: 1, openEntries: [{ quantity: 1, filledQuantity: 0 }], addQuantity: 1, reducing: false })).toContain('možná pozice 3');
    expect(exposureProblem({ netPosition: 0, openEntries: [{ quantity: 2, filledQuantity: 1 }], addQuantity: 1, reducing: false })).toBeNull();
    expect(exposureProblem({ netPosition: 1, openEntries: [], addQuantity: 2, reducing: true })).toContain('redukce');
    expect(exposureProblem({ netPosition: 2, openEntries: [], addQuantity: 1, reducing: true })).toBeNull();
    expect(exposureProblem({ netPosition: null, openEntries: [], addQuantity: 1, reducing: false })).toContain('nejde přečíst');
  });

  it('suchý průchod najde nedovolený krok', () => {
    const bad = scenario([marketOso, { kind: 'modify', label: 'SL přes trh', changes: [{ target: { ticket: 't1', order: 'sl' }, price: { from: 'market', points: 10 } }] }]);
    expect(dryRunScenario(bad, 'Buy', ANCHOR).join()).toContain('throughMarket');
    expect(dryRunScenario(scenario([marketOso]), 'Sell', ANCHOR)).toEqual([]);
  });
});

const order = (id: string, status: string, patch: Partial<DemoObservedOrder> = {}): DemoObservedOrder => ({ id, status, quantity: 1, filledQuantity: 0, ...patch });
const input = (orders: DemoObservedOrder[], patch: Partial<DemoClassifyInput> = {}): DemoClassifyInput => ({
  after: { orders, netPosition: 0 },
  tickets: { t1: { entry: 'e1', sl: 's1', tp: 'p1' }, t2: { entry: 'e2', sl: 's2', tp: 'p2' } },
  ...patch,
});

describe('klasifikace výsledků', () => {
  it('leg-resize: obě nohy, jen jedna, partner následuje', () => {
    const legs = (sl: number, tp: number) => [order('s1', 'working', { quantity: sl, type: 'Stop', stopPrice: 27_960 }), order('p1', 'working', { quantity: tp, type: 'Limit', limitPrice: 28_040 })];
    expect(classifyDemo({ name: 'leg-resize', ticket: 't1', quantity: 1 }, input(legs(1, 1))).verdict).toBe('resized');
    expect(classifyDemo({ name: 'leg-resize', ticket: 't1', quantity: 1 }, input(legs(2, 2))).verdict).toBe('not-resized');
    expect(classifyDemo({ name: 'leg-resize', ticket: 't1', order: 'sl', quantity: 1 }, input(legs(1, 2))).verdict).toBe('partner-unchanged');
    expect(classifyDemo({ name: 'leg-resize', ticket: 't1', order: 'sl', quantity: 1 }, input(legs(1, 1))).verdict).toBe('partner-followed');
    expect(classifyDemo({ name: 'leg-resize', ticket: 't1' }, { ...input([]), after: { orders: null, netPosition: 0 } }).verdict).toBe('unreadable');
  });

  it('oco-partner-after-cancel', () => {
    expect(classifyDemo({ name: 'oco-partner-after-cancel', ticket: 't2', order: 'sl' }, input([order('s2', 'canceled'), order('p2', 'canceled')])).verdict).toBe('partner-canceled');
    expect(classifyDemo({ name: 'oco-partner-after-cancel', ticket: 't2', order: 'sl' }, input([order('s2', 'canceled'), order('p2', 'working')])).verdict).toBe('partner-open');
    expect(classifyDemo({ name: 'oco-partner-after-cancel', ticket: 't2', order: 'sl' }, input([order('s2', 'working'), order('p2', 'working')])).verdict).toBe('cancel-not-applied');
  });

  it('tp-fill: zrušen jen vlastní SL, druhý lístek beze změny', () => {
    const orders = [
      order('p1', 'filled', { filledQuantity: 1 }), order('s1', 'canceled'),
      order('s2', 'working', { type: 'Stop', stopPrice: 27_960 }), order('p2', 'working', { type: 'Limit', limitPrice: 28_060 }),
    ];
    const expected = { t2: { sl: 27_960, tp: 28_060 } };
    const base = { after: { orders, netPosition: 1 }, expected };
    expect(classifyDemo({ name: 'tp-fill', ticket: 't1', tickets: ['t2'], quantity: 1 }, input(orders, base)).verdict).toBe('only-own-sl-canceled');
    expect(classifyDemo({ name: 'tp-fill', ticket: 't1', tickets: ['t2'], quantity: 1 }, input(orders, { ...base, after: { orders: [orders[0], order('s1', 'working'), orders[2], orders[3]], netPosition: 1 } })).verdict).toBe('own-sl-still-open');
    expect(classifyDemo({ name: 'tp-fill', ticket: 't1', tickets: ['t2'], quantity: 1 }, input(orders, { ...base, expected: { t2: { sl: 27_959, tp: 28_060 } } })).verdict).toBe('other-ticket-changed');
    expect(classifyDemo({ name: 'tp-fill', ticket: 't1', tickets: ['t2'] }, input([order('p1', 'working')], { expected })).verdict).toBe('tp-not-filled');
  });

  it('relative-leg-move: nohy o Δ, beze změny, smíšeně', () => {
    const snap = (entry: number, sl: number, tp: number) => ({ orders: [
      order('e1', 'working', { type: 'Limit', limitPrice: entry }), order('s1', 'pending', { type: 'Stop', stopPrice: sl }), order('p1', 'pending', { type: 'Limit', limitPrice: tp }),
    ], netPosition: 0 });
    const before = snap(27_580, 27_540, 27_620);
    expect(classifyDemo({ name: 'relative-leg-move', ticket: 't1' }, { ...input([]), before, after: snap(27_576, 27_536, 27_616) }).verdict).toBe('moved-by-delta');
    expect(classifyDemo({ name: 'relative-leg-move', ticket: 't1' }, { ...input([]), before, after: snap(27_576, 27_540, 27_620) }).verdict).toBe('legs-unchanged');
    expect(classifyDemo({ name: 'relative-leg-move', ticket: 't1' }, { ...input([]), before, after: snap(27_576, 27_536, 27_620) }).verdict).toBe('mixed');
    expect(classifyDemo({ name: 'relative-leg-move', ticket: 't1' }, { ...input([]), before, after: before }).verdict).toBe('entry-not-moved');
  });

  it('suspended-modify: přijato a stále Suspended, odmítnuto, nevyslán', () => {
    const after = [order('s1', 'pending', { type: 'Stop', stopPrice: 27_536 })];
    expect(classifyDemo({ name: 'suspended-modify', ticket: 't1', order: 'sl' }, input(after, { expected: { t1: { sl: 27_536 } } })).verdict).toBe('accepted-pending');
    expect(classifyDemo({ name: 'suspended-modify', ticket: 't1', order: 'sl' }, input(after, { expected: { t1: { sl: 28_010 } }, results: [{ id: 's1', ok: false, error: 'InvalidPrice' }] })).verdict).toBe('rejected');
    expect(classifyDemo({ name: 'suspended-modify', ticket: 't1', order: 'sl' }, input(after, { expected: { t1: { sl: 28_010 } } })).verdict).toBe('unconfirmed');
    // Výsledek kroku ze session nese i `notSent` (StepResult); klasifikace ho čte jen přes `error` — proměnná, ne literál (excess property).
    const notSent = { id: 's1', ok: false, notSent: true, error: 'nevyslán' };
    expect(classifyDemo({ name: 'suspended-modify', ticket: 't1', order: 'sl' }, input(after, { expected: { t1: { sl: 28_010 } }, results: [notSent] })).verdict).toBe('rejected');
  });

  it('fill-with-modified-legs: nové ceny, staré ceny, bez fillu', () => {
    const legs = (sl: number, tp: number) => [order('e1', 'filled', { filledQuantity: 1 }), order('s1', 'working', { type: 'Stop', stopPrice: sl }), order('p1', 'working', { type: 'Limit', limitPrice: tp })];
    const prices = { expected: { t1: { sl: 27_956, tp: 28_044 } }, placed: { t1: { sl: 27_960, tp: 28_040 } } };
    expect(classifyDemo({ name: 'fill-with-modified-legs', ticket: 't1' }, input(legs(27_956, 28_044), prices)).verdict).toBe('filled-new-prices');
    expect(classifyDemo({ name: 'fill-with-modified-legs', ticket: 't1' }, input(legs(27_960, 28_040), prices)).verdict).toBe('filled-old-prices');
    expect(classifyDemo({ name: 'fill-with-modified-legs', ticket: 't1' }, input([order('e1', 'working')], prices)).verdict).toBe('not-filled');
  });

  it('parent-qty a cascade', () => {
    const before = { orders: [order('s1', 'pending', { quantity: 2 }), order('p1', 'pending', { quantity: 2 })], netPosition: 0 };
    expect(classifyDemo({ name: 'parent-qty', ticket: 't1', quantity: 1 }, input([order('e1', 'working'), order('s1', 'pending'), order('p1', 'pending')], { before })).verdict).toBe('legs-follow');
    expect(classifyDemo({ name: 'parent-qty', ticket: 't1', quantity: 1 }, input([order('e1', 'working'), order('s1', 'pending', { quantity: 2 }), order('p1', 'pending', { quantity: 2 })], { before })).verdict).toBe('legs-unchanged');
    expect(classifyDemo({ name: 'parent-qty', ticket: 't1', quantity: 1 }, input([order('e1', 'working', { quantity: 2 })], { before, results: [{ id: 'e1', ok: false, error: 'x' }] })).verdict).toBe('rejected');
    expect(classifyDemo({ name: 'cascade', ticket: 't1' }, input([order('e1', 'canceled'), order('s1', 'canceled'), order('p1', 'canceled')])).verdict).toBe('legs-canceled');
    expect(classifyDemo({ name: 'cascade', ticket: 't1' }, input([order('e1', 'canceled'), order('s1', 'pending'), order('p1', 'canceled')])).verdict).toBe('legs-open');
    expect(classifyDemo({ name: 'cascade', ticket: 't1' }, input([order('e1', 'working')])).verdict).toBe('parent-open');
  });

  it('independent-pairs a cancel-one-of-many', () => {
    const pair = (n: string, entry = 'working', legs = 'pending') => [order(`e${n}`, entry), order(`s${n}`, legs), order(`p${n}`, legs)];
    expect(classifyDemo({ name: 'independent-pairs', tickets: ['t1', 't2'] }, input([...pair('1'), ...pair('2')])).verdict).toBe('independent');
    expect(classifyDemo({ name: 'independent-pairs', tickets: ['t1', 't2'] }, input([...pair('1'), ...pair('2', 'working', 'canceled')])).verdict).toBe('unexpected-status');
    expect(classifyDemo({ name: 'independent-pairs', tickets: ['t1'] }, { ...input(pair('1')), tickets: { t1: { entry: 'e1', sl: 'e1', tp: 'p1' } } }).verdict).toBe('shared-ids');
    const before = { orders: [...pair('1'), ...pair('2')], netPosition: 0 };
    expect(classifyDemo({ name: 'cancel-one-of-many', ticket: 't1', tickets: ['t2'] }, input([...pair('1', 'canceled', 'canceled'), ...pair('2')], { before })).verdict).toBe('only-own-canceled');
    expect(classifyDemo({ name: 'cancel-one-of-many', ticket: 't1', tickets: ['t2'] }, input([...pair('1', 'canceled', 'canceled'), ...pair('2', 'working', 'canceled')], { before })).verdict).toBe('others-touched');
    expect(classifyDemo({ name: 'cancel-one-of-many', ticket: 't1', tickets: ['t2'] }, input([...pair('1'), ...pair('2')], { before })).verdict).toBe('own-still-open');
  });

  it('liquidate-cancels-all (i cizí Limit) a through-market-entry', () => {
    expect(classifyDemo({ name: 'liquidate-cancels-all', plain: 'f1' }, input([order('f', 'canceled')], { plain: { f1: 'f' } })).verdict).toBe('all-canceled');
    const left = classifyDemo({ name: 'liquidate-cancels-all', plain: 'f1' }, input([order('f', 'working')], { plain: { f1: 'f' } }));
    expect(left.verdict).toBe('open-left');
    expect(left.detail.foreign).toMatchObject({ status: 'working' });
    expect(classifyDemo({ name: 'liquidate-cancels-all' }, { ...input([]), after: { orders: [], netPosition: 1 } }).verdict).toBe('position-open');
    const before = { orders: [order('e1', 'working', { type: 'Stop', stopPrice: 28_420 })], netPosition: 0 };
    expect(classifyDemo({ name: 'through-market-entry', ticket: 't1' }, input([order('e1', 'working', { type: 'Stop', stopPrice: 28_420 })], { before, results: [{ id: 'e1', ok: false, error: 'InvalidPrice' }] })).verdict).toBe('rejected-unchanged');
    expect(classifyDemo({ name: 'through-market-entry', ticket: 't1' }, { ...input([order('e1', 'filled', { filledQuantity: 1 })], { before }), after: { orders: [order('e1', 'filled', { filledQuantity: 1 })], netPosition: 1 } }).verdict).toBe('triggered');
    expect(classifyDemo({ name: 'through-market-entry', ticket: 't1' }, input([order('e1', 'working', { type: 'Stop', stopPrice: 27_990 })], { before })).verdict).toBe('accepted-working');
  });
});

describe('časová osa C4', () => {
  const timeline = [
    { t: 1_000, entityType: 'order', entity: { id: 11 } },
    { t: 1_200, entityType: 'fill', entity: { orderId: 11 } },
    { t: 1_500, entityType: 'position', entity: { netPos: 0 } },
    { t: 1_900, entityType: 'cashBalance', entity: { amount: 1 } },
    { t: 2_100, entityType: 'order', entity: { id: 21 } },
    { t: 2_300, entityType: 'order', entity: { id: 12 } },
    { t: 2_400, entityType: 'position', entity: { netPos: -1 } },
  ];

  it('ocas po liquidate: poslední event, cashBalance, position', () => {
    expect(liquidationTail(timeline, 1_000, 2_000)).toMatchObject({ entities: 4, lastEventMs: 900, firstCashBalanceMs: 900, lastPositionMs: 500 });
    expect(liquidationTail(timeline, 5_000, 6_000).lastEventMs).toBeNull();
  });

  it('otočení: event starého příkazu po prvním eventu nového = old-after-new', () => {
    expect(reverseOrdering(timeline, new Set(['11', '12']), new Set(['21']), 2_000)).toMatchObject({ verdict: 'old-after-new', firstNewEventMs: 100, positionAfterNew: 1 });
    expect(reverseOrdering(timeline, new Set(['11']), new Set(['21']), 2_000).verdict).toBe('separated');
    expect(reverseOrdering(timeline, new Set(['11']), new Set(['99']), 2_000).verdict).toBe('no-new-events');
  });
});

describe('anonymizace a tokeny', () => {
  it('cashBalance jen leadera, bez soukromých klíčů, id účtu přemapované', () => {
    const frame = `a${JSON.stringify([
      { e: 'props', d: { entityType: 'cashBalance', eventType: 'Updated', entity: { id: 5, accountId: DEMO_RECORD_ACCOUNT_ID, amount: 100, name: 'DEMO8661118' } } },
      { e: 'props', d: { entityType: 'cashBalance', eventType: 'Updated', entity: { id: 6, accountId: 777, amount: 1 } } },
      { e: 'props', d: { entityType: 'order', eventType: 'Created', entity: { id: 7, accountId: DEMO_RECORD_ACCOUNT_ID } } },
    ])}`;
    const map = new Map([[DEMO_RECORD_ACCOUNT_ID, 1001], [777, 2002]]);
    expect(leaderExtraEntities(frame, map, 1001)).toEqual([{ entityType: 'cashBalance', eventType: 'Updated', entity: { id: 5, accountId: 1001, amount: 100 } }]);
    expect(leaderExtraEntities('o', map, 1001)).toEqual([]);
  });

  it('tokeny a identifikátory se nikdy nevypíšou', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk';
    const text = redactDemoText(`Bearer ${jwt} accessToken=abc123 conn:1234-abcd účet DEMO8661118 61038658`, ['DEMO8661118', 61038658]);
    expect(text).not.toContain(jwt);
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('DEMO8661118');
    expect(text).not.toContain('61038658');
    expect(text).toContain('conn:x');
    expect(containsSecret(`{"x":"${jwt}"}`)).toBe(true);
    expect(containsSecret('{"x":"ok"}')).toBe(false);
  });

  it('popis plánu ukazuje fill a max. pozici', () => {
    expect(describeDemoPlan(plan()).join('\n')).toMatch(/max\. pozice 1, VYPLNÍ SE/);
  });
});
