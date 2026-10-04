import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Loader2, X } from 'lucide-react';
import type { Account, Trade } from '../types';
import type { TradeExecutionHistory } from '../lib/tradeExecutionHistory';
import { buildLabDecisions, labMissingHistoryIds, type LabDecision } from '../lib/labDataset';
import {
  LAB_DEFAULT_RULES, LAB_NO_REASON, labDays, labInvalidReasons, labPlanComparison, labSimulateRule,
  type LabDay, type LabRuleResult, type LabStats, type LabUnit,
} from '../lib/labAnalysis';
import { storageService } from '../services/storageService';
import { labExcursion, type LabExcursion } from '../lib/labExcursion';
import { cancelledOrderOutcome, type OutcomeCandle } from '../lib/entryOrderOutcome';
import { LAB_SETUP_MIN, LAB_TAG_MIN, labManagement, labSetups, labTime, labUntaken, labUntakenUsd, type LabUntakenItem } from '../lib/labSections';
import { loadMarketCandles } from '../services/marketData';
import { resolveMarketSymbol } from '../services/marketDataCalculations';
import { futuresSymbolRoot, pointValueUsd } from '../services/futuresContractSpecs';
import { loadUntakenOrders } from '../services/untakenOrders';

/**
 * Nový Lab (živý režim): jedna stránka, sekce podle otázek, každá karta =
 * tvrzení · číslo · „z N obchodů“ · rozkliknutí na obchody. Jednotka je
 * rozhodnutí (kopie se nesčítají), peníze jsou $ na leaderovi, R jen se SL.
 * Čísla počítá `lib/labAnalysis.ts`.
 */
type Period = 7 | 30 | 0;
/** Začátek dat deníku Tradovate (nevzaté obchody se načítají od něj). */
const LAB_DATA_SINCE_MS = Date.parse('2026-09-01T00:00:00Z');

