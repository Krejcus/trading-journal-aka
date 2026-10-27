import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { liveBalanceDisplay, liveCapitalDisplay, liveCushionEvidence, liveDailyLossRemainingDisplay, liveDailyPnlDisplay, liveDayReadAnswered, liveGroupDailyPnlDisplay } from '../lib/liveBalanceDisplay';
import { isLiveAccountReadVerified } from '../lib/liveReadFreshness';
import { BalanceValue, DailyPnlValue } from '../components/LiveCopyTradeOverview';
import { MobileMetric } from '../components/LiveMobileAccountDetail';
import type { LiveAccount } from '../services/tradecopiaLiveService';

const now = Date.UTC(2026, 8, 10, 8);
const account = (patch: Partial<LiveAccount> = {}) => ({
  id: 1, balance: 51_154.40, cashAvailability: 'available',
  cashUpdatedAt: new Date(now - 1_000).toISOString(), ...patch,
} as LiveAccount);

describe('retained balance presentation', () => {
  it('keeps a confirmed balance after 45 seconds but does not make it fresh risk evidence', () => {
    const a = account({ cashUpdatedAt: new Date(now - 60_000).toISOString() });
    const display = liveBalanceDisplay(a, now);
    expect(display).toMatchObject({ value: 51_154.40, stale: true, confirmedAt: a.cashUpdatedAt });
    expect(isLiveAccountReadVerified(a, 'cash', now)).toBe(false);
    const markup = renderToStaticMarkup(React.createElement(BalanceValue, { display }));
    expect(markup).toContain('51,154.40');
    expect(markup).not.toContain('>čeká na ověření<');
    expect(markup).toContain('poslední potvrzení');
    expect(markup).toContain('data-balance-state="last-known"');
  });

  it('keeps retained cash during a failed request then replaces it with the new broker value', () => {
    const failed = account({ cashAvailability: 'unavailable', cashUpdatedAt: new Date(now - 90_000).toISOString() });
    expect(liveBalanceDisplay(failed, now)).toMatchObject({ value: 51_154.40, stale: true });
    const fresh = liveBalanceDisplay(account({ balance: 51_100 }), now);
    expect(fresh).toMatchObject({ value: 51_100, stale: false });
    expect(renderToStaticMarkup(React.createElement(BalanceValue, { display: fresh }))).not.toContain('čeká na ověření');
  });

  it.each([
    { cashAvailability: 'unavailable', cashUpdatedAt: null, balance: 0 },
    { cashUpdatedAt: 'invalid' },
    { cashUpdatedAt: new Date(now + 60_000).toISOString() },
    { cashAvailability: 'denied' },
    { balance: NaN },
  ] as Partial<LiveAccount>[])('does not invent a balance for missing/invalid evidence: %j', patch => {
    expect(liveBalanceDisplay(account(patch), now).value).toBeNull();
  });

  it('preserves real zero and legacy shadow snapshots', () => {
    expect(liveBalanceDisplay(account({ balance: 0 }), now).value).toBe(0);
    expect(liveBalanceDisplay(account({ cashAvailability: undefined, cashUpdatedAt: undefined }), now).value).toBe(51_154.40);
    expect(liveBalanceDisplay(undefined, now).value).toBeNull();
  });

  it('sums every known member and marks a stale total without silently omitting unknown members', () => {
    const older = account({ balance: 50_000, cashUpdatedAt: new Date(now - 60_000).toISOString() });
    const display = liveCapitalDisplay([account(), older], now);
    expect(display).toMatchObject({ value: 101_154.40, stale: true, confirmedAt: older.cashUpdatedAt });
    expect(liveCapitalDisplay([account(), undefined], now).value).toBeNull();
    expect(liveCapitalDisplay([], now).value).toBeNull();
    const compact = renderToStaticMarkup(React.createElement(BalanceValue, { display, compact: true }));
    expect(compact).not.toContain('>čeká na ověření<');
    expect(compact).toContain('data-balance-state="last-known"');
  });
});


