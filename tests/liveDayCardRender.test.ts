import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveDayCard, LiveDayTrigger, dayMoney } from '../components/LiveDayCard';
import { buildLiveDaySummary, type LiveDaySummary } from '../lib/liveDaySummary';
import type { LiveAccount } from '../services/tradecopiaLiveService';

const now = Date.UTC(2026, 8, 10, 8);
const account = (patch: Partial<LiveAccount> = {}) => ({
  id: 1, name: 'LFF05066846490007', firm: 'LUCID', balance: 50_000, realizedPnl: 0,
  cashAvailability: 'available', cashUpdatedAt: new Date(now - 1_000).toISOString(), ...patch,
} as LiveAccount);

const card = (summary: LiveDaySummary, patch: Partial<React.ComponentProps<typeof LiveDayCard>> = {}) =>
  renderToStaticMarkup(React.createElement(LiveDayCard, {
    summary,
    owner: { name: 'Filip Krejča' },
    tradeDate: '2026-09-10',
    trades: 7,
    losingTrades: 2,
    formatName: (name: string) => name,
    ...patch,
  }));

describe('karta dne', () => {
  it('oddělovač tisíců nechává v částce (ořez šířky řeší CSS)', () => {
    expect(dayMoney(2906)).toBe('+$2 906');
    expect(dayMoney(-2906)).toBe('−$2 906');
    expect(dayMoney(0)).toBe('$0');
  });

  it('ukáže jméno, obchodní den a poměr Win/Loss', () => {
    const markup = card(buildLiveDaySummary([account({ realizedPnl: 240 })], now));
    expect(markup).toContain('Filip Krejča');
    expect(markup).toContain('10. 09. 2026');
    expect(markup).toContain('Účet · 1');
    // 7 obchodů, 2 ztrátové → 5 ziskových.
    expect(markup).toContain('>5</span>');
    expect(markup).toContain('>2</span>');
  });

  it('bez běžícího runtime nevymýšlí počet obchodů', () => {
    const markup = card(buildLiveDaySummary([account({ realizedPnl: 240 })], now), { trades: null, losingTrades: null });
    expect(markup).not.toContain('Win / Loss</div><div class="live-day-vv">0');
    expect(markup.match(/live-day-vv">—/g)).toHaveLength(2);
  });

  it('dílčí součet řekne nahlas, z kolika účtů je', () => {
    const summary = buildLiveDaySummary([
      account({ id: 1, name: 'A', realizedPnl: 240 }),
      account({ id: 2, name: 'B', cashAvailability: 'denied' }),
      account({ id: 3, name: 'C', cashAvailability: 'denied' }),
    ], now);
    const markup = card(summary);
    expect(markup).toContain('Sečteno bez 2 účtů');
    // Nepotvrzený účet má pomlčku, ne nulu.
    expect(markup.match(/live-day-val live-day-flat">—/g)).toHaveLength(2);
  });

  it('když broker nepotvrdil nic, karta to napíše místo nuly', () => {
    const markup = card(buildLiveDaySummary([account({ cashAvailability: 'denied' })], now));
    expect(markup).toContain('Broker dnes nepotvrdil denní P&amp;L ani u jednoho účtu.');
    expect(markup).not.toContain('Sečteno z');
  });

  it('redakce jmen z hlavičky LIVE platí i na kartě', () => {
    const markup = card(buildLiveDaySummary([account({ realizedPnl: 10 })], now), {
      formatName: name => `${name.slice(0, 3)}••••`,
    });
    expect(markup).toContain('LFF••••');
    expect(markup).not.toContain('LFF05066846490007');
  });

  it('zavírací tlačítko je jen tam, kde kartu drží dialog', () => {
    const summary = buildLiveDaySummary([account({ realizedPnl: 10 })], now);
    expect(card(summary)).not.toContain('Zavřít kartu dne');
    expect(card(summary, { onClose: () => {} })).toContain('live-day-close');
  });

  it('klidný den není výpadek dat a karta ho tak nepopisuje', () => {
    const markup = card(buildLiveDaySummary([account({ dailyPnlAvailable: false })], now));
    expect(markup).toContain('Broker dnes u žádného účtu nehlásí uzavřený obchod.');
    expect(markup).not.toContain('nepotvrdil');
  });

  it('účet bez obchodu vedle potvrzeného nevyvolá varování o dílčím součtu', () => {
    const markup = card(buildLiveDaySummary([
      account({ id: 1, name: 'A', realizedPnl: 240 }),
      account({ id: 2, name: 'B', dailyPnlAvailable: false }),
    ], now));
    expect(markup).not.toContain('Sečteno bez');
  });

  it('prázdné portfolio nevypadá jako rozbitá karta', () => {
    const markup = card(buildLiveDaySummary([], now));
    expect(markup).toContain('Žádný připojený účet.');
    // Bez účtu není co potvrzovat — hlásit „broker nepotvrdil“ by bylo lživé.
    expect(markup).not.toContain('nepotvrdil');
    expect(markup).not.toContain('nehlásí');
  });
});

describe('spouštěč karty dne', () => {
  const trigger = (summary: LiveDaySummary) =>
    renderToStaticMarkup(React.createElement(LiveDayTrigger, { summary, onOpen: () => {} }));

  it('ukáže popisek a číslo (varianta 2 — bez Win/Loss)', () => {
    const markup = trigger(buildLiveDaySummary([account({ realizedPnl: 2906 })], now));
    expect(markup).toContain('Dnešní P&amp;L');
    expect(markup).toContain('+$2 906');
    expect(markup).toContain('text-emerald-500');
    expect(markup).not.toContain('live-day-partial-dot');
  });

  it('ztrátový den je červený', () => {
    expect(trigger(buildLiveDaySummary([account({ realizedPnl: -410 })], now))).toContain('text-rose-500');
  });

  it('dílčí součet nese jantarovou tečku a vysvětlení', () => {
    const markup = trigger(buildLiveDaySummary([
      account({ id: 1, realizedPnl: 240 }),
      account({ id: 2, cashAvailability: 'denied' }),
    ], now));
    expect(markup).toContain('live-day-partial-dot');
    expect(markup).toContain('Sečteno bez 1 účtu');
  });

  it('bez jediného připojeného účtu se spouštěč vůbec nevykreslí', () => {
    expect(trigger(buildLiveDaySummary([], now))).toBe('');
  });

  it('bez potvrzené hodnoty ukáže pomlčku, ne nulu', () => {
    const markup = trigger(buildLiveDaySummary([account({ cashAvailability: 'denied' })], now));
    expect(markup).toContain('>—</span>');
    expect(markup).not.toContain('$0');
  });
});
