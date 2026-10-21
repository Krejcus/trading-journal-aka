/**
 * Dev-only ukázkový obchod pro kartu obchodu v LIVE (konvence at:dev:*).
 *
 * `?page=live&live-mock=trade` zapne, `?live-mock=off` vypne (pamatuje se
 * v localStorage). LIVE pak místo skutečných dat ukáže skupinu se čtyřmi
 * DEMO účty v obchodu MNQ, aby šla karta, ostrov a rozbalení vidět bez
 * otevřené pozice. Jen v dev buildu, nic se neodesílá.
 */

import type { LiveAccount, LiveOrder, LiveSnapshot } from '../services/tradecopiaLiveService';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';
import { feeRateKey } from './liveTradeCard';

export const DEV_LIVE_TRADE_MOCK_KEY = 'at:dev:live-trade-mock';

export function devLiveTradeMockEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    const param = new URLSearchParams(window.location.search).get('live-mock');
    if (param === 'trade') localStorage.setItem(DEV_LIVE_TRADE_MOCK_KEY, '1');
    if (param === 'off') localStorage.removeItem(DEV_LIVE_TRADE_MOCK_KEY);
    return localStorage.getItem(DEV_LIVE_TRADE_MOCK_KEY) === '1';
  } catch {
    return false;
  }
}

export type DevTradeMockScenario = 'position' | 'be' | 'nosl' | 'pending';

const IDS = [9_100_001, 9_100_002, 9_100_003, 9_100_004];
const NAMES = ['DEMO-LEADER-01', 'DEMO-FOLLOW-02', 'DEMO-FOLLOW-03', 'DEMO-FOLLOW-04'];
/** Followeři o tick dva hůř než leader — skluz kopie. */
const ENTRIES = [21_482.25, 21_482.5, 21_482.75, 21_482.25];
const GROUP_ID = 'dev-trade-mock';

export const devTradeMockGroup: CopyGroupConfig = {
  id: GROUP_ID, name: 'DEMO skupina', enabled: true, leaderAccountId: IDS[0],
  followers: IDS.slice(1).map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
  color: '#84cc16', localOnly: true,
  safety: { ...DEFAULT_COPY_GROUP_SAFETY },
};

/** Poplatek 0,52 USD za kontrakt a stranu (MNQ u prop firem zhruba tolik). */
export const devTradeMockFeeRates: ReadonlyMap<string, number> = new Map(IDS.map(id => [feeRateKey(id, 'MNQZ6'), 0.52]));

export function buildDevTradeMock(scenario: DevTradeMockScenario, price: number): { snapshot: LiveSnapshot; orders: LiveOrder[] } {
  const at = new Date().toISOString();
  const pending = scenario === 'pending';
  const accounts: LiveAccount[] = IDS.map((id, index) => ({
    id, entityId: null, name: NAMES[index], firm: index === 0 ? 'Lucid' : 'Tradeify', phase: 'Funded', accountSize: 50_000,
    balance: 50_000, equity: 50_000, realizedPnl: 0, weekRealizedPnl: 0,
    unrealizedPnl: pending ? 0 : (price - ENTRIES[index]) * 2 * 2,
    unrealizedPnlSource: 'broker', unrealizedPnlUpdatedAt: at,
    positionsAvailability: 'available', ordersAvailability: 'available', cashAvailability: 'available',
    positionsUpdatedAt: at, ordersUpdatedAt: at, cashUpdatedAt: at,
    peakEquity: null, drawdownFloor: null, cushion: 1_240 + index * 100,
    positions: pending ? [] : [{ accountId: id, symbol: 'MNQZ6', netPosition: 2, netPrice: ENTRIES[index], realizedPnl: 0, unrealizedPnl: 0, updatedAt: at }],
    updatedAt: at, mapRowId: null, mappedAccountId: null, mappedAccountName: null, mappingStatus: null,
  }));
  const stop = scenario === 'be' ? 21_492.25 : pending ? 21_450 : 21_462.25;
  const target = pending ? 21_510 : 21_522.25;
  let nextId = 1;
  const orders: LiveOrder[] = IDS.flatMap((id, index) => {
    const status = pending ? 'Suspended' : 'Working';
    const base = { accountId: id, accountName: NAMES[index], symbol: 'MNQZ6', placedAt: at, updatedAt: at };
    const legs: LiveOrder[] = [];
    if (pending) legs.push({ ...base, id: nextId++, action: 'Buy', orderType: 'Limit', quantity: 2, price: 21_470, stopPrice: null, status: 'Working', working: true });
    if (!(scenario === 'nosl' && index === 2)) {
      legs.push({ ...base, id: nextId++, action: 'Sell', orderType: 'Stop', quantity: 2, price: null, stopPrice: stop, status, working: !pending });
    }
    legs.push({ ...base, id: nextId++, action: 'Sell', orderType: 'Limit', quantity: 2, price: target, stopPrice: null, status, working: !pending });
    return legs;
  });
  const snapshot: LiveSnapshot = {
    run: null, accounts, appAccounts: [], alerts: [],
    connections: [{ id: 'dev-trade-mock', firm: 'Tradeify', connected: true, status: 'Connected', accountCount: IDS.length, disconnectedAt: null, disconnectReason: null, updatedAt: at }],
    groups: [{
      id: GROUP_ID, name: 'DEMO skupina', leaderAccountId: IDS[0], leaderName: NAMES[0],
      followers: IDS.slice(1).map((accountId, index) => ({ accountId, accountName: NAMES[index + 1], scale: 1, replicate: true, synced: true, mismatches: [] })),
      syncedCount: IDS.length - 1, warningCount: 0,
    }],
    totalBalance: 200_000, totalEquity: 200_000, totalRealizedPnl: 0, totalUnrealizedPnl: 0, worstCushion: 1_240,
  };
  return { snapshot, orders };
}

export const DEV_TRADE_MOCK_GROUP_ID = GROUP_ID;
