// Náhled vstupů bez SL/TP a SL a TP po jedné: skutečné čáry a štítky z appky na pohyblivém grafu. Cena i broker
// jsou smyšlené, nic se neposílá. Texty a brány jsou tytéž jako ve workeru a v UI.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChartView, type ChartViewApi } from '@getcandlekit/charts/react';
import BacktestOrderLinesOverlay from '../../components/BacktestOrderLinesOverlay';
import { LIVE_ATTACH_SEND_ACTION, liveBreakEven, liveLineMoveBlockReason, livePositionChartLines } from '../../lib/liveChartOrderLines';
import type { LiveChartPositionSummary } from '../../lib/liveChartPosition';
import { singleLegPriceProblem, type ManualLeg } from '../../lib/manualSingleLeg';
import { liveBareMarketButtonLabel } from '../../lib/liveBareEntry';
import { MANUAL_ENTRY_BARE_STOP_MIN_TICKS } from '../../services/manualEntryPreview';
import type { BacktestChartOrderLine } from '../../services/backtestOrderLines';
import '../../index.css';

const TICK = 0.25;
const BAR_SECONDS = 60;
const BAR_REAL_MS = 15_000;
const SEND_MS = 180;
const SPACING_MS = 2_000;
const SETTLE_MS = 2_000;
const snap = (price: number) => Math.round(price / TICK) * TICK;

function seedBars() {
  const now = Math.floor(Date.now() / 1000 / BAR_SECONDS) * BAR_SECONDS;
  const bars: Array<{ time: number; open: number; high: number; low: number; close: number }> = [];
  let price = 27_090;
  for (let index = 180; index > 0; index -= 1) {
    const open = price;
    const close = snap(open + (Math.random() - 0.48) * 9);
    bars.push({ time: now - index * BAR_SECONDS, open, close, high: snap(Math.max(open, close) + Math.random() * 3.5), low: snap(Math.min(open, close) - Math.random() * 3.5) });
    price = close;
  }
  return bars;
}

interface Position { side: 'long' | 'short'; entry: number; filledAt: number; stop: number | null; target: number | null }
type EntryType = 'market' | 'limit' | 'stop';
interface Order { side: 'long' | 'short'; type: 'limit' | 'stop'; price: number }

