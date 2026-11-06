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
import {
  SCALE_IN_DEMO_SCENARIOS,
  decideScaleInCleanup,
  isScaleInDemoScenario,
  parseRecordScaleInArgs,
  parseScaleInDemoArgs,
  scaleInDemoScenario,
} from '../scripts/copier/recordScaleInPlan';

const NOW = Date.UTC(2026, 10, 3, 15, 0);
const base = ['--account', String(DEMO_RECORD_ACCOUNT_ID), '--symbol', 'MNQZ6', '--market-price', '28000'];
const parse = (scenario: string, ...extra: string[]) => parseScaleInDemoArgs([...base, '--scenario', scenario, ...extra]);

describe('record-scale-in: R16/R17 argumenty', () => {
  it('nové scénáře jdou přes společný interpret, basic/five dál původní cestou', () => {
    expect(isScaleInDemoScenario(['--scenario', 'foreign-close'])).toBe(true);
    expect(isScaleInDemoScenario(['--scenario', 'pending-modify'])).toBe(true);
    expect(isScaleInDemoScenario(['--scenario', 'basic'])).toBe(false);
    expect(isScaleInDemoScenario([])).toBe(false);
    expect(() => parseRecordScaleInArgs([...base, '--sl', '27900', '--tp', '28500', '--add-limit', '27950', '--scenario', 'foreign-close'])).toThrow('basic nebo five');
  });

  it('výchozí vzdálenosti z trhu: přikoupení 0,16 %, SL o 40 b dál, TP 80', () => {
    expect(parse('pending-modify').options).toEqual({ addPoints: 45, slPoints: 85, tpPoints: 80 });
    expect(parse('foreign-close', '--sl-points', '100', '--add-points', '50').options).toEqual({ addPoints: 50, slPoints: 100, tpPoints: 80 });
  });

  it.each([
    [['--add-points', '30'], '0,15 %'], [['--add-points', '45', '--sl-points', '60'], 'dál než --add-points'],
    [['--sl-points', '400'], '--sl-points'], [['--tp-points', '30'], '--tp-points'], [['--add-points', '45.1'], 'tick'],
  ])('neplatné %o se odmítne', (extra, message) => {
    expect(() => parse('pending-modify', ...extra)).toThrow(message);
  });

  it('jiný účet, LIVE účet nebo jiný kontrakt neprojde; --confirm vyžaduje --allow-fill', () => {
    expect(demoPlanProblems(parseScaleInDemoArgs(['--account', '99', '--symbol', 'MNQZ6', '--market-price', '28000', '--scenario', 'foreign-close']), NOW).join(' ')).toContain('DEMO8661118');
    expect(() => parseScaleInDemoArgs(['--account', '99', '--symbol', 'ESZ6', '--market-price', '28000', '--scenario', 'foreign-close'])).toThrow('MNQ');
    expect(demoPlanProblems(parseScaleInDemoArgs(['--account', String(DEMO_RECORD_ACCOUNT_ID), '--symbol', 'MNQH7', '--market-price', '28000', '--scenario', 'foreign-close']), NOW).join(' ')).toContain('front kontrakt');
    expect(demoPlanProblems(parse('foreign-close'), NOW)).toEqual([]);
    expect(demoPlanProblems(parse('foreign-close', '--confirm'), NOW).join(' ')).toContain('--allow-fill');
    expect(demoPlanProblems(parse('pending-modify', '--confirm', '--allow-fill'), NOW)).toEqual([]);
  });
});

