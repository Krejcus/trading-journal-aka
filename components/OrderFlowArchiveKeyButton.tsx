import React, { useState } from 'react';
import { supabase } from '../services/supabase';

/**
 * Zkopíruje účelový klíč, kterým Mac nahrává archiv order flow (Edge Function `orderflow-archive`).
 * Klíč umí jen nahrát den order flow vlastníka; jiný účet dostane odmítnutí. Klíč se nezobrazuje ani neukládá
 * v appce — jde rovnou do schránky a na Macu si ho vezme `orderFlowArchiveUpload.ts --set-key` do Klíčenky.
 */
const OrderFlowArchiveKeyButton: React.FC = () => {
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'forbidden' | 'error'>('idle');
  const copy = async () => {
    setState('busy');
    try {
      const { data, error } = await supabase.functions.invoke('orderflow-archive', { body: { action: 'key' } });
      const status = (error as { context?: { status?: number } } | null)?.context?.status;
      if (status === 403) { setState('forbidden'); return; }
      const key = (data as { key?: unknown } | null)?.key;
      if (error || typeof key !== 'string') { setState('error'); return; }
      await navigator.clipboard.writeText(key);
      setState('copied');
    } catch { setState('error'); }
  };
  return (
    <div className="mt-3 rounded-lg border border-white/10 p-2.5">
      <div className="text-[11px] font-medium text-slate-300">Historie order flow z Macu</div>
      <p className="mt-1 text-[11px] leading-snug text-slate-500">
        Starší dny nahrává do archivu Mac. Jednou zkopíruj klíč a na Macu spusť <code className="text-slate-400">npx tsx scripts/rithmic/orderFlowArchiveUpload.ts --set-key</code>.
      </p>
      <button type="button" onClick={copy} disabled={state === 'busy'} className="mt-2 rounded-md border border-white/15 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-white/5 disabled:opacity-50">
        {state === 'busy' ? 'Kopíruji…' : 'Zkopírovat klíč pro Mac'}
      </button>
      {state === 'copied' && <span className="ml-2 text-[11px] text-emerald-400">Zkopírováno — schránku nahrávač po uložení vyčistí.</span>}
      {state === 'forbidden' && <span className="ml-2 text-[11px] text-amber-400">Jen pro vlastníka archivu.</span>}
      {state === 'error' && <span className="ml-2 text-[11px] text-rose-400">Klíč se nepodařilo získat.</span>}
    </div>
  );
};

export default OrderFlowArchiveKeyButton;
