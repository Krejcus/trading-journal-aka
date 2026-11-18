/**
 * Spárování TOHOTO zařízení (telefon) s místní Rithmic službou na Macu.
 *
 * Co se kde drží:
 *  - adresa služby, id a název zařízení, rozsah: běžné úložiště appky (nejsou tajné);
 *  - klíč zařízení: v nativní appce JEN v iOS Klíčence (vázaný na toto zařízení, dostupný po odemčení);
 *    mimo nativní appku (vývoj, zkušební stránka) v úložišti prohlížeče.
 *
 * Služba je dosažitelná jen přes soukromou síť Tailscale (`wss://<mac>.<síť>.ts.net`), případně místně při vývoji.
 * Klíč se službě posílá první zprávou po otevření spojení, ne v adrese.
 *
 * Nic z toho neautorizuje příkaz: služba každý příkaz ověřuje sama (rozsah zařízení, režim účtu, stav pozice).
 */
import { isNativeBuild } from '../utils/runtimeConfig';

export interface RithmicDeviceLink {
  /** `wss://host` (Tailscale) nebo `ws://127.0.0.1:port` při vývoji. Bez cesty a parametrů. */
  endpoint: string;
  deviceId: string;
  name: string;
  scope: 'full' | 'close' | 'read';
  pairedAt: number;
}

export interface RithmicKeyVault {
  secureGet(options: { key: string }): Promise<{ value: string | null }>;
  secureSet(options: { key: string; value: string }): Promise<void>;
  secureRemove(options: { key: string }): Promise<void>;
}

export const RITHMIC_DEVICE_LINK_KEY = 'at:rithmic:device-link';
export const RITHMIC_DEVICE_SECRET_KEY = 'at:rithmic:device-key';
const KEY_SHAPE = /^[A-Za-z0-9_-]{40,128}$/;
const TAILNET_HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.ts\.net$/;

/**
 * Z toho, co uživatel opsal nebo co přinesl párovací odkaz, udělá adresu služby — nebo null, když není přijatelná.
 * Přijímá se jen šifrované spojení na jméno v síti Tailscale (`*.ts.net`); nešifrované jen na tento počítač při vývoji.
 */
export function normalizeRithmicEndpoint(given: string, allowLocal: boolean): string | null {
  const text = given.trim().toLowerCase().replace(/\/+$/, '');
  if (!text) return null;
  const local = /^ws:\/\/(127\.0\.0\.1|localhost):(\d{2,5})$/.exec(text);
  if (local) return allowLocal ? text : null;
  const host = text.replace(/^(wss|https):\/\//, '');
  if (!TAILNET_HOST.test(host) || host.length > 200) return null;
  return `wss://${host}`;
}

/** Párovací odkaz `alphatrade-native://rithmic-pair?host=…&code=…` (např. z QR kódu na Macu). */
export function parseRithmicPairLink(url: string): { host: string; code: string } | null {
  const match = /^alphatrade-native:\/\/rithmic-pair\/?\?(.+)$/.exec(url.trim());
  if (!match) return null;
  const params = new URLSearchParams(match[1]);
  const host = params.get('host');
  const code = params.get('code');
  return host && code && /^[A-Za-z0-9 -]{8,12}$/.test(code) ? { host, code } : null;
}

const parseLink = (raw: string | null, allowLocal: boolean): RithmicDeviceLink | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RithmicDeviceLink>;
    const endpoint = typeof value.endpoint === 'string' ? normalizeRithmicEndpoint(value.endpoint, allowLocal) : null;
    if (!endpoint || typeof value.deviceId !== 'string' || !/^[0-9a-f]{12}$/.test(value.deviceId)) return null;
    const scope = value.scope === 'close' || value.scope === 'read' ? value.scope : value.scope === 'full' ? 'full' : null;
    if (!scope) return null;
    return { endpoint, deviceId: value.deviceId, name: typeof value.name === 'string' ? value.name.slice(0, 40) : 'Zařízení', scope, pairedAt: Number.isFinite(value.pairedAt) ? Number(value.pairedAt) : 0 };
  } catch { return null; }
};

/** Kde smí spárování existovat: nativní appka, nebo vývojový režim (zkušební stránka). Produkční web nikdy. */
export const rithmicDeviceLinkAllowed = (env: { dev: boolean; native: boolean }): boolean => env.native || env.dev;

const env = () => ({ dev: import.meta.env?.DEV === true, native: isNativeBuild });

export function readRithmicDeviceLink(storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined' ? null : window.localStorage): RithmicDeviceLink | null {
  const here = env();
  if (!rithmicDeviceLinkAllowed(here) || !storage) return null;
  try { return parseLink(storage.getItem(RITHMIC_DEVICE_LINK_KEY), here.dev); } catch { return null; }
}

async function nativeVault(): Promise<RithmicKeyVault | null> {
  if (!isNativeBuild) return null;
  const { alphaTradeNativePlugin } = await import('../services/alphaTradeNativePlugin');
  return alphaTradeNativePlugin as unknown as RithmicKeyVault;
}

