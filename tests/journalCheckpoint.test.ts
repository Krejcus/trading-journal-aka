import { describe, expect, it } from 'vitest';
import { buildJournalPositionEpisodes } from '../lib/journalPositionEpisodes';
import {
  compareJournalWindows, journalCheckpointManifest, journalFlatCaptures, journalLateEvidenceAt, journalLateEvidenceCheck,
  journalLateQueries, journalLiveAfterArchive, journalOrdersOpenSince,
} from '../lib/journalCheckpoint';
import { positionSnapshotObservations } from '../lib/journalPositionSnapshot';
import { journalObservation, type JournalEntityType, type JournalEvidence } from '../lib/tradovateJournalEvidence';

// Živý deník (14. 10. 2026): okno od kontrolního bodu K musí dát pro obchody po
// K totéž co plné přehrání, archivace nesmí odebrat nic potřebného a pozdní
// evidence k obchodům před K musí K vrátit zpět (nikdy tiché přepsání).

const connectionId = '33333333-3333-4333-8333-333333333333';
const iso = (at: number) => new Date(at).toISOString();
const T0 = Date.parse('2026-10-01T13:00:00Z');

function scenario() {
  const events: JournalEvidence[] = [];
  const add = (type: JournalEntityType, entity: Record<string, number | string | boolean | null>, at: number,
    source: 'stream' | 'snapshot' | 'transport' = 'stream', eventType = 'Created') => {
    const sequence = events.length + 1;
    events.push({ ...journalObservation(type, entity, source, eventType, at)!, connectionId, environment: 'demo',
      sequence, id: sequence.toString(16).padStart(64, '0'), sessionId: '55555555-5555-4555-8555-555555555555' });
  };
  const snapshot = (id: string, at: number) => {
    for (const row of positionSnapshotObservations(id, [{ id: 1 }, { id: 2 }], [], at - 200, at)) add(row.entityType, row.entity, row.receivedAt, 'snapshot');
  };
  add('contract', { id: 7, name: 'MNQZ6' }, T0);
  add('currency', { id: 1, name: 'USD', symbol: '$' }, T0);
  snapshot('s0', T0 + 1_000);
  // Obchod s limitním vstupem a OSO bracketem (SL posunutý), na dvou účtech.
  const trade = (account: number, base: number, entryOrder: number, start: number, price: number) => {
    const entry = entryOrder, stop = entryOrder + 1, target = entryOrder + 2;
    add('order', { id: entry, accountId: account, contractId: 7, action: 'Buy', ordStatus: 'Filled', timestamp: iso(start) }, start);
    add('order', { id: stop, accountId: account, contractId: 7, action: 'Sell', ordStatus: 'Canceled', parentId: entry, timestamp: iso(start) }, start);
    add('order', { id: target, accountId: account, contractId: 7, action: 'Sell', ordStatus: 'Filled', parentId: entry, timestamp: iso(start) }, start);
    for (const [order, type, priceValue, stopValue, at, kind] of [
      [entry, 'Limit', price, null, start, 'New'], [stop, 'Stop', null, price - 20, start + 1, 'New'],
      [target, 'Limit', price + 30, null, start + 2, 'New'], [stop, 'Stop', null, price - 10, start + 60_000, 'Modify'],
    ] as const) {
      const command = base + order * 10 + (kind === 'Modify' ? 5 : 0);
      add('command', { id: command, orderId: order, timestamp: iso(at), commandType: kind, commandStatus: 'ExecutionReportReceived' }, at);
      add('orderversion', { id: command, orderId: order, orderQty: 2, orderType: type, price: priceValue, stopPrice: stopValue }, at);
      add('executionreport', { id: command + 1, commandId: command, orderId: order, accountId: account, contractId: 7, timestamp: iso(at + 5),
        execType: kind === 'New' ? 'New' : 'Replaced', ordStatus: 'Working' }, at + 5);
    }
    const fillIn = base + 1, fillOut = base + 2;
    add('fill', { id: fillIn, orderId: entry, accountId: account, contractId: 7, action: 'Buy', qty: 2, price, timestamp: iso(start + 30_000) }, start + 30_000);
    add('position', { id: account * 100 + 7, accountId: account, contractId: 7, netPos: 2, timestamp: iso(start + 30_000) }, start + 30_000);
    add('fill', { id: fillOut, orderId: target, accountId: account, contractId: 7, action: 'Sell', qty: 2, price: price + 30, timestamp: iso(start + 120_000) }, start + 120_000);
    add('position', { id: account * 100 + 7, accountId: account, contractId: 7, netPos: 0, timestamp: iso(start + 120_000) }, start + 120_000);
    add('executionreport', { id: base + order(stop) , commandId: null, orderId: stop, accountId: account, contractId: 7, timestamp: iso(start + 120_001),
      execType: 'Canceled', ordStatus: 'Canceled' }, start + 120_001);
    for (const fill of [fillIn, fillOut]) add('fillfee', { id: fill, commission: 1.5, commissionCurrencyId: 1 }, start + 121_000);
    add('fillpair', { id: base + 9, buyFillId: fillIn, sellFillId: fillOut, qty: 2, buyPrice: price, sellPrice: price + 30, active: true }, start + 121_000);
    add('cashbalancelog', { id: base + 8, accountId: account, timestamp: iso(start + 121_000), currencyId: 1, cashChangeType: 'TradePaired', delta: 120, fillPairId: base + 9 }, start + 121_000);
  };
  const order = (id: number) => id;
  trade(1, 1_000_000, 100, T0 + 60_000, 20_000);
  trade(2, 2_000_000, 200, T0 + 70_000, 20_010);
  snapshot('k', T0 + 600_000);
  trade(1, 3_000_000, 300, T0 + 700_000, 20_050);
  trade(2, 4_000_000, 400, T0 + 710_000, 20_060);
  snapshot('s2', T0 + 1_200_000);
  return { events, add, K: T0 + 600_000 };
}

