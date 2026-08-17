import type { Drawing, DrawingEngine } from '@getcandlekit/charts';

interface LogicalRangeLike { from: number; to: number }
interface PriceRangeLike { from: number; to: number }

interface TimeScaleLike {
  getVisibleLogicalRange: () => LogicalRangeLike | null;
  setVisibleLogicalRange: (range: LogicalRangeLike) => void;
  subscribeVisibleLogicalRangeChange: (listener: () => void) => void;
  unsubscribeVisibleLogicalRangeChange: (listener: () => void) => void;
}

interface PriceScaleLike {
  getVisibleRange: () => PriceRangeLike | null;
  setVisibleRange: (range: PriceRangeLike) => void;
  setAutoScale: (enabled: boolean) => void;
  options: () => { autoScale?: boolean };
}

interface ChartLike {
  timeScale: () => TimeScaleLike;
  priceScale: (id: 'right') => PriceScaleLike;
}

interface ChartApiLike {
  controller: { getChart: () => ChartLike };
}

export interface WorkspaceHistoryPanel {
  drawingEngine: DrawingEngine | null;
  chartApi: ChartApiLike | null;
  getIndicatorState?: () => WorkspaceIndicatorState;
  applyIndicatorState?: (state: WorkspaceIndicatorState) => void;
}

export interface WorkspaceIndicatorState {
  custom: {
    fvg: boolean;
    levels: boolean;
    structure: boolean;
  };
  library: Array<{
    name: string;
    params: Record<string, unknown>;
  }>;
}

export interface WorkspacePanelSnapshot {
  drawings: Drawing[];
  logicalRange: LogicalRangeLike | null;
  priceRange: PriceRangeLike | null;
  autoScale: boolean;
  indicators: WorkspaceIndicatorState | null;
}

export type WorkspaceSnapshot = Record<string, WorkspacePanelSnapshot>;

interface HistoryEntry {
  snapshot: WorkspaceSnapshot;
  label: string;
}

/**
 * Rozpracované gesto. Snapshot je záměrně líný (`null` = spočítat až při
 * commitu): tažení kresby emituje change na každý pohyb myši a replay
 * re-registruje panely na každý tik — okamžitý snapshot celého workspace
 * s JSON porovnáním v obou případech platil O(události × velikost workspace).
 * `label: null` znamená „odvoď z diffu při commitu", ať přesné popisky Undo
 * (kresby vs. indikátory) zůstanou zachované.
 */
interface PendingGesture {
  snapshot: WorkspaceSnapshot | null;
  label: string | null;
}

export interface ChartWorkspaceHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
}

const MAX_HISTORY = 100;
const COMMIT_DELAY_MS = 120;
const RANGE_CAPTURE_DELAY_MS = 160;
const RANGE_PRECISION = 1_000_000;

const normalizeNumber = (value: number) => Math.round(value * RANGE_PRECISION) / RANGE_PRECISION;
const normalizeRange = <T extends LogicalRangeLike | PriceRangeLike>(range: T | null): T | null => range ? ({
  from: normalizeNumber(range.from),
  to: normalizeNumber(range.to),
} as T) : null;

const cloneDrawings = (drawings: readonly Drawing[]): Drawing[] => drawings.map(drawing => ({
  ...drawing,
  points: drawing.points.map(point => ({ ...point })),
  style: { ...drawing.style },
}));

const cloneUnknownRecord = (value: Record<string, unknown>): Record<string, unknown> => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
};

const cloneIndicatorState = (state: WorkspaceIndicatorState | null): WorkspaceIndicatorState | null => state ? ({
  custom: { ...state.custom },
  library: state.library.map(indicator => ({
    name: indicator.name,
    params: cloneUnknownRecord(indicator.params),
  })),
}) : null;

