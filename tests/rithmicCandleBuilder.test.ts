import { describe, expect, it } from 'vitest';
import { RithmicCandleBuilder } from '../services/rithmic/rithmicCandleBuilder';
import type { RithmicTick } from '../services/rithmic/rithmicClient';

const T0 = Date.UTC(2026, 10, 16, 14, 30, 0);

function trade(offsetMs: number, price: number, size = 1, extra: Partial<RithmicTick> = {}): RithmicTick {
  return {
    kind: 'trade', symbol: 'MNQZ6', exchange: 'CME', isSnapshot: false, tradePrice: price, tradeSize: size,
    bidPrice: null, askPrice: null, gatewayAt: T0 + offsetMs, exchangeAt: T0 + offsetMs, receivedAt: T0 + offsetMs + 120, ...extra,
  };
}

describe('RithmicCandleBuilder', () => {
  it('skládá minutovou svíčku z obchodů a uzavře ji na přelomu minuty', () => {
    const b = new RithmicCandleBuilder();
    b.onTick(trade(1_000, 25000, 2));
    b.onTick(trade(20_000, 25010, 1));
    b.onTick(trade(40_000, 24990, 3));
    b.onTick(trade(59_999, 25005, 1));
    expect(b.current('MNQZ6', T0 + 59_999)).toEqual({ time: T0 / 1000, open: 25000, high: 25010, low: 24990, close: 25005, volume: 7 });
    b.onTick(trade(60_000, 25006, 4));
    expect(b.finished('MNQZ6')).toHaveLength(1);
    expect(b.current('MNQZ6', T0 + 61_000)).toEqual({ time: T0 / 1000 + 60, open: 25006, high: 25006, low: 25006, close: 25006, volume: 4 });
  });

  it('čas minuty bere z burzy, ne z příjmu', () => {
    const b = new RithmicCandleBuilder();
    // obchod z 14:30:59.9 doručený až ve 14:31:00.1 patří do minuty 14:30
    b.onTick(trade(59_900, 25000, 1, { receivedAt: T0 + 60_100 }));
    expect(b.current('MNQZ6', T0 + 59_950)?.time).toBe(T0 / 1000);
    expect(b.current('MNQZ6', T0 + 60_100)).toBeNull();
  });

  it('snímek nastaví jen poslední cenu, do svíčky ani objemu se nepočítá', () => {
    const b = new RithmicCandleBuilder();
    expect(b.onTick(trade(-30_000, 24950, 9, { isSnapshot: true }))).toBe(true);
    expect(b.current('MNQZ6', T0)).toBeNull();
    expect(b.lastPrice('MNQZ6', T0, 60_000)).toBe(24950);
    b.onTick(trade(1_000, 25000, 1));
    expect(b.current('MNQZ6', T0 + 1_000)?.volume).toBe(1);
  });

  it('starou cenu nevydává jako čerstvou a stojící svíčku nevrací', () => {
    const b = new RithmicCandleBuilder();
    b.onTick(trade(1_000, 25000));
    expect(b.lastPrice('MNQZ6', T0 + 4_000, 5_000)).toBe(25000);
    expect(b.lastPrice('MNQZ6', T0 + 7_000, 5_000)).toBeNull();
    expect(b.current('MNQZ6', T0 + 125_000)).toBeNull();
  });

  it('každá strana kotace má vlastní stáří i při stejné ceně', () => {
    const b = new RithmicCandleBuilder();
    b.onTick({ ...trade(0, 0), kind: 'bbo', bidPrice: 100, askPrice: 101 });
    b.onTick({ ...trade(4_000, 0), kind: 'bbo', bidPrice: 100 });
    expect(b.quote('MNQZ6', T0 + 5_000, 2_000)).toEqual({ bid: 100, ask: null });
    b.onTick({ ...trade(5_000, 0), kind: 'bbo', askPrice: 99 });
    expect(b.quote('MNQZ6', T0 + 5_000, 2_000)).toBeNull();
  });

  it('opožděný obchod ze starší minuty svíčku nepřepíše', () => {
    const b = new RithmicCandleBuilder();
    b.onTick(trade(61_000, 25010));
    expect(b.onTick(trade(30_000, 24000))).toBe(false);
    expect(b.current('MNQZ6', T0 + 61_500)).toMatchObject({ low: 25010 });
    expect(b.lastPrice('MNQZ6', T0 + 61_500, 5_000)).toBe(25010);
    expect(b.finished('MNQZ6')).toEqual([]);
  });

  it('ignoruje neplatnou cenu, drží kotaci a symboly odděleně; reset vše zahodí', () => {
    const b = new RithmicCandleBuilder({ keepFinished: 2 });
    expect(b.onTick(trade(0, 0))).toBe(false);
    expect(b.onTick(trade(0, Number.NaN))).toBe(false);
    b.onTick({ ...trade(500, 0), kind: 'bbo', tradePrice: null, bidPrice: 24999.75, askPrice: 25000 });
    expect(b.quote('MNQZ6', T0 + 700, 2_000)).toEqual({ bid: 24999.75, ask: 25000 });
    expect(b.quote('MNQZ6', T0 + 10_000, 2_000)).toBeNull();
    b.onTick(trade(0, 7000, 1, { symbol: 'ESZ6' }));
    expect(b.current('MNQZ6', T0)).toBeNull();
    for (let m = 0; m < 5; m += 1) b.onTick(trade(m * 60_000, 25000 + m));
    expect(b.finished('MNQZ6').map((c) => c.open)).toEqual([25002, 25003]);
    b.reset();
    expect(b.lastPrice('ESZ6', T0, 60_000)).toBeNull();
  });
});

it('uses a newer valid two-sided quote for orders and retains the last trade on the candle', () => {
  const b = new RithmicCandleBuilder();
  b.onTick(trade(1000, 100));
  b.onTick({ ...trade(2000, 0), kind: 'bbo', bidPrice: 104, askPrice: 106 });
  expect(b.marketPrice('MNQZ6', T0 + 2500, 2000)).toBe(105);
  expect(b.current('MNQZ6', T0 + 2500)?.close).toBe(100);
  b.onTick(trade(3000, 104));
  expect(b.marketPrice('MNQZ6', T0 + 3500, 2000)).toBe(104);
  expect(b.marketPrice('MNQZ6', T0 + 6000, 2000)).toBeNull();
});
