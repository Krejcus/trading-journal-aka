import { latestJournalEvidence, projectJournalEvidence, type JournalEvidence, type JournalFill, type JournalProtectionEvent } from './tradovateJournalEvidence.js';
import { pointValueUsd } from '../services/futuresContractSpecs.js';

export interface TradeExecutionHistory {
  connectionId: string;
  environment: 'demo' | 'live';
  accountId: number;
  fills: Array<JournalFill & { role: 'entry' | 'exit'; allocatedQuantity: number }>;
  protection: JournalProtectionEvent[];
  gaps: Array<{ from: number; to: number | null }>;
  grossPnl: number | null;
  fees: number | null;
  netPnl: number | null;
  complete: boolean;
  issues: string[];
  position?: {
    id: string;
    status: 'open' | 'closed' | 'incomplete';
    openedAt: number;
    closedAt: number | null;
    openQuantity: number | null;
    peakQuantity: number;
    observedThrough?: number;
  };
}
export interface JournalAccountTrade {
  id: string;
  accountId: number;
  symbol: string;
  direction: 'Long' | 'Short';
  entryAt: number;
  exitAt: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  groupId?: string;
  isMaster?: boolean;
  history: TradeExecutionHistory;
}

const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const key = (value: unknown): string => String(value ?? '');

/** Broker FillPair identifies each realization, including reversals and partial exits.
 * We never invent an initial flat balance from an incomplete list of fills.
 */
