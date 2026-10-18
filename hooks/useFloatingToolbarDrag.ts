import React, { useEffect, useRef, useState } from 'react';

/**
 * Přetahování plovoucí lišty kresby za úchyt v rámci jejího offsetParent —
 * stejné chování jako lišty Fibonacci a ostatních kreseb. Dokud se netáhne,
 * `position` je null a lišta zůstává na výchozím místě (z tříd).
 */
export function useFloatingToolbarDrag<T extends HTMLElement>() {
  const toolbarRef = useRef<T>(null);
  const dragRef = useRef<{
    pointerX: number;
    pointerY: number;
    left: number;
    top: number;
    maxLeft: number;
    maxTop: number;
  } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      setPosition({
        left: Math.max(4, Math.min(drag.maxLeft, drag.left + event.clientX - drag.pointerX)),
        top: Math.max(4, Math.min(drag.maxTop, drag.top + event.clientY - drag.pointerY)),
      });
    };
    const stop = () => { dragRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    const toolbar = toolbarRef.current;
    const parent = toolbar?.offsetParent as HTMLElement | null;
    if (!toolbar || !parent) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = toolbar.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const left = rect.left - parentRect.left;
    const top = rect.top - parentRect.top;
    setPosition({ left, top });
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left,
      top,
      maxLeft: Math.max(4, parent.clientWidth - rect.width - 4),
      maxTop: Math.max(4, parent.clientHeight - rect.height - 4),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  return { toolbarRef, position, startDrag };
}
