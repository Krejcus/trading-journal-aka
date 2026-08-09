import { describe, expect, it } from 'vitest';
import { chartClickOrderOptions, createBacktestQuickOrderDraft } from '../services/backtestQuickOrder';
import { normalizePositionSettings, type PositionDrawing } from '../services/chartPositionDrawing';

const candle = (close: number) => ({ time: 120, open: close, high: close, low: close, close, volume: 1 });
const position = (
  tool: PositionDrawing['tool'],
  entry: number,
  target: number,
  stop: number,
  risk = 100,
): PositionDrawing => ({
  id: 'quick-order-position',
  tool,
  points: [
    { time: 120, price: entry },
    { time: 600, price: target },
    { time: 600, price: stop },
  ],
  style: {
    color: '#787b86', width: 1, dashed: false, fill: null,
    position: normalizePositionSettings({ risk, accountSize: 50_000, pointValue: 2, tickSize: 0.25 }),
  },
});

describe('backtest position Quick Order', () => {
  it('creates a BUY MARKET bracket directly from a long box at the current price', () => {
    expect(createBacktestQuickOrderDraft(position('LongPosition', 100, 110, 95), candle(100))).toEqual({
      side: 'buy', type: 'market', quantity: 10, price: undefined, stopLoss: 95, takeProfit: 110,
    });
  });

  it.each([
    ['LongPosition', 99, 100, 'buy', 'limit'],
    ['LongPosition', 101, 100, 'buy', 'stop'],
    ['ShortPosition', 101, 100, 'sell', 'limit'],
    ['ShortPosition', 99, 100, 'sell', 'stop'],
  ] as const)('infers %s entry at %s versus market %s as %s %s', (tool, entry, market, side, type) => {
    const target = tool === 'LongPosition' ? entry + 5 : entry - 5;
    const stop = tool === 'LongPosition' ? entry - 5 : entry + 5;
    expect(createBacktestQuickOrderDraft(position(tool, entry, target, stop), candle(market))).toMatchObject({
      side, type, price: entry, stopLoss: stop, takeProfit: target,
    });
  });

  it('rounds contracts down so Quick Order never exceeds the box risk', () => {
    const draft = createBacktestQuickOrderDraft(position('LongPosition', 100, 110, 97, 10), candle(100));
    expect(draft.quantity).toBe(1);
  });

  it('rejects inverted brackets and risk below one futures contract', () => {
    expect(() => createBacktestQuickOrderDraft(position('LongPosition', 100, 95, 105), candle(100)))
      .toThrow('Long box musí mít TP nad Entry a SL pod Entry.');
    expect(() => createBacktestQuickOrderDraft(position('LongPosition', 100, 110, 95, 1), candle(100)))
      .toThrow('Nastavený risk nestačí ani na 1 kontrakt.');
  });
});

describe('chartClickOrderOptions — objednávka z pravého kliku do grafu', () => {
  const base = { marketPrice: 100, quantity: 2, tickSize: 0.25, symbol: 'MNQ' };

  it('klik pod trhem nabídne buy limit a sell stop', () => {
    const [buy, sell] = chartClickOrderOptions({ ...base, price: 95 });
    expect(buy).toMatchObject({ side: 'buy', type: 'limit', price: 95, quantity: 2 });
    expect(sell).toMatchObject({ side: 'sell', type: 'stop', price: 95, quantity: 2 });
  });

  it('klik nad trhem obrátí typy', () => {
    const [buy, sell] = chartClickOrderOptions({ ...base, price: 105 });
    expect(buy).toMatchObject({ side: 'buy', type: 'stop' });
    expect(sell).toMatchObject({ side: 'sell', type: 'limit' });
  });

  it('klik na trhu je market a nenese cenu', () => {
    const [buy, sell] = chartClickOrderOptions({ ...base, price: 100 });
    expect(buy).toMatchObject({ type: 'market', price: undefined });
    expect(sell).toMatchObject({ type: 'market', price: undefined });
  });

  it('cenu zarovná na tick — klik je pixel, ne obchodovatelná úroveň', () => {
    const [buy] = chartClickOrderOptions({ ...base, price: 95.13 });
    expect(buy.price).toBe(95.25);
  });

  it('množství bere z panelu, nepočítá ho z rizika', () => {
    const [buy] = chartClickOrderOptions({ ...base, price: 95, quantity: 7 });
    expect(buy.quantity).toBe(7);
    expect(buy.label).toBe('Koupit 7 MNQ @ 95.00 limit');
  });

  it('popisek respektuje přesnost odvozenou z tick size', () => {
    const [buy] = chartClickOrderOptions({
      price: 84.696, marketPrice: 85, quantity: 1, tickSize: 0.001, symbol: 'AUDJPY',
    });
    expect(buy.label).toBe('Koupit 1 AUDJPY @ 84.696 limit');
  });

  it('nesmyslné vstupy nenabídnou nic', () => {
    expect(chartClickOrderOptions({ ...base, price: Number.NaN })).toEqual([]);
    expect(chartClickOrderOptions({ ...base, price: 95, quantity: 0 })).toEqual([]);
    expect(chartClickOrderOptions({ ...base, price: 95, tickSize: 0 })).toEqual([]);
  });
});
