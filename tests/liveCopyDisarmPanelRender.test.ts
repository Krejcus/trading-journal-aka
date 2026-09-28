import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CopierDisarmPanel,
  LiveCopyTradeOverview,
} from '../components/LiveCopyTradeOverview';
import { createCopierDisarmRecord } from '../lib/copierDisarmReason';
import type { CopierControllerStatus } from '../services/copierRuntimeController';
import type { LiveSnapshot } from '../services/tradecopiaLiveService';

const at = Date.UTC(2026, 8, 3, 16, 7, 3);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at + 1000); });
afterEach(() => vi.useRealTimers());
const disarm = createCopierDisarmRecord({
  at,
  trigger: 'fail-closed',
  detail: 'Copier fail-closed: follower 200 má autoritativně pozici -2 na MNQU6, očekáváno -3 podle leadera -3 × 1',
  copiesOutcome: 'unknown',
});

const runtimeGroup = {
  id: 'group-main',
  name: 'Hlavní',
  enabled: true,
  leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit' as const, multiplier: 1 }],
};

const snapshot: LiveSnapshot = {
  run: null,
  accounts: [],
  appAccounts: [],
  connections: [],
  groups: [{
    id: 'group-main',
    name: 'Hlavní',
    leaderAccountId: 100,
    leaderName: 'Leader',
    followers: [{
      accountId: 200,
      accountName: 'Follower',
      scale: 1,
      replicate: true,
      synced: false,
      mismatches: [],
    }],
    syncedCount: 0,
    warningCount: 1,
  }],
  alerts: [],
  totalBalance: 0,
  totalEquity: 0,
  totalRealizedPnl: 0,
  totalUnrealizedPnl: 0,
  worstCushion: null,
};

describe('CopierDisarmPanel', () => {
  it('12 hodin starý incident nezobrazuje v dashboardu ani při unknown výsledku', () => {
    vi.setSystemTime(at + 12 * 60 * 60_000);
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot, runtimeGroup, executionGroupId: runtimeGroup.id, lastDisarm: disarm,
      copierArmed: false,
    }));
    expect(markup).not.toContain('data-copier-disarm-panel');
    expect(disarm.copiesOutcome).toBe('unknown');
  });
  it('unknown výsledek je rose: shrnutí, výsledek a další krok; detail jen v tooltipu, historie v Událostech', () => {
    const markup = renderToStaticMarkup(React.createElement(CopierDisarmPanel, { lastDisarm: disarm }));

    expect(markup).toContain('data-tone="rose"');
    expect(markup).toContain('Poslední zaznamenané vypnutí');
    expect(markup).toContain(new Date(at).toLocaleDateString('cs-CZ'));
    expect(markup).toContain('Historický záznam — neověřuje aktuální stav pozic.');
    expect(markup).toContain('Pozice followera nesouhlasí');
    expect(markup).toContain('Výsledek kopií se nepodařilo potvrdit.');
    expect(markup).toContain('Další krok:');
    expect(markup).toContain('title="Copier fail-closed: follower 200');
    expect(markup).not.toContain('Technický detail');
    expect(markup).not.toContain('Historie odzbrojení');
  });

  it('potvrzené zavření guardem je amber', () => {
    const guarded = { ...disarm, copiesOutcome: 'guard-flattened' as const };
    const markup = renderToStaticMarkup(React.createElement(CopierDisarmPanel, { lastDisarm: guarded }));

    expect(markup).toContain('data-tone="amber"');
    expect(markup).toContain('Kopie byly guardem potvrzeně zavřené.');
    expect(markup).not.toContain('data-tone="rose"');
  });

  it('starý unknown panel vezme známou příčinu z lastError, ale výsledek kopií nechá nepotvrzený', () => {
    const legacyUnknown = createCopierDisarmRecord({
      at,
      trigger: 'fail-closed',
      detail: 'legacy-unknown',
      copiesOutcome: 'unknown',
    });
    const runtimeStatus: CopierControllerStatus = {
      started: true, armed: false, killSwitch: false, shadowMode: false, connected: true,
      reconciliationRequired: true, divergentAccounts: [], workingOrderAccounts: [],
      stuckOutbox: false, stuckOperations: [], revision: 1, lastSequence: 1,
      lastError: 'Copier fail-closed: unexplained-position-divergence účty 200',
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot, runtimeGroup, executionGroupId: runtimeGroup.id,
      lastDisarm: legacyUnknown, runtimeStatus, copierArmed: false,
    }));
    expect(markup).toContain('Pozice followerů se odchýlily od očekávané kopie.');
    expect(markup).not.toContain('neznámého technického důvodu');
    expect(markup).toContain('Výsledek kopií se nepodařilo potvrdit.');
  });

  it('karta skupiny panel po automatickém DISARM ukáže vedle dostupného ARM, po ARM ho skryje', () => {
    const props = {
      snapshot,
      runtimeGroup,
      executionGroupId: runtimeGroup.id,
      lastDisarm: disarm,
      onSwitchAndArm: () => undefined,
      runtimeAvailable: true,
    };
    const disarmed = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      ...props,
      copierArmed: false,
    }));
    expect(disarmed).toContain('data-copier-disarm-panel="true"');
    expect(disarmed).toContain('aria-label="Zapnout kopírovací skupinu"');

    const armed = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      ...props,
      copierArmed: true,
    }));
    expect(armed).not.toContain('data-copier-disarm-panel="true"');
    expect(armed).toContain('aria-label="Vypnout kopírovací skupinu"');
  });

  it('ruční vypnutí žádný panel nemá — kopírka je čistě vypnutá', () => {
    const manual = createCopierDisarmRecord({
      at,
      trigger: 'manual',
      detail: 'Uživatel vypnul kopírku ručně',
      copiesOutcome: 'flat',
    });
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot,
      runtimeGroup,
      executionGroupId: runtimeGroup.id,
      lastDisarm: manual,
      copierArmed: false,
      onSwitchAndArm: () => undefined,
      runtimeAvailable: true,
    }));
    expect(markup).not.toContain('data-copier-disarm-panel="true"');
    expect(markup).toContain('aria-label="Zapnout kopírovací skupinu"');
  });
});
