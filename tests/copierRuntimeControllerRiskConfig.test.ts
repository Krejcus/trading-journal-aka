import { describe, expect, it } from 'vitest';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import {
  cloneDayRuleActions,
  DEFAULT_COPY_GROUP_SAFETY,
  sanitizeDayRuleActions,
  type CopyGroupConfig,
} from '../services/liveCopyTrading';

const START_AT = Date.parse('2026-09-08T16:00:00.000Z');

const manualClock = (initial = START_AT) => {
  let value = initial;
  return {
    clock: () => value,
    set: (next: number) => { value = next; },
  };
};

const runtimeGroup = (): CopyGroupConfig => ({
  id: 'risk-group',
  name: 'Risk group',
  enabled: true,
  leaderAccountId: 100,
  followers: [
    {
      accountId: 200,
      mode: 'on-submit',
      multiplier: 1,
      maxContracts: 3,
      dailyLossCutUsd: 100,
      onCut: 'close-copy',
    },
    {
      accountId: 201,
      mode: 'on-submit',
      multiplier: 1,
      maxContracts: 3,
      dailyLossCutUsd: 100,
      onCut: 'close-copy',
    },
  ],
  safety: {
    ...DEFAULT_COPY_GROUP_SAFETY,
    dailyMaxLosingTrades: 2,
    dailyMaxTrades: 10,
    dailyLossLimitUsd: 500,
    entryCooldownMinutes: 20,
    armExpiryFlatten: 'group',
    tradingWindow: {
      enabled: true,
      from: '00:01',
      to: '23:58',
      timeZone: 'UTC',
    },
    dayRuleActions: cloneDayRuleActions(DEFAULT_COPY_GROUP_SAFETY.dayRuleActions),
  },
});

const follower = (group: CopyGroupConfig, accountId = 200) => {
  const found = group.followers.find(item => item.accountId === accountId);
  if (!found) throw new Error(`Test fixture neobsahuje followera ${accountId}`);
  return found;
};

type WeakerCase = {
  name: string;
  field: string;
  mutate: (group: CopyGroupConfig) => void;
};

const weakerCases: WeakerCase[] = [
  {
    name: 'vyšší maximum ztrátových obchodů',
    field: 'safety.dailyMaxLosingTrades',
    mutate: group => { group.safety!.dailyMaxLosingTrades = 3; },
  },
  {
    name: 'vypnuté maximum obchodů',
    field: 'safety.dailyMaxTrades',
    mutate: group => { group.safety!.dailyMaxTrades = 0; },
  },
  {
    name: 'vyšší denní ztrátový limit',
    field: 'safety.dailyLossLimitUsd',
    mutate: group => { group.safety!.dailyLossLimitUsd = 501; },
  },
  {
    name: 'kratší cooldown',
    field: 'safety.entryCooldownMinutes',
    mutate: group => { group.safety!.entryCooldownMinutes = 19; },
  },
  {
    name: 'vypnuté obchodní okno',
    field: 'safety.tradingWindow.enabled',
    mutate: group => { group.safety!.tradingWindow.enabled = false; },
  },
  {
    name: 'dřívější začátek obchodního okna',
    field: 'safety.tradingWindow.from',
    mutate: group => { group.safety!.tradingWindow.from = '00:00'; },
  },
  {
    name: 'pozdější konec obchodního okna',
    field: 'safety.tradingWindow.to',
    mutate: group => { group.safety!.tradingWindow.to = '23:59'; },
  },
  {
    name: 'užší rozsah auto-flatten',
    field: 'safety.armExpiryFlatten',
    mutate: group => { group.safety!.armExpiryFlatten = 'followers'; },
  },
  {
    name: 'akce pravidla lock změněná na pause',
    field: 'safety.dayRuleActions.dailyLoss.atLimit',
    mutate: group => {
      group.safety!.dayRuleActions.dailyLoss.atLimit = { kind: 'pause', minutes: 30 };
    },
  },
  {
    name: 'akce pravidla pause odebraná na null',
    field: 'safety.dayRuleActions.dailyLoss.at80Percent',
    mutate: group => { group.safety!.dayRuleActions.dailyLoss.at80Percent = null; },
  },
  {
    name: 'zkrácená pauza pravidla',
    field: 'safety.dayRuleActions.maxTrades.atLimit',
    mutate: group => {
      group.safety!.dayRuleActions.maxTrades.atLimit = { kind: 'pause', minutes: 29 };
    },
  },
  {
    name: 'vyšší follower loss cut',
    field: 'followers.200.dailyLossCutUsd',
    mutate: group => { follower(group).dailyLossCutUsd = 101; },
  },
  {
    name: 'vyšší follower maxContracts',
    field: 'followers.200.maxContracts',
    mutate: group => { follower(group).maxContracts = 4; },
  },
  {
    name: 'follower close-copy změněný na let-run',
    field: 'followers.200.onCut',
    mutate: group => { follower(group).onCut = 'let-run'; },
  },
  {
    name: 'vyšší follower multiplier',
    field: 'followers.200.multiplier',
    mutate: group => { follower(group).multiplier = 2; },
  },
  {
    name: 'nový follower bez vlastního loss cutu',
    field: 'followers.300',
    mutate: group => {
      group.followers.push({ accountId: 300, mode: 'on-submit', multiplier: 1 });
    },
  },
];

