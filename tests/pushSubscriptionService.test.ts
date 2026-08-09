import { describe, expect, it } from 'vitest';
import { buildSubscriptionRow } from '../services/pushSubscriptionService';

const validSubscription = {
  endpoint: 'https://web.push.apple.com/QF1a...',
  expirationTime: null,
  keys: {
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
};

describe('buildSubscriptionRow', () => {
  it('maps a browser PushSubscription JSON to a DB row', () => {
    expect(buildSubscriptionRow('user-1', validSubscription)).toEqual({
      user_id: 'user-1',
      endpoint: validSubscription.endpoint,
      p256dh: validSubscription.keys.p256dh,
      auth: validSubscription.keys.auth,
      expired_at: null,
      last_error: null,
    });
  });

  it('resets expiry flags so a revived endpoint is served again', () => {
    // Cron přeskakuje řádky s expired_at. Když iOS odběr obnoví na stejný
    // endpoint, musí se příznak vynulovat, jinak zařízení zůstane němé.
    const row = buildSubscriptionRow('user-1', validSubscription);
    expect(row?.expired_at).toBeNull();
    expect(row?.last_error).toBeNull();
  });

  it('rejects subscriptions without an endpoint', () => {
    expect(buildSubscriptionRow('user-1', { keys: validSubscription.keys })).toBeNull();
    expect(buildSubscriptionRow('user-1', { ...validSubscription, endpoint: '' })).toBeNull();
  });

  it('rejects subscriptions missing either encryption key', () => {
    // Řádek bez klíčů by v DB tiše seděl a webpush.sendNotification by na něm
    // padal při každém běhu cronu.
    expect(buildSubscriptionRow('user-1', { endpoint: validSubscription.endpoint })).toBeNull();
    expect(buildSubscriptionRow('user-1', {
      endpoint: validSubscription.endpoint,
      keys: { p256dh: validSubscription.keys.p256dh },
    })).toBeNull();
    expect(buildSubscriptionRow('user-1', {
      endpoint: validSubscription.endpoint,
      keys: { auth: validSubscription.keys.auth },
    })).toBeNull();
  });

  it('rejects a missing user id', () => {
    expect(buildSubscriptionRow('', validSubscription)).toBeNull();
  });

  it('survives null and malformed input', () => {
    expect(buildSubscriptionRow('user-1', null)).toBeNull();
    expect(buildSubscriptionRow('user-1', undefined)).toBeNull();
    expect(buildSubscriptionRow('user-1', { endpoint: 42, keys: validSubscription.keys })).toBeNull();
  });
});
