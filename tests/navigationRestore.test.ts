import { describe, expect, it } from 'vitest';
import { parseRestoredNavigation, readRestoredNavigation, saveNavigation, refreshFailedAssets, shouldReloadForStaleChunk } from '../lib/navigationRestore';

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

describe('obnova selhaných chunků po nasazení', () => {
  it('stáhne znovu s cache: reload jen selhané soubory z /assets a URL z chyby', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const count = await refreshFailedAssets([
      { name: 'https://x.app/assets/star-AAA.js', responseStatus: 404 },
      { name: 'https://x.app/assets/ok-BBB.js', responseStatus: 200 },
      { name: 'https://x.app/api/status', responseStatus: 500 },
      { name: 'https://x.app/assets/old-CCC.js' },
    ], 'Failed to fetch dynamically imported module: https://x.app/assets/LiveTradingScreen-DDD.js', async (url, init) => { calls.push([url, init]); });
    expect(count).toBe(2);
    expect(calls.map(([url]) => url).sort()).toEqual(['https://x.app/assets/LiveTradingScreen-DDD.js', 'https://x.app/assets/star-AAA.js']);
    expect(calls.every(([, init]) => init.cache === 'reload')).toBe(true);
  });

  it('nic selhaného = nic nestahuje; visící fetch reload nezablokuje', async () => {
    expect(await refreshFailedAssets([{ name: 'https://x.app/assets/a.js', responseStatus: 200 }], null, async () => { throw new Error('nemá se volat'); })).toBe(0);
    const started = Date.now();
    expect(await refreshFailedAssets([{ name: 'https://x.app/assets/a.js', responseStatus: 404 }], null, () => new Promise(() => {}), 50)).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
