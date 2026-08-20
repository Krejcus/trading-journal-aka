import { describe, expect, it } from 'vitest';
import {
  hashNativeWidgetToken,
  normalizeNativeWidgetPushRegistration,
  normalizeNativeWidgetToken,
} from '../server/nativeWidgetRegistration';

describe('native widget registration', () => {
  it('accepts exactly one 256-bit base64url token and stores only its digest', () => {
    const token = 'A'.repeat(43);
    expect(normalizeNativeWidgetToken(token)).toBe(token);
    expect(hashNativeWidgetToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashNativeWidgetToken(token)).not.toContain(token);
  });

  it('rejects malformed and padded tokens', () => {
    expect(normalizeNativeWidgetToken('A'.repeat(42))).toBeNull();
    expect(normalizeNativeWidgetToken(`${'A'.repeat(42)}=`)).toBeNull();
    expect(normalizeNativeWidgetToken('A'.repeat(42) + '+')).toBeNull();
  });

  it('normalizes an iOS 26 WidgetKit push registration', () => {
    expect(normalizeNativeWidgetPushRegistration({
      deviceToken: 'AB'.repeat(32),
      environment: 'development',
      bundleId: 'app.alphatrade.native',
      enabled: true,
      widgetKinds: ['AlphaTradeCopier', 'AlphaTradeDailyPnL', 'AlphaTradeCopier'],
    })).toEqual({
      deviceToken: 'ab'.repeat(32),
      environment: 'development',
      bundleId: 'app.alphatrade.native',
      enabled: true,
      widgetKinds: ['AlphaTradeCopier', 'AlphaTradeDailyPnL'],
    });
  });

  it('rejects malformed WidgetKit push registrations', () => {
    expect(normalizeNativeWidgetPushRegistration({
      deviceToken: 'bad', environment: 'development', widgetKinds: ['AlphaTradeCopier'],
    })).toBeNull();
    expect(normalizeNativeWidgetPushRegistration({
      deviceToken: 'ab'.repeat(32), environment: 'sandbox', widgetKinds: ['AlphaTradeCopier'],
    })).toBeNull();
    expect(normalizeNativeWidgetPushRegistration({
      deviceToken: 'ab'.repeat(32), environment: 'development', bundleId: 'evil.example', widgetKinds: ['AlphaTradeCopier'],
    })).toBeNull();
  });
});
