import { describe, expect, it } from 'vitest';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';

const group = (): CopyGroupConfig => ({
  id: 'preflight-disarmed', name: 'Preflight', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
});

async function bootWithoutReconcile() {
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(), group: group(),
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  return { broker, controller };
}

// 29. 9. 2026 po nasazení: změna skupiny nechala runtime DISARMED
// s požadovanou reconciliation a každý ARM z UI (posílá i konfiguraci
// skupiny) spadl v preflightu dřív, než stihl reconciliation sám provést.
describe('preflight změny skupiny za DISARMED s čekající reconciliation', () => {
  it('za DISARMED neblokuje změnu konfigurace, ARM cesta pak reconciliation provede', async () => {
    const { controller } = await bootWithoutReconcile();
    try {
      await controller.reconcile();
      const withSecondFollower: CopyGroupConfig = {
        ...group(),
        followers: [...group().followers, { accountId: 300, mode: 'on-submit', multiplier: 1 }],
      };
      await controller.reconfigureGroup(withSecondFollower);
      expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
      expect(() => controller.preflightGroupChange(withSecondFollower)).not.toThrow();
      await controller.reconcile();
      expect(controller.status().reconciliationRequired).toBe(false);
    } finally {
      controller.stop();
    }
  });
});
