import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  accountRiskLimitDraftsFromGroup,
  LiveAccountRiskTable,
  submitAccountRiskLimits,
  validateAccountRiskLimits,
} from '../components/LiveAccountRiskTable';
import LiveRiskTab from '../components/LiveRiskTab';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import type {
  CopierAccountRiskSnapshot,
  CopierControllerStatus,
  CopierFollowerCut,
} from '../services/copierRuntimeController';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';
import type { LiveAccount, LiveSnapshot } from '../services/tradecopiaLiveService';

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

const profile = (accountId: number, patch: Partial<TradovateAccountProfile> = {}): TradovateAccountProfile => ({
  id: `profile-${accountId}`,
  provider: 'tradovate',
  environment: 'demo',
  externalAccountId: String(accountId),
  accountName: `Profile account ${accountId}`,
  displayName: null,
  propFirm: 'Tradeify',
  planName: 'Growth 50K',
  accountType: 'funded',
  accountSize: 50_000,
  drawdownType: 'eod_trailing',
  maxLoss: 2_000,
  dailyLossLimit: null,
  consistencyPct: null,
  profitTarget: null,
  maxMini: null,
  maxMicro: null,
  mappedAccountId: null,
  onboardedAt: '2026-09-01T08:00:00.000Z',
  status: 'active',
  lastSeenAt: '2026-09-05T13:59:00.000Z',
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-05T13:59:00.000Z',
  ...patch,
});

const group: CopyGroupConfig = {
  id: 'risk-main',
  name: 'Hlavní',
  enabled: true,
  leaderAccountId: 1,
  followers: [
    { accountId: 2, mode: 'on-submit', multiplier: 1, dailyLossCutUsd: 500, maxContracts: 2 },
    { accountId: 3, mode: 'on-submit', multiplier: 1, dailyLossCutUsd: 100, maxContracts: 1, onCut: 'let-run' },
    { accountId: 4, mode: 'on-submit', multiplier: 1, dailyLossCutUsd: 100, maxContracts: 1, onCut: 'close-copy' },
    { accountId: 5, mode: 'on-submit', multiplier: 1 },
    { accountId: 6, mode: 'on-submit', multiplier: 1 },
  ],
  safety: {
    ...DEFAULT_COPY_GROUP_SAFETY,
    dailyMaxLosingTrades: 2,
    dailyLossLimitUsd: 1_000,
    dailyMaxTrades: 10,
  },
};

const accounts = [
  account(1, 'Snapshot leader', -10),
  account(2, 'Snapshot normal', -20),
  account(3, 'Snapshot near', -80),
  account(4, 'Snapshot cut', -120),
];

const profiles = [
  profile(1, { displayName: 'Profil Leader' }),
  profile(5, { accountName: 'Jen profil', displayName: null, propFirm: 'Lucid', planName: 'LucidFlex' }),
];

const risk = (accountId: number, patch: Partial<CopierAccountRiskSnapshot> = {}): CopierAccountRiskSnapshot => ({
  accountId,
  verifiedAt: NOW - 10_000,
  realizedPnlUsd: null,
  netLiq: 50_000,
  minNetLiq: 49_000,
  dailyLossAutoLiq: 1_000,
  trailingMaxDrawdown: null,
  propLimitUsd: 1_000,
  ...patch,
});

const accountRisk = [
  risk(1, { realizedPnlUsd: -10 }),
  risk(2, { realizedPnlUsd: -20 }),
  risk(3, { realizedPnlUsd: -80 }),
  risk(4, { verifiedAt: NOW - 90_000, realizedPnlUsd: -120, error: 'Risk feed timeout' }),
];

const followerCuts: CopierFollowerCut[] = [{
  accountId: 4,
  at: NOW - 60_000,
  until: NOW + 6 * 60 * 60_000,
  realizedPnlUsd: -120,
  cutUsd: 100,
  source: 'broker',
  closed: NOW - 30_000,
}];

const render = (patch: Partial<Parameters<typeof LiveAccountRiskTable>[0]> = {}) => renderToStaticMarkup(
  React.createElement(LiveAccountRiskTable, {
    group,
    accounts,
    accountProfiles: profiles,
    accountRisk,
    followerCuts,
    brokerDailyPnlByAccount: { 1: -10, 2: -20, 3: -80, 4: -120, 5: 0, 6: 0 },
    now: NOW,
    onSave: () => undefined,
    ...patch,
  }),
);

const snapshot: LiveSnapshot = {
  run: null,
  accounts,
  appAccounts: [],
  connections: [],
  groups: [],
  alerts: [],
  totalBalance: 200_000,
  totalEquity: 200_000,
  totalRealizedPnl: -230,
  totalUnrealizedPnl: 0,
  worstCushion: null,
};

