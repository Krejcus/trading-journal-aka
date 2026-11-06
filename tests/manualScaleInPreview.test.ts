// Přikoupení v náhledu vstupu (3. 11. 2026): riziko celé pozice s rezervou jen z realizovaného P&L
// (oponentura v4 P1-1), neznámý průměr pozice = blokace, strop na příkaz se u přikoupení nepoužije.
import { describe, expect, it } from 'vitest';
import { evaluateManualEntryPreview, type ManualEntryAccountInputs, type ManualEntryPreviewInputs } from '../services/manualEntryPreview';
import { copyGroupConfigHash, type LeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import { createRiskGateContext } from '../services/copierRiskGate';

const NOW = Date.UTC(2026, 10, 3, 15, 0, 0);
const group = {
  id: 'manual-demo-1', enabled: true, leaderAccountId: 1, followers: [], manualOnly: true, localOnly: true, manualEntryMaxContracts: 5,
  safety: { dailyLossLimitUsd: 250, dailyMaxLosingTrades: 0, dailyMaxTrades: 0 },
};
const leader = (risk: Partial<NonNullable<ManualEntryAccountInputs['risk']>> = {}): ManualEntryAccountInputs => ({
  positions: [{ symbol: 'MNQZ6', net: 2 }], liveOrders: [{ symbol: 'MNQZ6', side: 'Sell', remaining: 1 }], cut: 'none', syncPaused: false,
  risk: { verifiedAt: NOW - 5_000, sameSession: true, error: null, realizedPnlUsd: 0, openPnlUsd: 0, netLiq: 50_000, cashBalanceUsd: 50_000,
    minNetLiq: null, dailyLossAutoLiq: null, effectiveDailyLossCutUsd: null, ...risk },
});
const command = (patch: Partial<LeaderEntryPreviewCommand> = {}): LeaderEntryPreviewCommand => ({
  type: 'preview-leader-entry', groupId: group.id, operationId: 'preview:scalein0001', leaderAccountId: 1,
  symbol: 'MNQZ6', side: 'Buy', quantity: 2, orderType: 'Market', referencePrice: 140, quoteReceivedAt: NOW - 500, stopLoss: 100, takeProfit: 300,
  position: { mode: 'add', side: 'Buy', quantity: 2, ticketEntryIds: ['11', '22'] },
  intent: { armedAt: NOW - 600_000, groupConfigHash: copyGroupConfigHash(group), followerQuantities: [] },
  ...patch,
});
const inputs = (patch: Partial<ManualEntryPreviewInputs> = {}): ManualEntryPreviewInputs => ({
  now: NOW, command: command(), group,
  riskGate: createRiskGateContext({ armed: true, armedAt: NOW - 600_000, armTtlMs: 8 * 3_600_000, connected: true, lastHeartbeatAt: NOW,
    shadowMode: false, now: NOW, brokerEnvironment: 'demo', expectedEnvironment: 'demo' }),
  stateBlockers: [], reconciliationRequired: false, positionCheckComplete: true, managementOnly: false, dayLockPending: false, dayLockUntil: 0,
  pauseUntil: 0, pauseActive: false, entryCooldownUntil: 0, unconfirmedFlatLots: 0, tradingWindowState: 'off', tradingWindowStateAfterReserve: 'off',
  sessionEndAt: NOW + 6 * 3_600_000, armExpiresAt: null, transportResumePending: false,
  dailyStats: { realizedPnlUsd: 0, losingTrades: 0, tradesToday: 0 }, lastGroupFillAt: null,
  accounts: new Map([[1, leader()]]), entryIneligible: new Map(), excludedFollowers: new Set(), frontSymbols: ['MNQZ6'],
  workerQuote: { contract: 'MNQZ6', last: 140, lastAt: NOW - 200, bid: 139.75, ask: 140, quoteAt: NOW - 200 },
  scaleIn: { blockers: [], existingLossPoints: 0, existingQuantity: 2 },
  ...patch,
});
const codes = (patch: Partial<ManualEntryPreviewInputs> = {}) => evaluateManualEntryPreview(inputs(patch)).blockers.map(issue => issue.code);

describe('přikoupení v náhledu vstupu', () => {
  it('scénář oponentury P1-1: realizováno −200, otevřeno +160, strop 250 → přikoupení 2 se SL na BE zablokované', () => {
    // Přikoupení 2 @140 se SL 100: ~165 $; stávající pozice se SL na BE = 0. Rezerva 250 − 200 = 50 (ne 210).
    expect(codes({ accounts: new Map([[1, leader({ realizedPnlUsd: -200, openPnlUsd: 160 })]]) })).toContain('risk-daily');
  });

  it('bez realizované ztráty projde; otevřený zisk rezervu nezvětší', () => {
    expect(codes()).toEqual([]);
    expect(codes({ accounts: new Map([[1, leader({ openPnlUsd: 5_000 })]]), scaleIn: { blockers: [], existingLossPoints: 200, existingQuantity: 2 } }))
      .toContain('risk-daily');
  });

  it('neznámý průměr pozice = risk-unverified; vypnuté přikoupení = scale-in-off; blokery brány projdou', () => {
    expect(codes({ scaleIn: { blockers: [], existingLossPoints: null, existingQuantity: 2 } })).toContain('risk-unverified');
    expect(codes({ scaleIn: null })).toContain('scale-in-off');
    expect(codes({ scaleIn: { blockers: [{ code: 'scale-in-uncovered', text: 'x' }], existingLossPoints: 0, existingQuantity: 2 } })).toContain('scale-in-uncovered');
  });

  it('flat brána leadera se u přikoupení nepoužije, u vstupu bez `position` ano', () => {
    expect(codes()).not.toContain('account-not-flat');
    expect(codes({ command: command({ position: undefined }) })).toContain('account-not-flat');
  });

  it('risk snímek starší než poslední fill pozice = risk-unverified', () => {
    expect(codes({ lastGroupFillAt: NOW - 1_000 })).toContain('risk-unverified');
  });
});
