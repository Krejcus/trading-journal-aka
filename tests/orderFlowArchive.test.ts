import { describe, expect, it } from 'vitest';
import {
  buildOrderFlowDay,
  decodeOrderFlowRaw,
  encodeOrderFlowRaw,
  minuteSpans,
  orderFlowFromRaw,
  parseServiceOrderFlow,
  type OrderFlowRaw,
} from '../services/orderFlowArchive';

const START = 1_795_700_000 - (1_795_700_000 % 60); // celá minuta
const SESSION: [number, number] = [START, START + 3_600];

type Row = [sec: number, usecs: number, priceTicks: number, size: number, side: number];
function raw(rows: Row[], header: Partial<OrderFlowRaw['header']> = {}): OrderFlowRaw {
  const bytes = encodeOrderFlowRaw({
    v: 2, contract: 'NQZ6', tradeDate: '2026-11-27', tickSize: 0.25, session: { start: SESSION[0], end: SESSION[1] }, complete: true,
    check: { candleVolume: rows.reduce((s, r) => s + r[3], 0) }, ...header,
  }, {
    sec: rows.map((r) => r[0]), usecs: rows.map((r) => r[1]), priceTicks: rows.map((r) => r[2]), size: rows.map((r) => r[3]), side: rows.map((r) => r[4]),
  }, SESSION[0]);
  return decodeOrderFlowRaw(bytes);
}

describe('archiv order flow — syrová data OFR1', () => {
  it('zakóduje a přečte sloupce beze ztráty', () => {
    const r = raw([[START + 5, 250, 100_000, 3, 1], [START + 61, 0, 100_004, 2, -1]]);
    expect(r.header).toMatchObject({ contract: 'NQZ6', count: 2, startSec: START });
    expect(Array.from(r.dsec)).toEqual([5, 61]);
    expect(Array.from(r.usecs)).toEqual([250, 0]);
    expect(Array.from(r.priceTicks)).toEqual([100_000, 100_004]);
    expect(Array.from(r.size)).toEqual([3, 2]);
    expect(Array.from(r.side)).toEqual([1, -1]);
  });

  it('hlavička v1 (sonda s obrácenou stranou) se při čtení opraví', () => {
    expect(Array.from(raw([[START + 5, 0, 100_000, 3, 1]], { v: 1 }).side)).toEqual([-1]);
  });

  it('odmítne cizí nebo zkrácený soubor', () => {
    expect(() => decodeOrderFlowRaw(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]))).toThrow(/OFR1/);
    const bytes = encodeOrderFlowRaw({ v: 2, contract: 'NQZ6', tradeDate: 'x', tickSize: 0.25, session: { start: 0, end: 1 }, complete: true }, { sec: [1], usecs: [0], priceTicks: [1], size: [1], side: [1] }, 0);
    expect(() => decodeOrderFlowRaw(bytes.subarray(0, bytes.length - 4))).toThrow(/zkrácený/);
  });
});

describe('archiv order flow — ze syrových dat', () => {
  it('objem po minutách a cenách jako živá služba: [cena, nákup, prodej, bez strany]; mimo seanci nic', () => {
    const { minutes, volume } = orderFlowFromRaw(raw([
      [START + 1, 0, 100_000, 2, 1], [START + 2, 0, 100_000, 3, -1], [START + 3, 0, 99_999, 1, 0],
      [START + 70, 0, 100_001, 4, 1], [SESSION[1] + 5, 0, 100_000, 50, 1],
    ]));
    expect([...minutes.entries()]).toEqual([
      [START, [99_999, 0, 0, 1, 100_000, 2, 3, 0]],
      [START + 60, [100_001, 4, 0, 0]],
    ]);
    expect(volume).toBe(10);
  });

  it('přibližné bubliny: stejná strana do 10 µs, průjezd cenami do 100 µs, jinak nová bublina; práh 5', () => {
    const s = START + 10;
    const { trades } = orderFlowFromRaw(raw([
      // příkaz 1: nákup přes tři ceny (0 µs, +3 µs, +60 µs s vyšší cenou) = 9
      [s, 100, 100_000, 3, 1], [s, 103, 100_001, 3, 1], [s, 163, 100_002, 3, 1],
      // +60 µs, ale stejná cena → už jiný příkaz (4, pod prahem 5 → neuloží se)
      [s, 223, 100_002, 4, 1],
      // opačná strana hned potom → nová bublina 6
      [s, 224, 100_002, 6, -1],
      // stejná strana po 1 ms → nová bublina 5
      [s, 1_224, 100_001, 5, -1],
    ]));
    expect(trades.map((t) => [t[3], t[4], t[5], t[6], t[7]])).toEqual([[1, 9, 3, 100_000, 100_002], [-1, 6, 1, 100_002, 100_002], [-1, 5, 1, 100_001, 100_001]]);
    // začátek a konec v ms, průměr v ticích
    expect(trades[0][1]).toBe(s * 1_000); expect(trades[0][2]).toBe(s * 1_000);
    expect(trades[0][8]).toBe(100_001);
  });
});