const bootRuntime = async (options: { live?: boolean; shadow?: boolean } = {}): Promise<{
  broker: MockBroker;
  controller: CopierRuntimeController;
  time: ReturnType<typeof manualClock>;
}> => {
  const time = manualClock();
  const broker = createMockBroker({ clock: time.clock });
  const controller = await bootstrapCopierRuntime({
    broker,
    store: createMemoryCopierStore(),
    group: runtimeGroup(),
    clock: time.clock,
  });

  if (options.live || options.shadow) {
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm({ shadowMode: options.shadow === true });
    await controller.waitForIdle();
  }

  return { broker, controller, time };
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const tightenOnlyError = (field: string): RegExp => new RegExp(
  `Pravidla jdou dnes jen zpřísnit:.*${escapeRegExp(field)}`,
);

describe('CopierRuntimeController tighten-only', () => {
  it.each(weakerCases)('po prvním live ARM odmítne: $name', async ({ field, mutate }) => {
    const { controller } = await bootRuntime({ live: true });
    try {
      expect(controller.status().sessionArmedAt).toBeGreaterThan(0);
      const next = runtimeGroup();
      mutate(next);

      expect(() => controller.updateGroup(next)).toThrow(tightenOnlyError(field));
    } finally {
      controller.stop();
    }
  });

  it('před prvním ARM dovolí všechny jinak mírnější změny', async () => {
    const { controller } = await bootRuntime();
    try {
      expect(controller.status().sessionArmedAt ?? 0).toBe(0);
      for (const variant of weakerCases) {
        controller.updateGroup(runtimeGroup());
        const next = runtimeGroup();
        variant.mutate(next);
        expect(
          () => controller.updateGroup(next),
          `Před prvním ARM má být povoleno: ${variant.name}`,
        ).not.toThrow();
      }
    } finally {
      controller.stop();
    }
  });

  it('shadow ARM tighten-only nezapne', async () => {
    const { controller } = await bootRuntime({ shadow: true });
    try {
      expect(controller.status()).toMatchObject({ armed: true, shadowMode: true });
      expect(controller.status().sessionArmedAt ?? 0).toBe(0);
      for (const variant of weakerCases) {
        controller.updateGroup(runtimeGroup());
        const next = runtimeGroup();
        variant.mutate(next);
        expect(
          () => controller.updateGroup(next),
          `Po shadow ARM má být povoleno: ${variant.name}`,
        ).not.toThrow();
      }
    } finally {
      controller.stop();
    }
  });

  it('po live ARM dál dovolí skutečné zpřísnění, odebrání followera a chráněného nového followera', async () => {
    const { controller } = await bootRuntime({ live: true });
    try {
      const tighter = runtimeGroup();
      tighter.safety!.dailyMaxLosingTrades = 1;
      tighter.safety!.dailyMaxTrades = 5;
      tighter.safety!.dailyLossLimitUsd = 250;
      tighter.safety!.entryCooldownMinutes = 30;
      tighter.safety!.tradingWindow.from = '01:00';
      tighter.safety!.tradingWindow.to = '23:00';
      tighter.safety!.dayRuleActions.maxTrades.atLimit = { kind: 'lock' };
      follower(tighter).dailyLossCutUsd = 50;
      follower(tighter).maxContracts = 2;
      follower(tighter).multiplier = 0.5;
      tighter.followers = tighter.followers.filter(item => item.accountId !== 201);
      tighter.followers.push({
        accountId: 300,
        mode: 'on-submit',
        multiplier: 1,
        dailyLossCutUsd: 75,
      });

      expect(() => controller.updateGroup(tighter)).not.toThrow();
      expect(controller.status().sessionArmedAt).toBeGreaterThan(0);
    } finally {
      controller.stop();
    }
  });

  it('stejný tighten-only guard chrání reconfigureGroup i activateGroup', async () => {
    const first = await bootRuntime({ live: true });
    try {
      const weakerReconfigure = runtimeGroup();
      weakerReconfigure.safety!.dailyMaxTrades = 0;
      await expect(first.controller.reconfigureGroup(weakerReconfigure))
        .rejects.toThrow(tightenOnlyError('safety.dailyMaxTrades'));
    } finally {
      first.controller.stop();
    }

    const second = await bootRuntime({ live: true });
    try {
      const weakerActivation = runtimeGroup();
      weakerActivation.id = 'another-risk-group';
      weakerActivation.safety!.entryCooldownMinutes = 0;
      await expect(second.controller.activateGroup(weakerActivation))
        .rejects.toThrow(tightenOnlyError('safety.entryCooldownMinutes'));
    } finally {
      second.controller.stop();
    }
  });

  it('nová broker session resetuje tighten-only a dovolí mírnější konfiguraci', async () => {
    const { broker, controller, time } = await bootRuntime({ live: true });
    try {
      expect(controller.status().sessionArmedAt).toBeGreaterThan(0);
      const weaker = runtimeGroup();
      weaker.safety!.dailyLossLimitUsd = 750;
      expect(() => controller.updateGroup(weaker))
        .toThrow(tightenOnlyError('safety.dailyLossLimitUsd'));

      controller.disarm();
      const sessionEndAt = controller.status().dailyStats?.sessionEndAt;
      expect(sessionEndAt).toBeTypeOf('number');
      time.set((sessionEndAt as number) + 1);
      broker.emitEvent({ type: 'heartbeat', at: time.clock() });
      await controller.waitForIdle();

      expect(controller.status().sessionArmedAt ?? 0).toBe(0);
      expect(() => controller.updateGroup(weaker)).not.toThrow();
    } finally {
      controller.stop();
    }
  });

  it('live ARM hned po hranici session uloží marker do nové session i bez předchozího heartbeat', async () => {
    const { broker, controller, time } = await bootRuntime({ live: true });
    try {
      const previousSessionEndAt = controller.status().dailyStats?.sessionEndAt;
      expect(previousSessionEndAt).toBeTypeOf('number');
      controller.disarm();
      time.set((previousSessionEndAt as number) + 1);

      // Žádný heartbeat mezi hranicí session a novým ARM.
      await controller.reconcile();
      controller.arm();
      await controller.waitForIdle();

      expect(controller.status().sessionArmedAt).toBe(time.clock());
      expect(controller.status().dailyStats?.sessionEndAt).toBeGreaterThan(time.clock());
      const weaker = runtimeGroup();
      weaker.safety!.dailyLossLimitUsd = 750;
      expect(() => controller.updateGroup(weaker))
        .toThrow(tightenOnlyError('safety.dailyLossLimitUsd'));

      // Pozdější heartbeat už marker nové session nesmí smazat.
      broker.emitEvent({ type: 'heartbeat', at: time.clock() });
      await controller.waitForIdle();
      expect(controller.status().sessionArmedAt).toBe(time.clock());
    } finally {
      controller.stop();
    }
  });
});

describe('dayRuleActions sanitizer', () => {
  it('defaultuje pouze chybějící legacy pole a explicitní null odmítne fail-closed', () => {
    expect(sanitizeDayRuleActions(undefined)).toEqual(DEFAULT_COPY_GROUP_SAFETY.dayRuleActions);
    expect(sanitizeDayRuleActions(null)).toBeNull();
  });
});
