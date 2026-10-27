import { describe, expect, it } from 'vitest';
import { isEnterBlock } from '../lib/pageEnter';
import { historyCardOrder } from '../lib/historyCardOrder';
import type { Trade } from '../types';

describe('náběh stránky — které bloky naběhnou', () => {
  const vh = 800;
  it('karty a sekce na obrazovce ano', () => {
    expect(isEnterBlock({ top: 120, bottom: 340, width: 480, height: 220 }, vh)).toBe(true);
    // Částečně pod okrajem obrazovky taky.
    expect(isEnterBlock({ top: 700, bottom: 920, width: 480, height: 220 }, vh)).toBe(true);
  });

  it('tlačítka, štítky a bloky mimo obrazovku ne', () => {
    expect(isEnterBlock({ top: 100, bottom: 138, width: 150, height: 38 }, vh)).toBe(false);
    expect(isEnterBlock({ top: 820, bottom: 1040, width: 480, height: 220 }, vh)).toBe(false);
    expect(isEnterBlock({ top: -300, bottom: -80, width: 480, height: 220 }, vh)).toBe(false);
  });

  it('obal přes celou obrazovku ne — naběhnou jeho karty', () => {
    expect(isEnterBlock({ top: 80, bottom: 2080, width: 1000, height: 2000 }, vh)).toBe(false);
  });
});

describe('pořadí karet Historie (zahřívání náhledů míří na ně)', () => {
  const trade = (id: string, entryTime: number, patch: Partial<Trade> = {}) => ({ id, entryTime, date: '2026-10-26', ...patch } as unknown as Trade);
  it('bez neplatných, nejnovější vstup první', () => {
    const order = historyCardOrder([
      trade('a', 1_000),
      trade('b', 3_000, { executionStatus: 'Invalid' } as Partial<Trade>),
      trade('c', 2_000),
      trade('d', 4_000, { isValid: false } as Partial<Trade>),
    ]);
    expect(order.map(item => item.id)).toEqual(['c', 'a']);
  });
});
