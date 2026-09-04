import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DayLockBanner,
  LiveDayRulesCard,
  UnlockDayDialog,
  dailyRulesDraftFromSafety,
  submitUnlockDay,
  unlockDayCanSubmit,
  validateDailyRulesDraft,
  validUnlockDayReason,
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
      onUnlockDay: () => undefined,
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
    expect(markup).toContain('1 z 6 pravidel spuštěno');
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
    });

    const invalidDisabledWindow = validateDailyRulesDraft({
      ...draft,
      tradingWindowEnabled: false,
      tradingWindowFrom: '25:00',
    }, safety);
    expect(invalidDisabledWindow.safety).toBeNull();
    expect(invalidDisabledWindow.errors).toContain('Obchodní okno musí používat platný čas HH:MM.');
  });
});

describe('Odemknout den', () => {
  it('má povinný validní důvod a přesnou 10s bránu', () => {
    expect(validUnlockDayReason('ab')).toBe(false);
    expect(validUnlockDayReason('Vědomě pokračuji')).toBe(true);
    expect(validUnlockDayReason('abc\nARM')).toBe(false);
    expect(unlockDayCanSubmit('Vědomě pokračuji', 1)).toBe(false);
    expect(unlockDayCanSubmit('ab', 0)).toBe(false);
    expect(unlockDayCanSubmit('Vědomě pokračuji', 0)).toBe(true);

    const waiting = renderToStaticMarkup(React.createElement(UnlockDayDialog, {
      trigger: 'losing-trades',
      at: Date.UTC(2026, 8, 4, 13, 52),
      reason: 'Vědomě pokračuji',
      busy: false,
      secondsRemaining: 10,
      error: 'Worker: Den není zamčený',
      onReason: () => undefined,
      onClose: () => undefined,
      onConfirm: () => undefined,
    }));
    expect(waiting).toContain('Odemknout (za 10 s)');
    expect(waiting).toContain('disabled=""');
    expect(waiting).toContain('Po úspěchu zůstane VYPNUTO');
    expect(waiting).toContain('Worker: Den není zamčený');
  });

  it('po uplynutí brány odešle jen důvod k unlock handleru a žádný ARM', async () => {
    const unlock = vi.fn(async () => undefined);
    const arm = vi.fn();

    await expect(submitUnlockDay('  Vědomě pokračuji  ', 9, unlock)).rejects.toThrow('za 9 s');
    expect(unlock).not.toHaveBeenCalled();

    await submitUnlockDay('  Vědomě pokračuji  ', 0, unlock);
    expect(unlock).toHaveBeenCalledOnce();
    expect(unlock).toHaveBeenCalledWith('Vědomě pokračuji');
    expect(arm).not.toHaveBeenCalled();
  });

  it('banner existuje jen při aktivním zámku a popíše automatický trigger i čas', () => {
    const now = Date.UTC(2026, 8, 4, 14, 0);
    const active = renderToStaticMarkup(React.createElement(DayLockBanner, {
      until: now + 60_000,
      at: now - 8 * 60_000,
      trigger: 'max-trades',
      reason: '10. uzavřený obchod dne',
      now,
      onUnlock: () => undefined,
    }));
    const expired = renderToStaticMarkup(React.createElement(DayLockBanner, {
      until: now,
      now,
      onUnlock: () => undefined,
    }));

    expect(active).toContain('data-day-lock-banner="true"');
    expect(active).toContain('Den je zamčený do');
    expect(active).toContain('Automaticky');
    expect(active).toContain('Max obchodů za den');
    expect(active).toContain('Odemknout…');
    expect(expired).toBe('');
  });
});
