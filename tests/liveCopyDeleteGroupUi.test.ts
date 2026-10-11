// 11. 10. 2026: po smazání skupiny workeru UI skupinu znovu neadoptuje a
// řekne, že kopírka žádnou skupinu nemá.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LiveAccount, LiveSnapshot } from '../services/tradecopiaLiveService';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { copierWorkerExecutionGroup } from '../lib/copierWorkerCapabilities';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';

vi.mock('../utils/useCompactViewport', () => ({ useCompactViewport: () => true }));

const liveAccount = (id: number, name: string): LiveAccount => ({
  id, entityId: null, name, firm: 'Lucid', phase: 'Funded', accountSize: 50_000,
  balance: 50_000, equity: 50_000, realizedPnl: 0, weekRealizedPnl: 0, unrealizedPnl: 0,
  peakEquity: null, drawdownFloor: null, cushion: null, positions: [],
  updatedAt: '2026-10-11T08:00:00.000Z', mapRowId: null, mappedAccountId: null,
  mappedAccountName: null, mappingStatus: null,
});

const snapshot: LiveSnapshot = {
  run: null,
  accounts: [liveAccount(400, 'Nový leader'), liveAccount(500, 'Nový follower')],
  appAccounts: [],
  connections: [],
  groups: [],
  alerts: [],
  totalBalance: 100_000, totalEquity: 100_000, totalRealizedPnl: 0, totalUnrealizedPnl: 0, worstCushion: null,
};

const retiredGroup: CopyGroupConfig = {
  id: 'dvsvds', name: 'dvsvds', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};

describe('kopírka bez skupiny', () => {
  it('smazaná skupina workeru není execution skupina', () => {
    const status = { group: retiredGroup, controller: { retiredGroup: { groupId: 'dvsvds', at: 1 } } } as unknown as LocalCopierAgentStatus;
    expect(copierWorkerExecutionGroup(status)).toBeNull();
    const live = { group: retiredGroup, controller: { retiredGroup: null } } as unknown as LocalCopierAgentStatus;
    expect(copierWorkerExecutionGroup(live)?.id).toBe('dvsvds');
    // Značka jiné (dřívější) skupiny novou skupinu neschová.
    const stale = { group: retiredGroup, controller: { retiredGroup: { groupId: 'jina', at: 1 } } } as unknown as LocalCopierAgentStatus;
    expect(copierWorkerExecutionGroup(stale)?.id).toBe('dvsvds');
    expect(copierWorkerExecutionGroup(null)).toBeNull();
  });

  it('přehled ukáže, že kopírka nemá skupinu, a smazanou skupinu nevrátí do seznamu', async () => {
    const { LiveCopyTradeOverview } = await import('../components/LiveCopyTradeOverview');
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot, orders: [], runtimeAvailable: true, executionGroupId: null, runtimeGroup: null,
      workerWithoutGroup: true, groupDeleteSupported: true, copierArmed: false,
    } as never));
    expect(markup).toContain('data-testid="copier-no-group"');
    expect(markup).toContain('Kopírka nemá žádnou skupinu');
    expect(markup).not.toContain('dvsvds');
    // Kontrast: předaná runtime skupina by se do seznamu adoptovala — proto
    // LIVE posílá u smazané skupiny `runtimeGroup: null`.
    const adopted = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot, orders: [], runtimeAvailable: true, executionGroupId: null, runtimeGroup: retiredGroup, copierArmed: false,
    } as never));
    expect(adopted).toContain('dvsvds');
  });

  it('se skupinou workeru se hláška neukáže', async () => {
    const { LiveCopyTradeOverview } = await import('../components/LiveCopyTradeOverview');
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot, orders: [], runtimeAvailable: true, executionGroupId: null, copierArmed: false,
    } as never));
    expect(markup).not.toContain('copier-no-group');
  });
});
