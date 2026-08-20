import { describe, expect, it } from 'vitest';
import { buildApnsPayload, buildApnsWidgetPayload } from '../server/apns';
import { normalizeNativePushRegistration } from '../server/nativePushRegistration';
import {
  normalizeNativeLiveActivityRegistration,
  normalizeNativeLiveActivityStartRegistration,
} from '../server/nativeLiveActivityRegistration';
import { copierArmNotification } from '../server/nativeCopierStatePush';

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

  it('accepts a bounded Live Activity token and normalizes it', () => {
    expect(normalizeNativeLiveActivityRegistration({
      activityId: '2FDE40A9-8B6A-49B4-A3A9_AlphaTrade',
      pushToken: TOKEN.toUpperCase(),
      environment: 'development',
      bundleId: 'app.alphatrade.native',
    })).toEqual({
      activityId: '2FDE40A9-8B6A-49B4-A3A9_AlphaTrade',
      pushToken: TOKEN,
      environment: 'development',
      bundleId: 'app.alphatrade.native',
    });
  });

  it('rejects malformed Live Activity registrations', () => {
    expect(normalizeNativeLiveActivityRegistration({
      activityId: 'bad id with spaces',
      pushToken: TOKEN,
      environment: 'development',
    })).toBeNull();
    expect(normalizeNativeLiveActivityRegistration({
      activityId: 'valid-id',
      pushToken: TOKEN,
      environment: 'sandbox',
    })).toBeNull();
    expect(normalizeNativeLiveActivityRegistration({
      activityId: 'valid-id',
      pushToken: TOKEN,
      environment: 'production',
      bundleId: 'attacker.example',
    })).toBeNull();
  });

  it('accepts a device-scoped Live Activity push-to-start token', () => {
    expect(normalizeNativeLiveActivityStartRegistration({
      installationId: '123e4567-e89b-42d3-a456-426614174000',
      pushToken: TOKEN.toUpperCase(),
      environment: 'development',
      bundleId: 'app.alphatrade.native',
    })).toEqual({
      installationId: '123e4567-e89b-42d3-a456-426614174000',
      pushToken: TOKEN,
      environment: 'development',
      bundleId: 'app.alphatrade.native',
    });
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

  it('formats distinct immediate ARM and DISARM confirmations', () => {
    expect(copierArmNotification('arm-started')).toMatchObject({
      title: 'Copier: ARM aktivní',
    });
    expect(copierArmNotification('arm-ended')).toMatchObject({
      title: 'Copier: ARM skončil',
    });
  });

  it('uses the exact silent WidgetKit push payload', () => {
    expect(buildApnsWidgetPayload()).toEqual({ aps: { 'content-changed': true } });
  });
});
