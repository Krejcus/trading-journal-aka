// SKUTEČNÁ obchodní obrazovka appky (LiveTradingScreen: graf, lístek, čáry) napojená na místní
// proces scripts/rithmic/devTradeServer.ts → Rithmic Test. Příkazy opravdu odcházejí — na
// TESTOVACÍ účet se simulovanými penězi. Žádná skupina účtů, žádná kopírka; texty obrazovky
// o „leaderovi" a „kopírce" jsou pozůstatek Tradovate cesty a tady nic neznamenají.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import LiveTradingScreenSlot from '../../components/LiveTradingScreenSlot';
import type { LiveTradingCopierState, LiveTradingMarketData } from '../../components/LiveTradingScreen';
import type { LiveCandleFeed } from '../../lib/liveCandleFeed';
import type { LiveChartPosition, LiveChartPositionSummary } from '../../lib/liveChartPosition';
import type { LiveEntryPreviewDraft } from '../../lib/leaderEntryPreview';
import type { LeaderEntryPlaceResult } from '../../lib/leaderEntryPlace';
import type { LeaderOrderManageAction, LeaderOrderManageResult } from '../../lib/leaderOrderManage';
import type { MarketCandle } from '../../services/marketDataCalculations';
import type { LocalExecCommand, LocalExecOrderView, LocalExecState } from '../../services/rithmic/localExec';
import '../../index.css';

const LOCAL = ['127.0.0.1', 'localhost'].includes(window.location.hostname);
const TOKEN_KEY = 'rithmic-qa-token';
const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
if (fromHash) {
  try { window.localStorage.setItem(TOKEN_KEY, fromHash); } catch { /* soukromé okno */ }
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
let TOKEN = fromHash ?? '';
if (!TOKEN) { try { TOKEN = window.localStorage.getItem(TOKEN_KEY) ?? ''; } catch { /* soukromé okno */ } }
const SERVER = `${LOCAL ? 'ws://127.0.0.1:3311' : `ws://${window.location.hostname}:8080`}/?token=${encodeURIComponent(TOKEN)}`;
const ACCOUNT = 1; // obrazovka chce číslo „leadera"; tady jen formální

interface Bar { time: number; open: number; high: number; low: number; close: number; volume?: number }
interface Hello { system: string; symbol: string; tickSize: number; pointValue: number | null; price: number | null; bars: Bar[] }
interface Reply { ok: boolean; sent?: boolean | 'unknown'; error?: string; result?: unknown }
interface Timing { label: string; ms: number }

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
    push(price: number | null, bar: MarketCandle | null) {
      if (price !== null) last = price;
      if (bar) forming = bar;
      for (const listener of [...listeners]) listener();
    },
    beat() { for (const listener of [...listeners]) listener(); },
  };
}

