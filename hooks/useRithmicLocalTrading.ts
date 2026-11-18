// Obchodování přes místní proces Rithmicu (scripts/rithmic/devTradeServer.ts) pro obrazovku
// LiveTradingScreen: spojení, stav, cena a svíčky, karty obchodů a příkazy.
// Stav v prohlížeči slouží JEN k zobrazení — každý příkaz ověřuje místní proces (LocalExec).
// Žádné opakování: příkaz bez odpovědi končí „unknown" a nikdy se neposílá znovu.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveTradingCopyEvent, LiveTradingMarketData } from '../components/LiveTradingScreen';
import type { LiveCandleFeed } from '../lib/liveCandleFeed';
import type { LiveChartPosition, LiveChartPositionSummary } from '../lib/liveChartPosition';
import type { LiveEntryPreviewDraft } from '../lib/leaderEntryPreview';
import type { LeaderEntryPlaceResult } from '../lib/leaderEntryPlace';
import type { LeaderOrderManageAction, LeaderOrderManageResult } from '../lib/leaderOrderManage';
import type { MarketCandle } from '../services/marketDataCalculations';
import type { LocalExecClose, LocalExecCommand, LocalExecOrderView, LocalExecState } from '../services/rithmic/localExec';
import type { BareLeaderTrade } from '../lib/manualBareClose';
import type { LiveBareLegIntent } from '../lib/liveBareLeg';
import type { LiveTicketScaleIn } from '../lib/liveScaleIn';
import { liveWorkingOrderView } from '../lib/liveWorkingOrderLines';
import { RithmicPendingJournal, type PendingRithmicCommand } from '../lib/rithmicPendingJournal';
import { RithmicLocalConnection } from '../lib/rithmicLocalConnection';
import { liveChartFills, type LiveChartWorkingOrders } from './useLiveChartData';

/** Obrazovka chce číslo účtu „leadera"; u jednoho účtu jen formální. */
export const RITHMIC_SOLO_ACCOUNT = 1;
const RECONNECT_MS = 2_000;
const REPLY_TIMEOUT_MS = 15_000;
/** Bez zprávy od procesu déle než tohle = data jsou stará (tep chodí každou sekundu). */
const BEAT_TIMEOUT_MS = 4_000;

interface Bar { time: number; open: number; high: number; low: number; close: number; volume?: number }
type Limits = import('../services/rithmic/rithmicQuantityLimits').RithmicQuantityLimits;
interface Hello { account?: string; closeOnly?: boolean; limits?: Limits | null; readOnly?: boolean; /** Služba posílá příkazy na SKUTEČNÝ účet (souhlas vydaný člověkem). */ live?: boolean; feed?: boolean; system: string; symbol: string; tickSize: number; pointValue: number | null; price: number | null; bars: Bar[] }
export interface Reply { ok: boolean; sent?: boolean | 'unknown'; error?: string; result?: unknown }
export type RithmicLocalLinkState = 'off' | 'connecting' | 'open' | 'closed';

export interface RithmicLocalTradingOptions {
  /** Adresa místního procesu včetně tokenu; null = cesta vypnutá (žádné spojení). */
  url: string | null;
  /** Spojení se drží jen dokud je true (otevřená záložka Graf). */
  enabled: boolean;
  /** Jen pro měření klik → čára na zkušební stránce. */
  onMeasure?: (label: string, done: (state: LocalExecState) => boolean) => void;
}

