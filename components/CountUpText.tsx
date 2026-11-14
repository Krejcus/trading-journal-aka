import { useEffect, useRef, useState } from 'react';
import { easeOutCubic, formatNumericText, parseNumericText } from '../lib/countUp';

const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Text s číslem, které při prvním zobrazení a při každé změně plynule doběhne
 * na novou hodnotu. Po doběhnutí je vidět přesně `text`; text bez čísla
 * („∞“, „—“) se jen vypíše.
 */
export default function CountUpText({ text, duration = 520 }: { text: string; duration?: number }) {
  const [shown, setShown] = useState(() => {
    const shape = parseNumericText(text);
    return shape && !reducedMotion() ? formatNumericText(shape, 0) : text;
  });
  const previous = useRef(0);

  useEffect(() => {
    const shape = parseNumericText(text);
    if (!shape || reducedMotion() || typeof requestAnimationFrame !== 'function') { previous.current = shape?.value ?? 0; setShown(text); return; }
    const from = previous.current, to = shape.value;
    previous.current = to;
    if (from === to) { setShown(text); return; }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = (now - start) / duration;
      if (progress >= 1) { setShown(text); return; }
      setShown(formatNumericText(shape, from + (to - from) * easeOutCubic(progress)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); setShown(text); };
  }, [text, duration]);

  return <>{shown}</>;
}
