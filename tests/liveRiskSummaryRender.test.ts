import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import LiveRiskSummaryCard from '../components/LiveRiskSummaryCard';
import {
  DEFAULT_COPY_GROUP_SAFETY,
  type CopyGroupConfig,
} from '../services/liveCopyTrading';
import type { CopierAccountRiskSnapshot } from '../services/copierRuntimeController';
import type { LiveAccount } from '../services/tradecopiaLiveService';

const NOW = Date.UTC(2026, 8, 5, 14, 0);

const account = (id: number, name: string, realizedPnl: number): LiveAccount => ({
  id,
  entityId: null,
  name,
  firm: 'Tradeify',
  phase: 'funded',
  accountSize: 50_000,
  balance: 50_000,
  equity: 50_000,
  realizedPnl,
  weekRealizedPnl: realizedPnl,
  unrealizedPnl: 0,
  peakEquity: null,
  drawdownFloor: null,
  cushion: null,
  positions: [],
  updatedAt: new Date(NOW).toISOString(),
  mapRowId: null,
  mappedAccountId: null,
  mappedAccountName: null,
  mappingStatus: null,
});

const risk = (
  accountId: number,
  realizedPnlUsd: number | null,
  patch: Partial<CopierAccountRiskSnapshot> = {},
): CopierAccountRiskSnapshot => ({
  accountId,
  verifiedAt: NOW - 1_000,
  realizedPnlUsd,
  netLiq: 50_000,
  minNetLiq: 49_000,
  dailyLossAutoLiq: 1_000,
  trailingMaxDrawdown: null,
  propLimitUsd: 1_000,
  ...patch,
});

const group: CopyGroupConfig = {
  id: 'risk-main',
  name: 'Hlavní skupina',
  enabled: true,
  leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1, dailyLossCutUsd: 1_000 },
    { accountId: 300, mode: 'on-submit', multiplier: 1, dailyLossCutUsd: 1_000 },
    { accountId: 400, mode: 'off', multiplier: 1, dailyLossCutUsd: 500 },
  ],
  safety: {
    ...DEFAULT_COPY_GROUP_SAFETY,
    dailyLossLimitUsd: 1_000,
    dailyMaxLosingTrades: 2,
    dailyMaxTrades: 10,
  },
};