const candle = (bar: Bar): MarketCandle => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume ?? 0 });
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Zdroj živé svíčky a ceny pro graf: drží poslední data z místního procesu. Jen zobrazení. */
function createFeed() {
  const listeners = new Set<() => void>();
  let forming: MarketCandle | null = null;
  let last: number | null = null;
  const feed: LiveCandleFeed = {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    current: () => forming,
    lastPrice: () => last,
    contractMatchesData: () => true,
  };
  return {
    feed,
    reset() { forming = null; last = null; for (const listener of [...listeners]) listener(); },
    push(price: number | null, bar: MarketCandle | null) {
      last = price;
      if (bar) forming = bar;
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * Poslední příkaz s NEZNÁMÝM výsledkem (spojení spadlo nebo proces neodpověděl). Drží se mimo
 * komponentu, aby varování přežilo odchod ze záložky i obnovu spojení — dokud ho uživatel nezavře.
 */
export interface RithmicUncertainCommand { id: string; at: number; label: string; reason: string; confirmed?: boolean }
const NO_UNCERTAIN: readonly RithmicUncertainCommand[] = [];
// Vlastní výstupní Market částečného zavření (značka ui-red-) pracuje jen zlomek sekundy — není to cizí příkaz (jen zobrazení).
const isOwnExit = (order: { tag?: string; orderType?: string }): boolean => order.orderType === 'Market' && order.tag?.startsWith('ui-red-') === true;
const COMMAND_LABEL: Record<LocalExecCommand['op'], string> = { 'move-legs': 'Posun SL/TP', protect: 'Přidání SL/TP', 'protect-pair': 'Přidání SL a TP', 'replace-entry': 'Změna čekajícího vstupu', entry: 'Vstup', move: 'Posun SL/TP', cancel: 'Zrušení příkazu', flatten: 'Zavření pozice', reduce: 'Částečné zavření', ack: 'Potvrzení incidentu' };

/**
 * Odpověď služby na zavření pozice. `ok: true` znamená jen „služba doběhla" — výsledek zavření nese
 * `result.status`: odmítnuté ani nejisté zavření se NESMÍ tvářit jako hotové.
 */
export function rithmicFlattenReply(reply: Reply): Reply {
  if (!reply.ok) return reply;
  const result = (reply.result ?? {}) as { status?: unknown; reason?: unknown };
  const reason = typeof result.reason === 'string' ? result.reason : null;
  if (result.status === 'submitted' || result.status === 'already-flat') return reply;
  if (result.status === 'rejected') return { ok: false, sent: false, error: reason ?? 'Rithmic zavření pozice odmítl.' };
  return { ok: false, sent: 'unknown', error: reason ?? 'Výsledek zavření není znám — ověř stav.' };
}

/** Pracující nohy pozice podle role a která z nich se kreslí jako čára. Čistá funkce, jen zobrazení. */
export function rithmicLegView(orders: readonly LocalExecOrderView[], net: number) {
  const working = (role: 'stop' | 'target') => orders.filter((order) => order.role === role && order.status === 'working' && order.price !== undefined);
  const stops = working('stop');
  const targets = working('target');
  const long = net >= 0;
  const pick = (list: LocalExecOrderView[], highest: boolean) => list.reduce<LocalExecOrderView | null>((best, order) => (!best || (highest ? order.price! > best.price! : order.price! < best.price!) ? order : best), null);
  // Fallback na nepotvrzenou nohu, ať čára nezmizí během změny.
  const any = (role: 'stop' | 'target') => orders.find((order) => order.role === role) ?? null;
  const stop = pick(stops, long) ?? any('stop');
  const target = pick(targets, !long) ?? any('target');
  const prices = (list: LocalExecOrderView[]) => [...new Set(list.map((order) => order.price!))].sort((a, b) => a - b);
  const note = [prices(stops).length > 1 ? `SL má ${prices(stops).length} ceny (${prices(stops).map((value) => value.toFixed(2)).join(' / ')})` : null,
    prices(targets).length > 1 ? `TP má ${prices(targets).length} ceny (${prices(targets).map((value) => value.toFixed(2)).join(' / ')})` : null].filter(Boolean).join(', ') || null;
  return { stops, targets, stop, target, note };
}

interface Seen { net: number; avg: number | null; entries: Map<string, LocalExecOrderView>; stop: number | null; target: number | null; close?: LocalExecClose | null; at?: number }

/** Karta zavření bez výsledku: hook ji podrží, jestli služba vzápětí nedodá výsledek z vyplnění. */
export const RITHMIC_PLAIN_EXIT_ID = 'exit-plain:';

/** Karty obchodů ze dvou po sobě jdoucích stavů. Čistá funkce; důvod zavření se neodhaduje. */
export function rithmicTradeEvents(before: Seen, now: Seen, context: { symbol: string; lastPrice: number | null; pointValue: number; at: number }): LiveTradingCopyEvent[] {
  const out: LiveTradingCopyEvent[] = [];
  const add = (event: Record<string, unknown>) => out.push({ id: `${context.at}-${out.length}-${Math.random().toString(36).slice(2, 6)}`, at: context.at, symbol: context.symbol, followers: 0, ...event } as unknown as LiveTradingCopyEvent);
  const sideOf = (net: number) => (net > 0 ? 'Long' : 'Short');
  const orderSide = (order: LocalExecOrderView) => (order.side === 'Buy' ? 'Long' : 'Short');
  for (const [id, order] of now.entries) {
    if (!before.entries.has(id)) add({ kind: 'order-placed', side: orderSide(order), quantity: order.quantity, price: order.price, ...(order.plannedStop !== undefined ? { stopPrice: order.plannedStop } : {}), ...(order.plannedTarget !== undefined ? { targetPrice: order.plannedTarget } : {}) });
  }
  for (const [id, order] of before.entries) {
    if (!now.entries.has(id) && now.net === before.net) add({ kind: 'order-canceled', side: orderSide(order), quantity: order.quantity });
  }
  const fresh = now.close && now.close.id !== before.close?.id && now.close.symbol === context.symbol ? now.close : null;
  const closeEvent = (close: LocalExecClose) => ({
    id: `exit:${close.id}`, at: context.at, symbol: context.symbol, followers: 0, kind: 'exit', side: close.side === 'long' ? 'Long' : 'Short',
    quantity: close.quantity, price: close.exitAvg, pnlUsd: Math.round(close.pointsTotal * context.pointValue * 100) / 100,
    ...(close.reason ? { exitReason: close.reason } : {}),
  }) as unknown as LiveTradingCopyEvent;
  const same = Math.sign(now.net) === Math.sign(before.net);
  if (before.net === 0 && now.net !== 0) add({ kind: 'entry', side: sideOf(now.net), quantity: Math.abs(now.net) });
  else if (before.net !== 0 && now.net === 0) {
    // Výsledek a důvod dodává služba z vyplnění brokera (`closes`). Zpráva o pozici a zpráva o vyplnění
    // jdou jiným spojením, pořadí není dané: přišel-li výsledek dřív, karta už je venku; nepřišel-li
    // ještě, jde ven karta bez výsledku s odkladem (hook ji zahodí, když výsledek dorazí).
    if (fresh) out.push(closeEvent(fresh));
    else if (!(now.close && now.at !== undefined && now.at - now.close.at < 5_000)) {
      add({ kind: 'exit', side: sideOf(before.net), quantity: Math.abs(before.net) });
      (out[out.length - 1] as { id: string }).id = `${RITHMIC_PLAIN_EXIT_ID}${out[out.length - 1].id}`;
    }
  } else if (fresh) {
    out.push(closeEvent(fresh));
  } else if (same && Math.abs(now.net) > Math.abs(before.net)) add({ kind: 'scale-in', side: sideOf(now.net), quantity: Math.abs(now.net) });
  else if (same && Math.abs(now.net) < Math.abs(before.net)) add({ kind: 'scale-out', side: sideOf(now.net), quantity: Math.abs(now.net) });
  if (now.net !== 0) {
    const level = (price: number) => (now.avg !== null ? (price - now.avg) * now.net * context.pointValue : undefined);
    if (now.stop !== null && now.target !== null && (before.stop === null || before.target === null)) add({ kind: 'bracket-placed', side: sideOf(now.net), quantity: Math.abs(now.net), stopPrice: now.stop, targetPrice: now.target });
    else {
      if (now.stop !== null && before.stop !== null && now.stop !== before.stop) add({ kind: 'sl-moved', side: sideOf(now.net), quantity: Math.abs(now.net), price: now.stop, levelPnlUsd: level(now.stop) });
      if (now.target !== null && before.target !== null && now.target !== before.target) add({ kind: 'tp-moved', side: sideOf(now.net), quantity: Math.abs(now.net), price: now.target, levelPnlUsd: level(now.target) });
    }
  }
  return out;
}

export function useRithmicLocalTrading({ url, enabled, onMeasure }: RithmicLocalTradingOptions) {
  const [hello, setHello] = useState<Hello | null>(null);
  const [state, setState] = useState<LocalExecState | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [link, setLink] = useState<RithmicLocalLinkState>(url ? 'connecting' : 'off');
  const [candles, setCandles] = useState<MarketCandle[]>([]);
  const [capturedAt, setCapturedAt] = useState(0);
  /** Proces žije (tep) a jeho spojení pro ceny taky. Čerstvost se nikdy nevyrábí v prohlížeči. */
  const [limits, setLimits] = useState<Limits | null>(null);
  const [feedLive, setFeedLive] = useState(false);
  /** Identita procesu (systém, režim, kontrakt) potvrzená v TÉTO relaci spojení. */
  const [helloFresh, setHelloFresh] = useState(false);
  const lastMarketAt = useRef(0);
  const [events, setEvents] = useState<LiveTradingCopyEvent[]>([]);
  const seen = useRef<Seen | null>(null);
  const plainExitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [heldEntry, setHeldEntry] = useState<LocalExecOrderView | null>(null);
  /** Poslední cena a svíčka čekající na zápis do stavu obrazovky (graf je dostává hned, mimo React). */
  const uiTick = useRef<{ price: number | null; bar: MarketCandle | null; dirty: boolean; timer: ReturnType<typeof setTimeout> | null }>({ price: null, bar: null, dirty: false, timer: null });
  const capturedSetAt = useRef(0);
  /**
   * `final` = svíčka právě skončila (přišla další minuta). Pole svíček se mění JEN při nové nebo dokončené svíčce:
   * každá změna pole přiměje graf znovu zpracovat celou historii a indikátory (tisíce svíček) — při změně 10× za
   * sekundu se graf trhal a při tažení problikával (17. 11. 2026). Rozpracovanou svíčku graf dostává přímo z proudu cen.
   */
  const flushUiTick = useCallback((final = false) => {
    const ui = uiTick.current;
    if (ui.timer !== null) { clearTimeout(ui.timer); ui.timer = null; }
    if (!ui.dirty) return;
    ui.dirty = false;
    const bar = ui.bar;
    if (ui.price !== null) setPrice(ui.price);
    // Čas posledních dat slouží jen k poznání zastaralosti — stačí jednou za sekundu.
    if (lastMarketAt.current - capturedSetAt.current >= 1_000) { capturedSetAt.current = lastMarketAt.current; setCapturedAt(lastMarketAt.current); }
    if (bar) setCandles((current) => {
      const last = current[current.length - 1];
      if (!last || last.time < bar.time) return [...current, bar];
      if (last.time === bar.time) return final ? [...current.slice(0, -1), bar] : current;
      return current;
    });
  }, []);
  const connectionRef = useRef<RithmicLocalConnection | null>(null);
  /** Proces mlčí déle než BEAT_TIMEOUT_MS (tep chodí každou sekundu). */
  const [silent, setSilent] = useState(false);
  const [uncertain, setUncertain] = useState<readonly RithmicUncertainCommand[]>(NO_UNCERTAIN);
  const journalRef = useRef<RithmicPendingJournal | null>(null);
  const addUncertain = useCallback((next: RithmicUncertainCommand) => {
    setUncertain(current => [...current.filter(item => item.id !== next.id), next]);
  }, []);
  const clearUncertain = () => {
    if (!journalRef.current) return;
    try {
      for (const item of uncertain) journalRef.current.remove(item.id);
      setUncertain(NO_UNCERTAIN);
    } catch { /* Keep the warning if durable acknowledgement failed. */ }
  };
  const stateRef = useRef<LocalExecState | null>(null);
  const priceRef = useRef<number | null>(null);
  const symbolRef = useRef('');
  const measureRef = useRef(onMeasure);
  measureRef.current = onMeasure;
  const feedBox = useMemo(createFeed, []);

  useEffect(() => {
    if (!url || !enabled) { setLink(url ? 'closed' : 'off'); return undefined; }
    // Jádro spojení (obnova, lhůty, nejisté příkazy, zahazování starého socketu) žije v `RithmicLocalConnection`.
    let journal: RithmicPendingJournal | null = null;
    let sessionScope = '';
    let recoveryGeneration = 0;
    let identity: Hello | null = null;
    function lookupPending(item: PendingRithmicCommand, info: Hello) {
      const generation = recoveryGeneration;
      if (!info.account) return;
      if (item.op === 'cancel' ? !item.orderId : !item.clientId || !['entry', 'replace-entry'].includes(item.op)) return;
      void connection.send({ op: 'lookup', account: info.account, symbol: info.symbol, originalOp: item.op, clientId: item.clientId, orderId: item.orderId }).then(reply => {
        if (generation !== recoveryGeneration || !reply.ok || !reply.result || !journal?.list().some(x => x.id === item.id)) return;
        const order = reply.result as { status: string; orderId: string; filled: number; quantity: number };
        const status: Record<string, string> = { working: 'čeká', canceled: 'zrušen', filled: 'vyplněn', rejected: 'odmítnut', pending: 'přijat' };
        const label = COMMAND_LABEL[item.op as LocalExecCommand['op']] ?? item.op;
        journal?.remove(item.id);
        addUncertain({ ...item, label, confirmed: true, reason: `Příkaz ${order.orderId}: ${status[order.status] ?? order.status}, vyplněno ${order.filled}/${order.quantity}.` });
      }).catch(() => { /* Keep the item for verification. */ });
    }
    const connection = new RithmicLocalConnection({
      url,
      reconnectMs: RECONNECT_MS, replyTimeoutMs: REPLY_TIMEOUT_MS, beatTimeoutMs: BEAT_TIMEOUT_MS, newId,
      handlers: {
        beforeSend: (id, command) => {
          if (!journal) throw new Error('Účet není potvrzený nebo místní úložiště není dostupné.');
          if ((command.op === 'entry' || command.op === 'replace-entry') && journal.list().length > 0) throw new Error('Ověř předchozí příkaz u brokera.');
          journal.put({ id, op: command.op, at: Date.now(),
            ...(typeof command.clientId === 'string' ? { clientId: command.clientId } : {}),
            ...(command.op === 'cancel' && typeof command.orderId === 'string' ? { orderId: command.orderId } : {}) });
        },
        onCertain: id => journal?.remove(id),
        onLink: setLink,
        onUncertain: item => {
          addUncertain({ ...item, label: COMMAND_LABEL[item.op as LocalExecCommand['op']] ?? item.op });
          if (!connection.isOpen() || !identity) return;
          try {
            const saved = journal?.list().find(row => row.id === item.id);
            if (saved) lookupPending(saved, identity);
          } catch { /* The existing warning remains visible. */ }
        },
        // Konec relace (výpadek i odchod ze záložky): nic ze staré relace se nesmí tvářit jako živé.
        // Příkazy smí odejít až po novém `hello` + `state` z nového spojení.
        onSessionReset: () => {
          const ui = uiTick.current;
          if (ui.timer !== null) clearTimeout(ui.timer);
          uiTick.current = { price: null, bar: null, dirty: false, timer: null };
          identity = null;
          journalRef.current = journal = null;
          sessionScope = '';
          recoveryGeneration++;
          seen.current = null;
          stateRef.current = null;
          lastMarketAt.current = 0;
          setHelloFresh(false);
          setLimits(null);
          priceRef.current = null;
          feedBox.reset();
          setFeedLive(false);
          setSilent(false);
          setPrice(null);
          setState(null);
        },
        // Hlídač tepu: proces mlčí → cena je stará a stojí vstupy, posuny i rušení. Zavření pozice
        // (brzda) se zkusit smí vždy — skončí nejhůř „unknown".
        onSilent: (quiet) => {
          if (quiet) setFeedLive(false);
          setSilent(quiet);
        },
        onMessage: (message) => {
          if (message.type === 'hello') {
            const info = message as unknown as Hello;
            identity = info;
            symbolRef.current = info.symbol;
            const scope = JSON.stringify([info.system, info.account, info.symbol]);
            if (scope !== sessionScope) {
              sessionScope = scope;
              recoveryGeneration++;
              journal = null;
              setUncertain(NO_UNCERTAIN);
              try {
                if (info.account) journal = new RithmicPendingJournal(window.localStorage, info.system, info.account, info.symbol);
                journalRef.current = journal;
                for (const item of journal?.list() ?? []) {
                  const label = COMMAND_LABEL[item.op as LocalExecCommand['op']] ?? item.op;
                  addUncertain({ ...item, label, reason: 'Chybí potvrzení výsledku' });
                  lookupPending(item, info);
                }
              } catch { journalRef.current = journal = null; }
            }
            setHelloFresh(true);
            if (info.feed === true && info.price !== null) {
              lastMarketAt.current = Date.now();
              setCapturedAt(lastMarketAt.current);
            }
            setFeedLive(info.feed === true && info.price !== null);
            setHello(info);
            setLimits(info.limits ?? null);
            const bars = info.bars.map(candle);
            // Graf potřebuje aspoň jednu svíčku; testovací trh často stojí.
            if (!bars.length && typeof info.price === 'number') bars.push({ time: Math.floor(Date.now() / 60_000) * 60, open: info.price, high: info.price, low: info.price, close: info.price, volume: 0 });
            setCandles(bars);
            if (typeof info.price === 'number') { priceRef.current = info.price; setPrice(info.price); feedBox.push(info.price, bars.at(-1) ?? null); }
          } else if (message.type === 'tick') {
            const bar = message.bar ? candle(message.bar as Bar) : null;
            const tickPrice = typeof message.price === 'number' ? message.price : null;
            // Graf dostane KAŽDOU zprávu hned a přímo (mimo React) — cena i svíčka se kreslí při každém snímku.
            if (tickPrice !== null) {
              priceRef.current = tickPrice;
              lastMarketAt.current = Date.now();
            }
            feedBox.push(tickPrice, bar);
            // Zbytek obrazovky (lístek, P&L, seznam svíček) se překresluje nejvýš 10× za sekundu: překreslení celé
            // obrazovky při každém ticku graf na živém trhu zasekávalo (17. 11. 2026).
            const ui = uiTick.current;
            // Nová minuta: nejdřív zapsat poslední stav té dokončené.
            if (ui.bar && bar && bar.time !== ui.bar.time) { ui.dirty = true; flushUiTick(true); }
            if (tickPrice !== null) ui.price = tickPrice;
            if (bar) ui.bar = bar;
            ui.dirty = true;
            if (ui.timer === null) ui.timer = setTimeout(() => flushUiTick(), 100);
          } else if (message.type === 'limits') {
            setLimits(message.limits as Limits | null);
          } else if (message.type === 'beat') {
            setFeedLive(message.feed === true && Date.now() - lastMarketAt.current <= 30_000);
          } else if (message.type === 'state') {
            const next = message.state as LocalExecState;
            if (stateRef.current?.connected === false && next.connected && identity && journal) {
              try { for (const item of journal.list()) lookupPending(item, identity); }
              catch { /* Keep unresolved operations for manual verification. */ }
            }
            stateRef.current = next;
            setState(next);
          }
        },
      },
    });
    connectionRef.current = connection;
    connection.start();
    return () => {
      connectionRef.current = null;
      connection.stop();
    };
  }, [url, enabled, feedBox, flushUiTick]);

  useEffect(() => {
    if (!state || !symbolRef.current) return;
    const sym = symbolRef.current;
    const list = state.orders.filter((order) => order.symbol === sym);
    const pos = state.positions.find((item) => item.symbol === sym);
    const now: Seen = {
      net: pos?.netQuantity ?? 0, avg: pos?.averagePrice ?? null,
      entries: new Map(list.filter((order) => order.role === 'entry' && order.price !== undefined && order.status === 'working').map((order) => [order.orderId, order])),
      stop: list.find((order) => order.role === 'stop' && order.status === 'working')?.price ?? null,
      target: list.find((order) => order.role === 'target' && order.status === 'working')?.price ?? null,
      close: [...(state.closes ?? [])].reverse().find((item) => item.symbol === sym) ?? null, at: state.at,
    };
    const before = seen.current;
    seen.current = now;
    if (!before) return; // první stav je výchozí, ne událost
    const out = rithmicTradeEvents(before, now, { symbol: sym, lastPrice: priceRef.current, pointValue: hello?.pointValue ?? 2, at: Date.now() });
    // Karta bez výsledku čeká 1,5 s na výsledek z vyplnění; když přijde, nahradí ji ta s výsledkem.
    const plain = out.filter((event) => event.id.startsWith(RITHMIC_PLAIN_EXIT_ID));
    const rest = out.filter((event) => !event.id.startsWith(RITHMIC_PLAIN_EXIT_ID));
    if (rest.some((event) => event.id.startsWith('exit:')) && plainExitTimer.current !== null) { clearTimeout(plainExitTimer.current); plainExitTimer.current = null; }
    if (plain.length) {
      if (plainExitTimer.current !== null) clearTimeout(plainExitTimer.current);
      plainExitTimer.current = setTimeout(() => { plainExitTimer.current = null; setEvents((current) => [...current.slice(-30), ...plain]); }, 1_500);
    }
    if (rest.length) setEvents((current) => [...current.slice(-30), ...rest]);
  }, [state, hello?.pointValue]);
  useEffect(() => () => { if (plainExitTimer.current !== null) clearTimeout(plainExitTimer.current); }, []);

  // Správa (zrušení, posun, zavření) smí odejít při živém spojení appka ↔ proces ↔ Rithmic a po novém
  // úplném stavu. Nový vstup navíc chce živou cenu; zavření na ceně NEZÁVISÍ (brzda musí fungovat vždy).
  // Účet připojený jen pro čtení: žádný příkaz se nenabízí ani neposílá (služba je odmítá a na spojení je blokuje).
  const readOnly = hello?.readOnly === true;
  // Po každém (znovu)připojení platí až NOVÉ `hello`: proces mohl mezitím běžet proti jinému systému nebo režimu.
  const available = link === 'open' && helloFresh && Boolean(state?.connected) && !readOnly;
  const entryReady = available && feedLive && !silent && price !== null;
  const silentRef = useRef(false);
  silentRef.current = silent;
  const scaleInRef = useRef<LiveTicketScaleIn | null>(null);
  const availableRef = useRef(false);
  availableRef.current = available;
  const entryReadyRef = useRef(false);
  entryReadyRef.current = entryReady && !!limits && !!hello?.account && !hello.closeOnly && !uncertain.some(item => !item.confirmed);
  const maxContracts = limits ? Math.min(limits.order, Math.max(limits.buy, limits.sell)) : 0;
  const IN_POSITION = 'V pozici jde jen přikoupit Marketem do pozice se SL i TP (stejné SL/TP).';
  const NOT_READY = 'Spojení s Rithmicem není připravené — nic se neodeslalo.';
  const inPosition = Boolean(state?.positions.some((item) => item.symbol === hello?.symbol));
  const entryBlockedReason = uncertain.some(item => !item.confirmed) ? 'Nejdřív ověř výsledek předchozího příkazu.' : readOnly ? 'Účet je připojený jen pro čtení — příkazy jsou vypnuté.' : hello?.closeOnly ? 'Účet je v režimu jen pro zavírání.' : !maxContracts ? 'Limit RMS není dostupný nebo je nulový.' : entryReady ? (inPosition && !scaleInRef.current?.canAdd ? scaleInRef.current?.reason ?? IN_POSITION : null)
    : link !== 'open' ? 'Místní proces Rithmicu není připojený.'
    : !state?.connected ? 'Rithmic je odpojený.'
    : silent ? 'Místní proces neodpovídá — jde jen zavřít pozici.'
    : 'Ceny z Rithmicu stojí — nový vstup nejde, zavření a zrušení ano.';

  const send = useCallback((command: LocalExecCommand): Promise<Reply> => connectionRef.current?.send(command as unknown as { op: string } & Record<string, unknown>)
    ?? Promise.resolve({ ok: false, sent: false, error: 'místní proces není připojený' } as Reply), []);
  const measure = (label: string, done: (s: LocalExecState) => boolean) => measureRef.current?.(label, done);

  const symbol = hello?.symbol ?? '';
  const pointValue = hello?.pointValue ?? 2;
  const orders = state?.orders.filter((order) => order.symbol === symbol) ?? [];
  const net = state?.positions.find((item) => item.symbol === symbol) ?? null;
  const expectedPosition = JSON.stringify([net?.netQuantity ?? 0, net ? (state?.brackets ?? [])
    .filter(b => b.symbol === symbol && b.state === 'protected').map(b => b.entryId).sort() : []]);
  // Během výměny čekajícího vstupu (zrušit → zadat znovu) drží graf původní čáru, aby na okamžik nezmizela.
  const entryOrder = !net ? orders.find((order) => order.role === 'entry' && order.price !== undefined) ?? heldEntry : null;
  // Pozice může mít dvě ochrany (přikoupení): čára ukazuje OCHRANNĚJŠÍ SL (blíž trhu) a BLIŽŠÍ TP.
  const legView = rithmicLegView(orders, net?.netQuantity ?? 0);
  const stopOrder = legView.stop;
  const targetOrder = legView.target;

  // Podklad pro čipy „+ SL / + TP" a práci s nohami otevřené pozice. Jen zobrazení; příkaz ověří služba.
  // Jen zobrazení: během zavírání pozice služba nejdřív ruší SL/TP a pak zavírá — nabídka „+ SL / + TP" by na chvíli
  // probliknula. Po dobu zavírání (nejdéle 4 s) se proto nenabízí; nic to neautorizuje ani neblokuje.
  const [closingUntil, setClosingUntil] = useState(0);
  useEffect(() => {
    if (closingUntil === 0) return undefined;
    const timer = setTimeout(() => setClosingUntil(0), Math.max(0, closingUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [closingUntil]);
  const bareLegTrade = useMemo<BareLeaderTrade | null>(() => (closingUntil === 0 && net && net.averagePrice !== undefined ? {
    entryOperationId: `rithmic:${symbol}`, symbol, side: net.netQuantity > 0 ? 'Buy' : 'Sell', quantity: Math.abs(net.netQuantity), referencePrice: net.averagePrice,
    hasStop: stopOrder != null, hasTarget: targetOrder != null,
  } as BareLeaderTrade : null), [symbol, net?.netQuantity, net?.averagePrice, stopOrder != null, targetOrder != null, closingUntil]); // eslint-disable-line react-hooks/exhaustive-deps

  // Režim přikoupení v lístku: jen pozice se SL i TP ze vstupů (ne samostatná ochrana). Jestli opravdu jde, ověří služba.
  // Čekající vstupy (i přikoupení) jako klíč: jejich příchod nebo zmizení musí pohled přikoupení přepočítat.
  const waitingEntriesKey = orders.filter((order) => order.role === 'entry' && order.status === 'working').map((order) => `${order.orderId}@${order.price}`).join('|');
  const scaleIn = useMemo<LiveTicketScaleIn | null>(() => {
    if (!net) return null;
    const quantity = Math.abs(net.netQuantity);
    const own = (list: LocalExecOrderView[]) => list.length > 0 && list.every((order) => !order.tag?.startsWith('uiprot-'));
    const open = (list: LocalExecOrderView[]) => list.reduce((sum, order) => sum + (order.quantity - order.filledQuantity), 0);
    if (!own(legView.stops) || !own(legView.targets) || !stopOrder || !targetOrder) return null;
    // Čekající přikoupení (Limit do otevřené pozice): vlastní čára s ×; po zavření pozice ho služba sama zruší.
    const waitingAdd = orders.find((order) => order.role === 'entry' && order.status === 'working' && order.tag?.startsWith('ui-add-') && order.price !== undefined);
    const reason = waitingAdd ? 'Čeká přikoupení — další jde až po jeho vyplnění nebo zrušení.'
      : legView.note ? `${legView.note} — nejdřív je srovnej posunem.`
      : legView.stops.length >= 2 ? 'Pozice už má dvě části — další přikoupení služba nepustí.'
      : quantity >= (net.netQuantity > 0 ? limits?.buy ?? 0 : limits?.sell ?? 0) ? 'Pozice dosáhla limitu.'
      : open(legView.stops) !== quantity || open(legView.targets) !== quantity ? 'SL/TP nekryjí celou pozici — přikoupení nejde.' : null;
    return { side: net.netQuantity > 0 ? 'buy' : 'sell', quantity, stopLoss: stopOrder.price ?? null, targetPrice: targetOrder.price ?? null, canAdd: reason === null, reason,
      pendingAdd: waitingAdd ? { price: waitingAdd.price ?? null, quantity: waitingAdd.quantity, orderType: 'Limit' } : null };
  }, [waitingEntriesKey, limits, net?.netQuantity, legView.note, legView.stops.length, legView.targets.length, stopOrder?.price, targetOrder?.price, stopOrder?.tag, targetOrder?.tag]); // eslint-disable-line react-hooks/exhaustive-deps
  scaleInRef.current = scaleIn;

  const position = useMemo<LiveChartPosition | null>(() => {
    if (!symbol) return null;
    // Bez stavu z živého spojení se „bez pozice" netvrdí — neznámé není flat.
    if (!state) return { key: 'rithmic-unknown', symbol: null, lines: [], summary: null, issue: 'Stav u Rithmicu není znám (spojení s místním procesem)', issueKind: 'unknown' };
    // Ochranný příkaz bez pozice by po spuštění otevřel opačnou pozici — musí být vidět i bez čar.
    if (!net && orders.some((order) => order.status === 'working' && order.tag?.startsWith('uiprot-'))) {
      return { key: 'rithmic-orphan-protection', symbol: null, lines: [], summary: null, issue: 'Ochranný SL/TP pracuje bez pozice — zruš ho tlačítkem Zavřít pozici', issueKind: 'unknown' };
    }
    let summary: LiveChartPositionSummary | null = null;
    if (net && net.averagePrice !== undefined) {
      const quantity = Math.abs(net.netQuantity);
      summary = {
        kind: 'position', side: net.netQuantity > 0 ? 'long' : 'short', quantity, entry: net.averagePrice, entryType: null,
        openPnl: price !== null ? (price - net.averagePrice) * net.netQuantity * pointValue : null, mark: price,
        stop: stopOrder?.price ?? null, target: targetOrder?.price ?? null, protection: '', accounts: 1, scopeLabel: null,
        leader: { accountId: RITHMIC_SOLO_ACCOUNT, quantity, entry: net.averagePrice }, rows: [],
      };
    } else if (entryOrder) {
      summary = {
        kind: 'pending', side: entryOrder.side === 'Buy' ? 'long' : 'short', quantity: entryOrder.quantity, entry: entryOrder.price ?? null, entryType: entryOrder.entryType ?? 'Limit',
        // Plánované SL/TP (vzniknou až po vyplnění, počítané od limitní ceny) — jen zobrazení.
        openPnl: null, mark: price, stop: entryOrder.plannedStop ?? null, target: entryOrder.plannedTarget ?? null, protection: '', accounts: 1, scopeLabel: null,
        leader: { accountId: RITHMIC_SOLO_ACCOUNT, quantity: entryOrder.quantity, entry: entryOrder.price ?? null }, rows: [],
      };
    }
    // Slot překresluje jen při změně klíče → patří do něj vše, co má být v grafu aktuální.
    const key = JSON.stringify([symbol, summary?.kind, summary?.side, summary?.quantity, summary?.entry, summary?.entryType, entryOrder?.orderId, summary?.stop, summary?.target, summary?.mark, summary?.openPnl]);
    return { key, symbol, lines: [], summary, issue: null };
  }, [symbol, net?.netQuantity, net?.averagePrice, entryOrder?.orderId, entryOrder?.price, entryOrder?.entryType, entryOrder?.quantity, entryOrder?.side, entryOrder?.plannedStop, entryOrder?.plannedTarget, stopOrder?.price, targetOrder?.price, stopOrder?.tag, targetOrder?.tag, price, pointValue, state === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Příkazy zadané jinde než v této appce (jiná platforma): jen pro zobrazení, tlumenou čarou. Nejde je táhnout
  // ani rušit a nic z nich nejde do příkazu. Co už kreslí pozice (vlastní vstup, SL, TP), se nekreslí podruhé.
  const workingView = useMemo<LiveChartWorkingOrders | null>(() => {
    if (!state || !symbol) return null;
    const foreign = orders.filter((order) => order.role === 'other' && order.status === 'working' && !isOwnExit(order));
    if (!foreign.length) return null;
    const view = liveWorkingOrderView({
      orders: foreign.map((order) => ({
        id: order.orderId, accountId: RITHMIC_SOLO_ACCOUNT, action: order.side, orderType: order.stopPrice !== undefined && order.limitPrice === undefined ? 'Stop' : order.limitPrice !== undefined && order.stopPrice === undefined ? 'Limit' : order.orderType ?? 'Unsupported',
        quantity: order.quantity - order.filledQuantity, price: order.limitPrice ?? null, stopPrice: order.stopPrice ?? null, symbol: order.symbol, working: true,
      })),
      accountIds: [RITHMIC_SOLO_ACCOUNT], verified: true, contract: symbol, pointValue,
      drawn: { position: position?.summary ? { kind: position.summary.kind, side: position.summary.side, entry: position.summary.entry, entryType: position.summary.entryType, stop: position.summary.stop, target: position.summary.target, leader: position.summary.leader } : null, symbol },
    });
    const title = 'Zadáno jinde než v této appce — jen zobrazení. Spravuj tam, kde příkaz vznikl, nebo zavři pozici.';
    return { ...view, lines: view.lines.map((line) => ({ ...line, title })), badges: view.badges.map((badge) => ({ ...badge, title })), contract: symbol };
  }, [state, symbol, pointValue, position?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const marketData = useMemo<LiveTradingMarketData | null>(() => (candles.length && symbol ? ({
    candles,
    quality: { tone: 'info', title: hello?.system === 'Rithmic Test' ? 'Rithmic Test (simulovaný trh)' : `${hello?.system ?? 'Rithmic'} (živý trh)`, reasons: [], lastCandleAt: candles[candles.length - 1].time * 1_000, capturedAt, missingMinutes: 0, source: symbol },
    loading: false, error: null, liveStatus: link === 'open' && feedLive ? 'live' : 'stale', liveCapturedAt: capturedAt, liveSource: symbol, liveFeed: feedBox.feed,
  } as unknown as LiveTradingMarketData) : null), [candles, capturedAt, symbol, feedBox, link, feedLive, hello?.system]);

  const onPlaceEntry = useCallback(async (draft: LiveEntryPreviewDraft, operationId: string): Promise<LeaderEntryPlaceResult> => {
    const base = { type: 'leader-entry-placed' as const, operationId, checkedAt: Date.now() };
    if (!entryReadyRef.current) return { ...base, status: 'blocked', blockers: [{ code: 'local-exec', text: NOT_READY }] };
    // Povolené přikoupení nese totožnost pozice, kterou panel právě ukazoval.
    if (stateRef.current?.positions.some((item) => item.symbol === symbolRef.current)) {
      // Přikoupení: jen Market na stranu pozice a jen když ho režim přikoupení nabízí; všechno znovu ověří služba.
      const add = scaleInRef.current;
      const sameSide = add && (draft.side === 'Buy') === (add.side === 'buy');
      if (!add?.canAdd || !sameSide || (draft.orderType !== 'Market' && draft.orderType !== 'Limit')) return { ...base, status: 'blocked', blockers: [{ code: 'local-exec', text: add && !add.canAdd ? add.reason ?? IN_POSITION : IN_POSITION }] };
    }
    // Čekající přikoupení (Limit do otevřené pozice) nese označení vazby na pozici — služba ho po zavření pozice zruší.
    const pendingAdd = draft.orderType === 'Limit' && stateRef.current?.positions.some((item) => item.symbol === symbolRef.current) === true;
    const clientId = `${pendingAdd ? 'add-' : ''}${operationId.replace(/[^A-Za-z0-9_-]/g, '').slice(pendingAdd ? -24 : -28) || newId()}`;
    const tag = `ui-${clientId}`;
    const sym = symbolRef.current;
    measure(draft.orderType === 'Market' ? 'Market vstup → pozice + SL/TP' : `${draft.orderType} vstup → čára`, (s) => (draft.orderType !== 'Market'
      ? s.orders.some((order) => order.tag === tag && order.status === 'working')
      : s.positions.some((item) => item.symbol === sym) && (draft.stopLoss === undefined || s.orders.some((order) => order.symbol === sym && order.role === 'stop' && order.status === 'working'))));
    const reply = await send({
      op: 'entry', clientId, expectedPosition, symbol: draft.symbol, side: draft.side, quantity: draft.quantity, orderType: draft.orderType,
      ...(draft.orderType === 'Limit' ? { limitPrice: draft.price } : draft.orderType === 'Stop' ? { triggerPrice: draft.price } : { referencePrice: draft.referencePrice ?? priceRef.current ?? undefined }),
      ...(draft.stopLoss !== undefined ? { stopPrice: draft.stopLoss } : {}), ...(draft.takeProfit !== undefined ? { targetPrice: draft.takeProfit } : {}),
    });
    if (reply.ok) return { ...base, status: 'acknowledged', blockers: [], entryBrokerOrderId: String((reply.result as { orderId?: string } | undefined)?.orderId ?? '') };
    if (reply.sent === false) return { ...base, status: 'blocked', blockers: [{ code: 'local-exec', text: reply.error ?? 'Neodesláno.' }] };
    return { ...base, status: 'unknown', blockers: [], reason: reply.error ?? 'Výsledek není znám — ověř stav.' };
  }, [send, expectedPosition]);

  const onManageEntry = useCallback(async (action: LeaderOrderManageAction, expectPrice: number, newPrice?: number): Promise<LeaderOrderManageResult> => {
    const base = { type: 'leader-order-managed' as const, operationId: `manage:${newId()}`, action, checkedAt: Date.now() };
    const blocked = (text: string): LeaderOrderManageResult => ({ ...base, status: 'blocked', blockers: [{ code: 'local-exec', text }] });
    if (!availableRef.current) return blocked(NOT_READY);
    const current = stateRef.current;
    const sym = symbolRef.current;
    const list = current?.orders.filter((order) => order.symbol === sym) ?? [];
    const finish = (reply: Reply): LeaderOrderManageResult => (reply.ok
      ? { ...base, status: 'acknowledged', blockers: [] }
      : reply.sent === false ? blocked(reply.error ?? 'Neodesláno.') : { ...base, status: 'unknown', blockers: [], reason: reply.error ?? 'Výsledek není znám — ověř stav.' });
    if (silentRef.current && action !== 'close-position') return blocked('Místní proces neodpovídá — nic se neodeslalo. Zavřít pozici jde.');
    const replaceEntry = async (entry: LocalExecOrderView, change: { price?: number; stopPrice?: number; targetPrice?: number }): Promise<LeaderOrderManageResult> => {
      setHeldEntry(entry);
      try { return finish(await send({ op: 'replace-entry', clientId: newId(), orderId: entry.orderId, ...change })); } finally { setHeldEntry(null); }
    };
    if (action === 'move-stop' || action === 'move-target') {
      const role = action === 'move-stop' ? 'stop' : 'target';
      const view = rithmicLegView(list, current?.positions.find((item) => item.symbol === sym)?.netQuantity ?? 0);
      const legs = role === 'stop' ? view.stops : view.targets;
      const leg = role === 'stop' ? view.stop : view.target;
      // Čekající vstup: jeho SL/TP ještě nejsou příkazy. Služba vstup zruší a zadá znovu s novou cenou nohy.
      const waitingEntry = !leg && !current?.positions.some((item) => item.symbol === sym) ? list.find((order) => order.role === 'entry' && order.status === 'working') : undefined;
      if (waitingEntry) {
        const planned = role === 'stop' ? waitingEntry.plannedStop : waitingEntry.plannedTarget;
        if (planned === undefined) return blocked(`Čekající vstup ${role === 'stop' ? 'SL' : 'TP'} nemá.`);
        if (planned !== expectPrice) return blocked('Stav se mezitím změnil — čára už neodpovídá příkazu u Rithmicu.');
        if (typeof newPrice !== 'number') return blocked('Chybí nová cena.');
        measure(action === 'move-stop' ? 'Posun SL vstupu → čára' : 'Posun TP vstupu → čára', (s) => s.orders.some((order) => order.symbol === sym && order.role === 'entry' && (role === 'stop' ? order.plannedStop : order.plannedTarget) === newPrice));
        return replaceEntry(waitingEntry, role === 'stop' ? { stopPrice: newPrice } : { targetPrice: newPrice });
      }
      if (!leg) return blocked(`Pozice nemá ${role === 'stop' ? 'SL' : 'TP'} — přidej ho čipem u čáry pozice, nebo pozici zavři.`);
      if (leg.price !== expectPrice) return blocked('Stav se mezitím změnil — čára už neodpovídá příkazu u Rithmicu.');
      if (typeof newPrice !== 'number') return blocked('Chybí nová cena.');
      if (legs.length > 1) {
        // Dvě ochrany: posouvají se obě najednou (a tím se srovnají na jednu cenu).
        measure(action === 'move-stop' ? 'Posun SL → čára' : 'Posun TP → čára', (s) => rithmicLegView(s.orders.filter((order) => order.symbol === sym), 1)[role === 'stop' ? 'stops' : 'targets'].every((order) => order.price === newPrice));
        return finish(await send({ op: 'move-legs', symbol: sym, role, price: newPrice, expect: legs.map((order) => ({ orderId: order.orderId, price: order.price! })) }));
      }
      measure(action === 'move-stop' ? 'Posun SL → čára' : 'Posun TP → čára', (s) => s.orders.some((order) => order.orderId === leg.orderId && order.price === newPrice));
      return finish(await send({ op: 'move', orderId: leg.orderId, price: newPrice }));
    }
    if (action === 'move-limit') {
      // Posun čekajícího Limitu: služba posouvá jen vlastní Limit; SL/TP jsou u Rithmicu vzdálenosti od vstupu,
      // takže se posunou s ním (graf je ukáže podle stavu služby).
      const entry = list.find((order) => order.role === 'entry' && order.status === 'working' && order.price === expectPrice);
      if (!entry) return blocked('Čekající vstup s touto cenou už u Rithmicu není.');
      if (typeof newPrice !== 'number') return blocked('Chybí nová cena.');
      // Posun čekajícího vstupu = výměna: služba ho zruší a zadá znovu na nové ceně (SL/TP zůstanou na svých cenách;
      // Rithmic jejich vzdálenosti u čekajícího vstupu měnit neumí). Platí i pro vstup bez noh a pro víc kontraktů —
      // zrušení se potvrzuje s nulovým plněním, takže částečně vyplněný vstup se nevymění.
      measure(entry.entryType === 'Stop' ? 'Posun Stopu → čára' : 'Posun Limitu → čára', (s) => s.orders.some((order) => order.symbol === sym && order.role === 'entry' && order.status === 'working' && order.price === newPrice));
      return replaceEntry(entry, { price: newPrice });
    }
    if (action === 'cancel-entry') {
      const entry = list.find((order) => order.role === 'entry' && order.price === expectPrice);
      if (!entry) return blocked('Čekající vstup s touto cenou už u Rithmicu není.');
      measure('Zrušení vstupu → čára pryč', (s) => !s.orders.some((order) => order.orderId === entry.orderId));
      return finish(await send({ op: 'cancel', orderId: entry.orderId }));
    }
    if (action === 'close-position') {
      measure('Zavření pozice → čáry pryč', (s) => !s.positions.some((item) => item.symbol === sym) && !s.orders.some((order) => order.symbol === sym));
      setClosingUntil(Date.now() + 4_000);
      const raw = await send({ op: 'flatten', clientId: newId(), symbol: sym });
      const reply = rithmicFlattenReply(raw);
      if (!reply.ok) setClosingUntil(0);
      return finish(reply);
    }
    return blocked('Tuhle akci místní služba zatím neumí.');
  }, [send]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * SL/TP otevřené pozice přes čipy a čáry grafu (cesta `onBareLeg` obrazovky): přidat jde JEN jeden
   * SL nebo jeden TP k pozici bez jiného příkazu; posun jen ceny; odebrat jde jen samostatnou ochranu.
   * Všechno znovu ověřuje služba.
   */
  const onBareLeg = useCallback(async (_seen: BareLeaderTrade, intent: LiveBareLegIntent): Promise<LeaderOrderManageResult> => {
    const action: LeaderOrderManageAction = intent.kind === 'add' ? 'add-leg' : intent.kind === 'remove' ? 'remove-leg' : intent.leg === 'stopLoss' ? 'move-stop' : 'move-target';
    const base = { type: 'leader-order-managed' as const, operationId: `leg:${newId()}`, action, checkedAt: Date.now() };
    const blocked = (text: string): LeaderOrderManageResult => ({ ...base, status: 'blocked', blockers: [{ code: 'local-exec', text }] });
    const finish = (reply: Reply): LeaderOrderManageResult => (reply.ok
      ? { ...base, status: 'acknowledged', blockers: [] }
      : reply.sent === false ? blocked(reply.error ?? 'Neodesláno.') : { ...base, status: 'unknown', blockers: [], reason: reply.error ?? 'Výsledek není znám — ověř stav.' });
    if (!availableRef.current) return blocked(NOT_READY);
    if (silentRef.current) return blocked('Místní proces neodpovídá — nic se neodeslalo. Zavřít pozici jde.');
    const sym = symbolRef.current;
    const list = stateRef.current?.orders.filter((order) => order.symbol === sym) ?? [];
    const role = intent.leg === 'stopLoss' ? 'stop' : 'target';
    const name = role === 'stop' ? 'SL' : 'TP';
    const view = rithmicLegView(list, stateRef.current?.positions.find((item) => item.symbol === sym)?.netQuantity ?? 0);
    const legs = role === 'stop' ? view.stops : view.targets;
    const leg = legs.length ? (role === 'stop' ? view.stop : view.target) : null;
    if (intent.kind === 'add') {
      if (leg) return blocked(`Pozice už ${name} má.`);
      // Druhá noha: jde jen k JEDNÉ samostatné ochraně opačného druhu — služba ji zruší a obě zadá znovu jako
      // svázaný pár (vyplnění jedné pak druhou zruší burza). Jestli to opravdu jde, rozhodne služba.
      const others = list.filter((order) => order.status === 'working' || order.status === 'pending');
      if (others.length > 0 && !(others.length === 1 && others[0].tag?.startsWith('uiprot-') && others[0].role === (role === 'stop' ? 'target' : 'stop'))) {
        return blocked('Pozice už má pracující příkazy (SL/TP ze vstupu nebo čekající vstup) — další ochranu přidat nejde.');
      }
      measure(`Přidání ${name} → čára`, (s) => s.orders.some((order) => order.symbol === sym && order.role === role && order.status === 'working'));
      return finish(await send({ op: 'protect', clientId: newId(), symbol: sym, kind: role, price: intent.price }));
    }
    if (!leg) return blocked(`Pozice ${name} nemá.`);
    if (intent.kind === 'move') {
      if (leg.price !== intent.current) return blocked('Stav se mezitím změnil — čára už neodpovídá příkazu u Rithmicu.');
      if (legs.length > 1) {
        return finish(await send({ op: 'move-legs', symbol: sym, role, price: intent.price, expect: legs.map((order) => ({ orderId: order.orderId, price: order.price! })) }));
      }
      measure(`Posun ${name} → čára`, (s) => s.orders.some((order) => order.orderId === leg.orderId && order.price === intent.price));
      return finish(await send({ op: 'move', orderId: leg.orderId, price: intent.price }));
    }
    // Noha vstupu s ochranou se sama zrušit nedá (Rithmic by zrušil i sestru) — jen samostatná ochrana.
    if (!leg.tag?.startsWith('uiprot-')) return blocked(`${name} patří ke vstupu s ochranou — samotný zrušit nejde, jen zavřít pozici.`);
    measure(`Zrušení ${name} → čára pryč`, (s) => !s.orders.some((order) => order.orderId === leg.orderId));
    return finish(await send({ op: 'cancel', orderId: leg.orderId }));
  }, [send]); // eslint-disable-line react-hooks/exhaustive-deps

  const ack = useCallback(() => send({ op: 'ack' }), [send]);

  /**
   * Brzda: zavře pozici HNED, mimo zámek jednoho příkazu obrazovky — nečeká na visící vstup ani posun.
   * Nezávisí na ceně ani na čerstvosti stavu (službu smí zkusit vždy, když je spojení otevřené).
   * Vlastní pojistka jen proti dvojkliku; souběh se zavřením z obrazovky řeší služba (druhé zavření
   * čeká na první, nikdy dva exity). Nic se neopakuje.
   */
  const closingNow = useRef(false);
  const closeNow = useCallback(async (): Promise<{ status: 'sent' | 'blocked' | 'unknown'; text: string | null }> => {
    if (closingNow.current) return { status: 'blocked', text: 'Zavření už běží — počkej na výsledek.' };
    const sym = symbolRef.current;
    if (!sym) return { status: 'blocked', text: 'Kontrakt není znám — nic se neodeslalo.' };
    closingNow.current = true;
    try {
      setClosingUntil(Date.now() + 4_000);
      const raw = await send({ op: 'flatten', clientId: newId(), symbol: sym });
      const reply = rithmicFlattenReply(raw);
      if (!reply.ok) setClosingUntil(0);
      if (reply.ok) return { status: 'sent', text: null };
      if (reply.sent === false) return { status: 'blocked', text: reply.error ?? 'Neodesláno.' };
      // Nejistý výsledek od služby (ne jen timeout/výpadek) musí být vidět — brzda nejde přes hlášky obrazovky.
      return { status: 'unknown', text: reply.error ?? 'Výsledek není znám — ověř stav.' };
    } finally { closingNow.current = false; }
  }, [send]);

  /**
   * Částečné zavření: jen pozice ze dvou a více vlastních vstupů se SL i TP (každý vstup = jedna část).
   * Kolik kusů se zavře a jestli to opravdu jde, rozhoduje služba; tady je jen nabídka tlačítka.
   */
  const reducible = useMemo(() => {
    if (!net || Math.abs(net.netQuantity) < 2) return null;
    const own = (list: LocalExecOrderView[]) => list.length >= 1 && list.every((order) => order.status === 'working' && !order.tag?.startsWith('uiprot-') && order.entryId !== undefined);
    if (!own(legView.stops) || !own(legView.targets) || legView.stops.length !== legView.targets.length) return null;
    // JEDEN vstup s víc kusy: služba zmenší jeho ochranu o 1 ks a 1 ks zavře Marketem.
    if (legView.stops.length === 1) {
      const only = legView.stops[0];
      return only.quantity - only.filledQuantity >= 2 ? { entryId: only.entryId!, quantity: 1 } : null;
    }
    // Služba zavře část s méně ochranným SL; při shodě tu novější.
    const long = net.netQuantity > 0;
    const first = [...legView.stops].sort((a, b) => (long ? a.price! - b.price! : b.price! - a.price!) || (a.entryId! < b.entryId! ? 1 : -1))[0];
    return { entryId: first.entryId!, quantity: first.quantity - first.filledQuantity };
  }, [net?.netQuantity, legView.stops, legView.targets]); // eslint-disable-line react-hooks/exhaustive-deps
  const expectedEntryId = reducible?.entryId;
  const expectedQuantity = reducible?.quantity;
  const reducing = useRef(false);
  const reduceOne = useCallback(async (): Promise<{ status: 'sent' | 'blocked' | 'unknown'; text: string | null }> => {
    if (reducing.current) return { status: 'blocked', text: 'Částečné zavření už běží — počkej na výsledek.' };
    const sym = symbolRef.current;
    if (!sym) return { status: 'blocked', text: 'Kontrakt není znám — nic se neodeslalo.' };
    if (expectedEntryId === undefined || expectedQuantity === undefined) return { status: 'blocked', text: 'Část pozice už není k dispozici.' };
    reducing.current = true;
    try {
      const before = stateRef.current?.positions.find((item) => item.symbol === sym)?.netQuantity ?? 0;
      measureRef.current?.('Částečné zavření → pozice menší', (s) => Math.abs(s.positions.find((item) => item.symbol === sym)?.netQuantity ?? 0) < Math.abs(before));
      const reply = await send({ op: 'reduce', clientId: newId(), symbol: sym, expectedPosition, expectedEntryId, expectedQuantity });
      if (reply.ok) return { status: 'sent', text: null };
      return reply.sent === false ? { status: 'blocked', text: reply.error ?? 'Neodesláno.' } : { status: 'unknown', text: reply.error ?? 'Výsledek není znám — ověř stav.' };
    } finally { reducing.current = false; }
  }, [send, expectedPosition, expectedEntryId, expectedQuantity]);
  // × u SL/TP jen když ho služba opravdu provede: právě jedna samostatná ochrana (ne noha vstupu, ne svázaný pár).
  const standalone = orders.filter((order) => order.status === 'working' && order.tag?.startsWith('uiprot-') === true);
  const legsRemovable = standalone.length === 1 && orders.filter((order) => order.status === 'working' && (order.role === 'stop' || order.role === 'target')).length === 1;
  // Šipky vstupu a výstupu v grafu z vyplnění brokera (poslední nebo právě otevřený obchod). Jen zobrazení.
  const marks = state?.marks?.find((item) => item.symbol === symbol) ?? null;
  const marksKey = marks ? `${marks.open}:${marks.fills.map((fill) => `${fill.id}@${fill.price}`).join('|')}` : 'none';
  const liveFills = useMemo(() => liveChartFills(marks && marks.fills.length ? { fills: marks.fills, open: marks.open, symbol } : null), [marksKey, symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    liveFills,
    legsRemovable,
    reducible, reduceOne,
    link, system: hello?.system ?? null, symbol, price, state, events, position, marketData,
    available, helloFresh, readOnly, limits, maxContracts, accountName: hello?.account, closeOnly: hello?.closeOnly, liveAccount: hello?.live === true, workingOrders: orders.filter((order) => order.status === 'working' && order.role === 'other' && !isOwnExit(order)).length, entryReady, entryBlockedReason, silent,
    /** Je co zavírat nebo se to neví: pozice, pracující příkaz, nebo stav není znám. Jen pro nabídku brzdy. */
    mayHaveExposure: state === null || net != null || orders.some(order => order.status === 'working'), uncertain, dismissUncertain: clearUncertain, closeNow, tickSize: hello?.tickSize ?? null, pointValue: hello?.pointValue ?? null,
    averagePrice: net?.averagePrice ?? null,
    workingView, onPlaceEntry, onManageEntry, onBareLeg, bareLegTrade, ack, scaleIn, legsNote: legView.note,
  };
}
