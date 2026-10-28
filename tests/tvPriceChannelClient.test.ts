import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTvPriceChannelClient,
  TV_CLOSE_DELAY_MS,
  TV_GRANT_GRACE_MS,
  TV_UNTRACK_DELAY_MS,
  TV_VERIFY_QUEUE_MAX,
  TV_VERIFY_TIMEOUT_MS,
  TV_REOPEN_RETRY_MS,
  type TvPriceChannelStatus,
} from '../lib/tvPriceChannelClient';
import { signTvPricePayload, signTvPriceTrail, verifyTvPriceEnvelope, verifyTvPriceTrail, type TvPricePayload } from '../lib/tvPriceMessage';
import { createTvPriceStore } from '../lib/tvPriceStore';

const T0 = Date.UTC(2026, 9, 26, 15, 0, 10);
const grant = (letter = 'a') => ({ topic: `tv-price-${letter.repeat(22)}`, key: randomBytes(32).toString('base64url') });
const payload = (seq: number, last = 21010, patch: Partial<TvPricePayload> = {}): TvPricePayload => ({
  v: 1, seq, runId: 'run-a', chart: 'CME_MINI:MNQ1!', interval: '1', pane: 1, front: 'MNQZ2026', switchAt: null,
  mode: 'streaming', bar: [Math.floor(T0 / 60_000) * 60, last, last + 1, last - 1, last], last, bid: last - 0.25, ask: last,
  at: T0 + seq * 250, ...patch,
});

interface FakeChannel {
  topic: string;
  message(envelope: unknown): void;
  status(status: TvPriceChannelStatus): void;
  tracks: unknown[];
  untracks: number;
  closed: number;
}

