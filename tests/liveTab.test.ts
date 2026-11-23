import { describe, expect, it } from 'vitest';

import { liveTabFromSearch, liveTabHref } from '../lib/liveTab';

describe('Tradovate LIVE deep link', () => {
  it('otevře Connections pro pairing odkaz z Macu', () => {
    expect(liveTabFromSearch('?page=live&tab=connections')).toBe('connections');
  });

  it('otevře Connections pro jednorázový pairing intent', () => {
    expect(liveTabFromSearch('?open=mac-companion-pairing')).toBe('connections');
  });

  it('otevře samostatnou záložku Risk', () => {
    expect(liveTabFromSearch('?page=live&tab=risk')).toBe('risk');
  });

  it('vytvoří sdílitelnou Risk URL a zachová ostatní query i hash', () => {
    expect(liveTabHref(
      'https://alphatrade.app/?page=live&connection=demo#copier',
      'risk',
    )).toBe('/?page=live&connection=demo&tab=risk#copier');
  });

  it('pro neznámý nebo chybějící tab bezpečně použije přehled', () => {
    expect(liveTabFromSearch('?page=live&tab=broker-controls')).toBe('overview');
    expect(liveTabFromSearch('?page=live')).toBe('overview');
    expect(liveTabFromSearch('')).toBe('overview');
  });
});
