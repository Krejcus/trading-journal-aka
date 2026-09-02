import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  MacCompanionSettingsView,
  macCompanionDeviceActivityLabel,
  sortMacCompanionDevices,
  type MacCompanionSettingsViewProps,
} from '../components/MacCompanionSettings';
import type { MacCompanionDevice } from '../services/macCompanionApi';

const now = Date.parse('2026-09-01T10:00:00.000Z');
const activeDevice: MacCompanionDevice = {
  id: '11111111-1111-4111-8111-111111111111',
  deviceName: 'Filipův MacBook',
  createdAt: '2026-09-01T09:00:00.000Z',
  pairedAt: '2026-09-01T09:01:00.000Z',
  lastSeenAt: '2026-09-01T09:55:00.000Z',
  revokedAt: null,
};
const revokedDevice: MacCompanionDevice = {
  ...activeDevice,
  id: '22222222-2222-4222-8222-222222222222',
  deviceName: 'Starý Mac',
  lastSeenAt: '2026-08-30T09:00:00.000Z',
  revokedAt: '2026-09-01T09:30:00.000Z',
};

const baseProps: MacCompanionSettingsViewProps = {
  devices: [],
  listLoading: false,
  busyAction: null,
  pairingCode: '',
  editingDeviceId: null,
  editingDeviceName: '',
  error: null,
  notice: null,
  now,
  onPairingCodeChange: () => undefined,
  onPair: () => undefined,
  onRefresh: () => undefined,
  onBeginRename: () => undefined,
  onEditingDeviceNameChange: () => undefined,
  onSaveRename: () => undefined,
  onCancelRename: () => undefined,
  onRevoke: () => undefined,
  onDismissError: () => undefined,
};

const render = (props: Partial<MacCompanionSettingsViewProps> = {}): string => (
  renderToStaticMarkup(React.createElement(MacCompanionSettingsView, { ...baseProps, ...props }))
);

describe('Mac companion nastavení v PWA', () => {
  it('před prvním výsledkem ukazuje loading a netvrdí prázdný seznam', () => {
    const markup = render({ devices: null, listLoading: true });
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Načítám spárované Macy');
    expect(markup).not.toContain('Zatím není spárovaný žádný Mac');
  });

  it('vysvětluje read-only hranici a přijímá pouze jednorázový kód v paměti formuláře', () => {
    const markup = render();
    expect(markup).toContain('AlphaTrade Status pro Mac');
    expect(markup).toContain('Pouze čtení');
    expect(markup).toContain('Neumí zapnout kopírování, zavřít pozice ani poslat brokerovi příkaz');
    expect(markup).toContain('placeholder="7K2D-P9HX-W3QM"');
    expect(markup).toContain('autoComplete="one-time-code"');
    expect(markup).not.toContain('ARM');
    expect(markup).not.toContain('Flatten');
  });

  it('vykreslí aktivní i odvolaný Mac, ale akce nabízí jen aktivnímu', () => {
    const markup = render({ devices: [activeDevice, revokedDevice] });
    expect(markup).toContain('Filipův MacBook');
    expect(markup).toContain('Starý Mac');
    expect(markup).toContain('Aktivní před 5 min');
    expect(markup).toContain('Odvoláno');
    expect(markup.match(/Přejmenovat/g)).toHaveLength(2); // title + aria-label aktivního Macu
    expect(markup.match(/Odvolat přístup pro/g)).toHaveLength(1);
  });

  it('při chybě obnovení zachová poslední známý seznam a nabídne zavření chyby', () => {
    const markup = render({
      devices: [activeDevice],
      listLoading: false,
      error: 'Seznam Maců se nepodařilo načíst. Zkus to znovu.',
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Filipův MacBook');
    expect(markup).toContain('aria-label="Zavřít chybu"');
  });

  it('během párování blokuje další mutace a sdělí probíhající stav', () => {
    const markup = render({
      devices: [activeDevice],
      pairingCode: '7K2D-P9HX-W3QM',
      busyAction: { kind: 'pair' },
    });
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Páruji…');
    expect(markup).toContain('disabled=""');
  });

  it('řadí aktivní Macy před odvolané a stav počítá z posledního kontaktu', () => {
    expect(sortMacCompanionDevices([revokedDevice, activeDevice]).map(device => device.id)).toEqual([
      activeDevice.id,
      revokedDevice.id,
    ]);
    expect(macCompanionDeviceActivityLabel(activeDevice, now)).toBe('Aktivní před 5 min');
    expect(macCompanionDeviceActivityLabel({ ...activeDevice, lastSeenAt: null }, now)).toBe('Ještě se nepřipojil');
  });
});
