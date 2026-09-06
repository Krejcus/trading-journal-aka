/** Market time answers when price moved; recorded time answers when this research record was made. */
export interface ExperimentCohortConfig {
  id?: string;
  research?: { revisions: readonly { id: string; hash: string; recordedAt: number | null }[] };
  researchRevisionId?: string;
  researchRole?: 'development' | 'validation';
  researchPositionEvidence?: readonly { accountId:string; runId:string; positionId:string; expectedTradeIds:readonly string[]; closed:boolean }[];
  startTs: number;
  endTs?: number;
  clock?: 'market' | 'recorded';
  baselineTradeIds?: string[];
  accountIds?: string[];
}

interface CohortTrade {
  id: string | number;
  accountId: string;
  ts: number;
  raw: { recordedAt?: unknown; createdAt?: unknown; backtestRunId?: string; backtestResearch?: { experimentId:string; revisionId:string; revisionHash:string; role:string } };
}

const recordedTime = (trade: CohortTrade): number | null => {
  // Explicit unknown survives JSON; a later server insert is not a new replay decision.
  if (trade.raw.recordedAt === null) return null;
  for (const value of [trade.raw.recordedAt, trade.raw.createdAt]) {
    if (value == null || value === '') continue;
    const parsed = typeof value === 'number' ? value : Date.parse(String(value));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
};

export const selectExperimentCohorts = <T extends CohortTrade>(
  trades: readonly T[],
  experiment: ExperimentCohortConfig,
  world: 'live' | 'backtest',
) => {
  const clock = experiment.clock ?? (world === 'backtest' ? 'recorded' : 'market');
  const baseline = experiment.baselineTradeIds ? new Set(experiment.baselineTradeIds) : null;
  const accounts = experiment.accountIds ? new Set(experiment.accountIds) : null;
  const before: T[] = [];
  const after: T[] = [];
  const unknown: T[] = [];
  const unlinked: T[] = [];
  const revision = experiment.research?.revisions.find(item => item.id === experiment.researchRevisionId) ?? (experiment.researchRevisionId ? undefined : experiment.research?.revisions.at(-1));
  for (const trade of trades) {
    if (accounts && !accounts.has(trade.accountId)) continue;
    if (baseline?.has(String(trade.id))) {
      before.push(trade);
      continue;
    }
    const time = clock === 'market' ? trade.ts : recordedTime(trade);
    if (time === null || !Number.isFinite(time)) {
      unknown.push(trade);
      continue;
    }
    if (time < experiment.startTs) {
      // A frozen baseline never silently gains records imported later.
      if (!baseline) before.push(trade);
    } else if (experiment.endTs == null || time <= experiment.endTs) {
      if (experiment.research) {
        const reference = trade.raw.backtestResearch;
        if (!revision || !experiment.id || !reference || reference.experimentId !== experiment.id || reference.revisionId !== revision.id
          || reference.revisionHash !== revision.hash || reference.role !== (experiment.researchRole ?? 'development')
          || !Number.isFinite(revision.recordedAt) || revision.recordedAt === null || revision.recordedAt <= 0 || time < revision.recordedAt) { unlinked.push(trade); continue; }
      }
      after.push(trade);
    }
  }
  // Validate every claim before counting: a sliced row cannot belong to two positions.
  const evidence = experiment.researchPositionEvidence;
  const countPositions = (rows: readonly T[]): number | null => {
    if (!experiment.research || !evidence) return null;
    const rowKey = (account:string,id:string) => JSON.stringify([account,id]);
    const positionKey = (item:typeof evidence[number]) => JSON.stringify([item.accountId,item.runId,item.positionId]);
    const positions = new Map<string,typeof evidence[number]>(); const invalid = new Set<string>();
    const claims = new Map<string,Set<string>>();
    for (const item of evidence) {
      const key=positionKey(item);
      if (![item.accountId,item.runId,item.positionId].every(value => typeof value === 'string' && value.length > 0 && value.trim() === value) || !item.expectedTradeIds.length || new Set(item.expectedTradeIds).size!==item.expectedTradeIds.length) invalid.add(key);
      const prior=positions.get(key);
      if(prior && (prior.closed!==item.closed || JSON.stringify([...prior.expectedTradeIds].sort())!==JSON.stringify([...item.expectedTradeIds].sort()))) invalid.add(key);
      positions.set(key,item);
      for(const id of item.expectedTradeIds) { const rk=rowKey(item.accountId,id); const owners=claims.get(rk)??new Set<string>(); owners.add(key); claims.set(rk,owners); }
    }
    const included=new Map<string,T>(); const duplicates=new Set<string>();
    for(const trade of rows) { const key=rowKey(trade.accountId,String(trade.id)); if(included.has(key))duplicates.add(key); included.set(key,trade); }
    let count=0;
    for (const [key,item] of positions) {
      if (invalid.has(key) || !item.closed || !item.expectedTradeIds.every(id => {
        const rk=rowKey(item.accountId,id); return !duplicates.has(rk) && claims.get(rk)?.size===1 && included.get(rk)?.raw.backtestRunId===item.runId;
      })) continue;
      count++;
    }
    return count;
  };
  return { before, after, unknown, unlinked, completePositionN:countPositions(after), completeBeforePositionN:countPositions(before), clock };
};
