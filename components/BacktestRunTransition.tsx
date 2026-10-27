import React, { useLayoutEffect, useRef, useState } from 'react';

/**
 * Otevření a zavření backtest session: z karty session se rozvine plocha
 * grafu přes celou obrazovku a graf se do ní prolne; při zavření se graf
 * rozplyne a plocha se složí zpět do karty.
 *
 * Animují se jen `transform` a `opacity` — ty kreslí kompozitor i ve chvíli,
 * kdy hlavní vlákno zrovna připojuje workspace (graf, data). Animace
 * `clip-path` se tím sekala (snímky 100–300 ms, změřeno 27. 10. 2026).
 * Obal má pozici a z-index jen po dobu animace, takže vrstvy workspace
 * (z-300 až z-700) potom stojí přesně jako dřív.
 */

export interface TransitionRect { top: number; left: number; width: number; height: number }

const OPEN_MS = 460;
const CLOSE_MS = 380;
const EASE_OPEN = 'cubic-bezier(0.32, 0.72, 0, 1)';
const EASE_CLOSE = 'cubic-bezier(0.4, 0, 0.2, 1)';
/** Jak dlouho karta po návratu grafu svítí (`[data-landed]` v index.css). */
const LANDED_MS = 900;

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

/** Bez karty (nová session, karta mimo obrazovku): z prostředku. */
const fallbackRect = (): TransitionRect => {
  const width = window.innerWidth * 0.62;
  const height = window.innerHeight * 0.62;
  return { left: (window.innerWidth - width) / 2, top: (window.innerHeight - height) / 2, width, height };
};

/** Plocha přes celé okno (`transform-origin: 0 0`) zmenšená na obdélník karty. */
export const transitionTransform = (rect: TransitionRect, viewport: { width: number; height: number }): string => {
  const scaleX = Math.max(0.01, rect.width / viewport.width);
  const scaleY = Math.max(0.01, rect.height / viewport.height);
  return `translate(${rect.left}px, ${rect.top}px) scale(${scaleX}, ${scaleY})`;
};

const IDENTITY = 'translate(0px, 0px) scale(1, 1)';

/** Karta session v seznamu, pokud je aspoň částečně vidět. */
const visibleCardRect = (card: HTMLElement | null): TransitionRect | null => {
  if (!card) return null;
  const rect = card.getBoundingClientRect();
  if (rect.width < 40 || rect.bottom < 0 || rect.top > window.innerHeight) return null;
  return rect;
};

export function BacktestRunTransition({ runId, origin, closing, isDark, onClosed, children }: {
  runId: string;
  /** Karta, ze které se session otevřela. */
  origin: TransitionRect | null;
  closing: boolean;
  isDark: boolean;
  onClosed: () => void;
  children: React.ReactNode;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [opening, setOpening] = useState(() => !reducedMotion());
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const content = contentRef.current;
    if (!surface || !content || !opening) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const surfaceAnimation = surface.animate([
      { transform: transitionTransform(origin ?? fallbackRect(), viewport), opacity: 0.6 },
      { opacity: 1, offset: 0.25 },
      { transform: IDENTITY, opacity: 1 },
    ], { duration: OPEN_MS, easing: EASE_OPEN });
    // Graf (nebo načítací obrazovka) se prolne, až je plocha skoro rozvinutá.
    const contentAnimation = content.animate([
      { opacity: 0 },
      { opacity: 0, offset: 0.4 },
      { opacity: 1 },
    ], { duration: OPEN_MS, easing: 'ease-out' });
    contentAnimation.onfinish = () => setOpening(false);
    // Zrušení při úklidu efektu (StrictMode ho v dev spustí dvakrát) nesmí
    // ukončit „otevírání“ — obal by uprostřed animace ztratil vrstvu z-300.
    return () => {
      contentAnimation.onfinish = null;
      surfaceAnimation.cancel();
      contentAnimation.cancel();
    };
    // Jen při vzniku: karta, ze které se otevíralo, se později nemění.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (!closing) return;
    const surface = surfaceRef.current;
    const content = contentRef.current;
    const card = document.querySelector<HTMLElement>(`[data-backtest-run-card="${CSS.escape(runId)}"]`);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (card) {
        card.dataset.landed = 'true';
        window.setTimeout(() => { delete card.dataset.landed; }, LANDED_MS);
      }
      onClosedRef.current();
    };
    if (!surface || !content || reducedMotion()) {
      finish();
      return;
    }
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    content.animate([{ opacity: 1 }, { opacity: 0, offset: 0.35 }, { opacity: 0 }], { duration: CLOSE_MS, easing: 'ease-in', fill: 'forwards' });
    const surfaceAnimation = surface.animate([
      { transform: IDENTITY, opacity: 1 },
      { opacity: 1, offset: 0.7 },
      { transform: transitionTransform(visibleCardRect(card) ?? fallbackRect(), viewport), opacity: 0 },
    ], { duration: CLOSE_MS, easing: EASE_CLOSE, fill: 'forwards' });
    surfaceAnimation.onfinish = finish;
    // Zrušená animace nesmí nechat session viset otevřenou.
    surfaceAnimation.oncancel = finish;
  }, [closing, runId]);

  const moving = opening || closing;
  return (
    <div
      data-backtest-transition={closing ? 'closing' : opening ? 'opening' : 'open'}
      className={moving ? 'fixed inset-0 z-[300]' : undefined}
      style={closing ? { pointerEvents: 'none' } : undefined}
      // Při zavírání se už nic neovládá — graf jen odjíždí do karty.
      inert={closing}
    >
      {/* Plocha v barvě grafu: rozvine se z karty a pak zůstává pod grafem
          jako podklad (dokud se workspace načítá, je vidět aspoň ona). */}
      <div
        ref={surfaceRef}
        aria-hidden
        className={`fixed inset-0 z-[299] origin-top-left ${isDark ? 'bg-[#070a0f]' : 'bg-[#f4f6f8]'} ${moving ? 'bt-run-surface--moving' : ''}`}
      />
      <div ref={contentRef} className={moving ? 'relative z-[300]' : undefined}>
        {children}
      </div>
    </div>
  );
}
