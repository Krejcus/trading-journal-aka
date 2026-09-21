/**
 * Čtyři míry průhlednosti sdílené karty nad běžícím grafem svíček.
 *
 * Posoudit to jde jen nad živým pozadím: svíčky se hýbou, takže se pod
 * kartou střídá tmavé pozadí s jasnou svíčkou a čitelnost kolísá. Statický
 * snímek by ukázal jen jeden okamžik.
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
  confirmedCount: rows.length, accountCount: rows.length,
  partial: false, stale: false, noTradeCount: 0, unconfirmedCount: 0,
});

/** [klíč, název, popis, deska tmavá, dlaždice tmavá, deska světlá, dlaždice světlá] */
const LEVELS = [
  ['dnes', 'Dnešní stav', 'Svíčky jen naznačené v horním pruhu a kolem dlaždic.', 0.60, 0.55, 0.56, 0.78],
  ['a', 'A · Víc', 'Deska znatelně prosvítá, dlaždice pořád drží čísla.', 0.44, 0.42, 0.40, 0.66],
  ['b', 'B · Hodně', 'Karta je spíš obrys než plocha. Graf jede skrz celou.', 0.26, 0.30, 0.22, 0.52],
  ['c', 'C · Úplně průhledná', 'Deska nemá vlastní barvu, jen rozostření. Nejrizikovější na čtení.', 0, 0.16, 0, 0.38],
] as const;

function Preview() {
  const [light, setLight] = useState(false);
  const [level, setLevel] = useState<string>('a');
  const active = LEVELS.find(item => item[0] === level)!;

  useEffect(() => {
    document.documentElement.classList.toggle('light-theme', light);
    return () => document.documentElement.classList.remove('light-theme');
  }, [light]);

  const [, , , plateDark, tileDark, plateLight, tileLight] = active;
  const plate = light ? plateLight : plateDark;
  const tile = light ? tileLight : tileDark;

  const btn = (on: boolean) => `rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors ${on
    ? 'border-cyan-500 bg-cyan-600 text-white'
    : light ? 'border-slate-400 bg-white/80 text-slate-700' : 'border-white/20 bg-white/10 text-white'}`;

  return <main className={`relative min-h-screen w-full overflow-hidden ${light ? 'bg-slate-200' : 'bg-black'}`}>
    <AnimatedTradingBackground variant={light ? 'light' : 'dark'} />
    {/* Míru přepisuju tady, ať se kvůli porovnání nesahá do index.css. */}
    <style>{`
      .glass-demo .live-day-inner {
        background:
          radial-gradient(ellipse 70% 60% at 12% 0%, rgba(34,211,238,.14) 0%, transparent 60%),
          radial-gradient(ellipse 60% 60% at 100% 100%, rgba(16,185,129,.11) 0%, transparent 60%),
          rgba(0,0,0,${plate}) !important;
      }
      .light-theme .glass-demo .live-day-inner {
        background:
          radial-gradient(ellipse 100% 100% at 50% 45%, transparent 40%, rgba(15,23,42,.07) 100%),
          radial-gradient(ellipse 70% 60% at 12% 0%, rgba(34,211,238,.18) 0%, transparent 62%),
          radial-gradient(ellipse 60% 60% at 100% 100%, rgba(16,185,129,.14) 0%, transparent 62%),
          rgba(251,253,255,${plate}) !important;
      }
      .glass-demo .live-day-glass { background: rgba(10,14,22,${tile}) !important; }
      .light-theme .glass-demo .live-day-glass { background: rgba(255,255,255,${tile}) !important; }
    `}</style>

    <div className="relative z-10 min-h-screen w-full overflow-y-auto px-4 py-6 sm:px-8">
      <div className={`mx-auto mb-5 flex max-w-[1060px] flex-wrap items-center gap-2 rounded-xl border p-2 ${light
        ? 'border-slate-300 bg-white/70' : 'border-white/10 bg-black/50'}`}>
        <button type="button" onClick={() => setLight(value => !value)} className={btn(false)}>
          {light ? 'Tmavé' : 'Světlé'}
        </button>
        <span className={`mx-1 text-[10px] font-black uppercase tracking-[0.1em] ${light ? 'text-slate-500' : 'text-white/45'}`}>
          Průhlednost
        </span>
        {LEVELS.map(([key, name]) => (
          <button key={key} type="button" onClick={() => setLevel(key)} className={btn(key === level)}>{name}</button>
        ))}
        <span className={`ml-auto max-w-[420px] text-[11px] ${light ? 'text-slate-600' : 'text-white/60'}`}>
          {active[2]} <b className="tabular-nums">deska {Math.round(plate * 100)} % · dlaždice {Math.round(tile * 100)} %</b>
        </span>
      </div>

      <div className="mx-auto flex min-h-[calc(100vh-10rem)] w-full max-w-[1060px] items-center justify-center">
        <div className="glass-demo w-full">
          <LiveDayCard
            translucent
            summary={summary}
            owner={{ name: 'Filip Krejča' }}
            tradeDate="2026-09-21"
            trades={7}
            losingTrades={2}
            formatName={name => name}
          />
        </div>
      </div>
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Preview />);
