import { afterEach, describe, expect, it, vi } from 'vitest';
import { tvPriceChannelGrant } from '../server/tvPriceChannel';
import { isTvPricePayload, signTvPricePayload, verifyTvPriceEnvelope, type TvPricePayload } from '../lib/tvPriceMessage';

const SECRET = 'x'.repeat(48);
const DEVICE = '0b9d1c64-1f0a-4c55-9d21-6a3f7e2b8c11';
const OTHER_DEVICE = '7a1e3b52-9c0d-4e8f-a1b2-c3d4e5f60718';

const payload = (overrides: Partial<TvPricePayload> = {}): TvPricePayload => ({
  v: 1, seq: 7, runId: 'run-a', chart: 'CME_MINI:MNQ1!', interval: '1', pane: 1,
  front: 'MNQZ2026', switchAt: 1_797_285_601, mode: 'streaming',
  bar: [1_792_994_820, 29_144, 29_145.25, 29_139, 29_140.75], last: 29_140.75, bid: 29_140.5, ask: 29_141,
  at: 1_792_994_861_000, ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('kanál ceny z TV — odvození tématu a klíče (server)', () => {
  it('bez tajemství, s krátkým tajemstvím nebo cizím ID vrací null (pole se vynechá, žádné 502)', () => {
    expect(tvPriceChannelGrant(DEVICE, undefined)).toBeNull();
    expect(tvPriceChannelGrant(DEVICE, 'short')).toBeNull();
    expect(tvPriceChannelGrant('device', SECRET)).toBeNull();
    expect(tvPriceChannelGrant(null, SECRET)).toBeNull();
    expect(tvPriceChannelGrant({ toString: () => DEVICE }, SECRET)).toBeNull();
  });

  it('je deterministické a liší se podle zařízení i tajemství', () => {
    const grant = tvPriceChannelGrant(DEVICE, SECRET)!;
    expect(grant.topic).toMatch(/^tv-price-[A-Za-z0-9_-]{22}$/);
    expect(grant.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tvPriceChannelGrant(DEVICE.toUpperCase(), SECRET)).toEqual(grant);
    expect(tvPriceChannelGrant(OTHER_DEVICE, SECRET)!.topic).not.toBe(grant.topic);
    expect(tvPriceChannelGrant(DEVICE, 'y'.repeat(48))!.key).not.toBe(grant.key);
    // Téma neprozradí klíč ani zařízení.
    expect(grant.topic).not.toContain(DEVICE);
    expect(grant.key.startsWith(grant.topic.slice('tv-price-'.length))).toBe(false);
  });
});

describe('kanál ceny z TV — podepsaná zpráva', () => {
  const key = tvPriceChannelGrant(DEVICE, SECRET)!.key;
  const otherKey = tvPriceChannelGrant(OTHER_DEVICE, SECRET)!.key;

  it('podepsanou zprávu ověří a vrátí přesně odeslaný obsah', async () => {
    const envelope = await signTvPricePayload(payload(), key);
    expect(envelope).not.toBeNull();
    expect(await verifyTvPriceEnvelope(envelope, key)).toEqual(payload());
  });

  it('pozměněný obsah, cizí klíč, chybějící nebo poškozený podpis = null', async () => {
    const envelope = (await signTvPricePayload(payload(), key))!;
    expect(await verifyTvPriceEnvelope({ ...envelope, p: envelope.p.replace('29140.75', '29999') }, key)).toBeNull();
    expect(await verifyTvPriceEnvelope(envelope, otherKey)).toBeNull();
    expect(await verifyTvPriceEnvelope({ p: envelope.p }, key)).toBeNull();
    expect(await verifyTvPriceEnvelope({ ...envelope, sig: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, key)).toBeNull();
    expect(await verifyTvPriceEnvelope('not-an-envelope', key)).toBeNull();
    expect(await verifyTvPriceEnvelope(null, key)).toBeNull();
  });

  it('podepisuje se surový řetězec: stejná data v jiném pořadí klíčů neprojdou', async () => {
    const envelope = (await signTvPricePayload(payload(), key))!;
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(envelope.p)).reverse()));
    expect(await verifyTvPriceEnvelope({ p: reordered, sig: envelope.sig }, key)).toBeNull();
  });

  it('platný podpis nad neplatným obsahem neprojde (validace až po ověření)', async () => {
    expect(await signTvPricePayload(payload({ interval: '' }), key)).toBeNull();
    expect(isTvPricePayload(payload({ bar: [1_792_994_821, 1, 2, 0.5, 1.5] }))).toBe(false);
    expect(isTvPricePayload(payload({ bar: [1_792_994_820, 10, 9, 8, 9.5] }))).toBe(false);
    expect(isTvPricePayload(payload({ last: -1 }))).toBe(false);
    expect(isTvPricePayload({ ...payload(), v: 2 })).toBe(false);
    expect(isTvPricePayload(payload({ last: null, bid: null, ask: null, bar: null, front: null, mode: null, switchAt: null }))).toBe(true);
  });

  it('klíč navíc, chybějící klíč, bid nad ask nebo neceločíselný čas = neplatná zpráva', () => {
    expect(isTvPricePayload({ ...payload(), extra: 1 })).toBe(false);
    const { ask: _ask, ...missing } = payload();
    expect(isTvPricePayload(missing)).toBe(false);
    expect(isTvPricePayload(payload({ bid: 29_141.5, ask: 29_141 }))).toBe(false);
    expect(isTvPricePayload(payload({ at: 1.5 }))).toBe(false);
    expect(isTvPricePayload(payload({ at: 0 }))).toBe(false);
  });

  it('podpis s poškozeným klíčem nevyhodí (běží ve vlákně workeru)', async () => {
    await expect(signTvPricePayload(payload(), 'A'.repeat(21))).resolves.toBeNull();
    await expect(verifyTvPriceEnvelope({ p: '{}', sig: 'A'.repeat(21) }, key)).resolves.toBeNull();
  });

  it('příliš velká zpráva se nepodepíše ani neověří', async () => {
    const envelope = (await signTvPricePayload(payload(), key))!;
    expect(await verifyTvPriceEnvelope({ p: envelope.p + ' '.repeat(3_000), sig: envelope.sig }, key)).toBeNull();
  });

  it('bez WebCrypto (nezabezpečený kontext) ověření selže a klient zůstane u kotvy', async () => {
    const envelope = (await signTvPricePayload(payload(), key))!;
    vi.stubGlobal('crypto', {});
    const freshKey = tvPriceChannelGrant(OTHER_DEVICE, 'z'.repeat(48))!.key;
    expect(await verifyTvPriceEnvelope(envelope, freshKey)).toBeNull();
    expect(await signTvPricePayload(payload(), freshKey)).toBeNull();
  });
});
