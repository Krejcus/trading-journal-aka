// Zkušební stránka „klik → čára" nad Rithmic Test. Skutečné čáry a štítky z appky
// (BacktestOrderLinesOverlay + livePositionChartLines), stav i ceny z místního procesu
// scripts/rithmic/devTradeServer.ts. Příkazy opravdu odcházejí — na TESTOVACÍ účet se
// simulovanými penězi. Měří se čas od kliknutí po vykreslení čáry.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChartView, type ChartViewApi } from '@getcandlekit/charts/react';
import BacktestOrderLinesOverlay from '../../components/BacktestOrderLinesOverlay';
import { livePositionChartLines } from '../../lib/liveChartOrderLines';
import type { LiveChartPositionSummary } from '../../lib/liveChartPosition';
import type { BacktestChartOrderLine } from '../../services/backtestOrderLines';
import type { LocalExecCommand, LocalExecOrderView, LocalExecState } from '../../services/rithmic/localExec';
import '../../index.css';

// Na počítači přímo; z telefonu přes Tailscale Serve (HTTPS port 8443 → místní proces 3311).
const LOCAL = ['127.0.0.1', 'localhost'].includes(window.location.hostname);
const SERVER = LOCAL ? 'ws://127.0.0.1:3311' : `wss://${window.location.hostname}:8443`;
interface Bar { time: number; open: number; high: number; low: number; close: number }
interface Hello { system: string; symbol: string; tickSize: number; pointValue: number | null; price: number | null; bars: Bar[] }
interface Reply { ok: boolean; sent?: boolean | 'unknown'; error?: string; result?: unknown; serverMs?: number }
interface Measurement { label: string; lineMs: number; replyMs: number | null; lines: number }
interface Pending { label: string; t0: number; done: (state: LocalExecState) => boolean; replyMs: number | null; resolve: (m: Measurement) => void }

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]);
};
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function App() {
  const [isDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true);
  const [hello, setHello] = useState<Hello | null>(null);
  const [state, setState] = useState<LocalExecState | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [link, setLink] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [api, setApi] = useState<ChartViewApi | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'bad' | 'warn' }>({ text: 'Připojuji se k místnímu procesu…', tone: 'warn' });
  const [results, setResults] = useState<Measurement[]>([]);
  const [entryType, setEntryType] = useState<'Market' | 'Limit'>('Limit');
  const [distance, setDistance] = useState(10);
  const [stopPts, setStopPts] = useState(10);
  const [targetPts, setTargetPts] = useState(20);
  const [busy, setBusy] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const replies = useRef(new Map<string, (reply: Reply) => void>());
  const pending = useRef<Pending[]>([]);
  const stateRef = useRef<LocalExecState | null>(null);
  const priceRef = useRef<number | null>(null);
  const apiRef = useRef<ChartViewApi | null>(null);
  apiRef.current = api;
  const firstBars = useRef<Bar[] | null>(null);
  const [chartData, setChartData] = useState<Array<{ ts: number; open: number; high: number; low: number; close: number }> | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const say = useCallback((text: string, tone: 'ok' | 'bad' | 'warn' = 'ok') => {
    setNotice({ text, tone });
    // Chyby se nepřepisují další hláškou — zůstávají v seznamu pod tabulkou.
    if (tone === 'bad') setFailures((current) => [...current.slice(-5), `${new Date().toLocaleTimeString('cs-CZ')} ${text}`]);
  }, []);

  useEffect(() => {
    const socket = new WebSocket(SERVER);
    socketRef.current = socket;
    socket.onopen = () => { setLink('open'); say('Připojeno. Příkazy jdou na Rithmic Test (simulované peníze). První vysoká svíčka je jen pomocná kvůli měřítku.'); };
    socket.onclose = () => { setLink('closed'); say('Místní proces není dostupný. Spusť scripts/rithmic/devTradeServer.ts a obnov stránku.', 'bad'); };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'hello') {
        setHello(message as Hello);
        const startPrice = (message as Hello).price;
        if (typeof startPrice === 'number') { priceRef.current = startPrice; setPrice(startPrice); }
        firstBars.current = (message as Hello).bars;
        // Trh v testu může chvíli stát: graf se ukáže hned s jednou svíčkou na poslední ceně.
        if (typeof startPrice === 'number') {
          // POMOCNÁ svíčka jen kvůli měřítku (±25 b), aby byly vidět čáry dál od ceny — není to
          // skutečný obchod. Testovací trh často stojí a graf by jinak měl rozsah pár centů.
          const first = firstBars.current[0]?.time ?? Math.floor(Date.now() / 60_000) * 60;
          const scale = { time: first - 60, open: startPrice, high: startPrice + 25, low: startPrice - 25, close: startPrice };
          firstBars.current = [scale, ...(firstBars.current.length ? firstBars.current : [{ time: first, open: startPrice, high: startPrice, low: startPrice, close: startPrice }])];
        }
        if (firstBars.current.length) setChartData(firstBars.current.map(({ time, ...bar }) => ({ ts: time * 1_000, ...bar })));
      } else if (message.type === 'tick') {
        if (typeof message.price === 'number') { priceRef.current = message.price; setPrice(message.price); }
        const bar = message.bar as Bar | null;
        if (!bar) return;
        const row = { ts: bar.time * 1_000, open: bar.open, high: bar.high, low: bar.low, close: bar.close };
        if (!firstBars.current?.length) { firstBars.current = [bar]; setChartData([row]); } else apiRef.current?.controller.updateBar(row as never);
      } else if (message.type === 'state') {
        stateRef.current = message.state as LocalExecState;
        setState(message.state as LocalExecState);
      } else if (message.type === 'reply') {
        replies.current.get(String(message.id))?.(message as Reply);
        replies.current.delete(String(message.id));
      }
    };
    return () => socket.close();
  }, [say]);

  // Měření: po každém novém stavu zkontroluj čekající kliky; čas se bere až PO vykreslení (2× rAF).
  useEffect(() => {
    if (!state || !pending.current.length) return;
    const ready = pending.current.filter((item) => item.done(state));
    if (!ready.length) return;
    pending.current = pending.current.filter((item) => !ready.includes(item));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const lines = document.querySelectorAll('[data-order-line-wrap]').length;
      for (const item of ready) {
        const measurement = { label: item.label, lineMs: Math.round(performance.now() - item.t0), replyMs: item.replyMs, lines };
        setResults((current) => [...current, measurement]);
        item.resolve(measurement);
      }
    }));
  }, [state]);

  /** Odešle příkaz a měří od TEĎ po vykreslení stavu, který splní `done`. */
  const act = useCallback((label: string, command: LocalExecCommand, done: (state: LocalExecState) => boolean, timeoutMs = 8_000): Promise<Measurement | null> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) { say('Neodesláno: místní proces není připojený.', 'bad'); return Promise.resolve(null); }
    return new Promise((resolve) => {
      const id = newId();
      const t0 = performance.now();
      const item: Pending = { label, t0, done, replyMs: null, resolve };
      pending.current.push(item);
      const timer = window.setTimeout(() => {
        if (!pending.current.includes(item)) return;
        pending.current = pending.current.filter((other) => other !== item);
        say(`${label}: čára se do ${timeoutMs / 1000} s neobjevila.`, 'bad');
        resolve(null);
      }, timeoutMs);
      replies.current.set(id, (reply) => {
        item.replyMs = Math.round(performance.now() - t0);
        if (!reply.ok) {
          window.clearTimeout(timer);
          pending.current = pending.current.filter((other) => other !== item);
          say(`${label}: ${reply.sent === false ? 'neodesláno' : 'výsledek neznámý'} — ${reply.error ?? ''}`, 'bad');
          resolve(null);
        }
      });
      socket.send(JSON.stringify({ id, command }));
      // Stav mohl dorazit dřív než odpověď — zkontroluj hned po odeslání další změnu.
    });
  }, [say]);

  const symbol = hello?.symbol ?? '';
  const tick = hello?.tickSize ?? 0.25;
  const snap = useCallback((value: number) => Math.round(value / tick) * tick, [tick]);
  const orders = state?.orders.filter((order) => order.symbol === symbol) ?? [];
  const position = state?.positions.find((item) => item.symbol === symbol) ?? null;
  const stopOrder = orders.find((order) => order.role === 'stop') ?? null;
  const targetOrder = orders.find((order) => order.role === 'target') ?? null;
  const entryOrder = orders.find((order) => order.role === 'entry' && order.price !== undefined) ?? null;
  const lastEntry = useRef<number | null>(null);
  if (position?.averagePrice) lastEntry.current = position.averagePrice;
  if (!position) lastEntry.current = null;

  const summary: LiveChartPositionSummary | null = position ? {
    kind: 'position', side: position.netQuantity > 0 ? 'long' : 'short', quantity: Math.abs(position.netQuantity),
    entry: position.averagePrice ?? lastEntry.current ?? price ?? 0, entryType: null, openPnl: null, mark: price,
    stop: stopOrder?.price ?? null, target: targetOrder?.price ?? null, protection: '', accounts: 1, scopeLabel: null, leader: null, rows: [],
  } as LiveChartPositionSummary : entryOrder ? {
    kind: 'pending', side: entryOrder.side === 'Buy' ? 'long' : 'short', quantity: entryOrder.quantity, entry: entryOrder.price!, entryType: 'Limit', openPnl: null, mark: price,
    stop: null, target: null, protection: '', accounts: 1, scopeLabel: null, leader: null, rows: [],
  } as LiveChartPositionSummary : null;
  const pointValue = hello?.pointValue ?? 50;
  const pnl = position && summary && price != null ? (price - summary.entry) * position.netQuantity * pointValue : null;
  const lines = useMemo<BacktestChartOrderLine[]>(() => {
    if (!summary) return [];
    return summary.kind === 'pending'
      ? livePositionChartLines(summary, { manageable: false, canClose: false, entryAvg: null, pointValue, displayOpenPnl: null })
      : livePositionChartLines(summary, { manageable: Boolean(stopOrder && targetOrder), canClose: true, entryAvg: summary.entry, pointValue, displayOpenPnl: pnl });
  }, [summary?.kind, summary?.entry, summary?.side, summary?.stop, summary?.target, summary?.quantity, pnl, pointValue, Boolean(stopOrder && targetOrder)]); // eslint-disable-line react-hooks/exhaustive-deps

  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const has = (current: LocalExecState, predicate: (order: LocalExecOrderView) => boolean) => current.orders.some((order) => order.symbol === symbolRef.current && predicate(order));
  const placeEntry = useCallback((side: 'Buy' | 'Sell', type: 'Market' | 'Limit', options: { distance: number; stopPts: number; targetPts: number }) => {
    const market = priceRef.current;
    if (market == null) { say('Neodesláno: ještě nepřišla žádná cena.', 'bad'); return Promise.resolve(null); }
    const dir = side === 'Buy' ? 1 : -1;
    const clientId = newId();
    const limitPrice = snap(market - dir * options.distance);
    const reference = type === 'Limit' ? limitPrice : snap(market);
    const command: LocalExecCommand = {
      op: 'entry', clientId, symbol, side, quantity: 1, orderType: type,
      ...(type === 'Limit' ? { limitPrice } : { referencePrice: reference }),
      stopPrice: snap(reference - dir * options.stopPts), targetPrice: snap(reference + dir * options.targetPts),
    };
    const tag = `ui-${clientId}`;
    return act(type === 'Limit' ? 'Limit vstup → čára' : 'Market vstup → pozice + SL + TP', command, (current) => (type === 'Limit'
      ? has(current, (order) => order.tag === tag && order.status === 'working')
      : current.positions.some((item) => item.symbol === symbol) && has(current, (order) => order.role === 'stop' && order.status === 'working') && has(current, (order) => order.role === 'target' && order.status === 'working')));
  }, [act, say, snap, symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  const move = useCallback((order: LocalExecOrderView, next: number) => act(`Posun ${order.role === 'stop' ? 'SL' : 'TP'} → čára`, { op: 'move', orderId: order.orderId, price: next },
    (current) => has(current, (item) => item.orderId === order.orderId && item.price === next)), [act]); // eslint-disable-line react-hooks/exhaustive-deps
  const cancel = useCallback((order: LocalExecOrderView) => act('Zrušení vstupu → čára pryč', { op: 'cancel', orderId: order.orderId }, (current) => !has(current, (item) => item.orderId === order.orderId)), [act]); // eslint-disable-line react-hooks/exhaustive-deps
  const flatten = useCallback(() => act('Zavření pozice → čáry pryč', { op: 'flatten', clientId: newId(), symbol },
    (current) => !current.positions.some((item) => item.symbol === symbol) && !has(current, () => true), 12_000), [act, symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Automatické měření: 8× Limit (vložit, zrušit) a 3× Market se SL/TP (vstup, posun SL, zavřít). */
  const measure = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setResults([]);
    try {
      for (let round = 0; round < 8; round += 1) {
        const placed = await placeEntry('Buy', 'Limit', { distance: 30, stopPts: 10, targetPts: 20 });
        if (!placed) break;
        await wait(350);
        const order = stateRef.current?.orders.find((item) => item.symbol === symbol && item.role === 'entry' && item.status === 'working');
        if (!order || !(await cancel(order))) break;
        await wait(350);
      }
      for (let round = 0; round < 3; round += 1) {
        if (!(await placeEntry('Buy', 'Market', { distance: 0, stopPts: 10, targetPts: 20 }))) break;
        await wait(500);
        const stop = stateRef.current?.orders.find((item) => item.symbol === symbol && item.role === 'stop');
        if (stop?.price !== undefined) await move(stop, snap(stop.price - 1));
        await wait(500);
        if (!(await flatten())) break;
        await wait(2_000);
      }
      say('Měření hotové — výsledky jsou v tabulce.');
    } finally {
      setBusy(false);
    }
  }, [busy, cancel, flatten, move, placeEntry, say, snap, symbol]);
  useEffect(() => {
    (window as unknown as { __rithmicQa?: unknown }).__rithmicQa = { results, measure, busy, link, state, price, failures };
  }, [results, measure, busy, link, state, price, failures]);

  const panel = isDark ? '#121823' : '#fff';
  const ink = isDark ? '#e6ebf3' : '#0f172a';
  const line = isDark ? '#263041' : '#dbe1ea';
  const muted = isDark ? '#8a97ab' : '#64748b';
  const toneColor = notice.tone === 'bad' ? '#ef4444' : notice.tone === 'warn' ? '#f59e0b' : '#10b981';
  const button: React.CSSProperties = { minHeight: 42, flex: 1, border: 0, borderRadius: 10, color: '#fff', fontWeight: 800, cursor: 'pointer', fontSize: 14 };
  const stepper = (label: string, value: number, set: (next: number) => void) => (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: muted }}>
      {label}
      <button type="button" onClick={() => set(Math.max(1, value - 1))} style={{ width: 28, height: 28, border: 0, borderRadius: 7, background: line, color: ink, cursor: 'pointer' }}>−</button>
      <b style={{ color: ink, minWidth: 36, textAlign: 'center' }}>{value} b</b>
      <button type="button" onClick={() => set(value + 1)} style={{ width: 28, height: 28, border: 0, borderRadius: 7, background: line, color: ink, cursor: 'pointer' }}>+</button>
    </div>
  );
  const groups = [...new Set(results.map((item) => item.label))].map((label) => {
    const rows = results.filter((item) => item.label === label);
    return { label, n: rows.length, line: median(rows.map((row) => row.lineMs)), max: Math.max(...rows.map((row) => row.lineMs)), reply: median(rows.flatMap((row) => (row.replyMs == null ? [] : [row.replyMs]))) };
  });

  return (
    <div style={{ height: '100dvh', background: isDark ? '#0b0f16' : '#f3f5f9', color: ink, font: '14px Inter, system-ui, sans-serif', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 1180, display: 'flex', flexDirection: 'column', gap: 8, padding: 8, boxSizing: 'border-box', minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <b style={{ flex: 1, minWidth: 220 }}>Rithmic Test · {symbol || '…'} · klik → čára</b>
          <span style={{ fontSize: 12, color: muted }}>{link === 'open' ? `spojení OK${state?.connected ? ' · Rithmic připojen' : ' · Rithmic odpojen'}` : link === 'connecting' ? 'připojuji…' : 'odpojeno'}</span>
          <b data-qa-price>{price != null ? price.toFixed(2) : '—'}</b>
          <button type="button" data-qa-measure disabled={busy || link !== 'open'} onClick={() => void measure()} style={{ ...button, flex: 'none', minHeight: 34, padding: '0 14px', background: busy ? '#475569' : '#2563eb' }}>{busy ? 'Měřím…' : 'Změřit automaticky'}</button>
        </div>
        <div data-preview-chart style={{ position: 'relative', flex: 1, minHeight: 260, border: `1px solid ${line}`, borderRadius: 12, overflow: 'hidden' }}>
          {chartData ? (
            <ChartView data={chartData as never} seriesType="candlestick" showVolume={false} theme={isDark ? 'dark' : 'light'} onReady={setApi} style={{ width: '100%', height: '100%' }}>
              {api && (
                <BacktestOrderLinesOverlay
                  api={api} lines={lines} isDark={isDark} selectToDrag={false}
                  onChange={(_line, kind, next) => {
                    const order = kind === 'stopLoss' ? stopOrder : kind === 'takeProfit' ? targetOrder : null;
                    if (!order) { say('Vstup se SL/TP zatím posunout nejde — zruš ho a zadej znovu.', 'warn'); return; }
                    const snapped = snap(next);
                    if (snapped !== order.price) void move(order, snapped);
                  }}
                  onCancel={(target) => {
                    if (target.kind !== 'entry') { say('Zrušení jedné nohy by u Rithmicu zrušilo i druhou — pozice by zůstala bez ochrany. Neposílám.', 'warn'); return; }
                    if (position) void flatten(); else if (entryOrder) void cancel(entryOrder);
                  }}
                  onAction={() => say('Tahle akce v prototypu není.', 'warn')}
                  onAddBracket={() => say('Doplnění nohy v prototypu není — SL/TP se zadávají se vstupem.', 'warn')}
                />
              )}
            </ChartView>
          ) : <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: muted }}>Čekám na první cenu z Rithmic Test…</div>}
        </div>
        <div role="status" data-qa-notice style={{ minHeight: 38, boxSizing: 'border-box', padding: '8px 12px', borderRadius: 10, background: panel, border: `1px solid ${line}`, color: toneColor, fontWeight: 600, fontSize: 13 }}>{notice.text}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'stretch' }}>
          <div style={{ flex: 2, minWidth: 320, display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 9, background: line }}>
                {(['Market', 'Limit'] as const).map((type) => (
                  <button key={type} type="button" onClick={() => setEntryType(type)} style={{ border: 0, borderRadius: 6, padding: '6px 12px', fontWeight: 700, cursor: 'pointer', background: entryType === type ? panel : 'transparent', color: ink }}>{type}</button>
                ))}
              </div>
              {entryType === 'Limit' && stepper('Od trhu', distance, setDistance)}
              {stepper('SL', stopPts, setStopPts)}
              {stepper('TP', targetPts, setTargetPts)}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" data-qa-sell disabled={busy} onClick={() => void placeEntry('Sell', entryType, { distance, stopPts, targetPts })} style={{ ...button, background: '#dc2626' }}>SELL 1 {entryType.toUpperCase()}</button>
              <button type="button" data-qa-buy disabled={busy} onClick={() => void placeEntry('Buy', entryType, { distance, stopPts, targetPts })} style={{ ...button, background: '#059669' }}>BUY 1 {entryType.toUpperCase()}</button>
              <button type="button" data-qa-flatten disabled={busy} onClick={() => void flatten()} style={{ ...button, flex: 'none', padding: '0 16px', background: '#475569' }}>Zavřít vše</button>
            </div>
            <div style={{ fontSize: 12, color: muted }}>
              U Rithmicu: {position ? `${position.netQuantity > 0 ? 'LONG' : 'SHORT'} ${Math.abs(position.netQuantity)} @ ${summary?.entry.toFixed(2)} · SL ${stopOrder?.price?.toFixed(2) ?? '—'} · TP ${targetOrder?.price?.toFixed(2) ?? '—'}` : entryOrder ? `čeká ${entryOrder.side} ${entryOrder.quantity} @ ${entryOrder.price?.toFixed(2)}` : 'bez pozice a bez příkazů'}
              {state?.brackets.length ? ` · ochrana: ${state.brackets.map((b) => b.state).join(', ')}` : ''}
              {state?.incidents.length ? ` · incidenty: ${state.incidents.slice(-2).map((i) => i.kind).join(', ')}` : ''}
            </div>
          </div>
          <div data-qa-results style={{ flex: 1, minWidth: 300, padding: '8px 12px', borderRadius: 10, background: panel, border: `1px solid ${line}`, fontSize: 12 }}>
            <b style={{ color: muted, fontSize: 11 }}>KLIK → ČÁRA V GRAFU (ms)</b>
            {groups.length === 0 ? <div style={{ color: muted, marginTop: 6 }}>Zatím nic. Klikni na BUY/SELL nebo na „Změřit automaticky".</div> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4 }}>
                <thead><tr style={{ color: muted, textAlign: 'right' }}><th style={{ textAlign: 'left' }}>krok</th><th>n</th><th>medián</th><th>max</th><th>odpověď</th></tr></thead>
                <tbody>{groups.map((group) => (
                  <tr key={group.label} style={{ textAlign: 'right' }}><td style={{ textAlign: 'left' }}>{group.label}</td><td>{group.n}</td><td><b>{group.line}</b></td><td>{group.max}</td><td>{group.reply ?? '—'}</td></tr>
                ))}</tbody>
              </table>
            )}
            {failures.length > 0 && <div data-qa-failures style={{ marginTop: 6, color: '#ef4444' }}>{failures.map((text) => <div key={text}>{text}</div>)}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
