import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkerDiscoveryNotice } from '../components/LiveCopyTradeOverview';

// 4. 10. 2026: účty z propfirmy mimo Mac worker — místo CLI jednorázový souhlas.
const render = (props: Parameters<typeof WorkerDiscoveryNotice>[0]) => renderToStaticMarkup(
  React.createElement(WorkerDiscoveryNotice, props),
);
const discovery = (scope: 'owner' | 'connection' | null, pending: string[] = []) => ({
  scope, deviceId: 'd1', loadedConnectionIds: ['lucid'], pendingConnectionIds: pending, failedConnections: [],
});

describe('WorkerDiscoveryNotice', () => {
  it('bez souhlasu nabídne povolení a nezmiňuje instalaci přes terminál', () => {
    const html = render({ discovery: discovery('connection'), missingAccounts: 2, onGrant: async () => undefined });
    expect(html).toContain('Povolit Macu načítat propfirmy');
    expect(html).toContain('2 účtů je');
    expect(html).not.toContain('reinstall');
  });

  it('se souhlasem a čekajícím připojením vysvětlí, kdy se načte, a tlačítko neukáže', () => {
    const html = render({ discovery: discovery('owner', ['fn']), missingAccounts: 1, onGrant: async () => undefined });
    expect(html).toContain('jakmile bude kopírka vypnutá');
    expect(html).not.toContain('Povolit Macu');
  });
});
