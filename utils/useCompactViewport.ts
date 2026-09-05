import { useEffect, useState } from 'react';

/**
 * `true` pod Tailwind breakpointem `lg` (1024 px) — telefon a úzký tablet.
 * Mimo prohlížeč (SSR, testy přes renderToStaticMarkup) je vždy `false`,
 * takže existující desktopové snapshoty se nemění.
 */
const COMPACT_QUERY = '(max-width: 1023px)';

const matches = (): boolean =>
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia(COMPACT_QUERY).matches;

export function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(matches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(COMPACT_QUERY);
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}
