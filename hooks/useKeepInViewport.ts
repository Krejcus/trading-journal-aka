import { useLayoutEffect, type RefObject } from 'react';

const EDGE = 8;

/**
 * Plovoucí popup po otevření vodorovně posune zpět do okna, když by přetekl
 * okraj — tlačítko může být kdekoli v posunuté horní liště. Používá CSS
 * `translate`, aby nekolidoval s `transform` z tříd.
 */
export function useKeepInViewport(ref: RefObject<HTMLElement | null>, active = true) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    element.style.translate = '';
    const rect = element.getBoundingClientRect();
    const right = window.innerWidth - EDGE;
    const shift = rect.left < EDGE
      ? EDGE - rect.left
      : rect.right > right ? Math.max(EDGE - rect.left, right - rect.right) : 0;
    if (shift) element.style.translate = `${Math.round(shift)}px 0`;
  }, [active, ref]);
}
