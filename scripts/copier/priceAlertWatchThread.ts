import { randomUUID } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import { PRICE_ALERT_WATCH_HEADER, signPriceAlertWatchRequest, type PriceAlertWatchAction } from '../../server/priceAlertWatchKey';
import { createPriceAlertWatchCore, parseWatchAlert, PRICE_GAP_MS, type WatchAlert, type WatchTrigger } from '../../services/priceAlertWatchCore';

/**
 * Vlákno hlídače upozornění na cenu (2. 11. 2026, docs/reviews/price-alerts-contract-20261102.md).
 * Samostatný bundle `price-alert-watch.mjs`, `env: {}`: nezná token zařízení ani relay
 * příkazů, umí jen číst upozornění a hlásit křížení klíčem odvozeným pro upozornění
 * (INV-WORKER-04, INV-WATCH-01). Cena přichází jen jako dávky obchodů IBKR z vlákna
 * ceny přes hlavní vlákno; ven jde jen id upozornění, verze a čas, nikdy cena (INV-UI-04).
 * Logika křížení je v `services/priceAlertWatchCore.ts`; tady jen síť a fronta hlášení.
 */
interface Config { apiOrigin: string; deviceId: string; key: string }
interface Pending extends WatchTrigger { firstAt: number }

const port = parentPort;
if (!port) throw new Error('priceAlertWatchThread musí běžet jako worker_threads vlákno');

const LIST_MS = 5_000;
const REQUEST_TIMEOUT_MS = 4_000;
const SYNC_STALE_MS = 15_000;
const PENDING_MAX_AGE_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 60_000;

const core = createPriceAlertWatchCore({ uuid: randomUUID });
let config: Config | null = null;
let configKey = '';
let syncAt: number | null = null;
let listing = false;
let nextListAt = 0;
let listBackoff = 0;
let sending = false;
let nextSendAt = 0;
let sendBackoff = 0;
const pending: Pending[] = [];

async function call(action: PriceAlertWatchAction, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const current = config;
  if (!current) return null;
  const payload = JSON.stringify({ action, ...body });
  const response = await fetch(`${current.apiOrigin}/api/price-alerts/watch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PRICE_ALERT_WATCH_HEADER]: signPriceAlertWatchRequest({ deviceId: current.deviceId, key: current.key, action, body: payload, ts: Date.now() }),
    },
    body: JSON.stringify({ payload }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`status-${response.status}`);
  return await response.json() as Record<string, unknown>;
}

async function list(): Promise<void> {
  if (listing || !config) return;
  listing = true;
  const startedKey = configKey;
  try {
    const data = await call('list', {});
    if (startedKey !== configKey) return;
    const rows = data?.alerts;
    if (!Array.isArray(rows)) throw new Error('invalid-list');
    core.setAlerts(rows.map(parseWatchAlert).filter((item): item is WatchAlert => item != null));
    syncAt = Date.now();
    listBackoff = 0;
    nextListAt = Date.now() + LIST_MS;
  } catch {
    listBackoff = Math.min(MAX_BACKOFF_MS, listBackoff ? listBackoff * 2 : LIST_MS);
    nextListAt = Date.now() + listBackoff;
  } finally {
    listing = false;
  }
}

async function flush(): Promise<void> {
  if (sending || !config || pending.length === 0 || Date.now() < nextSendAt) return;
  sending = true;
  const startedKey = configKey;
  try {
    const data = await call('trigger', {
      triggers: pending.slice(0, 10).map(({ alertId, version, triggerId, observedAt, front }) => ({ alertId, version, triggerId, observedAt, front })),
    });
    if (startedKey !== configKey) return;
    // Odpověď serveru je konečná (triggered / duplicate / rejected); opakuje se jen transport
    // a vždy se stejným id (server pak pozná duplicitu).
    const results = data?.results;
    const answered = new Set(Array.isArray(results)
      ? results.flatMap((item: unknown) => {
        const row = item as { triggerId?: unknown; status?: unknown } | null;
        return row && typeof row.triggerId === 'string' && row.status !== 'error' ? [row.triggerId] : [];
      })
      : []);
    for (let index = pending.length - 1; index >= 0; index -= 1) if (answered.has(pending[index].triggerId)) pending.splice(index, 1);
    sendBackoff = 0;
    nextSendAt = 0;
  } catch {
    sendBackoff = Math.min(MAX_BACKOFF_MS, sendBackoff ? sendBackoff * 2 : 1_000);
    nextSendAt = Date.now() + sendBackoff;
  } finally {
    sending = false;
    const cutoff = Date.now() - PENDING_MAX_AGE_MS;
    for (let index = pending.length - 1; index >= 0; index -= 1) if (pending[index].firstAt < cutoff) pending.splice(index, 1);
  }
}

function applyConfig(message: Record<string, unknown>): void {
  if (message.off === true) {
    config = null;
    configKey = '';
    core.clear();
    pending.length = 0;
    syncAt = null;
    return;
  }
  const apiOrigin = typeof message.apiOrigin === 'string' && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(message.apiOrigin) ? message.apiOrigin : null;
  const deviceId = typeof message.deviceId === 'string' && /^[0-9a-f-]{36}$/.test(message.deviceId) ? message.deviceId : null;
  const key = typeof message.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(message.key) ? message.key : null;
  if (!apiOrigin || !deviceId || !key) return;
  const nextKey = `${apiOrigin}|${deviceId}|${key}`;
  if (nextKey === configKey) return;
  config = { apiOrigin, deviceId, key };
  configKey = nextKey;
  core.clear();
  pending.length = 0;
  syncAt = null;
  nextListAt = 0;
  listBackoff = 0;
}

port.on('message', message => {
  try {
    if (!message || typeof message !== 'object') return;
    const row = message as Record<string, unknown>;
    if (row.type === 'config') {
      applyConfig(row);
    } else if (row.type === 'batch' && config) {
      const triggers = core.onBatch(row as never);
      if (triggers.length) {
        const firstAt = Date.now();
        pending.push(...triggers.map(trigger => ({ ...trigger, firstAt })));
        void flush();
      }
    }
  } catch { /* hlídač nikdy nespadne kvůli jedné zprávě */ }
});

setInterval(() => {
  try {
    if (config && !listing && Date.now() >= nextListAt) void list();
    if (pending.length) void flush();
  } catch { /* best effort */ }
}, 1_000);

setInterval(() => {
  try {
    const now = Date.now();
    const { alerts, priceAt } = core.state();
    const state = !config ? 'off'
      : syncAt == null || now - syncAt > SYNC_STALE_MS ? 'no-sync'
        : priceAt == null || now - priceAt > PRICE_GAP_MS ? 'no-price'
          : 'watching';
    port.postMessage({ type: 'watch', state, alerts, priceAt, syncAt });
  } catch { /* best effort */ }
}, 1_000);
