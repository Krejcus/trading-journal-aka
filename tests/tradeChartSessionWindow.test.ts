import { describe, expect, it } from 'vitest';
import { marketDataSessionWindowForTrade, marketDataWindowForTrade } from '../services/marketDataCalculations';

const iso = (date: Date) => date.toISOString();

describe('okno jen seance obchodu (první načtení detailu)', () => {
  it('běžný odpolední obchod: od půlnoci dne vstupu, konec jako plné okno', () => {
    const entry = Date.parse('2026-09-21T13:34:00Z'); const exit = Date.parse('2026-09-21T13:40:00Z');
    const session = marketDataSessionWindowForTrade(entry, exit);
    expect(iso(session.start)).toBe('2026-09-20T22:00:00.000Z');
    expect(iso(session.end)).toBe(iso(marketDataWindowForTrade(entry, exit).end));
  });
  it('vstup krátce po půlnoci: vezme i předchozí den (rezerva 2 h)', () => {
    const entry = Date.parse('2026-09-20T22:30:00Z'); // 21. 9. 00:30 Praha
    expect(iso(marketDataSessionWindowForTrade(entry, entry + 5 * 60_000).start)).toBe('2026-09-19T22:00:00.000Z');
  });
  it('dlouhý obchod: rezerva před vstupem aspoň jeho délka', () => {
    const entry = Date.parse('2026-09-21T01:00:00Z'); // 03:00 Praha, 5 h obchod
    expect(iso(marketDataSessionWindowForTrade(entry, entry + 5 * 3_600_000).start)).toBe('2026-09-19T22:00:00.000Z');
  });
});
