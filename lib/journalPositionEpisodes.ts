import { journalSnapshotAnchors } from './journalPositionSnapshot.js';
import { buildJournalAccountTrades, type JournalAccountTrade, type TradeExecutionHistory } from './tradeExecutionHistory.js';
import { latestJournalEvidence, orderedJournalEvidence, projectJournalEvidence, type JournalEvidence, type JournalFill } from './tradovateJournalEvidence.js';

export interface JournalPositionEpisode {
  id: string;
  accountId: number;
  contractId: number;
  symbol: string;
  direction: 'Long' | 'Short';
  entryAt: number;
  exitAt: number | null;
  entryPrice: number;
  exitPrice: number | null;
  enteredQuantity: number;
  exitedQuantity: number;
  groupId?: string;
  isMaster?: boolean;
  realizationIds: string[];
  history: TradeExecutionHistory;
}
interface WorkingEpisode {
  id: string;
  accountId: number;
  contractId: number;
  direction: 'Long' | 'Short';
  entryAt: number;
  exitAt: number | null;
  baselineAt: number;
  openQuantity: number | null;
  peakQuantity: number;
  status: 'open' | 'closed' | 'incomplete';
  fills: TradeExecutionHistory['fills'];
  issues: string[];
  observedThrough: number;
}
type Item = { at: number; type: 'fill'; fill: JournalFill }
  | { at: number; type: 'anchor'; net: number }
  | { at: number; type: 'gap' };
const scope = (account: number, contract: number) => `${account}:${contract}`;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Reconstruct netted futures episodes only after an observed flat anchor.
 * A current flat snapshot cannot establish the initial state of older fills.
 * Reversal fills are split by quantity; their fees are split in the same ratio.
 */
