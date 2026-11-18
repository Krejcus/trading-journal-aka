/**
 * Spárovaná zařízení místní služby (telefon, další prohlížeč): kdo se smí připojit a co smí.
 *
 * Proč: dosud stačil jeden sdílený klíč v souboru, protože ke službě se dostal jen tento Mac (127.0.0.1).
 * Jakmile je služba dostupná i z telefonu (soukromá síť Tailscale), potřebuje každé zařízení VLASTNÍ klíč,
 * který jde odvolat, a rozsah oprávnění.
 *
 * Párování:
 *  1. Na Macu (jen z tohoto počítače) se vydá jednorázový kód s krátkou platností.
 *  2. Telefon se připojí s kódem a svým názvem; služba mu vydá dlouhý náhodný klíč a kód zahodí.
 *  3. Služba si ukládá jen OTISK klíče (SHA-256) — ze souboru se klíč zpět nezíská.
 *  4. Kód jde zkusit jen párkrát; pak propadá (hádání). Mezi pokusy je povinný odstup.
 *
 * Čistá logika: čas, náhodu a úložiště dodává volající. Nic z toho neautorizuje příkaz samo o sobě —
 * každý příkaz dál ověřuje služba (režim účtu, souhlas, stav pozice).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** `full` = vše, co dovolí režim služby; `close` = jen zavírat, rušit a spravovat ochranu; `read` = jen číst. */
export type DeviceScope = 'full' | 'close' | 'read';

