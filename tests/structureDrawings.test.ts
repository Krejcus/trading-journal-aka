import { describe, expect, it } from 'vitest';
import { structureDrawing, syncStructureDrawings, type StructureDrawingEngine } from '../lib/structureDrawings';
import type { MarketStructureEvent } from '../services/marketDataCalculations';

const style = { bullishColor: '#0f0', bearishColor: '#f00', lineWidth: 1 };
const event = (breakTime: number, direction: MarketStructureEvent['direction'] = 'bullish'): { event: MarketStructureEvent } => ({
  event: { type: 'BOS', direction, pivotTime: breakTime - 120, breakTime, price: 100, labelPrice: 101 },
});

/** Jako DrawingEngine z CandleKitu: `commit` kresbu označí a zahodí nástroj i náhled. */
const fakeEngine = (ids: string[] = []) => {
  let drawings = ids.map(id => ({ id, tool: 'TrendLine', points: [], style: {} }));
  let selectedId: string | null = null;
  let activeTool: string | null = null;
  let draft: unknown = null;
  const engine = {
    getDrawings: () => drawings,
    getById: (id: string) => drawings.find(drawing => drawing.id === id),
    commit: (drawing: { id: string }) => { drawings = [...drawings, drawing as never]; draft = null; activeTool = null; selectedId = drawing.id; },
    remove: (id: string) => { drawings = drawings.filter(drawing => drawing.id !== id); if (selectedId === id) selectedId = null; },
    select: (id: string | null) => { selectedId = id; },
    getSelectedId: () => selectedId,
    getActiveTool: () => activeTool,
    getDraft: () => draft,
  };
  return {
    engine: engine as unknown as StructureDrawingEngine,
    ids: () => drawings.map(drawing => drawing.id),
    selected: () => selectedId,
    tool: () => activeTool,
    setTool: (tool: string | null) => { activeTool = tool; },
    setDraft: (value: unknown) => { draft = value; },
  };
};

describe('syncStructureDrawings', () => {
  it('přidaná čára BoS/CHoCH nezůstane označená', () => {
    const chart = fakeEngine();
    expect(syncStructureDrawings(chart.engine, [event(600), event(900)], style)).toEqual({ changed: true, deferred: false });
    expect(chart.ids()).toEqual([structureDrawing(event(600).event, style).id, structureDrawing(event(900).event, style).id]);
    expect(chart.selected()).toBeNull();
  });

  it('výběr uživatele po přidání čáry zůstane', () => {
    const chart = fakeEngine(['dw_user']);
    chart.engine.select('dw_user');
    syncStructureDrawings(chart.engine, [event(600)], style);
    expect(chart.selected()).toBe('dw_user');
  });

  it('během kreslení nové čáry nepřidá (nástroj ani náhled nezmizí), staré odebere', () => {
    const stale = structureDrawing(event(300).event, style).id;
    const chart = fakeEngine([stale]);
    chart.setTool('TrendLine');
    chart.setDraft({ id: 'draft' });
    expect(syncStructureDrawings(chart.engine, [event(600)], style)).toEqual({ changed: true, deferred: true });
    expect(chart.ids()).toEqual([]);
    expect(chart.tool()).toBe('TrendLine');
    // Po dokreslení se odložená čára doplní.
    chart.setTool(null);
    chart.setDraft(null);
    expect(syncStructureDrawings(chart.engine, [event(600)], style)).toEqual({ changed: true, deferred: false });
    expect(chart.ids()).toEqual([structureDrawing(event(600).event, style).id]);
  });

  it('beze změny nic nedělá a ostatní kresby nechá být', () => {
    const line = structureDrawing(event(600).event, style).id;
    const chart = fakeEngine(['dw_user', 'auto-risk-1', line]);
    chart.engine.select('dw_user');
    expect(syncStructureDrawings(chart.engine, [event(600)], style)).toEqual({ changed: false, deferred: false });
    expect(chart.ids()).toEqual(['dw_user', 'auto-risk-1', line]);
    expect(chart.selected()).toBe('dw_user');
  });

  it('id čáry je dané zlomem, ne pořadím', () => {
    expect(structureDrawing(event(600, 'bearish').event, style).id).toBe('auto-structure-BOS-bearish-480-600');
  });
});
