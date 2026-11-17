// Obchodování přes místní proces Rithmicu (scripts/rithmic/devTradeServer.ts) pro obrazovku
// LiveTradingScreen: spojení, stav, cena a svíčky, karty obchodů a příkazy.
// Stav v prohlížeči slouží JEN k zobrazení — každý příkaz ověřuje místní proces (LocalExec).
// Žádné opakování: příkaz bez odpovědi končí „unknown" a nikdy se neposílá znovu.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { LiveTradingCopyEvent, LiveTradingMarketData } from '../components/LiveTradingScreen';
import type { LiveCandleFeed } from '../lib/liveCandleFeed';
import type { LiveChartPosition, LiveChartPositionSummary } from '../lib/liveChartPosition';
import type { LiveEntryPreviewDraft } from '../lib/leaderEntryPreview';
import type { LeaderEntryPlaceResult } from '../lib/leaderEntryPlace';
import type { LeaderOrderManageAction, LeaderOrderManageResult } from '../lib/leaderOrderManage';
import type { MarketCandle } from '../services/marketDataCalculations';
import type { LocalExecCommand, LocalExecOrderView, LocalExecState } from '../services/rithmic/localExec';

/** Obrazovka chce číslo účtu „leadera"; u jednoho účtu jen formální. */
export const RITHMIC_SOLO_ACCOUNT = 1;
const RECONNECT_MS = 2_000;
const REPLY_TIMEOUT_MS = 15_000;
/** Bez zprávy od procesu déle než tohle = data jsou stará (tep chodí každou sekundu). */
const BEAT_TIMEOUT_MS = 4_000;

interface Bar { time: number; open: number; high: number; low: number; close: number; volume?: number }
interface Hello { feed?: boolean; system: string; symbol: string; tickSize: number; pointValue: number | null; price: number | null; bars: Bar[] }
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
      if (price !== null) last = price;
      if (bar) forming = bar;
      for (const listener of [...listeners]) listener();
    },
    beat() { for (const listener of [...listeners]) listener(); },
  };
}

/**
 * Poslední příkaz s NEZNÁMÝM výsledkem (spojení spadlo nebo proces neodpověděl). Drží se mimo
 * komponentu, aby varování přežilo odchod ze záložky i obnovu spojení — dokud ho uživatel nezavře.
 */
export interface RithmicUncertainCommand { id: string; at: number; label: string; reason: string }
const NO_UNCERTAIN: readonly RithmicUncertainCommand[] = [];
let uncertainCommands: readonly RithmicUncertainCommand[] = NO_UNCERTAIN;
const uncertainListeners = new Set<() => void>();
const publishUncertain = (next: readonly RithmicUncertainCommand[]) => { uncertainCommands = next; for (const listener of [...uncertainListeners]) listener(); };
/** Každý nejistý příkaz zvlášť (vstup i zavření mimo zámek se nesmí přepsat); nejvýš posledních 5. */
const addUncertain = (next: RithmicUncertainCommand) => publishUncertain([...uncertainCommands.filter(item => item.id !== next.id), next].slice(-5));
const clearUncertain = () => publishUncertain(NO_UNCERTAIN);
const subscribeUncertain = (listener: () => void) => { uncertainListeners.add(listener); return () => { uncertainListeners.delete(listener); }; };
const readUncertain = () => uncertainCommands;
const COMMAND_LABEL: Record<LocalExecCommand['op'], string> = { entry: 'Vstup', move: 'Posun SL/TP', cancel: 'Zrušení příkazu', flatten: 'Zavření pozice', ack: 'Potvrzení incidentu' };

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

