// C12 (4. 11. 2026, docs/reviews/trading-gaps-designs/safety.md): automatické zrušení vlastního
// čekajícího vstupu — čisté helpery. Stavová podmínka (z flat i přikoupení), denní pauza CME přes
// sdílený DST-safe helper (oponentura P2), předčtení vstupu před zrušením (oponentura P1a/P1c).
import { describe, expect, it } from 'vitest';
import { cmeDailyHaltWindow, msUntilTradovateSessionEnd } from '../services/copierArmSession';
import {
  pendingEntryAutoCancelAt,
  pendingEntryNeedsLegOwnershipProof,
  pendingEntryPreReadDecision,
  pendingOwnEntryOutsidePosition,
  pendingOwnEntryViolation,
  type PendingOwnEntryViolationInput,
} from '../services/manualPendingEntries';
import { pendingAddViolation } from '../services/manualScaleIn';

const MIN = 60_000;
const RESERVE = 5 * MIN;
/** 3. 11. 2026 09:00 CST (UTC−6). */
const NOW = Date.UTC(2026, 10, 3, 15, 0, 0);
const base = (patch: Partial<PendingOwnEntryViolationInput> = {}): PendingOwnEntryViolationInput => ({
  kind: 'from-flat', armed: true, shadowMode: false, killSwitch: false, dayLockPending: false, dayLocked: false,
  pauseActive: false, managementOnly: false, leaderIneligible: false, windowNow: 'off', windowAfterReserve: 'off',
  cmeHaltWindow: false, now: NOW, sessionEndAt: NOW + 8 * 60 * MIN, armExpiresAt: NOW + 7 * 60 * MIN, reserveMs: RESERVE,
  net: 0, side: 'Buy', episodeMismatch: false, ...patch,
});
const violation = (patch: Partial<PendingOwnEntryViolationInput> = {}) => pendingOwnEntryViolation(base(patch));

describe('C12 — stavová podmínka čekajícího vlastního vstupu (čistě)', () => {
  it('klidný stav pod živým ARM: z flat i přikoupení smí čekat', () => {
    expect(violation()).toBeNull();
    expect(violation({ kind: 'add', net: 1 })).toBeNull();
  });

  it('každá brzda zvlášť vrátí důvod zrušení (i pro vstup z flat)', () => {
    expect(violation({ armed: false })).toBe('kopírka je vypnutá');
    expect(violation({ shadowMode: true })).toBe('kopírka je vypnutá');
    expect(violation({ killSwitch: true })).toBe('kill switch');
    expect(violation({ dayLockPending: true })).toBe('denní zámek');
    expect(violation({ dayLocked: true })).toBe('denní zámek');
    expect(violation({ pauseActive: true })).toBe('pauza pravidlem dne');
    expect(violation({ managementOnly: true })).toBe('kopírka jen spravuje');
    expect(violation({ leaderIneligible: true })).toBe('leader nesmí nové vstupy');
    expect(violation({ windowNow: 'outside' })).toBe('konec obchodního okna');
    expect(violation({ windowNow: 'inside', windowAfterReserve: 'outside' })).toBe('konec obchodního okna');
    expect(violation({ cmeHaltWindow: true })).toBe('denní pauza CME (16:00–17:00 CT)');
    expect(violation({ sessionEndAt: NOW + RESERVE - 1 })).toBe('konec broker session (17:00 CT)');
    expect(violation({ armExpiresAt: NOW + RESERVE - 1 })).toBe('vyprší zapnutí kopírky');
    expect(violation({ armExpiresAt: null })).toBeNull();
  });

  it('z flat: pozice mimo appku ani neznámá pozice není důvod ke zrušení (rozhodnutí Filipa 5. 11. 2026), brzdy dál ruší i s pozicí', () => {
    for (const net of [null, 0, 1, -2]) expect(violation({ net })).toBeNull();
    expect(violation({ net: 1, armed: false })).toBe('kopírka je vypnutá');
    expect(violation({ net: -2, killSwitch: true })).toBe('kill switch');
    expect(violation({ net: -2, cmeHaltWindow: true })).toBe('denní pauza CME (16:00–17:00 CT)');
  });

  it('z flat: upozornění na pozici mimo appku jen po ustálení, bez fillu vstupu a u známé nenulové pozice; přikoupení nikdy', () => {
    const outside = (patch: Partial<Parameters<typeof pendingOwnEntryOutsidePosition>[0]> = {}) => pendingOwnEntryOutsidePosition({ kind: 'from-flat', net: 1, entryFilled: 0, settled: true, ...patch });
    expect(outside()).toBe(true);
    expect(outside({ net: -2 })).toBe(true);
    expect(outside({ settled: false })).toBe(false); // Position mohla předběhnout Fill
    expect(outside({ entryFilled: 1 })).toBe(false); // dílčí fill vlastního vstupu pozici vysvětluje
    expect(outside({ net: 0 })).toBe(false);
    expect(outside({ net: null })).toBe(false);
    expect(outside({ kind: 'add' })).toBe(false);
  });

  it('přikoupení: zavřená / opačná pozice a nová epizoda; neznámá pozice nic', () => {
    expect(violation({ kind: 'add', net: 0 })).toBe('pozice je zavřená');
    expect(violation({ kind: 'add', net: -1 })).toBe('pozice je na druhé straně');
    expect(violation({ kind: 'add', net: 1, episodeMismatch: true })).toBe('přikoupení otevřelo nový obchod');
    expect(violation({ kind: 'add', net: null })).toBeNull();
  });

  it('pendingAddViolation (přikoupení) deleguje beze změny a zná i pauzu CME', () => {
    const { kind: _kind, cmeHaltWindow: _halt, ...add } = base({ net: 1 });
    expect(pendingAddViolation(add)).toBeNull();
    expect(pendingAddViolation({ ...add, net: 0 })).toBe('pozice je zavřená');
    expect(pendingAddViolation({ ...add, cmeHaltWindow: true })).toBe('denní pauza CME (16:00–17:00 CT)');
  });
});

