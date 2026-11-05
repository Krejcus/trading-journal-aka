import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { LiveSafetyTarget } from '../lib/liveSafetyAction';
import {
  LIVE_SAFETY_SHORTCUT_MAX_AGE_MS,
  createLiveSafetyShortcutBus,
  isLiveSafetyShortcutAction,
  liveSafetyShortcutConfirmation,
  type LiveSafetyShortcutAction,
  type LiveSafetyShortcutRequest,
  type LiveSafetyShortcutSource,
  type LiveSafetyShortcutView,
} from '../lib/liveSafetyShortcut';

const T0 = 1_762_000_000_000;
const target = (patch: Partial<LiveSafetyTarget> = {}): LiveSafetyTarget => ({ id: 'g1', name: 'Skupina', accountIds: [1, 2, 3], observedAt: T0 - 2_000, verified: true, ...patch });
const view = (patch: Partial<LiveSafetyShortcutView> = {}): LiveSafetyShortcutView => ({ target: target(), confirmationOpen: false, pending: [], flattenPending: false, ...patch });
const request = (patch: Partial<LiveSafetyShortcutRequest> = {}): LiveSafetyShortcutRequest => ({ action: 'flatten-group', source: 'hotkey', at: T0, ...patch });

describe('liveSafetyShortcut: sběrnice jen v paměti', () => {
  it('bez posluchače se nestane nic a nic se neuloží na později', () => {
    const bus = createLiveSafetyShortcutBus();
    expect(bus.listening()).toBe(false);
    expect(bus.request('flatten-group', 'hotkey', T0)).toBe(false);
    const listener = vi.fn();
    bus.subscribe(listener);
    // Pozdější přihlášení nedostane starý požadavek (žádná fronta → dialog nevyskočí sám).
    expect(listener).not.toHaveBeenCalled();
  });

  it('doručí akci, zdroj a čas; vrací true', () => {
    const bus = createLiveSafetyShortcutBus();
    const listener = vi.fn();
    bus.subscribe(listener);
    expect(bus.request('flatten-group', 'hotkey', T0)).toBe(true);
    expect(bus.request('disarm', 'native-intent', T0 + 1)).toBe(true);
    expect(listener.mock.calls).toEqual([
      [{ action: 'flatten-group', source: 'hotkey', at: T0 }],
      [{ action: 'disarm', source: 'native-intent', at: T0 + 1 }],
    ]);
  });

  it('Kill switch ani neznámá akce/zdroj zkratkou nejdou', () => {
    const bus = createLiveSafetyShortcutBus();
    const listener = vi.fn();
    bus.subscribe(listener);
    expect(bus.request('kill-switch' as LiveSafetyShortcutAction, 'hotkey', T0)).toBe(false);
    expect(bus.request('flatten' as LiveSafetyShortcutAction, 'hotkey', T0)).toBe(false);
    expect(bus.request('flatten-group', 'push' as LiveSafetyShortcutSource, T0)).toBe(false);
    expect(bus.request('flatten-group', 'hotkey', Number.NaN)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(isLiveSafetyShortcutAction('kill-switch')).toBe(false);
    expect(isLiveSafetyShortcutAction('flatten-group')).toBe(true);
    expect(isLiveSafetyShortcutAction('disarm')).toBe(true);
  });

  it('jediný příjemce: naposledy přihlášená lišta — z jedné zkratky nikdy dva dialogy', () => {
    const bus = createLiveSafetyShortcutBus();
    const older = vi.fn();
    const newer = vi.fn();
    bus.subscribe(older);
    const stop = bus.subscribe(newer);
    bus.request('flatten-group', 'hotkey', T0);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
    stop();
    stop();
    bus.request('flatten-group', 'hotkey', T0);
    expect(older).toHaveBeenCalledTimes(1);
    expect(newer).toHaveBeenCalledTimes(1);
  });

  it('tatáž funkce přihlášená dvakrát se odhlašuje zvlášť', () => {
    const bus = createLiveSafetyShortcutBus();
    const listener = vi.fn();
    const first = bus.subscribe(listener);
    const second = bus.subscribe(listener);
    second();
    expect(bus.request('flatten-group', 'hotkey', T0)).toBe(true);
    first();
    expect(bus.listening()).toBe(false);
    expect(bus.request('flatten-group', 'hotkey', T0)).toBe(false);
  });

  it('výjimka posluchače = nedoručeno (integrace ukáže hlášku)', () => {
    const bus = createLiveSafetyShortcutBus();
    bus.subscribe(() => { throw new Error('render'); });
    expect(bus.request('flatten-group', 'hotkey', T0)).toBe(false);
  });
});

describe('liveSafetyShortcut: co smí lišta otevřít', () => {
  it('Flatten otevře dialog přesně se svým cílem (stejný target jako tlačítko lišty)', () => {
    const current = target();
    const decision = liveSafetyShortcutConfirmation(request(), view({ target: current }), T0);
    expect(decision).toEqual({ open: { action: 'flatten-group', target: current } });
    expect('open' in decision && decision.open.target).toBe(current);
    // Neověřený cíl jde otevřít jako tlačítkem — dialog ukáže stáří, desk ověří `assertSameSafetyTarget`.
    expect(liveSafetyShortcutConfirmation(request(), view({ target: target({ verified: false }) }), T0)).toHaveProperty('open');
  });

  it('Flatten bez známé skupiny nic neotevře', () => {
    expect(liveSafetyShortcutConfirmation(request(), view({ target: null }), T0)).toEqual({ ignored: expect.stringMatching(/známou skupinu/) });
  });

  it('otevřený dialog se nikdy nepřepíše (potvrzení OFF se nesmí změnit na Flatten)', () => {
    expect(liveSafetyShortcutConfirmation(request(), view({ confirmationOpen: true }), T0)).toEqual({ ignored: expect.stringMatching(/už je otevřený/) });
    expect(liveSafetyShortcutConfirmation(request({ action: 'disarm' }), view({ confirmationOpen: true }), T0)).toHaveProperty('ignored');
    expect(liveSafetyShortcutConfirmation(request(), { ...view(), confirmationOpen: undefined } as unknown as LiveSafetyShortcutView, T0)).toHaveProperty('ignored');
  });

  it('běžící Flatten (lišta nebo sdílený zámek skupiny) nový dialog neotevře', () => {
    expect(liveSafetyShortcutConfirmation(request(), view({ pending: ['flatten-group'] }), T0)).toHaveProperty('ignored');
    expect(liveSafetyShortcutConfirmation(request(), view({ flattenPending: true }), T0)).toEqual({ ignored: expect.stringMatching(/už běží/) });
  });

  it('OFF jde otevřít vždy, i bez skupiny a během Flattenu (INV-UI-02)', () => {
    expect(liveSafetyShortcutConfirmation(request({ action: 'disarm' }), view({ target: null, flattenPending: true, pending: ['flatten-group'] }), T0))
      .toEqual({ open: { action: 'disarm', target: null } });
    expect(liveSafetyShortcutConfirmation(request({ action: 'disarm' }), view({ pending: ['disarm'] }), T0)).toHaveProperty('ignored');
  });

  it('starý požadavek (> 60 s) nebo z budoucnosti se zahodí', () => {
    expect(LIVE_SAFETY_SHORTCUT_MAX_AGE_MS).toBe(60_000);
    expect(liveSafetyShortcutConfirmation(request({ at: T0 - 60_000 }), view(), T0)).toHaveProperty('open');
    expect(liveSafetyShortcutConfirmation(request({ at: T0 - 60_001 }), view(), T0)).toHaveProperty('ignored');
    expect(liveSafetyShortcutConfirmation(request({ at: T0 + 60_000 }), view(), T0)).toHaveProperty('ignored');
    expect(liveSafetyShortcutConfirmation(request({ at: Number.NaN }), view(), T0)).toHaveProperty('ignored');
  });

  it('Kill switch ani v rozhodnutí lišty', () => {
    expect(liveSafetyShortcutConfirmation(request({ action: 'kill-switch' as LiveSafetyShortcutAction }), view(), T0)).toHaveProperty('ignored');
  });
});

describe('liveSafetyShortcut: statická pojistka', () => {
  const source = readFileSync(new URL('../lib/liveSafetyShortcut.ts', import.meta.url), 'utf8');

  it('jen typový import akce lišty; žádný runtime import', () => {
    const imports = [...source.matchAll(/^import .*$/gm)].map(match => match[0]);
    expect(imports).toEqual(["import type { LiveSafetyAction, LiveSafetyTarget } from './liveSafetyAction';"]);
  });

  it('nikdy nevolá akci lišty, desk ani síť', () => {
    expect(source).not.toMatch(/\b(onAction|runStaticSafetyAction|executeSafetyCommand|flattenCoordinator|run|executeTradovateCopierRelayCommand|fetch)\s*\(/);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|setTimeout/);
  });
});
