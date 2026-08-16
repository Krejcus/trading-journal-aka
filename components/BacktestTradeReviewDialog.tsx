import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Camera,
  Check,
  FileText,
  Image as ImageIcon,
  Layers3,
  Loader2,
  Maximize2,
  Plus,
  RefreshCw,
  Save,
  Target,
  Waves,
  X,
  Zap,
} from 'lucide-react';
import type { Trade } from '../types';
import {
  buildBacktestTradeRecalculationUpdates,
  describeBacktestTradeRecalculation,
  type BacktestTradeRecalculationChange,
} from '../services/backtestTradeRecalculation';

interface Props {
  trade: Trade;
  isDark: boolean;
  onClose: () => void;
  onCaptureSnapshot: () => string | Promise<string>;
  onRecalculate?: () => Trade | Promise<Trade>;
  onSave: (updates: Partial<Trade>, snapshotDataUrl?: string) => Promise<void>;
}

const splitTags = (value: string) => value
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

const joinTags = (values?: string[]) => (values ?? []).join(', ');

const formatAuditPrice = (value: unknown) => (
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—'
);

type EntryAuditTone = 'pass' | 'fail' | 'info' | 'missing';

interface EntryAuditItem {
  label: string;
  value: string;
  detail: string;
  tone: EntryAuditTone;
}

const getConfluenceTone = (tag: string, isDark: boolean) => {
  const normalized = tag.toLowerCase();
  if (/stop|sl\b|invalid|mimo/.test(normalized)) return isDark ? 'border-rose-400/25 bg-rose-400/10 text-rose-300' : 'border-rose-200 bg-rose-50 text-rose-700';
  if (/target|tp\b|valid|podle plánu/.test(normalized)) return isDark ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (/bos|choch|mss|break/.test(normalized)) return isDark ? 'border-sky-400/25 bg-sky-400/10 text-sky-300' : 'border-sky-200 bg-sky-50 text-sky-700';
  if (/ob|fvg|entry|vstup/.test(normalized)) return isDark ? 'border-violet-400/25 bg-violet-400/10 text-violet-300' : 'border-violet-200 bg-violet-50 text-violet-700';
  return isDark ? 'border-white/10 bg-white/[0.04] text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-600';
};

const ConfluenceCapsuleEditor: React.FC<{
  value: string;
  onChange: (value: string) => void;
  isDark: boolean;
  addLabel: string;
}> = ({ value, onChange, isDark, addLabel }) => {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const tags = splitTags(value);

  const commitDraft = () => {
    const additions = splitTags(draft);
    if (additions.length) onChange([...new Set([...tags, ...additions])].join(', '));
    setDraft('');
    setAdding(false);
  };

  return (
    <div className="mt-2 flex min-h-8 flex-wrap items-center gap-1.5">
      {tags.map((tag, index) => (
        <span key={`${tag}-${index}`} className={`inline-flex items-center gap-1 rounded-lg border py-1 pl-2 pr-1 text-[9px] font-black uppercase tracking-wide ${getConfluenceTone(tag, isDark)}`}>
          {tag}
          <button type="button" onClick={() => onChange(tags.filter((_, itemIndex) => itemIndex !== index).join(', '))} className="flex h-4 w-4 items-center justify-center rounded hover:bg-black/10" aria-label={`Odebrat ${tag}`}><X size={10} /></button>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              commitDraft();
            } else if (event.key === 'Escape') {
              setDraft('');
              setAdding(false);
            }
          }}
          placeholder="Název confluence"
          className={`h-7 min-w-40 flex-1 rounded-lg border px-2 text-[10px] font-bold outline-none focus:border-blue-500 ${isDark ? 'border-white/10 bg-white/[0.04]' : 'border-slate-200 bg-white'}`}
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={`inline-flex h-7 items-center gap-1 rounded-lg border border-dashed px-2 text-[9px] font-black uppercase tracking-wide ${isDark ? 'border-white/15 text-slate-400 hover:border-white/30' : 'border-slate-300 text-slate-500 hover:border-slate-400'}`}><Plus size={11} /> {addLabel}</button>
      )}
    </div>
  );
};

