import type { LocalCopierAgentStatus } from './localCopierAgentProtocol';

/**
 * Expozice workeru přímo do otevřeného LIVE grafu (docs/LIVE_HOT_PATH_PLAN.md §10, F2a).
 * Worker po změně u brokera pošle na téma budíčku zašifrovanou kopii `controller.exposure`
 * a posledních událostí; graf ji použije jen pro zobrazení pozice, čar a karet, když je
 * novější než pollovaný status (pořadí `displaySeq` téhož běhu). Čerstvost, ARM, povolení
 * příkazů i brzdy dál jen z pollu (INV-RELAY-04, INV-FRESH-02/03, INV-UI-03).
 * AES-256-GCM s tématem jako AAD: podvrh ani přesun z jiného tématu bez klíče neprojde.
 */

type Controller = LocalCopierAgentStatus['controller'];
export type CopierLiveExposure = NonNullable<Controller['exposure']>;
type CopyEvents = NonNullable<Controller['recentCopyEvents']>;

export const COPIER_LIVE_EXPOSURE_EVENT = 'exposure';
/** Větší zpráva se neposílá ani nepřijme (veřejné téma, strop dešifrování). */
export const COPIER_LIVE_EXPOSURE_MAX_CHARS = 64_000;
/** Kolik posledních událostí kopírky zpráva nese (karty obchodů). */
export const COPIER_LIVE_EXPOSURE_EVENTS = 10;
/** Strop sloučených událostí (poll ∪ kanál). */
const MERGED_EVENTS_MAX = 20;
/** Zpráva „z budoucnosti“ proti kotvě pollu (víc než uplynulý čas + tohle) se zahodí. */
export const COPIER_LIVE_EXPOSURE_FUTURE_SLACK_MS = 1_000;

export interface CopierLiveExposurePayload {
  v: 1;
  /** Běh workeru; jiný než v pollovaném statusu = zahodit. */
  startedAt: string;
  /** `displaySeq` sestavení statusu, ze kterého zpráva vznikla. */
  seq: number;
  /** `displayBuiltAt` téhož sestavení (hodiny workeru). */
  builtAt: number;
  /** `null` = worker expozici nezná (odpojený, bez kontroly) — i to je novější stav. */
  exposure: CopierLiveExposure | null;
  events: CopyEvents;
}

export interface CopierLiveExposureEnvelope {
  v: 1;
  iv: string;
  ct: string;
}

