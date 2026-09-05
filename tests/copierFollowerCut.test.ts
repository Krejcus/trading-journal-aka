import { describe, expect, it, vi } from 'vitest';
import type {
  BrokerAccountRiskSnapshot,
  BrokerFill,
  BrokerOrder,
  BrokerOrderRequest,
} from '../services/brokerPort';
import {
  bootstrapCopierRuntime,
  type CopierRuntimeController,
} from '../services/copierRuntimeController';
import { createMemoryCopierStore, type CopierStore } from '../services/copierStore';
import type { CopierAuditEntry } from '../services/copierRunner';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import {
  DEFAULT_COPY_GROUP_SAFETY,
  type CopyFollowerCutAction,
  type CopyGroupConfig,
} from '../services/liveCopyTrading';

const START_AT = Date.parse('2026-09-08T16:00:00.000Z');

const manualClock = (initial = START_AT) => {
  let value = initial;
  return {
    clock: () => value,
    now: () => value,
    set: (next: number) => { value = next; },
    advance: (milliseconds: number) => { value += milliseconds; },
  };
};

const riskGroup = ({
  mode = 'on-fill',
  onCut = 'close-copy',
  cutUsd = 100,
}: {
  mode?: 'on-submit' | 'on-fill';
  onCut?: CopyFollowerCutAction;
  cutUsd?: number;
} = {}): CopyGroupConfig => ({
  id: 'follower-cut-group',
  name: 'Follower cut group',
  enabled: true,
  leaderAccountId: 100,
  followers: [
    {
      accountId: 200,
      mode,
      multiplier: 1,
      dailyLossCutUsd: cutUsd,
      onCut,
    },
    {
      accountId: 201,
      mode,
      multiplier: 1,
    },
  ],
  safety: {
    ...DEFAULT_COPY_GROUP_SAFETY,
    dailyLossLimitUsd: 0,
    dailyMaxLosingTrades: 0,
    dailyMaxTrades: 0,
    tradingWindow: {
      enabled: false,
      from: '15:30',
      to: '22:00',
      timeZone: 'Europe/Prague',
    },
  },
});

const riskSnapshot = ({
  accountId,
  at,
  realizedPnlUsd = null,
  netLiq = null,
  minNetLiq = null,
  dailyLossAutoLiq = null,
}: {
  accountId: number;
  at: number;
  realizedPnlUsd?: number | null;
  netLiq?: number | null;
  minNetLiq?: number | null;
  dailyLossAutoLiq?: number | null;
}): BrokerAccountRiskSnapshot => ({
  accountId,
  at,
  realizedPnlUsd,
  netLiq,
  minNetLiq,
  dailyLossAutoLiq,
  trailingMaxDrawdown: null,
});

const installRiskProvider = (
  broker: MockBroker,
  provider: (accountId: number) => BrokerAccountRiskSnapshot,
) => vi.spyOn(broker, 'listAccountRiskSnapshots').mockImplementation(async accountIds => (
  [...new Set(accountIds)].map(provider)
));

let eventSequence = 0;

const brokerFill = ({
  accountId,
  side,
  quantity = 1,
  price,
  at,
}: {
  accountId: number;
  side: 'Buy' | 'Sell';
  quantity?: number;
  price: number;
  at: number;
}): BrokerFill => {
  eventSequence += 1;
  return {
    fillId: `cut-fill-${eventSequence}`,
    tag: '',
    brokerOrderId: `cut-order-${eventSequence}`,
    accountId,
    symbol: 'MNQU6',
    side,
    quantity,
    price,
    filledAt: at,
  };
};

const leaderPosition = (netQuantity: number) => ({
  type: 'position' as const,
  position: { accountId: 100, symbol: 'MNQU6', netQuantity },
});

const leaderWorkingOrder = ({
  brokerOrderId = 'leader-working-entry',
  at,
}: {
  brokerOrderId?: string;
  at: number;
}): BrokerOrder => ({
  tag: '',
  brokerOrderId,
  accountId: 100,
  symbol: 'MNQU6',
  side: 'Buy',
  orderType: 'Limit',
  quantity: 1,
  filledQuantity: 0,
  limitPrice: 19_900,
  status: 'working',
  sourceVersion: `${brokerOrderId}:working`,
  updatedAt: at,
});

const leaderMarketOrder = ({
  brokerOrderId,
  side,
  quantity,
  at,
}: {
  brokerOrderId: string;
  side: 'Buy' | 'Sell';
  quantity: number;
  at: number;
}): BrokerOrder => ({
  tag: '',
  brokerOrderId,
  accountId: 100,
  symbol: 'MNQU6',
  side,
  orderType: 'Market',
  quantity,
  filledQuantity: 0,
  status: 'working',
  sourceVersion: `${brokerOrderId}:working`,
  updatedAt: at,
});

interface BootedRuntime {
  broker: MockBroker;
  controller: CopierRuntimeController;
  store: CopierStore;
  audits: CopierAuditEntry[];
}

