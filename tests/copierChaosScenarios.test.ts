import { describe, expect, it, vi } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import { createRuntime, processOsoPair, type CopierAuditEntry } from '../services/copierRunner';
import { createCopierState } from '../services/copierEngine';
import { createRiskGateContext } from '../services/copierRiskGate';
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

  it('synchronní kopie po reconnectu DRŽÍ DISARMED a nový ARM do flat odmítne', async () => {
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
    expect(status.resumeOffer).toBeNull();
    expect(status.autoClose).toBeNull();
    expect(status.armed).toBe(false);
    expect(() => controller.arm()).toThrow('všechny zapojené účty flat');
    expect(broker.placedRequests()).toHaveLength(placedBefore);
    controller.stop();
  });

  it('armExpiryFlatten off stále provede povinnou read-only reconciliation po reconnectu', async () => {
    const audit = vi.fn();
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
    const controller = await bootstrapCopierRuntime({
      broker,
      store: createMemoryCopierStore(),
      group: {
        ...recoveryGroup,
        safety: { ...DEFAULT_COPY_GROUP_SAFETY, armExpiryFlatten: 'off' },
      },
      clock: stepClock(),
      osoCorrelationWindowMs: 5,
      onAudit: audit,
    });
    await openCopy(broker, controller);
    await broker.placeOrder({
      tag: 'seed-leader-off', accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 2, orderType: 'Market',
    });
    const placedBefore = broker.placedRequests().length;

    broker.setConnected(false);
    await controller.waitForIdle();
    broker.setConnected(true);
    await controller.waitForIdle();

    const audits = audit.mock.calls.flatMap(call => call[0] as CopierAuditEntry[]);
    expect(audits.some(item => (
      item.leaderEventId === 'connection-recovery'
      && item.reason?.includes('synchronní s leaderem')
    ))).toBe(true);
    expect(controller.status()).toMatchObject({ armed: false, autoClose: null });
    expect(broker.placedRequests()).toHaveLength(placedBefore);
    controller.stop();
  });

  it('orphan bez durable opening epochy je po reconnectu detect-only bez broker write', async () => {
    const audit = vi.fn();
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: recoveryGroup, clock: stepClock(), osoCorrelationWindowMs: 5,
      onAudit: audit,
    });
    await openCopy(broker, controller);
    const placedBefore = broker.placedRequests().length;

    broker.setConnected(false);
    await controller.waitForIdle();
    broker.setConnected(true);
    await controller.waitForIdle();

    const status = controller.status();
    expect(status).toMatchObject({
      armed: false,
      autoClose: null,
      reconciliationRequired: true,
      divergentAccounts: [200],
    });
    expect(status.lastError).toContain('bez opening ownership se automaticky nezavírá');
    expect(status.resumeOffer).toBeNull();
    expect(broker.placedRequests()).toHaveLength(placedBefore);
    expect(broker.liquidateRequests()).toEqual([]);
    const audits = audit.mock.calls.flatMap(call => call[0] as CopierAuditEntry[]);
    expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({
      leaderEventId: 'connection-recovery',
      kind: 'blocked',
      reason: expect.stringContaining('žádný broker write'),
    })]));
    controller.stop();
  });

  it('boot s liveCopyOpenSince bez epochy orphan pouze detekuje a durable stopu zachová', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 20_000 }) });
    // Kopie existuje u brokera, leader je flat — worker mezitím ležel.
    await broker.placeOrder({
      tag: 'seed-follower', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 2, orderType: 'Market',
    });
    const store = createMemoryCopierStore({
      ...emptySnapshot(),
      safety: { entryCooldownUntil: 0, dayLockUntil: 0, liveCopyOpenSince: 50 },
    });
    const placedBefore = broker.placedRequests().length;
    const controller = await bootstrapCopierRuntime({
      broker, store, group: recoveryGroup, clock: stepClock(),
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    const status = controller.status();
    expect(status).toMatchObject({
      armed: false,
      autoClose: null,
      reconciliationRequired: true,
      divergentAccounts: [200],
    });
    expect(status.lastError).toContain('bez opening ownership se automaticky nezavírá');
    expect(broker.placedRequests()).toHaveLength(placedBefore);
    expect(broker.liquidateRequests()).toEqual([]);
    expect((await store.load()).safety?.liveCopyOpenSince).toBe(50);
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

describe('chaos: agresivní scalp', () => {
  it('4 rychlé vstupy a okamžitý flat zůstanou bez falešného fail-closed i při opožděných follower fillech', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T14:00:00.000Z'));
    let controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>> | undefined;

    try {
      const scalpGroup: CopyGroupConfig = {
        ...group,
        id: 'chaos-aggressive-scalp',
        followers: [{ accountId: 200, mode: 'on-fill', multiplier: 1 }],
      };
      const clock = () => Date.now();
      const broker = createMockBroker({
        clock,
        behavior: () => ({ kind: 'working' }),
      });
      const positions = new Map<number, number>([[100, 0], [200, 0]]);
      broker.listPositions = async accountId => [{
        accountId, symbol: 'MNQU6', netQuantity: positions.get(accountId) ?? 0,
      }];

      let fillSequence = 0;
      const venueFill = (order: BrokerOrder, quantity: number, price: number) => {
        if (order.status !== 'working' || quantity <= 0 || order.filledQuantity + quantity > order.quantity) {
          throw new Error('Test setup: venue fill vyžaduje working order a nesmí překročit quantity');
        }
        order.filledQuantity += quantity;
        order.status = order.filledQuantity === order.quantity ? 'filled' : 'working';
        order.sourceVersion = `scalp-venue-fill-${++fillSequence}`;
        order.updatedAt = clock();
        broker.emitEvent({ type: 'order', order: { ...order } });
        broker.emitEvent({
          type: 'fill',
          fill: {
            fillId: `scalp-venue-fill-${fillSequence}`,
            tag: order.tag,
            brokerOrderId: order.brokerOrderId,
            accountId: order.accountId,
            symbol: order.symbol,
            side: order.side,
            quantity,
            price,
            filledAt: clock(),
          },
        });
        const signedQuantity = order.side === 'Buy' ? quantity : -quantity;
        const netQuantity = (positions.get(order.accountId) ?? 0) + signedQuantity;
        positions.set(order.accountId, netQuantity);
        broker.emitEvent({
          type: 'position',
          position: { accountId: order.accountId, symbol: order.symbol, netQuantity },
        });
      };

      controller = await bootstrapCopierRuntime({
        broker,
        store: createMemoryCopierStore(),
        group: scalpGroup,
        clock,
        osoCorrelationWindowMs: 5,
        wait: async () => undefined,
      });
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();

      const leaderFillTimes: number[] = [];
      for (let index = 1; index <= 4; index += 1) {
        vi.advanceTimersByTime(100);
        const entry = leaderOrder({
          brokerOrderId: `scalp-leader-entry-${index}`,
          quantity: 1,
          filledQuantity: 0,
          status: 'working',
          sourceVersion: `scalp-entry-${index}:working`,
          updatedAt: clock(),
        });
        venueFill(entry, 1, 30_000 + index * 0.25);
        leaderFillTimes.push(clock());
        await controller.waitForIdle();
        expect(positions.get(100)).toBe(index);
      }

      // Market flat přijde okamžitě po čtvrtém vstupu; celý leader scalp
      // trvá výrazně méně než jednu sekundu.
      vi.advanceTimersByTime(1);
      const leaderFlat = leaderOrder({
        brokerOrderId: 'scalp-leader-flat',
        side: 'Sell',
        quantity: 4,
        filledQuantity: 0,
        status: 'working',
        sourceVersion: 'scalp-flat:working',
        updatedAt: clock(),
      });
      venueFill(leaderFlat, 4, 30_001);
      const leaderFlatAt = clock();
      await controller.waitForIdle();
      expect(positions.get(100)).toBe(0);
      expect(leaderFillTimes.slice(1).map((at, index) => at - leaderFillTimes[index])).toEqual([100, 100, 100]);
      expect(leaderFlatAt - leaderFillTimes[3]).toBe(1);
      expect(leaderFlatAt - leaderFillTimes[0]).toBeLessThan(1_000);

      const followerMarketOrders = broker.orders().filter(order =>
        order.accountId === 200 && order.orderType === 'Market');
      const followerEntries = followerMarketOrders.filter(order => order.side === 'Buy');
      const followerClose = followerMarketOrders.find(order => order.side === 'Sell');
      expect(followerEntries).toHaveLength(4);
      if (!followerClose) throw new Error('Test setup: follower close Market příkaz nebyl vytvořen');

      // Kritické pořadí: leader flat už controller plně zpracoval. Teprve
      // teď dorazí follower entry filly 0→1→2→3→4; nejsou to reverzní filly
      // ochranné nohy a nesmějí spustit nový fail-closed detektor.
      for (const [index, entry] of followerEntries.entries()) {
        vi.advanceTimersByTime(25);
        venueFill(entry, 1, 30_001.25);
        await controller.waitForIdle();
        expect(positions.get(200)).toBe(index + 1);
        expect(controller.status().armed).toBe(true);
      }
      vi.advanceTimersByTime(25);
      venueFill(followerClose, 4, 30_001);
      await controller.waitForIdle();

      const followerNetQuantity = (await broker.listPositions(200))[0]?.netQuantity ?? 0;
      expect(followerNetQuantity).toBe(0);
      expect(controller.status()).toMatchObject({
        armed: true,
        lastError: null,
        autoClose: null,
      });

      const followerMarketRequests = broker.placedRequests().filter(request =>
        request.accountId === 200 && request.orderType === 'Market');
      expect(followerMarketRequests).toHaveLength(5);
      expect(followerMarketRequests.map(request => ({
        side: request.side,
        quantity: request.quantity,
      }))).toEqual([
        { side: 'Buy', quantity: 1 },
        { side: 'Buy', quantity: 1 },
        { side: 'Buy', quantity: 1 },
        { side: 'Buy', quantity: 1 },
        { side: 'Sell', quantity: 4 },
      ]);
    } finally {
      controller?.stop();
      vi.useRealTimers();
    }
  });
});

describe('flat sweep ochranných nohou (incident 24. 8.)', () => {
  it('follower flat → jeho ochranné nohy se okamžitě zruší, i po DISARM', async () => {
    // Venue engine dnes přeasertoval follower stop na vyšší total a 980 ms
    // po dosažení flat ho vyplnil do protipozice. Sweep tohle okno zavírá:
    // flat follower nesmí mít u brokera pracující ochranu ani sekundu déle,
    // než je nutné — bez čekání na kopii leaderova cancelu.
    const broker = createMockBroker();
    const store = createMemoryCopierStore();

    // Skutečný follower OSO (entry + SL + TP) přes runner, persistovaný.
    const oso = await processOsoPair({
      pair: {
        entryOrderId: 'entry-1', stopOrderId: 'stop-1', targetOrderId: 'target-1',
        accountId: 100, symbol: 'MNQU6', entrySide: 'Buy', quantity: 2,
        entryOrderType: 'Limit', entryLimitPrice: 30_000,
        stopPrice: 29_950, targetPrice: 30_100, detectedAt: 10,
        correlation: 'inferred-window',
      },
      event: {
        id: 'oso-stop', orderId: 'stop-1', kind: 'submitted', accountId: 100,
        symbol: 'MNQU6', side: 'Sell', quantity: 2, orderType: 'Stop',
        stopPrice: 29_950, sequence: 1, receivedAt: 0,
      },
      group,
      runtime: {
        state: createCopierState(), outbox: new Map(), cancelOutbox: new Map(),
        bracketOutbox: new Map(), osoOutbox: new Map(), revision: 0,
      },
      context: {
        ...createRiskGateContext({
          armed: true, connected: true, shadowMode: false,
          brokerEnvironment: 'demo', expectedEnvironment: 'demo',
          lastHeartbeatAt: 1, maxHeartbeatAgeMs: 1_000_000, now: 1,
        }),
      },
      broker, clock: stepClock(), store,
    });
    const followerLegs = broker.orders().filter(order => order.accountId === 200 && order.status === 'working');
    expect(followerLegs.length).toBeGreaterThan(0);
    expect([...oso.runtime.osoOutbox.values()][0]?.status).toBe('acknowledged');

    // Controller startuje nad stejným store (jako po restartu workeru).
    const controller = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    // DISARM (jako dnes) a follower dosáhne flat.
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 2 } });
    await controller.waitForIdle();
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 0 } });
    await controller.waitForIdle();

    // Sweep míří jen na ochranné nohy (SL/TP). Nevyplněná vstupní limitka
    // není ochrana — o tu se stará běžný lifecycle kopírování cancelů.
    const entry = [...oso.runtime.osoOutbox.values()][0];
    const zbyleOchranne = broker.orders().filter(order =>
      order.accountId === 200
      && order.status === 'working'
      && [entry?.firstBrokerOrderId, entry?.secondBrokerOrderId].includes(order.brokerOrderId));
    expect(zbyleOchranne).toHaveLength(0);
    controller.stop();
  });

  it('terminální historie nad limitem sweepu nezpůsobí falešný DISARM po úspěšném flat', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const store = createMemoryCopierStore();
    let runtime = createRuntime(createCopierState());
    const historicalProtectiveIds: string[] = [];

    // Šest starých OSO epizod = 12 ochranných noh v durable historii.
    // Všechny jsou u brokera terminální a nesmějí se počítat jako nehotový
    // úklid nové epizody jen proto, že překročí cap šesti REST požadavků.
    for (let index = 1; index <= 6; index += 1) {
      const entryOrderId = `historical-entry-${index}`;
      const result = await processOsoPair({
        pair: {
          entryOrderId,
          stopOrderId: `historical-stop-${index}`,
          targetOrderId: `historical-target-${index}`,
          accountId: 100,
          symbol: 'MNQU6',
          entrySide: 'Buy',
          quantity: 1,
          entryOrderType: 'Limit',
          entryLimitPrice: 30_000,
          stopPrice: 29_950,
          targetPrice: 30_100,
          detectedAt: index,
          correlation: 'inferred-window',
        },
        event: {
          id: `historical-event-${index}`,
          orderId: `historical-stop-${index}`,
          kind: 'submitted',
          accountId: 100,
          symbol: 'MNQU6',
          side: 'Sell',
          quantity: 1,
          orderType: 'Stop',
          stopPrice: 29_950,
          sequence: runtime.state.lastSequence + 1,
          receivedAt: index,
        },
        group,
        runtime,
        context: createRiskGateContext({
          armed: true,
          connected: true,
          shadowMode: false,
          brokerEnvironment: 'demo',
          expectedEnvironment: 'demo',
          lastHeartbeatAt: index,
          maxHeartbeatAgeMs: 1_000_000,
          now: index,
        }),
        broker,
        clock: stepClock(),
        store,
      });
      runtime = result.runtime;
      const entry = runtime.osoOutbox.get(`oso:${group.id}:${entryOrderId}:200`);
      if (!entry?.entryBrokerOrderId || !entry.firstBrokerOrderId || !entry.secondBrokerOrderId) {
        throw new Error('Test setup: historický follower OSO nebyl potvrzen');
      }
      historicalProtectiveIds.push(entry.firstBrokerOrderId, entry.secondBrokerOrderId);
      await Promise.all([
        broker.cancelOrder(200, entry.entryBrokerOrderId),
        broker.cancelOrder(200, entry.firstBrokerOrderId),
        broker.cancelOrder(200, entry.secondBrokerOrderId),
      ]);
    }
    expect(historicalProtectiveIds).toHaveLength(12);
    expect(broker.orders().filter(order => order.accountId === 200 && order.status === 'working')).toHaveLength(0);

    const controller = await bootstrapCopierRuntime({
      broker,
      store,
      group,
      clock: stepClock(),
      osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();

    // Nová živá epizoda. Po fillu SL musí sweep zrušit jen její TP a po
    // autoritativním flat/zero-working důkazu nechat session ARMED.
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'current-entry', orderType: 'Limit', quantity: 1,
      limitPrice: 30_000, sourceVersion: 'current-entry:working',
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'current-stop', parentOrderId: 'current-entry',
      side: 'Sell', orderType: 'Stop', quantity: 1, stopPrice: 29_950,
      sourceVersion: 'current-stop:working',
    }) });
    broker.emitEvent({ type: 'order', order: leaderOrder({
      brokerOrderId: 'current-target', parentOrderId: 'current-entry',
      side: 'Sell', orderType: 'Limit', quantity: 1, limitPrice: 30_100,
      sourceVersion: 'current-target:working',
    }) });
    await controller.waitForIdle();

    const currentEntry = ((await store.load()).osoOutbox ?? [])
      .find(entry => entry.leaderEntryOrderId === 'current-entry');
    if (!currentEntry?.firstBrokerOrderId || !currentEntry.secondBrokerOrderId) {
      throw new Error('Test setup: aktuální follower OSO nebyl potvrzen');
    }
    const currentStop = broker.orders().find(order => (
      order.brokerOrderId === currentEntry.firstBrokerOrderId && order.orderType === 'Stop'
    )) ?? broker.orders().find(order => (
      order.brokerOrderId === currentEntry.secondBrokerOrderId && order.orderType === 'Stop'
    ));
    if (!currentStop) throw new Error('Test setup: aktuální follower stop nebyl nalezen');
    const currentSiblingId = currentStop.brokerOrderId === currentEntry.firstBrokerOrderId
      ? currentEntry.secondBrokerOrderId
      : currentEntry.firstBrokerOrderId;

    broker.emitEvent({
      type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 1 },
    });
    currentStop.status = 'filled';
    currentStop.filledQuantity = 1;
    broker.emitEvent({
      type: 'fill',
      fill: {
        fillId: 'current-stop-fill', tag: currentStop.tag,
        brokerOrderId: currentStop.brokerOrderId, accountId: 200,
        symbol: 'MNQU6', side: 'Sell', quantity: 1, price: 29_950, filledAt: 500,
      },
    });
    broker.emitEvent({
      type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 0 },
    });
    await controller.waitForIdle();

    expect((await broker.findOrderById(200, currentSiblingId)).order?.status).toBe('canceled');
    expect(controller.status()).toMatchObject({ armed: true, lastError: null, autoClose: null });
    for (const brokerOrderId of historicalProtectiveIds) {
      // Jediný cancel pochází z přípravy terminální historie; nový flat sweep
      // se starých ID vůbec nedotkne.
      expect(broker.cancelRequestCount(brokerOrderId)).toBe(1);
    }
    controller.stop();
  });

  it('skutečně pracovní ochranná noha po flat zůstává fail-closed', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const store = createMemoryCopierStore();
    const oso = await processOsoPair({
      pair: {
        entryOrderId: 'orphan-entry', stopOrderId: 'orphan-stop', targetOrderId: 'orphan-target',
        accountId: 100, symbol: 'MNQU6', entrySide: 'Buy', quantity: 1,
        entryOrderType: 'Limit', entryLimitPrice: 30_000,
        stopPrice: 29_950, targetPrice: 30_100, detectedAt: 10,
        correlation: 'inferred-window',
      },
      event: {
        id: 'orphan-event', orderId: 'orphan-stop', kind: 'submitted', accountId: 100,
        symbol: 'MNQU6', side: 'Sell', quantity: 1, orderType: 'Stop',
        stopPrice: 29_950, sequence: 1, receivedAt: 0,
      },
      group,
      runtime: createRuntime(createCopierState()),
      context: createRiskGateContext({
        armed: true, connected: true, shadowMode: false,
        brokerEnvironment: 'demo', expectedEnvironment: 'demo',
        lastHeartbeatAt: 1, maxHeartbeatAgeMs: 1_000_000, now: 1,
      }),
      broker, clock: stepClock(), store,
    });
    const entry = [...oso.runtime.osoOutbox.values()][0];
    if (!entry?.firstBrokerOrderId || !entry.secondBrokerOrderId) {
      throw new Error('Test setup: ochranné nohy nebyly potvrzeny');
    }
    const orphanOrderId = entry.secondBrokerOrderId;
    const realCancelOrder = broker.cancelOrder.bind(broker);
    broker.cancelOrder = async (accountId, brokerOrderId) => {
      if (brokerOrderId === orphanOrderId) return;
      await realCancelOrder(accountId, brokerOrderId);
    };

    const controller = await bootstrapCopierRuntime({
      broker, store, group, clock: stepClock(), osoCorrelationWindowMs: 5,
    });
    broker.setConnected(true);
    await controller.waitForIdle();

    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 1 } });
    await controller.waitForIdle();
    broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: 'MNQU6', netQuantity: 0 } });
    await controller.waitForIdle();

    expect((await broker.findOrderById(200, orphanOrderId)).order?.status).toBe('working');
    expect(controller.status()).toMatchObject({ armed: false });
    expect(controller.status().lastError).toContain('Flat sweep nedokončen');
    controller.stop();
  });

  const setupVenueSideOsoQtyIncident = async ({
    delayProtectiveCancel,
  }: {
    delayProtectiveCancel: boolean;
  }) => {
    let now = 1_000;
    const clock = () => now;
    const broker = createMockBroker({
      clock,
      behavior: () => ({ kind: 'working' }),
    });
    const store = createMemoryCopierStore();
    const positions = new Map<number, number>([[100, 0], [200, 0]]);

    // Programovatelná autoritativní pozice mocku: venue filly ji mění
    // okamžitě, nezávisle na tom, zda náš pending cancel už doběhl.
    broker.listPositions = async accountId => [{
      accountId, symbol: 'MNQU6', netQuantity: positions.get(accountId) ?? 0,
    }];

    const sentModifyQuantities: number[] = [];
    const realPlaceOrder = broker.placeOrder.bind(broker);
    const realModifyOrder = broker.modifyOrder.bind(broker);
    broker.modifyOrder = async (accountId, brokerOrderId, changes) => {
      sentModifyQuantities.push(changes.quantity);
      await realModifyOrder(accountId, brokerOrderId, changes);
    };

    let delayedCancelOrderId: string | null = null;
    let cancelStartedAt: number | null = null;
    let signalCancelStarted!: () => void;
    let releaseCancel!: () => void;
    const cancelStarted = new Promise<void>(resolve => { signalCancelStarted = resolve; });
    const cancelMayComplete = new Promise<void>(resolve => { releaseCancel = resolve; });
    if (delayProtectiveCancel) {
      const realCancelOrder = broker.cancelOrder.bind(broker);
      broker.cancelOrder = async (accountId, brokerOrderId) => {
        if (brokerOrderId === delayedCancelOrderId) {
          if (cancelStartedAt == null) {
            cancelStartedAt = clock();
            signalCancelStarted();
          }
          await cancelMayComplete;
        }
        await realCancelOrder(accountId, brokerOrderId);
      };
    }

    let controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>> | undefined;
    try {
      controller = await bootstrapCopierRuntime({
        broker, store, group, clock, osoCorrelationWindowMs: 5,
        // Fake timers: potvrzovací polling flattenu by na reálném setTimeout
        // visel navěky a auto-flatten by zablokoval event tail.
        wait: async () => undefined,
      });
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();

      // 1) Leader čekající entry + SL + TP vytvoří skutečný follower OSO qty=5.
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'incident-2026-08-24-entry', orderType: 'Limit', quantity: 5,
        limitPrice: 30_000, sourceVersion: '1:WorkingEntry',
      }) });
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'incident-2026-08-24-stop', parentOrderId: 'incident-2026-08-24-entry',
        side: 'Sell', orderType: 'Stop', quantity: 5, stopPrice: 29_950,
        sourceVersion: '1:WorkingStop',
      }) });
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'incident-2026-08-24-target', parentOrderId: 'incident-2026-08-24-entry',
        side: 'Sell', orderType: 'Limit', quantity: 5, limitPrice: 30_100,
        sourceVersion: '1:WorkingTarget',
      }) });
      await controller.waitForIdle();

      const followerOrders = broker.orders().filter(order => order.accountId === 200);
      const followerEntry = followerOrders.find(order => order.parentOrderId == null);
      const followerStop = followerOrders.find(order => order.orderType === 'Stop');
      if (!followerEntry || !followerStop) throw new Error('Test setup: follower OSO nebyl vytvořen');
      delayedCancelOrderId = followerStop.brokerOrderId;

      let fillSequence = 0;
      const cumulativeEntryFills: number[] = [];
      const venueFill = (order: BrokerOrder, quantity: number, price: number) => {
        if (order.status !== 'working' || quantity <= 0 || order.filledQuantity + quantity > order.quantity) {
          throw new Error('Test setup: venue fill vyžaduje working order a nesmí překročit quantity');
        }
        order.filledQuantity += quantity;
        order.status = order.filledQuantity === order.quantity ? 'filled' : 'working';
        order.sourceVersion = `venue-fill-${++fillSequence}`;
        order.updatedAt = clock();
        broker.emitEvent({ type: 'order', order: { ...order } });
        broker.emitEvent({
          type: 'fill',
          fill: {
            fillId: `venue-fill-${fillSequence}`, tag: order.tag,
            brokerOrderId: order.brokerOrderId, accountId: order.accountId,
            symbol: order.symbol, side: order.side, quantity, price, filledAt: clock(),
          },
        });
        const signed = order.side === 'Buy' ? quantity : -quantity;
        const netQuantity = (positions.get(order.accountId) ?? 0) + signed;
        positions.set(order.accountId, netQuantity);
        broker.emitEvent({
          type: 'position',
          position: { accountId: order.accountId, symbol: order.symbol, netQuantity },
        });
      };

      // Případná budoucí oprava smí test zazelenit: risk-redukující Market
      // příkaz se v mocku opravdu vyplní a aktualizuje stejnou position mapu.
      broker.placeOrder = async request => {
        const ack = await realPlaceOrder(request);
        if (ack.accepted && request.orderType === 'Market') {
          const placedOrder = broker.orders().find(order => order.brokerOrderId === ack.brokerOrderId);
          if (!placedOrder) throw new Error('Test setup: potvrzený Market order chybí v mocku');
          venueFill(placedOrder, request.quantity, 29_949.75);
        }
        return ack;
      };

      // 2) Follower entry se plní po jednom kontraktu: 1/5 ... 5/5.
      positions.set(100, 5);
      broker.emitEvent({
        type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 5 },
      });
      for (let quantity = 1; quantity <= 5; quantity += 1) {
        now += 1;
        venueFill(followerEntry, 1, 30_000);
        cumulativeEntryFills.push(followerEntry.filledQuantity);
      }
      await controller.waitForIdle();
      expect(cumulativeEntryFills).toEqual([1, 2, 3, 4, 5]);

      // 3) Tradovate OSO engine bez našeho commandu vydá OrderVersion qty=7;
      // absence userSessionId je záměrná a sent modify zůstává prázdný.
      // PREVENCE smí uznat DISARM až jako reakci na tento konkrétní event.
      expect(controller.status().armed).toBe(true);
      now += 1;
      const venueOrderVersion: BrokerOrder = {
        ...followerStop,
        quantity: 7,
        sourceVersion: 'venue-version-qty-7-no-user-session',
        updatedAt: clock(),
      };
      Object.assign(followerStop, venueOrderVersion);
      broker.emitEvent({ type: 'order', order: venueOrderVersion });
      if (delayProtectiveCancel) {
        // Budoucí prevence může cancel zahájit už na qty=7. Delayed recovery
        // větev pak nesmí uváznout před místem, kde test cancel uvolní.
        await Promise.race([controller.waitForIdle(), cancelStarted]);
      } else {
        await controller.waitForIdle();
      }
      expect(broker.placedOsoRequests()[0]?.quantity).toBe(5);
      expect(followerStop.quantity).toBe(7);
      expect(sentModifyQuantities).toEqual([]);

      return {
        broker,
        controller,
        positions,
        followerStop,
        venueFill,
        clock,
        advanceNow: (delta = 1) => { now += delta; },
        setNow: (value: number) => { now = value; },
        cancelStarted,
        cancelStartedAt: () => cancelStartedAt,
        releaseCancel,
      };
    } catch (error) {
      controller?.stop();
      throw error;
    }
  };

  it('incident 24.8.2026: venue-side OSO qty=7 během opožděného cancelu nesmí otočit followera', async () => {
    vi.useFakeTimers();
    let incident: Awaited<ReturnType<typeof setupVenueSideOsoQtyIncident>> | undefined;

    try {
      incident = await setupVenueSideOsoQtyIncident({ delayProtectiveCancel: true });

      const { broker, controller, positions, followerStop, venueFill, clock } = incident;

      // 4) Leader jde flat. Oversized stop pak nejdřív zavře followera 5/7;
      // flat sweep odešle cancel, jeho fyzické dokončení ale držíme pending.
      positions.set(100, 0);
      broker.emitEvent({
        type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 },
      });
      await Promise.race([controller.waitForIdle(), incident.cancelStarted]);
      incident.advanceNow();
      venueFill(followerStop, 5, 29_950);
      await incident.cancelStarted;
      expect(positions.get(200)).toBe(0);

      // 5) Přesně v incidentním 980ms okně venue doplní zbylé 2/7. Cancel
      // dorazí až potom, takže už vyplněný stop nemá co zrušit.
      const cancelStartedAt = incident.cancelStartedAt();
      if (cancelStartedAt == null) throw new Error('Test setup: cancel nezačal');
      incident.setNow(cancelStartedAt + 980);
      venueFill(followerStop, 2, 29_949.75);
      expect(clock() - cancelStartedAt).toBe(980);
      incident.releaseCancel();
      await controller.waitForIdle();


      // Bezpečnostní invariant: follower smí být flat nebo ve směru leadera.
      const leaderNet = (await broker.listPositions(100))[0]?.netQuantity ?? 0;
      const followerNet = (await broker.listPositions(200))[0]?.netQuantity ?? 0;
      const safeDirection = followerNet === 0 || Math.sign(followerNet) === Math.sign(leaderNet);
      expect(
        { leaderNet, followerNet, safeDirection },
        `incident 24.8.2026 otočil followera: leader=${leaderNet}, follower=${followerNet}`,
      ).toMatchObject({ safeDirection: true });
    } finally {
      incident?.releaseCancel();
      incident?.controller.stop();
      vi.useRealTimers();
    }
  });

  it('incident 24.8.2026 prevence: venue-side OSO qty=7 musí fail-closed před leader flat', async () => {
    vi.useFakeTimers();
    let incident: Awaited<ReturnType<typeof setupVenueSideOsoQtyIncident>> | undefined;

    try {
      incident = await setupVenueSideOsoQtyIncident({ delayProtectiveCancel: false });
      const { broker, controller, positions, followerStop, venueFill } = incident;

      // Snapshot musí vzniknout před leader flat. Pozdější normální flat sweep
      // by jinak zrušeným stopem falešně dokazoval prevenci místo zotavení.
      const stopStatusBeforeLeaderFlat = followerStop.status;
      const groupStoppedBeforeLeaderFlat = !controller.status().armed;
      const oversizedContainedBeforeLeaderFlat = (
        stopStatusBeforeLeaderFlat === 'canceled' || groupStoppedBeforeLeaderFlat
      );

      // 4) Stejný incidentní přechod leadera do flat. Není-li oversized stop
      // preventivně zrušen, venue z něj vyplní původních 5 kontraktů; běžný
      // cancel pak smí doběhnout bez umělého 980ms zdržení.
      positions.set(100, 0);
      broker.emitEvent({
        type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: 0 },
      });
      await controller.waitForIdle();
      if (followerStop.status === 'working') {
        incident.advanceNow();
        venueFill(followerStop, 5, 29_950);
        await controller.waitForIdle();
      }

      // Stejný bezpečnostní invariant jako v recovery testu.
      const leaderNet = (await broker.listPositions(100))[0]?.netQuantity ?? 0;
      const followerNet = (await broker.listPositions(200))[0]?.netQuantity ?? 0;
      const safeDirection = followerNet === 0 || Math.sign(followerNet) === Math.sign(leaderNet);
      expect(
        { leaderNet, followerNet, safeDirection },
        `incident 24.8.2026 prevence otočila followera: leader=${leaderNet}, follower=${followerNet}`,
      ).toMatchObject({ safeDirection: true });
      expect(
        { stopStatusBeforeLeaderFlat, groupStoppedBeforeLeaderFlat, oversizedContainedBeforeLeaderFlat },
        `incident 24.8.2026 prevence selhala před leader flat: oversized stop status=${stopStatusBeforeLeaderFlat}, groupStopped=${groupStoppedBeforeLeaderFlat}`,
      ).toMatchObject({ oversizedContainedBeforeLeaderFlat: true });
    } finally {
      incident?.controller.stop();
      vi.useRealTimers();
    }
  });
});
