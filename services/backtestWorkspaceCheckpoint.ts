import type { BacktestWorkspaceState } from './backtestTypes';
import type { WorkspaceHistoryPanel, WorkspaceSnapshot } from './chartWorkspaceHistory';

/** A registration can precede creation of the chart and its drawing engine. */
export const workspacePanelsReady = (
  snapshot: WorkspaceSnapshot,
  panels: ReadonlyMap<string, WorkspaceHistoryPanel>,
): boolean => Object.keys(snapshot).every(id => {
  const panel = panels.get(id);
  return Boolean(panel?.chartApi && panel.drawingEngine);
});

export const workspaceLayoutPanelIds = (layout: unknown): Set<string> => {
  const ids = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const value = node as Record<string, unknown>;
    if (value.type === 'tab' && typeof value.id === 'string') ids.add(value.id);
    if (Array.isArray(value.children)) value.children.forEach(visit);
  };
  const tree = (layout as { tree?: { layout?: unknown } } | null)?.tree;
  visit(tree?.layout);
  return ids;
};

/** Hidden/lazy tabs keep their saved state until their chart can restore it. */
export const mergeWorkspacePanelSnapshots = (
  live: WorkspaceSnapshot,
  pending: WorkspaceSnapshot,
  panelIds: ReadonlySet<string>,
): WorkspaceSnapshot => Object.fromEntries(
  Object.entries({ ...live, ...pending }).filter(([id]) => panelIds.has(id)),
);

/** Capture reads live controls synchronously, including edits since the timer. */
export const createBacktestWorkspaceCheckpoint = <T extends BacktestWorkspaceState>(
  read: () => T | undefined,
  write: (state: T) => void,
): (() => void) => {
  let previous = '';
  return () => {
    const state = read();
    // During restoration the saved snapshot remains authoritative.
    if (!state) return;
    const layout = state.layout && typeof state.layout === 'object'
      ? { ...state.layout, updatedAt: undefined }
      : state.layout;
    // CandleKit stamps every export, even when no layout data has changed.
    const fingerprint = JSON.stringify({ ...state, layout });
    if (fingerprint === previous) return;
    write(state);
    previous = fingerprint;
  };
};
