export type CoachSurface = 'app' | 'mcp';
export type CoachCoverageLevel = 'none' | 'summary' | 'full';
export type CoachDataPriority = 'critical' | 'high' | 'medium';

export interface CoachDataDomain {
  id: string;
  label: string;
  description: string;
  sources: string[];
  priority: CoachDataPriority;
  current: Record<CoachSurface, CoachCoverageLevel>;
  target: Record<CoachSurface, CoachCoverageLevel>;
  gap: string | null;
}

/**
 * Executable source of truth for Coach data coverage.
 *
 * `summary` means the surface receives a derived/abridged representation but
 * cannot drill down to every source record. `full` means the surface can
 * retrieve the canonical record (or a lossless projection) on demand.
 *
 * Keep this list honest: changing a prompt from "partial" to "complete" is not
 * a coverage improvement. A domain moves to `full` only after a read path and
 * an eval prove it on both Coach surfaces.
 */
export const COACH_DATA_DOMAINS: readonly CoachDataDomain[] = [
  {
    id: 'profile',
    label: 'Profil a preference',
    description: 'Stabilní fakta o traderovi a způsob, jakým má Coach komunikovat.',
    sources: ['ai_coach_profile'],
    priority: 'critical',
    current: { app: 'full', mcp: 'full' },
    target: { app: 'full', mcp: 'full' },
    gap: null,
  },
  {
    id: 'memory',
    label: 'Dlouhodobá paměť a závazky',
    description: 'Pozorování, epizody, shrnutí konverzací a aktivní závazky.',
    sources: ['ai_coach_memory'],
    priority: 'critical',
    current: { app: 'full', mcp: 'full' },
    target: { app: 'full', mcp: 'full' },
    gap: null,
  },
  {
    id: 'conversations',
    label: 'Historie konverzací',
    description: 'Vlákna a zprávy AI Coache včetně jejich témat a shrnutí.',
    sources: ['ai_conversations', 'ai_messages'],
    priority: 'high',
    current: { app: 'full', mcp: 'full' },
    target: { app: 'full', mcp: 'full' },
    gap: null,
  },
  {
    id: 'accounts',
    label: 'Účty a drawdown',
    description: 'Stav účtů, fáze, balance, payouty, funerals a EOD drawdown.',
    sources: ['accounts', 'business_payouts', 'daily_reviews.data.incidents'],
    priority: 'critical',
    current: { app: 'full', mcp: 'full' },
    target: { app: 'full', mcp: 'full' },
    gap: null,
  },
  {
    id: 'trades',
    label: 'Obchody a obchodní rozhodnutí',
    description: 'Validní, nevalidní a missed obchody včetně copy fan-out vazeb.',
    sources: ['trades'],
    priority: 'critical',
    current: { app: 'full', mcp: 'full' },
    target: { app: 'full', mcp: 'full' },
    gap: null,
  },
  {
    id: 'journal',
    label: 'Přípravy, audity a psychologie',
    description: 'Denní přípravy, session plány, review, quick notes, emoce a lekce.',
    sources: ['daily_preps', 'daily_reviews'],
    priority: 'critical',
    current: { app: 'full', mcp: 'full' },
    target: { app: 'full', mcp: 'full' },
    gap: null,
  },
  {
    id: 'execution_imports',
    label: 'Raw exekuce a order flow',
    description: 'Tradecopia exekuce a objednávky: Market/Limit/Stop, velikost, fill, ceny a timing.',
    sources: ['imported_trades', 'imported_orders', 'import_account_map'],
    priority: 'critical',
    current: { app: 'full', mcp: 'full' },
    target: { app: 'full', mcp: 'full' },
    gap: null,
  },
  {
    id: 'incidents',
    label: 'Incidenty a nevalidní ztráty',
    description: 'Gambling/discipline incidenty, jejich alokace a vazba na zdrojové exekuce.',
    sources: ['daily_reviews.data.incidents', 'imported_trades.incident_ref'],
    priority: 'critical',
    current: { app: 'full', mcp: 'full' },
    target: { app: 'full', mcp: 'full' },
    gap: null,
  },
  {
    id: 'execution_path',
    label: 'Cesta obchodu po vstupu',
    description: 'MFE/MAE, 1m cesta, čas u entry, SL/TP varianty a dosažené levely.',
    sources: ['trades.data', 'candle_cache', 'Lab analytics'],
    priority: 'high',
    current: { app: 'full', mcp: 'full' },
    target: { app: 'full', mcp: 'full' },
    gap: null,
  },
  {
    id: 'market_context',
    label: 'Kontext trhu a levely',
    description: 'HTF/LTF confluence, session, bias, VWAP, likviditní levely a jejich vzdálenost/hit.',
    sources: ['trades.data', 'daily_preps', 'AlphaBridge payload'],
    priority: 'high',
    current: { app: 'full', mcp: 'full' },
    target: { app: 'full', mcp: 'full' },
    gap: null,
  },
  {
    id: 'trade_media',
    label: 'Screenshoty a vizuální důkazy',
    description: 'Screenshoty obchodů, příprav, breakdownů a payoutů včetně případné vision analýzy.',
    sources: ['trades.data.screenshots', 'daily_preps', 'daily_reviews', 'business_payouts'],
    priority: 'medium',
    current: { app: 'full', mcp: 'full' },
    target: { app: 'full', mcp: 'full' },
    gap: null,
  },
  {
    id: 'business',
    label: 'Business Hub',
    description: 'Náklady, payouty, cíle, zdroje a ekonomika prop tradingu.',
    sources: ['business_expenses', 'business_payouts', 'business_goals', 'business_resources'],
    priority: 'high',
    current: { app: 'full', mcp: 'full' },
    target: { app: 'full', mcp: 'full' },
    gap: null,
  },
  {
    id: 'insights',
    label: 'Insighty a týdenní řízení',
    description: 'Denní insighty, weekly focus/reporty a dlouhodobé experimenty.',
    sources: ['daily_insights', 'weekly_focus', 'weekly_reports', 'lab_experiments'],
    priority: 'high',
    current: { app: 'full', mcp: 'full' },
    target: { app: 'full', mcp: 'full' },
    gap: null,
  },
  {
    id: 'backtest',
    label: 'Backtest svět',
    description: 'Backtest účty, obchody, sessions, pre/post poznámky a porovnání s live.',
    sources: ['accounts', 'trades', 'backtest_sessions'],
    priority: 'high',
    current: { app: 'full', mcp: 'full' },
    target: { app: 'full', mcp: 'full' },
    gap: null,
  },
] as const;

