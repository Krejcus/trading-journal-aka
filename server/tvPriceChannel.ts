import { createHmac } from 'node:crypto';

/**
 * Kanál ceny z TradingView (docs/reviews/tv-price-channel-design-20261026.md):
 * veřejné Realtime téma a podpisový klíč odvozené ze zařízení. Jen zobrazení
 * — kanál nenese příkazy ani rozhodovací stav (INV-RELAY-04).
 *
 * Volá se na cestách příkazů a statusu relaye, proto **nikdy nevyhodí
 * výjimku**: chybějící/krátké tajemství nebo cizí tvar ID = `null` a pole se
 * v odpovědi vynechá (jinak by 502 zablokovalo i DISARM/kill — INV-BRAKE-03).
 * Téma ani klíč se nelogují.
 */
export const TV_PRICE_CHANNEL_SECRET_ENV = 'TV_PRICE_CHANNEL_SECRET';

export interface TvPriceChannelGrant {
  /** `tv-price-<22 znaků base64url>` (132 bitů). */
  topic: string;
  /** HMAC-SHA256 klíč pro podpis zpráv, base64url. */
  key: string;
}

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_SECRET_LENGTH = 32;

export function tvPriceChannelGrant(
  deviceId: unknown,
  secret: string | undefined = process.env[TV_PRICE_CHANNEL_SECRET_ENV],
): TvPriceChannelGrant | null {
  try {
    const value = secret?.trim();
    if (!value || value.length < MIN_SECRET_LENGTH || typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return null;
    const id = deviceId.toLowerCase();
    const derive = (label: string) => createHmac('sha256', value).update(`${label}:${id}`).digest('base64url');
    // Bez epoch: nové spárování = nový deviceId. Revokaci vynucuje relay —
    // klientovi vydá kanál jen pro zařízení s živým heartbeatem (ten vyžaduje
    // platnou autentizaci zařízení). Rotace všech klíčů = výměna tajemství.
    return { topic: `tv-price-${derive('tv-price-topic').slice(0, 22)}`, key: derive('tv-price-sign') };
  } catch {
    return null;
  }
}
