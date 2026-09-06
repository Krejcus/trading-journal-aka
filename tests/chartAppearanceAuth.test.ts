import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindChartAppearanceAuth } from '../services/chartAppearanceAuth';
import {
  CHART_APPEARANCE_SLOTS, CHART_APPEARANCE_STORAGE_KEYS,
  chartAppearanceSnapshot, chartAppearanceUserId, chartAppearanceUserStorageKey,
  createChartAppearanceSession, inheritGlobalAppearance, readChartAppearance,
  resetChartAppearanceScope, setChartAppearanceUserId, writeChartAppearance, writeGlobalChartAppearance,
} from '../services/chartAppearanceScope';

const stored = () => {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  return values;
};
const auth = () => {
  let listener: (event: string, session: { user: { id: string } } | null) => void = () => {};
  let resolve!: (value: { data: { session: { user: { id: string } } | null } }) => void;
  const client = {
    onAuthStateChange: (callback: typeof listener) => { listener = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; },
    getSession: () => new Promise<{ data: { session: { user: { id: string } } | null } }>(done => { resolve = done; }),
  };
  return {
    client,
    emit: (id: string | null) => listener(id ? 'SIGNED_IN' : 'SIGNED_OUT', id ? { user: { id } } : null),
    resolve: (id: string | null) => resolve({ data: { session: id ? { user: { id } } : null } }),
  };
};
afterEach(() => { resetChartAppearanceScope(); vi.unstubAllGlobals(); });

describe('appearance default ownership', () => {
  it('does not assign unowned legacy appearance to the first signed-in user', () => {
    const values = stored();
    for (const slot of CHART_APPEARANCE_SLOTS) values.set(CHART_APPEARANCE_STORAGE_KEYS[slot], JSON.stringify({ legacy: slot }));
    for (const slot of CHART_APPEARANCE_SLOTS) expect(inheritGlobalAppearance(slot)).toBeUndefined();
    expect(writeGlobalChartAppearance('chartSettings', { unknown: true })).toBe(false);
    setChartAppearanceUserId('A');
    for (const slot of CHART_APPEARANCE_SLOTS) {
      expect(inheritGlobalAppearance(slot)).toBeUndefined();
      expect(values.has(chartAppearanceUserStorageKey(slot, 'A'))).toBe(false);
    }
    setChartAppearanceUserId(null);
    for (const slot of CHART_APPEARANCE_SLOTS) expect(inheritGlobalAppearance(slot)).toEqual({ legacy: slot });
  });

  it('keeps all three default stores separate for A, B and guest on reads and writes', () => {
    const values = stored();
    setChartAppearanceUserId('A');
    for (const slot of CHART_APPEARANCE_SLOTS) writeGlobalChartAppearance(slot, { color: 'red' });
    setChartAppearanceUserId('B');
    for (const slot of CHART_APPEARANCE_SLOTS) {
      expect(inheritGlobalAppearance(slot)).toBeUndefined();
      writeGlobalChartAppearance(slot, { color: 'blue' });
      expect(JSON.parse(values.get(chartAppearanceUserStorageKey(slot, 'A'))!)).toEqual({ color: 'red' });
    }
    setChartAppearanceUserId('A');
    for (const slot of CHART_APPEARANCE_SLOTS) expect(inheritGlobalAppearance(slot)).toEqual({ color: 'red' });
    setChartAppearanceUserId(null);
    for (const slot of CHART_APPEARANCE_SLOTS) expect(inheritGlobalAppearance(slot)).toBeUndefined();
    setChartAppearanceUserId('B');
    for (const slot of CHART_APPEARANCE_SLOTS) expect(inheritGlobalAppearance(slot)).toEqual({ color: 'blue' });
  });

  it('preserves a restored session when initial unknown identity resolves to its signed-in user', () => {
    stored();
    const scope = createChartAppearanceSession('saved-run', { chartSettings: { color: 'saved' } }, inheritGlobalAppearance);
    scope.activate();
    setChartAppearanceUserId('A');
    expect(chartAppearanceSnapshot()).toEqual({ chartSettings: { color: 'saved' } });
    expect(writeChartAppearance('chartSettings', { color: 'edited' })).toBe(true);
    expect(chartAppearanceSnapshot()).toEqual({ chartSettings: { color: 'edited' } });
  });

  it('blocks stale session writes after A switches to B instead of writing B defaults', () => {
    const values = stored();
    setChartAppearanceUserId('A');
    const scope = createChartAppearanceSession('A-run', { chartSettings: { color: 'red' } }, inheritGlobalAppearance);
    scope.activate();
    setChartAppearanceUserId('B');
    expect(readChartAppearance('chartSettings')).toBeUndefined();
    expect(chartAppearanceSnapshot()).toBeUndefined();
    expect(writeChartAppearance('chartSettings', { color: 'stale-A' })).toBe(true);
    expect(values.has(chartAppearanceUserStorageKey('chartSettings', 'B'))).toBe(false);
    const newScope = createChartAppearanceSession('B-run', { chartSettings: { color: 'blue' } }, inheritGlobalAppearance);
    newScope.activate();
    scope.deactivate();
    expect(chartAppearanceSnapshot()).toEqual({ chartSettings: { color: 'blue' } });
  });

  it('ignores a delayed initial session read after a newer auth event', async () => {
    stored();
    const fixture = auth();
    const release = bindChartAppearanceAuth(fixture.client);
    fixture.emit('B');
    fixture.resolve('A');
    await Promise.resolve();
    expect(chartAppearanceUserId()).toBe('B');
    release();
  });

  it('does not restore the old identity when a pending read completes after logout or disposal', async () => {
    stored();
    const fixture = auth();
    const release = bindChartAppearanceAuth(fixture.client);
    fixture.emit('A');
    fixture.emit(null);
    release();
    fixture.resolve('A');
    await Promise.resolve();
    expect(chartAppearanceUserId()).toBeNull();
  });
});
