import React from 'react';
import ReactDOM from 'react-dom/client';
import LiveCopyTradeOverview from './components/LiveCopyTradeOverview';
import type { LiveAccount, LiveOrder, LiveSnapshot } from './services/tradecopiaLiveService';

const account = (id: number, name: string, balance: number): LiveAccount => ({
  id,
  entityId: null,
  name,
  firm: 'Tradeify',
  phase: 'Evaluation',
  accountSize: 50_000,
  balance,
  equity: balance,
  // The isolated preview has no live stream, so current-session P&L stays
  // neutral. Risk values mirror the verified Growth 50K EOD profile: no EOD
  // close above 50K and a 2K maximum loss means a 48K floor.
  realizedPnl: 0,
  weekRealizedPnl: 0,
  unrealizedPnl: 0,
  peakEquity: 50_000,
  drawdownFloor: 48_000,
  cushion: balance - 48_000,
  positions: [],
  updatedAt: new Date().toISOString(),
  mapRowId: null,
  mappedAccountId: null,
  mappedAccountName: null,
  mappingStatus: null,
});

const accounts = [
  account(1, 'TDFYG50426883902', 48_679.80),
  account(2, 'TDFYG50549979811', 48_554),
  account(3, 'TDFYG50534566527', 48_554),
  account(4, 'TDFYG50213913415', 48_554),
  account(5, 'TDFYG50144879707', 48_554),
];

const snapshot: LiveSnapshot = {
  run: null,
  accounts,
  appAccounts: [],
  connections: [{
    id: 'tradovate-preview', firm: 'Tradeify', connected: true, status: 'Connected',
    accountCount: accounts.length, disconnectedAt: null, disconnectReason: null,
    updatedAt: new Date().toISOString(),
  }],
  groups: [{
    id: 'tradeify', name: 'tradeify', leaderAccountId: 1, leaderName: accounts[0].name,
    followers: accounts.slice(1).map(item => ({ accountId: item.id, accountName: item.name, scale: 1, replicate: true, synced: true, mismatches: [] })),
    syncedCount: 4, warningCount: 0,
  }],
  alerts: [],
  totalBalance: accounts.reduce((sum, item) => sum + item.balance, 0),
  totalEquity: accounts.reduce((sum, item) => sum + item.equity, 0),
  totalRealizedPnl: accounts.reduce((sum, item) => sum + item.realizedPnl, 0),
  totalUnrealizedPnl: 0,
  worstCushion: Math.min(...accounts.map(item => item.cushion ?? Infinity)),
};

const orders: LiveOrder[] = [{
  id: 901,
  accountId: 1,
  accountName: accounts[0].name,
  action: 'Buy',
  orderType: 'Limit',
  quantity: 1,
  price: 23_750,
  stopPrice: null,
  status: 'Working',
  symbol: 'NQZ6',
  placedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  working: true,
}];

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main className="mx-auto max-w-[1500px] p-6">
      <LiveCopyTradeOverview snapshot={snapshot} orders={orders} />
    </main>
  </React.StrictMode>,
);
