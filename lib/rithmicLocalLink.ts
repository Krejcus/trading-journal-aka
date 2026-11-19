// Spojení appky s místním procesem Rithmicu (scripts/rithmic/devTradeServer.ts).
// Bez tokenu v tomto prohlížeči je cesta vypnutá: žádná záložka, žádné spojení (INV-DEFAULT-02).
// Adresa je napevno místní smyčka — appka se nikdy nepřipojuje jinam.

import { readRithmicDeviceKey, readRithmicDeviceLink, rithmicDeviceLinkAllowed } from './rithmicDeviceLink';
import { isNativeBuild } from '../utils/runtimeConfig';
import { isNativeShell } from '../utils/nativeShell';

export const RITHMIC_LOCAL_TOKEN_KEY = 'at:rithmic:local-token';
const RITHMIC_LOCAL_ENDPOINT = 'ws://127.0.0.1:3311';
const HASH_PARAM = 'rithmic-token';
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

/** Čistá část: z hashe adresy vytáhne token a vrátí hash bez něj (ostatní parametry zůstanou). */
export function takeRithmicTokenFromHash(hash: string): { token: string | null; rest: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const raw = params.get(HASH_PARAM);
  if (raw === null) return { token: null, rest: hash };
  params.delete(HASH_PARAM);
  const rest = params.toString();
  return { token: TOKEN_SHAPE.test(raw) ? raw : null, rest: rest ? `#${rest}` : '' };
}

/** Produkční adresa appky, kde se graf přes místní službu smí nabídnout (rozhodnutí Filipa 19. 11. 2026). */
export const RITHMIC_PRODUCTION_HOST = 'alphatrade-mentor-15.vercel.app';

/**
 * Kde smí cesta vůbec existovat: vývojová appka na místní adrese, nebo produkční appka na své přesné adrese
 * (ne náhledy Vercelu, ne jiné domény). Nikdy v nativní appce (ta má vlastní cestu přes spárování).
 * Bez tokenu v tomto prohlížeči je cesta i tak vypnutá a appka se připojuje jen na 127.0.0.1 — služba navíc
 * hlídá Origin. Token se do produkční appky dostane jen jednorázovým odkazem z Macu (`#rithmic-token=…`).
 */
export function rithmicLocalAllowedHere(env: { dev: boolean; hostname: string; native: boolean }): boolean {
  if (env.native) return false;
  if (env.dev) return env.hostname === 'localhost' || env.hostname === '127.0.0.1';
  return env.hostname === RITHMIC_PRODUCTION_HOST;
}

const allowedHere = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return rithmicLocalAllowedHere({ dev: import.meta.env?.DEV === true, hostname: window.location.hostname, native: isNativeShell() });
  } catch { return false; }
};

let adopted = false;
/**
 * Jednorázově převezme `#rithmic-token=…` z adresy do TRVALÉHO úložiště prohlížeče a z adresy ho smaže.
 * Rozhodnutí Filipa 17. 11. 2026: klíč má přežít zavření záložky (úložiště záložky ho ztrácelo při každém zavření).
 * Klíč je jen místní (služba poslouchá na 127.0.0.1 a navíc hlídá Origin); leží i v souboru na disku.
 */
function adoptTokenFromLocation(): void {
  if (adopted || !allowedHere()) return;
  adopted = true;
  try {
    const { token, rest } = takeRithmicTokenFromHash(window.location.hash);
    if (rest === window.location.hash) return;
    if (token) window.localStorage.setItem(RITHMIC_LOCAL_TOKEN_KEY, token);
    window.history.replaceState(null, '', window.location.pathname + window.location.search + rest);
  } catch { /* soukromé okno, zakázané úložiště */ }
}

export function rithmicLocalToken(): string | null {
  if (!allowedHere()) return null;
  adoptTokenFromLocation();
  try {
    let token = window.localStorage.getItem(RITHMIC_LOCAL_TOKEN_KEY);
    // Klíč uložený jen pro záložku (krátce používaná varianta) se převezme do trvalého úložiště.
    const tabOnly = window.sessionStorage.getItem(RITHMIC_LOCAL_TOKEN_KEY);
    if (tabOnly !== null) {
      if (!token && TOKEN_SHAPE.test(tabOnly)) {
        window.localStorage.setItem(RITHMIC_LOCAL_TOKEN_KEY, tabOnly);
        token = tabOnly;
      }
      window.sessionStorage.removeItem(RITHMIC_LOCAL_TOKEN_KEY);
    }
    return token && TOKEN_SHAPE.test(token) ? token : null;
  } catch { return null; }
}

/**
 * Adresa služby: na PC místní proces s tokenem; ve spárovaném zařízení (telefon) adresa Macu v síti Tailscale —
 * bez klíče (ten jde první zprávou, viz `rithmicLocalAuth`). Null = cesta tu není nastavená.
 */
export function rithmicLocalUrl(): string | null {
  const token = rithmicLocalToken();
  if (token) return `${RITHMIC_LOCAL_ENDPOINT}/?token=${encodeURIComponent(token)}`;
  return readRithmicDeviceLink()?.endpoint ?? null;
}

/** Přihlášení spárovaného zařízení klíčem z Klíčenky; null = PC cesta s tokenem v adrese (nebo nic). */
export function rithmicLocalAuth(): (() => Promise<string | null>) | null {
  if (rithmicLocalToken()) return null;
  return readRithmicDeviceLink() ? () => readRithmicDeviceKey() : null;
}

/** Záložka Graf s Rithmicem se nabízí: vývojová appka na místní adrese s tokenem, nebo spárované zařízení. */
export const rithmicLocalAvailable = (): boolean => rithmicLocalToken() !== null || readRithmicDeviceLink() !== null;

/** Smí se tu vůbec nabídnout spárování s Macem (nativní appka, nebo vývojový režim)? */
export const rithmicPairingOffered = (): boolean => rithmicDeviceLinkAllowed({ dev: import.meta.env?.DEV === true, native: isNativeBuild });
