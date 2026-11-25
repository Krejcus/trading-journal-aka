import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Klíč hlídače upozornění na cenu pro službu Rithmic na Macu (24. 11. 2026).
 *
 * Služba nemá přihlášení uživatele ani přístup do databáze. Přihlášená appka si pro ni u serveru vyžádá klíč
 * odvozený z ID uživatele a předá ho službě místním spojením. Klíč umí JEDINOU věc: ohlásit křížení úrovně
 * u existujícího upozornění téhož uživatele (o „jednou“, odstupu a stropu rozhoduje databáze). Neumí číst
 * upozornění, nic zakládat ani nic, co souvisí s příkazy (INV-UI-01).
 *
 * Kořenem odvození je serverový klíč databáze (na Vercelu je vždy, žádné nové tajemství). Odvolání všech klíčů =
 * zvednout `GRANT_LABEL`. Nikdy nevyhodí: chybějící kořen nebo cizí tvar ID = `null`. Klíč se neloguje.
 */
export const PRICE_ALERT_WATCH_HEADER = 'x-alphatrade-alert-auth';
export const PRICE_ALERT_WATCH_SKEW_MS = 60_000;

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_SECRET_LENGTH = 32;
const SECRET_ENV = 'SUPABASE_SERVICE_ROLE_KEY';
const GRANT_LABEL = 'rithmic-price-alert-watch:v1';

export function priceAlertWatchGrant(
  userId: unknown,
  secret: string | undefined = process.env[SECRET_ENV],
): { key: string; userId: string } | null {
  try {
    const value = secret?.trim();
    if (!value || value.length < MIN_SECRET_LENGTH || typeof userId !== 'string' || !USER_ID.test(userId)) return null;
    const id = userId.toLowerCase();
    return { key: createHmac('sha256', value).update(`${GRANT_LABEL}:${id}`).digest('base64url'), userId: id };
  } catch {
    return null;
  }
}

const bodyDigest = (body: string) => createHash('sha256').update(body).digest('hex');
const mac = (key: string, ts: number, body: string) => createHmac('sha256', key).update(`${ts}\ntrigger\n${bodyDigest(body)}`).digest('base64url');

/** Hlavička `v1.<userId>.<ts>.<mac>` pro hlášení křížení (podpis těla a času). */
export function signPriceAlertWatchRequest(input: { userId: string; key: string; body: string; ts: number }): string {
  return `v1.${input.userId.toLowerCase()}.${input.ts}.${mac(input.key, input.ts, input.body)}`;
}

/** Ověří hlavičku proti kořeni serveru; `null` = neplatné, staré (±60 s) nebo jiné tělo. */
export function verifyPriceAlertWatchRequest(
  header: unknown,
  body: string,
  now: number,
  secret: string | undefined = process.env[SECRET_ENV],
): { userId: string } | null {
  try {
    if (typeof header !== 'string' || header.length > 200) return null;
    const parts = header.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const [, userId, tsText, given] = parts;
    const ts = Number(tsText);
    if (!/^\d{13}$/.test(tsText) || !Number.isSafeInteger(ts) || Math.abs(now - ts) > PRICE_ALERT_WATCH_SKEW_MS) return null;
    const grant = priceAlertWatchGrant(userId, secret);
    if (!grant || grant.userId !== userId) return null;
    const expected = Buffer.from(mac(grant.key, ts, body));
    const actual = Buffer.from(given);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return { userId: grant.userId };
  } catch {
    return null;
  }
}
