import { describe, expect, it } from 'vitest';
import { cmeFuturesSessionOpen } from '../lib/cmeSession';
import { cmeDailyHaltWindow } from '../services/copierArmSession';

// Chicago v listopadu 2026 po změně času: UTC−6. 8. 11. 2026 je neděle.
const ct = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour + 6, minute);

describe('otevřená CME seance (jen zobrazení)', () => {
  it('týden: neděle 17:00 až pátek 16:00, sobota zavřeno', () => {
    expect(cmeFuturesSessionOpen(ct(7, 12))).toBe(false);
    expect(cmeFuturesSessionOpen(ct(8, 16, 59))).toBe(false);
    expect(cmeFuturesSessionOpen(ct(8, 17))).toBe(true);
    expect(cmeFuturesSessionOpen(ct(13, 15, 59))).toBe(true);
    expect(cmeFuturesSessionOpen(ct(13, 16))).toBe(false);
  });

  it('denní pauza sedí s výpočtem kopírky i přes změnu času', () => {
    for (const day of [Date.UTC(2026, 9, 28), Date.UTC(2026, 10, 3), Date.UTC(2027, 2, 16)]) {
      for (let minute = 0; minute < 24 * 60; minute += 30) {
        const at = day + minute * 60_000;
        const { inside } = cmeDailyHaltWindow(at, 0);
        if (inside) expect(cmeFuturesSessionOpen(at)).toBe(false);
        else expect(cmeFuturesSessionOpen(at)).toBe(true);
      }
    }
  });
});
