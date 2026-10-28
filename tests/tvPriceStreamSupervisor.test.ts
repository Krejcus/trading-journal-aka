import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTvPriceStreamSupervisor, IBKR_BARS_FRESH_MS, IBKR_CRASH_FALLBACK_MS, type TvPriceSourceName, type TvPriceStreamConfig } from '../server/tvPriceStreamSupervisor';

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

  it('zdroj IBKR: po pádu vlákna jede 30 min jen TradingView, pak zase IBKR', async () => {
    const sources: TvPriceSourceName[] = [];
    const workers: FakeWorker[] = [];
    const log = vi.fn();
    const supervisor = createTvPriceStreamSupervisor({
      priceSource: 'ibkr',
      createWorker: source => { sources.push(source); const worker = new FakeWorker(); workers.push(worker); return worker; },
      log,
    });
    supervisor.update(ON);
    expect(sources).toEqual(['ibkr']);
    workers[0].emit('error', new Error('ib boom'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sources).toEqual(['ibkr', 'tv']);
    expect(log.mock.calls.map(call => String(call[0])).join('\n')).toContain('30 min jen TradingView');
    // Zdravé vlákno s TV se po pauze samo vymění za IBKR; do jističe se to nepočítá.
    for (let elapsed = 0; elapsed < IBKR_CRASH_FALLBACK_MS - 10_000; elapsed += 10_000) {
      workers[1].emit('message', { type: 'alive' });
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(sources).toEqual(['ibkr', 'tv']);
    workers[1].emit('message', { type: 'alive' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sources).toEqual(['ibkr', 'tv', 'ibkr']);
    expect(workers[1].terminated).toBe(1);
    expect(supervisor.status()).toMatchObject({ running: true, crashes: 1, tripped: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(sources).toHaveLength(3);
    supervisor.stop();
  });

  it('výpadek a návrat IBKR z vlákna jde do oznámení jen jako stav a krátké kódy; pád vlákna s IBKR taky', async () => {
    const alerts: unknown[] = [];
    const workers: FakeWorker[] = [];
    const log = vi.fn();
    const supervisor = createTvPriceStreamSupervisor({
      priceSource: 'ibkr',
      createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
      log,
      onPriceSourceAlert: alert => { alerts.push(alert); throw new Error('oznámení selhalo'); },
    });
    supervisor.update(ON);
    expect(() => workers[0].emit('message', { type: 'price-source', state: 'down', ibkr: 'connecting<script>', code: 10197, text: 'účet U123' })).not.toThrow();
    workers[0].emit('message', { type: 'price-source', state: 'maybe' });
    workers[0].emit('message', { type: 'price-source', state: 'up' });
    expect(alerts).toEqual([{ state: 'down', ibkr: 'connectingscript', code: 10197 }, { state: 'up', ibkr: null, code: null }]);
    expect(log.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('U123');
    workers[0].emit('error', new Error('ib boom'));
    expect(alerts.at(-1)).toEqual({ state: 'down', ibkr: 'crash', code: null });
    supervisor.stop();
  });

  it('výchozí zdroj je TV', () => {
    const sources: TvPriceSourceName[] = [];
    const supervisor = createTvPriceStreamSupervisor({ createWorker: source => { sources.push(source); return new FakeWorker(); } });
    supervisor.update(ON);
    expect(sources).toEqual(['tv']);
    supervisor.stop();
  });

  describe('svíčky dne z IBKR (zpráva bars)', () => {
    const barsMessage = (at: number, count = 3, patch: Record<string, unknown> = {}) => {
      const first = Math.floor(at / 60_000) * 60 - (count - 1) * 60;
      const flat = new Float64Array(count * 6);
      for (let i = 0; i < count; i += 1) flat.set([first + i * 60, 100 + i, 101 + i, 99 + i, 100 + i, 5], i * 6);
      return { type: 'bars', root: 'MNQ', source: 'IBKR:MNQZ2026', contract: 'MNQZ2026', at, bars: flat, ...patch };
    };

    it('ověří a drží poslední čtení; NQ dostane svíčky rodiny; po 90 s null', () => {
      const t = setup();
      t.supervisor.update(ON);
      t.workers[0].emit('message', barsMessage(Date.now()));
      const capture = t.supervisor.latestBars('NQ');
      expect(capture).toMatchObject({ root: 'NQ', source: 'IBKR:MNQZ2026', contract: 'MNQZ2026' });
      expect(capture!.bars).toHaveLength(3);
      expect(t.supervisor.latestBars('ES')).toBeNull();
      vi.advanceTimersByTime(IBKR_BARS_FRESH_MS + 1);
      t.workers[0].emit('message', { type: 'alive' });
      expect(t.supervisor.latestBars('MNQ')).toBeNull();
      t.supervisor.stop();
    });

    it('vadná, přerostlá nebo cizí zpráva se zahodí bez výjimky; víc než 1×/10 s se nebere', () => {
      const t = setup();
      t.supervisor.update(ON);
      const at = Date.now();
      for (const bad of [
        barsMessage(at, 3, { bars: [1, 2, 3, 4, 5, 6] }),
        barsMessage(at, 3, { bars: new Float64Array(7) }),
        barsMessage(at, 1_701),
        barsMessage(at, 3, { source: 'CME_MINI:MNQ1!' }),
        barsMessage(at, 3, { contract: 'MNQZ6' }),
        barsMessage(at, 3, { root: 'IBKR:MNQ' }),
        barsMessage(at - 5 * 60_000),
        { type: 'bars' },
      ]) {
        expect(() => t.workers[0].emit('message', bad)).not.toThrow();
        expect(t.supervisor.latestBars('MNQ')).toBeNull();
      }
      t.workers[0].emit('message', barsMessage(at, 2));
      t.workers[0].emit('message', barsMessage(at, 3));
      expect(t.supervisor.latestBars('MNQ')!.bars).toHaveLength(2);
      vi.advanceTimersByTime(10_000);
      t.workers[0].emit('message', barsMessage(Date.now(), 3));
      expect(t.supervisor.latestBars('MNQ')!.bars).toHaveLength(3);
      t.supervisor.stop();
    });

    it('po pádu vlákna, vypnutí kanálu i stopu vrací null', async () => {
      const t = setup();
      t.supervisor.update(ON);
      t.workers[0].emit('message', barsMessage(Date.now()));
      t.workers[0].emit('error', new Error('boom'));
      expect(t.supervisor.latestBars('MNQ')).toBeNull();
      await vi.advanceTimersByTimeAsync(2_000);
      vi.advanceTimersByTime(10_000);
      t.workers[1].emit('message', barsMessage(Date.now()));
      expect(t.supervisor.latestBars('MNQ')).not.toBeNull();
      t.supervisor.update({ enabled: false });
      expect(t.supervisor.latestBars('MNQ')).toBeNull();
      t.supervisor.stop();
      expect(t.supervisor.latestBars('MNQ')).toBeNull();
    });
  });
});
