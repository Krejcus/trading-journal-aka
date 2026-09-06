import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { storageService } from '../services/storageService';
import type { ConnectionTradeNoteConsent as Consent } from '../services/tradeLegacyNotes';

export default function ConnectionTradeNoteConsent({ connectionId, permissions }: {
  connectionId: string; permissions: Record<string, unknown>;
}) {
  const permissionsSnapshot = JSON.stringify(permissions);
  const requestKey = `${connectionId}:${permissionsSnapshot}`;
  const activeKey = useRef(requestKey); activeKey.current = requestKey;
  const mounted = useRef(true);
  const [state, setState] = useState<{ key: string; value?: Consent; error?: string }>({ key: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setState({ key: requestKey });
    storageService.getConnectionTradeNoteConsent(connectionId, JSON.parse(permissionsSnapshot)).then(value => {
      if (!cancelled) setState({ key: requestKey, value });
    }).catch((error: unknown) => {
      if (!cancelled) setState({ key: requestKey, error: error instanceof Error ? error.message : 'Potvrzení se nepodařilo načíst.' });
    });
    return () => { cancelled = true; };
  }, [connectionId, permissionsSnapshot, requestKey]);
  const current = state.key === requestKey ? state : { key: requestKey };
  const accountCount = Array.isArray(permissions.allowedAccountIds) ? permissions.allowedAccountIds.length : 0;
  const enabled = (permissions.canSeeReviewNotes ?? permissions.canSeeNotes) === true;
  const confirm = async () => {
    setSaving(true);
    try {
      const value = await storageService.confirmConnectionTradeNotes(connectionId, permissions);
      if (mounted.current && activeKey.current === requestKey) setState({ key: requestKey, value });
    } catch (error) {
      if (mounted.current && activeKey.current === requestKey) setState({ key: requestKey, error: error instanceof Error ? error.message : 'Sdílení nebylo potvrzeno.' });
    } finally { if (mounted.current) setSaving(false); }
  };
  return <div className="rounded-xl border border-slate-500/20 bg-slate-500/5 p-3 space-y-2">
    <div className="flex items-center gap-2 text-xs font-bold"><ShieldCheck size={14} /> Soukromé poznámky obchodů</div>
    <p className="text-[11px] leading-relaxed text-slate-500">
      {enabled ? `${accountCount ? `Poznámky z ${accountCount} vybraných účtů.` : 'Poznámky ze všech účtů včetně nových.'} Přístup potvrzuje vlastník. Historie revizí zůstává soukromá.` : 'Sdílení poznámek obchodů je vypnuté.'}
    </p>
    {current.error ? <p role="status" className="text-[11px] text-amber-500">{current.error}</p>
      : !current.value ? <p role="status" className="flex gap-2 items-center text-[11px] text-slate-500"><Loader2 size={12} className="animate-spin" /> Ověřuji potvrzení…</p>
      : current.value.confirmed && enabled ? <p role="status" className="flex gap-2 items-center text-[11px] text-emerald-500"><CheckCircle2 size={12} /> Potvrzeno vlastníkem</p>
      : enabled ? <p role="status" className="text-[11px] text-amber-500">Poznámky vyžadují nové potvrzení.</p> : null}
    {enabled && <button type="button" onClick={confirm} disabled={saving || (!current.value && !current.error)}
      className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-emerald-500 disabled:opacity-40 flex items-center justify-center gap-2">
      {saving && <Loader2 size={12} className="animate-spin" />} {saving ? 'Potvrzuji…' : 'Potvrdit sdílení poznámek'}
    </button>}
  </div>;
}
