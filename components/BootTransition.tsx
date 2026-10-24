import React, { useLayoutEffect, useRef } from 'react';
import { whenFramesSettle } from '../lib/settledFrame';

/**
 * Přechod z načítání do appky (jen při startu dokumentu): točící se logo
 * se dotočí, přeletí do loga v horní liště vedle názvu stránky a appka se
 * kolem něj složí — lišta shora, sidebar zleva, obsah a widgety odspodu.
 *
 * Jen transform/opacity přes Web Animations (compositor). Prvky appky jsou
 * do svého náběhu skryté přes `html.boot-pre [data-boot]` (jen opacity, bez
 * posunu — poloha cíle loga se tak dá změřit přesně). Bez cíle (telefon,
 * deník bez lišty) logo jen zmizí. Pojistky zajistí, že appka bude vidět,
 * i když snímky neběží.
 */

const SPIN_MS = 2000;
const EASE_OUT = 'cubic-bezier(.16, 1, .3, 1)';
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

function visibleTarget(selector: string): HTMLElement | null {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  // Lišta odjetá nahoru (deník bez lišty) nebo skrytá = bez letu.
  return rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight ? element : null;
}

export default function BootTransition({ allowFlight, transparent = false, onDone }: { allowFlight: boolean; transparent?: boolean; onDone: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const pulseRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLImageElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useLayoutEffect(() => {
    const root = document.documentElement;
    const overlay = overlayRef.current;
    const pulseEl = pulseRef.current;
    const logo = logoRef.current;
    if (!overlay || !pulseEl || !logo) return;
    let cancelled = false;
    const extras: Animation[] = [];
    const entrances: Animation[] = [];
    const cleanups: Array<() => void> = [];
    const finish = () => {
      if (cancelled) return;
      cancelled = true;
      root.classList.remove('boot-pre');
      cleanups.forEach(run => run());
      doneRef.current();
    };

    if (reducedMotion() || typeof logo.animate !== 'function') {
      root.classList.remove('boot-pre');
      const fade = overlay.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' });
      const timer = window.setTimeout(finish, 200);
      return () => { cancelled = true; window.clearTimeout(timer); fade?.cancel(); };
    }

    root.classList.add('boot-pre');
    // Stejná fáze jako logo v načítání (hodiny dokumentu) — žádné cuknutí při předání.
    const pulse = pulseEl.animate([{ opacity: 1 }, { opacity: 0.5 }, { opacity: 1 }], { duration: SPIN_MS, iterations: Infinity, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' });
    const spin = logo.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: SPIN_MS, iterations: Infinity });
    pulse.startTime = 0;
    spin.startTime = 0;

    // Pojistka: ať se cokoli zasekne, appka je do 6 s vidět.
    const safety = window.setTimeout(() => {
      overlay.style.display = 'none';
      entrances.forEach(animation => animation.cancel());
      finish();
    }, 6_000);
    cleanups.push(() => window.clearTimeout(safety));

    const enter = (element: Element | null, from: Keyframe, delay: number, duration = 620) => {
      if (!(element instanceof HTMLElement)) return;
      const animation = element.animate([{ ...from, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration, delay, easing: EASE_OUT, fill: 'backwards' });
      entrances.push(animation);
    };

    void (async () => {
      // Logo se točí, dokud se appka pod ním nedokreslí.
      await whenFramesSettle();
      if (cancelled) return;
      // Dotočit do svislé polohy.
      const angle = (((spin.currentTime as number | null) ?? 0) % SPIN_MS) / SPIN_MS * 360;
      spin.cancel();
      pulse.cancel();
      const settle = logo.animate([{ transform: `rotate(${angle}deg)` }, { transform: 'rotate(360deg)' }], { duration: Math.max(200, (360 - angle) * 1.3), easing: 'cubic-bezier(.2, .8, .3, 1)', fill: 'forwards' });
      extras.push(settle);
      await Promise.race([settle.finished.catch(() => undefined), new Promise(resolve => window.setTimeout(resolve, 900))]);
      if (cancelled) return;

      const target = allowFlight ? visibleTarget('[data-boot-logo-target]') : null;
      // Všechny náběhy naplánované najednou se zpožděním (fill: backwards drží
      // prvek skrytý až do jeho startu), pak hned pryč s boot-pre.
      const lead = target ? 760 : 220;
      const fadeOverlay = overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: target ? 520 : 420, delay: target ? 120 : 0, easing: 'ease', fill: 'forwards' });
      extras.push(fadeOverlay);
      let fly: HTMLImageElement | null = null;
      let flight: Animation | null = null;
      if (target) {
        // Cíl změřen bez posunu (boot-pre skrývá jen průhledností).
        const from = logo.getBoundingClientRect();
        const to = target.getBoundingClientRect();
        target.style.opacity = '0';
        fly = logo.cloneNode() as HTMLImageElement;
        Object.assign(fly.style, {
          position: 'fixed', left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`,
          margin: '0', objectFit: 'contain', transformOrigin: '0 0', zIndex: '10001', pointerEvents: 'none', transform: 'none', visibility: 'visible',
        });
        document.body.appendChild(fly);
        logo.style.visibility = 'hidden';
        const flyEl = fly;
        cleanups.push(() => { flyEl.remove(); target.style.opacity = ''; });
        const dx = to.left - from.left;
        const dy = to.top - from.top;
        const scale = to.width / from.width;
        flight = fly.animate([
          { transform: 'translate(0, 0) scale(1)' },
          { transform: `translate(${dx * 0.92}px, ${dy * 0.92}px) scale(${scale * 1.12})`, offset: 0.82 },
          { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
        ], { duration: 820, easing: 'cubic-bezier(.65, 0, .25, 1)', fill: 'forwards' });
        extras.push(flight);
      } else {
        extras.push(logo.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9)' }], { duration: 320, fill: 'forwards' }));
      }
      // Lišta přijede první (logo do ní dosedne), pak sidebar, obsah a widgety.
      enter(document.querySelector('[data-boot="header"]'), { transform: 'translateY(-26px)' }, 60, 560);
      enter(document.querySelector('[data-boot="sidebar"]'), { transform: 'translateX(-36px)' }, lead);
      enter(document.querySelector('[data-boot="content"]'), { transform: 'translateY(14px)' }, lead + 40, 560);
      const widgets = [...document.querySelectorAll('[data-boot="content"] .react-grid-item > *')].slice(0, 14);
      widgets.forEach((widget, index) => enter(widget, { transform: 'translateY(22px) scale(.98)' }, lead + 90 + index * 45, 600));
      root.classList.remove('boot-pre');

      if (flight && fly && target) {
        await Promise.race([flight.finished.catch(() => undefined), new Promise(resolve => window.setTimeout(resolve, 1_400))]);
        if (cancelled) return;
        // Dosednutí: logo v liště převezme štafetu s malým „cvaknutím“.
        target.style.opacity = '';
        fly.remove();
        target.animate([{ transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(.3, 1.6, .5, 1)' });
      }
      const lastStart = lead + 90 + Math.max(0, widgets.length - 1) * 45 + 650;
      window.setTimeout(() => {
        // Nedoběhlé náběhy (snímky neběží) zrušit, ať je appka vidět; překryv už je pryč.
        overlay.style.display = 'none';
        entrances.forEach(animation => { if (animation.playState !== 'finished') animation.cancel(); });
        finish();
      }, Math.max(300, lastStart - (target ? 820 : 0)));
    })();

    return () => {
      cancelled = true;
      spin.cancel();
      pulse.cancel();
      extras.forEach(animation => animation.cancel());
      entrances.forEach(animation => animation.cancel());
      cleanups.forEach(run => run());
      root.classList.remove('boot-pre');
    };
  }, [allowFlight]);

  return (
    <div ref={overlayRef} aria-hidden="true" className="fixed inset-0 z-[10000] flex items-center justify-center pointer-events-none" style={{ background: transparent ? 'transparent' : 'var(--bg-page)' }}>
      <div ref={pulseRef} style={{ width: 128, height: 128 }}>
        <img ref={logoRef} src="/logos/at_logo_light_clean.png" alt="" className="w-full h-full object-contain" />
      </div>
    </div>
  );
}
