import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';

const samples = Number(process.argv[2] ?? 40);
if (!Number.isInteger(samples) || samples < 5 || samples > 500) {
  throw new Error('Sample count must be an integer between 5 and 500.');
}

const day = Date.UTC(2026, 8, 22) / 1000;
const candles = Array.from({ length: 1440 }, (_, index) => {
  const price = 24500 + Math.sin(index / 27) * 80 + index / 22;
  return {
    time: day + index * 60,
    open: price,
    high: price + 2.25,
    low: price - 1.75,
    close: price + Math.sin(index / 4) * 1.5,
    volume: 100 + (index * 73) % 1800,
  };
});
const body = JSON.stringify({ schema: 'ohlcv-1m', symbol: 'MNQ.v.0', start: '2026-09-22T00:00:00.000Z', candles });
const compressed = gzipSync(body, { level: 6 });
const directory = await mkdtemp(join(tmpdir(), 'alphatrade-candle-bench-'));
const objectPath = join(directory, 'one-day.json.gz');
await writeFile(objectPath, compressed);

const server = createServer(async (_request, response) => {
  try {
    const bytes = await readFile(objectPath);
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'cache-control': 'private, max-age=3600' });
    response.end(bytes);
  } catch {
    response.writeHead(500);
    response.end();
  }
});

const percentile = (numbers, share) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * share) - 1)].toFixed(2);
};

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Benchmark server did not bind a TCP port.');
  const url = `http://127.0.0.1:${address.port}/one-day.json.gz`;
  const roundTrips = [];
  const parseTimes = [];
  for (let index = 0; index < samples + 1; index += 1) {
    const started = performance.now();
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Local storage prototype returned ${response.status}.`);
    const raw = await response.text();
    const fetched = performance.now();
    const parsed = JSON.parse(raw);
    const finished = performance.now();
    if (parsed.candles.length !== 1440) throw new Error('Prototype data was truncated.');
    if (index === 0) continue; // warm up the local HTTP stack
    roundTrips.push(fetched - started);
    parseTimes.push(finished - fetched);
  }
  console.log(JSON.stringify({
    kind: 'local-loopback-prototype-not-supabase',
    records: candles.length,
    jsonBytes: Buffer.byteLength(body),
    gzipBytes: compressed.byteLength,
    samples,
    readAndTransferMs: { p50: percentile(roundTrips, 0.5), p95: percentile(roundTrips, 0.95) },
    parseMs: { p50: percentile(parseTimes, 0.5), p95: percentile(parseTimes, 0.95) },
  }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
