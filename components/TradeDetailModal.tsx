import { journalDetailSelectionKey, mergeJournalDetailSelection } from '../services/journalTradeDetail';
import { JOURNAL_REVIEW_FIELDS, journalReviewOnly } from '../lib/journalReviewPatch';
import { isImageDecoded, preloadDecodedImage } from '../services/imageDecodeCache';
import type { PreparedJournalTradeDetail } from '../services/tradeHistoryWarmup';
import { explicitTradeMaster, isCombinedTrade, journalDisplayBalance, tradeAccountLabel, tradeDetailMembers, tradeDetailSource, tradeEstimateNotice } from '../lib/tradeHistoryPresentation';
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { pointValueFor } from '../services/tradovateImport';
import { motion } from 'framer-motion';
import {
    Play, X, Edit3, Trash2, Clock, Image as ImageIcon,
    Maximize2, ArrowRight, Timer, Terminal, ArrowUpRight, ArrowDownRight,
    Share2, Check, ChevronLeft, ChevronRight, ChevronDown, Zap, Brain, FileText, Target,
    ShieldCheck, Layers, Wallet, Save, CornerDownLeft, AlertOctagon, MoreHorizontal, BarChart3
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
import { initialRiskPoints } from '../lib/tradeReplay';
import { HistoryScreenshotSlot, clipboardImage, pasteTargetsEditable, type ScreenshotAttachStatus } from './HistoryScreenshotSlot';

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
    onPrefetchPrev?: () => void;
    onPrefetchNext?: () => void;
    preparedJournalDetail?: PreparedJournalTradeDetail;
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
    /** Nahraje a uloží snímek vložený přímo v detailu; vrací jeho URL, nebo null. */
    onAttachScreenshotFile?: (file: Blob) => Promise<string | null>;
}

