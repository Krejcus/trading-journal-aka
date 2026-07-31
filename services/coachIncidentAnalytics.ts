import {
  executionEntryPrice,
  groupExecutions,
  normalizeSymbol,
  type ImportedExecution,
} from './importPairing.ts';

export interface ImportedOrderEvidence {
  id: string;
  account_ext_id: number;
  symbol?: string | null;
  side?: string | null;
  order_type?: string | null;
  quantity?: number | null;
  filled_qty?: number | null;
  limit_price?: number | null;
  stop_price?: number | null;
  avg_fill_price?: number | null;
  status?: string | null;
  placed_at?: string | null;
}

export type EvidenceConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface EntryOrderEvidence {
  executionId: string;
  orderId: string | null;
  orderType: string | null;
  confidence: EvidenceConfidence;
  timeDeltaMs: number | null;
  reasons: string[];
}

export interface IncidentDecision {
  key: string;
  entryAt: string;
  exitAt: string;
  symbol: string;
  direction: ImportedExecution['direction'];
  accountCount: number;
  copyCount: number;
  quantitiesByAccount: Array<{ accountExtId: number; quantity: number }>;
  totalPnl: number;
  representativeQuantity: number;
  entryOrderEvidence: EntryOrderEvidence[];
}

export interface IncidentExecutionAnalysis {
  executionCount: number;
  decisionCount: number;
  accountCount: number;
  totalPnl: number;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  medianSecondsBetweenDecisions: number | null;
  fastestSecondsBetweenDecisions: number | null;
  maxRepresentativeQuantity: number;
  quantityEscalationRatio: number | null;
  orderTypeCounts: Record<string, number>;
  verifiedOrderTypeCount: number;
  decisions: IncidentDecision[];
  warnings: string[];
}

const ENTRY_ORDER_WINDOW_MS = 2 * 60 * 1000;
const PRICE_TOLERANCE = 0.51;

const normalizedSide = (value?: string | null) => String(value || '').trim().toLowerCase();
const isEntrySide = (execution: ImportedExecution, order: ImportedOrderEvidence) => {
  const side = normalizedSide(order.side);
  if (!side) return true;
  if (execution.direction === 'Long') return side.includes('buy');
  if (execution.direction === 'Short') return side.includes('sell');
  return true;
};

