import { describe, expect, it } from 'vitest';
import { parseRestoredNavigation, readRestoredNavigation, saveNavigation, shouldReloadForStaleChunk } from '../lib/navigationRestore';

const memory = () => { const map = new Map<string, string>(); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) }; };

describe('navigationRestore', () => {
  it('uloží a obnoví stránku i záložku deníku', () => {
    const store = memory();
    saveNavigation({ page: 'journal', journalTab: 'weekly' }, store);
    expect(readRestoredNavigation(store)).toEqual({ page: 'journal', journalTab: 'weekly' });
  });
  it('neznámou stránku ani vadný obsah neobnoví', () => {
    const store = memory();
    saveNavigation({ page: 'journal', journalTab: 'daily' }, store);
    saveNavigation({ page: 'nesmysl', journalTab: 'daily' }, store);
    expect(readRestoredNavigation(store)).toBeNull();
    expect(parseRestoredNavigation('{')).toBeNull();
    expect(parseRestoredNavigation(JSON.stringify({ page: 'live', journalTab: 'x' }))).toEqual({ page: 'live' });
  });
  it('reload kvůli starému chunku nejvýš jednou za 30 s', () => {
    const store = memory();
    expect(shouldReloadForStaleChunk(1_000, store)).toBe(true);
    expect(shouldReloadForStaleChunk(20_000, store)).toBe(false);
    expect(shouldReloadForStaleChunk(40_000, store)).toBe(true);
  });
});
