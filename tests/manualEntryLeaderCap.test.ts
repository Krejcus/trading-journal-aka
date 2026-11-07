// Strop ručního vstupu podle propky (7. 11. 2026): účet leadera, followeři ho přebírají, během session jen zpřísnit.
import { describe, expect, it } from 'vitest';
import { leaderEntryContractCap, manualEntryContractCap, evaluateManualEntryPreview, type ManualEntryAccountInputs, type ManualEntryPreviewInputs } from '../services/manualEntryPreview';
import { copyGroupConfigHash, type LeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import { isWeakerRiskConfig } from '../lib/copierRiskConfig';
import { DEFAULT_COPY_GROUP_SAFETY, sanitizeCopyGroupSafety, type CopyGroupSafetySettings } from '../services/liveCopyTrading';
import { validateDailyRulesDraft, dailyRulesDraftFromSafety, isWeakerDailyRulesSafety } from '../components/LiveDayRulesCard';
import { createRiskGateContext } from '../services/copierRiskGate';

const safety = (cap?: { accountId: number; contracts: number }): CopyGroupSafetySettings => ({
  ...DEFAULT_COPY_GROUP_SAFETY, ...(cap ? { leaderMaxContracts: cap } : {}),
});

describe('strop leadera', () => {
  it('platí jen pro účet, ke kterému patří', () => {
    expect(manualEntryContractCap({ leaderAccountId: 1, safety: safety({ accountId: 1, contracts: 40 }) })).toBe(40);
    expect(leaderEntryContractCap({ leaderAccountId: 2, safety: safety({ accountId: 1, contracts: 40 }) })).toBeNull();
    expect(manualEntryContractCap({ leaderAccountId: 2, safety: safety({ accountId: 1, contracts: 40 }) })).toBe(1);
    // Bez stropu dál dnešní chování: manual-only DEMO instalační hodnota, jinak 1.
    expect(manualEntryContractCap({ leaderAccountId: 1, manualOnly: true, localOnly: true, manualEntryMaxContracts: 5 })).toBe(5);
    // Manual-only DEMO: pravidla instalační strop jen snižují.
    expect(manualEntryContractCap({ leaderAccountId: 1, manualOnly: true, localOnly: true, manualEntryMaxContracts: 2, safety: safety({ accountId: 1, contracts: 50 }) })).toBe(2);
    expect(manualEntryContractCap({ leaderAccountId: 1, manualOnly: true, localOnly: true, manualEntryMaxContracts: 5, safety: safety({ accountId: 1, contracts: 3 }) })).toBe(3);
    expect(manualEntryContractCap({ leaderAccountId: 1 })).toBe(1);
  });

  it('neplatný strop = neplatná pravidla, žádné tiché vynechání', () => {
    expect(sanitizeCopyGroupSafety({ ...DEFAULT_COPY_GROUP_SAFETY, leaderMaxContracts: { accountId: 1, contracts: 40 } })?.leaderMaxContracts).toEqual({ accountId: 1, contracts: 40 });
    expect(sanitizeCopyGroupSafety({ ...DEFAULT_COPY_GROUP_SAFETY, leaderMaxContracts: { accountId: 1, contracts: 51 } })).toBeNull();
    expect(sanitizeCopyGroupSafety({ ...DEFAULT_COPY_GROUP_SAFETY, leaderMaxContracts: { accountId: 0, contracts: 4 } })).toBeNull();
    expect(sanitizeCopyGroupSafety(DEFAULT_COPY_GROUP_SAFETY)?.leaderMaxContracts).toBeUndefined();
  });

  it('během session jen snížit: zvýšit, zrušit i jiný účet je zmírnění', () => {
    const config = (cap?: { accountId: number; contracts: number }) => ({ safety: safety(cap), followers: [] });
    expect(isWeakerRiskConfig(config({ accountId: 1, contracts: 40 }), config({ accountId: 1, contracts: 20 }))).toEqual([]);
    expect(isWeakerRiskConfig(config({ accountId: 1, contracts: 20 }), config({ accountId: 1, contracts: 40 }))).toContain('safety.leaderMaxContracts');
    expect(isWeakerRiskConfig(config({ accountId: 1, contracts: 20 }), config())).toContain('safety.leaderMaxContracts');
    expect(isWeakerRiskConfig(config(), config({ accountId: 1, contracts: 4 }))).toContain('safety.leaderMaxContracts');
    expect(isWeakerRiskConfig(config({ accountId: 1, contracts: 20 }), config({ accountId: 2, contracts: 20 }))).toContain('safety.leaderMaxContracts');
    expect(isWeakerDailyRulesSafety(safety({ accountId: 1, contracts: 20 }), safety({ accountId: 1, contracts: 40 }))).toBe(true);
    expect(isWeakerDailyRulesSafety(safety({ accountId: 1, contracts: 20 }), safety({ accountId: 1, contracts: 10 }))).toBe(false);
  });

  it('karta Pravidla dne strop váže na leadera a hlídá rozsah', () => {
    const draft = { ...dailyRulesDraftFromSafety(safety()), leaderCapEnabled: true, leaderMaxContracts: '40' };
    expect(validateDailyRulesDraft(draft, safety(), 7).safety?.leaderMaxContracts).toEqual({ accountId: 7, contracts: 40 });
    expect(validateDailyRulesDraft({ ...draft, leaderMaxContracts: '60' }, safety(), 7).errors.join(' ')).toContain('od 1 do 50');
    expect(validateDailyRulesDraft(draft, safety(), null).safety).toBeNull();
    expect(validateDailyRulesDraft({ ...draft, leaderCapEnabled: false }, safety({ accountId: 7, contracts: 40 }), 7).safety?.leaderMaxContracts).toBeUndefined();
    // Nový leader strop dřívějšího účtu nepřevezme a uložení jiného pravidla ho nepřenese.
    const old = safety({ accountId: 3, contracts: 4 });
    const fresh = dailyRulesDraftFromSafety(old, 7);
    expect(fresh.leaderCapEnabled).toBe(false);
    expect(validateDailyRulesDraft(fresh, old, 7).safety?.leaderMaxContracts).toEqual({ accountId: 3, contracts: 4 });
    expect(manualEntryContractCap({ leaderAccountId: 7, safety: validateDailyRulesDraft(fresh, old, 7).safety! })).toBe(1);
  });

  it('hash náhledu se změní se stropem, bez stropu zůstává stejný', () => {
    const base = { id: 'g', enabled: true, leaderAccountId: 1, followers: [] };
    expect(copyGroupConfigHash({ ...base, safety: safety() })).toBe(copyGroupConfigHash(base));
    expect(copyGroupConfigHash({ ...base, safety: safety({ accountId: 1, contracts: 40 }) })).not.toBe(copyGroupConfigHash(base));
  });
});

describe('náhled ve skupině s followery', () => {
  const NOW = Date.UTC(2026, 9, 29, 15, 0, 0);
  const risk = () => ({
    verifiedAt: NOW - 10_000, sameSession: true, error: null, realizedPnlUsd: 0, openPnlUsd: 0,
    netLiq: 51_000, cashBalanceUsd: 51_000, minNetLiq: 40_000, dailyLossAutoLiq: 5_000, effectiveDailyLossCutUsd: null,
  });
  const flat = (): ManualEntryAccountInputs => ({ positions: [], liveOrders: [], cut: 'none', syncPaused: false, risk: risk() });
  const group = (cap: number | null, followerMax?: number) => ({
    id: 'g1', enabled: true, leaderAccountId: 1,
    followers: [{ accountId: 2, mode: 'on-submit', multiplier: 1, ...(followerMax != null ? { maxContracts: followerMax } : {}) }],
    safety: { dailyLossLimitUsd: 0, dailyMaxLosingTrades: 0, dailyMaxTrades: 0, ...(cap != null ? { leaderMaxContracts: { accountId: 1, contracts: cap } } : {}) },
  });
  const codes = (g: ReturnType<typeof group>, quantity: number) => {
    const command: LeaderEntryPreviewCommand = {
      type: 'preview-leader-entry', groupId: 'g1', operationId: 'preview:abcdefgh1234', leaderAccountId: 1,
      symbol: 'MNQZ6', side: 'Buy', quantity, orderType: 'Limit', price: 29_500, stopLoss: 29_495, takeProfit: 29_510,
      intent: { armedAt: NOW - 600_000, groupConfigHash: copyGroupConfigHash(g), followerQuantities: [{ accountId: 2, quantity }] },
    };
    const inputs: ManualEntryPreviewInputs = {
      now: NOW, command, group: g,
      riskGate: createRiskGateContext({ armed: true, armedAt: NOW - 600_000, armTtlMs: 8 * 3_600_000, connected: true, lastHeartbeatAt: NOW, shadowMode: false, now: NOW, brokerEnvironment: 'demo', expectedEnvironment: 'demo' }),
      stateBlockers: [], reconciliationRequired: false, positionCheckComplete: true, managementOnly: false, dayLockPending: false, dayLockUntil: 0,
      pauseUntil: 0, pauseActive: false, entryCooldownUntil: 0, unconfirmedFlatLots: 0, tradingWindowState: 'inside', tradingWindowStateAfterReserve: 'inside',
      sessionEndAt: NOW + 6 * 3_600_000, armExpiresAt: NOW + 3 * 3_600_000, transportResumePending: false,
      dailyStats: { realizedPnlUsd: 0, losingTrades: 0, tradesToday: 0 }, lastGroupFillAt: null,
      accounts: new Map([[1, flat()], [2, flat()]]), entryIneligible: new Map(),
      excludedFollowers: new Set(), frontSymbols: ['MNQZ6'],
      workerQuote: { contract: 'MNQZ6', last: 29_500, lastAt: NOW - 500, bid: null, ask: null, quoteAt: null },
    } as unknown as ManualEntryPreviewInputs;
    return evaluateManualEntryPreview(inputs).blockers.map(issue => issue.code);
  };

  it('bez stropu jen 1 kontrakt, se stropem do jeho výše', () => {
    expect(codes(group(null), 3)).toContain('manual-cap');
    expect(codes(group(4), 3)).not.toContain('manual-cap');
    expect(codes(group(4), 5)).toContain('manual-cap');
  });

  it('follower bez vlastního stropu přebírá strop leadera, vlastní strop má přednost', () => {
    expect(codes(group(4), 4)).not.toContain('max-contracts');
    expect(codes(group(4, 2), 3)).toContain('max-contracts');
  });
});

describe('karta Pravidla dne', () => {
  it('ukazuje strop kontraktů s číslem leadera', async () => {
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { LiveDayRulesCard } = await import('../components/LiveDayRulesCard');
    const markup = renderToStaticMarkup(React.createElement(LiveDayRulesCard, {
      groupId: 'g', groupName: 'Lucid', leaderAccountId: 1, safety: safety({ accountId: 1, contracts: 40 }), riskConfigSupported: true, runtimeAvailable: true,
    }));
    expect(markup).toContain('Max kontraktů z grafu');
    expect(markup).toContain('nejvýš 40');
  });
});
