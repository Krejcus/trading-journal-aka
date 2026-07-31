export type CoachRetrievalDomain =
  | 'memory'
  | 'conversations'
  | 'trades'
  | 'journal'
  | 'incidents'
  | 'execution_imports'
  | 'accounts'
  | 'business'
  | 'lab'
  | 'insights'
  | 'backtest'
  | 'market_context'
  | 'trade_media';

export interface CoachRetrievalPlan {
  domains: CoachRetrievalDomain[];
  requiredCalls: CoachRetrievalCall[];
  requiredTools: string[];
  requiresLongTermRecall: boolean;
  requiresCanonicalEvidence: boolean;
  reasonCodes: string[];
}

export interface CoachRetrievalCall {
  tool: string;
  args?: Record<string, string>;
}

export function coachRetrievalCallKey(call: CoachRetrievalCall): string {
  const args = Object.entries(call.args || {}).sort(([a], [b]) => a.localeCompare(b));
  return args.length ? `${call.tool}:${args.map(([k, v]) => `${k}=${v}`).join('&')}` : call.tool;
}

export function actualCoachToolCallKeys(tool: string, args: Record<string, unknown> | undefined): string[] {
  const keys = [tool];
  if (tool === 'get_coach_records' && typeof args?.domain === 'string') {
    keys.push(coachRetrievalCallKey({ tool, args: { domain: args.domain } }));
  }
  if (tool === 'get_stats' && typeof args?.group_by === 'string') {
    keys.push(coachRetrievalCallKey({ tool, args: { group_by: args.group_by } }));
  }
  return keys;
}

const has = (text: string, expression: RegExp) => expression.test(text);

/**
 * Cheap deterministic router. It does not answer the question; it only prevents
 * the model from skipping a canonical source because recent prompt context looks
 * sufficient. The 90-day front-loaded context remains in place until evals prove
 * that progressive retrieval is at least as reliable.
 */
