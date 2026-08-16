import type { Trade } from '../types';

const GENERATED_LTF_TAG = /^(?:1m (?:BoS|CHoCH)(?: \(|$)|vstup(?:: (?:untouched FVG|ihned po potvrzení)| ve FVG)$|odraz od |(?:nad|pod) VWAP$|VWAP [+-]?\d+(?:\.\d+)?σ$)/i;
const GENERATED_HTF_TAG = /^(?:(?:1h|15m) (?:BoS|CHoCH)(?: |$)|u |v (?:15m|1h) FVG$|(?:nad|pod) (?:Day|Week) Open$)/i;

const DERIVED_FIELDS = [
  // Obchody odehrané před zavedením vstupního bracketu mají v deníku prázdné
  // SL/TP, i když je engine v session drží. Přepočet je proto musí umět
  // doplnit, jinak by na nich zůstala díra napořád.
  'stopLoss',
  'takeProfit',
  'outcomeAmbiguous',
  'time',
  'schemaVersion',
  'riskAmount',
  'targetAmount',
  'runUp',
  'drawdown',
  'session',
  'mfeR',
  'maeR',
  'mfePoints',
  'maePoints',
  'excursionAvailable',
  'excursionComplete',
  'excursion',
  'executionPath',
  'executionPathComplete',
  'counterfactual',
  'entryMap',
  'entryContext',
  'slPlacement',
  'targetType',
  'targetLevel',
  'management',
] as const satisfies readonly (keyof Trade)[];

const unique = (values: readonly string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))];

export const mergeManualAndGeneratedConfluences = (
  current: readonly string[] | undefined,
  generated: readonly string[] | undefined,
  kind: 'ltf' | 'htf',
) => {
  const generatedPattern = kind === 'ltf' ? GENERATED_LTF_TAG : GENERATED_HTF_TAG;
  const manual = (current ?? []).filter(tag => !generatedPattern.test(tag));
  return unique([...manual, ...(generated ?? [])]);
};

/**
 * Připraví pouze odvozená pole, která lze znovu spočítat z replay dat.
 * Uživatelská review data (poznámky, validita, screenshoty a ruční kapsle)
 * zůstávají nedotčená.
 */
export const buildBacktestTradeRecalculationUpdates = (
  current: Trade,
  recalculated: Trade,
): Partial<Trade> => {
  const updates: Partial<Trade> = {};
  DERIVED_FIELDS.forEach(field => {
    // `undefined` se při zápisu JSON blobu zahodí a stará chybná hodnota by
    // v Supabase zůstala. `null` ji naopak vědomě vyčistí, když ji aktuální
    // indikátor z dostupných dat už neumí potvrdit.
    (updates as Record<string, unknown>)[field] = recalculated[field] ?? null;
  });
  updates.ltfConfluence = mergeManualAndGeneratedConfluences(
    current.ltfConfluence,
    recalculated.ltfConfluence,
    'ltf',
  );
  updates.htfConfluence = mergeManualAndGeneratedConfluences(
    current.htfConfluence,
    recalculated.htfConfluence,
    'htf',
  );
  return updates;
};

export interface BacktestTradeRecalculationChange {
  label: string;
  before: string;
  after: string;
}

const display = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'ano' : 'ne';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return String(value);
};

const entryStructure = (trade: Trade) => {
  const map = trade.entryMap as { structureType?: string | null; structureBarsAgo?: number | null } | undefined;
  if (!map?.structureType) return null;
  if (map.structureBarsAgo == null) return map.structureType;
  const unit = map.structureBarsAgo === 1 ? 'bar' : map.structureBarsAgo >= 2 && map.structureBarsAgo <= 4 ? 'bary' : 'barů';
  return `${map.structureType} · ${map.structureBarsAgo} ${unit} zpět`;
};

const entryFvg = (trade: Trade) => {
  const map = trade.entryMap as { entryFvg?: unknown } | undefined;
  return Boolean(map?.entryFvg);
};

const htfStructure = (trade: Trade) => {
  const context = trade.entryContext as { htf?: { structureType?: string | null; structureDirection?: string | null } } | undefined;
  const structure = context?.htf;
  return structure?.structureType ? `${structure.structureType} · ${structure.structureDirection ?? 'bez směru'}` : null;
};

const snapshot = (trade: Trade) => ({
  'Stop loss': trade.stopLoss,
  'Take profit': trade.takeProfit,
  'Entry struktura': entryStructure(trade),
  'Entry FVG': entryFvg(trade),
  'HTF struktura': htfStructure(trade),
  'Entry kapsle': trade.ltfConfluence ?? [],
  'HTF kapsle': trade.htfConfluence ?? [],
  'SL umístění': trade.slPlacement,
  'Typ targetu': trade.targetType,
  'Target level': trade.targetLevel,
  Session: trade.session,
  MFE: trade.mfeR == null ? null : `${trade.mfeR.toFixed(2)}R`,
  MAE: trade.maeR == null ? null : `${trade.maeR.toFixed(2)}R`,
  Management: trade.management,
});

export const describeBacktestTradeRecalculation = (
  before: Trade,
  after: Trade,
): BacktestTradeRecalculationChange[] => {
  const previous = snapshot(before);
  const next = snapshot(after);
  return Object.keys(previous).flatMap(label => {
    const beforeValue = previous[label as keyof typeof previous];
    const afterValue = next[label as keyof typeof next];
    if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) return [];
    return [{ label, before: display(beforeValue), after: display(afterValue) }];
  });
};