function App() {
  const [isDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true);
  const [hello, setHello] = useState<Hello | null>(null);
  const [state, setState] = useState<LocalExecState | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [link, setLink] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [candles, setCandles] = useState<MarketCandle[]>([]);
  const [capturedAt, setCapturedAt] = useState(() => Date.now());
  const [timings, setTimings] = useState<Timing[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const replies = useRef(new Map<string, (reply: Reply) => void>());
  const stateRef = useRef<LocalExecState | null>(null);
  const priceRef = useRef<number | null>(null);
  const symbolRef = useRef('');
  const feedBox = useMemo(createFeed, []);
  /** Čekající měření klik → čára: splní se prvním stavem, který podmínce vyhoví, + vykreslení. */
  const pending = useRef<Array<{ label: string; t0: number; done: (s: LocalExecState) => boolean }>>([]);

  useEffect(() => {
    const socket = new WebSocket(SERVER);
    socketRef.current = socket;
    socket.onopen = () => setLink('open');
    socket.onclose = () => setLink('closed');
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'hello') {
        const info = message as Hello;
        symbolRef.current = info.symbol;
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
        // Dokončená minuta se připíše do svíček grafu.
        if (bar) setCandles((current) => (current.length && current[current.length - 1].time === bar.time ? [...current.slice(0, -1), bar] : current.length && current[current.length - 1].time > bar.time ? current : [...current, bar]));
      } else if (message.type === 'state') {
        stateRef.current = message.state as LocalExecState;
        setState(message.state as LocalExecState);
      } else if (message.type === 'reply') {
        replies.current.get(String(message.id))?.(message as Reply);
        replies.current.delete(String(message.id));
      }
    };
    // Cena lístku nesmí „zestárnout", i když trh stojí: zdroj se hlásí každou sekundu.
    const beat = window.setInterval(() => { feedBox.beat(); setCapturedAt(Date.now()); }, 1_000);
    return () => { window.clearInterval(beat); socket.close(); };
  }, [feedBox]);

  useEffect(() => {
    if (!state || !pending.current.length) return;
    const ready = pending.current.filter((item) => item.done(state));
    if (!ready.length) return;
    pending.current = pending.current.filter((item) => !ready.includes(item));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setTimings((current) => [...current.slice(-7), ...ready.map((item) => ({ label: item.label, ms: Math.round(performance.now() - item.t0) }))]);
    }));
  }, [state]);

  const send = useCallback((command: LocalExecCommand): Promise<Reply> => new Promise((resolve) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) { resolve({ ok: false, sent: false, error: 'místní proces není připojený' }); return; }
    const id = newId();
    const timer = window.setTimeout(() => { replies.current.delete(id); resolve({ ok: false, sent: 'unknown', error: 'místní proces neodpověděl' }); }, 15_000);
    replies.current.set(id, (reply) => { window.clearTimeout(timer); resolve(reply); });
    socket.send(JSON.stringify({ id, command }));
  }), []);
  const measure = (label: string, done: (s: LocalExecState) => boolean) => { pending.current.push({ label, t0: performance.now(), done }); };

  const symbol = hello?.symbol ?? '';
  const pointValue = hello?.pointValue ?? 2;
  const orders = state?.orders.filter((order) => order.symbol === symbol) ?? [];
  const net = state?.positions.find((item) => item.symbol === symbol) ?? null;
  const entryOrder = !net ? orders.find((order) => order.role === 'entry' && order.price !== undefined) ?? null : null;
  const legsOf = (entryId: string | undefined, role: 'stop' | 'target'): LocalExecOrderView | null => orders.find((order) => order.role === role && (entryId === undefined || order.entryId === entryId)) ?? null;
  const stopOrder = legsOf(undefined, 'stop');
  const targetOrder = legsOf(undefined, 'target');

  const position = useMemo<LiveChartPosition | null>(() => {
    if (!symbol) return null;
    let summary: LiveChartPositionSummary | null = null;
    if (net && net.averagePrice !== undefined) {
      const quantity = Math.abs(net.netQuantity);
      summary = {
        kind: 'position', side: net.netQuantity > 0 ? 'long' : 'short', quantity, entry: net.averagePrice, entryType: null,
        openPnl: price !== null ? (price - net.averagePrice) * net.netQuantity * pointValue : null, mark: price,
        stop: stopOrder?.price ?? null, target: targetOrder?.price ?? null, protection: '', accounts: 1, scopeLabel: null,
        leader: { accountId: ACCOUNT, quantity, entry: net.averagePrice }, rows: [],
      };
    } else if (entryOrder) {
      summary = {
        kind: 'pending', side: entryOrder.side === 'Buy' ? 'long' : 'short', quantity: entryOrder.quantity, entry: entryOrder.price ?? null, entryType: 'Limit',
        // Plánované SL/TP (vzniknou až po vyplnění, počítané od limitní ceny) — jen zobrazení.
        openPnl: null, mark: price, stop: entryOrder.plannedStop ?? null, target: entryOrder.plannedTarget ?? null, protection: '', accounts: 1, scopeLabel: null,
        leader: { accountId: ACCOUNT, quantity: entryOrder.quantity, entry: entryOrder.price ?? null }, rows: [],
      };
    }
    // Slot překresluje jen při změně klíče → patří do něj vše, co má být v grafu aktuální.
    const key = JSON.stringify([symbol, summary?.kind, summary?.side, summary?.quantity, summary?.entry, summary?.stop, summary?.target, summary?.mark, summary?.openPnl]);
    return { key, symbol, lines: [], summary, issue: null };
  }, [symbol, net?.netQuantity, net?.averagePrice, entryOrder?.orderId, entryOrder?.price, entryOrder?.plannedStop, entryOrder?.plannedTarget, stopOrder?.price, targetOrder?.price, price, pointValue]); // eslint-disable-line react-hooks/exhaustive-deps

  const marketData = useMemo<LiveTradingMarketData | null>(() => (candles.length && symbol ? ({
    candles,
    quality: { tone: 'info', title: 'Rithmic Test (simulovaný trh)', reasons: [], lastCandleAt: candles[candles.length - 1].time * 1_000, capturedAt, missingMinutes: 0, source: symbol },
    loading: false, error: null, liveStatus: 'live', liveCapturedAt: capturedAt, liveSource: symbol, liveFeed: feedBox.feed,
  } as unknown as LiveTradingMarketData) : null), [candles, capturedAt, symbol, feedBox]);

  const copier = useMemo<LiveTradingCopierState>(() => ({
    // Vyrobený stav jen proto, aby obrazovka nabídla × u pozice — žádná kopírka tu neběží.
    status: { started: true, armed: true, killSwitch: false, shadowMode: false, connected: true, reconciliationRequired: false, divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false, stuckOperations: [], manualRecovery: null } as never,
    available: link === 'open' && Boolean(state?.connected), pending: false, transport: 'local', reconnectRequired: 0,
  }), [link, state?.connected]);

  const onPlaceEntry = useCallback(async (draft: LiveEntryPreviewDraft, operationId: string): Promise<LeaderEntryPlaceResult> => {
    const base = { type: 'leader-entry-placed' as const, operationId, checkedAt: Date.now() };
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
  }, [send]);

  const onManageEntry = useCallback(async (action: LeaderOrderManageAction, expectPrice: number, newPrice?: number): Promise<LeaderOrderManageResult> => {
    const base = { type: 'leader-order-managed' as const, operationId: `manage:${newId()}`, action, checkedAt: Date.now() };
    const blocked = (text: string): LeaderOrderManageResult => ({ ...base, status: 'blocked', blockers: [{ code: 'local-exec', text }] });
    const current = stateRef.current;
    const sym = symbolRef.current;
    const list = current?.orders.filter((order) => order.symbol === sym) ?? [];
    const finish = (reply: Reply): LeaderOrderManageResult => (reply.ok
      ? { ...base, status: 'acknowledged', blockers: [] }
      : reply.sent === false ? blocked(reply.error ?? 'Neodesláno.') : { ...base, status: 'unknown', blockers: [], reason: reply.error ?? 'Výsledek není znám — ověř stav.' });
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
      return finish(await send({ op: 'flatten', clientId: newId(), symbol: sym }));
    }
    return blocked('Tuhle akci místní služba zatím neumí.');
  }, [send]);

  const banner = link !== 'open' ? (TOKEN ? 'Místní proces není dostupný (nebo neplatný token).' : 'Chybí přístupový token — otevři stránku odkazem s #token=…')
    : !state?.connected ? 'Rithmic je odpojený.' : state.blocked ? `Nové vstupy stojí: ${state.blocked}` : null;
  const rejection = state?.rejections.at(-1);

  return (
    <>
      {marketData ? (
        <LiveTradingScreenSlot
          open isDark={isDark} tabs={[]} onNavigate={() => undefined} copier={copier} group={null} disarm={null}
          position={position} marketData={marketData} soloAccountLabel={`Rithmic Test · ${symbol}`}
          onPlaceEntry={onPlaceEntry} onManageEntry={onManageEntry}
          manageEntryAvgPrice={net?.averagePrice ?? null} manageCloseSupported entryMarketSupported
          entryMaxContracts={2} entryFrontContract={symbol} manageLeaderAccountId={ACCOUNT} workingOrders={null}
        />
      ) : <div style={{ height: '100dvh', display: 'grid', placeItems: 'center', font: '14px system-ui', color: '#94a3b8', background: '#0b0f16' }}>Čekám na první cenu z Rithmic Test…</div>}
      <div data-qa-overlay style={{ position: 'fixed', left: 70, top: 150, zIndex: 400, maxWidth: 300, opacity: 0.9, padding: '8px 10px', borderRadius: 10, background: 'rgba(15,23,42,0.92)', color: '#e2e8f0', font: '12px system-ui', pointerEvents: 'auto' }}>
        <b>Rithmic Test · {symbol || '…'}</b> · {price?.toFixed(2) ?? '—'} · {link === 'open' ? 'připojeno' : link}
        {banner && <div style={{ color: '#f87171', marginTop: 4 }}>{banner}</div>}
        {state?.blocked && <button type="button" data-qa-ack onClick={() => void send({ op: 'ack' })} style={{ marginTop: 4, border: 0, borderRadius: 6, padding: '4px 8px', cursor: 'pointer' }}>Potvrdit incident</button>}
        {rejection && <div style={{ color: '#fbbf24', marginTop: 4 }}>Odmítnuto: {rejection.reason}</div>}
        {timings.length > 0 && <div data-qa-timings style={{ marginTop: 4 }}>{timings.map((item, index) => <div key={`${item.label}-${index}`}>{item.label}: <b>{item.ms} ms</b></div>)}</div>}
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
