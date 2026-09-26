import { describe, expect, it } from 'vitest';
import { buildJournalPositionEpisodes } from '../lib/journalPositionEpisodes';
import { journalPositionWrite } from '../lib/journalTradeFacts';
import { journalObservation, type JournalEntityType, type JournalEvidence } from '../lib/tradovateJournalEvidence';

const origin = Date.parse('2026-09-12T10:00:00Z');
const fixture = () => {
  let sequence = 0;
  const evidence: JournalEvidence[] = [];
  const add = (type: JournalEntityType, entity: Record<string, string | number | boolean>, at: number, source: 'stream' | 'snapshot' | 'transport' = 'stream') => {
    evidence.push({ ...journalObservation(type, entity, source, 'Updated', origin + at)!, id: String(++sequence),
      connectionId: 'conn', environment: 'demo', sessionId: 'one', sequence });
  };
  add('currency', { id: 1, name: 'USD', symbol: '$' }, 0);
  add('contract', { id: 1, name: 'MNQU6' }, 0);
  const flat = (account = 1, at = 0, source: 'stream' | 'snapshot' = 'stream') =>
    add('position', { id: account, accountId: account, contractId: 1, netPos: 0, timestamp: new Date(origin + at).toISOString() }, at, source);
  const fill = (id: number, side: 'Buy' | 'Sell', quantity: number, price: number, at: number, account = 1) => {
    add('order', { id, accountId: account, contractId: 1, action: side }, at);
    add('fill', { id, orderId: id, accountId: account, contractId: 1, action: side, qty: quantity, price, timestamp: new Date(origin + at).toISOString() }, at);
    add('fillfee', { id, commission: quantity, commissionCurrencyId: 1 }, at);
  };
  const pair = (id: number, buyFillId: number, sellFillId: number, qty: number, at = 3000) =>
    add('fillpair', { id, buyFillId, sellFillId, qty, active: true }, at);
  return { evidence, add, flat, fill, pair };
};

