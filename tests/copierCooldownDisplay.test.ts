import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildCopierCooldownDisplay, copierPauseDeadline, formatCopierCountdown, type CopierCooldownInput } from '../services/copierCooldownDisplay';
import CopierCooldownPanel from '../components/CopierCooldownPanel';
import { LiveCopyTradeOverview } from '../components/LiveCopyTradeOverview';
import type { LiveSnapshot } from '../services/tradecopiaLiveService';

const viewport = vi.hoisted(() => ({ compact: false }));
vi.mock('../utils/useCompactViewport', () => ({ useCompactViewport: () => viewport.compact }));
const start = Date.UTC(2026, 8, 10, 12);
const input: CopierCooldownInput = {
  cooldownUntil: start + 15 * 60_000, cooldownMinutes: 15,
  pause: { until: start + 20 * 60_000, at: start, rule: 'losing-trades' }, known: true,
  status: { started: true, armed: false, shadowMode: false, connected: true, killSwitch: false,
    reconciliationRequired: false, divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false,
    stuckOperations: [], lastError: null, revision: 1, lastSequence: 0, groupFlat: true },
};
afterEach(() => { vi.useRealTimers(); viewport.compact = false; });

describe('cooldown display', () => {
  it('reproduces the 15-minute cooldown / 20-minute risk pause gap', () => {
    const model = buildCopierCooldownDisplay(input, start + 17 * 60_000);
    expect(model.active).toBe(true);
    expect(model.seconds).toBe(180);
    expect(model.cooldown.active).toBe(false);
    expect(model.pause.active).toBe(true);
    expect(model.title).toBe('Pauza po ztrátě');
    expect(model.progress).toBeCloseTo(0.85);
  });
  it('uses cooldown when it ends later, including without a risk pause', () => {
    const model = buildCopierCooldownDisplay({ ...input, cooldownUntil: start + 30 * 60_000, cooldownMinutes: 30 }, start);
    expect(model.seconds).toBe(1800);
    expect(model.title).toBe('Cooldown po obchodu');
    expect(buildCopierCooldownDisplay({ ...input, pause: null }, start).seconds).toBe(900);
  });
  it('expires exactly at deadline without claiming automatic ARM', () => {
    const model = buildCopierCooldownDisplay(input, input.pause!.until);
    expect(model.active).toBe(false);
    expect(model.seconds).toBe(0);
    expect(model.subtitle).toBe('Kopírka zůstává vypnutá. Sama se nezapne.');
    expect(input.status?.armed).toBe(false);
  });
  it.each([
    [{ known: false }, 'Stav workeru není ověřený.'],
    [{ status: null }, 'Stav workeru není ověřený.'],
    [{ status: { ...input.status!, connected: false } }, 'Spojení s brokerem není potvrzené.'],
    [{ status: { ...input.status!, dayLockUntil: start + 3_600_000 } }, 'Den zůstává zamčený.'],
    [{ status: { ...input.status!, killSwitch: true } }, 'Zapnutí blokuje kill switch.'],
    [{ status: { ...input.status!, stuckOutbox: true } }, 'Před dalším zapnutím je nutná kontrola účtů.'],
    [{ status: { ...input.status!, reconciliationRequired: true } }, 'Před dalším zapnutím je nutná kontrola účtů.'],
  ])('retains blockers after time elapsed: %j', (override, message) => {
    expect(buildCopierCooldownDisplay({ ...input, ...override }, input.pause!.until).subtitle).toBe(message);
  });
  it('sanitizes missing deadlines and rounds seconds upwards', () => {
    expect(copierPauseDeadline(NaN, -1)).toBe(0);
    expect(formatCopierCountdown(167.1)).toBe('02:48');
    expect(formatCopierCountdown(-1)).toBe('00:00');
    expect(buildCopierCooldownDisplay(input, input.pause!.until - 1).seconds).toBe(1);
  });
  it('renders completion but never a success animation for unknown or locked status', () => {
    vi.useFakeTimers(); vi.setSystemTime(input.pause!.until);
    const normal = renderToStaticMarkup(React.createElement(CopierCooldownPanel, input));
    expect(normal).toContain('data-copier-cooldown="elapsed"');
    expect(normal).toContain('copier-cooldown-complete');
    for (const overrides of [{ known: false }, { status: { ...input.status!, dayLockUntil: start + 3_600_000 } }]) {
      const markup = renderToStaticMarkup(React.createElement(CopierCooldownPanel, { ...input, ...overrides }));
      expect(markup).not.toContain('copier-cooldown-complete');
      expect(markup).not.toContain('data-copier-cooldown="elapsed"');
    }
  });
  it('hides absent or old pauses', () => {
    vi.useFakeTimers(); vi.setSystemTime(input.pause!.until + 10_001);
    expect(renderToStaticMarkup(React.createElement(CopierCooldownPanel, input))).toBe('');
    expect(renderToStaticMarkup(React.createElement(CopierCooldownPanel, { ...input, pause: null, cooldownUntil: 0 }))).toBe('');
  });
  it('shows the later pause end as a local clock time without opening details', () => {
    vi.useFakeTimers(); vi.setSystemTime(start + 17 * 60_000);
    const markup = renderToStaticMarkup(React.createElement(CopierCooldownPanel, input));
    const deadline = new Date(input.pause!.until);
    expect(markup).toContain('Konec pauzy v');
    expect(markup).toContain(`dateTime="${deadline.toISOString()}"`);
    expect(markup).toContain(deadline.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
    expect(markup).not.toContain('copier-cooldown-details');
    const unknown = renderToStaticMarkup(React.createElement(CopierCooldownPanel, { ...input, known: false }));
    expect(unknown).not.toContain('Konec pauzy v');
  });
  it.each([false, true])('shows pause in group even when cooldown ended; compact=%s', compact => {
    viewport.compact = compact;
    vi.useFakeTimers(); vi.setSystemTime(start + 17 * 60_000);
    const runtimeGroup = { id: 'test', name: 'Hlavní', enabled: true, leaderAccountId: 100, followers: [] };
    const snapshot: LiveSnapshot = { run: null, accounts: [], appAccounts: [], connections: [], groups: [], alerts: [], totalBalance: 0, totalEquity: 0, totalRealizedPnl: 0, totalUnrealizedPnl: 0, worstCushion: null };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot, runtimeGroup, executionGroupId: 'test', cooldownUntil: input.cooldownUntil, pause: input.pause,
      runtimeStatus: input.status, runtimeAvailable: true, copierArmed: false, onSwitchAndArm: () => undefined,
    }));
    expect(markup).toContain('data-copier-cooldown="active"');
    expect(markup).toContain('03:00');
    expect(markup).not.toContain('Ukázka cooldownu');
    const power = markup.match(/<button[^>]*aria-label="Zapnout kopírovací skupinu"[^>]*>/)?.[0];
    expect(power).toBeDefined();
    expect(power).toMatch(/\sdisabled(?:=""|\s|>)/);
    const armedMarkup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot, runtimeGroup, executionGroupId: 'test', cooldownUntil: input.cooldownUntil, pause: input.pause,
      runtimeStatus: { ...input.status!, armed: true }, runtimeAvailable: true, copierArmed: true,
      onSwitchAndArm: () => undefined, onDisarm: () => undefined,
    }));
    const disarm = armedMarkup.match(/<button[^>]*aria-label="Vypnout kopírovací skupinu"[^>]*>/)?.[0];
    expect(disarm).toBeDefined();
    expect(disarm).not.toMatch(/\sdisabled(?:=""|\s|>)/);
  });
});
