import TradeNoteHistoryEditor from './TradeNoteHistoryEditor';
import { buildTradeNoteHistoryPatch, createTradeNoteDrafts, type TradeNoteCaptureContext, type TradeNoteHistoryPatch } from '../services/tradeNoteHistory';
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
  Tags,
  Waves,
  X,
  Zap,
} from 'lucide-react';
import { changedTradeFields } from '../services/tradePatch';
import type { Trade } from '../types';
import {
  buildBacktestTradeRecalculationUpdates,
  describeBacktestTradeRecalculation,
  reconcileBacktestConfluenceProvenance,
  type BacktestTradeRecalculationChange,
} from '../services/backtestTradeRecalculation';

import { normalizeTradeTags, type BacktestTagSuggestions } from '../services/backtestTagCatalog';

interface Props {
  trade: Trade;
  isDark: boolean;
  tagSuggestions?: BacktestTagSuggestions;
  noteCaptureContext?: TradeNoteCaptureContext;
  onClose: () => void;
  onCaptureSnapshot: () => string | Promise<string>;
  onRecalculate?: () => Trade | Promise<Trade>;
  onSave: (updates: Partial<Trade>, snapshotDataUrl?: string, expected?: Partial<Trade>) => Promise<void>;
}

const splitTags = (value: string) => normalizeTradeTags(value.split(','));

const joinTags = (values?: string[]) => (values ?? []).join(', ');

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
  disabled?: boolean;
  suggestions?: readonly string[];
  autoTags?: readonly string[];
  onManualAdd?: (tags: string[]) => void;
}> = ({ value, onChange, isDark, addLabel, disabled = false, suggestions = [], autoTags = [], onManualAdd }) => {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const cancelled = useRef(false);
  const tags = splitTags(value);
  const selected = new Set(tags.map(tag => tag.toLocaleLowerCase('cs')));
  const choices = normalizeTradeTags(suggestions).filter(tag => !selected.has(tag.toLocaleLowerCase('cs'))
    && tag.toLocaleLowerCase('cs').includes(draft.trim().toLocaleLowerCase('cs')));
  const addTags = (additions: string[]) => {
    if (additions.length) {
      onManualAdd?.(additions);
      onChange(normalizeTradeTags([...tags, ...additions]).join(', '));
    }
    setDraft('');
    setAdding(false);
  };
  const commitDraft = () => {
    if (!cancelled.current) addTags(splitTags(draft));
  };

  return (
    <div className="mt-2 flex min-h-8 flex-wrap items-center gap-1.5">
      {tags.map(tag => (
        <span key={tag} className={`inline-flex items-center gap-1 rounded-lg border py-1 pl-2 pr-1 text-[11px] font-semibold ${getConfluenceTone(tag, isDark)}`}>
          {tag}
          {autoTags.includes(tag) && <span className="text-[7px] opacity-60" title="Automaticky z indikátoru">Auto</span>}
          <button disabled={disabled} type="button" onClick={() => onChange(tags.filter(item => item !== tag).join(', '))} className="flex h-4 w-4 items-center justify-center rounded hover:bg-black/10" aria-label={`Odebrat ${tag}`}><X size={10} /></button>
        </span>
      ))}
      {adding ? (
        <div className="min-w-40 flex-1">
          <input
            disabled={disabled}
            autoFocus
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                commitDraft();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelled.current = true;
                setDraft('');
                setAdding(false);
              }
            }}
            aria-label={addLabel}
            placeholder="Napiš vlastní tag nebo vyber níže"
            className={`h-8 w-full rounded-lg border px-2 text-[10px] font-bold outline-none focus:border-blue-500 ${isDark ? 'border-[var(--border-subtle)] bg-[var(--bg-page)]' : 'border-[var(--border-subtle)] bg-[var(--bg-card)]'}`}
          />
          {choices.length > 0 && <div className="mt-1 flex max-h-24 flex-wrap gap-1 overflow-y-auto" aria-label="Dříve použité tagy">
            {choices.map(tag => <button disabled={disabled} key={tag} type="button" onMouseDown={event => event.preventDefault()} onClick={() => addTags([tag])} className={`rounded border px-2 py-1 text-[10px] ${getConfluenceTone(tag, isDark)}`}>{tag}</button>)}
          </div>}
        </div>
      ) : (
        <button disabled={disabled} type="button" onClick={() => { cancelled.current = false; setAdding(true); }} className={`inline-flex h-7 items-center gap-1 rounded-lg border border-dashed px-2 text-[11px] font-semibold ${isDark ? 'border-white/15 text-slate-400 hover:border-white/30' : 'border-slate-300 text-slate-500 hover:border-slate-400'}`}><Plus size={11} /> {addLabel}</button>
      )}
    </div>
  );
};

