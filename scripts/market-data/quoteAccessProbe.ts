import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  createMacCopierDeviceTokenProvider,
  loadMacCopierDevice,
} from '../../server/macCopierDevice';

/**
 * Read-only entitlement probe for Tradovate's market-data socket.
 * It reuses the paired Mac device lease, never logs tokens or prices, sends
 * only authorize/subscribeQuote/unsubscribeQuote and always closes the socket.
 */

interface ConnectionManifest {
  version: 1;
  connections: Array<{
    connectionId: string;
    deviceConfigPath: string;
  }>;
}

interface ProbeResult {
  authorized: boolean;
  subscribed: boolean;
  mode: string | null;
  quoteEvents: number;
  quoteUpdates: number;
  entryTypes: string[];
  medianArrivalGapMs: number | null;
  rejection: string | null;
}

interface SubscriptionDiagnostic {
  httpStatus: number | null;
  total: number | null;
  active: number | null;
  plans: Array<{
    title: string | null;
    dataType: string | null;
    professional: string | null;
    price: number | null;
  }>;
}

const safeRejection = (value: unknown): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'rejected';
  const payload = value as Record<string, unknown>;
  const text = String(payload.errorCode ?? payload.errorText ?? payload.message ?? 'rejected');
  return text.replace(/[^a-z0-9 _().:-]/gi, '').slice(0, 120);
};

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

const probe = (
  accessToken: string,
  symbol: string | number,
  websocketUrl: string,
): Promise<ProbeResult> => new Promise(resolve => {
  const socket = new WebSocket(websocketUrl);
  let authorized = false;
  let subscribed = false;
  let mode: string | null = null;
  let quoteEvents = 0;
  let quoteUpdates = 0;
  let rejection: string | null = null;
  let settled = false;
  let listeningStartedAt = 0;
  const entryTypes = new Set<string>();
  const arrivals: number[] = [];
  const arrivalGaps: number[] = [];
  const heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send('[]');
  }, 2_500);

  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    clearInterval(heartbeat);
    try {
      if (subscribed) socket.send(`md/unsubscribeQuote\n2\n\n${JSON.stringify({ symbol })}`);
    } catch { /* best effort cleanup */ }
    setTimeout(() => {
      try { socket.close(); } catch { /* best effort cleanup */ }
      resolve({
        authorized,
        subscribed,
        mode,
        quoteEvents,
        quoteUpdates,
        entryTypes: [...entryTypes].sort(),
        medianArrivalGapMs: median(arrivalGaps),
        rejection,
      });
    }, 100);
  };
  const deadline = setTimeout(() => {
    if (!rejection && !subscribed) rejection = 'timeout-before-subscription';
    finish();
  }, 25_000);

  socket.addEventListener('message', event => {
    const raw = String(event.data ?? '');
    if (raw === 'o') {
      socket.send(`authorize\n0\n\n${accessToken}`);
      return;
    }
    if (raw.startsWith('h')) {
      socket.send('[]');
      return;
    }
    if (!raw.startsWith('a')) return;

    let messages: unknown;
    try { messages = JSON.parse(raw.slice(1)); } catch { return; }
    if (!Array.isArray(messages)) return;
    for (const candidate of messages) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const message = candidate as { i?: number; s?: number; e?: string; d?: unknown };
      if (message.i === 0) {
        if (message.s !== 200) {
          rejection = `authorize-${message.s ?? 'rejected'}:${safeRejection(message.d)}`;
          finish();
          return;
        }
        authorized = true;
        socket.send(`md/subscribeQuote\n1\n\n${JSON.stringify({ symbol })}`);
        continue;
      }
      if (message.i === 1) {
        if (message.s !== 200) {
          rejection = `subscribe-${message.s ?? 'rejected'}:${safeRejection(message.d)}`;
          finish();
          return;
        }
        if (message.d && typeof message.d === 'object' && !Array.isArray(message.d)) {
          const responseData = message.d as Record<string, unknown>;
          mode = typeof responseData.mode === 'string' ? responseData.mode : null;
          if (responseData.errorCode || responseData.errorText || mode === 'None') {
            rejection = `subscribe-200:${safeRejection(responseData)}`;
            finish();
            return;
          }
        }
        subscribed = true;
        listeningStartedAt = Date.now();
        setTimeout(finish, 15_000);
        continue;
      }
      if (message.e !== 'md' || !message.d || typeof message.d !== 'object' || Array.isArray(message.d)) continue;
      const quotes = (message.d as { quotes?: unknown }).quotes;
      if (!Array.isArray(quotes)) continue;
      quoteEvents += 1;
      const arrivedAt = Date.now();
      if (arrivals.length > 0) arrivalGaps.push(arrivedAt - arrivals[arrivals.length - 1]);
      arrivals.push(arrivedAt);
      for (const quote of quotes) {
        if (!quote || typeof quote !== 'object' || Array.isArray(quote)) continue;
        const entries = (quote as { entries?: unknown }).entries;
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
        quoteUpdates += 1;
        Object.keys(entries).forEach(key => entryTypes.add(key));
      }
      if (listeningStartedAt > 0 && Date.now() - listeningStartedAt >= 15_000) finish();
    }
  });
  socket.addEventListener('error', () => {
    rejection ??= 'websocket-transport-error';
    finish();
  });
  socket.addEventListener('close', () => {
    if (!settled) {
      rejection ??= 'websocket-closed';
      finish();
    }
  });
});