export function planCoachRetrieval(query: string): CoachRetrievalPlan {
  const text = String(query || '').toLocaleLowerCase('cs-CZ');
  const domains = new Set<CoachRetrievalDomain>();
  const calls = new Map<string, CoachRetrievalCall>();
  const reasonCodes: string[] = [];
  const requireCall = (tool: string, args?: Record<string, string>) => {
    const call = { tool, ...(args ? { args } : {}) };
    calls.set(coachRetrievalCallKey(call), call);
  };

  const recurrence = has(text, /už někdy|stalo se.*dřív|před (měsíc|rok|týdn)|pamatuješ|pamatuj|opakovan|znovu|histor|v minulosti|podobn(á|é|ý|ou)|řešili jsme|dohodli.*(minul|dřív)|závazek.*(plat|aktuál)|původní zákaz/);
  if (recurrence) {
    domains.add('memory'); domains.add('conversations'); domains.add('trades'); domains.add('journal');
    requireCall('recall_memory'); requireCall('search_history');
    reasonCodes.push('cross-history-recurrence');
  }

  const incident = has(text, /incident|gambl|tilt|nevalid|hlava nehlava|mimo trad|spálen|spalen|revenge/);
  const execution = has(text, /market|limit|stop|příkaz|prikaz|exekuc|fill|size|velikost|rychlost|jak rychle|navyš|navys|kopi/);
  if (incident) {
    domains.add('incidents'); domains.add('accounts'); domains.add('journal');
    requireCall('get_incident_analysis');
    reasonCodes.push('incident-detail');
  }
  if (incident && execution) {
    domains.add('execution_imports');
    reasonCodes.push('incident-execution-anatomy');
  }

  if (has(text, /win ?rate|profit factor|\brr\b|\bpnl\b|kolik|statistik|nejlepší|nejhorsi|nejhorší/)) {
    domains.add('trades');
    requireCall('get_stats');
    reasonCodes.push('deterministic-stats');
  }
  if (has(text, /ponděl|úter|střed|čtvrt|pát|den v týdnu|weekday/) && has(text, /podle dat|přestat|funguje|výkon|statistik|win ?rate|zisk|ztrát/)) {
    domains.add('trades'); domains.add('journal');
    requireCall('get_stats', { group_by: 'weekday' });
    reasonCodes.push('weekday-sample-check');
  }
  if (has(text, /setup|kombinac|mae|mfe|take.?profit|\btp\b|stop.?loss|\bsl\b|counterfactual|leak/)) {
    domains.add('lab'); domains.add('trades');
    requireCall('get_lab_analytics');
    reasonCodes.push('lab-analysis');
  }
  if (has(text, /experiment|hypotéz|hypotez|co jsme testovali|jak dopadl|vyhodnotit vzorek/)) {
    domains.add('lab'); domains.add('insights'); domains.add('memory'); domains.add('trades');
    requireCall('get_experiments');
    reasonCodes.push('mentor-experiment-follow-up');
  }
  if (has(text, /payout|výplat|vyplat|náklad|naklad|challenge|business|reálně vydělal|realne vydelal/)) {
    domains.add('business'); domains.add('accounts');
    requireCall('get_business_summary');
    reasonCodes.push('business-money');
  }
  if (has(text, /weekly|týdenn(í|ím|ího) report|tydenn(i|im|iho) report|weekly focus|týdenní cíl|tydenni cil|daily insight|insight/)) {
    domains.add('insights');
    requireCall('get_coach_records', { domain: 'insights' });
    reasonCodes.push('insights-and-reports');
  }
  if (has(text, /backtest session|backtest poznám|backtest poznam|pre.?notes|post.?notes/)) {
    domains.add('backtest');
    requireCall('get_coach_records', { domain: 'backtest_sessions' });
    reasonCodes.push('backtest-session-detail');
  }
  if (has(text, /screenshot|screen|obráz|obraz|vizuál|vizual|důkaz výplaty|dukaz vyplaty/)) {
    domains.add('trade_media'); domains.add('trades');
    requireCall('get_coach_records', { domain: 'trade_media' });
    reasonCodes.push('media-evidence');
    if (has(text, /co (je|vidíš|vidis)|analyz|rozeb|popiš|popis|přečti|precti|interpret|zkontrol|vyhodnoť|vyhodnot|poznáš|poznas|najdi.*(chybu|setup|vstup|level)/)) {
      requireCall('get_coach_media');
      reasonCodes.push('media-vision-content');
    }
  }
  if (has(text, /fronta importu|nespárovan|nesparovan|pending|unlinked|raw objednáv|raw objednav|account map/)) {
    domains.add('execution_imports');
    requireCall('get_coach_records', { domain: 'execution_imports' });
    reasonCodes.push('raw-import-drilldown');
  }
  if (has(text, /skutečn(ých|é) rozhodnut|jen kopie|copy fan.?out|kolik záznamů.*kopi/)) {
    domains.add('accounts'); domains.add('trades');
    requireCall('get_stats');
    reasonCodes.push('copy-decision-collapse');
  }
  if (has(text, /live.*backtest|backtest.*live|porovnej.*backtest|nesmíchej.*statistik/)) {
    domains.add('backtest'); domains.add('market_context'); domains.add('trades');
    requireCall('get_lab_analytics');
    reasonCodes.push('live-backtest-separation');
  }
  if (has(text, /časová osa účtu|casova osa uctu|historie účtu|historie uctu|account event/)) {
    domains.add('accounts');
    requireCall('get_coach_records', { domain: 'account_events' });
    reasonCodes.push('account-event-timeline');
  }
  if (has(text, /ukaž|ukaz|vypiš|vypis|seřaď|serad|tabulk|konkrétní obchod/)) {
    domains.add('trades');
    requireCall('list_trades');
    reasonCodes.push('exact-record-list');
  }

  const requiredCalls = [...calls.values()];
  return {
    domains: [...domains],
    requiredCalls,
    requiredTools: [...new Set(requiredCalls.map(call => call.tool))],
    requiresLongTermRecall: recurrence,
    requiresCanonicalEvidence: recurrence || incident || requiredCalls.length > 0,
    reasonCodes,
  };
}

export function renderRetrievalPlanForPrompt(plan: CoachRetrievalPlan): string {
  if (plan.requiredTools.length === 0) return '';
  return [
    '=== RETRIEVAL PLANNER (deterministická pojistka) ===',
    `Potřebné domény: ${plan.domains.join(', ') || 'žádné'}`,
    `Povinná volání před konečnou odpovědí: ${plan.requiredCalls.map(call => call.args ? `${call.tool}(${JSON.stringify(call.args)})` : call.tool).join(', ')}`,
    `Důvody: ${plan.reasonCodes.join(', ')}`,
    'Tento blok není důkaz. Odpověď musí použít kanonická data a vrácené evidence reference.',
  ].join('\n');
}
