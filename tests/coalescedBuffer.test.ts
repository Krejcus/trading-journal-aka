import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoalescedBuffer } from '../lib/coalescedBuffer';

afterEach(() => vi.useRealTimers());

describe('createCoalescedBuffer — slučování náhledů kopírky v Historii', () => {
  it('delivers the first batch on the next tick and merges later batches into one delivery per 400 ms', () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const buffer = createCoalescedBuffer<string>(deliver);
    buffer.add(['a', 'b']);
    expect(deliver).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(deliver).toHaveBeenNthCalledWith(1, ['a', 'b']);
    buffer.add(['c']);
    vi.advanceTimersByTime(200);
    buffer.add(['d', 'e']);
    vi.advanceTimersByTime(199);
    expect(deliver).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(deliver).toHaveBeenNthCalledWith(2, ['c', 'd', 'e']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flush delivers everything at once and cancels the pending timer (end of run, cancel, cleanup)', () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const buffer = createCoalescedBuffer<string>(deliver);
    buffer.add(['a']);
    buffer.add(['b']);
    buffer.flush();
    expect(deliver).toHaveBeenCalledExactlyOnceWith(['a', 'b']);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a cancelled run never loses already signed items and never delivers twice', () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const buffer = createCoalescedBuffer<string>(deliver);
    buffer.add(['a']);
    buffer.flush(); // úklid efektu
    buffer.add(['late']); // podpis doběhl po zrušení
    buffer.flush();
    buffer.flush();
    expect(deliver.mock.calls).toEqual([[['a']], [['late']]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('empty batches neither deliver nor schedule anything', () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const buffer = createCoalescedBuffer<string>(deliver);
    buffer.add([]);
    buffer.flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });
});
