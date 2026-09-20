import { describe, expect, it } from 'vitest';
import { buildLiveDaySummary } from '../lib/liveDaySummary';
import type { LiveAccount } from '../services/tradecopiaLiveService';

const now = Date.UTC(2026, 8, 10, 8);
const account = (patch: Partial<LiveAccount> = {}) => ({
  id: 1, name: 'LFF-0010', firm: 'LUCID', balance: 51_154.40, realizedPnl: 0,
  cashAvailability: 'available', cashUpdatedAt: new Date(now - 1_000).toISOString(), ...patch,
} as LiveAccount);

describe('buildLiveDaySummary', () => {
  it('bez účtů nevrací nulu, ale chybějící hodnotu', () => {
    const summary = buildLiveDaySummary([], now);
    expect(summary).toMatchObject({ confirmed: null, confirmedCount: 0, accountCount: 0, partial: false });
    expect(summary.rows).toEqual([]);
  });

  it('sečte potvrzené účty a seřadí je od nejlepšího', () => {
    const summary = buildLiveDaySummary([
      account({ id: 1, name: 'A', realizedPnl: 120 }),
      account({ id: 2, name: 'B', realizedPnl: -45 }),
      account({ id: 3, name: 'C', realizedPnl: 300 }),
    ], now);
    expect(summary.confirmed).toBe(375);
    expect(summary.confirmedCount).toBe(3);
    expect(summary.accountCount).toBe(3);
    expect(summary.partial).toBe(false);
    expect(summary.rows.map(row => row.name)).toEqual(['C', 'A', 'B']);
  });

  it('nepotvrzený účet nesnižuje součet, ale označí ho jako dílčí', () => {
    const summary = buildLiveDaySummary([
      account({ id: 1, name: 'A', realizedPnl: 120 }),
      account({ id: 2, name: 'B', cashAvailability: 'denied' }),
    ], now);
    expect(summary.confirmed).toBe(120);
    expect(summary.confirmedCount).toBe(1);
    expect(summary.accountCount).toBe(2);
    expect(summary.partial).toBe(true);
  });

  it('nepotvrzené účty jdou až za potvrzené, i když jsou ty potvrzené ztrátové', () => {
    const summary = buildLiveDaySummary([
      account({ id: 1, name: 'chybí', cashAvailability: 'denied' }),
      account({ id: 2, name: 'ztráta', realizedPnl: -900 }),
    ], now);
    expect(summary.rows.map(row => row.name)).toEqual(['ztráta', 'chybí']);
    expect(summary.rows.map(row => row.value)).toEqual([-900, null]);
  });

  it('když broker nepotvrdil ani jeden účet, součet je null (ne nula)', () => {
    const summary = buildLiveDaySummary([
      account({ id: 1, name: 'A', cashAvailability: 'denied' }),
      account({ id: 2, name: 'B', cashAvailability: 'denied' }),
    ], now);
    expect(summary.confirmed).toBeNull();
    // Nic potvrzeného není „dílčí součet“ — není z čeho dělat součet.
    expect(summary.partial).toBe(false);
  });

  it('skutečně nulový den je potvrzená nula, ne chybějící hodnota', () => {
    const summary = buildLiveDaySummary([account({ realizedPnl: 0 })], now);
    expect(summary.confirmed).toBe(0);
    expect(summary.rows[0].value).toBe(0);
    expect(summary.partial).toBe(false);
  });

  it('P&L z minulé broker session se nepočítá do dneška', () => {
    const boundary = Date.UTC(2026, 8, 10, 22);
    const summary = buildLiveDaySummary([
      account({ id: 1, name: 'A', realizedPnl: 125, cashUpdatedAt: new Date(boundary - 1_000).toISOString() }),
    ], boundary + 1_000);
    expect(summary.confirmed).toBeNull();
    expect(summary.rows[0].value).toBeNull();
  });

  it('zastaralé potvrzení se počítá, ale je označené', () => {
    const summary = buildLiveDaySummary([
      account({ id: 1, name: 'A', realizedPnl: 60, cashUpdatedAt: new Date(now - 90_000).toISOString() }),
    ], now);
    expect(summary.confirmed).toBe(60);
    expect(summary.rows[0].stale).toBe(true);
    expect(summary.stale).toBe(true);
  });

  it('během doplňování denního ledgeru čeká na potvrzení brokerem', () => {
    const accounts = [account({ id: 1, name: 'A', realizedPnl: 120 })];
    expect(buildLiveDaySummary(accounts, now, true).confirmed).toBeNull();
    expect(buildLiveDaySummary(
      [account({ id: 1, name: 'A', realizedPnl: 120, dailyPnlAvailable: true })], now, true,
    ).confirmed).toBe(120);
  });

  it('účet bez obchodu se odliší od účtu, který se nepodařilo přečíst', () => {
    const summary = buildLiveDaySummary([
      // Čtení prošlo, broker jen nemá denní záznam → klid, ne výpadek.
      account({ id: 1, name: 'klid', dailyPnlAvailable: false }),
      // Čtení neprošlo → o tomhle účtu nevíme nic.
      account({ id: 2, name: 'necteno', cashAvailability: 'denied' }),
    ], now);
    expect(summary.rows.map(row => [row.name, row.state])).toEqual(
      expect.arrayContaining([['klid', 'no-trades'], ['necteno', 'unconfirmed']]),
    );
    expect(summary.noTradeCount).toBe(1);
    expect(summary.unconfirmedCount).toBe(1);
  });

  it('klidný účet vedle potvrzeného nedělá ze součtu dílčí součet', () => {
    const summary = buildLiveDaySummary([
      account({ id: 1, name: 'obchodoval', realizedPnl: 240 }),
      account({ id: 2, name: 'klid', dailyPnlAvailable: false }),
    ], now);
    expect(summary.confirmed).toBe(240);
    // Účet bez obchodu do součtu nic nepřidá, takže není o čem varovat.
    expect(summary.partial).toBe(false);
    expect(summary.unconfirmedCount).toBe(0);
  });

  it('nepřečtený účet vedle potvrzeného ze součtu dílčí součet udělá', () => {
    const summary = buildLiveDaySummary([
      account({ id: 1, name: 'obchodoval', realizedPnl: 240 }),
      account({ id: 2, name: 'necteno', cashAvailability: 'denied' }),
    ], now);
    expect(summary.partial).toBe(true);
    expect(summary.unconfirmedCount).toBe(1);
  });

  it('během doplňování ledgeru se klid nevydává za ověřený klid', () => {
    const summary = buildLiveDaySummary([account({ dailyPnlAvailable: false })], now, true);
    expect(summary.rows[0].state).toBe('unconfirmed');
    expect(summary.noTradeCount).toBe(0);
  });

  it('prázdná firma se nese jako null, ne jako prázdný řetězec', () => {
    const summary = buildLiveDaySummary([account({ firm: '  ' })], now);
    expect(summary.rows[0].firm).toBeNull();
  });
});
