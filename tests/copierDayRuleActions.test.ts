import { describe, expect, it } from 'vitest';
import type { BrokerOrder, BrokerOrderRequest } from '../services/brokerPort';
import type { CopierDailyRule } from '../services/copierEngine';
import {
  bootstrapCopierRuntime,
  type CopierRuntimeController,
} from '../services/copierRuntimeController';
import { createMemoryCopierStore, type CopierStore } from '../services/copierStore';
import type { CopierAuditEntry } from '../services/copierRunner';
import { createMockBroker, type MockBroker, type MockOrderOutcome } from '../services/mockBroker';
import {
  cloneDayRuleActions,
  DEFAULT_COPY_GROUP_SAFETY,
  type CopyGroupConfig,
} from '../services/liveCopyTrading';

const DEFAULT_NOW = Date.parse('2026-09-08T16:00:00.000Z');
const UNSUPPORTED_UNLOCK = 'unlock-day není podporován: den se odemyká jen koncem session';

const manualClock = (initial = DEFAULT_NOW) => {
  let value = initial;
  return {
    clock: () => value,
    now: () => value,
    set: (next: number) => { value = next; },
    advance: (milliseconds: number) => { value += milliseconds; },
  };
};

const copyGroup = (mode: 'on-submit' | 'on-fill' = 'on-submit'): CopyGroupConfig => ({
  id: 'pause-group',
  name: 'Pause group',
  enabled: true,
  leaderAccountId: 100,
  followers: [{ accountId: 200, mode, multiplier: 1 }],
  safety: {
    ...DEFAULT_COPY_GROUP_SAFETY,
    dailyLossLimitUsd: 0,
    dailyMaxLosingTrades: 0,
    dailyMaxTrades: 0,
    entryCooldownMinutes: 0,
    tradingWindow: {
      enabled: false,
      from: '15:30',
      to: '22:00',
      timeZone: 'Europe/Prague',
    },
    dayRuleActions: cloneDayRuleActions(DEFAULT_COPY_GROUP_SAFETY.dayRuleActions),
  },
});

let eventSequence = 0;

const leaderFill = (
  side: 'Buy' | 'Sell',
  price: number,
  at: number,
  quantity = 1,
) => {
  eventSequence += 1;
  return {
    type: 'fill' as const,
    fill: {
      fillId: `pause-fill-${eventSequence}`,
      tag: '',
      brokerOrderId: `pause-leader-${eventSequence}`,
      accountId: 100,
      symbol: 'MNQU6',
      side,
      quantity,
      price,
      filledAt: at,
    },
  };
};

const leaderPosition = (netQuantity: number) => ({
  type: 'position' as const,
  position: { accountId: 100, symbol: 'MNQU6', netQuantity },
});

const leaderMarketOrder = (
  at: number,
  {
    brokerOrderId,
    side = 'Buy',
    quantity = 1,
  }: { brokerOrderId?: string; side?: 'Buy' | 'Sell'; quantity?: number } = {},
): BrokerOrder => {
  eventSequence += 1;
  return {
    tag: '',
    brokerOrderId: brokerOrderId ?? `pause-entry-${eventSequence}`,
    accountId: 100,
    symbol: 'MNQU6',
    side,
    orderType: 'Market',
    quantity,
    filledQuantity: 0,
    status: 'working',
    sourceVersion: `${eventSequence}:Working`,
    updatedAt: at,
  };
};

const leaderProtectiveOrder = ({
  brokerOrderId,
  parentOrderId,
  orderType,
  price,
  at,
}: {
  brokerOrderId: string;
  parentOrderId: string;
  orderType: 'Limit' | 'Stop';
  price: number;
  at: number;
}): BrokerOrder => {
  eventSequence += 1;
  return {
    tag: '',
    brokerOrderId,
    parentOrderId,
    accountId: 100,
    symbol: 'MNQU6',
    side: 'Sell',
    orderType,
    quantity: 1,
    filledQuantity: 0,
    status: 'working',
    sourceVersion: `${eventSequence}:Working`,
    updatedAt: at,
    ...(orderType === 'Limit' ? { limitPrice: price } : { stopPrice: price }),
  };
};

interface BootedRuntime {
  broker: MockBroker;
  controller: CopierRuntimeController;
  store: CopierStore;
  audits: CopierAuditEntry[];
}

