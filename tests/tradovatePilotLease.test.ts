import { describe, expect, it } from 'vitest';
import {
  createTradovatePilotKeyPair,
  openTradovatePilotLease,
  sealTradovatePilotLease,
} from '../server/tradovatePilotLease';

const now = Date.parse('2026-08-16T08:00:00.000Z');

describe('Tradovate pilot lease', () => {
  it('round-trips a demo access token without putting it in the envelope', () => {
    const keys = createTradovatePilotKeyPair();
    const payload = {
      version: 1 as const,
      environment: 'demo' as const,
      connectionId: 'connection-1',
      accountSpec: 'user@example.com',
      accessToken: 'broker-secret-token',
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
    };
    const envelope = sealTradovatePilotLease(payload, keys.publicKey, now);

    expect(JSON.stringify(envelope)).not.toContain(payload.accessToken);
    expect(openTradovatePilotLease(envelope, keys.privateKey, now)).toEqual(payload);
  });

  it('rejects an expired lease and the wrong private key', () => {
    const keys = createTradovatePilotKeyPair();
    const other = createTradovatePilotKeyPair();
    const payload = {
      version: 1 as const,
      environment: 'demo' as const,
      connectionId: 'connection-1',
      accountSpec: 'user@example.com',
      accessToken: 'broker-secret-token',
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
    };
    const envelope = sealTradovatePilotLease(payload, keys.publicKey, now);

    expect(() => openTradovatePilotLease(envelope, other.privateKey, now)).toThrow();
    expect(() => openTradovatePilotLease(envelope, keys.privateKey, now + 59 * 60_000)).toThrow('pilot-lease-expired');
  });
});
