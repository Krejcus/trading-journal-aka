import { describe, expect, it } from 'vitest';
import { chicagoToUtcMs, historyPauseDeadline } from '../services/rithmic/cmeBreak';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('přestávka CME pro stahování historie (America/Chicago)', () => {
  it('všední den: jen 16:00–16:50 CT, konec 16:50 CT', () => {
    // středa 25. 11. 2026, CST (UTC−6): 16:10 CT = 22:10 UTC
    expect(iso(historyPauseDeadline(Date.UTC(2026, 10, 25, 22, 10)))).toBe('2026-11-25T22:50:00.000Z');
    expect(historyPauseDeadline(Date.UTC(2026, 10, 25, 21, 59))).toBeNull(); // 15:59 CT, trh otevřený
    expect(historyPauseDeadline(Date.UTC(2026, 10, 25, 22, 51))).toBeNull(); // 16:51 CT, za 9 min se otevírá
  });

  it('víkend: od pátku 16:00 CT do neděle 16:50 CT', () => {
    expect(iso(historyPauseDeadline(Date.UTC(2026, 10, 27, 22, 30)))).toBe('2026-11-29T22:50:00.000Z'); // pá 16:30 CT
    expect(iso(historyPauseDeadline(Date.UTC(2026, 10, 28, 12, 0)))).toBe('2026-11-29T22:50:00.000Z'); // sobota
    expect(iso(historyPauseDeadline(Date.UTC(2026, 10, 29, 20, 0)))).toBe('2026-11-29T22:50:00.000Z'); // ne 14:00 CT
    expect(historyPauseDeadline(Date.UTC(2026, 10, 29, 23, 30))).toBeNull(); // ne 17:30 CT, trh běží
    expect(historyPauseDeadline(Date.UTC(2026, 10, 27, 21, 0))).toBeNull(); // pá 15:00 CT
  });

  it('letní čas v USA, zimní v Evropě (březen): okno podle Chicaga', () => {
    // úterý 17. 3. 2026: USA už CDT (UTC−5), Evropa ještě SEČ → 16:20 CT = 21:20 UTC = 22:20 v Praze
    expect(iso(historyPauseDeadline(Date.UTC(2026, 2, 17, 21, 20)))).toBe('2026-03-17T21:50:00.000Z');
    expect(historyPauseDeadline(Date.UTC(2026, 2, 17, 22, 20))).toBeNull(); // 17:20 CT, trh běží (v Praze 23:20)
    expect(iso(chicagoToUtcMs(2026, 3, 17, 17, 0))).toBe('2026-03-17T22:00:00.000Z');
  });

  it('podzimní přechod (USA 1. 11. 2026): pátek v CDT, neděle už v CST', () => {
    // pátek 30. 10. 2026 16:30 CDT = 21:30 UTC → konec okna neděle 1. 11. 16:50 CST = 22:50 UTC
    expect(iso(historyPauseDeadline(Date.UTC(2026, 9, 30, 21, 30)))).toBe('2026-11-01T22:50:00.000Z');
    // pondělí 2. 11. 2026 16:10 CST = 22:10 UTC
    expect(iso(historyPauseDeadline(Date.UTC(2026, 10, 2, 22, 10)))).toBe('2026-11-02T22:50:00.000Z');
  });
});