const setup = (options: {
  webCrypto?: boolean;
  verify?: (envelope: unknown, key: string) => Promise<TvPricePayload | null>;
  verifyTrail?: (envelope: unknown, key: string, payload: TvPricePayload) => Promise<number[] | null>;
  topicBusy?: (topic: string) => boolean;
} = {}) => {
  const channels: FakeChannel[] = [];
  let foreground = true;
  const foregroundListeners = new Set<(value: boolean) => void>();
  const store = createTvPriceStore({ now: () => T0 });
  const verify = vi.fn(options.verify ?? (async (envelope: unknown) => (envelope as { payload: TvPricePayload }).payload));
  const client = createTvPriceChannelClient({
    store,
    openChannel(topic, handlers) {
      const channel: FakeChannel = {
        topic, tracks: [], untracks: 0, closed: 0,
        message: handlers.onMessage, status: handlers.onStatus,
      };
      channels.push(channel);
      return {
        track: async meta => { channel.tracks.push(meta); },
        untrack: async () => { channel.untracks += 1; },
        close: async () => { channel.closed += 1; },
      };
    },
    verify,
    verifyTrail: options.verifyTrail,
    topicBusy: options.topicBusy,
    hasWebCrypto: () => options.webCrypto ?? true,
    isForeground: () => foreground,
    subscribeForeground: listener => {
      foregroundListeners.add(listener);
      return () => foregroundListeners.delete(listener);
    },
    now: () => T0 + 1_000,
  });
  const setForeground = (value: boolean) => {
    foreground = value;
    for (const listener of foregroundListeners) listener(value);
  };
  return { client, store, channels, verify, setForeground };
};

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('klient kanálu ceny z TV (krok 3)', () => {
  it('kanál otevře až grant + listová komponenta s pozicí + viditelná appka; presence nese jen pnl', () => {
    const t = setup();
    const access = grant();
    t.client.offerGrant('u1', access, true);
    expect(t.channels).toHaveLength(0);
    const release = t.client.addPnlInterest();
    expect(t.channels).toHaveLength(1);
    expect(t.channels[0].topic).toBe(access.topic);
    expect(t.channels[0].tracks).toEqual([]);
    t.channels[0].status('SUBSCRIBED');
    expect(t.channels[0].tracks).toEqual([{ pnl: true, chart: false }]);
    expect(t.store.diagnostics().state).toBe('waiting');
    release();
  });

  it('graf dne hlásí presence chart; přibývající zájem hned, ubývající po prodlevě', () => {
    const t = setup();
    t.client.offerGrant('u1', grant(), true);
    const releaseChart = t.client.addChartInterest();
    t.channels[0].status('SUBSCRIBED');
    expect(t.channels[0].tracks).toEqual([{ pnl: false, chart: true }]);
    const releasePnl = t.client.addPnlInterest();
    expect(t.channels[0].tracks.at(-1)).toEqual({ pnl: true, chart: true });
    releasePnl();
    expect(t.channels[0].tracks).toHaveLength(2);
    vi.advanceTimersByTime(TV_UNTRACK_DELAY_MS);
    expect(t.channels[0].tracks.at(-1)).toEqual({ pnl: false, chart: true });
    releaseChart();
    vi.advanceTimersByTime(TV_UNTRACK_DELAY_MS);
    expect(t.channels[0].untracks).toBe(1);
    vi.advanceTimersByTime(TV_CLOSE_DELAY_MS);
    expect(t.store.diagnostics()).toMatchObject({ state: 'off', reason: 'not-watching' });
  });

  it('rejoin ohlásí celý zájem a návrat zájmu během prodlevy nic nepošle', () => {
    const t = setup();
    t.client.offerGrant('u1', grant(), true);
    t.client.addChartInterest();
    const releasePnl = t.client.addPnlInterest();
    t.channels[0].status('SUBSCRIBED');
    expect(t.channels[0].tracks).toEqual([{ pnl: true, chart: true }]);
    releasePnl();
    const again = t.client.addPnlInterest();
    vi.advanceTimersByTime(TV_UNTRACK_DELAY_MS);
    expect(t.channels[0].tracks).toHaveLength(1);
    t.channels[0].status('CHANNEL_ERROR');
    t.channels[0].status('SUBSCRIBED');
    expect(t.channels[0].tracks.at(-1)).toEqual({ pnl: true, chart: true });
    again();
  });

  it('po rejoinu kanálu presence ohlásí znovu (server ji po výpadku nezná)', () => {
    const t = setup();
    t.client.offerGrant('u1', grant(), true);
    t.client.addPnlInterest();
    t.channels[0].status('SUBSCRIBED');
    t.channels[0].status('CHANNEL_ERROR');
    expect(t.store.diagnostics()).toMatchObject({ state: 'connecting', reason: 'channel_error' });
    t.channels[0].status('SUBSCRIBED');
    expect(t.channels[0].tracks).toHaveLength(2);
  });

  it('pozadí: presence pryč hned (iOS JS brzy uspí), kanál zavřený po minutě; návrat ohlásí znovu', () => {
    const t = setup();
    t.client.offerGrant('u1', grant(), true);
    t.client.addPnlInterest();
    t.channels[0].status('SUBSCRIBED');
    t.setForeground(false);
    expect(t.channels[0].untracks).toBe(1);
    t.setForeground(true);
    expect(t.channels[0].tracks).toHaveLength(2);
    expect(t.channels[0].closed).toBe(0);
    t.setForeground(false);
    vi.advanceTimersByTime(TV_CLOSE_DELAY_MS);
    expect(t.channels[0].closed).toBe(1);
    expect(t.store.diagnostics()).toMatchObject({ state: 'off', reason: 'background' });
  });

  it('remount řádků presence neodhlásí; konec zájmu až po prodlevě', () => {
    const t = setup();
    t.client.offerGrant('u1', grant(), true);
    const release = t.client.addPnlInterest();
    t.channels[0].status('SUBSCRIBED');
    release();
    const again = t.client.addPnlInterest();
    vi.advanceTimersByTime(TV_CLOSE_DELAY_MS);
    expect(t.channels[0]).toMatchObject({ untracks: 0, closed: 0 });
    again();
    vi.advanceTimersByTime(TV_UNTRACK_DELAY_MS - 1);
    expect(t.channels[0].untracks).toBe(0);
    vi.advanceTimersByTime(1);
    expect(t.channels[0].untracks).toBe(1);
  });

  it('visící ověření se po stropu času zahodí a nové téma má vlastní frontu', async () => {
    const t = setup({ verify: () => new Promise(() => undefined) });
    t.client.offerGrant('u1', grant('a'), true);
    t.client.addPnlInterest();
    t.channels[0].status('SUBSCRIBED');
    for (let seq = 0; seq < TV_VERIFY_QUEUE_MAX + 2; seq += 1) t.channels[0].message({ payload: payload(seq) });
    expect(t.store.diagnostics().dropped).toBe(2);
    await vi.advanceTimersByTimeAsync(TV_VERIFY_TIMEOUT_MS);
    expect(t.store.diagnostics().rejected).toBe(1);
    t.client.offerGrant('u1', grant('b'), true);
    t.channels[1].status('SUBSCRIBED');
    // Stará fronta je plná visících ověření; nová začíná prázdná.
    for (let seq = 0; seq < TV_VERIFY_QUEUE_MAX; seq += 1) t.channels[1].message({ payload: payload(seq) });
    expect(t.store.diagnostics()).toMatchObject({ received: TV_VERIFY_QUEUE_MAX, dropped: 0 });
  });

  it('ověřuje postupně: pořadí přijetí = pořadí příchodu, i když podpis doběhne v jiném pořadí', async () => {
    const delays = [30, 10, 1];
    const t = setup({
      verify: envelope => new Promise(resolve => setTimeout(() => resolve((envelope as { payload: TvPricePayload }).payload),
        delays[(envelope as { payload: TvPricePayload }).payload.seq])),
    });
    t.client.offerGrant('u1', grant(), true);
    t.client.addPnlInterest();
    t.channels[0].status('SUBSCRIBED');
    for (const seq of [0, 1, 2]) t.channels[0].message({ payload: payload(seq) });
    await flush();
    // Druhé ověření začne až po prvním.
    expect(t.verify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(t.verify).toHaveBeenCalledTimes(3);
    expect(t.store.diagnostics()).toMatchObject({ verified: 3, replayed: 0, gaps: 0, seq: 2 });
  });

  it('stejné téma se ještě zavírá: nový kanál až po jeho zavření (jinak by zůstal „připojuje“)', async () => {
    let busy = true;
    const t = setup({ topicBusy: () => busy });
    t.client.offerGrant('u1', grant(), true);
    t.client.addChartInterest();
    expect(t.channels).toHaveLength(0);
    expect(t.store.diagnostics()).toMatchObject({ state: 'connecting', reason: 'closing-previous' });
    await vi.advanceTimersByTimeAsync(TV_REOPEN_RETRY_MS * 3);
    expect(t.channels).toHaveLength(0);
    busy = false;
    await vi.advanceTimersByTimeAsync(TV_REOPEN_RETRY_MS);
    expect(t.channels).toHaveLength(1);
    t.channels[0].status('SUBSCRIBED');
    expect(t.store.diagnostics().state).not.toBe('connecting');
  });

  it('zaseknuté ověření cesty zprávu přijme bez cesty a frontu nezablokuje', async () => {
    const t = setup({ verifyTrail: () => new Promise<number[] | null>(() => {}) });
    t.client.offerGrant('u1', grant(), true);
    t.client.addPnlInterest();
    t.channels[0].status('SUBSCRIBED');
    for (const seq of [0, 1, 2]) t.channels[0].message({ payload: payload(seq) });
    await vi.advanceTimersByTimeAsync(TV_VERIFY_TIMEOUT_MS * 3 + 100);
    expect(t.store.diagnostics()).toMatchObject({ verified: 3, dropped: 0, seq: 2 });
    expect(t.store.view().trail).toBeNull();
  });

  it('cesta ceny: platná jde do storu k zprávě; pozměněná zprávu neshodí, jen se zahodí', async () => {
    vi.useRealTimers();
    const t = setup({ verify: verifyTvPriceEnvelope, verifyTrail: verifyTvPriceTrail });
    const access = grant();
    t.client.offerGrant('u1', access, true);
    t.client.addPnlInterest();
    t.channels[0].status('SUBSCRIBED');
    const first = payload(0, 21010, { bar: [Math.floor(T0 / 60_000) * 60, 21009, 21011, 21008, 21010] });
    const signed = (await signTvPricePayload(first, access.key))!;
    const trail = (await signTvPriceTrail({ v: 1, runId: 'run-a', seq: 0, minute: first.bar![0], path: [21009.5, 21011, 21010] }, first, access.key))!;
    t.channels[0].message({ ...signed, ...trail });
    for (let index = 0; index < 50 && t.store.diagnostics().verified < 1; index += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(t.store.view().trail).toEqual([21009.5, 21011, 21010]);
    const second = payload(1, 21010, { bar: first.bar, at: T0 + 250 });
    const signedSecond = (await signTvPricePayload(second, access.key))!;
    const trailSecond = (await signTvPriceTrail({ v: 1, runId: 'run-a', seq: 1, minute: first.bar![0], path: [21011, 21010] }, second, access.key))!;
    t.channels[0].message({ ...signedSecond, ...trailSecond, t: trailSecond.t.replace('21011', '21008') });
    for (let index = 0; index < 50 && t.store.diagnostics().verified < 2; index += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(t.store.diagnostics()).toMatchObject({ verified: 2, rejected: 0, seq: 1 });
    expect(t.store.view().trail).toBeNull();
  });

  it('skutečný podpis: platná zpráva projde, pozměněná nebo cizím klíčem podepsaná se zahodí', async () => {
    // WebCrypto běží mimo falešné časovače.
    vi.useRealTimers();
    const t = setup({ verify: verifyTvPriceEnvelope });
    const access = grant();
    t.client.offerGrant('u1', access, true);
    t.client.addPnlInterest();
    t.channels[0].status('SUBSCRIBED');
    const good = await signTvPricePayload(payload(0), access.key);
    const forged = await signTvPricePayload(payload(1, 21500), grant('b').key);
    t.channels[0].message(good);
    t.channels[0].message({ ...good!, p: good!.p.replace('21010', '21500') });
    t.channels[0].message(forged);
    t.channels[0].message({ p: 'nonsense' });
    await vi.waitFor(() => expect(t.store.diagnostics()).toMatchObject({ verified: 1, rejected: 3 }));
    expect(t.store.view().latest?.last).toBe(21010);
  });

  it('zahlcení veřejného kanálu: nad strop čekajících ověření se zprávy zahodí', () => {
    const t = setup({ verify: () => new Promise(() => undefined) });
    t.client.offerGrant('u1', grant(), true);
    t.client.addPnlInterest();
    t.channels[0].status('SUBSCRIBED');
    for (let seq = 0; seq < TV_VERIFY_QUEUE_MAX + 5; seq += 1) t.channels[0].message({ payload: payload(seq) });
    expect(t.store.diagnostics().dropped).toBe(5);
  });

  it('změna tématu: starý kanál pryč, store vyprázdněný, pozdní ověření starého kanálu se zahodí', async () => {
    let releaseOld!: () => void;
    const t = setup({
      verify: envelope => new Promise(resolve => {
        releaseOld = () => resolve((envelope as { payload: TvPricePayload }).payload);
      }),
    });
    t.client.offerGrant('u1', grant('a'), true);
    t.client.addPnlInterest();
    t.channels[0].status('SUBSCRIBED');
    t.channels[0].message({ payload: payload(0) });
    await flush();
    t.client.offerGrant('u1', grant('b'), true);
    expect(t.channels[0].closed).toBe(1);
    expect(t.channels).toHaveLength(2);
    expect(t.channels[1].topic).toBe(`tv-price-${'b'.repeat(22)}`);
    releaseOld();
    await flush();
    expect(t.store.diagnostics().verified).toBe(0);
    t.channels[0].message({ payload: payload(1) });
    expect(t.store.diagnostics().received).toBe(0);
  });

  it('serverový vypínač: připojený worker bez grantu kanál zavře hned', () => {
    const t = setup();
    t.client.offerGrant('u1', grant(), true);
    t.client.addPnlInterest();
    t.client.offerGrant('u1', undefined, true);
    expect(t.channels[0].closed).toBe(1);
    expect(t.store.diagnostics()).toMatchObject({ state: 'off', reason: 'no-grant' });
  });

  it('worker krátce nepřipojený: grant platí ještě 30 s, pak kanál zavře', () => {
    const t = setup();
    t.client.offerGrant('u1', grant(), true);
    t.client.addPnlInterest();
    t.client.offerGrant('u1', null, false);
    vi.advanceTimersByTime(TV_GRANT_GRACE_MS - 1);
    expect(t.channels[0].closed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(t.channels[0].closed).toBe(1);
  });

  it('neplatný tvar grantu se nepoužije; jiný uživatel = vše zapomenout', () => {
    const t = setup();
    t.client.addPnlInterest();
    t.client.offerGrant('u1', { topic: 'copier-kick-x', key: 'short' }, true);
    expect(t.channels).toHaveLength(0);
    t.client.offerGrant('u1', grant(), true);
    t.client.offerGrant('u2', null, true);
    expect(t.channels[0].closed).toBe(1);
    t.client.clear();
    expect(t.store.diagnostics()).toMatchObject({ state: 'off', reason: 'signed-out' });
  });

  it('bez WebCrypto kanál neotevře (zůstane kotva) a řekne proč', () => {
    const t = setup({ webCrypto: false });
    t.client.offerGrant('u1', grant(), true);
    t.client.addPnlInterest();
    expect(t.channels).toHaveLength(0);
    expect(t.store.diagnostics()).toMatchObject({ state: 'off', reason: 'no-webcrypto' });
  });

  it('chyba kanálu ani výjimka v otevření nevyhodí do LIVE', () => {
    const store = createTvPriceStore();
    const client = createTvPriceChannelClient({
      store,
      openChannel: () => { throw new Error('socket'); },
      verify: async () => null,
      hasWebCrypto: () => true,
      isForeground: () => true,
      subscribeForeground: () => () => undefined,
    });
    expect(() => client.offerGrant('u1', grant(), true)).not.toThrow();
    expect(() => client.addPnlInterest()).not.toThrow();
    expect(store.diagnostics()).toMatchObject({ state: 'off', reason: 'channel-error' });
  });
});