describe('C12 — denní pauza CME 16:00–17:00 CT s rezervou (oponentura P2, DST)', () => {
  /** Kalendářní den v CT (měsíc 1–12) a čas; offset podle DST zadaný explicitně jako kontrola. */
  const ct = (year: number, month: number, day: number, hour: number, minute: number, utcOffsetHours: number) => (
    Date.UTC(year, month - 1, day, hour - utcOffsetHours, minute)
  );
  const inside = (at: number) => cmeDailyHaltWindow(at, RESERVE).inside;

  it('běžný den (CST): 15:54:59 ne, 15:55 ano, 16:10 ano, 16:59:59 ano, 17:00 ne (nová session)', () => {
    expect(inside(ct(2026, 11, 3, 15, 55, -6) - 1_000)).toBe(false);
    expect(inside(ct(2026, 11, 3, 15, 55, -6))).toBe(true);
    expect(inside(ct(2026, 11, 3, 16, 10, -6))).toBe(true);
    expect(inside(ct(2026, 11, 3, 17, 0, -6) - 1_000)).toBe(true);
    expect(inside(ct(2026, 11, 3, 17, 0, -6))).toBe(false);
    expect(inside(ct(2026, 11, 3, 9, 0, -6))).toBe(false);
  });

  it('16:10 CT v den přechodu času v březnu (CDT) i v listopadu (CST) a den předtím', () => {
    expect(inside(ct(2026, 3, 8, 16, 10, -5))).toBe(true); // DST začíná 8. 3. 2026
    expect(inside(ct(2026, 3, 7, 16, 10, -6))).toBe(true);
    expect(inside(ct(2026, 11, 1, 16, 10, -6))).toBe(true); // DST končí 1. 11. 2026
    expect(inside(ct(2026, 10, 31, 16, 10, -5))).toBe(true);
    // Hodina vedle (posun o offset) už mimo — helper offset nezaměňuje.
    expect(inside(ct(2026, 3, 8, 15, 10, -5))).toBe(false);
    expect(inside(ct(2026, 11, 1, 17, 10, -6))).toBe(false);
  });

  it('hranice okna: začátek 16:00 a konec 17:00 téhož dne v obou časech', () => {
    const march = cmeDailyHaltWindow(ct(2026, 3, 8, 12, 0, -5), RESERVE);
    expect(march.haltStartAt).toBe(ct(2026, 3, 8, 16, 0, -5));
    expect(march.haltEndAt).toBe(ct(2026, 3, 8, 17, 0, -5));
    const november = cmeDailyHaltWindow(ct(2026, 11, 1, 16, 30, -6), RESERVE);
    expect(november.haltStartAt).toBe(ct(2026, 11, 1, 16, 0, -6));
    expect(november.haltEndAt).toBe(ct(2026, 11, 1, 17, 0, -6));
  });

  it('proč samotný vzorec z návrhu nestačí: v 16:10 CT „do 16:00“ ukazuje až na zítřek (díra 16:00–16:55)', () => {
    const at = ct(2026, 11, 3, 16, 10, -6);
    expect(msUntilTradovateSessionEnd(at, 'America/Chicago', 16)).toBeGreaterThan(23 * 60 * MIN);
    expect(inside(at)).toBe(true);
  });
});

