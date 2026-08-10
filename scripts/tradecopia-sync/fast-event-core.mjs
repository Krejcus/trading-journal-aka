import { createHash } from 'node:crypto';

export const FAST_EVENT_TYPES = Object.freeze([
  'order_submitted', 'trade_opened', 'trade_closed', 'copy_partial',
  'order_rejected', 'connection_changed', 'position_mismatch', 'risk_alert',
]);

const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const text = (value, fallback = '') => value == null ? fallback : String(value);

const bool = (value) => value === true || value === 1 || value === '1' || value === 'true';

const rowKey = (row, keys) => keys.map(key => `${key}=${text(row?.[key])}`).join('|');

const indexRows = (rows = [], keys = ['id']) => new Map(rows.map(row => [rowKey(row, keys), row]));

const changedRows = (previous = [], current = [], keys = ['id']) => {
  const before = indexRows(previous, keys);
  const after = indexRows(current, keys);
  const changes = [];
  for (const [key, row] of after) {
    const old = before.get(key);
    if (!old || JSON.stringify(old) !== JSON.stringify(row)) changes.push({ key, previous: old ?? null, current: row });
  }
  for (const [key, row] of before) {
    if (!after.has(key)) changes.push({ key, previous: row, current: null });
  }
  return changes;
};

const isoBucket = (value, bucketMs = 3000) => {
  const timestamp = Date.parse(text(value));
  return Number.isFinite(timestamp) ? Math.floor(timestamp / bucketMs) : 0;
};

const stableDigest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);

const accountMap = snapshot => new Map((snapshot.accounts || []).map(account => [number(account.id), account]));

const groupModels = snapshot => {
  const accounts = accountMap(snapshot);
  const leaders = snapshot.groupLeaders || [];
  const followers = snapshot.groupFollowers || [];
  return (snapshot.groups || []).map(group => {
    const id = text(group.id);
    const leaderRow = leaders.find(row => text(row.group_id) === id);
    const leaderId = leaderRow ? number(leaderRow.id, NaN) : NaN;
    const followerRows = followers.filter(row => text(row.group_id) === id && row.replicate !== 0 && row.replicate !== false);
    const followerIds = followerRows.map(row => number(row.id, NaN)).filter(Number.isFinite);
    const memberIds = [leaderId, ...followerIds].filter(Number.isFinite);
    return {
      id,
      name: text(group.name, 'Kopírovací skupina'),
      leaderId: Number.isFinite(leaderId) ? leaderId : null,
      leaderName: Number.isFinite(leaderId) ? text(accounts.get(leaderId)?.name, `Účet ${leaderId}`) : 'Leader',
      memberIds,
      followerIds,
      expectedCount: followerIds.length || 1,
      scales: new Map(followerRows.map(row => [number(row.id), number(row.scale, 1)])),
    };
  });
};

const groupForAccounts = (groups, ids) => groups.find(group => ids.some(id => group.memberIds.includes(id))) ?? null;

const accountNames = (snapshot, ids) => {
  const accounts = accountMap(snapshot);
  return ids.map(id => text(accounts.get(id)?.name, `Účet ${id}`));
};

const orderStatus = order => text(order?.status).toLowerCase();
const rejectedStatuses = new Set(['rejected', 'cancelled', 'canceled', 'expired']);
const submittedStatuses = new Set(['new', 'working', 'pending', 'submitted', 'accepted', 'filled', 'partiallyfilled', 'partially_filled']);

const orderClusterKey = order => {
  const tag = text(order.group_tag).trim();
  if (tag) return `tag:${tag}`;
  const strategy = text(order.order_strategy_id).trim();
  const bucket = isoBucket(order.placed_timestamp ?? order.created_at);
  return `${text(order.symbol)}:${text(order.action)}:${strategy}:${bucket}`;
};

