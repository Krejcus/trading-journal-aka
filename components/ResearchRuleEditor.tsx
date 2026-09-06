import React, { useRef, useState } from 'react';
import type { LabExperiment } from '../types';
import { appendResearchRule, type BacktestResearchRule } from '../services/backtestResearchCases';
interface Props { experiment: LabExperiment; isDark: boolean; onSave: (next:LabExperiment)=>Promise<void>; onClose:()=>void }
export default function ResearchRuleEditor({experiment,isDark,onSave,onClose}:Props) {
  const [baseline]=useState(()=>structuredClone(experiment));
  const [definition,setDefinition]=useState<BacktestResearchRule>(()=>structuredClone(experiment.research?.revisions.at(-1)?.definition ?? {
    hypothesis:experiment.hypothesis,rule:experiment.rule,falsification:'',targetPositions:Math.max(5,experiment.targetTrades),timeZone:'Europe/Prague',
  }));
  const [reason,setReason]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState<string>();
  const busyRef=useRef(false);
  const operation=useRef<{operationId:string;recordedAt:number}|undefined>(undefined);
  const change=(patch:Partial<BacktestResearchRule>)=>{setDefinition(current=>({...current,...patch}));operation.current=undefined;};
  const save=async()=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);setError(undefined);try {
    const op=operation.current??{operationId:crypto.randomUUID(),recordedAt:Date.now()};operation.current=op;
    const research=await appendResearchRule({previous:baseline.research,expectedHeadId:baseline.research?.revisions.at(-1)?.id,definition,reason,...op,legacy:baseline.research?undefined:baseline});
    await onSave({...baseline,research,hypothesis:definition.hypothesis.trim(),rule:definition.rule.trim(),targetTrades:definition.targetPositions});onClose();
  } catch(reason){setError(reason instanceof Error?reason.message:'Verzi se nepodařilo uložit.');}finally{busyRef.current=false;setBusy(false);}};
  const field=`w-full rounded border px-3 py-2 text-sm ${isDark?'border-slate-600 bg-slate-900 text-slate-100':'border-slate-300 bg-white text-slate-900'}`;
  return <div className="fixed inset-0 z-[950] flex items-center justify-center bg-black/50 p-4" role="presentation"><section role="dialog" aria-modal="true" aria-labelledby="research-rule-title" className={`max-h-[90vh] w-full max-w-2xl space-y-4 overflow-auto rounded-xl p-5 ${isDark?'bg-slate-950 text-slate-100':'bg-slate-50 text-slate-900'}`}>
    <h2 id="research-rule-title" className="text-lg font-bold">Nová verze pravidel · {experiment.title}</h2>
    <p className="text-xs text-slate-500">Původní verze zůstane u už navázaných sessions. Novou verzi vybereš při založení další session.</p>
    <label className="block text-xs">Hypotéza<textarea disabled={busy} className={`${field} mt-1`} value={definition.hypothesis} rows={2} onChange={e=>change({hypothesis:e.target.value})}/></label>
    <label className="block text-xs">Přesné pravidlo<textarea disabled={busy} className={`${field} mt-1`} value={definition.rule} rows={3} onChange={e=>change({rule:e.target.value})}/></label>
    <label className="block text-xs">Co hypotézu vyvrátí<textarea disabled={busy} className={`${field} mt-1`} value={definition.falsification} rows={2} onChange={e=>change({falsification:e.target.value})}/></label>
    <div className="grid grid-cols-2 gap-3"><label className="text-xs">Cílový počet pozic<input disabled={busy} type="number" min={5} max={100000} className={`${field} mt-1`} value={definition.targetPositions} onChange={e=>change({targetPositions:Number(e.target.value)})}/></label><label className="text-xs">Časové pásmo<input disabled={busy} className={`${field} mt-1`} value={definition.timeZone} onChange={e=>change({timeZone:e.target.value})}/></label></div>
    {(['development','validation'] as const).map(kind=><fieldset key={kind} className="rounded border border-slate-500/20 p-3"><legend className="text-xs">{kind==='development'?'Vývojový vzorek':'Ověřovací vzorek'} (volitelné)</legend><div className="grid grid-cols-2 gap-3">{(['from','through'] as const).map(edge=><label key={edge} className="text-xs">{edge==='from'?'Od':'Do'}<input disabled={busy} type="date" className={`${field} mt-1`} value={definition[kind]?.[edge]??''} onChange={e=>{const next={from:definition[kind]?.from??'',through:definition[kind]?.through??'',[edge]:e.target.value};change({[kind]:!next.from&&!next.through?undefined:next});}}/></label>)}</div></fieldset>)}
    <p className="text-xs text-slate-500">Rozsahy stanovují plán. Samy nepotvrzují, že jsi trh nebo výsledky dosud neviděl.</p>
    <label className="block text-xs">Proč pravidlo měním<textarea disabled={busy} className={`${field} mt-1`} rows={2} value={reason} onChange={e=>{setReason(e.target.value);operation.current=undefined;}}/></label>
    {error&&<p role="alert" className="text-sm text-rose-500">{error}</p>}
    <div className="flex gap-3"><button disabled={busy} className="rounded bg-violet-600 px-4 py-2 text-sm text-white disabled:opacity-40" onClick={()=>void save()}>{busy?'Ukládám…':'Uložit novou verzi'}</button><button disabled={busy} className="rounded border border-slate-500/30 px-4 py-2 text-sm" onClick={onClose}>Zrušit</button></div>
  </section></div>;
}
