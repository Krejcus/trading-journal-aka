import { mergeJournalDetailSelection } from '../services/journalTradeDetail';
import { journalReviewOnly } from '../lib/journalReviewPatch';
import { explicitTradeMaster, isCombinedTrade, journalDisplayBalance, tradeAccountLabel, tradeDetailMembers, tradeDetailSource, tradeEstimateNotice } from '../lib/tradeHistoryPresentation';
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { pointValueFor } from '../services/tradovateImport';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Play, X, Edit3, Trash2, Clock, Image as ImageIcon,
    Maximize2, ArrowRight, Timer, Terminal, ArrowUpRight, ArrowDownRight,
    Share2, Check, ChevronLeft, ChevronRight, ChevronDown, Zap, Brain, FileText, Target,
    ShieldCheck, Layers, Wallet, Save, CornerDownLeft, AlertOctagon
} from 'lucide-react';
import { Trade, Account, CustomEmotion, PnLDisplayMode, User } from '../types';
import { formatTradePnL } from '../utils/formatPnL';
import { ExchangeRates } from '../services/currencyService';
import { storageService } from '../services/storageService';
import { ErrorBoundary } from './ErrorBoundary';
import ImageZoomModal from './ImageZoomModal';
import ConfirmationModal from './ConfirmationModal';
import TradeExecutionIntel from './TradeExecutionIntel';
import TradeConfluence from './TradeConfluence';
const EMPTY_TRADES: Trade[] = [];
const defaultLoadJournalDetails = (ids: readonly string[], signal?: AbortSignal) => storageService.getJournalTradeDetails(ids, signal);
const defaultLoadTradeDetail = (id: string) => storageService.getTradeById(id);
const ManualTradeForm = React.lazy(() => import('./ManualTradeForm'));
const AccountExecutionChart = React.lazy(() => import('./AccountExecutionChart'));
import TradeShareModal from './TradeShareModal';

interface PropertyProps {
    label: string;
    value: string | number;
    subValue?: string;
    color?: string;
    icon?: any;
    isDark?: boolean;
}

// Jednořádkový fakt: popisek vlevo, hodnota vpravo. Ve 2sloupcové mřížce dole
// v modalu drží „tabulkový" vzhled — poslední řádek (2 buňky) je bez podtržení.
const Property = React.memo(({ label, value, subValue, color, icon: Icon, isDark = true }: PropertyProps) => (
    <div className={`flex items-baseline justify-between gap-2 py-1 group/prop border-b [&:nth-last-child(-n+2)]:border-0 ${isDark ? 'border-white/[0.03]' : 'border-slate-100'}`}>
        <span className="flex items-center gap-1 shrink-0 opacity-40 group-hover/prop:opacity-60 transition-opacity">
            {Icon && <Icon size={9} className="text-slate-400" />}
            <span className="text-[8px] font-black uppercase tracking-[0.15em]">{label}</span>
        </span>
        <span className="flex items-baseline gap-1.5 min-w-0">
            {subValue && <span className="text-[7px] font-bold text-slate-500 uppercase tracking-wide opacity-60 shrink-0">{subValue}</span>}
            <span className={`text-[11px] lg:text-[12px] font-black font-mono tracking-tighter truncate ${color || (isDark ? 'text-slate-200' : 'text-slate-900')}`}>{value}</span>
        </span>
    </div>
));

// Editovatelná verze Property — pro SL/TP dodatečné doplnění
// (typicky když byl SL posunut po vstupu a parser ho ignoroval).
// Klik na value → input, Enter/blur uloží, Esc zruší.
const EditableNumberProperty: React.FC<{
  label: string;
  value: number | undefined;
  placeholder?: string;
  color?: string;
  icon: any;
  isDark: boolean;
  onSave: (value: number | undefined) => void;
  readOnly?: boolean;
}> = ({ label, value, placeholder, color, icon: Icon, isDark, onSave, readOnly = false }) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value !== undefined ? String(value) : '');

  useEffect(() => { setText(value !== undefined ? String(value) : ''); }, [value]);

  const commit = () => {
    const trimmed = text.trim().replace(',', '.');
    if (trimmed === '') {
      onSave(undefined);
    } else {
      const n = parseFloat(trimmed);
      if (!isNaN(n) && n > 0) onSave(n);
    }
    setEditing(false);
  };

  if (readOnly) return <Property label={label} value={value ?? '—'} color={color} icon={Icon} isDark={isDark} />;
  return (
    <div className={`flex items-baseline justify-between gap-2 py-1 group/prop border-b [&:nth-last-child(-n+2)]:border-0 ${isDark ? 'border-white/[0.03]' : 'border-slate-100'}`}>
      <span className="flex items-center gap-1 shrink-0">
        <span className="flex items-center gap-1 opacity-40 group-hover/prop:opacity-60 transition-opacity">
          {Icon && <Icon size={9} className="text-slate-400" />}
          <span className="text-[8px] font-black uppercase tracking-[0.15em]">{label}</span>
        </span>
        {value === undefined && !editing && (
          <span className={`text-[7px] font-black uppercase tracking-widest px-1 rounded ${isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700'}`}>+</span>
        )}
      </span>
      {editing ? (
        <input
          type="number"
          step="0.25"
          autoFocus
          value={text}
          onChange={e => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') { setText(value !== undefined ? String(value) : ''); setEditing(false); }
          }}
          placeholder={placeholder}
          className={`w-20 text-[11px] lg:text-[12px] font-black font-mono tracking-tighter text-right outline-none border rounded px-1 py-0 ${
            isDark ? 'bg-white/5 border-white/20 text-white' : 'bg-white border-slate-300 text-slate-900'
          }`}
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className={`text-[11px] lg:text-[12px] font-black font-mono tracking-tighter text-right hover:bg-white/5 rounded px-0.5 transition-colors ${
            color || (isDark ? 'text-slate-200' : 'text-slate-900')
          } ${value === undefined ? 'opacity-50 italic' : ''}`}
          title="Klikni pro úpravu"
        >
          {value !== undefined ? value : (placeholder || '—')}
        </button>
      )}
    </div>
  );
};

interface TradeDetailModalProps {
    trade: Trade;
    accountName: string;
    theme: 'dark' | 'light' | 'oled';
    onClose: () => void;
    onDelete: () => void;
    emotions: CustomEmotion[];
    onPrev?: () => void;
    onNext?: () => void;
    hasPrev?: boolean;
    hasNext?: boolean;
    loadJournalDetails?: (ids: readonly string[], signal?: AbortSignal) => Promise<Trade[]>;
    loadTradeDetail?: (id: string) => Promise<Trade | null>;
    signCopierSnapshots?: typeof storageService.createCopierSnapshotSignedUrls;
    onUpdateTrade?: (updates: Partial<Trade>) => void | boolean | Promise<void | boolean>;
    pnlDisplayMode?: PnLDisplayMode;
    accounts?: Account[];
    initialBalance?: number;
    user?: User;
    exchangeRates?: ExchangeRates | null;
    allTrades?: Trade[];
    /** Otevřít rovnou v editačním formuláři (průvodce doplněním importovaných obchodů). */
    startInEditMode?: boolean;
    /** Zavolá se po ULOŽENÍ v režimu průvodce — přejdi na další obchod. */
    onSaved?: () => void;
}

