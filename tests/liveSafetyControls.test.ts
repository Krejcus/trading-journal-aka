import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import LiveSafetyControls from '../components/LiveSafetyControls';
import { assertSameSafetyTarget, createFlattenGroupCoordinator, liveSafetyFailureMessage, liveSafetyReceipt, liveSafetyTargetAge } from '../lib/liveSafetyAction';
import type { LocalCopierAgentCommandResult } from '../lib/localCopierAgentProtocol';

const payload = (controller = {}, result?: unknown) => ({ status: { controller: { armed: false, killSwitch: true, ...controller } }, result }) as LocalCopierAgentCommandResult;
const flat = { type: 'flatten', accountIds: [1, 2], operationId: 'manual-test', canceledOrders: 1, submittedClosures: 1, flat: true, remainingPositionAccounts: [], workingOrderAccounts: [] };
const target = (patch = {}) => ({ id: 'g', name: 'Test', accountIds: [1, 2], observedAt: 1_000, verified: true, ...patch });
describe('static LIVE safety shell', () => {
  it('renders all brakes independently of overview imports and never dispatches on render', () => {
    const onAction = vi.fn(async () => 'unused');
    const html = renderToStaticMarkup(React.createElement(LiveSafetyControls, { target: target(), onAction, flattenCoordinator: createFlattenGroupCoordinator(), copierArmed: false }));
    for (const label of ['OFF', 'Kill switch', 'Flatten All']) expect(html).toContain(label);
    expect(html).not.toContain('disabled=');
    expect(html).toContain('native-fixed-above-tab-bar');
    expect(onAction).not.toHaveBeenCalled();
    const slot = readFileSync(new URL('../components/LiveCopyTradeOverviewSlot.tsx', import.meta.url), 'utf8');
    expect(slot).not.toContain('Graf a bezpečnostní ovládání fungují dál');
    const controls = readFileSync(new URL('../components/LiveSafetyControls.tsx', import.meta.url), 'utf8');
    expect(controls).not.toContain('accountIds.join');
    expect(controls).toContain('10 * 60_000');
    expect(controls).toContain('if (copierArmed)');
    const desk = readFileSync(new URL('../components/TradovateLiveDesk.tsx', import.meta.url), 'utf8');
    expect(desk.indexOf('<LiveSafetyControls')).toBeLessThan(desk.indexOf('{chartAvailable ? (', desk.indexOf('const requiresConnection =')));
    expect(desk).toContain('<ErrorBoundary name="LiveTradingScreenSlot"');
    expect(desk).toContain('<ErrorBoundary name="LiveCopyTradeOverviewSlot"');
    expect(desk).toMatch(/route\.transport === 'local' && !fullGroupFlatten/);
    expect(desk.match(/flattenCoordinator\.run\(/g)).toHaveLength(2);
  });
  it('keeps OFF and kill available when the group cannot be determined; flatten is explicit', () => {
    const html = renderToStaticMarkup(React.createElement(LiveSafetyControls, { target: null, onAction: vi.fn(), flattenCoordinator: createFlattenGroupCoordinator(), copierArmed: false }));
    expect((html.match(/disabled=""/g) ?? []).length).toBe(1);
    expect(html).toContain('Skupina workeru nezjištěna');
  });
  it('refuses a changed or missing flatten target', () => {
    const g = target();
    expect(() => assertSameSafetyTarget(g, { ...g, id: 'new' })).toThrow('nebyl odeslán');
    expect(() => assertSameSafetyTarget(undefined, g)).toThrow();
    expect(() => assertSameSafetyTarget(g, { ...g, accountIds: [1, 3] })).toThrow();
    expect(() => assertSameSafetyTarget(g, { ...g, accountIds: [2, 1] })).not.toThrow();
  });
  it('shares a group lock for a local Flatten that remains unresolved beyond 10 seconds', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = createFlattenGroupCoordinator();
      let finish!: (value: string) => void;
      const command = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
      const first = coordinator.run('g', command);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_001);
      const second = coordinator.run('g', command);
      expect(command).toHaveBeenCalledOnce();
      expect(coordinator.pending('g')).toBe(true);
      finish('flat');
      await expect(Promise.all([first, second])).resolves.toEqual(['flat', 'flat']);
      expect(coordinator.pending('g')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('labels stale targets and every unconfirmed failure explicitly', () => {
    expect(liveSafetyTargetAge(target({ verified: false, observedAt: 1_000 }), 62_000)).toContain('1 min');
    expect(liveSafetyFailureMessage(new Error('timeout'))).toContain('Výsledek neověřen; akce se neopakuje');
  });
  it('requires authoritative disarm/kill confirmation and does not label partial flatten as flat', () => {
    expect(liveSafetyReceipt('disarm', payload())).toContain('potvrdil OFF');
    expect(() => liveSafetyReceipt('disarm', payload({ armed: true }))).toThrow();
    expect(() => liveSafetyReceipt('kill-switch', payload({ killSwitch: false }))).toThrow();
    expect(() => liveSafetyReceipt('flatten-group', payload())).toThrow();
    expect(() => liveSafetyReceipt('flatten-group', payload({}, { ...flat, workingOrderAccounts: [1] }))).toThrow();
    expect(() => liveSafetyReceipt('flatten-group', payload({}, { ...flat, flat: false }))).toThrow();
    expect(liveSafetyReceipt('flatten-group', payload({}, { ...flat, pending: true }))).toContain('zatím není potvrzený');
    expect(liveSafetyReceipt('flatten-group', payload({}, flat))).toContain('2 účtů je flat');
    expect(() => liveSafetyReceipt('flatten-group', payload({}, flat), target({ accountIds: [1, 2, 3] }))).toThrow('všechny');
  });
});
