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
