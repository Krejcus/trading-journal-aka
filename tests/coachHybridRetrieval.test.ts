import { describe, expect, it } from 'vitest';
import { lexicalHistoryCandidates, normalizeSearchText } from '../services/coachTools';

describe('Coach hybrid history retrieval', () => {
  it('matches Czech text without depending on accents', () => {
    expect(normalizeSearchText('PŘED MĚSÍCEM — ztráta')).toBe('pred mesicem ztrata');
  });

  it('finds exact older evidence even when embeddings are unavailable', () => {
    const trades: any[] = [{
      id: 'old-1', accountId: 'a', date: '2025-01-10T12:00:00Z', instrument: 'MNQ',
      direction: 'Long', signal: 'FVG', pnl: -100, timestamp: 1, duration: '1m', durationMinutes: 1,
      runUp: 0, drawdown: 0, notes: 'Po stop lossu jsem udělal revenge a navýšil size.',
      mistakes: ['Revenge trading'], emotions: ['Tilt'],
    }];
    const results = lexicalHistoryCandidates(
      { query: 'revenge navýšil size', source_types: ['trade'] },
      trades, [], [], null, 'live',
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ source_type: 'trade', source_id: 'old-1' });
    expect(results[0].lexical_score).toBeGreaterThan(0.5);
  });

  it('keeps backtest retrieval isolated from live prep/review records', () => {
    const preps: any[] = [{ id: 'p1', date: '2026-01-01', notes: 'revenge reset plan' }];
    const reviews: any[] = [{ id: 'r1', date: '2026-01-01', mainTakeaway: 'revenge' }];
    expect(lexicalHistoryCandidates({ query: 'revenge' }, [], preps, reviews, null, 'backtest')).toEqual([]);
  });
});
