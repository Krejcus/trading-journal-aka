import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import LiveRiskSummaryCard from '../components/LiveRiskSummaryCard';
import LiveStatusStrip from '../components/LiveStatusStrip';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';
import type { CopierControllerStatus } from '../services/copierRuntimeController';

const NOW = Date.UTC(2026, 8, 8, 14, 0);
const group: CopyGroupConfig = {
  id: 'group-main', name: 'Hlavní', enabled: true, leaderAccountId: 10, color: '#4f6df5',
  followers: [{ accountId: 11, mode: 'on-fill', multiplier: 1 }],
  safety: { ...DEFAULT_COPY_GROUP_SAFETY, dailyLossLimitUsd: 1_000, dailyMaxLosingTrades: 2, dailyMaxTrades: 0 },
};
const status = {
  armed: true, connected: true, killSwitch: false, dayLockUntil: 0, shadowMode: false,
  accountEligibility: [{ accountId: 11, state: 'active', at: NOW }],
  dailyStats: { sessionEndAt: NOW + 3_600_000, realizedPnlUsd: -129, losingTrades: 1, tradesToday: 3, unpricedSymbols: [] },
} as unknown as CopierControllerStatus;

describe('LIVE hlavička na telefonu', () => {
  it('Risk je jeden klepnutelný řádek s limity a bez dlaždic', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveRiskSummaryCard, {
      group, status, runtimeAvailable: true, riskConfigSupported: true, dailyStats: status.dailyStats,
      dayLockUntil: 0, now: NOW, compact: true,
    }));
    expect(markup).toContain('data-live-risk-compact="true"');
    expect(markup).toContain('href="?page=live&amp;tab=risk"');
    expect(markup).toContain('Ztráta');
    expect(markup).toContain('129');
    expect(markup).toContain('1 / 2');
    expect(markup).toContain('vyp.');
    expect(markup).not.toContain('data-risk-summary-metric');
    expect(markup).not.toContain('Otevřít Risk');
  });

  it('desktop dál vykresluje čtyři dlaždice', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveRiskSummaryCard, {
      group, status, runtimeAvailable: true, riskConfigSupported: true, dailyStats: status.dailyStats, dayLockUntil: 0, now: NOW,
    }));
    expect(markup).toContain('data-risk-summary-metric="Denní ztráta"');
    expect(markup).toContain('Otevřít Risk');
  });

  it('stav workeru je jeden řádek s tečkami, na dashboardu v tichém režimu bez akce nic', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveStatusStrip, {
      status, available: true, pending: false, transport: 'relay',
    }));
    expect(markup).toContain('data-live-status-strip="true"');
    expect(markup).toContain('bg-emerald-500');
    expect(markup).toContain('Zapnutá');
    expect(markup).not.toContain('Broker stream');

    const quiet = renderToStaticMarkup(React.createElement(LiveStatusStrip, {
      status, available: true, pending: false, transport: 'relay', quiet: true,
    }));
    expect(quiet).toBe('');
  });
});
