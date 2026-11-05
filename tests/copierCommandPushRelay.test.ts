import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { copierKickWaitsForPush, pushBoundCopierCommand, scheduleCopierKickAfterPush } from '../server/copierCommandPushRelay';
import { copierCommandPushGrant, signCopierCommandPush, verifyCopierCommandPush } from '../server/copierCommandPush';
import { TV_PRICE_CHANNEL_SECRET_ENV } from '../server/tvPriceChannel';

// F1b′ server: navázání + podepsaný push nikdy nevyhodí, každý krok ≤ limit, nic nepošle
// bez čerstvého runtime a nikdy nepošle hotový řádek.
const DEVICE = '0b9d1c64-1f0a-4c55-9d21-6a3f7e2b8c11';
const DELIVERY = '6f1d2c3b-4a5e-4f60-8a71-b2c3d4e5f607';
const SECRET = 'x'.repeat(48);
const NOW = Date.parse('2026-11-02T08:00:00.000Z');

const abortable = <T>(value: () => Promise<T>) => ({
  abortSignal(signal: AbortSignal) {
    return new Promise<T>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      value().then(resolve, reject);
    });
  },
});

const fakeDb = (options: { lastSeenAgoMs?: number; idle?: unknown; claim?: () => Promise<unknown> }) => {
  const rpc = vi.fn((_name: string, _args: unknown) => abortable(options.claim ?? (async () => ({ data: [], error: null }))));
  const db = {
    from: () => ({ select: () => ({ eq: () => ({ abortSignal: () => ({ maybeSingle: async () => ({
      data: { relay_idle: options.idle === undefined ? { deliveryId: DELIVERY } : options.idle,
        last_seen_at: new Date(NOW - (options.lastSeenAgoMs ?? 500)).toISOString() }, error: null,
    }) }) }) }) }),
    rpc,
  } as unknown as SupabaseClient;
  return { db, rpc };
};
const row = (status: string) => ({ data: [{ id: 'cmd-1', status, created_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 30_000).toISOString(),
  command_type: 'disarm', payload: {} }], error: null });

afterEach(() => { delete process.env[TV_PRICE_CHANNEL_SECRET_ENV]; });

