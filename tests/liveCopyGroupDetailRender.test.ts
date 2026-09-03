import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  copyTradeDailyLossRemaining,
  LiveCopyTradeOverview,
} from '../components/LiveCopyTradeOverview';
import type { LiveAccount, LiveOrder, LiveSnapshot } from '../services/tradecopiaLiveService';

const liveAccount = (id: number, name: string): LiveAccount => ({
  id,
  entityId: null,
  name,
  firm: 'Tradeify',
  phase: 'Funded',
  accountSize: 50_000,
  balance: 50_000,
  equity: 50_000,
  realizedPnl: 0,
  weekRealizedPnl: 0,
  unrealizedPnl: 0,
  peakEquity: null,
  drawdownFloor: null,
  cushion: null,
  positions: [],
  updatedAt: '2026-08-25T08:00:00.000Z',
  mapRowId: null,
  mappedAccountId: null,
  mappedAccountName: null,
  mappingStatus: null,
});

const leaderId = 62_364_058;
const followerId = 62_364_057;

const snapshot: LiveSnapshot = {
  run: null,
  accounts: [
    liveAccount(leaderId, 'Leader DEMO'),
    liveAccount(followerId, 'Follower DEMO'),
  ],
  appAccounts: [],
  connections: [{
    id: 'tradovate-oauth-1',
    firm: 'Tradeify',
    connected: true,
    status: 'Connected',
    accountCount: 2,
    disconnectedAt: null,
    disconnectReason: null,
    updatedAt: '2026-08-25T08:00:00.000Z',
  }],
  groups: [{
    id: 'group-main',
    name: 'Hlavni',
    leaderAccountId: leaderId,
    leaderName: 'Leader DEMO',
    followers: [{
      accountId: followerId,
      accountName: 'Follower DEMO',
      scale: 1,
      replicate: true,
      synced: true,
      mismatches: [],
    }],
    syncedCount: 1,
    warningCount: 0,
  }],
  alerts: [],
  totalBalance: 100_000,
  totalEquity: 100_000,
  totalRealizedPnl: 0,
  totalUnrealizedPnl: 0,
  worstCushion: null,
};

const workingLeaderLimit: LiveOrder = {
  id: 9001,
  accountId: leaderId,
  accountName: 'Leader DEMO',
  action: 'Buy',
  orderType: 'Limit',
  quantity: 3,
  price: 23_000,
  stopPrice: null,
  status: 'Working',
  symbol: 'MNQU6',
  placedAt: '2026-08-25T08:00:00.000Z',
  updatedAt: '2026-08-25T08:00:00.000Z',
  working: true,
};

const tableRows = (markup: string): string[] => markup.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];
const tableCells = (row: string): string[] => row.match(/<td\b[^>]*>[\s\S]*?<\/td>/g) ?? [];