describe('archiv order flow — soubory živé služby', () => {
  it('u minuty platí poslední záznam (restart služby), pokrytí podle něj; vadné řádky se přeskočí', () => {
    const text = [
      JSON.stringify({ m: START, v: 1, c: [100_000, 1, 0, 0] }),
      'nesmysl',
      JSON.stringify({ m: START, v: 0, c: [100_000, 5, 0, 0] }),
      JSON.stringify({ m: START + 60, v: 1, c: [] }),
      JSON.stringify({ t: ['ord1', START * 1_000 + 5, 1, 20, 4, 100_000, 100_002, 100_001] }),
      JSON.stringify({ t: ['ord1', START * 1_000 + 5, 1, 20, 4, 100_000, 100_002, 100_001] }),
    ].join('\n');
    const parsed = parseServiceOrderFlow([text]);
    expect(parsed.minutes.get(START)).toEqual([100_000, 5, 0, 0]);
    expect([...parsed.covered]).toEqual([START + 60]);
    expect(parsed.trades).toHaveLength(1);
  });

  it('souvislé úseky minut', () => {
    expect(minuteSpans([START + 120, START, START + 60, START + 300])).toEqual([
      [START * 1_000, (START + 180) * 1_000], [(START + 300) * 1_000, (START + 360) * 1_000],
    ]);
  });
});

describe('archiv order flow — sloučení dne', () => {
  const rows: Row[] = [
    [START + 5, 0, 100_000, 10, 1], // minuta 0: 10 (služba ji má stejně)
    [START + 65, 0, 100_000, 8, -1], // minuta 1: 8 (služba spala: 0)
    [START + 125, 0, 100_000, 7, 1], // minuta 2: jen historie
  ];
  const service = parseServiceOrderFlow([[
    JSON.stringify({ m: START, v: 1, c: [100_000, 10, 0, 0] }),
    JSON.stringify({ m: START + 60, v: 1, c: [] }),
    JSON.stringify({ t: ['ordA', (START + 5) * 1_000, 1, 10, 2, 100_000, 100_000, 100_000] }),
  ].join('\n')]);

  it('objem z úplné historie; přesné bubliny jen tam, kde objem služby sedí s historií (ne ve spánku)', () => {
    const day = buildOrderFlowDay({ contract: 'NQZ6', tradeDate: '2026-11-27', tickSize: 0.25, session: SESSION, raw: raw(rows), service });
    expect(day.source).toBe('merged');
    expect(day.minutes.map(([m]) => m)).toEqual([START, START + 60, START + 120]);
    expect(day.coverage).toEqual([[SESSION[0] * 1_000, SESSION[1] * 1_000]]);
    expect(day.exactBubbles).toEqual([[START * 1_000, (START + 60) * 1_000]]);
    // minuta 0: přesná bublina ze služby (id příkazu), minuty 1 a 2: přibližné z historie
    expect(day.trades.map((t) => [t[0].startsWith('h') ? 'approx' : t[0], t[3], t[4]])).toEqual([['ordA', 1, 10], ['approx', -1, 8], ['approx', 1, 7]]);
    expect(day.check).toEqual({ flowVolume: 25, candleVolume: 25, ratio: 100 });
  });

  it('bez historie jen služba: objem a bubliny jen z jejích úplných minut', () => {
    const day = buildOrderFlowDay({ contract: 'NQZ6', tradeDate: '2026-11-27', tickSize: 0.25, session: SESSION, service });
    expect(day.source).toBe('live');
    expect(day.minutes.map(([m]) => m)).toEqual([START, START + 60]);
    expect(day.trades.map((t) => t[0])).toEqual(['ordA']);
    expect(day.check.candleVolume).toBeNull();
  });
});
