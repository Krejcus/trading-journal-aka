/**
 * Brána pro spárovaná zařízení (telefon): přijme spojení, ověří klíč zařízení nebo provede párování, a teprve
 * ověřené spojení předá službě. Do ověření neodchází NIC — ani účet, ani cena.
 *
 * Proč zvlášť: je to bezpečnostní hranice (jediné místo, kudy se ke službě dostane něco mimo tento Mac), takže
 * musí jít otestovat proti skutečnému WebSocketu a sdílí ji skutečná služba i místní simulace.
 *
 * Pravidla:
 *  - Origin tu NENÍ pojistka (nativní klient si ho nastaví sám) — jen se odmítá prohlížečová stránka odjinud;
 *  - neověřených spojení smí být naráz jen pár a každé má krátkou lhůtu;
 *  - klíč jde první zprávou, ne v adrese; odvolané zařízení je odpojeno hned, i s otevřeným spojením;
 *  - nečitelný seznam zařízení = nikdo neprojde (neznámý seznam se nebere jako prázdný);
 *  - správu (vydání kódu, seznam, odvolání) volá jen místní strana — brána ji z připojeného zařízení nepřijímá.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  attemptPairing, deviceForKey, parseDeviceRegistry, revokeDevice, startPairing, touchDevice,
  type DeviceRegistryState, type PairedDevice, type PendingPairing,
} from './devicePairing';

export interface DeviceStore { load(): DeviceRegistryState; save(state: DeviceRegistryState): void }

/** Seznam zařízení v souboru (jen pro tohoto uživatele). Chybějící soubor = prázdný seznam; poškozený = chyba. */
export function fileDeviceStore(file: string): DeviceStore {
  return {
    load() {
      let raw: string;
      try { raw = readFileSync(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { devices: [] }; throw error; }
      return parseDeviceRegistry(JSON.parse(raw));
    },
    save(state) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
  };
}

export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Okamžité ukončení bez čekání na druhou stranu (odvolané zařízení). */
  terminate?(): void;
  on(event: 'close', listener: () => void): unknown;
  once(event: 'message', listener: (raw: unknown) => void): unknown;
}

export const DEVICE_AUTH_TIMEOUT_MS = 3_000;
/** Kolik spojení smí mít jedno zařízení naráz (další = nejstarší končí). */
export const MAX_SOCKETS_PER_DEVICE = 2;
export const MAX_UNAUTHENTICATED = 4;

const PAIRING_ERRORS: Record<string, string> = {
  'no-pairing': 'na Macu není vydaný párovací kód',
  expired: 'kód vypršel — vydej na Macu nový',
  'too-fast': 'příliš rychle po sobě — zkus to za chvilku',
  'wrong-code': 'kód nesouhlasí',
  locked: 'příliš mnoho špatných pokusů — vydej na Macu nový kód',
  'bad-name': 'název zařízení není platný',
  'too-many-devices': 'je spárováno příliš mnoho zařízení — některé na Macu odvolej',
};

