import { describe, expect, it } from 'vitest';
import {
  DEMO_RECORD_ACCOUNT_ID,
  demoPlanProblems,
  dryRunScenario,
  scenarioFills,
  scenarioMaxExposure,
  scenarioStructureProblems,
  type DemoStep,
} from '../scripts/copier/recordDemoPlan';
import { EXITS_SCENARIOS, exitsScenario, parseRecordExitsArgs, type RecordExitsOptions } from '../scripts/copier/recordExitsPlan';

const NOW = Date.UTC(2026, 10, 3, 15, 0);
const base = ['--account', String(DEMO_RECORD_ACCOUNT_ID), '--symbol', 'MNQZ6', '--market-price', '28000'];
const parse = (...extra: string[]) => parseRecordExitsArgs([...base, ...extra]);
const options = (patch: Partial<RecordExitsOptions> = {}): RecordExitsOptions => ({
  slPoints: 40, tpPoints: 40, tpMarket: false, placement: 'concurrent', repeat: 3, tickets: 1, gapMs: null, ...patch,
});
const variants: RecordExitsOptions[] = [
  options(), options({ tpMarket: true }), options({ placement: 'sequential' }), options({ tickets: 2, repeat: 5 }),
  options({ gapMs: 1_500, repeat: 4 }), options({ gapMs: 300, tickets: 2, repeat: 5 }), options({ slPoints: 60, tpPoints: 80 }),
];

describe('record-exits: argumenty', () => {
  it('výchozí volby a seznam scénářů', () => {
    const plan = parse('--scenario', 'all');
    expect(plan.scenarios.map(item => item.name)).toEqual([...EXITS_SCENARIOS]);
    expect(plan.options).toEqual(options());
    expect(plan).toMatchObject({ side: 'Buy', confirm: false, allowFill: false, accountId: DEMO_RECORD_ACCOUNT_ID });
    expect(parse('--scenario', 'tp-fill', '--confirm', '--allow-fill', '--side', 'Sell')).toMatchObject({ confirm: true, allowFill: true, side: 'Sell' });
  });

  it('přesunuté a vyřazené scénáře odkážou jinam', () => {
    expect(() => parse('--scenario', 'split-limit')).toThrow('record-pending.ts --scenario multi-pending');
    expect(() => parse('--scenario', 'stop-hit')).toThrow('nenahrává');
    expect(() => parse('--scenario', 'flip')).toThrow('Neznámý');
  });

  it.each([
    [['--sl-points', '30'], '--sl-points'], [['--sl-points', '400'], '--sl-points'], [['--tp-points', '39'], '--tp-points'],
    [['--sl-points', '40.1'], 'tick'], [['--repeat', '6'], '--repeat'], [['--repeat', '0'], '--repeat'],
    [['--tickets', '3'], '--tickets'], [['--gap-ms', '100'], '--gap-ms'], [['--gap-ms', '7000'], '--gap-ms'],
    [['--placement', 'x'], '--placement'], [['--side', 'Long'], '--side'],
  ])('neplatné %o se odmítne', (extra, message) => {
    expect(() => parse('--scenario', 'resize', ...extra)).toThrow(message);
  });

  it('jen MNQ, LIVE/jiný účet a jiný kontrakt neprojdou pojistkami', () => {
    expect(() => parseRecordExitsArgs(['--account', '1', '--symbol', 'NQZ6', '--market-price', '28000', '--scenario', 'resize'])).toThrow('MNQ');
    const other = parseRecordExitsArgs(['--account', '22222', '--symbol', 'MNQZ6', '--market-price', '28000', '--scenario', 'resize']);
    expect(demoPlanProblems(other, NOW).join(' ')).toContain('DEMO8661118');
    expect(demoPlanProblems(parseRecordExitsArgs(['--account', String(DEMO_RECORD_ACCOUNT_ID), '--symbol', 'MNQH7', '--market-price', '28000', '--scenario', 'resize']), NOW).join(' ')).toContain('front kontrakt');
    expect(() => parse('--scenario', 'resize', '--account', '1')).toThrow('dvakrát');
  });

  it('bez --confirm jen plán; --confirm bez --allow-fill odmítne (všechny scénáře se vyplní)', () => {
    expect(demoPlanProblems(parse('--scenario', 'all'), NOW)).toEqual([]);
    const refused = demoPlanProblems(parse('--scenario', 'all', '--confirm'), NOW);
    expect(refused).toHaveLength(EXITS_SCENARIOS.length);
    expect(refused.every(item => item.includes('--allow-fill'))).toBe(true);
    expect(demoPlanProblems(parse('--scenario', 'all', '--confirm', '--allow-fill'), NOW)).toEqual([]);
  });
});

