import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  evaluateManualEntryPreview, remainingLossHeadroom, MANUAL_ENTRY_MAX_CONTRACTS,
  type ManualEntryAccountInputs, type ManualEntryPreviewInputs,
} from '../services/manualEntryPreview';
import {
  buildLeaderEntryPreviewCommand, copyGroupConfigHash, previewSymbolFromChartSource, validateLeaderEntryPreview, type LeaderEntryPreviewCommand,
} from '../lib/leaderEntryPreview';
import { createRiskGateContext } from '../services/copierRiskGate';

const NOW = Date.UTC(2026, 9, 29, 15, 0, 0);
const group = {
  id: 'g1', enabled: true, leaderAccountId: 1,
  followers: [
    { accountId: 2, mode: 'on-submit', multiplier: 1 },
    { accountId: 3, mode: 'on-submit', multiplier: 2 },
  ],
  safety: { dailyLossLimitUsd: 0, dailyMaxLosingTrades: 0, dailyMaxTrades: 0 },
};
const risk = (patch: Partial<NonNullable<ManualEntryAccountInputs['risk']>> = {}) => ({
  verifiedAt: NOW - 10_000, sameSession: true, error: null, realizedPnlUsd: 0, openPnlUsd: 0,
  netLiq: 51_000, cashBalanceUsd: 51_000, minNetLiq: 49_000, dailyLossAutoLiq: 1_200, effectiveDailyLossCutUsd: null, ...patch,
});
const flat = (patch: Partial<ManualEntryAccountInputs> = {}): ManualEntryAccountInputs => ({
  positions: [], liveOrders: [], cut: 'none', syncPaused: false, risk: risk(), ...patch,
});
const command = (patch: Partial<LeaderEntryPreviewCommand> = {}): LeaderEntryPreviewCommand => ({
  type: 'preview-leader-entry', groupId: 'g1', operationId: 'preview:abcdefgh1234', leaderAccountId: 1,
  symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 29_500, stopLoss: 29_480, takeProfit: 29_560,
  intent: { armedAt: NOW - 600_000, groupConfigHash: copyGroupConfigHash(group), followerQuantities: [{ accountId: 2, quantity: 1 }, { accountId: 3, quantity: 2 }] },
  ...patch,
});
const inputs = (patch: Partial<ManualEntryPreviewInputs> = {}): ManualEntryPreviewInputs => ({
  now: NOW,
  command: command(),
  group,
  riskGate: createRiskGateContext({
    armed: true, armedAt: NOW - 600_000, armTtlMs: 8 * 3_600_000, connected: true, lastHeartbeatAt: NOW,
    shadowMode: false, now: NOW, brokerEnvironment: 'demo', expectedEnvironment: 'demo',
  }),
  stateBlockers: [],
  reconciliationRequired: false,
  positionCheckComplete: true,
  managementOnly: false,
  dayLockPending: false,
  dayLockUntil: 0,
  pauseUntil: 0,
  pauseActive: false,
  entryCooldownUntil: 0,
  unconfirmedFlatLots: 0,
  tradingWindowState: 'inside',
  tradingWindowStateAfterReserve: 'inside',
  sessionEndAt: NOW + 6 * 3_600_000,
  armExpiresAt: NOW + 3 * 3_600_000 as number | null,
  transportResumePending: false,
  dailyStats: { realizedPnlUsd: 0, losingTrades: 0, tradesToday: 0 },
  lastGroupFillAt: null,
  accounts: new Map([[1, flat()], [2, flat()], [3, flat()]]),
  entryIneligible: new Map(),
  excludedFollowers: new Set(),
  frontSymbols: ['MNQZ6'],
  ...patch,
});
const codes = (patch: Partial<ManualEntryPreviewInputs> = {}) => evaluateManualEntryPreview(inputs(patch)).blockers.map(issue => issue.code);

