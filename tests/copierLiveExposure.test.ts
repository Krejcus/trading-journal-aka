import { describe, expect, it } from 'vitest';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import {
  decryptCopierLiveExposure, encryptCopierLiveExposure, isCopierLiveExposurePayload, mergeCopierLiveExposure, mergeCopyEvents,
  type CopierLiveExposurePayload,
} from '../lib/copierLiveExposure';

const KEY = 'A'.repeat(43); // 32 B base64url
const OTHER_KEY = 'B'.repeat(43);
const TOPIC = 'copier-nudge-abcdefghijklmnopqrstuv';
const STARTED = '2026-10-30T18:28:10.000Z';

const payload = (seq: number, builtAt: number, netQuantity = 1): CopierLiveExposurePayload => ({
  v: 1,
  startedAt: STARTED,
  seq,
  builtAt,
  exposure: {
    verifiedAt: 1,
    positions: netQuantity ? [{ accountId: 100, symbol: 'MNQZ6', netQuantity, avgPrice: 28_274.5 }] : [],
    followers: [{ accountId: 200, ok: true, detail: null }],
    orders: [{ accountId: 100, brokerOrderId: '711', symbol: 'MNQZ6', side: 'Sell', orderType: 'Stop', quantity: 1, filledQuantity: 0,
      limitPrice: null, stopPrice: 28_258.5, status: 'working', updatedAt: builtAt }],
  },
  events: [{ id: 'e-1', at: builtAt, kind: 'entry', side: 'Long', quantity: 1, symbol: 'MNQZ6', followers: 1 } as never],
});

const status = (displaySeq: number | undefined, displayBuiltAt: number | undefined, startedAt = STARTED): LocalCopierAgentStatus => ({
  startedAt,
  ...(displaySeq != null ? { displaySeq } : {}),
  ...(displayBuiltAt != null ? { displayBuiltAt } : {}),
  controller: {
    connected: true,
    exposure: { verifiedAt: 1, positions: [], followers: [], orders: [] },
    recentCopyEvents: [{ id: 'e-0', at: 5, kind: 'order-placed' }],
  },
} as unknown as LocalCopierAgentStatus);

