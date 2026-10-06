import { describe, expect, it } from 'vitest';
import { arrangeDuringDrag, firstFreeSpot, packMidLayout, phoneLayoutFromRows, phoneRows } from '../lib/dashboardLayoutEdit';
import type { DashboardWidgetConfig } from '../types';

const kpi = (i: string, x: number, y = 0) => ({ i, x, y, w: 2, h: 2, minW: 2, minH: 2 });
const START = [
  kpi('pnl', 0), kpi('wr', 2), kpi('pf', 4), kpi('day', 6), kpi('dd', 8), kpi('avg', 10),
  { i: 'equity', x: 0, y: 2, w: 6, h: 4, minW: 4, minH: 3 },
  { i: 'calendar', x: 6, y: 2, w: 6, h: 6, minW: 4, minH: 5 },
];
const at = (layout: ReadonlyArray<{ i: string; x: number; y: number }>, id: string) => layout.find(item => item.i === id)!;

describe('úpravy dashboardu', () => {
  it('stejně velké widgety se prohodí, ostatní zůstanou', () => {
    const result = arrangeDuringDrag(START, { ...kpi('pnl', 2) }, 12);
    expect(result.swapWith).toBe('wr');
    expect(at(result.layout, 'pnl')).toMatchObject({ x: 2, y: 0 });
    expect(at(result.layout, 'wr')).toMatchObject({ x: 0, y: 0 });
    expect(at(result.layout, 'pf')).toMatchObject({ x: 4, y: 0 });
  });

  it('jinak tažený widget udělá místo — ostatní uhnou dolů', () => {
    const result = arrangeDuringDrag(START, { ...START[6], y: 0 }, 12);
    expect(result.swapWith).toBeNull();
    expect(at(result.layout, 'equity')).toMatchObject({ x: 0, y: 0 });
    expect(at(result.layout, 'pnl').y).toBeGreaterThanOrEqual(4);
    expect(at(result.layout, 'day').y).toBe(0);
  });

  it('nový widget z knihovny si udělá místo, kam ho pustíš', () => {
    const result = arrangeDuringDrag(START, { i: 'new', x: 0, y: 0, w: 2, h: 2 }, 12);
    expect(at(result.layout, 'new')).toMatchObject({ x: 0, y: 0 });
    expect(at(result.layout, 'pnl').y).toBe(2);
  });

  it('první volné místo shora zleva', () => {
    expect(firstFreeSpot(START, 2, 2, 12)).toEqual({ x: 0, y: 6 });
    expect(firstFreeSpot(START.filter(item => item.i !== 'wr'), 2, 2, 12)).toEqual({ x: 2, y: 0 });
  });

  it('střední šířka: KPI po třech, velké přes celou šířku, pořadí zachované', () => {
    const mid = packMidLayout(START, 6);
    expect(mid.filter(item => item.y === 0).map(item => item.i)).toEqual(['pnl', 'wr', 'pf']);
    expect(at(mid, 'equity')).toMatchObject({ x: 0, w: 6 });
    expect(mid.every(item => item.x + item.w <= 6)).toBe(true);
  });

  it('telefon: vlastní pořadí, jinak odvozené ze širokého', () => {
    const lg = START.map(item => ({ id: item.i, label: item.i, visible: true, x: item.x, y: item.y, w: item.w, h: item.h })) as DashboardWidgetConfig[];
    const canHalf = (id: string) => !['equity', 'calendar'].includes(id);
    expect(phoneRows({ lg }, canHalf).map(row => row.id)).toEqual(['pnl', 'wr', 'pf', 'day', 'dd', 'avg', 'equity', 'calendar']);
    const phone = phoneLayoutFromRows([{ id: 'equity', half: false }, { id: 'pnl', half: false }], lg);
    const rows = phoneRows({ lg, phone }, canHalf);
    expect(rows).toEqual([{ id: 'equity', half: false }, { id: 'pnl', half: false }]);
    // Široké rozložení se tím nemění.
    expect(lg[0]).toMatchObject({ id: 'pnl', x: 0, y: 0 });
  });
});