const controller = (patch: Partial<CopierControllerStatus> = {}): CopierControllerStatus => ({
  started: true,
  armed: true,
  killSwitch: false,
  shadowMode: false,
  connected: true,
  reconciliationRequired: false,
  divergentAccounts: [],
  workingOrderAccounts: [],
  stuckOutbox: false,
  stuckOperations: [],
  lastError: null,
  revision: 1,
  lastSequence: 1,
  ...patch,
});

const row = (markup: string, accountId: number): string => (
  markup.match(new RegExp(`<tr[^>]*data-account-id="${accountId}"[^>]*>[\\s\\S]*?<\\/tr>`))?.[0] ?? ''
);

describe('LIVE Risk — Účty a propky', () => {
  it('vykreslí přesně osm sloupců, identity fallback a všechny požadované stavy', () => {
    const markup = render();
    const headers = markup.match(/<th\b[^>]*>/g) ?? [];

    expect(headers).toHaveLength(8);
    for (const label of [
      'Účet',
      'Propka',
      'Limit propky',
      'Vypnout při',
      'Max kontr.',
      'Dnes vč. poplatků',
      'Při dosažení',
      'Stav',
    ]) expect(markup).toContain(label);

    expect(row(markup, 1)).toContain('Profil Leader');
    expect(row(markup, 1)).toContain('Obchoduje pro leadera');
    expect(row(markup, 1)).not.toContain('<input');
    expect(row(markup, 1)).not.toContain('<select');
    expect(row(markup, 2)).toContain('Snapshot normal');
    expect(row(markup, 2)).toContain('data-account-risk-state="copying"');
    expect(row(markup, 2)).toContain('>Kopíruje<');
    expect(row(markup, 3)).toContain('data-account-risk-state="near"');
    expect(row(markup, 3)).toContain('Kopíruje · blízko limitu');
    expect(row(markup, 4)).toContain('data-account-risk-state="cut"');
    expect(row(markup, 4)).toContain('Vyřazen do konce session');
    expect(row(markup, 4)).toContain('kopie zavřena');
    expect(row(markup, 5)).toContain('Jen profil');
    expect(row(markup, 5)).toContain('Lucid');
    expect(row(markup, 6)).toContain('Účet 6');
    expect(markup).toContain('data-follower-cut-banner="true"');
    expect(markup).toContain('1 účet je vyřazen do konce session');
  });

  it('ukáže čerstvý limit se štítem, stale/unknown jako neověřeno a zachová broker chybu', () => {
    const markup = render();

    expect(row(markup, 2)).toContain('Ověřeno workerem před méně než 90 s');
    expect(row(markup, 4)).toContain('neověřeno');
    expect(row(markup, 4)).toContain('Risk feed timeout');
    expect(row(markup, 5)).toContain('neověřeno');
  });

  it('tighten-only ponechá zpřísnění editovatelné, ale omezí slabší hodnoty a volby', () => {
    const markup = render({ sessionArmedAt: NOW - 60_000 });
    const normal = row(markup, 2);
    const noExistingLimit = row(markup, 5);

    expect(markup).toContain('title="dnes jen zpřísnit"');
    expect(markup).toContain('jen zpřísnit');
    expect(normal).toContain('aria-label="Vypnout při pro účet 2"');
    expect(normal).toContain('max="500"');
    expect(normal).toContain('aria-label="Max kontraktů pro účet 2"');
    expect(normal).toContain('max="2"');
    expect(normal).toContain('<option value="let-run" disabled="">Nechat dojet</option>');
    expect(normal).not.toContain('aria-label="Vypnout při pro účet 2" type="number" min="0.01" max="500" step="0.01" placeholder="vypnuto" value="500" disabled=""');
    expect(noExistingLimit).toContain('aria-label="Vypnout při pro účet 5"');
  });

  it('fail-closed odmítne více než dvě desetinná místa i překročení 95 % prop limitu', () => {
    const drafts = accountRiskLimitDraftsFromGroup(group);
    const tooPrecise = validateAccountRiskLimits({
      group,
      drafts: {
        ...drafts,
        2: { ...drafts[2], dailyLossCutUsd: '100.001' },
      },
      accountRisk,
      now: NOW,
    });
    const abovePropLimit = validateAccountRiskLimits({
      group,
      drafts: {
        ...drafts,
        2: { ...drafts[2], dailyLossCutUsd: '950.01' },
      },
      accountRisk,
      now: NOW,
    });
    const aboveKnownStalePropLimit = validateAccountRiskLimits({
      group,
      drafts: {
        ...drafts,
        4: { ...drafts[4], dailyLossCutUsd: '950.01' },
      },
      accountRisk,
      now: NOW,
    });

    expect(tooPrecise.followers).toBeNull();
    expect(tooPrecise.errors.join(' ')).toContain('nejvýše se dvěma desetinnými místy');
    expect(abovePropLimit.followers).toBeNull();
    expect(abovePropLimit.errors.join(' ')).toContain('nejvýše 95 % limitu propky');
    expect(aboveKnownStalePropLimit.followers).toBeNull();
    expect(aboveKnownStalePropLimit.errors.join(' ')).toContain('nejvýše 95 % limitu propky');
  });

  it('odmítne limit Vypnout při na leader účtu i v poškozené topologii', () => {
    const malformedGroup: CopyGroupConfig = {
      ...group,
      followers: [
        ...group.followers,
        { accountId: group.leaderAccountId!, mode: 'on-submit', multiplier: 1, dailyLossCutUsd: 25 },
      ],
    };
    const result = validateAccountRiskLimits({
      group: malformedGroup,
      drafts: accountRiskLimitDraftsFromGroup(malformedGroup),
      accountRisk,
      now: NOW,
    });

    expect(result.followers).toBeNull();
    expect(result.errors.join(' ')).toContain('leader nemůže mít limit „Vypnout při“');
  });

  it('tighten-only validace odmítne vypnutí/zvýšení, ale vytvoří pouze přísnější payload', () => {
    const drafts = accountRiskLimitDraftsFromGroup(group);
    const weaker = validateAccountRiskLimits({
      group,
      drafts: {
        ...drafts,
        2: { dailyLossCutUsd: '600', maxContracts: '3', onCut: 'let-run' },
      },
      accountRisk,
      sessionArmedAt: NOW - 60_000,
      now: NOW,
    });
    const tighter = validateAccountRiskLimits({
      group,
      drafts: {
        ...drafts,
        2: { dailyLossCutUsd: '400', maxContracts: '1', onCut: 'close-copy' },
      },
      accountRisk,
      sessionArmedAt: NOW - 60_000,
      now: NOW,
    });

    expect(weaker.followers).toBeNull();
    expect(weaker.errors.join(' ')).toContain('jen zpřísnit');
    expect(tighter.errors).toEqual([]);
    expect(tighter.followers?.find(follower => follower.accountId === 2)).toMatchObject({
      dailyLossCutUsd: 400,
      maxContracts: 1,
      onCut: 'close-copy',
    });
  });

  it('předá relay chybu beze změny a nikdy nemutuje vstupní skupinu', async () => {
    const exactError = 'Pravidla jdou dnes jen zpřísnit: followers[2].dailyLossCutUsd';
    const onSave = vi.fn(async () => { throw new Error(exactError); });
    const original = structuredClone(group);

    await expect(submitAccountRiskLimits({
      group,
      drafts: accountRiskLimitDraftsFromGroup(group),
      accountRisk,
      now: NOW,
      onSave,
    })).rejects.toThrow(exactError);

    expect(onSave).toHaveBeenCalledOnce();
    expect(group).toEqual(original);
  });

  it('během broker P&L bootstrapu nehlásí falešný stav blízko limitu', () => {
    const markup = render({
      accountRisk: accountRisk.filter(snapshot => snapshot.accountId !== 3),
      brokerDailyPnlPending: true,
      followerCuts: [],
    });

    expect(row(markup, 3)).toContain('data-account-risk-state="copying"');
    expect(row(markup, 3)).not.toContain('blízko limitu');
    expect(row(markup, 3)).toContain('neověřeno');
  });

  it('použije jen explicitně potvrzené broker P&L a chybějící účet nechá neověřený', () => {
    const markup = render({
      accountRisk: [],
      followerCuts: [],
      brokerDailyPnlByAccount: { 2: -400 },
    });

    expect(row(markup, 2)).toContain('data-account-risk-state="near"');
    expect(row(markup, 2)).toContain('80 % limitu');
    expect(row(markup, 3)).toContain('data-account-risk-state="copying"');
    expect(row(markup, 3)).toContain('neověřeno');
    expect(row(markup, 3)).not.toContain('blízko limitu');
  });

  it('preferuje novější worker P&L před starší broker mapou', () => {
    const markup = render({
      accountRisk: accountRisk.map(snapshot => snapshot.accountId === 2
        ? { ...snapshot, verifiedAt: NOW - 1_000, realizedPnlUsd: -450 }
        : snapshot),
      brokerDailyPnlByAccount: { 2: -20 },
      followerCuts: [],
    });

    expect(row(markup, 2)).toContain('data-account-risk-state="near"');
    expect(row(markup, 2)).toContain('90 % limitu');
    expect(row(markup, 2)).not.toContain('data-account-risk-state="copying"');
  });

  it('stale nebo chybějící worker P&L nepřekryje starší broker hodnotou', () => {
    const stale = render({
      accountRisk: accountRisk.map(snapshot => snapshot.accountId === 2
        ? { ...snapshot, verifiedAt: NOW - 90_000, realizedPnlUsd: -450 }
        : snapshot),
      brokerDailyPnlByAccount: { 2: -450 },
      followerCuts: [],
    });
    const missing = render({
      accountRisk: accountRisk.map(snapshot => snapshot.accountId === 2
        ? { ...snapshot, verifiedAt: NOW - 1_000, realizedPnlUsd: null }
        : snapshot),
      brokerDailyPnlByAccount: { 2: -450 },
      followerCuts: [],
    });

    for (const markup of [stale, missing]) {
      expect(row(markup, 2)).toContain('data-account-risk-state="copying"');
      expect(row(markup, 2)).toContain('neověřeno');
      expect(row(markup, 2)).not.toContain('blízko limitu');
    }
  });

  it('u nullable výsledku cutu netvrdí stav otevřené kopie bez důkazu', () => {
    const cuts: CopierFollowerCut[] = [
      { ...followerCuts[0], accountId: 3, closed: null },
      { ...followerCuts[0], accountId: 4, closed: null },
    ];
    const markup = render({ followerCuts: cuts });

    expect(row(markup, 3)).toContain('stav otevřené kopie neověřen');
    expect(row(markup, 4)).toContain('stav otevřené kopie neověřen');
    expect(markup).not.toContain('kopie ponechána');
    expect(markup).not.toContain('žádná otevřená kopie k zavření');
  });
});