describe('GroupDetail Positions integrace', () => {
  it('odděluje leader-only copier statistiku od broker P&L všech účtů', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: {
        ...snapshot,
        accounts: [
          { ...snapshot.accounts[0], realizedPnl: -400 },
          { ...snapshot.accounts[1], realizedPnl: -200 },
        ],
      },
      dailyStats: {
        label: 'Leader · jen obchody přes kopírku · bez poplatků',
        sessionEndAt: 10_000,
        realizedPnlUsd: -100,
        losingTrades: 1,
        unpricedSymbols: [],
      },
    }));

    expect(markup).toContain('Leader · jen obchody přes kopírku · bez poplatků');
    expect(markup).toContain('Účty (broker, vč. poplatků)');
    expect(markup).toContain('-$100.00');
    expect(markup).toContain('-$600.00');
  });

  it('groupRows používá společnou source-group kaskádu i pro účet mimo OAuth snapshot', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: { ...snapshot, accounts: [snapshot.accounts[0]] },
    }));

    expect(markup).toContain('Follower DEMO');
    expect(markup).not.toContain(`Účet ${followerId}`);
  });

  it('zobrazuje volitelný zbývající DLL ze stejného realized + unrealized základu jako risk gate', () => {
    const accountWithDll = {
      ...snapshot.accounts[0],
      dailyLossLimit: 1_250,
      realizedPnl: -200,
      unrealizedPnl: -50,
    };
    expect(copyTradeDailyLossRemaining(accountWithDll)).toBe(1_000);
    expect(copyTradeDailyLossRemaining({ ...accountWithDll, dailyLossLimit: null })).toBeNull();

    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: { ...snapshot, accounts: [accountWithDll, snapshot.accounts[1]] },
    }));
    expect(markup).toContain('DLL zbývá');
    expect(markup).toContain('DLL $1,250.00 · dnešní realizovaný + otevřený P&amp;L -$250.00');
    expect(markup).toContain('>1,000<');
  });

  it('nabídne bezpečnou opravu pouze když TradingView běží bez CDP', () => {
    const health = {
      enabled: true,
      repairSupported: true,
      state: 'cdp-offline' as const,
      layoutName: 'AlphaTrade Snapshoty',
      chartIdConfigured: true,
      cdpReachable: false,
      targetFound: false,
      lastCheckedAt: 1,
      lastAttemptAt: null,
      lastSuccessAt: null,
    };
    const offline = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot,
      snapshotHealth: health,
      onRepairSnapshots: () => undefined,
    }));
    expect(offline).toContain('Obnovit snímky');
    expect(offline).toContain('Obchod proběhne, ale graf se neuloží.');

    const ready = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot,
      snapshotHealth: {
        ...health,
        state: 'ready',
        cdpReachable: true,
        targetFound: true,
      },
      onRepairSnapshots: () => undefined,
    }));
    expect(ready).not.toContain('Obnovit snímky');
    expect(ready).toContain('je připravený pro ENTRY/EXIT');
  });

  it('u staršího workeru nevystaví nefunkční opravu snímků', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot,
      snapshotHealth: {
        enabled: true,
        state: 'cdp-offline',
        layoutName: 'AlphaTrade Snapshoty',
        chartIdConfigured: true,
        cdpReachable: false,
        targetFound: false,
        lastCheckedAt: 1,
        lastAttemptAt: null,
        lastSuccessAt: null,
      },
      onRepairSnapshots: () => undefined,
    }));

    expect(markup).not.toContain('Obnovit snímky');
    expect(markup).toContain('Mac worker je starší a neumí automatickou opravu.');
  });

  it('během fresh bootstrapu nevydává chybějící denní ledger za nulu', () => {
    const bootstrapSnapshot = {
      ...snapshot,
      accounts: snapshot.accounts.map(account => ({ ...account, realizedPnl: 123 })),
      totalRealizedPnl: 246,
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: bootstrapSnapshot,
      dailyPnlPending: true,
    }));

    expect(markup).not.toContain('123');
    expect(markup).toContain('—');
  });

  it('propustí working limit přes group accountIds do pending pillu v leader řádku', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot,
      orders: [
        workingLeaderLimit,
        { ...workingLeaderLimit, id: 9002, accountId: 999_999, accountName: 'Mimo skupinu', symbol: 'NQH27' },
      ],
    }));

    const leaderRow = tableRows(markup).find(row => row.includes('title="Leader účet"'));
    const positionsCell = leaderRow && tableCells(leaderRow)
      .find(cell => cell.includes('aria-label="Čekající vstup'));

    expect(leaderRow, 'leader account row se musí vykreslit').toBeDefined();
    expect(leaderRow).toContain('Leader DEMO');
    expect(positionsCell, 'pending pill musí být přímo v Positions buňce leadera').toBeDefined();
    expect(positionsCell).toContain('aria-label="Čekající vstup MNQ, 3 kontraktů"');
    expect(positionsCell).toContain('lucide-clock-3');
    expect(positionsCell).not.toContain('Čekající vstup NQ,');
  });

  it('překrývající profily vykreslí jako vypnuté, dokud runtime není ARMED', () => {
    const second = {
      ...snapshot.groups[0],
      id: 'group-second',
      name: 'Druhy profil',
    };
    const runtimeGroup = {
      id: 'group-main',
      name: 'Hlavni',
      enabled: true,
      leaderAccountId: leaderId,
      followers: [{ accountId: followerId, mode: 'on-submit' as const, multiplier: 1 }],
      localOnly: true,
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: { ...snapshot, groups: [snapshot.groups[0], second] },
      executionGroupId: 'group-main',
      runtimeGroup,
    }));

    expect(markup).toContain('Hlavni');
    expect(markup).toContain('Druhy profil');
    expect(markup.match(/VYPNUTÁ/g)).toHaveLength(2);
    expect(markup).not.toContain('ZAPNUTÁ');
  });

  it('vybraný, ale vypnutý execution profil nezobrazuje jako aktivní', () => {
    const second = {
      ...snapshot.groups[0],
      id: 'group-second',
      name: 'Druhy profil',
    };
    const runtimeGroup = {
      id: 'group-main',
      name: 'Hlavni',
      enabled: false,
      leaderAccountId: leaderId,
      followers: [{ accountId: followerId, mode: 'on-submit' as const, multiplier: 1 }],
      localOnly: true,
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: { ...snapshot, groups: [snapshot.groups[0], second] },
      executionGroupId: 'group-main',
      runtimeGroup,
    }));

    expect(markup.match(/VYPNUTÁ/g)).toHaveLength(2);
    expect(markup).not.toContain('Execution aktivní');
  });

  it('jedinou ZAPNUTOU skupinu řadí před ostatní vypnuté profily', () => {
    const second = {
      ...snapshot.groups[0],
      id: 'group-second',
      name: 'Druhy profil',
    };
    const runtimeGroup = {
      id: 'group-second',
      name: 'Druhy profil',
      enabled: true,
      leaderAccountId: leaderId,
      followers: [{ accountId: followerId, mode: 'on-submit' as const, multiplier: 1 }],
      localOnly: true,
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: { ...snapshot, groups: [snapshot.groups[0], second] },
      executionGroupId: 'group-second',
      runtimeGroup,
      copierArmed: true,
    }));

    expect(markup.match(/ZAPNUTÁ/g)).toHaveLength(1);
    expect(markup.match(/VYPNUTÁ/g)).toHaveLength(1);
    expect(markup.indexOf('Druhy profil')).toBeLessThan(markup.indexOf('Hlavni'));
    expect(markup).toContain('data-group-layout-motion="true"');
  });

  it('zobrazí stale followera jako nedostupného a nepočítá ho mezi aktivní', () => {
    const staleFollowerId = 63_338_592;
    const staleGroup = {
      ...snapshot.groups[0],
      followers: [{
        ...snapshot.groups[0].followers[0],
        accountId: staleFollowerId,
        accountName: `Účet ${staleFollowerId}`,
      }],
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: { ...snapshot, groups: [staleGroup] },
    }));

    expect(markup).toContain('0/1 aktivních');
    expect(markup).toContain('1× nedostupný');
    expect(markup).toContain('Nedostupný účet');
    expect(markup).toContain('Účet není v aktuálním OAuth snapshotu. Oprav skupinu přes Edit group.');
  });

  it('u chybějícího OAuth účtu zachová autoritativní BREACHED místo obecného nedostupný', () => {
    const staleFollowerId = 63_338_592;
    const staleGroup = {
      ...snapshot.groups[0],
      followers: [{
        ...snapshot.groups[0].followers[0],
        accountId: staleFollowerId,
        accountName: `Účet ${staleFollowerId}`,
      }],
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: { ...snapshot, groups: [staleGroup] },
      accountEligibility: [{
        accountId: staleFollowerId,
        state: 'breached',
        reason: 'LIVE equity dosáhla drawdown flooru',
        at: 123,
      }],
    }));

    expect(markup).toContain('0/1 aktivních');
    expect(markup).toContain('1× BREACHED');
    expect(markup).not.toContain('1× nedostupný');
    expect(markup).toContain('LIVE equity dosáhla drawdown flooru · účet není v aktuálním OAuth snapshotu');
    expect(markup).toContain('>BREACHED<');
  });

  it('u uložené skupiny dopočítá DLL a BREACHED i bez dostupného worker statusu', () => {
    const dllId = 62_364_553;
    const breachedId = 62_364_058;
    const riskSnapshot: LiveSnapshot = {
      ...snapshot,
      accounts: [
        snapshot.accounts[0],
        { ...liveAccount(dllId, 'Lucid DLL'), firm: 'Lucid', dailyLossLimit: 1_200, realizedPnl: -1_206.5 },
        { ...liveAccount(breachedId, 'Tradeify breached'), cushion: -33 },
      ],
      connections: [
        ...snapshot.connections,
        { ...snapshot.connections[0], id: 'tradovate-oauth-2', firm: 'Lucid', accountCount: 1 },
      ],
      groups: [{
        ...snapshot.groups[0],
        followers: [
          { ...snapshot.groups[0].followers[0], accountId: dllId, accountName: 'Lucid DLL' },
          { ...snapshot.groups[0].followers[0], accountId: breachedId, accountName: 'Tradeify breached' },
        ],
      }],
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: riskSnapshot,
      accountProfiles: [],
      accountEligibility: [],
    }));

    expect(markup).toContain('0/2 aktivních');
    expect(markup).toContain('1× DLL');
    expect(markup).toContain('1× BREACHED');
    expect(markup).toContain('DLL · do konce session');
    expect(markup).toContain('LIVE denní P&amp;L -1206.50 USD');
    expect(markup).toContain('BREACHED');
    expect(markup).toContain('LIVE equity dosáhla drawdown flooru');
  });
});
