import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import LiveAccountRiskTable, {
  accountRiskLimitDraftsFromGroup,
  validateAccountRiskLimits,
} from '../components/LiveAccountRiskTable';
import LiveRiskSummaryCard from '../components/LiveRiskSummaryCard';
import { isWeakerRiskConfig } from '../lib/copierRiskConfig';
import { assertCopierRiskConfigAcknowledged, COPIER_RISK_CONFIG_CAPABILITY } from '../lib/copierWorkerCapabilities';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import { bootstrapCopierRuntime, type CopierControllerStatus } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import { DEFAULT_COPY_GROUP_SAFETY, sanitizeCopyGroups, type CopyGroupConfig } from '../services/liveCopyTrading';
import { enqueueTradovateCopierCommand } from '../server/tradovateCopierCommandRelay';

const NOW = Date.parse('2026-09-08T14:00:00.000Z');
const group = (): CopyGroupConfig => ({
  id: 'detailed-risk-review', name: 'Review', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
  safety: structuredClone(DEFAULT_COPY_GROUP_SAFETY),
});

const controllerStatus = (patch: Partial<CopierControllerStatus> = {}): CopierControllerStatus => ({
  started: true, armed: true, killSwitch: false, shadowMode: false, connected: true,
  reconciliationRequired: false, divergentAccounts: [], workingOrderAccounts: [],
  stuckOutbox: false, stuckOperations: [], lastError: null, revision: 1, lastSequence: 1,
  ...patch,
});

