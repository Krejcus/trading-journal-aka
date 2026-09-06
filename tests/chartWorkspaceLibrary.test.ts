import { describe, it, expect } from 'vitest';
import { readWorkspaceLibrary, saveWorkspaceTemplate, workspaceLibraryKey, workspaceTemplateForNewSession, setDefaultWorkspaceTemplate } from '../services/chartWorkspaceLibrary';
import { buildChartWorkspaceLayout } from '../services/chartWorkspaceLayouts';
import type { CompleteChartWorkspaceState } from '../services/chartWorkspaceDocument';
const fixture = (root = 'MNQ'): CompleteChartWorkspaceState => ({
  layout: { version: 1, id: 'workspace', name: 'saved', panels: {}, tree: buildChartWorkspaceLayout({ id: '1', component: 'alphatrade-chart', panelIdPrefix: 'chart-', panelTitle: n => `Graf ${n}`, configs: [{ root, timeframe: '5m', showLevels: true }] }) },
  layoutId: '1', activePanelId: 'chart-1',
  panels: { 'chart-1': { drawings: [{ id: 'r', tool: 'Rectangle', points: [{ time: 100, price: 10 }], style: { color: 'red', width: 2, dashed: false, fill: null } }], logicalRange: null, priceRange: null, autoScale: true, indicators: { custom: { fvg: true, levels: true, structure: false }, library: [] } } },
  syncSettings: { symbol: false, interval: false, crosshair: true, time: true, dateRange: true, drawings: false },
  appearance: { chartSettings: { __panelScoped: 1, shared: { symbol: { timeZone: 'Europe/Prague' } }, panels: { 'chart-1': { canvas: { gridLines: 'both' } } } }, indicatorSettings: { levels: { timezone: 'America/New_York' } }, drawingStyleDefaults: { Rectangle: { color: 'red', width: 2, dashed: false } } },
});

const storage = () => { const data = new Map<string, string>(); return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; };
describe('user-owned workspace library', () => {
  it('Save / Load / New Session use the same complete snapshot and default selection', () => {
    const target = storage(), state = fixture();
    const saved = saveWorkspaceTemplate('A', { name: 'NY', state, makeDefault: true }, target);
    expect(readWorkspaceLibrary('A', target).templates[0].document.state).toEqual(state);
    expect(workspaceTemplateForNewSession('A', 'default', ['MNQ'], target)).toEqual(state);
    expect(workspaceTemplateForNewSession('A', `template:${saved.id}`, ['MNQ'], target)).toEqual(state);
  });
  it('resolves current availability after save and observes the current default on every call', () => {
    const target = storage();
    expect(workspaceTemplateForNewSession('A', 'default', ['MNQ'], target)).toBeNull();
    const saved = saveWorkspaceTemplate('A', { name: 'NY', state: fixture(), makeDefault: true }, target);
    expect(workspaceTemplateForNewSession('A', 'default', ['MNQ'], target)?.panels['chart-1'].drawings).toHaveLength(1);
    saveWorkspaceTemplate('A', { id: saved.id, name: 'NY', state: fixture(), makeDefault: false }, target);
    expect(readWorkspaceLibrary('A', target).defaultId).toBeNull();
    setDefaultWorkspaceTemplate('A', null, target);
    expect(workspaceTemplateForNewSession('A', 'default', ['MNQ'], target)).toBeNull();
    expect(() => workspaceTemplateForNewSession('A', 'template:removed', ['MNQ'], target)).toThrow();
    expect(saved.id).toBeTruthy();
  });
  it('does not claim guest or unknown legacy data for A or B; stale A selection cannot read or write B', () => {
    const target = storage();
    target.setItem('alphatrade.candlekit.layout.alphatrade-market-workspace', JSON.stringify(fixture().layout));
    saveWorkspaceTemplate(null, { name: 'guest', state: fixture() }, target);
    const a = saveWorkspaceTemplate('A', { name: 'private A', state: fixture(), makeDefault: true }, target);
    expect(readWorkspaceLibrary(undefined, target).templates).toEqual([]);
    expect(readWorkspaceLibrary('B', target).templates).toEqual([]);
    expect(() => saveWorkspaceTemplate(undefined, { name: 'unknown', state: fixture() }, target)).toThrow();
    expect(() => saveWorkspaceTemplate('B', { id: a.id, name: 'private A', state: fixture() }, target)).toThrow();
    expect(() => workspaceTemplateForNewSession('B', `template:${a.id}`, ['MNQ'], target)).toThrow();
  });
  it('rejects incompatible roots without silently changing the chart or losing drawings', () => {
    const target = storage(), state = fixture('NQ');
    saveWorkspaceTemplate('A', { name: 'NQ', state, makeDefault: true }, target);
    expect(() => workspaceTemplateForNewSession('A', 'default', ['MNQ'], target)).toThrow('Instrument NQ');
    expect(workspaceTemplateForNewSession('A', 'default', ['MNQ', 'NQ'], target)).toEqual(state);
  });
  it('preserves a previous version on overwrite and leaves both versions intact after quota failure', () => {
    const target = storage(), first = fixture(), next = fixture();
    next.panels['chart-1'].drawings = [];
    const saved = saveWorkspaceTemplate('A', { name: 'NY', state: first }, target);
    saveWorkspaceTemplate('A', { id: saved.id, name: 'NY', state: next }, target);
    expect(readWorkspaceLibrary('A', target).templates[0].previous?.state).toEqual(first);
    const before = target.getItem(workspaceLibraryKey('A'));
    expect(() => saveWorkspaceTemplate('A', { id: saved.id, name: 'NY', state: first }, { getItem: target.getItem, setItem: () => { throw new Error('quota'); } })).toThrow('quota');
    expect(target.getItem(workspaceLibraryKey('A'))).toBe(before);
    expect(() => saveWorkspaceTemplate('A', { name: 'ny', state: first }, target)).toThrow('název');
  });
  it('does not erase corrupt stored library data', () => {
    const target = storage(); target.setItem(workspaceLibraryKey('A'), '{broken');
    expect(() => saveWorkspaceTemplate('A', { name: 'NY', state: fixture() }, target)).toThrow();
    expect(target.getItem(workspaceLibraryKey('A'))).toBe('{broken');
    expect(workspaceTemplateForNewSession('A', 'preset', ['MNQ'], target)).toBeNull();
  });
});
