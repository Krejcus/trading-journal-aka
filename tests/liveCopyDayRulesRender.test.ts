import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DayLockBanner,
  LiveDayRulesCard,
  dailyRulesDraftFromSafety,
  isWeakerDailyRulesSafety,
  validateDailyRulesDraft,
} from '../components/LiveDayRulesCard';
import {
  DEFAULT_COPY_GROUP_SAFETY,
  type CopyGroupSafetySettings,
} from '../services/liveCopyTrading';

const safety: CopyGroupSafetySettings = {
  ...DEFAULT_COPY_GROUP_SAFETY,
  dailyMaxLosingTrades: 2,
  dailyLossLimitUsd: 1_000,
  dailyMaxTrades: 10,
  tradingWindow: {
    enabled: true,
    from: '15:30',
    to: '22:00',
    timeZone: 'Europe/Prague',
  },
  entryCooldownMinutes: 15,
  armExpiryFlatten: 'followers',
};

describe('LIVE Pravidla dne', () => {
  it('vykreslí všech šest hodnot, autoritativní průběh a spuštěné pravidlo červeně', () => {
    const now = Date.now();
    const markup = renderToStaticMarkup(React.createElement(LiveDayRulesCard, {
      groupName: 'Hlavní',
      safety,
      dailyStats: {
        sessionEndAt: now + 8 * 60 * 60_000,
        realizedPnlUsd: -620,
        losingTrades: 2,
        tradesToday: 4,
        windowState: 'inside',
        warnedRules: [{ rule: 'daily-loss', current: 620, limit: 1_000, at: now - 1_000 }],
        unpricedSymbols: [],
      },
      dayLockUntil: now + 60 * 60_000,
      dayLockAt: now - 60_000,
      dayLockTrigger: 'losing-trades',
      cooldownUntil: now + 3 * 60_000,
      armedAt: now - 60 * 60_000,
      armExpiresAt: now + 7 * 60 * 60_000,
      onSave: () => undefined,
    }));

    expect(markup).toContain('data-live-day-rules="true"');
    expect(markup).toContain('Max ztrátových obchodů za den');
    expect(markup).toContain('Denní ztrátový limit');
    expect(markup).toContain('Max obchodů za den');
    expect(markup).toContain('Obchodní okno');
    expect(markup).toContain('Cooldown po uzavření');
    expect(markup).toContain('Expirace LIVE session');
    expect(markup).toContain('value="1000"');
    expect(markup).toContain('value="10"');
    expect(markup).toContain('2 / 2');
    expect(markup).toContain('4 / 10');
    expect(markup).toContain('−620 · 62 %');
    expect(markup).toContain('data-progress-value="100"');
    expect(markup).toContain('data-progress-value="62"');
    expect(markup).toContain('data-progress-value="40"');
    expect(markup).toContain('data-rule-triggered="true"');
    expect(markup).toContain('Akce');
    expect(markup).toContain('data-risk-rule-action="1. ztráta"');
    expect(markup).toContain('1. ztráta pauza 20 min · 2. ztráta zámek dne');
    expect(markup).toContain('80 % pauza 30 min · 100 % zámek dne');
    expect(markup).toContain('3 zámky');
  });

  it('fail-closed odmítne neplatné zapnuté hodnoty a nevytvoří safety payload', () => {
    const draft = dailyRulesDraftFromSafety(safety);
    const invalid = validateDailyRulesDraft({
      ...draft,
      dailyMaxLosingTrades: '1.5',
      dailyLossLimitUsd: '-10',
      dailyMaxTrades: '201',
      tradingWindowFrom: '22:00',
      tradingWindowTo: '15:30',
      entryCooldownMinutes: '721',
    }, safety);

    expect(invalid.safety).toBeNull();
    expect(invalid.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('celé číslo od 1 do 50'),
      expect.stringContaining('0,01 do 1 000 000 USD'),
      expect.stringContaining('celé číslo od 1 do 200'),
      expect.stringContaining('okno přes půlnoc není podporované'),
      expect.stringContaining('1 do 720 minut'),
    ]));
  });

  it('zachová volitelné null akce a validuje povinné akce i délku pauzy fail-closed', () => {
    const nullableSafety: CopyGroupSafetySettings = {
      ...safety,
      dayRuleActions: {
        ...safety.dayRuleActions,
        losingTrades: { ...safety.dayRuleActions.losingTrades, beforeLimit: null },
        dailyLoss: { ...safety.dayRuleActions.dailyLoss, at80Percent: null },
      },
    };
    const draft = dailyRulesDraftFromSafety(nullableSafety);

    expect(draft).toMatchObject({
      losingTradesBeforeAction: null,
      dailyLoss80Action: null,
    });
    const valid = validateDailyRulesDraft(draft, nullableSafety);
    expect(valid.errors).toEqual([]);
    expect(valid.safety?.dayRuleActions).toEqual(nullableSafety.dayRuleActions);

    const missingRequired = validateDailyRulesDraft({
      ...draft,
      maxTradesAtAction: null,
    }, nullableSafety);
    expect(missingRequired.safety).toBeNull();
    expect(missingRequired.errors).toContain('Max obchodů: vyber pauzu nebo zámek dne.');

    const invalidPause = validateDailyRulesDraft({
      ...draft,
      dailyLoss80Action: 'pause',
      dailyLoss80Minutes: '0',
    }, nullableSafety);
    expect(invalidPause.safety).toBeNull();
    expect(invalidPause.errors).toContain('Denní ztráta na 80 %: pauza musí být celé číslo od 1 do 720 minut.');
  });

  it('bez dailyStats ukáže neověřený průběh místo falešných nul', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveDayRulesCard, {
      safety,
      dayLockUntil: Date.now() + 60_000,
      dayLockTrigger: 'losing-trades',
      onSave: () => undefined,
    }));

    expect(markup).not.toContain('−0');
    expect(markup).toContain('stav nedostupný');
    for (const label of [
      'Průběh ztrátových obchodů',
      'Průběh denní ztráty',
      'Průběh obchodů za den',
    ]) {
      const tag = markup.match(new RegExp(`<div[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';
      expect(tag).toContain('data-progress-known="false"');
      expect(tag).toContain('aria-valuetext="neověřeno"');
      expect(tag).not.toContain('aria-valuenow=');
    }
    expect(markup).toContain('data-rule-triggered="true"');
    expect(markup).toContain('border-rose-500/35');
  });

  it('popíše předlimitní akci podle skutečného nastaveného limitu', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveDayRulesCard, {
      safety: { ...safety, dailyMaxLosingTrades: 5 },
      onSave: () => undefined,
    }));

    expect(markup).toContain('4. ztráta pauza 20 min · 5. ztráta zámek dne');
    expect(markup).toContain('4. ztráta – akce');
    expect(markup).toContain('5. ztráta – akce');
  });

  it('tighten-only preflight rozliší mírnější akci od zpřísnění', () => {
    expect(isWeakerDailyRulesSafety(safety, {
      ...safety,
      dailyLossLimitUsd: 1_001,
    })).toBe(true);
    expect(isWeakerDailyRulesSafety(safety, {
      ...safety,
      dayRuleActions: {
        ...safety.dayRuleActions,
        losingTrades: {
          ...safety.dayRuleActions.losingTrades,
          beforeLimit: { kind: 'pause', minutes: 30 },
        },
      },
    })).toBe(false);
  });

  it('ukládá vypnutá číselná pravidla jako nulu a zachová pevnou zónu Europe/Prague', () => {
    const draft = dailyRulesDraftFromSafety(safety);
    const result = validateDailyRulesDraft({
      ...draft,
      losingTradesEnabled: false,
      lossLimitEnabled: false,
      maxTradesEnabled: false,
      cooldownEnabled: false,
      tradingWindowEnabled: false,
      sessionExpiryEnabled: false,
    }, safety);

    expect(result.errors).toEqual([]);
    expect(result.safety).toMatchObject({
      dailyMaxLosingTrades: 0,
      dailyLossLimitUsd: 0,
      dailyMaxTrades: 0,
      entryCooldownMinutes: 0,
      tradingWindow: { enabled: false, timeZone: 'Europe/Prague' },
      armExpiryFlatten: 'off',
      dayRuleActions: safety.dayRuleActions,
    });

    const invalidDisabledWindow = validateDailyRulesDraft({
      ...draft,
      tradingWindowEnabled: false,
      tradingWindowFrom: '25:00',
    }, safety);
    expect(invalidDisabledWindow.safety).toBeNull();
    expect(invalidDisabledWindow.errors).toContain('Obchodní okno musí používat platný čas HH:MM.');
  });

  it('po prvním ARM zakáže oslabující směry a ponechá zpřísnění dostupné', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveDayRulesCard, {
      safety,
      sessionArmedAt: Date.UTC(2026, 8, 5, 13, 0),
      pause: { until: Date.now() + 60_000, rule: 'daily-loss', at: Date.now() },
      onSave: () => undefined,
    }));

    expect(markup).toContain('data-tighten-only="true"');
    expect(markup).toContain('jen zpřísnit');
    expect(markup).toContain('Pauza');
    expect(markup).toContain('title="dnes jen zpřísnit"');
    expect(markup).toContain('max="2"');
    expect(markup).toContain('max="1000"');
    expect(markup).toContain('min="15"');
    expect(markup).toContain('<option value="pause" disabled="">Pauza</option>');
  });
});

describe('Zámek dne', () => {
  it('banner existuje jen při aktivním zámku, nemá odemknutí a vysvětlí konec session', () => {
    const now = Date.UTC(2026, 8, 4, 14, 0);
    const active = renderToStaticMarkup(React.createElement(DayLockBanner, {
      until: now + 60_000,
      at: now - 8 * 60_000,
      trigger: 'max-trades',
      reason: '10. uzavřený obchod dne',
      now,
    }));
    const expired = renderToStaticMarkup(React.createElement(DayLockBanner, {
      until: now,
      now,
    }));

    expect(active).toContain('data-day-lock-banner="true"');
    expect(active).toContain('Den je zamčený do');
    expect(active).toContain('Automaticky');
    expect(active).toContain('Max obchodů za den');
    expect(active).toContain('Zámek skončí s koncem session (00:00 Chicago); pravidla jdou dnes jen zpřísnit');
    expect(active).not.toContain('Odemknout');
    expect(expired).toBe('');
  });

  it('bez triggeru neodhaduje, že zámek vznikl ručně', () => {
    const now = Date.UTC(2026, 8, 4, 14, 0);
    const markup = renderToStaticMarkup(React.createElement(DayLockBanner, {
      until: now + 60_000,
      at: now - 8 * 60_000,
      now,
    }));

    expect(markup).toContain('Původ zámku není ověřen');
    expect(markup).not.toContain('Ručně');
  });
});
