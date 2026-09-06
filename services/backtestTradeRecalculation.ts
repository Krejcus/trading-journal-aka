import type { Trade } from '../types';

const DERIVED_FIELDS = [
  // Obchody odehrané před zavedením vstupního bracketu mají v deníku prázdné
  // SL/TP, i když je engine v session drží. Přepočet je proto musí umět
  // doplnit, jinak by na nich zůstala díra napořád.
  'stopLoss',
  'takeProfit',
  'outcomeAmbiguous',
  'excursionAmbiguous',
  'time',
  'schemaVersion',
  'actualExcursionQuality',
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
  previousGenerated: readonly string[] = [],
) => {
  const generatedSet = new Set(unique(previousGenerated));
  const manual = unique(current ?? []).filter(tag => !generatedSet.has(tag));
  return unique([...manual, ...(generated ?? [])]);
};

/** Retain provenance on review edits, while an explicit manual choice takes ownership. */
export const reconcileBacktestConfluenceProvenance = (
  current: Pick<Trade, 'autoConfluence'>,
  selected: { htf: readonly string[]; ltf: readonly string[] },
  explicitlyManual: { htf?: readonly string[]; ltf?: readonly string[] } = {},
): NonNullable<Trade['autoConfluence']> => {
  const retain = (kind: 'htf' | 'ltf') => {
    const selectedSet = new Set(unique(selected[kind]));
    const manualSet = new Set(unique(explicitlyManual[kind] ?? []));
    return unique(current.autoConfluence?.[kind] ?? []).filter(tag => selectedSet.has(tag) && !manualSet.has(tag));
  };
  return { htf: retain('htf'), ltf: retain('ltf') };
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
    current.autoConfluence?.ltf,
  );
  updates.htfConfluence = mergeManualAndGeneratedConfluences(
    current.htfConfluence,
    recalculated.htfConfluence,
    current.autoConfluence?.htf,
  );
  const nextGenerated = (kind: 'htf' | 'ltf') => {
    const field = kind === 'htf' ? 'htfConfluence' : 'ltfConfluence';
    const oldGenerated = new Set(unique(current.autoConfluence?.[kind] ?? []));
    const manual = new Set(unique(current[field] ?? []).filter(tag => !oldGenerated.has(tag)));
    // An existing manual tag may have exactly the same text as a fresh indicator tag.
    // It must remain user-owned through this and every later recalculation.
    return unique(recalculated[field] ?? []).filter(tag => !manual.has(tag));
  };
  updates.autoConfluence = { htf: nextGenerated('htf'), ltf: nextGenerated('ltf') };
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
