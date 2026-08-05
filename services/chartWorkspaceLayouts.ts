export type ChartWorkspaceLayoutId =
  | '1'
  | '2h' | '2v'
  | '3h' | '3v' | '3s' | '3r' | '2-1' | '1-2'
  | '4' | '4v' | '4h' | '4s' | '4s-l' | '1-3' | '3-1' | '2-2-l' | '2-2-r' | '2-2';

type Direction = 'horizontal' | 'vertical';

interface LayoutLeaf {
  panel: number;
  weight?: number;
}

interface LayoutSplit {
  direction: Direction;
  children: LayoutSpec[];
  weight?: number;
}

type LayoutSpec = LayoutLeaf | LayoutSplit;

export interface ChartWorkspaceLayoutCell {
  panel: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChartWorkspaceLayoutTemplate {
  id: ChartWorkspaceLayoutId;
  row: 1 | 2 | 3 | 4;
  panelCount: number;
  cells: ChartWorkspaceLayoutCell[];
}

const leaf = (panel: number, weight?: number): LayoutLeaf => ({ panel, weight });
const horizontal = (...children: LayoutSpec[]): LayoutSplit => ({ direction: 'horizontal', children });
const vertical = (...children: LayoutSpec[]): LayoutSplit => ({ direction: 'vertical', children });
const weighted = <T extends LayoutSpec>(node: T, weight: number): T => ({ ...node, weight });

const specs: Record<ChartWorkspaceLayoutId, LayoutSplit> = {
  '1': horizontal(leaf(1)),
  '2h': horizontal(leaf(1), leaf(2)),
  '2v': vertical(leaf(1), leaf(2)),
  '3h': horizontal(leaf(1), leaf(2), leaf(3)),
  '3v': vertical(leaf(1), leaf(2), leaf(3)),
  '3s': horizontal(weighted(leaf(1), 2), vertical(leaf(2), leaf(3))),
  '3r': horizontal(vertical(leaf(1), leaf(2)), weighted(leaf(3), 2)),
  '2-1': vertical(horizontal(leaf(1), leaf(2)), leaf(3)),
  '1-2': vertical(leaf(1), horizontal(leaf(2), leaf(3))),
  '4': horizontal(vertical(leaf(1), leaf(3)), vertical(leaf(2), leaf(4))),
  '4v': horizontal(leaf(1), leaf(2), leaf(3), leaf(4)),
  '4h': vertical(leaf(1), leaf(2), leaf(3), leaf(4)),
  '4s': horizontal(weighted(leaf(1), 2), vertical(leaf(2), leaf(3), leaf(4))),
  '4s-l': horizontal(vertical(leaf(1), leaf(2), leaf(3)), weighted(leaf(4), 2)),
  '1-3': vertical(leaf(1), horizontal(leaf(2), leaf(3), leaf(4))),
  '3-1': vertical(horizontal(leaf(1), leaf(2), leaf(3)), leaf(4)),
  '2-2-l': horizontal(weighted(vertical(leaf(1), leaf(2)), 2), vertical(leaf(3), leaf(4))),
  '2-2-r': horizontal(vertical(leaf(1), leaf(2)), weighted(vertical(leaf(3), leaf(4)), 2)),
  '2-2': vertical(horizontal(leaf(1), leaf(2)), horizontal(leaf(3), leaf(4))),
};

const panelCount = (spec: LayoutSpec): number => (
  'panel' in spec ? spec.panel : Math.max(...spec.children.map(panelCount))
);

const collectCells = (
  spec: LayoutSpec,
  rect = { x: 0, y: 0, width: 1, height: 1 },
): ChartWorkspaceLayoutCell[] => {
  if ('panel' in spec) return [{ panel: spec.panel, ...rect }];
  const weights = spec.children.map(child => child.weight ?? 1);
  const total = weights.reduce((sum, value) => sum + value, 0);
  let offset = 0;
  return spec.children.flatMap((child, index) => {
    const ratio = weights[index] / total;
    const childRect = spec.direction === 'horizontal'
      ? { x: rect.x + rect.width * offset, y: rect.y, width: rect.width * ratio, height: rect.height }
      : { x: rect.x, y: rect.y + rect.height * offset, width: rect.width, height: rect.height * ratio };
    offset += ratio;
    return collectCells(child, childRect);
  });
};

const orderedIds: ChartWorkspaceLayoutId[][] = [
  ['1'],
  ['2h', '2v'],
  ['3h', '3v', '3s', '3r', '2-1', '1-2'],
  ['4', '4v', '4h', '4s', '4s-l', '1-3', '3-1', '2-2-l', '2-2-r', '2-2'],
];

export const CHART_WORKSPACE_LAYOUT_ROWS: ChartWorkspaceLayoutTemplate[][] = orderedIds.map((ids, index) => (
  ids.map(id => ({
    id,
    row: (index + 1) as 1 | 2 | 3 | 4,
    panelCount: panelCount(specs[id]),
    cells: collectCells(specs[id]),
  }))
));

export const CHART_WORKSPACE_LAYOUTS = CHART_WORKSPACE_LAYOUT_ROWS.flat();

export const getChartWorkspaceLayout = (id: ChartWorkspaceLayoutId) => (
  CHART_WORKSPACE_LAYOUTS.find(template => template.id === id) ?? CHART_WORKSPACE_LAYOUTS[0]
);

interface BuildWorkspaceLayoutOptions<TConfig extends Record<string, unknown>> {
  id: ChartWorkspaceLayoutId;
  configs: TConfig[];
  component: string;
  panelIdPrefix: string;
  panelTitle: (panel: number) => string;
  global?: Record<string, unknown>;
}

const compileFlexNode = <TConfig extends Record<string, unknown>>(
  spec: LayoutSpec,
  options: BuildWorkspaceLayoutOptions<TConfig>,
): Record<string, unknown> => {
  const weight = spec.weight ?? 1;
  if ('panel' in spec) {
    const id = `${options.panelIdPrefix}${spec.panel}`;
    const title = options.panelTitle(spec.panel);
    return {
      type: 'tabset',
      weight,
      children: [{
        type: 'tab',
        id,
        name: title,
        component: options.component,
        config: {
          id,
          kind: options.component,
          title,
          config: options.configs[spec.panel - 1],
          groupId: 'G1',
        },
      }],
    };
  }
  return {
    type: 'row',
    weight,
    children: spec.children.map(child => compileFlexNode(child, options)),
  };
};

export const buildChartWorkspaceLayout = <TConfig extends Record<string, unknown>>(
  options: BuildWorkspaceLayoutOptions<TConfig>,
) => {
  const spec = specs[options.id];
  return {
    global: {
      ...(options.global ?? {}),
      rootOrientationVertical: spec.direction === 'vertical',
    },
    borders: [],
    layout: compileFlexNode(spec, options),
  };
};

