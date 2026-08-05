import { describe, expect, it } from 'vitest';
import { buildLiveSnapshot, type ShadowRow, type ShadowSyncRun } from '../services/tradecopiaLiveService';

const row = (source_table: string, payload: Record<string, unknown>, account_ext_id: number | null = null): ShadowRow => ({
  source_table,
  source_key: String(payload.id ?? `${source_table}-1`),
  account_ext_id,
  source_updated_at: '2026-08-01T10:00:00Z',
  payload,
  last_seen_at: '2026-08-01T10:00:00Z',
  last_changed_at: '2026-08-01T10:00:00Z',
});

const run: ShadowSyncRun = {
  id: 'run-1',
  status: 'completed',
  captured_at: '2026-08-01T10:00:00Z',
  completed_at: '2026-08-01T10:00:01Z',
  row_counts: {},
  changed_counts: {},
  warning: null,
  error: null,
};

describe('buildLiveSnapshot', () => {
  it('calculates linked EOD trailing floor and current cushion', () => {
    const snapshot = buildLiveSnapshot([
      row('accounts', { id: 1, name: 'FTDFY001', balance: 51_800, realized_pn_l: 1_800, week_realized_pn_l: 800 }),
      row('positions', { id: 9, account_id: 1, symbol: 'MNQU6', net_pos: 2, unrealized_pl: 100 }),
      row('account_risk_statuses', { account_id: 1, max_net_liq: 52_100 }, 1),
      row('prop_firm_accounts', {
        id: 31,
        trading_account_id: 1,
        firm_name: 'Tradeify',
        account_size: 50_000,
        phase: 'funded',
        metadata: { maxLossLimit: 2_000 },
      }),
    ], run);

    expect(snapshot.accounts[0]).toMatchObject({
      equity: 51_900,
      peakEquity: 52_100,
      drawdownFloor: 50_100,
      cushion: 1_800,
      firm: 'Tradeify',
    });
    expect(snapshot.totalUnrealizedPnl).toBe(100);
  });

  it('does not invent a floor when prop metadata is missing', () => {
    const snapshot = buildLiveSnapshot([
      row('accounts', { id: 1, name: 'Unknown', balance: 50_000 }),
      row('account_risk_statuses', { account_id: 1, max_net_liq: 52_100 }, 1),
    ], run);

    expect(snapshot.accounts[0].drawdownFloor).toBeNull();
    expect(snapshot.accounts[0].cushion).toBeNull();
  });

  it('detects copier position mismatches with follower scale', () => {
    const snapshot = buildLiveSnapshot([
      row('accounts', { id: 1, name: 'Leader', balance: 50_000 }),
      row('accounts', { id: 2, name: 'Follower', balance: 50_000 }),
      row('positions', { id: 10, account_id: 1, symbol: 'MNQU6', net_pos: 2 }),
      row('positions', { id: 11, account_id: 2, symbol: 'MNQU6', net_pos: 3 }),
      row('groups', { id: 'group-uuid', name: 'Hlavní' }),
      row('group_leader_accounts', { id: 1, group_id: 'group-uuid', account_name: 'Leader' }),
      row('group_follower_accounts', { id: 2, group_id: 'group-uuid', account_name: 'Follower', scale: 2, replicate: true }),
    ], run);

    expect(snapshot.groups[0]).toMatchObject({ syncedCount: 0, warningCount: 1 });
    expect(snapshot.groups[0].followers[0].mismatches[0]).toContain('očekáváno 4');
    expect(snapshot.alerts[0].level).toBe('danger');
  });

  it('groups connection state by prop firm and attaches AlphaTrade mapping', () => {
    const snapshot = buildLiveSnapshot([
      row('entity_connections', {
        id: 'tradeify-entity',
        name: 'Tradeify login',
        organization: 'Tradeify',
        status: 'Disconnected',
        is_connected: 0,
        disconnected_at: '2026-07-31T20:30:24Z',
        disconnect_reason: 'automatic',
      }),
      row('accounts', { id: 10, entity_id: 'tradeify-entity', name: 'FTDFY001', balance: 50_100 }),
      row('accounts', { id: 11, entity_id: 'tradeify-entity', name: 'FTDFY002', balance: 50_200 }),
    ], run, [{
      id: 'map-1',
      account_ext_id: 10,
      account_name: 'FTDFY001',
      entity_id: 'tradeify-entity',
      mapped_account_id: 'alpha-1',
      status: 'mapped',
      is_connected: true,
      import_from_date: null,
    }], [{ id: 'alpha-1', name: 'Tradeify 1', status: 'Active', type: 'Funded' }]);

    expect(snapshot.connections).toHaveLength(1);
    expect(snapshot.connections[0]).toMatchObject({
      firm: 'Tradeify',
      connected: false,
      accountCount: 2,
      disconnectReason: 'automatic',
    });
    expect(snapshot.accounts.find(account => account.id === 10)).toMatchObject({
      firm: 'Tradeify',
      mappedAccountId: 'alpha-1',
      mappedAccountName: 'Tradeify 1',
      mappingStatus: 'mapped',
    });
  });
});
