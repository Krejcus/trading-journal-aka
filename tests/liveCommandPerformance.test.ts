import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  hasActiveLiveCommandTrace,
  liveCommandTraceReadyToComplete,
  liveCommandTraceWantsPaint,
  liveCommandWorkerDurations,
  liveCommandWorkerStage,
  markLiveCommandManageReady,
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

  it('propíše stejnou exposure paint stopu do desktopového i telefonního grafu', () => {
    const desk = readFileSync('components/TradovateLiveDesk.tsx', 'utf8');
    const phone = readFileSync('components/day/LivePhoneChart.tsx', 'utf8');
    expect(desk).toMatch(/liveExposurePaint=\{liveExposurePaint\}/);
    expect(desk).toMatch(/trade: phoneTrade,\s*\/\/[^\n]*\n\s*liveExposurePaint,/);
    expect(phone).toMatch(/const paint = slots\.liveExposurePaint;/);
    expect(phone).toMatch(/markLiveCommandPaint\(\{/);
    expect(phone).toMatch(/requestAnimationFrame\(\(\) => \{[\s\S]*requestAnimationFrame/);
  });

  const orderPaint = (operationId: string) => markLiveCommandPaint({ operationId, stage: 'order', receivedPerformanceAt: performance.now() });
  it('pozdější fill Limitu i připravenost správy jdou do téže stopy s původní kotvou', () => {
    const operationId = 'entry:later-fill';
    const started = startLiveCommandTrace(operationId)!;
    orderPaint(operationId);
    markLiveCommandResult(operationId, 'acknowledged');
    expect(hasActiveLiveCommandTrace(operationId)).toBe(false);
    const anchor = started.startedPerformanceMs;
    const fillAt = started.startedEpochMs + 1_000;
    markLiveCommandPaint({
      operationId, stage: 'fill', receivedPerformanceAt: anchor + 1_040,
      workerTiming: { ackAt: 5, fillAt },
    });
    markLiveCommandManageReady(operationId);
    expect(started.startedPerformanceMs).toBe(anchor);
    expect(started.stages?.fill?.receivedMs).toBeCloseTo(1_040, 5);
    expect(started.stages?.fill?.workerToReceiveMs).toBeCloseTo(40, 5);
    expect(started.manageReadyMs).toBeGreaterThanOrEqual(0);
    expect(started.manageReadyAfterResultMs).toBeGreaterThanOrEqual(0);
    expect(hasActiveLiveCommandTrace(operationId)).toBe(false);
  });
  it('správa se počítá jen poprvé; první fill nepřepíše další heartbeat', () => {
    const operationId = 'entry:first-only';
    const started = startLiveCommandTrace(operationId)!;
    markLiveCommandManageReady(operationId);
    const first = started.manageReadyMs;
    expect(started.manageReadyAfterResultMs).toBeUndefined();
    markLiveCommandManageReady(operationId);
    expect(started.manageReadyMs).toBe(first);
    markLiveCommandPaint({ operationId, stage: 'fill', receivedPerformanceAt: performance.now(), workerTiming: { fillAt: 1 } });
    const paint = started.stages?.fill;
    markLiveCommandPaint({ operationId, stage: 'fill', receivedPerformanceAt: performance.now() + 500 });
    expect(started.stages?.fill).toBe(paint);
    expect(started.workerTiming?.fillAt).toBe(1);
  });
  it('neznámá stopa (reload) nezaloží novou kotvu kliku', () => {
    orderPaint('entry:unknown-after-reload');
    markLiveCommandManageReady('entry:unknown-after-reload');
    expect(hasActiveLiveCommandTrace('entry:unknown-after-reload')).toBe(false);
    expect(liveCommandTraceWantsPaint('entry:unknown-after-reload', 'fill')).toBe(false);
  });
  it('dokončená stopa chce jen pozdější fill/position a každý jen jednou', () => {
    const operationId = 'entry:wants';
    startLiveCommandTrace(operationId);
    expect(liveCommandTraceWantsPaint(operationId, 'order')).toBe(true);
    orderPaint(operationId);
    markLiveCommandResult(operationId, 'acknowledged');
    expect(liveCommandTraceWantsPaint(operationId, 'order')).toBe(false);
    expect(liveCommandTraceWantsPaint(operationId, 'fill')).toBe(true);
    markLiveCommandPaint({ operationId, stage: 'fill', receivedPerformanceAt: performance.now() });
    expect(liveCommandTraceWantsPaint(operationId, 'fill')).toBe(false);
    expect(liveCommandTraceWantsPaint(operationId, 'position')).toBe(true);
  });

  it('produkční diagnostika zveřejní nezávislé start/result/paint milníky', () => {
    const source = readFileSync('lib/liveCommandPerformance.ts', 'utf8');
    expect(source).toContain('[live-command-perf-stage]');
    expect(source).toContain("logStage('start', trace)");
    expect(source).toContain("logStage('result', trace)");
    expect(source).toContain('logStage(`paint:${input.stage}`, trace)');
  });
});
