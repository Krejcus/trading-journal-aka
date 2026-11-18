// Telefonní graf nad místní službou Rithmicu: čisté převody (most příkazů, kotace, štítek režimu, karty stavů).
import { describe, expect, it, vi } from 'vitest';
import {
  rithmicPhoneAttachRefusal, rithmicPhoneBridge, rithmicPhoneCards, rithmicPhoneCloseText, rithmicPhoneModeLabel, rithmicPhoneQuote, rithmicPhoneWaiting,
  type RithmicPhoneBridgeInput,
} from '../lib/rithmicPhoneBridge';
import type { LiveChartPosition, LiveChartPositionSummary } from '../lib/liveChartPosition';
import type { BareLeaderTrade } from '../lib/manualBareClose';
import { livePhoneBareMarket } from '../lib/livePhoneOrders';

const summary = (over: Partial<LiveChartPositionSummary> = {}): LiveChartPositionSummary => ({
  kind: 'position', side: 'long', quantity: 2, entry: 25_000, entryType: null, openPnl: 10, mark: 25_002.5, stop: 24_980, target: 25_040,
  protection: '', accounts: 1, scopeLabel: null, leader: { accountId: 1, quantity: 2, entry: 25_000 }, rows: [], ...over,
} as LiveChartPositionSummary);
const position = (value: LiveChartPositionSummary | null): LiveChartPosition => ({ key: 'k', symbol: 'MNQZ6', lines: [], summary: value, issue: null });

const input = (over: Partial<RithmicPhoneBridgeInput> = {}): RithmicPhoneBridgeInput => ({
  readOnly: false, blocked: null, entryBlockedReason: null, maxContracts: 3, symbol: 'MNQZ6', averagePrice: 25_000, scaleIn: null,
  position: position(summary()), bareLegTrade: null, soloAccountId: 1,
  onPlaceEntry: vi.fn(), onManageEntry: vi.fn(async () => ({ type: 'leader-order-managed' as const, operationId: 'manage:x', action: 'move-stop' as const, status: 'acknowledged' as const, checkedAt: 1, blockers: [] })),
  onBareLeg: vi.fn(), closeNow: vi.fn(async () => ({ status: 'sent' as const, text: null })), ...over,
});

describe('most příkazů telefonu', () => {
  it('účet jen pro čtení most nemá', () => {
    expect(rithmicPhoneBridge(input({ readOnly: true }))).toBeNull();
  });

  it('schopnosti jako Rithmic graf na PC; kontrakt, strop a průměr ze služby', () => {
    const bridge = rithmicPhoneBridge(input())!;
    expect(bridge).toMatchObject({
      blockedReason: null, marketSupported: true, bareSupported: true, barePendingSupported: true, pendingLegs: true, moveLimit: true, moveBareEntry: true,
      closeSupported: true, maxContracts: 3, frontContract: 'MNQZ6', entryAvg: 25_000, leaderAccountId: 1,
    });
    // Nic z kopírky: žádný sdílený zámek, náhled u workeru, skupinové limity ani „Zrušit čekající".
    for (const key of ['commandLockRef', 'preview', 'groupLimitMove', 'groupLimitStateHash', 'bareLimitSupported', 'closeBare', 'bareClose', 'cancelPendingEntries', 'bareEntry'])
      expect(bridge).not.toHaveProperty(key);
  });

  it('incident služby blokuje nové vstupy a má přednost před běžným důvodem', () => {
    expect(rithmicPhoneBridge(input({ blocked: 'Pozice bez ochrany.', entryBlockedReason: 'Ceny stojí.' }))!.blockedReason).toBe('Nové vstupy stojí: Pozice bez ochrany.');
    expect(rithmicPhoneBridge(input({ entryBlockedReason: 'Účet je v režimu jen pro zavírání.' }))!.blockedReason).toBe('Účet je v režimu jen pro zavírání.');
  });

  it('pozice lišty: otevřená pozice bez „attach" (nohy jdou po jedné), čekající vstup se netváří jako pozice', () => {
    expect(rithmicPhoneBridge(input())!.position).toEqual({ side: 'long', quantity: 2, symbol: 'MNQZ6', bareEntryOperationId: null, pending: null });
    const pending = rithmicPhoneBridge(input({ position: position(summary({ kind: 'pending', side: 'short', quantity: 1, entry: 25_010, entryType: 'Limit', leader: { accountId: 1, quantity: 1, entry: 25_010 } })) }))!.position;
    expect(pending).toEqual({ side: 'short', quantity: 1, symbol: 'MNQZ6', bareEntryOperationId: null, pending: { type: 'Limit', price: 25_010 } });
    expect(rithmicPhoneBridge(input({ position: position(null) }))!.position).toBeNull();
    expect(rithmicPhoneBridge(input({ position: null }))!.position).toBeNull();
  });

  it('SL/TP po jedné jen s podkladem služby; attach nic neodešle a vrátí odmítnutí', async () => {
    expect(rithmicPhoneBridge(input())).not.toHaveProperty('bareLeg');
    const legTrade = { entryOperationId: 'rithmic:MNQZ6', symbol: 'MNQZ6', side: 'Buy', quantity: 2, referencePrice: 25_000 } as BareLeaderTrade;
    const onBareLeg = vi.fn();
    const given = input({ bareLegTrade: legTrade, onBareLeg });
    const bridge = rithmicPhoneBridge(given)!;
    expect(bridge.bareLegTrade).toBe(legTrade);
    expect(bridge.bareLeg).toBe(onBareLeg);
    const result = await bridge.attach({ entryOperationId: 'x', symbol: 'MNQZ6', quantity: 2, expectPrice: 25_000, stopLoss: 24_980, takeProfit: 25_040 });
    expect(result.status).toBe('blocked');
    expect(result.blockers[0].text).toMatch(/po jedné/);
    expect(onBareLeg).not.toHaveBeenCalled();
    expect(given.onManageEntry).not.toHaveBeenCalled();
    expect(given.onPlaceEntry).not.toHaveBeenCalled();
    expect(rithmicPhoneAttachRefusal(5)).toMatchObject({ type: 'leader-order-managed', action: 'attach-brackets', status: 'blocked', checkedAt: 5 });
  });

  it('správa a vstup jdou beze změny do služby; flatten = brzda služby s textem výsledku', async () => {
    const given = input();
    const bridge = rithmicPhoneBridge(given)!;
    expect(bridge.place).toBe(given.onPlaceEntry);
    await bridge.manage!('move-stop', 24_980, 24_990, 'hash-kopírky');
    expect(given.onManageEntry).toHaveBeenCalledWith('move-stop', 24_980, 24_990);
    expect(await bridge.flatten()).toBe('Zavření pozice odesláno — výsledek ukáže graf.');
    expect(given.closeNow).toHaveBeenCalledTimes(1);
    expect(rithmicPhoneCloseText({ status: 'blocked', text: 'bez pozice' })).toBe('Zavření neodešlo: bez pozice');
    expect(rithmicPhoneCloseText({ status: 'unknown', text: null })).toMatch(/NEZNÁMÝ.*nic neopakuj/);
  });
});

