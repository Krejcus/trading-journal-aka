import { describe, it, expect } from 'vitest';
import { storeWorkspaceRecovery, chartWorkspaceDocumentStorageKey, createChartWorkspaceDocument, parseChartWorkspaceDocument, summarizeWorkspaceDocument } from '../services/chartWorkspaceDocument';
import { buildChartWorkspaceLayout } from '../services/chartWorkspaceLayouts';
import type { CompleteChartWorkspaceState } from '../services/chartWorkspaceDocument';
const fixture = (root = 'MNQ'): CompleteChartWorkspaceState => ({
  layout: { version: 1, id: 'workspace', name: 'saved', panels: {}, tree: buildChartWorkspaceLayout({ id: '1', component: 'alphatrade-chart', panelIdPrefix: 'chart-', panelTitle: n => `Graf ${n}`, configs: [{ root, timeframe: '5m', showLevels: true }] }) },
  layoutId: '1', activePanelId: 'chart-1',
  panels: { 'chart-1': { drawings: [{ id: 'r', tool: 'Rectangle', points: [{ time: 100, price: 10 }], style: { color: 'red', width: 2, dashed: false, fill: null } }], logicalRange: null, priceRange: null, autoScale: true, indicators: { custom: { fvg: true, levels: true, structure: false }, library: [] } } },
  syncSettings: { symbol: false, interval: false, crosshair: true, time: true, dateRange: true, drawings: false },
  appearance: { chartSettings: { __panelScoped: 1, shared: { symbol: { timeZone: 'Europe/Prague' } }, panels: { 'chart-1': { canvas: { gridLines: 'both' } } } }, indicatorSettings: { levels: { timezone: 'America/New_York' } }, drawingStyleDefaults: { Rectangle: { color: 'red', width: 2, dashed: false } } },
});

describe('contextual workspace import validation', () => {
  it('validates both full documents and legacy layouts against allowed roots', () => {
    const state = fixture('NQ');
    for (const input of [createChartWorkspaceDocument(state), state.layout]) {
      expect(() => parseChartWorkspaceDocument(input, { allowedRoots: ['MNQ'] })).toThrow('Instrument NQ');
      expect(() => parseChartWorkspaceDocument(input, { allowedRoots: ['MNQ', 'NQ'] })).not.toThrow();
    }
  });
  it('provides a preview without touching the source and counts drawings and indicators', () => {
    const state = fixture(), before = structuredClone(state);
    expect(summarizeWorkspaceDocument(createChartWorkspaceDocument(state))).toEqual({ kind: 'complete', panels: 1, roots: ['MNQ'], drawings: 1, indicators: 2 });
    expect(state).toEqual(before);
  });
  it('rejects malformed nested containers, primitives and time zones in shared and per-panel settings before mutation', () => {
    const bad = [
      { chartSettings: { symbol: { timeZone: 'Mars/InvalidZone' } } },
      { chartSettings: { __panelScoped: 1, shared: { symbol: { timeZone: 'Mars/InvalidZone' } }, panels: {} } },
      { chartSettings: { __panelScoped: 1, panels: { 'chart-1': { symbol: { timeZone: { bad: true } } } } } },
      { chartSettings: { canvas: { backgroundColor: {} } } },
      { chartSettings: { symbol: [] } },
      { chartSettings: { canvas: { gridLines: 'broken' } } },
      { indicatorSettings: { levels: { timezone: 'Mars/InvalidZone' } } },
      { indicatorSettings: { __panelScoped: 1, panels: { 'chart-1': { fvg: { visibility: null } } } } },
      { indicatorSettings: { structure: { enabled: 'yes' } } },
      { drawingStyleDefaults: { FibRetracement: { fib: { levels: 'bad' } } } },
      { drawingStyleDefaults: { LongPosition: { position: { risk: {} } } } },
    ];
    for (const appearance of bad) {
      const state = fixture(); state.appearance = appearance;
      const before = structuredClone(state);
      expect(() => createChartWorkspaceDocument(state)).toThrow();
      expect(state).toEqual(before);
    }
  });
  it('rejects malformed fib/position styles inside drawing snapshots too', () => {
    const state = fixture();
    (state.panels['chart-1'].drawings[0].style as any).fib = { text: {} };
    expect(() => createChartWorkspaceDocument(state)).toThrow();
  });
});

it('keeps an owner/session-specific recovery version and stops on quota before mutating charts', () => {
  const state = fixture();
  const data = new Map<string, string>();
  storeWorkspaceRecovery('A', 'run', state, { setItem: (key, value) => { data.set(key, value); } });
  expect(parseChartWorkspaceDocument(data.get(`${chartWorkspaceDocumentStorageKey('A', 'run')}:recovery`))).toEqual({ kind: 'complete', document: createChartWorkspaceDocument(state) });
  let applied = false;
  const apply = () => { storeWorkspaceRecovery('A', 'run', state, { setItem: () => { throw new Error('quota'); } }); applied = true; };
  expect(apply).toThrow('quota'); expect(applied).toBe(false);
  expect(data.size).toBe(1);
});
