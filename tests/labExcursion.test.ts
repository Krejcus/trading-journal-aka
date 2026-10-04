import { describe, expect, it } from 'vitest';
import { labExcursion } from '../lib/labExcursion';

const T = (hhmm: string) => Date.parse(`2026-10-01T${hhmm}:00Z`) / 1000;
const bar = (hhmm: string, high: number, low: number) => ({ time: T(hhmm), high, low });

describe('labExcursion', () => {
  // Short 10:05 (1. 10.): vstup 30 900, výstup ručně 30 870, SL 30 926, TP 30 761,25.
  const short = { long: false, entryAt: Date.parse('2026-10-01T08:05:04Z'), exitAt: Date.parse('2026-10-01T08:12:30Z'),
    entryPrice: 30900, exitPrice: 30870, sl: 30926, tp: 30761.25 };
  const candles = [
    bar('08:04', 30920, 30899), // před vstupem — nepočítá se
    bar('08:05', 30906.5, 30888), bar('08:08', 30895, 30858), bar('08:12', 30880, 30866),
    bar('08:20', 30850, 30830), bar('08:32', 30790, 30758.5), bar('09:30', 30700, 30690),
  ];

  it('measures the move for and against the trade while it was open', () => {
    const result = labExcursion(short, candles);
    expect(result.candles).toBe(3);
    expect(result.mfePoints).toBe(42);
    expect(result.maePoints).toBe(6.5);
  });

  it('follows the price after the exit and checks the planned TP before the SL', () => {
    const result = labExcursion(short, candles);
    expect(result.afterExitPoints).toBe(111.5);
    expect(result.heldOutcome).toBe('tp');
  });

  it('never reports more adverse move than the stop allowed (entry candle carries pre-entry prices)', () => {
    // Long 9:25 (1. 10.): SL 6,75 b. pod vstupem, svíčka vstupu má low o 13,25 b. níž.
    const long = { long: true, entryAt: Date.parse('2026-10-01T07:25:43Z'), exitAt: Date.parse('2026-10-01T07:25:53Z'),
      entryPrice: 30884.75, exitPrice: 30877.79, sl: 30878, tp: 30990.5 };
    const result = labExcursion(long, [bar('07:25', 30899.75, 30871.5), bar('07:40', 31000, 30860)]);
    expect(result.maePoints).toBeCloseTo(6.96);
    expect(result.heldOutcome).toBeNull();
  });

  it('says when it cannot tell', () => {
    expect(labExcursion(short, []).candles).toBe(0);
    expect(labExcursion({ ...short, tp: null }, candles).heldOutcome).toBeNull();
    expect(labExcursion(short, [bar('08:15', 30930, 30750)]).heldOutcome).toBe('ambiguous');
  });
});
