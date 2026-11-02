import { describe, expect, it } from 'vitest';
import { priceAlertCrossed, priceAlertWatchCondition } from '../lib/priceAlertCross';

const batch = (prev: number, min: number, max: number, last = max) => ({ prev, min, max, last });

describe('upozornění na cenu: křížení z IBKR dávky', () => {
  it('nahoru přes: z pod úrovně na/nad úroveň; dolů přes obráceně', () => {
    expect(priceAlertCrossed('up', 100, batch(99.75, 99.75, 100))).toBe(true);
    expect(priceAlertCrossed('up', 100, batch(99.75, 99.5, 99.75))).toBe(false);
    expect(priceAlertCrossed('up', 100, batch(100.25, 99.5, 100.5))).toBe(false);
    expect(priceAlertCrossed('down', 100, batch(100.25, 100, 100.25))).toBe(true);
    expect(priceAlertCrossed('down', 100, batch(99.75, 99.5, 100.5))).toBe(false);
  });

  it('překročí: kterýkoli směr; průchod celou úrovní v jedné dávce se počítá', () => {
    expect(priceAlertCrossed('cross', 100, batch(99, 98.5, 101))).toBe(true);
    expect(priceAlertCrossed('cross', 100, batch(101, 99, 101.5))).toBe(true);
  });

  it('cena přesně na úrovni před dávkou nic nespustí; bez baseline nikdy', () => {
    expect(priceAlertCrossed('cross', 100, batch(100, 99.75, 100.25))).toBe(false);
    expect(priceAlertCrossed('up', 100, null)).toBe(false);
    expect(priceAlertCrossed('up', 100, batch(Number.NaN, 99, 101))).toBe(false);
    expect(priceAlertCrossed('up', 100, batch(99, 101, 99))).toBe(false);
  });

  it('automatický směr se přepočítá z IBKR baseline; ruční volba platí', () => {
    expect(priceAlertWatchCondition({ price: 100, condition: 'down', conditionAuto: true }, 99)).toBe('up');
    expect(priceAlertWatchCondition({ price: 100, condition: 'up', conditionAuto: true }, 101)).toBe('down');
    expect(priceAlertWatchCondition({ price: 100, condition: 'up', conditionAuto: true }, null)).toBe('cross');
    expect(priceAlertWatchCondition({ price: 100, condition: 'up' }, 101)).toBe('up');
    expect(priceAlertWatchCondition({ price: 100, condition: 'cross', conditionAuto: true }, 99)).toBe('cross');
  });
});
