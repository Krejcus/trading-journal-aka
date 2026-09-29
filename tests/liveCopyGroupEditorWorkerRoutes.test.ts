import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LiveAccount } from '../services/tradecopiaLiveService';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import type { CopierWorkerAccountRoute } from '../lib/copierWorkerAccountRoutes';

vi.mock('react-dom', () => ({ createPortal: (children: React.ReactNode) => children }));
vi.mock('../utils/useCompactViewport', () => ({ useCompactViewport: () => false }));

const originalDocument = globalThis.document;
beforeAll(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: {} } });
});
afterAll(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
});

const account = (id: number, name: string): LiveAccount => ({
  id, name, firm: 'FundedNext', entityId: null, phase: 'Funded', accountSize: 50_000,
  balance: 50_000, equity: 50_000, realizedPnl: 0, weekRealizedPnl: 0, unrealizedPnl: 0,
  peakEquity: null, drawdownFloor: null, cushion: null, positions: [], updatedAt: null,
  mapRowId: null, mappedAccountId: null, mappedAccountName: null, mappingStatus: null,
});

const accounts = [
  account(1, 'Leader'),
  account(2, 'Vybraný follower'),
  account(3, 'FN mimo worker'),
  account(4, 'Neověřitelný účet'),
];
const group: CopyGroupConfig = {
  id: 'fn', name: 'FundedNext', enabled: false, leaderAccountId: 1,
  followers: [{ accountId: 2, mode: 'on-submit', multiplier: 1 }],
};
const props = {
  group, isNew: false, tightenOnly: false, accounts,
  accountLabel: (id: number) => accounts.find(item => item.id === id)?.name ?? `Účet ${id}`,
  saving: false, libraryState: 'ready' as const, libraryError: null,
  onClose: () => undefined,
  onSave: async () => true,
  onRemoveUnavailableFollowers: () => undefined,
};

describe('GroupEditorDialog worker routes', () => {
  it('označí a zakáže pouze nový účet chybějící v manifestu; unknown nechá volitelný', async () => {
    const { GroupEditorDialog } = await import('../components/LiveCopyTradeOverview');
    const markup = renderToStaticMarkup(React.createElement(GroupEditorDialog, {
      ...props,
      workerAccountRoutes: {
        known: true,
        routes: new Map<number, CopierWorkerAccountRoute>([[1, 'routable'], [2, 'routable'], [3, 'missing-worker'], [4, 'unknown']]),
      },
    }));

    expect(markup).toContain('FN mimo worker');
    expect(markup).toContain('Není ve Mac workeru');
    expect(markup).toContain('manifestu Mac workeru');
    const missingRow = markup.match(/<div[^>]*data-worker-route="missing-worker"[^>]*>[\s\S]*?<\/div>/)?.[0];
    expect(missingRow).toBeDefined();
    expect(missingRow).toMatch(/<input type="checkbox"[^>]*disabled/);
    const unknownRow = markup.match(/<div[^>]*data-worker-route="unknown"[^>]*>[\s\S]*?<\/div>/)?.[0];
    expect(unknownRow).toBeDefined();
    expect(unknownRow).toMatch(/<input type="checkbox"/);
    expect(unknownRow).not.toMatch(/<input type="checkbox"[^>]*disabled/);
    expect(markup).toContain('při uložení má worker poslední slovo');
  });

  it('při neznámém statusu účty neblokuje a jen varuje', async () => {
    const { GroupEditorDialog } = await import('../components/LiveCopyTradeOverview');
    const markup = renderToStaticMarkup(React.createElement(GroupEditorDialog, {
      ...props,
      workerAccountRoutes: { known: false, routes: new Map() },
    }));
    expect(markup).toContain('Stav připojení Mac workeru se teď nedá úplně ověřit');
    expect(markup).not.toContain('Není ve Mac workeru');
  });
});
