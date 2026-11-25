import { describe, expect, it } from 'vitest';
import {
  exitTouchCrosshair,
  installTouchCancelRepair,
  readCrosshairPrice,
  tapEndsTouchCrosshair,
} from '../services/chartTouchCrosshair';

type Seen = { type: string; touches: number; changed: number[] };

/** Plátno grafu: zapisuje dotykové události tak, jak je čte knihovna. */
const fakeCanvas = () => {
  const target = new EventTarget();
  const seen: Seen[] = [];
  const record = (event: Event) => {
    const touch = event as Event & { touches: unknown[]; changedTouches: Array<{ identifier: number }> };
    seen.push({ type: event.type, touches: touch.touches.length, changed: touch.changedTouches.map(item => item.identifier) });
  };
  target.addEventListener('touchstart', record);
  target.addEventListener('touchend', record);
  return Object.assign(target, { seen, getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 400 }) });
};

describe('chartTouchCrosshair', () => {
  it('ukončení kříže pošle ploše grafu klepnutí bez pohybu a kříž smaže', () => {
    const canvas = fakeCanvas();
    let cleared = 0;
    const chartElement = { querySelector: () => ({ querySelectorAll: () => [canvas] }) } as unknown as HTMLElement;
    exitTouchCrosshair({ chartElement: () => chartElement, clearCrosshairPosition: () => { cleared += 1; } });
    expect(canvas.seen.map(item => item.type)).toEqual(['touchstart', 'touchend']);
    // Stejný prst začal i skončil; po konci už žádný dotyk nezbývá.
    expect(canvas.seen[0].changed).toEqual(canvas.seen[1].changed);
    expect(canvas.seen[0].touches).toBe(1);
    expect(canvas.seen[1].touches).toBe(0);
    expect(cleared).toBe(1);
  });

  it('graf, který se právě přestavuje, ukončení kříže neshodí', () => {
    expect(() => exitTouchCrosshair({
      chartElement: () => { throw new Error('disposed'); },
      clearCrosshairPosition: () => { throw new Error('disposed'); },
    })).not.toThrow();
  });

  it('přerušený dotyk se knihovně dořekne jako ukončený (jinak zahodí další klepnutí)', () => {
    const canvas = fakeCanvas();
    const remove = installTouchCancelRepair(canvas as unknown as HTMLElement);
    const cancel = new Event('touchcancel');
    Object.defineProperty(cancel, 'touches', { value: [] });
    Object.defineProperty(cancel, 'changedTouches', { value: [{ identifier: 4 }] });
    canvas.dispatchEvent(cancel);
    expect(canvas.seen).toEqual([{ type: 'touchend', touches: 0, changed: [4] }]);
    remove();
    canvas.dispatchEvent(cancel);
    expect(canvas.seen).toHaveLength(1);
  });

  it('kříž ukončí klepnutí mimo graf, ne klepnutí do grafu ani na plus u kříže', () => {
    const inside = { closest: () => null };
    const plus = { closest: (selector: string) => (selector === '[data-crosshair-keep]' ? {} : null) };
    const toolbar = { closest: () => null };
    const chartElement = { contains: (node: unknown) => node === inside } as unknown as HTMLElement;
    expect(tapEndsTouchCrosshair(inside as unknown as EventTarget, chartElement)).toBe(false);
    expect(tapEndsTouchCrosshair(plus as unknown as EventTarget, chartElement)).toBe(false);
    expect(tapEndsTouchCrosshair(toolbar as unknown as EventTarget, chartElement)).toBe(true);
    expect(tapEndsTouchCrosshair(null, chartElement)).toBe(false);
  });

  it('přesná cena kříže se čte z grafu; bez kříže žádná není', () => {
    expect(readCrosshairPrice({ dataset: { atCrosshairPrice: '24993.75' } } as unknown as HTMLElement)).toBe(24993.75);
    expect(readCrosshairPrice({ dataset: {} } as unknown as HTMLElement)).toBeNull();
    expect(readCrosshairPrice({ dataset: { atCrosshairPrice: 'x' } } as unknown as HTMLElement)).toBeNull();
  });
});
