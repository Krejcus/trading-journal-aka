import { describe, it, expect } from 'vitest';
import { formatCurrency, formatPnL, formatTradePnL } from '../utils/formatPnL';

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


describe('journal PnL presentation', () => {
  const journal = (pnl: number) => ({ pnl, copierTradeId: 'journal:confirmed' });
  it.each([15.76, -0.24, 0])('keeps the cents of confirmed net PnL %s', value => {
    const amount = Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(formatTradePnL(journal(value), 'usd')).toBe(`${value > 0 ? '+' : value < 0 ? '-' : ''}$${amount}`);
  });
  it('does not turn a price-based or legacy risk ratio into verified journal R', () => {
    expect(formatTradePnL(journal(15.76), 'rr', 50000, 0.85)).toBe('—');
    expect(formatTradePnL(journal(0), 'rr', 50000, 0)).toBe('—');
  });
  it('requires a known positive balance for percentages', () => {
    for (const balance of [undefined, 0, -1, NaN, Infinity]) expect(formatTradePnL(journal(15.76), 'percent', balance)).toBe('—');
    expect(formatTradePnL(journal(15.76), 'percent', 50000)).toBe('+0.03%');
    expect(formatTradePnL(journal(354.24), 'percent', 600000)).toBe('+0.06%');
  });
  it('converts cents only with a finite positive FX rate', () => {
    const expected = (15.76 * 23).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(formatTradePnL(journal(15.76), 'usd', undefined, undefined, true, 'CZK', { CZK: 23 })).toBe(`+${expected} Kč`);
    for (const rate of [0, -23, Infinity, NaN, '23']) expect(formatTradePnL(journal(15.76), 'usd', undefined, undefined, true, 'CZK', { CZK: rate })).toBe(formatTradePnL(journal(15.76), 'usd'));
  });
  it('keeps manual formatting defaults and rejects nonfinite journal PnL', () => {
    expect(formatTradePnL({ pnl: 15.76 }, 'usd')).toBe('+$16');
    expect(formatTradePnL(journal(NaN), 'usd')).toBe('—');
  });
});
