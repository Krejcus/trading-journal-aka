import { describe, expect, it } from 'vitest';

import {
  appDeepLinkIntentFromSearch,
  consumeAppDeepLinkUrl,
  consumeMacCompanionPairingUrl,
  isMacCompanionPairingSearch,
  macCompanionPairingUrl,
} from '../lib/macCompanionDeepLink';

describe('Mac companion pairing deep link', () => {
  it('recognizes the one-shot intent and the installed 0.2.0 legacy link', () => {
    expect(isMacCompanionPairingSearch('?open=mac-companion-pairing')).toBe(true);
    expect(isMacCompanionPairingSearch('?page=live&tab=connections')).toBe(true);
    expect(isMacCompanionPairingSearch('?page=live&tab=overview')).toBe(false);
  });

  it('consumes pairing navigation while preserving unrelated parameters and hash', () => {
    expect(consumeMacCompanionPairingUrl(
      'https://alphatrade-mentor-15.vercel.app/?open=mac-companion-pairing&source=mac#ready',
    )).toBe('/?source=mac#ready');
    expect(consumeMacCompanionPairingUrl(
      'https://alphatrade-mentor-15.vercel.app/?page=live&tab=connections&source=mac',
    )).toBe('/?source=mac');
  });

  it('builds a credential-free production intent URL', () => {
    expect(macCompanionPairingUrl('https://alphatrade-mentor-15.vercel.app')).toBe(
      'https://alphatrade-mentor-15.vercel.app/?open=mac-companion-pairing',
    );
  });
});

describe('PWA page deep link', () => {
  it('parses supported pages and validates the optional LIVE tab', () => {
    expect(appDeepLinkIntentFromSearch('?page=journal')).toEqual({ page: 'journal' });
    expect(appDeepLinkIntentFromSearch('?page=live&tab=overview')).toEqual({
      page: 'live',
      tab: 'overview',
    });
    expect(appDeepLinkIntentFromSearch('?page=live&tab=risk')).toEqual({
      page: 'live',
      tab: 'risk',
    });
    expect(appDeepLinkIntentFromSearch('?page=live&tab=broker-controls')).toEqual({
      page: 'live',
      tab: 'overview',
    });
    expect(appDeepLinkIntentFromSearch('?page=live')).toEqual({ page: 'live', tab: 'overview' });
    expect(appDeepLinkIntentFromSearch('?page=admin')).toBeNull();
    expect(appDeepLinkIntentFromSearch('?tab=overview')).toBeNull();
  });

  it('keeps pairing mapped to LIVE Connections', () => {
    expect(appDeepLinkIntentFromSearch('?open=mac-companion-pairing')).toEqual({
      page: 'live',
      tab: 'connections',
    });
    expect(appDeepLinkIntentFromSearch('?page=live&tab=connections')).toEqual({
      page: 'live',
      tab: 'connections',
    });
  });

  it('consumes a supported page and tab while preserving unrelated URL state', () => {
    expect(consumeAppDeepLinkUrl(
      'https://alphatrade-mentor-15.vercel.app/?page=live&tab=overview&source=mac#ready',
    )).toBe('/?source=mac#ready');
    expect(consumeAppDeepLinkUrl(
      'https://alphatrade-mentor-15.vercel.app/?page=admin&tab=overview#ready',
    )).toBe('/?page=admin&tab=overview#ready');
  });
});
