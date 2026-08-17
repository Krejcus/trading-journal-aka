import { supabase } from './supabase';
import {
  ensureAccountMapRows,
  listAccountMap,
  listAppAccounts,
  setAccountMapping,
  type AccountMapRow,
  type AppAccountOption,
} from './importService';

export type ShadowPayload = Record<string, unknown>;

export interface ShadowRow {
  source_table: string;
  source_key: string;
  account_ext_id: number | null;
  source_updated_at: string | null;
  payload: ShadowPayload;
  last_seen_at: string;
  last_changed_at: string;
}

export interface ShadowSyncRun {
  id: string;
  status: 'processing' | 'completed' | 'failed';
  captured_at: string;
  completed_at: string | null;
  row_counts: Record<string, number>;
  changed_counts: Record<string, number>;
  warning: string | null;
  error: string | null;
}

export interface LivePosition {
  accountId: number;
  symbol: string;
  netPosition: number;
  netPrice: number | null;
  realizedPnl: number;
  unrealizedPnl: number;
  updatedAt: string | null;
}

export interface LiveAccount {
  id: number;
  entityId: string | null;
  name: string;
  firm: string;
  phase: string | null;
  accountSize: number | null;
  balance: number;
  equity: number;
  realizedPnl: number;
  weekRealizedPnl: number;
  unrealizedPnl: number;
  unrealizedPnlSource?: 'broker' | 'estimated' | 'stale';
  unrealizedPnlUpdatedAt?: string | null;
  peakEquity: number | null;
  drawdownFloor: number | null;
  cushion: number | null;
  positions: LivePosition[];
  updatedAt: string | null;
  mapRowId: string | null;
  mappedAccountId: string | null;
  mappedAccountName: string | null;
  mappingStatus: AccountMapRow['status'] | null;
}

export interface LiveConnection {
  id: string;
  firm: string;
  connected: boolean;
  status: string;
  accountCount: number;
  disconnectedAt: string | null;
  disconnectReason: string | null;
  updatedAt: string | null;
}

export interface LiveFollower {
  accountId: number;
  accountName: string;
  scale: number;
  replicate: boolean;
  synced: boolean;
  mismatches: string[];
}

export interface LiveGroup {
  id: string;
  name: string;
  leaderAccountId: number | null;
  leaderName: string;
  followers: LiveFollower[];
  syncedCount: number;
  warningCount: number;
}

export interface LiveAlert {
  level: 'info' | 'warning' | 'danger';
  title: string;
  detail: string;
  accountId?: number;
}

export interface LiveSnapshot {
  run: ShadowSyncRun | null;
  accounts: LiveAccount[];
  appAccounts: AppAccountOption[];
  connections: LiveConnection[];
  groups: LiveGroup[];
  alerts: LiveAlert[];
  totalBalance: number;
  totalEquity: number;
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  worstCushion: number | null;
}

export interface LiveOrder {
  id: number;
  accountId: number | null;
  accountName: string;
  action: string;
  orderType: string;
  quantity: number;
  price: number | null;
  stopPrice: number | null;
  status: string;
  symbol: string;
  placedAt: string | null;
  updatedAt: string | null;
  working: boolean;
}

export interface LiveEvent {
  id: number;
  sourceTable: string;
  changeType: 'inserted' | 'updated' | 'deleted';
  accountId: number | null;
  accountName: string;
  observedAt: string;
  title: string;
  detail: string;
  payload: ShadowPayload;
}

const OVERVIEW_TABLES = [
  'accounts',
  'entity_connections',
  'positions',
  'account_risk_statuses',
  'groups',
  'group_leader_accounts',
  'group_follower_accounts',
  'prop_firm_accounts',
];

const terminalStatuses = new Set(['filled', 'canceled', 'cancelled', 'rejected', 'expired']);

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : value == null ? fallback : String(value);

const asNumber = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asNullableNumber = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const asBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
};

const payloadId = (payload: ShadowPayload): number | null => asNullableNumber(payload.id);

const parseMetadata = (value: unknown): ShadowPayload => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as ShadowPayload;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ShadowPayload : {};
  } catch {
    return {};
  }
};

