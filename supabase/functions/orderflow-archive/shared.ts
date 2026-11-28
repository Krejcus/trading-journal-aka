// Sdílená logika archivu order flow: účelový klíč pro Mac, podpis požadavků, ověření dne.
// Bez importů — používá ji Edge Function (Deno), nahrávač na Macu (Node) i testy (vitest). Jen Web Crypto.
// Návrh: docs/reviews/orderflow-history-archive-design-20261127.md, část C.

/** Odvolání všech klíčů = zvednout štítek (a znovu nasadit funkci). */
export const ORDERFLOW_ARCHIVE_GRANT_LABEL = 'rithmic-orderflow-archive:v1';
export const ORDERFLOW_ARCHIVE_HEADER = 'x-alphatrade-of-auth';
export const ORDERFLOW_ARCHIVE_BUCKET = 'orderflow-archive';
export const ORDERFLOW_ARCHIVE_SKEW_MS = 120_000;
export const ORDERFLOW_ARCHIVE_MAX_BYTES = 3 * 1024 * 1024;
/** Strop nahraných dnů za 24 h (první naplnění ~60 dní, pak 1 denně). */
export const ORDERFLOW_ARCHIVE_DAILY_QUOTA = 300;
/** Jak daleko zpět smí být obchodní den (Rithmic dává jen běžící kontrakt, archiv ze služby ~týdny). */
export const ORDERFLOW_ARCHIVE_MAX_AGE_DAYS = 800;

export type OrderFlowArchiveSource = 'live' | 'backfill' | 'merged';
export type OrderFlowArchiveAction = 'prepare' | 'commit';

export interface OrderFlowArchiveRequest {
  action: OrderFlowArchiveAction;
  contract: string;
  tradeDate: string;
  sha256: string;
  bytes: number;
  source: OrderFlowArchiveSource;
}

const SOURCES: readonly OrderFlowArchiveSource[] = ['live', 'backfill', 'merged'];
/** Pořadí kvality dne: sloučený > jen ze služby > jen z historie. Horší den lepší nepřepíše. */
const RANK: Record<OrderFlowArchiveSource, number> = { backfill: 1, live: 2, merged: 3 };

export function validateArchiveRequest(body: unknown, now: number): OrderFlowArchiveRequest | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'invalid-body' };
  const b = body as Record<string, unknown>;
  if (b.action !== 'prepare' && b.action !== 'commit') return { error: 'invalid-action' };
  if (typeof b.contract !== 'string' || !/^NQ[HMUZ][0-9]$/.test(b.contract)) return { error: 'invalid-contract' };
  if (typeof b.tradeDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.tradeDate)) return { error: 'invalid-date' };
  const dateMs = Date.parse(`${b.tradeDate}T12:00:00Z`);
  if (!Number.isFinite(dateMs) || new Date(dateMs).toISOString().slice(0, 10) !== b.tradeDate) return { error: 'invalid-date' };
  if (dateMs > now + 2 * 86_400_000 || dateMs < now - ORDERFLOW_ARCHIVE_MAX_AGE_DAYS * 86_400_000) return { error: 'date-out-of-range' };
  if (typeof b.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha256)) return { error: 'invalid-sha256' };
  if (typeof b.bytes !== 'number' || !Number.isInteger(b.bytes) || b.bytes <= 0 || b.bytes > ORDERFLOW_ARCHIVE_MAX_BYTES) return { error: 'invalid-bytes' };
  if (typeof b.source !== 'string' || !SOURCES.includes(b.source as OrderFlowArchiveSource)) return { error: 'invalid-source' };
  return { action: b.action, contract: b.contract, tradeDate: b.tradeDate, sha256: b.sha256, bytes: b.bytes, source: b.source as OrderFlowArchiveSource };
}

/** Smí nový den nahradit uložený? Horší zdroj lepší nepřepíše (např. historie den se živými bublinami). */
export const mayReplaceArchiveDay = (existing: OrderFlowArchiveSource | null, next: OrderFlowArchiveSource): boolean =>
  existing === null || RANK[next] >= RANK[existing];

