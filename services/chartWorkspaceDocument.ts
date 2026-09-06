import { validateWorkspaceAppearance, validateWorkspaceDrawingStyle } from './chartWorkspaceAppearanceValidation';
import type { ChartAppearanceState } from './chartAppearanceScope';
import type { WorkspaceSnapshot } from './chartWorkspaceHistory';
import { CHART_WORKSPACE_LAYOUTS, type ChartWorkspaceLayoutId } from './chartWorkspaceLayouts';
import type { ChartWorkspaceSyncSettings } from './chartWorkspaceSync';

export interface CompleteChartWorkspaceState {
  layout: unknown;
  panels: WorkspaceSnapshot;
  layoutId: ChartWorkspaceLayoutId;
  activePanelId: string;
  syncSettings: ChartWorkspaceSyncSettings;
  appearance: ChartAppearanceState;
}
export interface ChartWorkspaceDocument {
  format: 'alphatrade-workspace';
  version: 1;
  state: CompleteChartWorkspaceState;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fail = (): never => { throw new Error('Soubor neobsahuje platný workspace. Současné rozložení zůstalo zachováno.'); };
const range = (value: unknown) => value === null || (record(value) && Number.isFinite(value.from) && Number.isFinite(value.to) && Number(value.from) <= Number(value.to));

export interface ChartWorkspaceImportOptions { allowedRoots?: readonly string[] }

/** Validate before calling CandleKit: its import accepts malformed objects. */
export const validateChartWorkspaceLayout = (value: unknown, options: ChartWorkspaceImportOptions = {}): Set<string> => {
  if (!record(value) || value.version !== 1 || !record(value.tree) || !record(value.tree.layout) || value.tree.layout.type !== 'row') return fail();
  if (value.tree.global !== undefined && !record(value.tree.global)) return fail();
  const ids = new Set<string>();
  const allIds = new Set<string>();
  const visit = (node: unknown, depth: number, parent?: string) => {
    if (!record(node) || depth > 40) return fail();
    if (node.name !== undefined && typeof node.name !== 'string') return fail();
    if (node.id !== undefined) {
      if (typeof node.id !== 'string' || !node.id || allIds.has(node.id)) return fail();
      allIds.add(node.id);
    }
    if (node.type === 'tab') {
      if (parent !== 'tabset' || typeof node.id !== 'string' || node.component !== 'alphatrade-chart' || !record(node.config)) return fail();
      const instance = node.config;
      if (instance.id !== node.id || instance.kind !== 'alphatrade-chart' || !record(instance.config)) return fail();
      if (instance.title !== undefined && typeof instance.title !== 'string') return fail();
      const config = instance.config;
      if (!['MNQ', 'NQ'].includes(String(config.root)) || !['1m', '5m', '15m', '30m', '1h', '4h', '1d'].includes(String(config.timeframe))) return fail();
      if (options.allowedRoots && !options.allowedRoots.includes(String(config.root))) throw new Error(`Instrument ${config.root} není v této session povolen. Současné rozložení zůstalo zachováno.`);
      if (!['showFvg', 'showLevels', 'showStructure'].every(key => config[key] === undefined || typeof config[key] === 'boolean')) return fail();
      ids.add(node.id);
      return;
    }
    if ((node.type !== 'row' && node.type !== 'tabset') || !Array.isArray(node.children)) return fail();
    if (parent === 'tabset') return fail();
    node.children.forEach(child => visit(child, depth + 1, String(node.type)));
  };
  visit(value.tree.layout, 0);
  if (!ids.size || (value.tree.borders !== undefined && (!Array.isArray(value.tree.borders) || value.tree.borders.length > 0))) return fail();
  return ids;
};

const validateState = (value: unknown, options: ChartWorkspaceImportOptions = {}): CompleteChartWorkspaceState => {
  if (!record(value)) return fail();
  const ids = validateChartWorkspaceLayout(value.layout, options);
  if (!record(value.panels) || typeof value.layoutId !== 'string' || !CHART_WORKSPACE_LAYOUTS.some(template => template.id === value.layoutId)) return fail();
  if (typeof value.activePanelId !== 'string' || (value.activePanelId && !ids.has(value.activePanelId))) return fail();
  const sync = value.syncSettings;
  if (!record(sync) || !['symbol', 'interval', 'crosshair', 'time', 'dateRange', 'drawings'].every(key => typeof sync[key] === 'boolean')) return fail();
  validateWorkspaceAppearance(value.appearance);
  for (const [id, panel] of Object.entries(value.panels)) {
    if (!ids.has(id) || !record(panel) || !Array.isArray(panel.drawings) || !range(panel.logicalRange) || !range(panel.priceRange) || typeof panel.autoScale !== 'boolean') return fail();
    const drawingIds = new Set<string>();
    for (const drawing of panel.drawings) {
      if (!record(drawing) || typeof drawing.id !== 'string' || !drawing.id || drawingIds.has(drawing.id) || typeof drawing.tool !== 'string' || !drawing.tool || !Array.isArray(drawing.points) || !record(drawing.style)) return fail();
      drawingIds.add(drawing.id);
      validateWorkspaceDrawingStyle(drawing.style);
      if (!drawing.points.every(point => record(point) && Number.isFinite(point.time) && Number.isFinite(point.price))) return fail();
      if (typeof drawing.style.color !== 'string' || !Number.isFinite(drawing.style.width) || typeof drawing.style.dashed !== 'boolean') return fail();
    }
    if (panel.indicators !== null) {
      const indicators = panel.indicators;
      if (!record(indicators) || !record(indicators.custom) || !Array.isArray(indicators.library)) return fail();
      const custom = indicators.custom;
      if (!['fvg', 'levels', 'structure'].every(key => typeof custom[key] === 'boolean')) return fail();
      if (!indicators.library.every(item => record(item) && typeof item.name === 'string' && record(item.params))) return fail();
    }
  }
  return structuredClone(value) as unknown as CompleteChartWorkspaceState;
};

export const createChartWorkspaceDocument = (state: CompleteChartWorkspaceState, options: ChartWorkspaceImportOptions = {}): ChartWorkspaceDocument => ({
  format: 'alphatrade-workspace', version: 1, state: validateState(state, options),
});

export const parseChartWorkspaceDocument = (input: unknown, options: ChartWorkspaceImportOptions = {}): { kind: 'complete'; document: ChartWorkspaceDocument } | { kind: 'legacy'; layout: unknown } => {
  let value = input;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return fail(); } }
  if (record(value) && value.format === 'alphatrade-workspace') {
    if (value.version !== 1) return fail();
    return { kind: 'complete', document: createChartWorkspaceDocument(value.state as CompleteChartWorkspaceState, options) };
  }
  validateChartWorkspaceLayout(value, options);
  return { kind: 'legacy', layout: structuredClone(value) };
};

