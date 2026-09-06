import { describe, expect, it } from 'vitest';

import {
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