describe('confirmed daily display', () => {
  it('retains confirmed zero without loosening risk freshness', () => {
    const a = account({ realizedPnl: 0, cashUpdatedAt: new Date(now - 90_000).toISOString() });
    expect(liveDailyPnlDisplay(a, now).value).toBe(0);
    expect(isLiveAccountReadVerified(a, 'cash', now)).toBe(false);
    expect(liveGroupDailyPnlDisplay([a, undefined], now)).toBeNull();
  });
  it('uses newer display evidence without changing execution fields', () => {
    const a = account({ realizedPnl: 50, cashUpdatedAt: new Date(now - 90_000).toISOString(), displayValues: {
      dailyRealizedPnL: { value: 125, requestedAt: new Date(now - 2_000).toISOString(), confirmedAt: new Date(now - 1_000).toISOString() },
    } });
    expect(liveDailyPnlDisplay(a, now).value).toBe(125);
    expect(a.realizedPnl).toBe(50);
    expect(isLiveAccountReadVerified(a, 'cash', now)).toBe(false);
  });
  it('rejects previous-session P&L but retains the balance', () => {
    const boundary = Date.UTC(2026, 8, 10, 22);
    const a = account({ realizedPnl: 125, cashUpdatedAt: new Date(boundary - 1_000).toISOString() });
    expect(liveDailyPnlDisplay(a, boundary + 1_000).value).toBeNull();
    expect(liveBalanceDisplay(a, boundary + 1_000).value).toBe(51_154.40);
  });

  it('počítá Daily i DLL ze stejného novějšího realized vstupu bez požadavku na cash timestamp', () => {
    const limitAt = new Date(now - 2_000).toISOString();
    const a = account({
      cashUpdatedAt: null,
      realizedPnl: -200,
      dailyPnlAvailable: true,
      dailyPnlTradeDate: '2026-09-10',
      dailyPnlUpdatedAt: new Date(now - 1_000).toISOString(),
      dailyLossLimit: 1_000,
      dailyLossLimitUpdatedAt: limitAt,
      unrealizedPnl: -50,
      unrealizedPnlSource: 'broker',
      unrealizedPnlUpdatedAt: new Date(now - 700).toISOString(),
      displayValues: {
        dailyRealizedPnL: {
          value: -900,
          requestedAt: new Date(now - 800).toISOString(),
          confirmedAt: new Date(now - 500).toISOString(),
        },
      },
    });
    expect(liveDailyPnlDisplay(a, now)).toMatchObject({ value: -900, stale: false });
    expect(liveDailyLossRemainingDisplay(a, now)).toMatchObject({
      value: 50,
      state: 'ready',
      stale: false,
      confirmedAt: limitAt,
    });
  });

  it('nezapočítá datum uložení profilového limitu do stáří DLL', () => {
    const a = account({
      realizedPnl: -1_000,
      dailyPnlAvailable: true,
      dailyPnlTradeDate: '2026-09-10',
      dailyPnlUpdatedAt: new Date(now - 1_000).toISOString(),
      dailyLossLimit: 1_000,
      dailyLossLimitUpdatedAt: new Date(now - 10 * 86_400_000).toISOString(),
      dailyLossLimitSource: 'profile',
      unrealizedPnl: 0,
      unrealizedPnlSource: 'broker',
      unrealizedPnlUpdatedAt: new Date(now - 800).toISOString(),
    } as Partial<LiveAccount>);
    expect(liveDailyLossRemainingDisplay(a, now)).toMatchObject({
      value: 0,
      state: 'ready',
      stale: false,
      confirmedAt: a.dailyPnlUpdatedAt,
    });
  });

  it('stale denní P&L vykreslí šedě a s věkem místo barevného aktuálního čísla', () => {
    const display = { value: -125, stale: true, confirmedAt: new Date(now - 60_000).toISOString() };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const markup = renderToStaticMarkup(React.createElement(DailyPnlValue, { display }));
      expect(markup).toContain('data-daily-pnl-state="last-known"');
      expect(markup).toContain('text-[var(--text-secondary)]');
      expect(markup).toContain('před 1 min');
      const mobile = renderToStaticMarkup(React.createElement(MobileMetric, {
        label: 'Dnes realizováno', value: -125, pnl: true, stale: true, confirmedAt: display.confirmedAt,
      }));
      expect(mobile).toContain('data-mobile-metric-state="last-known"');
      expect(mobile).toContain('text-[var(--text-secondary)]');
      expect(mobile).toContain('před 1 min');
    } finally {
      clock.mockRestore();
    }
  });

  describe('DLL bez dnešního obchodu', () => {
    const noTradeToday = (patch: Partial<LiveAccount> = {}) => account({
      realizedPnl: 0,
      dailyPnlAvailable: false,
      dailyPnlUpdatedAt: new Date(now - 1_000).toISOString(),
      dailyLossLimit: 1_250,
      dailyLossLimitSource: 'profile',
      unrealizedPnl: 0,
      unrealizedPnlSource: 'broker',
      unrealizedPnlUpdatedAt: new Date(now - 800).toISOString(),
      ...patch,
    } as Partial<LiveAccount>);

    it('přečtený denní report bez dnešního záznamu = celý limit, ne „nedostupné“', () => {
      expect(liveDailyLossRemainingDisplay(noTradeToday(), now)).toMatchObject({
        value: 1_250, state: 'ready', stale: false,
      });
      // Stejný fakt jako sloupec „Dnes“: prokazatelně nula.
      expect(liveDayReadAnswered(noTradeToday(), now)).toBe(true);
    });

    it('otevřená ztráta zbývající DLL snižuje', () => {
      expect(liveDailyLossRemainingDisplay(noTradeToday({ unrealizedPnl: -200 }), now)).toMatchObject({
        value: 1_050, state: 'ready',
      });
    });

    it('report z předchozí session nic nedokazuje — zůstává „nedostupné“', () => {
      const old = noTradeToday({ dailyPnlUpdatedAt: new Date(now - 3 * 86_400_000).toISOString() });
      expect(liveDailyLossRemainingDisplay(old, now)).toMatchObject({ value: null, state: 'unavailable' });
    });

    it('bez času čtení denního reportu se nula nedomýšlí', () => {
      expect(liveDailyLossRemainingDisplay(noTradeToday({ dailyPnlUpdatedAt: null }), now))
        .toMatchObject({ value: null, state: 'unavailable' });
    });

    it('starý (ale dnešní) report je jen poslední známá hodnota', () => {
      const stale = noTradeToday({ dailyPnlUpdatedAt: new Date(now - 5 * 60_000).toISOString() });
      expect(liveDailyLossRemainingDisplay(stale, now)).toMatchObject({ value: 1_250, stale: true });
    });

    it('DLL zbývá nikdy nepřesáhne rezervu DD (max loss je blíž)', () => {
      const display = liveDailyLossRemainingDisplay(noTradeToday({ cushion: 546 }), now);
      expect(display).toMatchObject({ value: 546, state: 'ready', cappedByDrawdown: true, stale: false });
    });

    it('když je rezerva DD větší, platí denní limit', () => {
      const display = liveDailyLossRemainingDisplay(noTradeToday({ cushion: 3_998 }), now);
      expect(display).toMatchObject({ value: 1_250 });
      expect(display.cappedByDrawdown).toBeUndefined();
    });

    it('vypnutý nebo načítaný drawdown DLL neomezuje', () => {
      expect(liveDailyLossRemainingDisplay(noTradeToday({ cushion: 100, riskDisplayDrawdownDisabled: true }), now).value).toBe(1_250);
      expect(liveDailyLossRemainingDisplay(noTradeToday({ cushion: 100, riskDisplayPending: true }), now).value).toBe(1_250);
    });

    it('omezení starým zůstatkem je jen poslední známá hodnota', () => {
      const display = liveDailyLossRemainingDisplay(noTradeToday({
        cushion: 546, cashUpdatedAt: new Date(now - 5 * 60_000).toISOString(),
      }), now);
      expect(display).toMatchObject({ value: 546, stale: true, cappedByDrawdown: true });
    });

    it('během načítání dál „loading“', () => {
      expect(liveDailyLossRemainingDisplay(noTradeToday({ dailyPnlPending: true }), now).state).toBe('loading');
    });
  });

  it.each([
    [{ dailyPnlPending: true, dailyLossLimit: 1_000 }, 'loading'],
    [{ dailyPnlAvailable: false, dailyLossLimit: 1_000 }, 'unavailable'],
    [{ dailyLossLimit: null, riskDisplayPending: false }, 'unknown-limit'],
    [{ dailyLossLimit: null, riskDisplayDailyLossDisabled: true }, 'no-limit'],
  ] as const)('rozliší DLL stav %s', (patch, state) => {
    expect(liveDailyLossRemainingDisplay(account(patch as Partial<LiveAccount>), now).state).toBe(state);
  });
});

