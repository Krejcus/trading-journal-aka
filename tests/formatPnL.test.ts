import { describe, it, expect } from 'vitest';
import { formatCurrency, formatPnL } from '../utils/formatPnL';

describe('formatCurrency', () => {
  it('USD bez konverze', () => {
    expect(formatCurrency(250, 'USD')).toBe('$250');
  });

  it('CZK s kurzem konvertuje', () => {
    expect(formatCurrency(10, 'CZK', { CZK: 23 })).toBe('230 Kč');
  });

  // REGRESE: dřív se při nenačtených kurzech vypsala surová USD částka se symbolem cizí
  // měny (např. "250 Kč" kde 250 jsou dolary). Teď spadne zpět na USD.
  it('bez kurzů NEukáže dolary se symbolem Kč → spadne na USD', () => {
    expect(formatCurrency(250, 'CZK', undefined)).toContain('$');
    expect(formatCurrency(250, 'CZK', undefined)).not.toContain('Kč');
    expect(formatCurrency(250, 'CZK', {})).not.toContain('Kč');
    // EUR cíl, ale v kurzech EUR chybí → taky fallback na USD
    expect(formatCurrency(250, 'EUR', { CZK: 23 })).toContain('$');
  });

  it('znaménko (showSign)', () => {
    expect(formatCurrency(50, 'USD', undefined, true)).toBe('+$50');
    expect(formatCurrency(-50, 'USD', undefined, true)).toBe('-$50');
  });
});

describe('formatPnL', () => {
  it('percent mód podle balance', () => {
    expect(formatPnL(50, 'percent', 1000)).toBe('+5.00%');
  });

  it('rr mód podle R', () => {
    expect(formatPnL(0, 'rr', undefined, 2.5)).toBe('+2.50R');
  });

  it('usd mód deleguje na formatCurrency', () => {
    expect(formatPnL(250, 'usd', undefined, undefined, true)).toBe('+$250');
  });
});
