import { createHmac, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { TV_PRICE_CHANNEL_SECRET_ENV } from './tvPriceChannel.js';

/**
 * Přímé doručení navázaného příkazu (F1b′, docs/reviews/hot-path-f1b2-fees-close-20261102.md):
 * server po enqueue naváže příkaz k nečinné delivery workeru stejnou RPC jako poll
 * (`claim_tradovate_copier_command_v2`) a řádek pošle na téma odvozené ze zařízení,
 * podepsaný **Ed25519**. Soukromý klíč existuje jen na serveru (deterministicky ze
 * `TV_PRICE_CHANNEL_SECRET`), worker dostane jen veřejný klíč přes autentizovaný poll —
 * únik čehokoli z workeru ani prohlížeče podvrh neumožní. Push nikdy nic nevytváří:
 * nese jen řádek, který DB k delivery už vydala; ztracený push = poll vrátí totéž.
 *
 * Nikdy nevyhodí; chybějící/krátké tajemství nebo cizí tvar ID = `null` (pole se vynechá,
 * žádné 5xx na cestě brzd — INV-BRAKE-03). Téma, klíče ani tělo se nelogují.
 */
export const COPIER_COMMAND_PUSH_EVENT = 'cmd';
/**
 * Vlastní tajemství podpisu pushů (2. 11. 2026, oponentura P2): když je nastavené (≥ 32 znaků),
 * podpis i téma se odvozují z něj, takže rotace kanálu ceny a příkazů jsou nezávislé. Jinak
 * dosavadní `TV_PRICE_CHANNEL_SECRET`. Worker dostává jen veřejný klíč z pollu → výměnu převezme
 * sám; pushe podepsané novým klíčem před jeho dalším pollem se zahodí (kick/poll jako dřív).
 */
export const COPIER_PUSH_SIGNING_SECRET_ENV = 'COPIER_PUSH_SIGNING_SECRET';
const pushSecretFromEnv = (): string | undefined => {
  const own = process.env[COPIER_PUSH_SIGNING_SECRET_ENV]?.trim();
  return own && own.length >= 32 ? own : process.env[TV_PRICE_CHANNEL_SECRET_ENV];
};
export const COPIER_COMMAND_PUSH_VERSION = 1;
/** Strop těla zprávy (ochrana ověřování před záplavou podvrhů). */
export const COPIER_COMMAND_PUSH_MAX_BODY = 64_000;

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_SECRET_LENGTH = 32;
/** PKCS#8 obálka Ed25519 soukromého klíče z 32B seedu (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** SPKI obálka Ed25519 veřejného klíče (RFC 8410), za ní 32 B klíče. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const deviceSecret = (deviceId: unknown, secret: string | undefined): { id: string; value: string } | null => {
  const value = secret?.trim();
  if (!value || value.length < MIN_SECRET_LENGTH || typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return null;
  return { id: deviceId.toLowerCase(), value };
};

const privateKeyFor = (id: string, value: string): KeyObject => createPrivateKey({
  key: Buffer.concat([ED25519_PKCS8_PREFIX, createHmac('sha256', value).update(`copier-push-ed25519:${id}`).digest()]),
  format: 'der', type: 'pkcs8',
});

export interface CopierCommandPushGrant {
  /** `copier-push-<22 znaků base64url>`. */
  topic: string;
  /** Veřejný Ed25519 klíč (32 B, base64url) — jen ověření, nikdy podpis. */
  publicKey: string;
}

/** Téma a veřejný klíč pro worker (posílá se v `realtime` odpovědi poll-v2). */
export function copierCommandPushGrant(
  deviceId: unknown,
  secret: string | undefined = pushSecretFromEnv(),
): CopierCommandPushGrant | null {
  try {
    const device = deviceSecret(deviceId, secret);
    if (!device) return null;
    const topic = `copier-push-${createHmac('sha256', device.value).update(`copier-push-topic:${device.id}`).digest('base64url').slice(0, 22)}`;
    const spki = createPublicKey(privateKeyFor(device.id, device.value)).export({ format: 'der', type: 'spki' });
    return { topic, publicKey: spki.subarray(ED25519_SPKI_PREFIX.length).toString('base64url') };
  } catch {
    return null;
  }
}

export interface CopierCommandPushMessage { body: string; sig: string }

/** Podepsaná zpráva s navázaným řádkem; `null` = nepushovat (kick a poll jako dřív). */
export function signCopierCommandPush(
  input: { deviceId: string; deliveryId: string; command: unknown },
  secret: string | undefined = pushSecretFromEnv(),
): CopierCommandPushMessage | null {
  try {
    const device = deviceSecret(input.deviceId, secret);
    if (!device) return null;
    const body = JSON.stringify({ v: COPIER_COMMAND_PUSH_VERSION, deviceId: device.id, deliveryId: input.deliveryId, command: input.command });
    if (body.length > COPIER_COMMAND_PUSH_MAX_BODY) return null;
    return { body, sig: sign(null, Buffer.from(body), privateKeyFor(device.id, device.value)).toString('base64url') };
  } catch {
    return null;
  }
}

export interface VerifiedCopierCommandPush { deviceId: string; deliveryId: string; command: unknown }

/**
 * Worker: ověří podpis veřejným klíčem a tvar. `null` = zahodit (podvrh, cizí zařízení,
 * jiná verze, rozbité tělo). Shodu `deliveryId` s checkpointem řeší až doručovací automat.
 */
export function verifyCopierCommandPush(payload: unknown, publicKey: string, deviceId: string): VerifiedCopierCommandPush | null {
  try {
    const message = payload as Partial<CopierCommandPushMessage> | null;
    if (!message || typeof message.body !== 'string' || typeof message.sig !== 'string') return null;
    if (message.body.length > COPIER_COMMAND_PUSH_MAX_BODY || !/^[A-Za-z0-9_-]{86}$/.test(message.sig)) return null;
    const raw = Buffer.from(publicKey, 'base64url');
    if (raw.length !== 32) return null;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(message.body), key, Buffer.from(message.sig, 'base64url'))) return null;
    const parsed = JSON.parse(message.body) as { v?: unknown; deviceId?: unknown; deliveryId?: unknown; command?: unknown };
    if (parsed.v !== COPIER_COMMAND_PUSH_VERSION || parsed.deviceId !== deviceId.toLowerCase()
      || typeof parsed.deliveryId !== 'string' || !parsed.command || typeof parsed.command !== 'object') return null;
    return { deviceId: parsed.deviceId, deliveryId: parsed.deliveryId, command: parsed.command };
  } catch {
    return null;
  }
}