const subtle = (): SubtleCrypto | null => {
  const api = (globalThis as { crypto?: Crypto }).crypto;
  return api?.subtle ?? null;
};

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const decodeBase64Url = (value: unknown): Uint8Array | null => {
  if (typeof value !== 'string' || value.length === 0 || value.length > COPIER_LIVE_EXPOSURE_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
};

const keyCache = new Map<string, Promise<CryptoKey | null>>();
/** Klíč z grantu (32 B base64url) → AES-GCM. Neplatný = null, nikdy nevyhodí. */
export function importCopierLiveKey(key: unknown): Promise<CryptoKey | null> {
  const raw = decodeBase64Url(key);
  const api = subtle();
  if (!raw || raw.length !== 32 || !api) return Promise.resolve(null);
  const cacheKey = key as string;
  let pending = keyCache.get(cacheKey);
  if (!pending) {
    pending = api.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']).catch(() => null);
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(cacheKey, pending);
  }
  return pending;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
// Meze tvaru (oponentura 30. 10.): podvržená zpráva s platným klíčem nesmí shodit graf
// (Date mimo rozsah, `toFixed` na řetězci) — čas v rozsahu Date, kusy celá čísla, krátké texty.
const MAX_TIME = 8.64e15;
const time = (value: unknown): value is number => finite(value) && value >= 0 && value <= MAX_TIME;
const int = (value: unknown): value is number => Number.isSafeInteger(value);
const text = (value: unknown, max = 64): value is string => typeof value === 'string' && value.length <= max;
const optionalNumber = (value: unknown) => value === undefined || finite(value);
const MAX_ROWS = 200;

const isExposure = (value: unknown): value is CopierLiveExposure => {
  if (!value || typeof value !== 'object') return false;
  const exposure = value as Partial<CopierLiveExposure>;
  if (!time(exposure.verifiedAt)) return false;
  if (!Array.isArray(exposure.positions) || exposure.positions.length > MAX_ROWS || !exposure.positions.every(position => position
    && int(position.accountId) && text(position.symbol, 32) && int(position.netQuantity)
    && (position.avgPrice === undefined || (finite(position.avgPrice) && position.avgPrice > 0)))) return false;
  if (!Array.isArray(exposure.followers) || exposure.followers.length > MAX_ROWS || !exposure.followers.every(follower => follower
    && int(follower.accountId) && typeof follower.ok === 'boolean' && (follower.detail === null || text(follower.detail, 200)))) return false;
  return exposure.orders === undefined || (Array.isArray(exposure.orders) && exposure.orders.length <= MAX_ROWS && exposure.orders.every(order => order
    && int(order.accountId) && text(order.brokerOrderId, 32) && text(order.symbol, 32)
    && (order.side === 'Buy' || order.side === 'Sell') && text(order.orderType, 32)
    && int(order.quantity) && int(order.filledQuantity) && text(order.status, 32) && time(order.updatedAt)
    && (order.limitPrice === null || finite(order.limitPrice)) && (order.stopPrice === null || finite(order.stopPrice))));
};

const EXIT_REASONS = new Set(['sl', 'tp', 'manual']);
const isCopyEvent = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return text(event.id) && time(event.at) && text(event.kind, 32) && text(event.symbol, 32)
    && (event.side === 'Long' || event.side === 'Short') && int(event.quantity) && int(event.followers)
    && ['price', 'stopPrice', 'targetPrice', 'pnlUsd', 'levelPnlUsd', 'stopPnlUsd', 'targetPnlUsd', 'cutUsd', 'realizedPnlUsd']
      .every(field => optionalNumber(event[field]))
    && (event.accountId === undefined || int(event.accountId))
    && (event.episodeId === undefined || text(event.episodeId))
    && (event.exitReason === undefined || (typeof event.exitReason === 'string' && EXIT_REASONS.has(event.exitReason)))
    && (event.source === undefined || text(event.source, 32))
    && (event.closed === undefined || event.closed === null || event.closed === false || finite(event.closed));
};

export function isCopierLiveExposurePayload(value: unknown): value is CopierLiveExposurePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<CopierLiveExposurePayload>;
  if (payload.v !== 1 || !text(payload.startedAt) || !Number.isFinite(Date.parse(payload.startedAt))) return false;
  if (!int(payload.seq) || payload.seq <= 0 || !time(payload.builtAt)) return false;
  if (payload.exposure !== null && !isExposure(payload.exposure)) return false;
  return Array.isArray(payload.events) && payload.events.length <= COPIER_LIVE_EXPOSURE_EVENTS && payload.events.every(isCopyEvent);
}

/** Zašifrovat pro téma budíčku (AAD = téma); příliš velká zpráva nebo chybějící WebCrypto = null. */
export async function encryptCopierLiveExposure(payload: CopierLiveExposurePayload, key: string, topic: string): Promise<CopierLiveExposureEnvelope | null> {
  try {
    const cryptoKey = await importCopierLiveKey(key);
    const api = subtle();
    if (!cryptoKey || !api) return null;
    const iv = new Uint8Array(12);
    globalThis.crypto.getRandomValues(iv);
    const plain = new TextEncoder().encode(JSON.stringify(payload));
    const ct = new Uint8Array(await api.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`v1:${topic}`) }, cryptoKey, plain));
    const envelope: CopierLiveExposureEnvelope = { v: 1, iv: encodeBase64Url(iv), ct: encodeBase64Url(ct) };
    return envelope.ct.length > COPIER_LIVE_EXPOSURE_MAX_CHARS ? null : envelope;
  } catch {
    return null;
  }
}

