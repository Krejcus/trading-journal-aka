// Předem navázané spojení k Applu pro upozornění na cenu (25. 11. 2026): chování nad falešným HTTP/2.
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Plan = 'ok' | 'gone' | 'stream-close' | 'hang';

class FakeStream extends EventEmitter {
  setEncoding(): void { /* nic */ }
  end(): void { /* nic */ }
}
class FakeSession extends EventEmitter {
  closed = false;
  destroyed = false;
  streams: FakeStream[] = [];
  constructor(readonly host: string, private readonly plans: Plan[]) { super(); }
  request(): FakeStream {
    if (this.destroyed || this.closed) throw new Error('ERR_HTTP2_INVALID_SESSION');
    const stream = new FakeStream();
    this.streams.push(stream);
    const plan = this.plans.shift() ?? 'ok';
    queueMicrotask(() => {
      if (plan === 'ok') { stream.emit('response', { ':status': 200, 'apns-id': 'id-1' }); stream.emit('end'); stream.emit('close'); }
      else if (plan === 'gone') { stream.emit('response', { ':status': 410 }); stream.emit('data', '{"reason":"Unregistered"}'); stream.emit('end'); stream.emit('close'); }
      else if (plan === 'stream-close') stream.emit('close');
    });
    return stream;
  }
  close(): void { this.closed = true; this.emit('close'); }
  destroy(): void { this.destroyed = true; for (const stream of this.streams) stream.emit('close'); this.emit('close'); }
}

const sessions: FakeSession[] = [];
let plansFor: Plan[][] = [];
vi.mock('node:http2', () => ({
  connect: (host: string) => {
    const session = new FakeSession(host, plansFor.shift() ?? []);
    sessions.push(session);
    return session;
  },
}));

const device = { id: 'd1', deviceToken: 'a'.repeat(64), environment: 'development' as const, bundleId: 'app.example' };
const note = (patch: Record<string, unknown> = {}) => ({ title: 't', body: 'b', timeoutMs: 200, ...patch });
const sandbox = () => sessions.filter((session) => session.host.includes('sandbox'));

describe('spojení k Applu pro upozornění na cenu', () => {
  beforeEach(() => {
    sessions.length = 0;
    plansFor = [];
    process.env.APNS_KEY_ID = 'KEY';
    process.env.APNS_TEAM_ID = 'TEAM';
    process.env.APNS_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  });
  afterEach(() => { vi.resetModules(); });

  it('bez keepSession: vlastní spojení, po odeslání zavřené; předem navázané se nepoužije', async () => {
    const { prewarmApns, sendApnsNotification } = await import('../server/apns');
    const held = prewarmApns();
    expect(sessions).toHaveLength(2); // sandbox + produkce
    expect(await sendApnsNotification(device, note())).toMatchObject({ status: 'sent' });
    expect(sessions).toHaveLength(3);
    expect(sessions[2].closed).toBe(true);
    expect(sessions[0].streams).toHaveLength(0);
    held.release();
  });

  it('s keepSession: dvě odeslání jdou po předem navázaném spojení; release ho zavře a další požadavek otevře nové', async () => {
    const { prewarmApns, sendApnsNotification } = await import('../server/apns');
    const held = prewarmApns();
    const results = await Promise.all([sendApnsNotification(device, note({ keepSession: true })), sendApnsNotification(device, note({ keepSession: true }))]);
    expect(results.map((result) => result.status)).toEqual(['sent', 'sent']);
    expect(sessions).toHaveLength(2);
    expect(sandbox()[0].streams).toHaveLength(2);
    expect(sandbox()[0].closed).toBe(false);
    held.release();
    expect(sessions.every((session) => session.closed)).toBe(true);
    held.release(); // podruhé nic
    const next = prewarmApns();
    expect(sessions).toHaveLength(4);
    next.release();
  });

  it('bez předehřátí se keepSession chová jako běžné odeslání (nic se nedrží)', async () => {
    const { sendApnsNotification } = await import('../server/apns');
    expect(await sendApnsNotification(device, note({ keepSession: true }))).toMatchObject({ status: 'sent' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].closed).toBe(true);
  });

  it('stream skončí bez odpovědi: jedno opakování na čerstvém spojení, sourozenec nevisí', async () => {
    plansFor = [['stream-close', 'ok'], []];
    const { prewarmApns, sendApnsNotification } = await import('../server/apns');
    const held = prewarmApns();
    const results = await Promise.all([sendApnsNotification(device, note({ keepSession: true })), sendApnsNotification(device, note({ keepSession: true }))]);
    expect(results.map((result) => result.status)).toEqual(['sent', 'sent']);
    // Třetí spojení = opakování prvního odeslání; sdílené spojení zůstalo pro sourozence.
    expect(sessions).toHaveLength(3);
    expect(sessions[2].closed).toBe(true);
    held.release();
  });

  it('odpověď Applu (410) se neopakuje', async () => {
    plansFor = [['gone'], []];
    const { prewarmApns, sendApnsNotification } = await import('../server/apns');
    const held = prewarmApns();
    expect(await sendApnsNotification(device, note({ keepSession: true }))).toMatchObject({ status: 'expired', error: 'Unregistered' });
    expect(sessions).toHaveLength(2);
    held.release();
  });

  it('vypršení času: neopakuje se, sdílené spojení se zahodí a souběžné odeslání skončí hned', async () => {
    plansFor = [['hang', 'hang'], []];
    const { prewarmApns, sendApnsNotification } = await import('../server/apns');
    const held = prewarmApns();
    const started = Date.now();
    const results = await Promise.all([sendApnsNotification(device, note({ keepSession: true, timeoutMs: 120 })), sendApnsNotification(device, note({ keepSession: true, timeoutMs: 5_000 }))]);
    expect(results[0]).toMatchObject({ status: 'failed', error: 'apns-timeout' });
    // Sourozenec dostal `close` zničeného spojení a zkusil to na čerstvém — nečekal 5 s.
    expect(results[1].status).toBe('sent');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(sandbox()[0].destroyed).toBe(true);
    held.release();
  });

  it('dva souběžné požadavky sdílejí spojení; zavře se až po posledním release', async () => {
    const { prewarmApns } = await import('../server/apns');
    const first = prewarmApns();
    const second = prewarmApns();
    expect(sessions).toHaveLength(2);
    first.release();
    expect(sessions.some((session) => session.closed)).toBe(false);
    second.release();
    expect(sessions.every((session) => session.closed)).toBe(true);
  });

  it('bez konfigurace předehřátí nic neotevře a nikdy nevyhodí', async () => {
    delete process.env.APNS_KEY_ID;
    const { prewarmApns } = await import('../server/apns');
    const held = prewarmApns();
    expect(sessions).toHaveLength(0);
    expect(() => held.release()).not.toThrow();
  });
});
