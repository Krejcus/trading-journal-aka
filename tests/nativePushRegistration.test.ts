import { describe, expect, it } from 'vitest';
import { buildApnsPayload, buildApnsWidgetPayload } from '../server/apns';
import { normalizeNativePushRegistration } from '../server/nativePushRegistration';

const TOKEN = 'ab'.repeat(32);

describe('native APNs registration', () => {
  it('accepts a bounded iOS token and normalizes it', () => {
    expect(normalizeNativePushRegistration({
      deviceToken: TOKEN.toUpperCase(),
      environment: 'development',
      bundleId: 'app.alphatrade.native',
      appVersion: '1.0',
      deviceModel: 'iPhone',
    })).toEqual({
      deviceToken: TOKEN,
      environment: 'development',
      bundleId: 'app.alphatrade.native',
      appVersion: '1.0',
      deviceModel: 'iPhone',
    });
  });

  it('rejects foreign bundles and malformed tokens', () => {
    expect(normalizeNativePushRegistration({ deviceToken: 'not-a-token', environment: 'production' })).toBeNull();
    expect(normalizeNativePushRegistration({
      deviceToken: TOKEN,
      environment: 'production',
      bundleId: 'attacker.example',
    })).toBeNull();
  });

  it('builds a routed time-sensitive APNs alert', () => {
    expect(buildApnsPayload({
      title: 'Copier offline',
      body: 'Worker se neozývá.',
      route: 'live',
      threadId: 'alphatrade-copier',
      category: 'ALPHATRADE_RISK',
      interruptionLevel: 'time-sensitive',
      badge: 1,
    })).toEqual({
      aps: {
        alert: { title: 'Copier offline', body: 'Worker se neozývá.' },
        sound: 'default',
        badge: 1,
        'thread-id': 'alphatrade-copier',
        category: 'ALPHATRADE_RISK',
        'interruption-level': 'time-sensitive',
      },
      route: 'live',
    });
  });

  it('uses the exact silent WidgetKit push payload', () => {
    expect(buildApnsWidgetPayload()).toEqual({ aps: { 'content-changed': true } });
  });
});
