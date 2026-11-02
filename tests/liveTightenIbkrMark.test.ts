import { describe, expect, it } from 'vitest';
import { withIbkrTightenMark } from '../lib/liveChartPosition';
import { liveBreakEven } from '../lib/liveChartOrderLines';

const NOW = Date.UTC(2026, 10, 2, 10);
const summary = (mark: number | null) => ({ kind: 'position', side: 'long', quantity: 1, entry: 25_000, entryType: 'Market', openPnl: null, mark,
  stop: 24_990, target: 25_020, leader: { accountId: 1, quantity: 1, entry: 25_000 } }) as never;
const ibkr = (patch: Partial<{ source: string | null; price: number | null; at: number | null; stale: boolean }> = {}) => ({
  source: 'IBKR:MNQZ2026', price: 25_004, at: NOW - 500, stale: false, ...patch,
});

describe('pojistka utažení SL / BE: cena z IBKR, když P&L brokera chybí (2. 11. 2026)', () => {
  it('cena z P&L brokera má přednost; bez ní čerstvá IBKR téhož kontraktu', () => {
    expect((withIbkrTightenMark(summary(25_001), 'MNQZ6', ibkr(), NOW) as { mark: number }).mark).toBe(25_001);
    expect((withIbkrTightenMark(summary(null), 'MNQZ6', ibkr(), NOW) as { mark: number }).mark).toBe(25_004);
  });

  it('TradingView, kontinuální řada, jiný kontrakt, stará nebo zastaralá kotace = beze změny (blokováno)', () => {
    for (const quote of [ibkr({ source: 'CME_MINI:MNQ1!' }), ibkr({ source: 'IBKR:MNQH2027' }), ibkr({ at: NOW - 3_001 }), ibkr({ stale: true }), ibkr({ price: null }), ibkr({ at: NOW + 5_000 })]) {
      expect((withIbkrTightenMark(summary(null), 'MNQZ6', quote, NOW) as { mark: number | null }).mark).toBeNull();
    }
    expect((withIbkrTightenMark(summary(null), 'MNQH7', ibkr(), NOW) as { mark: number | null }).mark).toBeNull();
  });

  it('BE: bez ceny blokované, s IBKR ≥ 8 ticků nad BE povolené, blíž blokované', () => {
    expect(liveBreakEven(summary(null), 25_000).blocked).toMatch(/není známá/);
    expect(liveBreakEven(withIbkrTightenMark(summary(null), 'MNQZ6', ibkr({ price: 25_002 }), NOW), 25_000).blocked).toBeNull();
    expect(liveBreakEven(withIbkrTightenMark(summary(null), 'MNQZ6', ibkr({ price: 25_001.75 }), NOW), 25_000).blocked).toMatch(/8 ticků/);
  });
});
