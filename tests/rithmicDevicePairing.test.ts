import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  MAX_PAIRED_DEVICES, PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MS, PAIRING_MAX_FAILURES, PAIRING_MIN_ATTEMPT_GAP_MS,
  attemptPairing, deviceForKey, hashDeviceKey, newPairingCode, normalizePairingCode, parseDeviceRegistry, revokeDevice, scopeProblem, startPairing,
  type DeviceRegistryState,
} from '../services/rithmic/devicePairing';

const T0 = 1_800_000_000_000;
const empty: DeviceRegistryState = { devices: [] };
const pair = (pending: ReturnType<typeof startPairing> | null, code: string, now: number, state = empty, name = 'iPhone Filip') =>
  attemptPairing({ pending, state, code, name, now, randomBytes });

describe('párování zařízení s místní službou', () => {
  it('kód má 8 znaků z abecedy bez zaměnitelných znaků a jde opsat s mezerami a malými písmeny', () => {
    for (let i = 0; i < 200; i += 1) expect(newPairingCode(randomBytes)).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(PAIRING_CODE_LENGTH).toBe(8);
    expect(normalizePairingCode(' abcd-efgh ')).toBe('ABCDEFGH');
  });

  it('správný kód vydá zařízení klíč, kód spotřebuje a do seznamu uloží jen otisk klíče', () => {
    const pending = startPairing(T0, randomBytes);
    const done = pair(pending, pending.code.toLowerCase(), T0 + 2_000);
    if (!done.ok) throw new Error('mělo projít');
    expect(done.pending).toBeNull();
    expect(done.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(done.state.devices).toHaveLength(1);
    expect(done.state.devices[0]).toMatchObject({ name: 'iPhone Filip', scope: 'full', revokedAt: null, keyHash: hashDeviceKey(done.key) });
    expect(JSON.stringify(done.state)).not.toContain(done.key);
    expect(deviceForKey(done.state, done.key)?.id).toBe(done.device.id);
    // Tentýž kód podruhé už neplatí.
    expect(pair(done.pending, pending.code, T0 + 5_000, done.state)).toMatchObject({ ok: false, reason: 'no-pairing' });
  });

  it('bez vydaného kódu, po vypršení a příliš rychle po sobě párování neprojde', () => {
    expect(pair(null, 'ABCDEFGH', T0)).toMatchObject({ ok: false, reason: 'no-pairing' });
    const pending = startPairing(T0, randomBytes);
    expect(pair(pending, pending.code, T0 + PAIRING_CODE_TTL_MS)).toMatchObject({ ok: false, reason: 'expired', pending: null });
    const wrong = pair(pending, 'AAAAAAAA', T0 + 2_000);
    expect(wrong).toMatchObject({ ok: false, reason: 'wrong-code' });
    // I správný kód musí počkat na odstup mezi pokusy.
    expect(pair(wrong.pending, pending.code, T0 + 2_000 + PAIRING_MIN_ATTEMPT_GAP_MS - 1)).toMatchObject({ ok: false, reason: 'too-fast' });
    expect(pair(wrong.pending, pending.code, T0 + 2_000 + PAIRING_MIN_ATTEMPT_GAP_MS).ok).toBe(true);
  });

  it('po pěti špatných pokusech kód propadne — ani správný už neprojde', () => {
    let pending: ReturnType<typeof startPairing> | null = startPairing(T0, randomBytes);
    const code = pending.code;
    let last: ReturnType<typeof pair> | null = null;
    for (let i = 1; i <= PAIRING_MAX_FAILURES; i += 1) {
      last = pair(pending, 'ZZZZZZZZ', T0 + i * 2_000);
      pending = last.ok ? null : last.pending;
    }
    expect(last).toMatchObject({ ok: false, reason: 'locked', pending: null });
    expect(pair(pending, code, T0 + 60_000)).toMatchObject({ ok: false, reason: 'no-pairing' });
  });

  it('neplatný název zařízení se odmítne až po správném kódu a kód zůstane použitelný', () => {
    const pending = startPairing(T0, randomBytes);
    const bad = pair(pending, pending.code, T0 + 2_000, empty, '<script>');
    expect(bad).toMatchObject({ ok: false, reason: 'bad-name' });
    expect(pair(bad.pending, pending.code, T0 + 4_000).ok).toBe(true);
  });

  it('odvolané zařízení ani neznámý nebo zkomolený klíč neprojde', () => {
    const pending = startPairing(T0, randomBytes);
    const done = pair(pending, pending.code, T0 + 2_000);
    if (!done.ok) throw new Error('mělo projít');
    expect(deviceForKey(done.state, `${done.key}x`)).toBeNull();
    expect(deviceForKey(done.state, 'krátký')).toBeNull();
    expect(deviceForKey(done.state, null)).toBeNull();
    const revoked = revokeDevice(done.state, done.device.id, T0 + 10_000);
    expect(deviceForKey(revoked, done.key)).toBeNull();
    expect(revoked.devices[0].revokedAt).toBe(T0 + 10_000);
  });

  it('strop počtu aktivních zařízení; odvolaná se nepočítají', () => {
    let state = empty;
    for (let i = 0; i < MAX_PAIRED_DEVICES; i += 1) {
      const pending = startPairing(T0, randomBytes);
      const done = pair(pending, pending.code, T0 + 2_000, state, `Zařízení ${i}`);
      if (!done.ok) throw new Error('mělo projít');
      state = done.state;
    }
    const pending = startPairing(T0, randomBytes);
    expect(pair(pending, pending.code, T0 + 2_000, state)).toMatchObject({ ok: false, reason: 'too-many-devices' });
    state = revokeDevice(state, state.devices[0].id, T0 + 3_000);
    expect(pair(pending, pending.code, T0 + 4_000, state).ok).toBe(true);
  });

  it('rozsah oprávnění: jen čtení neposílá nic, jen zavírání neotevře ani nezvětší pozici', () => {
    for (const op of ['entry', 'replace-entry', 'flatten', 'move', 'cancel', 'ack']) expect(scopeProblem('full', op)).toBeNull();
    expect(scopeProblem('read', 'lookup')).toBeNull();
    for (const op of ['entry', 'flatten', 'move', 'ack']) expect(scopeProblem('read', op)).toMatch(/jen pro čtení/);
    for (const op of ['flatten', 'reduce', 'protect', 'protect-pair', 'lookup']) expect(scopeProblem('close', op)).toBeNull();
    // Posun umí čekající vstup přitáhnout k trhu nebo SL oddálit, rušení umí odstranit SL → do „jen zavírání" nepatří.
    for (const op of ['entry', 'replace-entry', 'move', 'move-legs', 'cancel', 'ack', 'neznámý', 'FLATTEN']) expect(scopeProblem('close', op)).toMatch(/jen zavřít pozici/);
    expect(scopeProblem('full', undefined)).toMatch(/bez názvu/);
  });

  it('poškozený seznam zařízení je chyba, ne prázdný seznam', () => {
    expect(() => parseDeviceRegistry(null)).toThrow();
    expect(() => parseDeviceRegistry({ devices: 'x' })).toThrow();
    expect(() => parseDeviceRegistry({ devices: [{ id: 'x' }] })).toThrow();
    const pending = startPairing(T0, randomBytes, 'close');
    const done = pair(pending, pending.code, T0 + 2_000);
    if (!done.ok) throw new Error('mělo projít');
    expect(parseDeviceRegistry(JSON.parse(JSON.stringify(done.state)))).toEqual(done.state);
    expect(done.device.scope).toBe('close');
  });
});
