import type { WorkspaceIndicatorState } from './chartWorkspaceHistory';
import { isChartEmoji } from './chartEmoji';

// Šablona celé sady indikátorů (jako „Indicator templates“ v TradingView).
// Ukládá se do obecného úložiště šablon (`chart_templates`) pod tímto klíčem,
// hodnota je WorkspaceIndicatorState: vlastní indikátory + knihovní s parametry.
export const INDICATOR_SET_TEMPLATE_KEY = 'indicator-set';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Hodnota šablony přichází i z cloudu — bez platného tvaru se nepoužije. */
export const normalizeIndicatorSetTemplate = (value: unknown): WorkspaceIndicatorState | null => {
  if (!isRecord(value) || !isRecord(value.custom) || !Array.isArray(value.library)) return null;
  const library = value.library.flatMap(item => (
    isRecord(item) && typeof item.name === 'string' && item.name
      ? [{ name: item.name, params: isRecord(item.params) ? { ...item.params } : {} }]
      : []
  ));
  return {
    custom: {
      fvg: value.custom.fvg === true,
      levels: value.custom.levels === true,
      structure: value.custom.structure === true,
    },
    library,
  };
};

const CUSTOM_TITLES: Array<[keyof WorkspaceIndicatorState['custom'], string]> = [
  ['fvg', 'FVG'],
  ['levels', 'Levely'],
  ['structure', 'Struktura'],
];

/** Krátký výčet indikátorů šablony pod jejím názvem. */
export const describeIndicatorSetTemplate = (
  state: WorkspaceIndicatorState,
  libraryTitle: (name: string) => string = name => name,
): string => {
  const names = [
    ...CUSTOM_TITLES.filter(([key]) => state.custom[key]).map(([, title]) => title),
    ...state.library.map(item => libraryTitle(item.name)),
  ];
  return names.length ? names.join(', ') : 'Bez indikátorů';
};

/** Oblíbená šablona má tlačítko v horní liště: emoji, nebo první písmeno názvu. */
export interface IndicatorSetTemplateMeta {
  favorite: boolean;
  icon: string | null;
}

export const indicatorSetTemplateMeta = (value: unknown): IndicatorSetTemplateMeta => ({
  favorite: isRecord(value) && value.favorite === true,
  icon: isRecord(value) && isChartEmoji(value.icon) ? value.icon : null,
});

export const withIndicatorSetTemplateMeta = (
  state: WorkspaceIndicatorState,
  meta: IndicatorSetTemplateMeta,
): WorkspaceIndicatorState & Partial<IndicatorSetTemplateMeta> => ({
  ...state,
  ...(meta.favorite ? { favorite: true } : {}),
  ...(meta.icon ? { icon: meta.icon } : {}),
});

export const indicatorSetTemplateBadge = (name: string, icon: string | null): string =>
  icon ?? (Array.from(name.trim())[0]?.toLocaleUpperCase('cs') || '?');
