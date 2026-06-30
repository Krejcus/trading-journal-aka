import React from 'react';
import {
  LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import type { Trade, DailyPrep, DailyReview } from '../types';
import type { ChartSpec } from '../services/aiService';

// ─── Constants ────────────────────────────────────────────────────────────────

const COLORS = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#f43f5e', '#06b6d4', '#f97316'];

const WEEKDAY_NAMES: Record<number, string> = {
  1: 'Pondělí', 2: 'Úterý', 3: 'Středa', 4: 'Čtvrtek',
  5: 'Pátek', 6: 'Sobota', 0: 'Neděle',
};

const METRIC_FORMATTER: Record<string, (v: number) => string> = {
  cumPnl:   v => `$${v}`,
  pnl:      v => `$${v}`,
  winrate:  v => `${v}%`,
  count:    v => `${v}`,
  avgPnl:   v => `$${v}`,
  // R-multiple metriky — používají risk amount per trade
  cumR:     v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`,
  r:        v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`,
  avgR:     v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDimensionKey(
  trade: Trade,
  dim: string,
  prepDates: Set<string>,
  reviewDates: Set<string>,
): string | null {
  switch (dim) {
    case 'session':    return trade.session ? String(trade.session).trim() : null;
    case 'signal':     return trade.signal ? String(trade.signal).trim() : null;
    // Normalize direction case ("LONG" / "Long" / "long" → "Long"), aby se nevytvářely duplicitní skupiny
    case 'direction': {
      if (!trade.direction) return null;
      const s = String(trade.direction).trim().toLowerCase();
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    case 'instrument': return trade.instrument ? String(trade.instrument).trim() : null;
    case 'weekday': {
      if (!trade.date) return null;
      // Den v týdnu počítáme z YYYY-MM-DD části v lokální poledne, ať se shoduje se
      // zbytkem appky (slice(0,10)). `new Date(trade.date).getDay()` u půlnočních
      // UTC timestampů spadne do jiného dne podle TZ → nekonzistentní statistiky.
      const dayKey = trade.date.slice(0, 10);
      return WEEKDAY_NAMES[new Date(dayKey + 'T12:00:00').getDay()] ?? null;
    }
    case 'violations':
      return (trade.mistakes?.length ?? 0) > 0 ? 'S chybami' : 'Čistě';
    case 'hasPrep':
      return prepDates.has(trade.date?.slice(0, 10) ?? '') ? 'S přípravou' : 'Bez přípravy';
    case 'hasReview':
      return reviewDates.has(trade.date?.slice(0, 10) ?? '') ? 'S auditem' : 'Bez auditu';
    default: return null;
  }
}

function matchesSingleFilter(t: Trade, filter: NonNullable<ChartSpec['filter']>): boolean {
  const val = (t as any)[filter.field];
  switch (filter.op) {
    case 'eq': return String(val) === String(filter.value);
    case 'neq': return String(val) !== String(filter.value);
    case 'gt': return Number(val) > Number(filter.value);
    case 'lt': return Number(val) < Number(filter.value);
    case 'gte': return Number(val) >= Number(filter.value);
    case 'lte': return Number(val) <= Number(filter.value);
    case 'in': {
      const arr = Array.isArray(filter.value) ? filter.value : [filter.value];
      const valStr = String(val);
      return arr.some(v => String(v) === valStr);
    }
    case 'contains': {
      // String substring nebo array.includes
      if (Array.isArray(val)) return val.some(v => String(v) === String(filter.value));
      return String(val ?? '').toLowerCase().includes(String(filter.value).toLowerCase());
    }
    default: return true;
  }
}

/**
 * Aplikuje VŠECHNY filter mechanismy na trades:
 * - `filter` (single, zpětná kompatibilita)
 * - `filters` (array, AND)
 * - `tradeIds` (whitelist konkrétních ID)
 * - `dateFrom` / `dateTo` (date range na trade.date)
 */
function applyFilter(trades: Trade[], spec: ChartSpec): Trade[] {
  let result = trades;

  // tradeIds — nejvyšší priorita, často nejvíc selektivní
  if (spec.tradeIds && spec.tradeIds.length > 0) {
    const idSet = new Set(spec.tradeIds.map(String));
    result = result.filter(t => idSet.has(String(t.id)));
  }

  // Date range — porovnává trade.date (ISO) proti dateFrom/dateTo
  if (spec.dateFrom || spec.dateTo) {
    const from = spec.dateFrom ? new Date(spec.dateFrom).getTime() : -Infinity;
    // dateTo je inclusive → použijeme konec dne pokud je to jen YYYY-MM-DD
    const toRaw = spec.dateTo;
    const to = toRaw
      ? (toRaw.length === 10 ? new Date(toRaw + 'T23:59:59.999Z').getTime() : new Date(toRaw).getTime())
      : Infinity;
    result = result.filter(t => {
      const ts = t.timestamp || (t.date ? new Date(t.date).getTime() : 0);
      return ts >= from && ts <= to;
    });
  }

  // Single filter (backward compat)
  if (spec.filter) {
    result = result.filter(t => matchesSingleFilter(t, spec.filter!));
  }

  // Multi filter (AND)
  if (spec.filters && spec.filters.length > 0) {
    result = result.filter(t => spec.filters!.every(f => matchesSingleFilter(t, f)));
  }

  return result;
}

/** Spočítá R pro jeden trade (pnl / riskAmount). Vrací null pokud riskAmount není > 0. */
function tradeR(t: Trade): number | null {
  if (!t.riskAmount || t.riskAmount <= 0) return null;
  return t.pnl / t.riskAmount;
}

function computeMetric(grpTrades: Trade[], metric: string): number {
  if (grpTrades.length === 0) return 0;
  switch (metric) {
    case 'pnl':
    case 'cumPnl':
      return parseFloat(grpTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2));
    case 'winrate':
      return Math.round(grpTrades.filter(t => t.pnl > 0).length / grpTrades.length * 100);
    case 'count':
      return grpTrades.length;
    case 'avgPnl':
      return parseFloat((grpTrades.reduce((s, t) => s + t.pnl, 0) / grpTrades.length).toFixed(2));
    // R-multiple metriky — počítají s pnl/riskAmount per trade
    case 'r':
    case 'cumR': {
      const total = grpTrades.reduce((s, t) => s + (tradeR(t) ?? 0), 0);
      return parseFloat(total.toFixed(2));
    }
    case 'avgR': {
      const valid = grpTrades.map(tradeR).filter((x): x is number => x !== null);
      if (valid.length === 0) return 0;
      const avg = valid.reduce((s, v) => s + v, 0) / valid.length;
      return parseFloat(avg.toFixed(2));
    }
    default: return 0;
  }
}

/**
 * Aplikuje skupinové filtry — vrátí trades, které spadají do dané ChartGroup.
 * Priorita: tradeIds (whitelist) → tradeIdsExclude (blacklist) → filters (AND)
 */
function tradesInGroup(trades: Trade[], group: { tradeIds?: Array<string | number>; tradeIdsExclude?: Array<string | number>; filters?: ChartSpec['filters'] }): Trade[] {
  let result = trades;
  if (group.tradeIds && group.tradeIds.length > 0) {
    const inSet = new Set(group.tradeIds.map(String));
    result = result.filter(t => inSet.has(String(t.id)));
  }
  if (group.tradeIdsExclude && group.tradeIdsExclude.length > 0) {
    const outSet = new Set(group.tradeIdsExclude.map(String));
    result = result.filter(t => !outSet.has(String(t.id)));
  }
  if (group.filters && group.filters.length > 0) {
    result = result.filter(t => group.filters!.every(f => matchesSingleFilter(t, f)));
  }
  return result;
}

function buildGroupMap(
  trades: Trade[],
  dim: string,
  prepDates: Set<string>,
  reviewDates: Set<string>,
): Map<string, Trade[]> {
  if (dim === 'one_per_day') {
    const sorted = [...trades].sort((a, b) =>
      new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    const seenDays = new Set<string>();
    const firstPerDay: Trade[] = [];
    for (const t of sorted) {
      const day = t.date?.slice(0, 10) ?? '';
      if (!seenDays.has(day)) { seenDays.add(day); firstPerDay.push(t); }
    }
    return new Map([['Všechny obchody', sorted], ['Max 1/den', firstPerDay]]);
  }

  const map = new Map<string, Trade[]>();
  const nullTrades: Trade[] = [];
  for (const trade of trades) {
    const key = getDimensionKey(trade, dim, prepDates, reviewDates);
    if (key === null) { nullTrades.push(trade); continue; }
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(trade);
  }
  // "Ostatní" jen pro dimenze kde null znamená chybějící data
  const noOthers = new Set(['violations', 'hasPrep', 'hasReview', 'direction', 'one_per_day']);
  if (nullTrades.length >= 3 && !noOthers.has(dim)) {
    map.set('Ostatní', nullTrades);
  }
  return map;
}

// ─── DynamicChart ─────────────────────────────────────────────────────────────

interface Props {
  spec: ChartSpec;
  trades: Trade[];
  dailyPreps?: DailyPrep[];
  dailyReviews?: DailyReview[];
}

export const DynamicChart: React.FC<Props> = ({
  spec, trades, dailyPreps = [], dailyReviews = [],
}) => {
  const prepDates   = React.useMemo(() => new Set(dailyPreps.map(p => p.date?.slice(0, 10) ?? '')),   [dailyPreps]);
  const reviewDates = React.useMemo(() => new Set(dailyReviews.map(r => r.date?.slice(0, 10) ?? '')), [dailyReviews]);

  const filtered  = React.useMemo(() => applyFilter(trades, spec), [trades, spec]);

  // Pokud má spec definované `groups`, každá skupina = jedna line/sloupec.
  // Jinak grupujeme podle dimenze `spec.x` (původní chování).
  const groupMap = React.useMemo(() => {
    if (spec.groups && spec.groups.length > 0) {
      const m = new Map<string, Trade[]>();
      for (const g of spec.groups) {
        m.set(g.name, tradesInGroup(filtered, g));
      }
      return m;
    }
    return buildGroupMap(filtered, spec.x, prepDates, reviewDates);
  }, [filtered, spec.x, spec.groups, prepDates, reviewDates]);
  const groupNames = Array.from(groupMap.keys());

  const title = spec.title ?? `${spec.y} / ${spec.x}`;
  const fmt   = METRIC_FORMATTER[spec.y] ?? (v => `${v}`);

  if (groupNames.length === 0) {
    return (
      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 my-2 flex items-center justify-center h-[180px]">
        <span className="text-xs text-[var(--text-secondary)]">Žádná data pro tento graf</span>
      </div>
    );
  }

  // ── BAR CHART ──────────────────────────────────────────────────────────────
  if (spec.type === 'bar') {
    // Najdi color override z spec.groups (pokud existuje)
    const colorByName = new Map<string, string>();
    if (spec.groups) {
      for (const g of spec.groups) if (g.color) colorByName.set(g.name, g.color);
    }
    let barData = groupNames.map((name, idx) => ({
      name,
      value: computeMetric(groupMap.get(name)!, spec.y),
      count: groupMap.get(name)!.length,
      color: colorByName.get(name) || COLORS[idx % COLORS.length],
    }));
    if (spec.sort === 'desc') barData = [...barData].sort((a, b) => b.value - a.value);
    if (spec.sort === 'asc')  barData = [...barData].sort((a, b) => a.value - b.value);

    return (
      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 my-2">
        <div className="text-[10px] font-black uppercase tracking-widest text-[var(--text-secondary)] mb-3">
          {title}
        </div>
        <div style={{ height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={barData} margin={{ top: 4, right: 4, bottom: barData.length > 4 ? 30 : 20, left: 0 }}>
              <XAxis
                dataKey="name"
                tick={{ fontSize: 9, fill: 'var(--text-secondary)' }}
                axisLine={false}
                tickLine={false}
                interval={0}
                angle={barData.length > 4 ? -30 : 0}
                textAnchor={barData.length > 4 ? 'end' : 'middle'}
              />
              <YAxis
                width={55}
                tickFormatter={fmt}
                tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                formatter={(value: number, _name: string, props: any) => [fmt(value), props.payload.name]}
                contentStyle={{
                  backgroundColor: 'var(--bg-card)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '8px',
                  fontSize: '11px',
                }}
                labelStyle={{ display: 'none' }}
              />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {barData.map((entry, idx) => (
                  <Cell key={idx} fill={entry.value >= 0 ? entry.color : '#f43f5e'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {barData.map(s => (
            <div key={s.name} className="flex items-center gap-1.5 px-2 py-1 rounded-xl border border-[var(--border-subtle)] text-[9px]">
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
              <span className="font-bold text-[var(--text-primary)]">{s.name}</span>
              <span className={`font-mono font-black ${s.value >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{fmt(s.value)}</span>
              <span className="text-[var(--text-secondary)]">{s.count} obch.</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── LINE CHART (equity curves — date-synchronized timeline) ──────────────
  // Sesbíráme všechna unikátní data ze všech skupin a seřadíme je chronologicky.
  // Každá skupina postupuje po téže časové ose — kdyz nemá obchod v daný den,
  // "nese" poslední hodnotu dopředu (flat line). Výsledek: obě křivky jsou
  // synchronizované a lze porovnat výkon ve stejném časovém období.

  const allDates = Array.from(new Set(
    [...groupMap.values()].flatMap(ts =>
      ts.map(t => t.date?.slice(0, 10) ?? '').filter(Boolean),
    ),
  )).sort();

  // Pro každou skupinu: datum → kumulativní hodnota po všech obchodech toho dne.
  // Volba metriky podle spec.y: 'cumPnl' = USD, 'cumR' = R-multiple, atd.
  // Pro line chart dává smysl jen kumulativní metriky.
  const useR = spec.y === 'cumR' || spec.y === 'r' || spec.y === 'avgR';
  const groupDatePnl = new Map<string, Map<string, number>>();
  for (const [name, groupTrades] of groupMap.entries()) {
    const sorted = [...groupTrades].sort((a, b) =>
      new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    let running = 0;
    const datePnl = new Map<string, number>();
    for (const t of sorted) {
      const delta = useR ? (tradeR(t) ?? 0) : t.pnl;
      running += delta;
      datePnl.set(t.date?.slice(0, 10) ?? '', parseFloat(running.toFixed(2)));
    }
    groupDatePnl.set(name, datePnl);
  }

  // Sestavíme chartData — pro každé datum neseme hodnotu dopředu (carry-forward)
  const chartData: Record<string, any>[] = [];
  const lastValues = new Map<string, number>(groupNames.map(n => [n, 0]));
  for (const date of allDates) {
    const row: Record<string, any> = { date };
    for (const name of groupNames) {
      const dp = groupDatePnl.get(name)!;
      if (dp.has(date)) lastValues.set(name, dp.get(date)!);
      row[name] = lastValues.get(name)!;
    }
    chartData.push(row);
  }

  // Finální statistiky skupin
  const lineStats = groupNames.map(name => {
    const grpTrades = groupMap.get(name)!;
    const finalPnl  = lastValues.get(name) ?? 0;
    const wins      = grpTrades.filter(t => t.pnl > 0).length;
    const winRate   = grpTrades.length > 0 ? Math.round(wins / grpTrades.length * 100) : 0;
    return { name, finalPnl, count: grpTrades.length, winRate };
  });

  // Inteligentní interval pro popisky osy X — max ~6 labelů
  const xInterval = Math.max(0, Math.floor(allDates.length / 6) - 1);
  const fmtDate = (d: string) => {
    const dt = new Date(d);
    return `${dt.getDate()}.${dt.getMonth() + 1}.`;
  };

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 my-2">
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--text-secondary)] mb-3">
        {title}
      </div>
      <div style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 20, left: 0 }}>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 9, fill: 'var(--text-secondary)' }}
              axisLine={false}
              tickLine={false}
              interval={xInterval}
              tickFormatter={fmtDate}
            />
            <YAxis
              width={55}
              tickFormatter={fmt}
              tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(value: number) => [fmt(value), '']}
              labelFormatter={(label: string) => fmtDate(label)}
              contentStyle={{
                backgroundColor: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                fontSize: '11px',
              }}
              labelStyle={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '4px' }}
            />
            <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '8px' }} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" />
            {groupNames.map((name, idx) => {
              const overrideColor = spec.groups?.find(g => g.name === name)?.color;
              return (
                <Line
                  key={name}
                  type="monotone"
                  dataKey={name}
                  stroke={overrideColor || COLORS[idx % COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {lineStats.map((s, idx) => {
          const isPos = s.finalPnl >= 0;
          const overrideColor = spec.groups?.find(g => g.name === s.name)?.color;
          return (
            <div key={s.name} className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[10px]">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: overrideColor || COLORS[idx % COLORS.length] }} />
              <span className="font-bold text-[var(--text-primary)]">{s.name}</span>
              <span className={`font-mono font-black ${isPos ? 'text-emerald-500' : 'text-rose-500'}`}>
                {useR ? `${isPos ? '+' : ''}${s.finalPnl.toFixed(2)}R` : `${isPos ? '+' : ''}$${s.finalPnl.toFixed(0)}`}
              </span>
              <span className="text-[var(--text-secondary)]">{s.count} obchodů</span>
              <span className="text-[var(--text-secondary)]">{s.winRate}% WR</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default DynamicChart;
