import React, { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import type { BacktestStoreEvidence } from '../services/backtestStoreEvidence';
const date = (value: number) => new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
const gapLabels = { 'calendar-closed': 'Uzavřeno podle kalendáře', 'expected-open-without-bar': 'Otevřeno bez svíčky', 'fetch-unverified': 'Stažení nedoloženo', 'unknown-schedule': 'Příčina mezery neznámá' };
export default function BacktestEvidenceDialog({ load, onClose, isDark }: { load: () => Promise<BacktestStoreEvidence>; onClose: () => void; isDark: boolean }) {
  const [data, setData] = useState<BacktestStoreEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; load().then(value => { if (active) setData(value); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }); return () => { active = false; }; }, [load]);
  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `backtest-evidence-${data.runId}.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="fixed inset-0 z-[600] flex items-center justify-center bg-black/60 p-4" onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') onClose(); }}>
    <section role="dialog" aria-modal="true" aria-label="Kvalita dat a exekuce replaye" className={`max-h-[85vh] w-full max-w-3xl overflow-auto rounded-xl border p-5 shadow-xl ${isDark ? 'border-slate-700 bg-[#11161f] text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}>
      <header className="mb-4 flex items-center justify-between"><h2 className="text-base font-bold">Kvalita dat a exekuce</h2><button autoFocus aria-label="Zavřít kvalitu dat" onClick={onClose}><X size={18} /></button></header>
      <p className="mb-4 text-xs text-slate-500">Snímek dat dostupných do aktuálního kurzoru. Mezera sama o sobě neprokazuje výpadek poskytovatele.</p>
      {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
      {!data && !error && <p role="status">Počítám přehled…</p>}
      {data && <div className="space-y-5">
        <p className="text-xs">Horizont: {data.replayHorizonTime === null ? 'Replay zatím nezačal' : date(data.replayHorizonTime * 1000)}</p>
        {data.manifests.map(({ root, manifest: m, sourceSymbols }) => <section key={root} className="rounded-lg border border-slate-500/25 p-3">
          <h3 className="mb-2 font-bold">{root} · 1 minuta</h3>
          <p className="text-xs">{m.coverage.observedGridSlots.toLocaleString('cs')} svíček · {m.coverage.fetchedGridSlots.toLocaleString('cs')} minut pokrytých požadavkem · {m.coverage.gaps.reduce((n, gap) => n + gap.slots, 0).toLocaleString('cs')} minut bez svíčky</p>
          <p className="mt-1 text-xs text-slate-500">Kontrakt/symbol z loaderu: {sourceSymbols.join(', ') || 'nedoložen'} · verze feedu: {m.source.revision || 'nedoložena'}</p>
          {m.coverage.gaps.length > 0 && <details className="mt-3 text-xs"><summary>Chybějící intervaly ({m.coverage.gaps.length})</summary><ul className="mt-2 space-y-1">{m.coverage.gaps.slice(0, 100).map(gap => <li key={gap.startMs}>{date(gap.startMs)} → {date(gap.endMs)} · {gapLabels[gap.kind]}</li>)}</ul>{m.coverage.gaps.length > 100 && <p>Další intervaly jsou v JSON exportu.</p>}</details>}
          <details className="mt-3 text-xs"><summary>Identita a diagnostika dat</summary><p className="mt-2 break-all font-mono">{m.contentHash}</p><p className="mt-2">Neplatné řádky: {m.quality.invalidRows}; duplicity v předaném snímku: {m.quality.duplicateRows}. Původní feed před normalizací není dostupný.</p></details>
        </section>)}
        <section className="text-xs"><h3 className="mb-2 font-bold">Model provedení příkazů</h3><p>Minutové OHLC, při neurčitém pořadí konzervativní výsledek. Zaznamenaná nejistota zůstává součástí analýzy.</p><p className="mt-2">Denní uzavření: {Math.floor(data.executionProfile.cutoff.minuteOfDay / 60).toString().padStart(2, '0')}:{(data.executionProfile.cutoff.minuteOfDay % 60).toString().padStart(2, '0')} {data.executionProfile.cutoff.timeZone}</p>
          {Object.entries(data.executionProfile.costs).map(([root, cost]) => <p key={root} className="mt-1">{root}: komise ${cost.commissionPerSide} za kontrakt a stranu · slippage {cost.slippageTicks} ticků</p>)}
        </section>
        <ul className="space-y-1 text-xs text-slate-500">{data.limitations.map(item => <li key={item}>{item}</li>)}</ul>
        <button onClick={download} className="flex items-center gap-2 rounded bg-violet-600 px-3 py-2 text-xs font-bold text-white"><Download size={14} /> Exportovat důkazy JSON</button>
      </div>}
    </section>
  </div>;
}