describe('C12 — předčtení vstupu před automatickým zrušením (oponentura P1a/P1c)', () => {
  const order = (patch: Record<string, unknown> = {}) => ({
    brokerOrderId: 'e1', symbol: 'MNQZ6', side: 'Buy', orderType: 'Limit', status: 'working', quantity: 2, filledQuantity: 0, ...patch,
  });
  const decide = (patch: Record<string, unknown> | null = {}, extra: { legIds?: string[]; leaderNet?: number | null; kind?: 'add' | 'from-flat' } = {}) => pendingEntryPreReadDecision({
    order: patch == null ? null : order({ tag: 'me1', ...patch }),
    expected: { side: 'Buy', orderType: 'Limit', symbol: 'MNQZ6', tag: 'me1' },
    legIds: new Set(extra.legIds ?? ['s1', 't1']),
    leaderNet: extra.leaderNet ?? 0,
    ...(extra.kind ? { kind: extra.kind } : {}),
  });

  it('jen čekající vstup s fillem 0 se smí zrušit', () => {
    expect(decide()).toEqual({ kind: 'cancel' });
    expect(decide({ status: 'pending' })).toEqual({ kind: 'cancel' });
  });

  it('nečitelné = nic se neruší (žádný zápis naslepo)', () => {
    expect(decide(null)).toEqual({ kind: 'unreadable' });
  });

  it('dílčí fill u qty > 1: zbytek se NERUŠÍ (stejně jako C16)', () => {
    expect(decide({ filledQuantity: 1 }, { leaderNet: 1 })).toEqual({ kind: 'partial', filled: 1, quantity: 2 });
  });

  it('REST už ví o fillu (cache pozadu, Position před Fill): nic se neruší', () => {
    expect(decide({ status: 'filled', filledQuantity: 2 }, { leaderNet: 2 })).toEqual({ kind: 'filled', filled: 2 });
    expect(decide({ status: 'canceled', filledQuantity: 1 }, { leaderNet: 1 })).toEqual({ kind: 'filled', filled: 1 });
    expect(decide({ status: 'canceled' })).toEqual({ kind: 'ended', status: 'canceled' });
  });

  it('nikdy nohu ani ochranu: parent, id nohy, jiná strana/typ/symbol, opačná strana než pozice', () => {
    expect(decide({ parentOrderId: 'x' }).kind).toBe('not-entry');
    expect(decide({ brokerOrderId: 's1' }).kind).toBe('not-entry');
    expect(decide({ side: 'Sell' }).kind).toBe('not-entry');
    expect(decide({ orderType: 'Stop' }).kind).toBe('not-entry');
    expect(decide({ symbol: 'MNQH7' }).kind).toBe('not-entry');
    expect(decide({}, { leaderNet: -1 }).kind).toBe('not-entry');
  });

  it('oponentura kolo 1 (P3): vlastní vstup proti pozici na opačné straně = vlastní text, ne „ochrana“; nic se neruší', () => {
    const own = decide({}, { leaderNet: -1 });
    expect(own).toEqual({ kind: 'not-entry', problem: expect.stringContaining('Pozice leadera je na opačné straně (-1) — vstup by ji zmenšil, zavřel nebo otočil') });
    expect(JSON.stringify(own)).not.toContain('ochrana');
    // Cizí tvar (jiná strana než záznam) zůstává obecná obrana „nikdy ochranu“.
    expect(decide({ side: 'Sell' }, { leaderNet: 1 })).toEqual({ kind: 'not-entry', problem: expect.stringContaining('nesedí se vstupem') });
    expect(decide({ parentOrderId: 'x' }, { leaderNet: -1 })).toEqual({ kind: 'not-entry', problem: expect.stringContaining('má parent') });
  });

  it('oponentura kolo 4 (P2): vlastní vstup Z FLAT proti pozici mimo appku na opačné straně = vlastní OSO → zrušit; přikoupení a cizí tvar dál ne', () => {
    // Kolo 5 (P2): rozhodnutí nese tvar „proti pozici na opačné straně“ (durable `cancel.opposite`, texty po fillu).
    expect(decide({}, { leaderNet: -1, kind: 'from-flat' })).toEqual({ kind: 'cancel', opposite: true });
    // Jen čekající s fillem 0: dílčí fill / vyplněný / skončený se neruší ani tady.
    expect(decide({ filledQuantity: 1 }, { leaderNet: -1, kind: 'from-flat' })).toEqual({ kind: 'partial', filled: 1, quantity: 2 });
    expect(decide({ status: 'canceled' }, { leaderNet: -1, kind: 'from-flat' })).toEqual({ kind: 'ended', status: 'canceled' });
    // Přikoupení (otočená pozice) a bez údaje o druhu: konzervativně incident.
    expect(decide({}, { leaderNet: -1, kind: 'add' }).kind).toBe('not-entry');
    expect(decide({}, { leaderNet: -1 }).kind).toBe('not-entry');
    // Noha / cizí tvar zůstává „nikdy nohu, nikdy ochranu“ i u vstupu z flat.
    expect(decide({ parentOrderId: 'x' }, { leaderNet: -1, kind: 'from-flat' })).toEqual({ kind: 'not-entry', problem: expect.stringContaining('má parent') });
    expect(decide({ brokerOrderId: 's1' }, { leaderNet: -1, kind: 'from-flat' }).kind).toBe('not-entry');
    expect(decide({ side: 'Sell' }, { leaderNet: 1, kind: 'from-flat' })).toEqual({ kind: 'not-entry', problem: expect.stringContaining('nesedí se vstupem') });
    // Vlastnictví jen s clOrdId = tag záznamu: cizí / chybějící tag (poškozený záznam s id uživatelova
    // ochranného příkazu, C7 „nikdy ochrana“) = incident, nic se neruší.
    expect(decide({ tag: 'tvUser' }, { leaderNet: -1, kind: 'from-flat' })).toEqual({ kind: 'not-entry', problem: expect.stringContaining('opačné straně') });
    expect(decide({ tag: '' }, { leaderNet: -1, kind: 'from-flat' }).kind).toBe('not-entry');
    expect(decide({ tag: undefined }, { leaderNet: -1, kind: 'from-flat' }).kind).toBe('not-entry');
  });

  it('oponentura kolo 5 (P3, A1): bez clOrdId záložní důkaz vlastnictví z nohou záznamu (parent = vstup); cizí tag se nepřebíjí; přikoupení ne', () => {
    const withLegs = (patch: Record<string, unknown>, kind: 'add' | 'from-flat', legsProveOwnership: boolean) => pendingEntryPreReadDecision({
      order: order({ ...patch }),
      expected: { side: 'Buy', orderType: 'Limit', symbol: 'MNQZ6', tag: 'me1' },
      legIds: new Set(['s1', 't1']), leaderNet: -1, kind, legsProveOwnership,
    });
    expect(withLegs({ tag: undefined }, 'from-flat', true)).toEqual({ kind: 'cancel', opposite: true });
    expect(withLegs({ tag: '' }, 'from-flat', true)).toEqual({ kind: 'cancel', opposite: true });
    expect(withLegs({ tag: undefined }, 'from-flat', false).kind).toBe('not-entry');
    // Tag, který nesedí (uživatelův příkaz), nohy nepřebijí.
    expect(withLegs({ tag: 'tvUser' }, 'from-flat', true).kind).toBe('not-entry');
    expect(withLegs({ tag: undefined }, 'add', true).kind).toBe('not-entry');
    // Kdy se nohy vůbec čtou: jen vlastní tvar z flat proti pozici na opačné straně bez clOrdId.
    const needs = (patch: Record<string, unknown>, leaderNet: number, kind: 'add' | 'from-flat' = 'from-flat') => pendingEntryNeedsLegOwnershipProof({
      order: order({ ...patch }), expected: { side: 'Buy', orderType: 'Limit', symbol: 'MNQZ6' }, legIds: new Set(['s1', 't1']), leaderNet, kind,
    });
    expect(needs({ tag: undefined }, -1)).toBe(true);
    expect(needs({ tag: 'me1' }, -1)).toBe(false);
    expect(needs({ tag: undefined }, 0)).toBe(false);
    expect(needs({ tag: undefined }, 1)).toBe(false);
    expect(needs({ tag: undefined }, -1, 'add')).toBe(false);
    expect(needs({ tag: undefined, parentOrderId: 'x' }, -1)).toBe(false);
    expect(needs({ tag: undefined, side: 'Sell' }, -1)).toBe(false);
  });
});

describe('C12 — kdy se vstup sám zruší (jen zobrazení)', () => {
  it('nejbližší budoucí: rezerva před pauzou CME, nebo před vypršením ARM', () => {
    const haltStart = NOW + 7 * 60 * MIN;
    expect(pendingEntryAutoCancelAt({ now: NOW, reserveMs: RESERVE, cmeHaltStartAt: haltStart, armExpiresAt: NOW + 8 * 60 * MIN }))
      .toEqual({ at: haltStart - RESERVE, reason: 'cme-halt' });
    expect(pendingEntryAutoCancelAt({ now: NOW, reserveMs: RESERVE, cmeHaltStartAt: haltStart, armExpiresAt: NOW + 60 * MIN }))
      .toEqual({ at: NOW + 60 * MIN - RESERVE, reason: 'arm-expiry' });
    expect(pendingEntryAutoCancelAt({ now: haltStart, reserveMs: RESERVE, cmeHaltStartAt: haltStart, armExpiresAt: null })).toBeNull();
  });
});
