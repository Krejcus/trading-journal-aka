import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  copyEventAnnouncement,
  createLiveFillAnnouncer,
  fillMarkerAnnouncement,
  formatFillPnlCs,
  formatFillPriceCs,
  LIVE_FILL_ANNOUNCE_GAP_MS,
  LIVE_FILL_ANNOUNCE_MAX_AGE_MS,
  LIVE_FILL_ANNOUNCE_STORAGE_KEY,
  liveFillAnnouncerActive,
  liveFillSymbolRoot,
  parseLiveFillAnnounceMode,
  readLiveFillAnnounceMode,
  spokenFillPnl,
  spokenFillPrice,
  writeLiveFillAnnounceMode,
  type LiveFillAnnouncerInput,
} from '../lib/liveFillAnnouncer';
import type { LiveFillMarker } from '../lib/liveFillMarkers';
import type { CopierCopyEvent } from '../services/copierRuntimeController';

const NOW = 1_800_000_000_000;
const NB = ' ';
const event = (patch: Partial<CopierCopyEvent>): CopierCopyEvent => ({
  id: 'e1', at: NOW, kind: 'entry', symbol: 'MNQZ6', side: 'Long', quantity: 1, followers: 2, ...patch,
});
const fill = (patch: Partial<LiveFillMarker>): LiveFillMarker => ({
  id: 'f1', orderId: 'o1', at: NOW, price: 25100.25, side: 'Buy', role: 'entry', quantity: 1, ...patch,
});
const input = (patch: Partial<LiveFillAnnouncerInput>): LiveFillAnnouncerInput => ({
  now: NOW, mode: 'voice', available: true, visible: true, focused: true, ...patch,
});
/** Announcer po prvním načtení prázdných zdrojů (aktivní, nic neohlášeno). */
const primed = (patch: Partial<LiveFillAnnouncerInput> = {}) => {
  const announcer = createLiveFillAnnouncer();
  expect(announcer.step(input({ events: [], fills: [], ...patch })).announcement).toBeNull();
  return announcer;
};