describe('record-scale-in: R16/R17 scénáře', () => {
  it('struktura, pozice ≤ 2, vyplní se, projde pojistkami při trhu (Buy i Sell)', () => {
    for (const name of SCALE_IN_DEMO_SCENARIOS) {
      const scenario = scaleInDemoScenario(name, parse(name).options);
      expect(scenarioStructureProblems(scenario), name).toEqual([]);
      expect(scenarioMaxExposure(scenario.steps), name).toBe(2);
      expect(scenarioFills(scenario.steps), name).toBe(true);
      expect(dryRunScenario(scenario, 'Buy', 28_000), name).toEqual([]);
      expect(dryRunScenario(scenario, 'Sell', 28_000), name).toEqual([]);
    }
  });

  it('R16: pozice 1 + cizí Limit daleko na stejném kontraktu, liquidate klasifikuje i cizí příkaz', () => {
    const steps = scaleInDemoScenario('foreign-close', parse('foreign-close').options).steps;
    expect(steps.map(step => step.kind)).toEqual(['place-oso', 'wait-net', 'place-order', 'liquidate']);
    expect(steps[2]).toMatchObject({ orderType: 'Limit', side: 'position', quantity: 1, price: { from: 'market', ratio: -0.015 } });
    expect(steps[2]).not.toHaveProperty('reducing');
    expect(steps[3]).toMatchObject({ classify: { name: 'liquidate-cancels-all', plain: 'f1' } });
  });

  it('R17: souběžný posun nohou základu i Suspended nohou, fill přikoupení, SL přes trh, zrušení, liquidate', () => {
    const steps = scaleInDemoScenario('pending-modify', parse('pending-modify').options).steps;
    const modifies = steps.filter(step => step.kind === 'modify') as Array<Extract<DemoStep, { kind: 'modify' }>>;
    expect(modifies[0].changes.map(change => 'ticket' in change.target && `${change.target.ticket}.${change.target.order}`)).toEqual(['base.sl', 'base.tp', 'a1.sl', 'a1.tp']);
    expect(modifies[0].classify).toEqual({ name: 'suspended-modify', ticket: 'a1' });
    expect(modifies[1]).toMatchObject({ changes: [{ target: { ticket: 'a1', order: 'entry' }, price: { from: 'market', marketable: true } }] });
    expect(modifies[2]).toMatchObject({ changes: [{ target: { ticket: 'a2', order: 'sl' }, throughMarket: true }] });
    const a1 = steps.find(step => step.kind === 'place-oso' && step.tickets[0].ticket === 'a1') as Extract<DemoStep, { kind: 'place-oso' }>;
    expect(a1.tickets[0]).toMatchObject({ stopLoss: { from: 'ticket', ticket: 'base', order: 'sl' }, takeProfit: { from: 'ticket', ticket: 'base', order: 'tp' } });
    const flat = steps.findIndex(step => step.kind === 'require-flat');
    expect(steps[flat - 1]).toMatchObject({ kind: 'liquidate', ref: 'liq1' });
    expect(steps[flat + 1]).toMatchObject({ kind: 'place-oso', tickets: [{ ticket: 'base2' }] });
    expect(steps.filter(step => step.kind === 'liquidate')).toHaveLength(2);
    expect(steps.find(step => step.kind === 'cancel')).toMatchObject({ targets: [{ ticket: 'a2', order: 'entry' }], classify: { name: 'cascade', ticket: 'a2' } });
  });
});

describe('úklid (sdílený s interpretem)', () => {
  const order = (id: string, status: string, filledQuantity = 0) => ({ id, status, filledQuantity });
  it('pozice → liquidate, flat → nejdřív vstupy, pak nohy, pak čisto; nečitelný stav = neověřeno', () => {
    expect(decideScaleInCleanup({ orders: null, netPosition: 0 }, new Set()).kind).toBe('unverified');
    expect(decideScaleInCleanup({ orders: [], netPosition: 1 }, new Set()).kind).toBe('liquidate');
    expect(decideScaleInCleanup({ orders: [order('e', 'working'), order('s', 'pending')], netPosition: 0 }, new Set(['e']))).toEqual({ kind: 'cancel', ids: ['e'] });
    expect(decideScaleInCleanup({ orders: [order('e', 'canceled'), order('s', 'pending')], netPosition: 0 }, new Set(['e']))).toEqual({ kind: 'cancel', ids: ['s'] });
    expect(decideScaleInCleanup({ orders: [order('e', 'canceled'), order('s', 'canceled')], netPosition: 0 }, new Set(['e'])).kind).toBe('clean');
  });
});
