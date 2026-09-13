import React, { useEffect, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import type { Trade } from '../types';
import { isEvidenceJournalTrade } from '../lib/journalTradeFacts';
import { storageService } from '../services/storageService';
import { loadJournalChartDetail } from '../services/journalChartDetail';

const TradeMarketChart = React.lazy(() => import('./TradeMarketChart'));
const loadOwnerTrade = (id: string) => storageService.getTradeById(id);

export default function AccountExecutionChart({ trade, isDark, verifiedDetail, loadTrade = loadOwnerTrade }: {
  trade: Trade; isDark: boolean; verifiedDetail?: Trade; loadTrade?: (id: string) => Promise<Trade | null>;
}) {
  const journal = isEvidenceJournalTrade(trade);
  const verified = verifiedDetail === trade && !!trade.executionHistory;
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ input: Trade; retry: number; detail: Trade | null } | null>(null);
  useEffect(() => {
    if (!journal || verified) return;
    let cancelled = false;
    const finish = (detail: Trade | null) => {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timeout);
      setResult({ input: trade, retry, detail });
    };
    const timeout = setTimeout(() => finish(null), 20_000);
    void loadJournalChartDetail(trade, loadTrade).then(detail => finish(detail), () => finish(null));
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [journal, verified, loadTrade, retry, trade]);
  const current = verified ? { detail: trade } : result?.input === trade && result.retry === retry ? result : null;
  const loading = <div role="status" className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-slate-500"><Loader2 size={18} className="animate-spin" />Načítám graf vybraného účtu…</div>;
  if (journal && !current) return loading;
  if (journal && !current?.detail) return <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-xs text-slate-500">
    <AlertCircle size={22} className="text-amber-500" />
    <p>Podklady grafu tohoto účtu se nepodařilo ověřit.</p>
    <p>Ceny a historii SL/TP zobrazíme po úspěšném načtení.</p>
    <button type="button" onClick={() => setRetry(value => value + 1)} className="inline-flex items-center gap-2 rounded-lg border border-slate-500/20 px-3 py-2 font-bold text-theme-primary"><RefreshCw size={13} />Zkusit znovu</button>
  </div>;
  return <React.Suspense fallback={loading}><TradeMarketChart trade={journal ? current!.detail! : trade} isDark={isDark} /></React.Suspense>;
}
