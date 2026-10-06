/**
 * Náhled skutečné sdílecí karty obchodu mimo přihlášenou appku: se
 * screenshotem, s cenovou dráhou, se skrytou částkou a v exportním plátně.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import TradeShareCard from '../components/TradeShareCard';
import type { Trade } from '../types';
import '../index.css';

const entry = Date.UTC(2026, 9, 2, 13, 47);
const base = {
  id: '6f0e9b9c-0000-4000-8000-000000000001', accountId: 'a', signal: '', runUp: 0, drawdown: 0,
  date: '2026-10-02', timestamp: entry, entryTime: entry, duration: '12m', durationMinutes: 12,
  instrument: 'MNQ', direction: 'Long', entryPrice: 31018.25, positionSize: 6, session: 'NY AM',
  plannedStopLoss: 31006, plannedTakeProfit: 31048, riskAmount: 147,
  notes: 'Reakce na PDH + VWAP, vstup po sweepu londýnského low. Částečný výstup jsem neudělal, příště 50 % na 1R.',
} as unknown as Trade;
const win = { ...base, pnl: 291, exitPrice: 31042.5, exitReason: 'tp' } as Trade;
const loss = { ...base, pnl: -147, exitPrice: 31006, exitReason: 'sl', durationMinutes: 7 } as Trade;
const owner = { name: 'Filip Krejča' };

const App = () => {
  const [dark, setDark] = useState(false);
  document.documentElement.classList.toggle('light-theme', !dark);
  const cases: Array<[string, Trade, Record<string, unknown>]> = [
    ['Screenshot + zisk', { ...win, screenshot: '/mockups/share-shots/mnq.jpg' } as Trade, { shareUrl: 'https://alphatrade.app/share/x', onScreenshotClick: () => alert('zoom') }],
    ['Bez screenshotu + ztráta (SL)', loss, {}],
    ['Skrytá částka + poznámka', win, { hideAmount: true, showNotes: true }],
  ];
  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: 24, display: 'grid', gap: 28 }}>
      <button onClick={() => setDark(value => !value)} style={{ justifySelf: 'start' }}>{dark ? 'Světlý' : 'Tmavý'} motiv</button>
      {cases.map(([title, trade, props]) => (
        <section key={title}>
          <h3 style={{ font: '600 13px Inter, sans-serif', color: dark ? '#cbd5e1' : '#475569' }}>{title}</h3>
          <TradeShareCard trade={trade} owner={owner} toolsSlot={<button className="live-day-ghost">↗</button>} {...props} />
        </section>
      ))}
      <h3 style={{ font: '600 13px Inter, sans-serif' }}>Export 1200×630</h3>
      <div className="trade-card-export" style={{ width: 1200, height: 630, background: dark ? '#020617' : '#e2e8f0' }}>
        <TradeShareCard trade={{ ...win, screenshot: '/mockups/share-shots/mnq.jpg' } as Trade} owner={owner} shareUrl="https://alphatrade.app/share/x" captureMode />
      </div>
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<App />);