export interface CoachEvalScenario {
  id: string;
  prompt: string;
  requiredDomains: string[];
  requiredAbilities: Array<'exact' | 'temporal' | 'cross_source' | 'memory' | 'abstention' | 'evidence'>;
  expectedEvidence: string[];
  /** Minimum canonical calls the deterministic router must require. */
  requiredToolCalls: Array<{ tool: string; args?: Record<string, string> }>;
}

/** Representative acceptance scenarios. They are model-agnostic by design. */
export const COACH_EVAL_SCENARIOS: readonly CoachEvalScenario[] = [
  {
    id: 'recurrence-over-90-days',
    prompt: 'Tohle se mi už někdy stalo? Připomeň mi podobnou situaci i kdyby byla starší než 90 dní.',
    requiredDomains: ['trades', 'journal', 'memory'],
    requiredAbilities: ['temporal', 'cross_source', 'memory', 'evidence'],
    expectedEvidence: ['trade', 'review'],
    requiredToolCalls: [{ tool: 'recall_memory' }, { tool: 'search_history' }],
  },
  {
    id: 'incident-execution-anatomy',
    prompt: 'Jak přesně probíhal poslední nevalidní incident: typy příkazů, velikost a rychlost vstupů?',
    requiredDomains: ['incidents', 'execution_imports', 'accounts'],
    requiredAbilities: ['exact', 'temporal', 'cross_source', 'evidence'],
    expectedEvidence: ['incident', 'execution', 'order'],
    requiredToolCalls: [{ tool: 'get_incident_analysis' }],
  },
  {
    id: 'real-pnl-without-stat-pollution',
    prompt: 'Kolik jsem reálně vydělal včetně payoutů a incidentů a jaký mám trade winrate?',
    requiredDomains: ['trades', 'incidents', 'accounts', 'business'],
    requiredAbilities: ['exact', 'cross_source', 'evidence'],
    expectedEvidence: ['trade_stats', 'incident', 'payout'],
    requiredToolCalls: [{ tool: 'get_stats' }, { tool: 'get_business_summary' }],
  },
  {
    id: 'copy-decision-collapse',
    prompt: 'Kolik skutečných rozhodnutí jsem udělal a kolik záznamů jsou jen kopie na účtech?',
    requiredDomains: ['trades', 'accounts'],
    requiredAbilities: ['exact', 'cross_source', 'evidence'],
    expectedEvidence: ['trade_group'],
    requiredToolCalls: [{ tool: 'get_stats' }],
  },
  {
    id: 'commitment-update',
    prompt: 'Původní zákaz live tradingu už neplatí. Jaký závazek je teď aktuální?',
    requiredDomains: ['memory', 'conversations'],
    requiredAbilities: ['temporal', 'memory', 'evidence'],
    expectedEvidence: ['memory_version', 'conversation'],
    requiredToolCalls: [{ tool: 'recall_memory' }, { tool: 'search_history' }],
  },
  {
    id: 'weak-pattern-abstention',
    prompt: 'Mám podle dat přestat obchodovat pondělky?',
    requiredDomains: ['trades', 'journal'],
    requiredAbilities: ['exact', 'abstention', 'evidence'],
    expectedEvidence: ['sample_size', 'trade_ids'],
    requiredToolCalls: [{ tool: 'get_stats', args: { group_by: 'weekday' } }],
  },
  {
    id: 'live-backtest-separation',
    prompt: 'Porovnej live a backtest výsledky stejného setupu, ale nesmíchej jejich statistiky.',
    requiredDomains: ['trades', 'backtest', 'market_context'],
    requiredAbilities: ['exact', 'cross_source', 'evidence'],
    expectedEvidence: ['live_trade_ids', 'backtest_trade_ids'],
    requiredToolCalls: [{ tool: 'get_lab_analytics' }],
  },
  {
    id: 'mentor-follow-up',
    prompt: 'Jak dopadl experiment, na kterém jsme se dohodli minulý týden?',
    requiredDomains: ['memory', 'insights', 'conversations', 'trades', 'journal'],
    requiredAbilities: ['temporal', 'cross_source', 'memory', 'evidence'],
    expectedEvidence: ['commitment', 'experiment', 'trade_or_review'],
    requiredToolCalls: [{ tool: 'get_experiments' }, { tool: 'recall_memory' }, { tool: 'search_history' }],
  },
  {
    id: 'vision-evidence',
    prompt: 'Analyzuj screenshot posledního obchodu a popiš, co je na něm vidět.',
    requiredDomains: ['trade_media', 'trades'],
    requiredAbilities: ['exact', 'cross_source', 'evidence'],
    expectedEvidence: ['image_content', 'trade'],
    requiredToolCalls: [
      { tool: 'get_coach_records', args: { domain: 'trade_media' } },
      { tool: 'get_coach_media' },
    ],
  },
] as const;