describe('detailed copier risk contracts', () => {
  it.each(['breached', 'dll-locked', 'unverifiable'] as const)(
    'does not label a runtime-excluded %s follower as copying', state => {
      const html = renderToStaticMarkup(React.createElement(LiveAccountRiskTable, {
        group: group(), accounts: [], runtimeAvailable: true, riskConfigSupported: true, now: NOW,
        status: controllerStatus({ accountEligibility: [{ accountId: 300, state, at: NOW, reason: 'Excluded by worker' }] }),
      }));
      const row = html.match(/<tr[^>]*data-account-id="300"[^>]*>[\s\S]*?<\/tr>/)?.[0];
      expect(row).toBeDefined();
      expect(row).not.toContain('data-account-risk-state="copying"');
      expect(row).not.toContain('>Kopíruje<');
    },
  );

  it.each(['breached', 'dll-locked', 'unverifiable'] as const)(
    'excludes a runtime %s follower from the actively copying count', state => {
      const html = renderToStaticMarkup(React.createElement(LiveRiskSummaryCard, {
        group: group(), runtimeAvailable: true, riskConfigSupported: true, now: NOW,
        status: controllerStatus({ accountEligibility: [{ accountId: 300, state, at: NOW, reason: 'Excluded by worker' }] }),
      }));
      expect(html).toContain('1/2 účtů kopíruje');
      expect(html).not.toContain('2/2 účtů kopíruje');
    },
  );

  it('accepts legacy disabled loss-cut values through UI validation and worker acknowledgement', () => {
    const requested = group();
    requested.followers[0].dailyLossCutUsd = 0;
    const validation = validateAccountRiskLimits({
      group: requested, drafts: accountRiskLimitDraftsFromGroup(requested), sessionArmedAt: NOW,
    });
    expect(validation.errors).toEqual([]);
    const returned = sanitizeCopyGroups([{ ...requested, followers: validation.followers }])![0];
    const ack: LocalCopierAgentStatus = {
      version: 1, capabilities: [COPIER_RISK_CONFIG_CAPABILITY], environment: 'demo',
      nonce: 'test-only', startedAt: new Date(NOW).toISOString(), group: returned, controller: controllerStatus(),
    };
    expect(() => assertCopierRiskConfigAcknowledged(requested, ack)).not.toThrow();
    expect(returned.followers[0].dailyLossCutUsd).toBeUndefined();
    expect(returned.followers[0].maxContracts).toBeUndefined();
  });

  it('does not invent verified account eligibility for a legacy worker', () => {
    const status = controllerStatus();
    const table = renderToStaticMarkup(React.createElement(LiveAccountRiskTable, {
      group: group(), accounts: [], runtimeAvailable: true, riskConfigSupported: true, now: NOW, status,
    }));
    const summary = renderToStaticMarkup(React.createElement(LiveRiskSummaryCard, {
      group: group(), runtimeAvailable: true, riskConfigSupported: true, now: NOW, status,
    }));
    expect(table).toContain('Způsobilost neověřena');
    expect(table).not.toContain('data-account-risk-state="copying"');
    expect(summary).toContain('Způsobilost účtů neověřena');
    expect(summary).not.toContain('účtů kopíruje');
  });

  it('shows applied risk utilization while a different loss limit remains an unsaved draft', async () => {
    const configured = group();
    configured.followers[0].dailyLossCutUsd = 500;
    const drafts = accountRiskLimitDraftsFromGroup(configured);
    drafts['200'].dailyLossCutUsd = '1000';
    vi.resetModules();
    vi.doMock('react', async importOriginal => {
      const actual = await importOriginal<typeof import('react')>();
      let firstState = true;
      return {
        ...actual,
        useState: (initial: unknown) => {
          if (firstState) {
            firstState = false;
            return [drafts, () => undefined];
          }
          return actual.useState(initial);
        },
      };
    });
    try {
      const { default: DraftRiskTable } = await import('../components/LiveAccountRiskTable');
      const html = renderToStaticMarkup(React.createElement(DraftRiskTable, {
        group: configured, accounts: [], runtimeAvailable: true, riskConfigSupported: true, now: NOW,
        status: controllerStatus({ accountEligibility: [] }), brokerDailyPnlByAccount: { 200: -400 },
      }));
      const row = html.match(/<tr[^>]*data-account-id="200"[^>]*>[\s\S]*?<\/tr>/)?.[0];
      expect(row).toContain('value="1000"');
      expect(row).toContain('data-progress-value="80"');
      expect(row).toContain('bg-amber-500');
      expect(row).toContain('80 % limitu');
    } finally {
      vi.doUnmock('react');
      vi.resetModules();
    }
  });

  it.each([
    ['paused', { pause: { at: NOW, until: NOW + 60_000, rule: 'max-trades' as const } }],
    ['locked', { dayLockUntil: NOW + 60_000 }],
  ] as const)('preserves %s presentation ahead of account eligibility', (state, patch) => {
    const html = renderToStaticMarkup(React.createElement(LiveAccountRiskTable, {
      group: group(), accounts: [], runtimeAvailable: true, riskConfigSupported: true, now: NOW,
      status: controllerStatus({ ...patch, accountEligibility: [{ accountId: 300, state: 'breached', at: NOW }] }),
    }));
    expect(html).toContain(`data-account-id="300" data-account-risk-state="${state}"`);
    expect(html).not.toContain('>Kopíruje<');
  });

  it('classifies a timezone shift that extends the trading window as weakening', () => {
    const previous = group();
    previous.safety!.tradingWindow = { enabled: true, from: '15:30', to: '17:00', timeZone: 'Europe/Prague' };
    const next = structuredClone(previous);
    // On this September date, this extends the UTC end from 15:00 to 17:00.
    next.safety!.tradingWindow.timeZone = 'UTC';
    expect(isWeakerRiskConfig(previous, next)).toContain('safety.tradingWindow.timeZone');
  });

  it('permits canonical timezone aliases and changes to a disabled window', () => {
    const previous = group();
    previous.safety!.tradingWindow = { enabled: true, from: '15:30', to: '17:00', timeZone: 'UTC' };
    const alias = structuredClone(previous);
    alias.safety!.tradingWindow.timeZone = 'Etc/UTC';
    expect(isWeakerRiskConfig(previous, alias)).toEqual([]);

    previous.safety!.tradingWindow.enabled = false;
    const disabled = structuredClone(previous);
    disabled.safety!.tradingWindow.timeZone = 'Europe/Prague';
    expect(isWeakerRiskConfig(previous, disabled)).toEqual([]);
    const legacy = group();
    delete legacy.safety;
    expect(isWeakerRiskConfig(legacy, group())).toEqual([]);
  });

  it.each(['arm-live', 'activate-group', 'update-group'] as const)(
    'rejects the timezone extension before relay enqueue via %s', async type => {
      const previous = group();
      previous.safety!.tradingWindow = { enabled: true, from: '15:30', to: '17:00', timeZone: 'Europe/Prague' };
      const next = structuredClone(previous);
      next.safety!.tradingWindow.timeZone = 'UTC';
      const deviceId = '33333333-3333-4333-8333-333333333333';
      const deviceQuery = {
        eq: () => deviceQuery, is: () => deviceQuery, order: () => deviceQuery, limit: () => deviceQuery,
        maybeSingle: async () => ({ data: { id: deviceId }, error: null }),
      };
      const runtimeQuery = {
        eq: () => runtimeQuery,
        maybeSingle: async () => ({
          data: { status: { group: previous, controller: { sessionArmedAt: NOW } } }, error: null,
        }),
      };
      let attemptedCommandWrite = false;
      const db = { from: (table: string) => {
        if (table === 'tradovate_copier_devices') return { select: () => deviceQuery };
        if (table === 'tradovate_copier_device_runtime') return { select: () => runtimeQuery };
        attemptedCommandWrite = true;
        throw new Error('Unexpected command write in simulated relay');
      } } as unknown as Parameters<typeof enqueueTradovateCopierCommand>[0]['db'];

      await expect(enqueueTradovateCopierCommand({
        db, deviceId, userId: '11111111-1111-4111-8111-111111111111',
        connectionId: '22222222-2222-4222-8222-222222222222', now: NOW,
        idempotencyKey: `timezone-review-${type}`,
        command: type === 'update-group'
          ? { type: 'copy-command', command: { type: 'update-group', group: next } }
          : { type, group: next },
      })).rejects.toThrow('tighten-only');
      expect(attemptedCommandWrite).toBe(false);
    },
  );

  it('rejects that timezone extension after the first live ARM in a simulated runtime', async () => {
    const previous = group();
    previous.safety!.tradingWindow = { enabled: true, from: '15:30', to: '17:00', timeZone: 'Europe/Prague' };
    const broker = createMockBroker({ clock: () => NOW });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: previous, clock: () => NOW,
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      await controller.waitForIdle();
      expect(controller.status().sessionArmedAt).toBe(NOW);
      const next = structuredClone(previous);
      next.safety!.tradingWindow.timeZone = 'UTC';
      expect(() => controller.updateGroup(next)).toThrow(/dnes jen zpřísnit/);
    } finally {
      controller.stop();
    }
  });
});
