import type { ChartViewApi } from '@getcandlekit/charts/react';
import { crossfadeChart } from './chartCrossfade';

export type GoToMotionPreset = 'original' | 'fade' | 'glide' | 'zoom' | 'timeline';
export interface GoToMotionOptions { preset: GoToMotionPreset; durationMs: number }
const defaults: GoToMotionOptions = { preset: 'glide', durationMs: 560 };
let options = { ...defaults };
/** A presentation preference only. This never changes the replay cursor or bars. */
export function configureGoToMotion(next: Partial<GoToMotionOptions>): void {
  const allowed: GoToMotionPreset[] = ['original', 'fade', 'glide', 'zoom', 'timeline'];
  options = {
    preset: next.preset && allowed.includes(next.preset) ? next.preset : options.preset,
    durationMs: next.durationMs === undefined || !Number.isFinite(next.durationMs) ? options.durationMs : Math.min(1200, Math.max(240, next.durationMs)),
  };
}
interface Panel { area: HTMLElement | null; api: ChartViewApi | null }
interface Jump { forward: boolean; fromLabel: string; toLabel: string; isDark: boolean; animateOriginal?: boolean }
const active = new WeakMap<HTMLElement, () => void>();

/** Freeze actual chart pixels, let the existing Go To update the real chart,
 * then reveal it. Intermediate candles/prices are never fabricated. */
