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
    expect(markup).toContain('aria-label="Vypnout kopírovací skupinu"');
    // Od 19. 9. je to přepínač: stav nese `aria-checked` a popisky v koleji,
    // ne text „ZAPNUTÁ" schovaný za hoverem.
    expect(markup).toContain('copier-switch');
    expect(markup).toContain('>ON<');
    expect(markup).toContain('>OFF<');
  });

  it('odpojený runtime nabízí připojení a hlásí ostrý provoz', () => {
    const markup = render();
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain('aria-label="Zapnout kopírovací skupinu"');
    expect(markup).toContain('naostro');
  });

  it('kill switch, denní zámek ani cooldown nepustí připojení', () => {
    const markup = render({ connectBlocked: true });
    expect(markup).toContain('disabled=""');
  });

  it('během přechodu točí spinner v knoflíku a nepustí další kliknutí', () => {
    const markup = render({ transition: 'connecting' });
    expect(markup).toContain('copier-switch-busy');
    expect(markup).toContain('copier-switch-spinner');
    expect(markup).toContain('animate-spin');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('disabled=""');
  });
});
