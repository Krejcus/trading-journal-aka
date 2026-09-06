import { DrawingEngine, type Drawing } from '@getcandlekit/charts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBacktestWorkspaceCheckpoint, mergeWorkspacePanelSnapshots, workspaceLayoutPanelIds, workspacePanelsReady } from '../services/backtestWorkspaceCheckpoint';
import { ChartWorkspaceHistory, type WorkspaceHistoryPanel, type WorkspacePanelSnapshot } from '../services/chartWorkspaceHistory';
import type { BacktestWorkspaceState } from '../services/backtestTypes';

const savedPanel = (id = 'saved'): WorkspacePanelSnapshot => ({
  drawings: [{ id, tool: 'TrendLine', points: [{ time: 1, price: 100 }, { time: 2, price: 101 }], style: { color: '#000', width: 1, dashed: false, fill: null } } as Drawing],
  logicalRange: { from: 1, to: 12 }, priceRange: null, autoScale: true, indicators: null,
});

afterEach(() => vi.useRealTimers());

describe('backtest workspace checkpoints', () => {
  it('captures a live drawing added immediately before Close, without waiting for either debounce timer', () => {
    vi.useFakeTimers();
    const engine = new DrawingEngine();
    const history = new ChartWorkspaceHistory();
    history.updatePanels(new Map([['chart-1', { drawingEngine: engine, chartApi: null }]]));
    let saved: BacktestWorkspaceState = {};
    const capture = createBacktestWorkspaceCheckpoint(() => ({ panels: history.exportSnapshot() }), state => { saved = structuredClone(state); });
    capture();
    engine.commit(savedPanel('just-created').drawings[0]);
    // This is called synchronously at the start of flush/Close.
    capture();
    expect(saved.panels?.['chart-1'].drawings.map(drawing => drawing.id)).toEqual(['just-created']);
  });

  it('does not mark an unchanged layout dirty just because exportLayout updates its timestamp', () => {
    let stamp = 'first';
    const write = vi.fn();
    const capture = createBacktestWorkspaceCheckpoint(() => ({ layout: { tree: { layout: {} }, updatedAt: stamp } }), write);
    capture();
    stamp = 'second';
    capture();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('includes appearance changes in the next synchronous checkpoint', () => {
    let appearance = { chartSettings: { color: 'blue' } };
    const write = vi.fn();
    const capture = createBacktestWorkspaceCheckpoint(() => ({ appearance }), write);
    capture();
    appearance = { chartSettings: { color: 'green' } };
    capture();
    expect(write).toHaveBeenLastCalledWith({ appearance: { chartSettings: { color: 'green' } } });
  });

  it('keeps the prior saved snapshot while the workspace has not mounted', () => {
    let ready = false;
    const write = vi.fn();
    const capture = createBacktestWorkspaceCheckpoint(() => ready ? { panels: { first: savedPanel() } } : undefined, write);
    capture();
    expect(write).not.toHaveBeenCalled();
    ready = true;
    capture();
    expect(write).toHaveBeenCalledOnce();
  });

  it('retries a failed checkpoint instead of recording its fingerprint as persisted', () => {
    const write = vi.fn().mockImplementationOnce(() => { throw new Error('quota'); });
    const capture = createBacktestWorkspaceCheckpoint(() => ({ activePanelId: 'first' }), write);
    expect(capture).toThrow('quota');
    expect(capture).not.toThrow();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('does not consider a placeholder registration ready to restore drawings', () => {
    const snapshots = { first: savedPanel() };
    const controls = new Map<string, WorkspaceHistoryPanel>([['first', { chartApi: null, drawingEngine: null }]]);
    expect(workspacePanelsReady(snapshots, controls)).toBe(false);
    controls.set('first', { drawingEngine: new DrawingEngine(), chartApi: {} as WorkspaceHistoryPanel['chartApi'] });
    expect(workspacePanelsReady(snapshots, controls)).toBe(true);
    expect(workspacePanelsReady({ second: savedPanel() }, controls)).toBe(false);
  });

  it('retains saved drawings for lazy tabs and drops panels actually removed from the layout', () => {
    const layout = { tree: { layout: { type: 'row', children: [{ type: 'tabset', children: [{ type: 'tab', id: 'visible' }, { type: 'tab', id: 'lazy' }] }] } } };
    const live = { visible: savedPanel('edited'), lazy: { ...savedPanel(), drawings: [] } };
    const pending = { lazy: savedPanel('unrestored'), removed: savedPanel('removed') };
    const merged = mergeWorkspacePanelSnapshots(live, pending, workspaceLayoutPanelIds(layout));
    expect(Object.keys(merged)).toEqual(['visible', 'lazy']);
    expect(merged.visible.drawings[0].id).toBe('edited');
    expect(merged.lazy.drawings[0].id).toBe('unrestored');
  });
});