export interface CoachEvalContractResult {
  scenarioId: string;
  passed: boolean;
  missingDomains: string[];
  missingCalls: string[];
  plan: CoachRetrievalPlan;
}

/**
 * Deterministic pre-model eval. It proves that the router forces the canonical
 * sources needed by a scenario; it deliberately does not pretend to grade the
 * natural-language answer itself.
 */
export function evaluateCoachRetrievalContract(
  scenario: CoachEvalScenario,
): CoachEvalContractResult {
  const plan = planCoachRetrieval(scenario.prompt);
  const plannedDomains = new Set<string>(plan.domains);
  const plannedCalls = new Set(plan.requiredCalls.map(coachRetrievalCallKey));
  const missingDomains = scenario.requiredDomains.filter(domain => !plannedDomains.has(domain));
  const missingCalls = scenario.requiredToolCalls
    .map(coachRetrievalCallKey)
    .filter(call => !plannedCalls.has(call));
  return {
    scenarioId: scenario.id,
    passed: missingDomains.length === 0 && missingCalls.length === 0,
    missingDomains,
    missingCalls,
    plan,
  };
}

export function evaluateAllCoachRetrievalContracts(): CoachEvalContractResult[] {
  return COACH_EVAL_SCENARIOS.map(evaluateCoachRetrievalContract);
}

const LEVEL_SCORE: Record<CoachCoverageLevel, number> = {
  none: 0,
  summary: 1,
  full: 2,
};

export function getCoachCoverageGaps(surface: CoachSurface): CoachDataDomain[] {
  return COACH_DATA_DOMAINS.filter(domain =>
    LEVEL_SCORE[domain.current[surface]] < LEVEL_SCORE[domain.target[surface]],
  );
}

export function getCoachSurfaceParityGaps(): CoachDataDomain[] {
  return COACH_DATA_DOMAINS.filter(domain => domain.current.app !== domain.current.mcp);
}

export function getCoachCoverageScore(surface: CoachSurface): number {
  const achieved = COACH_DATA_DOMAINS.reduce((sum, domain) => sum + LEVEL_SCORE[domain.current[surface]], 0);
  const target = COACH_DATA_DOMAINS.reduce((sum, domain) => sum + LEVEL_SCORE[domain.target[surface]], 0);
  return target === 0 ? 100 : Math.round((achieved / target) * 1000) / 10;
}
import {
  coachRetrievalCallKey,
  planCoachRetrieval,
  type CoachRetrievalPlan,
} from './coachRetrievalPlanner';
