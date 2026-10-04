import React, { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Loader2, X } from 'lucide-react';
import type { Account, Trade } from '../types';
import type { TradeExecutionHistory } from '../lib/tradeExecutionHistory';
import { buildLabDecisions, labMissingHistoryIds, type LabDecision } from '../lib/labDataset';
import {
  LAB_DEFAULT_RULES, LAB_NO_REASON, labDays, labInvalidReasons, labPlanComparison, labSimulateRule,
  type LabDay, type LabRuleResult, type LabStats, type LabUnit,
} from '../lib/labAnalysis';
import { storageService } from '../services/storageService';

/**
 * Nový Lab (živý režim): jedna stránka, sekce podle otázek, každá karta =
 * tvrzení · číslo · „z N obchodů“ · rozkliknutí na obchody. Jednotka je
 * rozhodnutí (kopie se nesčítají), peníze jsou $ na leaderovi, R jen se SL.
 * Čísla počítá `lib/labAnalysis.ts`.
 */
type Period = 7 | 30 | 0;

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
        {[['a', 'A · Plán vs. mimo plán'], ['b', 'B · Disciplína dne']].map(([id, label]) => (
          <a key={id} href={`#lab-${id}`} className={`rounded-full border px-3 py-1.5 text-[11.5px] font-extrabold ${line} ${isDark ? 'bg-white/[0.03] text-slate-200' : 'bg-white text-slate-700'}`}>{label}</a>
        ))}
        {['C · Řízení obchodu', 'D · Nevzaté', 'E · Čas', 'F · Setupy', 'G · Účty'].map(label => (
          <span key={label} className={`rounded-full border border-dashed px-3 py-1.5 text-[11.5px] font-bold ${line} text-slate-400`} title="Připravujeme">{label}</span>
        ))}
      </nav>

      <PlanSection decisions={decisions} unit={unit} ui={ui} onDrill={(title, list) => setDrawer({ title, decisions: list })} />
      <DisciplineSection decisions={decisions} ui={ui} onDrill={(title, list) => setDrawer({ title, decisions: list })} />

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