export const inferFirm = (accountName: string): string => {
  const normalized = accountName.toUpperCase();
  if (normalized.startsWith('FTDFY')) return 'Tradeify';
  if (normalized.startsWith('LFF') || normalized.startsWith('LF')) return 'Lucid';
  if (normalized.startsWith('FNFT')) return 'FundedNext';
  return 'Neznámá firma';
};

const findPropAccount = (accountId: number, accountName: string, rows: ShadowRow[]): ShadowPayload | null => {
  const normalizedName = accountName.trim().toLowerCase();
  for (const row of rows) {
    const linkedId = asNullableNumber(row.payload.trading_account_id);
    if (linkedId === accountId) return row.payload;
  }
  for (const row of rows) {
    const candidates = [row.payload.account_name, row.payload.broker_account_key]
      .map(value => asString(value).trim().toLowerCase())
      .filter(Boolean);
    if (normalizedName && candidates.includes(normalizedName)) return row.payload;
  }
  return null;
};

const positionsByAccount = (rows: ShadowRow[]): Map<number, LivePosition[]> => {
  const result = new Map<number, LivePosition[]>();
  rows.filter(row => row.source_table === 'positions').forEach(row => {
    const accountId = asNullableNumber(row.payload.account_id) ?? row.account_ext_id;
    if (accountId == null) return;
    const position: LivePosition = {
      accountId,
      symbol: asString(row.payload.symbol, '—'),
      netPosition: asNumber(row.payload.net_pos),
      netPrice: asNullableNumber(row.payload.net_price),
      realizedPnl: asNumber(row.payload.realized_pl),
      unrealizedPnl: asNumber(row.payload.unrealized_pl),
      updatedAt: asString(row.payload.updated_at, row.source_updated_at ?? '') || null,
    };
    const current = result.get(accountId) ?? [];
    current.push(position);
    result.set(accountId, current);
  });
  return result;
};