describe('U7: hlášení fillu — text', () => {
  it('plnění brokera → „Fill BUY 1 MNQ za 25 100,25“, hlas česky bez mezer v ceně', () => {
    expect(fillMarkerAnnouncement(fill({}), 'MNQZ6')).toMatchObject({
      key: 'fill:f1', text: `Fill BUY 1 MNQ za 25${NB}100,25`, speech: 'Koupeno 1 MNQ za 25100,25',
      cue: 'buy', orderSide: 'Buy', price: 25100.25, priority: 1,
    });
    expect(fillMarkerAnnouncement(fill({ side: 'Sell', quantity: 2, price: 21004 }))).toMatchObject({
      text: `Fill SELL 2 MNQ za 21${NB}004,00`, speech: 'Prodáno 2 MNQ za 21004', cue: 'sell',
    });
    expect(fillMarkerAnnouncement(fill({ price: 0 }))).toBeNull();
    expect(fillMarkerAnnouncement(fill({ quantity: Number.NaN }))).toBeNull();
  });

  it('události kopírky: jen filly; strana příkazu z pozice (výstup z longu = SELL), P&L jen z události', () => {
    expect(copyEventAnnouncement(event({}))).toMatchObject({ text: 'Fill BUY 1 MNQ', speech: 'Koupeno 1 MNQ', orderSide: 'Buy', price: null });
    expect(copyEventAnnouncement(event({ kind: 'exit', exitReason: 'tp', pnlUsd: 45 }))).toMatchObject({
      text: 'TP SELL 1 MNQ · +45,00 $', speech: 'TP zasažen, plus 45 dolarů', cue: 'win', orderSide: 'Sell', priority: 4,
    });
    expect(copyEventAnnouncement(event({ kind: 'exit', side: 'Short', exitReason: 'sl', pnlUsd: -30.5 }))).toMatchObject({
      text: 'SL BUY 1 MNQ · −30,50 $', speech: 'SL zasažen, minus 31 dolarů', cue: 'loss', orderSide: 'Buy',
    });
    expect(copyEventAnnouncement(event({ kind: 'exit', exitReason: 'manual' }))).toMatchObject({ text: 'Zavřeno SELL 1 MNQ', speech: 'Pozice zavřena', cue: 'flat' });
    expect(copyEventAnnouncement(event({ kind: 'scale-in', side: 'Short', quantity: 2 }))).toMatchObject({ text: 'Přidáno SELL 2 MNQ', orderSide: 'Sell' });
    expect(copyEventAnnouncement(event({ kind: 'scale-out', pnlUsd: 12.5 }))).toMatchObject({ text: 'Část SELL 1 MNQ · +12,50 $', speech: 'Částečný výstup 1 MNQ, plus 13 dolarů', priority: 2 });
    expect(copyEventAnnouncement(event({ kind: 'flip', side: 'Long' }))).toMatchObject({ text: 'Otočeno na LONG 1 MNQ', orderSide: 'Buy', priority: 3 });
    // Nejsou filly: zadání, posuny, zrušení, odpojený follower — ticho.
    for (const kind of ['order-placed', 'bracket-placed', 'order-canceled', 'order-moved', 'sl-moved', 'tp-moved', 'follower-cut'] as const) {
      expect(copyEventAnnouncement(event({ kind, price: 25100 }))).toBeNull();
    }
  });

  it('formáty: kořen kontraktu, ceny a dolary česky', () => {
    expect(liveFillSymbolRoot('MNQZ6')).toBe('MNQ');
    expect(liveFillSymbolRoot('MNQH27')).toBe('MNQ');
    expect(liveFillSymbolRoot(undefined)).toBe('MNQ');
    expect(liveFillSymbolRoot('es')).toBe('ES');
    expect(formatFillPriceCs(25100.25)).toBe(`25${NB}100,25`);
    expect(formatFillPnlCs(-1234.5)).toBe(`−1${NB}234,50 $`);
    expect(spokenFillPrice(25100.5)).toBe('25100,50');
    expect(spokenFillPnl(1)).toBe('plus 1 dolar');
    expect(spokenFillPnl(-3)).toBe('minus 3 dolary');
    expect(spokenFillPnl(0.2)).toBe('0 dolarů');
  });
});

