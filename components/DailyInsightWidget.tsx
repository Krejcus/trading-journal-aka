import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Sparkles, RefreshCw, AlertTriangle, TrendingUp, Flame, Lightbulb, X } from 'lucide-react';
import { supabase } from '../services/supabase';
import type { Trade } from '../types';

interface InsightRecord {
  id: string;
  content: string;
  headline: string | null;
  category: 'pattern' | 'warning' | 'celebration' | 'streak' | 'tip';
  refs: { tradeIds?: string[] };
  generated_at: string;
  is_dismissed: boolean;
}

interface Props {
  theme: 'dark' | 'light' | 'oled';
  trades: Trade[];
  onOpenTrade?: (trade: Trade) => void;
}

const CATEGORY_STYLE: Record<InsightRecord['category'], { icon: any; color: string; bg: string; border: string; label: string }> = {
  pattern:      { icon: Sparkles,      color: 'text-blue-500',    bg: 'bg-blue-500/10',    border: 'border-blue-500/20',    label: 'Pattern' },
  warning:      { icon: AlertTriangle, color: 'text-rose-500',    bg: 'bg-rose-500/10',    border: 'border-rose-500/20',    label: 'Pozor' },
  celebration:  { icon: TrendingUp,    color: 'text-emerald-500', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', label: 'Úspěch' },
  streak:       { icon: Flame,         color: 'text-amber-500',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   label: 'Série' },
  tip:          { icon: Lightbulb,     color: 'text-purple-500',  bg: 'bg-purple-500/10',  border: 'border-purple-500/20',  label: 'Tip' },
};

const STALE_HOURS = 24;

const EDGE_BASE = (() => {
  const url = (supabase as any).supabaseUrl || (import.meta as any).env?.VITE_SUPABASE_URL;
  return url || '';
})();

const DailyInsightWidget: React.FC<Props> = ({ theme, trades, onOpenTrade }) => {
  const isDark = theme !== 'light';
  const [insight, setInsight] = useState<InsightRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── Container size → text scale ─────────────────────────────────────────
  // Three tiers based on widget height: compact (<180px), medium, large (>360px).
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<'sm' | 'md' | 'lg'>('sm');
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        // Use combined "visual area" so a wide-but-short widget still scales text up.
        const { width, height } = e.contentRect;
        const score = Math.sqrt(width * height); // ~geometric mean
        setSize(score < 220 ? 'sm' : score > 400 ? 'lg' : 'md');
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Tier-based class maps — bumped ~2x for readability
  const headlineClass = size === 'lg' ? 'text-2xl' : size === 'md' ? 'text-xl' : 'text-base';
  const labelClass = size === 'lg' ? 'text-sm' : size === 'md' ? 'text-xs' : 'text-[10px]';
  const bodyClass = size === 'lg' ? 'text-xl leading-relaxed' : size === 'md' ? 'text-lg leading-relaxed' : 'text-sm leading-snug';
  const iconSize = size === 'lg' ? 26 : size === 'md' ? 22 : 16;
  const ctrlIconSize = size === 'lg' ? 18 : size === 'md' ? 16 : 13;
  const iconPad = size === 'lg' ? 'p-3' : size === 'md' ? 'p-2' : 'p-1.5';
  const pillCls = size === 'lg' ? 'text-base px-3 py-1' : size === 'md' ? 'text-sm px-2.5 py-1' : 'text-xs px-2 py-0.5';

  // Race a promise against a timeout — returns null if it exceeds ms.
  function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race<T | null>([
      p,
      new Promise<null>(resolve => setTimeout(() => resolve(null), ms)),
    ]);
  }

  const fetchLatest = useCallback(async (): Promise<InsightRecord | null> => {
    try {
      const result = await withTimeout(
        Promise.resolve(
          supabase
            .from('daily_insights')
            .select('*')
            .eq('is_dismissed', false)
            .order('generated_at', { ascending: false })
            .limit(1)
            .maybeSingle()
        ),
        5000,
      );
      if (!result) return null;
      return ((result as any).data as InsightRecord | null) || null;
    } catch {
      return null;
    }
  }, []);

  const callGenerate = useCallback(async (): Promise<InsightRecord | null> => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;
    try {
      const res = await withTimeout(
        fetch(`${EDGE_BASE}/functions/v1/generate-insight`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        }),
        30000, // Sonnet 4.5 can take up to ~20s — give it 30s ceiling.
      );
      if (!res) {
        setError('Generování trvá dlouho — zkus to znovu');
        return null;
      }
      const data = await res.json();
      if (!res.ok) {
        console.warn('[DailyInsightWidget] generate failed:', data);
        setError(data?.error || 'generate-failed');
        return null;
      }
      return (data.insight as InsightRecord) || null;
    } catch (e: any) {
      setError(e?.message || 'network');
      return null;
    }
  }, []);

  const refresh = useCallback(async (force: boolean) => {
    setError(null);
    if (force) setGenerating(true);
    else setLoading(true);
    try {
      const latest = await fetchLatest();
      const ageHours = latest ? (Date.now() - new Date(latest.generated_at).getTime()) / 36e5 : Infinity;
      if (!force && latest && ageHours < STALE_HOURS) {
        setInsight(latest);
      } else {
        // Show whatever we already have (if any) while we generate a fresh one in background.
        if (!force && latest) setInsight(latest);
        const fresh = await callGenerate();
        setInsight(fresh || latest);
      }
    } finally {
      setLoading(false);
      setGenerating(false);
    }
  }, [fetchLatest, callGenerate]);

  useEffect(() => {
    refresh(false);
  }, [refresh]);

  const handleDismiss = useCallback(async () => {
    if (!insight) return;
    await supabase.from('daily_insights').update({ is_dismissed: true }).eq('id', insight.id);
    setInsight(null);
    refresh(true);
  }, [insight, refresh]);

  // Render content with [TRADE:id] markers as clickable spans
  const renderContent = useCallback((text: string) => {
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    const regex = /\[TRADE:([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = regex.exec(text)) !== null) {
      if (m.index > lastIndex) parts.push(<span key={key++}>{text.slice(lastIndex, m.index)}</span>);
      const tradeId = m[1];
      // AI sometimes truncates UUIDs (e.g. "aed2a4e5" instead of full UUID).
      // Match exact first, then fall back to prefix match (8+ chars).
      const trade =
        trades.find(t => String(t.id) === tradeId)
        ?? (tradeId.length >= 6 ? trades.find(t => String(t.id).startsWith(tradeId)) : undefined);
      parts.push(
        <button
          key={key++}
          onClick={() => trade && onOpenTrade?.(trade)}
          className={`inline-flex items-center ${pillCls} mx-0.5 rounded font-black tracking-wider transition-all ${trade ? 'bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 border border-blue-500/20 cursor-pointer' : 'bg-slate-500/10 text-slate-500'}`}
          title={trade ? `${trade.instrument} ${trade.direction} · ${trade.pnl > 0 ? '+' : ''}$${trade.pnl?.toFixed(0)}` : 'Obchod nenalezen'}
        >
          {trade ? `${trade.instrument || '?'} ${trade.direction || ''}` : `TRADE`}
        </button>
      );
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < text.length) parts.push(<span key={key++}>{text.slice(lastIndex)}</span>);
    return parts;
  }, [trades, onOpenTrade, pillCls]);

  // Shared wrapper that mimics other dashboard widgets (glass-panel + rounded card).
  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div
      ref={containerRef}
      className={`${size === 'lg' ? 'p-6' : size === 'md' ? 'p-5' : 'p-4'} rounded-[24px] lg:rounded-[32px] h-full min-h-0 w-full flex flex-col overflow-hidden glass-panel`}
    >
      {children}
    </div>
  );

  if (loading) {
    return (
      <Wrapper>
        <div className="h-full flex items-center justify-center">
          <RefreshCw size={16} className={`animate-spin ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
        </div>
      </Wrapper>
    );
  }

  if (!insight) {
    return (
      <Wrapper>
        <div className="h-full flex flex-col items-center justify-center text-center gap-2">
          <Sparkles size={20} className={isDark ? 'text-slate-600' : 'text-slate-400'} />
          <p className={`text-[10px] font-bold uppercase tracking-widest ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Žádný insight zatím
          </p>
          <button
            onClick={() => refresh(true)}
            disabled={generating}
            className="px-3 py-1.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 text-[10px] font-black uppercase tracking-widest border border-blue-500/20 transition-all disabled:opacity-50"
          >
            {generating ? 'Generuju…' : 'Vygenerovat'}
          </button>
          {error && <p className="text-[9px] text-rose-500">{error}</p>}
        </div>
      </Wrapper>
    );
  }

  const cat = CATEGORY_STYLE[insight.category];
  const Icon = cat.icon;
  const ageMin = Math.floor((Date.now() - new Date(insight.generated_at).getTime()) / 60000);
  const ageLabel = ageMin < 60 ? `${ageMin}m` : ageMin < 1440 ? `${Math.floor(ageMin / 60)}h` : `${Math.floor(ageMin / 1440)}d`;

  return (
    <Wrapper>
      <div className={`flex items-start justify-between gap-2 ${size === 'lg' ? 'mb-4' : size === 'md' ? 'mb-3' : 'mb-2'}`}>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className={`${iconPad} rounded-md ${cat.bg} ${cat.border} border flex-shrink-0`}>
            <Icon size={iconSize} className={cat.color} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className={`${labelClass} font-black uppercase tracking-widest ${cat.color}`}>{cat.label}</span>
              <span className={`${labelClass} font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>· {ageLabel}</span>
            </div>
            {insight.headline && (
              <p className={`${headlineClass} font-black leading-tight ${size === 'sm' ? 'truncate' : ''} ${isDark ? 'text-white' : 'text-slate-900'}`}>{insight.headline}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={() => refresh(true)}
            disabled={generating}
            title="Vygenerovat nový insight"
            className={`${iconPad} rounded-md transition-all disabled:opacity-50 ${isDark ? 'hover:bg-white/10 text-slate-500 hover:text-white' : 'hover:bg-slate-100 text-slate-400 hover:text-slate-700'}`}
          >
            <RefreshCw size={ctrlIconSize} className={generating ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={handleDismiss}
            title="Skrýt tento insight"
            className={`${iconPad} rounded-md transition-all ${isDark ? 'hover:bg-white/10 text-slate-500 hover:text-white' : 'hover:bg-slate-100 text-slate-400 hover:text-slate-700'}`}
          >
            <X size={ctrlIconSize} />
          </button>
        </div>
      </div>

      <div className={`flex-1 ${bodyClass} ${isDark ? 'text-slate-300' : 'text-slate-700'} overflow-y-auto custom-scrollbar pr-1`}>
        {renderContent(insight.content)}
      </div>
    </Wrapper>
  );
};

export default DailyInsightWidget;
