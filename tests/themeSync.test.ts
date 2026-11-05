import { describe, expect, it } from 'vitest';
import { THEME_UPDATED_AT_KEY, incomingThemeToApply, readThemeUpdatedAt, writeThemeUpdatedAt } from '../lib/themeSync';

const base = { current: 'dark' as const, localAt: 1_000, hasLocalChoice: true };

describe('incomingThemeToApply', () => {
  it('převezme novější volbu z jiného zařízení', () => {
    expect(incomingThemeToApply({ ...base, incoming: 'light', incomingAt: 2_000 })).toBe('light');
  });
  it('starší ani stejně starou volbu nepřevezme', () => {
    expect(incomingThemeToApply({ ...base, incoming: 'light', incomingAt: 999 })).toBeNull();
    expect(incomingThemeToApply({ ...base, incoming: 'light', incomingAt: 1_000 })).toBeNull();
  });
  it('starý profil bez času zařízení s vlastní volbou nepřepíše', () => {
    expect(incomingThemeToApply({ ...base, incoming: 'light', incomingAt: undefined })).toBeNull();
  });
  it('nové zařízení bez vlastní volby bere téma účtu i bez času', () => {
    expect(incomingThemeToApply({ ...base, localAt: 0, hasLocalChoice: false, incoming: 'light', incomingAt: undefined })).toBe('light');
  });
  it('neplatnou hodnotu ani stejné téma ignoruje', () => {
    expect(incomingThemeToApply({ ...base, incoming: 'modra', incomingAt: 2_000 })).toBeNull();
    expect(incomingThemeToApply({ ...base, incoming: 'dark', incomingAt: 2_000 })).toBeNull();
  });
});

describe('čas změny v úložišti', () => {
  it('zapíše a přečte; nesmysl je 0', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    expect(readThemeUpdatedAt(storage)).toBe(0);
    writeThemeUpdatedAt(storage, 1234);
    expect(readThemeUpdatedAt(storage)).toBe(1234);
    data.set(THEME_UPDATED_AT_KEY, 'x');
    expect(readThemeUpdatedAt(storage)).toBe(0);
  });
});