describe('F1b′ server: pushBoundCopierCommand', () => {
  it('zavěšený claim_v2 → do limitu kroku vrátí failed, nevyhodí, nic nepošle', async () => {
    process.env[TV_PRICE_CHANNEL_SECRET_ENV] = SECRET;
    const { db } = fakeDb({ claim: () => new Promise(() => undefined) });
    const fetchImpl = vi.fn();
    const started = Date.now();
    const outcome = await pushBoundCopierCommand({ db, deviceId: DEVICE, supabaseUrl: 'https://s', serviceRoleKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW, stepTimeoutMs: 150 });
    expect(outcome).toBe('failed');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bez tajemství nic (žádné čtení ani claim)', async () => {
    const { db, rpc } = fakeDb({});
    expect(await pushBoundCopierCommand({ db, deviceId: DEVICE, supabaseUrl: 'https://s', serviceRoleKey: 'k', now: () => NOW })).toBe('no-grant');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('nečerstvý runtime (> 4 s) ani chybějící relayIdle se neváže', async () => {
    process.env[TV_PRICE_CHANNEL_SECRET_ENV] = SECRET;
    const stale = fakeDb({ lastSeenAgoMs: 5_000 });
    expect(await pushBoundCopierCommand({ db: stale.db, deviceId: DEVICE, supabaseUrl: 'https://s', serviceRoleKey: 'k', now: () => NOW })).toBe('stale');
    expect(stale.rpc).not.toHaveBeenCalled();
    const none = fakeDb({ idle: null });
    expect(await pushBoundCopierCommand({ db: none.db, deviceId: DEVICE, supabaseUrl: 'https://s', serviceRoleKey: 'k', now: () => NOW })).toBe('no-idle');
  });

  it('hotový vázaný řádek (relayIdle před rotací) se neposílá', async () => {
    process.env[TV_PRICE_CHANNEL_SECRET_ENV] = SECRET;
    const { db } = fakeDb({ claim: async () => row('succeeded') });
    const fetchImpl = vi.fn();
    expect(await pushBoundCopierCommand({ db, deviceId: DEVICE, supabaseUrl: 'https://s', serviceRoleKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW })).toBe('not-claimed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('navázaný řádek pošle podepsaný na téma zařízení; worker ho ověří jen veřejným klíčem', async () => {
    process.env[TV_PRICE_CHANNEL_SECRET_ENV] = SECRET;
    const { db, rpc } = fakeDb({ claim: async () => row('claimed') });
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 202 }));
    expect(await pushBoundCopierCommand({ db, deviceId: DEVICE, supabaseUrl: 'https://s', serviceRoleKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW })).toBe('pushed');
    expect(rpc).toHaveBeenCalledWith('claim_tradovate_copier_command_v2', { target_device_id: DEVICE, target_delivery_id: DELIVERY });
    const sent = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).messages[0];
    const grant = copierCommandPushGrant(DEVICE, SECRET)!;
    expect(sent.topic).toBe(grant.topic);
    expect(sent.event).toBe('cmd');
    const verified = verifyCopierCommandPush(sent.payload, grant.publicKey, DEVICE)!;
    expect(verified.deliveryId).toBe(DELIVERY);
    expect(verified.command).toMatchObject({ id: 'cmd-1', status: 'claimed', command: { type: 'disarm' } });
    // Pozměněné tělo / cizí zařízení = zahodit.
    expect(verifyCopierCommandPush({ ...sent.payload, body: sent.payload.body.replace('cmd-1', 'cmd-2') }, grant.publicKey, DEVICE)).toBeNull();
    expect(verifyCopierCommandPush(sent.payload, grant.publicKey, '11111111-1111-4111-8111-111111111111')).toBeNull();
  });

  it('preclaim z admission v2 přeskočí runtime read i claim RPC a jen podepíše+broadcastuje', async () => {
    process.env[TV_PRICE_CHANNEL_SECRET_ENV] = SECRET;
    const { db, rpc } = fakeDb({ claim: async () => { throw new Error('claim-must-not-run'); } });
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 202 }));
    const outcome = await pushBoundCopierCommand({
      db,
      deviceId: DEVICE,
      supabaseUrl: 'https://s',
      serviceRoleKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      preclaimed: {
        deliveryId: DELIVERY,
        command: {
          id: 'cmd-fast',
          status: 'claimed',
          command: { type: 'disarm' },
          createdAt: new Date(NOW).toISOString(),
          expiresAt: new Date(NOW + 30_000).toISOString(),
        },
      },
    });
    expect(outcome).toBe('pushed');
    expect(rpc).not.toHaveBeenCalled();
    const sent = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).messages[0];
    const verified = verifyCopierCommandPush(sent.payload, copierCommandPushGrant(DEVICE, SECRET)!.publicKey, DEVICE)!;
    expect(verified.deliveryId).toBe(DELIVERY);
    expect(verified.command).toMatchObject({ id: 'cmd-fast', status: 'claimed' });
  });
});

describe('F1b′ server: kick po pokusu o push (oponentura P2)', () => {
  const timeline = () => {
    const events: string[] = [];
    let t = 0;
    const sleep = async (ms: number) => { t += ms; events.push(`sleep ${ms}`); };
    return { events, sleep, sendKick: async () => { events.push(`kick @${t}`); }, now: () => t };
  };

  it('jen vstup, náhled a posun SL/TP čekají na push; brzdy, ARM, Flatten a risk-redukční správa ne', () => {
    const copy = (inner: object) => ({ type: 'copy-command', command: inner });
    expect(copierKickWaitsForPush(copy({ type: 'place-leader-entry' }))).toBe(true);
    expect(copierKickWaitsForPush(copy({ type: 'preview-leader-entry' }))).toBe(true);
    expect(copierKickWaitsForPush(copy({ type: 'manage-leader-order', action: 'move-stop' }))).toBe(true);
    for (const action of ['close-position', 'cancel-entry', 'attach-brackets']) {
      expect(copierKickWaitsForPush(copy({ type: 'manage-leader-order', action }))).toBe(false);
    }
    expect(copierKickWaitsForPush(copy({ type: 'flatten-group' }))).toBe(false);
    expect(copierKickWaitsForPush({ type: 'disarm' })).toBe(false);
    expect(copierKickWaitsForPush({ type: 'kill-switch' })).toBe(false);
    expect(copierKickWaitsForPush({ type: 'arm-live' })).toBe(false);
  });

  it('push vyšel → záložní kick o 250 ms později', async () => {
    const tl = timeline();
    expect(await scheduleCopierKickAfterPush({ push: Promise.resolve('pushed'), sendKick: tl.sendKick, settled: () => false, sleep: tl.sleep })).toBe('sent');
    expect(tl.events.at(-1)).toBe('kick @650');
    expect(tl.events).toContain('sleep 250');
  });

  it('push selhal → kick hned (bez +250 ms)', async () => {
    const sent: string[] = [];
    const result = await scheduleCopierKickAfterPush({ push: Promise.resolve('stale'), sendKick: async () => { sent.push('kick'); },
      settled: () => false, sleep: () => new Promise(() => undefined) });
    expect(result).toBe('sent');
    expect(sent).toEqual(['kick']);
  });

  it('push visí → kick nejpozději po 400 ms', async () => {
    const tl = timeline();
    expect(await scheduleCopierKickAfterPush({ push: new Promise(() => undefined), sendKick: tl.sendKick, settled: () => false, sleep: tl.sleep })).toBe('sent');
    expect(tl.events).toEqual(['sleep 400', 'kick @400']);
  });

  it('výsledek už je → záložní kick se neposílá', async () => {
    const tl = timeline();
    expect(await scheduleCopierKickAfterPush({ push: Promise.resolve('pushed'), sendKick: tl.sendKick, settled: () => true, sleep: tl.sleep })).toBe('skipped');
    expect(tl.events.some(event => event.startsWith('kick'))).toBe(false);
  });
});

