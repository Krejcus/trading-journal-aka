import type { Trade } from '../types';

export interface BacktestTagSuggestions {
  tags: string[];
  htf: string[];
  ltf: string[];
}

export const normalizeTradeTags = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  return values.map(value => value.normalize('NFC').trim().replace(/\s+/g, ' ')).filter(value => {
    const key = value.toLocaleLowerCase('cs');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Suggestions belong to the current user's journal; saved trades remain the source of truth. */
export const collectBacktestTagSuggestions = (
  trades: readonly Trade[],
  configured: { htf?: readonly string[]; ltf?: readonly string[] } = {},
): BacktestTagSuggestions => {
  const manual = (trade: Trade, kind: 'htf' | 'ltf') => {
    const generated = new Set(trade.autoConfluence?.[kind] ?? []);
    return (kind === 'htf' ? trade.htfConfluence : trade.ltfConfluence)?.filter(tag => !generated.has(tag)) ?? [];
  };
  const sorted = (values: readonly string[]) => normalizeTradeTags(values).sort((a, b) => a.localeCompare(b, 'cs'));
  return {
    tags: sorted(trades.flatMap(trade => trade.tags ?? [])),
    htf: sorted([...(configured.htf ?? []), ...trades.flatMap(trade => manual(trade, 'htf'))]),
    ltf: sorted([...(configured.ltf ?? []), ...trades.flatMap(trade => manual(trade, 'ltf'))]),
  };
};