describe('LIVE Risk záložka', () => {
  it('propojí worker pauzu, chybu, tighten-only, pravidla i účty', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveRiskTab, {
      snapshot,
      accountProfiles: profiles,
      group,
      status: controller({
        pause: { until: NOW + 20 * 60_000, rule: 'daily-loss', at: NOW - 1_000 },
        sessionArmedAt: NOW - 60_000,
        lastError: 'Relay přesně vrátil tighten-only chybu',
        accountRisk,
        followerCuts,
        dailyStats: {
          sessionEndAt: NOW + 8 * 60 * 60_000,
          realizedPnlUsd: -620,
          losingTrades: 1,
          tradesToday: 4,
          windowState: 'inside',
          unpricedSymbols: [],
        },
      }),
      brokerDailyPnlByAccount: { 1: -10, 2: -20, 3: -80, 4: -120, 5: 0, 6: 0 },
      now: NOW,
      onSaveGroup: () => undefined,
    }));

    expect(markup).toContain('data-live-risk-tab="true"');
    expect(markup).toContain('data-rule-pause-banner="true"');
    expect(markup).toContain('Pauza do');
    expect(markup).toContain('Denní ztrátový limit');
    expect(markup).toContain('vstupy se nekopírují');
    expect(markup).toContain('Relay přesně vrátil tighten-only chybu');
    expect(markup).toContain('data-tighten-only="true"');
    expect(markup).toContain('data-live-day-rules="true"');
    expect(markup).toContain('data-live-account-risk-table="true"');
    expect(markup).toContain('data-follower-cut-banner="true"');
  });

  it('zámek má přednost před pauzou a nikdy nenabídne odemknutí', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveRiskTab, {
      snapshot,
      group,
      status: controller({
        dayLockUntil: NOW + 60 * 60_000,
        dayLockAt: NOW - 60_000,
        dayLockTrigger: 'daily-loss',
        pause: { until: NOW + 20 * 60_000, rule: 'daily-loss', at: NOW - 1_000 },
      }),
      now: NOW,
    }));

    expect(markup).toContain('data-day-lock-banner="true"');
    expect(markup).not.toContain('data-rule-pause-banner="true"');
    expect(markup).not.toContain('Odemknout');
  });

  it('bez autoritativní skupiny neukáže výchozí pravidla jako potvrzená', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveRiskTab, {
      snapshot,
      group: null,
      status: null,
      now: NOW,
    }));

    expect(markup).toContain('data-rules-known="false"');
    expect(markup).toContain('Worker nevrátil autoritativní konfiguraci skupiny');
    expect(markup).not.toContain('3 zámky');
  });
});
