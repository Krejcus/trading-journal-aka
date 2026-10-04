import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { copierPowerDisplayKey } from '../lib/copierPowerDisplay';
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
  it('dokud stav runtime neznáme a nemáme potvrzený stav, netvrdí OFF a nabízí jen vypnutí', () => {
    const markup = render({ statusPending: true });
    // Přepínač se v tomto stavu nevykreslí — armovaný copier by se jinak
    // tvářil jako odpojený a kliknutí by ho zapnulo naostro. Místo něj je
    // „Neověřeno“, které smí otevřít jen potvrzení vypnutí (ST1).
    expect(markup).not.toContain('role="switch"');
    expect(markup).toContain('Neověřeno');
    expect(markup).toContain('aria-label="Stav kopírky neověřen — vypnout kopírku"');
    expect(markup).not.toContain('Zapnout kopírovací skupinu');
  });

  it('neověřený stav s posledním potvrzeným ZAPNUTO ukazuje ON a nabízí jen vypnutí', () => {
    const key = copierPowerDisplayKey('user-1', 'group-1');
    const store = new Map<string, string>([[key, JSON.stringify({ connected: true, confirmedAt: Date.now() - 1_000 })]]);
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } });
    try {
      const markup = render({ statusPending: true, powerDisplayKey: key, connected: false });
      expect(markup).toContain('role="switch"');
      expect(markup).toContain('aria-checked="true"');
      expect(markup).toContain('data-copier-power-display="retained"');
      expect(markup).toContain('Vypnout kopírovací skupinu (stav se ověřuje)');
      expect(markup).not.toContain('disabled=""');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('neověřený stav s posledním potvrzeným VYPNUTO nedovolí zapnout', () => {
    const key = copierPowerDisplayKey('user-1', 'group-2');
    const store = new Map<string, string>([[key, JSON.stringify({ connected: false, confirmedAt: Date.now() - 1_000 })]]);
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } });
    try {
      const markup = render({ statusPending: true, powerDisplayKey: key, connected: true });
      expect(markup).toContain('aria-checked="false"');
      expect(markup).toContain('disabled=""');
      expect(markup).toContain('Zapnout půjde až po ověření');
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('během zapínání točí spinner a dovolí zrušení přes OFF', () => {
    const markup = render({ transition: 'connecting' });
    expect(markup).toContain('copier-switch-busy');
    expect(markup).toContain('copier-switch-spinner');
    expect(markup).toContain('animate-spin');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain('Zrušit zapínání kopírky');
  });

  it('zrušení zapínání zůstává dostupné i při ztrátě ověřeného stavu', () => {
    const markup = render({ transition: 'connecting', statusPending: true, runtimeReady: false });
    expect(markup).toContain('Zrušit zapínání kopírky');
    expect(markup).not.toContain('disabled=""');
  });

  it('během vypínání nedovolí zahájit další akci', () => {
    expect(render({ transition: 'disconnecting' })).toContain('disabled=""');
  });
});
