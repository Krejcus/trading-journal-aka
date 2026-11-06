import { describe, expect, it } from 'vitest';
import {
  RECORD_DEMO_ACCOUNT_ID,
  STOP_LIMIT_STEP_ORDER,
  averageFillPrice,
  frontContractProblem,
  parseRecordLeaderOsoArgs,
  recordLeaderOsoProblems,
  stopLimitStepProblems,
  stopLimitSteps,
  type RecordLeaderOsoPlan,
} from '../scripts/copier/recordLeaderOsoPlan';

const NOW = 1_800_000_000_000;
const status = (controller: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  environment: 'demo',
  controller: {
    armed: false, connected: true, killSwitch: false, groupFlat: true, reconciliationRequired: false,
    lastError: null, manualRecovery: null, transportResume: null, divergentAccounts: [], workingOrderAccounts: [],
    ...controller,
  },
  group: { leaderAccountId: RECORD_DEMO_ACCOUNT_ID, manualOnly: true, localOnly: true, followers: [] },
  marketPrices: [{ symbol: 'MNQZ6', price: 30_000, at: NOW - 1_000 }],
  ...extra,
});
const plan = (patch: Partial<RecordLeaderOsoPlan> = {}): RecordLeaderOsoPlan => ({
  accountId: RECORD_DEMO_ACCOUNT_ID, symbol: 'MNQZ6', side: 'Buy', entry: 30_010, stopLoss: 29_900, takeProfit: 30_500,
  marketPrice: 30_000, holdMs: 4_000, confirm: false, scenario: 'stop-limit', allowNonGroupAccount: false, ...patch,
});
const problems = (p = plan(), s: unknown = status()) => recordLeaderOsoProblems(p, s, NOW);
const args = (...extra: string[]) => ['--account', String(RECORD_DEMO_ACCOUNT_ID), '--symbol', 'MNQZ6', '--entry', '30010', '--sl', '29900',
  '--tp', '30500', '--market-price', '30000', '--scenario', 'stop-limit', ...extra];

describe('R11 stop-limit: argumenty a pojistky', () => {
  it('jen DEMO8661118, jen čtvrtletní MNQ, nikdy účet mimo skupinu nebo LIVE', () => {
    expect(parseRecordLeaderOsoArgs(args())).toMatchObject({ scenario: 'stop-limit', accountId: RECORD_DEMO_ACCOUNT_ID, confirm: false });
    expect(parseRecordLeaderOsoArgs(args('--confirm')).confirm).toBe(true);
    const other = args();
    other[1] = '4242';
    expect(() => parseRecordLeaderOsoArgs(other)).toThrow('61038658');
    expect(() => parseRecordLeaderOsoArgs(args('--non-group-account'))).toThrow('--non-group-account');
    expect(() => parseRecordLeaderOsoArgs(args('--environment', 'live'))).toThrow('DEMO');
    expect(() => parseRecordLeaderOsoArgs(args('--live'))).toThrow('DEMO');
    const monthly = args();
    monthly[3] = 'MNQF7';
    expect(() => parseRecordLeaderOsoArgs(monthly)).toThrow('čtvrtletní');
    const big = args();
    big[3] = 'NQZ6';
    expect(() => parseRecordLeaderOsoArgs(big)).toThrow('MNQ');
  });

  it('bezpečný plán za DISARMED v sólo DEMO skupině projde (Buy i Sell)', () => {
    expect(problems()).toEqual([]);
    expect(problems(plan({ side: 'Sell', entry: 29_990, stopLoss: 30_100, takeProfit: 29_500 }))).toEqual([]);
  });

  it('DISARMED, DEMO a sólo skupina jsou povinné; brány Market vstupu platí', () => {
    expect(problems(plan(), status({ armed: true })).join(' ')).toContain('DISARMED');
    expect(problems(plan(), status({}, { environment: 'live' })).join(' ')).toContain('DEMO');
    const group = { leaderAccountId: RECORD_DEMO_ACCOUNT_ID, manualOnly: true, localOnly: true, followers: [] };
    expect(problems(plan(), status({}, { group: { ...group, manualOnly: false } })).join(' ')).toContain('manual-only');
    expect(problems(plan(), status({}, { group: { ...group, followers: [{ accountId: 7 }] } })).join(' ')).toContain('followery');
    expect(problems(plan(), status({}, { group: { ...group, leaderAccountId: 7 } })).join(' ')).toContain('není leader');
    expect(problems(plan({ accountId: 4242 }), status({}, { group: { ...group, leaderAccountId: 4242 } })).join(' ')).toContain('jen účet');
    expect(problems(plan({ allowNonGroupAccount: true })).join(' ')).toContain('--non-group-account');
    expect(problems(plan({ stopLoss: 30_005 })).join(' ')).toContain('SL');
    expect(problems(plan({ takeProfit: 30_100 })).join(' ')).toContain('TP');
    expect(problems(plan(), status({}, { marketPrices: [] })).join(' ')).toContain('čerstvou cenu');
  });

  it('ostatní scénáře nové pojistky nedostaly (beze změny chování)', () => {
    const legacy = { controller: status().controller, group: { leaderAccountId: 4242 }, marketPrices: status().marketPrices };
    expect(recordLeaderOsoProblems(plan({ scenario: 'market', accountId: 4242 }), legacy, NOW)).toEqual([]);
  });

  it('front kontrakt: jen přesná shoda s brokerem, bez odpovědi nic', () => {
    expect(frontContractProblem('MNQZ6', { contract: 'MNQZ6' })).toBeNull();
    expect(frontContractProblem('mnqz6', { contract: 'MNQZ6' })).toBeNull();
    expect(frontContractProblem('MNQZ6', { contract: 'MNQH7' })).toContain('není front');
    expect(frontContractProblem('MNQZ6', null)).toContain('nejde ověřit');
  });
});

