import { describe, expect, it } from 'vitest';

import { tradovateLiveTabFromSearch, tradovateLiveTabHref } from '../lib/tradovateLiveTab';

describe('Tradovate LIVE deep link', () => {
  it('otevře Connections pro pairing odkaz z Macu', () => {
    expect(tradovateLiveTabFromSearch('?page=live&tab=connections')).toBe('connections');
  });

  it('otevře Connections pro jednorázový pairing intent', () => {
    expect(tradovateLiveTabFromSearch('?open=mac-companion-pairing')).toBe('connections');
  });

  it('otevře samostatnou záložku Risk', () => {
    expect(tradovateLiveTabFromSearch('?page=live&tab=risk')).toBe('risk');
  });

  it('vytvoří sdílitelnou Risk URL a zachová ostatní query i hash', () => {
    expect(tradovateLiveTabHref(
      'https://alphatrade.app/?page=live&connection=demo#copier',
      'risk',
    )).toBe('/?page=live&connection=demo&tab=risk#copier');
  });

  it('pro neznámý nebo chybějící tab bezpečně použije přehled', () => {
    expect(tradovateLiveTabFromSearch('?page=live&tab=broker-controls')).toBe('overview');
    expect(tradovateLiveTabFromSearch('?page=live')).toBe('overview');
    expect(tradovateLiveTabFromSearch('')).toBe('overview');
  });
});
