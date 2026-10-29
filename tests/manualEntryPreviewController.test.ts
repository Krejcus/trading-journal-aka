// Fáze 1a obchodování z grafu: náhled ručního vstupu ve skutečném controlleru
// kopírky (ARMED, mock broker) — nesmí sáhnout na brokera, uložit stav,
// zapsat audit ani změnit stav kopírky. Ověřeno chováním, ne grepem.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';
import { buildLeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';

const group = (): CopyGroupConfig => ({
  id: 'preview-group', name: 'Náhled', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});

describe('fáze 1a: náhled v controlleru kopírky', () => {
  let controller: CopierRuntimeController | null = null;
  afterEach(() => { controller?.stop(); controller = null; });

  it('ARMED: náhled nevolá brokera, neukládá, nepíše audit a nemění stav', async () => {
    let now = Date.UTC(2026, 9, 29, 15, 0, 0);
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const store = createMemoryCopierStore();
    const audits: unknown[] = [];
    controller = await bootstrapCopierRuntime({
      broker, store, group: group(), clock: () => now,
      onAudit: entries => { audits.push(...entries); },
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    await controller.waitForIdle();
    now += 1_000;

    // Spy na všech metodách brokera a na commitu úložiště až TEĎ (po přípravě).
    const brokerRecord = broker as unknown as Record<string, unknown>;
    const brokerSpies = Object.keys(brokerRecord)
      .filter(key => typeof brokerRecord[key] === 'function')
      .map(key => ({ key, spy: vi.spyOn(brokerRecord as Record<string, (...args: unknown[]) => unknown>, key) }));
    const commitSpy = vi.spyOn(store, 'commit');
    const auditsBefore = audits.length;
    const before = controller.status();

    const status = controller.status();
    const command = buildLeaderEntryPreviewCommand(
      { symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 29_500, stopLoss: 29_480, takeProfit: 29_560 },
      { group: { ...group(), leaderAccountId: 100 }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: 'preview:controllertest01' },
    );
    const result = controller.previewLeaderEntry(command);
    await controller.waitForIdle();

    expect(result.type).toBe('leader-entry-preview');
    expect(result.operationId).toBe('preview:controllertest01');
    for (const { key, spy } of brokerSpies) expect(spy, key).not.toHaveBeenCalled();
    expect(commitSpy).not.toHaveBeenCalled();
    expect(audits.length).toBe(auditsBefore);
    const after = controller.status();
    expect(after.revision).toBe(before.revision);
    expect(after.armed).toBe(true);
    expect(after.lastError).toBe(before.lastError);
    expect(after.accountRisk).toEqual(before.accountRisk);
  });

  it('DISARMED: náhled vrátí blocker (halt), nic nepošle a nezaloží incident', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    controller = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group: group(), clock: () => Date.UTC(2026, 9, 29, 15, 0, 0) });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    const command = buildLeaderEntryPreviewCommand(
      { symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 29_500, stopLoss: 29_480, takeProfit: 29_560 },
      { group: { ...group(), leaderAccountId: 100 }, armedAt: 0, excludedFollowers: new Set(), participation: [], operationId: 'preview:controllertest02' },
    );
    const result = controller.previewLeaderEntry(command);
    expect(result.wouldPlace).toBeNull();
    expect(result.blockers.map(issue => issue.code)).toContain('halt');
    expect(broker.placedRequests()).toEqual([]);
    expect(broker.placedOsoRequests()).toEqual([]);
    expect(controller.status().lastError).toBeNull();
    expect(controller.status().manualRecovery).toBeNull();
  });
});
