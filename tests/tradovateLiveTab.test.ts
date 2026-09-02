import { describe, expect, it } from 'vitest';

import { tradovateLiveTabFromSearch } from '../lib/tradovateLiveTab';

describe('Tradovate LIVE deep link', () => {
  it('otevře Connections pro pairing odkaz z Macu', () => {
    expect(tradovateLiveTabFromSearch('?page=live&tab=connections')).toBe('connections');
  });

  it('otevře Connections pro jednorázový pairing intent', () => {
    expect(tradovateLiveTabFromSearch('?open=mac-companion-pairing')).toBe('connections');
  });

  it('pro neznámý nebo chybějící tab bezpečně použije přehled', () => {
    expect(tradovateLiveTabFromSearch('?page=live&tab=broker-controls')).toBe('overview');
    expect(tradovateLiveTabFromSearch('?page=live')).toBe('overview');
    expect(tradovateLiveTabFromSearch('')).toBe('overview');
  });
});
