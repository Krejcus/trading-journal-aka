import { describe, expect, it } from 'vitest';
import { createNativeLiveActivityGrant, verifyNativeLiveActivityGrant, LIVE_ACTIVITY_GRANT_TTL_S } from '../server/nativeLiveActivityGrant';
import { buildApnsLiveActivityStartPayload } from '../server/apns';

const secret = 'test-registration-key-at-least-32-characters';
const now = Date.parse('2026-09-13T16:00:00Z');
const scope = { userId: 'user-a', subscriptionId: 'installation-subscription', sessionId: 'remote-session' };
describe('session-scoped background registration grant', () => {
  it('accepts an intact grant only within its lifetime and with its signing key', () => {
    const token = createNativeLiveActivityGrant(scope, secret, now);
    expect(verifyNativeLiveActivityGrant(token, secret, now)).toMatchObject(scope);
    expect(verifyNativeLiveActivityGrant(token, secret, now + LIVE_ACTIVITY_GRANT_TTL_S * 1_000)).toBeNull();
    expect(verifyNativeLiveActivityGrant(token, 'different-key-at-least-32-characters', now)).toBeNull();
    expect(verifyNativeLiveActivityGrant(token, secret, now - 60_000)).toBeNull();
  });
  it('rejects scope tampering, malformed and oversized credentials', () => {
    const token = createNativeLiveActivityGrant(scope, secret, now);
    const [payload, signature] = token.split('.');
    const edited = JSON.parse(Buffer.from(payload, 'base64url').toString());
    edited.userId = 'user-b';
    expect(verifyNativeLiveActivityGrant(`${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${signature}`, secret, now)).toBeNull();
    for (const malformed of ['', 'a.b.c', 'e30.x', '*.*', 'a'.repeat(2_001)]) {
      expect(verifyNativeLiveActivityGrant(malformed, secret, now)).toBeNull();
    }
    expect(() => createNativeLiveActivityGrant(scope, '', now)).toThrow();
  });
  it('includes the grant only in start attributes and keeps a rich payload below APNs 4KB', () => {
    const token = createNativeLiveActivityGrant(scope, secret, now);
    const payload = buildApnsLiveActivityStartPayload({
      attributes: { sessionID: scope.sessionId, symbol: 'MNQ', registrationToken: token },
      state: {
        status: 'ARM LIVE', headline: 'LONG 3 MNQ', detail: '3 účty', pnlText: '+$325.50',
        isPositive: true, progress: 0.5, updatedAt: now / 1_000,
        mode: 'position', symbol: 'MNQ', side: 'Long', quantity: 3,
        entryPrice: 20_950, currentPrice: 20_962, stopPrice: 20_935, targetPrice: 20_980,
        dayTrades: Array.from({ length: 8 }, () => ({ pnl: -50.25, exit: 'SL' as const, closedAt: now / 1_000 })),
      },
      alert: { title: 'Copier je ARM', body: 'Kopírka je zapnutá' },
    });
    expect(payload).toMatchObject({ aps: { attributes: { registrationToken: token } } });
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(4_096);
    expect(JSON.stringify(payload)).not.toContain(secret);
  });
});
