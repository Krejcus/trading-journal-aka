import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllGlobals());
describe('device-local LIVE layout preference', () => {
  it('defaults to mobile, persists explicit selection, and falls back safely without storage', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    const events: string[] = [];
    vi.stubGlobal('window', { dispatchEvent: (event: Event) => { events.push(event.type); return true; } });
    const { readLiveLayout, setLiveLayout, LIVE_LAYOUT_KEY } = await import('../hooks/useLiveLayout');
    expect(readLiveLayout()).toBe('mobile');
    setLiveLayout('full'); expect(values.get(LIVE_LAYOUT_KEY)).toBe('full'); expect(readLiveLayout()).toBe('full');
    expect(events).toEqual(['alphatrade:live-layout']);
    setLiveLayout('mobile'); expect(readLiveLayout()).toBe('mobile');
    vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
    setLiveLayout('full'); expect(readLiveLayout()).toBe('full');
    setLiveLayout('mobile');
  });
});