export const buildBacktestTradeReviewUpdates = ({
  notes,
  htfConfluence,
  ltfConfluence,
  isValid,
}: {
  notes: string;
  htfConfluence: string;
  ltfConfluence: string;
  isValid: boolean;
}): Partial<Trade> => ({
  notes: notes.trim(),
  htfConfluence: splitTags(htfConfluence),
  ltfConfluence: splitTags(ltfConfluence),
  isValid,
  executionStatus: isValid ? 'Valid' : 'Invalid',
  planAdherence: isValid ? 'Yes' : 'No',
});

const BacktestTradeReviewDialog: React.FC<Props> = ({
  trade,
  isDark,
  onClose,
  onCaptureSnapshot,
  onRecalculate,
  onSave,
}) => {
  const [notes, setNotes] = useState(trade.notes ?? '');
  const [htfConfluence, setHtfConfluence] = useState(joinTags(trade.htfConfluence));
  const [ltfConfluence, setLtfConfluence] = useState(joinTags(trade.ltfConfluence));
  const [isValid, setIsValid] = useState(trade.isValid !== false && trade.executionStatus !== 'Invalid');
  const [snapshot, setSnapshot] = useState<string>();
  const [snapshotZoomOpen, setSnapshotZoomOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recalculatedUpdates, setRecalculatedUpdates] = useState<Partial<Trade>>({});
  const [recalculationChanges, setRecalculationChanges] = useState<BacktestTradeRecalculationChange[]>();
  const [error, setError] = useState<string>();
  const captureRequestRef = useRef(0);

  useEffect(() => {
    captureRequestRef.current += 1;
    setNotes(trade.notes ?? '');
    setHtfConfluence(joinTags(trade.htfConfluence));
    setLtfConfluence(joinTags(trade.ltfConfluence));
    setIsValid(trade.isValid !== false && trade.executionStatus !== 'Invalid');
    setSnapshot(undefined);
    setSnapshotZoomOpen(false);
    setCapturing(false);
    setRecalculating(false);
    setRecalculatedUpdates({});
    setRecalculationChanges(undefined);
    setError(undefined);
  }, [trade]);

  useEffect(() => () => {
    captureRequestRef.current += 1;
  }, []);

  useEffect(() => {
    if (!snapshotZoomOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSnapshotZoomOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [snapshotZoomOpen]);

  const displayTrade = useMemo(() => ({ ...trade, ...recalculatedUpdates }), [recalculatedUpdates, trade]);
  const collectedValues = useMemo(() => [
    displayTrade.session ? { label: 'Session', value: displayTrade.session } : null,
    displayTrade.riskAmount != null ? { label: 'Riziko', value: `$${displayTrade.riskAmount.toFixed(2)}` } : null,
    displayTrade.riskAmount ? { label: 'Výsledek v R', value: `${(displayTrade.pnl / displayTrade.riskAmount).toFixed(2)}R` } : null,
    displayTrade.mfeR != null ? { label: 'MFE', value: `${displayTrade.mfeR.toFixed(2)}R` } : null,
    displayTrade.maeR != null ? { label: 'MAE', value: `${displayTrade.maeR.toFixed(2)}R` } : null,
    displayTrade.management ? { label: 'Management', value: displayTrade.management } : null,
    displayTrade.targetLevel ? { label: 'Target', value: displayTrade.targetLevel } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item)), [displayTrade]);
  const savedSnapshot = trade.screenshots?.at(-1) ?? trade.screenshot;
  const snapshotPreview = snapshot ?? savedSnapshot;
  const isLong = trade.direction.toLowerCase() === 'long';
  const tradeDate = new Intl.DateTimeFormat('cs-CZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(trade.timestamp ?? trade.date));
  const executionValues = [
    { label: 'Entry', value: displayTrade.entryPrice?.toFixed(2) ?? '—' },
    { label: 'Exit', value: displayTrade.exitPrice?.toFixed(2) ?? '—' },
    { label: 'SL', value: displayTrade.stopLoss?.toFixed(2) ?? '—' },
    { label: 'TP', value: displayTrade.takeProfit?.toFixed(2) ?? '—' },
  ];
  const levelTags = useMemo(() => {
    const context = displayTrade.entryContext as any;
    const entryMap = displayTrade.entryMap as any;
    return [...new Set([
      ...(Array.isArray(entryMap?.odrazLevels) ? entryMap.odrazLevels : []),
      ...(Array.isArray(entryMap?.entryLevels) ? entryMap.entryLevels : []),
      ...(Array.isArray(context?.sweptLevels) ? context.sweptLevels.map((level: string) => `${level} sweep`) : []),
      context?.nearestUntappedAbove ? `${context.nearestUntappedAbove} nad vstupem` : null,
      context?.nearestUntappedBelow ? `${context.nearestUntappedBelow} pod vstupem` : null,
      displayTrade.targetLevel ? `TP ${displayTrade.targetLevel}` : null,
    ].filter((tag): tag is string => Boolean(tag)))];
  }, [displayTrade.entryContext, displayTrade.entryMap, displayTrade.targetLevel]);
  const entryAudit = useMemo<EntryAuditItem[]>(() => {
    const entryMap = displayTrade.entryMap as any;
    const context = displayTrade.entryContext as any;
    const placement = context?.placement as any;
    const odrazLabels = Array.isArray(entryMap?.odrazLevels) ? entryMap.odrazLevels : [];
    const odrazKnown = entryMap?.odrazPrice != null;

    const fvgHasAudit = entryMap?.entryFvgValid !== undefined;
    const fvgValid = entryMap?.entryFvgValid === true && entryMap?.entryFvgTimeframe === '1m';
    const fvgSpan = entryMap?.entryFvgSpan;
    const fvgRange = fvgSpan
      ? `${formatAuditPrice(fvgSpan.bottom)}–${formatAuditPrice(fvgSpan.top)}`
      : 'rozsah —';
    const fvgDistance = entryMap?.entryFvgDistanceTicks != null
      ? `${Number(entryMap.entryFvgDistanceTicks).toFixed(1)} ticku od hrany`
      : 'vzdálenost —';

    const slType = placement?.slPlacement ?? displayTrade.slPlacement;
    const slCandidate = slType && placement?.slCandidates?.[slType];
    const candidateSummary = placement?.slCandidates
      ? (['ote', 'swing', 'fvg'] as const)
        .map(key => `${key.toUpperCase()} ${formatAuditPrice(placement.slCandidates[key]?.price)}`)
        .join(' · ')
      : 'Přepočítej pro ceny OTE / swing / FVG';
    const slKnown = Boolean(slType);
    const slValid = slType === 'ote' || slType === 'swing' || slType === 'fvg';
    const slDistance = slCandidate?.distanceTicks != null
      ? ` · odchylka ${Number(slCandidate.distanceTicks).toFixed(1)} ticku`
      : '';

    const policy = placement?.targetPolicy;
    const targetKnown = Boolean(policy || displayTrade.targetType || displayTrade.targetLevel);
    const targetValid = policy?.valid === true;
    const targetValue = policy?.expected === 'session_close' || displayTrade.targetType === 'session_close'
      ? 'EOD / konec session'
      : policy?.valid === false
        ? 'Bez potvrzené shody'
        : policy?.nearestLevel
          ? displayTrade.targetType === 'deviation'
            ? `Deviace ${policy.nearestLevel}`
            : `Nejbližší ${policy.nearestLevel}`
        : displayTrade.targetLevel
          ? `Level ${displayTrade.targetLevel}`
          : displayTrade.targetType ?? 'Přepočítat';
    const targetDetail = policy?.expected === 'session_close'
      ? 'Bez pevného TP · engine vynutí session close'
      : policy
        ? `${policy.valid === false ? 'Nejbližší kandidát' : 'Level'} ${policy.nearestLevel ?? '—'} ${formatAuditPrice(policy.nearestPrice)} · TP ${formatAuditPrice(policy.actualPrice)}${policy.distanceTicks != null ? ` · odchylka ${Number(policy.distanceTicks).toFixed(1)} ticku` : ''}`
        : 'Přepočítej pro nejbližší netknutý level a odchylku';

    return [
      {
        label: 'Odraz',
        value: odrazKnown ? (odrazLabels.length ? odrazLabels.join(' + ') : 'Bez shody s levelem') : 'Nenalezen',
        detail: odrazKnown ? `Chráněný extrém ${formatAuditPrice(entryMap.odrazPrice)}${entryMap.odrazLevelPrice != null ? ` · level ${formatAuditPrice(entryMap.odrazLevelPrice)}` : ''}` : 'Struktura před vstupem nedala chráněný extrém',
        tone: odrazKnown ? 'info' : 'missing',
      },
      {
        label: 'Entry',
        value: !fvgHasAudit ? 'Starší data · přepočítat' : fvgValid ? '1m FVG · proximální hrana' : '1m FVG nepotvrzeno',
        detail: `${fvgRange} · ${fvgDistance}`,
        tone: !fvgHasAudit ? 'missing' : fvgValid ? 'pass' : 'fail',
      },
      {
        label: 'Stop loss',
        value: slKnown ? `${slValid ? slType.toUpperCase() : 'Mimo OTE / swing / FVG'} · ${formatAuditPrice(displayTrade.stopLoss)}` : 'Starší data · přepočítat',
        detail: slCandidate?.price != null
          ? `Reference ${formatAuditPrice(slCandidate.price)}${slDistance}`
          : candidateSummary,
        tone: !slKnown ? 'missing' : slValid ? 'pass' : 'fail',
      },
      {
        label: 'Cíl',
        value: targetValue,
        detail: targetDetail,
        tone: !targetKnown ? 'missing' : targetValid || policy?.expected === 'session_close' ? 'pass' : policy?.valid === false ? 'fail' : 'info',
      },
    ];
  }, [displayTrade]);

  const recalculate = async () => {
    if (!onRecalculate) return;
    setRecalculating(true);
    setError(undefined);
    try {
      const recalculated = await onRecalculate();
      const current = {
        ...trade,
        ...recalculatedUpdates,
        htfConfluence: splitTags(htfConfluence),
        ltfConfluence: splitTags(ltfConfluence),
      };
      const updates = buildBacktestTradeRecalculationUpdates(current, recalculated);
      const next = { ...current, ...updates };
      setRecalculatedUpdates(updates);
      setHtfConfluence(joinTags(next.htfConfluence));
      setLtfConfluence(joinTags(next.ltfConfluence));
      setRecalculationChanges(describeBacktestTradeRecalculation(current, next));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Přepočet z indikátoru se nepodařil.');
    } finally {
      setRecalculating(false);
    }
  };

  const captureSnapshot = async () => {
    const requestId = ++captureRequestRef.current;
    setCapturing(true);
    try {
      const capturedSnapshot = await onCaptureSnapshot();
      if (captureRequestRef.current !== requestId) return;
      setSnapshot(capturedSnapshot);
      setError(undefined);
    } catch (reason) {
      if (captureRequestRef.current !== requestId) return;
      setError(reason instanceof Error ? reason.message : 'Snapshot grafů se nepodařilo vytvořit.');
    } finally {
      if (captureRequestRef.current === requestId) setCapturing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await onSave({
        ...recalculatedUpdates,
        ...buildBacktestTradeReviewUpdates({
          notes,
          htfConfluence,
          ltfConfluence,
          isValid,
        }),
      }, snapshot);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Review obchodu se nepodařilo uložit.');
    } finally {
      setSaving(false);
    }
  };

  const panel = isDark
    ? 'border-white/10 bg-[#10161f] text-slate-100 shadow-black/60'
    : 'border-slate-200 bg-white text-slate-900 shadow-slate-900/20';
  const field = isDark
    ? 'border-white/10 bg-white/[0.04] text-slate-100 placeholder:text-slate-600'
    : 'border-slate-200 bg-slate-50 text-slate-900 placeholder:text-slate-400';

  return (
    <div className="fixed inset-0 z-[900] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section data-backtest-trade-review role="dialog" aria-modal="true" aria-labelledby="backtest-trade-review-title" className={`flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-md border shadow-2xl ${panel}`}>
        <header className={`border-b px-5 py-4 ${isDark ? 'border-white/10 bg-white/[0.02]' : 'border-slate-200 bg-slate-50/70'}`}>
          <div className="flex items-start gap-4">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded ${isLong ? (isDark ? 'bg-emerald-400/10 text-emerald-300' : 'bg-emerald-50 text-emerald-600') : (isDark ? 'bg-rose-400/10 text-rose-300' : 'bg-rose-50 text-rose-600')}`}>
              {isLong ? <ArrowUpRight size={21} /> : <ArrowDownRight size={21} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="backtest-trade-review-title" className="text-xl font-black tracking-tight">{trade.instrument ?? trade.symbol}</h2>
                <span className={`rounded border px-2 py-1 text-[9px] font-black uppercase tracking-wider ${isLong ? (isDark ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700') : (isDark ? 'border-rose-400/25 bg-rose-400/10 text-rose-300' : 'border-rose-200 bg-rose-50 text-rose-700')}`}>{trade.direction}</span>
                <span className={`rounded border px-2 py-1 text-[9px] font-black uppercase tracking-wider ${isValid ? (isDark ? 'border-emerald-400/25 text-emerald-300' : 'border-emerald-200 text-emerald-700') : (isDark ? 'border-rose-400/25 text-rose-300' : 'border-rose-200 text-rose-700')}`}>{isValid ? 'Validní' : 'Mimo plán'}</span>
              </div>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">{tradeDate} · {trade.session ?? 'Bez session'}{trade.signal ? ` · ${trade.signal}` : ''}</p>
            </div>
            <div className="text-right">
              <p className="text-[8px] font-black uppercase tracking-[0.18em] text-slate-500">Výsledek</p>
              <p className={`mt-0.5 text-xl font-black tabular-nums ${trade.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{trade.pnl >= 0 ? '+' : '−'}${Math.abs(trade.pnl).toFixed(2)}</p>
            </div>
            <button type="button" onClick={onClose} className={`flex h-8 w-8 shrink-0 items-center justify-center rounded ${isDark ? 'hover:bg-white/10' : 'hover:bg-slate-100'}`} aria-label="Zavřít review"><X size={17} /></button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[0.88fr_1.12fr]">
          <div className="space-y-4">
            <section className={`overflow-hidden rounded border ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
              <div className={`flex items-center gap-2 border-b px-3 py-2.5 ${isDark ? 'border-white/10 bg-white/[0.025]' : 'border-slate-200 bg-slate-50'}`}>
                <Target size={14} className="text-blue-500" />
                <h3 className="text-[10px] font-black uppercase tracking-[0.14em]">Exekuce obchodu</h3>
              </div>
              <dl className={`grid grid-cols-2 gap-px ${isDark ? 'bg-white/10' : 'bg-slate-200'}`}>
                {executionValues.map(item => (
                  <div key={item.label} className={`px-3 py-2.5 ${isDark ? 'bg-[#10161f]' : 'bg-white'}`}>
                    <dt className="text-[8px] font-black uppercase tracking-wider text-slate-500">{item.label}</dt>
                    <dd className="mt-1 text-sm font-black tabular-nums">{item.value}</dd>
                  </div>
                ))}
              </dl>
              {collectedValues.length ? (
                <dl className={`grid grid-cols-2 gap-px border-t ${isDark ? 'border-white/10 bg-white/10' : 'border-slate-200 bg-slate-200'}`}>
                  {collectedValues.map(item => (
                    <div key={item.label} className={`min-w-0 px-3 py-2 ${isDark ? 'bg-[#151b24]' : 'bg-slate-50/80'}`}>
                      <dt className="text-[8px] font-black uppercase tracking-wider text-slate-500">{item.label}</dt>
                      <dd className="mt-0.5 truncate text-[11px] font-bold tabular-nums">{item.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </section>

            <section className={`rounded border p-3 ${isDark ? 'border-white/10 bg-white/[0.02]' : 'border-slate-200 bg-white'}`}>
              <div className="mb-2 flex items-center gap-2"><Check size={14} className="text-emerald-500" /><h3 className="text-[10px] font-black uppercase tracking-[0.14em]">Vyhodnocení plánu</h3></div>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setIsValid(true)} className={`h-10 rounded border text-[10px] font-black uppercase tracking-wide ${isValid ? 'border-emerald-500 bg-emerald-500 text-white' : field}`}>Validní / podle plánu</button>
                <button type="button" onClick={() => setIsValid(false)} className={`h-10 rounded border text-[10px] font-black uppercase tracking-wide ${!isValid ? 'border-rose-500 bg-rose-500 text-white' : field}`}>Nevalidní / mimo plán</button>
              </div>
            </section>

            <section className={`rounded border p-3 ${isDark ? 'border-white/10 bg-white/[0.02]' : 'border-slate-200 bg-white'}`}>
              <div className="mb-2 flex items-center gap-2"><FileText size={14} className="text-slate-400" /><label htmlFor="backtest-review-notes" className="text-[10px] font-black uppercase tracking-[0.14em]">Poznámka k obchodu</label></div>
              <textarea id="backtest-review-notes" value={notes} onChange={event => setNotes(event.target.value)} rows={5} placeholder="Co jsem viděl, proč jsem vstoupil, co bych příště změnil…" className={`w-full resize-y rounded border px-3 py-2.5 text-sm outline-none focus:border-blue-500 ${field}`} />
            </section>
          </div>

          <div className="space-y-4">
            {onRecalculate ? (
              <section className={`rounded border p-3 ${isDark ? 'border-blue-400/20 bg-blue-400/[0.04]' : 'border-blue-200 bg-blue-50/50'}`}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2"><RefreshCw size={14} className="text-blue-500" /><h3 className="text-[10px] font-black uppercase tracking-[0.14em]">Data z indikátoru</h3></div>
                    <p className="mt-1 text-[10px] font-semibold text-slate-500">Znovu načte strukturu, FVG, levely a metriky ze stejných replay dat.</p>
                  </div>
                  <button type="button" onClick={() => void recalculate()} disabled={recalculating} className="flex h-9 shrink-0 items-center gap-2 rounded border border-blue-500 px-3 text-[10px] font-black uppercase tracking-wide text-blue-500 hover:bg-blue-500 hover:text-white disabled:opacity-50">
                    {recalculating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                    Přepočítat
                  </button>
                </div>
                {recalculationChanges ? (
                  <div className={`mt-3 border-t pt-3 ${isDark ? 'border-white/10' : 'border-blue-200'}`} data-backtest-recalculation-preview>
                    {recalculationChanges.length ? (
                      <>
                        <p className="mb-2 text-[9px] font-black uppercase tracking-wide text-blue-500">Náhled změn · zatím neuloženo</p>
                        <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
                          {recalculationChanges.map(change => (
                            <div key={change.label} className={`grid grid-cols-[6rem_1fr_auto_1fr] items-center gap-2 rounded px-2 py-1.5 text-[9px] ${isDark ? 'bg-black/20' : 'bg-white'}`}>
                              <span className="font-black uppercase tracking-wide text-slate-500">{change.label}</span>
                              <span className="min-w-0 truncate text-slate-400 line-through" title={change.before}>{change.before}</span>
                              <span className="text-blue-500">→</span>
                              <span className="min-w-0 truncate font-bold" title={change.after}>{change.after}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : <p className="text-[10px] font-bold text-emerald-500">Uložená data už odpovídají aktuálnímu indikátoru.</p>}
                  </div>
                ) : null}
              </section>
            ) : null}
            <section className={`rounded border ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
              <div className={`border-b px-3 py-3 ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
                <div className="flex items-center gap-2"><Zap size={14} className="text-violet-500" /><h3 className="text-[10px] font-black uppercase tracking-[0.14em]">Entry Confluence</h3></div>
                <ConfluenceCapsuleEditor value={ltfConfluence} onChange={setLtfConfluence} isDark={isDark} addLabel="Přidat Entry Confluence" />
                <div className="mt-3 grid gap-2 sm:grid-cols-2" data-backtest-entry-audit>
                  {entryAudit.map(item => {
                    const tone = item.tone === 'pass'
                      ? isDark ? 'border-emerald-400/20 bg-emerald-400/[0.06]' : 'border-emerald-200 bg-emerald-50/70'
                      : item.tone === 'fail'
                        ? isDark ? 'border-rose-400/20 bg-rose-400/[0.06]' : 'border-rose-200 bg-rose-50/70'
                        : item.tone === 'info'
                          ? isDark ? 'border-sky-400/20 bg-sky-400/[0.05]' : 'border-sky-200 bg-sky-50/70'
                          : isDark ? 'border-white/10 bg-white/[0.025]' : 'border-slate-200 bg-slate-50';
                    const dot = item.tone === 'pass' ? 'bg-emerald-500'
                      : item.tone === 'fail' ? 'bg-rose-500'
                        : item.tone === 'info' ? 'bg-sky-500' : 'bg-slate-400';
                    return (
                      <div key={item.label} className={`min-w-0 rounded border px-2.5 py-2 ${tone}`}>
                        <div className="flex items-center gap-1.5">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                          <p className="text-[8px] font-black uppercase tracking-[0.12em] text-slate-500">{item.label}</p>
                        </div>
                        <p className="mt-1 truncate text-[10px] font-black uppercase tracking-wide" title={item.value}>{item.value}</p>
                        <p className="mt-0.5 truncate text-[9px] font-semibold text-slate-500" title={item.detail}>{item.detail}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className={`px-3 py-3 ${levelTags.length ? (isDark ? 'border-b border-white/10' : 'border-b border-slate-200') : ''}`}>
                <div className="flex items-center gap-2"><Layers3 size={14} className="text-sky-500" /><h3 className="text-[10px] font-black uppercase tracking-[0.14em]">HTF Confluence</h3></div>
                <ConfluenceCapsuleEditor value={htfConfluence} onChange={setHtfConfluence} isDark={isDark} addLabel="Přidat HTF Confluence" />
              </div>
              {levelTags.length ? (
                <div className="px-3 py-3">
                  <div className="flex items-center gap-2"><Waves size={14} className="text-amber-500" /><h3 className="text-[10px] font-black uppercase tracking-[0.14em]">Levely</h3></div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {levelTags.map(tag => <span key={tag} className={`rounded-lg border px-2 py-1 text-[9px] font-black uppercase tracking-wide ${isDark ? 'border-amber-400/20 bg-amber-400/10 text-amber-400' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>{tag}</span>)}
                  </div>
                </div>
              ) : null}
            </section>

            <section className={`overflow-hidden rounded border ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
              <div className={`flex items-center gap-2 border-b px-3 py-2.5 ${isDark ? 'border-white/10 bg-white/[0.025]' : 'border-slate-200 bg-slate-50'}`}><Camera size={14} className="text-blue-500" /><h3 className="text-[10px] font-black uppercase tracking-[0.14em]">Snapshot grafů</h3></div>
              {snapshotPreview ? (
                <div className="relative bg-slate-950">
                  <button type="button" onClick={() => setSnapshotZoomOpen(true)} className="group block w-full cursor-zoom-in" aria-label="Zvětšit náhled snapshotu">
                    <img src={snapshotPreview} alt={snapshot ? 'Nový snapshot všech otevřených grafů' : 'Uložený snapshot obchodu'} className="aspect-video w-full object-contain" />
                    <span className="pointer-events-none absolute left-2 top-2 rounded bg-slate-950/75 px-2 py-1 text-[9px] font-black uppercase tracking-wide text-white">{snapshot ? 'Nový náhled · všechny grafy' : 'Uložený snapshot'}</span>
                    <span className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded bg-slate-950/75 px-2 py-1 text-[9px] font-black uppercase tracking-wide text-white opacity-80 transition-opacity group-hover:opacity-100"><Maximize2 size={12} /> Zvětšit</span>
                  </button>
                  {snapshot ? <button type="button" onClick={() => { setSnapshot(undefined); setSnapshotZoomOpen(false); }} className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded bg-slate-950/75 text-white" aria-label="Zahodit nový snapshot"><X size={14} /></button> : null}
                </div>
              ) : (
                <div className={`flex aspect-video flex-col items-center justify-center gap-2 ${isDark ? 'bg-white/[0.025]' : 'bg-slate-50'}`}>
                  <ImageIcon size={24} className="text-slate-400" />
                  <p className="text-center text-[11px] font-semibold text-slate-500">Vyfotí se celý viditelný layout se všemi grafy.<br />Nahraje se až při uložení review.</p>
                </div>
              )}
              <button type="button" onClick={() => void captureSnapshot()} disabled={capturing} className={`flex h-10 w-full items-center justify-center gap-2 border-t text-xs font-black disabled:cursor-wait disabled:opacity-60 ${isDark ? 'border-white/10 hover:bg-white/[0.05]' : 'border-slate-200 hover:bg-slate-50'}`}>{capturing ? <Loader2 size={15} className="animate-spin" /> : <Camera size={15} />}{capturing ? 'Pořizuji všechny grafy…' : snapshotPreview ? 'Vyfotit nový snapshot všech grafů' : 'Snapshot všech grafů'}</button>
            </section>
          </div>
        </div>

        <footer className={`flex items-center gap-3 border-t px-5 py-3 ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
          {error ? <p role="alert" className="mr-auto text-xs font-bold text-rose-500">{error}</p> : <p className="mr-auto text-[10px] font-semibold text-slate-500">Manuální režim · žádný automatický snapshot</p>}
          <button type="button" onClick={onClose} className={`h-9 rounded-md px-4 text-xs font-black ${isDark ? 'hover:bg-white/10' : 'hover:bg-slate-100'}`}>Zrušit</button>
          <button type="button" onClick={() => void save()} disabled={saving} className="flex h-9 items-center gap-2 rounded-md bg-blue-600 px-4 text-xs font-black text-white hover:bg-blue-500 disabled:opacity-50">{saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Uložit review</button>
        </footer>
      </section>
      {snapshotZoomOpen && snapshotPreview ? (
        <div
          data-backtest-snapshot-lightbox
          className="fixed inset-0 z-[980] flex flex-col items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Zvětšený náhled snapshotu všech grafů"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setSnapshotZoomOpen(false);
          }}
        >
          <button type="button" onClick={() => setSnapshotZoomOpen(false)} className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-md border border-white/15 bg-black/60 text-white hover:bg-white/10" aria-label="Zavřít zvětšený náhled"><X size={20} /></button>
          <img src={snapshotPreview} alt="Zvětšený snapshot všech otevřených grafů" className="max-h-[calc(100vh-5rem)] max-w-[calc(100vw-2rem)] object-contain shadow-2xl" />
          <p className="mt-3 text-[10px] font-bold uppercase tracking-wider text-white/60">Klikni mimo obrázek nebo stiskni Esc</p>
        </div>
      ) : null}
    </div>
  );
};

export default BacktestTradeReviewDialog;