const PRAGUE_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' });
const pragueDayKey = (ms: number) => PRAGUE_DAY.format(ms);
/** Půlnoc dne v Praze (UTC ms) — zimní i letní čas. */
function pragueMidnight(dayKey: string): number {
  for (const offset of ['+02:00', '+01:00']) {
    const at = Date.parse(`${dayKey}T00:00:00${offset}`);
    if (pragueDayKey(at) === dayKey && new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', hourCycle: 'h23' }).format(at) === '00') return at;
  }
  return Date.parse(`${dayKey}T00:00:00Z`);
}

/**
 * Svíčky po dnech (den + 6 h přesahu pro „kdybys držel“), seskupené podle
 * kořene kontraktu. Rozběhnutý den doběhne i při změně seznamu (data platí
 * dál) a výsledky se doplňují průběžně; 3 dny souběžně.
 */
function useLabCandles(requests: readonly string[]) {
  const [candles, setCandles] = useState<Map<string, OutcomeCandle[]>>(new Map());
  const [pending, setPending] = useState(0);
  const [started] = useState(() => new Set<string>());
  const mounted = useRef(true);
  // StrictMode v dev odpojí a znovu připojí — příznak se musí při připojení obnovit.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const key = requests.join(',');
  useEffect(() => {
    const queue = requests.filter(request => !started.has(request));
    if (!queue.length) return;
    queue.forEach(request => started.add(request));
    setPending(count => count + queue.length);
    const merge = (root: string, list: OutcomeCandle[]) => setCandles(previous => {
      const merged = new Map<number, OutcomeCandle>();
      for (const candle of [...(previous.get(root) ?? []), ...list]) merged.set(candle.time, candle);
      return new Map(previous).set(root, [...merged.values()].sort((a, b) => a.time - b.time));
    });
    const worker = async () => {
      for (let request = queue.shift(); request && mounted.current; request = queue.shift()) {
        const [symbol, dayKey] = request.split('|');
        const root = futuresSymbolRoot(symbol);
        if (root === 'MNQ' || root === 'NQ') {
          const start = pragueMidnight(dayKey);
          const load = () => loadMarketCandles({ symbol: resolveMarketSymbol(root, symbol), start: new Date(start), end: new Date(start + 30 * 3_600_000) });
          try {
            // Souběžné dotazy občas narazí na limit funkce — jeden opakovaný pokus.
            const response = await load().catch(() => new Promise(resolve => setTimeout(resolve, 800)).then(load));
            if (mounted.current) merge(root, response.candles.map(c => ({ time: Number(c.time), high: c.high, low: c.low })));
          } catch {
            // Den bez dat (třeba dnešek) nebo opakovaná chyba: příště se zkusí znovu.
            started.delete(request);
          }
        }
        if (mounted.current) setPending(count => count - 1);
      }
    };
    void Promise.all(Array.from({ length: 3 }, worker));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { candles, loading: pending > 0 };
}

const PRAGUE_TIME = new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit' });
const clock = (ms: number) => PRAGUE_TIME.format(ms);
const dayLabel = (dayKey: string) => { const [, m, d] = dayKey.split('-'); return `${Number(d)}. ${Number(m)}.`; };
const WEEKDAY = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];
const usd = (value: number, signed = true) => `${signed ? value < 0 ? '−' : value > 0 ? '+' : '' : value < 0 ? '−' : ''}$${Math.abs(Math.round(value)).toLocaleString('cs-CZ')}`;
const rFmt = (value: number) => `${value < 0 ? '−' : value > 0 ? '+' : ''}${Math.abs(value).toLocaleString('cs-CZ', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} R`;
const valueFmt = (value: number, unit: LabUnit) => unit === 'usd' ? usd(value) : rFmt(value);
const tone = (value: number | null | undefined) => value == null || value === 0 ? '' : value > 0 ? 'text-emerald-500' : 'text-rose-500';
const plural = (n: number, one: string, few: string, many: string) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;

export default function LabLivePage({ trades, accounts, theme, onOpenTrade }: {
  trades: readonly Trade[];
  accounts: readonly Account[];
  theme: 'dark' | 'light' | 'oled';
  onOpenTrade?: (trade: Trade) => void;
}) {
  const isDark = theme !== 'light';
  const [period, setPeriod] = useState<Period>(30);
  const [unit, setUnit] = useState<LabUnit>('usd');
  const [drawer, setDrawer] = useState<{ title: string; decisions: LabDecision[] } | null>(null);

  // Historie plnění leaderů: SL z brokera (R), výstup SL/TP, posuny SL. Bez ní
  // R chybí u obchodů s bracketem (SL není v řádku obchodu).
  const [histories, setHistories] = useState<Map<string, TradeExecutionHistory>>(new Map());
  // Obchody, jejichž historii se nepodařilo dotáhnout — nezkoušet dokola a
  // nepředstírat prázdnou historii (vypadalo by to jako obchod bez SL).
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());
  const [historyState, setHistoryState] = useState<'idle' | 'loading' | 'error'>('idle');
  const base = useMemo(() => buildLabDecisions({ trades, accounts, histories }), [accounts, histories, trades]);
  const missing = useMemo(() => labMissingHistoryIds(base, histories).filter(id => !unavailable.has(id)), [base, histories, unavailable]);
  const missingKey = missing.join(',');
  useEffect(() => {
    if (!missing.length) return;
    let cancelled = false;
    setHistoryState('loading');
    (async () => {
      const found = new Map<string, TradeExecutionHistory>();
      let failed = false;
      for (let i = 0; i < missing.length; i += 100) {
        try {
          const rows = await storageService.getJournalTradeDetails(missing.slice(i, i + 100));
          for (const row of rows) if (row.executionHistory) found.set(String(row.id), row.executionHistory);
        } catch { failed = true; }
      }
      return { found, failed };
    })().then(({ found, failed }) => {
      if (cancelled) return;
      setHistories(previous => { const merged = new Map(previous); found.forEach((value, key) => merged.set(key, value)); return merged; });
      setUnavailable(previous => { const next = new Set(previous); missing.forEach(id => { if (!found.has(id)) next.add(id); }); return next; });
      setHistoryState(failed ? 'error' : 'idle');
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey]);

  const decisions = useMemo(() => {
    if (!period) return base;
    const from = Date.now() - period * 86_400_000;
    return base.filter(decision => decision.entryAt >= from);
  }, [base, period]);
  // Nevzaté obchody (vlastní tabulka) — od začátku dat, ne jen od 1. 10. jako fronta Hodnotit.
  const [untakenTrades, setUntakenTrades] = useState<Trade[]>([]);
  useEffect(() => { let alive = true; void loadUntakenOrders(LAB_DATA_SINCE_MS).then(rows => { if (alive) setUntakenTrades(rows); }); return () => { alive = false; }; }, []);
  const untakenInPeriod = useMemo(() => {
    const from = period ? Date.now() - period * 86_400_000 : 0;
    return untakenTrades.filter(trade => trade.untaken && trade.untaken.order.placedAt >= from);
  }, [period, untakenTrades]);

  // Svíčky (1m) po dnech pro MFE/MAE, „kdybys držel“ a nevzaté obchody. Databento je až od 26. 9.
  const candleRequests = useMemo(() => {
    const keys = new Set<string>();
    for (const d of decisions) if (d.symbol) keys.add(`${d.symbol}|${d.dayKey}`);
    for (const trade of untakenInPeriod) { const o = trade.untaken!.order; keys.add(`${o.symbol}|${pragueDayKey(o.placedAt)}`); }
    return [...keys].sort();
  }, [decisions, untakenInPeriod]);
  const { candles, loading: candlesLoading } = useLabCandles(candleRequests);
  const candlesFor = (symbol: string) => candles.get(futuresSymbolRoot(symbol)) ?? [];
  const excursions = useMemo(() => {
    const map = new Map<string, LabExcursion>();
    for (const d of decisions) {
      if (d.entryPrice == null) continue;
      const list = candlesFor(d.symbol);
      if (!list.length) continue;
      map.set(d.id, labExcursion({ long: d.direction === 'Long', entryAt: d.entryAt, exitAt: d.exitAt, entryPrice: d.entryPrice, exitPrice: d.exitPrice, sl: d.sl, tp: d.tp }, list));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, decisions]);
  const untakenItems = useMemo<LabUntakenItem[]>(() => untakenInPeriod.filter((trade, index, list) => {
    // Kopie zrušeného vstupu na followerech (jiné připojení nezná vazby kopírky):
    // stejný směr, typ a cena zadané do 2 s = jeden nevzatý obchod.
    const o = trade.untaken!.order;
    return !list.slice(0, index).some(other => {
      const p = other.untaken!.order;
      return p.side === o.side && p.type === o.type && p.legs[0]?.price === o.legs[0]?.price && Math.abs(p.placedAt - o.placedAt) <= 2_000;
    });
  }).map(trade => {
    const meta = trade.untaken!;
    const list = candlesFor(meta.order.symbol);
    return { id: String(trade.id), order: meta.order, pointValue: meta.review?.pointValue ?? pointValueUsd(meta.order.symbol) ?? 2, reason: meta.review?.reason ?? null,
      outcome: meta.review?.outcome ?? (list.length ? cancelledOrderOutcome(meta.order, list) : null) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [candles, untakenInPeriod]);

  const tradeById = useMemo(() => new Map(trades.map(trade => [String(trade.id), trade])), [trades]);
  const open = (decision: LabDecision) => { const trade = tradeById.get(decision.leaderTradeId); if (trade) onOpenTrade?.(trade); };

  const line = isDark ? 'border-white/[0.08]' : 'border-slate-200';
  const card = `rounded-2xl border ${line} ${isDark ? 'bg-[#0d1219]' : 'bg-white'} p-4 md:p-5`;
  const ink = isDark ? 'text-slate-100' : 'text-slate-900';
  const muted = 'text-slate-500';
  const segBtn = (on: boolean) => `px-3 py-1.5 text-[11px] font-extrabold transition-colors ${on ? isDark ? 'bg-indigo-500/20 text-indigo-300' : 'bg-indigo-50 text-indigo-600' : 'text-slate-400 hover:text-slate-500'}`;
  const ui = { line, card, ink, muted, isDark };

  const first = base[0]?.entryAt;
  const reviewed = decisions.filter(d => d.reviewed).length;
  const withR = decisions.filter(d => d.r != null).length;

  if (!base.length) {
    return <div className={`${card} text-center py-12`}><p className={`text-sm font-bold ${ink}`}>Zatím tu nejsou obchody z deníku Tradovate.</p>
      <p className={`mt-1 text-xs ${muted}`}>Lab počítá jen obchody, které importuje deník z Tradovate.</p></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <p className={`text-xs ${muted}`}>
          <b className={ink}>{decisions.length}</b> rozhodnutí · <b className={ink}>{reviewed}</b> ohodnocených · R u <b className={ink}>{withR}</b>
          {first ? <> · data z Tradovate od {new Date(first).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' })}</> : null}
          {historyState === 'loading' && <span className="ml-2 inline-flex items-center gap-1 text-indigo-500"><Loader2 size={11} className="animate-spin" />dotahuji SL z historie</span>}
          {historyState === 'error' && <span className="ml-2 text-amber-600">historii se nepodařilo načíst — R může chybět</span>}
        </p>
        <div className="ml-auto flex flex-wrap gap-2">
          <div className={`flex overflow-hidden rounded-xl border ${line}`}>
            {([[7, '7 dní'], [30, '30 dní'], [0, 'Vše']] as const).map(([value, label]) => <button key={value} type="button" className={segBtn(period === value)} onClick={() => setPeriod(value)}>{label}</button>)}
          </div>
          <div className={`flex overflow-hidden rounded-xl border ${line}`} title="$ = výsledek leader účtu (kopie se nesčítají) · R jen u obchodů se SL">
            <button type="button" className={segBtn(unit === 'usd')} onClick={() => setUnit('usd')}>$ leader</button>
            <button type="button" className={segBtn(unit === 'r')} onClick={() => setUnit('r')}>R</button>
          </div>
        </div>
      </div>

      <nav className="flex flex-wrap gap-1.5">
        {[['a', 'A · Plán vs. mimo plán'], ['b', 'B · Disciplína dne'], ['c', 'C · Řízení obchodu'], ['d', 'D · Nevzaté'], ['e', 'E · Čas'], ['f', 'F · Setupy']].map(([id, label]) => (
          <a key={id} href={`#lab-${id}`} className={`rounded-full border px-3 py-1.5 text-[11.5px] font-extrabold ${line} ${isDark ? 'bg-white/[0.03] text-slate-200' : 'bg-white text-slate-700'}`}>{label}</a>
        ))}
        {['G · Účty'].map(label => (
          <span key={label} className={`rounded-full border border-dashed px-3 py-1.5 text-[11.5px] font-bold ${line} text-slate-400`} title="Připravujeme">{label}</span>
        ))}
      </nav>

      <PlanSection decisions={decisions} unit={unit} ui={ui} onDrill={(title, list) => setDrawer({ title, decisions: list })} />
      <DisciplineSection decisions={decisions} ui={ui} onDrill={(title, list) => setDrawer({ title, decisions: list })} />
      <ManagementSection decisions={decisions} excursions={excursions} candlesLoading={candlesLoading} ui={ui} onDrill={(title, list) => setDrawer({ title, decisions: list })} />
      <UntakenSection items={untakenItems} candlesLoading={candlesLoading} ui={ui} />
      <TimeSection decisions={decisions} unit={unit} ui={ui} onDrill={(title, list) => setDrawer({ title, decisions: list })} />
      <SetupSection decisions={decisions} unit={unit} ui={ui} onDrill={(title, list) => setDrawer({ title, decisions: list })} />

      {drawer && <Drawer title={drawer.title} decisions={drawer.decisions} unit={unit} ui={ui} onClose={() => setDrawer(null)} onOpen={open} />}
    </div>
  );
}

type Ui = { line: string; card: string; ink: string; muted: string; isDark: boolean };

function SectionHead({ letter, title, sub, ui }: { letter: string; title: string; sub: string; ui: Ui }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-2.5">
      <span className={`grid h-[22px] w-[22px] place-items-center rounded-md text-[11px] font-black ${ui.isDark ? 'bg-white text-slate-900' : 'bg-slate-900 text-white'}`}>{letter}</span>
      <h3 className={`text-[17px] font-black tracking-tight ${ui.ink}`}>{title}</h3>
      <p className={`text-xs ${ui.muted}`}>{sub}</p>
    </div>
  );
}

function Meta({ children, onDrill, label = 'Zobrazit obchody', ui }: { children: React.ReactNode; onDrill?: () => void; label?: string; ui: Ui }) {
  return (
    <div className={`mt-3 flex items-center justify-between gap-2 border-t border-dashed pt-2.5 text-[11px] ${ui.line} ${ui.muted}`}>
      <span>{children}</span>
      {onDrill && <button type="button" onClick={onDrill} className="font-extrabold text-indigo-500 hover:text-indigo-400">{label} ›</button>}
    </div>
  );
}

const eyebrow = 'text-[9.5px] font-black uppercase tracking-[0.16em] text-slate-500';

// ── A ────────────────────────────────────────────────────────────────────────

function PlanSection({ decisions, unit, ui, onDrill }: { decisions: LabDecision[]; unit: LabUnit; ui: Ui; onDrill: (title: string, list: LabDecision[]) => void }) {
  const plan = useMemo(() => labPlanComparison(decisions, unit), [decisions, unit]);
  const reasons = useMemo(() => labInvalidReasons(decisions, unit), [decisions, unit]);
  const yesList = decisions.filter(d => d.reviewed && d.plan === 'yes');
  const noList = decisions.filter(d => d.reviewed && d.plan === 'no');
  const enough = plan.yes.covered >= 5 && plan.no.covered >= 5;
  const claim = !plan.reviewed ? 'Zatím nemáš ohodnocený žádný obchod — srovnání se ukáže, jakmile začneš hodnotit v Hodnotit.'
    : !enough ? `Ohodnoceno ${plural(plan.reviewed, 'obchod', 'obchody', 'obchodů')} (podle plánu ${plan.yes.count}, mimo plán ${plan.no.count}). Srovnání bude spolehlivé od 5 v každé skupině.`
    : plan.no.total < 0 && plan.yes.total > 0 ? `Podle plánu jsi ${valueFmt(plan.yes.total, unit)}, mimo plán ${valueFmt(plan.no.total, unit)}.`
    : `Podle plánu ${valueFmt(plan.yes.total, unit)}, mimo plán ${valueFmt(plan.no.total, unit)}.`;
  const top = reasons[0];
  return (
    <section id="lab-a" className="scroll-mt-20">
      <SectionHead letter="A" title="Plán vs. mimo plán" sub="Kolik vyděláváš, když hraješ podle sebe." ui={ui} />
      <div className="grid gap-3 lg:grid-cols-[1.3fr_1fr]">
        <div className={ui.card}>
          <p className={eyebrow}>Equity · {unit === 'usd' ? '$ na leaderovi' : 'R'}</p>
          <p className={`mt-1.5 mb-3 text-[13.5px] font-bold leading-snug ${ui.ink}`}>{claim}</p>
          <EquityChart ui={ui} series={[
            { label: 'podle plánu', color: '#4f46e5', stats: plan.yes },
            { label: 'mimo plán', color: '#f43f5e', stats: plan.no },
            { label: 'neohodnocené', color: '#94a3b8', stats: plan.unreviewed, dashed: true },
          ]} unit={unit} />
          <div className={`mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-xl border ${ui.line} ${ui.isDark ? 'bg-white/[0.08]' : 'bg-slate-200'}`}>
            <PlanCell label="Podle plánu" color="text-indigo-500" stats={plan.yes} unit={unit} ui={ui} />
            <PlanCell label="Mimo plán" color="text-rose-500" stats={plan.no} unit={unit} ui={ui} />
          </div>
          <Meta ui={ui} onDrill={plan.reviewed ? () => onDrill('Ohodnocené obchody', [...yesList, ...noList]) : undefined}>
            z <b className="text-slate-600 dark:text-slate-300">{plan.reviewed}</b> ohodnocených · neohodnocených {plan.unreviewed.count}
            {unit === 'r' && ` · R jen se SL`}
          </Meta>
        </div>
        <div className={ui.card}>
          <p className={eyebrow}>Proč mimo plán</p>
          {top ? <>
            <p className={`mt-1.5 mb-3 text-[13.5px] font-bold leading-snug ${ui.ink}`}>Nejdražší důvod je <span className="text-indigo-500">„{top.reason}“</span> — {top.count}× a {valueFmt(top.total, unit)}.</p>
            <div className="grid gap-2">
              {reasons.map(row => {
                const width = reasons[0].total ? Math.max(4, row.total / reasons[0].total * 100) : 4;
                return (
                  <button key={row.reason} type="button" onClick={() => onDrill(`Mimo plán · ${row.reason}`, row.decisions)} className="grid grid-cols-[1fr_96px_72px] items-center gap-2.5 text-left text-xs">
                    <span className={row.reason === LAB_NO_REASON ? 'text-slate-400' : ui.ink}>{row.reason} <span className="text-slate-400">{row.count}×</span></span>
                    <span className={`h-2 overflow-hidden rounded ${ui.isDark ? 'bg-rose-500/10' : 'bg-rose-50'}`}><span className="block h-full bg-rose-500" style={{ width: `${row.total < 0 ? width : 0}%` }} /></span>
                    <b className={`text-right tabular-nums ${tone(row.total)}`}>{valueFmt(row.total, unit)}</b>
                  </button>
                );
              })}
            </div>
          </> : <p className={`mt-2 text-xs leading-relaxed ${ui.muted}`}>Zatím žádný obchod označený „mimo plán“. Důvody a jejich cena se objeví tady, jakmile nějaký ohodnotíš.</p>}
          <Meta ui={ui} onDrill={noList.length ? () => onDrill('Mimo plán', noList) : undefined}>z <b className="text-slate-600 dark:text-slate-300">{noList.length}</b> obchodů mimo plán</Meta>
        </div>
      </div>
    </section>
  );
}

function PlanCell({ label, color, stats, unit, ui }: { label: string; color: string; stats: LabStats; unit: LabUnit; ui: Ui }) {
  return (
    <div className={ui.isDark ? 'bg-[#0d1219] p-3' : 'bg-white p-3'}>
      <p className={`text-[9.5px] font-black uppercase tracking-[0.12em] ${color}`}>{label}</p>
      <p className={`mt-1.5 font-mono text-[20px] font-bold tabular-nums ${stats.average == null ? 'text-slate-400' : color}`}>{stats.average == null ? '—' : valueFmt(stats.average, unit)}</p>
      <p className="mt-0.5 text-[10.5px] text-slate-500">na obchod · {stats.winRate == null ? 'WR —' : `WR ${Math.round(stats.winRate * 100)} %`} · {plural(stats.count, 'obchod', 'obchody', 'obchodů')}{unit === 'r' && stats.covered < stats.count ? ` (${stats.covered} se SL)` : ''}</p>
    </div>
  );
}

function EquityChart({ series, unit, ui }: { series: { label: string; color: string; stats: LabStats; dashed?: boolean }[]; unit: LabUnit; ui: Ui }) {
  const W = 560, H = 160, P = 8;
  const points = series.flatMap(s => s.stats.equity);
  if (!points.length) return <div className={`grid h-[160px] place-items-center rounded-xl border border-dashed text-xs ${ui.line} text-slate-400`}>Zatím bez dat</div>;
  const t0 = Math.min(...points.map(p => p.at)), t1 = Math.max(...points.map(p => p.at));
  const values = [0, ...points.map(p => p.value)];
  const lo = Math.min(...values), hi = Math.max(...values);
  const x = (at: number) => t1 === t0 ? W / 2 : P + (at - t0) / (t1 - t0) * (W - 2 * P);
  const y = (v: number) => hi === lo ? H / 2 : P + (hi - v) / (hi - lo) * (H - 2 * P);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} aria-label="Equity křivky">
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke={ui.isDark ? '#334155' : '#e2e8f0'} strokeDasharray="3 4" />
        {series.filter(s => s.stats.equity.length).map(s => (
          <polyline key={s.label} fill="none" stroke={s.color} strokeWidth={s.dashed ? 1.5 : 2.5} strokeDasharray={s.dashed ? '4 4' : undefined} strokeLinejoin="round"
            points={[`${x(s.stats.equity[0].at)},${y(0)}`, ...s.stats.equity.map(p => `${x(p.at)},${y(p.value)}`)].join(' ')} />
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 text-[10.5px] text-slate-500">
        {series.map(s => <span key={s.label} className="inline-flex items-center gap-1.5"><i className="inline-block h-[3px] w-3 rounded" style={{ background: s.color }} />{s.label} {s.stats.covered ? <b className={tone(s.stats.total)}>{valueFmt(s.stats.total, unit)}</b> : '—'}</span>)}
      </div>
    </div>
  );
}

// ── B ────────────────────────────────────────────────────────────────────────

function DisciplineSection({ decisions, ui, onDrill }: { decisions: LabDecision[]; ui: Ui; onDrill: (title: string, list: LabDecision[]) => void }) {
  const days = useMemo(() => labDays(decisions), [decisions]);
  const rules = useMemo(() => LAB_DEFAULT_RULES.map(rule => labSimulateRule(days, rule)), [days]);
  const [selected, setSelected] = useState<string | null>(null);
  const fallback = [...days].reverse().find(day => day.tilt)?.dayKey ?? days[days.length - 1]?.dayKey ?? null;
  const day = days.find(item => item.dayKey === (selected ?? fallback)) ?? null;
  const tiltDays = days.filter(item => item.tilt).length;
  const best = [...rules].sort((a, b) => b.net - a.net)[0];
  return (
    <section id="lab-b" className="scroll-mt-20">
      <SectionHead letter="B" title="Disciplína dne" sub="Kde se den zlomil a které pravidlo by tě podrželo." ui={ui} />
      <div className={ui.card}>
        <p className={eyebrow}>Dny · klikni na den {tiltDays > 0 && <span className="ml-1 normal-case tracking-normal text-rose-500">⚠ {plural(tiltDays, 'den', 'dny', 'dní')} s eskalací velikosti</span>}</p>
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
          {days.map(item => {
            const on = item.dayKey === day?.dayKey;
            const weekday = WEEKDAY[item.decisions[0]?.weekday ?? 0];
            return (
              <button key={item.dayKey} type="button" onClick={() => setSelected(item.dayKey)}
                className={`w-[58px] shrink-0 rounded-xl border px-1 pb-1.5 pt-1.5 text-center text-[10px] transition-transform hover:-translate-y-px ${on ? ui.isDark ? 'border-white ring-1 ring-white' : 'border-slate-900 ring-1 ring-slate-900' : ui.line}`}>
                <span className="text-slate-400">{weekday}</span>
                <b className={`block text-[11px] ${ui.ink}`}>{dayLabel(item.dayKey)}</b>
                <span className={`font-extrabold ${tone(item.pnlUsd)}`}>{usd(item.pnlUsd)}</span>
                {item.tilt && <span className="font-black text-rose-500"> ⚠</span>}
                <i className="mt-1 block h-1 rounded" style={{ background: item.pnlUsd < 0 ? '#f43f5e' : '#10b981', opacity: Math.min(1, 0.25 + Math.abs(item.pnlUsd) / 2500) }} />
              </button>
            );
          })}
        </div>
        {day && <DayTimeline day={day} ui={ui} />}
        {day && <DayStory day={day} rule={rules[0]} ui={ui} />}
        {day && <Meta ui={ui} onDrill={() => onDrill(`Obchody ${dayLabel(day.dayKey)}`, day.decisions)}>{plural(day.count, 'rozhodnutí', 'rozhodnutí', 'rozhodnutí')} · úvodní velikost {day.baseSize} ks · max {day.maxSize} ks</Meta>}
      </div>

      <div className={`${ui.card} mt-3`}>
        <p className={eyebrow}>Pravidla na tvých dnech</p>
        <p className={`mt-1.5 mb-3 text-[13.5px] font-bold leading-snug ${ui.ink}`}>
          {best && best.net > 0
            ? <>Nejvíc by pomohlo <span className="text-indigo-500">„{best.label}“</span>: <span className="text-emerald-500">{usd(best.net)}</span> za období (zasáhlo by v {plural(best.affectedDays, 'dni', 'dnech', 'dnech')}).</>
            : <>Žádné z těchto pravidel by v tomto období nepomohlo — po ztrátách se ti zatím dařilo vracet. Rozhoduje to, co pravidlo vezme ze ziskových dnů.</>}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs">
            <thead><tr className="text-left text-[9px] font-black uppercase tracking-[0.13em] text-slate-400">
              <th className="pb-2 pr-2">Pravidlo</th><th className="pb-2 text-right">Dny, kdy zasáhne</th><th className="pb-2 text-right">Přidá</th><th className="pb-2 text-right">Vezme</th><th className="pb-2 text-right">Čistě</th><th className="w-6" />
            </tr></thead>
            <tbody>
              {rules.map(rule => <RuleRow key={rule.label} rule={rule} best={rule === best && rule.net > 0} ui={ui} onDrill={onDrill} />)}
            </tbody>
          </table>
        </div>
        <Meta ui={ui}>simulace nad {plural(days.length, 'obchodním dnem', 'obchodními dny', 'obchodními dny')} · předpoklad: ostatní obchody by proběhly stejně · $ na leaderovi</Meta>
      </div>
    </section>
  );
}

function RuleRow({ rule, best, ui, onDrill }: { rule: LabRuleResult; best: boolean; ui: Ui; onDrill: (title: string, list: LabDecision[]) => void }) {
  const affected = rule.days.flatMap(day => day.affected);
  return (
    <tr className={`border-t border-dashed ${ui.line} ${best ? ui.isDark ? 'bg-emerald-500/10' : 'bg-emerald-50' : ''}`}>
      <td className={`py-2.5 pr-2 ${best ? 'font-extrabold' : ''} ${ui.ink}`}>{rule.label}</td>
      <td className="py-2.5 text-right font-bold tabular-nums">{rule.affectedDays}</td>
      <td className="py-2.5 text-right font-bold tabular-nums text-emerald-500">{rule.added ? usd(rule.added) : '$0'}</td>
      <td className="py-2.5 text-right font-bold tabular-nums text-rose-500">{rule.taken ? usd(rule.taken) : '$0'}</td>
      <td className={`py-2.5 text-right font-extrabold tabular-nums ${tone(rule.net)}`}>{usd(rule.net)}</td>
      <td className="py-2.5 text-right">{affected.length > 0 && <button type="button" aria-label="Obchody, které by pravidlo nepustilo" onClick={() => onDrill(`${rule.label} · obchody, které by nepustilo`, affected)} className="text-indigo-500"><ChevronRight size={14} /></button>}</td>
    </tr>
  );
}

function DayTimeline({ day, ui }: { day: LabDay; ui: Ui }) {
  // Min. rozestup, ať se časy a odstupy nepřekrývají — den se 46 obchody se posouvá do strany.
  const n = day.decisions.length, W = 1060, L = 50, mid = 84;
  const step = Math.max(46, Math.min(84, (W - L - 20) / Math.max(1, n)));
  const width = Math.max(W, L + step * n + 20);
  const x = (i: number) => L + step * (i + 0.5);
  const maxSize = Math.max(1, day.maxSize);
  const sizeH = (size: number) => 8 + Math.min(1, size / maxSize) * 52;
  return (
    <div className="mt-3 overflow-x-auto">
      <svg viewBox={`0 0 ${width} 202`} width={width > W ? width : '100%'} height={202} className={width > W ? 'max-w-none' : 'min-w-[640px]'}>
        <line x1={L - 10} x2={x(n - 1) + step / 2} y1={mid} y2={mid} stroke={ui.isDark ? '#334155' : '#e2e8f0'} />
        <text x={4} y={mid - 6} fontSize={9.5} fill="#94a3b8">Long ↑</text>
        <text x={4} y={mid + 14} fontSize={9.5} fill="#94a3b8">Short ↓</text>
        {day.breakIndex != null && <>
          <rect x={x(day.breakIndex) - step / 2} y={8} width={(n - day.breakIndex) * step} height={150} fill="#f43f5e" opacity={ui.isDark ? 0.08 : 0.06} />
          <text x={x(day.breakIndex) - step / 2 + 6} y={22} fontSize={10} fontWeight={800} fill="#f43f5e">od zlomu dne</text>
        </>}
        {day.decisions.map((decision, i) => {
          const h = sizeH(decision.size), long = decision.direction === 'Long', top = long ? mid - h : mid;
          const color = decision.pnlUsd >= 0 ? '#10b981' : '#f43f5e';
          const signals = day.signals[i];
          const window = decision.session === 'NY open';
          const gap = i > 0 ? Math.round(decision.minutesSincePrevExit ?? 0) : null;
          const quick = signals.includes('quick');
          return (
            <g key={decision.id}>
              <title>{`${clock(decision.entryAt)} ${decision.direction} ${decision.size} ks · ${usd(decision.pnlUsd)}${decision.r != null ? ` · ${rFmt(decision.r)}` : ''}`}</title>
              <rect x={x(i) - 9} y={top} width={18} height={h} rx={4} fill={color} opacity={0.88} />
              <text x={x(i)} y={long ? top - 5 : top + h + 12} fontSize={9.5} fontWeight={800} fill={signals.includes('escalation') ? '#f43f5e' : ui.isDark ? '#cbd5e1' : '#334155'} textAnchor="middle">{decision.size}{signals.includes('escalation') ? '⇧' : ''}</text>
              {signals.includes('flip') && <text x={x(i) + 13} y={mid + 4} fontSize={12} fontWeight={900} fill="#f43f5e">↺</text>}
              <text x={x(i)} y={194} fontSize={10} textAnchor="middle" fontWeight={window ? 800 : 500} fill={window ? '#6366f1' : '#64748b'}>{clock(decision.entryAt)}</text>
              {gap != null && <text x={x(i) - step / 2} y={176} fontSize={9.5} textAnchor="middle" fontWeight={quick ? 900 : 600} fill={quick ? '#d97706' : ui.isDark ? '#475569' : '#cbd5e1'}>
                {quick ? '⏱ ' : ''}{gap >= 60 ? `${Math.floor(gap / 60)} h` : `${gap} min`}
              </text>}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-3.5 text-[10.5px] text-slate-500">
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />zisk</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-rose-500" />ztráta</span>
        <span>výška = velikost (ks)</span><span><b className="text-rose-500">⇧</b> ≥ 2× úvodní velikost v mínusu</span>
        <span><b className="text-rose-500">↺</b> otočení po ztrátě</span><span><b className="text-amber-600">⏱</b> vstup do 5 min po ztrátě</span>
        <span className="font-extrabold text-indigo-500">čas modře = NY open (tvoje okno)</span>
      </div>
    </div>
  );
}

function DayStory({ day, rule, ui }: { day: LabDay; rule: LabRuleResult; ui: Ui }) {
  const quick = day.signals.filter(items => items.includes('quick')).length;
  const flips = day.signals.filter(items => items.includes('flip')).length;
  const broke = day.breakIndex != null ? day.decisions[day.breakIndex] : null;
  const ruleDay = rule.days.find(item => item.dayKey === day.dayKey);
  const rows: [string, React.ReactNode][] = [
    [day.decisions[0] ? clock(day.decisions[0].entryAt) : '', <>Začátek dne: úvodní velikost <b>{day.baseSize} ks</b>, celkem {plural(day.count, 'rozhodnutí', 'rozhodnutí', 'rozhodnutí')}, výsledek <b className={tone(day.pnlUsd)}>{usd(day.pnlUsd)}</b>.</>],
  ];
  if (broke) rows.push([clock(broke.entryAt), <><span className="font-extrabold text-rose-500">Zlom:</span> po ztrátě {broke.size} ks = {(broke.size / day.baseSize).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })}× úvodní velikost. Od té chvíle {usd(day.decisions.slice(day.breakIndex!).reduce((sum, d) => sum + d.pnlUsd, 0))}.</>]);
  if (quick || flips) rows.push(['', <>Po ztrátě: {quick ? <b className="text-amber-600">{quick}× vstup do 5 min</b> : 'žádný rychlý návrat'}{flips ? <>, <b className="text-rose-500">{flips}× otočení směru</b></> : ''}.</>]);
  if (ruleDay && ruleDay.stopAt) rows.push(['', <>„{rule.label}“ by den ukončilo v <b>{clock(ruleDay.stopAt.entryAt)}</b> → <b className={tone(ruleDay.simulated)}>{usd(ruleDay.simulated)}</b> místo {usd(ruleDay.actual)}.</>]);
  return (
    <div className="mt-3 grid gap-1.5">
      {rows.map(([time, text], i) => (
        <div key={i} className="grid grid-cols-[46px_1fr] gap-2 text-xs leading-relaxed">
          <time className="font-bold tabular-nums text-slate-500">{time}</time><span className={ui.isDark ? 'text-slate-300' : 'text-slate-700'}>{text}</span>
        </div>
      ))}
    </div>
  );
}


// ── C ────────────────────────────────────────────────────────────────────────

function Claim({ children, ui }: { children: React.ReactNode; ui: Ui }) {
  return <p className={`mt-1.5 text-[13.5px] font-bold leading-snug ${ui.ink}`}>{children}</p>;
}
function Big({ value, className }: { value: string; className: string }) {
  return <p className={`mt-2 font-mono text-[26px] font-bold leading-none tabular-nums ${className}`}>{value}</p>;
}
function LowData() {
  return <span className="ml-1.5 inline-block rounded-full border border-amber-300/60 bg-amber-50 px-1.5 text-[9.5px] font-extrabold text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">málo dat</span>;
}

function ManagementSection({ decisions, excursions, candlesLoading, ui, onDrill }: { decisions: LabDecision[]; excursions: Map<string, LabExcursion>; candlesLoading: boolean; ui: Ui; onDrill: (title: string, list: LabDecision[]) => void }) {
  const m = useMemo(() => labManagement(decisions, excursions), [decisions, excursions]);
  const coverage = <>svíčky u {m.withCandles} z {decisions.length}{candlesLoading && <span className="ml-1 text-indigo-500">· načítám</span>}</>;
  const median = m.afterExit.medianPoints;
  const manualDelta = m.manual.heldAverageUsd != null && m.manual.actualCoveredAverageUsd != null ? m.manual.heldAverageUsd - m.manual.actualCoveredAverageUsd : null;
  return (
    <section id="lab-c" className="scroll-mt-20">
      <SectionHead letter="C" title="Řízení obchodu" sub="Z posunů SL/TP a svíček po výstupu." ui={ui} />
      <div className="grid gap-3 lg:grid-cols-3">
        <div className={ui.card}>
          <p className={eyebrow}>Posun SL na break-even</p>
          <Big value={m.beThenTp.length ? usd(-m.beCostUsd) : `${m.beStopped.length}×`} className={m.beThenTp.length ? 'text-rose-500' : ui.ink} />
          <Claim ui={ui}>{m.beMoved.length
            ? <>SL na BE nebo do zisku jsi posunul {m.beMoved.length}×, na BE tě to vyhodilo {m.beStopped.length}×{m.beStopped.length ? <> — v {m.beThenTp.length} z nich by původní plán došel do TP</> : null}.</>
            : 'Zatím žádný obchod s posunem SL na vstup.'}</Claim>
          <Meta ui={ui} onDrill={m.beMoved.length ? () => onDrill('Posun SL na BE', m.beMoved) : undefined}>z {m.withHistory} obchodů s historií SL</Meta>
        </div>
        <div className={ui.card}>
          <p className={eyebrow}>Ruční výstup vs. SL/TP</p>
          <Big value={m.manual.averageUsd == null ? '—' : usd(m.manual.averageUsd)} className={tone(m.manual.averageUsd) || ui.ink} />
          <Claim ui={ui}>{m.manual.decisions.length
            ? manualDelta != null
              ? <>Průměr ručně zavřeného obchodu. U {m.manual.covered.length} se svíčkami a plánem: skutečně {usd(m.manual.actualCoveredAverageUsd!)}, s původním SL/TP by to bylo <span className={tone(m.manual.heldAverageUsd)}>{usd(m.manual.heldAverageUsd!)}</span> na obchod.{m.manual.covered.length < 10 && <LowData />}</>
              : <>Průměr ručně zavřeného obchodu. Srovnání s SL/TP potřebuje svíčky a plánovaný SL i TP.</>
            : 'Zatím žádný ručně zavřený obchod.'}</Claim>
          <Meta ui={ui} onDrill={m.manual.decisions.length ? () => onDrill('Ruční výstupy', m.manual.decisions) : undefined}>z {m.manual.decisions.length} ručních výstupů · srovnání u {m.manual.covered.length}</Meta>
        </div>
        <div className={ui.card}>
          <p className={eyebrow}>Kam došla cena po výstupu</p>
          <Big value={median == null ? '—' : `${median >= 0 ? '+' : ''}${median.toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} b.`} className={ui.ink} />
          <Claim ui={ui}>{median == null ? 'Potřebuje svíčky po výstupu.' : <>Medián: do hodiny po tvém výstupu šla cena ještě {median.toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} bodu tvým směrem.</>}</Claim>
          <Meta ui={ui} onDrill={m.afterExit.decisions.length ? () => onDrill('Obchody se svíčkami po výstupu', m.afterExit.decisions) : undefined}>{coverage}</Meta>
        </div>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className={ui.card}>
          <p className={eyebrow}>Obchody bez SL</p>
          <Big value={usd(m.noStop.totalUsd)} className={tone(m.noStop.totalUsd) || ui.ink} />
          <Claim ui={ui}>{m.noStop.decisions.length
            ? <>{plural(m.noStop.decisions.length, 'obchod', 'obchody', 'obchodů')} bez SL po celou dobu.{m.noStop.avgLossUsd != null && m.noStop.avgLossWithStopUsd != null && <> Průměrná ztráta {usd(m.noStop.avgLossUsd)} proti {usd(m.noStop.avgLossWithStopUsd)} u obchodů se SL.</>}</>
            : 'Všechny obchody měly SL.'}
            {m.noStop.late.length > 0 && <span className={`mt-1 block text-xs font-semibold ${ui.muted}`}>Dalších {m.noStop.late.length}× SL až víc než 30 s po vstupu.</span>}</Claim>
          <Meta ui={ui} onDrill={m.noStop.decisions.length || m.noStop.late.length ? () => onDrill('Bez SL a pozdní SL', [...m.noStop.decisions, ...m.noStop.late]) : undefined}>z {m.withHistory} obchodů s historií SL · bez SL se R nepočítá</Meta>
        </div>
        <div className={ui.card}>
          <p className={eyebrow}>Vítězové: držet do plánovaného TP?</p>
          <Claim ui={ui}>{m.holdWinners.decisions.length
            ? <>U {plural(m.holdWinners.decisions.length, 'vítěze', 'vítězů', 'vítězů')} zavřených před TP: {m.holdWinners.reached}× by cena došla do TP (<span className="text-emerald-500">{usd(m.holdWinners.extraUsd)}</span> navíc), {m.holdWinners.reversed}× by se otočila do SL (<span className="text-rose-500">{usd(m.holdWinners.reversedUsd)}</span>). Čistě <span className={tone(m.holdWinners.extraUsd + m.holdWinners.reversedUsd)}>{usd(m.holdWinners.extraUsd + m.holdWinners.reversedUsd)}</span>.{m.holdWinners.decisions.length < 15 && <LowData />}</>
            : 'Potřebuje vítěze s plánovaným TP a svíčky po výstupu.'}</Claim>
          <Meta ui={ui} onDrill={m.holdWinners.decisions.length ? () => onDrill('Vítězové před TP', m.holdWinners.decisions) : undefined}>„první magnet vs. daleký level“ · původní SL/TP</Meta>
        </div>
      </div>
    </section>
  );
}

// ── D ────────────────────────────────────────────────────────────────────────

function UntakenSection({ items, candlesLoading, ui }: { items: LabUntakenItem[]; candlesLoading: boolean; ui: Ui }) {
  const u = useMemo(() => labUntaken(items), [items]);
  if (!items.length) {
    return (
      <section id="lab-d" className="scroll-mt-20">
        <SectionHead letter="D" title="Nevzaté obchody" sub="Zrušené vstupy se SL/TP." ui={ui} />
        <div className={ui.card}><p className={`text-xs ${ui.muted}`}>V tomto období žádný zrušený vstup se SL/TP.</p></div>
      </section>
    );
  }
  const judged = u.tp + u.sl + u.nofill;
  return (
    <section id="lab-d" className="scroll-mt-20">
      <SectionHead letter="D" title="Nevzaté obchody" sub="Zrušené vstupy se SL/TP — kdybys je nezrušil." ui={ui} />
      <div className="grid gap-3 lg:grid-cols-2">
        <div className={ui.card}>
          <p className={eyebrow}>Kdybys je nezrušil</p>
          <Claim ui={ui}>Rušením jsi přišel o <span className="text-rose-500">{usd(u.missed, false)}</span> ({u.tp}× by šel do TP) a ušetřil <span className="text-emerald-500">{usd(u.saved, false)}</span> ({u.sl}× do SL). {u.nofill ? `${u.nofill}× by se nevyplnil.` : ''}</Claim>
          {judged > 0 && <div className="mt-3 flex h-7 overflow-hidden rounded-lg text-[10.5px] font-extrabold text-white">
            {u.tp > 0 && <span className="grid place-items-center bg-rose-500" style={{ flex: u.tp }}>{u.tp} × TP</span>}
            {u.sl > 0 && <span className="grid place-items-center bg-emerald-500" style={{ flex: u.sl }}>{u.sl} × SL</span>}
            {u.nofill > 0 && <span className="grid place-items-center bg-amber-500" style={{ flex: u.nofill }}>{u.nofill} × nevyplnil</span>}
          </div>}
          <div className="mt-3 grid gap-2">
            {u.buckets.filter(b => b.items.length).map(b => (
              <div key={b.label} className="grid grid-cols-[84px_1fr_72px] items-center gap-2 text-xs">
                <span className={ui.muted}>stál {b.label}</span>
                <span className={`flex h-4 overflow-hidden rounded ${ui.isDark ? 'bg-white/5' : 'bg-slate-100'}`}>
                  <span className="bg-rose-500" style={{ flex: b.tp }} /><span className="bg-emerald-500" style={{ flex: b.sl }} /><span className="bg-amber-500" style={{ flex: b.nofill }} />
                  <span style={{ flex: Math.max(0, b.items.length - b.tp - b.sl - b.nofill) }} />
                </span>
                <b className={`text-right tabular-nums ${tone(b.netUsd)}`}>{usd(b.netUsd)}</b>
              </div>
            ))}
          </div>
          <Meta ui={ui}>z {plural(u.count, 'nevzatého', 'nevzatých', 'nevzatých')} · správně zrušené (SL / nevyplnil) {u.correct} z {judged}{candlesLoading && <span className="ml-1 text-indigo-500">· načítám svíčky</span>}</Meta>
        </div>
        <div className={ui.card}>
          <p className={eyebrow}>Sedí tvoje důvody?</p>
          {u.reasons.length ? <>
            <Claim ui={ui}>Jak často výsledek odpovídá důvodu, který jsi dal.</Claim>
            <div className="mt-3 grid gap-2">
              {u.reasons.map(row => (
                <div key={row.reason} className="grid grid-cols-[1fr_auto] items-center gap-2 text-xs">
                  <span className={ui.ink}>{row.reason} <span className="text-slate-400">{row.items.length}×</span></span>
                  <b className={`rounded-full px-2 py-0.5 text-[11px] ${row.judged ? row.hits / row.judged >= 0.6 ? 'bg-emerald-500/10 text-emerald-600' : 'bg-rose-500/10 text-rose-500' : 'bg-slate-500/10 text-slate-400'}`}>{row.judged ? `${row.hits} / ${row.judged}` : '—'}</b>
                </div>
              ))}
            </div>
          </> : <Claim ui={ui}>Zatím žádný nevzatý obchod s důvodem — ohodnoť je v Hodnotit.</Claim>}
          <Meta ui={ui}>{u.unreviewed ? `${u.unreviewed} bez důvodu (Hodnotit je bere od 1. 10.)` : 'všechny ohodnocené'} · nepočítá se do P&L ani statistik</Meta>
        </div>
      </div>
      <p className="mt-2 text-[10.5px] text-slate-400">Seznam nevzatých obchodů s grafem je v Hodnotit. {items.filter(i => labUntakenUsd(i) == null && i.outcome?.kind !== 'nofill').length > 0 && 'Část zatím bez výsledku (chybí svíčky).'}</p>
    </section>
  );
}

// ── E ────────────────────────────────────────────────────────────────────────

const WEEKDAY_SHORT = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

function TimeSection({ decisions, unit, ui, onDrill }: { decisions: LabDecision[]; unit: LabUnit; ui: Ui; onDrill: (title: string, list: LabDecision[]) => void }) {
  const t = useMemo(() => labTime(decisions, unit), [decisions, unit]);
  const ranked = t.byHour.filter(h => h.stats.covered >= 3 && h.stats.average != null);
  const best = [...ranked].sort((a, b) => b.stats.average! - a.stats.average!)[0];
  const worst = [...ranked].sort((a, b) => a.stats.average! - b.stats.average!)[0];
  const maxAbs = Math.max(1, ...t.heat.flatMap(row => row.cells.map(c => Math.abs(c.stats.average ?? 0))));
  const first = t.order[0], late = t.order[3];
  return (
    <section id="lab-e" className="scroll-mt-20">
      <SectionHead letter="E" title="Čas" sub="Kdy se ti daří a kdy ne (čas vstupu v Praze)." ui={ui} />
      <div className="grid gap-3 lg:grid-cols-[1.3fr_1fr]">
        <div className={ui.card}>
          <p className={eyebrow}>{unit === 'usd' ? '$' : 'R'} na obchod podle hodiny a dne</p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-separate border-spacing-[3px] text-[10px]">
              <thead><tr><th />{t.hours.map(h => <th key={h} className="font-bold text-slate-400">{h}h</th>)}</tr></thead>
              <tbody>{t.heat.map(row => (
                <tr key={row.weekday}><td className="pr-1 font-bold text-slate-400">{WEEKDAY_SHORT[row.weekday]}</td>
                  {row.cells.map((c, i) => {
                    const avg = c.stats.average, a = avg == null ? 0 : Math.min(1, Math.abs(avg) / maxAbs);
                    return <td key={i}>
                      <button type="button" disabled={!c.decisions.length} onClick={() => onDrill(`${WEEKDAY_SHORT[row.weekday]} ${t.hours[i]}:00`, c.decisions)}
                        title={c.decisions.length ? `${c.decisions.length}× · ${valueFmt(c.stats.total, unit)}` : ''}
                        className="grid h-7 w-full min-w-[34px] place-items-center rounded-md font-extrabold tabular-nums"
                        style={{ background: avg == null ? (ui.isDark ? 'rgba(255,255,255,.03)' : '#f8fafc') : avg >= 0 ? `rgba(16,185,129,${0.12 + a * 0.55})` : `rgba(244,63,94,${0.12 + a * 0.55})`, color: a > 0.6 ? '#fff' : ui.isDark ? '#cbd5e1' : '#334155' }}>
                        {avg == null ? '' : unit === 'usd' ? `${avg < 0 ? '−' : avg > 0 ? '+' : ''}${Math.abs(Math.round(avg))}` : avg.toLocaleString('cs-CZ', { maximumFractionDigits: 1 })}
                      </button></td>;
                  })}</tr>
              ))}</tbody>
            </table>
          </div>
          <Claim ui={ui}>{best && worst && best !== worst
            ? <>Nejlépe ti jde {best.hour}:00–{best.hour + 1}:00 (<span className={tone(best.stats.average)}>{valueFmt(best.stats.average!, unit)}</span> na obchod), nejhůř {worst.hour}:00–{worst.hour + 1}:00 (<span className={tone(worst.stats.average)}>{valueFmt(worst.stats.average!, unit)}</span>).</>
            : 'Na srovnání hodin je zatím málo obchodů (min. 3 v hodině).'}</Claim>
          <Meta ui={ui}>z {decisions.length} rozhodnutí · buňka = průměr na obchod, klik = obchody</Meta>
        </div>
        <div className={ui.card}>
          <p className={eyebrow}>Pořadí obchodu ve dni</p>
          <div className="mt-3 grid gap-2">
            {t.order.map(row => (
              <button key={row.label} type="button" disabled={!row.decisions.length} onClick={() => onDrill(`${row.label} obchod dne`, row.decisions)} className="grid grid-cols-[76px_1fr_auto] items-center gap-2 text-left text-xs">
                <span className={ui.muted}>{row.label} obchod</span>
                <span className="text-slate-400">{plural(row.decisions.length, 'obchod', 'obchody', 'obchodů')}{row.stats.winRate != null ? ` · WR ${Math.round(row.stats.winRate * 100)} %` : ''}</span>
                <b className={`tabular-nums ${tone(row.stats.average)}`}>{row.stats.average == null ? '—' : valueFmt(row.stats.average, unit)}</b>
              </button>
            ))}
          </div>
          <Claim ui={ui}>{first.stats.average != null && late.stats.average != null
            ? <>První obchod dne: <span className={tone(first.stats.average)}>{valueFmt(first.stats.average, unit)}</span> na obchod, 4. a další: <span className={tone(late.stats.average)}>{valueFmt(late.stats.average, unit)}</span>.</>
            : 'Průměr na obchod podle toho, kolikátý je ve dni.'}</Claim>
          <div className={`mt-3 border-t border-dashed pt-2.5 ${ui.line}`}>
            <p className={eyebrow}>Seance (newyorský čas)</p>
            <div className="mt-2 grid gap-1.5">
              {t.bySession.map(row => (
                <button key={row.session} type="button" onClick={() => onDrill(`Seance ${row.session}`, row.decisions)} className="grid grid-cols-[76px_1fr_auto] items-center gap-2 text-left text-xs">
                  <span className={row.session === 'NY open' ? 'font-extrabold text-indigo-500' : ui.muted}>{row.session}</span>
                  <span className="text-slate-400">{plural(row.decisions.length, 'obchod', 'obchody', 'obchodů')}</span>
                  <b className={`tabular-nums ${tone(row.stats.average)}`}>{row.stats.average == null ? '—' : valueFmt(row.stats.average, unit)}</b>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── F ────────────────────────────────────────────────────────────────────────

function SetupSection({ decisions, unit, ui, onDrill }: { decisions: LabDecision[]; unit: LabUnit; ui: Ui; onDrill: (title: string, list: LabDecision[]) => void }) {
  const f = useMemo(() => labSetups(decisions, unit), [decisions, unit]);
  return (
    <section id="lab-f" className="scroll-mt-20">
      <SectionHead letter="F" title="Setupy" sub="Které kombinace HTF/LTF fungují — z měření, ne z učebnice." ui={ui} />
      {f.tags.length === 0 && f.combos.length === 0 ? (
        <div className={`${ui.card} border-dashed text-center`}>
          <p className={eyebrow}>Zatím málo dat</p>
          <Claim ui={ui}>Štítky HTF/LTF má {plural(f.tagged, 'ohodnocený obchod', 'ohodnocené obchody', 'ohodnocených obchodů')}. Jednotlivý štítek se ukáže od {LAB_TAG_MIN} obchodů, kombinace od {LAB_SETUP_MIN}.</Claim>
          <div className={`mx-auto mt-3 h-2 max-w-[320px] overflow-hidden rounded ${ui.isDark ? 'bg-white/5' : 'bg-slate-100'}`}><span className="block h-full bg-indigo-500" style={{ width: `${Math.min(100, f.largestCombo / LAB_SETUP_MIN * 100)}%` }} /></div>
          <p className="mt-1 text-[11px] text-slate-500">nejčastější kombinace {f.largestCombo} / {LAB_SETUP_MIN}</p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className={ui.card}>
            <p className={eyebrow}>Štítky (od {LAB_TAG_MIN} obchodů)</p>
            <div className="mt-3 grid gap-2">
              {f.tags.map(row => (
                <button key={`${row.kind}:${row.tag}`} type="button" onClick={() => onDrill(`${row.kind} ${row.tag}`, row.decisions)} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 text-left text-xs">
                  <span className={ui.ink}><span className="mr-1 text-[9.5px] font-black text-slate-400">{row.kind}</span>{row.tag}</span>
                  <span className="text-slate-400">{row.decisions.length}× · WR {row.stats.winRate == null ? '—' : `${Math.round(row.stats.winRate * 100)} %`}</span>
                  <b className={`tabular-nums ${tone(row.stats.average)}`}>{row.stats.average == null ? '—' : valueFmt(row.stats.average, unit)}</b>
                </button>
              ))}
            </div>
            <Meta ui={ui}>průměr na obchod · jen ohodnocené obchody se štítky</Meta>
          </div>
          <div className={ui.card}>
            <p className={eyebrow}>Kombinace (od {LAB_SETUP_MIN} obchodů)</p>
            {f.combos.length ? f.combos.map(row => (
              <button key={row.combo} type="button" onClick={() => onDrill(row.combo, row.decisions)} className="mt-2 grid w-full grid-cols-[1fr_auto] gap-3 text-left text-xs">
                <span className={ui.ink}>{row.combo} <span className="text-slate-400">{row.decisions.length}×</span></span>
                <b className={`tabular-nums ${tone(row.stats.average)}`}>{row.stats.average == null ? '—' : valueFmt(row.stats.average, unit)}</b>
              </button>
            )) : <Claim ui={ui}>Žádná kombinace zatím nemá {LAB_SETUP_MIN} obchodů (nejčastější {f.largestCombo}).</Claim>}
          </div>
        </div>
      )}
    </section>
  );
}

// ── Rozkliknutí ──────────────────────────────────────────────────────────────

function Drawer({ title, decisions, unit, ui, onClose, onOpen }: { title: string; decisions: LabDecision[]; unit: LabUnit; ui: Ui; onClose: () => void; onOpen: (decision: LabDecision) => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const sorted = [...decisions].sort((a, b) => b.entryAt - a.entryAt);
  return (
    <>
      <div className="fixed inset-0 z-[100] bg-slate-900/20" onClick={onClose} />
      <aside className={`native-page-scroll-content fixed inset-y-0 right-0 z-[101] flex w-full max-w-[420px] flex-col border-l shadow-2xl ${ui.line} ${ui.isDark ? 'bg-[#0b1017]' : 'bg-white'}`}>
        <header className={`flex items-center gap-2 border-b px-4 py-3.5 ${ui.line}`}>
          <h3 className={`flex-1 text-sm font-black ${ui.ink}`}>{title} <span className="font-bold text-slate-400">({decisions.length})</span></h3>
          <button type="button" onClick={onClose} aria-label="Zavřít" className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-500/10"><X size={15} /></button>
        </header>
        <div className="flex-1 overflow-y-auto p-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {sorted.map(decision => {
            const value = unit === 'usd' ? decision.pnlUsd : decision.r;
            return (
              <button key={decision.id} type="button" onClick={() => onOpen(decision)} className="grid w-full grid-cols-[56px_1fr_auto] items-center gap-2.5 rounded-xl px-2 py-2.5 text-left hover:bg-slate-500/5">
                <span className="text-[10.5px] leading-tight text-slate-500"><b className={`block text-[11.5px] ${ui.ink}`}>{dayLabel(decision.dayKey)}</b>{clock(decision.entryAt)}</span>
                <span className="min-w-0 text-xs font-bold">
                  <span className={decision.direction === 'Long' ? 'text-emerald-500' : 'text-rose-500'}>{decision.direction}</span> <span className={ui.ink}>{decision.instrument} · {decision.size} ks</span>
                  <span className="mt-0.5 block truncate text-[10.5px] font-medium text-slate-500">
                    {decision.exitKind === 'sl' ? 'SL' : decision.exitKind === 'tp' ? 'TP' : 'ruční výstup'}
                    {decision.plan === 'no' ? ` · mimo plán${decision.invalidReasons.length ? ` · ${decision.invalidReasons.join(', ')}` : ''}` : decision.plan === 'yes' ? ' · podle plánu' : ' · neohodnocený'}
                    {decision.accountIds.length > 1 ? ` · ${decision.accountIds.length} účty` : ''}
                  </span>
                </span>
                <span className={`text-right font-mono text-[12.5px] font-bold ${tone(value)}`}>{value == null ? '— R' : valueFmt(value, unit)}<span className="block text-[10px] font-semibold text-slate-400">detail ›</span></span>
              </button>
            );
          })}
        </div>
      </aside>
    </>
  );
}
