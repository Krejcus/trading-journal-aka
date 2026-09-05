/**
 * Dev-only fixture pro LIVE přehled kopírky (konvence at:dev:*).
 *
 * `localStorage['at:dev:live-copy-fixture']='1'` podstrčí do LIVE Dashboardu
 * ukázkovou skupinu s leaderem, třemi followery, otevřenou pozicí, pracovními
 * příkazy a jedním odmítnutým followerem, aby šel vizuál (hlavně mobilní karty)
 * ladit v prohlížeči bez Tradovate dat. Jen v dev buildu, nic neodesílá.
 */

import type { LiveAccount, LiveOrder, LiveSnapshot } from '../services/tradecopiaLiveService';
import type { CopierAccountEligibility } from '../services/copierRuntimeController';

export const DEV_LIVE_COPY_FIXTURE_KEY = 'at:dev:live-copy-fixture';

const LEADER_ID = 62_364_058;
const FOLLOWER_A = 62_364_057;
const FOLLOWER_B = 62_364_060;
const FOLLOWER_C = 62_364_061;
const UPDATED_AT = '2026-09-05T13:42:10.000Z';

const account = (id: number, name: string, firm: string, patch: Partial<LiveAccount> = {}): LiveAccount => ({
  id,
  entityId: null,
  name,
  firm,
  phase: 'Funded',
  accountSize: 50_000,
  balance: 50_000,
  equity: 50_000,
  realizedPnl: 0,
  weekRealizedPnl: 0,
  unrealizedPnl: 0,
  peakEquity: null,
  drawdownFloor: null,
  cushion: 1_850,
  positions: [],
  updatedAt: UPDATED_AT,
  mapRowId: null,
  mappedAccountId: null,
  mappedAccountName: null,
  mappingStatus: null,
  ...patch,
});

export const devLiveCopyFixtureSnapshot: LiveSnapshot = {
  run: null,
  accounts: [
    account(LEADER_ID, 'FTDFYG50511354175', 'Tradeify', {
      balance: 51_240, equity: 51_310, realizedPnl: 240, unrealizedPnl: 70, cushion: 2_310,
      positions: [{ accountId: LEADER_ID, symbol: 'MNQZ6', netPosition: 2, netPrice: 23_412.25, realizedPnl: 0, unrealizedPnl: 70, updatedAt: UPDATED_AT }],
    }),
    account(FOLLOWER_A, 'LFF05066846490007', 'Lucid', {
      balance: 49_880, equity: 49_950, realizedPnl: -120, unrealizedPnl: 70, cushion: 1_120,
      positions: [{ accountId: FOLLOWER_A, symbol: 'MNQZ6', netPosition: 2, netPrice: 23_412.5, realizedPnl: 0, unrealizedPnl: 70, updatedAt: UPDATED_AT }],
    }),
    account(FOLLOWER_B, 'TRD-2200418', 'Tradeify', { balance: 50_000, equity: 50_000, realizedPnl: 0, unrealizedPnl: 0, cushion: 410 }),
    account(FOLLOWER_C, 'APX-118862', 'Apex', { balance: 48_300, equity: 48_300, realizedPnl: -640, unrealizedPnl: 0, cushion: 0 }),
  ],
  appAccounts: [],
  connections: [{
    id: 'tradovate-oauth-demo',
    firm: 'Tradeify',
    connected: true,
    status: 'Connected',
    accountCount: 4,
    disconnectedAt: null,
    disconnectReason: null,
    updatedAt: UPDATED_AT,
  }],
  groups: [{
    id: 'group-main',
    name: 'Hlavní',
    leaderAccountId: LEADER_ID,
    leaderName: 'FTDFYG50511354175',
    followers: [
      { accountId: FOLLOWER_A, accountName: 'LFF05066846490007', scale: 1, replicate: true, synced: true, mismatches: [] },
      { accountId: FOLLOWER_B, accountName: 'TRD-2200418', scale: 2, replicate: true, synced: true, mismatches: [] },
      { accountId: FOLLOWER_C, accountName: 'APX-118862', scale: 1, replicate: true, synced: false, mismatches: [] },
    ],
    syncedCount: 2,
    warningCount: 1,
  }],
  alerts: [],
  totalBalance: 199_420,
  totalEquity: 199_560,
  totalRealizedPnl: -520,
  totalUnrealizedPnl: 140,
  worstCushion: 0,
};

export const devLiveCopyFixtureOrders: LiveOrder[] = [
  {
    id: 9001, accountId: LEADER_ID, accountName: 'FTDFYG50511354175', action: 'Sell', orderType: 'Stop',
    quantity: 2, price: null, stopPrice: 23_380, status: 'Working', symbol: 'MNQZ6',
    placedAt: UPDATED_AT, updatedAt: UPDATED_AT, working: true,
  },
  {
    id: 9002, accountId: FOLLOWER_A, accountName: 'LFF05066846490007', action: 'Sell', orderType: 'Stop',
    quantity: 2, price: null, stopPrice: 23_380, status: 'Working', symbol: 'MNQZ6',
    placedAt: UPDATED_AT, updatedAt: UPDATED_AT, working: true,
  },
  {
    id: 9003, accountId: LEADER_ID, accountName: 'FTDFYG50511354175', action: 'Sell', orderType: 'Limit',
    quantity: 2, price: 23_470, stopPrice: null, status: 'Working', symbol: 'MNQZ6',
    placedAt: UPDATED_AT, updatedAt: UPDATED_AT, working: true,
  },
];

export const devLiveCopyFixtureEligibility: CopierAccountEligibility[] = [
  { accountId: LEADER_ID, state: 'active', at: Date.now() - 60_000 },
  {
    accountId: FOLLOWER_A, state: 'active', at: Date.now() - 4 * 60_000,
    lastExecution: { kind: 'rejected', reason: 'Your maximum order quantity has been met. Limit: 2 Current: 3.0', symbol: 'MNQZ6', at: Date.now() - 4 * 60_000 },
  },
  { accountId: FOLLOWER_B, state: 'dll-locked', reason: 'Denní ztrátový limit propfirmy dosažen', at: Date.now() - 30 * 60_000 },
  { accountId: FOLLOWER_C, state: 'breached', reason: 'Účet porušil drawdown', at: Date.now() - 2 * 60 * 60_000 },
];

export const devLiveCopyFixtureDailyStats = {
  sessionEndAt: Date.now() + 5 * 60 * 60_000,
  realizedPnlUsd: 240,
  losingTrades: 1,
  tradesToday: 3,
  windowState: 'inside' as const,
  warnedRules: [],
  unpricedSymbols: [],
};

export function devLiveCopyFixtureEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem(DEV_LIVE_COPY_FIXTURE_KEY) === '1';
  } catch {
    return false;
  }
}
