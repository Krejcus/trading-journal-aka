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
const render = (value: CopierControllerStatus, known = true, legacyReconcile?: () => Promise<void>) => renderToStaticMarkup(
  React.createElement(CopierMaintenancePanel, { status: value, known, legacyReconcile }),
);

describe('CopierMaintenancePanel', () => {
  it('za čistého stavu nic nezobrazí', () => {
    expect(render(status())).toBe('');
  });

  it('čekající reconciliation bez incidentu panel nerozsvítí (kontrolu dělá Zapnout)', () => {
    expect(render(status({ reconciliationRequired: true }))).toBe('');
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

  it('za ARM nic nezobrazí', () => {
    expect(render(status({ armed: true, manualRecovery: { id: 'i', at: 1, reason: 'x' } }))).toBe('');
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

  it.each(['needed', 'checking'] as const)('běžná příprava %s nevyžaduje ruční kontrolu', state => {
    const html = render(status({ reconciliationRequired: true,
      armPreparation: { state, verifiedAt: null, reason: null, blockedBy: null, manualRecoveryRequired: false } }));
    expect(html).toBe('');
  });

  it.each(['kill-switch', 'starting', 'recovery'] as const)(
    'blokátor %s nenabízí Kontrolu pozic',
    blockedBy => {
      const html = render(status({ reconciliationRequired: true,
        armPreparation: {
          state: 'blocked', verifiedAt: null, reason: `Blokováno: ${blockedBy}`,
          blockedBy, manualRecoveryRequired: blockedBy === 'kill-switch',
        } }));
      expect(html).not.toContain('Zkontrolovat pozice');
      expect(html).toBe('');
    },
  );

  it('po incidentu ukáže důvod a že se ověří při zapnutí; tlačítko Kontrola pozic už neexistuje', () => {
    const html = render(status({ reconciliationRequired: true,
      manualRecovery: { id: 'i', at: 1_791_000_000_000, reason: 'leader-flat guard: follower 200 nesedí' },
      armPreparation: { state: 'blocked', verifiedAt: null,
        reason: 'Po incidentu je potřeba ruční Kontrola pozic', blockedBy: 'incident',
        manualRecoveryRequired: true } }));
    expect(html).toContain('Po incidentu: leader-flat guard: follower 200 nesedí');
    expect(html).toContain('Ověří se při zapnutí');
    expect(html).not.toContain('Zkontrolovat pozice');
    expect(html).not.toContain('<button');
  });

  it('starší worker bez potvrzení v ON: zachová ruční Kontrolu pozic (přechod při nasazení)', () => {
    const html = render(status({ reconciliationRequired: true,
      armPreparation: { state: 'blocked', verifiedAt: null,
        reason: 'Po incidentu je potřeba ruční Kontrola pozic', blockedBy: 'incident',
        manualRecoveryRequired: true } }), true, async () => undefined);
    expect(html).toContain('Zkontrolovat pozice');
  });
});
