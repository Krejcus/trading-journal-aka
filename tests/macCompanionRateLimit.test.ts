import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  canonicalMacCompanionClientAddress,
  consumeMacCompanionPairingStartLimit,
  hashMacCompanionClientAddress,
  resolveMacCompanionClientAddress,
} from '../server/macCompanionRateLimit';

describe('mac companion pairing start rate limit', () => {
  it('prefers the Vercel-controlled address and canonicalizes IPv6 spellings', () => {
    expect(resolveMacCompanionClientAddress({
      headers: {
        'x-vercel-forwarded-for': '2001:0db8:0000:0000:0000:0000:0000:0001',
        'x-forwarded-for': '198.51.100.7',
      },
      isVercel: true,
    })).toBe('2001:db8::1');
    expect(canonicalMacCompanionClientAddress('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(canonicalMacCompanionClientAddress('::ffff:c000:201')).toBe('192.0.2.1');
  });

  it('fails closed on Vercel without a valid platform address', () => {
    expect(() => resolveMacCompanionClientAddress({ headers: {}, isVercel: true }))
      .toThrow('mac-companion-client-address-unavailable');
    expect(() => resolveMacCompanionClientAddress({
      headers: { 'x-vercel-forwarded-for': 'not-an-ip' },
      remoteAddress: '127.0.0.1',
      isVercel: true,
    })).toThrow('mac-companion-client-address-unavailable');
  });

  it('stores only a stable domain-separated HMAC, never a raw address or key', () => {
    const secret = 'backend-only-service-role-key';
    const first = hashMacCompanionClientAddress('192.0.2.1', secret);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(hashMacCompanionClientAddress('::ffff:192.0.2.1', secret));
    expect(first).not.toContain('192.0.2.1');
    expect(first).not.toContain(secret);
    expect(first).not.toBe(hashMacCompanionClientAddress('192.0.2.2', secret));
    expect(first).not.toBe(hashMacCompanionClientAddress('192.0.2.1', `${secret}-rotated`));
  });

  it('accepts only the fixed RPC decision shape and forwards only the digest', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: false, retryAfterSeconds: 37 },
      error: null,
    });
    const db = { rpc } as unknown as SupabaseClient;
    const digest = 'a'.repeat(64);
    await expect(consumeMacCompanionPairingStartLimit({ db, clientAddressHash: digest }))
      .resolves.toEqual({ allowed: false, retryAfterSeconds: 37 });
    expect(rpc).toHaveBeenCalledWith('consume_mac_companion_pairing_start_limit', {
      target_ip_hash: digest,
    });
    await expect(consumeMacCompanionPairingStartLimit({
      db: { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) } as unknown as SupabaseClient,
      clientAddressHash: digest,
    })).rejects.toThrow('mac-companion-pairing-rate-limit-invalid-response');
  });
});
