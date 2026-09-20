/**
 * Náhled skutečného přehledu kopírovacích skupin mimo přihlášenou appku.
 * Stejná data jako v render testech, jen mountnutá do prohlížeče, aby šel
 * posoudit detail skupiny včetně animací.
 */
import { createRoot } from 'react-dom/client';
import { LiveCopyTradeOverview } from '../components/LiveCopyTradeOverview';
import '../index.css';

const account = (id: number, name: string, firm: string, balance: number) => ({
  id, entityId: null, name, firm, phase: 'Funded', accountSize: 50_000,
  balance, equity: balance, realizedPnl: 0, weekRealizedPnl: 0, unrealizedPnl: 0,
  peakEquity: null, drawdownFloor: null, cushion: null, positions: [],
  updatedAt: '2026-09-19T08:00:00.000Z', mapRowId: null, mappedAccountId: null,
  mappedAccountName: null, mappingStatus: null,
});

const LEADER = 62_364_058;
const FOLLOWERS = [62_364_057, 62_364_056, 62_364_055, 62_364_054, 62_364_053];

const snapshot = {
  run: null,
  accounts: [
    account(LEADER, 'LFF05066846490010', 'Lucid', 48_632.5),
    ...FOLLOWERS.map((id, index) => account(id, `TDF-50K-1182${'0' + (4 + index)}`, 'Tradeify', 50_000 + index * 310)),
  ],
  appAccounts: [],
  connections: [{
    id: 'tradovate-oauth-1', firm: 'Tradeify', connected: true, status: 'Connected',
    accountCount: 6, disconnectedAt: null, disconnectReason: null,
    updatedAt: '2026-09-19T08:00:00.000Z',
  }],
  groups: [{
    id: 'group-main', name: 'asdlkjasd', leaderAccountId: LEADER, leaderName: 'LFF05066846490010',
    followers: FOLLOWERS.map((accountId, index) => ({
      accountId, accountName: `TDF-50K-1182${'0' + (4 + index)}`, scale: 1,
      replicate: true, synced: true, mismatches: [],
    })),
    syncedCount: FOLLOWERS.length, warningCount: 0,
  }],
  alerts: [],
  totalBalance: 349_261.1, totalEquity: 349_261.1, totalRealizedPnl: 0,
  totalUnrealizedPnl: 0, worstCushion: null,
};

const orders = [1, 2, 3].map((n, index) => ({
  id: 9000 + n,
  accountId: index === 0 ? LEADER : FOLLOWERS[index - 1],
  accountName: index === 0 ? 'LFF05066846490010' : `TDF-50K-1182${'0' + (4 + index - 1)}`,
  action: index === 2 ? 'Sell' : 'Buy', orderType: index === 2 ? 'Stop' : 'Limit',
  quantity: 3, price: index === 2 ? null : 29_487.75, stopPrice: index === 2 ? 29_462 : null,
  status: 'Working', symbol: 'MNQZ6',
  placedAt: '2026-09-19T08:00:00.000Z', updatedAt: '2026-09-19T08:00:00.000Z', working: true,
}));

const container = document.getElementById('root')! as HTMLElement & { _root?: ReturnType<typeof createRoot> };
container._root ??= createRoot(container);
container._root.render(
  <div style={{ padding: 20, background: 'var(--bg-page)', minHeight: '100vh' }}>
    <LiveCopyTradeOverview snapshot={snapshot as never} orders={orders as never} />
  </div>,
);
