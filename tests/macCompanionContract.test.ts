import { describe, expect, it } from 'vitest';

import {
  MAC_COMPANION_CONTRACT_VERSION,
  macCompanionFreshness,
  reduceMacCompanionPresentation,
  type MacCompanionStatusDTO,
} from '../lib/macCompanionContract';

const OBSERVED = Date.parse('2026-09-01T10:00:00.000Z');

const status = (overrides: Partial<MacCompanionStatusDTO> = {}): MacCompanionStatusDTO => ({
  contractVersion: MAC_COMPANION_CONTRACT_VERSION,
  serverTime: new Date(OBSERVED).toISOString(),
  revision: OBSERVED,
  observedAt: new Date(OBSERVED).toISOString(),
  validUntil: new Date(OBSERVED + 10_000).toISOString(),
  freshness: { verifiedMaxAgeSeconds: 10, offlineAfterSeconds: 90 },
  copierState: 'live',
  sessionExpiresAt: null,
  worker: { lastHeartbeatAt: new Date(OBSERVED).toISOString(), location: 'mac' },
  brokerConnected: true,
  safety: {
    reconciliation: { status: 'clean', at: null },
    divergences: [],
    outbox: { stuckCount: 0, oldestStuckMinutes: null },
    cooldownActive: false,
    dayLockActive: false,
    killSwitchTripped: false,
  },
  exposure: {
    verifiedAt: null,
    positions: [],
    followerAck: null,
    accountsWithWorkingOrders: null,
  },
  snapshots: { cdpReady: false, lastEntryAt: null, lastExitAt: null },
  problems: [],
  ...overrides,
});

