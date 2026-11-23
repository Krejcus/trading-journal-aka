import { describe, expect, it } from 'vitest';
import { appDeepLinkIntentFromSearch, consumeAppDeepLinkUrl } from '../lib/appDeepLink';

describe('odkaz do appky', () => {
  it('otevře podporovanou stránku, neznámou ignoruje', () => {
    expect(appDeepLinkIntentFromSearch('?page=history')).toEqual({ page: 'history' });
    expect(appDeepLinkIntentFromSearch('?page=live&tab=connections')).toEqual({ page: 'live' });
    expect(appDeepLinkIntentFromSearch('?page=nope')).toBeNull();
    expect(appDeepLinkIntentFromSearch('?open=mac-companion-pairing')).toBeNull();
  });
  it('po otevření smaže page a tab, ostatní parametry nechá', () => {
    expect(consumeAppDeepLinkUrl('https://x.test/?page=live&tab=chart&a=1#h')).toBe('/?a=1#h');
    expect(consumeAppDeepLinkUrl('https://x.test/?page=nope&a=1')).toBe('/?page=nope&a=1');
  });
});
