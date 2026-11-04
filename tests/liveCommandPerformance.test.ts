import { describe, expect, it } from 'vitest';
import {
  hasActiveLiveCommandTrace,
  liveCommandTraceReadyToComplete,
  liveCommandWorkerDurations,
  liveCommandWorkerStage,
  markLiveCommandPaint,
  markLiveCommandResult,
  startLiveCommandTrace,
  type LiveCommandTrace,
} from '../lib/liveCommandPerformance';

const trace = (patch: Partial<LiveCommandTrace> = {}): LiveCommandTrace => ({
  operationId: 'entry:test',
  kind: 'place-leader-entry',
  startedAt: '2026-11-04T00:00:00.000Z',
  startedEpochMs: 1,
  startedPerformanceMs: 1,
  startVisible: true,
  startFocused: true,
  stayedForeground: true,
  ...patch,
});

describe('LIVE command end-to-end performance', () => {
  it('rozliší order, fill a autoritativní position milestone', () => {
    expect(liveCommandWorkerStage({ ackAt: 100 })).toBe('order');
    expect(liveCommandWorkerStage({ ackAt: 100, fillAt: 120 })).toBe('fill');
    expect(liveCommandWorkerStage({ ackAt: 100, fillAt: 120, positionAt: 140 })).toBe('position');
  });

  it('počítá jen úseky na stejných hodinách workeru a záporný závod zahodí', () => {
    expect(liveCommandWorkerDurations({
      queuedAt: 10, startedAt: 20, dispatchAt: 30, ackAt: 60, committedAt: 70, fillAt: 80, positionAt: 100,
    })).toEqual({
      queuedToStartedMs: 10,
      startedToDispatchMs: 10,
      dispatchToAckMs: 30,
      ackToCommittedMs: 10,
      ackToFillMs: 20,
      fillToPositionMs: 20,
    });
    expect(liveCommandWorkerDurations({ startedAt: 20, queuedAt: 30 })).toEqual({});
  });

  it('nesmaže kotvu kliku, když order paint předběhne HTTP výsledek', () => {
    expect(liveCommandTraceReadyToComplete(trace({
      stages: { order: { receivedMs: 100, paintedMs: 120, receiveToPaintMs: 20, clickToPaintMs: 120, visible: true, focused: true } },
    }))).toBe(false);
    expect(liveCommandTraceReadyToComplete(trace({
      resultMs: 300,
      resultStatus: 'acknowledged',
      stages: { order: { receivedMs: 100, paintedMs: 120, receiveToPaintMs: 20, clickToPaintMs: 120, visible: true, focused: true } },
    }))).toBe(true);
  });

  it('udrží v reálném lifecycle stejnou aktivní stopu až do pozdějšího HTTP výsledku', () => {
    const operationId = 'entry:paint-before-result';
    startLiveCommandTrace(operationId);
    markLiveCommandPaint({
      operationId,
      stage: 'position',
      receivedPerformanceAt: performance.now(),
      workerTiming: { queuedAt: 10, startedAt: 11, positionAt: 20 },
    });
    expect(hasActiveLiveCommandTrace(operationId)).toBe(true);
    markLiveCommandResult(operationId, 'acknowledged');
    expect(hasActiveLiveCommandTrace(operationId)).toBe(false);
  });

  it('ponechá úspěšný working limit aktivní do prvního order paintu, ale definitivní reject uzavře bez paintu', () => {
    expect(liveCommandTraceReadyToComplete(trace({ resultMs: 300, resultStatus: 'acknowledged' }))).toBe(false);
    expect(liveCommandTraceReadyToComplete(trace({
      resultMs: 300,
      resultStatus: 'acknowledged',
      stages: { order: { receivedMs: 301, paintedMs: 320, receiveToPaintMs: 19, clickToPaintMs: 320, visible: true, focused: true } },
    }))).toBe(true);
    expect(liveCommandTraceReadyToComplete(trace({ resultMs: 300, resultStatus: 'blocked' }))).toBe(true);
  });
});
