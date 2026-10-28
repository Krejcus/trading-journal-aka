import { randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { signTvPricePayload, TV_PRICE_EVENT, type TvPriceEnvelope } from '../../lib/tvPriceMessage';
import {
  listTradingViewChartTargets,
  TradingViewCdpSession,
  TV_CHART_META_EXPRESSION,
  TV_FAST_PRICE_EXPRESSION,
} from '../../services/tradingViewCdpSession';
import { createIbkrPriceSource, initialPriceSourceSwitch, nextPriceSource, type IbkrPriceSource } from '../../services/ibkrPriceSource';
import { createTvPriceStream, realtimeChannelCanPush, type TvPriceStream, type TvStreamMeta, type TvStreamReading } from '../../services/tradingViewPriceStream';

/**
 * Vstup vlákna kanálu ceny z TradingView (samostatný bundle
 * `tv-price-stream.mjs`, nikdy bundle workeru — INV-WORKER-04). Neimportuje
 * nic z kopírky; hlavní vlákno mu jen pošle konfiguraci a čte `alive`.
 * Jen zobrazení: cena odsud nikdy nevstupuje do rozhodování (INV-UI-04).
 *
 * Chyba tady ukončí jen tohle vlákno; hlídač (`server/tvPriceStreamSupervisor.ts`)
 * ho restartuje s prodlevou nebo vypne jističem. TV se odsud nikdy nespouští.
 *
 * Zdroj ceny (`workerData.priceSource`, výchozí `tv`): při `ibkr` se čte IB
 * Gateway na 127.0.0.1 (`services/ibkrPriceSource.ts`, jen čtení) a TV je
 * záloha. Přepnutí zdroje = nový běh (`runId`), aby klient nikdy nesložil
 * jednu řadu vzorků ze dvou zdrojů.
 */

interface StreamConfig {
  enabled: boolean;
  url?: string;
  anonKey?: string;
  topic?: string;
  key?: string;
  excludeTargetId?: string;
  excludeChartId?: string;
}

type FastChart = {
  symbol?: unknown; interval?: unknown; bar?: unknown; last?: unknown; bid?: unknown; ask?: unknown; mode?: unknown;
} | null;
type MetaChart = { interval?: unknown; frontContract?: unknown; frontContractSwitchTime?: unknown } | null;

const META_REFRESH_MS = 60_000;
/** Jak často vlákno posílá svíčky dne z IBKR hlavnímu vláknu (hlídač drží max 1×/10 s). */
const IBKR_BARS_POST_MS = 30_000;
const IBKR_BARS_POST_PHASE_MS = 7_000;
const READ_TIMEOUT_MS = 1_000;

const port = parentPort;
if (!port) throw new Error('tv-price-stream-thread-only');

const priceSource: 'tv' | 'ibkr' = (workerData as { priceSource?: unknown } | null)?.priceSource === 'ibkr' ? 'ibkr' : 'tv';
let config: StreamConfig | null = null;
let stream: TvPriceStream | null = null;
let client: SupabaseClient | null = null;
let channel: RealtimeChannel | null = null;
let joined = false;
let synced = false;
let demand = false;
let session: TradingViewCdpSession | null = null;
let pane = -1;
let meta: TvStreamMeta = { front: null, switchAt: null };
let metaAt = 0;
let discovering = false;
let discoveryFailures = 0;
let nextDiscoveryAt = 0;
let ibkr: IbkrPriceSource | null = null;
let sourceSwitch = initialPriceSourceSwitch();
let ibkrMeta: TvStreamMeta = { front: null, switchAt: null };

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value: unknown, max = 64): string | null => typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;

const closeSession = () => {
  const current = session;
  session = null;
  pane = -1;
  current?.close();
};

/** Najde 1m panel mimo snímkový graf workeru; TV nikdy nespouští. */
const discover = async (cfg: StreamConfig) => {
  if (discovering || Date.now() < nextDiscoveryAt) return;
  discovering = true;
  try {
    const targets = (await listTradingViewChartTargets()).filter(target => target.id !== cfg.excludeTargetId
      && !(cfg.excludeChartId && target.url?.includes(`/chart/${cfg.excludeChartId}`)));
    for (const target of targets) {
      let candidate: TradingViewCdpSession | null = null;
      try {
        candidate = await TradingViewCdpSession.open(target.webSocketDebuggerUrl!, 2_000);
        const charts = (await candidate.evaluate(TV_CHART_META_EXPRESSION, 2_000)).value;
        const list = Array.isArray(charts) ? charts as MetaChart[] : [];
        const index = list.findIndex(chart => chart?.interval === '1');
        if (index < 0) { candidate.close(); continue; }
        if (config !== cfg) { candidate.close(); return; }
        session = candidate;
        pane = index;
        meta = { front: text(list[index]?.frontContract, 16), switchAt: finite(list[index]?.frontContractSwitchTime) };
        metaAt = Date.now();
        candidate.onClose(() => { if (session === candidate) { session = null; pane = -1; } });
        discoveryFailures = 0;
        return;
      } catch {
        candidate?.close();
      }
    }
    discoveryFailures += 1;
    nextDiscoveryAt = Date.now() + Math.min(30_000, 2_000 * 2 ** Math.min(discoveryFailures, 4));
  } catch {
    discoveryFailures += 1;
    nextDiscoveryAt = Date.now() + Math.min(30_000, 2_000 * 2 ** Math.min(discoveryFailures, 4));
  } finally {
    discovering = false;
  }
};

