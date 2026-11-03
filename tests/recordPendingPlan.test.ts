import { describe, expect, it } from 'vitest';
import {
  DEMO_RECORD_ACCOUNT_ID,
  demoPlanProblems,
  dryRunScenario,
  resolveDemoPrice,
  scenarioFills,
  scenarioMaxExposure,
  scenarioStructureProblems,
  type DemoStep,
} from '../scripts/copier/recordDemoPlan';
import { PENDING_SCENARIOS, parseRecordPendingArgs, pendingScenario, type RecordPendingOptions } from '../scripts/copier/recordPendingPlan';

const NOW = Date.UTC(2026, 10, 3, 15, 0);
const base = ['--account', String(DEMO_RECORD_ACCOUNT_ID), '--symbol', 'MNQZ6', '--market-price', '28000'];
const parse = (...extra: string[]) => parseRecordPendingArgs([...base, ...extra]);
const options = (patch: Partial<RecordPendingOptions> = {}): RecordPendingOptions => ({ slPoints: 40, tpPoints: 40, fillWaitMs: 180_000, ...patch });
const FILLS = new Set(['move-entry-stop', 'suspended-legs-then-fill']);

describe('record-pending: argumenty', () => {
  it('all, aliasy R1–R6', () => {
    expect(parse('--scenario', 'all').scenarios.map(item => item.name)).toEqual([...PENDING_SCENARIOS]);
    expect(parse('--scenario', 'r1,R3,r5,r6').scenarios.map(item => item.name)).toEqual(['move-entry-limit', 'move-suspended-legs', 'parent-qty', 'multi-pending']);
    expect(parse('--scenario', 'r4', '--fill-wait-ms', '60000').options.fillWaitMs).toBe(60_000);
  });

  it('překryvy a zamítnuté odkážou jinam', () => {
    expect(() => parse('--scenario', 'r7')).toThrow('record-exits.ts --scenario tp-fill --placement sequential');
    expect(() => parse('--scenario', 'r6b')).toThrow('pending-modify');
    expect(() => parse('--scenario', 'oco-breakout')).toThrow('zamítnuté');
  });

  it.each([
    [['--fill-wait-ms', '200000'], '--fill-wait-ms'], [['--fill-wait-ms', '500'], '--fill-wait-ms'],
    [['--sl-points', '20'], '--sl-points'], [['--tp-points', '1000'], '--tp-points'],
  ])('neplatné %o se odmítne', (extra, message) => {
    expect(() => parse('--scenario', 'r1', ...extra)).toThrow(message);
  });

  it('jiný účet / kontrakt neprojde; --confirm bez --allow-fill jen u scénářů s fillem', () => {
    expect(demoPlanProblems(parseRecordPendingArgs(['--account', '1', '--symbol', 'MNQZ6', '--market-price', '28000', '--scenario', 'r1']), NOW).join(' ')).toContain('DEMO8661118');
    expect(demoPlanProblems(parseRecordPendingArgs(['--account', String(DEMO_RECORD_ACCOUNT_ID), '--symbol', 'MNQU6', '--market-price', '28000', '--scenario', 'r1']), NOW).join(' ')).toContain('front kontrakt');
    expect(demoPlanProblems(parse('--scenario', 'r1,r3,r5,r6', '--confirm'), NOW)).toEqual([]);
    const refused = demoPlanProblems(parse('--scenario', 'all', '--confirm'), NOW);
    expect(refused.map(item => item.split(':')[0]).sort()).toEqual([...FILLS].sort());
  });
});