describe('kotace telefonu', () => {
  it('bid = cena na krok, ask o krok výš, čas a kontrakt ze služby', () => {
    expect(rithmicPhoneQuote({ price: 25_000.3, at: 1_000, symbol: 'MNQZ6', tickSize: 0.25 })).toEqual({ symbol: 'MNQZ6', bid: 25_000.25, ask: 25_000.5, at: 1_000 });
  });

  it('bez ceny, času, kontraktu nebo kroku kotace není', () => {
    const ok = { price: 25_000, at: 1_000, symbol: 'MNQZ6', tickSize: 0.25 };
    for (const bad of [{ price: null }, { price: Number.NaN }, { price: 0 }, { at: null }, { at: 0 }, { symbol: '' }, { tickSize: null }, { tickSize: 0 }])
      expect(rithmicPhoneQuote({ ...ok, ...bad })).toBeNull();
  });

  it('z kotace vznikne Market příkaz na kontrakt služby', () => {
    const quote = rithmicPhoneQuote({ price: 25_000, at: 1_000, symbol: 'MNQZ6', tickSize: 0.25 })!;
    expect(livePhoneBareMarket('buy', 1, quote)).toMatchObject({ symbol: 'MNQZ6', side: 'Buy', orderType: 'Market', referencePrice: 25_000.25, quoteReceivedAt: 1_000 });
  });
});

describe('štítek režimu účtu', () => {
  const base = { system: 'Rithmic Test', readOnly: false, closeOnly: false, liveAccount: false };
  it('test, jen čtení, jen zavírání, živý účet', () => {
    expect(rithmicPhoneModeLabel(base)).toEqual({ text: 'test', tone: 'muted' });
    expect(rithmicPhoneModeLabel({ ...base, system: 'Rithmic 01', readOnly: true, liveAccount: true })?.text).toBe('jen čtení');
    expect(rithmicPhoneModeLabel({ ...base, system: 'Rithmic 01', closeOnly: true, liveAccount: true })?.text).toBe('jen zavírání');
    expect(rithmicPhoneModeLabel({ ...base, system: 'Rithmic 01', liveAccount: true })).toEqual({ text: 'ŽIVÝ ÚČET', tone: 'danger' });
    expect(rithmicPhoneModeLabel({ ...base, simulation: true })?.text).toBe('simulace');
    // Simulace se nikdy netváří jako test, když služba hlásí skutečný účet.
    expect(rithmicPhoneModeLabel({ ...base, simulation: true, liveAccount: true })?.text).toBe('ŽIVÝ ÚČET');
    expect(rithmicPhoneModeLabel({ ...base, system: null })).toBeNull();
  });
});

