import { describe, expect, it } from 'vitest';

import { reduceMacCompanionPresentation } from '../lib/macCompanionContract';
import { buildMacCompanionStatus } from '../server/macCompanionStatus';

const NOW = Date.parse('2026-09-01T10:00:05.000Z');
const HEARTBEAT = '2026-09-01T10:00:00.000Z';

const runtime = (controller: Record<string, unknown>, extras: Record<string, unknown> = {}) => ({
  device_id: 'device-id',
  user_id: 'user-id',
  connection_id: 'connection-id',
  last_seen_at: HEARTBEAT,
  started_at: '2026-09-01T09:00:00.000Z',
  status: {
    version: 1,
    environment: 'demo',
    nonce: 'SECRET-NONCE-MUST-NOT-LEAK',
    group: {
      leaderAccountId: 123456,
      followers: [{ accountId: 222222 }, { accountId: 333333 }],
    },
    controller,
    snapshotHealth: { enabled: true, state: 'ready' },
    ...extras,
  },
});

describe('mac companion cloud status reducer', () => {
  it('builds a strict allowlist DTO without inventing exposure or follower acknowledgements', () => {
    const dto = buildMacCompanionStatus({
      runtime: runtime({
        armed: true,
        shadowMode: false,
        connected: true,
        reconciliationRequired: false,
        divergentAccounts: [],
        workingOrderAccounts: [],
        stuckOutbox: false,
        stuckOperations: [],
        killSwitch: false,
        dailyStats: {
          sessionEndAt: NOW + 60 * 60_000,
          realizedPnlUsd: -120,
          losingTrades: 2,
          tradesToday: 4,
          windowState: 'inside',
          warnedRules: [{ rule: 'max-trades', current: 4, limit: 5, at: NOW - 1_000 }],
        },
        entryCooldownUntil: NOW + 5 * 60_000,
        dayLockUntil: NOW + 60 * 60_000,
        dayLockAt: NOW - 2_000,
        dayLockTrigger: 'losing-trades',
        dayLockReason: 'auto day-lock: ztrátové obchody',
        dayUnlock: null,
        armExpiresAt: NOW + 30 * 60_000,
        groupFlat: true,
        lastError: 'RAW-LAST-ERROR-MUST-NOT-LEAK',
      }, {
        group: {
          leaderAccountId: 123456,
          followers: [{ accountId: 222222 }, { accountId: 333333 }],
          safety: {
            dailyLossLimitUsd: 500,
            dailyMaxLosingTrades: 3,
            dailyMaxTrades: 5,
            entryCooldownMinutes: 15,
            tradingWindow: { enabled: true, from: '15:30', to: '22:00', timeZone: 'Europe/Prague' },
          },
        },
      }),
      snapshots: [
        { kind: 'entry', at: '2026-09-01T09:58:00.000Z' },
        { kind: 'exit', at: '2026-09-01T09:59:00.000Z' },
      ],
      now: NOW,
    });

    expect(dto).toMatchObject({
      contractVersion: 1,
      revision: Date.parse(HEARTBEAT),
      copierState: 'live',
      worker: { location: 'mac', lastHeartbeatAt: HEARTBEAT },
      brokerConnected: true,
      dailyStats: {
        label: 'Leader · jen obchody přes kopírku · bez poplatků',
        realizedPnlUsd: -120,
        losingTrades: 2,
      },
      dayLock: {
        active: true,
        trigger: 'losing-trades',
        reason: 'auto day-lock: ztrátové obchody',
        unlocked: null,
      },
      dailyRules: {
        lossLimitUsd: 500,
        realizedLossUsd: -120,
        maxLosingTrades: 3,
        losingTrades: 2,
        maxTrades: 5,
        tradesToday: 4,
        window: { enabled: true, from: '15:30', to: '22:00', state: 'inside' },
        cooldownMinutes: 15,
        warnings: [{ rule: 'max-trades', current: 4, limit: 5 }],
      },
      exposure: {
        verifiedAt: null,
        positions: [],
        followerAck: null,
        accountsWithWorkingOrders: null,
      },
      snapshots: {
        cdpReady: true,
        lastEntryAt: '2026-09-01T09:58:00.000Z',
        lastExitAt: '2026-09-01T09:59:00.000Z',
      },
    });
    expect(JSON.stringify(dto)).not.toContain('SECRET-NONCE');
    expect(JSON.stringify(dto)).not.toContain('RAW-LAST-ERROR');
    expect(JSON.stringify(dto)).not.toContain('123456');
    expect(JSON.stringify(dto)).not.toContain('groupFlat');
  });

  it('redacts divergent account ids and surfaces fixed, non-executable problems', () => {
    const dto = buildMacCompanionStatus({
      runtime: runtime({
        armed: false,
        shadowMode: false,
        connected: true,
        reconciliationRequired: true,
        divergentAccounts: [333333],
        workingOrderAccounts: [],
        stuckOutbox: true,
        stuckOperations: [{ updatedAt: NOW - 125_000, reason: 'SECRET OPERATOR DETAIL' }],
        killSwitch: false,
      }),
      now: NOW,
    });

    expect(dto.safety.divergences).toEqual([{
      symbol: null,
      account: 'Follower 2',
      detail: 'Pozice se liší od leadera.',
    }]);
    expect(dto.safety.outbox).toEqual({ stuckCount: 1, oldestStuckMinutes: 2 });
    expect(dto.problems.map(problem => problem.kind)).toEqual(['divergence', 'stuck-outbox', 'reconciliation']);
    expect(JSON.stringify(dto)).not.toContain('333333');
    expect(JSON.stringify(dto)).not.toContain('SECRET OPERATOR DETAIL');
  });

  it('treats missing reconciliation evidence as unknown even on a fresh heartbeat', () => {
    const dto = buildMacCompanionStatus({
      runtime: runtime({ armed: false, shadowMode: false, connected: true }),
      now: NOW,
    });
    expect(dto.safety.reconciliation.status).toBe('unknown');
    expect(dto.problems).toContainEqual({
      kind: 'reconciliation',
      text: 'Stav reconciliation není potvrzený.',
    });
    expect(dto.dayLock).toBeNull();
    expect(dto.dailyRules).toBeNull();
  });

  it('fails closed to null when a new worker DTO field is incomplete', () => {
    const dto = buildMacCompanionStatus({
      runtime: runtime({
        armed: false,
        shadowMode: false,
        connected: true,
        reconciliationRequired: false,
        divergentAccounts: [],
        workingOrderAccounts: [],
        stuckOutbox: false,
        stuckOperations: [],
        killSwitch: false,
        dayLockUntil: NOW + 60_000,
        dayLockTrigger: 'max-trades',
        // dayLockAt intentionally missing
        dayLockReason: 'limit',
        dailyStats: { realizedPnlUsd: -10, losingTrades: 0 },
      }),
      now: NOW,
    });
    expect(dto.dayLock).toBeNull();
    expect(dto.dailyRules).toBeNull();
  });

  it.each([
    {
      label: 'divergent account array',
      divergentAccounts: ['schema-drift'],
      workingOrderAccounts: [],
    },
    {
      label: 'working-order account array',
      divergentAccounts: [],
      workingOrderAccounts: [0],
    },
  ])('fails closed when the $label contains an invalid account id', ({
    divergentAccounts,
    workingOrderAccounts,
  }) => {
    const dto = buildMacCompanionStatus({
      runtime: runtime({
        armed: true,
        shadowMode: false,
        connected: true,
        reconciliationRequired: false,
        divergentAccounts,
        workingOrderAccounts,
        stuckOutbox: false,
        stuckOperations: [],
        killSwitch: false,
        armExpiresAt: NOW + 30 * 60_000,
      }),
      now: NOW,
    });

    expect(dto.safety.reconciliation.status).toBe('unknown');
    expect(dto.safety.divergences).toEqual([]);
    expect(dto.problems).toContainEqual({
      kind: 'reconciliation',
      text: 'Stav reconciliation není potvrzený.',
    });
    expect(reduceMacCompanionPresentation(dto, NOW)).toBe('unknown');
  });
});
