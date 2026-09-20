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
    // The current shared risk-value component renders the amount; its legacy
    // path no longer contains the old inline tooltip. Keep the arithmetic and
    // rendered-value assertions rather than requiring retired markup.
    expect(markup).not.toContain('>1,250<');
    expect(markup).toContain('>1,000<');
  });

  it.each([1_500, 850, 0, -25])('uses the same actual DD reserve in both columns without DLL (%s)', cushion => {
    const account = {
      ...snapshot.accounts[0], dailyLossLimit: null, riskDisplayDailyLossDisabled: true,
      cashAvailability: 'available' as const, cashUpdatedAt: new Date().toISOString(),
      unrealizedPnlSource: 'broker' as const, cushion,
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: { ...snapshot, accounts: [account] },
    }));
    const cells = tableCells(tableRows(markup).find(row => row.includes('title="Leader účet"'))!);
    const ddCells = cells.filter(cell => cell.includes('data-risk-display="verified"'));
    expect(ddCells).toHaveLength(2);
    for (const cell of ddCells) expect(cell).toContain(`>${new Intl.NumberFormat('en-US').format(cushion)}<`);
    // Popisek „· DD“ u hodnoty byl odstraněn; rozdíl nese jen tooltip buňky.
    expect(ddCells[0]).toContain('title="Účet nemá denní limit ztráty');
    expect(ddCells[1]).not.toContain('title="Účet nemá denní limit ztráty');
    expect(ddCells[0]).not.toContain('role="status"');
  });

  it('keeps real DLL and unknown limits distinct from a confirmed no-DLL plan', () => {
    for (const account of [
      { ...snapshot.accounts[0], dailyLossLimit: 1_250, riskDisplayDailyLossDisabled: true, cushion: 1_500 },
      { ...snapshot.accounts[0], dailyLossLimit: null, riskDisplayDailyLossDisabled: false, cushion: 1_500 },
    ]) {
      const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
        snapshot: { ...snapshot, accounts: [account] },
      }));
      expect(markup).not.toContain('title="Účet nemá denní limit ztráty');
      if (account.dailyLossLimit) expect(markup).toContain('>1,250<');
    }
  });

  it.each(['missing', 'pending', 'denied', 'disabled'])('never invents a DD reserve when %s', state => {
    const account = {
      ...snapshot.accounts[0], dailyLossLimit: null, riskDisplayDailyLossDisabled: true,
      cashAvailability: state === 'denied' ? 'denied' as const : 'available' as const,
      cashUpdatedAt: new Date().toISOString(), unrealizedPnlSource: 'broker' as const,
      cushion: state === 'missing' ? null : 1_500,
      riskDisplayPending: state === 'pending', riskDisplayDrawdownDisabled: state === 'disabled',
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: { ...snapshot, accounts: [account] },
    }));
    expect(markup).toContain('title="Účet nemá denní limit ztráty');
    expect(markup).not.toContain('>1,500<');
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
      .find(cell => cell.includes('aria-label="Čekající BUY'));

    expect(leaderRow, 'leader account row se musí vykreslit').toBeDefined();
    expect(leaderRow).toContain('Leader DEMO');
    expect(positionsCell, 'pending pill musí být přímo v Positions buňce leadera').toBeDefined();
    // Popisek nese směr, typ i stav ochrany — chip sám ukáže směr a trojúhelník.
    expect(positionsCell).toContain('aria-label="Čekající BUY Limit MNQ, 3 kontrakty, bez stop lossu"');
    expect(positionsCell).toContain('lucide-clock-3');
    expect(positionsCell).toContain('>BUY<');
    expect(positionsCell).not.toContain('Čekající BUY Limit NQ,');
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
    expect(markup.match(/aria-checked="false"/g)).toHaveLength(2);
    expect(markup).not.toContain('aria-checked="true"');
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

    expect(markup.match(/aria-checked="false"/g)).toHaveLength(2);
    expect(markup).not.toContain('Execution aktivní');
  });

  it('po prvním ARM dovolí inline násobek jen snížit', () => {
    const runtimeGroup = {
      id: 'group-main',
      name: 'Hlavni',
      enabled: false,
      leaderAccountId: leaderId,
      followers: [{ accountId: followerId, mode: 'on-submit' as const, multiplier: 2 }],
      localOnly: true,
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: {
        ...snapshot,
        groups: [{
          ...snapshot.groups[0],
          // Starý browser draft je mírnější; už první render musí převzít
          // autoritativní worker multiplier 2.
          followers: [{ ...snapshot.groups[0].followers[0], scale: 3 }],
        }],
      },
      executionGroupId: 'group-main',
      runtimeGroup,
      sessionArmedAt: 1,
    }));
    const followerRow = tableRows(markup).find(row => row.includes('Follower DEMO'));

    expect(followerRow).toContain(`aria-label="Násobek Follower DEMO"`);
    expect(followerRow).toContain('max="2"');
    expect(followerRow).toContain('title="dnes jen zpřísnit"');
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

    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(markup.match(/aria-checked="false"/g)).toHaveLength(1);
    expect(markup.indexOf('Druhy profil')).toBeLessThan(markup.indexOf('Hlavni'));
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

    expect(markup).toContain('0/1 zařazených');
    expect(markup).toContain('1× nedostupný');
    expect(markup).toContain('Nedostupný účet');
    expect(markup).toContain('Aktuální data účtu nejsou dostupná. Ověř připojení firmy v záložce Připojení.');
    expect(markup).not.toContain('Oprav skupinu přes Edit group.');
    expect(markup).toContain('Odebrat ze skupiny');
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

    expect(markup).toContain('0/1 zařazených');
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

    expect(markup).toContain('0/2 zařazených');
    expect(markup).toContain('1× DLL');
    expect(markup).toContain('1× BREACHED');
    expect(markup).toContain('DLL · do konce session');
    expect(markup).toContain('LIVE denní P&amp;L -1206.50 USD');
    expect(markup).toContain('BREACHED');
    expect(markup).toContain('LIVE equity dosáhla drawdown flooru');
  });
  it('hlavička i buňky skupiny jdou ve stejném pořadí a nic z nich nechybí', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, { snapshot }));
    const headers = ['Skupina', 'Stav', 'Leader', 'Firma', 'Followeři', 'Kapitál', 'Denní P&amp;L', 'Otevřený P&amp;L'];
    const positions = headers.map(label => markup.indexOf(`>${label}</th>`));
    expect(positions.every(index => index > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    // Řádek skupiny: šipka + název + 7 volitelných sloupců + akce.
    const groupRow = tableRows(markup).find(row => row.includes('Hlavni'));
    expect(groupRow).toBeDefined();
    expect(tableCells(groupRow!)).toHaveLength(10);
  });
  it('přepínač Účty/Příkazy stojí pod obsahem, ne nad hlavičkou tabulky', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, { snapshot }));
    const morph = markup.indexOf('live-detail-morph');
    const tab = markup.indexOf('live-detail-tab');
    expect(morph).toBeGreaterThan(-1);
    // Dřív „Účty" stály hned nad sloupcem „ÚČET"; teď jsou až za obsahem.
    expect(tab).toBeGreaterThan(morph);
    expect(markup.indexOf('>Účet</th>')).toBeLessThan(tab);
  });

  it('přepínač nese počty a chip se zařazenými followery už nezdvojuje řádek skupiny', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, { snapshot }));
    expect(markup).toContain('live-detail-tab');
    expect(markup).not.toContain('zařazení');
  });
});
