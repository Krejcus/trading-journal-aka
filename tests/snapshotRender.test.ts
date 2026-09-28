import { describe, expect, it } from 'vitest';
import { parseSnapshotRenderParams } from '../lib/snapshotRender';
import { entryProtectionNote, entrySnapshotMoment } from '../lib/tradeReplay';
import { candleUntilFill } from '../lib/candleReplayPath';
import type { TradeExecutionHistory } from '../lib/tradeExecutionHistory';

describe('vykreslovací stránka snímků: parametry', () => {
  it('bez snapshotRender to není stránka snímku', () => {
    expect(parseSnapshotRenderParams('?share=abc')).toBeNull();
    expect(parseSnapshotRenderParams('?snapshotRender=')).toBeNull();
  });
  it('výchozí hodnoty a ořez velikosti', () => {
    expect(parseSnapshotRenderParams('?snapshotRender=t1')).toEqual({ tradeId: 't1', mode: 'exit', width: 1600, height: 900, theme: 'light', token: null });
    expect(parseSnapshotRenderParams('?snapshotRender=t1&mode=entry&w=99999&h=10&theme=dark&token=x')).toEqual({ tradeId: 't1', mode: 'entry', width: 3840, height: 320, theme: 'dark', token: 'x' });
    expect(parseSnapshotRenderParams('?snapshotRender=t1&w=abc')!.width).toBe(1600);
  });
});

const fill = (id: string, role: 'entry' | 'exit', at: number, price: number, side: 'Buy' | 'Sell') =>
  ({ id, role, at, price, side, allocatedQuantity: 1 }) as unknown as TradeExecutionHistory['fills'][number];

describe('snímek při vstupu: nic po vstupu', () => {
  it('konec prvního vstupního příkazu, průměrná cena, hranice před dalším plněním', () => {
    const history = { fills: [
      fill('a', 'entry', 10_000, 100, 'Buy'), fill('b', 'entry', 10_400, 102, 'Buy'),
      fill('c', 'exit', 11_000, 110, 'Sell'),
    ], protection: [] } as unknown as TradeExecutionHistory;
    expect(entrySnapshotMoment(history)).toEqual({ atMs: 10_400, price: 101, cutoffMs: 10_999 });
  });
  it('bez dalšího plnění pustí SL/TP odeslané s příkazem (2 s)', () => {
    const history = { fills: [fill('a', 'entry', 10_000, 100, 'Buy'), fill('c', 'exit', 90_000, 110, 'Sell')], protection: [] } as unknown as TradeExecutionHistory;
    expect(entrySnapshotMoment(history)!.cutoffMs).toBe(12_000);
  });
  it('svíčka vstupu jen od otevření po cenu vstupu', () => {
    const candle = { time: 60, open: 100, high: 110, low: 90, close: 95, volume: 50 };
    expect(candleUntilFill(candle, 104)).toEqual({ time: 60, open: 100, high: 104, low: 100, close: 104, volume: 0 });
    expect(candleUntilFill(candle, 200).close).toBe(110);
  });
});

describe('štítek chybějící ochrany u vstupu', () => {
  const protection = (kind: 'sl' | 'tp', at: number, price = 90, status = 'confirmed', operation = 'new') =>
    ({ id: `${kind}${at}`, orderId: 'o', commandId: null, accountId: 1, at, timeSource: 'broker', kind, price, quantity: 1, status, operation });
  const history = (events: unknown[]) => ({ fills: [fill('a', 'entry', 100_000, 100, 'Buy'), fill('b', 'exit', 400_000, 104, 'Sell')], protection: events } as unknown as TradeExecutionHistory);
  it('market in + out: bez SL/TP', () => expect(entryProtectionNote(history([]))).toEqual({ text: 'bez SL/TP', warn: true }));
  it('stop do 10 s po vstupu se počítá jako při vstupu', () => {
    expect(entryProtectionNote(history([protection('sl', 106_000)]))).toEqual({ text: 'bez TP', warn: false });
    expect(entryProtectionNote(history([protection('sl', 106_000), protection('tp', 100_500, 120)]))).toBeNull();
  });
  it('stop položený později ukáže prodlevu', () => {
    expect(entryProtectionNote(history([protection('sl', 260_000)]))).toEqual({ text: 'SL po 2:40 · bez TP', warn: true });
    expect(entryProtectionNote(history([protection('sl', 145_000), protection('tp', 100_000, 120)]))).toEqual({ text: 'SL po 45 s', warn: true });
  });
  it('jen TP: bez SL', () => expect(entryProtectionNote(history([protection('tp', 100_000, 120)]))).toEqual({ text: 'bez SL', warn: true }));
  it('zrušený SL při vstupu neplatí', () => {
    expect(entryProtectionNote(history([protection('sl', 100_000), protection('sl', 101_000, 90, 'cancelled', 'cancel')]))).toEqual({ text: 'bez SL/TP', warn: true });
  });
});