const buildOrderEvents = (previous, current, groups) => {
  const changes = changedRows(previous.orders, current.orders).filter(change => change.current);
  const clusters = new Map();
  for (const change of changes) {
    const row = change.current;
    const oldStatus = orderStatus(change.previous);
    const nextStatus = orderStatus(row);
    if (change.previous && oldStatus === nextStatus) continue;
    const key = orderClusterKey(row);
    const list = clusters.get(key) || [];
    list.push({ ...change, status: nextStatus });
    clusters.set(key, list);
  }

  const events = [];
  for (const [cluster, rows] of clusters) {
    const ids = [...new Set(rows.map(item => number(item.current.account_id, NaN)).filter(Number.isFinite))];
    const group = groupForAccounts(groups, ids);
    const expectedCount = group?.expectedCount ?? Math.max(1, ids.length);
    const sample = rows[0].current;
    const rejected = rows.filter(item => rejectedStatuses.has(item.status));
    const accepted = rows.filter(item => submittedStatuses.has(item.status));
    const copiedAccepted = group ? accepted.filter(item => group.followerIds.includes(number(item.current.account_id, NaN))) : accepted;
    const copiedRejected = group ? rejected.filter(item => group.followerIds.includes(number(item.current.account_id, NaN))) : rejected;
    const copiedIds = group ? ids.filter(id => group.followerIds.includes(id)) : ids;
    const base = {
      symbol: text(sample.symbol, '—'),
      side: text(sample.action, '—').toUpperCase(),
      quantity: number(sample.quantity),
      orderType: text(sample.order_type, '—'),
      price: sample.price == null ? null : number(sample.price),
      groupName: group?.name ?? null,
      leaderName: group?.leaderName ?? null,
      expectedAccountCount: expectedCount,
      accountNames: accountNames(current, copiedIds),
    };
    if (copiedAccepted.length) {
      events.push({
        key: `order-submitted:${stableDigest([cluster, ids.toSorted(), rows.map(item => item.current.id).toSorted()])}`,
        type: copiedAccepted.length < expectedCount ? 'copy_partial' : 'order_submitted',
        severity: copiedAccepted.length < expectedCount ? 'warning' : 'info',
        occurredAt: text(sample.updated_timestamp ?? sample.placed_timestamp ?? sample.updated_at, new Date().toISOString()),
        ...base,
        copiedAccountCount: copiedAccepted.length,
        failedAccountCount: Math.max(copiedRejected.length, expectedCount - copiedAccepted.length),
      });
    }
    if (copiedRejected.length) {
      events.push({
        key: `order-rejected:${stableDigest([cluster, rejected.map(item => [item.current.id, item.status]).toSorted()])}`,
        type: 'order_rejected',
        severity: 'critical',
        occurredAt: text(sample.updated_timestamp ?? sample.updated_at, new Date().toISOString()),
        ...base,
        copiedAccountCount: Math.max(0, expectedCount - copiedRejected.length),
        failedAccountCount: copiedRejected.length,
        reasons: copiedRejected.map(item => text(item.current.text ?? item.current.status, 'zamítnuto')).slice(0, 5),
      });
    }
  }
  return events;
};

const positionDirection = value => number(value) > 0 ? 'LONG' : number(value) < 0 ? 'SHORT' : 'FLAT';

const buildPositionEvents = (previous, current, groups) => {
  const changes = changedRows(previous.positions, current.positions, ['account_id', 'id']);
  const opened = changes.filter(change => number(change.previous?.net_pos) === 0 && number(change.current?.net_pos) !== 0);
  const closed = changes.filter(change => number(change.previous?.net_pos) !== 0 && number(change.current?.net_pos) === 0);
  const events = [];
  for (const [kind, rows] of [['trade_opened', opened], ['trade_closed', closed]]) {
    const bySymbol = new Map();
    for (const change of rows) {
      const row = kind === 'trade_opened' ? change.current : change.previous;
      const key = `${text(row?.symbol, '—')}:${positionDirection(row?.net_pos)}`;
      const list = bySymbol.get(key) || [];
      list.push(change);
      bySymbol.set(key, list);
    }
    for (const [symbolDirection, list] of bySymbol) {
      const sample = kind === 'trade_opened' ? list[0].current : list[0].previous;
      const ids = [...new Set(list.map(change => number((kind === 'trade_opened' ? change.current : change.previous)?.account_id, NaN)).filter(Number.isFinite))];
      const group = groupForAccounts(groups, ids);
      const expectedCount = group?.expectedCount ?? Math.max(ids.length, 1);
      const copiedIds = group ? ids.filter(id => group.followerIds.includes(id)) : ids;
      const balancesBefore = accountMap(previous);
      const balancesAfter = accountMap(current);
      const pnl = kind === 'trade_closed'
        ? copiedIds.reduce((sum, id) => sum + number(balancesAfter.get(id)?.balance) - number(balancesBefore.get(id)?.balance), 0)
        : null;
      events.push({
        key: `${kind.replace('_', '-')}:${stableDigest([symbolDirection, ids.toSorted(), list.map(change => change.key).toSorted(), sample?.updated_at])}`,
        type: kind,
        severity: copiedIds.length < expectedCount ? 'warning' : 'info',
        occurredAt: text((kind === 'trade_opened' ? list[0].current : list[0].current ?? list[0].previous)?.updated_at, new Date().toISOString()),
        symbol: text(sample?.symbol, '—'),
        side: positionDirection(sample?.net_pos),
        quantity: Math.abs(number(sample?.net_pos)),
        price: sample?.net_price == null ? null : number(sample.net_price),
        copiedAccountCount: copiedIds.length,
        expectedAccountCount: expectedCount,
        failedAccountCount: Math.max(0, expectedCount - copiedIds.length),
        accountNames: accountNames(current, copiedIds),
        groupName: group?.name ?? null,
        leaderName: group?.leaderName ?? null,
        pnl: pnl === 0 ? null : pnl,
      });
    }
  }
  return events;
};

const connectionState = row => bool(row?.is_connected) || ['connected', 'online', 'active'].includes(text(row?.status).toLowerCase());

