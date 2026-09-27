import { describe, expect, it } from 'vitest';
import { formatHoldDuration } from '../lib/holdDuration';

const at = (seconds: number) => 1_790_000_000_000 + seconds * 1000;

describe('délka držení obchodu', () => {
  it('pod minutu na vteřiny (dřív „0 min“)', () => {
    expect(formatHoldDuration(at(0), at(42))).toBe('42 s');
    expect(formatHoldDuration(at(0), at(0.4))).toBe('0 s');
  });
  it('minuty a vteřiny, celé minuty bez „0 s“', () => {
    expect(formatHoldDuration(at(0), at(192))).toBe('3 min 12 s');
    expect(formatHoldDuration(at(0), at(360))).toBe('6 min');
  });
  it('hodiny a dny', () => {
    expect(formatHoldDuration(at(0), at(3_900))).toBe('1 h 05 min');
    expect(formatHoldDuration(at(0), at(97_200))).toBe('1 d 3 h');
  });
  it('ISO text i neplatné vstupy', () => {
    expect(formatHoldDuration('2026-09-24T18:30:00.000Z', '2026-09-24T18:30:25.000Z')).toBe('25 s');
    expect(formatHoldDuration(at(10), at(0))).toBeNull();
    expect(formatHoldDuration(undefined, at(0))).toBeNull();
  });
});
