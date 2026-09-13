/** Broker observations are evidence, never execution instructions. Times are milliseconds. */
export const JOURNAL_ENTITY_FIELDS = {
  contract: ['id', 'name', 'contractMaturityId'],
  order: ['id', 'accountId', 'contractId', 'action', 'ordStatus', 'parentId', 'linkedId', 'ocoId', 'timestamp'],
  orderversion: ['id', 'orderId', 'orderQty', 'orderType', 'price', 'stopPrice', 'pegDifference', 'timeInForce'],
  command: ['id', 'orderId', 'timestamp', 'commandType', 'commandStatus', 'clOrdId'],
  commandreport: ['id', 'commandId', 'timestamp', 'commandStatus', 'ordStatus', 'rejectReason', 'text'],
  executionreport: ['id', 'commandId', 'orderId', 'accountId', 'contractId', 'timestamp', 'execType', 'execRefId', 'ordStatus', 'action', 'cumQty', 'avgPx', 'lastQty', 'lastPx', 'rejectReason', 'text'],
  fill: ['id', 'orderId', 'accountId', 'contractId', 'timestamp', 'action', 'qty', 'price', 'active', 'finallyPaired'],
  fillfee: ['id', 'clearingFee', 'clearingCurrencyId', 'exchangeFee', 'exchangeCurrencyId', 'nfaFee', 'nfaCurrencyId', 'brokerageFee', 'brokerageCurrencyId', 'ipFee', 'ipCurrencyId', 'commission', 'commissionCurrencyId', 'orderRoutingFee', 'orderRoutingCurrencyId'],
  fillpair: ['id', 'positionId', 'buyFillId', 'sellFillId', 'qty', 'buyPrice', 'sellPrice', 'active'],
  position: ['id', 'accountId', 'contractId', 'netPos', 'timestamp'],
  cashbalancelog: ['id', 'accountId', 'timestamp', 'currencyId', 'cashChangeType', 'delta', 'fillPairId', 'fillId'],
  connection: ['state', 'reason'],
  positionsnapshot: ['id', 'snapshotId', 'kind', 'accountId', 'contractId', 'netPos', 'rowCount', 'startedAt', 'completedAt', 'reason'],
  journalbackfill: ['id', 'entityType', 'kind', 'startedAt', 'completedAt', 'scanned', 'recorded', 'contended', 'reason', 'scope', 'requested', 'remaining'],
  copylink: ['id', 'leaderConnectionId', 'leaderAccountId', 'leaderOrderId', 'accountId', 'orderId', 'role', 'status', 'reason'],
} as const;

export type JournalEntityType = keyof typeof JOURNAL_ENTITY_FIELDS;
export type JournalScalar = string | number | boolean | null;
export interface JournalObservation {
  entityType: JournalEntityType;
  entity: Record<string, JournalScalar>;
  source: 'stream' | 'snapshot' | 'transport';
  eventType: string;
  receivedAt: number;
}
export interface JournalEvidence extends JournalObservation {
  id: string;
  connectionId: string;
  environment: 'demo' | 'live';
  sessionId: string;
  sequence: number;
}

/** Explicit allowlist: never copy account credentials, tokens, or entire API responses. */
export function journalObservation(
  entityType: string, entity: unknown, source: JournalObservation['source'],
  eventType: string, receivedAt: number,
): JournalObservation | null {
  const key = entityType.toLowerCase();
  if (!Object.hasOwn(JOURNAL_ENTITY_FIELDS, key) || !entity || typeof entity !== 'object'
    || Array.isArray(entity) || !Number.isFinite(receivedAt)) return null;
  const fields = JOURNAL_ENTITY_FIELDS[key as JournalEntityType];
  const input = entity as Record<string, unknown>;
  const safe: Record<string, JournalScalar> = {};
  for (const field of fields) {
    const value = input[field];
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) safe[field] = value as JournalScalar;
    else if (typeof value === 'string') safe[field] = value.slice(0, 512);
  }
  if (Object.keys(safe).length === 0) return null;
  return { entityType: key as JournalEntityType, entity: safe, source, eventType: eventType.slice(0, 40), receivedAt };
}