describe('fáze 1a: náhled ručního vstupu (čisté vyhodnocení)', () => {
  it('klidná ARMED skupina: worker by poslal leadera i kopie s floor(qty × násobek)', () => {
    const result = evaluateManualEntryPreview(inputs());
    expect(result.blockers).toEqual([]);
    expect(result.wouldPlace?.leader).toMatchObject({ accountId: 1, side: 'Buy', quantity: 1, orderType: 'Limit', price: 29_500, stopLoss: 29_480, takeProfit: 29_560 });
    expect(result.wouldPlace?.followers.map(order => [order.accountId, order.quantity])).toEqual([[2, 1], [3, 2]]);
    expect(result.notes.map(note => note.code)).toEqual(expect.arrayContaining(['leader-can-trade', 'limit-marketability']));
  });

  it('chybějící data účtu nejsou flat', () => {
    expect(codes({ accounts: new Map([[1, flat({ positions: null })], [2, flat()], [3, flat()]]) })).toContain('account-unverified');
    expect(codes({ accounts: new Map([[1, flat()], [2, flat({ liveOrders: null })], [3, flat()]]) })).toContain('account-unverified');
    expect(codes({ accounts: new Map([[1, flat()], [2, flat()]]) })).toContain('account-unverified');
    expect(codes({ accounts: new Map([[1, flat({ positions: [{ symbol: 'MNQZ6', net: 1 }] })], [2, flat()], [3, flat()]]) })).toContain('account-not-flat');
  });

  it('stav kopírky: vypnutá, stínová, zámek, pauza, cooldown, okno, rezerva do konce', () => {
    expect(codes({ riskGate: { ...inputs().riskGate, armed: false } })).toContain('halt');
    expect(codes({ riskGate: { ...inputs().riskGate, shadowMode: true } })).toContain('shadow');
    expect(codes({ dayLockPending: true })).toContain('day-lock-pending');
    expect(codes({ dayLockUntil: NOW + 1 })).toContain('day-lock');
    expect(codes({ pauseActive: true, pauseUntil: NOW + 1 })).toContain('pause');
    // Pauza, která už skončila (pravidlo ještě nesmazané), neblokuje.
    expect(codes({ pauseActive: true, pauseUntil: NOW - 1 })).not.toContain('pause');
    expect(codes({ entryCooldownUntil: NOW + 1 })).toContain('cooldown');
    expect(codes({ tradingWindowState: 'outside' })).toContain('outside-window');
    expect(codes({ tradingWindowStateAfterReserve: 'outside' })).toContain('window-ending');
    expect(codes({ sessionEndAt: NOW + 60_000 })).toContain('session-ending');
    expect(codes({ armExpiresAt: NOW + 60_000 })).toContain('arm-expiring');
    expect(codes({ transportResumePending: true })).toContain('transport-resume');
    expect(codes({ unconfirmedFlatLots: 1 })).toContain('unconfirmed-flat');
    expect(codes({ stateBlockers: [{ code: 'group-busy', text: 'x' }] })).toContain('group-busy');
  });

  it('záměr: změna ARM, nastavení skupiny nebo kontraktů followerů = blocker', () => {
    expect(codes({ command: command({ intent: { ...command().intent, armedAt: 1 } }) })).toContain('intent-arm-changed');
    expect(codes({ group: { ...group, followers: [{ ...group.followers[0], multiplier: 3 }, group.followers[1]] } })).toEqual(expect.arrayContaining(['intent-config-changed']));
    expect(codes({ command: command({ intent: { ...command().intent, followerQuantities: [{ accountId: 2, quantity: 1 }] } }) })).toContain('intent-quantities-changed');
  });

  it('příkaz: strop ručního vstupu, strany SL/TP, front kontrakt', () => {
    expect(codes({ command: command({ quantity: MANUAL_ENTRY_MAX_CONTRACTS + 1 }) })).toContain('manual-cap');
    expect(codes({ command: command({ stopLoss: 29_520 }) })).toContain('stop-side');
    expect(codes({ command: command({ takeProfit: 29_490 }) })).toContain('target-side');
    expect(codes({ command: command({ symbol: 'MNQH7' }) })).toContain('symbol-not-front');
  });

  it('followeři: on-fill a nulové množství blokují, nezpůsobilý/sync pauza jen nedostane, nikdo = blocker', () => {
    expect(codes({ group: { ...group, followers: [{ accountId: 2, mode: 'on-fill', multiplier: 1 }] } })).toContain('oso-on-fill-not-supported');
    expect(codes({ group: { ...group, followers: [{ accountId: 2, mode: 'on-submit', multiplier: 0.5 }] } })).toContain('scaled-quantity-zero');
    const skipped = evaluateManualEntryPreview(inputs({ entryIneligible: new Map([[3, 'dll-locked']]) }));
    expect(skipped.notes.map(note => note.code)).toContain('follower-skipped');
    const paused = evaluateManualEntryPreview(inputs({ accounts: new Map([[1, flat()], [2, flat()], [3, flat({ syncPaused: true })]]) }));
    expect(paused.notes.map(note => note.code)).toContain('follower-sync-paused');
    expect(codes({ entryIneligible: new Map([[2, 'x'], [3, 'y']]) })).toContain('no-follower-would-copy');
    expect(codes({ entryIneligible: new Map([[1, 'breached']]) })).toContain('leader-ineligible');
  });

  it('strop kontraktů followera nejhorším případem jako exposureCappedBroker', () => {
    const capped = { ...group, followers: [{ accountId: 2, mode: 'on-submit', multiplier: 3, maxContracts: 2 }] };
    expect(codes({ group: capped, command: command({ intent: { armedAt: NOW - 600_000, groupConfigHash: copyGroupConfigHash(capped), followerQuantities: [{ accountId: 2, quantity: 3 }] } }) })).toContain('max-contracts');
  });

  it('riziko: MIN ze všech limitů, zisk rezervu nezvětší, neznámé = blocker', () => {
    // DLL 1200, ale do MLL floor jen 100 $ → rozpětí TP–SL (80 b × 2 $ + skluz + poplatek ≈ 162 $) neprojde.
    expect(codes({ accounts: new Map([[1, flat({ risk: risk({ netLiq: 49_100 }) })], [2, flat()], [3, flat()]]) })).toContain('risk-drawdown');
    expect(codes({ accounts: new Map([[1, flat({ risk: risk({ netLiq: 49_300 }) })], [2, flat()], [3, flat()]]) })).not.toContain('risk-drawdown');
    // DLL 0 = broker limit nenastavil, ne „nic nezbývá“.
    expect(remainingLossHeadroom(risk({ dailyLossAutoLiq: 0 })).dailyUsd).toBeNull();
    // Cut followera: přísnější z nastaveného a efektivního.
    expect(remainingLossHeadroom(risk({ effectiveDailyLossCutUsd: null }), 400).cutUsd).toBe(400);
    expect(remainingLossHeadroom(risk({ effectiveDailyLossCutUsd: 300, realizedPnlUsd: -100 }), 400).cutUsd).toBe(200);
    expect(remainingLossHeadroom(risk({ realizedPnlUsd: 500 })).dailyUsd).toBe(1_200);
    expect(remainingLossHeadroom(risk({ realizedPnlUsd: -1_150 })).dailyUsd).toBe(50);
    expect(codes({ accounts: new Map([[1, flat({ risk: risk({ realizedPnlUsd: -1_180 }) })], [2, flat()], [3, flat()]]) })).toContain('risk-daily');
    expect(codes({ accounts: new Map([[1, flat({ risk: risk({ dailyLossAutoLiq: null, netLiq: null, cashBalanceUsd: null }) })], [2, flat()], [3, flat()]]) })).toContain('risk-unknown');
  });

  it('riziko: starý, cizí session, s chybou nebo starší než poslední fill = neověřeno', () => {
    expect(codes({ accounts: new Map([[1, flat({ risk: risk({ verifiedAt: NOW - 100_000 }) })], [2, flat()], [3, flat()]]) })).toContain('risk-unverified');
    expect(codes({ accounts: new Map([[1, flat({ risk: risk({ sameSession: false }) })], [2, flat()], [3, flat()]]) })).toContain('risk-unverified');
    expect(codes({ accounts: new Map([[1, flat({ risk: risk({ error: 'stale-snapshot' }) })], [2, flat()], [3, flat()]]) })).toContain('risk-unverified');
    expect(codes({ lastGroupFillAt: NOW - 5_000 })).toContain('risk-unverified');
    expect(codes({ accounts: new Map([[1, flat({ risk: null })], [2, flat()], [3, flat()]]) })).toContain('risk-unverified');
  });

  it('pravidla dne ze stavu dne', () => {
    const rules = { ...group, safety: { dailyLossLimitUsd: 500, dailyMaxLosingTrades: 3, dailyMaxTrades: 5 } };
    const hash = { command: command({ intent: { ...command().intent, groupConfigHash: copyGroupConfigHash(rules) } }) };
    expect(codes({ ...hash, group: rules, dailyStats: { realizedPnlUsd: 0, losingTrades: 0, tradesToday: 5 } })).toContain('daily-max-trades');
    expect(codes({ ...hash, group: rules, dailyStats: { realizedPnlUsd: 0, losingTrades: 3, tradesToday: 3 } })).toContain('daily-max-losing');
    expect(codes({ ...hash, group: rules, dailyStats: { realizedPnlUsd: -500, losingTrades: 1, tradesToday: 1 } })).toContain('daily-loss-limit');
  });
});

