import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { easeOutExpo, formatLike, sameShape, splitNumeric, type NumericParts } from '../lib/countUp';
import { whenFramesSettle } from '../lib/settledFrame';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * Číslo, které při zobrazení „dopočítá“ od nuly a při změně plynule navazuje
 * z předchozí hodnoty. První náběh čeká, až se stránka uklidní (jinak by
 * během načítání dashboardu trhal), a všechna čísla se rozjedou společně.
 * Snímky jdou přímo do textu (bez re-renderu Reactu).
 */
export default function CountUpNumber({ text, duration = 1400, className }: { text: string; duration?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shownRef = useRef<{ parts: NumericParts; value: number } | null>(null);
  const startedRef = useRef(false);
  const frameRef = useRef(0);
  const runRef = useRef(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const run = ++runRef.current;
    cancelAnimationFrame(frameRef.current);
    const target = splitNumeric(text);
    if (!target || reducedMotion()) {
      element.textContent = text;
      shownRef.current = target ? { parts: target, value: target.value } : null;
      startedRef.current = true;
      return;
    }
    const previous = shownRef.current;
    const animate = (from: number, ms: number) => {
      if (from === target.value) { element.textContent = text; shownRef.current = { parts: target, value: target.value }; return; }
      const started = performance.now();
      const tick = (now: number) => {
        if (runRef.current !== run) return;
        const progress = easeOutExpo((now - started) / ms);
        const value = from + (target.value - from) * progress;
        shownRef.current = { parts: target, value };
        element.textContent = progress >= 1 ? text : formatLike(value, target);
        if (progress < 1) frameRef.current = requestAnimationFrame(tick);
      };
      frameRef.current = requestAnimationFrame(tick);
      // Snímky neběží (přiškrcený panel) → po čase ukázat cílovou hodnotu, nikdy nezůstat na nule.
      window.setTimeout(() => {
        if (runRef.current !== run || element.textContent === text) return;
        cancelAnimationFrame(frameRef.current);
        element.textContent = text;
        shownRef.current = { parts: target, value: target.value };
      }, ms + 400);
    };
    if (startedRef.current) {
      // Změna hodnoty po náběhu: navázat z aktuálně zobrazené (stejný tvar), jinak skočit.
      if (previous && sameShape(previous.parts, target)) animate(previous.value, 900);
      else { element.textContent = text; shownRef.current = { parts: target, value: target.value }; }
      return;
    }
    // První náběh: ukázat nulu ve správném formátu a počkat na klidnou stránku.
    element.textContent = formatLike(0, target);
    shownRef.current = { parts: target, value: 0 };
    void whenFramesSettle().then(() => {
      if (runRef.current !== run) return;
      startedRef.current = true;
      animate(0, duration);
    });
  }, [duration, text]);

  useEffect(() => () => { runRef.current += 1; cancelAnimationFrame(frameRef.current); }, []);

  // Obsah spravuje efekt výše; čtečky obrazovky dostanou cílovou hodnotu.
  return <span ref={ref} className={className} aria-label={text} />;
}

/**
 * Náběh grafu KPI (otočení + zvětšení + zprůhlednění), spuštěný až na
 * uklidněné stránce přes Web Animations API — transform/opacity běží na
 * compositoru, takže jde plynule. Do té doby je graf skrytý.
 */
export function KpiChartEntrance({ variant, className, children }: { variant: 'gauge' | 'donut'; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || reducedMotion() || typeof element.animate !== 'function') return;
    let cancelled = false;
    element.style.opacity = '0';
    void whenFramesSettle().then(() => {
      if (cancelled) return;
      const keyframes = variant === 'gauge'
        ? [{ opacity: 0, transform: 'rotate(-40deg) scale(.82)' }, { opacity: 1, transform: 'none' }]
        : [{ opacity: 0, transform: 'rotate(-160deg) scale(.7)' }, { opacity: 1, transform: 'none' }];
      element.style.opacity = '';
      const duration = variant === 'gauge' ? 1100 : 1250;
      const animation = element.animate(keyframes, { duration, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' });
      // Animace stojí (přiškrcený panel) → zrušit, ať graf nezůstane neviditelný.
      window.setTimeout(() => { if (animation.playState !== 'finished') animation.cancel(); }, duration + 500);
    });
    return () => { cancelled = true; element.style.opacity = ''; };
  }, [variant]);
  return <div ref={ref} className={className} style={{ transformOrigin: variant === 'gauge' ? '50% 100%' : '50% 50%' }}>{children}</div>;
}
