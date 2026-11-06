import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLiveScreenThemePreference,
  resolveLiveScreenDark,
  setLiveScreenThemePreference,
} from '../services/liveScreenTheme';

describe('motiv obrazovky LIVE', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('„Podle aplikace“ přebírá motiv aplikace, jinak platí vlastní volba', () => {
    expect(resolveLiveScreenDark('app', true)).toBe(true);
    expect(resolveLiveScreenDark('app', false)).toBe(false);
    expect(resolveLiveScreenDark('dark', false)).toBe(true);
    expect(resolveLiveScreenDark('light', true)).toBe(false);
  });

  it('ukládá volbu zvlášť a neznámou hodnotu bere jako „Podle aplikace“', () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value); },
      },
      dispatchEvent: () => true,
    });
    vi.stubGlobal('CustomEvent', class { constructor(public type: string, public init: unknown) {} });
    expect(getLiveScreenThemePreference()).toBe('app');
    setLiveScreenThemePreference('light');
    expect(stored.get('alphatrade:live-screen-theme')).toBe('light');
    expect(getLiveScreenThemePreference()).toBe('light');
    stored.set('alphatrade:live-screen-theme', 'neon');
    expect(getLiveScreenThemePreference()).toBe('app');
  });
});
