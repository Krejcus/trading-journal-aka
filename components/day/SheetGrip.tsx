import React, { useRef } from 'react';

const CLOSE_DISTANCE = 80;
const FLICK_SPEED = 0.6; // px/ms

/**
 * Úchyt spodního listu jako na iOS: list jede s prstem dolů, po stažení
 * (nebo rychlém švihnutí) odjede a zavře se, jinak se vrátí. Posouvá
 * nejbližší `<section>` přímo přes DOM, takže list nepotřebuje vlastní stav.
 */
export default function SheetGrip({ onClose, gap = 8 }: { onClose: () => void; gap?: number }) {
  const drag = useRef<{ y0: number; t0: number; sheet: HTMLElement; backdrop: HTMLElement | null; dy: number } | null>(null);
  const move = (dy: number) => {
    const current = drag.current;
    if (!current) return;
    current.dy = Math.max(0, dy);
    current.sheet.style.transform = `translateY(${current.dy}px)`;
    if (current.backdrop) current.backdrop.style.opacity = String(Math.max(0.25, 1 - current.dy / Math.max(1, current.sheet.offsetHeight)));
  };
  const finish = (close: boolean) => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    const { sheet, backdrop, dy } = current;
    const reset = () => {
      sheet.style.transform = '';
      sheet.style.transition = '';
      if (backdrop) { backdrop.style.opacity = ''; backdrop.style.transition = ''; }
    };
    if (close) {
      sheet.style.transition = 'transform .2s cubic-bezier(.4,0,1,1)';
      sheet.style.transform = `translateY(${Math.max(dy, sheet.offsetHeight)}px)`;
      if (backdrop) { backdrop.style.transition = 'opacity .2s ease'; backdrop.style.opacity = '0'; }
      window.setTimeout(onClose, 190);
      return;
    }
    sheet.style.transition = 'transform .24s cubic-bezier(.2,.9,.25,1)';
    sheet.style.transform = 'translateY(0)';
    if (backdrop) { backdrop.style.transition = 'opacity .24s ease'; backdrop.style.opacity = ''; }
    window.setTimeout(reset, 260);
  };
  return (
    <div
      aria-hidden="true"
      data-sheet-grip
      onPointerDown={event => {
        const sheet = event.currentTarget.closest('section');
        if (!(sheet instanceof HTMLElement)) return;
        // Úvodní animace (fill „both“) by jinak přebila posun za prstem.
        sheet.style.animation = 'none';
        sheet.style.transition = 'none';
        const backdrop = sheet.previousElementSibling instanceof HTMLElement ? sheet.previousElementSibling : null;
        drag.current = { y0: event.clientY, t0: performance.now(), sheet, backdrop, dy: 0 };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* syntetická událost */ }
      }}
      onPointerMove={event => { if (drag.current) move(event.clientY - drag.current.y0); }}
      onPointerUp={event => {
        const current = drag.current;
        if (!current) return;
        const dy = event.clientY - current.y0;
        const speed = dy / Math.max(1, performance.now() - current.t0);
        finish(dy > CLOSE_DISTANCE || (dy > 24 && speed > FLICK_SPEED));
      }}
      onPointerCancel={() => finish(false)}
      style={{ display: 'grid', placeItems: 'center', height: 22, margin: `-6px 0 ${gap - 4}px`, touchAction: 'none', cursor: 'grab' }}
    >
      <span style={{ width: 38, height: 5, borderRadius: 3, background: 'var(--dj-line)', filter: 'brightness(2.2)' }} />
    </div>
  );
}
