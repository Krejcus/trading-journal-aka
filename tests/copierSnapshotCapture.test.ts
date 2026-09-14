import { expect, it, vi } from 'vitest';
import { captureTimelyCopierSnapshot } from '../services/copierSnapshotCapture';

it('does not capture queued events after their time window or after a new lifecycle event', async () => {
  const capture = vi.fn(async () => 'png'); const skip = vi.fn();
  expect(await captureTimelyCopierSnapshot({ eventAt: 1000, now: () => 16000, isCurrent: () => true, capture, onSkip: skip })).toBeNull();
  expect(skip).toHaveBeenLastCalledWith('snapshot-capture-expired');
  expect(await captureTimelyCopierSnapshot({ eventAt: 1000, now: () => 1001, isCurrent: () => false, capture, onSkip: skip })).toBeNull();
  expect(skip).toHaveBeenLastCalledWith('snapshot-capture-superseded');
  expect(capture).not.toHaveBeenCalled();
});

it('discards an entry image when exit arrives during rendering; never retries capture', async () => {
  let current = true; let finish!: (image: string) => void;
  const capture = vi.fn(() => new Promise<string>(resolve => { finish = resolve; })); const skip = vi.fn();
  const pending = captureTimelyCopierSnapshot({ eventAt: 1000, now: () => 1001, isCurrent: () => current, capture, onSkip: skip });
  current = false; finish('now-exited-chart');
  expect(await pending).toBeNull(); expect(capture).toHaveBeenCalledExactlyOnceWith(8000);
  expect(skip).toHaveBeenCalledWith('snapshot-capture-superseded');
});

it('retains the available budget and rejects an image returned after the event deadline', async () => {
  let now = 15000;
  const capture = vi.fn(async () => { now = 16001; return 'late-image'; }); const skip = vi.fn();
  expect(await captureTimelyCopierSnapshot({ eventAt: 1000, now: () => now, isCurrent: () => true, capture, onSkip: skip })).toBeNull();
  expect(capture).toHaveBeenCalledWith(1000); expect(skip).toHaveBeenCalledWith('snapshot-capture-expired');
});
