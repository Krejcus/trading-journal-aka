import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CopierDisarmPanel,
  LiveCopyTradeOverview,
} from '../components/LiveCopyTradeOverview';
import { createCopierDisarmRecord } from '../lib/copierDisarmReason';
import type { LiveSnapshot } from '../services/tradecopiaLiveService';

const at = Date.UTC(2026, 8, 3, 16, 7, 3);
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
  it('unknown výsledek je rose a zachová shrnutí, další krok, detail i historii dne', () => {
    const older = createCopierDisarmRecord({
      at: at - 60_000,
      trigger: 'manual',
      detail: 'Uživatel vypnul kopírku ručně',
      copiesOutcome: 'flat',
    });
    const markup = renderToStaticMarkup(React.createElement(CopierDisarmPanel, {
      lastDisarm: disarm,
      history: [older, disarm],
    }));

    expect(markup).toContain('data-tone="rose"');
    expect(markup).toContain('Kopírka se vypnula');
    expect(markup).toContain('Pozice followera nesouhlasí');
    expect(markup).toContain('Výsledek kopií se nepodařilo potvrdit.');
    expect(markup).toContain('Další krok:');
    expect(markup).toContain('Technický detail');
    expect(markup).toContain('očekáváno -3 podle leadera -3 × 1');
    expect(markup).toContain('Historie odzbrojení dne (2)');
  });

  it('potvrzené zavření guardem je amber', () => {
    const guarded = { ...disarm, copiesOutcome: 'guard-flattened' as const };
    const markup = renderToStaticMarkup(React.createElement(CopierDisarmPanel, {
      lastDisarm: guarded,
      history: [guarded],
    }));

    expect(markup).toContain('data-tone="amber"');
    expect(markup).toContain('Kopie byly guardem potvrzeně zavřené.');
    expect(markup).not.toContain('data-tone="rose"');
  });

  it('karta skupiny panel po DISARM ukáže vedle dostupného ARM, po ARM ho skryje', () => {
    const props = {
      snapshot,
      runtimeGroup,
      executionGroupId: runtimeGroup.id,
      lastDisarm: disarm,
      disarmHistory: [disarm],
      onSwitchAndArm: () => undefined,
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
});