describe('position episodes from observed account exposure', () => {
  // 23. 9. 2026: SL výstup 13 lotů se rozpadl na 1 + 1 + 11, poslední dva fills
  // ve stejné milisekundě. Broker ke každému poslal stav pozice (−11 a 0) se
  // stejným časem a zavřený obchod skončil jako „incomplete“ mimo Historii.
  const position = (f: ReturnType<typeof fixture>, netPos: number, at: number) =>
    f.add('position', { id: 1, accountId: 1, contractId: 1, netPos, timestamp: new Date(origin + at).toISOString() }, at);

  it('stavy pozice se stejným časem, které jsou cestou fills, obchod nezruší', () => {
    const f = fixture(); f.flat();
    f.fill(10, 'Sell', 13, 20000, 1000); position(f, -13, 1000);
    f.fill(11, 'Buy', 1, 19990, 2000); position(f, -12, 2000);
    f.fill(12, 'Buy', 1, 19990, 3000); f.fill(13, 'Buy', 11, 19991, 3000);
    position(f, -11, 3000); position(f, 0, 3000);
    const { episodes } = buildJournalPositionEpisodes(f.evidence);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ enteredQuantity: 13, exitedQuantity: 13, exitAt: origin + 3000,
      history: { position: { status: 'closed', openQuantity: 0 } } });
    expect(episodes[0].history.issues ?? []).not.toContain('conflicting-position-anchors');
  });

  it('stav mimo cestu fills ve stejné milisekundě dál přeruší pozici', () => {
    const f = fixture(); f.flat();
    f.fill(10, 'Sell', 13, 20000, 1000); position(f, -13, 1000);
    f.fill(11, 'Buy', 13, 19990, 3000);
    // −5 není stav, kterým by pozice prošla — rozpor, nevíme, co platí.
    position(f, -5, 3000); position(f, 0, 3000);
    const { episodes } = buildJournalPositionEpisodes(f.evidence);
    expect(episodes[0].history.position).toMatchObject({ status: 'incomplete' });
  });

  it('když konečný stav mezi stavy chybí, pozice se neuzavře', () => {
    const f = fixture(); f.flat();
    f.fill(10, 'Sell', 13, 20000, 1000); position(f, -13, 1000);
    f.fill(11, 'Buy', 1, 19990, 3000); f.fill(12, 'Buy', 12, 19991, 3000);
    // Jen mezistavy −13 a −12; stav po posledním fillu (0) broker nepotvrdil.
    position(f, -13, 3000); position(f, -12, 3000);
    const { episodes } = buildJournalPositionEpisodes(f.evidence);
    expect(episodes[0].history.position).toMatchObject({ status: 'incomplete' });
  });

  it('keeps scale-in and partial exits in one position with own weighted prices and fees', () => {
    const f = fixture(); f.flat();
    f.fill(10, 'Buy', 2, 20000, 1000); f.fill(11, 'Buy', 1, 20003, 1500);
    f.fill(12, 'Sell', 1, 20006, 2000); f.fill(13, 'Sell', 2, 20009, 3000);
    f.pair(1, 10, 12, 1); f.pair(2, 10, 13, 1); f.pair(3, 11, 13, 1);
    const result = buildJournalPositionEpisodes(f.evidence);
    expect(result.unassignedFillIds).toEqual([]);
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]).toMatchObject({ enteredQuantity: 3, exitedQuantity: 3, entryPrice: 20001, exitPrice: 20008,
      entryAt: origin + 1000, exitAt: origin + 3000, history: { grossPnl: 42, fees: 6, netPnl: 36,
        position: { status: 'closed', peakQuantity: 3, openQuantity: 0 } } });
    expect(result.episodes[0].history.fills).toHaveLength(4);
  });
  it('splits reversal quantity and commission without merging long and short', () => {
    const f = fixture(); f.flat();
    f.fill(10, 'Buy', 2, 20000, 1000); f.fill(11, 'Sell', 3, 20010, 2000); f.fill(12, 'Buy', 1, 20005, 3000);
    f.pair(1, 10, 11, 2); f.pair(2, 12, 11, 1);
    const { episodes } = buildJournalPositionEpisodes(f.evidence);
    expect(episodes.map(row => [row.direction, row.history.grossPnl, row.history.fees, row.history.netPnl])).toEqual([
      ['Long', 40, 4, 36], ['Short', 10, 2, 8],
    ]);
    expect(episodes[0].exitAt).toBe(episodes[1].entryAt);
    expect(episodes[0].history.fills[1].allocatedQuantity).toBe(2);
    expect(episodes[1].history.fills[0].allocatedQuantity).toBe(1);
  });
  it('does not call a partial exit the final close or claim final net PnL', () => {
    const f = fixture(); f.flat(); f.fill(10, 'Buy', 3, 20000, 1000); f.fill(11, 'Sell', 1, 20005, 2000); f.pair(1, 10, 11, 1);
    const [episode] = buildJournalPositionEpisodes(f.evidence).episodes;
    expect(episode.exitAt).toBeNull();
    expect(episode.history.position).toMatchObject({ status: 'open', openQuantity: 2 });
    expect(episode.history.netPnl).toBeNull();
  });
  it('does not invent a starting flat balance or backdate a current flat snapshot', () => {
    const f = fixture(); f.fill(10, 'Buy', 1, 20000, 1000); f.fill(11, 'Sell', 1, 20005, 2000); f.pair(1, 10, 11, 1);
    f.add('position', { id: 1, accountId: 1, contractId: 1, netPos: 0, timestamp: new Date(origin).toISOString() }, 3000, 'snapshot');
    const result = buildJournalPositionEpisodes(f.evidence);
    expect(result.episodes).toEqual([]); expect(result.unassignedFillIds).toEqual(['10', '11']);
  });
  it('does not treat an ordinary REST row or handshake ACK as complete initial state', () => {
    const f = fixture();
    f.add('connection', { state: 'starting' }, 0, 'transport');
    f.flat(1, 10, 'snapshot');
    f.add('connection', { state: 'synced' }, 20, 'transport');
    f.fill(10, 'Buy', 1, 20000, 1000); f.fill(11, 'Sell', 1, 20005, 2000); f.pair(1, 10, 11, 1);
    expect(buildJournalPositionEpisodes(f.evidence).episodes).toEqual([]);
    expect(buildJournalPositionEpisodes(f.evidence).unassignedFillIds).toEqual(['10', '11']);
  });
  it('uses a new flat anchor after a recording gap without attaching later fills to the old position', () => {
    const f = fixture(); f.flat(); f.fill(10, 'Buy', 2, 20000, 1000);
    f.add('connection', { state: 'disconnected' }, 1500, 'transport');
    f.add('connection', { state: 'synced' }, 2000, 'transport');
    f.fill(11, 'Sell', 2, 20005, 2500); f.flat(1, 3000);
    f.fill(12, 'Buy', 1, 20010, 4000); f.fill(13, 'Sell', 1, 20015, 5000); f.pair(1, 12, 13, 1, 5000);
    const result = buildJournalPositionEpisodes(f.evidence);
    expect(result.episodes.map(row => row.history.position?.status)).toEqual(['incomplete', 'closed']);
    expect(result.episodes[0].exitAt).toBeNull(); expect(result.episodes[0].history.netPnl).toBeNull();
    expect(result.unassignedFillIds).toEqual(['11']);
  });
  it('does not infer execution order from arrival order when opposite sides have the same timestamp', () => {
    const f = fixture(); f.flat(); f.fill(10, 'Buy', 1, 20000, 1000); f.fill(11, 'Sell', 1, 20005, 1000);
    const result = buildJournalPositionEpisodes(f.evidence);
    expect(result.episodes).toEqual([]); expect(result.unassignedFillIds).toEqual(['10', '11']);
    expect(result.issues).toContain('1:1:ambiguous-fill-order');
  });
  it('does not assign tied same-side reversal fills to old and new positions arbitrarily', () => {
    const f = fixture(); f.flat(); f.fill(10, 'Buy', 1, 20000, 1000);
    f.fill(11, 'Sell', 1, 20005, 2000); f.fill(12, 'Sell', 1, 20006, 2000);
    const result = buildJournalPositionEpisodes(f.evidence);
    expect(result.episodes[0].history.position?.status).toBe('incomplete');
    expect(result.unassignedFillIds).toEqual(['11', '12']);
  });
  it('keeps 12 accounts independent and rebuilds identically after duplicate/out-of-order delivery', () => {
    const f = fixture();
    for (let account = 1; account <= 12; account++) {
      f.flat(account); f.fill(account * 10, 'Buy', 1, 20000 + account, 1000 + account, account);
      f.fill(account * 10 + 1, 'Sell', 1, 20010 + account, 2000 + account, account);
      f.pair(account, account * 10, account * 10 + 1, 1);
    }
    const result = buildJournalPositionEpisodes(f.evidence);
    expect(result.episodes).toHaveLength(12);
    expect(new Set(result.episodes.map(row => row.accountId)).size).toBe(12);
    expect(result.episodes.every(row => row.history.netPnl === 18)).toBe(true);
    expect(buildJournalPositionEpisodes([...f.evidence].reverse().concat(f.evidence))).toEqual(result);
  });
  it('withholds closed PnL while a broker pair or its fees are missing', () => {
    const f = fixture(); f.flat(); f.fill(10, 'Buy', 1, 20000, 1000); f.fill(11, 'Sell', 1, 20010, 2000);
    expect(buildJournalPositionEpisodes(f.evidence).episodes[0].history.netPnl).toBeNull();
    f.pair(1, 10, 11, 1);
    const withoutFees = f.evidence.filter(row => row.entityType !== 'fillfee');
    expect(buildJournalPositionEpisodes(withoutFees).episodes[0].history).toMatchObject({ grossPnl: 20, fees: null, netPnl: null });
  });
});