describe('U7: hlášení fillu — kdy (fail-silent)', () => {
  it('první načtení je ticho; ohlásí se až nová událost', () => {
    const announcer = createLiveFillAnnouncer();
    const old = event({ id: 'old', at: NOW - 1_000 });
    expect(announcer.step(input({ events: [old] })).announcement).toBeNull();
    expect(announcer.step(input({ events: [old, event({ id: 'new' })] })).announcement?.key).toBe('event:new');
  });

  it('starší než 30 s ticho (hranice 30 000 ms ještě zazní); „z budoucnosti“ nad 10 s ticho', () => {
    expect(LIVE_FILL_ANNOUNCE_MAX_AGE_MS).toBe(30_000);
    expect(primed().step(input({ events: [event({ id: 'stale', at: NOW - 30_001 })] })).announcement).toBeNull();
    expect(primed().step(input({ events: [event({ id: 'edge', at: NOW - 30_000 })] })).announcement?.key).toBe('event:edge');
    expect(primed().step(input({ events: [event({ id: 'future', at: NOW + 10_001 })] })).announcement).toBeNull();
    expect(primed().step(input({ fills: [fill({ id: 'stale', at: NOW - 45_000 })] })).announcement).toBeNull();
  });

  it('každé id nejvýš jednou (nový poll se stejnou událostí = ticho)', () => {
    const announcer = primed();
    expect(announcer.step(input({ events: [event({ id: 'a' })], fills: [] })).announcement?.key).toBe('event:a');
    expect(announcer.step(input({ now: NOW + 5_000, events: [event({ id: 'a' })], fills: [] })).announcement).toBeNull();
    expect(announcer.step(input({ now: NOW + 9_000, events: [{ ...event({ id: 'a' }) }], fills: [] })).announcement).toBeNull();
  });

  it('kopírka nedostupná (available=false) = ticho a událost se už nikdy nepřehraje', () => {
    const announcer = primed();
    const fresh = [event({ id: 'during-unavailable' })];
    expect(announcer.step(input({ available: false, events: fresh })).announcement).toBeNull();
    expect(announcer.step(input({ now: NOW + 1_000, events: fresh })).announcement).toBeNull();
    // Po návratu dostupnosti nová událost zase zazní (brána není trvale zavřená).
    expect(announcer.step(input({ now: NOW + 2_000, events: [...fresh, event({ id: 'after', at: NOW + 1_900 })] })).announcement?.key).toBe('event:after');
  });

  it.each([
    ['volba Vypnuto', { mode: 'off' as const }],
    ['skrytý graf / appka v pozadí', { visible: false }],
    ['PC okno bez fokusu', { focused: false }],
  ])('%s = ticho a bez přehrání po návratu', (_label, gate) => {
    const announcer = primed();
    const fresh = [event({ id: 'muted' })];
    expect(announcer.step(input({ ...gate, events: fresh })).announcement).toBeNull();
    expect(announcer.step(input({ now: NOW + 500, events: fresh })).announcement).toBeNull();
  });

  it('brána aktivity: všechny čtyři podmínky', () => {
    expect(liveFillAnnouncerActive({ mode: 'tone', available: true, visible: true, focused: true })).toBe(true);
    expect(liveFillAnnouncerActive({ mode: 'tone', available: false, visible: true, focused: true })).toBe(false);
    expect(liveFillAnnouncerActive({ mode: 'voice', available: true, visible: false, focused: true })).toBe(false);
    expect(liveFillAnnouncerActive({ mode: 'voice', available: true, visible: true, focused: false })).toBe(false);
    expect(liveFillAnnouncerActive({ mode: 'off', available: true, visible: true, focused: true })).toBe(false);
  });

  it('zdroj, který chyběl (PC bez dostupné kopírky → undefined), začíná znovu prvním načtením', () => {
    const announcer = primed();
    expect(announcer.step(input({ events: undefined })).announcement).toBeNull();
    expect(announcer.step(input({ now: NOW + 100, events: [event({ id: 'backlog', at: NOW + 50 })] })).announcement).toBeNull();
    expect(announcer.step(input({ now: NOW + 200, events: [event({ id: 'backlog', at: NOW + 50 }), event({ id: 'next', at: NOW + 150 })] })).announcement?.key).toBe('event:next');
  });
});