const orderPrice = (order: ImportedOrderEvidence): number | null => {
  for (const value of [order.avg_fill_price, order.limit_price, order.stop_price]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
};

/**
 * Finds supporting entry-order evidence without pretending that a temporal
 * correlation is a canonical trade↔order relation. High confidence requires
 * matching account, symbol, side, time and fill price; weaker matches stay
 * explicitly labelled and must not be presented as fact by the Coach.
 */
export function findEntryOrderEvidence(
  execution: ImportedExecution,
  orders: ImportedOrderEvidence[],
): EntryOrderEvidence {
  const entryMs = new Date(execution.entry_at).getTime();
  const entryPrice = executionEntryPrice(execution);
  const candidates = orders
    .filter(order => order.account_ext_id === execution.account_ext_id)
    .filter(order => normalizeSymbol(order.symbol) === normalizeSymbol(execution.symbol))
    .filter(order => isEntrySide(execution, order))
    .map(order => {
      const placedMs = order.placed_at ? new Date(order.placed_at).getTime() : Number.NaN;
      const timeDeltaMs = Number.isFinite(placedMs) ? Math.abs(placedMs - entryMs) : Number.POSITIVE_INFINITY;
      const price = orderPrice(order);
      const priceDelta = price === null ? Number.POSITIVE_INFINITY : Math.abs(price - entryPrice);
      const filled = !order.status || /fill|complete/i.test(order.status)
        || (Number(order.filled_qty) > 0 && Number(order.filled_qty) >= Number(order.quantity || 0));
      const timeMatch = timeDeltaMs <= ENTRY_ORDER_WINDOW_MS;
      const priceMatch = priceDelta <= PRICE_TOLERANCE;
      const quantityMatch = !order.quantity || Number(order.quantity) === Number(execution.qty);
      const score = (timeMatch ? 4 : 0) + (priceMatch ? 4 : 0) + (filled ? 2 : 0) + (quantityMatch ? 1 : 0);
      return { order, timeDeltaMs, timeMatch, priceMatch, filled, quantityMatch, score };
    })
    .filter(candidate => candidate.timeMatch)
    .sort((a, b) => b.score - a.score || a.timeDeltaMs - b.timeDeltaMs);

  const best = candidates[0];
  if (!best) {
    return {
      executionId: execution.id,
      orderId: null,
      orderType: null,
      confidence: 'unknown',
      timeDeltaMs: null,
      reasons: ['Nebyla nalezena odpovídající objednávka v časovém okně.'],
    };
  }

  const tied = candidates[1] && candidates[1].score === best.score
    && Math.abs(candidates[1].timeDeltaMs - best.timeDeltaMs) < 1_000;
  let confidence: EvidenceConfidence = 'low';
  if (!tied && best.priceMatch && best.filled && best.quantityMatch) confidence = 'high';
  else if (!tied && best.priceMatch && best.filled) confidence = 'medium';

  const reasons = [
    `časový rozdíl ${Math.round(best.timeDeltaMs / 1000)} s`,
    best.priceMatch ? 'shoda vstupní ceny' : 'bez potvrzené shody ceny',
    best.quantityMatch ? 'shoda množství' : 'bez shody množství',
  ];
  if (tied) reasons.push('více stejně pravděpodobných objednávek');

  return {
    executionId: execution.id,
    orderId: best.order.id,
    orderType: best.order.order_type || null,
    confidence,
    timeDeltaMs: best.timeDeltaMs,
    reasons,
  };
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

export function analyzeIncidentExecutions(
  executions: ImportedExecution[],
  orders: ImportedOrderEvidence[] = [],
): IncidentExecutionAnalysis {
  const groups = groupExecutions(executions).sort((a, b) =>
    new Date(a.sample.entry_at).getTime() - new Date(b.sample.entry_at).getTime());
  const decisions: IncidentDecision[] = groups.map(group => {
    const orderedCopies = [...group.executions].sort((a, b) =>
      new Date(a.entry_at).getTime() - new Date(b.entry_at).getTime());
    return {
      key: group.key,
      entryAt: orderedCopies[0].entry_at,
      exitAt: orderedCopies.reduce((latest, item) => item.exit_at > latest ? item.exit_at : latest, orderedCopies[0].exit_at),
      symbol: normalizeSymbol(group.sample.symbol),
      direction: group.sample.direction,
      accountCount: group.accountCount,
      copyCount: group.executions.length,
      quantitiesByAccount: group.executions.map(item => ({
        accountExtId: item.account_ext_id,
        quantity: Number(item.qty) || 0,
      })),
      totalPnl: group.totalPnl,
      // Representative size avoids claiming that copy fan-out was one huge
      // broker order. Per-account quantities remain available above.
      representativeQuantity: Math.max(...group.executions.map(item => Number(item.qty) || 0), 0),
      entryOrderEvidence: group.executions.map(item => findEntryOrderEvidence(item, orders)),
    };
  });

  const gapsSeconds = decisions.slice(1).map((decision, index) =>
    Math.max(0, (new Date(decision.entryAt).getTime() - new Date(decisions[index].entryAt).getTime()) / 1000));
  const first = decisions[0];
  const lastExitMs = executions.length
    ? Math.max(...executions.map(item => new Date(item.exit_at).getTime()))
    : Number.NaN;
  const quantities = decisions.map(item => item.representativeQuantity).filter(value => value > 0);
  const firstQuantity = quantities[0] || 0;
  const maxQuantity = Math.max(...quantities, 0);
  const evidence = decisions.flatMap(item => item.entryOrderEvidence);
  const verifiedEvidence = evidence.filter(item => item.confidence === 'high' || item.confidence === 'medium');
  const orderTypeCounts = verifiedEvidence.reduce<Record<string, number>>((counts, item) => {
    const type = item.orderType?.trim() || 'Neznámý';
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});
  const warnings: string[] = [];
  if (executions.length > 0 && orders.length === 0) warnings.push('Pro incident nejsou načtené raw objednávky; typ vstupu nelze ověřit.');
  if (evidence.length > verifiedEvidence.length) warnings.push('Část typů vstupu má slabou nebo chybějící vazbu na objednávku.');

  return {
    executionCount: executions.length,
    decisionCount: decisions.length,
    accountCount: new Set(executions.map(item => item.account_ext_id)).size,
    totalPnl: executions.reduce((sum, item) => sum + (Number(item.pnl) || 0), 0),
    startedAt: first?.entryAt || null,
    endedAt: Number.isFinite(lastExitMs) ? new Date(lastExitMs).toISOString() : null,
    durationSeconds: first && Number.isFinite(lastExitMs)
      ? Math.max(0, (lastExitMs - new Date(first.entryAt).getTime()) / 1000)
      : null,
    medianSecondsBetweenDecisions: median(gapsSeconds),
    fastestSecondsBetweenDecisions: gapsSeconds.length ? Math.min(...gapsSeconds) : null,
    maxRepresentativeQuantity: maxQuantity,
    quantityEscalationRatio: firstQuantity > 0 ? maxQuantity / firstQuantity : null,
    orderTypeCounts,
    verifiedOrderTypeCount: verifiedEvidence.length,
    decisions,
    warnings,
  };
}