const cloneSnapshot = (snapshot: WorkspaceSnapshot): WorkspaceSnapshot => Object.fromEntries(
  Object.entries(snapshot).map(([id, panel]) => [id, {
    drawings: cloneDrawings(panel.drawings),
    logicalRange: panel.logicalRange ? { ...panel.logicalRange } : null,
    priceRange: panel.priceRange ? { ...panel.priceRange } : null,
    autoScale: panel.autoScale,
    indicators: cloneIndicatorState(panel.indicators),
  }]),
);

const sameSnapshot = (left: WorkspaceSnapshot, right: WorkspaceSnapshot) => JSON.stringify(left) === JSON.stringify(right);

export class ChartWorkspaceHistory {
  private panels = new Map<string, WorkspaceHistoryPanel>();
  private subscriptions = new Map<string, () => void>();
  private current: WorkspaceSnapshot = {};
  private pending: PendingGesture | null = null;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rangeCaptureTimer: ReturnType<typeof setTimeout> | null = null;
  private rangeCaptureFrame: number | null = null;
  private rangeCaptureLabel: string | null = null;
  private applying = false;
  private listeners = new Set<(state: ChartWorkspaceHistoryState) => void>();
  private lastEmittedState: ChartWorkspaceHistoryState | null = null;

  updatePanels = (panels: Map<string, WorkspaceHistoryPanel>) => {
    const sameRuntime = this.panels.size === panels.size
      && [...panels.entries()].every(([id, panel]) => {
        const current = this.panels.get(id);
        return current?.drawingEngine === panel.drawingEngine && current?.chartApi === panel.chartApi;
      });

    // A chart remount establishes a fresh runtime baseline. A regular panel
    // registration, however, is also how React reports indicator changes. Keep
    // those inside the same coalescing window as a simultaneous drawing delete
    // so "remove drawings & indicators" becomes one Undo step.
    if (!sameRuntime) this.flush();
    this.panels = new Map(panels);
    if (!sameRuntime) this.subscribePanels();

    if (!sameRuntime || this.applying) {
      // Panel creation/remount establishes the baseline for the new chart API;
      // already committed workspace history remains intact.
      this.current = this.snapshot();
    } else {
      // Běžná re-registrace (React ji hlásí i na každý replay tik) jen natáhne
      // levný timer; jestli se něco doopravdy změnilo, zjistí jediný snapshot
      // při commitu. Label se tam odvodí z diffu, proto tu zůstává `null`.
      this.pending = { snapshot: null, label: this.pending?.label ?? null };
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(this.flush, COMMIT_DELAY_MS);
    }
    this.emit();
  };

  capture = (label: string) => {
    if (this.applying) return;
    // Snapshot se tady záměrně nepočítá — tažení kresby volá capture na každý
    // pohyb myši. Commit po zklidnění gesta si stav přečte jednou.
    this.pending = { snapshot: null, label };
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(this.flush, COMMIT_DELAY_MS);
    this.emit();
  };

  captureAfterEvent = (label: string) => {
    // Price-wheel updates are intentionally rendered in requestAnimationFrame.
    // Read the workspace only after that paint, otherwise the history records
    // the state from before the wheel event and Undo appears to do nothing.
    this.scheduleRangeCapture(label, true);
  };

  getState = (): ChartWorkspaceHistoryState => ({
    canUndo: this.pending !== null || this.undoStack.length > 0,
    canRedo: this.redoStack.length > 0,
    undoLabel: this.pending ? (this.pending.label ?? 'změnu workspace') : this.undoStack.at(-1)?.label,
    redoLabel: this.redoStack.at(-1)?.label,
  });

  subscribe = (listener: (state: ChartWorkspaceHistoryState) => void) => {
    this.listeners.add(listener);
    listener(this.getState());
    return () => { this.listeners.delete(listener); };
  };

  /** Durable session checkpoint (drawings, indicators and both chart scales). */
  exportSnapshot = (): WorkspaceSnapshot => {
    this.flush();
    this.current = this.snapshot();
    return cloneSnapshot(this.current);
  };