describe('U7: hlášení fillu — jednou na fill', () => {
  it('událost + plnění téhož fillu v jednom kole = jedno hlášení s cenou z plnění', () => {
    const announcer = primed();
    const result = announcer.step(input({ events: [event({ id: 'entry' })], fills: [fill({ id: 'f1', at: NOW - 300 })], fillsSymbol: 'MNQZ6' }));
    expect(result.announcement).toMatchObject({ key: 'event:entry', text: `Fill BUY 1 MNQ za 25${NB}100,25`, price: 25100.25 });
    expect(announcer.step(input({ now: NOW + 3_000, events: [event({ id: 'entry' })], fills: [fill({ id: 'f1', at: NOW - 300 })] })).announcement).toBeNull();
  });

  it('výstup TP s plněním: cena i P&L v jednom hlášení', () => {
    const announcer = primed();
    expect(announcer.step(input({
      events: [event({ id: 'exit', kind: 'exit', exitReason: 'tp', pnlUsd: 45 })],
      fills: [fill({ id: 'f-exit', orderId: 'tp-1', side: 'Sell', role: 'exit', price: 25140 })],
    })).announcement?.text).toBe(`TP SELL 1 MNQ za 25${NB}140,00 · +45,00 $`);
  });

  it('plnění dřív, událost o kolo později (protějšek) = ticho', () => {
    const announcer = primed();
    expect(announcer.step(input({ events: [], fills: [fill({})] })).announcement?.key).toBe('fill:f1');
    expect(announcer.step(input({ now: NOW + 2_000, events: [event({ id: 'late', at: NOW + 400 })], fills: [fill({})] })).announcement).toBeNull();
  });

  it('událost dřív, plnění o kolo později = ticho; dílčí plnění téhož příkazu také', () => {
    const announcer = primed();
    expect(announcer.step(input({ events: [event({ id: 'entry' })], fills: [] })).announcement?.key).toBe('event:entry');
    expect(announcer.step(input({ now: NOW + 2_000, events: [event({ id: 'entry' })], fills: [fill({ id: 'p1', orderId: 'm1' })] })).announcement).toBeNull();
    expect(announcer.step(input({ now: NOW + 4_000, events: [event({ id: 'entry' })], fills: [fill({ id: 'p1', orderId: 'm1' }), fill({ id: 'p2', orderId: 'm1', at: NOW + 3_900 })] })).announcement).toBeNull();
  });

  it('protějšek pohltí jen jeden fill: opačná strana i nový vstup po spárovaném výstupu zazní', () => {
    const announcer = primed();
    expect(announcer.step(input({
      events: [event({ id: 'exit', kind: 'exit', exitReason: 'sl', pnlUsd: -20 })],
      fills: [fill({ id: 'x1', orderId: 'sl-1', side: 'Sell', role: 'exit' })],
    })).announcement?.key).toBe('event:exit');
    // Otočka dvěma příkazy: nový short (Sell) 2 s po výstupu z longu (Sell) — spárovaný výstup ho nepohltí.
    expect(announcer.step(input({
      now: NOW + 2_000,
      events: [event({ id: 'exit', kind: 'exit', exitReason: 'sl', pnlUsd: -20 }), event({ id: 'short', side: 'Short', at: NOW + 1_900 })],
      fills: [fill({ id: 'x1', orderId: 'sl-1', side: 'Sell', role: 'exit' })],
    })).announcement?.key).toBe('event:short');
  });

  it('dílčí plnění jednoho příkazu v jednom kole = jedno hlášení (součet qty, VWAP)', () => {
    const announcer = primed();
    expect(announcer.step(input({ events: [], fills: [fill({ id: 'p1', orderId: 'm1', price: 100 }), fill({ id: 'p2', orderId: 'm1', quantity: 2, price: 100.75 })] })).announcement?.text)
      .toBe('Fill BUY 3 MNQ za 100,50');
  });

  it('vstup + přidání na stejnou stranu v jednom kole = jeden vstup', () => {
    const announcer = primed();
    expect(announcer.step(input({ events: [event({ id: 'a' }), event({ id: 'b', kind: 'scale-in', at: NOW + 10 })] })).announcement?.text).toBe('Fill BUY 2 MNQ');
  });
});

describe('U7: hlášení fillu — nejvýš jedno za 1,5 s', () => {
  it('druhé hlášení čeká na limit a pak zazní, je-li stále čerstvé', () => {
    expect(LIVE_FILL_ANNOUNCE_GAP_MS).toBe(1_500);
    const announcer = primed();
    const first = event({ id: 'a' });
    const second = event({ id: 'b', kind: 'exit', exitReason: 'tp', pnlUsd: 10, at: NOW + 900 });
    expect(announcer.step(input({ events: [first] })).announcement?.key).toBe('event:a');
    expect(announcer.step(input({ now: NOW + 1_000, events: [first, second] }))).toEqual({ announcement: null, retryAt: NOW + 1_500 });
    expect(announcer.step(input({ now: NOW + 1_499, events: [first, second] }))).toEqual({ announcement: null, retryAt: NOW + 1_500 });
    expect(announcer.step(input({ now: NOW + 1_500, events: [first, second] })).announcement?.key).toBe('event:b');
    expect(announcer.step(input({ now: NOW + 4_000, events: [first, second] })).announcement).toBeNull();
  });

  it('záplava: zazní jen nejdůležitější (výstup), ostatní se zahodí', () => {
    const announcer = primed();
    const first = event({ id: 'a' });
    expect(announcer.step(input({ events: [first] })).announcement?.key).toBe('event:a');
    const flood = [
      first,
      event({ id: 'add', kind: 'scale-in', at: NOW + 300 }),
      event({ id: 'part', kind: 'scale-out', at: NOW + 350 }),
      event({ id: 'out', kind: 'exit', exitReason: 'sl', at: NOW + 400 }),
    ];
    expect(announcer.step(input({ now: NOW + 500, events: flood })).announcement).toBeNull();
    expect(announcer.step(input({ now: NOW + 1_500, events: flood })).announcement?.key).toBe('event:out');
    expect(announcer.step(input({ now: NOW + 3_200, events: flood })).announcement).toBeNull();
  });

  it('zadržené hlášení, které mezitím zestárlo (> 30 s), už nezazní', () => {
    const announcer = primed();
    const first = event({ id: 'a' });
    const old = event({ id: 'old', at: NOW - 29_000 });
    expect(announcer.step(input({ events: [first] })).announcement).not.toBeNull();
    expect(announcer.step(input({ now: NOW + 500, events: [first, old] })).retryAt).toBe(NOW + 1_500);
    expect(announcer.step(input({ now: NOW + 1_500, events: [first, old] }))).toEqual({ announcement: null, retryAt: null });
  });

  it('vypnutí zahodí i zadržené hlášení', () => {
    const announcer = primed();
    const first = event({ id: 'a' });
    const second = event({ id: 'b', at: NOW + 200 });
    announcer.step(input({ events: [first] }));
    expect(announcer.step(input({ now: NOW + 300, events: [first, second] })).retryAt).toBe(NOW + 1_500);
    expect(announcer.step(input({ now: NOW + 400, mode: 'off', events: [first, second] })).announcement).toBeNull();
    expect(announcer.step(input({ now: NOW + 1_600, events: [first, second] })).announcement).toBeNull();
  });
});

