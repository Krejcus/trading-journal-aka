import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * Lehký náklon karty za myší (pár stupňů) s odleskem. Jen myš — dotyk a
 * „omezit pohyb“ nedělají nic. Mění jen `transform` a dvě CSS proměnné
 * prvku, React se nepřekresluje. Styl odlesku je třída `.tilt-card` v index.css.
 */
export function useTilt<T extends HTMLElement>(maxDegrees = 5) {
  const ref = useRef<T>(null);
  const onPointerMove = useCallback((event: ReactPointerEvent<T>) => {
    const element = ref.current;
    if (!element || event.pointerType !== 'mouse') return;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const box = element.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height;
    element.style.transform = `perspective(900px) rotateX(${((0.5 - y) * 2 * maxDegrees).toFixed(2)}deg) rotateY(${((x - 0.5) * 2 * maxDegrees).toFixed(2)}deg)`;
    element.style.setProperty('--tilt-x', `${(x * 100).toFixed(1)}%`);
    element.style.setProperty('--tilt-y', `${(y * 100).toFixed(1)}%`);
    element.style.setProperty('--tilt-glare', '1');
  }, [maxDegrees]);
  const onPointerLeave = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.style.transform = '';
    element.style.setProperty('--tilt-glare', '0');
  }, []);
  return { ref, onPointerMove, onPointerLeave };
}