const refreshMeta = async (current: TradingViewCdpSession, index: number) => {
  metaAt = Date.now();
  try {
    const charts = (await current.evaluate(TV_CHART_META_EXPRESSION, 2_000)).value;
    const chart = Array.isArray(charts) ? charts[index] as MetaChart : null;
    if (chart && session === current) meta = { front: text(chart.frontContract, 16), switchAt: finite(chart.frontContractSwitchTime) };
  } catch { /* metadata počkají na další pokus */ }
};

const readTv = async (): Promise<TvStreamReading | null> => {
  const cfg = config;
  if (!cfg) return null;
  const current = session;
  if (!current || current.closed || pane < 0) {
    void discover(cfg);
    return null;
  }
  if (Date.now() - metaAt > META_REFRESH_MS) void refreshMeta(current, pane);
  const value = (await current.evaluate(TV_FAST_PRICE_EXPRESSION, READ_TIMEOUT_MS)).value as { charts?: unknown } | null;
  const chart = Array.isArray(value?.charts) ? value!.charts[pane] as FastChart : null;
  if (!chart || chart.interval !== '1') {
    // Panel zmizel nebo už není 1m: znovu najít, nic neposílat.
    closeSession();
    return null;
  }
  const bar = Array.isArray(chart.bar) && chart.bar.length >= 5 && chart.bar.slice(0, 5).every(item => finite(item) !== null)
    ? chart.bar.slice(0, 5) as [number, number, number, number, number] : null;
  return {
    chart: text(chart.symbol) ?? 'unknown',
    interval: '1',
    pane,
    bar,
    last: finite(chart.last),
    bid: finite(chart.bid),
    ask: finite(chart.ask),
    mode: text(chart.mode, 32),
  };
};

/**
 * IBKR, když je k dispozici, jinak TV. Přepnutí zdroje zastaví tenhle stream
 * a založí nový s novým `runId`; do té doby se nic neposílá.
 */
const read = async (): Promise<TvStreamReading | null> => {
  const source = ibkr;
  if (!source) return readTv();
  const reading = source.reading();
  const next = nextPriceSource(sourceSwitch, reading !== null, Date.now());
  sourceSwitch = next.state;
  if (next.changed) {
    restartStream();
    return null;
  }
  if (sourceSwitch.active === 'tv') return readTv();
  if (!reading) return null;
  ibkrMeta = { front: reading.front, switchAt: null };
  return {
    chart: reading.chart, interval: '1', pane: 0, bar: reading.bar,
    last: reading.last, bid: reading.bid, ask: reading.ask, mode: reading.mode,
  };
};

const publish = async (envelope: TvPriceEnvelope): Promise<boolean> => {
  const current = channel;
  // Jen připojený kanál: jinak by realtime-js tiše přešel na REST POST.
  if (!current || !client || !realtimeChannelCanPush(client.realtime.isConnected(), current.state)) return false;
  return await current.send({ type: 'broadcast', event: TV_PRICE_EVENT, payload: envelope }) === 'ok';
};

const computeDemand = () => {
  const state = channel?.presenceState() ?? {};
  demand = Object.values(state).some(entries => (entries as Array<{ pnl?: unknown; chart?: unknown }>)
    .some(entry => entry?.pnl === true || entry?.chart === true));
};

const closeChannel = async () => {
  const currentClient = client;
  const currentChannel = channel;
  client = null;
  channel = null;
  joined = false;
  synced = false;
  demand = false;
  if (!currentClient) return;
  try {
    if (currentChannel) await currentClient.removeChannel(currentChannel);
  } catch { /* odhlášení je best effort */ }
  try {
    currentClient.realtime.disconnect();
  } catch { /* best effort */ }
};

const openChannel = (cfg: Required<Pick<StreamConfig, 'url' | 'anonKey' | 'topic'>>) => {
  const created = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const createdChannel = created.channel(cfg.topic, { config: { broadcast: { self: false, ack: false } } });
  client = created;
  channel = createdChannel;
  createdChannel.on('presence', { event: 'sync' }, () => {
    if (channel !== createdChannel) return;
    // Po (re)joinu se streamuje až po prvním syncu presence.
    synced = true;
    computeDemand();
  });
  createdChannel.subscribe(status => {
    if (channel !== createdChannel) return;
    joined = status === 'SUBSCRIBED';
    if (!joined) { synced = false; demand = false; }
  });
};

