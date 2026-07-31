import { describe, expect, it } from 'vitest';
import {
  actualCoachToolCallKeys,
  coachRetrievalCallKey,
  planCoachRetrieval,
  renderRetrievalPlanForPrompt,
} from '../services/coachRetrievalPlanner';

describe('Coach progressive retrieval planner', () => {
  it('chrání spontánní připomenutí událostí starších než 90 dní', () => {
    const plan = planCoachRetrieval('Tohle se mi stalo i před měsícem, pamatuješ?');
    expect(plan.requiresLongTermRecall).toBe(true);
    expect(plan.requiredTools).toEqual(expect.arrayContaining(['recall_memory', 'search_history']));
    expect(plan.domains).toEqual(expect.arrayContaining(['memory', 'conversations', 'trades', 'journal']));
  });

  it('pro anatomii incidentu vyžádá canonical raw exekuce', () => {
    const plan = planCoachRetrieval('Jak rychle jsem navyšoval size a byly vstupy market nebo limit? Ten gambling incident.');
    expect(plan.requiredTools).toContain('get_incident_analysis');
    expect(plan.domains).toEqual(expect.arrayContaining(['incidents', 'execution_imports']));
    expect(plan.requiresCanonicalEvidence).toBe(true);
  });

  it('oddělí business peníze od trade statistik', () => {
    const plan = planCoachRetrieval('Kolik jsem reálně vydělal včetně payoutů a jaký mám winrate?');
    expect(plan.requiredTools).toEqual(expect.arrayContaining(['get_business_summary', 'get_stats']));
    expect(plan.domains).toEqual(expect.arrayContaining(['business', 'trades']));
  });

  it('nevynucuje nástroje pro čistě konverzační zprávu', () => {
    const plan = planCoachRetrieval('Ahoj, dnes se cítím klidně.');
    expect(plan.requiredTools).toEqual([]);
    expect(renderRetrievalPlanForPrompt(plan)).toBe('');
  });

  it('naváže mentor follow-up na skutečný Lab experiment', () => {
    const plan = planCoachRetrieval('Jak dopadl experiment, který jsme minulý týden testovali?');
    expect(plan.requiredTools).toContain('get_experiments');
    expect(plan.domains).toEqual(expect.arrayContaining(['lab', 'memory', 'trades']));
  });

  it('dohledá data, která nejsou součástí běžného promptu', () => {
    const plan = planCoachRetrieval('Ukaž mi screenshot a poznámky z backtest session v týdenním reportu.');
    expect(plan.requiredTools).toContain('get_coach_records');
    expect(plan.domains).toEqual(expect.arrayContaining(['trade_media', 'backtest', 'insights']));
    expect(plan.requiredCalls).toEqual(expect.arrayContaining([
      { tool: 'get_coach_records', args: { domain: 'trade_media' } },
      { tool: 'get_coach_records', args: { domain: 'backtest_sessions' } },
      { tool: 'get_coach_records', args: { domain: 'insights' } },
    ]));
  });

  it('vyžádá skutečný vision obsah, když má obrázek interpretovat', () => {
    const plan = planCoachRetrieval('Analyzuj screenshot obchodu a popiš, co je na něm špatně.');
    expect(plan.requiredTools).toContain('get_coach_media');
    expect(plan.reasonCodes).toContain('media-vision-content');
  });

  it('nepovažuje volání obecného nástroje pro špatnou doménu za splnění', () => {
    const required = coachRetrievalCallKey({ tool: 'get_coach_records', args: { domain: 'trade_media' } });
    const actual = actualCoachToolCallKeys('get_coach_records', { domain: 'insights' });
    expect(actual).not.toContain(required);
    expect(actualCoachToolCallKeys('get_coach_records', { domain: 'trade_media' })).toContain(required);
  });

  it('použije canonical import drill-down pro nespárované exekuce', () => {
    const plan = planCoachRetrieval('Co zůstalo pending a nespárované ve frontě importu?');
    expect(plan.requiredTools).toContain('get_coach_records');
    expect(plan.domains).toContain('execution_imports');
  });
});