export function animateChartGoTo(host: HTMLElement | null, panels: readonly Panel[], jump: Jump): void {
  if (!host) return;
  active.get(host)?.();
  if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const selected = { ...options };
  if (selected.preset === 'original') {
    if (jump.animateOriginal === false) return;
    panels.forEach(({ area, api }) => crossfadeChart(area, api, { slideX: jump.forward ? -36 : 36, holdMs: 60 }));
    return;
  }
  const frames: HTMLElement[] = [];
  const animations: Animation[] = [];
  const timers: number[] = [];
  let disposed = false;
  const clean = () => {
    if (disposed) return;
    disposed = true;
    animations.forEach(animation => animation.cancel());
    timers.forEach(timer => window.clearTimeout(timer));
    frames.forEach(frame => frame.remove());
    if (active.get(host) === clean) active.delete(host);
  };
  active.set(host, clean);
  const color = jump.isDark ? '#e4e9f4' : '#27324b';
  const surface = jump.isDark ? 'rgba(15,21,34,.94)' : 'rgba(255,255,255,.96)';
  const accent = jump.isDark ? '#baa8ff' : '#7254cb';
  const direction = jump.forward ? -1 : 1;
  const duration = selected.durationMs;
  const animate = (element: HTMLElement, keyframes: Keyframe[], settings: KeyframeAnimationOptions = {}) => {
    if (disposed || typeof element.animate !== 'function') return;
    const animation = element.animate(keyframes, { duration, easing: 'cubic-bezier(.22,.68,.16,1)', fill: 'both', ...settings });
    animations.push(animation);
  };
  let snapshots = 0;
  panels.forEach(({ area, api }) => {
    if (!area?.isConnected || !api) return;
    try {
      const chart = api.controller.getChart();
      const oldShot = chart.takeScreenshot(true, false);
      const chartRect = chart.chartElement().getBoundingClientRect();
      const areaRect = area.getBoundingClientRect();
      if (chartRect.width <= 0 || chartRect.height <= 0) return;
      const frame = document.createElement('div');
      frame.dataset.gotoMotion = selected.preset;
      frame.dataset.snapshotHide = '';
      frame.setAttribute('aria-hidden', 'true');
      Object.assign(frame.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: '40', contain: 'paint' });
      const shotStyle = { position: 'absolute', left: `${chartRect.left - areaRect.left}px`, top: `${chartRect.top - areaRect.top}px`, width: `${chartRect.width}px`, height: `${chartRect.height}px`, transformOrigin: '50% 50%', willChange: 'transform,opacity', pointerEvents: 'none' };
      Object.assign(oldShot.style, shotStyle, { zIndex: '2' });
      frame.append(oldShot); area.append(frame); frames.push(frame); snapshots++;
      // Existing Go To has already ensured the required data before this call.
      // A short hold lets React/CandleKit commit the prepared target underneath.
      const hold = 100;
      timers.push(window.setTimeout(() => {
        if (disposed || !area.isConnected) { clean(); return; }
        try {
          if (selected.preset === 'glide' || selected.preset === 'zoom') {
            const nextShot = chart.takeScreenshot(true, false);
            Object.assign(nextShot.style, shotStyle, { zIndex: '1' });
            frame.prepend(nextShot);
            if (selected.preset === 'glide') animate(nextShot, [
              { opacity: .4, transform: `translateX(${-direction * 36}px)` },
              { opacity: 1, transform: 'translateX(0)' },
            ]);
            else animate(nextShot, [
              { opacity: .1, transform: 'scale(1.055)', filter: 'blur(1.4px)' },
              { opacity: 1, transform: 'scale(1)', filter: 'blur(0)' },
            ]);
          }
        } catch { /* The real updated chart remains underneath. */ }
        if (selected.preset === 'fade') animate(oldShot, [{ opacity: 1 }, { opacity: 0 }]);
        if (selected.preset === 'glide') animate(oldShot, [
          { opacity: 1, transform: 'translateX(0)' },
          { opacity: 0, transform: `translateX(${direction * 72}px)` },
        ]);
        if (selected.preset === 'zoom') animate(oldShot, [
          { opacity: 1, transform: 'scale(1)', filter: 'blur(0)' },
          { opacity: 0, transform: 'scale(.95)', filter: 'blur(1.4px)' },
        ]);
        if (selected.preset === 'timeline') animate(oldShot, [
          { opacity: 1, offset: 0 }, { opacity: 1, offset: .24 },
          { opacity: 0, transform: `translateX(${direction * 18}px)`, offset: 1 },
        ]);
      }, hold));
    } catch { /* A destroyed chart should never prevent navigation. */ }
  });
  if (!snapshots) { clean(); return; }
  const badge = document.createElement('div');
  badge.dataset.gotoMotionLabel = selected.preset;
  badge.dataset.snapshotHide = '';
  badge.setAttribute('aria-hidden', 'true');
  Object.assign(badge.style, { position: 'absolute', left: '50%', top: selected.preset === 'timeline' ? '44%' : '65px', transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: '75', border: `1px solid ${jump.isDark ? '#ffffff22' : '#a2aec938'}`, borderRadius: '12px', padding: selected.preset === 'timeline' ? '17px 25px' : '9px 15px', background: surface, color, boxShadow: '0 8px 30px rgba(15,23,42,.10)', textAlign: 'center', whiteSpace: 'nowrap', maxWidth: 'calc(100% - 24px)', fontFamily: 'Inter,system-ui,sans-serif' });
  if (selected.preset === 'timeline') {
    const title = document.createElement('div'); title.textContent = 'PŘESUN V ČASE';
    Object.assign(title.style, { fontSize: '9px', fontWeight: '700', letterSpacing: '1.8px', color: accent, marginBottom: '9px' });
    const line = document.createElement('div'); Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '14px', fontSize: '12px', fontWeight: '600' });
    const from = document.createElement('span'); from.textContent = jump.fromLabel; from.style.opacity = '.5';
    const arrow = document.createElement('span'); arrow.textContent = jump.forward ? '→' : '←'; arrow.style.color = accent;
    const to = document.createElement('span'); to.textContent = jump.toLabel;
    line.append(from, arrow, to);
    const track = document.createElement('div'); Object.assign(track.style, { height: '2px', background: `${accent}22`, borderRadius: '3px', marginTop: '14px', overflow: 'hidden' });
    const fill = document.createElement('i'); Object.assign(fill.style, { display: 'block', width: '100%', height: '100%', background: accent, transformOrigin: jump.forward ? 'left' : 'right' });
    track.append(fill); badge.append(title, line, track);
    animate(fill, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { delay: 60, duration: duration * .72 });
  } else {
    const mark = document.createElement('span'); mark.textContent = '↳'; Object.assign(mark.style, { color: accent, marginRight: '8px' });
    const label = document.createElement('span'); label.textContent = jump.toLabel; Object.assign(label.style, { fontSize: '11px', fontWeight: '650', letterSpacing: '.1px' });
    badge.append(mark, label);
  }
  host.append(badge); frames.push(badge);
  animate(badge, [
    { opacity: 0, transform: 'translate(-50%,5px)', offset: 0 },
    { opacity: 1, transform: 'translate(-50%,0)', offset: .18 },
    { opacity: 1, transform: 'translate(-50%,0)', offset: .76 },
    { opacity: 0, transform: 'translate(-50%,-4px)', offset: 1 },
  ], { duration: duration + 260 });
  timers.push(window.setTimeout(clean, duration + 380));
}