const finitePrice = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Obchod jako pravítko: SL – vstup – TP na jedné cenové ose (riziko červeně,
 * cíl zeleně), značka výstupu a pod tím výsledek v R s pruhy MFE / MAE.
 */
const TradeRuler: React.FC<{ trade: Trade; isDark: boolean }> = ({ trade, isDark }) => {
  const { entryPrice: entry, exitPrice: exit, stopLoss: stop, takeProfit: target } = trade;
  const r = trade.riskAmount ? trade.pnl / trade.riskAmount : null;
  const prices = [entry, exit, stop, target].filter(finitePrice);
  const line = isDark ? 'border-white/10' : 'border-slate-200';
  const win = trade.pnl >= 0;
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const position = (value: number) => (high > low ? 6 + ((value - low) / (high - low)) * 88 : 50);
  const label = (value: number, text: string, tone: string, row: 'above' | 'below') => {
    const at = position(value);
    const align = at < 14 ? 'translate-x-0' : at > 86 ? '-translate-x-full' : '-translate-x-1/2';
    return (
      <div className={`absolute ${row === 'above' ? 'top-2' : 'top-[60px]'} ${align} whitespace-nowrap ${at < 14 ? 'text-left' : at > 86 ? 'text-right' : 'text-center'}`} style={{ left: `calc(${at}% )` }}>
        <div className={`text-[9.5px] font-extrabold uppercase tracking-[0.08em] ${tone}`}>{text}</div>
        <div className="font-mono text-[12px] font-semibold leading-tight tabular-nums">{value.toFixed(2)}</div>
      </div>
    );
  };
  const scale = Math.max(1, Math.abs(r ?? 0), trade.mfeR ?? 0, trade.maeR ?? 0);
  const bound = trade.excursionAmbiguous ? '≥' : '';
  const bar = (value: number | undefined, color: string) => (
    <div className={`mt-1.5 h-1.5 overflow-hidden rounded-full ${isDark ? 'bg-white/[0.06]' : 'bg-slate-100'}`}>
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, ((value ?? 0) / scale) * 100)}%` }} />
    </div>
  );
  return (
    <div className={`overflow-hidden rounded-lg border ${line}`} data-backtest-trade-ruler>
      {finitePrice(entry) && prices.length >= 2 ? (
        <div className="relative mx-4 h-[96px]">
          {finitePrice(exit) && label(exit, 'Exit', win ? 'text-emerald-500' : 'text-rose-500', 'above')}
          <div className={`absolute inset-x-0 top-[44px] h-2 rounded-full ${isDark ? 'bg-white/[0.06]' : 'bg-slate-100'}`}>
            {finitePrice(stop) && (
              <div className="absolute inset-y-0 rounded-full bg-gradient-to-r from-rose-500/80 to-rose-500/40"
                style={{ left: `${Math.min(position(stop), position(entry))}%`, width: `${Math.abs(position(entry) - position(stop))}%` }} />
            )}
            {finitePrice(target) && (
              <div className="absolute inset-y-0 rounded-full bg-gradient-to-r from-emerald-500/40 to-emerald-500/80"
                style={{ left: `${Math.min(position(target), position(entry))}%`, width: `${Math.abs(position(target) - position(entry))}%` }} />
            )}
            <div className={`absolute top-1/2 h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full ${isDark ? 'bg-white' : 'bg-slate-800'}`} style={{ left: `${position(entry)}%` }} />
            {finitePrice(exit) && (
              <div className={`absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${isDark ? 'border-[#10161f]' : 'border-white'} ${win ? 'bg-emerald-500' : 'bg-rose-500'} shadow`} style={{ left: `${position(exit)}%` }} />
            )}
          </div>
          {finitePrice(stop) && label(stop, 'SL', 'text-rose-500', 'below')}
          {label(entry, 'Entry', 'text-slate-500', 'below')}
          {finitePrice(target) && label(target, 'TP', 'text-emerald-500', 'below')}
        </div>
      ) : null}
      <div className={`grid grid-cols-3 border-t ${line}`}>
        <div className={`border-r px-3 py-2.5 ${line}`}>
          <div className="text-[9.5px] font-extrabold uppercase tracking-[0.08em] text-slate-500">Výsledek</div>
          <div className={`font-mono text-[17px] font-black tabular-nums ${win ? 'text-emerald-500' : 'text-rose-500'}`}>{r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`}</div>
        </div>
        <div className={`border-r px-3 py-2.5 ${line}`} title={trade.excursionAmbiguous ? 'Prokazatelná dolní mez — pořadí cen uvnitř svíčky není známé' : 'Největší pohyb ve prospěch obchodu'}>
          <div className="flex items-baseline justify-between"><span className="text-[9.5px] font-extrabold uppercase tracking-[0.08em] text-slate-500">MFE</span><span className="font-mono text-[12.5px] font-semibold tabular-nums text-emerald-500">{trade.mfeR != null ? `${bound}${trade.mfeR.toFixed(2)}R` : '—'}</span></div>
          {bar(trade.mfeR, 'bg-emerald-500')}
        </div>
        <div className="px-3 py-2.5" title={trade.excursionAmbiguous ? 'Prokazatelná dolní mez — pořadí cen uvnitř svíčky není známé' : 'Největší pohyb proti obchodu'}>
          <div className="flex items-baseline justify-between"><span className="text-[9.5px] font-extrabold uppercase tracking-[0.08em] text-slate-500">MAE</span><span className="font-mono text-[12.5px] font-semibold tabular-nums text-rose-500">{trade.maeR != null ? `${bound}${trade.maeR.toFixed(2)}R` : '—'}</span></div>
          {bar(trade.maeR, 'bg-rose-500')}
        </div>
      </div>
    </div>
  );
};

