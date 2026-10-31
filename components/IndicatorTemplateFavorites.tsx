import React, { useEffect, useState } from 'react';
import { chartTemplates, subscribeChartTemplates, type ChartTemplateRecord } from '../services/chartTemplateStore';
import {
  indicatorSetTemplateBadge,
  indicatorSetTemplateMeta,
  INDICATOR_SET_TEMPLATE_KEY,
  normalizeIndicatorSetTemplate,
} from '../services/chartIndicatorSetTemplates';
import { CHART_EMOJI_FONT } from '../services/chartEmoji';
import type { WorkspaceIndicatorState } from '../services/chartWorkspaceHistory';

/** Oblíbené šablony indikátorů jako tlačítka v horní liště grafu. */
const IndicatorTemplateFavorites: React.FC<{
  onApply: (state: WorkspaceIndicatorState) => void;
  isDark: boolean;
}> = ({ onApply, isDark }) => {
  const [records, setRecords] = useState<ChartTemplateRecord[]>(() => typeof window === 'undefined' ? [] : chartTemplates());
  useEffect(() => subscribeChartTemplates(setRecords), []);
  const favorites = records
    .filter(record => record.indicator === INDICATOR_SET_TEMPLATE_KEY && indicatorSetTemplateMeta(record.value).favorite)
    .flatMap(record => {
      const state = normalizeIndicatorSetTemplate(record.value);
      return state ? [{ record, state, icon: indicatorSetTemplateMeta(record.value).icon }] : [];
    })
    .sort((a, b) => a.record.name.localeCompare(b.record.name, 'cs'));
  if (!favorites.length) return null;
  return <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Oblíbené šablony indikátorů">
    {favorites.map(({ record, state, icon }) => <button
      key={record.id}
      type="button"
      onClick={() => onApply(structuredClone(state))}
      title={`Šablona indikátorů: ${record.name}`}
      aria-label={`Načíst šablonu indikátorů ${record.name}`}
      className={`flex h-7 min-w-7 items-center justify-center rounded-md px-1 ${icon ? 'text-[16px]' : 'text-[11px] font-black'} ${isDark ? 'text-slate-200 hover:bg-white/10' : 'text-slate-700 hover:bg-slate-100'}`}
      style={icon ? { fontFamily: CHART_EMOJI_FONT } : undefined}
    >{indicatorSetTemplateBadge(record.name, icon)}</button>)}
  </div>;
};

export default IndicatorTemplateFavorites;
