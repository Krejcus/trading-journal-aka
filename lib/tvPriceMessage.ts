/**
 * Zpráva kanálu ceny z TradingView (worker → Realtime → klient). Jen
 * zobrazení — cena ani z ní spočtené P&L nesmí do risku, limitů, day locku,
 * kopírky ani read modelu účtů (INV-UI-04, pravidlo v `lib/tradingViewBars.ts`).
 *
 * Kanál je veřejný (anon klíč), proto se každá zpráva podepisuje klíčem
 * zařízení: podepisuje a ověřuje se **surový řetězec** `p` (serializace Node
 * a JavaScriptCore se může lišit), parsuje se až po ověření. Bez WebCrypto
 * (nezabezpečený kontext) ověření selže a klient zůstane u kotvy brokera.
 */

export const TV_PRICE_EVENT = 'price';
/** Strop velikosti `p`: zpráva nese jen poslední svíčku a kotaci. */
export const TV_PRICE_MAX_PAYLOAD_CHARS = 2_048;

export interface TvPricePayload {
  v: 1;
  /** Monotónní v rámci `runId`. */
  seq: number;
  /** Náhodné ID běhu streamu (nový start workeru/vlákna = nové ID). */
  runId: string;
  /** Symbol grafu (`CME_MINI:MNQ1!`). */
  chart: string;
  /** Interval panelu; pro P&L a živou svíčku se přijímá jen `'1'`. */
  interval: string;
  /** Pořadí panelu v okně TV. */
  pane: number;
  /** Kontrakt za kontinuálním symbolem (`MNQZ2026`). */
  front: string | null;
  /** Kdy TV přepne kontinuální symbol na další kontrakt (epoch s). */
  switchAt: number | null;
  /** `update_mode` kotace (`streaming`, `delayed_streaming_600` …). */
  mode: string | null;
  /** Poslední svíčka: [čas otevření s, open, high, low, close]. */
  bar: [number, number, number, number, number] | null;
  last: number | null;
  bid: number | null;
  ask: number | null;
  /** Hodiny workeru v ms. */
  at: number;
}

export interface TvPriceEnvelope {
  p: string;
  sig: string;
}

const PAYLOAD_KEYS = ['v', 'seq', 'runId', 'chart', 'interval', 'pane', 'front', 'switchAt', 'mode', 'bar', 'last', 'bid', 'ask', 'at'];

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const price = (value: unknown) => value === null || (finite(value) && value > 0);
const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max;
const optionalText = (value: unknown, max: number) => value === null || text(value, max);

/** Tvar zprávy; klíč navíc, chybějící klíč nebo hodnota mimo rozsah = neplatná zpráva. */
export function isTvPricePayload(value: unknown): value is TvPricePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const bar = row.bar;
  const barValid = bar === null || (Array.isArray(bar) && bar.length === 5 && bar.every(finite)
    && (bar[0] as number) % 60 === 0 && (bar as number[]).slice(1).every(item => item > 0)
    && (bar[2] as number) >= Math.max(bar[1] as number, bar[4] as number, bar[3] as number)
    && (bar[3] as number) <= Math.min(bar[1] as number, bar[4] as number));
  const keys = Object.keys(row);
  return keys.length === PAYLOAD_KEYS.length && keys.every(key => PAYLOAD_KEYS.includes(key))
    && row.v === 1
    && Number.isSafeInteger(row.seq) && (row.seq as number) >= 0
    && text(row.runId, 64) && text(row.chart, 64) && text(row.interval, 8)
    && Number.isSafeInteger(row.pane) && (row.pane as number) >= 0 && (row.pane as number) <= 16
    && optionalText(row.front, 16) && (row.switchAt === null || finite(row.switchAt))
    && optionalText(row.mode, 32) && barValid
    && price(row.last) && price(row.bid) && price(row.ask)
    && (row.bid === null || row.ask === null || (row.bid as number) <= (row.ask as number))
    && Number.isSafeInteger(row.at) && (row.at as number) > 0;
}

const subtle = (): SubtleCrypto | null => {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  return crypto?.subtle ?? null;
};

/** Nikdy nevyhodí (délka ≡ 1 mod 4 by v `atob` selhala) — volá se i ve vlákně workeru. */
const decodeBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value) || value.length % 4 === 1) return null;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
};

const encodeBase64Url = (bytes: ArrayBuffer): string => {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const keyCache = new Map<string, Promise<CryptoKey | null>>();
const importKey = (key: string): Promise<CryptoKey | null> => {
  const cached = keyCache.get(key);
  if (cached) return cached;
  const api = subtle();
  const raw = decodeBase64Url(key);
  const pending = !api || !raw
    ? Promise.resolve(null)
    : api.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']).catch(() => null);
  // Klíč zařízení je jeden; strop chrání jen proti nečekanému růstu.
  if (keyCache.size > 8) keyCache.clear();
  keyCache.set(key, pending);
  return pending;
};

const encoder = new TextEncoder();

/**
 * Podepíše zprávu (worker). `null` = podpis není možný (žádné WebCrypto,
 * neplatný klíč či obsah); nikdy nevyhodí. Ochrana proti replay (`seq`
 * v rámci `runId`) patří klientovi, ne sem.
 */
export async function signTvPricePayload(payload: TvPricePayload, key: string): Promise<TvPriceEnvelope | null> {
  try {
    if (!isTvPricePayload(payload)) return null;
    const p = JSON.stringify(payload);
    if (p.length > TV_PRICE_MAX_PAYLOAD_CHARS) return null;
    const cryptoKey = await importKey(key);
    const api = subtle();
    if (!cryptoKey || !api) return null;
    return { p, sig: encodeBase64Url(await api.sign('HMAC', cryptoKey, encoder.encode(p))) };
  } catch {
    return null;
  }
}

/**
 * Ověří podpis surového `p` a teprve pak ho rozparsuje (klient).
 * Jakákoli chyba = `null`: zpráva se zahodí a zobrazení zůstane u kotvy.
 */
export async function verifyTvPriceEnvelope(envelope: unknown, key: string): Promise<TvPricePayload | null> {
  try {
    const row = envelope as Partial<TvPriceEnvelope> | null;
    if (!row || typeof row.p !== 'string' || typeof row.sig !== 'string' || row.p.length > TV_PRICE_MAX_PAYLOAD_CHARS) return null;
    const signature = decodeBase64Url(row.sig);
    const cryptoKey = await importKey(key);
    const api = subtle();
    if (!signature || !cryptoKey || !api) return null;
    if (!await api.verify('HMAC', cryptoKey, signature, encoder.encode(row.p))) return null;
    const payload = JSON.parse(row.p) as unknown;
    return isTvPricePayload(payload) ? payload : null;
  } catch {
    return null;
  }
}