interface Seen { net: number; avg: number | null; entries: Map<string, LocalExecOrderView>; stop: number | null; target: number | null }

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
  const same = Math.sign(now.net) === Math.sign(before.net);
  if (before.net === 0 && now.net !== 0) add({ kind: 'entry', side: sideOf(now.net), quantity: Math.abs(now.net) });
  else if (before.net !== 0 && now.net === 0) {
    // Důvod (SL/TP/ručně) ze změny stavu poznat nejde — karta řekne jen „Pozice zavřena".
    add({ kind: 'exit', side: sideOf(before.net), quantity: Math.abs(before.net) });
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
  const [capturedAt, setCapturedAt] = useState(() => Date.now());
  /** Proces žije (tep) a jeho spojení pro ceny taky. Čerstvost se nikdy nevyrábí v prohlížeči. */
  const [feedLive, setFeedLive] = useState(false);
  const lastMessageAt = useRef(0);
  const feedOpen = useRef(false);
  const [events, setEvents] = useState<LiveTradingCopyEvent[]>([]);
  const seen = useRef<Seen | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const replies = useRef(new Map<string, { resolve: (reply: Reply) => void; op: LocalExecCommand['op'] }>());
  /** Proces mlčí déle než BEAT_TIMEOUT_MS (tep chodí každou sekundu). */
  const [silent, setSilent] = useState(false);
  const uncertain = useSyncExternalStore(subscribeUncertain, readUncertain, readUncertain);
  const stateRef = useRef<LocalExecState | null>(null);
  const priceRef = useRef<number | null>(null);
  const symbolRef = useRef('');
  const measureRef = useRef(onMeasure);
  measureRef.current = onMeasure;
  const feedBox = useMemo(createFeed, []);

  useEffect(() => {
    if (!url || !enabled) { setLink(url ? 'closed' : 'off'); return undefined; }
    let stopped = false;
    let retry: number | undefined;
    let socket: WebSocket | null = null;
    // Příkazy bez odpovědi v okamžiku ztráty spojení: výsledek není znám, nic se neopakuje.
    const failPending = () => {
      for (const [id, pending] of replies.current) {
        if (pending.op !== 'ack') addUncertain({ id, at: Date.now(), label: COMMAND_LABEL[pending.op], reason: 'spojení s místním procesem spadlo' });
        pending.resolve({ ok: false, sent: 'unknown', error: 'spojení s místním procesem spadlo — ověř stav' });
      }
      replies.current.clear();
    };
    // Konec relace (výpadek i odchod ze záložky): nic ze staré relace se nesmí tvářit jako živé.
    // Příkazy smí odejít až po novém `hello` + `state` z nového spojení.
    const resetSession = () => {
      seen.current = null;
      stateRef.current = null;
      feedOpen.current = false;
      priceRef.current = null;
      feedBox.reset();
      setFeedLive(false);
      setSilent(false);
      setPrice(null);
      setState(null);
    };
    const connect = () => {
      if (stopped) return;
      setLink('connecting');
      socket = new WebSocket(url);
      socketRef.current = socket;
      const mine = socket;
      mine.onopen = () => { if (socketRef.current !== mine) return; lastMessageAt.current = Date.now(); setLink('open'); };
      mine.onclose = () => {
        if (socketRef.current !== mine) return;
        socketRef.current = null;
        failPending();
        // Po obnově je první stav výchozí, ne událost; starý stav se nesmí tvářit jako živý.
        resetSession();
        setLink('closed');
        if (!stopped) retry = window.setTimeout(connect, RECONNECT_MS);
      };
      mine.onmessage = (event) => {
        if (socketRef.current !== mine) return;
        let message: Record<string, unknown>;
        try { message = JSON.parse(String(event.data)) as Record<string, unknown>; } catch { return; }
        lastMessageAt.current = Date.now();
        setSilent(false);
        if (message.type === 'hello') {
          const info = message as unknown as Hello;
          symbolRef.current = info.symbol;
          feedOpen.current = info.feed === true;
          setFeedLive(feedOpen.current);
          setHello(info);
          const bars = info.bars.map(candle);
          // Graf potřebuje aspoň jednu svíčku; testovací trh často stojí.
          if (!bars.length && typeof info.price === 'number') bars.push({ time: Math.floor(Date.now() / 60_000) * 60, open: info.price, high: info.price, low: info.price, close: info.price, volume: 0 });
          setCandles(bars);
          if (typeof info.price === 'number') { priceRef.current = info.price; setPrice(info.price); feedBox.push(info.price, bars.at(-1) ?? null); }
        } else if (message.type === 'tick') {
          const bar = message.bar ? candle(message.bar as Bar) : null;
          if (typeof message.price === 'number') { priceRef.current = message.price; setPrice(message.price); }
          feedBox.push(typeof message.price === 'number' ? message.price : null, bar);
          setCapturedAt(Date.now());
          if (bar) setCandles((current) => (current.length && current[current.length - 1].time === bar.time ? [...current.slice(0, -1), bar] : current.length && current[current.length - 1].time > bar.time ? current : [...current, bar]));
        } else if (message.type === 'beat') {
          feedOpen.current = message.feed === true;
          setFeedLive(feedOpen.current);
          if (feedOpen.current) { feedBox.beat(); setCapturedAt(Date.now()); }
        } else if (message.type === 'state') {
          stateRef.current = message.state as LocalExecState;
          setState(message.state as LocalExecState);
        } else if (message.type === 'reply') {
          const pending = replies.current.get(String(message.id));
          const reply = message as unknown as Reply;
          // Nejistou odpověď služby zapisuje jedno místo — stejně jako timeout a výpadek.
          if (pending && pending.op !== 'ack' && !reply.ok && reply.sent !== false) addUncertain({ id: String(message.id), at: Date.now(), label: COMMAND_LABEL[pending.op], reason: reply.error ?? 'výsledek není znám' });
          pending?.resolve(reply);
          replies.current.delete(String(message.id));
        }
      };
    };
    connect();
    // Hlídač tepu: proces mlčí → cena je stará a stojí vstupy, posuny i rušení. Zavření pozice
    // (brzda) se zkusit smí vždy — skončí nejhůř „unknown".
    const beat = window.setInterval(() => {
      if (socketRef.current?.readyState !== WebSocket.OPEN || Date.now() - lastMessageAt.current <= BEAT_TIMEOUT_MS) return;
      feedOpen.current = false;
      setFeedLive(false);
      setSilent(true);
    }, 1_000);
    return () => {
      stopped = true;
      window.clearInterval(beat);
      if (retry !== undefined) window.clearTimeout(retry);
      const closing = socket;
      socketRef.current = null;
      failPending();
      resetSession();
      closing?.close();
    };
  }, [url, enabled, feedBox]);

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
    };
    const before = seen.current;
    seen.current = now;
    if (!before) return; // první stav je výchozí, ne událost
    const out = rithmicTradeEvents(before, now, { symbol: sym, lastPrice: priceRef.current, pointValue: hello?.pointValue ?? 2, at: Date.now() });
    if (out.length) setEvents((current) => [...current.slice(-30), ...out]);
  }, [state, hello?.pointValue]);

  // Správa (zrušení, posun, zavření) smí odejít při živém spojení appka ↔ proces ↔ Rithmic a po novém
  // úplném stavu. Nový vstup navíc chce živou cenu; zavření na ceně NEZÁVISÍ (brzda musí fungovat vždy).
  const available = link === 'open' && Boolean(state?.connected);
  const entryReady = available && feedLive && !silent && price !== null;
  const silentRef = useRef(false);
  silentRef.current = silent;
  const availableRef = useRef(false);
  availableRef.current = available;
  const entryReadyRef = useRef(false);
  entryReadyRef.current = entryReady;
  const NOT_READY = 'Spojení s Rithmicem není připravené — nic se neodeslalo.';
  const entryBlockedReason = entryReady ? null
    : link !== 'open' ? 'Místní proces Rithmicu není připojený.'
    : !state?.connected ? 'Rithmic je odpojený.'
    : silent ? 'Místní proces neodpovídá — jde jen zavřít pozici.'
    : 'Ceny z Rithmicu stojí — nový vstup nejde, zavření a zrušení ano.';

  const send = useCallback((command: LocalExecCommand): Promise<Reply> => new Promise((resolve) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) { resolve({ ok: false, sent: false, error: 'místní proces není připojený' }); return; }
    const id = newId();
    const timer = window.setTimeout(() => {
      replies.current.delete(id);
      if (command.op !== 'ack') addUncertain({ id, at: Date.now(), label: COMMAND_LABEL[command.op], reason: 'místní proces neodpověděl' });
      resolve({ ok: false, sent: 'unknown', error: 'místní proces neodpověděl — ověř stav' });
    }, REPLY_TIMEOUT_MS);
    replies.current.set(id, { op: command.op, resolve: (reply) => { window.clearTimeout(timer); resolve(reply); } });
    socket.send(JSON.stringify({ id, command }));
  }), []);
  const measure = (label: string, done: (s: LocalExecState) => boolean) => measureRef.current?.(label, done);

  const symbol = hello?.symbol ?? '';
  const pointValue = hello?.pointValue ?? 2;
  const orders = state?.orders.filter((order) => order.symbol === symbol) ?? [];
  const net = state?.positions.find((item) => item.symbol === symbol) ?? null;
  const entryOrder = !net ? orders.find((order) => order.role === 'entry' && order.price !== undefined) ?? null : null;
  const stopOrder = orders.find((order) => order.role === 'stop') ?? null;
  const targetOrder = orders.find((order) => order.role === 'target') ?? null;

  const position = useMemo<LiveChartPosition | null>(() => {
    if (!symbol) return null;
    // Bez stavu z živého spojení se „bez pozice" netvrdí — neznámé není flat.
    if (!state) return { key: 'rithmic-unknown', symbol: null, lines: [], summary: null, issue: 'Stav u Rithmicu není znám (spojení s místním procesem)', issueKind: 'unknown' };
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
        kind: 'pending', side: entryOrder.side === 'Buy' ? 'long' : 'short', quantity: entryOrder.quantity, entry: entryOrder.price ?? null, entryType: 'Limit',
        // Plánované SL/TP (vzniknou až po vyplnění, počítané od limitní ceny) — jen zobrazení.
        openPnl: null, mark: price, stop: entryOrder.plannedStop ?? null, target: entryOrder.plannedTarget ?? null, protection: '', accounts: 1, scopeLabel: null,
        leader: { accountId: RITHMIC_SOLO_ACCOUNT, quantity: entryOrder.quantity, entry: entryOrder.price ?? null }, rows: [],
      };
    }
    // Slot překresluje jen při změně klíče → patří do něj vše, co má být v grafu aktuální.
    const key = JSON.stringify([symbol, summary?.kind, summary?.side, summary?.quantity, summary?.entry, summary?.stop, summary?.target, summary?.mark, summary?.openPnl]);
    return { key, symbol, lines: [], summary, issue: null };
  }, [symbol, net?.netQuantity, net?.averagePrice, entryOrder?.orderId, entryOrder?.price, entryOrder?.quantity, entryOrder?.side, entryOrder?.plannedStop, entryOrder?.plannedTarget, stopOrder?.price, targetOrder?.price, price, pointValue, state === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const marketData = useMemo<LiveTradingMarketData | null>(() => (candles.length && symbol ? ({
    candles,
    quality: { tone: 'info', title: `${hello?.system ?? 'Rithmic'} (simulovaný trh)`, reasons: [], lastCandleAt: candles[candles.length - 1].time * 1_000, capturedAt, missingMinutes: 0, source: symbol },
    loading: false, error: null, liveStatus: link === 'open' && feedLive ? 'live' : 'stale', liveCapturedAt: capturedAt, liveSource: symbol, liveFeed: feedBox.feed,
  } as unknown as LiveTradingMarketData) : null), [candles, capturedAt, symbol, feedBox, link, feedLive, hello?.system]);

  const onPlaceEntry = useCallback(async (draft: LiveEntryPreviewDraft, operationId: string): Promise<LeaderEntryPlaceResult> => {
    const base = { type: 'leader-entry-placed' as const, operationId, checkedAt: Date.now() };
    if (!entryReadyRef.current) return { ...base, status: 'blocked', blockers: [{ code: 'local-exec', text: NOT_READY }] };
    if (draft.orderType === 'Stop') return { ...base, status: 'blocked', blockers: [{ code: 'unsupported', text: 'Stop vstup místní služba neumí — použij Limit nebo Market.' }] };
    const clientId = operationId.replace(/[^A-Za-z0-9_-]/g, '').slice(-28) || newId();
    const tag = `ui-${clientId}`;
    const sym = symbolRef.current;
    measure(draft.orderType === 'Limit' ? 'Limit vstup → čára' : 'Market vstup → pozice + SL/TP', (s) => (draft.orderType === 'Limit'
      ? s.orders.some((order) => order.tag === tag && order.status === 'working')
      : s.positions.some((item) => item.symbol === sym) && (draft.stopLoss === undefined || s.orders.some((order) => order.symbol === sym && order.role === 'stop' && order.status === 'working'))));
    const reply = await send({
      op: 'entry', clientId, symbol: draft.symbol, side: draft.side, quantity: draft.quantity, orderType: draft.orderType,
      ...(draft.orderType === 'Limit' ? { limitPrice: draft.price } : { referencePrice: draft.referencePrice ?? priceRef.current ?? undefined }),
      ...(draft.stopLoss !== undefined ? { stopPrice: draft.stopLoss } : {}), ...(draft.takeProfit !== undefined ? { targetPrice: draft.takeProfit } : {}),
    });
    if (reply.ok) return { ...base, status: 'acknowledged', blockers: [], entryBrokerOrderId: String((reply.result as { orderId?: string } | undefined)?.orderId ?? '') };
    if (reply.sent === false) return { ...base, status: 'blocked', blockers: [{ code: 'local-exec', text: reply.error ?? 'Neodesláno.' }] };
    return { ...base, status: 'unknown', blockers: [], reason: reply.error ?? 'Výsledek není znám — ověř stav.' };
  }, [send]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (action === 'move-stop' || action === 'move-target') {
      const role = action === 'move-stop' ? 'stop' : 'target';
      const leg = list.find((order) => order.role === role);
      if (!leg || leg.price !== expectPrice) return blocked('Stav se mezitím změnil — čára už neodpovídá příkazu u Rithmicu.');
      if (typeof newPrice !== 'number') return blocked('Chybí nová cena.');
      measure(action === 'move-stop' ? 'Posun SL → čára' : 'Posun TP → čára', (s) => s.orders.some((order) => order.orderId === leg.orderId && order.price === newPrice));
      return finish(await send({ op: 'move', orderId: leg.orderId, price: newPrice }));
    }
    if (action === 'cancel-entry') {
      const entry = list.find((order) => order.role === 'entry' && order.price === expectPrice);
      if (!entry) return blocked('Čekající vstup s touto cenou už u Rithmicu není.');
      measure('Zrušení vstupu → čára pryč', (s) => !s.orders.some((order) => order.orderId === entry.orderId));
      return finish(await send({ op: 'cancel', orderId: entry.orderId }));
    }
    if (action === 'close-position') {
      measure('Zavření pozice → čáry pryč', (s) => !s.positions.some((item) => item.symbol === sym) && !s.orders.some((order) => order.symbol === sym));
      const raw = await send({ op: 'flatten', clientId: newId(), symbol: sym });
      const reply = rithmicFlattenReply(raw);
      // Služba doběhla, ale broker výsledek nepotvrdil (ostatní nejistoty zapisuje příjem odpovědi).
      if (raw.ok && !reply.ok && reply.sent !== false) addUncertain({ id: `close:${Date.now()}`, at: Date.now(), label: COMMAND_LABEL.flatten, reason: reply.error ?? 'výsledek není znám' });
      return finish(reply);
    }
    return blocked('Tuhle akci místní služba zatím neumí.');
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
      const raw = await send({ op: 'flatten', clientId: newId(), symbol: sym });
      const reply = rithmicFlattenReply(raw);
      if (reply.ok) return { status: 'sent', text: null };
      if (reply.sent === false) return { status: 'blocked', text: reply.error ?? 'Neodesláno.' };
      // Nejistý výsledek od služby (ne jen timeout/výpadek) musí být vidět — brzda nejde přes hlášky obrazovky.
      if (raw.ok) addUncertain({ id: `close-now:${Date.now()}`, at: Date.now(), label: COMMAND_LABEL.flatten, reason: reply.error ?? 'výsledek není znám' });
      return { status: 'unknown', text: reply.error ?? 'Výsledek není znám — ověř stav.' };
    } finally { closingNow.current = false; }
  }, [send]);

  return {
    link, system: hello?.system ?? null, symbol, price, state, events, position, marketData,
    available, entryReady, entryBlockedReason, silent,
    /** Je co zavírat nebo se to neví: pozice, pracující příkaz, nebo stav není znám. Jen pro nabídku brzdy. */
    mayHaveExposure: state === null || net != null || orders.some(order => order.status === 'working'), uncertain, dismissUncertain: clearUncertain, closeNow, tickSize: hello?.tickSize ?? null, pointValue: hello?.pointValue ?? null,
    averagePrice: net?.averagePrice ?? null,
    onPlaceEntry, onManageEntry, ack,
  };
}