/** Cesta v bucketu — sha v cestě: obsah se nikdy nepřepisuje, nový den = nový soubor. */
export const archiveObjectPath = (userId: string, r: Pick<OrderFlowArchiveRequest, 'contract' | 'tradeDate' | 'sha256'>): string =>
  `${userId}/NQ/${r.contract}/${r.tradeDate}/${r.sha256}.json.gz`;

/** Podepisovaný text: celá operace, ne jen její druh. */
export const archiveCanonical = (ts: number, r: OrderFlowArchiveRequest): string =>
  [String(ts), r.action, r.contract, r.tradeDate, r.sha256, String(r.bytes), r.source].join('\n');

const toBase64Url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function hmac(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message))));
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Účelový klíč odvozený ze serverového tajemství a ID uživatele. Neumí nic než nahrát den order flow. */
export async function deriveArchiveKey(secret: string, userId: string): Promise<string | null> {
  if (!secret || secret.trim().length < 32 || !USER_ID.test(userId)) return null;
  return hmac(secret.trim(), `${ORDERFLOW_ARCHIVE_GRANT_LABEL}:${userId.toLowerCase()}`);
}

/** Hlavička požadavku z Macu: `<ts ms>.<podpis>`. */
export async function signArchiveRequest(key: string, ts: number, r: OrderFlowArchiveRequest): Promise<string> {
  return `${ts}.${await hmac(key, archiveCanonical(ts, r))}`;
}

const sameText = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export async function verifyArchiveRequest(header: string | null, r: OrderFlowArchiveRequest, secret: string, userId: string, now: number): Promise<boolean> {
  if (!header) return false;
  const match = /^(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) return false;
  const ts = Number(match[1]);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > ORDERFLOW_ARCHIVE_SKEW_MS) return false;
  const key = await deriveArchiveKey(secret, userId);
  if (!key) return false;
  const expected = await signArchiveRequest(key, ts, r);
  return sameText(expected, `${ts}.${match[2]}`);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ArchiveDaySummary { minutes: number; trades: number; exactMinutes: number; flowVolume: number; candleVolume: number | null }

/** Obsah dne (rozbalený JSON) musí sedět s požadavkem; jinak se nic neuloží. */
export function summarizeArchiveDay(day: unknown, r: Pick<OrderFlowArchiveRequest, 'contract' | 'tradeDate' | 'source'>): ArchiveDaySummary | { error: string } {
  if (!day || typeof day !== 'object') return { error: 'invalid-day' };
  const d = day as Record<string, unknown>;
  if (d.v !== 1 || d.root !== 'NQ') return { error: 'invalid-version' };
  if (d.contract !== r.contract || d.tradeDate !== r.tradeDate || d.source !== r.source) return { error: 'day-mismatch' };
  if (!Array.isArray(d.minutes) || !Array.isArray(d.trades) || !Array.isArray(d.exactBubbles) || !Array.isArray(d.coverage)) return { error: 'invalid-shape' };
  const check = (d.check ?? {}) as Record<string, unknown>;
  const flowVolume = typeof check.flowVolume === 'number' && check.flowVolume >= 0 ? Math.round(check.flowVolume) : null;
  if (flowVolume === null) return { error: 'invalid-check' };
  const exactMinutes = Math.round((d.exactBubbles as unknown[]).reduce<number>((s, span) => {
    if (!Array.isArray(span) || typeof span[0] !== 'number' || typeof span[1] !== 'number' || span[1] < span[0]) return s;
    return s + (span[1] - span[0]) / 60_000;
  }, 0));
  return {
    minutes: d.minutes.length, trades: d.trades.length, exactMinutes, flowVolume,
    candleVolume: typeof check.candleVolume === 'number' && check.candleVolume >= 0 ? Math.round(check.candleVolume) : null,
  };
}