/** Dešifrovat a ověřit tvar; cizí klíč, jiné téma, upravená zpráva nebo cizí tvar = null. */
export async function decryptCopierLiveExposure(envelope: unknown, key: string, topic: string): Promise<CopierLiveExposurePayload | null> {
  try {
    if (!envelope || typeof envelope !== 'object' || (envelope as { v?: unknown }).v !== 1) return null;
    const iv = decodeBase64Url((envelope as { iv?: unknown }).iv);
    const ct = decodeBase64Url((envelope as { ct?: unknown }).ct);
    const cryptoKey = await importCopierLiveKey(key);
    const api = subtle();
    if (!iv || iv.length !== 12 || !ct || !cryptoKey || !api) return null;
    const plain = await api.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`v1:${topic}`) }, cryptoKey, ct);
    const payload: unknown = JSON.parse(new TextDecoder().decode(plain));
    return isCopierLiveExposurePayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

export interface CopierLiveExposureReceived {
  payload: CopierLiveExposurePayload;
  /** Čas přijetí v prohlížeči (hodiny desku). */
  receivedAt: number;
  /** Monotónní čas přijetí pro měření receive → React paint. */
  receivedPerformanceAt: number;
}

/**
 * Status pro zobrazení grafu a karet. Expozice z kanálu se použije jen tehdy, když
 * patří témuž běhu workeru a je novější (`seq`) než pollovaný status; novější poll
 * vyhrává, i když nese `exposure: null`. Stáří se počítá od kotvy pollu
 * (`observedAt + (builtAt − displayBuiltAt)`, nejvýš čas přijetí) — přehraná nebo po
 * probuzení doručená zpráva tak nevypadá čerstvěji než poll; zpráva „z budoucnosti“ se
 * zahodí. Výsledek jen pro zobrazení: nikdy do `acceptAgentStatus`, čerstvosti ani příkazů.
 */
export function mergeCopierLiveExposure(
  status: LocalCopierAgentStatus | null,
  observedAt: number | null,
  live: CopierLiveExposureReceived | null,
): { status: LocalCopierAgentStatus | null; exposureObservedAt: number | null } {
  const unchanged = { status, exposureObservedAt: observedAt };
  if (!status || !live || observedAt == null || live.payload.startedAt !== status.startedAt) return unchanged;
  // Starší worker bez pořadí: kanál neřadit (posílat ho stejně neumí).
  if (!finite(status.displaySeq) || !finite(status.displayBuiltAt)) return unchanged;
  if (!(live.payload.seq > status.displaySeq)) return unchanged;
  const ahead = live.payload.builtAt - status.displayBuiltAt;
  if (ahead > Math.max(0, live.receivedAt - observedAt) + COPIER_LIVE_EXPOSURE_FUTURE_SLACK_MS) return unchanged;
  return {
    status: {
      ...status,
      controller: {
        ...status.controller,
        exposure: live.payload.exposure,
        recentCopyEvents: mergeCopyEvents(status.controller.recentCopyEvents ?? [], live.payload.events),
      },
    },
    exposureObservedAt: Math.min(live.receivedAt, observedAt + Math.max(0, ahead)),
  };
}

/**
 * Sjednotit podle id (poll ∪ kanál), seřadit podle času, nejvýš 20; žádná událost nezmizí.
 * U stejného id vyhrává verze z kanálu — je novější (např. doplněný `exitReason`).
 */
export function mergeCopyEvents(polled: CopyEvents, live: CopyEvents): CopyEvents {
  const byId = new Map<string, CopyEvents[number]>();
  for (const event of [...live, ...polled]) if (!byId.has(event.id)) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.at - right.at).slice(-MERGED_EVENTS_MAX);
}
