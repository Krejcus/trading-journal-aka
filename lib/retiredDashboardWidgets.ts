import type { DashboardLayouts } from '../types';

/** Dlaždice odstraněné z aplikace (AI „Insight Dne“, 12. 10. 2026). */
const RETIRED_WIDGET_IDS = new Set(['daily_insight']);

/** Uložené rozvržení je může obsahovat; bez filtru by po nich zůstala prázdná karta. */
export const withoutRetiredWidgets = (layouts: DashboardLayouts): DashboardLayouts => {
  let changed = false;
  const next: DashboardLayouts = {};
  for (const [breakpoint, items] of Object.entries(layouts ?? {})) {
    const kept = (items ?? []).filter(item => !RETIRED_WIDGET_IDS.has(item.id));
    if (kept.length !== (items ?? []).length) changed = true;
    next[breakpoint] = kept;
  }
  return changed ? next : layouts;
};
