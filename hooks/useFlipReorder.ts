import { useEffect, useLayoutEffect, useRef } from 'react';

/** `useLayoutEffect` hlásí na serveru varování; testy renderují staticky. */
export const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const REORDER_MS = 420;
const EASING = 'cubic-bezier(.34, 1.3, .5, 1)';

/**
 * Plynulé přeskládání seznamu technikou FLIP.
 *
 * Když se pořadí změní (zapnutá skupina jde nahoru), React přepíše DOM skokem.
 * Hook si pamatuje, kde prvky byly, a po překreslení je nechá dojet z původní
 * pozice na novou — takže je vidět, co se kam přesunulo, místo bliknutí.
 *
 * Prvky se hledají podle `data-flip-id`; bez něj se přeskočí.
 *
 * `durationMs` zkracuje animaci tam, kde se přeskládává během tahu prstem —
 * 420 ms je na průběžné prohazování řádků příliš pomalé.
 *
 * `skipId` vynechá prvek, který si polohu řídí sám — typicky řádek držený
 * pod prstem při přetahování. Ten se posouvá vlastním `transform`, takže by
 * ho FLIP jinak animoval proti pohybu ruky.
 */
export function useFlipReorder(signature: string, selector = '[data-flip-id]', skipId?: string, durationMs = REORDER_MS): void {
  const positions = useRef(new Map<string, number>());
  const running = useRef(new Map<string, Animation>());

  useIsomorphicLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    for (const node of document.querySelectorAll<HTMLElement>(selector)) {
      const id = node.dataset.flipId;
      if (!id) continue;
      if (id === skipId) {
        // Poloha taženého řádku je posunutá o `transform`; uložit ji by po
        // puštění vyvolalo skok zpět. Radši na něj zapomeneme.
        positions.current.delete(id);
        running.current.get(id)?.cancel();
        running.current.delete(id);
        continue;
      }
      // Zrušit PŘED měřením: běžící animace posouvá prvek `transform`em, takže
      // by `getBoundingClientRect` vrátil místo, kde je zrovna vidět, ne kam
      // patří. Při rychlém tahu se tím do další animace zanesla chyba a řádky
      // poskakovaly. Po zrušení je rect zase skutečná poloha v layoutu.
      running.current.get(id)?.cancel();
      running.current.delete(id);
      const top = node.getBoundingClientRect().top;
      const previous = positions.current.get(id);
      // Posun pod jeden pixel je přepočet layoutu, ne přeskládání.
      if (!reduced && previous != null && Math.abs(previous - top) > 1
          && typeof node.animate === 'function') {
        running.current.set(id, node.animate(
          [{ transform: `translateY(${previous - top}px)` }, { transform: 'translateY(0)' }],
          { duration: durationMs, easing: EASING },
        ));
      }
      positions.current.set(id, top);
    }
  }, [durationMs, signature, selector, skipId]);
}
