import { useEffect, useRef, useState } from 'react';
import { GripVertical, Lock } from 'lucide-react';
import { useFlipReorder, useIsomorphicLayoutEffect } from '../hooks/useFlipReorder';

export interface ColumnOrderItem {
  key: string;
  label: string;
  visible: boolean;
  /** Kotva tabulky — dá se jen číst, ne skrýt ani přesunout. */
  locked?: boolean;
}

/** Během tahu se řádky prohazují, tak se animace vejde mezi dva pohyby ruky. */
const DRAG_FLIP_MS = 170;

/**
 * Seznam sloupců jedné tabulky: přepínač viditelnosti a pořadí přetažením.
 *
 * Řádek se drží pod prstem přes `transform`, zatímco ostatní se překládají
 * animací FLIP — vzniká tím dojem, že se řádky mezi sebou prohazují, ne že
 * seznam skokem přeskládá. Ukotvené sloupce se z pohybu vyjímají, takže do
 * jejich pozice nelze nic zasunout.
 *
 * Tah nesmí sahat na stav celé stránky: přeskládání běží lokálně a nadřazená
 * komponenta (a s ní zápis do localStorage a překreslení tabulek LIVE) se
 * dozví jediný výsledný přesun, až když se prst zvedne. Posun pod prstem se
 * navíc zapisuje přímo do DOM a pohyby se slučují po snímcích, aby jeden tah
 * nevyvolal desítky rerenderů.
 */
