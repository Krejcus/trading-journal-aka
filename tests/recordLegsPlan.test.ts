// DEMO záznam pro volitelné SL/TP: scénáře projdou pojistkami, nic se tu neposílá.
import { describe, expect, it } from 'vitest';
import { demoStartProblems, dryRunScenario, exitOrderProblems, plainOrderProblems, scenarioFills, scenarioMaxExposure, scenarioStructureProblems } from '../scripts/copier/recordDemoPlan';
import { LEGS_SCENARIOS, legsScenario, parseRecordLegsArgs } from '../scripts/copier/recordLegsPlan';

const options = { slPoints: 40, tpPoints: 40 };

describe('record-legs: scénáře', () => {
  it('každý má platnou strukturu, pozici ≤ 1 a projde pojistkami při trhu (Buy i Sell)', () => {
    for (const name of LEGS_SCENARIOS) {
      const scenario = legsScenario(name, options);
      expect(scenarioStructureProblems(scenario), name).toEqual([]);
      expect(scenarioMaxExposure(scenario.steps), name).toBeLessThanOrEqual(1);
      expect(dryRunScenario(scenario, 'Buy', 28_000), name).toEqual([]);
      expect(dryRunScenario(scenario, 'Sell', 28_000), name).toEqual([]);
    }
  });
  it('scénáře bez fillu se opravdu nevyplní', () => {
    expect(scenarioFills(legsScenario('bare-limit-cancel-race', options).steps)).toBe(true);
    for (const name of ['bare-limit-cancel', 'limit-replace', 'pending-leg-cancel'] as const) expect(scenarioFills(legsScenario(name, options).steps), name).toBe(false);
    expect(scenarioFills(legsScenario('oco-cancel-sl', options).steps)).toBe(true);
  });
  it('--scenario all a odmítnutí blízkých nohou', () => {
    const base = ['--account', '61038658', '--symbol', 'MNQZ6', '--side', 'Buy', '--market-price', '28000'];
    expect(parseRecordLegsArgs([...base, '--scenario', 'all']).scenarios).toHaveLength(LEGS_SCENARIOS.length);
    expect(() => parseRecordLegsArgs([...base, '--scenario', 'all', '--sl-points', '10'])).toThrow('--sl-points');
  });
});

describe('record-legs: pojistky startu', () => {
  it('nevyřešený ruční vstup nebo změna obchodu záznam nepustí', () => {
    const plan = { accountId: 61038658, symbol: 'MNQZ6', marketPrice: 28_000 };
    const problems = (controller: Record<string, unknown>) => demoStartProblems(plan, { controller }, 1);
    expect(problems({ manualEntries: [{ status: 'unknown' }] })).toContain('worker má nevyřešený ruční vstup nebo změnu obchodu');
    expect(problems({ unresolvedManualOrderActions: [{ status: 'sending' }] })).toContain('worker má nevyřešený ruční vstup nebo změnu obchodu');
    expect(problems({ manualEntries: [{ status: 'acknowledged' }] })).not.toContain('worker má nevyřešený ruční vstup nebo změnu obchodu');
  });
});

describe('record-legs: pojistky nohou', () => {
  const stop = { side: 'Buy' as const, leg: 'stop' as const, quantity: 1, anchor: 28_000 };
  it('noha na špatné straně nebo blízko trhu se nepošle', () => {
    expect(exitOrderProblems({ ...stop, price: 27_960 })).toEqual([]);
    expect(exitOrderProblems({ ...stop, price: 27_990 })).toHaveLength(1);
    expect(exitOrderProblems({ ...stop, price: 28_050 })).toHaveLength(1);
    expect(exitOrderProblems({ ...stop, leg: 'limit', price: 28_040 })).toEqual([]);
    expect(exitOrderProblems({ ...stop, side: 'Sell', price: 28_040 })).toEqual([]);
    expect(exitOrderProblems({ ...stop, anchor: null, price: 27_960 })).toHaveLength(1);
    expect(exitOrderProblems({ ...stop, quantity: 3, price: 27_960 })).toHaveLength(1);
  });
  it('holý Market a blízký Limit jen s příznakem `bare`', () => {
    const market = { side: 'Buy' as const, orderType: 'Market' as const, price: null, quantity: 1, reducing: false, anchor: 28_000 };
    expect(plainOrderProblems(market)).toContain('holý Market jen jako redukce');
    expect(plainOrderProblems({ ...market, bare: true })).toEqual([]);
    const limit = { ...market, orderType: 'Limit' as const, price: 28_002 };
    expect(plainOrderProblems(limit)).toHaveLength(1);
    expect(plainOrderProblems({ ...limit, bare: true })).toHaveLength(1);
    expect(plainOrderProblems({ ...limit, bare: true, marketable: true })).toEqual([]);
  });
});
