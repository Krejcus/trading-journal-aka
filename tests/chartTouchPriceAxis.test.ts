import { describe, expect, it, vi } from 'vitest';
import { attachTouchPriceAxisScale } from '../services/chartTouchPriceAxis';

function fakeElement() {
  const listeners = new Map<string, (event: unknown) => void>();
  return {
    style: { touchAction: '' } as { touchAction: string },
    getBoundingClientRect: () => ({ left: 0, right: 400, top: 0, bottom: 300 }),
    addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, listener); },
    removeEventListener: (type: string) => { listeners.delete(type); },
    fire: (type: string, x: number, count = 1) => listeners.get(type)?.({ touches: Array.from({ length: count }, () => ({ clientX: x })) }),
  };
}

describe('attachTouchPriceAxisScale', () => {
  it('enables vertical touch drag only while a touch that started on the price axis lasts', () => {
    const element = fakeElement();
    const applyOptions = vi.fn();
    const detach = attachTouchPriceAxisScale({ chartElement: () => element as never, priceScale: () => ({ width: () => 60 }) as never, applyOptions });
    element.fire('touchstart', 200);
    element.fire('touchstart', 380, 2);
    expect(applyOptions).not.toHaveBeenCalled();
    element.fire('touchstart', 380);
    expect(applyOptions).toHaveBeenLastCalledWith({ handleScroll: { vertTouchDrag: true } });
    element.fire('touchend', 380, 0);
    expect(applyOptions).toHaveBeenLastCalledWith({ handleScroll: { vertTouchDrag: false } });
    applyOptions.mockClear();
    detach();
    element.fire('touchstart', 380);
    expect(applyOptions).not.toHaveBeenCalled();
  });

  it('restores page scrolling when detached mid-touch', () => {
    const element = fakeElement();
    const applyOptions = vi.fn();
    const detach = attachTouchPriceAxisScale({ chartElement: () => element as never, priceScale: () => ({ width: () => 60 }) as never, applyOptions });
    element.fire('touchstart', 390);
    detach();
    expect(applyOptions).toHaveBeenLastCalledWith({ handleScroll: { vertTouchDrag: false } });
  });

  it('keeps the page still under the chart while attached', () => {
    const element = fakeElement();
    const detach = attachTouchPriceAxisScale({ chartElement: () => element as never, priceScale: () => ({ width: () => 60 }) as never, applyOptions: vi.fn() });
    expect(element.style.touchAction).toBe('none');
    detach();
    expect(element.style.touchAction).toBe('');
  });
});