describe('SL/TP přidané během obchodu samostatnou objednávkou', () => {
  // Objednávka + její verze potvrzená brokerem (New/Modify) v čase `at`.
  const protective = (f: ReturnType<typeof fixture>, order: number, side: 'Buy' | 'Sell', type: 'Stop' | 'Limit', quantity: number) => {
    let version = order * 10;
    f.add('order', { id: order, accountId: 1, contractId: 1, action: side }, 0);
    return (price: number, at: number, commandType: 'New' | 'Modify' = 'New') => {
      const id = ++version;
      f.add('orderversion', { id, orderId: order, orderType: type, orderQty: quantity, ...(type === 'Stop' ? { stopPrice: price } : { price }) }, at);
      f.add('command', { id, orderId: order, commandType, timestamp: new Date(origin + at).toISOString() }, at);
      f.add('executionreport', { id: id + 5000, commandId: id, orderId: order, execType: commandType === 'New' ? 'New' : 'Replaced',
        timestamp: new Date(origin + at).toISOString() }, at);
    };
  };
  const long3 = () => {
    const f = fixture(); f.flat();
    f.fill(10, 'Buy', 3, 20000, 1000);
    return f;
  };

  it('stop přidaný po vstupu a jeho posuny patří k obchodu', () => {
    const f = long3();
    const stop = protective(f, 50, 'Sell', 'Stop', 3);
    stop(19980, 60_000); stop(19990, 120_000, 'Modify');
    f.fill(51, 'Sell', 3, 19990, 180_000); f.pair(1, 10, 51, 3, 180_000);
    const [episode] = buildJournalPositionEpisodes(f.evidence).episodes;
    const levels = episode.history.protection.filter(event => event.status === 'confirmed').map(event => [event.kind, event.price, event.source]);
    expect(levels).toEqual([['sl', 19980, 'standalone'], ['sl', 19990, 'standalone']]);
    expect(episode.history.issues).not.toContain('protection-history-unavailable');
  });

  it('limit nad longem je TP', () => {
    const f = long3();
    protective(f, 60, 'Sell', 'Limit', 3)(20050, 30_000);
    const [episode] = buildJournalPositionEpisodes(f.evidence).episodes;
    expect(episode.history.protection.map(event => [event.kind, event.price])).toEqual([['tp', 20050]]);
  });

  it('do původního SL (riziko, R) se počítá jen stop zadaný hned se vstupem', () => {
    const late = long3();
    protective(late, 50, 'Sell', 'Stop', 3)(19990, 60_000);
    const [lateEpisode] = buildJournalPositionEpisodes(late.evidence).episodes;
    expect(journalPositionWrite({ ...lateEpisode, journalAccountId: 'j' }).facts.stopLoss).toBeUndefined();
    const quick = long3();
    protective(quick, 50, 'Sell', 'Stop', 3)(19980, 1_800);
    const [quickEpisode] = buildJournalPositionEpisodes(quick.evidence).episodes;
    expect(journalPositionWrite({ ...quickEpisode, journalAccountId: 'j' }).facts.stopLoss).toBe(19980);
  });

  it('stop na víc kusů než pozice (stop-and-reverse), na stejné straně nebo z doby před vstupem se nepřiřadí', () => {
    const f = fixture(); f.flat();
    protective(f, 70, 'Sell', 'Stop', 3)(19950, 500);
    f.fill(10, 'Buy', 3, 20000, 1000);
    protective(f, 71, 'Sell', 'Stop', 5)(19980, 60_000);
    protective(f, 72, 'Buy', 'Stop', 3)(20020, 60_000);
    const [episode] = buildJournalPositionEpisodes(f.evidence).episodes;
    expect(episode.history.protection).toEqual([]);
  });
});
