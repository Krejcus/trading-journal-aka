import { describe, expect, it } from 'vitest';
import { buildChartWorkspaceLayout } from '../services/chartWorkspaceLayouts';
import { chartWorkspaceDocumentStorageKey, createChartWorkspaceDocument, parseChartWorkspaceDocument, type CompleteChartWorkspaceState } from '../services/chartWorkspaceDocument';

const fixture = (): CompleteChartWorkspaceState => ({
  layout: { version: 1, id: 'workspace', name: 'saved', createdAt: '2026-09-05', updatedAt: '2026-09-05', panels: {},
    tree: buildChartWorkspaceLayout({ id: '1', component: 'alphatrade-chart', panelIdPrefix: 'chart-', panelTitle: n => `Graf ${n}`,
      configs: [{ root: 'MNQ', timeframe: '5m', showLevels: true, showFvg: false, showStructure: false }] }) },
  panels: { 'chart-1': {
    drawings: [{ id: 'rectangle', tool: 'Rectangle', points: [{ time: 100, price: 10 }, { time: 200, price: 20 }], style: { color: 'red', width: 2, dashed: false, fill: '#f006' } }],
    logicalRange: { from: 100, to: 140 }, priceRange: { from: 10, to: 20 }, autoScale: false,
    indicators: { custom: { fvg: false, levels: true, structure: false }, library: [{ name: 'SMA', params: { period: 20 } }] },
  } },
  layoutId: '1', activePanelId: 'chart-1',
  syncSettings: { symbol: true, interval: false, crosshair: true, time: true, dateRange: false, drawings: false },
  appearance: { chartSettings: { grid: 'both' }, indicatorSettings: { levels: { color: 'blue' } }, drawingStyleDefaults: { Rectangle: { color: 'red' } } },
});

describe('versioned complete workspace documents', () => {
  it('round-trips drawings, both scales, library/custom indicators, appearance and sync settings', () => {
    const state = fixture();
    const parsed = parseChartWorkspaceDocument(JSON.stringify(createChartWorkspaceDocument(state)));
    expect(parsed.kind).toBe('complete');
    if (parsed.kind === 'complete') expect(parsed.document.state).toEqual(state);
  });

  it('returns an independent snapshot and never mutates the live state during conversion', () => {
    const state = fixture();
    const before = structuredClone(state);
    const document = createChartWorkspaceDocument(state);
    document.state.panels['chart-1'].drawings[0].style.color = 'green';
    expect(state).toEqual(before);
  });

  it('accepts a structurally valid legacy manager-only layout with an explicit legacy result', () => {
    const layout = fixture().layout;
    expect(parseChartWorkspaceDocument(JSON.stringify(layout))).toEqual({ kind: 'legacy', layout });
  });

  it.each(['{', '{}', 'null', '[]', '{"format":"alphatrade-workspace","version":2,"state":{}}'])('rejects invalid input before any workspace state is touched: %s', input => {
    const state = fixture();
    const before = JSON.stringify(state);
    expect(() => parseChartWorkspaceDocument(input)).toThrow('Současné rozložení zůstalo zachováno');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('rejects malformed drawings, panel configs, duplicate IDs, sync and indicator snapshots', () => {
    const variants = [
      (state: any) => { state.panels['chart-1'].drawings[0].points[0].price = 'oops'; },
      (state: any) => { state.layout.tree.layout.children[0].children[0].config.config.root = 'OTHER'; },
      (state: any) => { state.layout.tree.layout.children[0].children.push(structuredClone(state.layout.tree.layout.children[0].children[0])); },
      (state: any) => { state.syncSettings.drawings = 'yes'; },
      (state: any) => { state.panels['chart-1'].indicators.library[0].params = null; },
      (state: any) => { state.appearance = []; },
    ];
    for (const corrupt of variants) {
      const state = fixture();
      corrupt(state);
      const unchanged = structuredClone(state);
      expect(() => createChartWorkspaceDocument(state)).toThrow();
      expect(state).toEqual(unchanged);
    }
  });

  it('uses separate named slots for accounts and sessions, and does not claim unknown ownership', () => {
    expect(chartWorkspaceDocumentStorageKey('A', 'run')).not.toBe(chartWorkspaceDocumentStorageKey('B', 'run'));
    expect(chartWorkspaceDocumentStorageKey('A', 'run')).not.toBe(chartWorkspaceDocumentStorageKey('A', 'other'));
    expect(chartWorkspaceDocumentStorageKey(null)).toContain('guest');
    expect(() => chartWorkspaceDocumentStorageKey(undefined, 'run')).toThrow();
  });

  it('rejects object tab labels and malformed optional display flags before React receives them', () => {
    for (const field of ['name', 'title', 'showLevels', 'showFvg', 'showStructure']) {
      const state = fixture();
      const tab = (state.layout as any).tree.layout.children[0].children[0];
      if (field === 'name') tab.name = { invalid: true };
      else if (field === 'title') tab.config.title = { invalid: true };
      else tab.config.config[field] = 'yes';
      expect(() => createChartWorkspaceDocument(state)).toThrow();
    }
  });
});
