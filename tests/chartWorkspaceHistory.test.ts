import { DrawingEngine, type Drawing } from '@getcandlekit/charts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChartWorkspaceHistory,
  type WorkspaceHistoryPanel,
  type WorkspaceIndicatorState,
} from '../services/chartWorkspaceHistory';

const drawing = (id: string): Drawing => ({
  id,
  tool: 'TrendLine',
  points: [{ time: 1, price: 100 }, { time: 2, price: 101 }],
  style: { color: '#000', width: 1, dashed: false, fill: null },
});

const panel = () => {
  const engine = new DrawingEngine();
  let logicalRange = { from: 0, to: 10 };
  let priceRange = { from: 90, to: 110 };
  let autoScale = false;
  const rangeListeners = new Set<() => void>();
  let indicators: WorkspaceIndicatorState = {
    custom: { fvg: false, levels: false, structure: false },
    library: [],
  };
  const chart = {
    timeScale: () => ({
      getVisibleLogicalRange: () => logicalRange,
      setVisibleLogicalRange: (range: typeof logicalRange) => { logicalRange = { ...range }; rangeListeners.forEach(listener => listener()); },
      subscribeVisibleLogicalRangeChange: (listener: () => void) => { rangeListeners.add(listener); },
      unsubscribeVisibleLogicalRangeChange: (listener: () => void) => { rangeListeners.delete(listener); },
    }),
    priceScale: () => ({
      getVisibleRange: () => priceRange,
      setVisibleRange: (range: typeof priceRange) => { priceRange = { ...range }; },
      setAutoScale: (enabled: boolean) => { autoScale = enabled; },
      options: () => ({ autoScale }),
    }),
  };
  return {
    control: {
      drawingEngine: engine,
      chartApi: { controller: { getChart: () => chart } },
      getIndicatorState: () => indicators,
      applyIndicatorState: (state: WorkspaceIndicatorState) => { indicators = structuredClone(state); },
    } as WorkspaceHistoryPanel,
    engine,
    move: (range: typeof logicalRange) => { logicalRange = { ...range }; rangeListeners.forEach(listener => listener()); },
    getLogicalRange: () => logicalRange,
    getIndicators: () => indicators,
    setIndicators: (state: WorkspaceIndicatorState) => { indicators = structuredClone(state); },
  };
};

