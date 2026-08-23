import React, { useEffect, useState } from 'react';
import { AlertTriangle, Save, X } from 'lucide-react';
import type { FirmPayoutRules } from '../lib/propFirmRules';

interface Props {
  firm: string;
  initialRules: FirmPayoutRules;
  theme: 'dark' | 'light' | 'oled';
  saving: boolean;
  error: string | null;
  onSave: (rules: FirmPayoutRules) => void;
  onClose: () => void;
}

const numericFields: Array<{ key: keyof FirmPayoutRules; label: string; suffix: string; help?: string }> = [
  { key: 'profitDaysRequired', label: 'Profit dny', suffix: 'dnů' },
  { key: 'minProfitPerDayUsd', label: 'Minimum profit dne', suffix: 'USD' },
  { key: 'minPayoutUsd', label: 'Min payout', suffix: 'USD' },
  { key: 'maxPayoutUsd', label: 'Max payout', suffix: 'USD' },
  { key: 'withdrawablePctOfProfit', label: 'Vybratelná část zisku', suffix: '%', help: 'Kolik procent simulovaného zisku lze vybrat v jedné žádosti.' },
  { key: 'minBalanceToRequestUsd', label: 'Min balance pro žádost', suffix: 'USD', help: 'Žádost je dostupná až po dosažení této balance; vybrat lze část nad ní.' },
  { key: 'payoutCycleDays', label: 'Payout cyklus', suffix: 'dnů' },
  { key: 'consistencyPct', label: 'Consistency limit', suffix: '%' },
  { key: 'splitPct', label: 'Profit split', suffix: '%' },
];

const FirmPayoutRulesDialog: React.FC<Props> = ({ firm, initialRules, theme, saving, error, onSave, onClose }) => {
  const [rules, setRules] = useState(initialRules);
  const isDark = theme !== 'light';
  useEffect(() => setRules(initialRules), [initialRules]);
  const input = `w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30 ${isDark ? 'border-white/10 bg-slate-950 text-white' : 'border-slate-200 bg-slate-50 text-slate-900'}`;

  return <div className="fixed inset-0 z-[470] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" role="dialog" aria-label={`Payout pravidla ${firm}`} onClick={onClose}>
    <div className={`flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border shadow-2xl ${isDark ? 'border-white/10 bg-slate-900' : 'border-slate-200 bg-white'}`} onClick={event => event.stopPropagation()}>
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 p-5">
        <div><p className="text-[9px] font-black uppercase tracking-[0.2em] text-indigo-500">Pravidla firmy</p><h3 className="mt-1 text-xl font-black">{firm}</h3></div>
        <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-white/5 hover:text-white"><X size={18} /></button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        <div className={`flex gap-3 rounded-lg border p-3 text-xs ${isDark ? 'border-amber-500/20 bg-amber-500/5 text-amber-300' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          <AlertTriangle size={16} className="shrink-0" /><span>Firmy mění pravidla bez varování. Šablonu uprav podle svého aktuálního plánu.</span>
        </div>
        <label className="block"><span className="mb-1 block text-[10px] font-black uppercase tracking-wider text-slate-500">Název plánu</span><input className={input} value={rules.planName} onChange={event => setRules(current => ({ ...current, planName: event.target.value }))} /></label>
        <div className="grid gap-4 sm:grid-cols-2">
          {numericFields.map(field => <label key={field.key} className="block"><span className="mb-1 block text-[10px] font-black uppercase tracking-wider text-slate-500">{field.label}</span><div className="relative"><input type="number" min="0" className={`${input} pr-14 tabular-nums`} value={rules[field.key] as number | null ?? ''} placeholder="Nezobrazovat" onChange={event => setRules(current => ({ ...current, [field.key]: event.target.value === '' ? null : Number(event.target.value) }))} /><span className="absolute right-3 top-2.5 text-[9px] font-black uppercase text-slate-500">{field.suffix}</span></div>{field.help && <span className="mt-1 block text-[10px] leading-snug text-slate-500">{field.help}</span>}</label>)}
          <label className="block"><span className="mb-1 block text-[10px] font-black uppercase tracking-wider text-slate-500">Drawdown typ</span><select className={input} value={rules.drawdownType ?? ''} onChange={event => setRules(current => ({ ...current, drawdownType: event.target.value ? event.target.value as FirmPayoutRules['drawdownType'] : null }))}><option value="">Nezobrazovat</option><option value="trailing">Intraday trailing</option><option value="eod_trailing">EOD trailing</option><option value="static">Static</option></select></label>
        </div>
        {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs font-bold text-rose-500">{error}</p>}
      </div>
      <div className="flex shrink-0 justify-end gap-3 border-t border-white/10 p-5"><button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-xs font-black uppercase text-slate-500">Zrušit</button><button type="button" disabled={saving || !rules.planName.trim()} onClick={() => onSave(rules)} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-xs font-black uppercase text-white disabled:opacity-50"><Save size={14} />{saving ? 'Ukládám…' : 'Uložit'}</button></div>
    </div>
  </div>;
};

export default FirmPayoutRulesDialog;
