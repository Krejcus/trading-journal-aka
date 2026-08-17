import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';

export interface TradovatePilotLeasePayload {
  version: 1;
  environment: 'demo';
  connectionId: string;
  /** Deprecated single-account fallback. Pilot resolves Account.name per account from account/list. */
  accountSpec?: string;
  accessToken: string;
  expiresAt: string;
  issuedAt: string;
}

export interface TradovatePilotLeaseEnvelope {
  version: 1;
  algorithm: 'RSA-OAEP-256+A256GCM';
  encryptedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function createTradovatePilotKeyPair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

export function sealTradovatePilotLease(
  payload: TradovatePilotLeasePayload,
  publicKeyPem: string,
  now = Date.now(),
): TradovatePilotLeaseEnvelope {
  validatePayload(payload, now);
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
    throw new Error('pilot-public-key-must-be-rsa-3072');
  }
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    version: 1,
    algorithm: 'RSA-OAEP-256+A256GCM',
    encryptedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function openTradovatePilotLease(
  envelope: TradovatePilotLeaseEnvelope,
  privateKeyPem: string,
  now = Date.now(),
): TradovatePilotLeasePayload {
  if (envelope.version !== 1 || envelope.algorithm !== 'RSA-OAEP-256+A256GCM') {
    throw new Error('unsupported-pilot-lease');
  }
  const privateKey = createPrivateKey(privateKeyPem);
  const key = privateDecrypt({
    key: privateKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, Buffer.from(envelope.encryptedKey, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const clear = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const payload = JSON.parse(clear) as TradovatePilotLeasePayload;
  validatePayload(payload, now);
  return payload;
}

function validatePayload(payload: TradovatePilotLeasePayload, now: number): void {
  if (
    payload.version !== 1
    || payload.environment !== 'demo'
    || !payload.connectionId
    || !payload.accessToken.trim()
  ) {
    throw new Error('invalid-pilot-lease');
  }
  const expires = Date.parse(payload.expiresAt);
  const issued = Date.parse(payload.issuedAt);
  if (!Number.isFinite(expires) || !Number.isFinite(issued) || issued > now + 60_000) {
    throw new Error('invalid-pilot-lease-time');
  }
  if (expires - now <= 120_000) throw new Error('pilot-lease-expired');
  if (expires - issued > 24 * 60 * 60 * 1_000) throw new Error('pilot-lease-too-long');
}
