import { describe, expect, it, vi } from 'vitest';
import { createTradovateRequestControlRemote } from '../server/tradovateRequestControlRemote';
import { createTradovateRequestGovernor, type TradovateRequestControlDurableState } from '../services/tradovateRequestControlGovernor';
import { TradovateRemoteControlError, type TradovateRequestControlSnapshot } from '../lib/tradovateRequestControl';

const snapshot = (patch: Partial<TradovateRequestControlSnapshot> = {}): TradovateRequestControlSnapshot => ({
  version: 1, brokerUserId: 77, epoch: 0, serverNow: 100_000, blockedUntil: null,
  captchaRequired: false, evidence: null, reason: null, backgroundReservedHour: 0, backgroundReservedMinute: 0,
    policyVersion: 2, riskReservedHour: 0, riskReservedMinute: 0, controlReservedHour: 0, controlReservedMinute: 0, totalReservedHour: 0, ...patch,
});
const remoteFor = (wire: typeof fetch) => createTradovateRequestControlRemote({ apiOrigin: 'https://app.test',
  connectionId: 'own-connection', authorizationHeader: async () => 'Device test', fetchImpl: wire });

describe('request authority refusal is not a broker outage', () => {
  it.each([
    ['tradovate-request-budget', 'budget', { backgroundReservedHour: 3000 }],
    ['tradovate-request-cooldown', 'cooldown', { epoch: 1, blockedUntil: 160_000, evidence: 'p-time', reason: 'broker pause' }],
    ['tradovate-request-captcha', 'captcha', { epoch: 1, blockedUntil: 160_000, captchaRequired: true, evidence: 'captcha', reason: 'captcha' }],
  ] as const)('preserves %s and its authoritative snapshot from HTTP503', async (code, kind, patch) => {
    const state = snapshot(patch);
    const remote = remoteFor(vi.fn(async () => Response.json({ error: code, retryAfterMs: 60_000, snapshot: state }, { status: 503 })));
    await expect(remote.reserve({ grantId: 'grant', purpose: 'background', units: 1, ttlMs: 5000 }))
      .rejects.toMatchObject({ kind, code, snapshot: state, retryAfterMs: 60_000 });
  });

  it('does not trust a malformed penalty snapshot or HTML error as a fresh authority', async () => {
    const malformed = remoteFor(vi.fn(async () => Response.json({ error: 'tradovate-request-cooldown', snapshot: snapshot({ epoch: -1 }) }, { status: 503 })));
    await expect(malformed.read()).rejects.toMatchObject({ kind: 'cooldown', snapshot: undefined });
    const html = remoteFor(vi.fn(async () => new Response('gateway failure', { status: 503 })));
    await expect(html.read()).rejects.toMatchObject({ kind: 'unavailable', code: 'request-control-remote-503' });
  });

  it.each(['budget', 'cooldown', 'captcha'] as const)('applies %s before another local dispatch without waiting for periodic sync', async kind => {
    const initial = snapshot(), state = snapshot(kind === 'budget' ? { backgroundReservedMinute: 120 }
      : { epoch: 1, blockedUntil: 160_000, captchaRequired: kind === 'captcha', evidence: kind === 'captcha' ? 'captcha' : 'p-time', reason: kind });
    let saved: TradovateRequestControlDurableState | null = null;
    const governor = createTradovateRequestGovernor({ brokerUserId: 77, clock: () => 100_000, monotonic: () => 100,
      store: { load: async () => null, save: async value => { saved = value; } },
      remote: { read: async () => initial, reserve: async () => { throw new TradovateRemoteControlError('tradovate-request-' + kind, 60_000, state); }, penalize: vi.fn() } });
    await governor.initialize();
    await expect(governor.prepare('background')).rejects.toMatchObject({ controlReason: kind, beforeDispatch: true });
    expect(governor.health().state).toBe(kind === 'budget' ? 'budget-limited' : kind);
    expect(governor.newRiskBlocker()).toBeTruthy();
    if (kind === 'budget') { expect(() => governor.dispatch('management')()).not.toThrow(); expect(saved).toBeNull(); }
    else { expect(() => governor.dispatch('management')).toThrow(); expect(saved).toMatchObject({ brokerUserId: 77, blockedUntil: 160_000 }); }
  });

  it('does not refresh control age from the arrival time of a slow refusal', async () => {
    let mono = 0;
    const governor = createTradovateRequestGovernor({ brokerUserId: 77, clock: () => 100_000, monotonic: () => mono,
      store: { load: async () => null, save: vi.fn() }, remote: { read: async () => snapshot(),
        reserve: async () => { mono += 6000; throw new TradovateRemoteControlError('tradovate-request-budget', 60_000, snapshot({ backgroundReservedMinute: 120 })); }, penalize: vi.fn() } });
    await governor.initialize(); await expect(governor.prepare('background')).rejects.toBeDefined();
    expect(governor.health().state).toBe('unavailable');
  });
  it('a hard refusal without a usable snapshot fences management until a subsequent fresh reconciliation', async () => {
    let now=100_000, state=snapshot(); let pendingResolve!: (v: TradovateRequestControlSnapshot)=>void;
    let hold=false;
    const governor=createTradovateRequestGovernor({brokerUserId:77,clock:()=>now,monotonic:()=>now,
      store:{load:async()=>null,save:async()=>{}},remote:{read:async()=>hold?new Promise(r=>{pendingResolve=r;}):state,
        reserve:async()=>{throw new TradovateRemoteControlError('tradovate-request-cooldown');},penalize:vi.fn()}});
    await governor.initialize();hold=true;const older=governor.sync();
    await expect(governor.prepare('control')).rejects.toMatchObject({controlReason:'unavailable'});
    expect(()=>governor.dispatch('management')).toThrow();
    pendingResolve(snapshot({serverNow:100_001}));await older;expect(()=>governor.dispatch('management')).toThrow();
    hold=false;now+=10;state=snapshot({serverNow:now});await governor.sync();expect(()=>governor.dispatch('management')()).not.toThrow();
  });

  it('an older or equal response cannot reduce counters or renew authority age', async () => {
    let now=100_000,state=snapshot({serverNow:100_001,backgroundReservedMinute:40});
    const governor=createTradovateRequestGovernor({brokerUserId:77,clock:()=>now,monotonic:()=>now,
      store:{load:async()=>null,save:async()=>{}},remote:{read:async()=>state,reserve:vi.fn(),penalize:vi.fn()}});
    await governor.initialize();now+=1000;state=snapshot({serverNow:100_001});await governor.sync();
    await expect(governor.prepare('background')).rejects.toMatchObject({controlReason:'budget'});
    state=snapshot({serverNow:100_000});await governor.sync();now+=4001;
    expect(governor.health().state).toBe('unavailable');
  });

  it('a wrong-principal hard refusal never leaves accepted writes enabled',async()=>{
    const governor=createTradovateRequestGovernor({brokerUserId:77,clock:()=>100_000,monotonic:()=>100,
      store:{load:async()=>null,save:async()=>{}},remote:{read:async()=>snapshot(),reserve:async()=>{throw new TradovateRemoteControlError('tradovate-request-captcha',null,snapshot({brokerUserId:88}));},penalize:vi.fn()}});
    await governor.initialize();await expect(governor.prepare('control')).rejects.toThrow();expect(()=>governor.dispatch('management')).toThrow();
  });

});