const stopAll = async () => {
  stream?.stop();
  stream = null;
  ibkr?.stop();
  ibkr = null;
  sourceSwitch = initialPriceSourceSwitch();
  closeSession();
  await closeChannel();
};

const createStream = () => createTvPriceStream({
  read,
  meta: () => (sourceSwitch.active === 'ibkr' ? ibkrMeta : meta),
  demand: () => demand,
  ready: () => joined && synced,
  // Klíč se čte z aktuální konfigurace — změna tajemství na serveru přijde bez restartu.
  sign: payload => config?.key ? signTvPricePayload(payload, config.key) : Promise.resolve(null),
  publish,
  // Nový běh při každém (re)startu streamu: přepnutí zdroje = nová řada u klienta.
  runId: randomUUID(),
});

function restartStream() {
  stream?.stop();
  stream = createStream();
  stream.start();
}

const apply = async (next: StreamConfig) => {
  const previous = config;
  const usable = next.enabled && next.url && next.anonKey && next.topic && next.key;
  if (!usable) {
    config = null;
    await stopAll();
    return;
  }
  config = next;
  const channelChanged = !previous || previous.url !== next.url || previous.anonKey !== next.anonKey || previous.topic !== next.topic;
  if (channelChanged) {
    await closeChannel();
    openChannel({ url: next.url!, anonKey: next.anonKey!, topic: next.topic! });
  }
  if (!previous || previous.excludeTargetId !== next.excludeTargetId || previous.excludeChartId !== next.excludeChartId) {
    closeSession();
    nextDiscoveryAt = 0;
  }
  if (priceSource === 'ibkr' && !ibkr) {
    // Selhání IBKR nesmí zastavit čtení z TV v tomtéž vlákně.
    try {
      // Dávka obchodů = poslat hned; jen když je IBKR aktivní zdroj (na TV by to jen přidalo čtení CDP).
      const created = createIbkrPriceSource({ onTrade: () => { if (sourceSwitch.active === 'ibkr') stream?.nudge(); } });
      created.start();
      ibkr = created;
    } catch {
      ibkr = null;
    }
  }
  if (!stream) restartStream();
};

// Konfigurace se aplikují postupně — překryté přepojení kanálu by nechalo dva klienty.
let applying: Promise<void> = Promise.resolve();
port.on('message', message => {
  if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'config') return;
  applying = applying.then(() => apply(message as StreamConfig)).catch(() => undefined);
});

setInterval(() => port.postMessage({ type: 'alive' }), 2_000);
// Svíčky dne z IBKR pro graf dne a hodnocení (fáze 4): jen hotová čísla, buffer se
// předá bez kopírování; hlavní vlákno je jen ověří a nechá v paměti pro upload.
const postBars = () => {
  const bars = ibkr?.minuteBars() ?? null;
  if (!bars) return;
  port.postMessage({ type: 'bars', root: bars.root, source: bars.source, contract: bars.contract, at: bars.at, bars: bars.bars }, [bars.bars.buffer]);
};
// Zarovnáno na 7. a 37. sekundu: upload svíček dne v 10. sekundě (pilot) tak nese
// uzavřenou předchozí minutu, ne stav z její poloviny.
// Řetěz časovačů: prodleva se pokaždé počítá z hodin, aby fázi nerozhodilo
// zpožďování ani uspání Macu (setInterval by ji postupně ztratil).
const schedulePostBars = () => {
  const raw = (IBKR_BARS_POST_MS + IBKR_BARS_POST_PHASE_MS - (Date.now() % IBKR_BARS_POST_MS)) % IBKR_BARS_POST_MS;
  setTimeout(() => { postBars(); schedulePostBars(); }, raw < 1_000 ? raw + IBKR_BARS_POST_MS : raw);
};
schedulePostBars();
setInterval(() => {
  const stats = stream?.stats();
  // Jen čísla a stav; téma, klíč ani obsah zpráv nikdy.
  const ib = ibkr?.stats();
  port.postMessage({
    type: 'diag', state: stats?.state ?? 'off', reads: stats?.reads ?? 0, sends: stats?.sends ?? 0, errors: stats?.errors ?? 0,
    // Zdroj a stav IBKR jen jako krátké kódy (nikdy text chyb Gateway).
    source: sourceSwitch.active, ibkr: ib?.state ?? null, ibkrCode: ib?.lastCode ?? null, ibkrTrades: ib?.trades ?? 0,
  });
}, 60_000);