export interface JournalProtectionEvent {
  id: string;
  orderId: string;
  commandId: string | null;
  accountId: number;
  at: number;
  timeSource: 'broker' | 'received';
  kind: 'sl' | 'tp';
  price: number | null;
  quantity: number | null;
  status: 'confirmed' | 'pending' | 'rejected' | 'cancelled' | 'uncertain';
  operation?: 'new' | 'modify' | 'cancel';
  reason?: string;
}
export interface JournalFill {
  id: string;
  orderId: string;
  accountId: number;
  contractId: number;
  at: number;
  timeSource: 'broker' | 'received';
  side: 'Buy' | 'Sell';
  quantity: number;
  price: number;
  fees: number | null;
  feeCurrencyId: number | null;
}
export interface JournalProjection {
  fills: JournalFill[];
  protection: JournalProtectionEvent[];
  gaps: Array<{ from: number; to: number | null }>;
  issues: string[];
}
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const entityId = (value: unknown): string | null => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
const eventTime = (event: JournalEvidence) => {
  const parsed = typeof event.entity.timestamp === 'string' ? Date.parse(event.entity.timestamp) : NaN;
  return Number.isFinite(parsed) ? { at: parsed, timeSource: 'broker' as const }
    : { at: event.receivedAt, timeSource: 'received' as const };
};

export function orderedJournalEvidence(events: readonly JournalEvidence[]): JournalEvidence[] {
  return [...new Map(events.map(event => [event.id, event])).values()]
    .sort((a, b) => a.receivedAt - b.receivedAt || a.sessionId.localeCompare(b.sessionId) || a.sequence - b.sequence || a.id.localeCompare(b.id));
}

/** Stream patches may omit unchanged fields. A stale broker timestamp must not
 * overwrite a newer entity; equal timestamps still allow explicit corrections. */
export function latestJournalEvidence(events: readonly JournalEvidence[]): Map<string, JournalEvidence> {
  const latest = new Map<string, JournalEvidence>();
  for (const event of orderedJournalEvidence(events)) {
    if (event.entityType === 'connection' || event.entity.id == null) continue;
    const key = `${event.entityType}:${event.entity.id}`;
    const previous = latest.get(key);
    const nextTime = eventTime(event);
    const previousTime = previous && eventTime(previous);
    if (previousTime?.timeSource === 'broker' && nextTime.timeSource === 'broker' && nextTime.at < previousTime.at) continue;
    latest.set(key, previous ? { ...event, entity: { ...previous.entity, ...event.entity } } : event);
  }
  return latest;
}