const bootLive = async ({
  group,
  time,
  store = createMemoryCopierStore(),
  behavior = () => ({ kind: 'working' }),
  nativeLiquidate = false,
}: {
  group: CopyGroupConfig;
  time: ReturnType<typeof manualClock>;
  store?: CopierStore;
  behavior?: (request: BrokerOrderRequest, attempt: number) => MockOrderOutcome;
  nativeLiquidate?: boolean;
}): Promise<BootedRuntime> => {
  const audits: CopierAuditEntry[] = [];
  const broker = createMockBroker({
    clock: time.clock,
    behavior,
    nativeLiquidate,
  });
  const controller = await bootstrapCopierRuntime({
    broker,
    store,
    group,
    clock: time.clock,
    onAudit: entries => audits.push(...entries),
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  controller.arm();
  await controller.waitForIdle();
  return { broker, controller, store, audits };
};

const completeLeaderTrade = async ({
  broker,
  controller,
  time,
  exitPrice,
}: {
  broker: MockBroker;
  controller: CopierRuntimeController;
  time: ReturnType<typeof manualClock>;
  exitPrice: number;
}): Promise<number> => {
  broker.emitEvent(leaderFill('Buy', 20_000, time.now()));
  broker.emitEvent(leaderPosition(1));
  await controller.waitForIdle();
  time.advance(1_000);
  const closedAt = time.now();
  broker.emitEvent(leaderFill('Sell', exitPrice, closedAt));
  broker.emitEvent(leaderPosition(0));
  await controller.waitForIdle();
  return closedAt;
};

type TriggerScenario = {
  name: string;
  rule: CopierDailyRule;
  minutes: number;
  exitPrice: number;
  configure: (group: CopyGroupConfig) => void;
};

const triggerScenarios: TriggerScenario[] = [
  {
    name: 'beforeLimit ztrátových obchodů',
    rule: 'losing-trades',
    minutes: 5,
    exitPrice: 19_995,
    configure: group => {
      group.safety!.dailyMaxLosingTrades = 2;
      group.safety!.dayRuleActions.losingTrades.beforeLimit = { kind: 'pause', minutes: 5 };
    },
  },
  {
    name: '80 % denní ztráty',
    rule: 'daily-loss',
    minutes: 7,
    exitPrice: 19_960,
    configure: group => {
      group.safety!.dailyLossLimitUsd = 100;
      group.safety!.dayRuleActions.dailyLoss.at80Percent = { kind: 'pause', minutes: 7 };
    },
  },
  {
    name: 'limit počtu obchodů',
    rule: 'max-trades',
    minutes: 9,
    exitPrice: 20_001,
    configure: group => {
      group.safety!.dailyMaxTrades = 1;
      group.safety!.dayRuleActions.maxTrades.atLimit = { kind: 'pause', minutes: 9 };
    },
  },
];

describe('CopierRuntimeController — akce pravidel dne', () => {
  it.each(triggerScenarios)('spustí nakonfigurovanou pauzu: $name', async scenario => {
    const time = manualClock();
    const group = copyGroup();
    scenario.configure(group);
    const { broker, controller, audits } = await bootLive({ group, time });
    try {
      const triggeredAt = await completeLeaderTrade({
        broker,
        controller,
        time,
        exitPrice: scenario.exitPrice,
      });
      const until = triggeredAt + scenario.minutes * 60_000;

      expect(controller.status()).toMatchObject({
        armed: true,
        pause: { rule: scenario.rule, at: triggeredAt, until },
        dayLockUntil: 0,
        autoClose: null,
      });
      expect(audits).toContainEqual(expect.objectContaining({
        kind: 'rule-pause',
        rule: scenario.rule,
        until,
      }));
      expect(broker.placedRequests()).toHaveLength(0);
      expect(broker.liquidateRequests()).toHaveLength(0);
    } finally {
      controller.stop();
    }
  });

  it('window-end pauza drží ARM, nic nezavírá, blokuje entry přesným důvodem a dál kopíruje exit', async () => {
    const time = manualClock(Date.parse('2026-01-15T20:59:00.000Z'));
    const group = copyGroup('on-fill');
    group.safety!.tradingWindow = {
      enabled: true,
      from: '15:30',
      to: '22:00',
      timeZone: 'Europe/Prague',
    };
    group.safety!.dayRuleActions.windowEnd.atEnd = { kind: 'pause', minutes: 11 };
    const { broker, controller, audits } = await bootLive({
      group,
      time,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
      nativeLiquidate: true,
    });
    try {
      broker.emitEvent(leaderFill('Buy', 20_000, time.now()));
      broker.emitEvent(leaderPosition(1));
      await controller.waitForIdle();
      expect(broker.placedRequests()).toEqual([
        expect.objectContaining({ accountId: 200, side: 'Buy', quantity: 1 }),
      ]);

      time.set(Date.parse('2026-01-15T21:00:00.000Z'));
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await controller.waitForIdle();
      const until = time.now() + 11 * 60_000;
      expect(controller.status()).toMatchObject({
        armed: true,
        pause: { rule: 'window-end', at: time.now(), until },
        dayLockUntil: 0,
        autoClose: null,
      });
      expect(broker.placedRequests()).toHaveLength(1);
      expect(broker.liquidateRequests()).toHaveLength(0);

      // Snižující fill musí přes běžící pauzu followera zavřít.
      time.advance(1_000);
      broker.emitEvent(leaderFill('Sell', 20_001, time.now()));
      broker.emitEvent(leaderPosition(0));
      await controller.waitForIdle();
      expect(broker.placedRequests()).toEqual([
        expect.objectContaining({ accountId: 200, side: 'Buy', quantity: 1 }),
        expect.objectContaining({ accountId: 200, side: 'Sell', quantity: 1 }),
      ]);

      // Nový zvyšující fill je zaznamenán, ale nesmí založit follower order.
      time.advance(1_000);
      broker.emitEvent(leaderFill('Buy', 20_010, time.now()));
      await controller.waitForIdle();
      expect(broker.placedRequests()).toHaveLength(2);
      expect(controller.status().armed).toBe(true);
      expect(audits).toContainEqual(expect.objectContaining({
        kind: 'blocked',
        rule: 'window-end',
        until,
        reason: `pause:window-end:${until}`,
      }));
    } finally {
      controller.stop();
    }
  });

  it('zkopíruje ochranný exit i když leader Position=0 dorazí před Fillem během pauzy', async () => {
    const time = manualClock(Date.parse('2026-01-15T20:59:00.000Z'));
    const group = copyGroup('on-fill');
    group.safety!.tradingWindow = {
      enabled: true,
      from: '15:30',
      to: '22:00',
      timeZone: 'Europe/Prague',
    };
    group.safety!.dayRuleActions.windowEnd.atEnd = { kind: 'pause', minutes: 5 };
    const { broker, controller } = await bootLive({
      group,
      time,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    try {
      const entry = leaderFill('Buy', 20_000, time.now());
      broker.emitEvent(entry);
      broker.emitEvent(leaderPosition(1));
      await controller.waitForIdle();

      const stopOrderId = `pause-stop-${eventSequence}`;
      broker.emitEvent({
        type: 'order',
        order: leaderProtectiveOrder({
          brokerOrderId: stopOrderId,
          parentOrderId: entry.fill.brokerOrderId,
          orderType: 'Stop',
          price: 19_950,
          at: time.now(),
        }),
      });
      await controller.waitForIdle();

      time.set(Date.parse('2026-01-15T21:00:00.000Z'));
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await controller.waitForIdle();
      expect(controller.status().pause).toMatchObject({ rule: 'window-end' });

      // Tradovate smí projekci Position doručit dřív než závěrečný Fill.
      broker.emitEvent(leaderPosition(0));
      await controller.waitForIdle();
      broker.emitEvent({
        type: 'fill',
        fill: {
          fillId: `pause-protective-fill-${eventSequence}`,
          tag: '',
          brokerOrderId: stopOrderId,
          accountId: 100,
          symbol: 'MNQU6',
          side: 'Sell',
          quantity: 1,
          price: 19_950,
          filledAt: time.now(),
        },
      });
      await controller.waitForIdle();

      expect(broker.placedRequests()).toEqual([
        expect.objectContaining({ accountId: 200, side: 'Buy', quantity: 1 }),
        expect.objectContaining({ accountId: 200, side: 'Sell', quantity: 1 }),
      ]);
      expect(controller.status()).toMatchObject({ armed: true, pause: { rule: 'window-end' } });
    } finally {
      controller.stop();
    }
  });

  it('nevytvoří orphan bracket po on-fill entry zablokovaném během pauzy', async () => {
    const time = manualClock(Date.parse('2026-01-15T20:59:00.000Z'));
    const group = copyGroup('on-fill');
    group.safety!.tradingWindow = {
      enabled: true,
      from: '15:30',
      to: '22:00',
      timeZone: 'Europe/Prague',
    };
    group.safety!.dayRuleActions.windowEnd.atEnd = { kind: 'pause', minutes: 5 };
    group.followers.push({ accountId: 300, mode: 'on-submit', multiplier: 1 });
    const { broker, controller, audits } = await bootLive({ group, time });
    try {
      // Předprahový heartbeat uloží warning; následující atEnd musí skutečně založit pauzu.
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await controller.waitForIdle();
      time.set(Date.parse('2026-01-15T21:00:00.000Z'));
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await controller.waitForIdle();
      expect(controller.status().pause).toMatchObject({ rule: 'window-end' });

      const blockedEntry = leaderFill('Buy', 20_000, time.now());
      broker.emitEvent(blockedEntry);
      broker.emitEvent(leaderPosition(1));
      await controller.waitForIdle();
      expect(broker.placedRequests()).toHaveLength(0);

      broker.emitEvent({
        type: 'order',
        order: leaderProtectiveOrder({
          brokerOrderId: `blocked-stop-${eventSequence}`,
          parentOrderId: blockedEntry.fill.brokerOrderId,
          orderType: 'Stop',
          price: 19_950,
          at: time.now(),
        }),
      });
      broker.emitEvent({
        type: 'order',
        order: leaderProtectiveOrder({
          brokerOrderId: `blocked-target-${eventSequence}`,
          parentOrderId: blockedEntry.fill.brokerOrderId,
          orderType: 'Limit',
          price: 20_100,
          at: time.now(),
        }),
      });
      await controller.waitForIdle();

      expect(broker.placedRequests()).toHaveLength(0);
      expect(broker.placedOcoRequests()).toHaveLength(0);
      expect(controller.status()).toMatchObject({ armed: true, pause: { rule: 'window-end' } });
    } finally {
      controller.stop();
    }
  });

  it('aplikuje at-limit pauzu i při prvním přímém skoku přes warning threshold', async () => {
    const time = manualClock();
    const group = copyGroup();
    group.safety!.dailyLossLimitUsd = 100;
    group.safety!.dayRuleActions.dailyLoss.at80Percent = null;
    group.safety!.dayRuleActions.dailyLoss.atLimit = { kind: 'pause', minutes: 12 };
    const { broker, controller, audits } = await bootLive({ group, time });
    try {
      const triggeredAt = await completeLeaderTrade({
        broker,
        controller,
        time,
        exitPrice: 19_950,
      });

      expect(controller.status().pause).toEqual({
        rule: 'daily-loss',
        at: triggeredAt,
        until: triggeredAt + 12 * 60_000,
      });
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('u simultánních pause kandidátů použije nejdelší konec pauzy', async () => {
    const time = manualClock();
    const group = copyGroup();
    group.safety!.dailyLossLimitUsd = 100;
    group.safety!.dailyMaxLosingTrades = 2;
    group.safety!.dayRuleActions.dailyLoss.at80Percent = { kind: 'pause', minutes: 5 };
    group.safety!.dayRuleActions.losingTrades.beforeLimit = { kind: 'pause', minutes: 20 };
    const { broker, controller } = await bootLive({ group, time });
    try {
      const triggeredAt = await completeLeaderTrade({
        broker,
        controller,
        time,
        exitPrice: 19_960,
      });

      expect(controller.status().pause?.until).toBe(triggeredAt + 20 * 60_000);
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('pauza vyprší sama, emituje jediný end audit a další entry znovu projde', async () => {
    const time = manualClock();
    const group = copyGroup();
    group.safety!.dailyLossLimitUsd = 100;
    group.safety!.dayRuleActions.dailyLoss.at80Percent = { kind: 'pause', minutes: 1 };
    const { broker, controller, audits } = await bootLive({ group, time });
    try {
      const triggeredAt = await completeLeaderTrade({
        broker,
        controller,
        time,
        exitPrice: 19_960,
      });
      const until = triggeredAt + 60_000;
      expect(controller.status().pause).toEqual({ rule: 'daily-loss', at: triggeredAt, until });

      time.set(until);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await controller.waitForIdle();
      expect(controller.status()).toMatchObject({ armed: true, pause: null });
      expect(audits.filter(entry => entry.kind === 'rule-pause-end')).toEqual([
        expect.objectContaining({ rule: 'daily-loss', until }),
      ]);

      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      broker.emitEvent({ type: 'order', order: leaderMarketOrder(time.now()) });
      await controller.waitForIdle();
      expect(audits.filter(entry => entry.kind === 'rule-pause-end')).toHaveLength(1);
      expect(broker.placedRequests()).toEqual([
        expect.objectContaining({ accountId: 200, side: 'Buy', quantity: 1 }),
      ]);
    } finally {
      controller.stop();
    }
  });

  it('at-limit lock přebije běžící beforeLimit pauzu a čeká na flat', async () => {
    const time = manualClock();
    const group = copyGroup();
    group.safety!.dailyMaxLosingTrades = 2;
    group.safety!.dayRuleActions.losingTrades.beforeLimit = { kind: 'pause', minutes: 20 };
    group.safety!.dayRuleActions.losingTrades.atLimit = { kind: 'lock' };
    const { broker, controller, store, audits } = await bootLive({ group, time });
    try {
      await completeLeaderTrade({ broker, controller, time, exitPrice: 19_995 });
      const firstPause = controller.status().pause;
      expect(firstPause).toMatchObject({ rule: 'losing-trades' });
      expect(controller.status().armed).toBe(true);

      time.advance(1_000);
      broker.emitEvent(leaderFill('Buy', 20_000, time.now()));
      broker.emitEvent(leaderPosition(1));
      await controller.waitForIdle();
      time.advance(1_000);
      broker.emitEvent(leaderFill('Sell', 19_990, time.now()));
      await controller.waitForIdle();

      // Finální limit už založil lock, ale otevřený leader ho zatím nesmí aktivovat.
      expect(controller.status()).toMatchObject({ armed: true, dayLockUntil: 0 });
      broker.emitEvent(leaderPosition(0));
      await controller.waitForIdle();

      expect(controller.status()).toMatchObject({
        armed: false,
        dayLockTrigger: 'losing-trades',
      });
      expect(controller.status().dayLockUntil).toBeGreaterThan(time.now());
      // Lock pauzu nemaže; pouze nad ní dostane prioritu.
      expect((await store.load()).safety).toMatchObject({
        pauseUntil: firstPause?.until,
        pauseRule: 'losing-trades',
      });
      expect(audits).toContainEqual(expect.objectContaining({
        kind: 'blocked',
        reason: expect.stringContaining('auto day-lock trigger=losing-trades'),
      }));
      expect(broker.liquidateRequests()).toHaveLength(0);
    } finally {
      controller.stop();
    }
  });

  it('restart obnoví pending automatický lock z durable warningu a po flat ho dokončí', async () => {
    const time = manualClock();
    const group = copyGroup('on-fill');
    // Platný follower zůstává v topologii, ale tento 2-lot test při 0,1×
    // nevytvoří brokerovou pozici; pending lock tak drží otevřený leader.
    group.followers[0].multiplier = 0.1;
    group.safety!.dailyLossLimitUsd = 100;
    group.safety!.dayRuleActions.dailyLoss.at80Percent = { kind: 'lock' };
    const store = createMemoryCopierStore();
    const first = await bootLive({ group, time, store });

    first.broker.emitEvent(leaderFill('Buy', 20_000, time.now(), 2));
    first.broker.emitEvent(leaderPosition(2));
    await first.controller.waitForIdle();
    time.advance(1_000);
    first.broker.emitEvent(leaderFill('Sell', 19_960, time.now()));
    first.broker.emitEvent(leaderPosition(1));
    await first.controller.waitForIdle();
    expect(first.controller.status()).toMatchObject({ armed: true, dayLockUntil: 0 });
    expect((await store.load()).safety?.dailyStats?.warnedRules).toContainEqual(
      expect.objectContaining({ rule: 'daily-loss' }),
    );
    first.controller.stop();
    first.broker.setConnected(false);

    const restarted = await bootstrapCopierRuntime({
      broker: first.broker,
      store,
      group,
      clock: time.clock,
    });
    try {
      first.broker.setConnected(true);
      await restarted.waitForIdle();
      await restarted.reconcile();
      first.broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await restarted.waitForIdle();

      expect(restarted.status()).toMatchObject({
        armed: false,
        dayLockTrigger: 'daily-loss',
      });
      expect(restarted.status().dayLockUntil).toBeGreaterThan(time.now());
      expect((await store.load()).safety).toMatchObject({
        dayLockTrigger: 'daily-loss',
        dayLockUntil: expect.any(Number),
      });
    } finally {
      restarted.stop();
    }
  });

  it('další pause akce běžící pauzu pouze prodlouží na maximum', async () => {
    const time = manualClock();
    const group = copyGroup();
    group.safety!.dailyLossLimitUsd = 100;
    group.safety!.dailyMaxTrades = 2;
    group.safety!.dayRuleActions.dailyLoss.at80Percent = { kind: 'pause', minutes: 10 };
    group.safety!.dayRuleActions.maxTrades.atLimit = { kind: 'pause', minutes: 15 };
    const { broker, controller } = await bootLive({ group, time });
    try {
      await completeLeaderTrade({ broker, controller, time, exitPrice: 19_960 });
      const firstUntil = controller.status().pause?.until ?? 0;

      time.advance(1_000);
      broker.emitEvent(leaderFill('Buy', 20_000, time.now()));
      broker.emitEvent(leaderPosition(1));
      await controller.waitForIdle();
      time.advance(1_000);
      const secondClosedAt = time.now();
      broker.emitEvent(leaderFill('Sell', 20_001, secondClosedAt));
      broker.emitEvent(leaderPosition(0));
      await controller.waitForIdle();

      expect(controller.status().pause).toEqual({
        rule: 'max-trades',
        at: secondClosedAt,
        until: secondClosedAt + 15 * 60_000,
      });
      expect(controller.status().pause!.until).toBeGreaterThan(firstUntil);
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('on-fill reversal rozdělený do dvou fillů zavře followera, ale druhý fill přes flat ho neotočí', async () => {
    const time = manualClock(Date.parse('2026-01-15T20:59:00.000Z'));
    const group = copyGroup('on-fill');
    group.safety!.tradingWindow = {
      enabled: true,
      from: '15:30',
      to: '22:00',
      timeZone: 'Europe/Prague',
    };
    group.safety!.dayRuleActions.windowEnd.atEnd = { kind: 'pause', minutes: 10 };
    const { broker, controller } = await bootLive({
      group,
      time,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    try {
      broker.emitEvent(leaderFill('Buy', 20_000, time.now()));
      broker.emitEvent(leaderPosition(1));
      await controller.waitForIdle();

      time.set(Date.parse('2026-01-15T21:00:00.000Z'));
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await controller.waitForIdle();

      const reversalOrderId = 'leader-partial-reversal';
      broker.emitEvent({
        type: 'fill',
        fill: {
          fillId: 'leader-partial-reversal-1', tag: '', brokerOrderId: reversalOrderId,
          accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 1, price: 19_990,
          filledAt: time.now(),
        },
      });
      broker.emitEvent(leaderPosition(0));
      await controller.waitForIdle();
      broker.emitEvent({
        type: 'fill',
        fill: {
          fillId: 'leader-partial-reversal-2', tag: '', brokerOrderId: reversalOrderId,
          accountId: 100, symbol: 'MNQU6', side: 'Sell', quantity: 1, price: 19_985,
          filledAt: time.now(),
        },
      });
      broker.emitEvent(leaderPosition(-1));
      await controller.waitForIdle();

      expect(broker.placedRequests().filter(request => request.accountId === 200)).toEqual([
        expect.objectContaining({ side: 'Buy', quantity: 1 }),
        expect.objectContaining({ side: 'Sell', quantity: 1 }),
      ]);
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 0 }),
      ]);
      expect(controller.status().lastError).toBe(null);
      expect(controller.status()).toMatchObject({ armed: true, pause: { rule: 'window-end' } });
    } finally {
      controller.stop();
    }
  });

  it('on-submit mixed reversal během pauzy pošle jen zavírací slice', async () => {
    const time = manualClock(Date.parse('2026-01-15T20:59:00.000Z'));
    const group = copyGroup('on-submit');
    group.safety!.tradingWindow = {
      enabled: true,
      from: '15:30',
      to: '22:00',
      timeZone: 'Europe/Prague',
    };
    group.safety!.dayRuleActions.windowEnd.atEnd = { kind: 'pause', minutes: 10 };
    const { broker, controller } = await bootLive({
      group,
      time,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    try {
      broker.emitEvent({ type: 'order', order: leaderMarketOrder(time.now()) });
      broker.emitEvent(leaderPosition(1));
      await controller.waitForIdle();
      time.set(Date.parse('2026-01-15T21:00:00.000Z'));
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await controller.waitForIdle();

      broker.emitEvent({
        type: 'order',
        order: leaderMarketOrder(time.now(), {
          brokerOrderId: 'leader-submit-reversal', side: 'Sell', quantity: 2,
        }),
      });
      broker.emitEvent(leaderPosition(-1));
      await controller.waitForIdle();

      expect(broker.placedRequests().filter(request => request.accountId === 200)).toEqual([
        expect.objectContaining({ side: 'Buy', quantity: 1 }),
        expect.objectContaining({ side: 'Sell', quantity: 1 }),
      ]);
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 0 }),
      ]);
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('mixed reversal OSO během pauzy zavře followera standalone a nikdy mu nevytvoří opačné SL/TP', async () => {
    const time = manualClock(Date.parse('2026-01-15T20:59:00.000Z'));
    const group = copyGroup('on-submit');
    group.safety!.tradingWindow = {
      enabled: true,
      from: '15:30',
      to: '22:00',
      timeZone: 'Europe/Prague',
    };
    group.safety!.dayRuleActions.windowEnd.atEnd = { kind: 'pause', minutes: 10 };
    const { broker, controller } = await bootLive({
      group,
      time,
      behavior: () => ({ kind: 'fill', price: 20_000 }),
    });
    try {
      broker.emitEvent({ type: 'order', order: leaderMarketOrder(time.now()) });
      broker.emitEvent(leaderPosition(1));
      await controller.waitForIdle();
      time.set(Date.parse('2026-01-15T21:00:00.000Z'));
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await controller.waitForIdle();

      const entryOrderId = 'leader-oso-reversal';
      broker.emitEvent({
        type: 'order',
        order: {
          ...leaderMarketOrder(time.now(), { brokerOrderId: entryOrderId, side: 'Sell', quantity: 2 }),
          orderType: 'Limit', limitPrice: 19_990,
        },
      });
      for (const [brokerOrderId, orderType, price] of [
        ['leader-oso-reversal-stop', 'Stop', 20_050],
        ['leader-oso-reversal-target', 'Limit', 19_900],
      ] as const) {
        eventSequence += 1;
        broker.emitEvent({
          type: 'order',
          order: {
            tag: '', brokerOrderId, parentOrderId: entryOrderId, accountId: 100,
            symbol: 'MNQU6', side: 'Buy', orderType, quantity: 2, filledQuantity: 0,
            status: 'working', sourceVersion: `${eventSequence}:Working`, updatedAt: time.now(),
            ...(orderType === 'Limit' ? { limitPrice: price } : { stopPrice: price }),
          },
        });
      }
      await controller.waitForIdle();

      expect(broker.placedRequests().filter(request => request.accountId === 200).at(-1))
        .toMatchObject({ side: 'Sell', quantity: 1 });
      expect(broker.placedOsoRequests()).toHaveLength(0);
      expect(await broker.listPositions(200)).toEqual([
        expect.objectContaining({ netQuantity: 0 }),
      ]);
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('po zpřísnění již spuštěné pre-limit akce ji worker ihned přehodnotí', async () => {
    const time = manualClock();
    const group = copyGroup();
    group.safety!.dailyLossLimitUsd = 100;
    group.safety!.dayRuleActions.dailyLoss.at80Percent = { kind: 'pause', minutes: 5 };
    const { broker, controller, audits } = await bootLive({ group, time });
    try {
      await completeLeaderTrade({ broker, controller, time, exitPrice: 19_960 });
      expect(controller.status().pause).toMatchObject({ rule: 'daily-loss' });

      const stricter = structuredClone(group);
      stricter.safety!.dayRuleActions.dailyLoss.at80Percent = { kind: 'lock' };
      controller.updateGroup(stricter);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await controller.waitForIdle();

      expect(audits).toContainEqual(expect.objectContaining({
        reason: expect.stringContaining('auto day-lock trigger=daily-loss'),
      }));
      expect(controller.status().dayLockTrigger).toBe('daily-loss');
      expect(controller.status().dayLockUntil).toBeGreaterThan(time.now());
    } finally {
      controller.stop();
    }
  });

  it('fill dříve tombstonovaného on-fill entry po expiraci pauzy zůstane očekávaně vynechaný bez DISARM', async () => {
    const time = manualClock(Date.parse('2026-01-15T20:59:00.000Z'));
    const group = copyGroup('on-fill');
    group.safety!.tradingWindow = {
      enabled: true,
      from: '15:30',
      to: '22:00',
      timeZone: 'Europe/Prague',
    };
    group.safety!.dayRuleActions.windowEnd.atEnd = { kind: 'pause', minutes: 1 };
    const { broker, controller } = await bootLive({ group, time });
    try {
      time.set(Date.parse('2026-01-15T21:00:00.000Z'));
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await controller.waitForIdle();
      const blockedOrder = {
        ...leaderMarketOrder(time.now(), { brokerOrderId: 'late-blocked-entry' }),
        orderType: 'Limit' as const,
        limitPrice: 19_990,
      };
      broker.emitEvent({ type: 'order', order: blockedOrder });
      await controller.waitForIdle();

      time.advance(60_000);
      broker.emitEvent({ type: 'heartbeat', at: time.now() });
      await controller.waitForIdle();
      broker.emitEvent({
        type: 'fill',
        fill: {
          fillId: 'late-blocked-fill', tag: '', brokerOrderId: blockedOrder.brokerOrderId,
          accountId: 100, symbol: 'MNQU6', side: 'Buy', quantity: 1, price: 19_990,
          filledAt: time.now(),
        },
      });
      broker.emitEvent(leaderPosition(1));
      await controller.waitForIdle();

      expect(broker.placedRequests()).toHaveLength(0);
      expect(controller.status()).toMatchObject({ armed: true, pause: null, lastError: null });
    } finally {
      controller.stop();
    }
  });

  it('restart zachová pauzu a ARM během ní zůstává povolený', async () => {
    const time = manualClock();
    const group = copyGroup();
    group.safety!.dailyLossLimitUsd = 100;
    group.safety!.dayRuleActions.dailyLoss.at80Percent = { kind: 'pause', minutes: 5 };
    const store = createMemoryCopierStore();
    const first = await bootLive({ group, time, store });
    const triggeredAt = await completeLeaderTrade({
      broker: first.broker,
      controller: first.controller,
      time,
      exitPrice: 19_960,
    });
    const expectedPause = {
      rule: 'daily-loss' as const,
      at: triggeredAt,
      until: triggeredAt + 5 * 60_000,
    };
    expect(first.controller.status().pause).toEqual(expectedPause);
    const expectedSessionArmedAt = first.controller.status().sessionArmedAt;
    expect(expectedSessionArmedAt).toBeGreaterThan(0);
    first.controller.stop();
    first.broker.setConnected(false);

    const audits: CopierAuditEntry[] = [];
    const restarted = await bootstrapCopierRuntime({
      broker: first.broker,
      store,
      group,
      clock: time.clock,
      onAudit: entries => audits.push(...entries),
    });
    try {
      expect(restarted.status()).toMatchObject({
        armed: false,
        pause: expectedPause,
        sessionArmedAt: expectedSessionArmedAt,
      });
      first.broker.setConnected(true);
      await restarted.waitForIdle();
      await restarted.reconcile();
      expect(() => restarted.arm()).not.toThrow();
      expect(restarted.status()).toMatchObject({ armed: true, pause: expectedPause });
      expect((await store.load()).safety).toMatchObject({
        pauseUntil: expectedPause.until,
        pauseRule: expectedPause.rule,
        pauseAt: expectedPause.at,
      });
      expect(first.broker.placedRequests()).toHaveLength(0);
      expect(first.broker.liquidateRequests()).toHaveLength(0);
      expect(audits.filter(entry => entry.kind === 'rule-pause-end')).toHaveLength(0);
    } finally {
      restarted.stop();
    }
  });

  it('unlockDay vždy vrací přesnou unsupported chybu', async () => {
    const controller = await bootstrapCopierRuntime({
      broker: createMockBroker(),
      store: createMemoryCopierStore(),
      group: copyGroup(),
      clock: () => DEFAULT_NOW,
    });
    try {
      await expect(controller.unlockDay('libovolný důvod')).rejects.toMatchObject({
        message: UNSUPPORTED_UNLOCK,
      });
    } finally {
      controller.stop();
    }
  });
});
