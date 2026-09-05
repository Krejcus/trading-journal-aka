import { describe, expect, it } from 'vitest';
import {
  isWeakerRiskConfig,
  type CopierRiskConfig,
} from '../lib/copierRiskConfig';
import {
  cloneDayRuleActions,
  DEFAULT_COPY_GROUP_SAFETY,
  type CopierRuleAction,
  type CopyGroupSafetySettings,
} from '../services/liveCopyTrading';

const riskConfig = (): CopierRiskConfig => ({
  safety: {
    ...DEFAULT_COPY_GROUP_SAFETY,
    dailyMaxLosingTrades: 2,
    dailyMaxTrades: 10,
    dailyLossLimitUsd: 500,
    entryCooldownMinutes: 20,
    armExpiryFlatten: 'group',
    tradingWindow: {
      enabled: true,
      from: '15:30',
      to: '22:00',
      timeZone: 'Europe/Prague',
    },
    dayRuleActions: cloneDayRuleActions(DEFAULT_COPY_GROUP_SAFETY.dayRuleActions),
  },
  followers: [{
    accountId: 22,
    mode: 'on-submit',
    multiplier: 1,
    maxContracts: 3,
    dailyLossCutUsd: 100,
    onCut: 'close-copy',
  }],
});

type PositiveSafetyLimit = 'dailyMaxLosingTrades' | 'dailyMaxTrades' | 'dailyLossLimitUsd';

describe('isWeakerRiskConfig — pravidla skupiny', () => {
  it.each<readonly [PositiveSafetyLimit, number]>([
    ['dailyMaxLosingTrades', 3],
    ['dailyMaxTrades', 11],
    ['dailyLossLimitUsd', 501],
  ])('označí zvýšení %s', (field, weakerValue) => {
    const previous = riskConfig();
    const next = riskConfig();
    next.safety![field] = weakerValue;

    expect(isWeakerRiskConfig(previous, next)).toEqual([`safety.${field}`]);
  });

  it.each<PositiveSafetyLimit>([
    'dailyMaxLosingTrades',
    'dailyMaxTrades',
    'dailyLossLimitUsd',
  ])('označí vypnutí dříve aktivního %s, ale dovolí jeho zapnutí a zpřísnění', (field) => {
    const previous = riskConfig();
    const disabled = riskConfig();
    disabled.safety![field] = 0;
    expect(isWeakerRiskConfig(previous, disabled)).toEqual([`safety.${field}`]);

    const previouslyDisabled = riskConfig();
    previouslyDisabled.safety![field] = 0;
    const enabled = riskConfig();
    enabled.safety![field] = 1;
    expect(isWeakerRiskConfig(previouslyDisabled, enabled)).toEqual([]);

    const tighter = riskConfig();
    tighter.safety![field] = Math.max(1, previous.safety![field] - 1);
    expect(isWeakerRiskConfig(previous, tighter)).toEqual([]);
  });

  it('nižší cooldown je mírnější, vyšší je zpřísnění', () => {
    const previous = riskConfig();
    const weaker = riskConfig();
    weaker.safety!.entryCooldownMinutes = 19;
    expect(isWeakerRiskConfig(previous, weaker)).toEqual(['safety.entryCooldownMinutes']);

    const tighter = riskConfig();
    tighter.safety!.entryCooldownMinutes = 21;
    expect(isWeakerRiskConfig(previous, tighter)).toEqual([]);
  });

  it('označí vypnutí a rozšíření obchodního okna', () => {
    const previous = riskConfig();

    const disabled = riskConfig();
    disabled.safety!.tradingWindow.enabled = false;
    expect(isWeakerRiskConfig(previous, disabled)).toEqual(['safety.tradingWindow.enabled']);

    const earlier = riskConfig();
    earlier.safety!.tradingWindow.from = '15:00';
    expect(isWeakerRiskConfig(previous, earlier)).toEqual(['safety.tradingWindow.from']);

    const later = riskConfig();
    later.safety!.tradingWindow.to = '22:30';
    expect(isWeakerRiskConfig(previous, later)).toEqual(['safety.tradingWindow.to']);

    const wider = riskConfig();
    wider.safety!.tradingWindow.from = '15:00';
    wider.safety!.tradingWindow.to = '22:30';
    expect(isWeakerRiskConfig(previous, wider)).toEqual([
      'safety.tradingWindow.from',
      'safety.tradingWindow.to',
    ]);
  });

  it('dovolí zapnout nebo zúžit obchodní okno', () => {
    const disabled = riskConfig();
    disabled.safety!.tradingWindow.enabled = false;
    const enabled = riskConfig();
    enabled.safety!.tradingWindow.from = '15:00';
    enabled.safety!.tradingWindow.to = '22:30';
    expect(isWeakerRiskConfig(disabled, enabled)).toEqual([]);

    const narrower = riskConfig();
    narrower.safety!.tradingWindow.from = '16:00';
    narrower.safety!.tradingWindow.to = '21:00';
    expect(isWeakerRiskConfig(riskConfig(), narrower)).toEqual([]);
  });

  it.each([
    ['group', 'followers'],
    ['group', 'off'],
    ['followers', 'off'],
  ] as const)('označí oslabení armExpiryFlatten %s → %s', (previousScope, nextScope) => {
    const previous = riskConfig();
    previous.safety!.armExpiryFlatten = previousScope;
    const next = riskConfig();
    next.safety!.armExpiryFlatten = nextScope;
    expect(isWeakerRiskConfig(previous, next)).toEqual(['safety.armExpiryFlatten']);
  });

  it('dovolí zpřísnit armExpiryFlatten', () => {
    const previous = riskConfig();
    previous.safety!.armExpiryFlatten = 'off';
    const next = riskConfig();
    next.safety!.armExpiryFlatten = 'group';
    expect(isWeakerRiskConfig(previous, next)).toEqual([]);
  });
});