const TradeDetailModal: React.FC<TradeDetailModalProps> = ({
    trade, accountName, theme, onClose, onDelete, emotions, onPrev, onNext, onPrefetchPrev, onPrefetchNext, preparedJournalDetail, hasPrev, hasNext,
    onUpdateTrade, pnlDisplayMode = 'usd', accounts = [], initialBalance, user, exchangeRates,
    allTrades = EMPTY_TRADES, startInEditMode = false, onSaved, onAttachScreenshotFile, loadJournalDetails = defaultLoadJournalDetails, loadTradeDetail = defaultLoadTradeDetail, signCopierSnapshots = storageService.createCopierSnapshotSignedUrls
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
    const detailLoadLookupId = journalReviewOnly(trade) ? null : detailLookupId;
    const selectedMembers = useMemo(() => tradeDetailMembers(trade, allTrades), [trade, allTrades]);
    const selectionKey = journalDetailSelectionKey(trade, selectedMembers);
    const detailLoadTrigger = journalReviewOnly(trade) ? selectionKey : trade;
    const tradeRef = useRef(trade);
    const selectedMembersRef = useRef(selectedMembers);
    tradeRef.current = trade;
    selectedMembersRef.current = selectedMembers;
    const [journalResult, setJournalResult] = useState<{ selectionKey: string; rows: Trade[] | null } | null>(null);
    const preparedJournal = useMemo(() => {
        if (!journalReviewOnly(trade) || preparedJournalDetail?.tradeId !== String(trade.id)) return null;
        try {
            return mergeJournalDetailSelection(trade, selectedMembers, preparedJournalDetail.rows);
        } catch {
            return null;
        }
    }, [preparedJournalDetail, selectedMembers, trade]);
    const currentJournal = useMemo(() => journalResult?.selectionKey === selectionKey
        ? journalResult
        : preparedJournal ? { selectionKey, rows: preparedJournal.members } : null,
    [journalResult, preparedJournal, selectionKey]);
    const journalPending = journalReviewOnly(trade) && !currentJournal?.rows;
    const [showJournalPending, setShowJournalPending] = useState(false);
    const [fullTrade, setFullTrade] = useState<Trade>(trade);
    const [isLoadingDetails, setIsLoadingDetails] = useState(false);
    const [detailsLoadError, setDetailsLoadError] = useState(false);
    const [detailsRetry, setDetailsRetry] = useState(0);
    // Id obchodu, pro který už doběhl lazy-load detailu (screenshoty z DB).
    const [detailsLoadedTradeId, setDetailsLoadedTradeId] = useState<string | null>(null);

    // Rychlý zásah cache se vejde před první zprávu. Při skutečně studeném
    // načtení zůstává ověřovací stav pravdivě skrytý a stav ukážeme až po 180 ms.
    useEffect(() => {
        if (!journalPending) {
            setShowJournalPending(false);
            return;
        }
        const timer = window.setTimeout(() => setShowJournalPending(true), 180);
        return () => window.clearTimeout(timer);
    }, [journalPending, selectionKey]);

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


    // Při změně propu nesmí starý fullTrade ani na jediný render vystupovat
    // jako nový obchod. Ověřený detail se připojí až se shodným id.
    const activeTrade = preparedJournal?.trade
        ?? (String(fullTrade.id) === String(trade.id) ? fullTrade : trade);

    useEffect(() => {
        const detailTrade = tradeRef.current;
        const detailMembers = selectedMembersRef.current;
        setFullTrade(detailTrade);
        setDetailsLoadError(false);
        if (journalReviewOnly(detailTrade)) {
            if (preparedJournal) {
                setFullTrade(preparedJournal.trade);
                setJournalResult({ selectionKey, rows: preparedJournal.members });
                setDetailsLoadedTradeId(String(detailTrade.id));
                setIsLoadingDetails(false);
                return;
            }
            const controller = new AbortController();
            setIsLoadingDetails(true);
            setDetailsLoadedTradeId(previous => previous === String(detailTrade.id) ? previous : null);
            void loadJournalDetails(isCombinedTrade(detailTrade) ? detailTrade.combinedTradeIds?.map(String) ?? [] : [String(detailTrade.id)], controller.signal)
                .then(rows => {
                    if (controller.signal.aborted) return;
                    const merged = mergeJournalDetailSelection(detailTrade, detailMembers, rows);
                    setFullTrade(merged.trade);
                    setJournalResult({ selectionKey, rows: merged.members });
                    setDetailsLoadedTradeId(String(detailTrade.id));
                }).catch(() => {
                    if (controller.signal.aborted) return;
                    setDetailsLoadError(true);
                    setJournalResult({ selectionKey, rows: null });
                }).finally(() => { if (!controller.signal.aborted) setIsLoadingDetails(false); });
            return () => controller.abort();
        }
        // If parent trade already has screenshot data, use it directly (no extra DB call)
        if (!journalReviewOnly(detailTrade) && (detailTrade.screenshot || (detailTrade.screenshots && detailTrade.screenshots.length > 0))) {
            // Předchozí (zrušený) lazy-load mohl nechat spinner zapnutý — vypni ho,
            // jinak by screenshot z props zůstal schovaný za spinnerem.
            setIsLoadingDetails(false);
            setDetailsLoadedTradeId(String(detailTrade.id));
            return;
        }
        let cancelled = false;
        // Keep an already opened editor mounted while its optimistic review refreshes.
        setDetailsLoadedTradeId(previous => previous === String(detailTrade.id) ? previous : null);
        const loadFull = async () => {
            // Bez guardu na isLoadingDetails: hodnota v closure je stále z prvního renderu
            // a při rychlém přepínání obchodů by načtení detailu úplně přeskočila.
            setIsLoadingDetails(true);
            let succeeded = false;
            try {
                if (detailLoadLookupId != null) {
                    const detailed = await loadTradeDetail(String(detailLoadLookupId));
                    // Merge only screenshot/screenshots from DB — keep parent prop's
                    // up-to-date fields (executionStatus, isValid, notes, etc.) so we
                    // don't overwrite an optimistic update with stale DB data.
                    if (journalReviewOnly(detailTrade) && (!detailed || String(detailed.id) !== String(detailLoadLookupId))) throw new Error("journal-review-details-unavailable");
                    if (detailed && !cancelled) {
                        succeeded = true;
                        setFullTrade(prev => ({
                            ...prev,
                            screenshot: detailed.screenshot ?? prev.screenshot,
                            screenshots: detailed.screenshots ?? prev.screenshots,
                            copierSnapshots: journalReviewOnly(detailTrade) ? detailed.copierSnapshots ?? [] : detailed.copierSnapshots ?? prev.copierSnapshots,
                            copierEpisodeId: journalReviewOnly(detailTrade) ? detailed.copierEpisodeId : detailed.copierEpisodeId ?? prev.copierEpisodeId,
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
                    if (succeeded || !journalReviewOnly(detailTrade)) setDetailsLoadedTradeId(String(detailTrade.id));
                }
            }
        };
        loadFull();
        return () => { cancelled = true; };
    // Journal detail tracks stable selected IDs; ordinary trades still track the full object.
    }, [detailLoadTrigger, detailLoadLookupId, detailsRetry, loadTradeDetail, loadJournalDetails, preparedJournal, selectionKey]);

    // Background list refreshes may carry newer review labels, but they must not
    // invalidate or overwrite the already verified financial/media snapshot.
    useEffect(() => {
        if (!journalReviewOnly(trade) || !currentJournal?.rows) return;
        const review = Object.fromEntries(Object.entries(trade).filter(([key, value]) => JOURNAL_REVIEW_FIELDS.has(key)
            && !['screenshot', 'screenshots', 'drawings'].includes(key) && value !== undefined));
        setFullTrade(previous => String(previous.id) === String(trade.id) ? { ...previous, ...review } : previous);
    }, [trade, currentJournal?.rows]);

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
    const [displayedImage, setDisplayedImage] = useState<{ tradeId: string; url: string } | null>(null);
    const [imageLoadError, setImageLoadError] = useState(false);
    const [visualMode, setVisualMode] = useState<'chart' | 'screenshots'>('screenshots');
    const [moreOpen, setMoreOpen] = useState(false);
    // Graf se připojí až při prvním otevření a pak zůstane — přepnutí zpět je okamžité.
    const [chartMounted, setChartMounted] = useState(false);
    // Každý návrat na graf = nové „postavení“ svíček.
    const [chartRevealKey, setChartRevealKey] = useState(0);
    useEffect(() => { if (visualMode === 'chart') { setChartMounted(true); setChartRevealKey(value => value + 1); } }, [visualMode]);
    const shotInputRef = useRef<HTMLInputElement>(null);
    const [isSigningSnapshots, setIsSigningSnapshots] = useState(false);
    const [snapshotSignError, setSnapshotSignError] = useState(false);
    const [signedCopierSnapshots, setSignedCopierSnapshots] = useState<Array<{
        kind: string; at: number; path: string; url: string;
    }>>([]);
    const [signedSnapshotTradeId, setSignedSnapshotTradeId] = useState<string | null>(null);
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

    // Snímek vložený právě v tomhle detailu. Ověřený řádek z mezipaměti ho ještě
    // nemá, takže se ukáže hned odsud — nečeká na další načtení z databáze.
    const [attachedShots, setAttachedShots] = useState<{ tradeId: string; urls: string[] }>({ tradeId: '', urls: [] });
    const [shotAttach, setShotAttach] = useState<ScreenshotAttachStatus | null>(null);
    const manualImages = useMemo(() => {
        const base = activeTrade.screenshots && activeTrade.screenshots.length > 0
            ? activeTrade.screenshots
            : (activeTrade.screenshot ? [activeTrade.screenshot] : []);
        const local = attachedShots.tradeId === String(activeTrade.id) ? attachedShots.urls.filter(url => !base.includes(url)) : [];
        return local.length ? [...local, ...base] : base;
    }, [activeTrade.id, activeTrade.screenshot, activeTrade.screenshots, attachedShots]);

    const attachShot = async (file: Blob) => {
        if (!onAttachScreenshotFile || shotAttach?.status === 'uploading') return;
        const tradeId = String(activeTrade.id);
        setShotAttach({ status: 'uploading' });
        const url = await onAttachScreenshotFile(file);
        if (!url) { setShotAttach({ status: 'error', message: 'Snímek se nepodařilo uložit.' }); return; }
        setAttachedShots(previous => ({ tradeId, urls: [url, ...(previous.tradeId === tradeId ? previous.urls : [])] }));
        setVisualMode('screenshots');
        setActiveImageIndex(0);
        setShotAttach({ status: 'saved' });
        window.setTimeout(() => setShotAttach(current => current?.status === 'saved' ? null : current), 1800);
    };
    const attachShotRef = useRef(attachShot);
    attachShotRef.current = attachShot;

    useEffect(() => { setShotAttach(null); }, [activeTrade.id]);

    // ⌘V v detailu přidá snímek k obchodu. Editační formulář má vlastní
    // vkládání a pole s textem patří textu — tam se nepřebíjí.
    useEffect(() => {
        if (!onAttachScreenshotFile || isFullEditOpen) return;
        const onPaste = (event: ClipboardEvent) => {
            if (event.defaultPrevented || pasteTargetsEditable(event.target)) return;
            const image = clipboardImage(event.clipboardData);
            if (!image) return;
            event.preventDefault();
            void attachShotRef.current(image);
        };
        window.addEventListener('paste', onPaste);
        return () => window.removeEventListener('paste', onPaste);
    }, [onAttachScreenshotFile, isFullEditOpen]);
    const currentSignedCopierSnapshots = useMemo(
        () => signedSnapshotTradeId === String(activeTrade.id)
            ? signedCopierSnapshots
            : preparedJournalDetail?.tradeId === String(activeTrade.id)
                ? preparedJournalDetail.signedCopierSnapshots
                : [],
        [activeTrade.id, preparedJournalDetail, signedCopierSnapshots, signedSnapshotTradeId],
    );
    const images = useMemo(() => [...manualImages, ...currentSignedCopierSnapshots.map(snapshot => snapshot.url)], [manualImages, currentSignedCopierSnapshots]);
    const requestedImageIndex = images.length > 0 ? Math.min(activeImageIndex, images.length - 1) : -1;
    const requestedImageUrl = requestedImageIndex >= 0 ? images[requestedImageIndex] : null;
    const displayedImageUrl = displayedImage?.tradeId === String(activeTrade.id) && images.includes(displayedImage.url)
        ? displayedImage.url
        : requestedImageUrl && isImageDecoded(requestedImageUrl) ? requestedImageUrl : null;
    const displayedImageIndex = displayedImageUrl ? images.indexOf(displayedImageUrl) : -1;
    const activeCopierSnapshot = displayedImageIndex >= manualImages.length
        ? currentSignedCopierSnapshots[displayedImageIndex - manualImages.length]
        : undefined;

    const requiresJournalMedia = journalReviewOnly(activeTrade);
    // Modal je hranice lazy-loadu: privátní cesty se podepíší až po otevření
    // detailu a ruční screenshoty zůstávají nedotčené.
    useEffect(() => {
        let cancelled = false;
        setSignedCopierSnapshots([]);
        setSignedSnapshotTradeId(null);
        setSnapshotSignError(false);
        setIsSigningSnapshots(false);
        // Journal media must come from the freshly read owner detail.
        if (requiresJournalMedia && (isLoadingDetails || detailsLoadedTradeId !== String(trade.id))) return () => { cancelled = true; };
        const snapshots = activeTrade.copierSnapshots ?? [];
        if (snapshots.length === 0) return () => { cancelled = true; };
        const preparedSnapshots = preparedJournalDetail?.tradeId === String(activeTrade.id)
            ? preparedJournalDetail.signedCopierSnapshots
            : null;
        const preparedPaths = new Set(preparedSnapshots?.map(snapshot => snapshot.path));
        if (preparedSnapshots && snapshots.every(snapshot => preparedPaths.has(snapshot.path))) {
            setSignedCopierSnapshots(preparedSnapshots);
            setSignedSnapshotTradeId(String(activeTrade.id));
            setSnapshotSignError(preparedSnapshots.length !== snapshots.length);
            return () => { cancelled = true; };
        }
        setIsSigningSnapshots(true);
        void signCopierSnapshots(snapshots)
            .then(items => {
                if (!cancelled) {
                    setSignedCopierSnapshots(items);
                    setSignedSnapshotTradeId(String(activeTrade.id));
                    setSnapshotSignError(items.length !== snapshots.length);
                }
            })
            .catch(() => { if (!cancelled) setSnapshotSignError(true); })
            .finally(() => { if (!cancelled) setIsSigningSnapshots(false); });
        return () => { cancelled = true; };
    }, [activeTrade.id, requiresJournalMedia, activeTrade.copierSnapshots, trade.id, isLoadingDetails, detailsLoadedTradeId, preparedJournalDetail, signCopierSnapshots]);

    useEffect(() => {
        if (activeImageIndex >= images.length) setActiveImageIndex(0);
    }, [activeImageIndex, images.length]);

    useEffect(() => {
        const requested = requestedImageUrl;
        if (!requested) {
            if (images.length === 0) setDisplayedImage(null);
            return;
        }
        let cancelled = false;
        setImageLoadError(false);
        void preloadDecodedImage(requested)
            .then(() => { if (!cancelled) setDisplayedImage({ tradeId: String(activeTrade.id), url: requested }); })
            .catch(() => { if (!cancelled) setImageLoadError(true); });
        // The active image has priority, while the rest of the small carousel is
        // decoded in advance so arrow clicks can cross-fade without a blank frame.
        for (const url of images) {
            if (url !== requested) void preloadDecodedImage(url).catch(() => undefined);
        }
        return () => { cancelled = true; };
    }, [activeTrade.id, images, requestedImageUrl]);

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

    // Reset error state when trade changes
    useEffect(() => { setImageLoadError(false); }, [activeTrade.id]);
    const snapshotError = Boolean(activeTrade.copierSnapshotLoadError || snapshotSignError || detailsLoadError || imageLoadError);
    const loadingImages = (isLoadingDetails && !displayedImageUrl) || (isSigningSnapshots && images.length === 0)
        || (images.length > 0 && !displayedImageUrl && !imageLoadError);
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

    // ── Odvozené hodnoty nového detailu ────────────────────────────────────
    const history = executionTrade.executionHistory;
    // R je vždy za jeden účet: u sloučené karty hlavní účet (v grafu vybraný).
    // Součet P&L všech účtů proti riziku jednoho by R zkreslil.
    const rTrade = isCombined
        ? (visualMode === 'chart' ? chartTrade : groupTrades.find(member => member.id === masterTradeIdInGroup) ?? groupTrades[0]) ?? executionTrade
        : executionTrade;
    const riskPts = initialRiskPoints(rTrade.executionHistory);
    const tradeQty = safeValue(rTrade.positionSize) || 1;
    const journalRiskUsd = riskPts != null ? riskPts * tradeQty * pointValueFor(rTrade.instrument) : null;
    // R: u deníku z SL platného při vstupu (doložené brokerem), jinak původní výpočet.
    const tileR = journalReviewOnly(activeTrade)
        ? (journalRiskUsd ? safeValue(rTrade.pnl) / journalRiskUsd : null)
        : (realRRR ?? null);
    const tileRiskUsd = journalReviewOnly(activeTrade) ? journalRiskUsd : (riskAmount > 0 ? riskAmount : null);
    const movePts = entryPrice > 0 && exitPrice > 0 ? (exitPrice - entryPrice) * (executionTrade.direction === 'Long' ? 1 : -1) : null;
    const grossFees = !isCombined && history && history.grossPnl != null ? { gross: history.grossPnl, fees: history.fees } : null;
    const fmtPrice = (value: number) => value.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtUsd = (value: number, signed = true) => `${signed ? (value < 0 ? '−' : value > 0 ? '+' : '') : ''}$${Math.abs(value).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const dateLabel = activeTrade.date ? new Date(activeTrade.date).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' }) : '—';
    const pnlHex = isMissed ? '#60a5fa' : isBEOverride ? '#f59e0b' : isWin ? (isDark ? '#34d399' : '#059669') : '#f43f5e';
    const needsReview = trade.needsReview === true || activeTrade.needsReview === true;
    const reviewChips = [
        ...(activeTrade.emotions ?? []).map(id => ({ key: `e:${id}`, label: getEmotionDetails(id).label, tone: 'purple' as const })),
        ...(activeTrade.mistakes ?? []).map(mistake => ({ key: `m:${mistake}`, label: mistake, tone: 'rose' as const })),
    ];
    const shotLabel = (index: number) => {
        if (index < manualImages.length) return `Snímek ${index + 1}`;
        const kind = currentSignedCopierSnapshots[index - manualImages.length]?.kind;
        return kind === 'entry' ? 'Vstup' : kind === 'exit' ? 'Výstup' : 'Auto';
    };
    const selectedShot = visualMode === 'screenshots' ? (displayedImageIndex >= 0 ? displayedImageIndex : activeImageIndex) : -1;
    const panel = isDark ? 'bg-theme-card border-white/10' : 'bg-white border-slate-200';
    const hairline = isDark ? 'border-white/[0.06]' : 'border-slate-200/80';
    const labelCls = 'text-[9.5px] font-black uppercase tracking-[0.12em] text-slate-500';
    const ghostBase = `h-8 w-8 items-center justify-center rounded-md transition-colors ${isDark ? 'text-slate-400 hover:bg-white/5 hover:text-white' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-900'}`;
    const ghostBtn = `inline-flex ${ghostBase}`;

    return (
        <ErrorBoundary name="TradeDetailModal">
            {journalPending && showJournalPending && <div className="fixed inset-0 z-[300] flex items-center justify-center bg-theme-page-95 backdrop-blur-2xl p-6">
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
                    initial={{ opacity: 0, scale: 0.97, y: 16 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97, y: 16 }}
                    className={`relative w-full max-w-[1600px] h-full lg:h-[85vh] rounded-none md:rounded-lg overflow-hidden shadow-[0_40px_80px_-40px_rgba(15,23,42,0.55)] flex flex-col border ${panel}`}
                >
                    {/* ── Hlavička ───────────────────────────────────────────── */}
                    <div className={`h-14 shrink-0 border-b flex items-center gap-2.5 px-3 md:px-5 z-20 ${hairline}`}>
                        <h2 className={`text-[19px] font-black tracking-tight shrink-0 ${isDark ? 'text-white' : 'text-slate-900'}`}>{activeTrade.instrument}</h2>
                        <span className={`h-[22px] px-2 rounded border inline-flex items-center gap-1 shrink-0 text-[9.5px] font-black uppercase tracking-[0.07em] ${directionColor}`}>
                            {isMissed ? <Clock size={10} /> : (activeTrade.direction === 'Long' ? <ArrowUpRight size={11} strokeWidth={3} /> : <ArrowDownRight size={11} strokeWidth={3} />)}
                            {isMissed ? 'Missed' : activeTrade.direction}
                        </span>
                        {!isMissed && (
                            <span className={`hidden sm:inline-flex h-[22px] px-2 rounded border items-center gap-1 shrink-0 text-[9.5px] font-black uppercase tracking-[0.07em] ${status === 'Invalid' ? 'text-rose-500 bg-rose-500/10 border-rose-500/20' : isDark ? 'text-slate-300 bg-white/5 border-white/10' : 'text-slate-600 bg-slate-100 border-slate-200'}`}>
                                {status === 'Invalid' ? <AlertOctagon size={10} strokeWidth={3} /> : <Check size={10} strokeWidth={3} />}
                                {status === 'Invalid' ? 'Nevalidní' : 'Validní'}
                            </span>
                        )}
                        <span className={`hidden md:inline text-[12.5px] whitespace-nowrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                            <b className={`font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{dateLabel}</b> · {formatTime(tradeEntryTime)} → {formatTime(exitTime)}
                        </span>
                        <span className="flex-1" />
                        {needsReview && (
                            <span className="hidden lg:inline-flex h-[22px] px-2 rounded border items-center gap-1.5 text-[9.5px] font-black uppercase tracking-[0.07em] text-amber-600 bg-amber-500/10 border-amber-500/30">
                                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />Nezkontrolováno
                            </span>
                        )}
                        {onUpdateTrade && (
                            <button type="button" onClick={(e) => { e.stopPropagation(); setIsFullEditOpen(true); }}
                                className={`h-8 px-2.5 sm:px-3 rounded-md text-[12px] font-bold whitespace-nowrap transition-colors ${needsReview ? 'bg-indigo-600 text-white hover:bg-indigo-500' : isDark ? 'border border-white/10 text-slate-300 hover:bg-white/5' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                                title={journalReviewOnly(activeTrade) ? 'Upravit hodnocení obchodu' : String(activeTrade.id).startsWith('combined_') ? 'Upravit obchod (změny se propíší na účty v aktuálním výběru)' : 'Upravit obchod'}>
                                {needsReview ? 'Zkontrolovat' : 'Upravit'}
                            </button>
                        )}
                        <span className={`hidden sm:block h-5 w-px ${isDark ? 'bg-white/10' : 'bg-slate-200'}`} />
                        <span className={`flex rounded-md border overflow-hidden ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
                            <button onPointerEnter={onPrefetchPrev} onPointerDown={onPrefetchPrev} onFocus={onPrefetchPrev} onClick={onPrev} disabled={!hasPrev} title="Předchozí obchod (←)"
                                className={`h-8 w-8 inline-flex items-center justify-center disabled:opacity-25 ${isDark ? 'text-slate-400 hover:bg-white/5 hover:text-white' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-900'}`}><ChevronLeft size={15} /></button>
                            <button onPointerEnter={onPrefetchNext} onPointerDown={onPrefetchNext} onFocus={onPrefetchNext} onClick={onNext} disabled={!hasNext} title="Další obchod (→)"
                                className={`h-8 w-8 inline-flex items-center justify-center border-l disabled:opacity-25 ${isDark ? 'border-white/10 text-slate-400 hover:bg-white/5 hover:text-white' : 'border-slate-200 text-slate-400 hover:bg-slate-50 hover:text-slate-900'}`}><ChevronRight size={15} /></button>
                        </span>
                        <button onClick={() => setIsShareCardOpen(true)} title="Sdílet jako kartu" className={`hidden sm:inline-flex ${ghostBase}`}><Share2 size={15} /></button>
                        <span className="relative">
                            <button type="button" onClick={() => setMoreOpen(value => !value)} title="Další akce" aria-expanded={moreOpen} className={ghostBtn}><MoreHorizontal size={16} /></button>
                            {moreOpen && (
                                <div className={`absolute right-0 top-10 z-50 w-52 rounded-lg border py-1 shadow-2xl ${panel}`} onMouseLeave={() => setMoreOpen(false)}>
                                    <button type="button" onClick={() => { setMoreOpen(false); setIsShareCardOpen(true); }} className={`sm:hidden w-full h-9 px-3 flex items-center gap-2 text-left text-[12px] font-semibold ${isDark ? 'text-slate-200 hover:bg-white/5' : 'text-slate-700 hover:bg-slate-50'}`}><Share2 size={13} /> Sdílet jako kartu</button>
                                    {onUpdateTrade && <button type="button" onClick={() => { setMoreOpen(false); setIsFullEditOpen(true); }} className={`w-full h-9 px-3 flex items-center gap-2 text-left text-[12px] font-semibold ${isDark ? 'text-slate-200 hover:bg-white/5' : 'text-slate-700 hover:bg-slate-50'}`}><Edit3 size={13} /> Upravit obchod</button>}
                                    {onUpdateTrade && !isMissed && <button type="button" onClick={() => { setMoreOpen(false); onUpdateTrade({ isBE: !isBEOverride } as any); }} className={`w-full h-9 px-3 flex items-center gap-2 text-left text-[12px] font-semibold ${isDark ? 'text-slate-200 hover:bg-white/5' : 'text-slate-700 hover:bg-slate-50'}`}
                                        title="Break-even ve statistikách bez ohledu na P&L"><span className="w-[13px] text-center">⚖</span> {isBEOverride ? 'Zrušit označení BE' : 'Označit jako BE'}</button>}
                                    <button type="button" onClick={(e) => { e.stopPropagation(); setMoreOpen(false); setIsDeleteModalOpen(true); }} className="w-full h-9 px-3 flex items-center gap-2 text-left text-[12px] font-semibold text-rose-500 hover:bg-rose-500/10"><Trash2 size={13} /> Smazat obchod</button>
                                </div>
                            )}
                        </span>
                        <span className={`hidden sm:block h-5 w-px ${isDark ? 'bg-white/10' : 'bg-slate-200'}`} />
                        <button onClick={onClose} title="Zavřít (Esc)" className={ghostBtn}><X size={17} /></button>
                    </div>

                    <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">

                        {/* ── Levý sloupec: výsledek, fakta, účty, hodnocení, snímky ── */}
                        <div className={`order-2 lg:order-1 w-full lg:w-[330px] flex-1 lg:flex-none shrink-0 border-t lg:border-t-0 lg:border-r flex flex-col z-10 overflow-y-auto no-scrollbar ${hairline} ${isDark ? 'bg-white/[0.015]' : 'bg-slate-50/70'}`}>
                            <div className={`px-5 pt-5 pb-4 border-b ${hairline}`} style={{ background: `linear-gradient(180deg, ${pnlHex}14, transparent)` }}>
                                <p className={labelCls}>{isCombined ? 'Čistý výsledek · vybrané účty' : 'Čistý výsledek · tento účet'}</p>
                                <h3 className="mt-2 text-[40px] font-light tracking-[-0.04em] leading-none tabular-nums whitespace-nowrap" style={{ color: pnlHex }}>{formattedPnL || '—'}</h3>
                                {grossFees && (
                                    <p className={`mt-2.5 text-[12px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                        Hrubě <b className={`font-medium tabular-nums ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{fmtUsd(grossFees.gross)}</b>
                                        {grossFees.fees != null && <> · poplatky <b className={`font-medium tabular-nums ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{fmtUsd(grossFees.fees, false)}</b></>}
                                    </p>
                                )}
                                {isBEOverride && <p className="mt-2 text-[11px] font-semibold text-amber-500">Označeno jako break-even</p>}
                                {estimateNotice && <p className="mt-2 text-[10.5px] leading-relaxed text-amber-500" role="note">{estimateNotice}</p>}
                            </div>

                            {journalReviewOnly(activeTrade) && isCombined && visualMode === 'chart' && (
                                <p className="px-5 pt-3 text-[9px] font-bold uppercase tracking-wider text-slate-500">Plnění · {accounts.find(account => account.id === executionTrade.accountId)?.name ?? accountName}</p>
                            )}
                            <div className={`grid grid-cols-2 border-b ${hairline} ${isDark ? 'bg-white/[0.02]' : 'bg-white'}`}>
                                {([
                                    ['Vstup', entryPrice > 0 ? fmtPrice(entryPrice) : '—', formatTime(tradeEntryTime), undefined],
                                    ['Výstup', exitPrice > 0 ? fmtPrice(exitPrice) : '—', formatTime(exitTime), undefined],
                                    ['Pohyb', movePts == null ? '—' : `${movePts >= 0 ? '+' : '−'}${fmtPrice(Math.abs(movePts))} b.`, undefined, movePts == null ? undefined : movePts >= 0 ? pnlHex : '#f43f5e'],
                                    ['Velikost', `${executionTrade.positionSize || 1} ${executionTrade.instrument || ''}`.trim(), undefined, undefined],
                                    ['Držení', String(holdTime).replace(/m$/, ' min'), undefined, undefined],
                                    ['R', tileR == null || !Number.isFinite(tileR) ? '—' : `${tileR.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} R`,
                                        tileRiskUsd != null ? `riziko ${fmtUsd(tileRiskUsd, false)}` : 'bez stopu', undefined],
                                ] as Array<[string, string, string | undefined, string | undefined]>).map(([label, value, sub, color], index) => (
                                    <div key={label} className={`px-4 py-2 ${index % 2 === 0 ? `border-r ${hairline}` : ''} ${index > 1 ? `border-t ${hairline}` : ''}`}>
                                        <p className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-500">{label}</p>
                                        <p className={`mt-0.5 text-[13.5px] font-medium tabular-nums whitespace-nowrap ${value === '—' ? 'text-slate-500' : isDark ? 'text-slate-100' : 'text-slate-900'}`} style={color ? { color } : undefined}>
                                            {value}{sub && <span className="ml-1.5 text-[10.5px] font-normal text-slate-500">{sub}</span>}
                                        </p>
                                    </div>
                                ))}
                            </div>
                            {!journalReviewOnly(activeTrade) && onUpdateTrade && (
                                <div className={`px-5 py-2 border-b grid grid-cols-2 gap-x-5 ${hairline}`}>
                                    <EditableNumberProperty label="STOP" value={executionTrade.stopLoss} placeholder="—" color="text-rose-500/80" icon={ShieldCheck} isDark={isDark}
                                        onSave={(val) => {
                                            const updates: Partial<Trade> = { stopLoss: val };
                                            if (val !== undefined && activeTrade.entryPrice && activeTrade.positionSize) {
                                                const risk = Math.abs(activeTrade.entryPrice - val) * activeTrade.positionSize * pointValueFor(activeTrade.instrument);
                                                updates.riskAmount = risk > 0 ? risk : undefined;
                                            } else updates.riskAmount = undefined;
                                            onUpdateTrade(updates);
                                        }} />
                                    <EditableNumberProperty label="TARGET" value={executionTrade.takeProfit} placeholder="—" color="text-emerald-500/80" icon={Zap} isDark={isDark}
                                        onSave={(val) => {
                                            const updates: Partial<Trade> = { takeProfit: val };
                                            if (val !== undefined && activeTrade.entryPrice && activeTrade.positionSize) {
                                                const target = Math.abs(val - activeTrade.entryPrice) * activeTrade.positionSize * pointValueFor(activeTrade.instrument);
                                                updates.targetAmount = target > 0 ? target : undefined;
                                            } else updates.targetAmount = undefined;
                                            onUpdateTrade(updates);
                                        }} />
                                </div>
                            )}

                            <div className="px-5 py-4 space-y-4">
                                {(() => {
                                    // Účty: master vždy nahoře, kopie schované za rozbalovací lištu.
                                    const visibleAccountTrades = groupTrades;
                                    if (visibleAccountTrades.length === 0) return null;
                                    const isMasterTrade = (gt: Trade) => masterTradeIdInGroup != null && gt.id === masterTradeIdInGroup;
                                    const masterTrade = visibleAccountTrades.find(isMasterTrade) || visibleAccountTrades[0];
                                    const copyTrades = visibleAccountTrades.filter(gt => gt.id !== masterTrade.id);
                                    const hasCopies = copyTrades.length > 0;
                                    const totalPnl = visibleAccountTrades.reduce((sum, gt) => sum + safeValue(gt.pnl), 0);
                                    const row = (gt: Trade, master: boolean) => {
                                        const acc = accounts.find(a => a.id === gt.accountId);
                                        const pnlVal = safeValue(gt.pnl);
                                        return (
                                            <>
                                                <span className={`h-[7px] w-[7px] rounded-full shrink-0 ${acc?.type === 'Funded' ? 'bg-purple-500' : 'bg-blue-500'}`} />
                                                <span className={`text-[12.5px] font-semibold truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{acc?.name || (gt.accountId === activeTrade.accountId ? accountName : gt.accountId)}</span>
                                                {master && visibleAccountTrades.length > 1 && <span className="text-[8px] font-black uppercase tracking-widest text-blue-500 shrink-0">Master</span>}
                                                <span className={`ml-auto text-[12.5px] font-semibold tabular-nums shrink-0 ${pnlVal >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{gt.pnlEstimated ? '≈ ' : ''}{formatValue(gt)}</span>
                                            </>
                                        );
                                    };
                                    return (
                                        <div>
                                            <div className="flex items-center justify-between mb-2">
                                                <p className={labelCls}>{hasCopies ? 'Účty' : 'Účet'}</p>
                                                {hasCopies && <span className="text-[10.5px] font-semibold text-slate-500">{tradeAccountLabel(visibleAccountTrades)} · <span className={`tabular-nums ${totalPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{visibleAccountTrades.some(member => member.pnlEstimated) ? '≈ ' : ''}{formatValue({ ...activeTrade, pnl: totalPnl })}</span></span>}
                                            </div>
                                            <div className={`rounded-md border overflow-hidden ${panel}`}>
                                                <button type="button" onClick={hasCopies ? () => setAccountsExpanded(v => !v) : undefined} aria-expanded={hasCopies ? accountsExpanded : undefined} disabled={!hasCopies}
                                                    className={`w-full px-3 py-2 flex items-center gap-2.5 text-left ${hasCopies ? (isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-slate-50') : 'cursor-default'}`}>
                                                    {row(masterTrade, isMasterTrade(masterTrade))}
                                                    {hasCopies && <span className={`flex items-center gap-1 pl-2.5 border-l text-[10.5px] font-bold shrink-0 ${hairline} text-slate-500`}>+{copyTrades.length}<ChevronDown size={12} className={`transition-transform ${accountsExpanded ? 'rotate-180' : ''}`} /></span>}
                                                </button>
                                                {hasCopies && accountsExpanded && copyTrades.map(gt => (
                                                    <div key={gt.id} className={`px-3 py-2 flex items-center gap-2.5 border-t ${hairline}`}>{row(gt, false)}</div>
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })()}

                                <div>
                                    <p className={`${labelCls} mb-2`}>Hodnocení</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {reviewChips.map(chip => (
                                            <span key={chip.key} className={`h-[26px] px-2 rounded inline-flex items-center text-[11px] font-semibold border ${chip.tone === 'purple' ? 'bg-purple-500/10 border-purple-500/20 text-purple-500' : 'bg-rose-500/10 border-rose-500/20 text-rose-500'}`}>{chip.label}</span>
                                        ))}
                                        {onUpdateTrade && (reviewChips.length === 0 ? ['+ Setup', '+ Emoce', '+ Chyby', '+ Tagy'] : ['+ Doplnit']).map(label => (
                                            <button key={label} type="button" onClick={() => setIsFullEditOpen(true)}
                                                className={`h-[26px] px-2 rounded border border-dashed text-[11px] transition-colors ${isDark ? 'border-slate-600 text-slate-500 hover:border-slate-400 hover:text-slate-300' : 'border-slate-300 text-slate-400 hover:border-slate-400 hover:text-slate-600'}`}>{label}</button>
                                        ))}
                                    </div>
                                </div>

                                <TradeConfluence trade={activeTrade} isDark={isDark} />
                                <TradeExecutionIntel trade={activeTrade} isDark={isDark} />

                                {/* Snímky a graf: náhledy přepnou plochu na snímek, řádek grafu na graf. */}
                                <div>
                                    <p className={`${labelCls} mb-2`}>Snímky</p>
                                    <div className="grid grid-cols-3 gap-1.5">
                                        {images.slice(0, 5).map((url, index) => (
                                            <button key={url} type="button" onClick={() => { setVisualMode('screenshots'); setActiveImageIndex(index); }}
                                                className={`relative aspect-[16/10] rounded-md overflow-hidden border transition-[box-shadow,border-color,opacity] ${selectedShot === index ? 'border-emerald-500 shadow-[0_0_0_1px_#10b981]' : hairline} ${visualMode === 'chart' ? 'opacity-55' : ''} ${isDark ? 'bg-black/30' : 'bg-slate-100'}`}>
                                                <img src={url} alt="" className="h-full w-full object-cover object-[30%_50%]" loading="lazy" />
                                                <span className={`absolute left-1 bottom-1 rounded px-1 text-[8.5px] font-black uppercase tracking-wide ${isDark ? 'bg-black/70 text-slate-200' : 'bg-white/90 text-slate-600'}`}>{shotLabel(index)}</span>
                                            </button>
                                        ))}
                                        {onAttachScreenshotFile && (
                                            <button type="button" onClick={() => shotInputRef.current?.click()} title="Vložit snímek ze schránky (⌘V) nebo vybrat soubor"
                                                className={`aspect-[16/10] rounded-md border border-dashed flex flex-col items-center justify-center gap-0.5 text-[10.5px] font-semibold transition-colors ${isDark ? 'border-slate-600 text-slate-500 hover:text-slate-300' : 'border-slate-300 text-slate-400 hover:text-slate-600'}`}>
                                                <span className="text-[13px] leading-none">＋</span>Vložit
                                            </button>
                                        )}
                                    </div>
                                    <input ref={shotInputRef} type="file" accept="image/*" className="hidden" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void attachShot(file); }} />
                                    <button type="button" onClick={() => setVisualMode('chart')}
                                        className={`mt-2 w-full flex items-center gap-3 px-3 py-2.5 rounded-md border text-left transition-[border-color,box-shadow] ${visualMode === 'chart' ? 'border-emerald-500 shadow-[0_0_0_1px_#10b981]' : hairline} ${isDark ? 'bg-white/[0.02]' : 'bg-white'}`}>
                                        <span className={`h-[30px] w-[30px] shrink-0 rounded-md grid place-items-center ${visualMode === 'chart' ? 'bg-emerald-500/10 text-emerald-500' : isDark ? 'bg-white/5 text-slate-400' : 'bg-slate-100 text-slate-500'}`}><BarChart3 size={16} /></span>
                                        <span className="min-w-0">
                                            <b className={`block text-[12.5px] ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Interaktivní graf</b>
                                            <span className="block truncate text-[11px] text-slate-500">{activeTrade.instrument} · 1 min · průběh SL/TP</span>
                                        </span>
                                        <span className={`ml-auto shrink-0 text-[10px] font-black uppercase tracking-[0.08em] ${visualMode === 'chart' ? 'text-emerald-500' : 'text-slate-500'}`}>{visualMode === 'chart' ? 'Zobrazeno' : 'Otevřít'}</span>
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* ── Pravá část: snímek ↔ graf a poznámka ─────────────── */}
                        <div className="order-1 lg:order-2 flex-none lg:flex-1 flex flex-col overflow-hidden min-w-0">
                            {/* Mobil: galerie je až pod plochou, přepínač proto stojí nad ní. */}
                            <div className={`lg:hidden shrink-0 flex justify-center border-b py-2 ${hairline}`}>
                                <div className={`flex rounded-md border overflow-hidden ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
                                    <button onClick={() => setVisualMode('screenshots')} className={`px-3 py-1.5 text-[10.5px] font-bold ${visualMode === 'screenshots' ? (isDark ? 'bg-white text-slate-900' : 'bg-slate-900 text-white') : 'text-slate-500'}`}>Snímky {images.length ? `(${images.length})` : ''}</button>
                                    <button onClick={() => setVisualMode('chart')} className={`px-3 py-1.5 text-[10.5px] font-bold ${visualMode === 'chart' ? (isDark ? 'bg-white text-slate-900' : 'bg-slate-900 text-white') : 'text-slate-500'}`}>Graf</button>
                                </div>
                            </div>
                            <div className={`relative group flex-none h-[420px] lg:flex-1 lg:h-auto lg:min-h-0 overflow-hidden ${isDark ? 'bg-black/20' : 'bg-slate-100/70'}`}>


                                {/* Snímek */}
                                <div className={`trade-stage-layer absolute inset-0 ${visualMode === 'screenshots' ? '' : 'is-off'}`}>
                                    {loadingImages && (
                                        <div className="absolute inset-0 flex items-center justify-center z-10">
                                            <div className="w-10 h-10 rounded-full border-2 border-white/10 border-t-emerald-500 animate-spin" />
                                        </div>
                                    )}
                                    {snapshotError && !isLoadingDetails && <div role="status" className={`absolute bottom-16 left-4 right-4 z-30 rounded-md border p-3 text-xs ${panel}`}>
                                        Snímky se nepodařilo úplně načíst.
                                        <button type="button" className="ml-2 font-bold text-blue-500" onClick={() => { setImageLoadError(false); setDetailsRetry(value => value + 1); }}>Zkusit znovu</button>
                                    </div>}
                                    {displayedImageUrl ? (
                                        <div className="absolute inset-0">
                                            <img src={displayedImageUrl} className="absolute inset-0 w-full h-full object-contain cursor-zoom-in" onClick={() => setIsZoomed(true)} onError={() => { setImageLoadError(true); setDisplayedImage(null); }} />
                                            {activeCopierSnapshot && (
                                                <div className="absolute top-3 left-3 z-20 rounded-md border border-white/10 bg-black/65 px-2.5 py-1.5 text-white backdrop-blur-md">
                                                    <p className="text-[9px] font-black uppercase tracking-widest">Auto · {activeCopierSnapshot.kind === 'entry' ? 'vstup' : activeCopierSnapshot.kind === 'exit' ? 'výstup' : activeCopierSnapshot.kind}</p>
                                                    <p className="mt-0.5 text-[9px] font-mono text-white/60">{new Date(activeCopierSnapshot.at).toLocaleTimeString('cs-CZ')}</p>
                                                </div>
                                            )}
                                            <button type="button" onClick={() => setIsZoomed(true)} className={`absolute right-3 bottom-3 z-20 h-8 px-2.5 inline-flex items-center gap-1.5 rounded-md border text-[11px] font-semibold backdrop-blur-md ${isDark ? 'bg-black/60 border-white/10 text-slate-200' : 'bg-white/90 border-slate-200 text-slate-600'}`}><Maximize2 size={12} /> Zvětšit</button>
                                        </div>
                                    ) : !loadingImages ? (
                                        onAttachScreenshotFile && !snapshotError ? (
                                            <div className="absolute inset-0">
                                                <HistoryScreenshotSlot variant="detail" light={!isDark} canAttach state={shotAttach} onPickFile={file => { void attachShot(file); }} />
                                            </div>
                                        ) : (
                                            <div className="absolute inset-0 flex flex-col items-center justify-center opacity-40 text-slate-500 p-8 text-center">
                                                <ImageIcon size={40} strokeWidth={1} />
                                                <p className="text-[11px] font-black uppercase tracking-[0.25em] mt-4">{snapshotError ? 'Chyba načítání' : 'Bez screenshotu'}</p>
                                            </div>
                                        )
                                    ) : null}
                                    {shotAttach && images.length > 0 && (
                                        <div role="status" className={`absolute top-3 right-3 z-30 inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-[11px] font-bold backdrop-blur-md ${shotAttach.status === 'error' ? 'border-rose-500/30 bg-rose-500/15 text-rose-500' : shotAttach.status === 'saved' ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-500' : 'border-indigo-500/30 bg-indigo-500/15 text-indigo-500'}`}>
                                            {shotAttach.status === 'uploading' ? 'Ukládám snímek…' : shotAttach.status === 'saved' ? 'Snímek uložen' : shotAttach.message}
                                        </div>
                                    )}
                                    {images.length > 1 && (
                                        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-3 py-1.5 bg-black/60 backdrop-blur-xl rounded-md border border-white/10">
                                            <button onClick={() => setActiveImageIndex((activeImageIndex - 1 + images.length) % images.length)} className="p-0.5 text-white/60 hover:text-white"><ChevronLeft size={16} /></button>
                                            <span className="text-[10px] font-mono text-white/70">{(displayedImageIndex >= 0 ? displayedImageIndex : activeImageIndex) + 1} / {images.length}</span>
                                            <button onClick={() => setActiveImageIndex((activeImageIndex + 1) % images.length)} className="p-0.5 text-white/60 hover:text-white"><ChevronRight size={16} /></button>
                                        </div>
                                    )}
                                </div>

                                {/* Graf — připojí se při prvním otevření a pak zůstává, aby přepnutí zpět bylo okamžité. */}
                                <div className={`trade-stage-layer absolute inset-0 flex flex-col ${visualMode === 'chart' ? '' : 'is-off'} ${isDark ? 'bg-[#090d12]' : 'bg-white'}`}>
                                    {chartMounted && (
                                        <React.Suspense fallback={<div className="absolute inset-0 flex items-center justify-center"><div className="w-10 h-10 rounded-full border-2 border-white/10 border-t-emerald-500 animate-spin" /></div>}>
                                            {chartTrade ? <>
                                                {isCombined && <div className={`shrink-0 h-9 flex items-center gap-2 px-3 border-b text-[10.5px] font-semibold text-slate-500 ${hairline}`}>
                                                    <label htmlFor="trade-chart-account">Účet v grafu</label>
                                                    <select id="trade-chart-account" value={chartTrade.accountId} onChange={event => setChartAccountId(event.target.value)} className={`min-w-0 max-w-[55%] rounded-md border px-2 py-0.5 ${panel}`}>
                                                        {[...new Set(groupTrades.map(member => member.accountId))].map(id => <option key={id} value={id}>{accounts.find(account => account.id === id)?.name || id}</option>)}
                                                    </select>
                                                    {accountChartTrades.length > 1 && <select aria-label="Realizace vybraného účtu" value={String(chartTrade.id)} onChange={event => setChartRealizationId(event.target.value)} className={`min-w-0 rounded-md border px-2 py-0.5 ${panel}`}>
                                                        {accountChartTrades.map((member, index) => <option key={member.id} value={String(member.id)}>Realizace {index + 1} · {new Date(member.timestamp).toLocaleTimeString('cs-CZ')}</option>)}
                                                    </select>}
                                                    {chartTrade.pnlEstimated && <span className="text-amber-500">Odhad podle leadera</span>}
                                                </div>}
                                                <div className="relative flex-1 min-h-0"><AccountExecutionChart trade={chartTrade} isDark={isDark} variant="detail" revealKey={chartRevealKey} verifiedDetail={currentJournal?.rows?.includes(chartTrade) ? chartTrade : undefined} /></div>
                                            </> : <p className="p-6 text-xs text-slate-500">Podklady vybraných účtů nejsou načtené.</p>}
                                        </React.Suspense>
                                    )}
                                </div>
                            </div>

                            {/* Poznámka */}
                            <div className={`shrink-0 border-t px-4 py-3 flex items-start gap-3 ${hairline}`}>
                                <span className={`${labelCls} pt-2.5 shrink-0`}>Poznámka</span>
                                {isEditingNotes ? (
                                    <textarea autoFocus value={editedNotes} onChange={event => setEditedNotes(event.target.value)}
                                        onBlur={handleSaveNotes}
                                        onKeyDown={event => { if (event.key === 'Escape') { setEditedNotes(activeTrade.notes || ''); setIsEditingNotes(false); } if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) handleSaveNotes(); }}
                                        rows={3} placeholder="Co se v obchodu stalo?"
                                        className={`flex-1 min-h-[72px] resize-y rounded-md border px-3 py-2 text-[12.5px] leading-relaxed outline-none ${isDark ? 'bg-black/30 border-white/10 text-slate-200' : 'bg-white border-slate-200 text-slate-700'}`} />
                                ) : (
                                    <button type="button" disabled={!onUpdateTrade} onClick={() => setIsEditingNotes(true)}
                                        className={`flex-1 text-left rounded-md border px-3 py-2 text-[12.5px] leading-relaxed max-h-[120px] overflow-y-auto whitespace-pre-wrap ${isDark ? 'bg-black/20 border-white/10 text-slate-300' : 'bg-white border-slate-200 text-slate-600'} ${onUpdateTrade ? 'cursor-text' : 'cursor-default'}`}>
                                        {activeTrade.notes || <span className="text-slate-400">Co se v obchodu stalo?</span>}
                                    </button>
                                )}
                            </div>
                        </div>
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
                <ImageZoomModal images={images} initialIndex={displayedImageIndex >= 0 ? displayedImageIndex : activeImageIndex} onClose={() => setIsZoomed(false)} />
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
