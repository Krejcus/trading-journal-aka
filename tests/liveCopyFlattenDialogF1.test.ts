import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Review 30. 9. 2026, F1: potvrzovací dialog Flatten při neověřeném stavu
// tvrdil „žádný brokerový příkaz se neodešle“, ale Flatten se workeru odeslal.
vi.mock('react-dom', async importOriginal => {
  const actual = await importOriginal<typeof import('react-dom')>();
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});
(globalThis as { document?: unknown }).document ??= { body: {} };

const { ConfirmActionDialog, confirmActionReachesWorker } = await import('../components/LiveCopyTradeOverview');

const flattenAll = { type: 'flatten-group' as const, groupId: 'g', operationId: 'op-flatten-all-1' };
const reaches = (overrides: Partial<Parameters<typeof confirmActionReachesWorker>[0]> = {}) => confirmActionReachesWorker({
  command: flattenAll, hasAdapter: true, executionGroupId: 'g', runtimeAvailable: false, armed: true, ...overrides,
});

describe('F1: dialog Flatten říká pravdu o odeslání', () => {
  it('Flatten bez čerstvého stavu workeru dojde, konfigurace ne', () => {
    expect(reaches()).toBe(true);
    expect(reaches({ command: { type: 'set-multiplier', groupId: 'g', accountId: 2, multiplier: 2 } })).toBe(false);
    expect(reaches({ hasAdapter: false })).toBe(false);
    expect(reaches({ executionGroupId: 'jina' })).toBe(false);
    expect(reaches({
      command: { type: 'flatten-follower-trade', groupId: 'g', accountId: 2, operationId: 'op-follower-1' },
      armed: false, runtimeAvailable: true,
    })).toBe(false);
  });

  it('dialog při neověřeném stavu varuje, že se akce přesto odešle', () => {
    const html = renderToStaticMarkup(React.createElement(ConfirmActionDialog, {
      action: { title: 'Flatten All?', detail: 'Zavře vše.', confirmLabel: 'Flatten All', danger: true, command: flattenAll },
      busy: false, apiReady: reaches(), stateUnverified: true, onClose: () => undefined, onConfirm: () => undefined,
    }));
    expect(html).toContain('přesto odešle Mac workeru');
    expect(html).not.toContain('žádný brokerový příkaz se neodešle');
  });
});
