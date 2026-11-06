import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import type { ContractDetails } from '@stoqey/ib';
import { priceAlertWatchGrant, signPriceAlertWatchRequest, verifyPriceAlertWatchRequest } from '../server/priceAlertWatchKey';
import { createPriceAlertWatchCore, LOCAL_CAP, parseWatchAlert, type WatchAlert } from '../services/priceAlertWatchCore';
import { createPriceAlertWatchSupervisor, type PriceAlertWorkerLike } from '../server/priceAlertWatchSupervisor';
import { createIbkrPriceSource } from '../services/ibkrPriceSource';
import type { ReadOnlyIbClient, ReadOnlyIbHandlers } from '../services/ibkrMarketData';
import { priceAlertCollapseId, priceAlertNotificationText } from '../server/priceAlertOutbox';

const SECRET = 's'.repeat(48);
const DEVICE = '0b9d1c64-1f0a-4c55-9d21-6a3f7e2b8c11';
const NOW = 1_800_000_000_000;

describe('klíč hlídače upozornění', () => {
  it('podpis projde jen se stejným tělem, akcí, zařízením a časem ±60 s', () => {
    const grant = priceAlertWatchGrant(DEVICE, SECRET)!;
    expect(grant.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const body = JSON.stringify({ action: 'list' });
    const header = signPriceAlertWatchRequest({ deviceId: DEVICE, key: grant.key, action: 'list', body, ts: NOW });
    expect(verifyPriceAlertWatchRequest(header, 'list', body, NOW + 1_000, SECRET)).toEqual({ deviceId: DEVICE });
    expect(verifyPriceAlertWatchRequest(header, 'trigger', body, NOW, SECRET)).toBeNull();
    expect(verifyPriceAlertWatchRequest(header, 'list', `${body} `, NOW, SECRET)).toBeNull();
    expect(verifyPriceAlertWatchRequest(header, 'list', body, NOW + 61_000, SECRET)).toBeNull();
    expect(verifyPriceAlertWatchRequest(header, 'list', body, NOW, 't'.repeat(48))).toBeNull();
    const foreign = priceAlertWatchGrant('7a1e3b52-9c0d-4e8f-a1b2-c3d4e5f60718', SECRET)!;
    expect(verifyPriceAlertWatchRequest(header.replace(DEVICE, '7a1e3b52-9c0d-4e8f-a1b2-c3d4e5f60718'), 'list', body, NOW, SECRET)).toBeNull();
    expect(foreign.key).not.toBe(grant.key);
  });

  it('bez tajemství nebo s cizím tvarem id nic nevydá a nevyhodí; klíč se liší od klíče kanálu ceny', async () => {
    expect(priceAlertWatchGrant(DEVICE, undefined)).toBeNull();
    expect(priceAlertWatchGrant(DEVICE, 'short')).toBeNull();
    expect(priceAlertWatchGrant('nope', SECRET)).toBeNull();
    expect(verifyPriceAlertWatchRequest(undefined, 'list', '', NOW, SECRET)).toBeNull();
    const { tvPriceChannelGrant, copierStatusNudgeKey } = await import('../server/tvPriceChannel');
    const key = priceAlertWatchGrant(DEVICE, SECRET)!.key;
    expect(key).not.toBe(tvPriceChannelGrant(DEVICE, SECRET)!.key);
    expect(key).not.toBe(copierStatusNudgeKey(DEVICE, SECRET));
  });
});

const alert = (patch: Partial<WatchAlert> = {}): WatchAlert => ({
  id: 'pa-a1', symbol: 'MNQ', price: 100, condition: 'up', conditionAuto: false, frequency: 'once', version: 1, expiresAt: null, ...patch,
});
const batch = (patch: Record<string, unknown> = {}) => ({ contract: 'MNQZ2026', prev: 99, min: 99, max: 99.5, last: 99.5, at: NOW, ...patch });

describe('jádro hlídače: křížení jen z platné výchozí ceny', () => {
  const core = (patch: Partial<WatchAlert>[] = [{}]) => {
    let n = 0;
    const watch = createPriceAlertWatchCore({ now: () => NOW, uuid: () => `t${(n += 1)}` });
    watch.setAlerts(patch.map(item => alert(item)));
    return watch;
  };

  it('první dávka jen nastaví výchozí cenu; křížení nahoru pak spustí jednou s jedním id', () => {
    const watch = core();
    expect(watch.onBatch(batch({ prev: null }))).toEqual([]);
    expect(watch.onBatch(batch({ at: NOW + 250, prev: 99.5, min: 99.5, max: 100.25, last: 99.75 }))).toEqual([
      { alertId: 'pa-a1', version: 1, triggerId: 't1', observedAt: NOW + 250, front: 'MNQZ2026' },
    ]);
    // Návrat a nové křížení „jednou“ už nespustí (rozhoduje server, lokálně jen jednou).
    expect(watch.onBatch(batch({ at: NOW + 500, prev: 99.75, min: 99, max: 99.75, last: 99 }))).toEqual([]);
    expect(watch.onBatch(batch({ at: NOW + 750, prev: 99, min: 99, max: 100.5, last: 100.5 }))).toEqual([]);
  });

  it('mezera v ceně > 15 s, jiný kontrakt a dávka bez prev = nová výchozí cena, nic nespustí', () => {
    const watch = core();
    watch.onBatch(batch({ prev: null }));
    expect(watch.onBatch(batch({ at: NOW + 16_000, prev: 99, min: 99, max: 101, last: 101 }))).toEqual([]);
    const second = core();
    second.onBatch(batch({ prev: null }));
    expect(second.onBatch(batch({ contract: 'MNQH2027', at: NOW + 250, prev: 99, min: 99, max: 101, last: 101 }))).toEqual([]);
    const third = core();
    third.onBatch(batch({ prev: null }));
    expect(third.onBatch(batch({ at: NOW + 250, prev: null, min: 99, max: 101, last: 101 }))).toEqual([]);
  });

  it('nová verze upozornění = nová výchozí cena; „pokaždé“ drží 60 s odstup', () => {
    const watch = core([{ frequency: 'every' }]);
    watch.onBatch(batch({ prev: null }));
    expect(watch.onBatch(batch({ at: NOW + 250, prev: 99.5, min: 99.5, max: 100, last: 100 }))).toHaveLength(1);
    expect(watch.onBatch(batch({ at: NOW + 500, prev: 100, min: 99, max: 99, last: 99 }))).toEqual([]);
    expect(watch.onBatch(batch({ at: NOW + 750, prev: 99, min: 99, max: 100.5, last: 100.5 }))).toEqual([]);
    watch.setAlerts([alert({ frequency: 'every', version: 2 })]);
    // Verze 2 přibyla během hlídání: první dávka jen nastaví směr.
    expect(watch.onBatch(batch({ at: NOW + 1_000, prev: 99, min: 99, max: 101, last: 101 }))).toEqual([]);
  });

  it('automatický směr se přepočítá z výchozí ceny IBKR; ruční směr platí', () => {
    const auto = core([{ condition: 'up', conditionAuto: true }]);
    // Trh je už nad úrovní: automatický směr = dolů.
    auto.onBatch(batch({ prev: null, min: 101, max: 101, last: 101 }));
    expect(auto.onBatch(batch({ at: NOW + 250, prev: 101, min: 99.75, max: 101, last: 99.75 }))).toHaveLength(1);
    const manual = core([{ condition: 'up' }]);
    manual.onBatch(batch({ prev: null, min: 101, max: 101, last: 101 }));
    expect(manual.onBatch(batch({ at: NOW + 250, prev: 101, min: 99.75, max: 101, last: 99.75 }))).toEqual([]);
  });

  it('vypršelé upozornění nehlídá; lokální strop 30 spuštění / 10 min', () => {
    const expired = core([{ expiresAt: NOW - 1 }]);
    expired.onBatch(batch({ prev: null }));
    expect(expired.onBatch(batch({ at: NOW + 250, prev: 99.5, min: 99.5, max: 101, last: 101 }))).toEqual([]);
    const many = core(Array.from({ length: 40 }, (_, index) => ({ id: `pa-m${index}` })));

    many.onBatch(batch({ prev: null }));
    expect(many.onBatch(batch({ at: NOW + 250, prev: 99.5, min: 99.5, max: 101, last: 101 }))).toHaveLength(LOCAL_CAP);
  });

  it('seznam ze serveru: neplatné řádky se zahodí', () => {
    expect(parseWatchAlert({ ...alert(), id: 'x' })).toBeNull();
    expect(parseWatchAlert({ ...alert(), symbol: 'ES' })).toBeNull();
    expect(parseWatchAlert({ ...alert(), price: -1 })).toBeNull();
    expect(parseWatchAlert({ ...alert(), version: 0 })).toBeNull();
    expect(parseWatchAlert(alert())).toEqual(alert());
  });
});

describe('jádro hlídače: odpověď serveru', () => {
  const make = (patch: Partial<WatchAlert> = {}) => {
    let n = 0;
    const watch = createPriceAlertWatchCore({ now: () => NOW, uuid: () => `t${(n += 1)}` });
    watch.setAlerts([alert(patch)]);
    watch.onBatch(batch({ prev: null }));
    return watch;
  };
  const cross = (watch: ReturnType<typeof make>, at: number) => watch.onBatch(batch({ at, prev: 99.5, min: 99.5, max: 100.5, last: 100.5 }))
    .concat(watch.onBatch(batch({ at: at + 1, prev: 100.5, min: 99, max: 100.5, last: 99 })));
  // Klidné dávky pod úrovní, ať čas mezi kříženími není „výpadek ceny“ (> 15 s = nová výchozí cena).
  const idle = (watch: ReturnType<typeof make>, from: number, to: number) => {
    for (let at = from; at < to; at += 10_000) expect(watch.onBatch(batch({ at, prev: 99, min: 99, max: 99, last: 99 }))).toEqual([]);
  };

  it('„jednou“ bez konečné odpovědi (výpadek) se uvolní a příští křížení znovu nahlásí; konečná odpověď ho nechá', () => {
    const watch = make();
    const [first] = cross(watch, NOW + 250);
    expect(first).toMatchObject({ triggerId: 't1' });
    expect(cross(watch, NOW + 500)).toEqual([]);
    watch.settle('t1', 'retry');
    expect(cross(watch, NOW + 750)).toHaveLength(1);
    watch.settle('t2', 'final');
    expect(cross(watch, NOW + 1_000)).toEqual([]);
  });

  it('„pokaždé“: odmítnutí kvůli odstupu serveru vrátí předchozí čas; místní odstup 62 s', () => {
    const watch = make({ frequency: 'every' });
    expect(cross(watch, NOW + 250)).toHaveLength(1);
    idle(watch, NOW + 10_000, NOW + 61_000);
    expect(cross(watch, NOW + 61_000)).toEqual([]);
    const [second] = cross(watch, NOW + 62_500);
    expect(second).toBeDefined();
    watch.settle(second.triggerId, 'retry');
    // Po vrácení času platí odstup od prvního spuštění — další křížení hned projde.
    expect(cross(watch, NOW + 63_000)).toHaveLength(1);
  });

  it('upozornění přibylé během hlídání bere směr z konce dávky (výchozí cena příští dávky)', () => {
    let n = 0;
    const watch = createPriceAlertWatchCore({ now: () => NOW, uuid: () => `t${(n += 1)}` });
    watch.setAlerts([]);
    watch.onBatch(batch({ prev: null, min: 100.75, max: 100.75, last: 100.75 }));
    watch.setAlerts([alert({ price: 101, conditionAuto: true, condition: 'up' })]);
    // Dávka 100.75 → 101.25: konec je nad úrovní, směr tedy „dolů“.
    expect(watch.onBatch(batch({ at: NOW + 250, prev: 100.75, min: 100.75, max: 101.25, last: 101.25 }))).toEqual([]);
    expect(watch.onBatch(batch({ at: NOW + 500, prev: 101.25, min: 100.5, max: 101.25, last: 100.5 }))).toHaveLength(1);
  });
});

describe('dávka obchodů IBKR pro upozornění', () => {
  it('min/max/last od minulého odběru, prev z minulé dávky; neplatné čtení zapomene výchozí cenu', () => {
    const clock = Date.UTC(2026, 9, 28, 13, 30, 5);
    const handlers: { current: ReadOnlyIbHandlers | null } = { current: null };
    const source = createIbkrPriceSource({
      now: () => clock, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {},
      createClient: next => {
        handlers.current = next;
        const noop = () => {};
        return {
          connect: noop, disconnect: noop, isConnected: () => true, requestRealtimeData: noop, requestContractDetails: noop,
          subscribeTrades: noop, cancelTrades: noop, subscribeVolume: noop, cancelVolume: noop, requestMinuteBars: noop, cancelMinuteBars: noop,
        } as ReadOnlyIbClient;
      },
    });
    source.start();
    const h = handlers.current!;
    h.onConnected?.();
    h.onContractDetails?.(1_001, { contract: { conId: 1, localSymbol: 'MNQZ6', lastTradeDateOrContractMonth: '20261218', multiplier: 2 } } as unknown as ContractDetails);
    h.onContractDetailsEnd?.(1_001);
    const trade = (price: number) => h.onTick?.(2, { time: Math.floor(clock / 1_000), price, size: 1, receivedAt: clock, pastLimit: false, unreported: false });
    expect(source.takeAlertBatch(true)).toBeNull();
    trade(100); trade(101); trade(99.5); trade(100.25);
    expect(source.takeAlertBatch(true)).toEqual({ contract: 'MNQZ2026', prev: null, min: 99.5, max: 101, last: 100.25 });
    trade(100.5);
    expect(source.takeAlertBatch(true)).toEqual({ contract: 'MNQZ2026', prev: 100.25, min: 100.5, max: 100.5, last: 100.5 });
    trade(102);
    expect(source.takeAlertBatch(false)).toBeNull();
    trade(103);
    expect(source.takeAlertBatch(true)).toMatchObject({ prev: null, last: 103 });
    // Neohlášený / mimolimitní obchod upozornění nespustí.
    h.onTick?.(2, { time: Math.floor(clock / 1_000), price: 200, size: 1, receivedAt: clock, pastLimit: false, unreported: true });
    h.onTick?.(2, { time: Math.floor(clock / 1_000), price: 1, size: 1, receivedAt: clock, pastLimit: true, unreported: false });
    expect(source.takeAlertBatch(true)).toBeNull();
    source.stop();
  });
});

describe('supervisor vlákna hlídače', () => {
  const fakeWorker = () => {
    const listeners: Record<string, ((value: unknown) => void)[]> = {};
    const posted: unknown[] = [];
    const worker: PriceAlertWorkerLike & { emit(event: string, value: unknown): void; posted: unknown[]; terminated: boolean } = {
      posted, terminated: false,
      on(event, listener) { (listeners[event] ??= []).push(listener); return worker; },
      postMessage(message) { posted.push(message); },
      terminate() { worker.terminated = true; return Promise.resolve(0); },
      unref() {},
      emit(event, value) { for (const listener of listeners[event] ?? []) listener(value); },
    };
    return worker;
  };
  const config = { apiOrigin: 'https://example.test', deviceId: DEVICE, key: 'k'.repeat(43) };

  it('stejná konfigurace z každého pollu vlákno nerestartuje; null ho ukončí; dávky jdou jen do běžícího vlákna', () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const timers: (() => void)[] = [];
    const supervisor = createPriceAlertWatchSupervisor({
      createWorker: () => { const worker = fakeWorker(); workers.push(worker); return worker; },
      setTimeoutImpl: callback => { timers.push(callback); return timers.length; }, clearTimeoutImpl: () => {}, setIntervalImpl: () => 0, clearIntervalImpl: () => {},
    });
    supervisor.onBatch({ contract: 'MNQZ2026', prev: 1, min: 1, max: 1, last: 1, at: NOW });
    supervisor.update(config);
    // Vlákno vznikne až mimo volání z pollu.
    expect(workers).toHaveLength(0);
    timers.shift()!();
    supervisor.update({ ...config });
    expect(workers).toHaveLength(1);
    expect(workers[0].posted).toEqual([{ type: 'config', ...config }]);
    supervisor.onBatch({ contract: 'MNQZ2026', prev: 1, min: 1, max: 1, last: 1, at: NOW });
    expect(workers[0].posted.at(-1)).toMatchObject({ type: 'batch', contract: 'MNQZ2026' });
    supervisor.update(null);
    expect(workers[0].terminated).toBe(true);
    supervisor.stop();
  });

  it('status jen z čerstvé zprávy vlákna (stáří v ms); 3 pády = jistič; nic nevyhodí', () => {
    let clock = NOW;
    const timers: (() => void)[] = [];
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const supervisor = createPriceAlertWatchSupervisor({
      now: () => clock,
      createWorker: () => { const worker = fakeWorker(); workers.push(worker); return worker; },
      setTimeoutImpl: callback => { timers.push(callback); return timers.length; }, clearTimeoutImpl: () => {},
      setIntervalImpl: () => 0, clearIntervalImpl: () => {},
    });
    supervisor.update(config);
    timers.shift()!();
    expect(supervisor.status()).toBeNull();
    workers[0].emit('message', { type: 'watch', state: 'watching', alerts: 3, priceAt: clock - 400, syncAt: clock - 2_000 });
    expect(supervisor.status()).toEqual({ state: 'watching', alerts: 3, priceAgeMs: 400, syncAgeMs: 2_000 });
    workers[0].emit('message', { type: 'watch', state: 'evil', alerts: 3 });
    clock += 6_000;
    expect(supervisor.status()).toBeNull();
    clock += 60_000;
    for (let i = 0; i < 3; i += 1) {
      workers.at(-1)!.emit('exit', 1);
      timers.shift()?.();
    }
    expect(supervisor.status()).toEqual({ state: 'tripped', alerts: 0, priceAgeMs: null, syncAgeMs: null });
    // Záplava zpráv z rozbitého vlákna = ukončit a počítat jako pád (nezahltí poll a brzdy).
    const floodTimers: (() => void)[] = [];
    const floodWorkers: ReturnType<typeof fakeWorker>[] = [];
    const flooded = createPriceAlertWatchSupervisor({
      now: () => clock,
      createWorker: () => { const worker = fakeWorker(); floodWorkers.push(worker); return worker; },
      setTimeoutImpl: callback => { floodTimers.push(callback); return floodTimers.length; }, clearTimeoutImpl: () => {},
      setIntervalImpl: () => 0, clearIntervalImpl: () => {},
    });
    flooded.update(config);
    floodTimers.shift()!();
    for (let i = 0; i < 150; i += 1) floodWorkers[0].emit('message', { type: 'watch', state: 'watching', alerts: 1, priceAt: clock, syncAt: clock });
    expect(floodWorkers[0].terminated).toBe(true);
    expect(floodTimers).toHaveLength(1);
    const broken = createPriceAlertWatchSupervisor({
      createWorker: () => { throw new Error('boom'); },
      setTimeoutImpl: () => 0, clearTimeoutImpl: () => {}, setIntervalImpl: () => 0, clearIntervalImpl: () => {},
    });
    expect(() => broken.update(config)).not.toThrow();
    expect(() => broken.onBatch({ contract: 'MNQZ2026', prev: 1, min: 1, max: 1, last: 1, at: NOW })).not.toThrow();
  });
});

