import React, { useState, useEffect } from 'react';
import { Eye, Loader2, RefreshCw, AlertCircle, Lightbulb } from 'lucide-react';
import { Trade } from '../types';
import { analyzeChart, type VisionAnalysis } from '../services/visionService';

interface Props {
  trade: Trade;
  theme: 'dark' | 'light' | 'oled';
  onUpdateTrade?: (updates: Partial<Trade>) => void;
}

/**
 * Vision debrief sekce v Trade Detail Modalu.
 * Claude "uvidí" screenshot grafu a vrátí ICT rozbor (entry/stop/timing).
 * On-demand přes tlačítko; výsledek se uloží do trade.data.visionAnalysis (edge function).
 */
const TradeVisionSection: React.FC<Props> = ({ trade, theme, onUpdateTrade }) => {
  const isDark = theme !== 'light';
  const [analysis, setAnalysis] = useState<VisionAnalysis | undefined>((trade as any).visionAnalysis);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setAnalysis((trade as any).visionAnalysis); }, [(trade as any).visionAnalysis]);

  // Má obchod screenshot? (jinak nemá smysl tlačítko ukazovat)
  const hasScreenshot = !!(
    (trade.screenshot && String(trade.screenshot).startsWith('http')) ||
    (Array.isArray(trade.screenshots) && trade.screenshots.some(s => s && String(s).startsWith('http')))
  );
  if (!hasScreenshot) return null;

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await analyzeChart(trade.id);
      setAnalysis(result);
      onUpdateTrade?.({ visionAnalysis: result } as Partial<Trade>);
    } catch (e: any) {
      setError(e?.message || 'Analýza selhala');
    } finally {
      setLoading(false);
    }
  };

  const confColor = analysis?.confidence === 'high' ? 'text-emerald-500'
    : analysis?.confidence === 'low' ? 'text-amber-500' : 'text-slate-400';
  const confLabel = analysis?.confidence === 'high' ? 'Vysoká jistota'
    : analysis?.confidence === 'low' ? 'Nízká jistota (graf nečitelný)' : 'Střední jistota';

  return (
    <div className={`rounded-2xl border overflow-hidden ${isDark ? 'border-violet-500/20 bg-violet-500/[0.03]' : 'border-violet-200 bg-violet-50/30'}`}>
      <div className="flex items-center justify-between px-4 py-3">
        <p className="text-[10px] font-black uppercase text-violet-500 tracking-[0.2em] flex items-center gap-2">
          <Eye size={13} /> Vision rozbor grafu
        </p>
        {analysis && (
          <button
            onClick={run}
            disabled={loading}
            className="text-violet-500 hover:text-violet-600 disabled:opacity-40 p-1 rounded-lg"
            title="Přegenerovat"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        )}
      </div>

      <div className="px-4 pb-4">
        {!analysis && !loading && (
          <button
            onClick={run}
            className="w-full py-2.5 rounded-xl bg-violet-500 hover:bg-violet-600 text-white text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
          >
            <Eye size={14} /> Analyzuj graf
          </button>
        )}

        {loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-violet-500">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-xs font-bold">Coach kouká na graf…</span>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-rose-500 text-xs py-2">
            <AlertCircle size={14} /> {error}
          </div>
        )}

        {analysis && !loading && (
          <div className="space-y-3">
            {/* Verdikt */}
            <div className={`text-sm font-black ${isDark ? 'text-violet-200' : 'text-violet-900'}`}>
              {analysis.verdict}
            </div>

            {/* Postřehy */}
            {analysis.observations.length > 0 && (
              <ul className="space-y-1.5">
                {analysis.observations.map((o, i) => (
                  <li key={i} className={`text-xs leading-relaxed flex gap-2 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                    <span className="text-violet-400 shrink-0">▸</span>
                    <span>{o}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* Lekce */}
            {analysis.lesson && (
              <div className={`flex items-start gap-2 p-2.5 rounded-xl text-xs font-medium ${isDark ? 'bg-amber-500/10 text-amber-200' : 'bg-amber-50 text-amber-800'}`}>
                <Lightbulb size={13} className="text-amber-500 shrink-0 mt-0.5" />
                <span>{analysis.lesson}</span>
              </div>
            )}

            <p className={`text-[9px] font-bold uppercase tracking-wider ${confColor}`}>{confLabel}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default TradeVisionSection;