export function buildLiveSnapshot(
  rows: ShadowRow[],
  run: ShadowSyncRun | null,
  mappings: AccountMapRow[] = [],
  appAccounts: AppAccountOption[] = [],
): LiveSnapshot {
  const propRows = rows.filter(row => row.source_table === 'prop_firm_accounts');
  const riskRows = rows.filter(row => row.source_table === 'account_risk_statuses');
  const positions = positionsByAccount(rows);
  const mappingsByExternalId = new Map(mappings.map(mapping => [mapping.account_ext_id, mapping]));
  const appAccountsById = new Map(appAccounts.map(account => [account.id, account]));
  const connectionRows = rows.filter(row => row.source_table === 'entity_connections');
  const connectionById = new Map(connectionRows.map(row => [asString(row.payload.id, row.source_key), row.payload]));
  const accountCountByEntity = new Map<string, number>();
  rows.filter(row => row.source_table === 'accounts').forEach(row => {
    const entityId = asString(row.payload.entity_id).trim();
    if (entityId) accountCountByEntity.set(entityId, (accountCountByEntity.get(entityId) ?? 0) + 1);
  });

  const connections = connectionRows.map(row => {
    const payload = row.payload;
    const id = asString(payload.id, row.source_key);
    const status = asString(payload.status, asBoolean(payload.is_connected) ? 'Connected' : 'Disconnected');
    return {
      id,
      firm: asString(payload.organization, asString(payload.name, 'Neznámá firma')),
      connected: asBoolean(payload.is_connected, status.toLowerCase() === 'connected'),
      status,
      accountCount: accountCountByEntity.get(id) ?? 0,
      disconnectedAt: asString(payload.disconnected_at) || null,
      disconnectReason: asString(payload.disconnect_reason) || null,
      updatedAt: asString(payload.updated_at, row.source_updated_at ?? '') || null,
    } satisfies LiveConnection;
  }).sort((a, b) => Number(a.connected) - Number(b.connected) || a.firm.localeCompare(b.firm, 'cs'));

  const accounts = rows
    .filter(row => row.source_table === 'accounts')
    .map(row => {
      const id = payloadId(row.payload) ?? row.account_ext_id;
      if (id == null) return null;
      const entityId = asString(row.payload.entity_id).trim() || null;
      const name = asString(row.payload.name, `Účet ${id}`);
      const accountPositions = positions.get(id) ?? [];
      const unrealizedPnl = accountPositions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
      const balance = asNumber(row.payload.balance);
      const equity = balance + unrealizedPnl;
      const risk = riskRows.find(candidate => (asNullableNumber(candidate.payload.account_id) ?? candidate.account_ext_id) === id)?.payload;
      const prop = findPropAccount(id, name, propRows);
      const metadata = parseMetadata(prop?.metadata);
      const accountSize = asNullableNumber(prop?.account_size) ?? asNullableNumber(metadata.accountSize) ?? asNullableNumber(metadata.account_size);
      const maxLossLimit = asNullableNumber(metadata.maxLossLimit) ?? asNullableNumber(metadata.max_loss_limit);
      const maxNetLiq = asNullableNumber(risk?.max_net_liq);
      const peakEquity = accountSize != null || maxNetLiq != null
        ? Math.max(accountSize ?? Number.NEGATIVE_INFINITY, maxNetLiq ?? Number.NEGATIVE_INFINITY)
        : null;
      const drawdownFloor = peakEquity != null && maxLossLimit != null ? peakEquity - maxLossLimit : null;
      const entity = entityId ? connectionById.get(entityId) : undefined;
      const firm = asString(entity?.organization, asString(entity?.name)).trim()
        || asString(prop?.firm_name).trim()
        || asString(metadata.firm).trim()
        || inferFirm(name);
      const mapping = mappingsByExternalId.get(id);
      const mappedAccount = mapping?.mapped_account_id ? appAccountsById.get(mapping.mapped_account_id) : undefined;

      return {
        id,
        entityId,
        name,
        firm,
        phase: asString(prop?.phase, asString(metadata.phase)) || null,
        accountSize,
        balance,
        equity,
        realizedPnl: asNumber(row.payload.realized_pn_l),
        weekRealizedPnl: asNumber(row.payload.week_realized_pn_l),
        unrealizedPnl,
        peakEquity,
        drawdownFloor,
        cushion: drawdownFloor == null ? null : equity - drawdownFloor,
        positions: accountPositions,
        updatedAt: asString(row.payload.updated_at, row.source_updated_at ?? '') || null,
        mapRowId: mapping?.id ?? null,
        mappedAccountId: mapping?.mapped_account_id ?? null,
        mappedAccountName: mappedAccount?.name ?? null,
        mappingStatus: mapping?.status ?? null,
      } satisfies LiveAccount;
    })
    .filter((account): account is LiveAccount => account != null)
    .sort((a, b) => a.name.localeCompare(b.name, 'cs'));

  const accountMap = new Map(accounts.map(account => [account.id, account]));
  const positionMap = new Map<number, Map<string, number>>();
  for (const account of accounts) {
    positionMap.set(account.id, new Map(account.positions.map(position => [position.symbol, position.netPosition])));
  }

  const leaderRows = rows.filter(row => row.source_table === 'group_leader_accounts');
  const followerRows = rows.filter(row => row.source_table === 'group_follower_accounts');
  const groups = rows.filter(row => row.source_table === 'groups').map(row => {
    const id = asString(row.payload.id, row.source_key);
    if (!id) return null;
    const leaderRow = leaderRows.find(candidate => asString(candidate.payload.group_id) === id);
    const leaderAccountId = leaderRow ? payloadId(leaderRow.payload) : null;
    const leader = leaderAccountId == null ? undefined : accountMap.get(leaderAccountId);
    const leaderPositions = leaderAccountId == null ? new Map<string, number>() : positionMap.get(leaderAccountId) ?? new Map<string, number>();
    const followers = followerRows
      .filter(candidate => asString(candidate.payload.group_id) === id)
      .map(candidate => {
        const accountId = payloadId(candidate.payload);
        if (accountId == null) return null;
        const scale = asNumber(candidate.payload.scale, 1);
        const replicate = asBoolean(candidate.payload.replicate, true);
        const followerPositions = positionMap.get(accountId) ?? new Map<string, number>();
        const symbols = new Set([...leaderPositions.keys(), ...followerPositions.keys()]);
        const mismatches: string[] = [];
        if (replicate) {
          for (const symbol of symbols) {
            const expected = (leaderPositions.get(symbol) ?? 0) * scale;
            const actual = followerPositions.get(symbol) ?? 0;
            if (Math.abs(expected - actual) > 0.0001) mismatches.push(`${symbol}: očekáváno ${expected}, skutečnost ${actual}`);
          }
        }
        return {
          accountId,
          accountName: accountMap.get(accountId)?.name ?? asString(candidate.payload.account_name, `Účet ${accountId}`),
          scale,
          replicate,
          synced: replicate && mismatches.length === 0,
          mismatches,
        } satisfies LiveFollower;
      })
      .filter((follower): follower is LiveFollower => follower != null);

    return {
      id,
      name: asString(row.payload.name, `Skupina ${id}`),
      leaderAccountId,
      leaderName: leader?.name ?? asString(leaderRow?.payload.account_name, 'Bez leadera'),
      followers,
      syncedCount: followers.filter(follower => follower.synced).length,
      warningCount: followers.filter(follower => !follower.synced).length,
    } satisfies LiveGroup;
  }).filter((group): group is LiveGroup => group != null);

  const alerts: LiveAlert[] = [];
  for (const group of groups) {
    for (const follower of group.followers) {
      if (!follower.replicate) {
        alerts.push({ level: 'warning', title: `${follower.accountName}: kopírování vypnuté`, detail: group.name, accountId: follower.accountId });
      } else if (!follower.synced) {
        alerts.push({ level: 'danger', title: `${follower.accountName}: rozdílná pozice`, detail: follower.mismatches.join(' · '), accountId: follower.accountId });
      }
    }
  }
  for (const account of accounts) {
    if (account.cushion != null && account.cushion <= 500) {
      alerts.push({
        level: account.cushion <= 0 ? 'danger' : 'warning',
        title: `${account.name}: nízká rezerva`,
        detail: `Do EOD drawdownu zbývá ${Math.round(account.cushion)} USD`,
        accountId: account.id,
      });
    }
  }

  const cushions = accounts.map(account => account.cushion).filter((value): value is number => value != null);
  return {
    run,
    accounts,
    appAccounts,
    connections,
    groups,
    alerts,
    totalBalance: accounts.reduce((sum, account) => sum + account.balance, 0),
    totalEquity: accounts.reduce((sum, account) => sum + account.equity, 0),
    totalRealizedPnl: accounts.reduce((sum, account) => sum + account.realizedPnl, 0),
    totalUnrealizedPnl: accounts.reduce((sum, account) => sum + account.unrealizedPnl, 0),
    worstCushion: cushions.length ? Math.min(...cushions) : null,
  };
}

