// Spojení appky s místním procesem Rithmicu (scripts/rithmic/devTradeServer.ts).
// Bez tokenu v tomto prohlížeči je cesta vypnutá: žádná záložka, žádné spojení (INV-DEFAULT-02).
// Adresa je napevno místní smyčka — appka se nikdy nepřipojuje jinam.

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

/**
 * Kde smí cesta vůbec existovat: jen vývojová appka na místní adrese a ne nativní appka.
 * Produkční build ji nemá nikdy — ani s tokenem v prohlížeči (rozhodnutí o nasazení přijde zvlášť).
 */
export function rithmicLocalAllowedHere(env: { dev: boolean; hostname: string; native: boolean }): boolean {
  return env.dev && !env.native && (env.hostname === 'localhost' || env.hostname === '127.0.0.1');
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

/** Adresa místního procesu s tokenem, nebo null, když token chybí. */
export function rithmicLocalUrl(): string | null {
  const token = rithmicLocalToken();
  return token ? `${RITHMIC_LOCAL_ENDPOINT}/?token=${encodeURIComponent(token)}` : null;
}

/** Záložka Graf s Rithmicem se nabízí jen tady: vývojová appka na místní adrese s uloženým tokenem. */
export const rithmicLocalAvailable = (): boolean => rithmicLocalToken() !== null;
