import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CopierConnectionSwitch } from '../components/LiveCopyTradeOverview';

const render = (props: Partial<Parameters<typeof CopierConnectionSwitch>[0]> = {}) =>
  renderToStaticMarkup(React.createElement(CopierConnectionSwitch, {
    connected: false,
    statusPending: false,
    runtimeReady: true,
    transition: null,
    connectBlocked: false,
    onToggle: () => undefined,
    ...props,
  }));

describe('Connect/Disconnect přepínač copieru', () => {
  it('dokud stav runtime neznáme, netvrdí OFF ani nenabízí kliknutí', () => {
    const markup = render({ statusPending: true });
    // Přepínač se v tomto stavu vůbec nevykreslí — armovaný copier by se
    // jinak tvářil jako odpojený a kliknutí by ho zapnulo naostro.
    expect(markup).not.toContain('role="switch"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Zjišťuji stav copieru');
  });

  it('armovaný runtime hlásí připojeno a nabízí odpojení', () => {
    const markup = render({ connected: true });
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-label="Disconnect copier"');
    expect(markup).toContain('h-11 w-[82px]');
    expect(markup).toContain('h-7 w-full');
  });

  it('odpojený runtime nabízí připojení a hlásí ostrý provoz', () => {
    const markup = render();
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain('aria-label="Connect copier"');
    expect(markup).toContain('naostro');
  });

  it('kill switch, denní zámek ani cooldown nepustí připojení', () => {
    const markup = render({ connectBlocked: true });
    expect(markup).toContain('disabled=""');
  });
});
