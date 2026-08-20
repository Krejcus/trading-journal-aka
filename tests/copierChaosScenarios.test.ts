import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

/**
 * Chaos scénáře: co udělá copier, když svět umře v nejhorší moment.
 *
 * Nejde o unit testy jednotlivých modulů (ty existují vedle), ale o
 * end-to-end důkazy invariantů celého runtime:
 *  1. pád workeru uprostřed odeslání NIKDY nevede k duplicitní objednávce,
 *  2. nejasný osud objednávky VŽDY skončí fail-closed + viditelná stuck
 *     operace, nikdy tichý retry,
 *  3. výpadek WS okamžitě odzbrojí a po reconnectu se bez reconciliation
 *     nic neodešle.
 */

const group: CopyGroupConfig = {
  id: 'chaos', name: 'Chaos', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
  safety: { ...DEFAULT_COPY_GROUP_SAFETY },
};

const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-1', accountId: 100, symbol: 'MNQU6', side: 'Buy',
  orderType: 'Market', quantity: 2, filledQuantity: 0,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...partial,
});

const stepClock = () => {
  let value = 100;
  return () => ++value;
};

describe('chaos: pád workeru uprostřed odeslání', () => {
  it('odpověď se ztratí PO přijetí u brokera → restart dohledá, nikdy nepošle podruhé', async () => {
    // 1. pokus: objednávka u brokera existuje, ale odpověď zemřela s procesem.
    const broker = createMockBroker({
      behavior: (_request, attempt) => attempt === 1
        ? { kind: 'timeout-after-accept' }
        : { kind: 'working' },
    });
    const store = createMemoryCopierStore();
    const first = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await first.waitForIdle();
    await first.reconcile();
    first.arm();
    broker.emitEvent({ type: 'order', order: leaderOrder() });
    await first.waitForIdle();

    // Nejasný konec = fail-closed + stuck operace. Žádný slepý retry.
    expect(broker.placedRequests()).toHaveLength(1);
    const firstStatus = first.status();
    expect(firstStatus.armed).toBe(false);
    expect(firstStatus.stuckOutbox).toBe(true);
    expect(firstStatus.stuckOperations[0]).toMatchObject({ kind: 'place', accountId: 200 });
    // „Worker umřel": stop bez úklidu, durable snapshot zůstává ve store.
    first.stop();

    // Restart: recovery dohledá objednávku podle tagu — acknowledged,
    // placeOrder se NEvolá podruhé.
    const restarted = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await restarted.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(1);
    expect(restarted.status().stuckOutbox).toBe(false);
    expect(restarted.status().armed).toBe(false);
    restarted.stop();
  });

  it('broker vidí dvě objednávky se stejným tagem → abandoned, nikdy třetí pokus', async () => {
    // Nejhorší scénář neidempotentního brokera: retry před pádem prošel
    // dvakrát. Recovery to musí poznat a vzdát se — ne „vybrat jednu".
    const broker = createMockBroker({
      behavior: () => ({ kind: 'timeout-after-accept' }),
    });
    const store = createMemoryCopierStore();
    const first = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await first.waitForIdle();
    await first.reconcile();
    first.arm();
    broker.emitEvent({ type: 'order', order: leaderOrder() });
    await first.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(1);
    // Simulace duplicitního odeslání „před pádem": druhá objednávka se
    // stejným tagem vznikla u brokera mimo náš outbox zápis.
    const sentRequest = broker.placedRequests()[0];
    await broker.placeOrder({ ...sentRequest }).catch(() => undefined);
    expect(broker.placedRequests()).toHaveLength(2);
    first.stop();

    const restarted = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await restarted.waitForIdle();
    // Duplicita je terminální nejasnost: abandoned + stuck, žádný další send.
    expect(broker.placedRequests()).toHaveLength(2);
    const status = restarted.status();
    expect(status.stuckOutbox).toBe(true);
    expect(status.stuckOperations[0]).toMatchObject({ kind: 'place', status: 'abandoned' });
    expect(() => restarted.arm()).toThrow();
    restarted.stop();
  });
});

describe('chaos: výpadek WebSocket spojení', () => {
  it('disconnect uprostřed ARMED okamžitě odzbrojí; reconnect bez reconciliation nic nepustí', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    expect(controller.status().armed).toBe(true);

    broker.setConnected(false);
    await controller.waitForIdle();
    expect(controller.status()).toMatchObject({ armed: false, connected: false });

    // Reconnect sám o sobě ARM nevrací a leader event nesmí nic odeslat.
    broker.setConnected(true);
    broker.emitEvent({ type: 'order', order: leaderOrder({ brokerOrderId: 'leader-2', sourceVersion: '2:Working' }) });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(0);
    expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    expect(() => controller.arm()).toThrow();

    // Teprve autoritativní reconciliation otevírá cestu k novému ARM.
    await controller.reconcile();
    controller.arm();
    expect(controller.status().armed).toBe(true);
    controller.stop();
  });

  it('transportní chyba uprostřed zpracování failne zavřeně a je vidět v lastError', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'error', error: new Error('Tradovate WebSocket transport error'), at: 500 });
    await controller.waitForIdle();
    expect(controller.status()).toMatchObject({ armed: false, connected: false });
    expect(controller.status().lastError).toContain('transport');
    controller.stop();
  });
});
