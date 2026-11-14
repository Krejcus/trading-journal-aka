import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * Lehký náklon karty za myší (pár stupňů), bez odlesku — ten rozmazával
 * čísla. Jen myš — dotyk a „omezit pohyb“ nedělají nic. Mění jen `transform`
 * prvku, React se nepřekresluje. Přechod je třída `.tilt-card` v index.css.
 */
export function useTilt<T extends HTMLElement>(maxDegrees = 3) {
  const ref = useRef<T>(null);
  const onPointerMove = useCallback((event: ReactPointerEvent<T>) => {
    const element = ref.current;
    if (!element || event.pointerType !== 'mouse') return;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const box = element.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height;
    element.style.transform = `perspective(900px) rotateX(${((0.5 - y) * 2 * maxDegrees).toFixed(2)}deg) rotateY(${((x - 0.5) * 2 * maxDegrees).toFixed(2)}deg)`;
  }, [maxDegrees]);
  const onPointerLeave = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.style.transform = '';
  }, []);
  return { ref, onPointerMove, onPointerLeave };
}
