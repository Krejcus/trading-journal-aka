import { describe, expect, it } from 'vitest';
import { priceAxisLabelPriority, thinPriceAxisLabels } from '../services/chartPriceAxisLabels';

// 1 bod ceny = 1 px, osa roste dolů jako v grafu.
const y = (price: number) => 1_000 - price;

describe('thinPriceAxisLabels — štítky na ose telefonu', () => {
  it('priorita: VWAP, úrovně, σ pásma', () => {
    expect(priceAxisLabelPriority('VWAP')).toBe(0);
    expect(priceAxisLabelPriority('dHigh')).toBe(1);
    expect(priceAxisLabelPriority('VWAP +1σ')).toBe(2);
  });

  it('z překrývajících se nechá ten s vyšší prioritou', () => {
    const labels = [
      { name: 'VWAP -1σ', price: 500 },
      { name: 'dLow', price: 505 },
      { name: 'VWAP', price: 510 },
      { name: 'PDL', price: 600 },
    ];
    expect(thinPriceAxisLabels(labels, y, [], 17).map(label => label.name)).toEqual(['VWAP', 'PDL']);
  });

  it('neschová štítek pod aktuální cenou a drží vstupní pořadí', () => {
    const labels = [
      { name: 'PDH', price: 700 },
      { name: 'dHigh', price: 650 },
      { name: 'VWAP', price: 640 },
    ];
    // Aktuální cena 655 → dHigh i VWAP jsou do 17 px, PDH je daleko.
    expect(thinPriceAxisLabels(labels, y, [y(655)], 17).map(label => label.name)).toEqual(['PDH']);
  });

  it('štítek mimo graf (null souřadnice) vynechá', () => {
    expect(thinPriceAxisLabels([{ name: 'VWAP', price: 1 }], () => null, [], 17)).toEqual([]);
  });
});
