import { describe, expect, it } from 'vitest';
import { msUntilTradovateSessionEnd } from '../services/copierArmSession';

const HOUR = 60 * 60 * 1000;

describe('msUntilTradovateSessionEnd', () => {
  it('v zimě (CST, UTC-6) končí session ve 23:00 UTC', () => {
    // 2026-01-15 12:00 UTC = 06:00 CT -> do 17:00 CT zbývá 11 h.
    expect(msUntilTradovateSessionEnd(Date.UTC(2026, 0, 15, 12))).toBe(11 * HOUR);
  });

  it('v létě (CDT, UTC-5) končí session ve 22:00 UTC', () => {
    // 2026-07-15 12:00 UTC = 07:00 CT -> do 17:00 CT zbývá 10 h.
    expect(msUntilTradovateSessionEnd(Date.UTC(2026, 6, 15, 12))).toBe(10 * HOUR);
  });

  it('po 17:00 CT patří TTL už další session', () => {
    // 2026-07-15 22:30 UTC = 17:30 CT -> do zítřejších 17:00 CT zbývá 23,5 h.
    expect(msUntilTradovateSessionEnd(Date.UTC(2026, 6, 15, 22, 30))).toBe(23.5 * HOUR);
  });

  it('přesně v 17:00 CT začíná nová session', () => {
    expect(msUntilTradovateSessionEnd(Date.UTC(2026, 6, 15, 22))).toBe(24 * HOUR);
  });

  it('den přechodu na letní čas nedá zápornou ani nulovou hodnotu', () => {
    // Přechod 2026-03-08 02:00 CST -> 03:00 CDT. Armování 8. 3. ráno.
    const ttl = msUntilTradovateSessionEnd(Date.UTC(2026, 2, 8, 6));
    expect(ttl).toBeGreaterThan(0);
    // 06:00 UTC = 00:00 CST; den je o hodinu kratší -> 17:00 CDT = 22:00 UTC = 16 h.
    expect(ttl).toBe(16 * HOUR);
  });

  it('den přechodu na zimní čas počítá s delším dnem', () => {
    // Přechod 2026-11-01 02:00 CDT -> 01:00 CST. 06:00 UTC = 01:00 CDT.
    const ttl = msUntilTradovateSessionEnd(Date.UTC(2026, 10, 1, 6));
    // 17:00 CST = 23:00 UTC -> 17 h.
    expect(ttl).toBe(17 * HOUR);
  });

  it('výsledek nikdy nepřesáhne 25 hodin', () => {
    for (let hour = 0; hour < 48; hour += 1) {
      const ttl = msUntilTradovateSessionEnd(Date.UTC(2026, 2, 7, hour));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(25 * HOUR);
    }
  });

  it('odmítne nekonečný vstup', () => {
    expect(() => msUntilTradovateSessionEnd(Number.NaN)).toThrow();
  });
});
