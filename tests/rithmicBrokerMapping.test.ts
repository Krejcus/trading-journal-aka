import { describe, expect, it } from 'vitest';
import {
  RithmicOrderBook,
  rithmicContractRoot,
  rithmicExchangeForSymbol,
  rithmicPriceType,
} from '../services/rithmic/rithmicBrokerMapping';
import type { RithmicOrderUpdate } from '../services/rithmic/rithmicClient';

const ACCOUNT = 9_000_000_000_001;

function book() {
  return new RithmicOrderBook({ accountNumber: (id) => (id === '1875' ? ACCOUNT : null), now: () => 1_000 });
}

let seq = 0;
function update(patch: Partial<RithmicOrderUpdate>): RithmicOrderUpdate {
  seq += 1;
  return {
    source: 'exchange', notifyType: 'STATUS', isSnapshot: false, accountId: '1875', basketId: 'B1', originalBasketId: '',
    linkedBasketIds: '', userTag: 'tag-1', symbol: 'MNQZ6', exchange: 'CME', side: 'BUY', priceType: 'LIMIT', bracketType: '',
    status: 'open', completionReason: '', reportType: '', quantity: 2, price: 25000, triggerPrice: null, fillPrice: null, fillSize: null,
    fillId: '', avgFillPrice: null, totalFillSize: null, totalUnfilledSize: null, text: '', gatewayAt: 5_000 + seq,
    receivedAt: 6_000 + seq, raw: { sequence_number: String(seq) }, ...patch,
  };
}

describe('symboly a typy', () => {
  it('určí root a burzu jen u známých kontraktů', () => {
    expect(rithmicContractRoot('MNQZ6')).toBe('MNQ');
    expect(rithmicContractRoot('ESH27')).toBe('ES');
    expect(rithmicContractRoot('MNQ')).toBeNull();
    expect(rithmicExchangeForSymbol('MNQZ6')).toBe('CME');
    expect(rithmicExchangeForSymbol('MYMZ6')).toBe('CBOT');
    expect(rithmicExchangeForSymbol('MGCZ6')).toBe('COMEX');
    expect(rithmicExchangeForSymbol('FDAXZ6')).toBeNull();
    expect(rithmicPriceType('Stop')).toBe('STOP_MARKET');
  });
});