describe('fáze 1a: protokol náhledu', () => {
  it('kontrakt ze zdroje ceny grafu; kontinuální řada = neznámý', () => {
    expect(previewSymbolFromChartSource('IBKR:MNQZ2026')).toBe('MNQZ6');
    expect(previewSymbolFromChartSource('MNQH7')).toBe('MNQH7');
    expect(previewSymbolFromChartSource('CME_MINI:MNQ1!')).toBeNull();
    // Fáze 1b: kontrakt jen z IBKR, nikdy z TradingView (INV-UI-04).
    expect(previewSymbolFromChartSource('CME_MINI:MNQZ2026')).toBeNull();
    expect(previewSymbolFromChartSource(null)).toBeNull();
  });

  it('validace: whitelist klíčů, typy, tick, symbol jen [HMUZ], prefix preview:', () => {
    expect(validateLeaderEntryPreview(command())).toBeTruthy();
    const bad = (patch: Record<string, unknown>) => () => validateLeaderEntryPreview({ ...command(), ...patch });
    expect(bad({ extra: 1 })).toThrow('invalid-relay-command-payload');
    expect(bad({ operationId: 'abcdefgh1234' })).toThrow();
    expect(bad({ symbol: 'MNQF6' })).toThrow();
    expect(bad({ price: 29_500.1 })).toThrow();
    expect(bad({ quantity: 0 })).toThrow();
    expect(bad({ quantity: 51 })).toThrow();
    expect(bad({ price: Number.NaN })).toThrow();
    expect(bad({ orderType: 'Market' })).toThrow();
    expect(bad({ intent: { ...command().intent, extra: 1 } })).toThrow();
  });

  it('panel sestaví záměr stejně jako kopírka (vyřazený, vypnutý, on-fill bez kopie)', () => {
    const built = buildLeaderEntryPreviewCommand(
      { symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 29_500, stopLoss: 29_480, takeProfit: 29_560 },
      {
        group: { ...group, followers: [...group.followers, { accountId: 4, mode: 'on-fill', multiplier: 1 }, { accountId: 5, mode: 'on-submit', multiplier: 1 }] },
        armedAt: 7, excludedFollowers: new Set([5]), participation: [], operationId: 'preview:abcdefgh1234',
      },
    );
    expect(built.intent.followerQuantities).toEqual([{ accountId: 2, quantity: 1 }, { accountId: 3, quantity: 2 }]);
    expect(validateLeaderEntryPreview(built)).toBeTruthy();
  });
});