/** Klíč zařízení pro přihlášení ke službě; null = není spárováno (nebo Klíčenka není dostupná). */
export async function readRithmicDeviceKey(vault?: RithmicKeyVault | null): Promise<string | null> {
  try {
    const store = vault === undefined ? await nativeVault() : vault;
    const value = store ? (await store.secureGet({ key: RITHMIC_DEVICE_SECRET_KEY })).value : window.localStorage.getItem(RITHMIC_DEVICE_SECRET_KEY);
    return value && KEY_SHAPE.test(value) ? value : null;
  } catch { return null; }
}

export async function forgetRithmicDevice(vault?: RithmicKeyVault | null): Promise<void> {
  try { window.localStorage.removeItem(RITHMIC_DEVICE_LINK_KEY); } catch { /* úložiště není dostupné */ }
  try {
    const store = vault === undefined ? await nativeVault() : vault;
    if (store) await store.secureRemove({ key: RITHMIC_DEVICE_SECRET_KEY });
    else window.localStorage.removeItem(RITHMIC_DEVICE_SECRET_KEY);
  } catch { /* klíč už není */ }
}

export interface RithmicPairSocket {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type RithmicPairResult = { ok: true; link: RithmicDeviceLink } | { ok: false; error: string };

/**
 * Spáruje toto zařízení: připojí se ke službě, pošle kód z Macu a název zařízení, převezme klíč a uloží ho.
 * Jeden pokus = jedno spojení; nic se neopakuje samo (kód má jen pár pokusů).
 */
export function pairRithmicDevice(input: {
  endpoint: string; code: string; name: string;
  socketFactory?: (url: string) => RithmicPairSocket;
  vault?: RithmicKeyVault | null;
  storage?: Pick<Storage, 'setItem'>;
  timeoutMs?: number;
  now?: () => number;
}): Promise<RithmicPairResult> {
  const endpoint = normalizeRithmicEndpoint(input.endpoint, env().dev);
  if (!endpoint) return Promise.resolve({ ok: false, error: 'Adresa Macu není platná — čekám jméno ze sítě Tailscale, např. macbook-air.tail1234.ts.net.' });
  const code = input.code.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) return Promise.resolve({ ok: false, error: 'Kód má 8 znaků.' });
  const name = input.name.trim().slice(0, 40) || 'iPhone';
  return new Promise((resolve) => {
    let done = false;
    let socket: RithmicPairSocket;
    const finish = (result: RithmicPairResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* už zavřené */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'Mac neodpověděl — je zapnutý Tailscale v telefonu i na Macu a běží služba?' }), input.timeoutMs ?? 12_000);
    try { socket = (input.socketFactory ?? ((url) => new WebSocket(url) as unknown as RithmicPairSocket))(endpoint); }
    catch { finish({ ok: false, error: 'Spojení s Macem se nepodařilo otevřít.' }); return; }
    socket.onopen = () => { try { socket.send(JSON.stringify({ pair: { code, name } })); } catch { finish({ ok: false, error: 'Kód se nepodařilo odeslat.' }); } };
    socket.onerror = () => finish({ ok: false, error: 'Mac není dostupný — zkontroluj Tailscale a adresu.' });
    socket.onclose = () => finish({ ok: false, error: 'Mac spojení ukončil dřív, než párování doběhlo.' });
    socket.onmessage = (event) => {
      let message: { type?: unknown; ok?: unknown; error?: unknown; key?: unknown; deviceId?: unknown; scope?: unknown; name?: unknown };
      try { message = JSON.parse(String(event.data)) as typeof message; } catch { return; }
      if (message?.type !== 'paired') return;
      if (message.ok !== true) { finish({ ok: false, error: typeof message.error === 'string' ? message.error : 'Párování se nepovedlo.' }); return; }
      const key = typeof message.key === 'string' && KEY_SHAPE.test(message.key) ? message.key : null;
      const link = parseLink(JSON.stringify({ endpoint, deviceId: message.deviceId, name: typeof message.name === 'string' ? message.name : name, scope: message.scope, pairedAt: (input.now ?? Date.now)() }), env().dev);
      if (!key || !link) { finish({ ok: false, error: 'Mac poslal neúplnou odpověď — spáruj znovu novým kódem.' }); return; }
      void (async () => {
        try {
          const store = input.vault === undefined ? await nativeVault() : input.vault;
          if (store) await store.secureSet({ key: RITHMIC_DEVICE_SECRET_KEY, value: key });
          else window.localStorage.setItem(RITHMIC_DEVICE_SECRET_KEY, key);
          (input.storage ?? window.localStorage).setItem(RITHMIC_DEVICE_LINK_KEY, JSON.stringify(link));
          finish({ ok: true, link });
        } catch {
          // Klíč nejde uložit → zařízení je u služby zapsané, ale nepoužitelné: na Macu ho odvolej a spáruj znovu.
          finish({ ok: false, error: 'Klíč se nepodařilo uložit do Klíčenky — na Macu toto zařízení odvolej a spáruj znovu.' });
        }
      })();
    };
  });
}