describe('LiveRiskSummaryCard', () => {
  it('shrne konfiguraci, aktivní pauzu, účty a všechny čtyři mini-lišty', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveRiskSummaryCard, {
      group: {
        ...group,
        // Worker může cut followera držet v runtime mode=off; v souhrnu má
        // přesto zůstat ve jmenovateli do konce session.
        followers: group.followers.map(follower => follower.accountId === 200
          ? { ...follower, mode: 'off' as const }
          : follower),
      },
      dailyStats: {
        sessionEndAt: NOW + 8 * 60 * 60_000,
        realizedPnlUsd: -620,
        losingTrades: 1,
        tradesToday: 4,
        unpricedSymbols: [],
      },
      pause: { until: NOW + 20 * 60_000, rule: 'daily-loss', at: NOW - 1_000 },
      followerCuts: [{
        accountId: 200,
        at: NOW - 60_000,
        until: NOW + 8 * 60 * 60_000,
        realizedPnlUsd: -1_010,
        cutUsd: 1_000,
        source: 'broker',
        closed: NOW - 50_000,
      }],
      accounts: [
        account(100, 'Leader', -620),
        account(200, 'Vyřazený follower', -1_010),
        account(300, 'Nejblíž limitu', 999),
        account(400, 'Vypnutý follower', -490),
      ],
      brokerDailyPnlByAccount: { 100: -620, 200: -1_010, 300: -850, 400: -490 },
      now: NOW,
      onOpenRisk: () => undefined,
    }));

    expect(markup).toContain('data-live-risk-summary="true"');
    expect(markup).toContain('3 zámky');
    expect(markup).toContain('Pauza');
    expect(markup).toContain('1/2 účtů kopíruje');
    expect(markup).toContain('Denní ztráta');
    expect(markup).toContain('Ztrátové obchody');
    expect(markup).toContain('>Obchody<');
    expect(markup).toContain('Účet nejblíž limitu');
    expect(markup).toContain('Nejblíž limitu');
    expect(markup).not.toContain('Vyřazený follower</b>');
    expect(markup.match(/role="progressbar"/g)).toHaveLength(4);
    expect(markup).toContain('href="?page=live&amp;tab=risk"');
    expect(markup).toContain('Otevřít Risk');
  });

  it('neznámý worker a broker stav nevydává za nulu', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveRiskSummaryCard, {
      group: null,
      brokerDailyPnlPending: true,
      now: NOW,
    }));

    expect(markup).toContain('— zámků');
    expect(markup).toContain('—/— účtů kopíruje');
    expect(markup.match(/data-metric-known="false"/g)).toHaveLength(4);
    expect(markup).not.toContain('aria-valuenow="0"');
    expect(markup).toContain('Denní P&amp;L se načítá');
    expect(markup).toContain('href="?page=live&amp;tab=risk"');
  });

  it('skupinu bez potvrzené safety konfigurace nevydává za defaultní pravidla', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveRiskSummaryCard, {
      group: { ...group, safety: undefined },
      dailyStats: {
        sessionEndAt: NOW + 8 * 60 * 60_000,
        realizedPnlUsd: -620,
        losingTrades: 1,
        tradesToday: 4,
        unpricedSymbols: [],
      },
      now: NOW,
    }));

    expect(markup).toContain('— zámků');
    expect(markup).not.toContain('3 zámky');
    expect(markup.match(/data-metric-known="false"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(markup).not.toContain('62 % limitu leadera');
  });

  it('bez callbacku ponechá odkaz jako běžnou navigaci', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveRiskSummaryCard, {
      group,
      now: NOW,
    }));

    expect(markup).toContain('href="?page=live&amp;tab=risk"');
    expect(markup).toContain('Otevřít Risk');
  });

  it('při částečném broker P&L neurčí nejbližší účet z neúplné množiny', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveRiskSummaryCard, {
      group,
      accounts: [
        account(200, 'Známý follower', -900),
        account(300, 'Chybějící follower', -990),
      ],
      brokerDailyPnlByAccount: { 200: -900, 300: null },
      now: NOW,
    }));
    const metricTag = markup.match(/<div[^>]*data-risk-summary-metric="Účet nejblíž limitu"[^>]*>/)?.[0] ?? '';

    expect(metricTag).toContain('data-metric-known="false"');
    expect(markup).toContain('Denní P&amp;L všech účtů není ověřené');
    expect(markup).not.toContain('Známý follower</b>');
    expect(markup).not.toContain('Chybějící follower</b>');
  });

  it('preferuje novější worker P&L před starší broker mapou', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveRiskSummaryCard, {
      group,
      accounts: [
        account(200, 'Worker nejblíž', -950),
        account(300, 'Broker by vyhrál', -900),
      ],
      accountRisk: [risk(200, -950), risk(300, -200)],
      brokerDailyPnlByAccount: { 200: -50, 300: -900 },
      // Načítání PWA broker read-modelu nesmí zneplatnit čerstvý worker snapshot.
      brokerDailyPnlPending: true,
      now: NOW,
    }));

    expect(markup).toContain('data-risk-summary-metric="Účet nejblíž limitu"');
    expect(markup).toContain('Worker nejblíž</b>');
    expect(markup).toContain('95 % ·');
    expect(markup).not.toContain('Broker by vyhrál</b>');
  });

  it('stale nebo chybějící worker P&L nepřekryje starší broker hodnotou', () => {
    const singleFollowerGroup: CopyGroupConfig = {
      ...group,
      followers: [group.followers[0]],
    };
    const stale = renderToStaticMarkup(React.createElement(LiveRiskSummaryCard, {
      group: singleFollowerGroup,
      accounts: [account(200, 'Stale worker', -950)],
      accountRisk: [risk(200, -950, { verifiedAt: NOW - 90_000 })],
      brokerDailyPnlByAccount: { 200: -950 },
      now: NOW,
    }));
    const missing = renderToStaticMarkup(React.createElement(LiveRiskSummaryCard, {
      group: singleFollowerGroup,
      accounts: [account(200, 'Chybějící worker hodnota', -950)],
      accountRisk: [risk(200, null)],
      brokerDailyPnlByAccount: { 200: -950 },
      now: NOW,
    }));

    for (const markup of [stale, missing]) {
      const metricTag = markup.match(/<div[^>]*data-risk-summary-metric="Účet nejblíž limitu"[^>]*>/)?.[0] ?? '';
      expect(metricTag).toContain('data-metric-known="false"');
      expect(markup).toContain('Denní P&amp;L všech účtů není ověřené');
      expect(markup).not.toContain('95 % ·');
    }
  });
});