/** Rychlé čipy disciplíny — ukládají se mezi tagy obchodu. */
export const BACKTEST_DISCIPLINE_TAGS = ['Čistá exekuce', 'Pozdní vstup', 'FOMO', 'Posunutý SL', 'Brzký exit', 'Revenge'] as const;

/**
 * Backtest: obchod je vždy validní — co validní není, se smaže. Typ setupu
 * karta už neupravuje, takže se posílá jen tehdy, když ho volající zadá.
 */
export const buildBacktestTradeReviewUpdates = ({
  notes,
  tags,
  htfConfluence,
  ltfConfluence,
  isValid = true,
  setupType,
}: {
  notes: string;
  tags?: string;
  htfConfluence: string;
  ltfConfluence: string;
  isValid?: boolean;
  setupType?: NonNullable<Trade['setupType']>;
}): Partial<Trade> => ({
  notes: notes.trim(),
  ...(tags !== undefined ? { tags: splitTags(tags) } : {}),
  htfConfluence: splitTags(htfConfluence),
  ltfConfluence: splitTags(ltfConfluence),
  isValid,
  executionStatus: isValid ? 'Valid' : 'Invalid',
  planAdherence: isValid ? 'Yes' : 'No',
  ...(setupType !== undefined ? { setupType } : {}),
});