describe('karty stavů telefonu', () => {
  const calm = {
    link: 'open' as const, helloFresh: true, rithmicConnected: true, silent: false, readOnly: false, blocked: null, uncertain: [],
    closeNote: null, ackNote: null, rejection: null, sessionWarning: null, foreignOrders: 0,
  };
  it('klid = žádná karta', () => {
    expect(rithmicPhoneCards(calm)).toEqual([]);
  });

  it('spojení: odpojeno, připojuji, Rithmic odpojen, služba mlčí', () => {
    expect(rithmicPhoneCards({ ...calm, link: 'closed' })[0]).toMatchObject({ id: 'link', tone: 'red' });
    expect(rithmicPhoneCards({ ...calm, helloFresh: false })[0]).toMatchObject({ id: 'hello', tone: 'amber' });
    expect(rithmicPhoneCards({ ...calm, rithmicConnected: false })[0]).toMatchObject({ id: 'rithmic', tone: 'red' });
    expect(rithmicPhoneCards({ ...calm, silent: true })[0]).toMatchObject({ id: 'silent', tone: 'red' });
  });

  it('incident má tlačítko „Potvrdit incident"; účet jen pro čtení ho nemá', () => {
    const [card] = rithmicPhoneCards({ ...calm, blocked: 'Pozice bez ochrany.' });
    expect(card).toMatchObject({ tone: 'red', title: 'Nové vstupy stojí', action: { kind: 'ack', label: 'Potvrdit incident', disabled: false } });
    expect(rithmicPhoneCards({ ...calm, blocked: 'Pozice bez ochrany.', readOnly: true })[0].action).toBeUndefined();
    // Bez spojení potvrzení odeslat nejde — tlačítko je vidět, ale neaktivní.
    expect(rithmicPhoneCards({ ...calm, link: 'closed', blocked: 'x' }).find(item => item.action?.kind === 'ack')?.action?.disabled).toBe(true);
    expect(rithmicPhoneCards({ ...calm, ackNote: { at: 7, text: 'služba odmítla' } })[0]).toMatchObject({ id: 'ack:7', tone: 'red', text: 'služba odmítla' });
  });

  it('nejistý příkaz: každý má kartu, jedno tlačítko „ověřeno" (maže všechna) a jen s čerstvým spojením', () => {
    const uncertain = [{ id: 'a', label: 'Vstup', reason: 'bez odpovědi' }, { id: 'b', label: 'Posun SL/TP', reason: 'spojení spadlo' }];
    const cards = rithmicPhoneCards({ ...calm, uncertain });
    expect(cards.map(card => card.title)).toEqual(['Vstup: výsledek NEZNÁMÝ', 'Posun SL/TP: výsledek NEZNÁMÝ']);
    expect(cards[0].action).toBeUndefined();
    expect(cards[1].action).toEqual({ kind: 'verified', label: 'Stav u brokera ověřen', disabled: false });
    expect(rithmicPhoneCards({ ...calm, helloFresh: false, uncertain }).find(card => card.action?.kind === 'verified')?.action?.disabled).toBe(true);
    // Potvrzený brokerem: zelená karta; tlačítko jen když už nic nejistého nezbývá.
    const mixed = rithmicPhoneCards({ ...calm, uncertain: [{ id: 'a', label: 'Vstup', reason: 'vyplněn 1/1', confirmed: true }, uncertain[1]] });
    expect(mixed.filter(card => card.action).map(card => card.action!.label)).toEqual(['Stav u brokera ověřen']);
    expect(rithmicPhoneCards({ ...calm, uncertain: [{ id: 'a', label: 'Vstup', reason: 'vyplněn 1/1', confirmed: true }] })[0]).toMatchObject({ tone: 'green', action: { label: 'Zavřít potvrzení' } });
  });

  it('výsledek brzdy, odmítnutí, konec seance a cizí příkazy', () => {
    const cards = rithmicPhoneCards({ ...calm, closeNote: { at: 3, text: 'Zavření neodešlo: x' }, rejection: { at: 4, reason: 'cena mimo limit' }, sessionWarning: 'Za 10 minut končí seance.', foreignOrders: 2 });
    expect(cards.map(card => card.id)).toEqual(['close:3', 'rejected:4', 'session-close', 'foreign:2']);
    expect(cards[3].title).toBe('Na účtu pracuje 2 příkazů zadaných jinde');
  });
});

describe('prázdný stav telefonu', () => {
  it('chybí spárování, špatný kontrakt, služba nedostupná, čekání na cenu, graf', () => {
    expect(rithmicPhoneWaiting({ url: null, instrumentIssue: null, hasMarket: false, link: 'off' })).toMatch(/Chybí spárování/);
    expect(rithmicPhoneWaiting({ url: 'ws://x', instrumentIssue: 'Jiný kontrakt.', hasMarket: true, link: 'open' })).toBe('Jiný kontrakt.');
    expect(rithmicPhoneWaiting({ url: 'ws://x', instrumentIssue: null, hasMarket: false, link: 'closed' })).toMatch(/není dostupná/);
    expect(rithmicPhoneWaiting({ url: 'ws://x', instrumentIssue: null, hasMarket: false, link: 'open' })).toMatch(/Čekám na první cenu/);
    // Pozdější výpadek graf neodmontuje.
    expect(rithmicPhoneWaiting({ url: 'ws://x', instrumentIssue: null, hasMarket: true, link: 'closed' })).toBeNull();
  });
});