describe('fáze 1a: strážní pravidla', () => {
  it('modul náhledu neimportuje brokera ani controller a nevolá zápisy', () => {
    const source = readFileSync('services/manualEntryPreview.ts', 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
    for (const path of imports) expect(path).not.toMatch(/tradovateBroker|brokerRouter|copierRuntimeController|copierRunner|copierOutbox/);
    expect(source).not.toMatch(/placeOrder|placeOso|placeOco|modifyOrder|cancelOrder|liquidatePosition|dispatchBroker/);
  });

  it('controller náhled jen sbírá stav bez IO a vyhodnotí čistou funkcí', () => {
    const controller = readFileSync('services/copierRuntimeController.ts', 'utf8');
    const start = controller.indexOf('    previewLeaderEntry(command: LeaderEntryPreviewCommand): LeaderEntryPreviewResult {');
    const body = controller.slice(start, controller.indexOf('\n    prepareArm,', start));
    expect(start).toBeGreaterThan(0);
    expect(body).not.toMatch(/await |dispatchBroker|options\.broker|persist|onAudit|lastError =|failClosed/);
    expect(body).toMatch(/return evaluateManualEntryPreview\(/);
  });

  it('starý / neznámý copy-command ve workeru nikdy nevrátí „ok“ bez výsledku', () => {
    const agent = readFileSync('server/localCopierExecutionAgent.ts', 'utf8');
    expect(agent).toMatch(/unsupported-copy-command:/);
    expect(agent).toMatch(/case 'preview-leader-entry': \{/);
  });

  it('relay pouští nejvýš jeden náhled na zařízení a validuje ho na enqueue i claim', () => {
    const relay = readFileSync('server/tradovateCopierCommandRelay.ts', 'utf8');
    expect(relay).toMatch(/if \(command\.type === 'preview-leader-entry'\) return validateLeaderEntryPreview\(value\)/);
    expect(relay).toMatch(/copier-relay-preview-busy/);
    expect(relay).toMatch(/PREVIEW_COMMAND_TTL_MS = 15_000/);
  });
});