describe('record-exits: scénáře', () => {
  it('každý scénář a varianta: platná struktura, pozice ≤ 2, vyplní se, projde pojistkami při trhu (Buy i Sell)', () => {
    for (const variant of variants) {
      for (const name of EXITS_SCENARIOS) {
        const scenario = exitsScenario(name, variant);
        expect(scenarioStructureProblems(scenario), name).toEqual([]);
        expect(scenarioMaxExposure(scenario.steps), name).toBeLessThanOrEqual(2);
        expect(scenarioFills(scenario.steps), name).toBe(true);
        expect(dryRunScenario(scenario, 'Buy', 28_000), name).toEqual([]);
        expect(dryRunScenario(scenario, 'Sell', 28_000), name).toEqual([]);
      }
    }
  });

  it('resize: nohy 2→1 souběžně, Market redukce až po pozorovaném potvrzení obou nohou', () => {
    const steps = exitsScenario('resize', options()).steps;
    const modify = steps.findIndex(step => step.kind === 'modify');
    const reduce = steps.findIndex(step => step.kind === 'place-order');
    expect(modify).toBeGreaterThan(0);
    expect(reduce).toBeGreaterThan(modify);
    expect(steps[modify]).toMatchObject({ changes: [{ target: { order: 'sl' }, quantity: 1 }, { target: { order: 'tp' }, quantity: 1 }] });
    expect(steps[reduce]).toMatchObject({ orderType: 'Market', side: 'opposite', reducing: true, onlyIfLegsQuantity: { ticket: 't1', quantity: 1 } });
    expect(steps.at(-1)?.kind).toBe('liquidate');
  });

  it('resize-one-leg mění jen SL; ticket-cancel ruší SL lístku 2, pak znovu a zbytek jen otevřený', () => {
    const oneLeg = exitsScenario('resize-one-leg', options()).steps.filter(step => step.kind === 'modify');
    expect(oneLeg).toHaveLength(1);
    expect(oneLeg[0]).toMatchObject({ changes: [{ target: { ticket: 't1', order: 'sl' }, quantity: 1 }], classify: { name: 'leg-resize', order: 'sl' } });
    const cancels = exitsScenario('ticket-cancel', options()).steps.filter(step => step.kind === 'cancel') as Array<Extract<DemoStep, { kind: 'cancel' }>>;
    expect(cancels.map(step => step.targets)).toEqual([[{ ticket: 't2', order: 'sl' }], [{ ticket: 't2', order: 'sl' }], [{ ticket: 't2', order: 'tp' }]]);
    expect(cancels[2].onlyIfOpen).toBe(true);
  });

  it('tp-fill: souběžně dva lístky, TP1 marketable; sequential = R7 s vlastním SL a TP lístku 2; --tp-market = Market', () => {
    const concurrent = exitsScenario('tp-fill', options()).steps;
    expect(concurrent[0]).toMatchObject({ kind: 'place-oso', tickets: [{ ticket: 't1' }, { ticket: 't2', takeProfit: { points: 60 } }] });
    expect(concurrent.find(step => step.kind === 'modify')).toMatchObject({ changes: [{ target: { ticket: 't1', order: 'tp' }, price: { from: 'market', points: -2, marketable: true } }] });
    expect(concurrent.find(step => step.kind === 'observe' && step.classify)).toMatchObject({ classify: { name: 'tp-fill', ticket: 't1', tickets: ['t2'] } });
    const sequential = exitsScenario('tp-fill', options({ placement: 'sequential' })).steps;
    expect(sequential.filter(step => step.kind === 'place-oso')).toHaveLength(2);
    expect(sequential[2]).toMatchObject({ tickets: [{ ticket: 't2', stopLoss: { points: -44 } }] });
    expect(sequential.find(step => step.kind === 'modify')).toMatchObject({ changes: [{ target: { ticket: 't2', order: 'tp' } }] });
    expect(exitsScenario('tp-fill', options({ tpMarket: true })).steps.find(step => step.kind === 'modify')).toMatchObject({ changes: [{ orderType: 'Market' }] });
  });

  it('reverse bez mezery: každé opakování liquidate + 6 s ticha + REST flat', () => {
    const steps = exitsScenario('reverse', options({ repeat: 3 })).steps;
    expect(steps.filter(step => step.kind === 'liquidate')).toHaveLength(3);
    expect(steps.filter(step => step.kind === 'wait-quiet')).toHaveLength(3);
    expect(steps.filter(step => step.kind === 'wait-quiet').every(step => step.kind === 'wait-quiet' && step.quietMs === 6_000)).toBe(true);
    expect(steps.some(step => step.kind === 'place-oso' && step.tickets.some(ticket => ticket.side === 'opposite'))).toBe(false);
  });

  it('reverse s mezerou: opačný vstup jen po mezeře a REST flat, ocas po posledním liquidate', () => {
    const steps = exitsScenario('reverse', options({ repeat: 3, gapMs: 1_500, tickets: 2 })).steps;
    const placements = steps.filter(step => step.kind === 'place-oso') as Array<Extract<DemoStep, { kind: 'place-oso' }>>;
    expect(placements.map(step => step.tickets[0].side)).toEqual(['position', 'opposite', 'position']);
    expect(placements.map(step => step.tickets.length)).toEqual([2, 2, 2]);
    expect(placements.slice(1).map(step => step.reverseAfter)).toEqual(['liq1', 'liq2']);
    for (const placement of placements.slice(1)) {
      const index = steps.indexOf(placement);
      expect(steps[index - 1].kind).toBe('require-flat');
      expect(steps[index - 2]).toMatchObject({ kind: 'sleep', ms: 1_500 });
    }
    expect(steps.filter(step => step.kind === 'wait-quiet')).toHaveLength(1);
    expect(steps.at(-1)).toMatchObject({ kind: 'observe', classify: { name: 'liquidate-cancels-all' } });
  });
});
