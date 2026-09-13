import { describe, expect, it } from 'vitest';
import { buildJournalPositionEpisodes } from '../lib/journalPositionEpisodes';
import { journalObservation, type JournalEntityType, type JournalEvidence } from '../lib/tradovateJournalEvidence';

const origin = Date.parse('2026-09-12T10:00:00Z');
const fixture = () => {
  let sequence = 0;
  const evidence: JournalEvidence[] = [];
  const add = (type: JournalEntityType, entity: Record<string, string | number | boolean>, at: number, source: 'stream' | 'snapshot' | 'transport' = 'stream') => {
    evidence.push({ ...journalObservation(type, entity, source, 'Updated', origin + at)!, id: String(++sequence),
      connectionId: 'conn', environment: 'demo', sessionId: 'one', sequence });
  };
  add('contract', { id: 1, name: 'MNQU6' }, 0);
  const flat = (account = 1, at = 0, source: 'stream' | 'snapshot' = 'stream') =>
    add('position', { id: account, accountId: account, contractId: 1, netPos: 0, timestamp: new Date(origin + at).toISOString() }, at, source);
  const fill = (id: number, side: 'Buy' | 'Sell', quantity: number, price: number, at: number, account = 1) => {
    add('order', { id, accountId: account, contractId: 1, action: side }, at);
    add('fill', { id, orderId: id, accountId: account, contractId: 1, action: side, qty: quantity, price, timestamp: new Date(origin + at).toISOString() }, at);
    add('fillfee', { id, commission: quantity, commissionCurrencyId: 840 }, at);
  };
  const pair = (id: number, buyFillId: number, sellFillId: number, qty: number, at = 3000) =>
    add('fillpair', { id, buyFillId, sellFillId, qty, active: true }, at);
  return { evidence, add, flat, fill, pair };
};

describe('position episodes from observed account exposure', () => {
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
