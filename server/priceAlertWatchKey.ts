import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Klíč hlídače upozornění na cenu (2. 11. 2026, docs/reviews/price-alerts-contract-20261102.md).
 * Odvozený ze zařízení jako klíč kanálu ceny, ale s vlastním štítkem: vlákno hlídače
 * dostane jen tenhle klíč, nikdy token zařízení (ten autorizuje relay příkazů) —
 * umí jen číst upozornění a hlásit spuštění (INV-WORKER-04, INV-WATCH-01).
 *
 * Nikdy nevyhodí: chybějící tajemství nebo cizí tvar ID = `null` a pole v poll-v2
 * chybí (502 by zablokovalo i DISARM/kill — INV-BRAKE-03). Klíč se neloguje.
 */
export const PRICE_ALERT_WATCH_HEADER = 'x-alphatrade-alert-auth';
export const PRICE_ALERT_WATCH_SKEW_MS = 60_000;

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_SECRET_LENGTH = 32;
const SECRET_ENV = 'TV_PRICE_CHANNEL_SECRET';

export type PriceAlertWatchAction = 'list' | 'trigger';

export function priceAlertWatchGrant(
  deviceId: unknown,
  secret: string | undefined = process.env[SECRET_ENV],
): { key: string; deviceId: string } | null {
  try {
    const value = secret?.trim();
    if (!value || value.length < MIN_SECRET_LENGTH || typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return null;
    const id = deviceId.toLowerCase();
    return { key: createHmac('sha256', value).update(`price-alert-watch-sign:${id}`).digest('base64url'), deviceId: id };
  } catch {
    return null;
  }
}

const bodyDigest = (body: string) => createHash('sha256').update(body).digest('hex');
const mac = (key: string, ts: number, action: string, body: string) => createHmac('sha256', key)
  .update(`${ts}\n${action}\n${bodyDigest(body)}`).digest('base64url');

/** Hlavička `v1.<deviceId>.<ts>.<mac>` pro požadavek hlídače (podpis těla, akce a času). */
export function signPriceAlertWatchRequest(input: { deviceId: string; key: string; action: PriceAlertWatchAction; body: string; ts: number }): string {
  return `v1.${input.deviceId.toLowerCase()}.${input.ts}.${mac(input.key, input.ts, input.action, input.body)}`;
}

/** Ověří hlavičku proti tajemství serveru; `null` = neplatné, staré (±60 s) nebo jiná akce/tělo. */
export function verifyPriceAlertWatchRequest(
  header: unknown,
  action: PriceAlertWatchAction,
  body: string,
  now: number,
  secret: string | undefined = process.env[SECRET_ENV],
): { deviceId: string } | null {
  try {
    if (typeof header !== 'string' || header.length > 200) return null;
    const parts = header.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const [, deviceId, tsText, given] = parts;
    const ts = Number(tsText);
    if (!/^\d{13}$/.test(tsText) || !Number.isSafeInteger(ts) || Math.abs(now - ts) > PRICE_ALERT_WATCH_SKEW_MS) return null;
    const grant = priceAlertWatchGrant(deviceId, secret);
    if (!grant || grant.deviceId !== deviceId) return null;
    const expected = Buffer.from(mac(grant.key, ts, action, body));
    const actual = Buffer.from(given);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return { deviceId: grant.deviceId };
  } catch {
    return null;
  }
}
