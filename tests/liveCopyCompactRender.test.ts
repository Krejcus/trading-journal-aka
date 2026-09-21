import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LiveAccount, LiveOrder, LiveSnapshot } from '../services/tradecopiaLiveService';
import { DEFAULT_COPY_GROUP_SAFETY } from '../services/liveCopyTrading';

// Telefon: hook hlásí úzký viewport, takže LIVE vykreslí karty místo tabulky.
vi.mock('../utils/useCompactViewport', () => ({ useCompactViewport: () => true }));

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
    { ...liveAccount(leaderId, 'Leader DEMO'), realizedPnl: -150, unrealizedPnl: 40 },
    { ...liveAccount(followerId, 'Follower DEMO'), realizedPnl: -75 },
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
  totalRealizedPnl: -225,
  totalUnrealizedPnl: 40,
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

describe('LIVE kompaktní karty (telefon)', () => {
  it('nahradí 900px tabulku kartami se stejnými daty a akcemi', async () => {
    const { LiveCopyTradeOverview } = await import('../components/LiveCopyTradeOverview');
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot,
      orders: [workingLeaderLimit],
    }));

    expect(markup).toContain('data-testid="compact-group-list"');
    expect(markup).toContain('data-testid="compact-group-card"');
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('Diagnostika dat a API');

    // Hlavička skupiny + přepínač copieru.
    expect(markup).toContain('Hlavni');
    // Plný počet způsobilých je ticho; chip se ukáže až při výpadku (19. 9.).
    expect(markup).not.toContain('aktivních');
    // Firma skupiny, ne jen leaderova. V úzké buňce souhrnu je jen kolečko,
    // takže název nese `title` — jinak by u firmy bez loga (monogram) nešlo
    // zjistit, o koho jde.
    expect(markup).toContain('title="Tradeify"');
    expect(markup).toContain('role="switch"');

    // Souhrn skupiny. Na 375 px je bez haléřů — „-$225.00“ se do buňky
    // nevešlo a ořízlo se; zaokrouhlení je čitelnější než oříznuté číslo.
    expect(markup).toContain('Kapitál');
    expect(markup).toContain('$100,000');
    expect(markup).toContain('-$225');
    expect(markup).not.toContain('-$225.00');
    // Firmy se přesunuly z hlavičky do souhrnu, aby se na řádek vešel
    // název skupiny, Flatten All i vypínač najednou.
    expect(markup).toContain('Firmy');
    expect(markup).toContain('>Flatten All<');

    // Dvě sekce místo jedné tabulky. Rozlišuje je popisek pravého sloupce:
    // účty v trhu mají „Otevřený“, zbytek „Dnes“.
    expect(markup).toContain('>Otevřený</span>');
    expect(markup).toContain('>Dnes</span>');
    expect(markup).not.toContain('V trhu');
    // Haléře u jednotlivých účtů zůstávají.
    expect(markup).toContain('$40.00');
    expect(markup).toContain('-$75.00');

    // Účty s leaderem a followerem.
    expect(markup).toContain('Leader DEMO');
    expect(markup).toContain('Follower DEMO');
    expect(markup).toContain('title="Leader účet"');
    expect(markup).toContain('×1');

    // Příkazy a akce se zachovaným dotykovým cílem.
    expect(markup).toContain('Příkazy · 1 working');
    expect(markup).toContain('MNQU6');
    expect(markup).toContain('Zrušit');
    expect(markup).toContain('Flatten All');
    expect(markup).toContain('More actions');
  });

  it('v obchodu ustoupí Kapitál otevřenému P&L, mimo obchod zůstane', async () => {
    const { LiveCopyTradeOverview } = await import('../components/LiveCopyTradeOverview');
    const withPosition: LiveSnapshot = {
      ...snapshot,
      accounts: snapshot.accounts.map((account, index) => index === 0 ? {
        ...account,
        positions: [{
          accountId: leaderId, symbol: 'MNQU6', netPosition: 2, netPrice: 23_000,
          realizedPnl: 0, unrealizedPnl: 40, updatedAt: '2026-08-25T08:00:00.000Z',
        }],
      } : account),
    };
    const inTrade = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, { snapshot: withPosition, orders: [] }));
    // Kapitál se v obchodu nehýbe a na 375 px bere šířku otevřenému P&L.
    expect(inTrade).not.toContain('Kapitál');
    expect(inTrade).toContain('Otevřený');
    expect(inTrade).toContain('Firmy');
    expect(inTrade).toContain('Denní P&amp;L');

    // Čekající vstup ještě obchod není — kapitál zůstává.
    const pendingOnly = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, { snapshot, orders: [workingLeaderLimit] }));
    expect(pendingOnly).toContain('Kapitál');
  });

  it('dlouhý seznam se sbalí, ale účty v trhu zůstanou vidět', async () => {
    const { LiveCopyTradeOverview } = await import('../components/LiveCopyTradeOverview');
    const many: LiveSnapshot = {
      ...snapshot,
      accounts: [
        ...snapshot.accounts,
        ...Array.from({ length: 10 }, (_, index) => liveAccount(70_000 + index, `Follower ${index}`)),
      ],
      groups: snapshot.groups,
    };
    const group = {
      ...snapshot.groups[0],
      followers: [
        ...snapshot.groups[0].followers,
        ...Array.from({ length: 10 }, (_, index) => ({
          accountId: 70_000 + index, accountName: `Follower ${index}`,
          scale: 1, replicate: true, synced: true, mismatches: [],
        })),
      ],
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: { ...many, groups: [group] },
      orders: [],
    }));
    // 12 účtů bez pozice, ukáže se prvních 6.
    expect(markup).toContain('Zobrazit dalších 6');
    expect(markup).toContain('Follower 0');
    // Zbytek zůstává v DOMu kvůli animaci výšky, ale sbalený obal je `inert`,
    // takže se na něj nedá dostat tabem ani čtečkou.
    expect(markup).toContain('Follower 9');
    expect(markup).toContain('class="live-accounts-more" data-open="false"');
    expect(markup).toContain('<div inert=""><ul');
    // Leader je první a nikdy nespadne pod ořez.
    expect(markup).toContain('Leader DEMO');
  });

  it('karta dne počítá jen účty ze skupin, ne demo účty z OAuth snapshotu', async () => {
    const { LiveCopyTradeOverview } = await import('../components/LiveCopyTradeOverview');
    // Demo účet, který chodí s Tradovate přihlášením a v žádné skupině není.
    const withDemo: LiveSnapshot = {
      ...snapshot,
      accounts: [...snapshot.accounts, { ...liveAccount(66_424_940, 'PTLOP1748077962'), realizedPnl: 900 }],
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, { snapshot: withDemo, orders: [] }));
    // Skupina má dva účty; demo do součtu ani do soupisu nepatří.
    expect(markup).not.toContain('PTLOP1748077962');
    expect(markup).toContain('−$225');
    expect(markup).not.toContain('+$675');
  });

  it('desktop bez úzkého viewportu dál vykresluje tabulku', async () => {
    vi.doMock('../utils/useCompactViewport', () => ({ useCompactViewport: () => false }));
    vi.resetModules();
    const { LiveCopyTradeOverview } = await import('../components/LiveCopyTradeOverview');
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, { snapshot, orders: [] }));
    expect(markup).toContain('<table');
    expect(markup).not.toContain('data-testid="compact-group-list"');
    expect(markup).toContain('Diagnostika dat a API');
  });
});

describe('Pravidla dne na telefonu', () => {
  it('bez okna (SSR) zůstává karta rozbalená a nese data-collapsed pro mobilní výchozí sbalení', async () => {
    const { LiveDayRulesCard } = await import('../components/LiveDayRulesCard');
    const markup = renderToStaticMarkup(React.createElement(LiveDayRulesCard, { groupName: 'Hlavní', safety: DEFAULT_COPY_GROUP_SAFETY, riskConfigSupported: true }));
    expect(markup).toContain('data-collapsed="false"');
    expect(markup).toContain('aria-label="Sbalit pravidla dne"');
  });
});
