import React, { useMemo, useState } from 'react';
import type { Trade } from '../types';
import { computeBacktestRobustness, type BacktestBootstrapOptions, type BacktestRobustnessInterval,
  type BacktestRobustnessOptions, type BacktestRobustnessScenario } from '../services/backtestRobustness';

export interface BacktestRobustnessPanelProps {
  trades: readonly Trade[];
  options: BacktestRobustnessOptions;
  isDark: boolean;
}
const labels = { netPnl: 'Čistý P&L', expectancy: 'Expectancy / pozice', profitFactor: 'Profit factor pozic', maxDrawdown: 'Max. drawdown' };
const exclusionLabels = {
  'missing-run': 'Chybí replay session', 'missing-identity': 'Chybí doložená identita pozice', 'ambiguous-identity': 'Nejednoznačná identita pozice',
  'duplicate-trade': 'Duplicitní řádek obchodu', 'invalid-value': 'Neplatná hodnota P&L nebo času', 'unknown-currency': 'Neznámá měna',
  'open-position': 'Uzavření celé pozice není potvrzené', 'incomplete-position-selection': 'Filtr vynechal část výstupů pozice', 'invalid-position-member': 'Jiný výstup pozice má neplatná data',
};
export default function BacktestRobustnessPanel({ trades, options, isDark }: BacktestRobustnessPanelProps) {
  const [unit, setUnit] = useState<BacktestBootstrapOptions['unit']>('day');
  const [length, setLength] = useState('2');
  const [seed, setSeed] = useState('42');
  const [repetitions, setRepetitions] = useState('1000');
  const [applied, setApplied] = useState<BacktestBootstrapOptions>();
  const result = useMemo(() => {
    try { return { report: computeBacktestRobustness(trades, { ...options, bootstrap: applied ?? options.bootstrap }), error: null }; }
    catch (error) { return { report: null, error: error instanceof Error ? error.message : 'Výpočet není dostupný.' }; }
  }, [trades, options, applied]);
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const border = isDark ? 'border-white/10' : 'border-slate-200';
  const inputClass = `rounded-lg border px-3 py-2 text-sm ${isDark ? 'border-white/10 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-900'}`;
  const report = result.report;
  const money = (value: number | null) => value === null ? '—' : `${value.toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} ${report?.currency ?? ''}`;
  const factor = (value: number | null, state: string) => state === 'no-losses' ? '∞ (bez ztráty)' : value === null ? '—' : value.toFixed(2);
  const scenarioName = (scenario: BacktestRobustnessScenario) => scenario.kind === 'baseline' ? 'Baseline — celý způsobilý vzorek'
    : `Bez top ${scenario.requestedRemoveN} ${scenario.kind === 'days' ? 'ziskových dní' : 'ziskových pozic'}`;
  const formatInterval = (interval: BacktestRobustnessInterval, isFactor: boolean) => {
    if (!interval.validReplicates) return 'Nelze odhadnout';
    const value = (v: number | null, unbounded: boolean) => unbounded ? '∞' : isFactor ? v?.toFixed(2) ?? '—' : money(v);
    return `${value(interval.low, interval.lowUnbounded)} až ${value(interval.high, interval.highUnbounded)}`;
  };
  const validSettings = Number.isInteger(Number(length)) && Number(length) >= 1 && Number.isInteger(Number(repetitions)) && Number(repetitions) >= 100
    && Number(repetitions) <= 5000 && seed.trim() !== '' && Number.isInteger(Number(seed)) && Number(seed) >= 0 && Number(seed) <= 0xFFFFFFFF;
  const bootstrap = report?.bootstrap;
  return <section className={`space-y-5 ${isDark ? 'text-slate-100' : 'text-slate-900'}`} aria-label="Odolnost výsledku backtestu">
    <div><h2 className="text-lg font-semibold">Odolnost výsledku</h2>
      <p className={`mt-1 text-sm ${muted}`}>Citlivost na největší zisky a nejistota odhadu. Původní obchody i baseline zůstávají zachované.</p></div>
    {result.error && <p role="alert" className="text-sm text-amber-500">{result.error}</p>}
    {report && <>
      <p className={`text-sm ${muted}`}>{report.inputN} vstupních výstupů · {report.eligibleTradeN} použitelných výstupů v {report.positions.length} pozicích · {report.excludedN} vyřazených.
        {' '}Obchodní den: {report.timeZone}, hranice {String(Math.floor(report.dayStartMinute / 60)).padStart(2, '0')}:{String(report.dayStartMinute % 60).padStart(2, '0')} místního času.</p>
      {report.exclusions.length > 0 && <details className={`rounded-xl border p-3 ${border}`}><summary className="cursor-pointer text-sm font-medium">Vyřazené záznamy a důvody ({report.excludedN})</summary>
        <ul className={`mt-2 max-h-52 space-y-1 overflow-auto text-xs ${muted}`}>{report.exclusions.map((item, index) => <li key={`${item.accountId}:${item.tradeId}:${index}`}>
          {item.tradeId} · účet {item.accountId} · {exclusionLabels[item.reason]}</li>)}</ul></details>}
      {report.status === 'mixed-currency' && <p role="status" className="text-sm text-amber-500">Vzorek míchá měny {report.currencies.join(', ')}. Vyber účty se stejnou měnou; peněžní výsledky se nesčítají bez převodu.</p>}
      {report.status === 'empty' && <p role="status" className={`text-sm ${muted}`}>Chybí úplné uzavřené pozice s doloženou identitou, měnou a všemi výstupy ve vybraném filtru.</p>}
      {report.baseline && <div className={`overflow-x-auto rounded-xl border ${border}`}><table className="w-full min-w-[760px] text-left text-sm">
        <caption className={`px-4 py-3 text-left text-xs ${muted}`}>Zisk a PF po celých pozicích; DD po realizovaných výstupech. Odstraňují se pouze kladné pozice nebo dny, vždy samostatně vůči baseline.</caption>
        <thead className={muted}><tr>{['Varianta', 'Vyřazeno / zbývá pozic', 'Čistý P&L', 'Expectancy', 'PF', 'DD'].map(label => <th key={label} className="px-4 py-2 font-medium">{label}</th>)}</tr></thead>
        <tbody>{[report.baseline, ...report.scenarios].map(scenario => <tr key={scenario.id} className={`border-t ${border}`}>
          <td className="px-4 py-3"><span className={scenario.kind === 'baseline' ? 'font-semibold' : ''}>{scenarioName(scenario)}</span>
            {scenario.kind !== 'baseline' && <details className={`mt-1 text-xs ${muted}`}><summary className="cursor-pointer">Přesný výběr ({scenario.removedUnitIds.length} {scenario.kind === 'days' ? 'dní' : 'pozic'})</summary>
              <p className="mt-1 break-all">Jednotky: {scenario.removedUnitIds.join(', ') || 'žádné'}</p>
              <p className="mt-1 break-all">Výstupy: {scenario.removedTradeIds.join(', ') || 'žádné'}</p></details>}</td>
          <td className="px-4 py-3">{scenario.removedN} / {scenario.retainedN}</td><td className="px-4 py-3 whitespace-nowrap">{money(scenario.netPnl)}</td>
          <td className="px-4 py-3 whitespace-nowrap">{money(scenario.expectancy)}</td><td className="px-4 py-3">{factor(scenario.profitFactor, scenario.profitFactorState)}</td>
          <td className="px-4 py-3 whitespace-nowrap">{money(scenario.maxDrawdown)}</td>
        </tr>)}</tbody></table></div>}
      {report.status === 'ready' && <div className={`space-y-3 rounded-xl border p-4 ${border}`}>
        <h3 className="font-medium">Blokový bootstrap</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className={`grid gap-1 text-xs ${muted}`}>Jednotka<select className={inputClass} value={unit} onChange={event => setUnit(event.target.value as BacktestBootstrapOptions['unit'])}>
            <option value="day">Obchodní den</option><option value="position">Celá pozice</option></select></label>
          <label className={`grid gap-1 text-xs ${muted}`}>Délka bloku<input className={`${inputClass} w-28`} type="number" min={1} step={1} value={length} onChange={event => setLength(event.target.value)} /></label>
          <label className={`grid gap-1 text-xs ${muted}`}>Opakování<input className={`${inputClass} w-32`} type="number" min={100} max={5000} step={100} value={repetitions} onChange={event => setRepetitions(event.target.value)} /></label>
          <label className={`grid gap-1 text-xs ${muted}`}>Seed<input className={`${inputClass} w-32`} type="number" min={0} max={0xFFFFFFFF} step={1} value={seed} onChange={event => setSeed(event.target.value)} /></label>
          <button type="button" disabled={!validSettings} onClick={() => setApplied({ unit, blockLength: Number(length), repetitions: Number(repetitions), seed: Number(seed), confidenceLevel: 0.95 })}
            className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">Spočítat intervaly</button>
        </div>
        {bootstrap && <p className={`text-xs ${muted}`}>Použitý běh: {bootstrap.unitN} {bootstrap.unit === 'day' ? 'dní' : 'pozic'} · délka bloku {bootstrap.blockLength} · {bootstrap.sourceBlockN} možných začátků bloků
          {' '}· {bootstrap.drawnBlocksPerReplication} tahů bloků na opakování · {bootstrap.repetitions} opakování · seed {bootstrap.seed}.
          {' '}Nejde o počet nezávislých vzorků.</p>}
        {bootstrap?.reason && <p role="status" className="text-sm text-amber-500">{bootstrap.reason}</p>}
        {bootstrap?.intervals && <>
          <p className={`text-xs ${muted}`}>{Math.round(bootstrap.confidenceLevel * 100)}% percentilové intervaly. DD bootstrapu měřený po {bootstrap.unit === 'day' ? 'dnech' : 'celých pozicích'};
            {' '}pozic v jednom opakování {bootstrap.sampledPositionN?.min}–{bootstrap.sampledPositionN?.max}.</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{(Object.keys(labels) as Array<keyof typeof labels>).map(key => <div key={key} className={`rounded-lg border p-3 ${border}`}>
            <p className={`text-xs ${muted}`}>{labels[key]}</p><p className="mt-1 text-sm font-semibold">{formatInterval(bootstrap.intervals![key], key === 'profitFactor')}</p>
            {bootstrap.intervals![key].undefinedReplicates > 0 && <p className={`mt-1 text-xs ${muted}`}>Neurčitelné v {bootstrap.intervals![key].undefinedReplicates} opakováních.</p>}
          </div>)}</div>
        </>}
      </div>}
      <details className={`rounded-xl border p-3 ${border}`}><summary className="cursor-pointer text-sm font-medium">Metodika a omezení</summary>
        <ul className={`mt-2 list-disc space-y-2 pl-4 text-xs ${muted}`}>{report.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
        <p className={`mt-3 text-xs ${muted}`}>Metoda: <a className="underline" href="https://bashtage.github.io/arch/bootstrap/timeseries-bootstraps.html" target="_blank" rel="noreferrer">kruhový blokový bootstrap</a>.
          {' '}Citlivost bez nejlepších zisků není důvod mazat výherní obchody z historie.</p></details>
    </>}
  </section>;
}
