import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { easeOutCubic, formatLike, sameShape, splitNumeric, type NumericParts } from '../lib/countUp';

/**
 * Číslo, které při zobrazení „dopočítá“ ze nuly a při změně plynule navazuje
 * z předchozí hodnoty. Snímky jdou přímo do textu (bez re-renderu Reactu),
 * takže nezatěžují dashboard. Bez animace při `prefers-reduced-motion`.
 */
export default function CountUpNumber({ text, duration = 900, className }: { text: string; duration?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shownRef = useRef<{ parts: NumericParts; value: number } | null>(null);
  const frameRef = useRef(0);

  // Před prvním vykreslením nastavit výchozí stav (0), ať číslo nebliká na cílové hodnotě.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const target = splitNumeric(text);
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const previous = shownRef.current;
    cancelAnimationFrame(frameRef.current);
    if (!target || reduce) {
      element.textContent = text;
      shownRef.current = target ? { parts: target, value: target.value } : null;
      return;
    }
    // Navázat z předchozí hodnoty, jen když má číslo stejný tvar; jinak od nuly.
    const from = previous && sameShape(previous.parts, target) ? previous.value : previous ? target.value : 0;
    if (from === target.value) {
      element.textContent = text;
      shownRef.current = { parts: target, value: target.value };
      return;
    }
    element.textContent = formatLike(from, target);
    const started = performance.now();
    const tick = (now: number) => {
      const progress = easeOutCubic((now - started) / duration);
      const value = from + (target.value - from) * progress;
      shownRef.current = { parts: target, value };
      element.textContent = progress >= 1 ? text : formatLike(value, target);
      if (progress < 1) frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [duration, text]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  // Obsah spravuje efekt výše; čtečky obrazovky dostanou cílovou hodnotu.
  return <span ref={ref} className={className} aria-label={text} />;
}