const buildConnectionEvents = (previous, current) => changedRows(previous.connections, current.connections)
  .filter(change => change.previous && connectionState(change.previous) !== connectionState(change.current))
  .map(change => {
    const connected = connectionState(change.current);
    const firm = text(change.current?.organization ?? change.current?.name ?? change.previous?.organization ?? change.previous?.name, 'TradeCopia');
    const accountCount = (current.accounts || []).filter(account => text(account.entity_id) === text(change.current?.id)).length;
    return {
      key: `connection:${text(change.current?.id ?? change.previous?.id)}:${connected ? 'connected' : 'disconnected'}:${isoBucket(change.current?.updated_at, 1000)}`,
      type: 'connection_changed',
      severity: connected ? 'info' : 'critical',
      occurredAt: text(change.current?.updated_at, new Date().toISOString()),
      firm,
      connected,
      expectedAccountCount: accountCount,
      copiedAccountCount: connected ? accountCount : 0,
      failedAccountCount: connected ? 0 : accountCount,
      reason: text(change.current?.disconnect_reason),
    };
  });

const mismatchSignatures = snapshot => {
  const groups = groupModels(snapshot);
  const positions = new Map();
  for (const row of snapshot.positions || []) {
    const accountId = number(row.account_id, NaN);
    if (!Number.isFinite(accountId)) continue;
    const map = positions.get(accountId) || new Map();
    map.set(text(row.symbol), number(row.net_pos));
    positions.set(accountId, map);
  }
  const result = new Map();
  for (const group of groups) {
    if (group.leaderId == null) continue;
    const leader = positions.get(group.leaderId) || new Map();
    const mismatches = [];
    for (const accountId of group.memberIds.filter(id => id !== group.leaderId)) {
      const follower = positions.get(accountId) || new Map();
      const symbols = new Set([...leader.keys(), ...follower.keys()]);
      const scale = group.scales.get(accountId) ?? 1;
      for (const symbol of symbols) {
        const expected = number(leader.get(symbol)) * scale;
        const actual = number(follower.get(symbol));
        if (Math.abs(expected - actual) > 0.0001) mismatches.push({ accountId, symbol, expected, actual });
      }
    }
    if (mismatches.length) result.set(group.id, { group, mismatches, signature: stableDigest(mismatches) });
  }
  return result;
};

const buildMismatchEvents = (previous, current) => {
  const before = mismatchSignatures(previous);
  const after = mismatchSignatures(current);
  const accounts = accountMap(current);
  const events = [];
  for (const [groupId, state] of after) {
    if (before.get(groupId)?.signature === state.signature) continue;
    const affected = [...new Set(state.mismatches.map(item => item.accountId))];
    events.push({
      key: `position-mismatch:${groupId}:${state.signature}`,
      type: 'position_mismatch',
      severity: 'critical',
      occurredAt: new Date().toISOString(),
      groupName: state.group.name,
      leaderName: state.group.leaderName,
      expectedAccountCount: state.group.expectedCount,
      copiedAccountCount: Math.max(0, state.group.expectedCount - affected.length),
      failedAccountCount: affected.length,
      accountNames: affected.map(id => text(accounts.get(id)?.name, `Účet ${id}`)),
      mismatches: state.mismatches.slice(0, 5),
    });
  }
  return events;
};

const buildRiskEvents = (previous, current, threshold = 500) => {
  const beforeAccounts = accountMap(previous);
  const positions = new Map();
  for (const row of current.positions || []) {
    const id = number(row.account_id, NaN);
    positions.set(id, number(positions.get(id)) + number(row.unrealized_pl));
  }
  const floors = new Map((current.autoLiquidations || []).map(row => [number(row.account_id), number(row.trailing_max_drawdown_limit, NaN)]));
  return (current.accounts || []).flatMap(account => {
    const id = number(account.id, NaN);
    const floor = floors.get(id);
    if (!Number.isFinite(id) || !Number.isFinite(floor)) return [];
    const cushion = number(account.balance) + number(positions.get(id)) - floor;
    const previousCushion = number(beforeAccounts.get(id)?.balance) - floor;
    if (cushion > threshold || previousCushion <= threshold) return [];
    return [{
      key: `risk-alert:${id}:${cushion <= 0 ? 'breached' : 'warning'}:${Math.floor(cushion / 50)}`,
      type: 'risk_alert',
      severity: cushion <= 0 ? 'critical' : 'warning',
      occurredAt: text(account.updated_at, new Date().toISOString()),
      accountNames: [text(account.name, `Účet ${id}`)],
      cushion,
      drawdownFloor: floor,
      balance: number(account.balance),
      expectedAccountCount: 1,
      copiedAccountCount: 1,
      failedAccountCount: 0,
    }];
  });
};

export function deriveFastEvents(previous, current, options = {}) {
  if (!previous || !current) return [];
  const groups = groupModels(current);
  return [
    ...buildOrderEvents(previous, current, groups),
    ...buildPositionEvents(previous, current, groups),
    ...buildConnectionEvents(previous, current),
    ...buildMismatchEvents(previous, current),
    ...buildRiskEvents(previous, current, number(options.riskThreshold, 500)),
  ].filter(event => FAST_EVENT_TYPES.includes(event.type));
}