export interface PairedDevice {
  id: string;
  name: string;
  /** SHA-256 klíče, hex. */
  keyHash: string;
  scope: DeviceScope;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export interface DeviceRegistryState { devices: PairedDevice[] }

export interface PendingPairing { code: string; expiresAt: number; failures: number; lastAttemptAt: number; scope: DeviceScope }

export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_FAILURES = 5;
export const PAIRING_MIN_ATTEMPT_GAP_MS = 1_000;
export const MAX_PAIRED_DEVICES = 8;

/** Bez znaků, které se pletou (0/O, 1/I/L). 8 znaků = 40 bitů; s pěti pokusy a krátkou platností nejde uhodnout. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;
const KEY_SHAPE = /^[A-Za-z0-9_-]{40,128}$/;
const NAME_SHAPE = /^[\p{L}\p{N} ._'()-]{1,40}$/u;

export const hashDeviceKey = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');

export function newPairingCode(randomBytes: (size: number) => Uint8Array): string {
  // Zamítací výběr: žádné zkreslení modulem.
  let code = '';
  while (code.length < PAIRING_CODE_LENGTH) {
    for (const byte of randomBytes(16)) {
      if (byte >= 256 - (256 % CODE_ALPHABET.length)) continue;
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === PAIRING_CODE_LENGTH) break;
    }
  }
  return code;
}

/** Sjednotí opsaný kód (mezery, pomlčky, malá písmena). */
export const normalizePairingCode = (given: string): string => given.replace(/[\s-]/g, '').toUpperCase();

export function startPairing(now: number, randomBytes: (size: number) => Uint8Array, scope: DeviceScope = 'full'): PendingPairing {
  return { code: newPairingCode(randomBytes), expiresAt: now + PAIRING_CODE_TTL_MS, failures: 0, lastAttemptAt: 0, scope };
}

const sameText = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

export type PairingAttempt =
  | { ok: true; pending: null; device: PairedDevice; key: string; state: DeviceRegistryState }
  | { ok: false; pending: PendingPairing | null; reason: 'no-pairing' | 'expired' | 'too-fast' | 'wrong-code' | 'locked' | 'bad-name' | 'too-many-devices' };

/**
 * Jeden pokus o spárování. Špatný kód se počítá; po `PAIRING_MAX_FAILURES` kód propadá. Úspěch kód spotřebuje.
 * Název zařízení se kontroluje až PO kódu, aby nešel zkoušet bez něj.
 */
export function attemptPairing(input: {
  pending: PendingPairing | null; state: DeviceRegistryState; code: string; name: string; now: number;
  randomBytes: (size: number) => Uint8Array;
}): PairingAttempt {
  const { pending, now } = input;
  if (!pending) return { ok: false, pending: null, reason: 'no-pairing' };
  if (now >= pending.expiresAt) return { ok: false, pending: null, reason: 'expired' };
  if (now - pending.lastAttemptAt < PAIRING_MIN_ATTEMPT_GAP_MS) return { ok: false, pending, reason: 'too-fast' };
  const tried = { ...pending, lastAttemptAt: now };
  if (!sameText(normalizePairingCode(input.code), pending.code)) {
    const failures = pending.failures + 1;
    return failures >= PAIRING_MAX_FAILURES
      ? { ok: false, pending: null, reason: 'locked' }
      : { ok: false, pending: { ...tried, failures }, reason: 'wrong-code' };
  }
  const name = input.name.trim();
  if (!NAME_SHAPE.test(name)) return { ok: false, pending: tried, reason: 'bad-name' };
  const active = input.state.devices.filter((device) => device.revokedAt === null);
  if (active.length >= MAX_PAIRED_DEVICES) return { ok: false, pending: tried, reason: 'too-many-devices' };
  const key = Buffer.from(input.randomBytes(32)).toString('base64url');
  const device: PairedDevice = {
    id: Buffer.from(input.randomBytes(6)).toString('hex'), name, keyHash: hashDeviceKey(key), scope: pending.scope,
    createdAt: now, lastSeenAt: null, revokedAt: null,
  };
  return { ok: true, pending: null, device, key, state: { devices: [...input.state.devices, device] } };
}

/** Zařízení podle klíče; odvolané ani neznámé neprojde. Porovnání otisků v konstantním čase. */
export function deviceForKey(state: DeviceRegistryState, key: string | null | undefined): PairedDevice | null {
  if (!key || !KEY_SHAPE.test(key)) return null;
  const hash = hashDeviceKey(key);
  let found: PairedDevice | null = null;
  for (const device of state.devices) {
    if (sameText(device.keyHash, hash) && device.revokedAt === null) found = device;
  }
  return found;
}

export function revokeDevice(state: DeviceRegistryState, id: string, now: number): DeviceRegistryState {
  return { devices: state.devices.map((device) => (device.id === id && device.revokedAt === null ? { ...device, revokedAt: now } : device)) };
}

export function touchDevice(state: DeviceRegistryState, id: string, now: number): DeviceRegistryState {
  return { devices: state.devices.map((device) => (device.id === id ? { ...device, lastSeenAt: now } : device)) };
}

/** Příkazy, které zařízení s rozsahem `close` smí: nic, co otevírá nebo zvětšuje pozici. */
const CLOSE_SCOPE_OPS = new Set(['flatten', 'reduce', 'cancel', 'move', 'move-legs', 'protect', 'protect-pair', 'ack', 'lookup']);

/** Proč zařízení příkaz NESMÍ (null = smí). Služba pak příkaz ještě ověří po svém. */
export function scopeProblem(scope: DeviceScope, op: unknown): string | null {
  if (typeof op !== 'string') return 'příkaz bez názvu';
  if (scope === 'full') return null;
  if (op === 'lookup') return null;
  if (scope === 'read') return 'toto zařízení je spárované jen pro čtení';
  return CLOSE_SCOPE_OPS.has(op) ? null : 'toto zařízení smí jen zavírat a spravovat ochranu';
}

/** Načtený soubor se zařízeními: cokoli neplatného = chyba (neznámý seznam zařízení se nesmí brát jako prázdný). */
export function parseDeviceRegistry(raw: unknown): DeviceRegistryState {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as DeviceRegistryState).devices)) throw new Error('seznam zařízení má neplatný tvar');
  const devices = (raw as DeviceRegistryState).devices.map((device) => {
    const ok = typeof device === 'object' && device !== null
      && typeof device.id === 'string' && /^[0-9a-f]{12}$/.test(device.id)
      && typeof device.name === 'string' && NAME_SHAPE.test(device.name)
      && typeof device.keyHash === 'string' && /^[0-9a-f]{64}$/.test(device.keyHash)
      && (device.scope === 'full' || device.scope === 'close' || device.scope === 'read')
      && Number.isFinite(device.createdAt)
      && (device.lastSeenAt === null || Number.isFinite(device.lastSeenAt))
      && (device.revokedAt === null || Number.isFinite(device.revokedAt));
    if (!ok) throw new Error('seznam zařízení obsahuje neplatný záznam');
    return { id: device.id, name: device.name, keyHash: device.keyHash, scope: device.scope, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, revokedAt: device.revokedAt };
  });
  return { devices };
}