describe('text notifikace', () => {
  it('úroveň uživatele, česky; automatický směr = „přes“; collapse-id ≤ 64 B', () => {
    expect(priceAlertNotificationText({ symbol: 'MNQ', condition: 'up', level: 21480, note: '' }).title).toMatch(/^MNQ nahoru přes 21\s480,00$/);
    expect(priceAlertNotificationText({ symbol: 'MNQ', condition: 'cross', level: 21480.25, note: ' VWAP ' })).toMatchObject({ body: 'VWAP' });
    expect(priceAlertNotificationText({ symbol: 'NQ', condition: 'cross', level: 1, note: null }).body).toBe('Upozornění na cenu');
    expect(Buffer.byteLength(priceAlertCollapseId(`pa-${'x'.repeat(61)}`))).toBeLessThanOrEqual(64);
  });
});

describe('oddělení hlídače od příkazů (INV-WORKER-04, INV-WATCH-01)', () => {
  const source = (path: string) => readFileSync(path, 'utf8');

  it('vlákno importuje jen node:, jádro křížení a podpis; žádný token zařízení, relay ani Supabase', () => {
    const thread = source('scripts/copier/priceAlertWatchThread.ts');
    const imports = [...thread.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
    expect(imports.sort()).toEqual(['../../server/priceAlertWatchKey', '../../services/priceAlertWatchCore', 'node:crypto', 'node:worker_threads'].sort());
    const core = source('services/priceAlertWatchCore.ts');
    expect([...core.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(match => match[1]).sort()).toEqual(['../lib/priceAlertCross', '../lib/priceAlerts']);
    expect(source('server/priceAlertWatchKey.ts')).not.toMatch(/\bfrom\s+['"](?!node:)/);
    expect(thread).not.toMatch(/copier-relay|Authorization|Device [0-9a-f]/);
    expect(thread).not.toMatch(/supabase/i);
  });

  it('bundle postavený jako v instalátoru naběhne jako Worker s env {} a bez konfigurace hlásí „off“', async () => {
    const root = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'price-alert-watch-'));
    try {
      const outfile = join(dir, 'price-alert-watch.mjs');
      execFileSync(join(root, 'node_modules/.bin/esbuild'), [
        join(root, 'scripts/copier/priceAlertWatchThread.ts'),
        '--bundle', '--platform=node', '--format=esm', '--target=node20', `--outfile=${outfile}`, '--log-level=error',
      ]);
      const thread = new Worker(outfile, { env: {}, stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8 } });
      thread.stdout.resume();
      thread.stderr.resume();
      const outcome = await new Promise<unknown>(done => {
        const timer = setTimeout(() => done('timeout'), 5_000);
        thread.on('message', message => { clearTimeout(timer); done(message); });
        thread.on('error', error => { clearTimeout(timer); done(`error: ${error.message}`); });
      });
      await thread.terminate();
      expect(outcome).toEqual({ type: 'watch', state: 'off', alerts: 0, priceAt: null, syncAt: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('pilot: vlákno s env {}, jen IBKR a --price-alerts on; jiný bundle jako Worker nikdy', () => {
    const pilot = source('scripts/copier/pilot.ts');
    expect(pilot).toContain("new URL('./price-alert-watch.mjs', import.meta.url)");
    expect(pilot).toContain("process.env.ALPHATRADE_PRICE_ALERTS?.trim().toLowerCase() === 'on'");
    expect(pilot).toMatch(/new Worker\(priceAlertWatchBundle, \{\n\s+env: \{\},/);
    expect(pilot).toContain('priceAlertWatch?.stop();');
    expect(pilot).not.toMatch(/new Worker\((?!tvPriceStreamBundle|priceAlertWatchBundle)/);
    const installer = source('scripts/copier/mac-install.ts');
    expect(installer).toContain("flags.get('price-alerts')?.trim().toLowerCase() === 'on'");
    expect(installer).toContain('<key>ALPHATRADE_PRICE_ALERTS</key><string>on</string>');
    expect(source('scripts/copier/mac-reinstall-safe.sh')).toContain('Print :EnvironmentVariables:ALPHATRADE_PRICE_ALERTS');
  });

  it('klíč upozornění jen v poll-v2 a jen vláknu hlídače (ne do onRealtimeConfig, ne prohlížeči)', () => {
    const api = source('api/tradovate/oauth/copier-relay.ts');
    expect(api.match(/\.\.\.priceAlertRealtimeFields\(/g)).toHaveLength(1);
    const pollV2 = api.slice(api.indexOf("if (action === 'poll-v2')"), api.indexOf("if (action === 'complete-v2'"));
    expect(pollV2).toContain('...priceAlertRealtimeFields(device.id)');
    const shared = api.slice(api.indexOf('const tvPriceRealtimeFields'), api.indexOf('const priceAlertRealtimeFields'));
    expect(shared).not.toMatch(/priceAlert/);
    const relay = source('server/macCopierCommandRelay.ts');
    expect(relay).toContain('const { nudgeKey: _omit, priceAlert: _alert, ...rest }');
  });

  it('relay: onPriceAlertConfig dostane klíč, onRealtimeConfig nikdy', async () => {
    const { startMacCopierCommandRelay } = await import('../server/macCopierCommandRelay');
    expect(typeof startMacCopierCommandRelay).toBe('function');
    const relaySource = source('server/macCopierCommandRelay.ts');
    const notify = relaySource.slice(relaySource.indexOf('const notifyRealtimeConfig'), relaySource.indexOf('const notifyRealtimeConfig') + 2_000);
    expect(notify.indexOf('options.onRealtimeConfig?.(')).toBeLessThan(notify.indexOf('options.onPriceAlertConfig('));
    expect(notify).toMatch(/\{ apiOrigin: options\.apiOrigin, deviceId: grant\.deviceId, key: grant\.key \}/);
  });

  it('vlákno ceny: dávka podle platnosti čtení IBKR (ne zdroje zobrazení), vlastní zprávou; kotace beze změny', () => {
    const thread = source('scripts/copier/tvPriceStreamThread.ts');
    expect(thread).toContain("const ibkrReading = priceSource === 'ibkr' ? ibkr?.reading() ?? null : null;");
    expect(thread).toContain('ibkr?.takeAlertBatch(ibkrReading != null)');
    expect(thread).toMatch(/type: 'alert-batch', front: batch\.contract/);
    expect(thread).toContain("if (priceSource !== 'ibkr' || sourceSwitch.active !== 'ibkr' || !ibkrReading) return;");
    const supervisor = source('server/tvPriceStreamSupervisor.ts');
    const quote = supervisor.slice(supervisor.indexOf("if (type === 'quote')"), supervisor.indexOf("if (type === 'alert-batch')"));
    expect(quote).not.toMatch(/onAlertBatch|batch/);
  });

  it('cron: upozornění ve vlastním try/catch za sekcí kopírky; fronta incidentů beze změny', () => {
    const cron = source('api/cron/send-alerts.ts');
    expect(cron.indexOf('drainPriceAlertOutbox({ db: supabase })')).toBeGreaterThan(cron.indexOf("console.error('[Cron] Copier watchdog failed:'"));
    expect(source('server/notificationDelivery.ts')).not.toMatch(/price_alert/);
  });
});

