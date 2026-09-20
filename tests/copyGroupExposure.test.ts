import { describe, expect, it } from 'vitest';
import { copyGroupExposureMultiple } from '../components/LiveCopyTradeOverview';

const follower = (accountId: number, multiplier: number, mode: 'off' | 'on-submit' | 'on-fill' = 'on-submit') =>
  ({ accountId, multiplier, mode });

describe('copyGroupExposureMultiple', () => {
  it('sečte násobky aktivních followerů', () => {
    expect(copyGroupExposureMultiple({ followers: [follower(1, 1), follower(2, 2), follower(3, 1.5)] })).toBe(4.5);
  });

  it('vypnutou replikaci nepočítá — účet je ve skupině, ale nic neodešle', () => {
    expect(copyGroupExposureMultiple({ followers: [follower(1, 1), follower(2, 3, 'off')] })).toBe(1);
  });

  it('prázdná skupina má nulovou expozici', () => {
    expect(copyGroupExposureMultiple({ followers: [] })).toBe(0);
  });

  it('nenechá v součtu plovoucí zbytky', () => {
    expect(copyGroupExposureMultiple({ followers: [follower(1, 0.1), follower(2, 0.2)] })).toBe(0.3);
  });
});
