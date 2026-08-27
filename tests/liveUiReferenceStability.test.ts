import { describe, expect, it } from 'vitest';
import {
  preserveAgentStatusReference,
  type LocalCopierAgentStatus,
} from '../lib/localCopierAgentProtocol';
import {
  mergeCopyGroupsPreservingReference,
  type CopyGroupConfig,
} from '../services/liveCopyTrading';
import type { LiveSnapshot } from '../services/tradecopiaLiveService';

// 2s poll agent statusu i 2s P&L snapshot vrací pokaždé nové objekty.
// Tyhle testy hlídají, že se při obsahové shodě zachová původní reference —
// jinak se vrátí prázdné kaskády re-renderů a localStorage zápisů.

const agentStatus = (): LocalCopierAgentStatus => ({
  version: 1,
  environment: 'demo',
  nonce: 'session-nonce',
  startedAt: '2026-08-27T10:00:00.000Z',
  group: {
    id: 'agent-1-2',
    name: 'Lokální DEMO agent',
    enabled: true,
    leaderAccountId: 1,
    followers: [{ accountId: 2, mode: 'on-submit', multiplier: 1 }],
  },
  controller: {
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
    revision: 7,
    lastSequence: 42,
  },
});

describe('preserveAgentStatusReference', () => {
  it('keeps the previous reference when a poll returns identical content', () => {
    const previous = agentStatus();
    expect(preserveAgentStatusReference(previous, agentStatus())).toBe(previous);
  });

  it('adopts a status whose content actually changed', () => {
    const previous = agentStatus();
    const next = agentStatus();
    next.controller.armed = false;
    expect(preserveAgentStatusReference(previous, next)).toBe(next);
  });

  it('handles transitions from and to a missing agent', () => {
    const status = agentStatus();
    expect(preserveAgentStatusReference(null, status)).toBe(status);
    expect(preserveAgentStatusReference(status, null)).toBeNull();
    expect(preserveAgentStatusReference(null, null)).toBeNull();
  });
});

describe('mergeCopyGroupsPreservingReference', () => {
  const snapshot = {
    groups: [],
    accounts: [{ id: 1 }, { id: 2 }],
  } as unknown as LiveSnapshot;
  const groups = (): CopyGroupConfig[] => [{
    id: 'agent-1-2',
    name: 'Lokální DEMO agent',
    enabled: true,
    leaderAccountId: 1,
    followers: [{ accountId: 2, mode: 'on-submit', multiplier: 1 }],
    localOnly: true,
  }];

  it('keeps the previous reference for a content-identical 2s snapshot', () => {
    const current = groups();
    expect(mergeCopyGroupsPreservingReference(current, snapshot, null)).toBe(current);
    expect(mergeCopyGroupsPreservingReference(current, snapshot, groups()[0])).toBe(current);
  });

  it('returns a new array when the runtime group actually changed', () => {
    const current = groups();
    const runtime = groups()[0];
    runtime.followers = [{ accountId: 2, mode: 'on-submit', multiplier: 2 }];
    const next = mergeCopyGroupsPreservingReference(current, snapshot, runtime);
    expect(next).not.toBe(current);
    expect(next[0].followers[0].multiplier).toBe(2);
  });
});
