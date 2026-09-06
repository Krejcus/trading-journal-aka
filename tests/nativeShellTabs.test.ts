import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NATIVE_SHELL_TAB_SLOTS,
  NATIVE_SHELL_TAB_DESTINATIONS,
  nativeShellTabLayout,
  normalizeNativeShellTabSlots,
  replaceNativeShellTabSlot,
} from '../lib/nativeShellTabs';

describe('nativní karty spodního menu', () => {
  it('výchozí trojice je Dashboard, Historie, Deník', () => {
    expect(normalizeNativeShellTabSlots(undefined)).toEqual(['dashboard', 'history', 'journal']);
    expect(DEFAULT_NATIVE_SHELL_TAB_SLOTS).toEqual(['dashboard', 'history', 'journal']);
  });

  it('přijme jen tři různé známé cíle, jinak se vrátí na výchozí', () => {
    expect(normalizeNativeShellTabSlots(['dashboard', 'history', 'live'])).toEqual(['dashboard', 'history', 'live']);
    expect(normalizeNativeShellTabSlots(['dashboard', 'dashboard', 'live'])).toEqual(DEFAULT_NATIVE_SHELL_TAB_SLOTS);
    expect(normalizeNativeShellTabSlots(['dashboard', 'history'])).toEqual(DEFAULT_NATIVE_SHELL_TAB_SLOTS);
    expect(normalizeNativeShellTabSlots(['dashboard', 'history', 'capture'])).toEqual(DEFAULT_NATIVE_SHELL_TAB_SLOTS);
    expect(normalizeNativeShellTabSlots(['dashboard', 'history', 'nope'])).toEqual(DEFAULT_NATIVE_SHELL_TAB_SLOTS);
    expect(normalizeNativeShellTabSlots('dashboard')).toEqual(DEFAULT_NATIVE_SHELL_TAB_SLOTS);
  });

  it('nahrazení Deníku za LIVE nechá ostatní karty na místě', () => {
    expect(replaceNativeShellTabSlot(['dashboard', 'history', 'journal'], 2, 'live'))
      .toEqual(['dashboard', 'history', 'live']);
  });

  it('výběr karty, která už je jinde, oba sloty prohodí místo duplicity', () => {
    expect(replaceNativeShellTabSlot(['dashboard', 'history', 'live'], 0, 'live'))
      .toEqual(['live', 'history', 'dashboard']);
  });

  it('neznámý cíl ani index mimo rozsah výběr nezmění', () => {
    expect(replaceNativeShellTabSlot(['dashboard', 'history', 'live'], 5, 'lab')).toEqual(['dashboard', 'history', 'live']);
    expect(replaceNativeShellTabSlot(['dashboard', 'history', 'live'], 1, 'more')).toEqual(['dashboard', 'history', 'live']);
  });

  it('lišta má pevné Zapsat uprostřed a Více vpravo', () => {
    expect(nativeShellTabLayout(['dashboard', 'history', 'live']).map(item => item.title))
      .toEqual(['Dashboard', 'Historie', 'Zapsat', 'LIVE', 'Více']);
  });

  it('katalog zrcadlí Swift AlphaTradeTabCatalog', () => {
    expect(NATIVE_SHELL_TAB_DESTINATIONS.map(item => item.id)).toEqual([
      'dashboard', 'history', 'journal', 'live', 'ai', 'lab', 'business', 'network', 'accounts', 'settings',
    ]);
  });
});