describe('částka, za kterou ručí worker (stream beze změny)', () => {
  const iso = (offset: number) => new Date(now + offset).toISOString();
  // Denní report přečtený před 10 minutami (např. při otevření LIVE), od té doby bez obchodu.
  const idle = (patch: Partial<LiveAccount> = {}) => account({
    balance: 51_147,
    cashUpdatedAt: iso(-600_000),
    realizedPnl: 200,
    dailyPnlAvailable: true,
    dailyPnlTradeDate: '2026-09-10',
    dailyPnlUpdatedAt: iso(-600_000),
    dailyLossLimit: 1_200,
    dailyLossLimitUpdatedAt: iso(-3_000),
    unrealizedPnl: 0,
    unrealizedPnlSource: 'estimated',
    unrealizedPnlUpdatedAt: iso(-3_000),
    displayVouch: {
      dailyRealizedPnL: { value: 200, confirmedAt: iso(-900_000 + 360_000), vouchedAt: iso(-2_000) },
      totalCashValue: { value: 51_147, confirmedAt: iso(-900_000 + 360_000), vouchedAt: iso(-2_000) },
    },
    ...patch,
  });

  it('stejná částka s čerstvým statusem workeru je ověřená, čas posledního čtení zůstává', () => {
    const a = idle();
    expect(liveDailyPnlDisplay(a, now)).toMatchObject({ value: 200, stale: false, confirmedAt: a.dailyPnlUpdatedAt, vouchedAt: iso(-2_000) });
    expect(liveBalanceDisplay(a, now)).toMatchObject({ value: 51_147, stale: false, confirmedAt: a.cashUpdatedAt });
    expect(liveDailyLossRemainingDisplay(a, now)).toMatchObject({ value: 1_400, stale: false, state: 'ready' });
    expect(renderToStaticMarkup(React.createElement(DailyPnlValue, { display: liveDailyPnlDisplay(a, now) })))
      .toContain('data-daily-pnl-state="confirmed"');
    // Čerstvost čtení pro risk/execution se nemění.
    expect(isLiveAccountReadVerified(a, 'cash', now)).toBe(false);
  });

  it('Rezerva DD: ručení za hotovost ověří jen s čerstvým otevřeným P&L', () => {
    expect(liveCushionEvidence(idle(), now)).toEqual({ verified: true, confirmedAt: iso(-3_000) });
    // V pozici: hotovost beze změny, ale tick otevřeného P&L minutu stojí.
    const frozen = idle({ unrealizedPnl: -400, unrealizedPnlUpdatedAt: iso(-60_000) });
    expect(liveCushionEvidence(frozen, now)).toMatchObject({ verified: false });
    expect(liveCushionEvidence(idle({ unrealizedPnlSource: 'stale' }), now).verified).toBe(false);
    expect(liveCushionEvidence(idle({ displayVouch: undefined }), now)).toEqual({ verified: false, confirmedAt: iso(-600_000) });
  });

  it('DLL omezené rezervou DD má s ručením stejnou čerstvost jako rezerva', () => {
    const capped = idle({ cushion: 900 });
    expect(liveDailyLossRemainingDisplay(capped, now)).toMatchObject({ value: 900, cappedByDrawdown: true, stale: false, confirmedAt: iso(-3_000) });
  });

  it('jiná částka, starý status workeru nebo minulá session nic neověří', () => {
    const differs = idle({ realizedPnl: 212, balance: 51_159 });
    expect(liveDailyPnlDisplay(differs, now).stale).toBe(true);
    expect(liveBalanceDisplay(differs, now).stale).toBe(true);
    const old = idle({ displayVouch: {
      dailyRealizedPnL: { value: 200, confirmedAt: iso(-600_000), vouchedAt: iso(-46_000) },
      totalCashValue: { value: 51_147, confirmedAt: iso(-600_000), vouchedAt: iso(-46_000) },
    } });
    expect(liveDailyPnlDisplay(old, now).stale).toBe(true);
    expect(liveBalanceDisplay(old, now).stale).toBe(true);
    expect(liveDailyLossRemainingDisplay(old, now).stale).toBe(true);
    const future = idle({ displayVouch: { dailyRealizedPnL: { value: 200, confirmedAt: iso(-600_000), vouchedAt: iso(60_000) } } });
    expect(liveDailyPnlDisplay(future, now).stale).toBe(true);
    const previousSession = idle({ displayVouch: { dailyRealizedPnL: { value: 200, confirmedAt: iso(-86_400_000), vouchedAt: iso(-2_000) } } });
    expect(liveDailyPnlDisplay(previousSession, now).stale).toBe(true);
  });
});
