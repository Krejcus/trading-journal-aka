import { describe, expect, it } from 'vitest';
import { priceAlertWatchGrant, signPriceAlertWatchRequest, verifyPriceAlertWatchRequest } from '../server/priceAlertWatchKey';
import { createPriceAlertWatchCore, LOCAL_CAP, parseWatchAlert, type WatchAlert } from '../services/priceAlertWatchCore';
import { priceAlertCollapseId, priceAlertNotificationText } from '../server/priceAlertOutbox';
import { parsePriceAlertTriggers } from '../api/price-alerts/watch';

const SECRET = 's'.repeat(48);
const USER = '0b9d1c64-1f0a-4c55-9d21-6a3f7e2b8c11';
const NOW = 1_800_000_000_000;

describe('klíč hlídače upozornění (služba Rithmic)', () => {
  it('podpis projde jen se stejným tělem, uživatelem a časem ±60 s', () => {
    const grant = priceAlertWatchGrant(USER, SECRET)!;
    expect(grant.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const body = JSON.stringify({ action: 'trigger', triggers: [] });
    const header = signPriceAlertWatchRequest({ userId: USER, key: grant.key, body, ts: NOW });
    expect(verifyPriceAlertWatchRequest(header, body, NOW + 1_000, SECRET)).toEqual({ userId: USER });
    expect(verifyPriceAlertWatchRequest(header, `${body} `, NOW, SECRET)).toBeNull();
    expect(verifyPriceAlertWatchRequest(header, body, NOW + 61_000, SECRET)).toBeNull();
    expect(verifyPriceAlertWatchRequest(header, body, NOW, 't'.repeat(48))).toBeNull();
    const other = '7a1e3b52-9c0d-4e8f-a1b2-c3d4e5f60718';
    // Klíč jednoho uživatele nepodepíše hlášení za jiného.
    expect(verifyPriceAlertWatchRequest(header.replace(USER, other), body, NOW, SECRET)).toBeNull();
    expect(priceAlertWatchGrant(other, SECRET)!.key).not.toBe(grant.key);
  });

  it('bez kořene nebo s cizím tvarem id nic nevydá a nevyhodí', () => {
    expect(priceAlertWatchGrant(USER, undefined)).toBeNull();
    expect(priceAlertWatchGrant(USER, 'short')).toBeNull();
    expect(priceAlertWatchGrant('nope', SECRET)).toBeNull();
    expect(verifyPriceAlertWatchRequest(undefined, '', NOW, SECRET)).toBeNull();
  });
});

describe('hlášení křížení: tvar', () => {
  const trigger = (patch: Record<string, unknown> = {}) => ({ alertId: 'pa-a1', version: 1, triggerId: '0b9d1c64-1f0a-4c55-9d21-6a3f7e2b8c11', observedAt: NOW, front: 'MNQZ6', ...patch });
  it('kontrakt Rithmicu (MNQZ6) projde; nesmysly a prázdná nebo příliš dlouhá dávka ne', () => {
    expect(parsePriceAlertTriggers([trigger()], NOW)).toEqual([trigger()]);
    expect(parsePriceAlertTriggers([trigger({ front: 'ESZ6' })], NOW)![0].front).toBeNull();
    expect(parsePriceAlertTriggers([], NOW)).toBeNull();
    expect(parsePriceAlertTriggers(Array.from({ length: 11 }, () => trigger()), NOW)).toBeNull();
    expect(parsePriceAlertTriggers([trigger({ alertId: 'x' })], NOW)).toBeNull();
    expect(parsePriceAlertTriggers([trigger({ observedAt: 9e15 })], NOW)).toBeNull();
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


describe('jádro hlídače pro Rithmic: jeden obchod = jedna dávka', () => {
  const tick = (price: number, prev: number | null, at: number) => ({ contract: 'MNQZ6', prev, min: price, max: price, last: price, at });
  const make = (gapMs?: number) => {
    let n = 0;
    const watch = createPriceAlertWatchCore({ now: () => NOW, uuid: () => `t${(n += 1)}`, gapMs });
    watch.setAlerts([alert({ price: 100, condition: 'cross' })]);
    return watch;
  };

  it('kontrakt ve tvaru Rithmicu se bere; první obchod jen nastaví výchozí cenu', () => {
    const watch = make();
    expect(watch.onBatch(tick(99, null, NOW))).toEqual([]);
    expect(watch.onBatch(tick(99.75, 99, NOW + 100))).toEqual([]);
    expect(watch.onBatch(tick(100, 99.75, NOW + 200))).toMatchObject([{ alertId: 'pa-a1', front: 'MNQZ6', observedAt: NOW + 200 }]);
  });

  it('klidný trh není výpadek: s delší povolenou mezerou křížení po 40 s ticha platí', () => {
    const watch = make(120_000);
    watch.onBatch(tick(99, null, NOW));
    watch.onBatch(tick(99.5, 99, NOW + 100));
    expect(watch.onBatch(tick(100.25, 99.5, NOW + 40_100))).toHaveLength(1);
  });

  it('spojení spadlo (resetBaseline): skok ceny přes úroveň po obnově NIC nespustí, další křížení ano', () => {
    const watch = make(120_000);
    watch.onBatch(tick(99, null, NOW));
    watch.onBatch(tick(99.5, 99, NOW + 100));
    watch.resetBaseline();
    expect(watch.onBatch(tick(101, 99.5, NOW + 5_000))).toEqual([]);
    expect(watch.onBatch(tick(99.75, 101, NOW + 5_100))).toHaveLength(1);
  });
});

describe('text notifikace', () => {
  it('úroveň uživatele, česky; automatický směr = „přes“; collapse-id ≤ 64 B', () => {
    expect(priceAlertNotificationText({ symbol: 'MNQ', condition: 'up', level: 21480, note: '' }).title).toMatch(/^🚨 MNQ 21\s480,00$/);
    expect(priceAlertNotificationText({ symbol: 'MNQ', condition: 'cross', level: 21480.25, note: ' VWAP ' })).toMatchObject({ body: 'Překročí\nVWAP' });
    expect(priceAlertNotificationText({ symbol: 'NQ', condition: 'cross', level: 1, note: null }).body).toBe('Překročí');
    expect(Buffer.byteLength(priceAlertCollapseId(`pa-${'x'.repeat(61)}`))).toBeLessThanOrEqual(64);
  });
});

