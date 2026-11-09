import { describe, expect, it, vi } from 'vitest';
import type { TradovateRequestControlRemote, TradovateRequestControlSnapshot, TradovateRequestGrant } from '../lib/tradovateRequestControl';
import { parseTradovateRequestPenalty } from '../lib/tradovateRequestControl';
import { createTradovateControlledFetch } from '../services/tradovateRequestControlFetch';
import {
  createTradovateRequestControlRegistry, createTradovateRequestGovernor,
  type TradovateRequestControlDurableState, type TradovateRequestControlStore,
} from '../services/tradovateRequestControlGovernor';

function fixture() {
  let wall = 1_000_000, mono = 100;
  let onWait: (() => Promise<void>) | null = null;
  let snapshot: TradovateRequestControlSnapshot = {
    version: 1, brokerUserId: 71000000, serverNow: wall, epoch: 0, blockedUntil: null,
    captchaRequired: false, evidence: null, reason: null,
    backgroundReservedHour: 0, backgroundReservedMinute: 0,
    policyVersion: 2, riskReservedHour: 0, riskReservedMinute: 0, controlReservedHour: 0, controlReservedMinute: 0, totalReservedHour: 0,
  };
  const grants = new Map<string, TradovateRequestGrant>();
  const remote: TradovateRequestControlRemote = {
    read: vi.fn(async () => ({ ...snapshot, serverNow: wall })),
    reserve: vi.fn(async input => {
      if (snapshot.captchaRequired || (snapshot.blockedUntil ?? 0) > wall) throw new Error('remote cooldown');
      if (snapshot.backgroundReservedMinute + input.units > 120) throw new Error('remote budget');
      if (grants.has(input.grantId)) throw new Error('client reused grant id');
      snapshot = { ...snapshot, backgroundReservedHour: snapshot.backgroundReservedHour + input.units,
        backgroundReservedMinute: snapshot.backgroundReservedMinute + input.units };
      const grant: TradovateRequestGrant = { version: 1, grantId: input.grantId, brokerUserId: snapshot.brokerUserId,
        purpose: input.purpose, units: input.units, serverNow: wall, validUntil: wall + input.ttlMs, epoch: snapshot.epoch };
      grants.set(input.grantId, grant);
      return grant;
    }),
    penalize: vi.fn(async penalty => {
      snapshot = { ...snapshot, epoch: snapshot.epoch + 1, blockedUntil: Math.max(snapshot.blockedUntil ?? 0, wall + penalty.retryAfterMs),
        captchaRequired: snapshot.captchaRequired || penalty.captchaRequired === true,
        evidence: penalty.evidence, reason: penalty.reason };
      return { ...snapshot, serverNow: wall };
    }),
  };
  const persisted = new Map<number, TradovateRequestControlDurableState>();
  const store: TradovateRequestControlStore = {
    load: vi.fn(async id => persisted.has(id) ? { ...persisted.get(id)! } : null),
    save: vi.fn(async value => { persisted.set(value.brokerUserId, { ...value }); }),
  };
  let sequence = 0;
  const make = () => createTradovateRequestGovernor({
    brokerUserId: snapshot.brokerUserId, remote, store, clock: () => wall, monotonic: () => mono,
    wait: async ms => { await onWait?.(); wall += ms; mono += ms; },
    uuid: () => `test-grant-${++sequence}`,
  });
  return { remote, store, make, persisted, grants,
    onBackgroundWait(action: () => Promise<void>) { onWait = action; },
    advance(ms: number) { wall += ms; mono += ms; },
    wallJump(ms: number) { wall += ms; },
    setSnapshot(patch: Partial<TradovateRequestControlSnapshot>) { snapshot = { ...snapshot, ...patch }; },
  };
}

