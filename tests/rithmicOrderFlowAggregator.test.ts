import { describe, expect, it } from 'vitest';
import { OrderFlowAggregator } from '../services/rithmic/orderFlowAggregator';
import type { RithmicTick } from '../services/rithmic/rithmicClient';

const T0 = Date.UTC(2026, 10, 27, 14, 30, 0);
const M0 = T0 / 1000;

function trade(offsetMs: number, price: number, size: number, aggressor: 'buy' | 'sell' | null, orderId: string | null, extra: Partial<RithmicTick> = {}): RithmicTick {
  return {
    kind: 'trade', symbol: 'NQZ6', exchange: 'CME', isSnapshot: false, tradePrice: price, tradeSize: size,
    bidPrice: null, askPrice: null, gatewayAt: T0 + offsetMs, exchangeAt: T0 + offsetMs, receivedAt: T0 + offsetMs + 80,
    aggressor, aggressorOrderId: orderId, ...extra,
  };
}

function make(floor = 5): OrderFlowAggregator {
  const a = new OrderFlowAggregator({ tickSize: 0.25, tradeFloor: () => floor });
  a.addSymbol('NQZ6');
  a.feedOpened(T0 - 120_000);
  return a;
}

describe('OrderFlowAggregator — objem po minutách a cenách', () => {
  it('sčítá nákupy a prodeje zvlášť na každé ceně', () => {
    const a = make();
    a.onTick(trade(1_000, 25000, 2, 'buy', 'A'));
    a.onTick(trade(2_000, 25000, 3, 'sell', 'B'));
    a.onTick(trade(3_000, 25000.25, 1, 'buy', 'C'));
    a.onTick(trade(4_000, 25000, 4, null, null));
    expect(a.cells('NQZ6', M0)).toEqual([100000, 2, 3, 4, 100001, 1, 0, 0]);
  });

  it('hlásí jen změněné ceny rozdělané minuty a po přelomu celou dokončenou minutu', () => {
    const a = make();
    a.onTick(trade(1_000, 25000, 2, 'buy', 'A'));
    expect(a.drainCells('NQZ6')).toEqual([{ minute: M0, keys: [100000] }]);
    expect(a.drainCells('NQZ6')).toEqual([]);
    a.onTick(trade(5_000, 25001, 1, 'sell', 'B'));
    a.onTick(trade(61_000, 25002, 1, 'buy', 'C'));
    expect(a.drainCells('NQZ6')).toEqual([{ minute: M0, keys: null }, { minute: M0 + 60, keys: [100008] }]);
    expect(a.cells('NQZ6', M0, [100004])).toEqual([100004, 0, 1, 0]);
    expect(a.minutes('NQZ6', M0)).toEqual([M0, M0 + 60]);
  });

  it('opožděný obchod ze starší minuty zahodí (stejně jako svíčky)', () => {
    const a = make();
    a.onTick(trade(61_000, 25002, 1, 'buy', 'C'));
    a.onTick(trade(59_000, 25000, 9, 'buy', 'A'));
    expect(a.minutes('NQZ6', M0)).toEqual([M0 + 60]);
    expect(a.takeStats('NQZ6').late).toBe(1);
  });

  it('snímek po přihlášení odběru a kotace ignoruje', () => {
    const a = make();
    a.onTick(trade(1_000, 25000, 5, 'buy', 'A', { isSnapshot: true }));
    a.onTick({ ...trade(1_000, 25000, 5, 'buy', 'A'), kind: 'bbo' });
    expect(a.minutes('NQZ6', M0)).toEqual([]);
  });

  it('cizí symbol nezapočítá', () => {
    const a = make();
    a.onTick(trade(1_000, 25000, 5, 'buy', 'A', { symbol: 'ESZ6' }));
    expect(a.minutes('NQZ6', M0)).toEqual([]);
    expect(a.minutes('ESZ6', M0)).toEqual([]);
  });
});

describe('OrderFlowAggregator — velké obchody', () => {
  it('sečte dílčí obchody jednoho příkazu agresora do jedné události', () => {
    const a = make(5);
    a.onTick(trade(1_000, 25000, 2, 'buy', 'A'));
    a.onTick(trade(1_000, 25000.25, 3, 'buy', 'A'));
    a.onTick(trade(1_000, 25000.5, 4, 'buy', 'A'));
    expect(a.drainTrades('NQZ6')).toEqual([['A', T0 + 1_000, 1, 9, 3, 100000, 100002, 100001]]);
    expect(a.drainTrades('NQZ6')).toEqual([]);
  });

  it('malý příkaz neposílá a po doplnění nad práh pošle opravu se stejným id', () => {
    const a = make(5);
    a.onTick(trade(1_000, 25000, 3, 'sell', 'A'));
    expect(a.drainTrades('NQZ6')).toEqual([]);
    a.onTick(trade(1_000, 25000, 3, 'sell', 'A'));
    expect(a.drainTrades('NQZ6')).toEqual([['A', T0 + 1_000, -1, 6, 2, 100000, 100000, 100000]]);
    a.onTick(trade(1_000, 24999.75, 4, 'sell', 'A'));
    const rows = a.drainTrades('NQZ6');
    expect(rows).toHaveLength(1);
    expect(rows[0].slice(0, 5)).toEqual(['A', T0 + 1_000, -1, 10, 3]);
    expect(a.tradesSince('NQZ6', T0)).toHaveLength(1);
  });

  it('jiné číslo příkazu začíná novou událost; obchod bez čísla je každý zvlášť', () => {
    const a = make(5);
    a.onTick(trade(1_000, 25000, 6, 'buy', 'A'));
    a.onTick(trade(1_100, 25000, 7, 'sell', 'B'));
    a.onTick(trade(1_200, 25000, 8, 'buy', null));
    a.onTick(trade(1_300, 25000, 9, 'buy', null));
    const rows = a.drainTrades('NQZ6');
    expect(rows.map((row) => [row[2], row[3]])).toEqual([[1, 6], [-1, 7], [1, 8], [1, 9]]);
    expect(new Set(rows.map((row) => row[0])).size).toBe(4);
  });

  it('obchod bez strany jde jen do objemu, nikdy do velkých obchodů', () => {
    const a = make(1);
    a.onTick(trade(1_000, 25000, 50, null, 'A'));
    expect(a.drainTrades('NQZ6')).toEqual([]);
    expect(a.takeStats('NQZ6').noSide).toBe(1);
  });

  it('vede rozdělení velikostí všech příkazů, i těch pod prahem', () => {
    const a = make(100);
    a.onTick(trade(1_000, 25000, 1, 'buy', 'A'));
    a.onTick(trade(1_100, 25000, 3, 'buy', 'B'));
    a.onTick(trade(1_200, 25000, 60, 'sell', 'C'));
    a.onTick(trade(61_000, 25000, 1, 'sell', 'D'));
    const stats = a.takeStats('NQZ6');
    expect(stats.orders).toBe(3);
    expect(stats.sizeHistogram).toEqual([1, 1, 0, 0, 0, 1, 0]);
    expect(stats.volume).toBe(65);
  });
});

