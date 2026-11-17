// SKUTEČNÁ obchodní obrazovka appky (LiveTradingScreen: graf, lístek, čáry) napojená na místní
// proces scripts/rithmic/devTradeServer.ts → Rithmic Test. Příkazy opravdu odcházejí — na
// TESTOVACÍ účet se simulovanými penězi. Žádná skupina účtů, žádná kopírka; texty obrazovky
// o „leaderovi" a „kopírce" jsou pozůstatek Tradovate cesty a tady nic neznamenají.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import LiveTradingScreenSlot from '../../components/LiveTradingScreenSlot';
import type { LiveTradingCopierState } from '../../components/LiveTradingScreen';
import { RITHMIC_SOLO_ACCOUNT, useRithmicLocalTrading } from '../../hooks/useRithmicLocalTrading';
import type { LocalExecState } from '../../services/rithmic/localExec';
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

interface Timing { label: string; ms: number }

function App() {
  const [isDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true);
  const [timings, setTimings] = useState<Timing[]>([]);
  /** Čekající měření klik → čára: splní se prvním stavem, který podmínce vyhoví, + vykreslení. */
  const pending = useRef<Array<{ label: string; t0: number; done: (s: LocalExecState) => boolean }>>([]);
  const onMeasure = useCallback((label: string, done: (s: LocalExecState) => boolean) => { pending.current.push({ label, t0: performance.now(), done }); }, []);
  const trading = useRithmicLocalTrading({ url: SERVER, enabled: true, onMeasure });
  const { link, state, symbol, price, position, marketData, events, onPlaceEntry, onManageEntry } = trading;

  useEffect(() => {
    if (!state || !pending.current.length) return;
    const ready = pending.current.filter((item) => item.done(state));
    if (!ready.length) return;
    pending.current = pending.current.filter((item) => !ready.includes(item));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setTimings((current) => [...current.slice(-7), ...ready.map((item) => ({ label: item.label, ms: Math.round(performance.now() - item.t0) }))]);
    }));
  }, [state]);

  // Žádná kopírka tu neběží: prázdný stav; dostupnost příkazů dává režim jednoho účtu.
  const copier = useMemo<LiveTradingCopierState>(() => ({ status: null, available: false, pending: false, transport: 'local', reconnectRequired: 0 }), []);
  const solo = useMemo(() => ({ label: `Rithmic Test · ${symbol}`, available: trading.available }), [symbol, trading.available]);

  const banner = link !== 'open' ? (TOKEN ? 'Místní proces není dostupný (nebo neplatný token).' : 'Chybí přístupový token — otevři stránku odkazem s #token=…')
    : !state?.connected ? 'Rithmic je odpojený.' : state.blocked ? `Nové vstupy stojí: ${state.blocked}` : null;
  const rejection = state?.rejections.at(-1);

  return (
    <>
      {marketData ? (
        <LiveTradingScreenSlot
          open isDark={isDark} tabs={[]} onNavigate={() => undefined} copier={copier} group={null} disarm={null}
          position={position} marketData={marketData} solo={solo} copyEvents={events}
          onPlaceEntry={onPlaceEntry} onManageEntry={onManageEntry}
          manageEntryAvgPrice={trading.averagePrice} manageCloseSupported entryMarketSupported
          entryMaxContracts={2} entryFrontContract={symbol} manageLeaderAccountId={RITHMIC_SOLO_ACCOUNT} workingOrders={null}
        />
      ) : <div style={{ height: '100dvh', display: 'grid', placeItems: 'center', font: '14px system-ui', color: '#94a3b8', background: '#0b0f16' }}>Čekám na první cenu z Rithmic Test…</div>}
      <div data-qa-overlay style={{ position: 'fixed', left: 70, top: 150, zIndex: 400, maxWidth: 300, opacity: 0.9, padding: '8px 10px', borderRadius: 10, background: 'rgba(15,23,42,0.92)', color: '#e2e8f0', font: '12px system-ui', pointerEvents: 'auto' }}>
        <b>Rithmic Test · {symbol || '…'}</b> · {price?.toFixed(2) ?? '—'} · {link === 'open' ? 'připojeno' : link}
        {banner && <div style={{ color: '#f87171', marginTop: 4 }}>{banner}</div>}
        {state?.blocked && <button type="button" data-qa-ack onClick={() => void trading.ack()} style={{ marginTop: 4, border: 0, borderRadius: 6, padding: '4px 8px', cursor: 'pointer' }}>Potvrdit incident</button>}
        {rejection && <div style={{ color: '#fbbf24', marginTop: 4 }}>Odmítnuto: {rejection.reason}</div>}
        {timings.length > 0 && <div data-qa-timings style={{ marginTop: 4 }}>{timings.map((item, index) => <div key={`${item.label}-${index}`}>{item.label}: <b>{item.ms} ms</b></div>)}</div>}
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