/** Produkce: nová evidence po posunu je živá; věcná změna archivované entity
 * ji v DB odarchivuje (trigger), takže se slije i s jejím starším stavem. */
function liveAfterAdvance(events: readonly JournalEvidence[], before: number, manifest: ReturnType<typeof journalCheckpointManifest>) {
  const appended = events.slice(before);
  const touched = new Set(appended.map(event => `${event.entityType}:${event.entity.id}`));
  const archivedEntities = new Set(manifest.entityKeys);
  return [...journalLiveAfterArchive(events.slice(0, before), manifest),
    ...events.slice(0, before).filter(event => archivedEntities.has(`${event.entityType}:${event.entity.id}`) && touched.has(`${event.entityType}:${event.entity.id}`)),
    ...appended];
}

function hitsFor(manifest: ReturnType<typeof journalCheckpointManifest>, live: readonly JournalEvidence[], at: number) {
  const refs = new Map(manifest.refs.map(ref => [`${ref.kind}:${ref.id}`, ref]));
  const check = journalLateEvidenceCheck(live, at, new Set([1, 2]));
  const hits = journalLateQueries(check).filter(query => refs.has(`${query.kind}:${query.id}`))
    .map(query => ({ ...query, fingerprint: refs.get(`${query.kind}:${query.id}`)!.fingerprint ?? null, epoch: 1 }));
  return journalLateEvidenceAt(check, hits);
}

