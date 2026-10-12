import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterLivePriority, holdForLive, LIVE_PRIORITY_MAX_MS, livePriorityActive, releaseLivePriority } from '../lib/livePriority';

afterEach(() => { releaseLivePriority(); vi.useRealTimers(); });

describe('přednost LIVE při studeném otevření', () => {
  it('bez přednosti čtení běží hned', async () => {
    let ran = false;
    await afterLivePriority().then(() => { ran = true; });
    expect(ran).toBe(true);
  });

  it('čtení na pozadí počká na uvolnění po zobrazení LIVE', async () => {
    holdForLive();
    let ran = false;
    const waiting = afterLivePriority().then(() => { ran = true; });
    await Promise.resolve();
    expect(ran).toBe(false);
    releaseLivePriority();
    await waiting;
    expect(ran).toBe(true);
  });

  it('nejdéle do stropu, i když se LIVE nikdy nezobrazí', async () => {
    vi.useFakeTimers();
    holdForLive();
    let ran = false;
    const waiting = afterLivePriority().then(() => { ran = true; });
    vi.advanceTimersByTime(LIVE_PRIORITY_MAX_MS - 1);
    await Promise.resolve();
    expect(ran).toBe(false);
    vi.advanceTimersByTime(1);
    await waiting;
    expect(ran).toBe(true);
    expect(livePriorityActive()).toBe(false);
  });
});
