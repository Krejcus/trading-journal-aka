// 22. 10. 2026 (Filip): ruční obchod na leaderovi při VYPNUTÉ kopírce založil
// při exitu leadera incident „nevysvětlená divergence“ (follower zůstal flat,
// protože kopírka nic nekopírovala) a další Zapnout pak vyžadovalo potvrzení.
// Za vypnuté kopírky to má být jen audit + nová Kontrola pozic.
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';

const symbol = 'MNQZ6';
const group = (): CopyGroupConfig => ({
  id: 'manual-leader', name: 'Origoš', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }], localOnly: true,
});

const leaderOrder = (id: string, patch: Partial<BrokerOrder>): BrokerOrder => ({
  tag: '', brokerOrderId: id, accountId: 100, symbol, side: 'Sell', orderType: 'Market', quantity: 20,
  filledQuantity: 0, status: 'working', sourceVersion: '1', updatedAt: 100, ...patch,
});

async function leaderRoundTrip(broker: MockBroker, controller: CopierRuntimeController) {
  broker.emitEvent({ type: 'order', order: leaderOrder('entry', {}) });
  broker.emitEvent({ type: 'fill', fill: { fillId: 'e', tag: '', brokerOrderId: 'entry', accountId: 100,
    symbol, side: 'Sell', quantity: 20, price: 29_800, filledAt: 1 } });
  broker.setPosition(100, symbol, -20);
  broker.emitEvent({ type: 'position', position: { accountId: 100, symbol, netQuantity: -20 } });
  await controller.waitForIdle();
  broker.emitEvent({ type: 'order', order: leaderOrder('exit', { side: 'Buy' }) });
  await controller.waitForIdle();
  broker.emitEvent({ type: 'fill', fill: { fillId: 'x', tag: '', brokerOrderId: 'exit', accountId: 100,
    symbol, side: 'Buy', quantity: 20, price: 29_850, filledAt: 2 } });
  broker.setPosition(100, symbol, 0);
  broker.emitEvent({ type: 'position', position: { accountId: 100, symbol, netQuantity: 0 } });
  await controller.waitForIdle();
}

describe('ruční obchod leadera za vypnuté kopírky', () => {
  let controller: CopierRuntimeController | null = null;
  afterEach(() => { controller?.stop(); controller = null; });

  it('nezaloží incident; další zapnutí jen potřebuje novou Kontrolu pozic', async () => {
    let now = 1_000;
    const audits: string[] = [];
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: group(), clock: () => ++now,
      onAudit: entries => { for (const entry of entries) audits.push(entry.reason ?? entry.kind); },
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    expect(controller.status().armed).toBe(false);

    await leaderRoundTrip(broker, controller);

    expect(controller.status().manualRecovery).toBeNull();
    expect(controller.status().lastError).toBeNull();
    expect(controller.status().armPreparation?.manualRecoveryRequired).not.toBe(true);
    expect(audits.some(reason => reason.includes('před leader exitem')
      && reason.includes('DISARMED audit nezměnil poslední příčinu vypnutí'))).toBe(true);
    expect(controller.status().lastDisarm?.trigger ?? null).not.toBe('fail-closed');
    expect(broker.placedRequests()).toEqual([]);
    // Zapnutí po čisté kontrole projde bez potvrzování incidentu.
    const check = await controller.reconcile();
    expect(check.authoritativelyClean).toBe(true);
    controller.arm();
    expect(controller.status().armed).toBe(true);
  });

  it('za zapnuté kopírky zůstává divergence před exitem incidentem', async () => {
    let now = 1_000;
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: group(), clock: () => ++now,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    // Follower drží cizí pozici → před exitem leadera nesedí.
    broker.setPosition(200, symbol, 3);
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol, netQuantity: 3 } });
    await controller.waitForIdle();
    await leaderRoundTrip(broker, controller);
    expect(controller.status().armed).toBe(false);
    expect(controller.status().manualRecovery).not.toBeNull();
  });

  for (const receivedBeforeOff of [true, false]) {
    it(`exit přijatý ${receivedBeforeOff ? 'před' : 'po'} OFF: ${receivedBeforeOff ? 'incident (byl ARMED)' : 'jen audit'}`, async () => {
      let now = 1_000;
      const audits: string[] = [];
      const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
      controller = await bootstrapCopierRuntime({
        broker, store: createMemoryCopierStore(), group: group(), clock: () => ++now,
        onAudit: entries => { for (const entry of entries) audits.push(entry.reason ?? entry.kind); },
      });
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      // Follower drží cizí pozici → před exitem leadera nesedí.
      broker.setPosition(200, symbol, 3);
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol, netQuantity: 3 } });
      broker.emitEvent({ type: 'order', order: leaderOrder('entry', {}) });
      broker.emitEvent({ type: 'fill', fill: { fillId: 'e', tag: '', brokerOrderId: 'entry', accountId: 100,
        symbol, side: 'Sell', quantity: 20, price: 29_800, filledAt: 1 } });
      broker.setPosition(100, symbol, -20);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol, netQuantity: -20 } });
      await controller.waitForIdle();
      expect(controller.status().manualRecovery).toBeNull();
      const receivedWhileArmed = now;
      controller.disarm();
      const receivedAt = receivedBeforeOff ? receivedWhileArmed : now + 1_000;
      now += 2_000;
      broker.emitEvent({ type: 'order', order: leaderOrder('exit', { side: 'Buy' }), receivedAt } as never);
      await controller.waitForIdle();
      if (receivedBeforeOff) {
        expect(controller.status().manualRecovery).not.toBeNull();
      } else {
        expect(controller.status().manualRecovery).toBeNull();
        expect(audits.some(reason => reason.includes('DISARMED audit nezměnil poslední příčinu vypnutí'))).toBe(true);
      }
    });
  }
});

