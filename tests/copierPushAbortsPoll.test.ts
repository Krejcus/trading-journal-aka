import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startMacCopierCommandRelay } from '../server/macCopierCommandRelay';
import type { RelayDelivery } from '../server/copierRelayDeliveryStore';
import { copierCommandPushGrant, signCopierCommandPush } from '../server/copierCommandPush';

// F1b′ (2. 11. odpoledne): ověřený push pro aktuální nečinnou delivery přeruší běžící poll
// (jinak by příkaz čekal na jeho RTT); podvrh ani push pro cizí delivery poll nepřeruší.
const DEVICE = '0b9d1c64-1f0a-4c55-9d21-6a3f7e2b8c11';
const SECRET = 'y'.repeat(48);
const grant = copierCommandPushGrant(DEVICE, SECRET)!;
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

const setup = () => {
  let saved: RelayDelivery | null = null;
  let hangNext = false;
  let pollAborted = 0;
  const polls: string[] = [];
  const acks: string[] = [];
  const execute = vi.fn(async () => ({ ok: true }) as never);
  let onPush: ((payload: unknown) => void) | null = null;
  let kick: (() => void) | null = null;
  const fetchImpl = (async (_url: unknown, init: { body: string; signal?: AbortSignal }) => {
    const body = JSON.parse(init.body) as { action: string; deliveryId?: string; commandId?: string };
    if (body.action === 'poll-v2') {
      polls.push(body.deliveryId!);
      if (hangNext) {
        hangNext = false;
        return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => { pollAborted += 1; reject(init.signal!.reason); }, { once: true }));
      }
      return { ok: true, json: async () => ({ protocol: 2, command: null, serverNow: new Date().toISOString(), realtime: {
        url: 'https://example.supabase.co', anonKey: 'anon', topic: 'copier-kick-d1',
        pushTopic: grant.topic, pushKey: grant.publicKey, pushDeviceId: DEVICE,
      } }) };
    }
    if (body.action === 'complete-v2') acks.push(body.commandId!);
    return { ok: true, json: async () => ({ protocol: 2, accepted: true }) };
  }) as unknown as typeof fetch;
  const relay = startMacCopierCommandRelay({
    apiOrigin: 'https://example.test',
    authorizationHeader: async () => 'Device x',
    agent: { status: () => ({ startedAt: new Date(0).toISOString() }) as never, execute, origin: '', beginShutdown: vi.fn(), close: async () => undefined },
    fetchImpl,
    pollMs: 60_000,
    deliveryStore: { read: async () => saved && structuredClone(saved), write: async value => { saved = value && structuredClone(value); } },
    createKickSubscription: (_config, onKick) => { kick = onKick; return () => undefined; },
    createPushSubscription: (_config, onMessage) => { onPush = onMessage; return () => undefined; },
  });
  const row = () => ({ id: randomUUID(), status: 'claimed', command: { type: 'reconcile' },
    createdAt: new Date(Date.now() + 5).toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() });
  return {
    relay, execute, polls, acks,
    get saved() { return saved; },
    get pollAborted() { return pollAborted; },
    hang: () => { hangNext = true; kick?.(); },
    push: (payload: unknown) => onPush?.(payload),
    signed: (deliveryId: string) => signCopierCommandPush({ deviceId: DEVICE, deliveryId, command: row() }, SECRET),
  };
};

afterEach(() => { vi.restoreAllMocks(); });

describe('F1b′: ověřený push přeruší běžící poll', () => {
  it('push pro aktuální nečinnou delivery: poll se přeruší, příkaz se provede jednou', async () => {
    const h = setup();
    await tick(50);
    const idle = h.saved!.deliveryId;
    h.hang();
    await tick();
    h.push(h.signed(idle));
    await tick(80);
    expect(h.pollAborted).toBe(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.acks).toHaveLength(1);
    await h.relay.close();
  });

  it('podvržený push (cizí podpis) ani push pro jinou delivery poll nepřeruší', async () => {
    const h = setup();
    await tick(50);
    const idle = h.saved!.deliveryId;
    h.hang();
    await tick();
    const genuine = h.signed(idle)!;
    h.push({ ...genuine, sig: genuine.sig.replace(/^./, genuine.sig[0] === 'A' ? 'B' : 'A') });
    h.push(h.signed(randomUUID()));
    await tick(80);
    expect(h.pollAborted).toBe(0);
    expect(h.execute).not.toHaveBeenCalled();
    await h.relay.close();
  });

  it('přehrávaný pravý push přeruší poll nejvýš jednou — další poll doběhne (útok s tématem)', async () => {
    const h = setup();
    await tick(50);
    const idle = h.saved!.deliveryId;
    const replayed = h.signed(idle);
    // Zastaralý vzorek hodin: push se nepoužije, schránka propadne do pollu.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    h.hang();
    await tick();
    h.push(replayed);
    await tick(40);
    expect(h.pollAborted).toBe(1);
    h.hang();
    await tick();
    h.push(replayed);
    await tick(40);
    expect(h.pollAborted).toBe(1);
    await h.relay.close();
  });
});
