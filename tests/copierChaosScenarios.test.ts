import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
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

describe('fail-closed za živého ARM: auto-zavření kopií', () => {
  const followersGroup: CopyGroupConfig = {
    ...group,
    safety: { ...DEFAULT_COPY_GROUP_SAFETY, armExpiryFlatten: 'followers' },
  };

  it('kritická chyba uprostřed obchodu zavře followery; leadera se nedotkne', async () => {
    // Vstup (Market) projde a otevře follower pozici; druhá kopie (Limit)
    // dostane reject -> fail-closed. Zavírací Market flatten musí projít.
    const broker = createMockBroker({
      behavior: request => request.orderType === 'Limit'
        ? { kind: 'reject', reason: 'Simulovaný broker reject' }
        : { kind: 'fill', price: 20_000 },
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: followersGroup,
      clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    broker.emitEvent({ type: 'order', order: leaderOrder() });
    await controller.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(1);

    broker.emitEvent({
      type: 'order',
      order: leaderOrder({ brokerOrderId: 'leader-2', orderType: 'Limit', limitPrice: 19_900, sourceVersion: '2:Working' }),
    });
    await controller.waitForIdle();

    const status = controller.status();
    expect(status.armed).toBe(false);
    expect(status.lastError).toBeTruthy();
    expect(status.autoClose).toMatchObject({
      trigger: 'fail-closed', scope: 'followers', flat: true, submittedClosures: 1,
    });
    // Poslední odeslaný příkaz je risk-redukující close: opačná strana,
    // přesně |pozice|, jen follower účet.
    const close = broker.placedRequests().at(-1);
    expect(close).toMatchObject({ accountId: 200, side: 'Sell', quantity: 2, orderType: 'Market' });
    expect(broker.placedRequests().every(request => request.accountId !== 100)).toBe(true);
    controller.stop();
  });

  it('výpadek transportu auto-zavření nespouští — bez spojení nejde zavírat', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: followersGroup,
      clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    broker.emitEvent({ type: 'order', order: leaderOrder() });
    await controller.waitForIdle();
    const placedBefore = broker.placedRequests().length;

    broker.emitEvent({ type: 'error', error: new Error('Tradovate WebSocket transport error'), at: 900 });
    await controller.waitForIdle();
    expect(controller.status().armed).toBe(false);
    expect(controller.status().autoClose).toBeNull();
    expect(broker.placedRequests()).toHaveLength(placedBefore);
    controller.stop();
  });

  it('fail-closed bez otevřené pozice nic neposílá', async () => {
    const broker = createMockBroker({
      behavior: () => ({ kind: 'reject', reason: 'Simulovaný broker reject' }),
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: followersGroup,
      clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    broker.emitEvent({ type: 'order', order: leaderOrder() });
    await controller.waitForIdle();

    expect(controller.status().armed).toBe(false);
    expect(controller.status().autoClose).toBeNull();
    controller.stop();
  });
});

describe('connection recovery podle stavu (výpadek spojení / pád Macu)', () => {
  const recoveryGroup: CopyGroupConfig = {
    ...group,
    safety: { ...DEFAULT_COPY_GROUP_SAFETY, armExpiryFlatten: 'followers' },
  };

  const openCopy = async (broker: ReturnType<typeof createMockBroker>, controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>) => {
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    broker.emitEvent({ type: 'order', order: leaderOrder() });
    await controller.waitForIdle();
    expect(broker.placedRequests().filter(request => request.accountId === 200)).toHaveLength(1);
  };

  it('synchronní kopie po reconnectu DRŽÍ, nabídne ARM a nic neposílá', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({
      broker, store, group: recoveryGroup, clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    await openCopy(broker, controller);
    // Leader má u brokera stejnou pozici jako kopie (2 kontrakty).
    await broker.placeOrder({
      tag: 'seed-leader', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 2, orderType: 'Market',
    });
    const placedBefore = broker.placedRequests().length;

    broker.setConnected(false);
    await controller.waitForIdle();
    broker.setConnected(true);
    await controller.waitForIdle();

    const status = controller.status();
    expect(broker.placedRequests()).toHaveLength(placedBefore);
    expect(status.resumeOffer).not.toBeNull();
    expect(status.autoClose).toBeNull();
    expect(status.armed).toBe(false);
    // Recovery už udělalo autoritativní reconciliation — ARM je jeden klik.
    expect(() => controller.arm()).not.toThrow();
    expect(controller.status().resumeOffer).toBeNull();
    controller.stop();
  });

  it('osiřelé kopie (leader mezitím flat) se po reconnectu risk-redukčně zavřou', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: recoveryGroup, clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    await openCopy(broker, controller);

    broker.setConnected(false);
    await controller.waitForIdle();
    broker.setConnected(true);
    await controller.waitForIdle();

    const status = controller.status();
    expect(status.autoClose).toMatchObject({ trigger: 'reconnect', flat: true, submittedClosures: 1 });
    expect(status.resumeOffer).toBeNull();
    const close = broker.placedRequests().at(-1);
    expect(close).toMatchObject({ accountId: 200, side: 'Sell', quantity: 2, orderType: 'Market' });
    controller.stop();
  });

  it('boot po pádu Macu: durable stopa spustí recovery a osiřelé kopie zavře bez ARM', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
    // Kopie existuje u brokera, leader je flat — worker mezitím ležel.
    await broker.placeOrder({
      tag: 'seed-follower', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 2, orderType: 'Market',
    });
    const store = createMemoryCopierStore({
      ...emptySnapshot(),
      safety: { entryCooldownUntil: 0, dayLockUntil: 0, liveCopyOpenSince: 50 },
    });
    const controller = await bootstrapCopierRuntime({
      broker, store, group: recoveryGroup, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    const status = controller.status();
    expect(status.autoClose).toMatchObject({ trigger: 'reconnect', flat: true });
    expect(broker.placedRequests().at(-1)).toMatchObject({ accountId: 200, side: 'Sell', quantity: 2 });
    expect((await store.load()).safety?.liveCopyOpenSince).toBeUndefined();
    controller.stop();
  });

  it('ruční DISARM smaže durable stopu — boot recovery držené pozice nezavírá', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
    const store = createMemoryCopierStore();
    const first = await bootstrapCopierRuntime({
      broker, store, group: recoveryGroup, clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    await openCopy(broker, first);
    expect((await store.load()).safety?.liveCopyOpenSince).toBeDefined();

    first.disarm();
    await first.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await store.load()).safety?.liveCopyOpenSince).toBeUndefined();
    first.stop();

    const placedBefore = broker.placedRequests().length;
    const restarted = await bootstrapCopierRuntime({
      broker, store, group: recoveryGroup, clock: stepClock(),
    });
    broker.setConnected(true);
    await restarted.waitForIdle();
    expect(broker.placedRequests()).toHaveLength(placedBefore);
    expect(restarted.status().autoClose).toBeNull();
    restarted.stop();
  });
});