const bootRuntime = async ({
  broker,
  group,
  time,
  store = createMemoryCopierStore(),
  shadowMode = false,
  flattenConfirmationAttempts,
}: {
  broker: MockBroker;
  group: CopyGroupConfig;
  time: ReturnType<typeof manualClock>;
  store?: CopierStore;
  shadowMode?: boolean;
  flattenConfirmationAttempts?: number;
}): Promise<BootedRuntime> => {
  const audits: CopierAuditEntry[] = [];
  const controller = await bootstrapCopierRuntime({
    broker,
    store,
    group,
    clock: time.clock,
    onAudit: entries => audits.push(...entries),
    flattenConfirmationAttempts,
    flattenConfirmationPollMs: 0,
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm({ shadowMode });
  await controller.waitForIdle();
  return { broker, controller, store, audits };
};

const emitLeaderFill = async ({
  broker,
  controller,
  time,
  side,
  quantity = 1,
  price,
  netQuantity,
}: BootedRuntime & {
  time: ReturnType<typeof manualClock>;
  side: 'Buy' | 'Sell';
  quantity?: number;
  price: number;
  netQuantity: number;
}): Promise<void> => {
  broker.emitEvent({
    type: 'fill',
    fill: brokerFill({ accountId: 100, side, quantity, price, at: time.now() }),
  });
  broker.emitEvent(leaderPosition(netQuantity));
  await controller.waitForIdle();
};

const followerCut = (controller: CopierRuntimeController, accountId = 200) => (
  controller.status().followerCuts?.find(cut => cut.accountId === accountId)
);

const accountRisk = (controller: CopierRuntimeController, accountId: number) => (
  controller.status().accountRisk?.find(snapshot => snapshot.accountId === accountId)
);

describe('CopierRuntimeController — follower account cuts', () => {
  it('broker cut zavře jen zasaženou kopii a ostatní follower dál přijímá nové vstupy', async () => {
    const time = manualClock();
    let breached = false;
    const broker = createMockBroker({
      clock: time.clock,
      nativeLiquidate: true,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const runtime = await bootRuntime({ broker, group: riskGroup(), time });
    try {
      await emitLeaderFill({
        ...runtime,
        time,
        side: 'Buy',
        price: 20_000,
        netQuantity: 1,
      });
      expect(broker.placedRequests().map(request => request.accountId).sort()).toEqual([200, 201]);

      breached = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();

      expect(followerCut(runtime.controller)).toMatchObject({
        accountId: 200,
        at: time.now(),
        realizedPnlUsd: -125,
        cutUsd: 100,
        source: 'broker',
        closed: time.now(),
      });
      expect(broker.liquidateRequests()).toEqual([
        expect.objectContaining({ accountId: 200, symbol: 'MNQU6' }),
      ]);
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 0 }),
      ]);
      expect(await broker.listPositions(201)).toEqual([
        expect.objectContaining({ netQuantity: 1 }),
      ]);
      expect(runtime.controller.status()).toMatchObject({
        armed: true,
        dayLockUntil: 0,
        dayLockTrigger: null,
        lastError: null,
      });
      expect(runtime.audits).toContainEqual(expect.objectContaining({
        kind: 'follower-cut',
        accountId: 200,
        source: 'broker',
      }));

      time.advance(1_000);
      await emitLeaderFill({
        ...runtime,
        time,
        side: 'Buy',
        price: 20_010,
        netQuantity: 2,
      });
      expect(broker.placedRequests().slice(2)).toEqual([
        expect.objectContaining({ accountId: 201, side: 'Buy', quantity: 1 }),
      ]);
      expect(runtime.controller.status().armed).toBe(true);
    } finally {
      runtime.controller.stop();
    }
  });

  it('close-copy follower po flattenu nedostane pozdější leader exit a neotevře reverse', async () => {
    const time = manualClock();
    let breached = false;
    const broker = createMockBroker({
      clock: time.clock,
      nativeLiquidate: true,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const runtime = await bootRuntime({ broker, group: riskGroup(), time });
    try {
      await emitLeaderFill({
        ...runtime,
        time,
        side: 'Buy',
        price: 20_000,
        netQuantity: 1,
      });

      breached = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();

      expect(followerCut(runtime.controller)).toMatchObject({ closed: time.now() });
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 0 }),
      ]);
      const cutFollowerRequestsBeforeExit = broker.placedRequests()
        .filter(request => request.accountId === 200).length;

      time.advance(1_000);
      await emitLeaderFill({
        ...runtime,
        time,
        side: 'Sell',
        price: 19_950,
        netQuantity: 0,
      });

      expect(broker.placedRequests().filter(request => request.accountId === 200))
        .toHaveLength(cutFollowerRequestsBeforeExit);
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 0 }),
      ]);
      expect(await broker.listPositions(201)).toEqual([
        expect.objectContaining({ netQuantity: 0 }),
      ]);
    } finally {
      runtime.controller.stop();
    }
  });

  it('cut zruší copier-owned working entry i když follower zatím nemá pozici', async () => {
    const time = manualClock();
    let breached = false;
    const broker = createMockBroker({
      clock: time.clock,
      nativeLiquidate: true,
      behavior: () => ({ kind: 'working' }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const runtime = await bootRuntime({
      broker,
      group: riskGroup({ mode: 'on-submit' }),
      time,
    });
    try {
      broker.emitEvent({
        type: 'order',
        order: leaderWorkingOrder({ at: time.now() }),
      });
      await runtime.controller.waitForIdle();
      const cutFollowerOrder = broker.orders().find(order => order.accountId === 200);
      const healthyFollowerOrder = broker.orders().find(order => order.accountId === 201);
      expect(cutFollowerOrder).toMatchObject({ accountId: 200, status: 'working' });
      expect(healthyFollowerOrder).toMatchObject({ accountId: 201, status: 'working' });

      breached = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();

      expect(followerCut(runtime.controller)).toBeDefined();
      expect(broker.orders().find(order => order.brokerOrderId === cutFollowerOrder?.brokerOrderId))
        .toMatchObject({ status: 'canceled' });
      expect(broker.cancelRequestCount(cutFollowerOrder?.brokerOrderId ?? '')).toBe(1);
      expect(broker.orders().find(order => order.brokerOrderId === healthyFollowerOrder?.brokerOrderId))
        .toMatchObject({ status: 'working' });
    } finally {
      runtime.controller.stop();
    }
  });

  it('cut automaticky nezavírá cizí pozici bez copier lineage', async () => {
    const time = manualClock();
    let breached = false;
    const broker = createMockBroker({
      clock: time.clock,
      nativeLiquidate: true,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const runtime = await bootRuntime({ broker, group: riskGroup(), time });
    try {
      await broker.placeOrder({
        tag: 'manual-external-order',
        accountId: 200,
        symbol: 'MNQU6',
        side: 'Buy',
        quantity: 1,
        orderType: 'Market',
      });
      await runtime.controller.waitForIdle();
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 1 }),
      ]);

      breached = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();

      expect(followerCut(runtime.controller)).toBeDefined();
      expect(broker.liquidateRequests().filter(request => request.accountId === 200)).toHaveLength(0);
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 1 }),
      ]);
    } finally {
      runtime.controller.stop();
    }
  });

  it('close-copy s nepotvrzeným liquidate zůstane jedním pokusem, nastaví closed=false a fail-closed (neznámý broker stav)', async () => {
    const time = manualClock();
    let breached = false;
    const broker = createMockBroker({
      clock: time.clock,
      nativeLiquidate: true,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const runtime = await bootRuntime({
      broker,
      group: riskGroup(),
      time,
      flattenConfirmationAttempts: 1,
    });
    try {
      await emitLeaderFill({
        ...runtime,
        time,
        side: 'Buy',
        price: 20_000,
        netQuantity: 1,
      });
      const liquidate = vi.fn(async () => ({
        status: 'submitted' as const,
        brokerOrderId: 'accepted-but-position-stayed-open',
      }));
      broker.liquidatePosition = liquidate;

      breached = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();

      expect(liquidate).toHaveBeenCalledTimes(1);
      expect(followerCut(runtime.controller)).toMatchObject({
        accountId: 200,
        source: 'broker',
        closed: false,
      });
      // Liquidate byl odeslán a broker flat nepotvrdil: neznámý broker stav
      // je fail-closed pro celou skupinu (stuck outbox), ne jen pro účet.
      expect(runtime.controller.status().lastError).toContain('Flatten selhal');
      expect(runtime.controller.status().armed).toBe(false);
      expect(runtime.controller.status().stuckOutbox).toBe(true);
      expect(runtime.controller.status().dayLockUntil).toBe(0);
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 1 }),
      ]);
    } finally {
      runtime.controller.stop();
    }
  });

  it('ledger cut s let-run ponechá kopii dojet, zablokuje další entry a neomezí druhého followera', async () => {
    const time = manualClock();
    const broker = createMockBroker({
      clock: time.clock,
      behavior: (request: BrokerOrderRequest) => ({
        kind: 'fill',
        price: request.side === 'Buy' ? 20_000 : 19_940,
      }),
    });
    const runtime = await bootRuntime({
      broker,
      group: riskGroup({ onCut: 'let-run' }),
      time,
    });
    try {
      await emitLeaderFill({
        ...runtime,
        time,
        side: 'Buy',
        quantity: 2,
        price: 20_000,
        netQuantity: 2,
      });
      time.advance(1_000);
      await emitLeaderFill({
        ...runtime,
        time,
        side: 'Sell',
        quantity: 1,
        price: 19_940,
        netQuantity: 1,
      });

      expect(followerCut(runtime.controller)).toMatchObject({
        accountId: 200,
        realizedPnlUsd: -120,
        source: 'ledger',
        closed: null,
      });
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 1 }),
      ]);
      expect(runtime.controller.status()).toMatchObject({
        armed: true,
        dayLockUntil: 0,
        dayLockTrigger: null,
        lastError: null,
      });

      // Exit leadera je risk-redukující, takže musí dojet i na cut followerovi.
      time.advance(1_000);
      await emitLeaderFill({
        ...runtime,
        time,
        side: 'Sell',
        quantity: 1,
        price: 19_950,
        netQuantity: 0,
      });
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 0 }),
      ]);

      // Další entry dostane jen zdravý follower 201.
      time.advance(1_000);
      await emitLeaderFill({
        ...runtime,
        time,
        side: 'Buy',
        quantity: 1,
        price: 20_010,
        netQuantity: 1,
      });
      expect(broker.placedRequests().filter(request => request.accountId === 200)).toHaveLength(3);
      expect(broker.placedRequests().filter(request => request.accountId === 201)).toHaveLength(4);
      expect(broker.placedRequests().at(-1)).toMatchObject({ accountId: 201, side: 'Buy' });
      expect(runtime.controller.status().armed).toBe(true);
      expect(broker.liquidateRequests()).toHaveLength(0);
    } finally {
      runtime.controller.stop();
    }
  });

  it('let-run při leader reversal zkopíruje jen zavírací část a neotevře reverse', async () => {
    const time = manualClock();
    const broker = createMockBroker({
      clock: time.clock,
      behavior: (request: BrokerOrderRequest) => ({
        kind: 'fill',
        price: request.side === 'Buy' ? 20_000 : 19_940,
      }),
    });
    const runtime = await bootRuntime({
      broker,
      group: riskGroup({ onCut: 'let-run' }),
      time,
    });
    try {
      await emitLeaderFill({
        ...runtime, time, side: 'Buy', quantity: 2, price: 20_000, netQuantity: 2,
      });
      time.advance(1_000);
      await emitLeaderFill({
        ...runtime, time, side: 'Sell', quantity: 1, price: 19_940, netQuantity: 1,
      });
      expect(followerCut(runtime.controller)).toMatchObject({ source: 'ledger' });

      time.advance(1_000);
      await emitLeaderFill({
        ...runtime, time, side: 'Sell', quantity: 2, price: 19_950, netQuantity: -1,
      });

      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 0 }),
      ]);
      expect(await broker.listPositions(201)).toEqual([
        expect.objectContaining({ netQuantity: -1 }),
      ]);
      expect(broker.placedRequests().filter(request => request.accountId === 200).at(-1))
        .toMatchObject({ side: 'Sell', quantity: 1 });
      expect(broker.placedRequests().filter(request => request.accountId === 201).at(-1))
        .toMatchObject({ side: 'Sell', quantity: 2 });
      expect(runtime.controller.status().armed).toBe(true);
    } finally {
      runtime.controller.stop();
    }
  });

  it('let-run cut zruší čekající copier entry jen zasaženého followera', async () => {
    const time = manualClock();
    let breached = false;
    const broker = createMockBroker({
      clock: time.clock,
      behavior: () => ({ kind: 'working' }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const runtime = await bootRuntime({
      broker,
      group: riskGroup({ mode: 'on-submit', onCut: 'let-run' }),
      time,
    });
    try {
      broker.emitEvent({ type: 'order', order: leaderWorkingOrder({ at: time.now() }) });
      await runtime.controller.waitForIdle();
      const cutOrder = broker.orders().find(order => order.accountId === 200);
      const healthyOrder = broker.orders().find(order => order.accountId === 201);

      breached = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();

      expect(followerCut(runtime.controller)).toMatchObject({ source: 'broker', closed: null });
      expect(broker.orders().find(order => order.brokerOrderId === cutOrder?.brokerOrderId))
        .toMatchObject({ status: 'canceled' });
      expect(broker.orders().find(order => order.brokerOrderId === healthyOrder?.brokerOrderId))
        .toMatchObject({ status: 'working' });
      expect(broker.liquidateRequests()).toHaveLength(0);
      expect(runtime.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      runtime.controller.stop();
    }
  });

  it('fractional let-run redukuje podle cílové pozice, i když floor jedné exit objednávky je nula', async () => {
    const time = manualClock();
    let breached = false;
    const broker = createMockBroker({
      clock: time.clock,
      behavior: request => ({ kind: 'fill', price: request.side === 'Buy' ? 20_000 : 19_990 }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const group = riskGroup({ onCut: 'let-run' });
    group.followers[0].multiplier = 0.5;
    const runtime = await bootRuntime({ broker, group, time });
    try {
      await emitLeaderFill({
        ...runtime, time, side: 'Buy', quantity: 2, price: 20_000, netQuantity: 2,
      });
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 1 }),
      ]);

      breached = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();
      time.advance(1);
      await emitLeaderFill({
        ...runtime, time, side: 'Sell', quantity: 1, price: 19_990, netQuantity: 1,
      });

      expect(broker.placedRequests().filter(request => request.accountId === 200).at(-1))
        .toMatchObject({ side: 'Sell', quantity: 1 });
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 0 }),
      ]);
      expect(runtime.controller.status().armed).toBe(true);
    } finally {
      runtime.controller.stop();
    }
  });

  it('let-run partial reversal přes flat nezkopíruje druhý fill stejné leader objednávky', async () => {
    const time = manualClock();
    let breached = false;
    const broker = createMockBroker({
      clock: time.clock,
      behavior: request => ({ kind: 'fill', price: request.side === 'Buy' ? 20_000 : 19_990 }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const runtime = await bootRuntime({ broker, group: riskGroup({ onCut: 'let-run' }), time });
    try {
      await emitLeaderFill({
        ...runtime, time, side: 'Buy', quantity: 1, price: 20_000, netQuantity: 1,
      });
      breached = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();

      const reversalOrderId = 'cut-partial-reversal';
      for (const [index, netQuantity] of [[1, 0], [2, -1]] as const) {
        time.advance(1);
        broker.emitEvent({
          type: 'fill',
          fill: {
            fillId: `cut-partial-reversal-${index}`, tag: '', brokerOrderId: reversalOrderId,
            accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 1, price: 19_990,
            filledAt: time.now(),
          },
        });
        broker.emitEvent(leaderPosition(netQuantity));
        await runtime.controller.waitForIdle();
      }

      expect(broker.placedRequests().filter(request => request.accountId === 200)).toHaveLength(2);
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 0 }),
      ]);
      expect(runtime.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      runtime.controller.stop();
    }
  });

  it('broker snapshot s neplatným časem je neověřený a nikdy nespustí cut', async () => {
    const time = manualClock();
    const broker = createMockBroker({ clock: time.clock });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: 0,
      realizedPnlUsd: accountId === 200 ? -1_000 : 0,
    }));
    const runtime = await bootRuntime({ broker, group: riskGroup(), time });
    try {
      expect(followerCut(runtime.controller)).toBeUndefined();
      expect(accountRisk(runtime.controller, 200)).toMatchObject({
        verifiedAt: 0,
        error: 'broker risk snapshot má neplatný čas',
      });
      expect(broker.liquidateRequests()).toHaveLength(0);
      expect(runtime.controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      runtime.controller.stop();
    }
  });

  it('dva současné close-copy cuty se durable provedou nezávisle i když první selže', async () => {
    const time = manualClock();
    let breached = false;
    const broker = createMockBroker({
      clock: time.clock,
      nativeLiquidate: true,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: breached && (accountId === 200 || accountId === 201) ? -125 : 0,
    }));
    const group = riskGroup();
    group.followers[1].dailyLossCutUsd = 100;
    group.followers[1].onCut = 'close-copy';
    const runtime = await bootRuntime({ broker, group, time, flattenConfirmationAttempts: 1 });
    try {
      await emitLeaderFill({
        ...runtime, time, side: 'Buy', quantity: 1, price: 20_000, netQuantity: 1,
      });
      const nativeLiquidate = broker.liquidatePosition!;
      const liquidate = vi.fn(async request => (
        request.accountId === 200
          ? { status: 'rejected' as const, reason: 'account 200 test failure' }
          : nativeLiquidate(request)
      ));
      broker.liquidatePosition = liquidate;

      breached = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();

      expect(followerCut(runtime.controller, 200)).toMatchObject({ closed: false });
      expect(followerCut(runtime.controller, 201)).toMatchObject({ closed: time.now() });
      expect(liquidate.mock.calls.map(([request]) => request.accountId).sort()).toEqual([200, 201]);
      expect(await broker.listPositions(201)).toEqual([
        expect.objectContaining({ netQuantity: 0 }),
      ]);
      expect((await runtime.store.load()).safety?.followerCuts).toMatchObject({
        '200': { closed: false },
        '201': { closed: time.now() },
      });
      expect(runtime.controller.status().dayLockUntil).toBe(0);
    } finally {
      runtime.controller.stop();
    }
  });

  it('close-copy odmítne account-wide flatten, pokud snapshot obsahuje další manuální symbol', async () => {
    const time = manualClock();
    let breached = false;
    let exposeManualSymbol = false;
    const broker = createMockBroker({
      clock: time.clock,
      nativeLiquidate: true,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const listPositions = broker.listPositions.bind(broker);
    vi.spyOn(broker, 'listPositions').mockImplementation(async accountId => {
      const positions = await listPositions(accountId);
      return exposeManualSymbol && accountId === 200
        ? [...positions, { accountId, symbol: 'ESU6', netQuantity: 1 }]
        : positions;
    });
    const runtime = await bootRuntime({ broker, group: riskGroup(), time });
    try {
      await emitLeaderFill({
        ...runtime, time, side: 'Buy', quantity: 1, price: 20_000, netQuantity: 1,
      });
      exposeManualSymbol = true;
      breached = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();

      expect(followerCut(runtime.controller)).toMatchObject({ closed: false });
      expect(broker.liquidateRequests().filter(request => request.accountId === 200)).toHaveLength(0);
      // Odmítnutí account-wide flattenu je per účet (closed=false); skupina
      // zůstává ARM a bez lastError — nic neletí, stav účtu je známý.
      expect(runtime.controller.status()).toMatchObject({ armed: true, lastError: null, stuckOutbox: false });
      expect(runtime.audits).toContainEqual(expect.objectContaining({
        kind: 'follower-cut',
        accountId: 200,
        reason: expect.stringContaining('kopii se nepodařilo zavřít'),
      }));

      // Druhý follower kopíruje dál; vyřazený účet nedostane nový vstup.
      time.advance(1_000);
      const placedBefore = broker.placedRequests().length;
      await emitLeaderFill({
        ...runtime, time, side: 'Buy', price: 20_010, netQuantity: 2,
      });
      expect(broker.placedRequests().slice(placedBefore)).toEqual([
        expect.objectContaining({ accountId: 201, side: 'Buy', quantity: 1 }),
      ]);
      expect(runtime.controller.status().armed).toBe(true);

      // Exit leadera se do neuzavřené kopie kopíruje (chová se jako let-run),
      // aby se mohla zavřít s leaderem — žádný liquidation pokus navíc.
      time.advance(1_000);
      await emitLeaderFill({
        ...runtime, time, side: 'Sell', quantity: 2, price: 20_020, netQuantity: 0,
      });
      expect(broker.placedRequests().slice(placedBefore + 1)).toEqual(expect.arrayContaining([
        expect.objectContaining({ accountId: 200, side: 'Sell' }),
        expect.objectContaining({ accountId: 201, side: 'Sell' }),
      ]));
      expect(broker.liquidateRequests().filter(request => request.accountId === 200)).toHaveLength(0);
    } finally {
      runtime.controller.stop();
    }
  });

  it('close-copy rozpozná vlastní working SL/TP jako copier lineage a bezpečně je zruší s kopií', async () => {
    const time = manualClock();
    let breached = false;
    const broker = createMockBroker({
      clock: time.clock,
      nativeLiquidate: true,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const runtime = await bootRuntime({ broker, group: riskGroup({ mode: 'on-submit' }), time });
    try {
      const entryOrder = leaderMarketOrder({
        brokerOrderId: 'leader-cut-entry', side: 'Buy', quantity: 1, at: time.now(),
      });
      broker.emitEvent({ type: 'order', order: entryOrder });
      const entry = {
        ...brokerFill({ accountId: 100, side: 'Buy', price: 20_000, at: time.now() }),
        brokerOrderId: entryOrder.brokerOrderId,
      };
      broker.emitEvent({ type: 'fill', fill: entry });
      broker.emitEvent(leaderPosition(1));
      await runtime.controller.waitForIdle();

      for (const [brokerOrderId, orderType, price] of [
        ['leader-cut-stop', 'Stop', 19_950],
        ['leader-cut-target', 'Limit', 20_100],
      ] as const) {
        broker.emitEvent({
          type: 'order',
          order: {
            tag: '', brokerOrderId, parentOrderId: entry.brokerOrderId,
            accountId: 100, symbol: 'MNQU6', side: 'Sell', orderType,
            quantity: 1, filledQuantity: 0, status: 'working',
            sourceVersion: `${brokerOrderId}:working`, updatedAt: time.now(),
            ...(orderType === 'Limit' ? { limitPrice: price } : { stopPrice: price }),
          },
        });
      }
      await runtime.controller.waitForIdle();
      expect(broker.placedOcoRequests().filter(request => request.accountId === 200)).toHaveLength(1);

      breached = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();

      expect(followerCut(runtime.controller)).toMatchObject({ closed: time.now() });
      expect(broker.liquidateRequests()).toContainEqual(
        expect.objectContaining({ accountId: 200, symbol: 'MNQU6' }),
      );
      expect(runtime.controller.status().lastError).toBe(null);
    } finally {
      runtime.controller.stop();
    }
  });

  it('restart dokončí durable pending close-copy stejným operationId místo blind retry', async () => {
    const time = manualClock();
    let breached = false;
    let crashAfterPendingCutCommit = true;
    const broker = createMockBroker({
      clock: time.clock,
      nativeLiquidate: true,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const durableStore = createMemoryCopierStore();
    const crashStore: CopierStore = {
      load: () => durableStore.load(),
      commit: async (snapshot, expectedRevision) => {
        const committed = await durableStore.commit(snapshot, expectedRevision);
        if (
          crashAfterPendingCutCommit
          && committed.safety?.followerCuts?.['200']?.closed === null
        ) {
          crashAfterPendingCutCommit = false;
          throw new Error('simulated crash after pending cut commit');
        }
        return committed;
      },
    };
    const first = await bootRuntime({ broker, group: riskGroup(), time, store: crashStore });
    await emitLeaderFill({
      ...first, time, side: 'Buy', quantity: 1, price: 20_000, netQuantity: 1,
    });
    breached = true;
    time.advance(30_000);
    broker.emitEvent({ type: 'heartbeat', at: time.now() });
    await first.controller.waitForIdle();
    expect((await durableStore.load()).safety?.followerCuts?.['200']).toMatchObject({ closed: null });
    expect(broker.liquidateRequests()).toHaveLength(0);
    first.controller.stop();

    const restarted = await bootstrapCopierRuntime({
      broker,
      store: crashStore,
      group: riskGroup(),
      clock: time.clock,
      flattenConfirmationAttempts: 1,
      flattenConfirmationPollMs: 0,
    });
    try {
      broker.setConnected(true);
      await restarted.waitForIdle();
      await restarted.reconcile();
      await restarted.waitForIdle();

      expect(followerCut(restarted)).toMatchObject({ closed: expect.any(Number) });
      expect(broker.liquidateRequests().filter(request => request.accountId === 200)).toHaveLength(1);
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 0 }),
      ]);
    } finally {
      restarted.stop();
    }
  });

  it('restart nikdy nepovýší shadow cut na live close podle starého sessionArmedAt', async () => {
    const time = manualClock();
    let breached = false;
    const broker = createMockBroker({
      clock: time.clock,
      nativeLiquidate: true,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    const cancelOrder = vi.spyOn(broker, 'cancelOrder');
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const group = riskGroup();
    const store = createMemoryCopierStore();

    const live = await bootRuntime({ broker, group, time, store });
    await broker.placeOrder({
      tag: 'leader-live-before-shadow',
      accountId: 100,
      symbol: 'MNQU6',
      side: 'Buy',
      quantity: 1,
      orderType: 'Market',
    });
    await live.controller.waitForIdle();
    expect(live.controller.status().sessionArmedAt).toBeGreaterThan(0);
    expect(await broker.listPositions(200)).toEqual([
      expect.objectContaining({ netQuantity: 1 }),
    ]);
    live.controller.stop();
    broker.setConnected(false);

    const shadow = await bootstrapCopierRuntime({
      broker,
      store,
      group,
      clock: time.clock,
      flattenConfirmationAttempts: 1,
      flattenConfirmationPollMs: 0,
    });
    broker.setConnected(true);
    await shadow.waitForIdle();
    await shadow.reconcile();
    shadow.arm({ shadowMode: true });
    await shadow.waitForIdle();

    breached = true;
    time.advance(30_000);
    broker.emitEvent({ type: 'heartbeat', at: time.now() });
    await shadow.waitForIdle();
    expect(followerCut(shadow)).toMatchObject({ accountId: 200, closed: null });
    expect(broker.liquidateRequests()).toHaveLength(0);
    expect(cancelOrder).not.toHaveBeenCalled();
    shadow.stop();
    broker.setConnected(false);

    const restarted = await bootstrapCopierRuntime({
      broker,
      store,
      group,
      clock: time.clock,
      flattenConfirmationAttempts: 1,
      flattenConfirmationPollMs: 0,
    });
    try {
      broker.setConnected(true);
      await restarted.waitForIdle();
      await restarted.reconcile();
      await restarted.waitForIdle();

      expect(followerCut(restarted)).toMatchObject({ accountId: 200, closed: null });
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 1 }),
      ]);
      expect(broker.liquidateRequests()).toHaveLength(0);
      expect(cancelOrder).not.toHaveBeenCalled();
    } finally {
      restarted.stop();
    }
  });

  it('restart close-copy neflattenuje manuálně znovuotevřenou pozici jen podle historického ACK a expected net', async () => {
    const time = manualClock();
    let breached = false;
    let crashAfterPendingCutCommit = true;
    const broker = createMockBroker({
      clock: time.clock,
      nativeLiquidate: true,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const group = riskGroup();
    const durableStore = createMemoryCopierStore();
    const crashStore: CopierStore = {
      load: () => durableStore.load(),
      commit: async (snapshot, expectedRevision) => {
        const committed = await durableStore.commit(snapshot, expectedRevision);
        if (
          crashAfterPendingCutCommit
          && committed.safety?.followerCuts?.['200']?.closed === null
        ) {
          crashAfterPendingCutCommit = false;
          throw new Error('simulated crash after pending cut commit');
        }
        return committed;
      },
    };
    const first = await bootRuntime({ broker, group, time, store: crashStore });
    await broker.placeOrder({
      tag: 'leader-entry-before-lineage-crash',
      accountId: 100,
      symbol: 'MNQU6',
      side: 'Buy',
      quantity: 1,
      orderType: 'Market',
    });
    await first.controller.waitForIdle();

    breached = true;
    time.advance(30_000);
    broker.emitEvent({ type: 'heartbeat', at: time.now() });
    await first.controller.waitForIdle();
    expect((await durableStore.load()).safety?.followerCuts?.['200']).toMatchObject({ closed: null });
    expect(broker.liquidateRequests()).toHaveLength(0);
    first.controller.stop();
    time.advance(1);

    // Původní copier pozice už neexistuje. Mimo běžící worker ji
    // operátor zavřel a otevřel stejný net ručně; historický ACK zůstal.
    await broker.placeOrder({
      tag: 'manual-close-after-crash',
      accountId: 200,
      symbol: 'MNQU6',
      side: 'Sell',
      quantity: 1,
      orderType: 'Market',
    });
    await broker.placeOrder({
      tag: 'manual-reopen-after-crash',
      accountId: 200,
      symbol: 'MNQU6',
      side: 'Buy',
      quantity: 1,
      orderType: 'Market',
    });
    const beforeRestart = await durableStore.load();
    expect(beforeRestart.outbox.some(entry => (
      entry.status === 'acknowledged' && entry.request.accountId === 200
    ))).toBe(true);
    broker.setConnected(false);

    const restarted = await bootstrapCopierRuntime({
      broker,
      store: crashStore,
      group,
      clock: time.clock,
      flattenConfirmationAttempts: 1,
      flattenConfirmationPollMs: 0,
    });
    try {
      broker.setConnected(true);
      await restarted.waitForIdle();
      await restarted.reconcile();
      await restarted.waitForIdle();

      expect(followerCut(restarted)).toMatchObject({ accountId: 200, closed: false });
      expect(broker.liquidateRequests()).toHaveLength(0);
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 1 }),
      ]);
    } finally {
      restarted.stop();
    }
  });

  it('restart dokončí durable pending let-run zrušením stejného waiting entry bez blind retry', async () => {
    const time = manualClock();
    let breached = false;
    let crashAfterPendingCutCommit = true;
    const broker = createMockBroker({
      clock: time.clock,
      behavior: () => ({ kind: 'working' }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const group = riskGroup({ mode: 'on-submit', onCut: 'let-run' });
    const durableStore = createMemoryCopierStore();
    const crashStore: CopierStore = {
      load: () => durableStore.load(),
      commit: async (snapshot, expectedRevision) => {
        const committed = await durableStore.commit(snapshot, expectedRevision);
        if (
          crashAfterPendingCutCommit
          && committed.safety?.followerCuts?.['200']?.closed === null
        ) {
          crashAfterPendingCutCommit = false;
          throw new Error('simulated crash after pending let-run cut commit');
        }
        return committed;
      },
    };
    const first = await bootRuntime({ broker, group, time, store: crashStore });
    broker.emitEvent({
      type: 'order',
      order: leaderWorkingOrder({ brokerOrderId: 'leader-crash-entry', at: time.now() }),
    });
    await first.controller.waitForIdle();
    const followerOrder = broker.orders().find(order => order.accountId === 200);
    expect(followerOrder).toMatchObject({ status: 'working' });

    breached = true;
    time.advance(30_000);
    broker.emitEvent({ type: 'heartbeat', at: time.now() });
    await first.controller.waitForIdle();
    expect((await durableStore.load()).safety?.followerCuts?.['200']).toMatchObject({ closed: null });
    expect(broker.orders().find(order => order.brokerOrderId === followerOrder?.brokerOrderId))
      .toMatchObject({ status: 'working' });
    expect(broker.cancelRequestCount(followerOrder?.brokerOrderId ?? '')).toBe(0);
    first.controller.stop();
    broker.setConnected(false);

    const restarted = await bootstrapCopierRuntime({
      broker,
      store: crashStore,
      group,
      clock: time.clock,
    });
    try {
      broker.setConnected(true);
      await restarted.waitForIdle();
      await restarted.reconcile();
      await restarted.waitForIdle();

      expect(followerCut(restarted)).toMatchObject({ accountId: 200, closed: null });
      expect(broker.orders().find(order => order.brokerOrderId === followerOrder?.brokerOrderId))
        .toMatchObject({ status: 'canceled' });
      expect(broker.cancelRequestCount(followerOrder?.brokerOrderId ?? '')).toBe(1);
      expect(broker.liquidateRequests()).toHaveLength(0);
    } finally {
      restarted.stop();
    }
  });

  it('zpřísnění aktivního cutu let-run na close-copy dokončí zavření místo tichého přepnutí režimu', async () => {
    const time = manualClock();
    let breached = false;
    const broker = createMockBroker({
      clock: time.clock,
      nativeLiquidate: true,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const group = riskGroup({ onCut: 'let-run' });
    const runtime = await bootRuntime({ broker, group, time });
    try {
      await emitLeaderFill({
        ...runtime, time, side: 'Buy', quantity: 1, price: 20_000, netQuantity: 1,
      });
      breached = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();
      expect(followerCut(runtime.controller)).toMatchObject({ closed: null });

      const stricter = structuredClone(group);
      stricter.followers[0].onCut = 'close-copy';
      runtime.controller.updateGroup(stricter);
      await runtime.controller.waitForIdle();

      expect(followerCut(runtime.controller)).toMatchObject({ closed: expect.any(Number) });
      expect(broker.liquidateRequests()).toContainEqual(
        expect.objectContaining({ accountId: 200, symbol: 'MNQU6' }),
      );
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 0 }),
      ]);
    } finally {
      runtime.controller.stop();
    }
  });

  it('follower flat zruší stále working exit-only příkaz dřív, než by mohl otevřít reverse', async () => {
    const time = manualClock();
    let breached = false;
    const broker = createMockBroker({
      clock: time.clock,
      behavior: request => (
        request.side === 'Buy' || request.tag === 'test-external-flat'
          ? { kind: 'fill', price: 20_000 }
          : { kind: 'working' }
      ),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const runtime = await bootRuntime({
      broker,
      group: riskGroup({ mode: 'on-submit', onCut: 'let-run' }),
      time,
    });
    try {
      broker.emitEvent({
        type: 'order',
        order: leaderMarketOrder({ brokerOrderId: 'cut-flat-entry', side: 'Buy', quantity: 1, at: time.now() }),
      });
      broker.emitEvent(leaderPosition(1));
      await runtime.controller.waitForIdle();
      breached = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();

      broker.emitEvent({
        type: 'order',
        order: leaderMarketOrder({ brokerOrderId: 'cut-flat-reversal', side: 'Sell', quantity: 2, at: time.now() }),
      });
      await runtime.controller.waitForIdle();
      const exitOrder = broker.orders().find(order => (
        order.accountId === 200 && order.side === 'Sell' && order.status === 'working'
      ));
      expect(exitOrder).toBeDefined();

      await broker.placeOrder({
        accountId: 200,
        symbol: 'MNQU6',
        side: 'Sell',
        quantity: 1,
        orderType: 'Market',
        tag: 'test-external-flat',
      });
      await runtime.controller.waitForIdle();

      expect(broker.orders().find(order => order.brokerOrderId === exitOrder?.brokerOrderId))
        .toMatchObject({ status: 'canceled' });
      expect(broker.cancelRequestCount(exitOrder?.brokerOrderId ?? '')).toBe(1);
      expect(runtime.controller.status().lastError).toBe(null);
    } finally {
      runtime.controller.stop();
    }
  });

  it.each([
    ['Fill → Position', 'fill-first'],
    ['Position → Fill', 'position-first'],
  ] as const)(
    '%s u exit-only protective nohy zruší OCO sourozence a nikdy neotevře reverse',
    async (_label, eventOrder) => {
      const time = manualClock();
      let breached = false;
      let followerAuthoritativelyFlat = false;
      const broker = createMockBroker({
        clock: time.clock,
        behavior: request => (
          request.side === 'Buy'
            ? { kind: 'fill', price: 20_000 }
            : { kind: 'working' }
        ),
      });
      installRiskProvider(broker, accountId => riskSnapshot({
        accountId,
        at: time.now(),
        realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
      }));
      const listPositions = broker.listPositions.bind(broker);
      vi.spyOn(broker, 'listPositions').mockImplementation(async accountId => {
        const positions = await listPositions(accountId);
        if (accountId !== 200 || !followerAuthoritativelyFlat) return positions;
        return positions.map(position => (
          position.symbol === 'MNQU6' ? { ...position, netQuantity: 0 } : position
        ));
      });
      const runtime = await bootRuntime({
        broker,
        group: riskGroup({ mode: 'on-submit', onCut: 'let-run' }),
        time,
      });
      try {
        const leaderEntry = leaderMarketOrder({
          brokerOrderId: `cut-protective-entry-${eventOrder}`,
          side: 'Buy',
          quantity: 1,
          at: time.now(),
        });
        broker.emitEvent({ type: 'order', order: leaderEntry });
        broker.emitEvent({
          type: 'fill',
          fill: {
            ...brokerFill({ accountId: 100, side: 'Buy', price: 20_000, at: time.now() }),
            brokerOrderId: leaderEntry.brokerOrderId,
          },
        });
        broker.emitEvent(leaderPosition(1));
        await runtime.controller.waitForIdle();

        for (const [brokerOrderId, orderType, price] of [
          [`leader-cut-stop-${eventOrder}`, 'Stop', 19_950],
          [`leader-cut-target-${eventOrder}`, 'Limit', 20_100],
        ] as const) {
          broker.emitEvent({
            type: 'order',
            order: {
              tag: '', brokerOrderId, parentOrderId: leaderEntry.brokerOrderId,
              accountId: 100, symbol: 'MNQU6', side: 'Sell', orderType,
              quantity: 1, filledQuantity: 0, status: 'working',
              sourceVersion: `${brokerOrderId}:working`, updatedAt: time.now(),
              ...(orderType === 'Limit' ? { limitPrice: price } : { stopPrice: price }),
            },
          });
        }
        await runtime.controller.waitForIdle();
        expect(broker.placedOcoRequests().filter(request => request.accountId === 200)).toHaveLength(1);

        breached = true;
        time.advance(30_000);
        broker.emitEvent({ type: 'heartbeat', at: time.now() });
        await runtime.controller.waitForIdle();
        expect(followerCut(runtime.controller)).toMatchObject({ closed: null });

        const protectiveOrders = broker.orders().filter(order => (
          order.accountId === 200
          && order.symbol === 'MNQU6'
          && order.side === 'Sell'
          && (order.orderType === 'Stop' || order.orderType === 'Limit')
        ));
        expect(protectiveOrders).toHaveLength(2);
        const filledLeg = protectiveOrders[0];
        const siblingLeg = protectiveOrders[1];
        filledLeg.status = 'filled';
        filledLeg.filledQuantity = 1;
        followerAuthoritativelyFlat = true;
        const followerFill: BrokerFill = {
          fillId: `exit-only-protective-${eventOrder}`,
          tag: filledLeg.tag,
          brokerOrderId: filledLeg.brokerOrderId,
          accountId: 200,
          symbol: 'MNQU6',
          side: 'Sell',
          quantity: 1,
          price: 19_950,
          filledAt: time.now(),
        };

        if (eventOrder === 'fill-first') {
          broker.emitEvent({ type: 'fill', fill: followerFill });
          await runtime.controller.waitForIdle();
          // Ochranná noha musí být pryč už před opožděným Position eventem.
          expect(siblingLeg).toMatchObject({ status: 'canceled' });
          broker.emitEvent({
            type: 'position',
            position: { accountId: 200, symbol: 'MNQU6', netQuantity: 0 },
          });
        } else {
          broker.emitEvent({
            type: 'position',
            position: { accountId: 200, symbol: 'MNQU6', netQuantity: 0 },
          });
          await runtime.controller.waitForIdle();
          expect(siblingLeg).toMatchObject({ status: 'canceled' });
          broker.emitEvent({ type: 'fill', fill: followerFill });
        }
        await runtime.controller.waitForIdle();

        expect(siblingLeg).toMatchObject({ status: 'canceled' });
        expect(broker.cancelRequestCount(siblingLeg.brokerOrderId)).toBe(1);
        expect(await broker.listPositions(200)).toEqual([
          expect.objectContaining({ symbol: 'MNQU6', netQuantity: 0 }),
        ]);
        expect(broker.placedRequests().filter(request => request.accountId === 200)).toHaveLength(1);
        expect(runtime.controller.status()).toMatchObject({ armed: true, lastError: null });
      } finally {
        runtime.controller.stop();
      }
    },
  );

  it('zastaralý broker snapshot účet nevyřadí a ve statusu zůstane neověřený', async () => {
    const time = manualClock();
    const broker = createMockBroker({ clock: time.clock });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now() - 90_001,
      realizedPnlUsd: accountId === 200 ? -1_000 : 0,
    }));
    const runtime = await bootRuntime({ broker, group: riskGroup(), time });
    try {
      expect(runtime.controller.status().followerCuts).toEqual([]);
      expect(accountRisk(runtime.controller, 200)).toMatchObject({
        verifiedAt: time.now() - 90_001,
        realizedPnlUsd: -1_000,
        error: 'stale-snapshot',
      });
      expect(runtime.controller.status()).toMatchObject({ armed: true, lastError: null, dayLockUntil: 0 });
      expect(broker.liquidateRequests()).toHaveLength(0);
    } finally {
      runtime.controller.stop();
    }
  });

  it('propLimit používá broker auto-liq před fallbackem a validace odmítne cut nad 95 %', async () => {
    const time = manualClock();
    const broker = createMockBroker({ clock: time.clock });
    installRiskProvider(broker, accountId => {
      if (accountId === 200) {
        return riskSnapshot({
          accountId,
          at: time.now(),
          netLiq: 50_000,
          minNetLiq: 48_000,
          dailyLossAutoLiq: 1_000,
        });
      }
      if (accountId === 201) {
        return riskSnapshot({
          accountId,
          at: time.now(),
          netLiq: 50_000,
          minNetLiq: 48_750,
        });
      }
      return riskSnapshot({ accountId, at: time.now() });
    });
    const group = riskGroup({ mode: 'on-submit', cutUsd: 900 });
    const runtime = await bootRuntime({ broker, group, time, shadowMode: true });
    try {
      expect(accountRisk(runtime.controller, 200)?.propLimitUsd).toBe(1_000);
      expect(accountRisk(runtime.controller, 201)?.propLimitUsd).toBe(1_250);
      runtime.controller.disarm();

      const boundary = riskGroup({ mode: 'on-submit', cutUsd: 950 });
      expect(() => runtime.controller.updateGroup(boundary)).not.toThrow();
      const tooHigh = riskGroup({ mode: 'on-submit', cutUsd: 950.01 });
      expect(() => runtime.controller.updateGroup(tooHigh)).toThrow('nejvýše 95 % prop limitu');
    } finally {
      runtime.controller.stop();
    }
  });

  it('chyba risk pollu jde jen do accountRisk.error a nikdy do execution lastError', async () => {
    const time = manualClock();
    const broker = createMockBroker({ clock: time.clock });
    vi.spyOn(broker, 'listAccountRiskSnapshots').mockRejectedValue(new Error('risk endpoint unavailable'));
    const runtime = await bootRuntime({ broker, group: riskGroup(), time });
    try {
      expect(runtime.controller.status()).toMatchObject({
        armed: true,
        lastError: null,
        followerCuts: [],
      });
      for (const accountId of [100, 200, 201]) {
        expect(accountRisk(runtime.controller, accountId)).toMatchObject({
          accountId,
          error: 'risk endpoint unavailable',
        });
      }
      expect(broker.placedRequests()).toHaveLength(0);
      expect(broker.liquidateRequests()).toHaveLength(0);
    } finally {
      runtime.controller.stop();
    }
  });

  it('selhání persistence broker snapshotu nepotlačí už ověřený follower cut', async () => {
    const time = manualClock();
    let breached = false;
    let failRiskSnapshotCommit = false;
    const broker = createMockBroker({ clock: time.clock });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const durableStore = createMemoryCopierStore();
    const store: CopierStore = {
      load: () => durableStore.load(),
      commit: async (snapshot, expectedRevision) => {
        if (
          failRiskSnapshotCommit
          && snapshot.safety?.accountRisk?.['200']?.realizedPnlUsd === -125
          && Object.keys(snapshot.safety?.followerCuts ?? {}).length === 0
        ) {
          failRiskSnapshotCommit = false;
          throw new Error('risk snapshot commit failed');
        }
        return durableStore.commit(snapshot, expectedRevision);
      },
    };
    const runtime = await bootRuntime({
      broker,
      group: riskGroup({ onCut: 'let-run' }),
      time,
      store,
    });
    try {
      breached = true;
      failRiskSnapshotCommit = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();

      expect(followerCut(runtime.controller)).toMatchObject({
        accountId: 200,
        source: 'broker',
        realizedPnlUsd: -125,
      });
      expect(runtime.controller.status()).toMatchObject({
        armed: true,
        lastError: null,
        dayLockUntil: 0,
      });
      expect((await durableStore.load()).safety?.followerCuts?.['200']).toMatchObject({
        accountId: 200,
        source: 'broker',
      });
    } finally {
      runtime.controller.stop();
    }
  });

  it('pozdní broker snapshot z minulé session nevyřadí followera v nové session', async () => {
    const time = manualClock();
    const broker = createMockBroker({ clock: time.clock });
    const provider = (accountId: number) => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: 0,
    });
    const poll = installRiskProvider(broker, provider);
    const runtime = await bootRuntime({
      broker,
      group: riskGroup({ onCut: 'let-run' }),
      time,
    });
    try {
      const oldSessionEndAt = runtime.controller.status().dailyStats?.sessionEndAt;
      expect(oldSessionEndAt).toBeTypeOf('number');

      let releaseOldPoll: ((snapshots: BrokerAccountRiskSnapshot[]) => void) | undefined;
      let holdNextFollowerPoll = true;
      const oldPollStarted = new Promise<void>(resolve => {
        poll.mockImplementation(async accountIds => {
          if (holdNextFollowerPoll && accountIds.length === 1 && accountIds[0] === 200) {
            holdNextFollowerPoll = false;
            resolve();
            return new Promise<BrokerAccountRiskSnapshot[]>(release => {
              releaseOldPoll = release;
            });
          }
          return [...new Set(accountIds)].map(provider);
        });
      });

      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await oldPollStarted;

      time.set((oldSessionEndAt as number) + 1);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((runtime.controller.status().dailyStats?.sessionEndAt ?? 0) > time.now()) break;
        await Promise.resolve();
      }
      expect(runtime.controller.status().dailyStats?.sessionEndAt).toBeGreaterThan(time.now());

      releaseOldPoll?.([riskSnapshot({
        accountId: 200,
        at: time.now() - 30_001,
        realizedPnlUsd: -125,
      })]);
      await runtime.controller.waitForIdle();

      expect(poll).toHaveBeenCalledTimes(9);
      expect(runtime.controller.status()).toMatchObject({
        armed: true,
        followerCuts: [],
        dayLockUntil: 0,
        lastError: null,
      });
    } finally {
      runtime.controller.stop();
    }
  });

  it('nově zjištěný prop limit slabší než aktivní cut disarmuje fail-closed', async () => {
    const time = manualClock();
    let propLimitKnown = false;
    const broker = createMockBroker({ clock: time.clock });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: 0,
      dailyLossAutoLiq: accountId === 200 && propLimitKnown ? 100 : null,
    }));
    const runtime = await bootRuntime({
      broker,
      group: riskGroup({ cutUsd: 100 }),
      time,
    });
    try {
      expect(runtime.controller.status()).toMatchObject({ armed: true, lastError: null });

      propLimitKnown = true;
      time.advance(30_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();

      expect(runtime.controller.status().armed).toBe(false);
      expect(runtime.controller.status().lastError).toContain('nejvýše 95 % prop limitu');
      expect(followerCut(runtime.controller)).toBeUndefined();
    } finally {
      runtime.controller.stop();
    }
  });

  it('polluje nejvýše po 30 s a vlastní fill vynutí okamžitý poll daného účtu', async () => {
    const time = manualClock();
    const broker = createMockBroker({ clock: time.clock });
    const poll = installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
    }));
    const runtime = await bootRuntime({ broker, group: riskGroup(), time });
    try {
      expect(poll).toHaveBeenCalledTimes(3);
      expect(poll.mock.calls.slice(0, 3).map(([accountIds]) => accountIds)).toEqual([[100], [200], [201]]);

      time.advance(29_999);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();
      expect(poll).toHaveBeenCalledTimes(3);

      time.advance(1);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();
      expect(poll).toHaveBeenCalledTimes(6);
      expect(poll.mock.calls.slice(3, 6).map(([accountIds]) => accountIds)).toEqual([[100], [200], [201]]);

      time.advance(1);
      broker.emitEvent({
        type: 'fill',
        fill: brokerFill({
          accountId: 200,
          side: 'Buy',
          price: 20_000,
          at: time.now(),
        }),
      });
      await runtime.controller.waitForIdle();
      expect(poll).toHaveBeenCalledTimes(7);
      expect(poll).toHaveBeenLastCalledWith([200]);
    } finally {
      runtime.controller.stop();
    }
  });

  it('cut přežije restart a runtime dál blokuje entry jen pro vyřazený účet', async () => {
    const time = manualClock();
    let breached = true;
    const broker = createMockBroker({
      clock: time.clock,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const group = riskGroup({ onCut: 'let-run' });
    const store = createMemoryCopierStore();
    const first = await bootRuntime({ broker, group, time, store });
    expect(followerCut(first.controller)).toMatchObject({ accountId: 200, source: 'broker' });
    first.controller.stop();
    broker.setConnected(false);
    breached = false;

    const audits: CopierAuditEntry[] = [];
    const restarted = await bootstrapCopierRuntime({
      broker,
      store,
      group,
      clock: time.clock,
      onAudit: entries => audits.push(...entries),
    });
    try {
      expect(followerCut(restarted)).toMatchObject({ accountId: 200, source: 'broker' });
      expect(accountRisk(restarted, 200)).toMatchObject({ realizedPnlUsd: -125 });
      broker.setConnected(true);
      await restarted.waitForIdle();
      await restarted.reconcile();
      restarted.arm();
      await restarted.waitForIdle();
      broker.emitEvent({
        type: 'fill',
        fill: brokerFill({ accountId: 100, side: 'Buy', price: 20_000, at: time.now() }),
      });
      await restarted.waitForIdle();

      expect(broker.placedRequests()).toEqual([
        expect.objectContaining({ accountId: 201, side: 'Buy' }),
      ]);
      expect(restarted.status()).toMatchObject({ armed: true, dayLockUntil: 0, lastError: null });
      expect(audits.filter(entry => entry.kind === 'follower-cut')).toHaveLength(0);
    } finally {
      restarted.stop();
    }
  });

  it('nová broker session cut resetuje a obnoví followera bez automatického ARM', async () => {
    const time = manualClock();
    let breached = true;
    const broker = createMockBroker({
      clock: time.clock,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    installRiskProvider(broker, accountId => riskSnapshot({
      accountId,
      at: time.now(),
      realizedPnlUsd: accountId === 200 && breached ? -125 : 0,
    }));
    const runtime = await bootRuntime({ broker, group: riskGroup({ onCut: 'let-run' }), time });
    try {
      expect(followerCut(runtime.controller)).toBeDefined();
      runtime.controller.disarm();
      const sessionEndAt = runtime.controller.status().dailyStats?.sessionEndAt;
      expect(sessionEndAt).toBeTypeOf('number');
      breached = false;
      time.set((sessionEndAt as number) + 1);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await runtime.controller.waitForIdle();

      expect(runtime.controller.status()).toMatchObject({ armed: false, followerCuts: [] });
      expect(() => runtime.controller.arm()).not.toThrow();
      await runtime.controller.waitForIdle();
      broker.emitEvent({
        type: 'fill',
        fill: brokerFill({ accountId: 100, side: 'Buy', price: 20_000, at: time.now() }),
      });
      await runtime.controller.waitForIdle();
      expect(broker.placedRequests().map(request => request.accountId).sort()).toEqual([200, 201]);
      expect(runtime.controller.status()).toMatchObject({ armed: true, followerCuts: [], dayLockUntil: 0 });
    } finally {
      runtime.controller.stop();
    }
  });

  it('odmítne cut na leader účtu a částku mimo povolenou přesnost', async () => {
    const leaderAsFollower = riskGroup();
    leaderAsFollower.followers[0] = {
      ...leaderAsFollower.followers[0],
      accountId: leaderAsFollower.leaderAccountId!,
    };
    await expect(bootstrapCopierRuntime({
      broker: createMockBroker(),
      store: createMemoryCopierStore(),
      group: leaderAsFollower,
    })).rejects.toThrow('Leader nemůže být zároveň follower');

    const overPrecise = riskGroup({ cutUsd: 10.001 });
    await expect(bootstrapCopierRuntime({
      broker: createMockBroker(),
      store: createMemoryCopierStore(),
      group: overPrecise,
    })).rejects.toThrow('nejvýš 2 desetinná místa');
  });
});