async function loadLatestRun(): Promise<ShadowSyncRun | null> {
  const { data, error } = await supabase
    .from('tradecopia_shadow_sync_runs')
    .select('id,status,captured_at,completed_at,row_counts,changed_counts,warning,error')
    .eq('source', 'tradecopia')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as ShadowSyncRun | null;
}

export async function loadTradecopiaLiveOverview(): Promise<LiveSnapshot> {
  const [rowsResult, run, initialMappings, appAccounts] = await Promise.all([
    supabase
      .from('tradecopia_shadow_latest')
      .select('source_table,source_key,account_ext_id,source_updated_at,payload,last_seen_at,last_changed_at')
      .eq('source', 'tradecopia')
      .in('source_table', OVERVIEW_TABLES),
    loadLatestRun(),
    listAccountMap(),
    listAppAccounts(),
  ]);
  if (rowsResult.error) throw rowsResult.error;
  const rows = (rowsResult.data ?? []) as ShadowRow[];
  let mappings = initialMappings;
  const initialSnapshot = buildLiveSnapshot(rows, run, mappings, appAccounts);
  const missingMappings = initialSnapshot.accounts.filter(account => !account.mapRowId);
  if (missingMappings.length > 0) {
    const created = await ensureAccountMapRows(missingMappings.map(account => ({
      account_ext_id: account.id,
      account_name: account.name,
      entity_id: account.entityId,
      platform: 'Tradovate',
      trade_count: 0,
      total_pnl: account.realizedPnl,
      first_trade: null,
      last_trade: null,
      is_demo: false,
    })));
    if (created > 0) mappings = await listAccountMap();
  }
  return buildLiveSnapshot(rows, run, mappings, appAccounts);
}

export async function updateTradecopiaLiveMapping(mapRowId: string, mappedAccountId: string | null): Promise<boolean> {
  return setAccountMapping(mapRowId, {
    mapped_account_id: mappedAccountId,
    status: mappedAccountId ? 'mapped' : 'new',
  });
}