const BacktestTradeReviewContent: React.FC<Props> = ({
  trade,
  isDark,
  tagSuggestions,
  noteCaptureContext,
  onClose,
  onCaptureSnapshot,
  onRecalculate,
  onSave,
}) => {
  const [originalTrade] = useState(() => structuredClone(trade));
  const [notes, setNotes] = useState(trade.notes ?? '');
  const [noteDrafts, setNoteDrafts] = useState(() => {
    try { return createTradeNoteDrafts(trade.noteHistory); }
    catch { return { before: '', during: '', after: '' }; }
  });
  const noteOperationRef = useRef<TradeNoteHistoryPatch | undefined>(undefined);
  const noteContext: TradeNoteCaptureContext = noteCaptureContext ?? {
    marketTime: null, maxRevealedMarketTime: null,
    entryMarketTime: Number.isFinite(trade.entryTime) ? trade.entryTime! / 1000 : null,
    exitMarketTime: Number.isFinite(trade.timestamp) ? trade.timestamp / 1000 : null,
    closedTradeReview: true,
  };
  const [tags, setTags] = useState(joinTags(trade.tags));
  const manualTags = useRef<{ htf: string[]; ltf: string[] }>({ htf: [], ltf: [] });
  const [htfConfluence, setHtfConfluence] = useState(joinTags(trade.htfConfluence));
  const [ltfConfluence, setLtfConfluence] = useState(joinTags(trade.ltfConfluence));
  const [snapshot, setSnapshot] = useState<string>();
  const [snapshotZoomOpen, setSnapshotZoomOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recalculatedUpdates, setRecalculatedUpdates] = useState<Partial<Trade>>({});
  const [recalculationChanges, setRecalculationChanges] = useState<BacktestTradeRecalculationChange[]>();
  const [error, setError] = useState<string>();
  const captureRequestRef = useRef(0);


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
  const selectedProvenance = () => reconcileBacktestConfluenceProvenance(displayTrade, { htf: splitTags(htfConfluence), ltf: splitTags(ltfConfluence) }, manualTags.current);
  const autoTags = selectedProvenance();
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
  const recalculate = async () => {
    if (!onRecalculate) return;
    setRecalculating(true);
    setError(undefined);
    try {
      const recalculated = await onRecalculate();
      const current = {
        ...trade,
        ...recalculatedUpdates,
        autoConfluence: selectedProvenance(),
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
      const baseline = originalTrade;
      const phasedPatch = noteOperationRef.current ?? buildTradeNoteHistoryPatch(noteDrafts, baseline.noteHistory, noteContext,
        { operationId: crypto.randomUUID(), clientCapturedAt: Date.now() });
      noteOperationRef.current = phasedPatch;
      const normalizedBaseline = {
        ...baseline,
        ...buildBacktestTradeReviewUpdates({ notes: baseline.notes ?? '', tags: joinTags(baseline.tags),
          htfConfluence: joinTags(baseline.htfConfluence), ltfConfluence: joinTags(baseline.ltfConfluence),
          isValid: baseline.isValid !== false && baseline.executionStatus !== 'Invalid' }),
        autoConfluence: baseline.autoConfluence ?? { htf: [], ltf: [] },
      };
      const patch = changedTradeFields(normalizedBaseline, {
        ...recalculatedUpdates,
        ...(phasedPatch.changed ? { noteHistory: phasedPatch.history } : {}),
        autoConfluence: selectedProvenance(),
        ...buildBacktestTradeReviewUpdates({
          notes,
          tags,
          htfConfluence,
          ltfConfluence,
        }),
      });
      await onSave({ ...patch, needsReview: false }, snapshot, baseline);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Review obchodu se nepodařilo uložit.');
    } finally {
      setSaving(false);
    }
  };

  // Automatický snímek celého obchodu hned po otevření (uloží se s review).
  useEffect(() => {
    if (!savedSnapshot) void captureSnapshot();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- jen při otevření karty
  }, []);

  const disciplineSet = new Set<string>(BACKTEST_DISCIPLINE_TAGS);
  const tagList = splitTags(tags);
  const customTags = tagList.filter(tag => !disciplineSet.has(tag));
  const toggleDiscipline = (tag: string) => {
    setTags(joinTags(tagList.includes(tag) ? tagList.filter(item => item !== tag) : [...tagList, tag]));
  };
  const resultR = displayTrade.riskAmount ? displayTrade.pnl / displayTrade.riskAmount : null;

  const panel = isDark
    ? 'border-white/10 bg-[#10161f] text-slate-100 shadow-black/60'
    : 'border-slate-200 bg-white text-slate-900 shadow-slate-900/20';
  const field = isDark
    ? 'border-white/10 bg-white/[0.04] text-slate-100 placeholder:text-slate-600'
    : 'border-slate-200 bg-slate-50 text-slate-900 placeholder:text-slate-400';
  const line = isDark ? 'border-white/10' : 'border-slate-200';
  const sectionTitle = 'flex items-center gap-2 text-[12px] font-bold';
  const chip = (on: boolean) => `inline-flex h-7 items-center rounded-full border px-3 text-[11.5px] font-semibold transition-colors ${on
    ? isDark ? 'border-amber-400/45 bg-amber-400/15 text-amber-300' : 'border-amber-300 bg-amber-50 text-amber-700'
    : isDark ? 'border-white/15 text-slate-300 hover:border-white/30' : 'border-slate-300 text-slate-600 hover:border-slate-400'}`;

  return (
    <div className="fixed inset-0 z-[900] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={event => {
      if (!saving && event.target === event.currentTarget) onClose();
    }}>
      <section data-backtest-trade-review role="dialog" aria-modal="true" aria-labelledby="backtest-trade-review-title" className={`flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border shadow-2xl ${panel}`}>
        <header className={`flex items-center gap-3 border-b px-5 py-3.5 ${line}`}>
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${isLong ? (isDark ? 'bg-emerald-400/10 text-emerald-300' : 'bg-emerald-50 text-emerald-600') : (isDark ? 'bg-rose-400/10 text-rose-300' : 'bg-rose-50 text-rose-600')}`}>
            {isLong ? <ArrowUpRight size={19} /> : <ArrowDownRight size={19} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="backtest-trade-review-title" className="text-lg font-black tracking-tight">{trade.instrument ?? trade.symbol}</h2>
              <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${isLong ? (isDark ? 'bg-emerald-400/15 text-emerald-300' : 'bg-emerald-50 text-emerald-700') : (isDark ? 'bg-rose-400/15 text-rose-300' : 'bg-rose-50 text-rose-700')}`}>{trade.direction}</span>
              <span className="text-[12px] font-semibold text-slate-500">{tradeDate} · {trade.session ?? 'Bez session'}{trade.signal ? ` · ${trade.signal}` : ''}</span>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-semibold text-slate-500">Výsledek</p>
            <p className={`font-mono text-lg font-black tabular-nums ${trade.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{trade.pnl >= 0 ? '+' : '−'}${Math.abs(trade.pnl).toFixed(2)}{resultR != null ? ` · ${resultR.toFixed(2)}R` : ''}</p>
          </div>
          <button type="button" disabled={saving} onClick={onClose} className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${isDark ? 'hover:bg-white/10' : 'hover:bg-slate-100'}`} aria-label="Zavřít review"><X size={17} /></button>
        </header>

        <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[1.4fr_1fr]">
          {/* Vlevo: snímek celého obchodu, čísla, detail z indikátoru. */}
          <div className={`space-y-3 p-4 lg:border-r ${line}`}>
            <div className={`relative overflow-hidden rounded-lg border ${line} bg-[#0b0f15]`}>
              {snapshotPreview ? (
                <button type="button" onClick={() => setSnapshotZoomOpen(true)} className="group block w-full cursor-zoom-in" aria-label="Zvětšit náhled snapshotu">
                  <img src={snapshotPreview} alt={snapshot ? 'Automatický snímek celého obchodu' : 'Uložený snapshot obchodu'} className="block aspect-[1600/900] w-full object-contain" />
                  <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-slate-950/75 px-2 py-1 text-[10.5px] font-bold text-white">{snapshot ? 'Auto snímek · celý obchod' : 'Uložený snapshot'}</span>
                  <span className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-slate-950/75 px-2 py-1 text-[10.5px] font-bold text-white opacity-0 transition-opacity group-hover:opacity-100"><Maximize2 size={12} /> Zvětšit</span>
                </button>
              ) : (
                <div className="flex aspect-[1600/900] flex-col items-center justify-center gap-2 text-slate-500">
                  {capturing ? <Loader2 size={22} className="animate-spin text-blue-500" /> : <ImageIcon size={22} />}
                  <p className="text-center text-[11.5px] font-semibold">{capturing ? 'Fotím celý obchod…' : 'Snímek obchodu se nepodařilo pořídit.'}</p>
                </div>
              )}
              <button type="button" onClick={() => void captureSnapshot()} disabled={saving || capturing} className="absolute right-2 top-2 flex h-7 items-center gap-1.5 rounded-md bg-slate-950/75 px-2 text-[10.5px] font-bold text-white hover:bg-slate-900 disabled:opacity-60" title="Vyfotí obchod znovu z aktuálního grafu (i s tím, co cena udělala po výstupu)">
                {capturing ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />} Přefotit obchod
              </button>
            </div>
            <TradeRuler trade={displayTrade} isDark={isDark} />
            {displayTrade.outcomeAmbiguous && <p className="text-[11px] text-amber-500">Pořadí vstupu a zásahů SL/TP není z OHLC jisté. Engine použil konzervativní výsledek.</p>}
            <section>
              <label htmlFor="backtest-review-notes" className={sectionTitle}><FileText size={14} className="text-slate-400" /> Popis obchodu</label>
              <textarea disabled={saving} id="backtest-review-notes" value={notes} onChange={event => setNotes(event.target.value)} rows={6} placeholder="Co jsem viděl, proč jsem vstoupil, jak jsem obchod vedl, co bych příště změnil…" className={`mt-2 w-full resize-y rounded-lg border px-3 py-2.5 text-sm leading-relaxed outline-none focus:border-blue-500 ${field}`} />
            </section>
          </div>

          {/* Vpravo: jen to, co má smysl psát. */}
          <div className="min-w-0">
            <section className={`border-b px-4 py-3.5 ${line}`}>
              <div className="flex items-center gap-2">
                <h3 className={sectionTitle}><Zap size={14} className="text-violet-500" /> Confluence</h3>
                {onRecalculate ? (
                  <button type="button" onClick={() => void recalculate()} disabled={saving || recalculating} className="ml-auto flex h-7 items-center gap-1.5 rounded-md border border-blue-500/60 px-2 text-[10.5px] font-bold text-blue-500 hover:bg-blue-500 hover:text-white disabled:opacity-50" title="Znovu načte strukturu, FVG, levely a metriky ze stejných replay dat">
                    {recalculating ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Přepočítat
                  </button>
                ) : null}
              </div>
              <p className="mt-1 text-[10.5px] text-slate-500">Auto z indikátoru — co nesedí, odeber křížkem.</p>
              <p className="mt-3 text-[10.5px] font-bold uppercase tracking-[0.06em] text-slate-500">Entry Confluence</p>
              <ConfluenceCapsuleEditor disabled={saving || recalculating} value={ltfConfluence} onChange={setLtfConfluence} isDark={isDark} addLabel="Přidat Entry Confluence" suggestions={tagSuggestions?.ltf} autoTags={autoTags.ltf} onManualAdd={added => { manualTags.current.ltf.push(...added); }} />
              <p className="mt-3 text-[10.5px] font-bold uppercase tracking-[0.06em] text-slate-500">HTF Confluence</p>
              <ConfluenceCapsuleEditor disabled={saving || recalculating} value={htfConfluence} onChange={setHtfConfluence} isDark={isDark} addLabel="Přidat HTF Confluence" suggestions={tagSuggestions?.htf} autoTags={autoTags.htf} onManualAdd={added => { manualTags.current.htf.push(...added); }} />
              {recalculationChanges ? (
                <div className={`mt-3 border-t pt-3 ${line}`} data-backtest-recalculation-preview>
                  {recalculationChanges.length ? (
                    <>
                      <p className="mb-2 text-[11px] font-semibold text-blue-500">Náhled změn · zatím neuloženo</p>
                      <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
                        {recalculationChanges.map(change => (
                          <div key={change.label} className={`grid grid-cols-[6rem_1fr_auto_1fr] items-center gap-2 rounded px-2 py-1.5 text-[9px] ${isDark ? 'bg-[var(--bg-page)]' : 'bg-[var(--bg-card)]'}`}>
                            <span className="font-semibold text-slate-500">{change.label}</span>
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

            <section className={`border-b px-4 py-3.5 ${line}`}>
              <h3 className={sectionTitle}><Check size={14} className="text-emerald-500" /> Disciplína</h3>
              <div className="mt-2.5 flex flex-wrap gap-1.5" data-backtest-discipline>
                {BACKTEST_DISCIPLINE_TAGS.map(tag => (
                  <button key={tag} type="button" disabled={saving} aria-pressed={tagList.includes(tag)} onClick={() => toggleDiscipline(tag)} className={chip(tagList.includes(tag))}>{tag}</button>
                ))}
              </div>
              <div className="mt-1"><ConfluenceCapsuleEditor disabled={saving || recalculating} value={joinTags(customTags)} onChange={value => setTags(joinTags([...tagList.filter(tag => disciplineSet.has(tag)), ...splitTags(value)]))} isDark={isDark} addLabel="Vlastní tag" suggestions={(tagSuggestions?.tags ?? []).filter(tag => !disciplineSet.has(tag))} /></div>
            </section>

            <details className="px-4 py-3">
              <summary className="cursor-pointer list-none text-[12px] font-bold text-slate-500 hover:text-slate-300">Poznámky po fázích · před / během / po</summary>
              <div className="mt-3">
                <TradeNoteHistoryEditor baseHistory={originalTrade.noteHistory} legacyNotes={originalTrade.notes}
                  captureContext={noteContext} drafts={noteDrafts} disabled={saving} isDark={isDark}
                  onChange={next => { setNoteDrafts(next); noteOperationRef.current = undefined; }} />
              </div>
            </details>
          </div>
        </div>

        <footer className={`flex items-center gap-3 border-t px-5 py-3 ${line}`}>
          {error ? <p role="alert" className="mr-auto text-xs font-bold text-rose-500">{error}</p> : <p className="mr-auto text-[10.5px] font-semibold text-slate-500">{snapshot ? 'Snímek se pořídil automaticky · uloží se s review' : 'Snímek se uloží s review'}</p>}
          <button type="button" disabled={saving} onClick={onClose} className={`h-9 rounded-lg px-4 text-xs font-black ${isDark ? 'hover:bg-white/10' : 'hover:bg-slate-100'}`}>Zrušit</button>
          <button type="button" onClick={() => void save()} disabled={saving || capturing || recalculating} className="flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-xs font-black text-white hover:bg-blue-500 disabled:opacity-50">{saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Uložit review</button>
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
          <p className="mt-3 text-[11px] font-bold text-white/60">Klikni mimo obrázek nebo stiskni Esc</p>
        </div>
      ) : null}
    </div>
  );
};

// Same-trade background refresh must not reset an unfinished review. A different trade starts a fresh draft.
const BacktestTradeReviewDialog: React.FC<Props> = props => <BacktestTradeReviewContent key={String(props.trade.id)} {...props} />;

export default BacktestTradeReviewDialog;
