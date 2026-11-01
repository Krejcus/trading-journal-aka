import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_PILL, LIVE_PILL_STORAGE_KEY, pressQtyKey, qtyFromBuffer, readLivePillPrefs, writeLivePillPrefs,
} from '../lib/livePhoneTrade';

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => { data[key] = value; } };
};

describe('obchodní lišta na telefonu', () => {
  it('preference: výchozí vlevo dole, nesmysly se ořežou', () => {
    expect(readLivePillPrefs(memory())).toEqual(DEFAULT_LIVE_PILL);
    expect(readLivePillPrefs(memory({ [LIVE_PILL_STORAGE_KEY]: '{' }))).toEqual(DEFAULT_LIVE_PILL);
    expect(readLivePillPrefs(memory({ [LIVE_PILL_STORAGE_KEY]: JSON.stringify({ on: false, x: 4, y: -1, qty: 0 }) })))
      .toEqual({ on: false, x: 1, y: 0, qty: 1 });
    expect(readLivePillPrefs(memory({ [LIVE_PILL_STORAGE_KEY]: JSON.stringify({ qty: 5000.7 }) })).qty).toBe(999);
    const storage = memory();
    writeLivePillPrefs(storage, { on: true, x: 0.4, y: 0.6, qty: 25 });
    expect(readLivePillPrefs(storage)).toEqual({ on: true, x: 0.4, y: 0.6, qty: 25 });
  });

  it('klávesnice množství: max. 3 číslice, ⌫, úvodní nula, prázdné = 1', () => {
    expect(pressQtyKey('1', '2')).toBe('12');
    expect(pressQtyKey('0', '7')).toBe('7');
    expect(pressQtyKey('999', '1')).toBe('999');
    expect(pressQtyKey('25', '⌫')).toBe('2');
    expect(pressQtyKey('', '⌫')).toBe('');
    expect(pressQtyKey('4', 'x')).toBe('4');
    expect(qtyFromBuffer('')).toBe(1);
    expect(qtyFromBuffer('0')).toBe(1);
    expect(qtyFromBuffer('25')).toBe(25);
  });

  it('fáze A: lišta ani LIVE graf na telefonu nemají cestu k brokerovi', () => {
    for (const file of ['components/day/LivePhoneTrade.tsx', 'components/day/LivePhoneChart.tsx', 'lib/livePhoneTrade.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from ['"][^'"]*(tradovate|copier|relay|liveOrder|brokerCommand|LiveDesk)[^'"]*['"]/i);
    }
  });
});