const subscriptionDiagnostic = async (accessToken: string): Promise<SubscriptionDiagnostic> => {
  try {
    const response = await fetch('https://demo.tradovateapi.com/v1/marketDataSubscription/list', {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok || !Array.isArray(body)) {
      return { httpStatus: response.status, total: null, active: null, plans: [] };
    }
    const activeSubscriptions = body.filter(value => value && typeof value === 'object'
      && !Array.isArray(value) && (value as { expired?: unknown }).expired === false) as Array<{
        marketDataSubscriptionPlanId?: unknown;
      }>;
    const planIds = [...new Set(activeSubscriptions
      .map(value => Number(value.marketDataSubscriptionPlanId))
      .filter(value => Number.isSafeInteger(value) && value > 0))];
    const plans: SubscriptionDiagnostic['plans'] = [];
    for (const id of planIds) {
      const planResponse = await fetch(`https://demo.tradovateapi.com/v1/marketDataSubscriptionPlan/item?id=${id}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8_000),
      });
      const plan = await planResponse.json().catch(() => null) as Record<string, unknown> | null;
      if (!planResponse.ok || !plan || Array.isArray(plan)) continue;
      plans.push({
        title: typeof plan.title === 'string' ? plan.title : typeof plan.name === 'string' ? plan.name : null,
        dataType: typeof plan.dataType === 'string' ? plan.dataType : null,
        professional: typeof plan.professional === 'string' ? plan.professional : null,
        price: typeof plan.price === 'number' && Number.isFinite(plan.price) ? plan.price : null,
      });
    }
    return {
      httpStatus: response.status,
      total: body.length,
      active: activeSubscriptions.length,
      plans,
    };
  } catch {
    return { httpStatus: null, total: null, active: null, plans: [] };
  }
};

const resolveContractId = async (accessToken: string, symbol: string): Promise<number | null> => {
  try {
    const response = await fetch(`https://demo.tradovateapi.com/v1/contract/find?name=${encodeURIComponent(symbol)}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    const body = await response.json().catch(() => null) as { id?: unknown } | null;
    const id = Number(body?.id);
    return response.ok && Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
};

async function main(): Promise<void> {
  const symbol = (process.argv[2] ?? 'MNQU6').trim().toUpperCase();
  if (!/^MNQ[FGHJKMNQUVXZ]\d{1,2}$/.test(symbol)) throw new Error('invalid-mnq-symbol');
  const manifestPath = process.argv[3]
    ?? resolve(homedir(), 'Library/Application Support/AlphaTrade/copier/connections.json');
  const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8')) as ConnectionManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.connections)) throw new Error('invalid-connections-manifest');
  const connections = manifest.connections;
  console.log(`Quote access probe: symbol=${symbol}, connected=${connections.length}`);
  if (connections.length === 0) return;

  const websocketUrls = [
    'wss://md.tradovateapi.com/v1/websocket',
    'wss://md-demo.tradovateapi.com/v1/websocket',
  ];

  for (const [index, connection] of connections.entries()) {
    const config = await loadMacCopierDevice(connection.deviceConfigPath);
    if (config.connectionId !== connection.connectionId) throw new Error('connection-device-mismatch');
    const token = await createMacCopierDeviceTokenProvider({ config }).getAccessToken();
    console.log(`connection ${index + 1}/${connections.length} subscriptions: ${JSON.stringify(await subscriptionDiagnostic(token))}`);
    const contractId = await resolveContractId(token, symbol);
    for (const websocketUrl of websocketUrls) {
      const host = new URL(websocketUrl).hostname;
      for (const [target, value] of [['symbol', symbol], ...(contractId ? [['contract-id', contractId]] : [])] as Array<[string, string | number]>) {
        const result = await probe(token, value, websocketUrl);
        console.log(`connection ${index + 1}/${connections.length} host=${host} target=${target}: ${JSON.stringify(result)}`);
      }
    }
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'probe-failed');
  process.exitCode = 1;
});