export async function loadTradecopiaLiveOrders(accountNames: Map<number, string>, limit = 300): Promise<LiveOrder[]> {
  const { data, error } = await supabase
    .from('tradecopia_shadow_latest')
    .select('source_table,source_key,account_ext_id,source_updated_at,payload,last_seen_at,last_changed_at')
    .eq('source', 'tradecopia')
    .eq('source_table', 'orders')
    .order('last_changed_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as ShadowRow[]).map(row => {
    const payload = row.payload;
    const accountId = asNullableNumber(payload.account_id) ?? row.account_ext_id;
    const status = asString(payload.status, 'Neznámý');
    return {
      id: payloadId(payload) ?? asNumber(row.source_key),
      accountId,
      accountName: accountId == null ? 'Neznámý účet' : accountNames.get(accountId) ?? `Účet ${accountId}`,
      action: asString(payload.action, '—'),
      orderType: asString(payload.order_type, '—'),
      quantity: asNumber(payload.quantity),
      price: asNullableNumber(payload.price),
      stopPrice: asNullableNumber(payload.stop_price),
      status,
      symbol: asString(payload.symbol, '—'),
      placedAt: asString(payload.placed_timestamp, asString(payload.created_at)) || null,
      updatedAt: asString(payload.updated_timestamp, asString(payload.updated_at, row.source_updated_at ?? '')) || null,
      working: !terminalStatuses.has(status.toLowerCase()),
    };
  });
}

const eventCopy = (row: { source_table: string; change_type: string; payload: ShadowPayload }): { title: string; detail: string } => {
  const payload = row.payload;
  if (row.source_table === 'orders') {
    return {
      title: `Příkaz ${asString(payload.status, row.change_type)}`,
      detail: `${asString(payload.action, '—')} ${asNumber(payload.quantity)}× ${asString(payload.symbol, '—')} · ${asString(payload.order_type, '—')}`,
    };
  }
  if (row.source_table === 'positions') {
    return { title: 'Změna pozice', detail: `${asString(payload.symbol, '—')} · pozice ${asNumber(payload.net_pos)}` };
  }
  if (row.source_table === 'accounts' || row.source_table === 'cash_balances') {
    return { title: 'Změna účtu', detail: `Balance ${asNumber(payload.balance ?? payload.amount).toLocaleString('cs-CZ')} USD` };
  }
  if (row.source_table.includes('risk')) return { title: 'Změna risku', detail: row.source_table.replaceAll('_', ' ') };
  return { title: row.source_table.replaceAll('_', ' '), detail: row.change_type };
};

export async function loadTradecopiaLiveEvents(accountNames: Map<number, string>, limit = 200): Promise<LiveEvent[]> {
  const [{ data: baseline }, { data, error }] = await Promise.all([
    supabase.from('tradecopia_shadow_sync_runs').select('id').eq('source', 'tradecopia').eq('status', 'completed').order('captured_at', { ascending: true }).limit(1).maybeSingle(),
    supabase
      .from('tradecopia_shadow_changes')
      .select('id,source_table,change_type,account_ext_id,observed_at,payload,sync_run_id')
      .eq('source', 'tradecopia')
      .order('observed_at', { ascending: false })
      .limit(limit),
  ]);
  if (error) throw error;
  return (data ?? [])
    .filter(row => row.sync_run_id !== baseline?.id)
    .map(row => {
      const payload = (row.payload ?? {}) as ShadowPayload;
      const groupAccountId = row.source_table === 'group_follower_accounts' || row.source_table === 'group_leader_accounts'
        ? asNullableNumber(payload.id)
        : null;
      const accountId = asNullableNumber(payload.account_id) ?? asNullableNumber(row.account_ext_id) ?? groupAccountId;
      const copy = eventCopy({ source_table: row.source_table, change_type: row.change_type, payload });
      return {
        id: asNumber(row.id),
        sourceTable: row.source_table,
        changeType: row.change_type as LiveEvent['changeType'],
        accountId,
        accountName: accountId == null ? 'Systém' : accountNames.get(accountId) ?? `Účet ${accountId}`,
        observedAt: row.observed_at,
        title: copy.title,
        detail: copy.detail,
        payload,
      };
    });
}