export function buildJournalAccountTrades(evidence: readonly JournalEvidence[]): JournalAccountTrade[] {
  if (!evidence.length) return [];
  const projection = projectJournalEvidence(evidence);
  const byFill = new Map(projection.fills.map(fill => [fill.id, fill]));
  const latest = latestJournalEvidence(evidence);
  const pairs = [...latest.values()].filter(event => event.entityType === 'fillpair' && event.entity.active !== false && event.eventType.toLowerCase() !== 'deleted');
  const pairedQuantities = new Map<string, number>();
  const ledgerByPair = new Map<unknown, JournalEvidence[]>();
  const childrenByParent = new Map<string, Set<string>>();
  const linksByOrder = new Map<string, JournalEvidence[]>();
  const childrenByLeader = new Map<string, Set<string>>();
  const correctedOrders = new Set<string>();
  const protectionByOrder = new Map<string, JournalProtectionEvent[]>();
  const leaderKey = (row: JournalEvidence['entity']) => `${row.accountId}:${row.leaderConnectionId}:${row.leaderOrderId}`;
  for (const pair of pairs) for (const fillId of [pair.entity.buyFillId, pair.entity.sellFillId]) {
    pairedQuantities.set(key(fillId), (pairedQuantities.get(key(fillId)) ?? 0) + (number(pair.entity.qty) ?? 0));
  }
  for (const event of projection.protection) {
    const list = protectionByOrder.get(event.orderId) ?? []; list.push(event); protectionByOrder.set(event.orderId, list);
  }
  for (const event of latest.values()) {
    const row = event.entity;
    if (event.entityType === 'cashbalancelog') {
      const list = ledgerByPair.get(row.fillPairId) ?? []; list.push(event); ledgerByPair.set(row.fillPairId, list);
    } else if (event.entityType === 'order' && row.parentId != null) {
      const id = `${row.accountId}:${row.parentId}`;
      const children = childrenByParent.get(id) ?? new Set<string>(); children.add(key(row.id)); childrenByParent.set(id, children);
    } else if (event.entityType === 'copylink') {
      const id = `${row.accountId}:${row.orderId}`;
      const links = linksByOrder.get(id) ?? []; links.push(event); linksByOrder.set(id, links);
      if (['stop', 'target'].includes(String(row.role))) {
        const children = childrenByLeader.get(leaderKey(row)) ?? new Set<string>(); children.add(key(row.orderId)); childrenByLeader.set(leaderKey(row), children);
      }
    } else if (event.entityType === 'executionreport' && ['TradeCorrect', 'TradeCancel'].includes(String(row.execType))) correctedOrders.add(key(row.orderId));
  }
  const result: JournalAccountTrade[] = [];
  for (const pair of pairs) {
    const buy = byFill.get(key(pair.entity.buyFillId));
    const sell = byFill.get(key(pair.entity.sellFillId));
    const quantity = number(pair.entity.qty);
    if (!buy || !sell || buy.side !== 'Buy' || sell.side !== 'Sell' || buy.accountId !== sell.accountId
      || buy.contractId !== sell.contractId || quantity == null || quantity <= 0 || quantity > Math.min(buy.quantity, sell.quantity)) continue;
    // Identical or absent broker timestamps do not prove which side opened the position.
    if (buy.timeSource !== 'broker' || sell.timeSource !== 'broker' || buy.at === sell.at) continue;
    const [entry, exit] = buy.at < sell.at ? [buy, sell] : [sell, buy];
    const contract = latest.get(`contract:${entry.contractId}`)?.entity;
    if (typeof contract?.name !== 'string') continue;
    const symbol = contract.name;
    const pv = pointValueUsd(symbol);
    const buyPrice = number(pair.entity.buyPrice) ?? buy.price;
    const sellPrice = number(pair.entity.sellPrice) ?? sell.price;
    const ledger = (ledgerByPair.get(pair.entity.id) ?? []).filter(event => event.entity.accountId === entry.accountId
      && event.entity.cashChangeType === 'TradePaired' && event.entity.currencyId === 840);
    const grossPnl = ledger.length && ledger.every(event => number(event.entity.delta) != null)
      ? ledger.reduce((sum, event) => sum + Number(event.entity.delta), 0)
      : pv == null ? null : (sellPrice - buyPrice) * quantity * pv;
    // A fill can close several pairs or reverse. Allocate its fee by quantity;
    // charging the entire fill fee to each pair would multiply commissions.
    const fees = [buy, sell].every(fill => fill.fees != null && fill.feeCurrencyId === 840)
      ? buy.fees! * quantity / buy.quantity + sell.fees! * quantity / sell.quantity : null;
    const childOrders = new Set(childrenByParent.get(`${entry.accountId}:${entry.orderId}`) ?? []);
    const links = (linksByOrder.get(`${entry.accountId}:${entry.orderId}`) ?? []).filter(event => event.entity.role === 'entry');
    const link = links.length === 1 ? links[0].entity : null;
    if (link) for (const id of childrenByLeader.get(leaderKey(link)) ?? []) childOrders.add(id);
    const protection = [...childOrders].flatMap(id => protectionByOrder.get(id) ?? []).filter(event => event.at <= exit.at);
    const gaps = projection.gaps.filter(gap => gap.from <= exit.at && (gap.to ?? Infinity) >= entry.at);
    const overAllocated = [buy, sell].some(fill => (pairedQuantities.get(fill.id) ?? 0) > fill.quantity);
    const corrections = correctedOrders.has(entry.orderId) || correctedOrders.has(exit.orderId);
    const issues = [...projection.issues,
      ...(overAllocated ? ['fill-pairs-over-allocated'] : []),
      ...(corrections ? ['broker-correction-requires-reconciliation'] : []),
      ...(gaps.length ? ['connection-gap'] : []),
      ...(!protection.length ? ['protection-history-unavailable'] : []),
    ];
    const history: TradeExecutionHistory = {
      connectionId: pair.connectionId, environment: pair.environment, accountId: entry.accountId,
      fills: [{ ...entry, role: 'entry', allocatedQuantity: quantity }, { ...exit, role: 'exit', allocatedQuantity: quantity }],
      protection, gaps, grossPnl: overAllocated || corrections ? null : grossPnl,
      fees, netPnl: grossPnl == null || fees == null || overAllocated || corrections ? null : grossPnl - fees,
      complete: issues.length === 0, issues,
    };
    result.push({ id: `${pair.environment}:${pair.connectionId}:pair:${pair.entity.id}`, accountId: entry.accountId, symbol,
      direction: entry.side === 'Buy' ? 'Long' : 'Short', entryAt: entry.at, exitAt: exit.at,
      entryPrice: entry.side === 'Buy' ? buyPrice : sellPrice, exitPrice: entry.side === 'Buy' ? sellPrice : buyPrice, quantity,
      ...(link ? { groupId: `execution:${pair.environment}:${link.leaderConnectionId}:${link.leaderOrderId}`,
        isMaster: link.leaderConnectionId === pair.connectionId && link.leaderAccountId === entry.accountId } : {}), history });
  }
  return result.sort((a, b) => a.entryAt - b.entryAt || a.id.localeCompare(b.id));
}

/** Dense minute-chart markers preserve a separately inspectable exact event list. */
export function groupProtectionMarkers(events: readonly JournalProtectionEvent[], timeframeMs = 60_000) {
  const groups = new Map<string, { at: number; kind: 'sl' | 'tp'; events: JournalProtectionEvent[] }>();
  for (const event of events) {
    const at = Math.floor(event.at / timeframeMs) * timeframeMs;
    const id = `${at}:${event.kind}`;
    const group = groups.get(id) ?? { at, kind: event.kind, events: [] };
    group.events.push(event); groups.set(id, group);
  }
  return [...groups.values()].map(group => ({ ...group, events: group.events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)) }));
}
