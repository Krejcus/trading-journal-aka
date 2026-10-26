import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTvPriceStreamSupervisor, type TvPriceStreamConfig } from '../server/tvPriceStreamSupervisor';

class FakeWorker extends EventEmitter {
  messages: unknown[] = [];
  terminated = 0;
  unrefd = false;
  postMessage(message: unknown) { this.messages.push(message); }
  terminate() { this.terminated += 1; queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1); }
  unref() { this.unrefd = true; }
}

const ON: TvPriceStreamConfig = { enabled: true, url: 'https://x.supabase.co', anonKey: 'anon', topic: 'tv-price-abc', key: 'secret-key' };

const setup = () => {
  const workers: FakeWorker[] = [];
  const log = vi.fn();
  const supervisor = createTvPriceStreamSupervisor({
    createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    log,
  });
  return { supervisor, workers, log, logs: () => log.mock.calls.map(call => String(call[0])).join('\n') };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('hlídač vlákna kanálu ceny (hlavní vlákno workeru)', () => {
  it('spustí vlákno jen při enabled, odpojí ho od procesu (unref) a pošle konfiguraci', () => {
    const t = setup();
    t.supervisor.update({ enabled: false });
    expect(t.workers).toHaveLength(0);
    t.supervisor.update(ON);
    expect(t.workers).toHaveLength(1);
    expect(t.workers[0].unrefd).toBe(true);
    expect(t.workers[0].messages).toEqual([{ type: 'config', ...ON }]);
    t.supervisor.stop();
  });

  it('serverový vypínač: enabled false vlákno ukončí bez počítání pádu', async () => {
    const t = setup();
    t.supervisor.update(ON);
    t.supervisor.update({ enabled: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(t.workers[0].terminated).toBe(1);
    expect(t.supervisor.status()).toEqual({ running: false, tripped: false, crashes: 0 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.workers).toHaveLength(1);
    t.supervisor.stop();
  });

  it('pád vlákna = restart s prodlevou; 3 pády za 10 min vypnou stream jističem, worker žije dál', async () => {
    const t = setup();
    t.supervisor.update(ON);
    t.workers[0].emit('error', new Error('boom'));
    expect(t.supervisor.status().running).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.workers).toHaveLength(2);
    t.workers[1].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(t.workers).toHaveLength(3);
    t.workers[2].emit('error', new Error('boom'));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(t.workers).toHaveLength(3);
    expect(t.supervisor.status().tripped).toBe(true);
    expect(t.logs()).toContain('jistič');
    t.supervisor.stop();
  });

  it('zaseknuté vlákno bez „alive“ 15 s ukončí a započítá jednou', async () => {
    const t = setup();
    t.supervisor.update(ON);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.workers[0].terminated).toBe(1);
    expect(t.supervisor.status().crashes).toBe(1);
    t.supervisor.stop();
  });

  it('živé vlákno (alive) se neukončuje', async () => {
    const t = setup();
    t.supervisor.update(ON);
    for (let step = 0; step < 10; step += 1) {
      t.workers[0].emit('message', { type: 'alive' });
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(t.workers[0].terminated).toBe(0);
    t.supervisor.stop();
  });

  it('pád do 60 s po probuzení Macu se do jističe nepočítá', async () => {
    let clock = 1_000_000;
    const timers: Array<() => void> = [];
    const workers: FakeWorker[] = [];
    const supervisor = createTvPriceStreamSupervisor({
      createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
      now: () => clock,
      setIntervalImpl: callback => { timers.push(callback); return timers.length; },
      clearIntervalImpl: () => {},
      setTimeoutImpl: () => 0,
      clearTimeoutImpl: () => {},
    });
    supervisor.update(ON);
    clock += 5 * 60_000; // Mac spal
    timers.forEach(callback => callback());
    workers[0].emit('error', new Error('socket'));
    expect(supervisor.status().crashes).toBe(0);
    supervisor.stop();
  });

  it('diagnostika z vlákna se loguje jen jako čísla, nikdy téma ani klíč', () => {
    const t = setup();
    t.supervisor.update(ON);
    t.workers[0].emit('message', { type: 'diag', state: 'streaming', reads: 10, sends: 4, errors: 0, topic: ON.topic, key: ON.key });
    expect(t.logs()).toContain('reads=10 sends=4');
    expect(t.logs()).not.toContain(ON.topic!);
    expect(t.logs()).not.toContain(ON.key!);
    t.supervisor.stop();
  });

  it('update ani stop nikdy nevyhodí, ani když vytvoření vlákna selže', () => {
    const supervisor = createTvPriceStreamSupervisor({ createWorker: () => { throw new Error('no worker file'); } });
    expect(() => supervisor.update(ON)).not.toThrow();
    expect(() => supervisor.stop()).not.toThrow();
  });

  it('nová konfigurace během čekajícího restartu neobejde prodlevu', async () => {
    const t = setup();
    t.supervisor.update(ON);
    t.workers[0].emit('error', new Error('boom'));
    t.supervisor.update({ ...ON, excludeTargetId: 'T2' });
    expect(t.workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.workers).toHaveLength(2);
    expect(t.workers[1].messages).toEqual([{ type: 'config', ...ON, excludeTargetId: 'T2' }]);
    t.supervisor.stop();
  });

  it('výjimka v posluchači vlákna se nedostane do hlavního vlákna', () => {
    const t = setup();
    t.supervisor.update(ON);
    const hostile = { get type() { throw new Error('getter'); } };
    expect(() => t.workers[0].emit('message', hostile)).not.toThrow();
    t.supervisor.stop();
  });

  it('stop ukončí běžící vlákno a další update už nic nespustí', async () => {
    const t = setup();
    t.supervisor.update(ON);
    t.supervisor.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(t.workers[0].terminated).toBe(1);
    t.supervisor.update({ ...ON, topic: 'tv-price-other' });
    expect(t.workers).toHaveLength(1);
  });
});
