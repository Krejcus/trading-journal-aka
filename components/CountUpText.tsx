import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { easeOutCubic, formatNumericText, parseNumericText } from '../lib/countUp';

/**
 * „Stránka je usazená, pohyb může začít.“ Dashboard ho zapne, až doběhne
 * první těžké vykreslení — jinak by animace proběhly během záseku a nebyly vidět.
 * Mimo dashboard je výchozí hodnota true (animuje se hned).
 */
export const MotionReadyContext = createContext(true);

const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Text s číslem, které při prvním zobrazení a při každé změně plynule doběhne
 * na novou hodnotu. Po doběhnutí je vidět přesně `text`; text bez čísla
 * („∞“, „—“) se jen vypíše. `delay` platí jen pro první náběh od nuly —
 * karta se mezitím stihne vynořit, takže je dopočet vidět.
 */
export default function CountUpText({ text, duration = 900, delay = 250 }: { text: string; duration?: number; delay?: number }) {
  const [shown, setShown] = useState(() => {
    const shape = parseNumericText(text);
    return shape && !reducedMotion() ? formatNumericText(shape, 0) : text;
  });
  // Hodnota, která je právě vidět — z ní začíná další doběhnutí (i když se předchozí přerušilo).
  const visible = useRef(0);
  const ready = useContext(MotionReadyContext);

  useEffect(() => {
    if (!ready) return;
    const shape = parseNumericText(text);
    if (!shape || reducedMotion() || typeof requestAnimationFrame !== 'function') { visible.current = shape?.value ?? 0; setShown(text); return; }
    const from = visible.current, to = shape.value;
    if (from === to) { setShown(text); return; }
    const wait = from === 0 ? delay : 0;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = (now - start - wait) / duration;
      if (progress >= 1) { visible.current = to; setShown(text); return; }
      const value = progress <= 0 ? from : from + (to - from) * easeOutCubic(progress);
      visible.current = value;
      setShown(formatNumericText(shape, value));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, duration, delay, ready]);

  return <>{shown}</>;
}
