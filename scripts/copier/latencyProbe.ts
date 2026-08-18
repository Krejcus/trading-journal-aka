/**
 * Měření latence k Tradovate z kandidátního regionu.
 *
 * Spouští se NA testovacím stroji (Fly machine / VPS) v každém kandidátním
 * regionu — ord, iad, ewr, dfw — a výsledky se porovnají. Ping nestačí:
 * ICMP nejde stejnou cestou jako API, proto se měří skutečný handshake,
 * REST round-trip a WebSocket připojení.
 *
 * Bez tokenu měří neautentizované round-tripy (`/contract/deps` vrací 401,
 * ale RTT je vypovídající). S `TRADOVATE_ACCESS_TOKEN` v prostředí měří
 * autentizovaný `/account/list`. Měřit BĚHEM živé session, ne v noci.
 *
 *   npx tsx scripts/copier/latencyProbe.ts --env demo --samples 50
 */
import { performance } from 'node:perf_hooks';
import { connect as tlsConnect } from 'node:tls';
import { lookup } from 'node:dns/promises';
import { TRADOVATE_HOSTS } from '../../services/tradovateMapping';

type Env = 'demo' | 'live';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const env = (flag('env', 'demo') === 'live' ? 'live' : 'demo') as Env;
const samples = Math.max(5, Math.min(500, Number(flag('samples', '50')) || 50));
const restUrl = new URL(TRADOVATE_HOSTS[env].rest);
const wsUrl = TRADOVATE_HOSTS[env].websocket;
const token = process.env.TRADOVATE_ACCESS_TOKEN?.trim();

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return Number.NaN;
  const pos = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, pos)];
};

const summarize = (label: string, values: number[]): void => {
  const ok = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  const failed = values.length - ok.length;
  if (ok.length === 0) {
    console.log(`${label.padEnd(28)} VŠECH ${values.length} MĚŘENÍ SELHALO`);
    return;
  }
  const fmt = (value: number) => `${value.toFixed(1)} ms`.padStart(10);
  console.log(
    `${label.padEnd(28)} p50 ${fmt(quantile(ok, 0.5))}  p95 ${fmt(quantile(ok, 0.95))}`
    + `  p99 ${fmt(quantile(ok, 0.99))}  min ${fmt(ok[0])}  max ${fmt(ok[ok.length - 1])}`
    + (failed > 0 ? `  (${failed} selhání)` : ''),
  );
};

async function measureTlsHandshake(): Promise<number> {
  const start = performance.now();
  return new Promise<number>((resolve) => {
    const socket = tlsConnect({ host: restUrl.hostname, port: 443, servername: restUrl.hostname }, () => {
      const elapsed = performance.now() - start;
      socket.end();
      resolve(elapsed);
    });
    socket.setTimeout(10_000, () => { socket.destroy(); resolve(Number.NaN); });
    socket.on('error', () => resolve(Number.NaN));
  });
}

async function measureRest(path: string, headers: Record<string, string>): Promise<number> {
  const start = performance.now();
  try {
    const response = await fetch(`${TRADOVATE_HOSTS[env].rest}${path}`, {
      headers, signal: AbortSignal.timeout(10_000),
    });
    // Tělo se musí dočíst, jinak se měří jen hlavičky.
    await response.arrayBuffer();
    return performance.now() - start;
  } catch {
    return Number.NaN;
  }
}

async function measureWsConnect(): Promise<number> {
  // Nativní WebSocket (Node >= 21). Tradovate po otevření posílá `o` frame —
  // teprve ten znamená živý stream, samotné `open` nestačí.
  const start = performance.now();
  return new Promise<number>((resolve) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => { socket.close(); resolve(Number.NaN); }, 10_000);
    socket.addEventListener('message', () => {
      clearTimeout(timer);
      socket.close();
      resolve(performance.now() - start);
    }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); resolve(Number.NaN); }, { once: true });
  });
}

async function series(count: number, fn: () => Promise<number>): Promise<number[]> {
  const results: number[] = [];
  for (let index = 0; index < count; index += 1) {
    results.push(await fn());
    // Malý rozestup, aby se neměřil vlastní backpressure.
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return results;
}

async function main(): Promise<void> {
  console.log(`Tradovate latency probe — env=${env}, host=${restUrl.hostname}, samples=${samples}`);
  console.log(`token: ${token ? 'ANO (autentizované REST měření)' : 'NE (jen neautentizované RTT)'}`);

  const dnsStart = performance.now();
  const address = await lookup(restUrl.hostname);
  console.log(`DNS: ${address.address} za ${(performance.now() - dnsStart).toFixed(1)} ms\n`);

  summarize('TLS handshake', await series(samples, measureTlsHandshake));
  summarize('REST RTT (bez auth)', await series(samples, () => measureRest('/contract/deps', {})));
  if (token) {
    summarize('REST /account/list (auth)', await series(samples, () =>
      measureRest('/account/list', { Authorization: `Bearer ${token}` })));
  }
  summarize('WS connect -> první frame', await series(Math.min(samples, 20), measureWsConnect));

  console.log('\nPorovnej p95/p99 mezi regiony; vyhrává stabilita, ne nejhezčí p50.');
}

void main();