type RuleActionCase = {
  field: string;
  set: (safety: CopyGroupSafetySettings, action: CopierRuleAction) => void;
};

const ruleActionCases: RuleActionCase[] = [
  {
    field: 'safety.dayRuleActions.losingTrades.beforeLimit',
    set: (safety, action) => { safety.dayRuleActions.losingTrades.beforeLimit = action; },
  },
  {
    field: 'safety.dayRuleActions.losingTrades.atLimit',
    set: (safety, action) => { safety.dayRuleActions.losingTrades.atLimit = action; },
  },
  {
    field: 'safety.dayRuleActions.dailyLoss.at80Percent',
    set: (safety, action) => { safety.dayRuleActions.dailyLoss.at80Percent = action; },
  },
  {
    field: 'safety.dayRuleActions.dailyLoss.atLimit',
    set: (safety, action) => { safety.dayRuleActions.dailyLoss.atLimit = action; },
  },
  {
    field: 'safety.dayRuleActions.maxTrades.atLimit',
    set: (safety, action) => { safety.dayRuleActions.maxTrades.atLimit = action; },
  },
  {
    field: 'safety.dayRuleActions.windowEnd.atEnd',
    set: (safety, action) => { safety.dayRuleActions.windowEnd.atEnd = action; },
  },
];

describe('isWeakerRiskConfig — akce pravidel dne', () => {
  it.each(ruleActionCases)('označí lock → pause pro $field', ({ field, set }) => {
    const previous = riskConfig();
    const next = riskConfig();
    set(previous.safety!, { kind: 'lock' });
    set(next.safety!, { kind: 'pause', minutes: 30 });
    expect(isWeakerRiskConfig(previous, next)).toEqual([field]);
  });

  it.each(ruleActionCases)('označí zkrácení pauzy pro $field', ({ field, set }) => {
    const previous = riskConfig();
    const next = riskConfig();
    set(previous.safety!, { kind: 'pause', minutes: 30 });
    set(next.safety!, { kind: 'pause', minutes: 29 });
    expect(isWeakerRiskConfig(previous, next)).toEqual([field]);
  });

  it('označí pause → null i přímé lock → null', () => {
    const previous = riskConfig();
    const next = riskConfig();
    previous.safety!.dayRuleActions.losingTrades.beforeLimit = { kind: 'pause', minutes: 20 };
    next.safety!.dayRuleActions.losingTrades.beforeLimit = null;
    previous.safety!.dayRuleActions.dailyLoss.at80Percent = { kind: 'lock' };
    next.safety!.dayRuleActions.dailyLoss.at80Percent = null;

    expect(isWeakerRiskConfig(previous, next)).toEqual([
      'safety.dayRuleActions.losingTrades.beforeLimit',
      'safety.dayRuleActions.dailyLoss.at80Percent',
    ]);
  });

  it('dovolí null → pause, pause → lock a prodloužení pauzy', () => {
    const previous = riskConfig();
    const next = riskConfig();
    previous.safety!.dayRuleActions.losingTrades.beforeLimit = null;
    next.safety!.dayRuleActions.losingTrades.beforeLimit = { kind: 'pause', minutes: 10 };
    previous.safety!.dayRuleActions.dailyLoss.at80Percent = { kind: 'pause', minutes: 30 };
    next.safety!.dayRuleActions.dailyLoss.at80Percent = { kind: 'lock' };
    previous.safety!.dayRuleActions.maxTrades.atLimit = { kind: 'pause', minutes: 30 };
    next.safety!.dayRuleActions.maxTrades.atLimit = { kind: 'pause', minutes: 60 };

    expect(isWeakerRiskConfig(previous, next)).toEqual([]);
  });
});

