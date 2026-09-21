/**
 * Náhled veřejné stránky sdílené karty bez Supabase.
 *
 * Mountuje tutéž kartu a totéž animované pozadí, co uvidí příjemce odkazu —
 * jen jim podstrčí snapshot v paměti. Slouží k posouzení světlé varianty
 * grafu a šířky kompozice, které v přihlášené appce nejde vyzkoušet.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AnimatedTradingBackground from '../components/AnimatedTradingBackground';
import { LiveDayCard } from '../components/LiveDayCard';
import { publicLiveDaySummary } from '../lib/liveDayShare';
import type { LiveDayRow, LiveDaySummary } from '../lib/liveDaySummary';
import '../index.css';

const row = (name: string, firm: string, value: number): LiveDayRow =>
  ({ accountId: 0, name, firm, value, state: 'confirmed', stale: false });

const rows: LiveDayRow[] = [
  row('FTDFYG50511354175', 'Tradeify', 610), row('TDF00008211', 'Tradeify', 507),
  row('TDF00008217', 'Tradeify', 441), row('TDF00008206', 'Apex', 412),
  row('TDF00008208', 'Tradeify', 388), row('TDF00008222', 'Tradeify', 305),
  row('TDF00008214', 'Tradeify', 264), row('TDF00008219', 'Tradeify', 159),
  row('LFF05066846490007', 'Lucid', -95), row('TDF00008216', 'Tradeify', -97),
];
const summary: LiveDaySummary = publicLiveDaySummary({
  rows,
  confirmed: rows.reduce((sum, item) => sum + (item.value ?? 0), 0),
  confirmedCount: rows.length,
  accountCount: rows.length,
  partial: false,
  stale: false,
  noTradeCount: 0,
  unconfirmedCount: 0,
});

function Preview() {
  const [light, setLight] = useState(true);
  // Vedlejší efekt patří do `useEffect`, ne do renderu — jinak se motiv
  // přepisoval i při překreslení z jiného důvodu.
  useEffect(() => {
    document.documentElement.classList.toggle('light-theme', light);
    return () => document.documentElement.classList.remove('light-theme');
  }, [light]);

  return <main className={`relative min-h-screen w-full overflow-hidden ${light ? 'bg-slate-200' : 'bg-black'}`}>
    <AnimatedTradingBackground variant={light ? 'light' : 'dark'} />
    <div className="relative z-10 min-h-screen w-full overflow-y-auto px-4 py-8 sm:px-8">
      <button
        type="button"
        onClick={() => setLight(value => !value)}
        className={`mb-4 rounded-lg border px-3 py-1.5 text-xs font-bold ${light
          ? 'border-slate-400 bg-white text-slate-700'
          : 'border-white/20 bg-white/10 text-white'}`}
      >
        {light ? 'Přepnout na tmavé' : 'Přepnout na světlé'}
      </button>
      <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-[1060px] items-center justify-center">
        <div className="w-full"><LiveDayCard
          translucent
          summary={summary}
          owner={{ name: 'Filip Krejča' }}
          tradeDate="2026-09-21"
          trades={7}
          losingTrades={2}
          formatName={name => name}
        /></div>
      </div>
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Preview />);
