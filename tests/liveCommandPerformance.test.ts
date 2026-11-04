import { describe, expect, it } from 'vitest';
import { liveCommandWorkerDurations, liveCommandWorkerStage } from '../lib/liveCommandPerformance';

describe('LIVE command end-to-end performance', () => {
  it('rozliší order, fill a autoritativní position milestone', () => {
    expect(liveCommandWorkerStage({ ackAt: 100 })).toBe('order');
    expect(liveCommandWorkerStage({ ackAt: 100, fillAt: 120 })).toBe('fill');
    expect(liveCommandWorkerStage({ ackAt: 100, fillAt: 120, positionAt: 140 })).toBe('position');
  });

  it('počítá jen úseky na stejných hodinách workeru a záporný závod zahodí', () => {
    expect(liveCommandWorkerDurations({
      queuedAt: 10, startedAt: 20, dispatchAt: 30, ackAt: 60, fillAt: 80, positionAt: 100,
    })).toEqual({
      queuedToStartedMs: 10,
      startedToDispatchMs: 10,
      dispatchToAckMs: 30,
      ackToFillMs: 20,
      fillToPositionMs: 20,
    });
    expect(liveCommandWorkerDurations({ startedAt: 20, queuedAt: 30 })).toEqual({});
  });
});