  /** Restores a durable checkpoint without adding an Undo entry. */
  importSnapshot = (snapshot: WorkspaceSnapshot) => {
    this.flush();
    this.undoStack = [];
    this.redoStack = [];
    this.apply(cloneSnapshot(snapshot));
  };

  undo = () => {
    this.flush();
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.redoStack.push({ snapshot: cloneSnapshot(this.current), label: entry.label });
    this.apply(entry.snapshot);
  };

  redo = () => {
    this.flush();
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push({ snapshot: cloneSnapshot(this.current), label: entry.label });
    this.apply(entry.snapshot);
  };

  private snapshot = (): WorkspaceSnapshot => Object.fromEntries(
    [...this.panels.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, panel]) => {
      let logicalRange: LogicalRangeLike | null = null;
      let priceRange: PriceRangeLike | null = null;
      let autoScale = true;
      try {
        const chart = panel.chartApi?.controller.getChart();
        const priceScale = chart?.priceScale('right');
        logicalRange = normalizeRange(chart?.timeScale().getVisibleLogicalRange() ?? null);
        autoScale = priceScale?.options().autoScale !== false;
        // With autoscale enabled the visible price range is derived from the
        // logical range and changes by tiny amounts during every pan. Storing it
        // would create phantom history entries that cannot be restored directly.
        priceRange = autoScale ? null : normalizeRange(priceScale?.getVisibleRange() ?? null);
      } catch {
        // A panel registration may briefly still reference a chart destroyed by
        // a timeframe/layout remount. Drawings remain safe to snapshot below.
      }
      return [id, {
        drawings: cloneDrawings(panel.drawingEngine?.getDrawings().filter(drawing => !drawing.id.startsWith('auto-')) ?? []),
        logicalRange,
        priceRange,
        autoScale,
        indicators: cloneIndicatorState(panel.getIndicatorState?.() ?? null),
      }];
    }),
  );

  private subscribePanels = () => {
    this.subscriptions.forEach(cleanup => cleanup());
    this.subscriptions.clear();
    this.panels.forEach((panel, id) => {
      const cleanups: Array<() => void> = [];
      if (panel.drawingEngine) {
        cleanups.push(panel.drawingEngine.onChange(() => this.capture('změnu kresby')));
      }
      if (panel.chartApi) {
        const timeScale = panel.chartApi.controller.getChart().timeScale();
        const listener = () => this.scheduleRangeCapture('posun nebo časové měřítko grafu');
        timeScale.subscribeVisibleLogicalRangeChange(listener);
        cleanups.push(() => timeScale.unsubscribeVisibleLogicalRangeChange(listener));
      }
      this.subscriptions.set(id, () => cleanups.forEach(cleanup => cleanup()));
    });
  };

  /**
   * Lightweight Charts emits a visible-range callback for every animation and
   * wheel step. Snapshotting the whole workspace in that callback made a long
   * pan O(events * workspace size). Keep the pre-gesture state in `current`
   * and read the final chart state once after the gesture becomes idle.
   */
  private scheduleRangeCapture = (label: string, afterPaint = false) => {
    if (this.applying) return;
    this.rangeCaptureLabel = label;

    const armTimer = () => {
      if (this.rangeCaptureTimer !== null) clearTimeout(this.rangeCaptureTimer);
      this.rangeCaptureTimer = setTimeout(() => {
        this.rangeCaptureTimer = null;
        const captureLabel = this.rangeCaptureLabel;
        this.rangeCaptureLabel = null;
        if (captureLabel) this.capture(captureLabel);
      }, RANGE_CAPTURE_DELAY_MS);
    };

    if (afterPaint && typeof requestAnimationFrame === 'function') {
      if (this.rangeCaptureFrame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.rangeCaptureFrame);
      }
      this.rangeCaptureFrame = requestAnimationFrame(() => {
        this.rangeCaptureFrame = null;
        armTimer();
      });
      return;
    }
    armTimer();
  };

  private captureScheduledRange = () => {
    if (this.rangeCaptureFrame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rangeCaptureFrame);
      this.rangeCaptureFrame = null;
    }
    if (this.rangeCaptureTimer !== null) {
      clearTimeout(this.rangeCaptureTimer);
      this.rangeCaptureTimer = null;
    }
    const label = this.rangeCaptureLabel;
    this.rangeCaptureLabel = null;
    if (label) this.capture(label);
  };

  private flush = () => {
    this.captureScheduledRange();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    const entry = this.pending;
    this.pending = null;
    const next = entry.snapshot ?? this.snapshot();
    if (!sameSnapshot(next, this.current)) {
      this.undoStack.push({
        snapshot: cloneSnapshot(this.current),
        label: this.labelFromDiff(next, entry.label),
      });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.current = cloneSnapshot(next);
      this.redoStack = [];
    }
    this.emit();
  };

  /**
   * Popisek Undo odvozený z diffu při commitu — stejná pravidla, jaká dřív
   * počítal updatePanels na každou registraci. Explicitní label gesta
   * („změnu kresby", „posun…") je fallback, když diff nic přesnějšího neřekne.
   */
  private labelFromDiff = (next: WorkspaceSnapshot, explicit: string | null): string => {
    const section = (source: WorkspaceSnapshot, key: 'drawings' | 'indicators') => JSON.stringify(
      Object.fromEntries(Object.entries(source).map(([id, state]) => [id, state[key]])),
    );
    const drawingsChanged = section(this.current, 'drawings') !== section(next, 'drawings');
    const indicatorsChanged = section(this.current, 'indicators') !== section(next, 'indicators');
    if (drawingsChanged && indicatorsChanged) return 'odstranění kreseb a indikátorů';
    if (indicatorsChanged) return 'změnu indikátorů';
    return explicit ?? 'změnu workspace';
  };

  private apply = (snapshot: WorkspaceSnapshot) => {
    this.applying = true;
    try {
      this.panels.forEach((panel, id) => {
        const state = snapshot[id];
        if (!state) return;
        try {
          if (panel.drawingEngine) {
            const selectedId = panel.drawingEngine.getSelectedId();
            const automatic = cloneDrawings(panel.drawingEngine.getDrawings().filter(drawing => drawing.id.startsWith('auto-')));
            panel.drawingEngine.import(JSON.stringify([...automatic, ...cloneDrawings(state.drawings)]));
            panel.drawingEngine.select(selectedId && panel.drawingEngine.getById(selectedId) ? selectedId : null);
          }
        } catch {
          // Continue restoring the other panels if one engine was remounted.
        }
        try {
          if (state.indicators) panel.applyIndicatorState?.(cloneIndicatorState(state.indicators)!);
        } catch {
          // A missing indicator definition must not prevent drawings or ranges
          // from being restored in the remaining panels.
        }
        try {
          const chart = panel.chartApi?.controller.getChart();
          if (!chart) return;
          if (state.logicalRange) chart.timeScale().setVisibleLogicalRange(state.logicalRange);
          const priceScale = chart.priceScale('right');
          if (state.autoScale) priceScale.setAutoScale(true);
          else if (state.priceRange) {
            priceScale.setAutoScale(false);
            priceScale.setVisibleRange(state.priceRange);
          }
        } catch {
          // A stale chart must not prevent Undo in all remaining graphs.
        }
      });
      this.current = cloneSnapshot(snapshot);
      this.pending = null;
    } finally {
      this.applying = false;
    }
    this.emit();
  };

  private emit = () => {
    const state = this.getState();
    if (this.lastEmittedState
      && this.lastEmittedState.canUndo === state.canUndo
      && this.lastEmittedState.canRedo === state.canRedo
      && this.lastEmittedState.undoLabel === state.undoLabel
      && this.lastEmittedState.redoLabel === state.redoLabel) return;
    this.lastEmittedState = { ...state };
    this.listeners.forEach(listener => listener(state));
  };
}
