import { describe, expect, it } from 'vitest';
import { cmeSessionCloseWarning, minutesToCmeSessionClose } from '../lib/cmeSessionClose';

describe('konec seance CME (jen upozornění)', () => {
  // 17. 11. 2026 je úterý; 16:00 v Chicagu = 22:00 UTC (zimní čas).
  const at = (hhmmUtc: string) => Date.parse(`2026-11-17T${hhmmUtc}:00Z`);
  it('minuty do 16:00 chicagského času, o víkendu a po konci nic', () => {
    expect(minutesToCmeSessionClose(at('21:45'))).toBe(15);
    expect(minutesToCmeSessionClose(at('21:59'))).toBe(1);
    expect(minutesToCmeSessionClose(at('22:00'))).toBeNull();
    expect(minutesToCmeSessionClose(at('23:30'))).toBeNull();
    expect(minutesToCmeSessionClose(Date.parse('2026-11-21T21:45:00Z'))).toBeNull(); // sobota
  });
  it('varuje jen s pozicí nebo čekajícím vstupem a jen v posledních minutách', () => {
    expect(cmeSessionCloseWarning(at('21:50'), { position: true, pendingEntry: false })).toMatch(/Za 10 min končí/);
    expect(cmeSessionCloseWarning(at('21:50'), { position: false, pendingEntry: true })).toMatch(/čekající vstup burza/);
    expect(cmeSessionCloseWarning(at('21:50'), { position: false, pendingEntry: false })).toBeNull();
    expect(cmeSessionCloseWarning(at('21:30'), { position: true, pendingEntry: false })).toBeNull();
  });
});
