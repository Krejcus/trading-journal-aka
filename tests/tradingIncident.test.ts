import { describe, expect, it } from 'vitest';
import { buildReviewContent } from '../services/embeddingService';
import type { DailyReview } from '../types';

describe('trading incident bez jednotlivých tradů', () => {
  it('uloží do review rozpad ztráty a označí ho pro Coach search', () => {
    const review: DailyReview = {
      id: 'review-2026-07-23',
      date: '2026-07-23',
      mainTakeaway: '',
      mistakes: [],
      lessons: '',
      rating: 1,
      incidents: [{
        id: 'incident-1',
        timestamp: Date.parse('2026-07-23T19:00:00+02:00'),
        type: 'gambling',
        title: 'Večerní gamble',
        whatHappened: 'Po skončené session jsem otevřel graf a házel vstupy bez plánu.',
        trigger: 'Nuda a pocit, že padesát dolarů nestačí.',
        lesson: 'Po session nemažu jen graf, ale i alerty.',
        allocations: [
          { id: 'a1', scopeType: 'account', scopeId: 'lucid', label: 'Lucid Funded', lossAmount: 500, currency: 'USD' },
          { id: 'a2', scopeType: 'firm', scopeId: 'Tradeify', label: 'Tradeify', lossAmount: 600, currency: 'USD' },
        ],
      }],
    };

    const result = buildReviewContent(review);

    expect(result.content).toContain('Trading incident bez tradů');
    expect(result.content).toContain('Lucid Funded -$500');
    expect(result.content).toContain('Tradeify -$600');
    expect(result.content).toContain('Ztráta -$1100');
    expect(result.metadata.incidentLoss).toBe(1100);
  });
});