export const chartWorkspaceDocumentStorageKey = (owner: string | null | undefined, sessionId?: string) => {
  if (owner === undefined) throw new Error('Počkej na ověření přihlášeného účtu.');
  return `alphatrade:workspace-document:v1:${owner === null ? 'guest' : `user:${owner}`}:${sessionId ?? 'market'}`;
};

export const summarizeWorkspaceDocument = (input: unknown) => {
  const parsed = parseChartWorkspaceDocument(input);
  const layout = parsed.kind === 'complete' ? parsed.document.state.layout : parsed.layout;
  const roots = new Set<string>();
  const walk = (node: unknown): void => {
    if (!record(node)) return;
    if (record(node.config) && record(node.config.config)) roots.add(String(node.config.config.root));
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk((layout as { tree: { layout: unknown } }).tree.layout);
  const panels = parsed.kind === 'complete' ? Object.values(parsed.document.state.panels) : [];
  return { kind: parsed.kind, panels: validateChartWorkspaceLayout(layout).size, roots: [...roots], drawings: panels.reduce((sum, panel) => sum + panel.drawings.length, 0), indicators: panels.reduce((sum, panel) => sum + (panel.indicators?.library.length ?? 0) + Object.values(panel.indicators?.custom ?? {}).filter(Boolean).length, 0) };
};

/** Persist the recovery checkpoint before invoking any chart mutation. */
export const storeWorkspaceRecovery = (owner: string | null | undefined, sessionId: string | undefined, before: CompleteChartWorkspaceState, storage: Pick<Storage, 'setItem'>): void => {
  storage.setItem(`${chartWorkspaceDocumentStorageKey(owner, sessionId)}:recovery`, JSON.stringify(createChartWorkspaceDocument(before)));
};
