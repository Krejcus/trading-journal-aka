import { describe, expect, it } from 'vitest';
import type { Trade } from '../types';
import { collectBacktestTagSuggestions, normalizeTradeTags } from '../services/backtestTagCatalog';
import { buildBacktestTradeReviewUpdates } from '../components/BacktestTradeReviewDialog';

describe('custom trade tags', () => {
  it('normalizes whitespace, Unicode and case duplicates without losing Czech text', () => {
    expect(normalizeTradeTags(['  Můj   setup ', 'můj setup', 'chyba', '', 'Odra\u0301z', 'Odráz']))
      .toEqual(['Můj setup', 'chyba', 'Odráz']);
  });

  it('suggests saved custom tags and settings confluences, excluding proven automatic labels', () => {
    const trade = { tags: ['Můj setup'], htfConfluence: ['U mého levelu', 'Auto HTF'], ltfConfluence: ['Můj vstup'],
      autoConfluence: { htf: ['Auto HTF'], ltf: [] } } as Trade;
    expect(collectBacktestTagSuggestions([trade], { htf: ['Denní level'] })).toEqual({
      tags: ['Můj setup'], htf: ['Denní level', 'U mého levelu'], ltf: ['Můj vstup'],
    });
    expect(collectBacktestTagSuggestions([])).toEqual({ tags: [], htf: [], ltf: [] });
  });

  it('persists custom tags with notes and supports clearing them without touching machine data', () => {
    const input = { notes: '  Čekal jsem na retest. ', tags: '  Trpělivost, A setup, trpělivost ',
      htfConfluence: 'PDH', ltfConfluence: '', isValid: true, setupType: 'reaction' as const };
    const updates = buildBacktestTradeReviewUpdates(input);
    expect(updates.tags).toEqual(['Trpělivost', 'A setup']);
    expect(updates.notes).toBe('Čekal jsem na retest.');
    expect(updates).not.toHaveProperty('entryContext');
    expect(buildBacktestTradeReviewUpdates({ ...input, tags: '' }).tags).toEqual([]);
  });
});