describe('U7: volba Vypnuto / Tón / Hlas', () => {
  it('neznámá nebo chybějící hodnota = Vypnuto; chyba úložiště = Vypnuto, nikdy výjimka', () => {
    expect(parseLiveFillAnnounceMode('voice')).toBe('voice');
    expect(parseLiveFillAnnounceMode('tone')).toBe('tone');
    expect(parseLiveFillAnnounceMode('loud')).toBe('off');
    expect(parseLiveFillAnnounceMode(null)).toBe('off');
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readLiveFillAnnounceMode(broken)).toBe('off');
    expect(() => writeLiveFillAnnounceMode(broken, 'voice')).not.toThrow();
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
    writeLiveFillAnnounceMode(storage, 'tone');
    expect(map.get(LIVE_FILL_ANNOUNCE_STORAGE_KEY)).toBe('tone');
    expect(readLiveFillAnnounceMode(storage)).toBe('tone');
  });
});

describe('U7: jen zobrazení (INV-UI-01) — statická kontrola', () => {
  const FILES = ['lib/liveFillAnnouncer.ts', 'hooks/useLiveFillAnnouncer.ts', 'services/liveFillAudio.ts'];
  const FORBIDDEN_MODULE = /relay|localCopierAgent|copierRuntimeCommandAdapter|TradovateLiveDesk|tradovateBroker|liveSafetyAction|copierSafetyControls|leaderEntryPlace|leaderOrderManage|leaderEntryPreview|supabase/i;

  it.each(FILES)('%s neimportuje relay, desk ani příkazy a nic neodesílá', file => {
    const source = readFileSync(file, 'utf8');
    const imports = [...source.matchAll(/^import\s+(type\s+)?[\s\S]*?\sfrom\s+'([^']+)';/gm)].map(match => ({ typeOnly: !!match[1], from: match[2] }));
    expect(imports.length).toBeGreaterThan(0);
    for (const item of imports) {
      expect(item.from).not.toMatch(FORBIDDEN_MODULE);
      // Typ události smí (jako karty obchodů), hodnota z kontroleru kopírky ne.
      if (/copierRuntimeController/.test(item.from)) expect(item.typeOnly).toBe(true);
    }
    expect(source).not.toMatch(/\b(previewLeaderEntry|placeLeaderEntry|manageLeaderEntry|attachBrackets|runStaticSafetyAction|onPlaceEntry|sendDirect)\b/);
    expect(source).not.toMatch(/\bfetch\s*\(|WebSocket|sendBeacon|XMLHttpRequest/);
  });
});
