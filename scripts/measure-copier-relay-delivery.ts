/** Offline latency/fault benchmark. Real relay + real durable checkpoint;
 * simulated HTTP/server and execution. Never accesses broker or credentials. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startMacCopierCommandRelay } from '../server/macCopierCommandRelay';
import { fileRelayDeliveryStore } from '../server/copierRelayDeliveryStore';
import type { LocalCopierExecutionAgent } from '../server/localCopierExecutionAgent';
const pause = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal?.reason); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
});
async function measure(mode: 'normal' | 'slow-background' | 'lost-claim' | 'lost-ack') {
  const directory = await mkdtemp(join(tmpdir(), 'relay-latency-'));
  const start = performance.now();
  let executions = 0, polls = 0, completions = 0, statusReads = 0, done = false;
  let deliveryId: string | null = null;
  let executedMs: number | null = null;
  let acknowledgedMs: number | null = null;
  const command = { id: randomUUID(), command: { type: 'disarm' }, status: 'claimed',
    createdAt: new Date(Date.now() + 2).toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() };
  const agent = { status: () => ({ startedAt: new Date().toISOString() }), execute: async () => {
    executions++; executedMs = performance.now() - start; await pause(15); return { ok: true };
  } } as unknown as LocalCopierExecutionAgent;
  const relay = startMacCopierCommandRelay({ apiOrigin: 'https://offline.invalid', authorizationHeader: async () => 'fictional', agent,
    deliveryStore: fileRelayDeliveryStore(join(directory, 'delivery.json')), pollMs: 500,
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      await pause(60, init?.signal); // Explicit artificial RTT; not a production measurement.
      if (body.action === 'heartbeat-v2') { statusReads++; return Response.json({ protocol: 2, accepted: true }); }
      if (body.action === 'background-v2') {
        if (mode === 'slow-background') await pause(11_000, init?.signal);
        return Response.json({ protocol: 2, snapshotRequests: [] });
      }
      if (body.action === 'poll-v2') {
        polls++;
        if (done) return Response.json({ protocol: 2, command: null });
        if (deliveryId && body.deliveryId !== deliveryId) throw new Error('delivery ID changed before ACK');
        if (!deliveryId) command.createdAt = new Date().toISOString();
        deliveryId = body.deliveryId;
        if (mode === 'lost-claim' && polls === 1) await pause(11_000, init?.signal);
        if (command.status === 'succeeded') { done = true; acknowledgedMs = performance.now() - start; }
        return Response.json({ protocol: 2, command });
      }
      if (body.action === 'complete-v2') {
        completions++; command.status = 'succeeded';
        if (mode === 'lost-ack' && completions === 1) await pause(11_000, init?.signal);
        done = true; acknowledgedMs = performance.now() - start;
        return Response.json({ protocol: 2, accepted: true });
      }
      throw new Error('unexpected operation');
    }) as typeof fetch,
  });
  try {
    while (!done && performance.now() - start < 8_000) await pause(10);
    if (!done || executions !== 1) throw new Error(`${mode}: execution/delivery verification failed`);
    return { mode, executions, polls, completions, statusReads, executionMs: Math.round(executedMs!), confirmedMs: Math.round(acknowledgedMs!) };
  } finally { await relay.close(); await rm(directory, { recursive: true, force: true }); }
}
const samples = [];
for (let i = 0; i < 12; i++) samples.push(await measure('normal'));
const normal = samples.map(row => row.confirmedMs).sort((a, b) => a - b);
const faults = [];
for (const mode of ['slow-background', 'lost-claim', 'lost-ack'] as const) faults.push(await measure(mode));
console.log(JSON.stringify({ environment: 'offline simulation; 60ms artificial RTT + 15ms execution + real fsync',
  normal: { n: normal.length, medianMs: normal[Math.floor(normal.length / 2)], maxMs: normal.at(-1) }, faults }, null, 2));