/** One connection/environment only. Rebuildable after late arrivals or broker corrections. */
export function projectJournalEvidence(events: readonly JournalEvidence[]): JournalProjection {
  const result: JournalProjection = { fills: [], protection: [], gaps: [], issues: [] };
  if (new Set(events.map(event => `${event.environment}/${event.connectionId}`)).size > 1) {
    throw new Error('journal-projection-mixed-connections');
  }
  const ordered = orderedJournalEvidence(events);
  const tables = new Map<JournalEntityType, Map<string, JournalEvidence>>();
  for (const event of ordered) {
    if (event.entityType === 'connection') {
      const last = result.gaps.at(-1);
      if (event.entity.state !== 'synced') {
        if (!last || last.to != null) result.gaps.push({ from: event.receivedAt, to: null });
      } else if (last && last.to == null) last.to = event.receivedAt;
      continue;
    }
    if (event.entity.id == null) result.issues.push(`missing-id:${event.id}`);
  }
  for (const event of latestJournalEvidence(ordered).values()) {
    if (event.entityType === 'positionsnapshot' || event.entityType === 'journalbackfill') continue; // Capture metadata is not a financial entity.
    const id = event.entityType === 'copylink' && typeof event.entity.id === 'string' ? event.entity.id : entityId(event.entity.id);
    if (id == null) { result.issues.push(`missing-id:${event.id}`); continue; }
    const table = tables.get(event.entityType) ?? new Map<string, JournalEvidence>();
    table.set(id, event);
    tables.set(event.entityType, table);
  }
  const table = (name: JournalEntityType) => tables.get(name) ?? new Map<string, JournalEvidence>();
  for (const [id, fill] of table('fill')) {
    const row = fill.entity;
    if (row.active === false || fill.eventType.toLowerCase() === 'deleted') continue;
    const orderId = entityId(row.orderId);
    const order = orderId ? table('order').get(orderId)?.entity : null;
    const accountId = numeric(row.accountId) ?? numeric(order?.accountId);
    const contractId = numeric(row.contractId);
    const quantity = numeric(row.qty);
    const price = numeric(row.price);
    const side = row.action ?? order?.action;
    if (!orderId || accountId == null || contractId == null || quantity == null || quantity <= 0
      || price == null || (side !== 'Buy' && side !== 'Sell')) { result.issues.push(`incomplete-fill:${id}`); continue; }
    const feeEvent = table('fillfee').get(id);
    const fee = feeEvent?.eventType.toLowerCase() === 'deleted' ? undefined : feeEvent?.entity;
    const components = ['clearing', 'exchange', 'nfa', 'brokerage', 'ip', 'commission', 'orderRouting'];
    let fees: number | null = fee ? 0 : null;
    let currency: number | null = null;
    for (const component of components) {
      const amount = numeric(fee?.[component === 'commission' ? component : `${component}Fee`]);
      if (amount == null) continue;
      const currencyId = numeric(fee?.[`${component}CurrencyId`]);
      if (currencyId == null || (currency != null && currency !== currencyId)) { fees = null; break; }
      currency = currencyId;
      fees = (fees ?? 0) + amount;
    }
    // An empty fee entity does not prove a zero commission.
    if (currency == null) fees = null;
    result.fills.push({ id, orderId, accountId, contractId, ...eventTime(fill), side, quantity, price, fees, feeCurrencyId: fees == null ? null : currency });
  }
  const reportsByCommand = new Map<unknown, JournalEvidence[]>();
  const rejectsByCommand = new Map<unknown, JournalEvidence>();
  for (const report of table('executionreport').values()) {
    const list = reportsByCommand.get(report.entity.commandId) ?? [];
    list.push(report); reportsByCommand.set(report.entity.commandId, list);
  }
  for (const report of table('commandreport').values()) {
    if (['ExecutionRejected', 'RiskRejected'].includes(String(report.entity.commandStatus))) rejectsByCommand.set(report.entity.commandId, report);
  }
  for (const [versionId, version] of table('orderversion')) {
    const row = version.entity;
    const orderId = entityId(row.orderId);
    const order = orderId ? table('order').get(orderId)?.entity : null;
    const accountId = numeric(order?.accountId);
    if (!orderId || accountId == null) continue;
    // Price-bearing order versions share the command identity. Require BOTH
    // the matching command/order link and an execution report for that command.
    const command = table('command').get(versionId);
    const commandMatches = command?.entity.orderId === row.orderId;
    const reports = (reportsByCommand.get(row.id) ?? []).filter(report => report.entity.orderId === row.orderId)
      .sort((a, b) => eventTime(a).at - eventTime(b).at || Number(a.entity.id) - Number(b.entity.id));
    const accepted = commandMatches ? reports.find(report => ['New', 'Replaced'].includes(String(report.entity.execType))) : undefined;
    const rejected = reports.find(report => report.entity.execType === 'Rejected') ?? rejectsByCommand.get(row.id);
    const status = accepted && rejected ? 'uncertain' : accepted ? 'confirmed' : rejected ? 'rejected' : 'pending';
    if (accepted && rejected) result.issues.push(`conflicting-command:${versionId}`);
    const stop = numeric(row.stopPrice);
    const limit = numeric(row.price);
    const kind = ['Stop', 'StopLimit', 'TrailingStop', 'TrailingStopLimit'].includes(String(row.orderType)) ? 'sl' : row.orderType === 'Limit' ? 'tp' : null;
    if (!kind) continue;
    // Entry limit orders are not automatically take profits: UI must link the
    // order to the actual position using explicit parent/copier references.
    const proof = accepted ?? rejected ?? command ?? version;
    result.protection.push({ id: `version:${versionId}`, orderId, commandId: commandMatches ? versionId : null,
      accountId, ...eventTime(proof), kind, price: kind === 'sl' ? stop : limit,
      quantity: numeric(row.orderQty), status,
      ...(command?.entity.commandType === 'New' ? { operation: 'new' as const } : command?.entity.commandType === 'Modify' ? { operation: 'modify' as const } : {}),
      ...(rejected ? { reason: String(rejected.entity.text ?? rejected.entity.rejectReason ?? 'Odmítnuto brokerem') } : {}) });
  }
  for (const report of table('executionreport').values()) {
    if (!['Canceled', 'Expired', 'DoneForDay'].includes(String(report.entity.execType))) continue;
    const orderId = entityId(report.entity.orderId);
    const previous = result.protection.filter(event => event.orderId === orderId && event.status === 'confirmed' && event.at <= eventTime(report).at)
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).at(-1);
    if (previous) result.protection.push({ ...previous, id: `terminal:${report.entity.id}`, ...eventTime(report), status: 'cancelled', operation: 'cancel', price: null });
  }
  result.fills.sort((a, b) => a.at - b.at || Number(a.id) - Number(b.id));
  result.protection.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return result;
}
