import { describe, expect, it } from 'vitest';
import { placeTooltip } from '../services/journalEntryOrdersPrimitive';

const size = { width: 800, height: 600 };
const overlap = (a: { left: number; top: number }, w: number, h: number, r: { left: number; right: number; top: number; bottom: number }) =>
  Math.max(0, Math.min(a.left + w, r.right) - Math.max(a.left, r.left)) * Math.max(0, Math.min(a.top + h, r.bottom) - Math.max(a.top, r.top));

describe('placeTooltip', () => {
  it('keeps the what-if area of the order uncovered when there is room', () => {
    // Příkaz vlevo, dráha a výsledek daleko vpravo pod kurzorem.
    const avoid = { left: 250, right: 720, top: 100, bottom: 330 };
    const at = { x: 260, y: 120 };
    const place = placeTooltip(size, at, avoid, 252, 260);
    expect(overlap(place, 252, 260, avoid)).toBe(0);
    expect(place.left).toBeGreaterThanOrEqual(6);
    expect(place.top + 260).toBeLessThanOrEqual(594);
  });

  it('stays next to the cursor when nothing needs to be avoided', () => {
    expect(placeTooltip(size, { x: 100, y: 100 }, null, 200, 120)).toEqual({ left: 114, top: 114 });
  });
});