describe('chart workspace history', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('undoes drawing changes chronologically across different graphs', () => {
    const first = panel();
    const second = panel();
    const history = new ChartWorkspaceHistory();
    history.updatePanels(new Map([['first', first.control], ['second', second.control]]));

    first.engine.commit(drawing('first-drawing'));
    vi.advanceTimersByTime(120);
    second.engine.commit(drawing('second-drawing'));
    vi.advanceTimersByTime(120);

    history.undo();
    expect(second.engine.getById('second-drawing')).toBeUndefined();
    expect(first.engine.getById('first-drawing')).toBeDefined();
    history.undo();
    expect(first.engine.getById('first-drawing')).toBeUndefined();
  });

  it('undoes and redoes style changes made from the drawing toolbar', () => {
    const first = panel();
    first.engine.commit(drawing('styled-drawing'));
    const history = new ChartWorkspaceHistory();
    history.updatePanels(new Map([['first', first.control]]));
    first.engine.select('styled-drawing');

    first.engine.setStyle('styled-drawing', {
      color: '#2962ff80',
      width: 4,
      dashed: true,
    });
    vi.advanceTimersByTime(120);

    history.undo();
    expect(first.engine.getById('styled-drawing')?.style).toMatchObject({
      color: '#000',
      width: 1,
      dashed: false,
    });
    expect(first.engine.getSelectedId()).toBe('styled-drawing');

    history.redo();
    expect(first.engine.getById('styled-drawing')?.style).toMatchObject({
      color: '#2962ff80',
      width: 4,
      dashed: true,
    });
    expect(first.engine.getSelectedId()).toBe('styled-drawing');
  });

  it('undoes and redoes chart movement', () => {
    const first = panel();
    const history = new ChartWorkspaceHistory();
    history.updatePanels(new Map([['first', first.control]]));

    first.move({ from: 5, to: 15 });
    vi.advanceTimersByTime(120);
    history.undo();
    expect(first.getLogicalRange()).toEqual({ from: 0, to: 10 });
    history.redo();
    expect(first.getLogicalRange()).toEqual({ from: 5, to: 15 });
  });

  it('captures a large visible-range burst only once after the gesture settles', () => {
    const first = panel();
    const history = new ChartWorkspaceHistory();
    history.updatePanels(new Map([['first', first.control]]));
    const drawingReads = vi.spyOn(first.engine, 'getDrawings');
    const stateListener = vi.fn();
    history.subscribe(stateListener);
    drawingReads.mockClear();

    for (let index = 1; index <= 200; index += 1) {
      first.move({ from: index, to: index + 10 });
    }

    expect(drawingReads).not.toHaveBeenCalled();
    vi.advanceTimersByTime(159);
    expect(drawingReads).not.toHaveBeenCalled();
    // Zklidnění gesta (160 ms) jen zaregistruje rozpracovanou změnu; jediný
    // drahý snapshot proběhne až s commitem po COMMIT_DELAY_MS.
    vi.advanceTimersByTime(1);
    expect(drawingReads).not.toHaveBeenCalled();
    expect(stateListener).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(120);
    expect(drawingReads).toHaveBeenCalledTimes(1);

    history.undo();
    expect(first.getLogicalRange()).toEqual({ from: 0, to: 10 });
    expect(history.getState().canUndo).toBe(false);

    history.redo();
    expect(first.getLogicalRange()).toEqual({ from: 200, to: 210 });
  });

  it('keeps a pending gesture when panel controls are registered again', () => {
    const first = panel();
    const history = new ChartWorkspaceHistory();
    const panels = new Map([['first', first.control]]);
    history.updatePanels(panels);

    first.move({ from: 3, to: 13 });
    history.updatePanels(new Map(panels));
    history.undo();

    expect(first.getLogicalRange()).toEqual({ from: 0, to: 10 });
  });

  it('undoes indicator removal with the original library parameters', () => {
    const first = panel();
    const enabled: WorkspaceIndicatorState = {
      custom: { fvg: true, levels: false, structure: true },
      library: [{ name: 'EMA', params: { length: 21, color: '#2962ff' } }],
    };
    first.setIndicators(enabled);
    const history = new ChartWorkspaceHistory();
    history.updatePanels(new Map([['first', first.control]]));

    first.setIndicators({
      custom: { fvg: false, levels: false, structure: false },
      library: [],
    });
    history.updatePanels(new Map([['first', first.control]]));
    vi.advanceTimersByTime(120);

    history.undo();
    expect(first.getIndicators()).toEqual(enabled);
    history.redo();
    expect(first.getIndicators()).toEqual({
      custom: { fvg: false, levels: false, structure: false },
      library: [],
    });
  });

  it('coalesces drawing and indicator removal into one Undo step', () => {
    const first = panel();
    first.engine.commit(drawing('combined-drawing'));
    first.setIndicators({
      custom: { fvg: true, levels: true, structure: false },
      library: [{ name: 'RSI', params: { length: 14 } }],
    });
    const history = new ChartWorkspaceHistory();
    const panels = new Map([['first', first.control]]);
    history.updatePanels(panels);

    first.engine.remove('combined-drawing');
    first.setIndicators({
      custom: { fvg: false, levels: false, structure: false },
      library: [],
    });
    history.updatePanels(new Map(panels));
    vi.advanceTimersByTime(120);

    expect(history.getState().undoLabel).toBe('odstranění kreseb a indikátorů');
    history.undo();
    expect(first.engine.getById('combined-drawing')).toBeDefined();
    expect(first.getIndicators()).toEqual({
      custom: { fvg: true, levels: true, structure: false },
      library: [{ name: 'RSI', params: { length: 14 } }],
    });
    expect(history.getState().canUndo).toBe(false);
  });
});