describe('mac companion contract reducer', () => {
  it('keeps additive dayLock and dailyRules fields optional in contract v1', () => {
    const legacy = status();
    expect(legacy.contractVersion).toBe(1);
    expect('dayLock' in legacy).toBe(false);
    expect('dailyRules' in legacy).toBe(false);
    expect(reduceMacCompanionPresentation(legacy, OBSERVED)).toBe('unknown');
  });

  it('uses the exact 10 second and 90 second freshness boundaries', () => {
    const dto = status();
    expect(macCompanionFreshness(dto, OBSERVED + 10_000)).toBe('verified');
    expect(macCompanionFreshness(dto, OBSERVED + 10_001)).toBe('unknown');
    expect(macCompanionFreshness(dto, OBSERVED + 90_000)).toBe('unknown');
    expect(macCompanionFreshness(dto, OBSERVED + 90_001)).toBe('worker-offline');
  });

  it('lets stale data override the last known live or problem state', () => {
    const dto = status({
      problems: [{ kind: 'divergence', text: 'stará divergence' }],
    });
    expect(reduceMacCompanionPresentation(dto, OBSERVED + 10_001)).toBe('unknown');
    expect(reduceMacCompanionPresentation(dto, OBSERVED + 90_001)).toBe('worker-offline');
  });

  it('keeps malformed/unknown safety amber before considering issue rows', () => {
    const base = status();
    const dto = status({
      safety: {
        ...base.safety,
        reconciliation: { status: 'unknown', at: null },
      },
      problems: [{ kind: 'reconciliation', text: 'Stav není potvrzený.' }],
    });
    expect(reduceMacCompanionPresentation(dto, OBSERVED)).toBe('unknown');
  });

  it('keeps confirmed fresh safety problems red even when broker connectivity is unknown', () => {
    const base = status();
    const divergence = status({
      brokerConnected: null,
      safety: {
        ...base.safety,
        reconciliation: { status: 'unknown', at: null },
        divergences: [{ symbol: null, account: 'Follower 1', detail: 'Pozice se liší.' }],
      },
      problems: [{ kind: 'divergence', text: 'Jeden účet má rozdílnou pozici.' }],
    });
    const killSwitch = status({
      brokerConnected: null,
      safety: {
        ...base.safety,
        reconciliation: { status: 'unknown', at: null },
        killSwitchTripped: true,
      },
      problems: [{ kind: 'reconciliation', text: 'Stav není potvrzený.' }],
    });

    expect(reduceMacCompanionPresentation(divergence, OBSERVED)).toBe('intervention');
    expect(reduceMacCompanionPresentation(killSwitch, OBSERVED)).toBe('intervention');
  });

  it('keeps a fresh unknown reconciliation amber when no concrete problem exists', () => {
    const base = status();
    const dto = status({
      brokerConnected: null,
      safety: {
        ...base.safety,
        reconciliation: { status: 'unknown', at: null },
      },
      problems: [{ kind: 'reconciliation', text: 'Stav není potvrzený.' }],
    });
    expect(reduceMacCompanionPresentation(dto, OBSERVED)).toBe('unknown');
  });

  it('keeps stale precedence over a confirmed divergence', () => {
    const base = status();
    const dto = status({
      brokerConnected: null,
      safety: {
        ...base.safety,
        reconciliation: { status: 'unknown', at: null },
        divergences: [{ symbol: null, account: 'Follower 1', detail: 'Pozice se liší.' }],
      },
      problems: [{ kind: 'divergence', text: 'Jeden účet má rozdílnou pozici.' }],
    });
    expect(reduceMacCompanionPresentation(dto, OBSERVED + 10_001)).toBe('unknown');
    expect(reduceMacCompanionPresentation(dto, OBSERVED + 90_001)).toBe('worker-offline');
  });

  it('presents DISARMED only from a complete authoritative flat snapshot', () => {
    const base = status();
    const verifiedAt = new Date(OBSERVED).toISOString();
    expect(reduceMacCompanionPresentation(status({ copierState: 'disarmed' }), OBSERVED)).toBe('unknown');
    expect(reduceMacCompanionPresentation(status({
      copierState: 'disarmed',
      exposure: {
        ...base.exposure,
        verifiedAt,
        accountsWithWorkingOrders: null,
      },
    }), OBSERVED)).toBe('unknown');
    expect(reduceMacCompanionPresentation(status({
      copierState: 'disarmed',
      exposure: {
        ...base.exposure,
        verifiedAt,
        accountsWithWorkingOrders: 0,
      },
    }), OBSERVED)).toBe('disarmed');
  });

  it('escalates authoritative non-flat exposure while DISARMED', () => {
    const base = status();
    const verifiedAt = new Date(OBSERVED).toISOString();
    const position = {
      symbol: 'MNQ',
      side: 'long' as const,
      qty: 1,
      at: verifiedAt,
    };
    expect(reduceMacCompanionPresentation(status({
      copierState: 'disarmed',
      exposure: {
        ...base.exposure,
        verifiedAt,
        positions: [position],
        accountsWithWorkingOrders: 0,
      },
    }), OBSERVED)).toBe('intervention');
    expect(reduceMacCompanionPresentation(status({
      copierState: 'disarmed',
      exposure: {
        ...base.exposure,
        verifiedAt,
        accountsWithWorkingOrders: 1,
      },
    }), OBSERVED)).toBe('intervention');
  });

  it('escalates incomplete LIVE acknowledgements but keeps a complete ack LIVE', () => {
    const base = status();
    const sessionExpiresAt = new Date(OBSERVED + 60_000).toISOString();
    const withAck = (
      confirmed: number,
      failing: NonNullable<MacCompanionStatusDTO['exposure']['followerAck']>['failing'],
    ) => status({
      sessionExpiresAt,
      exposure: {
        ...base.exposure,
        followerAck: { confirmed, total: 20, failing },
      },
    });

    expect(reduceMacCompanionPresentation(withAck(19, []), OBSERVED)).toBe('intervention');
    expect(reduceMacCompanionPresentation(withAck(20, [{
      account: 'Follower 1',
      detail: 'ENTRY nepotvrzeno',
      sinceMinutes: 1,
    }]), OBSERVED)).toBe('intervention');
    expect(reduceMacCompanionPresentation(withAck(20, []), OBSERVED)).toBe('live');
  });

  it('rejects future heartbeat evidence instead of preserving LIVE', () => {
    expect(macCompanionFreshness(status(), OBSERVED - 1)).toBe('unknown');
  });
});
