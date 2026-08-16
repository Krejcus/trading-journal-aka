import { describe, expect, it } from 'vitest';
import { buildBacktestTradeReviewUpdates } from '../components/BacktestTradeReviewDialog';

describe('buildBacktestTradeReviewUpdates', () => {
  it('normalizes editable notes and confluences', () => {
    expect(buildBacktestTradeReviewUpdates({
      notes: '  Čekal jsem na sweep.  ',
      htfConfluence: 'PDH, 1H FVG, ',
      ltfConfluence: 'MSS, displacement',
      isValid: true,
    })).toEqual({
      notes: 'Čekal jsem na sweep.',
      htfConfluence: ['PDH', '1H FVG'],
      ltfConfluence: ['MSS', 'displacement'],
      isValid: true,
      executionStatus: 'Valid',
      planAdherence: 'Yes',
    });
  });

  it('keeps every invalidity field consistent', () => {
    expect(buildBacktestTradeReviewUpdates({
      notes: '', htfConfluence: '', ltfConfluence: '', isValid: false,
    })).toMatchObject({
      isValid: false,
      executionStatus: 'Invalid',
      planAdherence: 'No',
    });
  });
});
