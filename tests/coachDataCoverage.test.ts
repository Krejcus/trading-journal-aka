import { describe, expect, it } from 'vitest';
import {
  COACH_DATA_DOMAINS,
  COACH_EVAL_SCENARIOS,
  evaluateAllCoachRetrievalContracts,
  getCoachCoverageGaps,
  getCoachCoverageScore,
  getCoachSurfaceParityGaps,
} from '../services/coachDataCoverage';

describe('Coach data coverage contract', () => {
  it('má unikátní domény s dohledatelným zdrojem a plným cílem pro oba surfaces', () => {
    const ids = COACH_DATA_DOMAINS.map(domain => domain.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const domain of COACH_DATA_DOMAINS) {
      expect(domain.sources.length).toBeGreaterThan(0);
      expect(domain.target).toEqual({ app: 'full', mcp: 'full' });
      if (domain.current.app !== 'full' || domain.current.mcp !== 'full') {
        expect(domain.gap).toBeTruthy();
      }
    }
  });

  it('všechny evidované domény mají implementované plné pokrytí', () => {
    expect(getCoachCoverageScore('app')).toBe(100);
    expect(getCoachCoverageScore('mcp')).toBe(100);
    expect(getCoachCoverageGaps('app')).toEqual([]);
    expect(getCoachCoverageGaps('mcp')).toEqual([]);
  });

  it('udržuje plnou shodu pokrytí app Coache a MCP', () => {
    const parityGaps = getCoachSurfaceParityGaps().map(domain => domain.id);
    expect(parityGaps).toEqual([]);
    expect(getCoachCoverageGaps('app')).toEqual([]);
    expect(getCoachCoverageGaps('mcp')).toEqual([]);
  });

  it('každý eval používá existující domény a vyžaduje konkrétní evidence', () => {
    const domainIds = new Set(COACH_DATA_DOMAINS.map(domain => domain.id));
    const scenarioIds = COACH_EVAL_SCENARIOS.map(scenario => scenario.id);
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);

    for (const scenario of COACH_EVAL_SCENARIOS) {
      expect(scenario.requiredDomains.length).toBeGreaterThan(0);
      expect(scenario.expectedEvidence.length).toBeGreaterThan(0);
      for (const domain of scenario.requiredDomains) expect(domainIds.has(domain)).toBe(true);
    }
  });

  it('chrání schopnost připomenout podobnou událost starší než 90 dní', () => {
    const scenario = COACH_EVAL_SCENARIOS.find(item => item.id === 'recurrence-over-90-days');
    expect(scenario).toMatchObject({
      requiredDomains: expect.arrayContaining(['trades', 'journal', 'memory']),
      requiredAbilities: expect.arrayContaining(['temporal', 'evidence']),
    });
  });

  it('všechny akceptační scénáře vynutí potřebné domény a canonical tool cally', () => {
    const results = evaluateAllCoachRetrievalContracts();
    expect(results.filter(result => !result.passed)).toEqual([]);
  });
});