export function createDeviceGateway<S extends GatewaySocket>(options: {
  store: DeviceStore;
  origins: ReadonlySet<string>;
  /** Ověřené spojení: odteď ho obsluhuje služba (s rozsahem zařízení). */
  serve: (socket: S, device: PairedDevice) => void;
  log?: (text: string) => void;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  authTimeoutMs?: number;
  /**
   * Přihlašovací jméno Tailscale, které smí port použít (hlavička `Tailscale-User-Login`, kterou přidává Tailscale
   * Serve). Když je zadané, spojení bez ní nebo s jiným jménem se neotevře vůbec — odřízne to ostatní uzly v síti
   * i omylem zapnutý Funnel (ten hlavičku nepřidává). Věřit jí jde jen proto, že port poslouchá na 127.0.0.1.
   * Klíč zařízení se ověřuje vždy; tohle je pojistka navíc. Bez hodnoty (simulace) se nekontroluje.
   */
  tailscaleLogin?: string | null;
}) {
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? ((size: number) => nodeRandomBytes(size));
  const log = options.log ?? (() => undefined);
  let state: DeviceRegistryState = { devices: [] };
  let broken: string | null = null;
  try { state = options.store.load(); } catch (error) { broken = error instanceof Error ? error.message : String(error); }
  let pending: PendingPairing | null = null;
  let unauthenticated = 0;
  const sockets = new Map<S, string>();
  const save = (next: DeviceRegistryState): void => { options.store.save(next); state = next; };
  const send = (socket: S, message: unknown): void => { try { socket.send(JSON.stringify(message)); } catch { /* spojení už není */ } };
  const active = (id: string): PairedDevice | null => state.devices.find((device) => device.id === id && device.revokedAt === null) ?? null;

  return {
    /** Smí se spojení vůbec otevřít? (Počet neověřených a původ stránky; skutečné ověření je až klíč.) */
    verify: (origin: string | undefined, headers: Record<string, string | string[] | undefined> = {}): boolean => {
      if (unauthenticated >= MAX_UNAUTHENTICATED) return false;
      if (origin !== undefined && !options.origins.has(origin)) return false;
      if (options.tailscaleLogin) {
        const login = headers['tailscale-user-login'];
        if (typeof login !== 'string' || login.trim().toLowerCase() !== options.tailscaleLogin.trim().toLowerCase()) return false;
      }
      return true;
    },
    active,
    summary: (): string => (broken ? `SEZNAM ZAŘÍZENÍ NEJDE PŘEČÍST: ${broken}` : `spárováno ${state.devices.filter((device) => device.revokedAt === null).length}`),

    accept(socket: S): void {
      unauthenticated += 1;
      let settled = false;
      const settle = (): void => { if (!settled) { settled = true; unauthenticated -= 1; } };
      const timer = setTimeout(() => socket.close(4001, 'auth timeout'), options.authTimeoutMs ?? DEVICE_AUTH_TIMEOUT_MS);
      socket.on('close', () => { clearTimeout(timer); settle(); sockets.delete(socket); });
      socket.once('message', (raw) => {
        clearTimeout(timer);
        let hello: { auth?: unknown; pair?: { code?: unknown; name?: unknown } } = {};
        try { hello = JSON.parse(String(raw)) as typeof hello; } catch { /* neplatná zpráva = odmítnout níže */ }
        if (!hello || typeof hello !== 'object') hello = {};
        // `retry`: potíž je na straně služby, ne zařízení — klient má zkoušet dál, ne nabízet nové spárování.
        if (broken) { send(socket, { type: 'auth', ok: false, retry: true, error: 'služba nemá čitelný seznam zařízení' }); socket.close(4002, 'registry'); return; }
        if (hello.pair && typeof hello.pair === 'object' && typeof hello.pair.code === 'string' && typeof hello.pair.name === 'string') {
          const attempt = attemptPairing({ pending, state, code: hello.pair.code, name: hello.pair.name, now: now(), randomBytes: random });
          pending = attempt.pending;
          if (!('reason' in attempt)) {
            // Nejdřív uložit, pak teprve vydat klíč: zařízení s klíčem, které služba po restartu nezná, by bylo k ničemu.
            try { save(attempt.state); } catch (error) {
              log(`párování se nepodařilo uložit: ${error instanceof Error ? error.message : String(error)}`);
              send(socket, { type: 'paired', ok: false, error: 'Mac nedokázal zařízení uložit — vydej nový kód a zkus to znovu' });
              socket.close(1011, 'store');
              return;
            }
            log(`spárováno „${attempt.device.name}" (${attempt.device.id}, rozsah ${attempt.device.scope})`);
            send(socket, { type: 'paired', ok: true, deviceId: attempt.device.id, key: attempt.key, scope: attempt.device.scope, name: attempt.device.name });
          } else {
            log(`párování odmítnuto: ${attempt.reason}`);
            send(socket, { type: 'paired', ok: false, error: PAIRING_ERRORS[attempt.reason] ?? 'párování se nepovedlo' });
          }
          socket.close(1000, 'pairing done');
          return;
        }
        const device = deviceForKey(state, typeof hello.auth === 'string' ? hello.auth : null);
        if (!device) { send(socket, { type: 'auth', ok: false, error: 'zařízení není spárované nebo bylo odvoláno' }); socket.close(4003, 'unknown device'); return; }
        settle();
        // Zařízení smí mít jen pár spojení naráz (jinak by jedno zařízení šlo zneužít k zahlcení): nejstarší končí.
        const mine = [...sockets].filter(([, id]) => id === device.id).map(([other]) => other);
        for (const old of mine.slice(0, Math.max(0, mine.length - (MAX_SOCKETS_PER_DEVICE - 1)))) { sockets.delete(old); old.close(4004, 'too many connections'); }
        sockets.set(socket, device.id);
        try { save(touchDevice(state, device.id, now())); } catch { /* čas posledního použití není podstatný */ }
        send(socket, { type: 'auth', ok: true, deviceId: device.id, scope: device.scope });
        options.serve(socket, device);
      });
    },

    /** Správa zařízení — volá JEN místní strana (tento Mac). */
    manage(command: Record<string, unknown>): unknown {
      if (broken) throw new Error(`seznam zařízení nejde přečíst (${broken})`);
      const list = () => state.devices.map(({ keyHash: _hidden, ...device }) => ({ ...device, online: [...sockets.values()].includes(device.id) }));
      if (command.op === 'pair-start') {
        const scope = command.scope === 'close' || command.scope === 'read' ? command.scope : 'full';
        pending = startPairing(now(), random, scope);
        log(`vydán párovací kód (rozsah ${scope})`);
        return { code: pending.code, expiresAt: pending.expiresAt, scope };
      }
      if (command.op === 'revoke-device') {
        const id = typeof command.deviceId === 'string' ? command.deviceId : '';
        if (!active(id)) throw new Error('takové aktivní zařízení neznám');
        // Nejdřív odvolat V PAMĚTI a odpojit, teprve pak ukládat: kdyby zápis selhal (plný disk), ztracený telefon
        // nesmí zůstat připojený s platným klíčem.
        const next = revokeDevice(state, id, now());
        state = next;
        for (const [socket, deviceId] of [...sockets]) {
          if (deviceId !== id) continue;
          sockets.delete(socket);
          if (socket.terminate) socket.terminate(); else socket.close(4003, 'device revoked');
        }
        let persisted = true;
        try { options.store.save(next); } catch (error) {
          persisted = false;
          log(`odvolání ${id} se NEPODAŘILO ULOŽIT (${error instanceof Error ? error.message : String(error)}) — platí jen do restartu služby`);
        }
        log(`odvoláno ${id}`);
        return { devices: list(), persisted, ...(persisted ? {} : { warning: 'Odvoláno, ale nepodařilo se to uložit — po restartu služby by zařízení zase platilo. Uvolni místo na disku a odvolej ho znovu.' }) };
      }
      return { devices: list() };
    },
  };
}