describe('record-pending: scénáře', () => {
  it('každý scénář: struktura, pozice ≤ 2, fill jen R2/R4, projde pojistkami při trhu (Buy i Sell)', () => {
    for (const variant of [options(), options({ slPoints: 80, tpPoints: 120 })]) {
      for (const name of PENDING_SCENARIOS) {
        const scenario = pendingScenario(name, variant);
        expect(scenarioStructureProblems(scenario), name).toEqual([]);
        expect(scenarioMaxExposure(scenario.steps), name).toBeLessThanOrEqual(2);
        expect(scenarioFills(scenario.steps), name).toBe(FILLS.has(name));
        expect(dryRunScenario(scenario, 'Buy', 28_000), name).toEqual([]);
        expect(dryRunScenario(scenario, 'Sell', 28_000), name).toEqual([]);
      }
    }
  });

  it('R1: rodič −4 a +8 b s klasifikací relativního posunu, pak zrušení a kaskáda', () => {
    const steps = pendingScenario('move-entry-limit', options()).steps;
    const modifies = steps.filter(step => step.kind === 'modify') as Array<Extract<DemoStep, { kind: 'modify' }>>;
    expect(modifies.map(step => step.changes[0].price)).toEqual([{ from: 'current', points: -4 }, { from: 'current', points: 8 }]);
    expect(modifies.every(step => step.classify?.name === 'relative-leg-move')).toBe(true);
    expect(steps.at(-1)).toMatchObject({ kind: 'cancel', classify: { name: 'cascade' } });
  });

  it('R2: Stop přes trh jen s příznakem throughMarket, pak úklid včetně liquidate', () => {
    const steps = pendingScenario('move-entry-stop', options()).steps;
    expect(steps[0]).toMatchObject({ tickets: [{ entry: { orderType: 'Stop', price: { ratio: 0.015 } } }] });
    expect(steps.find(step => step.kind === 'modify' && step.changes[0].throughMarket)).toMatchObject({ classify: { name: 'through-market-entry' } });
    expect(steps.at(-1)?.kind).toBe('liquidate');
  });

  it('R3: Suspended SL/TP zvlášť i souběžně; SL Stop vstupu mezi trh a vstup jen s throughMarket', () => {
    const steps = pendingScenario('move-suspended-legs', options()).steps;
    const modifies = steps.filter(step => step.kind === 'modify') as Array<Extract<DemoStep, { kind: 'modify' }>>;
    expect(modifies.map(step => step.changes.length)).toEqual([1, 1, 2, 1]);
    expect(modifies[3]).toMatchObject({ changes: [{ target: { ticket: 't2', order: 'sl' }, throughMarket: true, price: { from: 'market', ratio: 0.0075 } }] });
    // Buy: SL Stop vstupu je mezi trhem a vstupem.
    const sl = resolveDemoPrice(modifies[3].changes[0].price!, { anchor: 28_000, dir: 1 });
    const entry = resolveDemoPrice({ from: 'market', ratio: 0.015 }, { anchor: 28_000, dir: 1 });
    expect(sl).toBeGreaterThan(28_000);
    expect(sl).toBeLessThan(entry);
  });

  it('R4: Limit na trhu, modify nohou hned po zadání (bez čtení mezi), pak čekání na fill', () => {
    const steps = pendingScenario('suspended-legs-then-fill', options({ fillWaitMs: 30_000 })).steps;
    expect(steps.slice(0, 3).map(step => step.kind)).toEqual(['place-oso', 'modify', 'wait-fill']);
    expect(steps[0]).not.toHaveProperty('observeMs');
    expect(steps[1]).not.toHaveProperty('observeMs');
    expect(steps[2]).toMatchObject({ timeoutMs: 30_000 });
    expect(steps[3]).toMatchObject({ classify: { name: 'fill-with-modified-legs' } });
  });

  it('R5: qty rodiče 2→1→2 (strop 2)', () => {
    const steps = pendingScenario('parent-qty', options()).steps;
    expect(steps[0]).toMatchObject({ tickets: [{ quantity: 2 }] });
    expect(steps.filter(step => step.kind === 'modify').map(step => step.kind === 'modify' && step.changes[0].quantity)).toEqual([1, 2]);
  });

  it('R6: dvě kola souběžných OSO; A stejná cena a různé TP, B žebřík se stejnými SL/TP pod oběma vstupy', () => {
    const steps = pendingScenario('multi-pending', options()).steps;
    const placements = steps.filter(step => step.kind === 'place-oso') as Array<Extract<DemoStep, { kind: 'place-oso' }>>;
    expect(placements.map(step => step.tickets.length)).toEqual([2, 2]);
    expect(placements[0].tickets[0].entry).toEqual(placements[0].tickets[1].entry);
    expect(placements[0].tickets[0].takeProfit).not.toEqual(placements[0].tickets[1].takeProfit);
    const [b1, b2] = placements[1].tickets;
    const at = (ref: Parameters<typeof resolveDemoPrice>[0]) => resolveDemoPrice(ref, { anchor: 28_000, dir: 1 });
    const entries = [b1, b2].map(ticket => at((ticket.entry as { price: Parameters<typeof resolveDemoPrice>[0] }).price));
    expect(entries[0] - entries[1]).toBe(10);
    expect(at(b1.stopLoss)).toBe(at(b2.stopLoss));
    expect(at(b1.stopLoss)).toBeLessThan(Math.min(...entries) - 39);
    expect(steps.filter(step => step.kind === 'cancel' && step.classify?.name === 'cancel-one-of-many')).toHaveLength(2);
  });
});
