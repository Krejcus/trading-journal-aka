import { createHmac, timingSafeEqual } from 'node:crypto';

const DOMAIN = 'alphatrade:live-activity-registration:v1';
export const LIVE_ACTIVITY_GRANT_TTL_S = 9 * 60 * 60;
interface Grant {
  v: 1;
  userId: string;
  subscriptionId: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
}
const signature = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(`${DOMAIN}:${payload}`).digest('base64url');

/** Only authorizes registration/removal of this session, never a Supabase login. */
export function createNativeLiveActivityGrant(
  input: Pick<Grant, 'userId' | 'subscriptionId' | 'sessionId'>,
  secret: string,
  now: number,
): string {
  if (secret.length < 32) throw new Error('live-activity-registration-key-unavailable');
  const issuedAt = Math.floor(now / 1_000);
  const payload = Buffer.from(JSON.stringify({ ...input, v: 1, issuedAt, expiresAt: issuedAt + LIVE_ACTIVITY_GRANT_TTL_S })).toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyNativeLiveActivityGrant(token: string, secret: string, now: number): Grant | null {
  if (secret.length < 32 || token.length > 2_000) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  const [payload, supplied] = parts;
  const expected = signature(payload, secret);
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return null;
  try {
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Grant;
    const seconds = Math.floor(now / 1_000);
    if (grant.v !== 1 || !Number.isInteger(grant.issuedAt) || !Number.isInteger(grant.expiresAt)
      || grant.issuedAt > seconds + 30 || grant.expiresAt <= seconds
      || grant.expiresAt - grant.issuedAt !== LIVE_ACTIVITY_GRANT_TTL_S
      || ![grant.userId, grant.subscriptionId, grant.sessionId].every(value =>
        typeof value === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(value))) return null;
    return grant;
  } catch { return null; }
}
