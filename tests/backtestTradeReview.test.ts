import { describe, expect, it } from 'vitest';
import { buildBacktestTradeReviewUpdates } from '../components/BacktestTradeReviewDialog';

describe('buildBacktestTradeReviewUpdates', () => {
  it('normalizes editable notes and confluences', () => {
    expect(buildBacktestTradeReviewUpdates({
      notes: '  Čekal jsem na sweep.  ',
      htfConfluence: 'PDH, 1H FVG, ',
      ltfConfluence: 'MSS, displacement',
      isValid: true,
      setupType: 'reaction',
    })).toEqual({
      notes: 'Čekal jsem na sweep.',
      htfConfluence: ['PDH', '1H FVG'],
      ltfConfluence: ['MSS', 'displacement'],
      isValid: true,
      executionStatus: 'Valid',
      planAdherence: 'Yes',
      setupType: 'reaction',
    });
  });

  it('backtest je bez volby vždy validní a typ setupu nepřepisuje', () => {
    const updates = buildBacktestTradeReviewUpdates({ notes: '', htfConfluence: '', ltfConfluence: '' });
    expect(updates).toMatchObject({ isValid: true, executionStatus: 'Valid', planAdherence: 'Yes' });
    expect(updates).not.toHaveProperty('setupType');
  });

  it('keeps every invalidity field consistent', () => {
    expect(buildBacktestTradeReviewUpdates({
      notes: '', htfConfluence: '', ltfConfluence: '', isValid: false, setupType: 'unclear',
    })).toMatchObject({
      isValid: false,
      executionStatus: 'Invalid',
      planAdherence: 'No',
      setupType: 'unclear',
    });
  });
});

describe('withReviewedFlag', () => {
  it('odškrtne „čeká na review“ jen u obchodu, který tam opravdu byl', async () => {
    const { withReviewedFlag } = await import('../services/backtestTradeReview');
    expect(withReviewedFlag({ notes: 'x' }, { needsReview: true })).toEqual({ notes: 'x', needsReview: false });
    // Pole chybí (204/205 backtest obchodů) nebo je false: neposílat — CAS by hlásil falešný konflikt.
    expect(withReviewedFlag({ notes: 'x' }, { needsReview: false })).toEqual({ notes: 'x' });
    expect(withReviewedFlag({ notes: 'x' }, {})).toEqual({ notes: 'x' });
  });
});