describe('shared worker request governor', () => {
  it('reuses a broker principal across token, account and route adapters', () => {
    const f = fixture(), registry = createTradovateRequestControlRegistry();
    const first = registry.get(71000000, f.make);
    const second = registry.get(71000000, () => { throw new Error('must not allocate another quota'); });
    expect(first).toBe(second);
    expect(registry.values()).toEqual([first]);
  });

  it('allows accepted lifecycle writes at a soft limit while blocking new risk and background reads', async () => {
    const f = fixture();
    f.setSnapshot({ backgroundReservedHour: 3000, backgroundReservedMinute: 120 });
    const governor = f.make(); await governor.initialize();
    expect(governor.newRiskBlocker()).toBeTruthy();
    await expect(governor.prepare('background')).rejects.toMatchObject({ beforeDispatch: true, controlReason: 'budget' });
    for (let follower = 0; follower < 8; follower++) governor.dispatch('entry')();
    governor.dispatch('management')();
    expect(governor.health()).toMatchObject({ state: 'budget-limited', counts: { dispatchAttempts: 9, blockedBeforeDispatch: 1 } });
    expect(f.remote.reserve).not.toHaveBeenCalled();
  });

  it('consumes each short grant once and never reclaims unused credits after restart', async () => {
    const f = fixture(), first = f.make(); await first.initialize();
    const permit = await first.prepare('background');
    first.dispatch('background', permit)();
    expect(() => first.dispatch('background', permit)).toThrow('permit');
    const restarted = f.make(); await restarted.initialize();
    const next = await restarted.prepare('background'); restarted.dispatch('background', next)();
    expect(f.grants.size).toBe(2);
    expect([...f.grants.values()].reduce((sum, grant) => sum + grant.units, 0)).toBe(2);
  });

  it('six simultaneous background reads can reserve a second pool without false exhaustion', async () => {
    const f = fixture(), governor = f.make(); await governor.initialize();
    const permits = await Promise.all(Array.from({ length: 6 }, () => governor.prepare('background')));
    const releases = permits.map(permit => governor.dispatch('background', permit));
    releases.forEach(release => release());
    expect([...f.grants.values()].reduce((n,g) => n + g.units, 0)).toBe(6);
    expect(governor.health().counts).toMatchObject({ dispatchAttempts: 6, blockedBeforeDispatch: 0 });
  });

  it('a background capacity wait never queues accepted management and rechecks a newly observed penalty', async () => {
    const f = fixture(), governor = f.make(); await governor.initialize();
    for (let i = 0; i < 8; i++) await governor.prepare('background');
    governor.dispatch('management')();
    f.onBackgroundWait(async () => { await governor.penalize(parseTradovateRequestPenalty(429, null)!); });
    await expect(governor.prepare('background')).rejects.toMatchObject({ beforeDispatch: true, controlReason: 'cooldown' });
    expect(governor.health().counts.dispatchAttempts).toBe(1);
    expect(() => governor.dispatch('management')).toThrow();
  });

  it('an abandoned prepared batch cannot create an unbounded background wait or dispatch after its deadline', async () => {
    const f = fixture(), governor = f.make(); await governor.initialize();
    const permits = await Promise.all(Array.from({ length: 8 }, () => governor.prepare('background')));
    await expect(governor.prepare('background')).rejects.toMatchObject({ beforeDispatch: true });
    expect(governor.health().counts.dispatchAttempts).toBe(0);
    expect(() => governor.dispatch('background', permits[0])).toThrow();
  });

  it('drops a permit that expires during an awaited token or scheduler step', async () => {
    const f = fixture(), governor = f.make(); await governor.initialize();
    const permit = await governor.prepare('background');
    f.advance(5100); await governor.sync();
    expect(() => governor.dispatch('background', permit)).toThrow();
    expect(governor.health().counts.dispatchAttempts).toBe(0);
  });

  it('a penalty arriving after prepare stops the final dispatch, including management', async () => {
    const f = fixture(), governor = f.make(); await governor.initialize();
    const permit = await governor.prepare('background');
    await governor.penalize(parseTradovateRequestPenalty(429, null)!);
    expect(() => governor.dispatch('background', permit)).toThrow();
    expect(() => governor.dispatch('management')).toThrow();
    expect(governor.health()).toMatchObject({ state: 'cooldown', evidence: 'raw-429', counts: { dispatchAttempts: 0 } });
  });

  it('shares a cooldown across independent contexts after control sync without inventing atomic propagation', async () => {
    const f = fixture(), first = f.make(), second = f.make();
    await first.initialize(); await second.initialize();
    await first.penalize(parseTradovateRequestPenalty(429, null)!);
    // The second process has not yet received the authority update.
    expect(second.health().state).toBe('ready');
    await second.sync();
    expect(() => second.dispatch('management')).toThrow();
    expect(second.health().state).toBe('cooldown');
  });

  it('remote roundtrip cannot shorten an explicit cooldown', async () => {
    const f = fixture();
    f.setSnapshot({ blockedUntil: 1_010_000, evidence: 'p-time', reason: 'explicit delay' });
    const read = f.remote.read;
    f.remote.read = async () => { const state = await read(); f.advance(500); return state; };
    const governor = f.make(); await governor.initialize();
    f.advance(9500);
    expect(() => governor.dispatch('management')).toThrow();
    f.advance(501);
    expect(() => governor.dispatch('management')()).not.toThrow();
  });

  it.each([
    { grantId: 'other-grant' }, { epoch: -1 }, { units: 0 },
    { validUntil: 999_999 }, { purpose: 'management' },
  ])('rejects a malformed or unrelated remote grant %j before dispatch', async patch => {
    const f = fixture(), reserve = f.remote.reserve;
    f.remote.reserve = async input => ({ ...await reserve(input), ...patch }) as TradovateRequestGrant;
    const governor = f.make(); await governor.initialize();
    await expect(governor.prepare('background')).rejects.toThrow();
    expect(governor.health().counts.dispatchAttempts).toBe(0);
  });

  it('stale control blocks new risk/background but does not introduce an accepted-management queue', async () => {
    const f = fixture(), governor = f.make(); await governor.initialize(); f.advance(5001);
    expect(governor.health().state).toBe('unavailable');
    expect(governor.newRiskBlocker()).toBeTruthy();
    await expect(governor.prepare('risk')).rejects.toMatchObject({ beforeDispatch: true });
    governor.dispatch('management')();
    expect(governor.health().counts.dispatchAttempts).toBe(1);
  });

  it('a wall clock jump cannot expire a running cooldown; restart restores the durable stop', async () => {
    const f = fixture(), governor = f.make(); await governor.initialize();
    await governor.penalize(parseTradovateRequestPenalty(429, null)!);
    f.wallJump(86_400_000);
    expect(() => governor.dispatch('management')).toThrow();
    f.wallJump(-86_400_000);
    const restarted = f.make(); await restarted.initialize();
    expect(() => restarted.dispatch('management')).toThrow();
    expect(f.persisted.get(71000000)?.remainingMs).toBeGreaterThan(0);
  });

  it('an unpublished local penalty survives a forward clock jump followed by restart', async () => {
    const f = fixture(), governor = f.make(); await governor.initialize();
    f.remote.penalize = async () => { throw new Error('DB publication unavailable'); };
    await governor.penalize(parseTradovateRequestPenalty(429, null)!);
    f.wallJump(86_400_000);
    const restarted = f.make(); await restarted.initialize();
    expect(() => restarted.dispatch('management')).toThrow();
    expect(restarted.health().state).toBe('cooldown');
  });

  it('expired remote timestamps do not create repeated persistence windows or block accepted writes', async () => {
    const f = fixture(); f.setSnapshot({ blockedUntil: 999_999, evidence: 'p-time' });
    const governor = f.make(); await governor.initialize();
    for (let i = 0; i < 3; i++) { f.advance(2000); await governor.sync(); governor.dispatch('management')(); }
    expect(f.store.save).not.toHaveBeenCalled();
    expect(governor.health().counts.dispatchAttempts).toBe(3);
  });

  it('a completed monotonic wait is durably cleared once and does not restart the old pause later', async () => {
    const f = fixture(), governor = f.make(); await governor.initialize();
    await governor.penalize(parseTradovateRequestPenalty(200, { 'p-ticket': 'p', 'p-time': 15 })!);
    f.advance(16_000); await governor.sync();
    expect(f.persisted.get(71000000)?.remainingMs).toBe(0);
    const saves = vi.mocked(f.store.save).mock.calls.length;
    f.advance(2000); await governor.sync();
    expect(vi.mocked(f.store.save).mock.calls.length).toBe(saves);
    const restarted = f.make(); await restarted.initialize();
    expect(() => restarted.dispatch('management')()).not.toThrow();
  });

  it('actual captcha remains terminal after its numeric duration and across restart', async () => {
    const f = fixture(), governor = f.make(); await governor.initialize();
    await governor.penalize(parseTradovateRequestPenalty(200, { 'p-ticket': 'p', 'p-time': 1, 'p-captcha': true })!);
    f.advance(7_200_000); await governor.sync();
    expect(governor.health().state).toBe('captcha');
    const restarted = f.make(); await restarted.initialize();
    expect(() => restarted.dispatch('management')).toThrow();
  });

  it('raw display HTTP429 stops all later physical requests and keeps blocked attempts separate', async () => {
    const f = fixture(), governor = f.make(); await governor.initialize();
    const upstream = vi.fn(async () => new Response('', { status: 429 }));
    const controlled = createTradovateControlledFetch(governor, upstream);
    expect((await controlled('https://example.invalid/cashBalance/deps')).status).toBe(429);
    await expect(controlled('https://example.invalid/other')).rejects.toMatchObject({ beforeDispatch: true });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(governor.health().counts).toMatchObject({ dispatchAttempts: 1, responses: 1, blockedBeforeDispatch: 1 });
  });

  it('does not turn an actual transport failure into a safe not-sent result', async () => {
    const f = fixture(), governor = f.make(); await governor.initialize();
    const networkError = new Error('connection lost after dispatch');
    const controlled = createTradovateControlledFetch(governor, async () => { throw networkError; }, 'management');
    await expect(controlled('https://example.invalid/order/placeorder')).rejects.toBe(networkError);
    expect(governor.health().counts).toMatchObject({ dispatchAttempts: 1, transportUnknown: 1 });
  });
  it('background exhaustion still admits bounded risk/recovery reads with purpose-bound permits',async()=>{
    const f=fixture();f.setSnapshot({backgroundReservedHour:1200,backgroundReservedMinute:40});const g=f.make();await g.initialize();
    for (const purpose of ['risk','control'] as const) {const permit=await g.prepare(purpose);expect(()=>g.dispatch('background',permit)).toThrow();g.dispatch(purpose,permit)();expect(()=>g.dispatch(purpose,permit)).toThrow();}
    expect(()=>g.dispatch('management')()).not.toThrow();expect(g.newRiskBlocker()).toBeTruthy();
  });
  it('a full recovery lane does not stop an otherwise available background lane',async()=>{
    const f=fixture();f.setSnapshot({controlReservedMinute:24});const g=f.make();await g.initialize();
    g.dispatch('background',await g.prepare('background'))();expect(g.newRiskBlocker()).toBeTruthy();
  });
  it('priority reservation expiry releases capacity rather than accumulating abandoned slots',async()=>{
    const f=fixture(),reserve=f.remote.reserve;f.remote.reserve=async input=>{const grant=await reserve(input);f.advance(5100);return grant;};
    const g=f.make();await g.initialize();for(let i=0;i<5;i++){await expect(g.prepare('control')).rejects.toThrow();await g.sync();}
    f.remote.reserve=reserve;const permit=await g.prepare('control');expect(()=>g.dispatch('control',permit)()).not.toThrow();
  });

});