const TradeDetailModal: React.FC<TradeDetailModalProps> = ({
    trade, accountName, theme, onClose, onDelete, emotions, onPrev, onNext, hasPrev, hasNext,
    onUpdateTrade, pnlDisplayMode = 'usd', accounts = [], initialBalance, user, exchangeRates,
    allTrades = EMPTY_TRADES, startInEditMode = false, onSaved, loadJournalDetails = defaultLoadJournalDetails, loadTradeDetail = defaultLoadTradeDetail, signCopierSnapshots = storageService.createCopierSnapshotSignedUrls
}) => {
    const isDark = theme !== 'light';
    const targetCurrency = user?.currency || 'USD';

    const safeValue = (val: any) => {
        const parsed = parseFloat(String(val || 0));
        return isNaN(parsed) ? 0 : parsed;
    };

    const formatValue = (sourceTrade: Trade, mode: PnLDisplayMode = pnlDisplayMode, bal?: number, rr?: number, sign: boolean = true) => {
        const balance = mode === 'percent' && journalReviewOnly(sourceTrade) ? journalDisplayBalance(sourceTrade, accounts, isCombinedTrade(sourceTrade) ? groupTrades : [sourceTrade]) : bal;
        return formatTradePnL(sourceTrade, mode, balance, rr, sign, targetCurrency, exchangeRates);
    };

    const detailLookupId = useMemo(
        () => tradeDetailSource(trade, allTrades)?.id,
        [trade, allTrades],
    );
    const selectedMembers = useMemo(() => tradeDetailMembers(trade, allTrades), [trade, allTrades]);
    const [journalResult, setJournalResult] = useState<{ input: Trade; selection: Trade[]; rows: Trade[] | null } | null>(null);
    const currentJournal = journalResult?.input === trade && journalResult.selection === selectedMembers ? journalResult : null;
    const journalPending = journalReviewOnly(trade) && !currentJournal?.rows;
    const [fullTrade, setFullTrade] = useState<Trade>(trade);
    const [isLoadingDetails, setIsLoadingDetails] = useState(false);
    const [detailsLoadError, setDetailsLoadError] = useState(false);
    const [detailsRetry, setDetailsRetry] = useState(0);
    // Id obchodu, pro který už doběhl lazy-load detailu (screenshoty z DB).
    const [detailsLoadedTradeId, setDetailsLoadedTradeId] = useState<string | null>(null);

    // Scroll Lock
    useEffect(() => {
        const originalBodyOverflow = document.body.style.overflow;
        const originalHtmlOverflow = document.documentElement.style.overflow;

        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';

        return () => {
            document.body.style.overflow = originalBodyOverflow;
            document.documentElement.style.overflow = originalHtmlOverflow;
        };
    }, []);


    const activeTrade = fullTrade || trade;

    useEffect(() => {
        setFullTrade(trade);
        setDetailsLoadError(false);
        if (journalReviewOnly(trade)) {
            const controller = new AbortController();
            setIsLoadingDetails(true);
            setJournalResult(null);
            setDetailsLoadedTradeId(previous => previous === String(trade.id) ? previous : null);
            void loadJournalDetails(isCombinedTrade(trade) ? trade.combinedTradeIds?.map(String) ?? [] : [String(trade.id)], controller.signal)
                .then(rows => {
                    if (controller.signal.aborted) return;
                    const merged = mergeJournalDetailSelection(trade, selectedMembers, rows);
                    setFullTrade(merged.trade);
                    setJournalResult({ input: trade, selection: selectedMembers, rows: merged.members });
                    setDetailsLoadedTradeId(String(trade.id));
                }).catch(() => {
                    if (controller.signal.aborted) return;
                    setDetailsLoadError(true);
                    setJournalResult({ input: trade, selection: selectedMembers, rows: null });
                }).finally(() => { if (!controller.signal.aborted) setIsLoadingDetails(false); });
            return () => controller.abort();
        }
        // If parent trade already has screenshot data, use it directly (no extra DB call)
        if (!journalReviewOnly(trade) && (trade.screenshot || (trade.screenshots && trade.screenshots.length > 0))) {
            // Předchozí (zrušený) lazy-load mohl nechat spinner zapnutý — vypni ho,
            // jinak by screenshot z props zůstal schovaný za spinnerem.
            setIsLoadingDetails(false);
            setDetailsLoadedTradeId(String(trade.id));
            return;
        }
        let cancelled = false;
        // Keep an already opened editor mounted while its optimistic review refreshes.
        setDetailsLoadedTradeId(previous => previous === String(trade.id) ? previous : null);
        const loadFull = async () => {
            // Bez guardu na isLoadingDetails: hodnota v closure je stále z prvního renderu
            // a při rychlém přepínání obchodů by načtení detailu úplně přeskočila.
            setIsLoadingDetails(true);
            let succeeded = false;
            try {
                if (detailLookupId != null) {
                    const detailed = await loadTradeDetail(String(detailLookupId));
                    // Merge only screenshot/screenshots from DB — keep parent prop's
                    // up-to-date fields (executionStatus, isValid, notes, etc.) so we
                    // don't overwrite an optimistic update with stale DB data.
                    if (journalReviewOnly(trade) && (!detailed || String(detailed.id) !== String(detailLookupId))) throw new Error("journal-review-details-unavailable");
                    if (detailed && !cancelled) {
                        succeeded = true;
                        setFullTrade(prev => ({
                            ...prev,
                            screenshot: detailed.screenshot ?? prev.screenshot,
                            screenshots: detailed.screenshots ?? prev.screenshots,
                            copierSnapshots: journalReviewOnly(trade) ? detailed.copierSnapshots ?? [] : detailed.copierSnapshots ?? prev.copierSnapshots,
                            copierEpisodeId: journalReviewOnly(trade) ? detailed.copierEpisodeId : detailed.copierEpisodeId ?? prev.copierEpisodeId,
                            copierSnapshotLoadError: detailed.copierSnapshotLoadError ?? false,
                            drawings: detailed.drawings ?? prev.drawings,
                            aiSuggestions: (detailed as any).aiSuggestions ?? (prev as any).aiSuggestions,
                            visionAnalysis: (detailed as any).visionAnalysis ?? (prev as any).visionAnalysis,
                        }));
                    }
                }
            } catch (e) {
                console.error("Failed to load full trade details", e);
                if (!cancelled) setDetailsLoadError(true);
            } finally {
                if (!cancelled) {
                    setIsLoadingDetails(false);
                    if (succeeded || !journalReviewOnly(trade)) setDetailsLoadedTradeId(String(trade.id));
                }
            }
        };
        loadFull();
        return () => { cancelled = true; };
    // Sync na CELÝ trade objekt — když edit upraví jakékoliv pole, sync fullTrade.
    }, [trade, detailLookupId, detailsRetry, loadTradeDetail, loadJournalDetails, selectedMembers]);

    const groupTrades = useMemo(
        () => journalReviewOnly(trade) ? currentJournal?.rows ?? [] : tradeDetailMembers(activeTrade, allTrades),
        [trade, currentJournal, activeTrade, allTrades],
    );
    const masterTradeIdInGroup = useMemo(
        () => explicitTradeMaster(groupTrades)?.id ?? null,
        [groupTrades],
    );
    const estimateNotice = tradeEstimateNotice(activeTrade);
    const isCombined = isCombinedTrade(activeTrade);
    const [chartAccountId, setChartAccountId] = useState<string | null>(null);
    const [chartRealizationId, setChartRealizationId] = useState<string | null>(null);
    const accountChartTrades = isCombined
        ? groupTrades.filter(member => member.accountId === (chartAccountId ?? activeTrade.accountId))
        : [activeTrade];
    const chartTrade = isCombined
        ? accountChartTrades.find(member => String(member.id) === chartRealizationId) ?? accountChartTrades[0]
          ?? groupTrades.find(member => member.accountId === activeTrade.accountId) ?? groupTrades[0]
        : activeTrade;

    const [isZoomed, setIsZoomed] = useState(false);
    const [accountsExpanded, setAccountsExpanded] = useState(false);
    const [activeImageIndex, setActiveImageIndex] = useState(0);
    const [visualMode, setVisualMode] = useState<'chart' | 'screenshots'>('screenshots');
    const [isSigningSnapshots, setIsSigningSnapshots] = useState(false);
    const [snapshotSignError, setSnapshotSignError] = useState(false);
    const [signedCopierSnapshots, setSignedCopierSnapshots] = useState<Array<{
        kind: string; at: number; path: string; url: string;
    }>>([]);
    const [shareCopied, setShareCopied] = useState(false);
    const [isShareCardOpen, setIsShareCardOpen] = useState(false);
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

    // Full Edit Mode — ManualTradeForm overlay
    const [isFullEditOpen, setIsFullEditOpen] = useState(!!startInEditMode);
    // Průvodce: rozliš uložení (→ další obchod) od zrušení (→ konec průvodce).
    const wizardSavedRef = useRef(false);
    // Při přechodu na další obchod v průvodci znovu otevři editační formulář.
    useEffect(() => {
        if (startInEditMode) {
            wizardSavedRef.current = false;
            setIsFullEditOpen(true);
        }
    }, [trade.id, startInEditMode]);
    // Bezpečnostní pojistka: v režimu průvodce bez onUpdateTrade by se editační formulář
    // nevyrenderoval (viz render guard níž) a průvodce by visel na detailu bez akce — radši ukonči.
    useEffect(() => {
        if (startInEditMode && !onUpdateTrade) onClose();
    }, [startInEditMode, onUpdateTrade, onClose]);
    const [editPrefs, setEditPrefs] = useState<{ htf: string[]; ltf: string[]; mistakes: string[] }>({ htf: [], ltf: [], mistakes: [] });
    useEffect(() => {
        storageService.getCachedPreferences().then((p: any) => {
            if (!p) return;
            setEditPrefs({ htf: p.htfOptions || [], ltf: p.ltfOptions || [], mistakes: p.standardMistakes || [] });
        }).catch(() => {});
    }, []);

    // Keyboard navigation — šipky listují trady, Escape zavírá
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (isFullEditOpen) return;
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            if (e.key === 'ArrowLeft' && hasPrev) onPrev?.();
            if (e.key === 'ArrowRight' && hasNext) onNext?.();
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [hasPrev, hasNext, onPrev, onNext, onClose, isFullEditOpen]);

    // Inline Editing State
    const [isEditingNotes, setIsEditingNotes] = useState(false);
    const [editedNotes, setEditedNotes] = useState(activeTrade.notes || '');

    useEffect(() => {
        setEditedNotes(activeTrade.notes || '');
    }, [activeTrade.notes]);

    const handleSaveNotes = () => {
        onUpdateTrade?.({ notes: editedNotes });
        setIsEditingNotes(false);
    };

    const manualImages = activeTrade.screenshots && activeTrade.screenshots.length > 0
        ? activeTrade.screenshots
        : (activeTrade.screenshot ? [activeTrade.screenshot] : []);
    const images = [...manualImages, ...signedCopierSnapshots.map(snapshot => snapshot.url)];
    const activeCopierSnapshot = activeImageIndex >= manualImages.length
        ? signedCopierSnapshots[activeImageIndex - manualImages.length]
        : undefined;

    const requiresJournalMedia = journalReviewOnly(activeTrade);
    // Modal je hranice lazy-loadu: privátní cesty se podepíší až po otevření
    // detailu a ruční screenshoty zůstávají nedotčené.
    useEffect(() => {
        let cancelled = false;
        setSignedCopierSnapshots([]);
        setSnapshotSignError(false);
        setIsSigningSnapshots(false);
        // Journal media must come from the freshly read owner detail.
        if (requiresJournalMedia && (isLoadingDetails || detailsLoadedTradeId !== String(trade.id))) return () => { cancelled = true; };
        const snapshots = activeTrade.copierSnapshots ?? [];
        if (snapshots.length === 0) return () => { cancelled = true; };
        setIsSigningSnapshots(true);
        void signCopierSnapshots(snapshots)
            .then(items => {
                if (!cancelled) {
                    setSignedCopierSnapshots(items);
                    setSnapshotSignError(items.length !== snapshots.length);
                }
            })
            .catch(() => { if (!cancelled) setSnapshotSignError(true); })
            .finally(() => { if (!cancelled) setIsSigningSnapshots(false); });
        return () => { cancelled = true; };
    }, [activeTrade.id, requiresJournalMedia, activeTrade.copierSnapshots, trade.id, isLoadingDetails, detailsLoadedTradeId, signCopierSnapshots]);

    useEffect(() => {
        if (activeImageIndex >= images.length) setActiveImageIndex(0);
    }, [activeImageIndex, images.length]);

    const executionTrade = journalReviewOnly(activeTrade) && isCombined && visualMode === 'chart' ? chartTrade ?? activeTrade : activeTrade;
    const entryPrice = safeValue(executionTrade.entryPrice);
    const exitPrice = safeValue(executionTrade.exitPrice);
    const stopLoss = safeValue(activeTrade.stopLoss);
    const takeProfit = safeValue(activeTrade.takeProfit);
    const riskAmount = safeValue(activeTrade.riskAmount);

    // Defensive RRR calculation
    const pnl = safeValue(activeTrade.pnl);
    // Price-based RR (jako TradingView) — čistý cenový poměr bez fees.
    // Pokud máme entry + exit + stopLoss, použij to (přesnější, matches TV).
    // Fallback na pnl/risk pokud něco chybí (např. SL doplněno ručně bez exit price).
    const priceBasedRR = (() => {
      if (entryPrice > 0 && exitPrice > 0 && stopLoss > 0) {
        const profitMove = Math.abs(entryPrice - exitPrice);
        const riskMove = Math.abs(entryPrice - stopLoss);
        if (riskMove > 0) {
          const sign = pnl >= 0 ? 1 : -1;
          return sign * (profitMove / riskMove);
        }
      }
      return null;
    })();
    const realRRR = journalReviewOnly(activeTrade) ? null : priceBasedRR !== null
      ? priceBasedRR
      : (riskAmount > 0 ? pnl / riskAmount : 0);

    const exitTime = executionTrade.timestamp || new Date(executionTrade.date).getTime();
    const tradeEntryTime = executionTrade.entryTime || executionTrade.entryDate || (exitTime - (safeValue(executionTrade.durationMinutes) * 60 * 1000));

    // Format the time range string
    const formatTime = (time: any) => {
        const d = new Date(time);
        return isNaN(d.getTime()) ? '--:--' : d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
    };

    const timeRange = `${formatTime(tradeEntryTime)} - ${formatTime(exitTime)}`;
    const holdTime = executionTrade.duration || (Math.round(safeValue(executionTrade.durationMinutes ?? (executionTrade as any).duration_minutes)) + 'm');
    // Status MUSÍ číst z nejnovějšího trade propu (ne z fullTrade, který může být přepsán stale DB fetchem)
    const status = trade.executionStatus || activeTrade.executionStatus || ((trade.isValid === false || activeTrade.isValid === false) ? 'Invalid' : 'Valid');
    const isMissed = status === 'Missed';
    // Manual BE override má přednost před auto detekcí z pnl
    const isBEOverride = activeTrade.isBE === true;
    const isWin = !isBEOverride && pnl >= 0;

    const pnlColor = isMissed ? 'text-blue-400' : (isWin ? 'text-emerald-500' : 'text-rose-500');
    const directionColor = isMissed ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' : (activeTrade.direction === 'Long' ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' : 'text-rose-500 bg-rose-500/10 border-rose-500/20');

    const getEmotionDetails = (emoId: string) => emotions.find(e => e.id === emoId) || { label: emoId, icon: '' };

    const [imageLoadError, setImageLoadError] = useState(false);

    // Reset error state when switching images
    useEffect(() => { setImageLoadError(false); }, [activeImageIndex]);
    // Reset error state when trade changes
    useEffect(() => { setImageLoadError(false); }, [activeTrade.id]);
    const snapshotError = Boolean(activeTrade.copierSnapshotLoadError || snapshotSignError || detailsLoadError || imageLoadError);
    const loadingImages = isLoadingDetails || (isSigningSnapshots && images.length === 0);
    // Screenshot obchodu je výchozí pohled; graf je druhá záložka.
    useEffect(() => { setVisualMode('screenshots'); }, [activeTrade.id]);



    const handleShare = async () => {
        let url = '';
        const isUUID = (id: any) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        try {
            if (isUUID(trade.id)) {
                storageService.markTradeAsPublic(trade.id as string).catch(err => console.error("DB Mark Public failed", err));
                url = `${window.location.origin}${window.location.pathname}?shareId=${trade.id}`;
            } else {
                const shareableTrade = { ...trade, screenshot: null, screenshots: [] };
                // Modern Unicode-safe encode: UTF-8 string → bytes → base64
                const jsonStr = JSON.stringify(shareableTrade);
                const bytes = new TextEncoder().encode(jsonStr);
                const encoded = btoa(String.fromCharCode(...bytes));
                url = `${window.location.origin}${window.location.pathname}?share=${encoded}`;
            }
            await navigator.clipboard.writeText(url);
            setShareCopied(true);
            setTimeout(() => setShareCopied(false), 2000);
        } catch (err) {
            console.error("General sharing failure", err);
        }
    };

    // Preferuj price-based RR (jako TradingView) pro PnL display v R mode
    const formattedPnL = formatValue(activeTrade, pnlDisplayMode, initialBalance || accounts.find(a => a.id === activeTrade.accountId)?.initialBalance, priceBasedRR !== null ? priceBasedRR : ((riskAmount > 0) ? pnl / riskAmount : undefined));

    return (
        <ErrorBoundary name="TradeDetailModal">
            {journalPending && <div className="fixed inset-0 z-[300] flex items-center justify-center bg-theme-page-95 backdrop-blur-2xl p-6">
                <div role={currentJournal ? 'alert' : 'status'} className="max-w-md rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-6 text-center text-sm text-[var(--text-primary)]">
                    <p>{currentJournal ? 'Údaje vybraných účtů se nepodařilo ověřit. Obnovte detail, případně výběr v historii.' : 'Načítám společný přehled vybraných účtů…'}</p>
                    <div className="mt-4 flex justify-center gap-4">{currentJournal && <button className="font-bold text-blue-500" onClick={() => setDetailsRetry(value => value + 1)}>Zkusit znovu</button>}<button onClick={onClose}>Zavřít</button></div>
                </div>
            </div>}
            <div style={{ display: 'contents', visibility: journalPending ? 'hidden' : undefined }}>
            <div className="native-modal-safe-area fixed inset-0 z-[110] flex items-center justify-center p-0 md:p-6 lg:p-12 overflow-hidden">
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 bg-theme-page-95 backdrop-blur-2xl"
                    onClick={onClose}
                />

                <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 20 }}
                    className={`relative w-full max-w-[1600px] h-full lg:h-[85vh] rounded-none md:rounded-[40px] overflow-hidden shadow-[0_0_100px_rgba(0,0,0,0.8)] flex flex-col border ${isDark ? 'bg-theme-card-80 border-white/10' : 'bg-white/90 border-slate-200'}`}
                >
                    {/* Header */}
                    <div className={`h-14 lg:h-20 shrink-0 border-b flex items-center justify-between px-4 md:px-10 z-20 ${isDark ? 'border-white/5 bg-theme-card-50' : 'bg-white/50 border-slate-100'} backdrop-blur-md`}>
                        <div className="flex items-center gap-3 lg:gap-4 min-w-0">
                            <div className="flex items-center gap-2 lg:gap-4 min-w-0">
                                <h2 className={`text-lg lg:text-2xl font-black tracking-tighter uppercase shrink-0 ${isDark ? 'text-white' : 'text-slate-900'}`}>{activeTrade.instrument}</h2>
                                <div className={`px-2 lg:px-3 py-1 rounded-full border flex items-center gap-1.5 shrink-0 ${directionColor}`}>
                                    {isMissed ? <Clock size={11} /> : (activeTrade.direction === 'Long' ? <ArrowUpRight size={12} strokeWidth={3} /> : <ArrowDownRight size={12} strokeWidth={3} />)}
                                    <span className="text-[9px] lg:text-[10px] font-black uppercase tracking-widest">{isMissed ? 'MISSED' : activeTrade.direction}</span>
                                </div>
                                {!isMissed && (
                                    <div className={`px-2 lg:px-3 py-1 rounded-full border flex items-center gap-1.5 shrink-0 ${status === 'Invalid' ? 'text-rose-500 bg-rose-500/10 border-rose-500/20' : 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20'}`}>
                                        {status === 'Invalid' ? <AlertOctagon size={11} strokeWidth={3} /> : <Check size={11} strokeWidth={3} />}
                                        <span className="text-[9px] lg:text-[10px] font-black uppercase tracking-widest">{status === 'Invalid' ? 'NEVALIDNÍ' : 'VALIDNÍ'}</span>
                                    </div>
                                )}
                            </div>
                            <div className="h-6 w-px bg-white/10 hidden lg:block" />
                            <div className="hidden lg:flex flex-col">
                                <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Transaction Date</p>
                                <p className={`text-[11px] font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                    {activeTrade.date ? new Date(activeTrade.date).toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'}
                                </p>
                            </div>
                            <div className={`hidden lg:flex p-1 rounded-xl border shrink-0 ${isDark ? 'bg-black/30 border-white/10' : 'bg-white/80 border-slate-200 shadow-sm'}`}>
                                <button onClick={() => setVisualMode('screenshots')} className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all ${visualMode === 'screenshots' ? 'bg-blue-500 text-white' : 'text-slate-500'}`}>Screenshoty {images.length ? `(${images.length})` : ''}</button>
                                <button onClick={() => setVisualMode('chart')} className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all ${visualMode === 'chart' ? 'bg-emerald-500 text-white' : 'text-slate-500'}`}>Graf</button>
                            </div>
                        </div>

                        <div className="flex items-center gap-1.5 lg:gap-3">
                            {/* Prev/Next */}
                            <div className={`flex items-center gap-0.5 p-0.5 rounded-xl border ${isDark ? 'bg-white/5 border-white/5' : 'bg-white border-slate-200'}`}>
                                <button onClick={onPrev} disabled={!hasPrev} className={`p-1.5 lg:p-2 rounded-lg transition-all ${!hasPrev ? 'opacity-20 cursor-not-allowed' : isDark ? 'hover:bg-white/10 text-slate-400 hover:text-white' : 'hover:bg-slate-100 text-slate-400 hover:text-slate-700'}`}><ChevronLeft size={16} /></button>
                                <button onClick={onNext} disabled={!hasNext} className={`p-1.5 lg:p-2 rounded-lg transition-all ${!hasNext ? 'opacity-20 cursor-not-allowed' : isDark ? 'hover:bg-white/10 text-slate-400 hover:text-white' : 'hover:bg-slate-100 text-slate-400 hover:text-slate-700'}`}><ChevronRight size={16} /></button>
                            </div>
                            <button onClick={() => setIsShareCardOpen(true)} title="Sdílet jako kartu" className={`p-2 lg:p-3 rounded-xl lg:rounded-2xl transition-all ${isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white' : 'bg-white text-slate-400 hover:text-slate-700 hover:bg-slate-50 border border-slate-200'}`}><Share2 size={16} /></button>
                            {onUpdateTrade && (
                                <button onClick={(e) => { e.stopPropagation(); setIsFullEditOpen(true); }} className={`p-2 lg:p-3 rounded-xl lg:rounded-2xl transition-all ${isDark ? 'bg-blue-500/10 text-blue-500 hover:bg-blue-500 hover:text-white' : 'bg-white text-blue-400 hover:bg-blue-500 hover:text-white border border-blue-200'}`} title={journalReviewOnly(activeTrade) ? 'Upravit hodnocení obchodu' : String(activeTrade.id).startsWith('combined_') ? 'Upravit obchod (změny se propíší na účty v aktuálním výběru)' : 'Upravit obchod'}><Edit3 size={16} /></button>
                            )}
                            <button onClick={(e) => { e.stopPropagation(); setIsDeleteModalOpen(true); }} className={`p-2 lg:p-3 rounded-xl lg:rounded-2xl transition-all ${isDark ? 'bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white' : 'bg-white text-rose-400 hover:bg-rose-500 hover:text-white border border-rose-200'}`}><Trash2 size={16} /></button>
                            <button onClick={onClose} className={`p-2 lg:p-3 rounded-full transition-all ${isDark ? 'hover:bg-white/10 text-slate-400' : 'bg-white hover:bg-slate-50 text-slate-400 border border-slate-200'}`}><X size={20} /></button>
                        </div>
                    </div>

                    <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">

                        {/* LEFT: Pure trade data only */}
                        <div className={`order-2 lg:order-1 w-full lg:w-[320px] flex-1 lg:flex-none shrink-0 border-t lg:border-t-0 lg:border-r flex flex-col z-10 ${isDark ? 'border-white/5 bg-theme-card-40' : 'border-slate-100 bg-slate-50/40'} backdrop-blur-xl overflow-y-auto no-scrollbar`}>
                            {/* PnL hero card */}
                            <div className={`p-5 border-b relative ${isDark ? 'border-white/5' : 'border-slate-100'} ${isMissed ? 'bg-blue-500/[0.04]' : isBEOverride ? 'bg-amber-500/[0.04]' : isWin ? 'bg-emerald-500/[0.04]' : 'bg-rose-500/[0.04]'}`}>
                                <p className="text-[9px] font-black text-slate-500 uppercase tracking-[0.3em] mb-2">{isCombined ? 'Profit / Loss · vybrané účty' : 'Profit / Loss · tento účet'}</p>
                                <div className="flex items-baseline justify-between gap-4 flex-wrap">
                                    <h3 className={`text-4xl lg:text-4xl font-black font-mono tracking-tighter leading-none ${pnlColor}`} style={{ color: isMissed ? '#60a5fa' : isBEOverride ? '#f59e0b' : isWin ? '#10b981' : '#f43f5e' }}>
                                        {formattedPnL || '—'}
                                    </h3>
                                    <div className="flex flex-col items-end">
                                        <span className={`text-base font-black font-mono ${(realRRR ?? -Infinity) >= 1 ? 'text-emerald-500' : 'text-slate-500'}`}>{realRRR == null ? '—' : `${isFinite(realRRR) ? realRRR.toFixed(2) : '0.00'} R`}</span>
                                        <span className="text-[8px] font-bold text-slate-600 uppercase tracking-widest leading-none mt-1" title={journalReviewOnly(activeTrade) ? 'Výchozí peněžní riziko není doložené. Pozdější SL ani původní odhad nejsou podkladem pro R/R.' : undefined}>{journalReviewOnly(activeTrade) ? 'R/R · chybí riziko' : 'Reward/Risk'}</span>
                                    </div>
                                </div>
                                {estimateNotice && (
                                    <p className="mt-3 text-[10px] leading-relaxed text-amber-500" role="note">{estimateNotice}</p>
                                )}
                                {/* BE override — když trade byl fakticky BE ale fees/slippage daly +/- pár dolarů */}
                                {!isMissed && onUpdateTrade && (
                                  <button
                                    onClick={() => onUpdateTrade({ isBE: !isBEOverride } as any)}
                                    className={`mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all active:scale-95 ${
                                      isBEOverride
                                        ? 'bg-amber-500 text-white shadow-sm'
                                        : isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10 border border-white/10' : 'bg-white text-slate-500 hover:bg-amber-50 hover:text-amber-600 border border-slate-200'
                                    }`}
                                    title={isBEOverride ? 'Odznačit jako BE (vrátit auto detekci podle pnl)' : 'Označit jako BE (počítá se jako break-even ve statistikách bez ohledu na pnl)'}
                                  >
                                    {isBEOverride ? '✓ Označeno jako BE' : '⚖ Označit jako BE'}
                                  </button>
                                )}
                            </div>
                            {/* Metrics — 3-col na mobile (kompaktnější), 2-col na desktop */}
                            <div className="p-3 lg:p-5">
                                {journalReviewOnly(activeTrade) && isCombined && <p className="mb-2 text-[8px] font-bold uppercase tracking-wider text-slate-500">Plnění · {accounts.find(account => account.id === executionTrade.accountId)?.name ?? accountName}</p>}
                                <div className="grid grid-cols-2 gap-x-4 lg:gap-x-6">
                                    <Property label="ENTRY" value={entryPrice || '—'} icon={Target} isDark={isDark} />
                                    <Property label="EXIT" value={exitPrice || '—'} color={isWin ? 'text-emerald-400' : 'text-rose-400'} icon={ArrowRight} isDark={isDark} />
                                    <EditableNumberProperty
                                      readOnly={journalReviewOnly(activeTrade)}
                                      label="STOP"
                                      value={executionTrade.stopLoss}
                                      placeholder="—"
                                      color="text-rose-500/80"
                                      icon={ShieldCheck}
                                      isDark={isDark}
                                      onSave={(val) => {
                                        if (!onUpdateTrade) return;
                                        // Při změně SL spočítej i riskAmount (pro RR display)
                                        const updates: Partial<Trade> = { stopLoss: val };
                                        if (val !== undefined && activeTrade.entryPrice && activeTrade.positionSize) {
                                          const pv = pointValueFor(activeTrade.instrument);
                                          const risk = Math.abs(activeTrade.entryPrice - val) * activeTrade.positionSize * pv;
                                          updates.riskAmount = risk > 0 ? risk : undefined;
                                        } else {
                                          updates.riskAmount = undefined;
                                        }
                                        onUpdateTrade(updates);
                                      }}
                                    />
                                    <EditableNumberProperty
                                      readOnly={journalReviewOnly(activeTrade)}
                                      label="TARGET"
                                      value={executionTrade.takeProfit}
                                      placeholder="—"
                                      color="text-emerald-500/80"
                                      icon={Zap}
                                      isDark={isDark}
                                      onSave={(val) => {
                                        if (!onUpdateTrade) return;
                                        const updates: Partial<Trade> = { takeProfit: val };
                                        if (val !== undefined && activeTrade.entryPrice && activeTrade.positionSize) {
                                          const pv = pointValueFor(activeTrade.instrument);
                                          const target = Math.abs(val - activeTrade.entryPrice) * activeTrade.positionSize * pv;
                                          updates.targetAmount = target > 0 ? target : undefined;
                                        } else {
                                          updates.targetAmount = undefined;
                                        }
                                        onUpdateTrade(updates);
                                      }}
                                    />
                                    <Property label="POSITION" value={executionTrade.positionSize || 1} icon={Layers} isDark={isDark} />
                                    <Property label="HOLD" value={holdTime} subValue={timeRange.includes('01:00 - 01:00') ? undefined : timeRange} icon={Timer} isDark={isDark} />
                                </div>
                                {(() => {
                                    // Účty: master vždy nahoře, kopie schované za rozbalovací lištu.
                                    // Souhrn (počet + Σ P/L) je hned v hlavičce, takže i sbalené vidíš celek.
                                    const visibleAccountTrades = groupTrades;
                                    if (visibleAccountTrades.length === 0) return null;

                                    const isMasterTrade = (gt: Trade) => masterTradeIdInGroup != null && gt.id === masterTradeIdInGroup;

                                    // Master první, zbytek ponech v původním pořadí.
                                    const masterTrade = visibleAccountTrades.find(isMasterTrade) || visibleAccountTrades[0];
                                    const copyTrades = visibleAccountTrades.filter(gt => gt.id !== masterTrade.id);
                                    const hasCopies = copyTrades.length > 0;
                                    const totalPnl = visibleAccountTrades.reduce((s, gt) => s + safeValue(gt.pnl), 0);

                                    // Řádek účtu bez vlastního rámečku — rámeček nese obalová „buňka".
                                    const AccountRow = ({ gt, master }: { gt: Trade; master: boolean }) => {
                                        const acc = accounts.find(a => a.id === gt.accountId);
                                        const pnlVal = safeValue(gt.pnl);
                                        return (
                                            <div className={`px-3 py-2 flex items-center justify-between transition-all ${isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-slate-50'}`}>
                                                <div className="flex items-center gap-2.5 min-w-0">
                                                    <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${acc?.type === 'Funded' ? 'bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.5)]' : 'bg-blue-500'}`} />
                                                    <span className="text-[11px] font-black uppercase tracking-tight truncate max-w-[120px]">{acc?.name || (gt.accountId === activeTrade.accountId ? accountName : gt.accountId)}</span>
                                                    {master && groupTrades.length > 1 && <span className="text-[7px] font-black text-blue-500 uppercase tracking-widest shrink-0">MASTER</span>}
                                                    {!master && gt.masterTradeId != null && groupTrades.length > 1 && <span className="text-[7px] font-black text-purple-500 uppercase tracking-widest shrink-0">COPY</span>}
                                                </div>
                                                <span className={`text-[11px] font-black font-mono shrink-0 ${pnlVal >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{gt.pnlEstimated ? '≈ ' : ''}{formatValue(gt)}</span>
                                            </div>
                                        );
                                    };

                                    const divider = isDark ? 'border-white/5' : 'border-slate-200';
                                    const masterAcc = accounts.find(a => a.id === masterTrade.accountId);
                                    const masterPnl = safeValue(masterTrade.pnl);

                                    return (
                                        <div className="pt-4">
                                            <div className="flex items-center justify-between mb-2">
                                                <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] flex items-center gap-2"><Wallet size={12} /> Účty</p>
                                                {hasCopies && (
                                                    <span className="text-[10px] font-black tracking-tight text-slate-500">
                                                        {tradeAccountLabel(visibleAccountTrades)} · <span className={`font-mono ${totalPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{visibleAccountTrades.some(member => member.pnlEstimated) ? '≈ ' : ''}{formatValue({ ...activeTrade, pnl: totalPnl })}</span>
                                                    </span>
                                                )}
                                            </div>
                                            {/* Master + přepínač kopií = jeden řádek v jedné buňce.
                                                Po rozbalení se kopie odvinou pod ním uvnitř téhož rámečku. */}
                                            <div className={`rounded-xl border overflow-hidden ${isDark ? 'bg-white/[0.03] border-white/5' : 'bg-white border-slate-200'}`}>
                                                <button
                                                    onClick={hasCopies ? () => setAccountsExpanded(v => !v) : undefined}
                                                    aria-expanded={hasCopies ? accountsExpanded : undefined}
                                                    disabled={!hasCopies}
                                                    className={`w-full px-3 py-2 flex items-center gap-2.5 text-left transition-all ${hasCopies ? (isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-slate-50') : 'cursor-default'}`}
                                                >
                                                    <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${masterAcc?.type === 'Funded' ? 'bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.5)]' : 'bg-blue-500'}`} />
                                                    <span className="text-[11px] font-black uppercase tracking-tight truncate">{masterAcc?.name || (masterTrade.accountId === activeTrade.accountId ? accountName : masterTrade.accountId)}</span>
                                                    {isMasterTrade(masterTrade) && <span className="text-[7px] font-black text-blue-500 uppercase tracking-widest shrink-0">MASTER</span>}
                                                    <span className={`ml-auto text-[11px] font-black font-mono shrink-0 ${masterPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{masterTrade.pnlEstimated ? '≈ ' : ''}{formatValue(masterTrade)}</span>
                                                    {hasCopies && (
                                                        <span className={`flex items-center gap-1 pl-2.5 ml-0.5 border-l text-[10px] font-black shrink-0 ${divider} ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                                            +{copyTrades.length}
                                                            <ChevronDown size={12} className={`transition-transform ${accountsExpanded ? 'rotate-180' : ''}`} />
                                                        </span>
                                                    )}
                                                </button>
                                                {hasCopies && accountsExpanded && copyTrades.map(gt => (
                                                    <div key={gt.id} className={`border-t ${divider}`}><AccountRow gt={gt} master={false} /></div>
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })()}

                                {/* Mindset */}
                                {!!(activeTrade.emotions?.length || activeTrade.mistakes?.length) && (
                                    <div className={`pt-4 border-t ${isDark ? 'border-white/[0.03]' : 'border-slate-100'}`}>
                                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] mb-2.5 flex items-center gap-2"><Brain size={11} /> Mindset</p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {activeTrade.emotions?.map(e => <span key={e} className="px-2 py-1 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-400 text-[9px] font-black uppercase tracking-wide">{getEmotionDetails(e).label}</span>)}
                                            {activeTrade.mistakes?.map(m => <span key={m} className="px-2 py-1 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-500 text-[9px] font-black uppercase tracking-wide">{m}</span>)}
                                        </div>
                                    </div>
                                )}

                                {/* Entry Confluence · HTF Confluence · Levely — vždy viditelné.
                                    Nahradilo dřívější HTF/LTF Confluence: LTF se dublovalo s „Execution"
                                    a „Entry model" v Intelu, HTF sekce byla ruční a většinou prázdná. */}
                                <TradeConfluence trade={activeTrade} isDark={isDark} />

                                {/* AlphaBridge Intel — MFE/MAE v R, execution tagy, entry model,
                                    excursion (co zbylo na stole) a counterfactual. Vykreslí se jen
                                    když obchod nese data z extension (jinak vrací null). */}
                                <TradeExecutionIntel trade={activeTrade} isDark={isDark} />

                                {/* Notes + AI (MOBILE ONLY) — na desktop jsou v right pane bottom.
                                    Pořadí: nejdřív Poznámky (user content), pak AI návrhy. */}
                                <div className="lg:hidden pt-4 mt-4 border-t border-slate-100 dark:border-white/[0.03] space-y-4">
                                    <div>
                                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] mb-3 flex items-center gap-2"><FileText size={12} /> Poznámky</p>
                                        <div className={`p-4 rounded-2xl border text-xs font-medium leading-[1.8] ${isDark ? 'bg-black/30 border-white/5 text-slate-400' : 'bg-white border-slate-100 text-slate-600'}`}>
                                            {activeTrade.notes || <span className="italic opacity-40">No log entry.</span>}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* RIGHT: screenshot top + info bottom.
                            Na mobile: flex-none (natural height image) — pak sidebar dole.
                            Na desktop: flex-1 (zabere prostor v row layoutu). */}
                        <div className="order-1 lg:order-2 flex-none lg:flex-1 flex flex-col overflow-hidden">

                            {/* TOP: screenshot obchodu je výchozí; interaktivní CME graf je druhá záložka. */}
                            <div className="relative group flex-none h-[420px] lg:flex-[3_3_0] lg:h-auto lg:min-h-0 lg:overflow-hidden">
                                <div className={`absolute top-3 left-1/2 -translate-x-1/2 z-40 flex lg:hidden p-1 rounded-xl border backdrop-blur-xl ${isDark ? 'bg-black/70 border-white/10' : 'bg-white/80 border-slate-200 shadow-sm'}`}>
                                    <button onClick={() => setVisualMode('screenshots')} className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all ${visualMode === 'screenshots' ? 'bg-blue-500 text-white' : 'text-slate-500'}`}>Screenshoty {images.length ? `(${images.length})` : ''}</button>
                                    <button onClick={() => setVisualMode('chart')} className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all ${visualMode === 'chart' ? 'bg-emerald-500 text-white' : 'text-slate-500'}`}>Graf</button>
                                </div>

                                {visualMode === 'chart' ? (
                                    <React.Suspense fallback={<div className="absolute inset-0 flex items-center justify-center"><div className="w-10 h-10 rounded-full border-2 border-white/10 border-t-emerald-500 animate-spin" /></div>}>
                                        {chartTrade ? <>
                                            {isCombined && <div className="absolute top-0 left-0 right-0 z-30 h-10 flex items-center gap-2 px-3 text-[10px] font-bold text-slate-500 bg-theme-card">
                                                <label htmlFor="trade-chart-account">Účet v grafu</label>
                                                <select id="trade-chart-account" value={chartTrade.accountId} onChange={event => setChartAccountId(event.target.value)} className="min-w-0 max-w-[55%] rounded-lg border border-slate-500/20 bg-theme-card px-2 py-1 text-theme-primary">
                                                    {[...new Set(groupTrades.map(member => member.accountId))].map(id => <option key={id} value={id}>{accounts.find(account => account.id === id)?.name || id}</option>)}
                                                </select>
                                                {accountChartTrades.length > 1 && <select aria-label="Realizace vybraného účtu" value={String(chartTrade.id)} onChange={event => setChartRealizationId(event.target.value)} className="min-w-0 rounded-lg border border-slate-500/20 bg-theme-card px-2 py-1 text-theme-primary">
                                                    {accountChartTrades.map((member, index) => <option key={member.id} value={String(member.id)}>Realizace {index + 1} · {new Date(member.timestamp).toLocaleTimeString('cs-CZ')}</option>)}
                                                </select>}
                                                {chartTrade.pnlEstimated && <span className="text-amber-500">Odhad podle leadera</span>}
                                            </div>}
                                            <div className={isCombined ? 'absolute inset-0 top-10' : 'absolute inset-0'}><AccountExecutionChart trade={chartTrade} isDark={isDark} verifiedDetail={currentJournal?.rows?.includes(chartTrade) ? chartTrade : undefined} /></div>
                                        </> : <p className="p-6 text-xs text-slate-500">Podklady vybraných účtů nejsou načtené.</p>}
                                    </React.Suspense>
                                ) : (
                                    <>
                                        {loadingImages && (
                                            <div className="absolute inset-0 flex items-center justify-center z-10">
                                                <div className="w-10 h-10 rounded-full border-2 border-white/10 border-t-emerald-500 animate-spin" />
                                            </div>
                                        )}
                                        {snapshotError && !isLoadingDetails && <div role="status" className="absolute bottom-16 left-4 right-4 z-30 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3 text-xs text-[var(--text-primary)]">
                                            Snímky se nepodařilo úplně načíst.
                                            <button type="button" className="ml-2 font-bold text-blue-500" onClick={() => { setImageLoadError(false); setDetailsRetry(value => value + 1); }}>Zkusit znovu</button>
                                        </div>}
                                        <AnimatePresence mode="wait">
                                            {!loadingImages && (images.length > 0 && !imageLoadError) ? (
                                                <motion.div key={images[activeImageIndex]} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0">
                                                    <img src={images[activeImageIndex]} className="absolute inset-0 w-full h-full object-contain cursor-zoom-in" onClick={() => setIsZoomed(true)} onError={() => setImageLoadError(true)} />
                                                    {activeCopierSnapshot && (
                                                        <div className="absolute top-16 left-4 z-20 rounded-lg border border-white/10 bg-black/65 px-3 py-2 text-white backdrop-blur-md">
                                                            <p className="text-[9px] font-black uppercase tracking-widest">Auto · {activeCopierSnapshot.kind}</p>
                                                            <p className="mt-0.5 text-[9px] font-mono text-white/60">{new Date(activeCopierSnapshot.at).toLocaleTimeString('cs-CZ')}</p>
                                                        </div>
                                                    )}
                                                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                                                        <div className="p-5 bg-black/40 backdrop-blur-md rounded-full text-white border border-white/20 shadow-2xl pointer-events-auto cursor-pointer" onClick={() => setIsZoomed(true)}><Maximize2 size={28} /></div>
                                                    </div>
                                                </motion.div>
                                            ) : !loadingImages ? (
                                                <div className="absolute inset-0 flex flex-col items-center justify-center opacity-30 text-slate-500 p-8 text-center">
                                                    <div className="p-8 rounded-[36px] border-2 border-dashed border-slate-500"><ImageIcon size={52} strokeWidth={1} /></div>
                                                    <p className="text-sm font-black uppercase tracking-[0.3em] mt-7">{snapshotError ? 'CHYBA NAČÍTÁNÍ' : 'BEZ SCREENSHOTU'}</p>
                                                </div>
                                            ) : null}
                                        </AnimatePresence>
                                        {images.length > 1 && (
                                            <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-4 py-2 bg-black/60 backdrop-blur-xl rounded-full border border-white/10">
                                                <button onClick={() => setActiveImageIndex((activeImageIndex - 1 + images.length) % images.length)} className="p-1 text-white/50 hover:text-white"><ChevronLeft size={18} /></button>
                                                <span className="text-[10px] font-mono text-white/70">{activeImageIndex + 1} / {images.length}</span>
                                                <button onClick={() => setActiveImageIndex((activeImageIndex + 1) % images.length)} className="p-1 text-white/50 hover:text-white"><ChevronRight size={18} /></button>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>

                            {/* BOTTOM: AI + Notes (DESKTOP ONLY) — na mobile přesunuto do sidebar dole */}
                            <div className={`hidden lg:block flex-[2_2_0] min-h-0 overflow-y-auto no-scrollbar border-t ${isDark ? 'border-white/5 bg-theme-card-40' : 'border-slate-100 bg-slate-50/30'}`}>
                                <div className="px-5 lg:px-6 pt-3 pb-5 lg:pb-6 space-y-4">
                                    {/* Notes */}
                                    <div>
                                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] mb-3 flex items-center gap-2"><FileText size={12} /> Poznámky</p>
                                        <div className={`p-5 rounded-2xl border text-xs font-medium leading-[1.8] ${isDark ? 'bg-black/30 border-white/5 text-slate-400' : 'bg-white border-slate-100 text-slate-600'}`}>
                                            {activeTrade.notes || <span className="italic opacity-40">No log entry.</span>}
                                        </div>
                                    </div>
                                </div>
                            </div>

                        </div>{/* /RIGHT */}
                    </div>
                </motion.div>

                <ConfirmationModal
                    isOpen={isDeleteModalOpen}
                    onClose={() => setIsDeleteModalOpen(false)}
                    onConfirm={onDelete}
                    title="Smazat obchod"
                    message="Opravdu chcete tento obchod trvale odstranit z Alpha Matrixu? Tuto akci nelze vrátit."
                    theme={theme}
                />
            </div>

            {isZoomed && images.length > 0 && (
                <ImageZoomModal images={images} initialIndex={activeImageIndex} onClose={() => setIsZoomed(false)} />
            )}

            {isFullEditOpen && journalReviewOnly(activeTrade) && detailsLoadedTradeId !== String(trade.id) && (
                <div className="absolute inset-x-4 bottom-4 z-[130] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 text-xs text-[var(--text-primary)]" role="status">
                    {detailsLoadError ? <>Hodnocení nelze otevřít bez načtených poznámek a obrázků. <button className="ml-2 font-bold text-blue-500" onClick={() => setDetailsRetry(value => value + 1)}>Načíst znovu</button></> : 'Načítám podklady pro hodnocení…'}
                </div>
            )}
            {/* FULL EDIT MODE — ManualTradeForm overlay. Lazy chunk MUSÍ mít lokální
                Suspense — App.tsx:4117 renderuje modal mimo jakoukoli boundary a bez
                fallbacku by suspend při otevření editace shodil celou appku. */}
            {isFullEditOpen && onUpdateTrade && (!journalReviewOnly(activeTrade) || detailsLoadedTradeId === String(trade.id)) && (
                <React.Suspense fallback={null}>
                <ManualTradeForm
                    key={String(activeTrade.id)}
                    editTrade={activeTrade}
                    onUpdate={(updates) => {
                        // Označ „uloženo" až PO úspěšném dořešení (ManualTradeForm volá onClose
                        // teprve po resolve této promise) — jinak by průvodce postoupil i po selhání.
                        return Promise.resolve(onUpdateTrade(updates)).then(res => { if (res === false) throw new Error('review-save-unconfirmed'); wizardSavedRef.current = true; });
                    }}
                    onClose={() => {
                        if (startInEditMode) {
                            // Průvodce: uložení → další obchod; zrušení → konec průvodce.
                            if (wizardSavedRef.current) { wizardSavedRef.current = false; onSaved?.(); }
                            else { onClose(); }
                        } else {
                            setIsFullEditOpen(false);
                        }
                    }}
                    theme={theme}
                    accounts={accounts}
                    activeAccountId={String(activeTrade.accountId || '')}
                    availableEmotions={emotions}
                    availableMistakes={editPrefs.mistakes}
                    availableHtfOptions={editPrefs.htf}
                    availableLtfOptions={editPrefs.ltf}
                />
                </React.Suspense>
            )}

            {/* SHARE CARD MODAL — generuje shareable PNG s AlphaTrade brandingem */}
            {isShareCardOpen && (
                <TradeShareModal
                    trade={activeTrade}
                    username={(() => {
                        // Priority: name → email prefix → fallback
                        if (user?.name) return `@${user.name.toLowerCase().replace(/\s+/g, '')}`;
                        if (user?.email) return `@${user.email.split('@')[0]}`;
                        return '@trader';
                    })()}
                    avatarUrl={user?.avatar}
                    onClose={() => setIsShareCardOpen(false)}
                />
            )}
            </div>
        </ErrorBoundary>
    );
};

export default TradeDetailModal;