describe('OrderFlowAggregator — pokrytí a disk', () => {
  it('minuta, ve které ceny teprve začaly téct, není pokrytá; další ano', () => {
    const a = new OrderFlowAggregator({ tickSize: 0.25, tradeFloor: () => 5 });
    a.addSymbol('NQZ6');
    a.feedOpened(T0 + 20_000);
    a.onTick(trade(30_000, 25000, 1, 'buy', 'A'));
    a.onTick(trade(70_000, 25000, 1, 'buy', 'B'));
    a.onTick(trade(130_000, 25000, 1, 'buy', 'C'));
    expect(a.coverage('NQZ6', M0)).toEqual([[M0 + 60, M0 + 120]]);
    const persisted = a.takePersist('NQZ6').minutes;
    expect(persisted.map((record) => [record.minute, record.covered])).toEqual([[M0, false], [M0 + 60, true]]);
  });

  it('prázdné minuty při tekoucích cenách počítá jako pokryté', () => {
    const a = make();
    a.onTick(trade(1_000, 25000, 1, 'buy', 'A'));
    a.advance(T0 + 5 * 60_000 + 3_000);
    // minuta 0 (s obchodem) a minuty 1–4 (prázdné) jsou uzavřené; pátá teprve běží
    expect(a.coverage('NQZ6', M0)).toEqual([[M0, M0 + 300]]);
    a.onTick(trade(2 * 60_000, 25000, 9, 'buy', 'Z'));
    expect(a.takeStats('NQZ6').late).toBe(1);
  });

  it('po výpadku uzavře rozdělanou minutu jako neúplnou', () => {
    const a = make();
    a.onTick(trade(1_000, 25000, 6, 'buy', 'A'));
    a.feedLost();
    expect(a.coverage('NQZ6', M0)).toEqual([]);
    expect(a.takePersist('NQZ6').minutes).toEqual([{ minute: M0, cells: [100000, 6, 0, 0], covered: false }]);
    expect(a.liveSince('NQZ6')).toBeNull();
  });

  it('obnoví stav z uložených záznamů a nic z něj neposílá jako změnu', () => {
    const a = make();
    a.onTick(trade(1_000, 25000, 6, 'buy', 'A'));
    a.onTick(trade(61_000, 25001, 7, 'sell', 'B'));
    a.onTick(trade(121_000, 25001, 1, 'sell', 'C'));
    const saved = a.takePersist('NQZ6');
    expect(saved.trades.map((row) => row[0])).toEqual(['A', 'B']);

    const b = new OrderFlowAggregator({ tickSize: 0.25, tradeFloor: () => 5 });
    b.addSymbol('NQZ6');
    b.restore('NQZ6', saved.minutes, saved.trades, T0 + 200_000);
    expect(b.cells('NQZ6', M0)).toEqual([100000, 6, 0, 0]);
    expect(b.cells('NQZ6', M0 + 60)).toEqual([100004, 0, 7, 0]);
    expect(b.coverage('NQZ6', M0)).toEqual([[M0, M0 + 120]]);
    expect(b.tradesSince('NQZ6', T0).map((row) => row[3])).toEqual([6, 7]);
    expect(b.drainCells('NQZ6')).toEqual([]);
    expect(b.drainTrades('NQZ6')).toEqual([]);
    expect(b.takePersist('NQZ6')).toEqual({ minutes: [], trades: [] });
  });

  it('staré minuty a obchody po čase zahodí', () => {
    const a = new OrderFlowAggregator({ tickSize: 0.25, tradeFloor: () => 5, keepMs: 3_600_000 });
    a.addSymbol('NQZ6');
    a.feedOpened(T0 - 120_000);
    a.onTick(trade(1_000, 25000, 6, 'buy', 'A'));
    a.advance(T0 + 2 * 3_600_000 + 5_000);
    expect(a.minutes('NQZ6', 0)).toEqual([]);
    expect(a.tradesSince('NQZ6', 0)).toEqual([]);
  });
});
