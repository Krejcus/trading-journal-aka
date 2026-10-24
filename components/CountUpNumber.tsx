import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { easeOutExpo, formatLike, nearStart, sameShape, splitNumeric, type NumericParts } from '../lib/countUp';
import { whenFramesSettle } from '../lib/settledFrame';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * Číslo, které při zobrazení dopočítá poslední číslice a při změně plynule navazuje
 * z předchozí hodnoty. První náběh čeká, až se stránka uklidní (jinak by
 * během načítání dashboardu trhal), a všechna čísla se rozjedou společně.
 * Snímky jdou přímo do textu (bez re-renderu Reactu).
 */
export default function CountUpNumber({ text, duration = 950, className }: { text: string; duration?: number; className?: string }) {
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
    // První náběh: dopočítají se jen poslední číslice (4 168 → 4 268), až na klidné stránce.
    const from = nearStart(target);
    element.textContent = formatLike(from, target);
    shownRef.current = { parts: target, value: from };
    void whenFramesSettle().then(() => {
      if (runRef.current !== run) return;
      startedRef.current = true;
      animate(from, duration);
    });
  }, [duration, text]);

  useEffect(() => () => { runRef.current += 1; cancelAnimationFrame(frameRef.current); }, []);

  // Obsah spravuje efekt výše; čtečky obrazovky dostanou cílovou hodnotu.
  return <span ref={ref} className={className} aria-label={text} />;
}

let sweepRegistered: boolean | null = null;
/** Animovatelný úhel pro masku (CSS @property); bez podpory → jen prolnutí. */
function registerSweep(): boolean {
  if (sweepRegistered != null) return sweepRegistered;
  try {
    (CSS as unknown as { registerProperty(definition: object): void }).registerProperty({ name: '--kpi-sweep', syntax: '<angle>', inherits: false, initialValue: '360deg' });
    sweepRegistered = true;
  } catch (error) {
    // Už registrováno (HMR) je v pořádku.
    sweepRegistered = error instanceof DOMException && error.name === 'InvalidModificationError';
  }
  return sweepRegistered;
}

/**
 * Náběh grafu KPI jako skutečné vykreslení oblouku: maska z conic-gradientu
 * odkrývá stávající graf zleva doprava (půlkruh) nebo dokola (kroužek).
 * Graf, tooltipy i zvýraznění zůstávají. Spouští se až na uklidněné stránce;
 * když snímky neběží, graf se ukáže celý.
 */
export function KpiChartEntrance({ variant, className, children }: { variant: 'gauge' | 'donut'; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || reducedMotion() || typeof element.animate !== 'function') return;
    const sweep = registerSweep();
    let cancelled = false;
    if (sweep) {
      const mask = variant === 'gauge'
        ? 'conic-gradient(from 270deg at 50% 100%, #000 calc(var(--kpi-sweep) - 6deg), transparent var(--kpi-sweep))'
        : 'conic-gradient(from 0deg at 50% 50%, #000 calc(var(--kpi-sweep) - 8deg), transparent var(--kpi-sweep))';
      element.style.setProperty('--kpi-sweep', '0deg');
      element.style.webkitMaskImage = mask;
      element.style.maskImage = mask;
    } else {
      element.style.opacity = '0';
    }
    const reset = () => {
      element.style.removeProperty('--kpi-sweep');
      element.style.webkitMaskImage = '';
      element.style.maskImage = '';
      element.style.opacity = '';
    };
    void whenFramesSettle().then(() => {
      if (cancelled) return;
      const duration = variant === 'gauge' ? 1000 : 1200;
      const animation = sweep
        // +6/8° navíc, ať měkká hrana masky na konci zmizí.
        ? element.animate([{ '--kpi-sweep': '0deg' }, { '--kpi-sweep': variant === 'gauge' ? '186deg' : '368deg' }] as Keyframe[], { duration, easing: 'cubic-bezier(.33, 1, .68, 1)', fill: 'forwards' })
        : element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, fill: 'forwards' });
      const done = () => { if (!cancelled) { animation.cancel(); reset(); } };
      animation.finished.then(done, () => {});
      // Animace stojí (přiškrcený panel) → ukázat graf celý.
      window.setTimeout(() => { if (animation.playState !== 'finished') done(); }, duration + 500);
    });
    return () => { cancelled = true; reset(); };
  }, [variant]);
  return <div ref={ref} className={className}>{children}</div>;
}
