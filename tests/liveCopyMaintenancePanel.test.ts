import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CopierMaintenancePanel } from '../components/LiveCopyTradeOverview';
import type { CopierControllerStatus } from '../services/copierRuntimeController';

const status = (overrides: Partial<CopierControllerStatus> = {}): CopierControllerStatus => ({
  started: true, armed: false, killSwitch: false, shadowMode: false, connected: true,
  reconciliationRequired: false, divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false,
  stuckOperations: [], lastError: null, revision: 1, lastSequence: 0, groupFlat: true,
  ...overrides,
});
const render = (value: CopierControllerStatus, known = true) => renderToStaticMarkup(
  React.createElement(CopierMaintenancePanel, { status: value, known, onReconcile: async () => undefined }),
);

describe('CopierMaintenancePanel', () => {
  it('za čistého stavu nic nezobrazí', () => {
    expect(render(status())).toBe('');
  });

  it('nabídne Kontrolu pozic, když worker čeká na reconciliation', () => {
    const html = render(status({ reconciliationRequired: true }));
    expect(html).toContain('Zkontrolovat pozice');
    expect(html).toContain('read-only');
  });

  it('zastaralý snapshot pro zapnutí vypnutého followera panel nerozsvítí', () => {
    const html = render(status({
      followerParticipation: [{
        accountId: 200, configuredEnabled: true, effectiveEnabled: true, canToggle: false,
        blockers: ['Snapshot pozic není čerstvý'],
      }],
    }));
    expect(html).toBe('');
  });

  it('za ARM tlačítko nenabízí (Kontrola by kopírku vypnula)', () => {
    expect(render(status({ armed: true, reconciliationRequired: true }))).toBe('');
  });

  it('v režimu opravy vysvětlí nedostupné účty a tlačítko neukáže', () => {
    const html = render(status({
      reconciliationRequired: true,
      startupGroupRepair: { groupId: 'hlavni', unavailableAccountIds: [66142377, 66142378] },
    }));
    expect(html).toContain('66142377, 66142378');
    expect(html).toContain('odeber tyto účty');
    expect(html).not.toContain('Zkontrolovat pozice');
  });

  it('bez ověřeného stavu nic netvrdí', () => {
    expect(render(status({ reconciliationRequired: true }), false)).toBe('');
  });
});