function App() {
  const [phone, setPhone] = useState(() => window.innerWidth < 720);
  const [isDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true);
  const bars = useMemo(seedBars, []);
  const chartData = useMemo(() => bars.map(({ time, ...bar }) => ({ ts: time * 1_000, ...bar })), [bars]);
  const [api, setApi] = useState<ChartViewApi | null>(null);
  const [price, setPrice] = useState(bars[bars.length - 1].close);
  const [position, setPosition] = useState<Position | null>(null);
  const [pending, setPending] = useState<{ stopLoss?: number; takeProfit?: number }>({});
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'bad' | 'warn' } | null>({ text: 'Cena je smyšlená a nic se neposílá. Vyber Limit nebo Stop a klikni na tlačítko dole.', tone: 'ok' });
  const say = useCallback((text: string, tone: 'ok' | 'bad' | 'warn' = 'ok') => setNotice({ text, tone }), []);
  const [entryType, setEntryType] = useState<EntryType>('limit');
  const [distance, setDistance] = useState(10);
  const [order, setOrder] = useState<Order | null>(null);
  const orderRef = useRef(order);
  orderRef.current = order;
  /** Tlačítko „Dojet k příkazu“: cena jde přímo k němu, ať nemusíš čekat. */
  const driveRef = useRef(false);
  const anchorRef = useRef(bars[bars.length - 1].close);
  const positionRef = useRef(position);
  positionRef.current = position;
  const priceRef = useRef(price);
  priceRef.current = price;
  const lastCommand = useRef(0);
  const barRef = useRef({ ...bars[bars.length - 1] });
  const barStarted = useRef(Date.now());

  useEffect(() => {
    if (!api) return undefined;
    const timer = window.setInterval(() => {
      const previous = priceRef.current;
      const pull = (anchorRef.current - previous) * 0.004;
      const waiting = orderRef.current;
      const next = waiting && driveRef.current
        ? snap(previous + Math.sign(waiting.price - previous) * Math.min(1.5, Math.abs(waiting.price - previous)))
        : snap(previous + (Math.random() - 0.5) * 2.4 + pull);
      priceRef.current = next;
      setPrice(next);
      const now = Date.now();
      if (now - barStarted.current >= BAR_REAL_MS) {
        barStarted.current = now;
        barRef.current = { time: barRef.current.time + BAR_SECONDS, open: previous, high: Math.max(previous, next), low: Math.min(previous, next), close: next };
      } else {
        barRef.current = { ...barRef.current, close: next, high: Math.max(barRef.current.high, next), low: Math.min(barRef.current.low, next) };
      }
      const { time, ...bar } = barRef.current;
      api.controller.updateBar({ ts: time * 1_000, ...bar } as never);
      if (waiting) {
        const long = waiting.side === 'long';
        const hit = waiting.type === 'limit' ? (long ? next <= waiting.price : next >= waiting.price) : (long ? next >= waiting.price : next <= waiting.price);
        if (hit) {
          driveRef.current = false;
          anchorRef.current = next;
          orderRef.current = null;
          setOrder(null);
          setPosition({ side: waiting.side, entry: waiting.price, filledAt: Date.now(), stop: null, target: null });
          say(`${waiting.type === 'limit' ? 'Limit' : 'Stop'} se vyplnil na ${waiting.price.toFixed(2)}. Pozice je BEZ SL/TP, dokud je nedoplníš. Natáhni čip + SL nebo + TP.`, 'warn');
        }
        return;
      }
      const open = positionRef.current;
      if (!open) return;
      const dir = open.side === 'long' ? 1 : -1;
      if (open.stop != null && (next - open.stop) * dir <= 0) { setPosition(null); say(`SL se vyplnil na ${open.stop.toFixed(2)}. Pozice je zavřená, TP broker zrušil.`, 'warn'); }
      else if (open.target != null && (next - open.target) * dir >= 0) { setPosition(null); say(`TP se vyplnil na ${open.target.toFixed(2)}. Pozice je zavřená, SL broker zrušil.`); }
    }, 300);
    return () => window.clearInterval(timer);
  }, [api, bars, say]);

  const summary: LiveChartPositionSummary | null = position ? {
    kind: 'position', side: position.side, quantity: 1, entry: position.entry, entryType: null, openPnl: null, mark: price,
    stop: position.stop, target: position.target, protection: '', accounts: 1, scopeLabel: null, leader: null, rows: [],
  } : order ? {
    kind: 'pending', side: order.side, quantity: 1, entry: order.price, entryType: order.type === 'limit' ? 'Limit' : 'Stop', openPnl: null, mark: price,
    stop: null, target: null, protection: '', accounts: 1, scopeLabel: null, leader: null, rows: [],
  } : null;
  const pnl = position ? (price - position.entry) * (position.side === 'long' ? 1 : -1) * 2 : null;
  const bothLegs = position?.stop != null && position.target != null;
  const lines = useMemo<BacktestChartOrderLine[]>(() => (order && summary ? livePositionChartLines(summary, {
    manageable: true, canClose: false, entryAvg: null, pointValue: 2, displayOpenPnl: null,
  }) : summary ? livePositionChartLines(summary, {
    manageable: bothLegs, canClose: true, entryAvg: summary.entry, pointValue: 2, bareLegs: true, displayOpenPnl: pnl,
    bareClose: bothLegs ? null : { entryOperationId: 'entry:preview' }, pending,
  }) : []), [bothLegs, pending, pnl, order, summary?.entry, summary?.mark, summary?.side, summary?.stop, summary?.target]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Stejné brány jako worker: rozestup relaye a čekání po fillu. */
  const gate = (): boolean => {
    const now = Date.now();
    if (now - lastCommand.current < SPACING_MS) { say('Neodesláno: jiná změna se právě zpracovává', 'bad'); return false; }
    if (positionRef.current && now - positionRef.current.filledAt < SETTLE_MS) { say('Neodesláno: Vstup se právě vyplnil — zkus to za chvíli.', 'bad'); return false; }
    return true;
  };
  const setLeg = (leg: ManualLeg, value: number | null, text: string) => {
    lastCommand.current = Date.now();
    if (value != null) setPending(current => ({ ...current, [leg]: value }));
    window.setTimeout(() => {
      setPending({});
      setPosition(current => (current ? { ...current, [leg === 'stopLoss' ? 'stop' : 'target']: value } : current));
      say(text);
    }, SEND_MS);
  };
  const name = (leg: ManualLeg) => (leg === 'stopLoss' ? 'SL' : 'TP');
  const market = () => priceRef.current;
  const place = (leg: ManualLeg, value: number, verb: string) => {
    const open = positionRef.current;
    if (!open || !gate()) return;
    const problem = singleLegPriceProblem({ side: open.side === 'long' ? 'Buy' : 'Sell', leg, price: value, market: market(), minTicks: 8 });
    if (problem) { say(`Neodesláno: ${problem}`, 'bad'); return; }
    setLeg(leg, value, `${name(leg)} ${verb}.`);
  };
  const orderPrice = (side: 'long' | 'short', type: 'limit' | 'stop') => {
    const towardsLoss = (side === 'long') === (type === 'limit');
    return snap(price + (towardsLoss ? -distance : distance));
  };
  const buy = (side: 'long' | 'short') => {
    if (entryType === 'market') {
      setPosition({ side, entry: market(), filledAt: Date.now(), stop: null, target: null });
      say('Market vyplněný, pozice je bez SL a TP. Natáhni čip + SL nebo + TP.', 'warn');
      return;
    }
    // Stejné brány jako worker `manualEntryBarePendingBlockers`.
    if (entryType === 'limit' && distance <= 0) { say('Neodesláno: Limit bez SL/TP je přes trh a vyplnil by se hned — použij Market, nebo cenu posuň.', 'bad'); return; }
    if (entryType === 'stop' && distance < MANUAL_ENTRY_BARE_STOP_MIN_TICKS * TICK) { say(`Neodesláno: Stop bez SL/TP musí být aspoň ${MANUAL_ENTRY_BARE_STOP_MIN_TICKS} ticků od trhu na straně průrazu.`, 'bad'); return; }
    const next = { side, type: entryType, price: orderPrice(side, entryType) };
    orderRef.current = next;
    setOrder(next);
    say(`${entryType === 'limit' ? 'Limit' : 'Stop'} je u brokera bez SL a TP. Čeká na vyplnění, × ho zruší.`);
  };

  const panel = isDark ? '#121823' : '#fff';
  const ink = isDark ? '#e6ebf3' : '#0f172a';
  const line = isDark ? '#263041' : '#dbe1ea';
  const muted = isDark ? '#8a97ab' : '#64748b';
  const toneColor = notice?.tone === 'bad' ? '#ef4444' : notice?.tone === 'warn' ? '#f59e0b' : '#10b981';
  const button: React.CSSProperties = { minHeight: 42, flex: 1, border: 0, borderRadius: 10, color: '#fff', fontWeight: 800, cursor: 'pointer', fontSize: 14 };
  return (
    <div style={{ height: '100dvh', background: isDark ? '#0b0f16' : '#f3f5f9', color: ink, font: '14px Inter, system-ui, sans-serif', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: phone ? 'min(100%, 430px)' : '100%', maxWidth: phone ? 430 : 1100, display: 'flex', flexDirection: 'column', gap: 8, padding: 8, boxSizing: 'border-box', minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <b style={{ flex: 1, minWidth: 180 }}>Limit a Stop bez SL/TP · náhled</b>
          <div style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 9, background: line }}>
            {[['PC', false], ['Telefon', true]].map(([label, value]) => (
              <button key={String(label)} type="button" onClick={() => setPhone(value as boolean)} style={{ border: 0, borderRadius: 6, padding: '5px 10px', fontWeight: 700, cursor: 'pointer', background: phone === value ? panel : 'transparent', color: phone === value ? ink : muted }}>{label}</button>
            ))}
          </div>
        </div>
        <div data-preview-chart style={{ position: 'relative', flex: 1, minHeight: 240, border: `1px solid ${line}`, borderRadius: 12, overflow: 'hidden' }}>
          <ChartView data={chartData as never} seriesType="candlestick" showVolume={false} theme={isDark ? 'dark' : 'light'} onReady={setApi} style={{ width: '100%', height: '100%' }}>
            {api && (
              <BacktestOrderLinesOverlay
                api={api} lines={lines} isDark={isDark} selectToDrag={phone}
                onChange={(_line, kind, next) => {
                  if (kind === 'entry' || !summary) return;
                  const snapped = snap(next);
                  const current = kind === 'stopLoss' ? summary.stop : summary.target;
                  if (snapped === current) return;
                  const blocked = liveLineMoveBlockReason(summary, kind, snapped, { pendingLegs: true });
                  if (blocked) { say(blocked, 'bad'); return; }
                  place(kind, snapped, 'posunut');
                }}
                onCancel={target => {
                  if (target.kind === 'entry' && orderRef.current) {
                    driveRef.current = false;
                    orderRef.current = null;
                    setOrder(null);
                    say('Vstup zrušený, žádná pozice nevznikla.');
                    return;
                  }
                  if (target.kind === 'entry') { setPosition(null); say('Pozice zavřená, nohy zrušil broker.'); return; }
                  if (!gate()) return;
                  setLeg(target.kind, null, `${name(target.kind)} zrušen, čip je zpátky na vstupu.`);
                }}
                onAction={(_line, action) => {
                  if (action === LIVE_ATTACH_SEND_ACTION || action !== 'break-even' || !summary) return;
                  const be = liveBreakEven(summary, summary.entry);
                  if (be.blocked || be.price == null) { say(be.blocked ?? 'BE teď nejde.', 'bad'); return; }
                  place('stopLoss', be.price, 'posunut na BE');
                }}
                onAddBracket={(_line, kind, next) => {
                  if (next == null) { say('Čip táhni na cenu, kde chceš mít nohu.', 'warn'); return; }
                  place(kind, snap(next), 'je u brokera');
                }}
              />
            )}
          </ChartView>
        </div>
        <div role="status" style={{ minHeight: 38, boxSizing: 'border-box', padding: '8px 12px', borderRadius: 10, background: panel, border: `1px solid ${line}`, color: toneColor, fontWeight: 600, fontSize: 13 }}>{notice?.text}</div>
        {position || order ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200, padding: '8px 12px', borderRadius: 10, background: panel, border: `1px solid ${line}`, fontSize: 13 }}>
              <b style={{ color: muted, fontSize: 11 }}>U BROKERA </b>
              {order
                ? <>{order.side === 'long' ? 'BUY' : 'SELL'} 1 {order.type === 'limit' ? 'LIMIT' : 'STOP'} {order.price.toFixed(2)} · čeká · <span style={{ color: '#f59e0b', fontWeight: 700 }}>žádný SL ani TP</span></>
                : <>{position!.side === 'long' ? 'LONG' : 'SHORT'} 1 · {position!.stop != null ? `SL ${position!.stop.toFixed(2)}` : <span style={{ color: '#ef4444', fontWeight: 700 }}>bez SL</span>} · {position!.target != null ? `TP ${position!.target.toFixed(2)}` : <span style={{ color: muted, fontWeight: 700 }}>bez TP</span>}</>}
            </div>
            {order && <button type="button" onClick={() => { driveRef.current = true; say('Cena jede k příkazu. Sleduj, co se stane při vyplnění.', 'warn'); }} style={{ ...button, flex: 'none', padding: '0 14px', background: line, color: ink }}>Dojet k příkazu</button>}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 9, background: line }}>
                {(['market', 'limit', 'stop'] as const).map(type => (
                  <button key={type} type="button" onClick={() => setEntryType(type)} style={{ border: 0, borderRadius: 6, padding: '6px 12px', fontWeight: 700, cursor: 'pointer', background: entryType === type ? panel : 'transparent', color: entryType === type ? ink : muted }}>{type === 'market' ? 'Market' : type === 'limit' ? 'Limit' : 'Stop'}</button>
                ))}
              </div>
              {entryType !== 'market' && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: muted }}>
                  Od trhu
                  <button type="button" aria-label="Blíž k trhu" onClick={() => setDistance(current => Math.max(0, current - 1))} style={{ width: 30, height: 30, border: 0, borderRadius: 7, background: line, color: ink, cursor: 'pointer', fontWeight: 800 }}>−</button>
                  <b style={{ color: ink, minWidth: 42, textAlign: 'center' }}>{distance} b</b>
                  <button type="button" aria-label="Dál od trhu" onClick={() => setDistance(current => current + 1)} style={{ width: 30, height: 30, border: 0, borderRadius: 7, background: line, color: ink, cursor: 'pointer', fontWeight: 800 }}>+</button>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['short', 'long'] as const).map(side => (
                <button key={side} type="button" onClick={() => buy(side)} style={{ ...button, minHeight: 50, background: '#d97706', display: 'grid', alignContent: 'center' }}>
                  <span>{liveBareMarketButtonLabel(side === 'long' ? 'buy' : 'sell', 1, entryType === 'stop' ? 'STOP' : entryType === 'limit' ? 'LIMIT' : 'MARKET')}</span>
                  <small style={{ fontWeight: 600, opacity: 0.85, fontSize: 11 }}>{entryType === 'market' ? `~${price.toFixed(2)}` : `@ ${orderPrice(side, entryType).toFixed(2)}`}</small>
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: muted }}>
              {entryType === 'market' ? 'Market bez SL/TP: odešle se hned, ztráta nemá strop.' : `${entryType === 'stop' ? 'Stop' : 'Limit'} bez SL/TP: po vyplnění ztráta nemá strop, dokud SL nenatáhneš. Jen 1 kontrakt.`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