export function buildJournalPositionEpisodes(evidence: readonly JournalEvidence[]): {
  episodes: JournalPositionEpisode[]; unassignedFillIds: string[]; issues: string[];
} {
  const projection = projectJournalEvidence(evidence);
  const latest = latestJournalEvidence(evidence);
  const pairs = buildJournalAccountTrades(evidence);
  const lastObservationAt = evidence.reduce((at, event) => Math.max(at, event.receivedAt), 0);
  const lanes = new Map<string, { accountId: number; contractId: number; items: Item[] }>();
  const lane = (accountId: number, contractId: number) => {
    const id = scope(accountId, contractId);
    const value = lanes.get(id) ?? { accountId, contractId, items: [] };
    lanes.set(id, value); return value;
  };
  const unassigned = new Set<string>();
  const issues = new Set(projection.issues);
  const positionState = new Map<unknown, JournalEvidence['entity']>();
  for (const event of orderedJournalEvidence(evidence)) {
    if (event.entityType !== 'position' || event.entity.id == null) continue;
    const previous = positionState.get(event.entity.id);
    const row = { ...previous, ...event.entity };
    positionState.set(row.id, row);
    if (!finite(event.entity.netPos) || !finite(row.accountId) || !finite(row.contractId)) continue;
    // Ordinary REST/handshake rows have no request-window proof. Only stream
    // changes or the complete, validated snapshot witnesses below establish state.
    if (event.source !== 'stream') continue;
    const brokerTime = typeof event.entity.timestamp === 'string' ? Date.parse(event.entity.timestamp) : NaN;
    const at = Number.isFinite(brokerTime) ? brokerTime : event.receivedAt;
    if (projection.gaps.some(value => value.from <= at && (value.to ?? Infinity) > at)) continue;
    lane(row.accountId, row.contractId).items.push({ at, type: 'anchor', net: event.entity.netPos });
  }
  for (const fill of projection.fills) {
    if (fill.timeSource !== 'broker') { unassigned.add(fill.id); continue; }
    lane(fill.accountId, fill.contractId).items.push({ at: fill.at, type: 'fill', fill });
  }
  for (const anchor of journalSnapshotAnchors(evidence, [...lanes.values()], projection.gaps)) {
    lane(anchor.accountId, anchor.contractId).items.push({ at: anchor.at, type: 'anchor', net: anchor.net });
  }
  const working: WorkingEpisode[] = [];
  for (const current of lanes.values()) {
    current.items.push(...projection.gaps.map(gap => ({ at: gap.from, type: 'gap' as const })));
    current.items.sort((a, b) => a.at - b.at);
    let net: number | null = null;
    let baselineAt = 0;
    let active: WorkingEpisode | null = null;
    const interrupt = (reason: string, at: number) => {
      const last = working.at(-1);
      const affected = active ?? (last?.accountId === current.accountId && last.contractId === current.contractId && last.exitAt === at ? last : null);
      if (affected) { affected.status = 'incomplete'; affected.openQuantity = null; affected.exitAt = null;
        affected.observedThrough = at; affected.issues.push(reason); active = null; }
      net = null;
      issues.add(`${scope(current.accountId, current.contractId)}:${reason}`);
    };
    const start = (fill: JournalFill) => {
      active = { id: `${evidence[0].environment}:${evidence[0].connectionId}:position:${current.accountId}:${current.contractId}:${fill.id}:${fill.side}`,
        accountId: current.accountId, contractId: current.contractId, direction: fill.side === 'Buy' ? 'Long' : 'Short',
        entryAt: fill.at, exitAt: null, baselineAt, openQuantity: 0, peakQuantity: 0, status: 'open', fills: [], issues: [], observedThrough: fill.at };
      working.push(active);
    };
    const allocate = (fill: JournalFill, role: 'entry' | 'exit', quantity: number) => {
      if (!active || quantity <= 0) return;
      active.fills.push({ ...fill, role, allocatedQuantity: quantity });
      active.observedThrough = fill.at;
    };
    for (let index = 0; index < current.items.length;) {
      const at = current.items[index].at;
      const bucket: Item[] = [];
      while (index < current.items.length && current.items[index].at === at) bucket.push(current.items[index++]);
      if (bucket.some(item => item.type === 'gap')) interrupt('connection-gap', at);
      const fills = bucket.flatMap(item => item.type === 'fill' ? [item.fill] : []);
      const inGap = projection.gaps.some(gap => gap.from <= at && (gap.to ?? Infinity) > at);
      const crossesWithinTie = fills.length > 1 && net != null && net !== 0
        && Math.sign(net) !== (fills[0].side === 'Buy' ? 1 : -1)
        && fills.reduce((sum, fill) => sum + fill.quantity, 0) > Math.abs(net);
      if (new Set(fills.map(fill => fill.side)).size > 1 || crossesWithinTie) {
        // Receipt order and numeric fill ids do not prove broker execution order.
        interrupt('ambiguous-fill-order', at);
        fills.forEach(fill => unassigned.add(fill.id));
      } else for (const fill of fills) {
        if (net == null || inGap) { unassigned.add(fill.id); continue; }
        const sign = fill.side === 'Buy' ? 1 : -1;
        if (net === 0) start(fill);
        if (net === 0 || Math.sign(net) === sign) {
          allocate(fill, 'entry', fill.quantity);
          net += sign * fill.quantity;
        } else {
          const reducing = Math.min(Math.abs(net), fill.quantity);
          allocate(fill, 'exit', reducing);
          net += sign * reducing;
          if (net === 0 && active) {
            active.status = 'closed'; active.exitAt = fill.at; active.openQuantity = 0; active = null;
            baselineAt = fill.at;
          }
          const remainder = fill.quantity - reducing;
          if (remainder > 0) { start(fill); allocate(fill, 'entry', remainder); net = sign * remainder; }
        }
        if (active) { active.openQuantity = Math.abs(net); active.peakQuantity = Math.max(active.peakQuantity, Math.abs(net)); }
      }
      const anchors = bucket.flatMap(item => item.type === 'anchor' ? [item.net] : []);
      if (new Set(anchors).size > 1) { interrupt('conflicting-position-anchors', at); continue; }
      if (anchors.length) {
        const anchor = anchors[0];
        if (net != null && net !== anchor) interrupt('position-reconciliation-mismatch', at);
        if (net == null && anchor === 0) { net = 0; baselineAt = at; }
      }
    }
  }

  const pairsByAccount = new Map<number, JournalAccountTrade[]>();
  for (const pair of pairs) {
    const rows = pairsByAccount.get(pair.accountId) ?? []; rows.push(pair); pairsByAccount.set(pair.accountId, rows);
  }
  const linksByAccount = new Map<number, JournalEvidence[]>();
  const childrenByParent = new Map<string, string[]>();
  for (const event of latest.values()) {
    if (!finite(event.entity.accountId)) continue;
    if (event.entityType === 'copylink') {
      const rows = linksByAccount.get(event.entity.accountId) ?? []; rows.push(event); linksByAccount.set(event.entity.accountId, rows);
    } else if (event.entityType === 'order' && event.entity.parentId != null) {
      const key = `${event.entity.accountId}:${event.entity.parentId}`;
      const rows = childrenByParent.get(key) ?? []; rows.push(String(event.entity.id)); childrenByParent.set(key, rows);
    }
  }
  const episodes = working.map((episode): JournalPositionEpisode => {
    if (episode.status === 'open') episode.observedThrough = Math.max(episode.observedThrough, lastObservationAt);
    const entryFills = episode.fills.filter(fill => fill.role === 'entry');
    const exitFills = episode.fills.filter(fill => fill.role === 'exit');
    const enteredQuantity = entryFills.reduce((sum, fill) => sum + fill.allocatedQuantity, 0);
    const exitedQuantity = exitFills.reduce((sum, fill) => sum + fill.allocatedQuantity, 0);
    const entryIds = new Set(entryFills.map(fill => fill.id));
    const exitIds = new Set(exitFills.map(fill => fill.id));
    const realizations = (pairsByAccount.get(episode.accountId) ?? []).filter(pair =>
      pair.direction === episode.direction && pair.history.fills.some(fill => fill.role === 'entry' && entryIds.has(fill.id))
      && pair.history.fills.some(fill => fill.role === 'exit' && exitIds.has(fill.id)));
    const allocated = new Map(episode.fills.map(fill => [`${fill.role}:${fill.id}`, fill.allocatedQuantity]));
    const realized = new Map<string, number>();
    for (const pair of realizations) for (const fill of pair.history.fills) {
      const id = `${fill.role}:${fill.id}`; realized.set(id, (realized.get(id) ?? 0) + fill.allocatedQuantity);
    }
    const matches = exitFills.every(fill => realized.get(`exit:${fill.id}`) === fill.allocatedQuantity)
      && [...realized].every(([id, quantity]) => quantity <= (allocated.get(id) ?? 0))
      && (episode.status !== 'closed' || entryFills.every(fill => realized.get(`entry:${fill.id}`) === fill.allocatedQuantity));
    const linkRows = linksByAccount.get(episode.accountId) ?? [];
    const rootLinks = linkRows.filter(event => event.entity.role === 'entry' && String(event.entity.orderId) === entryFills[0]?.orderId);
    const root = rootLinks.length === 1 ? rootLinks[0].entity : null;
    const entryOrderIds = new Set(entryFills.map(fill => fill.orderId));
    const leaderOrders = new Set(linkRows.filter(event => event.entity.role === 'entry' && entryOrderIds.has(String(event.entity.orderId)))
      .map(event => `${event.entity.leaderConnectionId}:${event.entity.leaderOrderId}`));
    const protectiveOrders = new Set([...entryOrderIds].flatMap(id => childrenByParent.get(`${episode.accountId}:${id}`) ?? []));
    for (const event of linkRows) if (['stop', 'target'].includes(String(event.entity.role))
      && leaderOrders.has(`${event.entity.leaderConnectionId}:${event.entity.leaderOrderId}`)) protectiveOrders.add(String(event.entity.orderId));
    const through = episode.exitAt ?? episode.observedThrough;
    const protection = projection.protection.filter(event => event.accountId === episode.accountId && protectiveOrders.has(event.orderId)
      && event.at >= episode.baselineAt && event.at <= through);
    const gaps = projection.gaps.filter(gap => gap.from >= episode.entryAt && gap.from <= through);
    const ownIssues = [...new Set([...episode.issues, ...realizations.flatMap(pair => pair.history.issues)
      .filter(issue => issue !== 'protection-history-unavailable'), ...projection.issues,
      ...(!matches ? ['fill-pair-reconciliation-pending'] : []), ...(!protection.length ? ['protection-history-unavailable'] : [])])];
    const fees = episode.fills.every(fill => fill.fees != null && fill.feeCurrencyId === 840)
      ? episode.fills.reduce((sum, fill) => sum + fill.fees! * fill.allocatedQuantity / fill.quantity, 0) : null;
    const gross = episode.status === 'closed' && matches && realizations.every(pair => pair.history.grossPnl != null)
      ? realizations.reduce((sum, pair) => sum + pair.history.grossPnl!, 0) : null;
    const history: TradeExecutionHistory = {
      connectionId: evidence[0].connectionId, environment: evidence[0].environment, accountId: episode.accountId,
      fills: episode.fills, protection, gaps, grossPnl: gross, fees, netPnl: gross == null || fees == null ? null : gross - fees,
      complete: episode.status === 'closed' && ownIssues.length === 0 && gross != null && fees != null,
      issues: ownIssues,
      position: { id: episode.id, status: episode.status, openedAt: episode.entryAt, closedAt: episode.exitAt,
        openQuantity: episode.openQuantity, peakQuantity: episode.peakQuantity, observedThrough: episode.observedThrough },
    };
    return { id: episode.id, accountId: episode.accountId, contractId: episode.contractId,
      symbol: String(latest.get(`contract:${episode.contractId}`)?.entity.name ?? ''), direction: episode.direction,
      entryAt: episode.entryAt, exitAt: episode.exitAt,
      entryPrice: entryFills.reduce((sum, fill) => sum + fill.price * fill.allocatedQuantity, 0) / enteredQuantity,
      exitPrice: exitedQuantity ? exitFills.reduce((sum, fill) => sum + fill.price * fill.allocatedQuantity, 0) / exitedQuantity : null,
      enteredQuantity, exitedQuantity, realizationIds: realizations.map(pair => pair.id), history,
      ...(root ? { groupId: `execution:${history.environment}:${root.leaderConnectionId}:${root.leaderOrderId}`,
        isMaster: root.leaderConnectionId === history.connectionId && root.leaderAccountId === episode.accountId } : {}),
    };
  });
  return { episodes: episodes.sort((a, b) => a.entryAt - b.entryAt || a.id.localeCompare(b.id)),
    unassignedFillIds: [...unassigned].sort(), issues: [...issues] };
}