describe('kontrolní bod živého deníku', () => {
  it('najde kolo snímků, kde jsou všechny účty flat, a bez pracujících příkazů', () => {
    const { events, K } = scenario();
    const captures = journalFlatCaptures(events);
    expect(captures.map(capture => capture.at)).toContain(K);
    expect(journalOrdersOpenSince(events, K)).toEqual([]);
  });

  it('okno od K dá totéž co plné přehrání, i po archivaci; vznik SL/TP i posun zůstanou', () => {
    const { events, K } = scenario();
    const full = buildJournalPositionEpisodes(events);
    const capture = journalFlatCaptures(events).find(item => item.at === K)!;
    const window = buildJournalPositionEpisodes(events, capture.window);
    expect(compareJournalWindows(full, window, K)).toEqual([]);
    const manifest = journalCheckpointManifest(events, K);
    const live = journalLiveAfterArchive(events, manifest);
    expect(live.length).toBeLessThan(events.length);
    const archived = buildJournalPositionEpisodes(live, capture.window);
    expect(compareJournalWindows(full, archived, K)).toEqual([]);
    const after = archived.episodes.filter(episode => episode.entryAt >= K);
    expect(after).toHaveLength(2);
    for (const episode of after) {
      expect(episode.history.protection.some(event => event.kind === 'sl' && event.operation === 'new')).toBe(true);
      expect(episode.history.protection.some(event => event.kind === 'sl' && event.operation === 'modify')).toBe(true);
      expect(episode.history.netPnl).not.toBeNull();
    }
    expect(hitsFor(manifest, live, K)).toBeNull();
  });

  it('identické opakování zmrazeného fillu (resync brokera) není pozdní evidence', () => {
    const { events, add, K } = scenario();
    const manifest = journalCheckpointManifest(events, K);
    const fill = events.find(event => event.entityType === 'fill' && Date.parse(String(event.entity.timestamp)) < K)!;
    add('fill', { ...fill.entity }, K + 900_000, 'snapshot');
    add('position', { id: 107, accountId: 1, contractId: 7, netPos: 0, timestamp: iso(T0 + 60_000 + 120_000) }, K + 900_001);
    const live = liveAfterAdvance(events, events.length - 2, manifest);
    expect(hitsFor(manifest, live, K)).toBeNull();
  });

  it.each([
    ['bust zmrazeného fillu', (s: ReturnType<typeof scenario>, fill: JournalEvidence) => s.add('fill', { ...fill.entity, active: false }, s.K + 900_000)],
    ['pozdní jiný poplatek', (s: ReturnType<typeof scenario>, fill: JournalEvidence) => s.add('fillfee', { id: Number(fill.entity.id), commission: 4, commissionCurrencyId: 1 }, s.K + 900_000, 'snapshot')],
    ['nový pár k zmrazenému fillu', (s: ReturnType<typeof scenario>, fill: JournalEvidence) => s.add('fillpair', { id: 99_999, buyFillId: Number(fill.entity.id), sellFillId: 1, qty: 1, active: true }, s.K + 900_000)],
    ['oprava obchodu brokerem', (s: ReturnType<typeof scenario>, fill: JournalEvidence) => s.add('executionreport', { id: 88_888, orderId: Number(fill.entity.orderId), accountId: 1, contractId: 7,
      timestamp: iso(s.K + 900_000), execType: 'TradeCorrect', ordStatus: 'Filled' }, s.K + 900_000)],
    ['zpožděný výpadek spojení', (s: ReturnType<typeof scenario>) => s.add('connection', { state: 'disconnected', reason: 'socket' }, s.K - 1_000, 'transport')],
    ['neznámý fill před K', (s: ReturnType<typeof scenario>) => s.add('fill', { id: 77_777, orderId: 100, accountId: 1, contractId: 7, action: 'Buy', qty: 1, price: 1, timestamp: iso(s.K - 5_000) }, s.K + 900_000)],
    ['neznámá stream pozice před K', (s: ReturnType<typeof scenario>) => s.add('position', { id: 107, accountId: 1, contractId: 7, netPos: 3, timestamp: iso(s.K - 5_000) }, s.K + 900_000)],
  ])('%s → K se vrátí zpět', (_label, mutate) => {
    const s = scenario();
    const manifest = journalCheckpointManifest(s.events, s.K);
    const fill = s.events.find(event => event.entityType === 'fill' && Date.parse(String(event.entity.timestamp)) < s.K)!;
    const before = s.events.length;
    mutate(s, fill);
    const live = liveAfterAdvance(s.events, before, manifest);
    const late = hitsFor(manifest, live, s.K);
    expect(late).not.toBeNull();
    // Buď vazba na zmrazený objekt (bod 1 se vrátí), nebo pozdní čas před K.
    expect(late!.epoch === 1 || (late!.at != null && late!.at < s.K)).toBe(true);
  });

  it('účet s historií, který v kole snímků K chyběl, znovu obchoduje → K se vrátí; jiný účet ne', () => {
    const s = scenario();
    const manifest = journalCheckpointManifest(s.events, s.K);
    const before = s.events.length;
    s.add('order', { id: 900, accountId: 2, contractId: 7, action: 'Buy', ordStatus: 'Filled', timestamp: iso(s.K + 1_500_000) }, s.K + 1_500_000);
    s.add('fill', { id: 901, orderId: 900, accountId: 2, contractId: 7, action: 'Buy', qty: 1, price: 20_100, timestamp: iso(s.K + 1_500_000) }, s.K + 1_500_000);
    const live = liveAfterAdvance(s.events, before, manifest);
    const refs = new Map(manifest.refs.map(ref => [`${ref.kind}:${ref.id}`, ref]));
    const late = (flat: number[]) => {
      const check = journalLateEvidenceCheck(live, s.K, new Set(flat));
      return journalLateEvidenceAt(check, journalLateQueries(check).filter(query => refs.has(`${query.kind}:${query.id}`))
        .map(query => ({ ...query, fingerprint: refs.get(`${query.kind}:${query.id}`)!.fingerprint ?? null, epoch: 1 })));
    };
    expect(late([1])).toEqual({ at: null, epoch: 1 });
    expect(late([1, 2])).toBeNull();
  });

  it('příkaz zadaný před K a vyplněný po něm: posun se odmítne (pracující příkaz / rozdíl)', () => {
    const { events, add, K } = scenario();
    add('order', { id: 500, accountId: 1, contractId: 7, action: 'Buy', ordStatus: 'Working', timestamp: iso(K - 30_000) }, K - 30_000);
    expect(journalOrdersOpenSince(events, K)).toEqual(['500']);
  });
});