describe('F1b′ server: předčtení relayIdle souběžně s admission', () => {
  it('shoda zařízení → bez druhého čtení; jiné zařízení → čte se podle device_id', async () => {
    process.env[TV_PRICE_CHANNEL_SECRET_ENV] = SECRET;
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 202 }));
    const from = vi.fn();
    const base = fakeDb({ claim: async () => row('claimed') });
    const db = { ...base.db, from: (...args: unknown[]) => { from(...args); return (base.db as unknown as { from: (...a: unknown[]) => unknown }).from(...args); } } as unknown as SupabaseClient;
    const fresh = { deviceId: DEVICE.toUpperCase(), relayIdle: { deliveryId: DELIVERY }, lastSeenAt: new Date(NOW - 300).toISOString() };
    expect(await pushBoundCopierCommand({ db, deviceId: DEVICE, supabaseUrl: 'https://s', serviceRoleKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW, prefetched: Promise.resolve(fresh) })).toBe('pushed');
    expect(from).not.toHaveBeenCalled();
    expect(await pushBoundCopierCommand({ db, deviceId: DEVICE, supabaseUrl: 'https://s', serviceRoleKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW,
      prefetched: Promise.resolve({ ...fresh, deviceId: '11111111-1111-4111-8111-111111111111' }) })).toBe('pushed');
    expect(from).toHaveBeenCalledTimes(1);
  });
});

describe('F1b′: vlastní tajemství podpisu pushů (volitelné)', () => {
  afterEach(() => { delete process.env.COPIER_PUSH_SIGNING_SECRET; });
  it('bez vlastního tajemství platí sdílené; s ním jiné téma i klíč a starý veřejný klíč podpis neověří', () => {
    process.env[TV_PRICE_CHANNEL_SECRET_ENV] = SECRET;
    const shared = copierCommandPushGrant(DEVICE)!;
    expect(shared).toEqual(copierCommandPushGrant(DEVICE, SECRET));
    process.env.COPIER_PUSH_SIGNING_SECRET = 'z'.repeat(48);
    const own = copierCommandPushGrant(DEVICE)!;
    expect(own.topic).not.toBe(shared.topic);
    expect(own.publicKey).not.toBe(shared.publicKey);
    const message = signCopierCommandPush({ deviceId: DEVICE, deliveryId: DELIVERY, command: { id: 'c' } })!;
    expect(verifyCopierCommandPush(message, own.publicKey, DEVICE)).not.toBeNull();
    expect(verifyCopierCommandPush(message, shared.publicKey, DEVICE)).toBeNull();
  });
  it('krátké vlastní tajemství (< 32) se ignoruje — zůstává sdílené', () => {
    process.env[TV_PRICE_CHANNEL_SECRET_ENV] = SECRET;
    process.env.COPIER_PUSH_SIGNING_SECRET = 'short';
    expect(copierCommandPushGrant(DEVICE)).toEqual(copierCommandPushGrant(DEVICE, SECRET));
  });
});
