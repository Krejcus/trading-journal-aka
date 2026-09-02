import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';

const RATE_KEY_DOMAIN = 'alphatrade/mac-companion/pairing-rate-key/v1';
const MAX_RETRY_AFTER_SECONDS = 10 * 60;

type HeaderValue = string | string[] | undefined;

export interface MacCompanionClientAddressSource {
  headers: Record<string, HeaderValue>;
  remoteAddress?: string | null;
  isVercel?: boolean;
}

export interface MacCompanionPairingRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

const firstHeaderValue = (value: HeaderValue): string | null => {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string') return null;
  const first = text.split(',', 1)[0]?.trim();
  return first || null;
};

/** Canonicalize enough to prevent alternate IPv6 spellings from creating new buckets. */
export function canonicalMacCompanionClientAddress(value: string): string | null {
  const candidate = value.trim();
  if (!candidate || candidate.length > 64 || candidate.includes('%')) return null;
  if (isIP(candidate) === 4) return candidate;
  if (isIP(candidate) !== 6) return null;

  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname.toLowerCase();
    const canonical = hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
    if (!mapped) return canonical;
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  } catch {
    return null;
  }
}

/**
 * Vercel overwrites these headers with the public client IP. Production fails
 * closed if neither is present; a socket fallback exists only for local tests.
 */
export function resolveMacCompanionClientAddress(
  source: MacCompanionClientAddressSource,
): string {
  for (const name of ['x-vercel-forwarded-for', 'x-forwarded-for'] as const) {
    const raw = firstHeaderValue(source.headers[name]);
    if (!raw) continue;
    const canonical = canonicalMacCompanionClientAddress(raw);
    if (!canonical) throw new Error('mac-companion-client-address-unavailable');
    return canonical;
  }

  if (source.isVercel) throw new Error('mac-companion-client-address-unavailable');
  const local = source.remoteAddress
    ? canonicalMacCompanionClientAddress(source.remoteAddress)
    : null;
  if (!local) throw new Error('mac-companion-client-address-unavailable');
  return local;
}

/** The database receives only a domain-separated, server-keyed 64-hex digest. */
export function hashMacCompanionClientAddress(
  clientAddress: string,
  serverSecret: string,
): string {
  const canonical = canonicalMacCompanionClientAddress(clientAddress);
  if (!canonical || !serverSecret) throw new Error('invalid-mac-companion-rate-key');
  const derivedKey = createHmac('sha256', serverSecret)
    .update(RATE_KEY_DOMAIN, 'utf8')
    .digest();
  return createHmac('sha256', derivedKey).update(canonical, 'utf8').digest('hex');
}

const parseDecision = (value: unknown): MacCompanionPairingRateLimitDecision | null => {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== 'object') return null;
  const record = candidate as Record<string, unknown>;
  if (record.allowed === true && record.retryAfterSeconds === 0) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (
    record.allowed === false
    && typeof record.retryAfterSeconds === 'number'
    && Number.isSafeInteger(record.retryAfterSeconds)
    && record.retryAfterSeconds >= 1
    && record.retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS
  ) {
    return { allowed: false, retryAfterSeconds: record.retryAfterSeconds };
  }
  return null;
};

export async function consumeMacCompanionPairingStartLimit(options: {
  db: SupabaseClient;
  clientAddressHash: string;
}): Promise<MacCompanionPairingRateLimitDecision> {
  if (!/^[0-9a-f]{64}$/.test(options.clientAddressHash)) {
    throw new Error('invalid-mac-companion-rate-key');
  }
  const { data, error } = await options.db.rpc('consume_mac_companion_pairing_start_limit', {
    target_ip_hash: options.clientAddressHash,
  });
  if (error) throw new Error(`mac-companion-pairing-rate-limit-failed:${error.message}`);
  const decision = parseDecision(data);
  if (!decision) throw new Error('mac-companion-pairing-rate-limit-invalid-response');
  return decision;
}