describe('RithmicOrderBook', () => {
  it('pending → working → dílčí fill → filled; filly jsou dílčí množství', () => {
    const b = book();
    expect(b.apply(update({ source: 'rithmic', notifyType: 'ORDER_RCVD_FROM_CLNT' })).order?.status).toBe('pending');
    expect(b.apply(update({ source: 'rithmic', notifyType: 'ORDER_SENT_TO_EXCH' })).order).toBeUndefined();
    expect(b.apply(update({ notifyType: 'STATUS' })).order).toMatchObject({ status: 'working', orderType: 'Limit', limitPrice: 25000, tag: 'tag-1', accountId: ACCOUNT });
    const partial = b.apply(update({ notifyType: 'FILL', fillId: 'F1', fillSize: 1, fillPrice: 24999.75, totalFillSize: 1, totalUnfilledSize: 1 }));
    expect(partial.order).toMatchObject({ status: 'working', filledQuantity: 1 });
    expect(partial.fill).toMatchObject({ fillId: `rithmic:${ACCOUNT}:F1`, quantity: 1, price: 24999.75, side: 'Buy', brokerOrderId: 'B1' });
    const done = b.apply(update({ notifyType: 'FILL', fillId: 'F2', fillSize: 1, fillPrice: 25000, totalFillSize: 2, totalUnfilledSize: 0 }));
    expect(done.order).toMatchObject({ status: 'filled', filledQuantity: 2 });
    expect(done.fill?.quantity).toBe(1);
  });

  it('stejná exekuce podruhé nevytvoří druhý fill', () => {
    const b = book();
    b.apply(update({ notifyType: 'STATUS' }));
    const fill = update({ notifyType: 'FILL', fillId: 'F1', fillSize: 2, fillPrice: 25000, totalFillSize: 2 });
    expect(b.apply(fill).fill).toBeDefined();
    const again = b.apply({ ...fill, raw: { sequence_number: 'x' } });
    expect(again.fill).toBeUndefined();
    expect(b.get(ACCOUNT, 'B1')?.filledQuantity).toBe(2);
  });

  it('FILL bez ID exekuce nevytvoří fill a vyžádá si pozornost', () => {
    const b = book();
    b.apply(update({ notifyType: 'STATUS' }));
    const delta = b.apply(update({ notifyType: 'FILL', fillSize: 2, fillPrice: 25000, totalFillSize: 2 }));
    expect(delta.fill).toBeUndefined();
    expect(delta.attention).toMatch(/bez ID/);
    // bez exekuce se stav neposune: musí se dohledat čtením
    expect(delta.order).toBeUndefined();
    expect(b.get(ACCOUNT, 'B1')).toMatchObject({ status: 'working', filledQuantity: 0 });
  });

  it('konečný stav se neoživí a vyplněné množství neklesne', () => {
    const b = book();
    b.apply(update({ notifyType: 'STATUS' }));
    b.apply(update({ notifyType: 'FILL', fillId: 'F1', fillSize: 1, fillPrice: 25000, totalFillSize: 1 }));
    expect(b.apply(update({ notifyType: 'CANCEL', totalFillSize: 1 })).order).toMatchObject({ status: 'canceled', filledQuantity: 1 });
    expect(b.apply(update({ notifyType: 'STATUS', totalFillSize: 0 })).order).toBeUndefined();
    expect(b.apply(update({ source: 'rithmic', notifyType: 'OPEN_PENDING' })).order).toBeUndefined();
    expect(b.get(ACCOUNT, 'B1')).toMatchObject({ status: 'canceled', filledQuantity: 1 });
  });

  it('odmítnutí burzou nese důvod', () => {
    const b = book();
    const delta = b.apply(update({ notifyType: 'REJECT', text: 'Price out of range' }));
    expect(delta.order).toMatchObject({ status: 'rejected', rejectReason: 'Price out of range' });
  });

  it('neznámý typ příkazu je Unsupported a čtení nespadne', () => {
    const b = book();
    const delta = b.apply(update({ priceType: 'UNKNOWN_5', price: null, triggerPrice: 25010 }));
    expect(delta.order).toMatchObject({ orderType: 'Unsupported', brokerOrderType: 'UNKNOWN_5', stopPrice: 25010, status: 'working' });
    expect(b.apply(update({ basketId: 'B9', priceType: '' })).order).toMatchObject({ orderType: 'Unsupported', brokerOrderType: 'UNSPECIFIED' });
  });

  it('cokoli z bracketu je Unsupported (verze 0 brackety neumí) a vazby zůstanou', () => {
    const b = book();
    const leg = b.apply(update({ basketId: 'B2', originalBasketId: 'B1', linkedBasketIds: 'B1,B3', side: 'SELL', priceType: 'STOP_MARKET', price: null, triggerPrice: 24990 }));
    expect(leg.order).toMatchObject({ orderType: 'Unsupported', brokerOrderType: 'BRACKET:LEG', side: 'Sell', stopPrice: 24990 });
    expect(leg.order?.parentOrderId).toBeUndefined();
    expect(leg.order?.linkedOrderId).toBeUndefined();
    const parent = b.apply(update({ basketId: 'B5', bracketType: 'TARGET_AND_STOP_STATIC' }));
    expect(parent.order).toMatchObject({ orderType: 'Unsupported', brokerOrderType: 'BRACKET:TARGET_AND_STOP_STATIC' });
    // pozdější notifikace bez údaje o bracketu z něj obyčejný příkaz neudělá
    expect(b.apply(update({ basketId: 'B5', notifyType: 'MODIFY', price: 24000 })).order).toMatchObject({ orderType: 'Unsupported' });
  });

  it('neúplná první notifikace se nevyšle; stranu ani množství si nedomýšlíme', () => {
    const b = book();
    expect(b.apply(update({ side: null })).order).toBeUndefined();
    expect(b.apply(update({ basketId: 'B2', quantity: null }))).toMatchObject({ attention: expect.stringMatching(/neúplná/), needsRead: 'incomplete' });
    expect(b.apply(update({ basketId: 'B3', symbol: '' })).order).toBeUndefined();
    expect(b.list(ACCOUNT)).toEqual([]);
  });

  it('po konečném stavu se příkaz znovu nevyšle a jeho verze se nezmění', () => {
    const b = book();
    b.apply(update({ notifyType: 'STATUS' }));
    const canceled = b.apply(update({ notifyType: 'CANCEL' })).order!;
    expect(b.apply(update({ source: 'rithmic', notifyType: 'COMPLETE', completionReason: 'C' }))).toEqual({});
    expect(b.apply(update({ source: 'rithmic', notifyType: 'COMPLETE', completionReason: 'FA' }))).toEqual({});
    expect(b.apply(update({ notifyType: 'CANCEL', text: 'znovu' })).order).toBeUndefined();
    expect(b.get(ACCOUNT, 'B1')?.sourceVersion).toBe(canceled.sourceVersion);
  });

  it('COMPLETE od Rithmicu: FA a R = odmítnuto, C = zrušeno, F čeká na exekuci z burzy', () => {
    const b = book();
    // odmítnutí RMS: burza příkaz nikdy neviděla (změřená sekvence)
    b.apply(update({ source: 'rithmic', notifyType: 'ORDER_RCVD_FROM_CLNT', basketId: 'R1', quantity: 500 }));
    expect(b.apply(update({ source: 'rithmic', notifyType: 'COMPLETE', basketId: 'R1', completionReason: 'FA', text: 'Rejected at RMS' })).order)
      .toMatchObject({ status: 'rejected', rejectReason: 'Rejected at RMS' });
    b.apply(update({ basketId: 'R2', notifyType: 'STATUS' }));
    expect(b.apply(update({ source: 'rithmic', notifyType: 'COMPLETE', basketId: 'R2', completionReason: 'R' })).order?.status).toBe('rejected');
    b.apply(update({ basketId: 'R3', notifyType: 'STATUS' }));
    expect(b.apply(update({ source: 'rithmic', notifyType: 'COMPLETE', basketId: 'R3', completionReason: 'C' })).order?.status).toBe('canceled');
    // F bez množství před burzovním FILL: stav se neposune, jen se hlídá lhůta
    b.apply(update({ basketId: 'R4', notifyType: 'STATUS' }));
    const early = b.apply(update({ source: 'rithmic', notifyType: 'COMPLETE', basketId: 'R4', completionReason: 'F' }));
    expect(early).toEqual({ awaitingFill: true });
    expect(b.get(ACCOUNT, 'R4')?.status).toBe('working');
    expect(b.fillGap(ACCOUNT, 'R4')).toBe(2);
    expect(b.apply(update({ basketId: 'R4', notifyType: 'FILL', fillId: 'F4', fillSize: 2, fillPrice: 25000, totalFillSize: 2 })).fill?.quantity).toBe(2);
    expect(b.fillGap(ACCOUNT, 'R4')).toBe(0);
    // F s plným množstvím před FILL: příkaz je vyplněný, fill dorazí zvlášť
    b.apply(update({ basketId: 'R5', notifyType: 'STATUS' }));
    expect(b.apply(update({ source: 'rithmic', notifyType: 'COMPLETE', basketId: 'R5', completionReason: 'F', totalFillSize: 2 })).order?.status).toBe('filled');
    expect(b.apply(update({ basketId: 'R5', notifyType: 'FILL', fillId: 'F5', fillSize: 2, fillPrice: 25000, totalFillSize: 2 })).fill?.quantity).toBe(2);
  });

  it('pozdní dílčí fill po zrušení vydá fill, ale verzi konečného stavu nezmění', () => {
    const b = book();
    b.apply(update({ notifyType: 'STATUS' }));
    const canceled = b.apply(update({ notifyType: 'CANCEL' })).order!;
    const late = b.apply(update({ notifyType: 'FILL', fillId: 'F1', fillSize: 1, fillPrice: 25000, totalFillSize: 1 }));
    expect(late.fill?.quantity).toBe(1);
    expect(late.order).toMatchObject({ status: 'canceled', filledQuantity: 1, sourceVersion: canceled.sourceVersion });
  });

  it('fill a zrušení se nezahodí kvůli staršímu času brány', () => {
    const b = book();
    b.apply(update({ notifyType: 'STATUS', gatewayAt: 5_000 }));
    b.apply(update({ source: 'rithmic', notifyType: 'OPEN', gatewayAt: 5_010 }));
    const fill = b.apply(update({ notifyType: 'FILL', fillId: 'F1', fillSize: 1, fillPrice: 25000, totalFillSize: 1, gatewayAt: 5_008 }));
    expect(fill.fill?.quantity).toBe(1);
    expect(b.apply(update({ notifyType: 'CANCEL', totalFillSize: 1, gatewayAt: 5_001 })).order?.status).toBe('canceled');
    // pozdní dosud neviděný fill po zrušení se taky vyšle
    expect(b.apply(update({ notifyType: 'FILL', fillId: 'F2', fillSize: 1, fillPrice: 25000, totalFillSize: 2, gatewayAt: 4_000 })).fill?.quantity).toBe(1);
  });

  it('první FILL neznámého příkazu: úplný vydá fill, neúplný jen pozornost a exekuce se neztratí', () => {
    const b = book();
    const full = b.apply(update({ basketId: 'N1', notifyType: 'FILL', fillId: 'F9', fillSize: 2, fillPrice: 25000, totalFillSize: 2 }));
    expect(full.fill?.quantity).toBe(2);
    expect(full.order?.status).toBe('filled');
    const partialInfo = update({ basketId: 'N2', notifyType: 'FILL', fillId: 'F10', fillSize: 1, fillPrice: 25000, totalFillSize: 1, side: null });
    expect(b.apply(partialInfo).attention).toMatch(/neúplná/);
    // tatáž exekuce později s úplnými údaji se vydá (deduplikace ji nespolkla)
    expect(b.apply({ ...partialInfo, side: 'BUY' }).fill?.quantity).toBe(1);
  });

  it('nepotvrzená změna z Rithmicu tvar příkazu nezmění', () => {
    const b = book();
    b.apply(update({ notifyType: 'STATUS' }));
    expect(b.apply(update({ source: 'rithmic', notifyType: 'MODIFY_RCVD_FROM_CLNT', price: 24000, quantity: 5 })).order).toBeUndefined();
    expect(b.apply(update({ source: 'rithmic', notifyType: 'MODIFICATION_FAILED' })).attention).toMatch(/MODIFICATION_FAILED/);
    expect(b.get(ACCOUNT, 'B1')).toMatchObject({ limitPrice: 25000, quantity: 2 });
    // ani „MODIFIED" od Rithmicu tvar nemění — rozhoduje jen burza (opožděná 351 by vrátila starou cenu)
    expect(b.apply(update({ notifyType: 'MODIFY', price: 24990 })).order?.limitPrice).toBe(24990);
    expect(b.apply(update({ source: 'rithmic', notifyType: 'MODIFIED', price: 25000 })).order).toBeUndefined();
    expect(b.apply(update({ source: 'rithmic', notifyType: 'OPEN', price: 25000 })).order).toBeUndefined();
    expect(b.get(ACCOUNT, 'B1')?.limitPrice).toBe(24990);
  });

  it('verze je funkcí stavu: stejná ze snímku i ze streamu, u konečného stavu se nemění', () => {
    const b = book();
    const live = b.apply(update({ notifyType: 'STATUS' })).order!;
    const snap = b.composeSnapshotRow(ACCOUNT, update({ isSnapshot: true, notifyType: 'STATUS', gatewayAt: 99_000 }))!;
    expect(snap.sourceVersion).toBe(live.sourceVersion);
    const canceled = b.apply(update({ notifyType: 'CANCEL' })).order!;
    const again = b.replaceFromSnapshot(ACCOUNT, [update({ isSnapshot: true, status: 'cancelled', price: 1, gatewayAt: 99_000 })]).orders[0];
    expect(again).toEqual(canceled);
  });

  it('neúplný řádek snímku snímek odmítne', () => {
    const b = book();
    expect(() => b.composeSnapshotRow(ACCOUNT, update({ isSnapshot: true, basketId: 'S1', side: null }))).toThrow(/neúplný/);
    expect(() => b.replaceFromSnapshot(ACCOUNT, [update({ isSnapshot: true, basketId: 'S2', quantity: null })])).toThrow(/neúplný/);
    expect(b.list(ACCOUNT)).toEqual([]);
  });

  it('posun ceny je změna, stejný stav podruhé ne', () => {
    const b = book();
    b.apply(update({ notifyType: 'STATUS' }));
    expect(b.apply(update({ notifyType: 'STATUS' })).order).toBeUndefined();
    expect(b.apply(update({ notifyType: 'MODIFY', price: 24999 })).order).toMatchObject({ status: 'working', limitPrice: 24999 });
  });

  it('selhání změny/zrušení a COMPLETE bez důvodu stav nemění a chtějí ověření', () => {
    const b = book();
    b.apply(update({ notifyType: 'STATUS' }));
    expect(b.apply(update({ notifyType: 'NOT_CANCELLED', text: 'too late' }))).toEqual({ attention: 'NOT_CANCELLED u příkazu B1: too late' });
    expect(b.apply(update({ source: 'rithmic', notifyType: 'MODIFICATION_FAILED' })).attention).toMatch(/MODIFICATION_FAILED/);
    const complete = b.apply(update({ source: 'rithmic', notifyType: 'COMPLETE', completionReason: 'XX' }));
    expect(complete.attention).toMatch(/neznámým důvodem/);
    expect(complete.needsRead).toBe('unknown-complete');
    expect(b.get(ACCOUNT, 'B1')?.status).toBe('working');
  });

  it('cizí účet, chybějící ID a snímek nevytvoří živou událost', () => {
    const b = book();
    expect(b.apply(update({ accountId: 'JINY' })).attention).toMatch(/neznámý účet/);
    expect(b.apply(update({ basketId: '' })).attention).toMatch(/bez basket_id/);
    expect(b.apply(update({ isSnapshot: true }))).toEqual({});
    expect(b.list(ACCOUNT)).toEqual([]);
  });

  it('snímek je baseline bez fillů; aktivní příkaz chybějící ve snímku se nezruší, jen ohlásí', () => {
    const b = book();
    b.apply(update({ basketId: 'B1', notifyType: 'STATUS' }));
    b.apply(update({ basketId: 'B2', notifyType: 'STATUS' }));
    b.apply(update({ basketId: 'B3', notifyType: 'CANCEL' }));
    const result = b.replaceFromSnapshot(ACCOUNT, [
      update({ basketId: 'B2', isSnapshot: true, price: 24990 }),
      update({ basketId: 'B7', isSnapshot: true, userTag: 'cizi', quantity: 1, totalFillSize: 1, status: 'complete' }),
      update({ basketId: 'B8', isSnapshot: true, accountId: 'JINY' }),
    ]);
    expect(result.missingActive.map((o) => o.brokerOrderId)).toEqual(['B1']);
    expect(b.get(ACCOUNT, 'B1')?.status).toBe('working');
    expect(b.get(ACCOUNT, 'B2')).toMatchObject({ status: 'working', limitPrice: 24990 });
    expect(b.get(ACCOUNT, 'B7')).toMatchObject({ status: 'filled', tag: 'cizi' });
    expect(b.get(ACCOUNT, 'B3')?.status).toBe('canceled');
    expect(b.get(ACCOUNT, 'B8')).toBeNull();
  });

  it('stav řádku snímku určuje text stavu, ne typ notifikace', () => {
    const b = book();
    const row = (patch: Partial<RithmicOrderUpdate>) => b.composeSnapshotRow(ACCOUNT, update({ isSnapshot: true, basketId: `S${seq}`, ...patch }));
    expect(row({ status: 'open' })?.status).toBe('working');
    expect(row({ status: 'Cancel pending' })?.status).toBe('pending');
    // stop čekající na spuštění je pracující (potvrzená) ochrana
    expect(row({ status: 'trigger pending', priceType: 'STOP_MARKET', price: null, triggerPrice: 24990 })?.status).toBe('working');
    expect(row({ status: 'modified, trigger pending', priceType: 'STOP_MARKET', price: null, triggerPrice: 24990 })?.status).toBe('working');
    expect(row({ status: 'complete', notifyType: 'REJECT', text: 'Illegal Price' })).toMatchObject({ status: 'rejected', rejectReason: 'Illegal Price' });
    expect(row({ source: 'rithmic', notifyType: 'COMPLETE', status: 'complete', completionReason: 'FA', text: 'Rejected at RMS' })).toMatchObject({ status: 'rejected' });
    expect(() => row({ status: 'neco pending' })).toThrow(/nejde určit/);
    expect(row({ status: 'cancelled' })?.status).toBe('canceled');
    expect(row({ status: 'complete', totalFillSize: 2 })?.status).toBe('filled');
    expect(row({ status: 'complete', completionReason: 'C', totalFillSize: 1 })).toMatchObject({ status: 'canceled', filledQuantity: 1 });
    // tvar změřený na Rithmic Test: complete + report_type cancel
    expect(row({ status: 'complete', reportType: 'cancel', notifyType: 'CANCEL', totalFillSize: 0 })?.status).toBe('canceled');
    expect(row({ status: 'complete', completionReason: 'FA', text: 'risk' })).toMatchObject({ status: 'rejected', rejectReason: 'risk' });
  });

  it('chybějící exekuce: rozdíl vyplněného množství proti vyslaným fillům', () => {
    const b = book();
    b.apply(update({ notifyType: 'STATUS', quantity: 3 }));
    expect(b.fillGap(ACCOUNT, 'B1')).toBe(0);
    // Rithmic hlásí vyplnění celé, z burzy přišel jen jeden kus
    b.apply(update({ source: 'rithmic', notifyType: 'COMPLETE', completionReason: 'F', totalFillSize: 3, quantity: 3 }));
    expect(b.fillGap(ACCOUNT, 'B1')).toBe(3);
    b.apply(update({ notifyType: 'FILL', fillId: 'F1', fillSize: 1, fillPrice: 25000, totalFillSize: 1, quantity: 3 }));
    expect(b.fillGap(ACCOUNT, 'B1')).toBe(2);
    b.apply(update({ notifyType: 'FILL', fillId: 'F2', fillSize: 2, fillPrice: 25000, totalFillSize: 3, quantity: 3 }));
    expect(b.fillGap(ACCOUNT, 'B1')).toBe(0);
    // výchozí stav: vyplněný příkaz ze snímku nic nedluží
    b.replaceFromSnapshot(ACCOUNT, [update({ basketId: 'S1', isSnapshot: true, status: 'complete', notifyType: 'FILL', totalFillSize: 2 })], new Set(), { baseline: true });
    expect(b.fillGap(ACCOUNT, 'S1')).toBe(0);
    // příkaz poprvé viděný ve snímku až za běhu: jeho exekuce jádru chybí
    b.replaceFromSnapshot(ACCOUNT, [update({ basketId: 'S2', isSnapshot: true, status: 'complete', notifyType: 'FILL', totalFillSize: 2 })]);
    expect(b.fillGap(ACCOUNT, 'S2')).toBe(2);
    // snímek zvýší vyplnění známého pracujícího příkazu: taky chybí
    b.apply(update({ basketId: 'W1', notifyType: 'STATUS' }));
    const result = b.replaceFromSnapshot(ACCOUNT, [update({ basketId: 'W1', isSnapshot: true, status: 'complete', notifyType: 'FILL', totalFillSize: 2 })]);
    expect(b.fillGap(ACCOUNT, 'W1')).toBe(2);
    expect(result.changed.map((o) => `${o.brokerOrderId}:${o.status}`)).toEqual(['W1:filled']);
    expect(result.orders.map((o) => o.brokerOrderId)).toEqual(['W1']);
  });

  it('neznámý stav ve snímku snímek odmítne a knihu nezmění', () => {
    const b = book();
    b.apply(update({ basketId: 'B1', notifyType: 'STATUS' }));
    expect(() => b.replaceFromSnapshot(ACCOUNT, [
      update({ basketId: 'B1', isSnapshot: true, price: 1 }),
      update({ basketId: 'B2', isSnapshot: true, status: 'divny stav' }),
    ])).toThrow(/nejde určit/);
    expect(() => b.composeSnapshotRow(ACCOUNT, update({ basketId: 'B4', isSnapshot: true, status: 'complete' }))).toThrow(/nejde určit/);
    expect(b.get(ACCOUNT, 'B1')?.limitPrice).toBe(25000);
    expect(b.get(ACCOUNT, 'B2')).toBeNull();
  });

  it('řádek snímku, ke kterému přišla živá notifikace, se přeskočí', () => {
    const b = book();
    b.apply(update({ basketId: 'B1', notifyType: 'MODIFY', price: 24990 }));
    const result = b.replaceFromSnapshot(ACCOUNT, [update({ basketId: 'B1', isSnapshot: true, price: 25000, gatewayAt: 1 })], new Set(['B1']));
    expect(b.get(ACCOUNT, 'B1')?.limitPrice).toBe(24990);
    expect(result.missingActive).toEqual([]);
  });
});
