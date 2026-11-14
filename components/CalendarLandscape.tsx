import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

export interface LandscapeDay {
  key: string;
  dayNum: number;
  /** null = den bez obchodů (jen dlaždice), jinak sloupec. */
  bar: { positive: boolean; /** 0–1 podle velikosti výsledku */ size: number; title: string } | null;
  /** Den ze sousedního měsíce — tlumený, bez sloupce. */
  dim?: boolean;
  onOpen?: () => void;
}

const START = { x: 56, z: -26 };

/**
 * Kalendář jako „krajina měsíce“: každý obchodní den je sloupec, jehož výška
 * odpovídá velikosti výsledku (zelený zisk, červená ztráta). Tažením myší se
 * otáčí. Jen jiný pohled na stejná čísla jako plochý kalendář — klik na
 * sloupec otevře stejný detail dne.
 */
export default function CalendarLandscape({ weeks }: { weeks: Array<Array<LandscapeDay | null>> }) {
  const planeRef = useRef<HTMLDivElement>(null);
  const rotation = useRef({ ...START });
  const drag = useRef<{ x: number; y: number; rx: number; rz: number; moved: boolean } | null>(null);
  const transform = () => `rotateX(${rotation.current.x.toFixed(1)}deg) rotateZ(${rotation.current.z.toFixed(1)}deg) scale(0.86)`;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: event.clientX, y: event.clientY, rx: rotation.current.x, rz: rotation.current.z, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.x, dy = event.clientY - state.y;
    if (!state.moved && Math.hypot(dx, dy) < 5) return;
    if (!state.moved) { state.moved = true; event.currentTarget.setPointerCapture(event.pointerId); }
    rotation.current = { x: Math.max(20, Math.min(75, state.rx - dy * 0.3)), z: state.rz + dx * 0.35 };
    if (planeRef.current) planeRef.current.style.transform = transform();
  };
  // Po tažení se klik na sloupec nepočítá (jinak by otočení otevřelo detail dne).
  const wasDrag = useRef(false);
  const onPointerUp = () => { wasDrag.current = Boolean(drag.current?.moved); drag.current = null; };

  let barIndex = 0;
  return (
    <div className="cal-land" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <div ref={planeRef} className="cal-land__plane" style={{ transform: transform(), gridTemplateRows: `repeat(${weeks.length}, 1fr)` }}>
        {weeks.flatMap((week, weekIndex) => week.map((day, dayIndex) => {
          if (!day) return <div key={`${weekIndex}-${dayIndex}`} />;
          const color = day.bar?.positive ? '#10b981' : '#f43f5e';
          return (
            <div key={day.key} className="cal-land__cell" style={day.dim ? { opacity: 0.35 } : undefined}>
              {day.bar && (
                <div
                  className="cal-land__bar" title={day.bar.title}
                  style={{ ['--bar-h' as string]: `${Math.round(8 + 64 * day.bar.size)}px`, ['--bar-color' as string]: color, ['--bar-i' as string]: barIndex++ }}
                  onClick={() => { if (!wasDrag.current) day.onOpen?.(); wasDrag.current = false; }}
                >
                  <i className="cal-land__n" /><i className="cal-land__w" /><i className="cal-land__e" /><i className="cal-land__s" />
                  <i className="cal-land__top">{day.dayNum}</i>
                </div>
              )}
            </div>
          );
        }))}
      </div>
    </div>
  );
}
