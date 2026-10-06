import { cloneLayout, getLayoutItem, moveElement, verticalCompactor } from 'react-grid-layout';
import type { Layout, LayoutItem } from 'react-grid-layout';
import type { DashboardWidgetConfig } from '../types';

/*
 * Úpravy dashboardu — čisté výpočty nad rozložením mřížky:
 * náhled během tažení (prohození stejně velkých widgetů / uvolnění místa),
 * první volné místo pro nový widget, dopočítané rozložení pro střední šířku
 * (6 sloupců) a oddělené pořadí pro telefon.
 */

export interface ArrangeResult { layout: Layout; swapWith: string | null }

/**
 * Rozložení během tažení, vždy od stavu před začátkem tahu. Nad stejně velkým
 * widgetem se oba prohodí (cíl odjede na původní místo taženého), jinak tažený
 * widget odtlačí ostatní dolů — udělá si místo.
 */
export function arrangeDuringDrag(start: Layout, moving: LayoutItem, cols: number): ArrangeResult {
  const origin = start.find(item => item.i === moving.i);
  const cx = moving.x + moving.w / 2;
  const cy = moving.y + moving.h / 2;
  const target = origin
    ? start.find(item => item.i !== moving.i && item.w === moving.w && item.h === moving.h
      && cx >= item.x && cx < item.x + item.w && cy >= item.y && cy < item.y + item.h)
    : undefined;
  if (origin && target) {
    return {
      swapWith: target.i,
      layout: start.map(item => item.i === moving.i
        ? { ...item, x: target.x, y: target.y }
        : item.i === target.i ? { ...item, x: origin.x, y: origin.y } : { ...item }),
    };
  }
  const clone = cloneLayout(start).filter(item => item.i !== moving.i);
  // Výchozí bod = původní místo (nový widget „zespodu“): moveElement nic
  // neodtlačí, když položka už na cílové pozici stojí.
  clone.push({ ...moving, x: origin?.x ?? 0, y: origin?.y ?? 9999 });
  const moved = moveElement(clone, getLayoutItem(clone, moving.i)!, moving.x, moving.y, true, false, 'vertical', cols, false);
  return { swapWith: null, layout: verticalCompactor.compact(moved, cols) };
}

/** První volné místo shora zleva, kam se widget w×h vejde. */
export function firstFreeSpot(items: ReadonlyArray<Pick<LayoutItem, 'x' | 'y' | 'w' | 'h'>>, w: number, h: number, cols: number): { x: number; y: number } {
  const width = Math.min(w, cols);
  const hit = (x: number, y: number) => items.some(it => x < it.x + it.w && x + width > it.x && y < it.y + it.h && y + h > it.y);
  const limit = items.reduce((max, it) => Math.max(max, it.y + it.h), 0) + 1;
  for (let y = 0; y <= limit; y++) for (let x = 0; x + width <= cols; x++) if (!hit(x, y)) return { x, y };
  return { x: 0, y: limit };
}

/**
 * Střední šířka (6 sloupců): pořadí jako na širokém rozložení, malé widgety po
 * třech, velké přes celou šířku. Dřív se tu jen ořízla šířka a widgety z pravé
 * půlky se naskládaly do sloupce vpravo s prázdnou plochou vlevo.
 */
export function packMidLayout(items: ReadonlyArray<LayoutItem>, cols = 6): Layout {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  let x = 0;
  let row = 0;
  const out: LayoutItem[] = [];
  for (const item of sorted) {
    const w = item.w >= cols ? cols : Math.min(cols, Math.max(item.minW ?? 2, Math.ceil(item.w / 2)));
    if (x + w > cols) { x = 0; row += 1; }
    out.push({ ...item, x, y: row * 1000, w, minW: Math.min(item.minW ?? 1, w), maxW: cols });
    x += w;
  }
  return verticalCompactor.compact(out, cols);
}

/** Klíč rozložení pro telefon — mřížka ho nečte, nesahá na rozložení počítače. */
export const PHONE_LAYOUT_KEY = 'phone';

export interface PhoneRow { id: string; half: boolean }

/**
 * Pořadí na telefonu: uložené `phone` rozložení, jinak odvozené ze širokého
 * (shora zleva). `half` = widget vedle dalšího (dvojice KPI), jinak celá šířka.
 */
export function phoneRows(
  layouts: Record<string, DashboardWidgetConfig[] | undefined>,
  canHalf: (id: string) => boolean,
  defaultHalf: (id: string) => boolean = canHalf,
): PhoneRow[] {
  const phone = layouts[PHONE_LAYOUT_KEY];
  const source = phone?.length ? phone : layouts.lg ?? [];
  return [...source]
    .filter(widget => widget.visible !== false)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(widget => ({ id: widget.id, half: canHalf(widget.id) && (widget.mobileHalf ?? defaultHalf(widget.id)) }));
}

/** Uloží pořadí a šířky z telefonu jako `phone` rozložení (y = pořadí). */
export function phoneLayoutFromRows(rows: ReadonlyArray<PhoneRow>, catalog: ReadonlyArray<DashboardWidgetConfig>): DashboardWidgetConfig[] {
  const byId = new Map(catalog.map(widget => [widget.id, widget]));
  return rows.map((row, index) => {
    const base = byId.get(row.id);
    return {
      ...(base ?? { id: row.id, label: row.id, visible: true, x: 0, y: 0, w: 2, h: 2 }),
      visible: true,
      x: 0,
      y: index,
      mobileHalf: row.half,
    };
  });
}