describe('expozice workeru přímo do grafu (F2a, 30. 10.)', () => {
  it('šifrování tam a zpět zachová obsah; cizí klíč, jiné téma ani upravená zpráva neprojdou', async () => {
    const envelope = await encryptCopierLiveExposure(payload(5, 1_000), KEY, TOPIC);
    expect(envelope).not.toBeNull();
    expect(JSON.stringify(envelope)).not.toContain('MNQZ6');
    expect(await decryptCopierLiveExposure(envelope, KEY, TOPIC)).toEqual(payload(5, 1_000));
    expect(await decryptCopierLiveExposure(envelope, OTHER_KEY, TOPIC)).toBeNull();
    expect(await decryptCopierLiveExposure(envelope, KEY, 'copier-nudge-zzzzzzzzzzzzzzzzzzzzzz')).toBeNull();
    // Převrátit bit prvního bajtu (vždy jiný obsah, nikdy náhodou stejný bajt).
    const flip = (value: string) => {
      const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)), char => char.charCodeAt(0));
      bytes[0] ^= 0x01;
      return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    expect(await decryptCopierLiveExposure({ ...envelope!, ct: flip(envelope!.ct) }, KEY, TOPIC)).toBeNull();
    expect(await decryptCopierLiveExposure({ ...envelope!, iv: flip(envelope!.iv) }, KEY, TOPIC)).toBeNull();
    for (const bad of [null, 42, {}, { v: 2, iv: envelope!.iv, ct: envelope!.ct }, { v: 1, iv: 'x', ct: envelope!.ct }]) {
      expect(await decryptCopierLiveExposure(bad, KEY, TOPIC)).toBeNull();
    }
  });

  it('neplatný klíč = null, nikdy nevyhodí; expozice null je platná', async () => {
    expect(await encryptCopierLiveExposure(payload(1, 1), 'short', TOPIC)).toBeNull();
    expect(await decryptCopierLiveExposure({ v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' }, 'not base64!', TOPIC)).toBeNull();
    const unknown = { ...payload(2, 2), exposure: null };
    const envelope = await encryptCopierLiveExposure(unknown, KEY, TOPIC);
    expect(await decryptCopierLiveExposure(envelope, KEY, TOPIC)).toEqual(unknown);
  });

  it('tvar: odmítne chybějící seq, nekonečná čísla, záporný průměr a moc událostí', () => {
    expect(isCopierLiveExposurePayload(payload(1, 1))).toBe(true);
    const broken = (patch: (value: CopierLiveExposurePayload) => void) => {
      const value = structuredClone(payload(1, 1));
      patch(value);
      return isCopierLiveExposurePayload(value);
    };
    expect(broken(value => { (value as { seq?: number }).seq = undefined; })).toBe(false);
    expect(broken(value => { value.seq = 0; })).toBe(false);
    expect(broken(value => { value.exposure!.positions[0].netQuantity = Number.NaN; })).toBe(false);
    expect(broken(value => { value.exposure!.positions[0].avgPrice = -1; })).toBe(false);
    expect(broken(value => { value.events = Array.from({ length: 11 }, (_, index) => ({ ...value.events[0], id: `e-${index}` })); })).toBe(false);
    expect(broken(value => { (value as { startedAt: string }).startedAt = 'nope'; })).toBe(false);
    // Meze proti pádu grafu z podvrhu s platným klíčem.
    expect(broken(value => { value.exposure!.orders![0].updatedAt = 9e15; })).toBe(false);
    expect(broken(value => { value.exposure!.positions[0].netQuantity = 1.5; })).toBe(false);
    expect(broken(value => { (value.events[0] as { price?: unknown }).price = '28000'; })).toBe(false);
    expect(broken(value => { (value.events[0] as { side?: unknown }).side = 'Buy'; })).toBe(false);
    expect(broken(value => { value.exposure!.positions[0].symbol = 'X'.repeat(100); })).toBe(false);
    expect(broken(value => { value.builtAt = -1; })).toBe(false);
  });

  it('sloučení: novější seq téhož běhu nahradí expozici; stáří od kotvy pollu, nejvýš čas přijetí', () => {
    // Poll seq 10 sestaven v 1 000 (hodiny workeru), přijat v 8 000 (hodiny desku).
    const merged = mergeCopierLiveExposure(status(10, 1_000), 8_000, {
      payload: payload(12, 1_300), receivedAt: 8_500, receivedPerformanceAt: 100,
    });
    expect(merged.status!.controller.exposure).toEqual(payload(12, 1_300).exposure);
    expect(merged.exposureObservedAt).toBe(8_300);
    expect(merged.status!.controller.recentCopyEvents!.map(event => event.id)).toEqual(['e-0', 'e-1']);
    // Zbytek controlleru i statusu z pollu.
    expect(merged.status!.controller.connected).toBe(true);
    expect(merged.status!.displaySeq).toBe(10);
  });

  it('starší nebo stejné seq, jiný běh, starý worker a chybějící status = beze změny', () => {
    const received = { payload: payload(10, 1_300), receivedAt: 8_500, receivedPerformanceAt: 100 };
    expect(mergeCopierLiveExposure(status(10, 1_000), 8_000, received)).toEqual({ status: status(10, 1_000), exposureObservedAt: 8_000 });
    expect(mergeCopierLiveExposure(status(11, 1_200), 8_000, received).exposureObservedAt).toBe(8_000);
    expect(mergeCopierLiveExposure(status(5, 1_000, '2026-10-30T19:00:00.000Z'), 8_000, received).exposureObservedAt).toBe(8_000);
    expect(mergeCopierLiveExposure(status(undefined, undefined), 8_000, received).exposureObservedAt).toBe(8_000);
    expect(mergeCopierLiveExposure(null, null, received)).toEqual({ status: null, exposureObservedAt: null });
    expect(mergeCopierLiveExposure(status(5, 1_000), null, received).exposureObservedAt).toBeNull();
  });

  it('novější poll vyhrává i s exposure null (worker po flat/odpojení)', () => {
    const polled = status(20, 2_000);
    polled.controller.exposure = null;
    const merged = mergeCopierLiveExposure(polled, 9_000, {
      payload: payload(15, 1_500), receivedAt: 9_100, receivedPerformanceAt: 100,
    });
    expect(merged.status!.controller.exposure).toBeNull();
    expect(merged.exposureObservedAt).toBe(9_000);
  });

  it('zpráva „z budoucnosti“ proti kotvě pollu se zahodí; přehraná stará zpráva nevypadá čerstvě', () => {
    // Poll přijat v 8 000; zpráva tvrdí builtAt o 5 s později, ale přišla jen 0,5 s po pollu.
    expect(mergeCopierLiveExposure(status(10, 1_000), 8_000, {
      payload: payload(11, 6_000), receivedAt: 8_500, receivedPerformanceAt: 100,
    }).exposureObservedAt).toBe(8_000);
    // Doručeno se zpožděním (probuzení): builtAt jen +200 ms po pollu → stáří od kotvy, ne od přijetí.
    const late = mergeCopierLiveExposure(status(10, 1_000), 8_000, {
      payload: payload(11, 1_200), receivedAt: 15_000, receivedPerformanceAt: 100,
    });
    expect(late.exposureObservedAt).toBe(8_200);
  });

  it('události: sjednocení podle id, seřazené, nejvýš 20, nikdy nenahrazuje', () => {
    const polled = Array.from({ length: 20 }, (_, index) => ({ id: `p-${index}`, at: index, kind: 'entry' })) as never[];
    const live = [{ id: 'p-19', at: 19, kind: 'entry' }, { id: 'n-1', at: 30, kind: 'exit' }] as never[];
    const merged = mergeCopyEvents(polled, live);
    expect(merged).toHaveLength(20);
    expect(merged.at(-1)!.id).toBe('n-1');
    expect(merged.filter(event => event.id === 'p-19')).toHaveLength(1);
    // Nejdřív 10 z kanálu, pak 20 z pollu (stejná id) → nic nového.
    const first = mergeCopyEvents([], polled.slice(10));
    expect(mergeCopyEvents(polled, first).map(event => event.id)).toEqual(polled.map(event => (event as { id: string }).id));
  });
});