describe('isWeakerRiskConfig — followeři', () => {
  it('označí vyšší nebo vypnutý dailyLossCutUsd, ale dovolí nižší či nově zapnutý limit', () => {
    const previous = riskConfig();
    const higher = riskConfig();
    higher.followers[0].dailyLossCutUsd = 101;
    expect(isWeakerRiskConfig(previous, higher)).toEqual(['followers.22.dailyLossCutUsd']);

    const disabled = riskConfig();
    delete disabled.followers[0].dailyLossCutUsd;
    expect(isWeakerRiskConfig(previous, disabled)).toEqual(['followers.22.dailyLossCutUsd']);

    const lower = riskConfig();
    lower.followers[0].dailyLossCutUsd = 99;
    expect(isWeakerRiskConfig(previous, lower)).toEqual([]);

    const previouslyDisabled = riskConfig();
    delete previouslyDisabled.followers[0].dailyLossCutUsd;
    expect(isWeakerRiskConfig(previouslyDisabled, riskConfig())).toEqual([]);
  });

  it('označí vyšší nebo odebraný maxContracts', () => {
    const previous = riskConfig();
    const higher = riskConfig();
    higher.followers[0].maxContracts = 4;
    expect(isWeakerRiskConfig(previous, higher)).toEqual(['followers.22.maxContracts']);

    const removed = riskConfig();
    delete removed.followers[0].maxContracts;
    expect(isWeakerRiskConfig(previous, removed)).toEqual(['followers.22.maxContracts']);

    const lower = riskConfig();
    lower.followers[0].maxContracts = 2;
    expect(isWeakerRiskConfig(previous, lower)).toEqual([]);
  });

  it('označí close-copy → let-run včetně implicitního defaultu', () => {
    const previous = riskConfig();
    delete previous.followers[0].onCut;
    const next = riskConfig();
    next.followers[0].onCut = 'let-run';
    expect(isWeakerRiskConfig(previous, next)).toEqual(['followers.22.onCut']);

    const tighter = riskConfig();
    tighter.followers[0].onCut = 'let-run';
    expect(isWeakerRiskConfig(tighter, riskConfig())).toEqual([]);
  });

  it('označí zvýšení multiplieru a dovolí jeho snížení', () => {
    const higher = riskConfig();
    higher.followers[0].multiplier = 2;
    expect(isWeakerRiskConfig(riskConfig(), higher)).toEqual(['followers.22.multiplier']);

    const lower = riskConfig();
    lower.followers[0].multiplier = 0.5;
    expect(isWeakerRiskConfig(riskConfig(), lower)).toEqual([]);
  });

  it('nový follower bez vlastního cutu je slabší, pokud už některý cut existuje', () => {
    const next = riskConfig();
    next.followers.push({ accountId: 33, mode: 'on-submit', multiplier: 1 });
    expect(isWeakerRiskConfig(riskConfig(), next)).toEqual(['followers.33']);

    next.followers[1].dailyLossCutUsd = 200;
    expect(isWeakerRiskConfig(riskConfig(), next)).toEqual([]);
  });

  it('nový follower bez cutu je povolen, pokud žádný stávající follower cut nemá', () => {
    const previous = riskConfig();
    delete previous.followers[0].dailyLossCutUsd;
    const next = riskConfig();
    delete next.followers[0].dailyLossCutUsd;
    next.followers.push({ accountId: 33, mode: 'on-submit', multiplier: 1 });

    expect(isWeakerRiskConfig(previous, next)).toEqual([]);
  });

  it('odebrání followera je vždy povolené', () => {
    const next = riskConfig();
    next.followers = [];
    expect(isWeakerRiskConfig(riskConfig(), next)).toEqual([]);
  });
});

describe('isWeakerRiskConfig — kontrakt výsledku', () => {
  it('vrací všechny porušené cesty v deterministickém pořadí bez duplicit', () => {
    const next = riskConfig();
    next.safety!.dailyMaxTrades = 20;
    next.safety!.entryCooldownMinutes = 0;
    next.followers[0].maxContracts = 5;
    next.followers[0].multiplier = 2;

    expect(isWeakerRiskConfig(riskConfig(), next)).toEqual([
      'safety.dailyMaxTrades',
      'safety.entryCooldownMinutes',
      'followers.22.maxContracts',
      'followers.22.multiplier',
    ]);
  });

  it('legacy chybějící safety porovnává přes bezpečné defaulty', () => {
    const previous: CopierRiskConfig = { followers: riskConfig().followers };
    const next: CopierRiskConfig = { followers: riskConfig().followers };
    expect(isWeakerRiskConfig(previous, next)).toEqual([]);
  });

  it('neplatné safety odmítne fail-closed', () => {
    const next = riskConfig();
    next.safety = {
      ...next.safety!,
      dayRuleActions: { losingTrades: 'invalid' },
    } as unknown as CopyGroupSafetySettings;
    expect(isWeakerRiskConfig(riskConfig(), next)).toEqual(['safety']);
  });
});