export const ColumnOrderList = ({ tableKey, items, onMove, onToggle }: {
  tableKey: string;
  items: ColumnOrderItem[];
  onMove: (from: number, to: number) => void;
  onToggle: (key: string) => void;
}) => {
  const listRef = useRef<HTMLUListElement>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const gesture = useRef<{
    startY: number; startIndex: number; index: number; rowHeight: number;
    min: number; max: number; node: HTMLElement; pointerY: number; frame: number | null;
    detach: () => void;
  } | null>(null);

  const signature = items.map(item => item.key).join(',');
  // Lokální kopie žije jen po dobu tahu. React sloučí puštění i zápis do
  // nadřazeného stavu do jednoho překreslení, takže v okamžiku, kdy `dragKey`
  // zmizí, už jsou v `items` nová data — zahození kopie tedy nebliká.
  useEffect(() => { if (!dragKey) setLocalOrder(null); }, [dragKey, signature]);

  const byKey = new Map(items.map(item => [item.key, item]));
  const visible = (localOrder ?? items.map(item => item.key))
    .flatMap(key => { const item = byKey.get(key); return item ? [item] : []; });

  useFlipReorder(
    `${tableKey}|${visible.map(item => item.key).join(',')}`,
    '[data-flip-id^="col:"]',
    dragKey ? `col:${tableKey}:${dragKey}` : undefined,
    DRAG_FLIP_MS,
  );

  const movableRange = () => {
    const min = visible.findIndex(item => !item.locked);
    let max = visible.length - 1;
    while (max >= 0 && visible[max].locked) max -= 1;
    return { min: min < 0 ? 0 : min, max };
  };

  /** Přepočet se dělá jednou za snímek — pointermove chodí i 10× mezi nimi. */
  const settle = () => {
    const state = gesture.current;
    if (!state) return;
    state.frame = null;
    const travelled = state.pointerY - state.startY;
    const target = targetFor(state, state.pointerY);
    if (target === state.index) {
      // Beze změny pořadí žádné překreslení nepřijde, takže posun zapíšeme rovnou.
      state.node.style.transform = `translateY(${travelled - (state.index - state.startIndex) * state.rowHeight}px)`;
      return;
    }
    const from = state.index;
    state.index = target;
    // Nový posun se dopočítá až po překreslení (`track` níž). Kdyby se zapsal
    // teď, řádek by jeden snímek visel u starého místa s posunem pro nové —
    // přesně to při rychlém tahu poskakovalo.
    setLocalOrder(current => {
      const next = [...(current ?? items.map(item => item.key))];
      next.splice(target, 0, next.splice(from, 1)[0]);
      return next;
    });
  };

  /** Po každém překreslení během tahu dorovná řádek zpět pod prst. */
  useIsomorphicLayoutEffect(() => {
    const state = gesture.current;
    if (!state) return;
    state.node.style.transform =
      `translateY(${state.pointerY - state.startY - (state.index - state.startIndex) * state.rowHeight}px)`;
  });

  const slide = (event: PointerEvent) => {
    const state = gesture.current;
    if (!state || state.rowHeight <= 0) return;
    state.pointerY = event.clientY;
    if (state.frame == null) state.frame = requestAnimationFrame(settle);
  };

  const targetFor = (state: NonNullable<typeof gesture.current>, pointerY: number) =>
    Math.min(state.max, Math.max(state.min,
      state.startIndex + Math.round((pointerY - state.startY) / state.rowHeight)));

  const release = (event: PointerEvent) => {
    const state = gesture.current;
    if (!state) return;
    if (state.frame != null) cancelAnimationFrame(state.frame);
    state.node.style.transform = '';
    state.detach();
    gesture.current = null;
    setDragKey(null);
    // Zrušené gesto (systém převzal dotyk) pořadí nemění.
    if (event.type === 'pointercancel') { setLocalOrder(null); return; }
    // Při rychlém tahu může poslední pohyb dorazit až s puštěním, nebo se
    // naplánovaný snímek nestihne — cíl proto dopočítáme z konečné polohy
    // prstu, ne z toho, kam se seznam stihl překreslit.
    const target = targetFor(state, Number.isFinite(event.clientY) ? event.clientY : state.pointerY);
    // Jediný zápis za celý tah: až tady se přepočítají tabulky a uloží pořadí.
    if (target !== state.startIndex) onMove(state.startIndex, target);
    else setLocalOrder(null);
  };

  const grab = (index: number) => (event: React.PointerEvent<HTMLElement>) => {
    const item = visible[index];
    const node = listRef.current?.children[index] as HTMLElement | undefined;
    if (item.locked || !node || event.button !== 0) return;
    const { min, max } = movableRange();
    if (index < min || index > max) return;
    event.preventDefault();
    // Zachycení ukazatele drží tah i mimo okno; posloucháme ale na okně, aby
    // ruka nemusela jet přesně svisle po úchytu — stačí, že se hýbe.
    const handle = event.currentTarget;
    try { handle.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    const detach = () => {
      window.removeEventListener('pointermove', slide);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      try { if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    };
    window.addEventListener('pointermove', slide);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    gesture.current = {
      startY: event.clientY, startIndex: index, index, rowHeight: node.getBoundingClientRect().height,
      min, max, node, pointerY: event.clientY, frame: null, detach,
    };
    setLocalOrder(items.map(entry => entry.key));
    setDragKey(item.key);
  };

  // Když se dialog zavře uprostřed tahu, posluchači na okně nesmí přežít.
  useEffect(() => () => gesture.current?.detach(), []);

  const nudge = (index: number) => (event: React.KeyboardEvent<HTMLElement>) => {
    const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (!step || visible[index].locked) return;
    const { min, max } = movableRange();
    const target = Math.min(max, Math.max(min, index + step));
    if (target === index) return;
    event.preventDefault();
    onMove(index, target);
  };

  return (
    <ul ref={listRef} className="select-none">
      {visible.map((item, index) => {
        const dragging = dragKey === item.key;
        return (
          <li
            key={item.key}
            data-flip-id={`col:${tableKey}:${item.key}`}
            className={`flex items-center gap-2 rounded-md py-[5px] pl-0.5 pr-1.5 text-xs font-bold ${
              item.locked ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'
            } ${dragging
              ? 'relative z-10 bg-[var(--bg-card)] shadow-[0_8px_20px_-10px_rgba(0,0,0,.55)] ring-1 ring-[var(--border-subtle)]'
              : 'hover:bg-[var(--bg-page)]'}`}
          >
            <span
              role={item.locked ? undefined : 'button'}
              tabIndex={item.locked ? undefined : 0}
              aria-label={item.locked ? undefined : `Přesunout sloupec ${item.label}`}
              onPointerDown={grab(index)}
              onKeyDown={nudge(index)}
              className={`flex h-[18px] w-4 shrink-0 touch-none items-center justify-center rounded ${
                item.locked
                  ? 'opacity-30'
                  : 'cursor-grab text-[var(--text-muted)] hover:text-[var(--text-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 active:cursor-grabbing'
              }`}
            >
              <GripVertical size={12} />
            </span>
            <span className="flex-1 truncate">{item.label}</span>
            {item.locked ? (
              <span className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-[var(--text-muted)]">
                <Lock size={9} /> vždy
              </span>
            ) : (
              // Zaškrtávátko, ne přepínač: přepínač v této appce znamená
              // zapnutou kopírku a nesmí vypadat stejně jako volba sloupce.
              <input
                type="checkbox"
                checked={item.visible}
                aria-label={`Zobrazit sloupec ${item.label}`}
                onChange={() => onToggle(item.key)}
                className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-indigo-600"
              />
            )}
          </li>
        );
      })}
    </ul>
  );
};
