import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { MarketStructureEvent } from '../services/marketDataCalculations';

type DrawingEngine = NonNullable<ChartViewApi['drawing']>['engine'];
type Drawing = Parameters<DrawingEngine['commit']>[0];
export type StructureDrawingEngine = Pick<DrawingEngine,
  'getDrawings' | 'getById' | 'commit' | 'remove' | 'select' | 'getSelectedId' | 'getActiveTool' | 'getDraft'>;

interface StructureLineStyle {
  bullishColor: string;
  bearishColor: string;
  lineWidth: number;
}

/**
 * Generovaná (needitovaná uživatelem) čára BoS/CHoCH mimo přehrávání. Id je
 * dané zlomem, ne pořadím — zlom z tvořící se svíčky pak přidá/odebere jen
 * svou čáru a ostatní zůstanou.
 */
export const structureDrawing = (event: MarketStructureEvent, style: StructureLineStyle): Drawing => ({
  id: `auto-structure-${event.type}-${event.direction}-${event.pivotTime}-${event.breakTime}`,
  tool: 'TrendLine',
  points: [{ time: event.pivotTime, price: event.price }, { time: event.breakTime, price: event.price }],
  style: {
    color: event.direction === 'bullish' ? style.bullishColor : style.bearishColor,
    width: style.lineWidth,
    dashed: false,
    fill: null,
  },
});

/**
 * Srovná čáry BoS/CHoCH na `events`: odebere navíc, přidá chybějící.
 *
 * `commit` knihovny přidanou kresbu označí (zvýraznění s úchyty na koncích)
 * a zahodí rozdělaný nástroj i náhled kresby. Výběr se proto vrátí, jak byl,
 * a dokud uživatel kreslí, nové čáry se nepřidávají (`deferred`) — doplní
 * se, až nástroj skončí.
 */
export function syncStructureDrawings(
  engine: StructureDrawingEngine,
  events: readonly { event: MarketStructureEvent }[],
  style: StructureLineStyle,
): { changed: boolean; deferred: boolean } {
  const wanted = events.map(({ event }) => structureDrawing(event, style));
  const wantedIds = new Set(wanted.map(drawing => drawing.id));
  const stale = engine.getDrawings().filter(drawing => drawing.id.startsWith('auto-structure-') && !wantedIds.has(drawing.id));
  const missing = wanted.filter(drawing => !engine.getById(drawing.id));
  stale.forEach(drawing => engine.remove(drawing.id));
  const drawing = engine.getActiveTool() !== null || engine.getDraft() !== null;
  if (drawing || !missing.length) return { changed: stale.length > 0, deferred: drawing && missing.length > 0 };
  const selected = engine.getSelectedId();
  missing.forEach(item => engine.commit(item));
  engine.select(selected && engine.getById(selected) ? selected : null);
  return { changed: true, deferred: false };
}