describe('R11 stop-limit: kroky posunu SL', () => {
  const byName = (steps: ReturnType<typeof stopLimitSteps>) => Object.fromEntries(steps.map(step => [step.name, step]));

  it('long: limit 2 t pod stopem, posun dál/utažení o 8 t, BE z fillu, limit na lepší straně, stop 20 b nad trhem', () => {
    const steps = stopLimitSteps(plan(), { entryFill: 30_010.25, anchor: 30_050 });
    expect(steps.map(step => step.name)).toEqual([...STOP_LIMIT_STEP_ORDER]);
    const named = byName(steps);
    expect(named['to-stoplimit']).toMatchObject({ stopPrice: 29_900, limitPrice: 29_899.5 });
    expect(named.further).toMatchObject({ stopPrice: 29_898, limitPrice: 29_897.5 });
    expect(named.tighten).toMatchObject({ stopPrice: 29_902, limitPrice: 29_901.5 });
    expect(named.tighten.skip).toBeUndefined();
    expect(named.breakeven).toMatchObject({ stopPrice: 30_010.25, limitPrice: 30_009.75 });
    expect(named.breakeven.skip).toBeUndefined();
    expect(named['limit-better-side']).toMatchObject({ stopPrice: 29_900, limitPrice: 29_900.5 });
    expect(named['through-market']).toMatchObject({ stopPrice: 30_070, limitPrice: 30_069.5 });
    for (const step of steps) expect(stopLimitStepProblems(step, plan()), step.name).toEqual([]);
  });

  it('short zrcadlově', () => {
    const short = plan({ side: 'Sell', entry: 29_990, stopLoss: 30_100, takeProfit: 29_500 });
    const named = byName(stopLimitSteps(short, { entryFill: 29_990, anchor: 29_950 }));
    expect(named['to-stoplimit']).toMatchObject({ stopPrice: 30_100, limitPrice: 30_100.5 });
    expect(named.further).toMatchObject({ stopPrice: 30_102, limitPrice: 30_102.5 });
    expect(named.tighten).toMatchObject({ stopPrice: 30_098 });
    expect(named.breakeven).toMatchObject({ stopPrice: 29_990, limitPrice: 29_990.5 });
    expect(named.breakeven.skip).toBeUndefined();
    expect(named['limit-better-side']).toMatchObject({ stopPrice: 30_100, limitPrice: 30_099.5 });
    expect(named['through-market']).toMatchObject({ stopPrice: 29_930, limitPrice: 29_930.5 });
  });

  it('BE a utažení se přeskočí bez rezervy 16 t od trhu, bez fillu nebo bez ceny workeru — nikdy se nehádá', () => {
    const near = byName(stopLimitSteps(plan(), { entryFill: 30_010, anchor: 30_012 }));
    expect(near.breakeven.skip).toContain('16 t');
    expect(near.tighten.skip).toBeUndefined();
    const noFill = byName(stopLimitSteps(plan(), { entryFill: null, anchor: 30_050 }));
    expect(noFill.breakeven.skip).toContain('fillu');
    const noAnchor = byName(stopLimitSteps(plan(), { entryFill: 30_010, anchor: null }));
    expect(noAnchor.tighten.skip).toContain('cena workeru');
    expect(noAnchor.breakeven.skip).toContain('cena workeru');
    // Bez ceny workeru jde „přes trh“ od fillu.
    expect(noAnchor['through-market'].stopPrice).toBe(30_030);
    // Nesmyslný fill mimo tick se zaokrouhlí na tick.
    expect(byName(stopLimitSteps(plan(), { entryFill: 30_010.1, anchor: 30_050 })).breakeven.stopPrice).toBe(30_010);
  });

  it('pojistka kroku: tick, vzdálenost od vstupu, odstup limitu', () => {
    const base = { name: 'further' as const, stopPrice: 29_900, limitPrice: 29_899.5, checks: '' };
    expect(stopLimitStepProblems(base, plan())).toEqual([]);
    expect(stopLimitStepProblems({ ...base, stopPrice: 29_900.1 }, plan()).join(' ')).toContain('tick');
    expect(stopLimitStepProblems({ ...base, stopPrice: 28_000, limitPrice: 27_999.5 }, plan()).join(' ')).toContain('2 %');
    expect(stopLimitStepProblems({ ...base, limitPrice: 29_880 }, plan()).join(' ')).toContain('odstup');
  });

  it('průměrný fill vstupu: jen jeho fill, deduplikace podle fillId, vážený průměr', () => {
    const fills = [
      { fillId: 'a', brokerOrderId: 'e', quantity: 1, price: 30_010 },
      { fillId: 'a', brokerOrderId: 'e', quantity: 1, price: 30_010 },
      { fillId: 'b', brokerOrderId: 'e', quantity: 1, price: 30_011 },
      { fillId: 'c', brokerOrderId: 'x', quantity: 1, price: 1 },
    ];
    expect(averageFillPrice(fills, 'e')).toBe(30_010.5);
    expect(averageFillPrice(fills, 'none')).toBeNull();
  });
});
