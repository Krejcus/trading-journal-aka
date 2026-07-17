import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Trade, Account, CustomEmotion, PnLDisplayMode, User } from '../types';
import { formatPnL } from '../utils/formatPnL';
import { ExchangeRates } from '../services/currencyService';
import { storageService } from '../services/storageService';
import { thumbMedium, thumbLarge, fullSize } from '../services/imageUrlService';
import {
  Trash2, TrendingUp, TrendingDown, X, Edit3, Calendar,
  Tag, DollarSign, FileText, Image as ImageIcon,
  ChevronRight, ChevronLeft, Wallet, Target, AlertTriangle, AlertCircle, Brain,
  ShieldCheck, ShieldAlert, BarChart3, Activity, Zap, Monitor,
  Maximize2, ArrowRight, Gauge, Hash, Ruler, Percent,
  Compass, Hourglass, Cpu, Terminal, Layers, ArrowUpRight, ArrowDownRight,
  Share2, Check, Copy, LayoutGrid, List, AlertOctagon, Clock, Timer, CheckCircle2, UploadCloud, Sparkles,
  MoreHorizontal, CheckSquare
} from 'lucide-react';
import { tradeNeedsEnrichment } from '../services/tradovateImport';

import TradeDetailModal from './TradeDetailModal';
import ImageZoomModal from './ImageZoomModal';
import ConfirmationModal from './ConfirmationModal';

// Levný podpis tradu pro detekci změny — vynechá base64 screenshoty (ty by JSON.stringify
// nafoukl na stovky KB). Screenshoty porovnáme zvlášť přes délku + KONEC URL.
const tradeSig = (t: any): string => {
  if (!t) return '';
  const { screenshot, screenshots, ...rest } = t;
  // Konec URL (unikátní filename ext_<ts>_<rand>.jpg), ne začátek — Supabase storage URL sdílí
  // ~70 znaků prefixu, takže slice(0,32) by nikdy nerozlišil dva různé screenshoty stejné délky.
  const shotKey = (typeof screenshot === 'string' ? `${screenshot.length}:${screenshot.slice(-40)}` : '')
    + '|' + (Array.isArray(screenshots) ? `${screenshots.length}:${screenshots.map((s: any) => typeof s === 'string' ? s.slice(-24) : '').join(',')}` : '');
  return JSON.stringify(rest) + '#' + shotKey;
};

// Entry čas obchodu (epoch ms) s fallbackem — historie se řadí podle OTEVŘENÍ pozice, ne exitu.
// entryTime (epoch) → entryDate (ISO) → timestamp (exit epoch) → date (exit ISO).
const entryMs = (t: any): number => {
  if (typeof t?.entryTime === 'number' && t.entryTime > 0) return t.entryTime;
  if (t?.entryDate) { const p = Date.parse(t.entryDate); if (!isNaN(p)) return p; }
  if (typeof t?.timestamp === 'number' && t.timestamp > 0) return t.timestamp;
  const d = Date.parse(t?.date); return isNaN(d) ? 0 : d;
};

// Jednotný badge „k doplnění" pro importované obchody bez screenshotu/konfluence.
// `card` = plovoucí pilulka v rohu karty, `inline` = malý štítek vedle instrumentu v tabulce.
const EnrichBadge = ({ variant }: { variant: 'card' | 'inline' }) => (
  variant === 'card' ? (
    <div
      className="absolute top-3 right-3 z-20 flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500 text-white text-[9px] font-black uppercase tracking-wider shadow-lg shadow-amber-500/30"
      title="Importováno — doplň screenshot a konfluence"
    >
      <Sparkles size={10} /> Doplnit
    </div>
  ) : (
    <span
      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-500 text-[8px] font-black uppercase tracking-wider"
      title="Importováno — doplň screenshot a konfluence"
    >
      <Sparkles size={8} /> Doplnit
    </span>
  )
);

// Badge „čeká se" — AlphaBridge obchod zapsaný před koncem dne; excursion se dopočítá,
// až graf pokryje celé okno (auto při otevření AlphaBridge, nebo ručně přes 🔄).
const PENDING_TITLE = 'Excursion se dopočítá, až graf pokryje celý den — otevři AlphaBridge na tomto instrumentu';
const PendingBadge = ({ variant }: { variant: 'card' | 'inline' }) => (
  variant === 'card' ? (
    <div
      className="absolute top-3 left-3 z-20 flex items-center gap-1 px-2 py-1 rounded-full bg-violet-500 text-white text-[9px] font-black uppercase tracking-wider shadow-lg shadow-violet-500/30"
      title={PENDING_TITLE}
    >
      <Clock size={10} /> Čeká se
    </div>
  ) : (
    <span
      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-400 text-[8px] font-black uppercase tracking-wider"
      title={PENDING_TITLE}
    >
      <Clock size={8} /> Čeká
    </span>
  )
);

interface TradeHistoryProps {
  trades: Trade[];
  accounts: Account[];
  onDelete: (id: number | string) => void;
  onClear: () => void;
  theme: 'dark' | 'light' | 'oled';
  emotions: CustomEmotion[];
  onUpdateTrade?: (tradeId: string | number, updates: Partial<Trade>) => void;
  allTrades?: Trade[];
  viewMode: 'grid' | 'table';
  setViewMode?: (mode: 'grid' | 'table') => void;
  pnlDisplayMode?: PnLDisplayMode;
  initialBalance?: number;
  user: User;
  exchangeRates: ExchangeRates;
  onImportTradovate?: () => void;
  onImportTradesyncer?: () => void;
  /** Inkrementuje se zvenčí (floating tlačítko / „Doplnit teď") pro spuštění průvodce doplněním. */
  enrichSignal?: number;
  /** Uživatelské kategorie chyb (Settings → Strategie → Katalog Chyb) — pro bulk-tag importovaných obchodů. */
  userMistakes?: string[];
}

const TradeHistory: React.FC<TradeHistoryProps> = ({
  trades, accounts, onDelete, onClear, theme, emotions, onUpdateTrade,
  pnlDisplayMode = 'usd', initialBalance, user, exchangeRates, allTrades = [],
  viewMode, setViewMode, onImportTradovate, onImportTradesyncer, enrichSignal, userMistakes = [],
}) => {
  const isDark = theme !== 'light';
  const targetCurrency = user.currency || 'USD';

  const formatValue = (val: number, mode: PnLDisplayMode = pnlDisplayMode, bal?: number, rr?: number, sign: boolean = true) => {
    return formatPnL(val, mode, bal, rr, sign, targetCurrency, exchangeRates);
  };

  // Price-based RR helper (jako TradingView) — preferuje entry/exit/stopLoss diff
  // před pnl/riskAmount poměrem (který zahrnuje fees).
  const priceBasedRR = (t: Trade): number | undefined => {
    if (t.entryPrice && t.exitPrice && t.stopLoss) {
      const profitMove = Math.abs(t.entryPrice - t.exitPrice);
      const riskMove = Math.abs(t.entryPrice - t.stopLoss);
      if (riskMove > 0) {
        const sign = (t.pnl || 0) >= 0 ? 1 : -1;
        return sign * (profitMove / riskMove);
      }
    }
    return t.riskAmount ? (t.pnl || 0) / t.riskAmount : undefined;
  };

  // Get account phase for a trade (account is source of truth, not trade.phase)
  const getTradePhase = (trade: Trade): string | null => {
    const account = accounts.find(a => a.id === trade.accountId);
    if (account?.type === 'Backtest') return 'Backtesting';
    return account?.phase || trade.phase || null;
  };

  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const [zoomImage, setZoomImage] = useState<{ images: string[]; index: number } | null>(null);
  // Rozbalené dny v sekci „Neplatné / mimo plán" (klíč = ISO datum).
  const [openInvalidDays, setOpenInvalidDays] = useState<Set<string>>(new Set());

  // --- ENRICHMENT (doplnění importovaných obchodů) ---
  const [enrichFilter, setEnrichFilter] = useState(false); // filtr „K doplnění"
  const [wizardMode, setWizardMode] = useState(false);      // průvodce: po zavření detailu otevři další

  // --- MULTI-SELECT STATE ---
  const [selectedTradeIds, setSelectedTradeIds] = useState<Set<string | number>>(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);

  // --- BULK TAG MODAL (pro hromadné tagování importovaných obchodů) ---
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagMistakes, setBulkTagMistakes] = useState<Set<string>>(new Set());
  const [bulkTagText, setBulkTagText] = useState('');
  const [bulkTagNotes, setBulkTagNotes] = useState('');
  const [bulkTagMarkDone, setBulkTagMarkDone] = useState(true); // C: defaultně archivovat z fronty

  // Kebab menu (sloučí "Vybrat více" + "Import Tradovate" + budoucí akce)
  const [kebabOpen, setKebabOpen] = useState(false);
  const kebabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!kebabOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (kebabRef.current && !kebabRef.current.contains(e.target as Node)) setKebabOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setKebabOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDocClick); document.removeEventListener('keydown', onEsc); };
  }, [kebabOpen]);

  // --- INFINITE SCROLL STATE ---
  const PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // --- LAZY SCREENSHOT CACHE ---
  // Init z globálního cache (naplněno v App.tsx po loadu) — žádný flash při mountu
  const [screenshotCache, setScreenshotCache] = useState<Map<string, { screenshot?: string; screenshots?: string[] }>>(
    () => new Map(storageService.getCachedScreenshots())
  );
  // Ref mirror of screenshotCache — avoids stale closure in stable callbacks
  const screenshotCacheRef = useRef<Map<string, { screenshot?: string; screenshots?: string[] }>>(new Map());
  const loadingScreenshotsRef = useRef<Set<string>>(new Set());
  // Tracks IDs we've already attempted to fetch (even if no screenshot was found)
  // This prevents re-fetching "no screenshot" trades every time the cache updates
  const fetchedIdsRef = useRef<Set<string>>(new Set());
  // Init z globálního setu — při návratu na tab nejsou cached images "znova loading"
  const [loadedImages, setLoadedImages] = useState<Set<string>>(
    () => new Set(storageService.getLoadedImageIds())
  );
  const [errorImages, setErrorImages] = useState<Set<string>>(new Set());

  // Keep ref in sync with state (synchronously inside setState so ref is always current)
  const updateScreenshotCache = useCallback((updater: (prev: Map<string, { screenshot?: string; screenshots?: string[] }>) => Map<string, { screenshot?: string; screenshots?: string[] }>) => {
    setScreenshotCache(prev => {
      const next = updater(prev);
      screenshotCacheRef.current = next;
      return next;
    });
  }, []);

  const handleImageLoad = (id: string) => {
    storageService.markImageLoaded(id); // persistent přes mount/unmount
    setLoadedImages(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const handleImageError = (id: string) => {
    setErrorImages(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    // Retry: fetch fresh screenshot from DB — may have been a transient error or expired URL
    if (loadingScreenshotsRef.current.has(id)) return;
    loadingScreenshotsRef.current.add(id);
    storageService.getTradeScreenshots([id]).then(results => {
      const fresh = results.get(id);
      if (fresh?.screenshot) {
        updateScreenshotCache(prev => {
          const next = new Map(prev);
          next.set(id, fresh);
          return next;
        });
        // Clear error flag so the img re-renders with fresh src
        setErrorImages(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }).catch(() => {}).finally(() => {
      loadingScreenshotsRef.current.delete(id);
    });
  };

  // Sync selectedTrade when trades change.
  // DŮLEŽITÉ: hledáme v `allTrades` (kompletní list), ne ve `trades` (po filtru).
  // Jinak po editaci na Invalid/Missed by trade vypadl z filtru "Valid only" a selectedTrade
  // by se neaktualizoval — modal by zůstal viset na staré verzi.
  useEffect(() => {
    if (selectedTrade) {
      const source = allTrades.length > 0 ? allTrades : trades;
      const updated = source.find(t => t.id === selectedTrade.id);
      // Levný podpis místo JSON.stringify celého tradu — ten dřív serializoval i inline base64
      // screenshot (stovky KB) synchronně při KAŽDÉ změně trades/allTrades → zásek UI.
      if (updated && updated !== selectedTrade && tradeSig(updated) !== tradeSig(selectedTrade)) {
        setSelectedTrade(updated);
      }
    }
  }, [trades, allTrades, selectedTrade]);

  // Obchody z importu, které ještě nemají doplněný screenshot/konfluence.
  const enrichTrades = useMemo(
    () => trades.filter(tradeNeedsEnrichment),
    [trades]
  );
  const enrichCount = enrichTrades.length;
  const enrichIds = useMemo(() => new Set(enrichTrades.map(t => String(t.id))), [enrichTrades]);

  // Jeden zdroj pravdy pro frontu průvodce: nedoplněné obchody chronologicky (nejstarší první),
  // volitelně bez konkrétního id (aktuálně řešený obchod).
  const buildEnrichQueue = useCallback((excludeId?: string | number) =>
    trades
      .filter(tradeNeedsEnrichment)
      .filter(t => excludeId == null || String(t.id) !== String(excludeId))
      .sort((a, b) => entryMs(a) - entryMs(b)),
    [trades]
  );

  // Řazeno podle ENTRY času (otevření pozice), nejnovější nahoře — ne podle exitu.
  const sortedTrades = useMemo(() => {
    const base = enrichFilter ? trades.filter(tradeNeedsEnrichment) : trades;
    return [...base].sort((a, b) => entryMs(b) - entryMs(a));
  }, [trades, enrichFilter]);

  // Pokud filtr „K doplnění" vyprázdní seznam (vše doplněno), vypni ho.
  useEffect(() => {
    if (enrichFilter && enrichCount === 0) setEnrichFilter(false);
  }, [enrichFilter, enrichCount]);

  // --- PRŮVODCE DOPLNĚNÍM ---
  // Otevři frontu od prvního nedoplněného obchodu.
  const startWizard = useCallback(() => {
    const queue = buildEnrichQueue();
    if (queue.length > 0) {
      setWizardMode(true);
      setSelectedTrade(queue[0]);
    }
  }, [buildEnrichQueue]);

  // enrichSignal se zvenčí inkrementuje (≥1) → spusť průvodce.
  // Ref init na undefined (ne na hodnotu propu) — jinak by se při mountu z jiné stránky,
  // kde už je signál inkrementovaný, hodnota rovnala a průvodce by se NESPUSTIL.
  // `!enrichSignal` ošetří jak undefined, tak výchozí 0 (= žádný požadavek).
  const enrichSignalRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!enrichSignal || enrichSignal === enrichSignalRef.current) return;
    enrichSignalRef.current = enrichSignal;
    startWizard();
  }, [enrichSignal, startWizard]);

  // Zavření detailu — ukončí i případný průvodce.
  const handleCloseDetail = useCallback(() => {
    setWizardMode(false);
    setSelectedTrade(null);
  }, []);

  // Po uložení v průvodci — skoč na další nedoplněný obchod (nebo skonči).
  const handleWizardAdvance = useCallback(() => {
    const remaining = buildEnrichQueue(selectedTrade?.id);
    if (remaining.length > 0) {
      setSelectedTrade(remaining[0]);
    } else {
      setWizardMode(false);
      setSelectedTrade(null);
    }
  }, [buildEnrichQueue, selectedTrade]);

  // Visible slice for rendering
  const visibleTrades = useMemo(() =>
    sortedTrades.slice(0, visibleCount),
    [sortedTrades, visibleCount]
  );
  const hasMore = visibleCount < sortedTrades.length;

  // Status helper + vyčlenění neplatných obchodů (tilt/mimo plán) do vlastní sekce.
  const tradeStatusOf = useCallback((t: Trade) => (t as any).executionStatus || ((t as any).isValid === false ? 'Invalid' : 'Valid'), []);
  const isInvalidTrade = useCallback((t: Trade) => tradeStatusOf(t) === 'Invalid', [tradeStatusOf]);
  // Plné karty renderují jen NEneplatné obchody (paginováno přes visibleTrades).
  const validTrades = useMemo(() => visibleTrades.filter(t => !isInvalidTrade(t)), [visibleTrades, isInvalidTrade]);

  // Předpočítané indexy pro detekci skupinových/copy obchodů. Dřív se pro KAŽDOU
  // vykreslenou kartu 2× lineárně skenoval celý allTrades (O(karty × N)) přímo v render
  // mapě → záseky při scrollu/načtení screenshotu. Teď O(1) lookup v Map.
  const { groupMap, fuzzyMap } = useMemo(() => {
    const src = allTrades.length > 0 ? allTrades : trades;
    const g = new Map<string, Trade[]>();
    const f = new Map<string, Trade[]>();
    for (const t of src) {
      if (t.groupId) {
        const arr = g.get(t.groupId);
        if (arr) arr.push(t); else g.set(t.groupId, [t]);
      }
      const fk = `${t.instrument}|${t.timestamp}|${t.direction}`;
      const fa = f.get(fk);
      if (fa) fa.push(t); else f.set(fk, [t]);
    }
    return { groupMap: g, fuzzyMap: f };
  }, [allTrades, trades]);
  const getGroupTrades = useCallback((trade: Trade): Trade[] => {
    let group: Trade[] = trade.groupId ? (groupMap.get(trade.groupId) || []) : [];
    if (group.length <= 1) {
      const fuzzy = fuzzyMap.get(`${trade.instrument}|${trade.timestamp}|${trade.direction}`) || [];
      if (fuzzy.length > 1) group = fuzzy;
    }
    return group;
  }, [groupMap, fuzzyMap]);


  // --- MULTI-SELECT HANDLERS ---
  const toggleTradeSelection = (tradeId: string | number) => {
    setSelectedTradeIds(prev => {
      const next = new Set(prev);
      if (next.has(tradeId)) {
        next.delete(tradeId);
      } else {
        next.add(tradeId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedTradeIds.size === visibleTrades.length) {
      setSelectedTradeIds(new Set());
    } else {
      setSelectedTradeIds(new Set(visibleTrades.map(t => t.id)));
    }
  };

  const handleDeleteSelected = () => {
    if (selectedTradeIds.size === 0) return;
    setBulkDeleteConfirmOpen(true);
  };

  const confirmDeleteSelected = () => {
    selectedTradeIds.forEach(id => onDelete(id));
    setSelectedTradeIds(new Set());
    setIsMultiSelectMode(false);
    setBulkDeleteConfirmOpen(false);
  };

  /** Aplikuje hromadný tag na vybrané obchody — append (ne overwrite) mistakes/tags,
   *  prepend notes (existující kontext zachová), volitelně označí jako "doplněno". */
  const applyBulkTag = () => {
    if (selectedTradeIds.size === 0 || !onUpdateTrade) return;
    const newMistakes = Array.from(bulkTagMistakes);
    const newTag = bulkTagText.trim();
    const newNote = bulkTagNotes.trim();
    selectedTradeIds.forEach(id => {
      const t = trades.find(x => String(x.id) === String(id));
      if (!t) return;
      const mergedMistakes = Array.from(new Set([...(t.mistakes || []), ...newMistakes]));
      const mergedTags = newTag
        ? Array.from(new Set([...(t.tags || []), newTag]))
        : t.tags;
      const mergedNotes = newNote
        ? (t.notes ? `${newNote}\n\n${t.notes}` : newNote)
        : t.notes;
      const updates: Partial<Trade> = {
        mistakes: mergedMistakes,
        tags: mergedTags,
        notes: mergedNotes,
      };
      if (bulkTagMarkDone) updates.enrichmentSkipped = true;
      onUpdateTrade(id, updates);
    });
    // Reset state + zavřít modal
    setBulkTagOpen(false);
    setBulkTagMistakes(new Set());
    setBulkTagText('');
    setBulkTagNotes('');
    setSelectedTradeIds(new Set());
    setIsMultiSelectMode(false);
  };

  const clearSelection = () => {
    setSelectedTradeIds(new Set());
    setIsMultiSelectMode(false);
  };

  // Fingerprint of first 20 trade IDs — catches filter/sort changes even when count doesn't change
  const tradesFingerprint = useMemo(
    () => trades.slice(0, 20).map(t => t.id).join(','),
    [trades]
  );

  // Reset visible count when trades change (e.g., filter applied, sort changed)
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    // NOTE: Do NOT reset loadedImages here. When background refresh fires with a different
    // fingerprint, setLoadedImages(new Set()) clears already-loaded IDs. But since the img
    // elements keep the same src (same base64 data), React won't remount them and onLoad
    // won't re-fire — leaving images permanently stuck at opacity-0 behind the skeleton.
    // New trade IDs not yet in loadedImages naturally show the skeleton until onLoad fires.
    setErrorImages(new Set());
    // Reset fetched tracking so new trade set gets fresh screenshots
    fetchedIdsRef.current = new Set();
  }, [tradesFingerprint]);

  // --- INTERSECTION OBSERVER: Load more on scroll ---
  useEffect(() => {
    if (!sentinelRef.current || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
          setIsLoadingMore(true);
          // Small delay for smooth animation
          setTimeout(() => {
            setVisibleCount(prev => Math.min(prev + PAGE_SIZE, sortedTrades.length));
            setIsLoadingMore(false);
          }, 600);
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, sortedTrades.length]);

  // --- LAZY SCREENSHOT LOADING ---
  // STABLE callback — uses refs only (no state deps), never recreated.
  // This breaks the stale-closure re-fetch loop: screenshotCache state changes
  // no longer cause loadScreenshots to be recreated and the effect to re-fire.
  const SCREENSHOT_BATCH = 5;
  const uuidRegex = useMemo(() => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, []);

  const loadScreenshots = useCallback(async (tradesToLoad: Trade[]) => {
    const missing = tradesToLoad.filter(t =>
      typeof t.id === 'string' &&
      uuidRegex.test(t.id) &&
      !t.screenshot &&                                    // skip trades that already carry screenshot inline
      !screenshotCacheRef.current.has(String(t.id)) &&   // skip already cached
      !fetchedIdsRef.current.has(String(t.id)) &&        // skip already attempted (even if empty result)
      !loadingScreenshotsRef.current.has(String(t.id))   // skip currently in-flight
    );

    if (missing.length === 0) return;

    const ids = missing.map(t => String(t.id));
    ids.forEach(id => loadingScreenshotsRef.current.add(id));

    // Fetch in small batches to avoid heavy payloads timing out
    for (let i = 0; i < ids.length; i += SCREENSHOT_BATCH) {
      const batch = ids.slice(i, i + SCREENSHOT_BATCH);
      // queryRan = true means the DB query actually executed (userId was available).
      // Only mark as "fetched" when queryRan — if auth wasn't ready, leave IDs
      // out of fetchedIdsRef so they'll be retried on the next trigger.
      let queryRan = false;
      try {
        const results = await storageService.getTradeScreenshots(batch);
        queryRan = true; // resolving (even empty) means auth was ready and query ran
        if (results.size > 0) {
          updateScreenshotCache(prev => {
            const next = new Map(prev);
            results.forEach((value, key) => {
              if (value.screenshot) next.set(key, value);
            });
            return next;
          });
        }
      } catch (err) {
        // queryRan stays false — auth wasn't ready or network error → will retry
        console.error('[Screenshots] Batch fetch failed, will retry:', err);
      } finally {
        batch.forEach(id => {
          loadingScreenshotsRef.current.delete(id);
          // Only mark as done if the query actually ran against the DB.
          // If auth wasn't ready (threw), leave out so next trigger retries.
          if (queryRan) fetchedIdsRef.current.add(id);
        });
      }
    }
  }, [updateScreenshotCache, uuidRegex]);

  // Trigger screenshot loading when visibleTrades changes.
  // loadScreenshots is stable ([] deps) so this only fires on actual changes.
  // On fresh load, if auth isn't ready yet, a 1-second retry fires to catch
  // the case where IndexedDB served cached trades before Supabase session initialized.
  useEffect(() => {
    if (visibleTrades.length === 0) return;
    loadScreenshots(visibleTrades);
    // Retry after 1s for the "auth not ready on first render" case:
    // If all IDs were skipped due to missing userId, fetchedIdsRef won't have them
    // and this retry will succeed once the session is established.
    const retryTimer = setTimeout(() => loadScreenshots(visibleTrades), 1200);
    return () => clearTimeout(retryTimer);
  }, [visibleTrades, loadScreenshots]);

  // PREFETCH ALL screenshoty jedním query při mountu — eliminate flash při scroll/lazy load.
  // Po dokončení má každý visible trade screenshot okamžitě z cache, žádný per-batch query.
  useEffect(() => {
    let cancelled = false;
    const prefetch = async () => {
      try {
        const all = await storageService.prefetchAllScreenshots();
        if (cancelled || all.size === 0) return;
        updateScreenshotCache(prev => {
          const next = new Map(prev);
          all.forEach((v, k) => {
            if (!next.has(k) && (v.screenshot || (v.screenshots && v.screenshots.length > 0))) {
              next.set(k, v);
            }
          });
          return next;
        });
        // Mark all prefetched IDs as fetched — zabrání retry logic v loadScreenshots
        all.forEach((_, id) => fetchedIdsRef.current.add(id));
      } catch (err) {
        console.warn('[Screenshots] Prefetch failed (will fall back to lazy):', err);
      }
    };
    prefetch();
    return () => { cancelled = true; };
  }, [updateScreenshotCache]);

  // Helper: get screenshot for a trade (prefer cache over inline field)
  // Uses screenshotCache STATE (not ref) so React re-renders when cache updates
  const getScreenshot = (trade: Trade): string | undefined => {
    return screenshotCache.get(String(trade.id))?.screenshot || trade.screenshot || undefined;
  };

  const getScreenshots = (trade: Trade): string[] | undefined => {
    const cached = screenshotCache.get(String(trade.id))?.screenshots;
    if (cached && cached.length > 0) return cached;
    if (trade.screenshots && trade.screenshots.length > 0) return trade.screenshots;
    return undefined;
  };

  const formatTradeDate = (dateStr: string) => {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return { date: dateStr, time: '' };

    const date = d.toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

    // If time is exactly 01:00 (CET) or 00:00 (UTC), it's likely a date-only timestamp
    const isPlaceholderTime = time === '01:00' || time === '00:00';

    return { date, time, isPlaceholderTime };
  };

  const getAccountName = (id: string) => accounts.find(a => a.id === id)?.name || 'Neznámý účet';
  const getEmotionDetails = (emoId: string) => emotions.find(e => e.id === emoId) || { label: emoId };

  // Neplatné obchody agregované po dni (1 karta = 1 session píčovin). Počítáme z VŠECH
  // (ne jen z viditelné stránky), ať mezisoučet PnL za den sedí. Řazeno nejnovější nahoře.
  const invalidDays = useMemo(() => {
    const groups = new Map<string, Trade[]>();
    for (const t of sortedTrades) {
      if (!isInvalidTrade(t)) continue;
      const key = String(t.entryDate || t.date || '').slice(0, 10) || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }
    return Array.from(groups.entries())
      .map(([key, items]) => ({
        key,
        items: [...items].sort((a, b) => entryMs(b) - entryMs(a)),
        pnl: items.reduce((s, t) => s + (t.pnl || 0), 0),
        label: items[0] ? formatTradeDate(items[0].entryDate || items[0].date).date : key,
      }))
      .sort((a, b) => b.key.localeCompare(a.key));
  }, [sortedTrades, isInvalidTrade]);

  const toggleInvalidDay = (key: string) => setOpenInvalidDays(prev => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-700 pb-20 pt-4">

      <ConfirmationModal
        isOpen={bulkDeleteConfirmOpen}
        onClose={() => setBulkDeleteConfirmOpen(false)}
        onConfirm={confirmDeleteSelected}
        title={`Smazat ${selectedTradeIds.size} obchodů`}
        message={`Opravdu chcete smazat ${selectedTradeIds.size} vybraných obchodů? Tato akce je nevratná.`}
        confirmText="Smazat"
        cancelText="Zrušit"
        variant="danger"
        theme={theme}
      />

      {/* Multi-Select Toolbar */}
      <div className="flex items-center gap-3 mb-4 px-2">
        {!isMultiSelectMode && enrichCount > 0 && (
          <button
            onClick={() => setEnrichFilter(v => !v)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg font-bold text-sm transition-all active:scale-95 ${
              enrichFilter
                ? 'bg-amber-500 text-white'
                : 'bg-amber-500/15 text-amber-500 border border-amber-500/30 hover:bg-amber-500/25'
            }`}
            title="Zobrazit jen importované obchody bez screenshotu/konfluence"
          >
            <Sparkles size={14} /> K doplnění ({enrichCount})
          </button>
        )}

        {!isMultiSelectMode && enrichFilter && enrichCount > 0 && (
          <button
            onClick={startWizard}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg font-bold text-sm transition-all bg-emerald-600 hover:bg-emerald-500 text-white active:scale-95"
            title="Projít nedoplněné obchody jeden po druhém"
          >
            <ChevronRight size={14} /> Doplnit postupně
          </button>
        )}

        {!isMultiSelectMode && (
          <div className="ml-auto relative" ref={kebabRef}>
            <button
              onClick={() => setKebabOpen(v => !v)}
              className={`flex items-center justify-center w-9 h-9 rounded-lg transition-all active:scale-95 ${
                kebabOpen
                  ? theme === 'light'
                    ? 'bg-slate-200 text-slate-700'
                    : 'bg-slate-700 text-slate-100'
                  : theme === 'light'
                    ? 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    : 'bg-slate-700/50 text-slate-300 hover:bg-slate-600/50'
              }`}
              title="Další akce"
              aria-label="Další akce"
            >
              <MoreHorizontal size={18} />
            </button>

            <AnimatePresence>
              {kebabOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -4, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.96 }}
                  transition={{ duration: 0.12 }}
                  className={`absolute right-0 mt-2 w-56 rounded-xl shadow-lg border overflow-hidden z-30 ${
                    theme === 'light'
                      ? 'bg-white border-slate-200'
                      : 'bg-slate-800 border-slate-700'
                  }`}
                >
                  {setViewMode && (
                    <div className={`px-3 pt-3 pb-2 ${theme === 'light' ? 'border-b border-slate-200' : 'border-b border-slate-700'}`}>
                      <div className={`text-[9px] font-black uppercase tracking-widest mb-1.5 px-1 ${theme === 'light' ? 'text-slate-400' : 'text-slate-500'} flex items-center gap-1.5`}>
                        <LayoutGrid size={10} /> Zobrazení
                      </div>
                      <div className={`flex p-0.5 rounded-lg relative ${theme === 'light' ? 'bg-slate-100' : 'bg-slate-900/60'}`}>
                        <motion.div
                          animate={{ x: (viewMode === 'grid' ? 0 : 100) + '%' }}
                          transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                          className={`absolute inset-y-0.5 left-0.5 w-[calc((100%-4px)/2)] rounded-md ${theme === 'light' ? 'bg-white shadow-sm' : 'bg-slate-700'}`}
                        />
                        {([{ id: 'grid', label: 'Mřížka', Icon: LayoutGrid }, { id: 'table', label: 'Tabulka', Icon: List }] as const).map(v => (
                          <button
                            key={v.id}
                            onClick={() => setViewMode(v.id)}
                            className={`flex-1 relative z-10 py-1.5 rounded-md text-[10px] font-black uppercase tracking-wider transition-colors flex items-center justify-center gap-1.5 ${
                              viewMode === v.id
                                ? (theme === 'light' ? 'text-slate-900' : 'text-white')
                                : (theme === 'light' ? 'text-slate-500' : 'text-slate-400')
                            }`}
                          >
                            <v.Icon size={11} /> {v.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <button
                    onClick={() => { setKebabOpen(false); setIsMultiSelectMode(true); }}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm font-semibold text-left transition-colors ${
                      theme === 'light' ? 'hover:bg-slate-100 text-slate-700' : 'hover:bg-slate-700/60 text-slate-200'
                    }`}
                  >
                    <CheckSquare size={16} className="opacity-70" /> Vybrat více
                  </button>
                  {onImportTradovate && (
                    <button
                      onClick={() => { setKebabOpen(false); onImportTradovate(); }}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm font-semibold text-left transition-colors ${
                        theme === 'light' ? 'hover:bg-slate-100 text-slate-700' : 'hover:bg-slate-700/60 text-slate-200'
                      }`}
                    >
                      <UploadCloud size={16} className="opacity-70" /> Import Tradovate
                    </button>
                  )}
                  {onImportTradesyncer && (
                    <button
                      onClick={() => { setKebabOpen(false); onImportTradesyncer(); }}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm font-semibold text-left transition-colors ${
                        theme === 'light' ? 'hover:bg-slate-100 text-slate-700' : 'hover:bg-slate-700/60 text-slate-200'
                      }`}
                    >
                      <UploadCloud size={16} className="opacity-70" /> Import Tradesyncer
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {isMultiSelectMode && (
          <button
            onClick={clearSelection}
            className={`px-4 py-2 rounded-lg font-bold text-sm transition-all bg-cyan-500/20 text-cyan-400 border border-cyan-500/30`}
          >
            Zrušit výběr
          </button>
        )}

        {isMultiSelectMode && (
          <>
            <button
              onClick={toggleSelectAll}
              className={`px-4 py-2 rounded-lg font-bold text-sm transition-all ${theme === 'light' ? 'bg-slate-100 text-slate-500 border border-slate-200 hover:bg-slate-200' : 'bg-slate-700/50 text-slate-300 border border-slate-600/30 hover:bg-slate-600/50'}`}
            >
              {selectedTradeIds.size === visibleTrades.length ? 'Zrušit vše' : 'Vybrat vše'}
            </button>

            {selectedTradeIds.size > 0 && enrichFilter && onUpdateTrade && (
              <button
                onClick={() => setBulkTagOpen(true)}
                className="px-4 py-2 rounded-lg font-bold text-sm bg-amber-500/20 text-amber-500 border border-amber-500/40 hover:bg-amber-500/30 transition-all flex items-center gap-2"
                title="Přidat chyby/tagy najednou k vybraným importovaným obchodům"
              >
                <Sparkles size={16} />
                Hromadně otagovat ({selectedTradeIds.size})
              </button>
            )}

            {selectedTradeIds.size > 0 && (
              <button
                onClick={handleDeleteSelected}
                className="px-4 py-2 rounded-lg font-bold text-sm bg-rose-500/20 text-rose-400 border border-rose-500/30 hover:bg-rose-500/30 transition-all flex items-center gap-2"
              >
                <Trash2 size={16} />
                Smazat vybrané ({selectedTradeIds.size})
              </button>
            )}
          </>
        )}
      </div>

      {/* Neplatné / mimo plán — 1 karta = 1 session píčovin (agregát po dni, jen PnL).
          NAD gridem: dole byla s infinite scrollem nedosažitelná (nové karty ji odsouvaly)
          a obchod označený jako nevalidní tak „beze stopy zmizel". */}
      {invalidDays.length > 0 && (
        <div className="mb-6 space-y-3">
          {invalidDays.map(day => {
            const open = openInvalidDays.has(day.key);
            const dayWin = day.pnl > 0.01;
            const dayBE = Math.abs(day.pnl) <= 0.01;
            const pnlColor = dayBE ? 'text-amber-500' : (dayWin ? 'text-emerald-500' : 'text-rose-500');
            return (
              <div key={day.key} className={`rounded-2xl border overflow-hidden ${theme !== 'light' ? 'bg-amber-500/[0.04] border-amber-500/20' : 'bg-amber-50 border-amber-200'}`}>
                {/* Hlavička dne — klik = rozbalit */}
                <button
                  onClick={() => toggleInvalidDay(day.key)}
                  className="w-full flex items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-amber-500/[0.06]"
                >
                  <ChevronRight size={16} className={`text-amber-500 transition-transform duration-200 shrink-0 ${open ? 'rotate-90' : ''}`} />
                  <AlertTriangle size={15} className="text-amber-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-black ${theme !== 'light' ? 'text-slate-100' : 'text-slate-800'}`}>
                      Neplatné / mimo plán
                    </div>
                    <div className="text-[11px] font-bold text-amber-600/80 uppercase tracking-wider">
                      {day.label} · {day.items.length} {day.items.length === 1 ? 'obchod' : day.items.length < 5 ? 'obchody' : 'obchodů'}
                    </div>
                  </div>
                  <div className={`text-lg font-black font-mono ${pnlColor} shrink-0`}>
                    {day.pnl >= 0 ? '+' : '−'}${Math.abs(Math.round(day.pnl)).toLocaleString('en-US')}
                  </div>
                </button>

                {/* Slim řádky — rozbalené */}
                {open && (
                  <div className={`border-t ${theme !== 'light' ? 'border-amber-500/15 divide-y divide-white/5' : 'border-amber-200 divide-y divide-slate-100'}`}>
                    {day.items.map(t => {
                      const win = t.pnl > 0.01;
                      const be = Math.abs(t.pnl) <= 0.01;
                      const c = be ? 'text-amber-500' : (win ? 'text-emerald-500' : 'text-rose-500');
                      const isLong = String(t.direction || '').toLowerCase() === 'long';
                      const dt = new Date(t.timestamp || Date.parse(t.date));
                      const hhmm = isNaN(dt.getTime()) ? '' : dt.toTimeString().slice(0, 5);
                      return (
                        <div
                          key={t.id}
                          onClick={() => !isMultiSelectMode && setSelectedTrade(t)}
                          className="flex items-center gap-3 px-5 py-2.5 text-[13px] cursor-pointer hover:bg-white/[0.03] transition-colors"
                        >
                          <span className="font-mono text-slate-500 w-[42px] shrink-0">{hhmm}</span>
                          <span className={`font-bold ${theme !== 'light' ? 'text-slate-200' : 'text-slate-700'}`}>{t.instrument}</span>
                          <span className={`text-[10px] font-black uppercase ${isLong ? 'text-emerald-500' : 'text-rose-500'} shrink-0`}>
                            {isLong ? '▲' : '▼'} {t.direction}
                          </span>
                          <span className="flex-1 min-w-0 truncate text-slate-500">{getAccountName(t.accountId)}</span>
                          <span className={`font-mono font-bold ${c} shrink-0`}>
                            {t.pnl >= 0 ? '+' : '−'}${Math.abs(Math.round(t.pnl)).toLocaleString('en-US')}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {viewMode === 'grid' ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {validTrades.map((trade) => {
            const status = trade.executionStatus || (trade.isValid === false ? 'Invalid' : 'Valid');
            const isMissed = status === 'Missed';
            const isBE = (trade as any).isBE === true || Math.abs(trade.pnl) <= 0.01;
            const isWin = !isBE && trade.pnl > 0.01;

            let glowClass = isWin
              ? 'neon-border-green neon-glow-green'
              : isBE
                ? 'neon-border-amber neon-glow-amber'
                : 'neon-border-red neon-glow-red';
            // Missed: stejný pulzující rámeček jako ostatní, ale modrý + lehce zšedlý
            // (zachová tvar/vzhled karty, jen jasně signalizuje že obchod nebyl proveden)
            if (isMissed) glowClass = 'neon-border-blue neon-glow-blue grayscale-[0.45] opacity-80';

            const pnlColor = isMissed
              ? 'text-blue-400'
              : isBE
                ? 'text-amber-500'
                : (isWin ? 'text-emerald-500' : 'text-rose-500');
            const tradeHex = !isNaN(Number(trade.id))
              ? `0x${Math.abs(Number(trade.id)).toString(16).padStart(6, '0')}`
              : `0xCOMB`;

            const tradeScreenshot = getScreenshot(trade);
            const tradeScreenshots = getScreenshots(trade);
            const isImageLoaded = loadedImages.has(String(trade.id));
            const needsEnrich = enrichIds.has(String(trade.id));

            const tradeAccount = accounts.find(a => a.id === trade.accountId);
            // Find group trades using same logic as TradeDetailModal (groupId + fuzzy) — O(1) přes index
            const groupTrades = getGroupTrades(trade);
            const isGroupTrade = groupTrades.length > 1;
            const isCombinedCard = String(trade.id).startsWith('combined_');
            const masterTrade = groupTrades.find(t => t.isMaster) || groupTrades[0];
            const masterAcc = isGroupTrade ? accounts.find(a => a.id === masterTrade?.accountId) : null;
            const copyCount = isGroupTrade ? groupTrades.length - 1 : 0;
            const isCopyCard = isGroupTrade && !isCombinedCard && trade.id !== masterTrade?.id;
            const isMasterCard = isGroupTrade && !isCombinedCard && trade.id === masterTrade?.id;

            return (
              <div
                key={trade.id}
                onClick={() => !isMultiSelectMode && setSelectedTrade(trade)}
                className={`group relative flex flex-col md:flex-row h-auto md:h-56 rounded-[24px] border overflow-hidden transition-all duration-500 cursor-pointer ${glowClass} glass-panel hover:scale-[1.01] ${
                  selectedTradeIds.has(trade.id) ? 'ring-2 ring-cyan-400' : ''
                }`}
              >
                {/* Badge „k doplnění" pro importované obchody bez kontextu */}
                {needsEnrich && !isMultiSelectMode && <EnrichBadge variant="card" />}
                {/* Badge „čeká se" — excursion se teprve dopočítá (den nedojel do konce) */}
                {(trade as any).excursionComplete === false && !isMultiSelectMode && <PendingBadge variant="card" />}

                {/* Multi-Select Checkbox */}
                {isMultiSelectMode && (
                  <div
                    className="absolute top-3 left-3 z-20"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleTradeSelection(trade.id);
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedTradeIds.has(trade.id)}
                      onChange={() => {}}
                      className="w-5 h-5 cursor-pointer accent-cyan-500"
                    />
                  </div>
                )}


                <div className="flex-1 flex flex-col justify-between p-6 min-w-0 relative z-10">
                  <div className="space-y-2.5">
                    {/* Row 1: Datum (zvýrazněno) */}
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <Calendar size={11} className="text-slate-400" />
                      <span className={`text-xs font-black font-mono tracking-tight ${theme !== 'light' ? 'text-slate-200' : 'text-slate-800'}`}>
                        {formatTradeDate(trade.date).date}
                      </span>
                    </div>

                    {/* Row 2: Instrument (hero) — hned pod datem pro maximální důraz */}
                    <h3 className={`text-2xl font-black uppercase tracking-tighter truncate leading-none ${theme !== 'light' ? 'text-white group-hover:text-trade-accent' : 'text-slate-900'} transition-colors duration-300`}>
                      {trade.instrument}
                    </h3>

                    {/* Row 3: Direction + Status + Phase */}
                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
                      {(() => {
                        const isLong = String(trade.direction || '').toLowerCase() === 'long';
                        return (
                          <span className={`px-2 py-0.5 rounded-md text-[7px] font-black uppercase border tracking-tighter flex items-center gap-1 ${
                            isLong ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border-rose-500/20'
                          }`}>
                            {isLong ? <ArrowUpRight size={9} strokeWidth={3} /> : <ArrowDownRight size={9} strokeWidth={3} />}
                            {trade.direction}
                          </span>
                        );
                      })()}
                      {/* Execution Status badge — always show */}
                      {(() => {
                        const status = trade.executionStatus || (trade.isValid === false ? 'Invalid' : 'Valid');
                        if (status === 'Missed') return (
                          <span className="px-2 py-0.5 rounded-md text-[7px] font-black uppercase border tracking-tighter flex items-center gap-1 bg-blue-500/10 text-blue-400 border-blue-500/20">
                            <Clock size={9} strokeWidth={3} /> MISSED
                          </span>
                        );
                        if (status === 'Invalid') return (
                          <span className="px-2 py-0.5 rounded-md text-[7px] font-black uppercase border tracking-tighter flex items-center gap-1 bg-rose-500/10 text-rose-500 border-rose-500/20">
                            <AlertOctagon size={9} strokeWidth={3} /> NEVALIDNÍ
                          </span>
                        );
                        return (
                          <span className="px-2 py-0.5 rounded-md text-[7px] font-black uppercase border tracking-tighter flex items-center gap-1 bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
                            <CheckCircle2 size={9} strokeWidth={3} /> VALIDNÍ
                          </span>
                        );
                      })()}
                      {getTradePhase(trade) && (
                        <span className={`px-1.5 py-0.5 rounded text-[7px] font-black tracking-widest border ${
                            getTradePhase(trade) === 'Funded'
                              ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                              : getTradePhase(trade) === 'Backtesting'
                                ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20'
                                : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                          }`}>
                          {getTradePhase(trade)!.toUpperCase()}
                        </span>
                      )}
                    </div>

                    {/* Row 4: Account pill — kompaktní, stejný styl jako ostatní badge */}
                    <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border w-fit ${isGroupTrade
                        ? 'bg-blue-500/5 border-blue-500/15'
                        : theme !== 'light' ? 'bg-white/[0.03] border-white/5' : 'bg-slate-50 border-slate-200'
                      }`}>
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        tradeAccount?.type === 'Funded' ? 'bg-purple-500' :
                        isGroupTrade ? 'bg-blue-500' :
                        'bg-emerald-500'
                      }`} />
                      {isCombinedCard && masterAcc ? (
                        <>
                          <span className={`text-[8px] font-black uppercase tracking-tighter truncate max-w-[120px] ${theme !== 'light' ? 'text-slate-300' : 'text-slate-600'}`}>
                            {masterAcc.name}
                          </span>
                          <ArrowRight size={8} className="text-blue-400/60" />
                          <span className="text-[7px] font-black text-blue-400 uppercase tracking-widest">
                            {copyCount} {copyCount === 1 ? 'copy' : 'copies'}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className={`text-[8px] font-black uppercase tracking-tighter truncate max-w-[120px] ${theme !== 'light' ? 'text-slate-300' : 'text-slate-600'}`}>
                            {getAccountName(trade.accountId)}
                          </span>
                          {isMasterCard && (
                            <span className="px-1 py-0 bg-blue-600/20 text-blue-400 rounded text-[6px] font-black tracking-widest border border-blue-500/30">MASTER</span>
                          )}
                          {isCopyCard && (
                            <span className="px-1 py-0 bg-purple-600/20 text-purple-400 rounded text-[6px] font-black tracking-widest border border-purple-500/30">COPY</span>
                          )}
                        </>
                      )}
                    </div>

                    {/* Row 4: Emoce */}
                    {(trade.emotions || []).length > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                        {(trade.emotions || []).slice(0, 3).map(eId => {
                          const e = getEmotionDetails(eId);
                          return <span key={eId} className="text-[9px] font-black uppercase text-purple-500/70 bg-purple-500/5 px-2 py-0.5 rounded border border-purple-500/15">{e.label}</span>;
                        })}
                      </div>
                    )}
                  </div>

                  {/* Bottom: PnL */}
                  <div className="flex items-end mt-6 md:mt-0">
                    <span className={`text-3xl md:text-4xl font-black tracking-tighter leading-none font-mono ${pnlColor}`}>
                      {formatValue(
                        trade.pnl,
                        pnlDisplayMode,
                        accounts.find(a => a.id === trade.accountId)?.initialBalance || 0,
                        priceBasedRR(trade)
                      )}
                    </span>
                  </div>
                </div>

                <div className={`relative transition-all duration-700 overflow-hidden ${tradeScreenshot || !tradeScreenshot ? 'h-48 md:h-full w-full md:w-[42%] block' : 'hidden'}`}>
                  {tradeScreenshot ? (
                    <div
                      className="w-full h-full relative group/img"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Sestavit flat pole všech screenshotů ze všech viditelných obchodů
                        const allImgs: string[] = [];
                        let startIndex = 0;
                        visibleTrades.forEach(t => {
                          const tScreenshots = getScreenshots(t);
                          const tScreenshot = getScreenshot(t);
                          const tImgs = tScreenshots && tScreenshots.length > 0 ? tScreenshots : (tScreenshot ? [tScreenshot] : []);
                          if (t.id === trade.id) startIndex = allImgs.length;
                          allImgs.push(...tImgs);
                        });
                        if (allImgs.length > 0) setZoomImage({ images: allImgs, index: startIndex });
                      }}
                    >
                      {!isImageLoaded && !errorImages.has(String(trade.id)) && (
                        <div className={`absolute inset-0 animate-pulse bg-slate-800/20 backdrop-blur-sm flex items-center justify-center z-10`}>
                          <ImageIcon size={24} className="text-slate-700/50" />
                        </div>
                      )}
                      {errorImages.has(String(trade.id)) && (
                        <div className="absolute inset-0 flex items-center justify-center bg-slate-900/60 z-10">
                          <ImageIcon size={20} className="text-slate-600" />
                        </div>
                      )}

                      <img
                        src={thumbLarge(tradeScreenshot)}
                        onLoad={() => handleImageLoad(String(trade.id))}
                        onError={() => handleImageError(String(trade.id))}
                        loading="lazy"
                        className={`w-full h-full object-cover transition-opacity duration-300 group-hover/img:scale-105 ${isImageLoaded ? 'opacity-100' : 'opacity-0'}`}
                      />

                      <div className={`absolute inset-0 bg-gradient-to-r ${theme !== 'light' ? 'from-[var(--bg-card)] via-transparent' : 'from-white via-transparent'} to-transparent md:block hidden z-20`}></div>
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 flex items-center justify-center transition-all duration-500 backdrop-blur-[1px] z-30">
                        <div className="p-4 bg-white/10 rounded-full text-white shadow-2xl border border-white/20 animate-in zoom-in-95"><Maximize2 size={24} /></div>
                      </div>
                      {tradeScreenshots && tradeScreenshots.length > 1 && (
                        <div className="absolute bottom-3 right-3 px-2 py-1 bg-black/60 rounded-md text-[8px] font-black text-white uppercase tracking-widest backdrop-blur-md z-40">
                          +{tradeScreenshots.length - 1} more
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className={`w-full h-full flex items-center justify-center border-l bg-[var(--bg-page)]/10 group-hover:bg-blue-500/5 transition-colors duration-500 ${theme === 'light' ? 'border-slate-100' : 'border-[var(--border-subtle)]'}`}>
                      <Cpu size={24} className="text-slate-800/40 group-hover:text-blue-500 transition-colors" />
                    </div>
                  )}
                </div>

              </div>
            );
          })}
        </div>
      ) : (
        <div className={`rounded-3xl border overflow-hidden ${theme !== 'light' ? 'bg-white/[0.02] border-white/10' : 'bg-white border-slate-200'} backdrop-blur-md`}>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className={`${theme !== 'light' ? 'bg-white/[0.03]' : 'bg-slate-50'} border-b ${theme !== 'light' ? 'border-white/10' : 'border-slate-200'}`}>
                  {isMultiSelectMode && (
                    <th className="px-4 py-4 w-12">
                      <input
                        type="checkbox"
                        checked={selectedTradeIds.size === visibleTrades.length && visibleTrades.length > 0}
                        onChange={toggleSelectAll}
                        className="w-4 h-4 cursor-pointer accent-cyan-500"
                      />
                    </th>
                  )}
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Vizual</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Instrument</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Typ</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Datum & Čas</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Účet</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 text-right">PnL / R</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 text-right">Akce</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {validTrades.map((trade) => {
                  const status = trade.executionStatus || (trade.isValid === false ? 'Invalid' : 'Valid');
                  const isMissed = status === 'Missed';
                  const isBE = (trade as any).isBE === true || Math.abs(trade.pnl) <= 0.01;
                  const isWin = !isBE && trade.pnl > 0.01;
                  const pnlColor = isMissed
                    ? 'text-blue-400'
                    : isBE
                      ? 'text-amber-500'
                      : (isWin ? 'text-emerald-500' : 'text-rose-500');
                  const tableScreenshot = getScreenshot(trade);
                  const tblGroup = getGroupTrades(trade);
                  const tblIsGroup = tblGroup.length > 1;
                  const tblIsCombined = String(trade.id).startsWith('combined_');
                  const tblMaster = tblGroup.find(t => t.isMaster) || tblGroup[0];
                  const tblMasterAcc = tblIsGroup ? accounts.find(a => a.id === tblMaster?.accountId) : null;
                  const tblCopyCount = tblIsGroup ? tblGroup.length - 1 : 0;
                  const tblIsCopy = tblIsGroup && !tblIsCombined && trade.id !== tblMaster?.id;
                  const tblIsMaster = tblIsGroup && !tblIsCombined && trade.id === tblMaster?.id;

                  return (
                    <tr
                      key={trade.id}
                      onClick={() => !isMultiSelectMode && setSelectedTrade(trade)}
                      className={`group hover:bg-white/[0.03] transition-colors cursor-pointer border-b ${theme !== 'light' ? 'border-white/5' : 'border-slate-100'} ${
                        selectedTradeIds.has(trade.id) ? 'bg-cyan-500/10 ring-1 ring-cyan-400' : ''
                      }`}
                    >
                      {isMultiSelectMode && (
                        <td className="px-4 py-3 w-12">
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleTradeSelection(trade.id);
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selectedTradeIds.has(trade.id)}
                              onChange={() => {}}
                              className="w-4 h-4 cursor-pointer accent-cyan-500"
                            />
                          </div>
                        </td>
                      )}
                      <td className="px-6 py-3">
                        <div className="w-12 h-12 rounded-lg border border-white/10 overflow-hidden bg-white/5 flex items-center justify-center relative">
                          {tableScreenshot ? (
                            <>
                              {!loadedImages.has(String(trade.id)) && !errorImages.has(String(trade.id)) && (
                                <div className="absolute inset-0 animate-pulse bg-slate-800/20 flex items-center justify-center z-10">
                                  <ImageIcon size={14} className="text-slate-700/50" />
                                </div>
                              )}
                              {errorImages.has(String(trade.id)) ? (
                                <ImageIcon size={14} className="text-slate-600" />
                              ) : (
                                <img
                                  src={thumbMedium(tableScreenshot)}
                                  onLoad={() => handleImageLoad(String(trade.id))}
                                  onError={() => handleImageError(String(trade.id))}
                                  loading="lazy"
                                  className={`w-full h-full object-cover group-hover:opacity-100 transition-all duration-700 animate-in fade-in ${loadedImages.has(String(trade.id)) ? 'opacity-60 scale-100' : 'opacity-0 scale-90'}`}
                                />
                              )}
                            </>
                          ) : (
                            <Cpu size={16} className="text-slate-600" />
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex flex-col">
                          <span className={`flex items-center gap-1.5 text-sm font-black uppercase tracking-tight ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>
                            {trade.instrument}
                            {enrichIds.has(String(trade.id)) && <EnrichBadge variant="inline" />}
                            {(trade as any).excursionComplete === false && <PendingBadge variant="inline" />}
                          </span>
                          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">{getTradePhase(trade) || 'Standard'}</span>
                        </div>
                      </td>
                      <td className="px-6 py-3">
                        <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase border tracking-tighter ${isMissed ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' :
                          isWin ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' :
                            'bg-rose-500/10 text-rose-500 border-rose-500/20'
                          }`}>
                          {isMissed ? 'MISSED' : trade.direction}
                        </span>
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-slate-400">{formatTradeDate(trade.date).date}</span>
                          {!formatTradeDate(trade.date).isPlaceholderTime && (
                            <span className="text-[10px] font-mono text-blue-500/60">{formatTradeDate(trade.date).time}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Terminal size={10} className={tblIsGroup ? 'text-blue-400' : 'text-slate-600'} />
                          {tblIsCombined && tblMasterAcc ? (
                            <>
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest max-w-[100px] truncate">{tblMasterAcc.name}</span>
                              <ArrowRight size={8} className="text-blue-400/60" />
                              <span className="text-[8px] font-bold text-blue-400 uppercase tracking-wider">
                                {tblCopyCount} {tblCopyCount === 1 ? 'copy' : 'copies'}
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest max-w-[100px] truncate">{getAccountName(trade.accountId)}</span>
                              {tblIsMaster && (
                                <span className="px-1 py-0.5 bg-blue-600/20 text-blue-400 rounded text-[7px] font-black tracking-widest border border-blue-500/30">MASTER</span>
                              )}
                              {tblIsCopy && (
                                <span className="px-1 py-0.5 bg-purple-600/20 text-purple-400 rounded text-[7px] font-black tracking-widest border border-purple-500/30">COPY</span>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-3 text-right">
                        <span className={`text-sm font-mono font-black ${pnlColor}`}>
                          {formatValue(
                            trade.pnl,
                            pnlDisplayMode,
                            accounts.find(a => a.id === trade.accountId)?.initialBalance || 0,
                            priceBasedRR(trade)
                          )}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-right">
                        <div className="flex justify-end">
                          <div className="p-2 rounded-lg bg-white/5 border border-white/10 text-slate-500 group-hover:text-blue-500 transition-all opacity-0 group-hover:opacity-100">
                            <ChevronRight size={14} />
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* (Sekce „Neplatné / mimo plán" se renderuje NAD gridem — dole byla s infinite
          scrollem nedosažitelná: nové karty ji pořád odsouvaly.) */}

      {/* Infinite Scroll Sentinel + Loading Spinner */}
      {hasMore && (
        <div ref={sentinelRef} className="flex flex-col items-center justify-center py-8">
          <div className="relative w-16 h-16 animate-pulse">
            <img
              src="/logos/at_logo_light_clean.png"
              alt="Loading..."
              className="w-full h-full object-contain animate-spin"
              style={{ animationDuration: '2s' }}
            />
          </div>
          <span className={`mt-3 text-[10px] font-black uppercase tracking-[0.3em] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {isLoadingMore ? 'Načítám další obchody...' : `${sortedTrades.length - visibleCount} dalších`}
          </span>
        </div>
      )}

      {!hasMore && sortedTrades.length > PAGE_SIZE && (
        <div className="flex justify-center py-6">
          <span className={`text-[10px] font-black uppercase tracking-[0.3em] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
            Zobrazeno všech {sortedTrades.length} obchodů
          </span>
        </div>
      )}

      {zoomImage && (
        <ImageZoomModal images={zoomImage.images} initialIndex={zoomImage.index} onClose={() => setZoomImage(null)} />
      )}

      {/* Bulk Tag Modal — hromadné označení vybraných importovaných obchodů. */}
      <AnimatePresence>
        {bulkTagOpen && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setBulkTagOpen(false)}>
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className={`max-w-lg w-full rounded-[32px] border shadow-2xl overflow-hidden ${isDark ? 'bg-slate-900 border-white/10' : 'bg-white border-slate-200'}`}
              onClick={e => e.stopPropagation()}
            >
              <div className="p-6 border-b border-amber-500/20 bg-gradient-to-b from-amber-500/5 to-transparent">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-2xl bg-amber-500/15 border border-amber-500/30">
                    <Sparkles size={20} className="text-amber-500" />
                  </div>
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-[0.3em] text-amber-500 mb-0.5">Hromadné otagování</p>
                    <h2 className={`text-lg font-black tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
                      {selectedTradeIds.size} importovaných obchodů
                    </h2>
                  </div>
                </div>
                <p className={`text-xs mt-3 leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Pro session kterou „nemá smysl rozebírat detailně" (revenge cyklus, overtrading apod.) přidáš všem vybraným obchodům stejné chyby/tag/poznámku najednou.
                </p>
              </div>

              <div className="p-6 space-y-5">
                {/* Chyby — checklist */}
                <div>
                  <label className={`text-[10px] font-black uppercase tracking-widest mb-2 block ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                    Chyby (vyber co se opakovalo)
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {userMistakes.length === 0 && (
                      <p className={`text-[11px] italic ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        Žádné chyby zatím nemáš v Nastavení → Strategie → Katalog Chyb.
                      </p>
                    )}
                    {userMistakes.map(m => {
                      const active = bulkTagMistakes.has(m);
                      return (
                        <button
                          key={m}
                          onClick={() => {
                            const next = new Set(bulkTagMistakes);
                            if (active) next.delete(m); else next.add(m);
                            setBulkTagMistakes(next);
                          }}
                          className={`px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-wide transition-all border ${active
                            ? 'bg-rose-500 text-white border-rose-500 shadow-md'
                            : (isDark ? 'bg-white/5 text-slate-400 border-white/10 hover:bg-white/10' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100')
                          }`}
                        >
                          {m}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Tag */}
                <div>
                  <label className={`text-[10px] font-black uppercase tracking-widest mb-2 block ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                    Tag (volitelný — např. „MFF spálení 1.6.")
                  </label>
                  <input
                    value={bulkTagText}
                    onChange={e => setBulkTagText(e.target.value)}
                    placeholder="MFF spálení 1.6."
                    className={`w-full px-4 py-2.5 rounded-xl border text-sm font-bold outline-none ${isDark ? 'bg-white/5 border-white/10 text-white placeholder:text-slate-600' : 'bg-slate-50 border-slate-200 text-slate-900 placeholder:text-slate-400'}`}
                  />
                </div>

                {/* Note */}
                <div>
                  <label className={`text-[10px] font-black uppercase tracking-widest mb-2 block ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                    Poznámka (volitelná — co se stalo, jedním řádkem)
                  </label>
                  <textarea
                    value={bulkTagNotes}
                    onChange={e => setBulkTagNotes(e.target.value)}
                    placeholder="Po prvním lossu jsem začal honit a do konce dne nedokázal přestat."
                    rows={2}
                    className={`w-full px-4 py-2.5 rounded-xl border text-xs resize-none outline-none ${isDark ? 'bg-white/5 border-white/10 text-white placeholder:text-slate-600' : 'bg-slate-50 border-slate-200 text-slate-900 placeholder:text-slate-400'}`}
                  />
                </div>

                {/* Toggle — označit jako Hotovo (odebere z K doplnění fronty) */}
                <label className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${bulkTagMarkDone ? 'bg-emerald-500/10 border-emerald-500/30' : (isDark ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-200')}`}>
                  <input
                    type="checkbox"
                    checked={bulkTagMarkDone}
                    onChange={e => setBulkTagMarkDone(e.target.checked)}
                    className="w-4 h-4 accent-emerald-500"
                  />
                  <div className="flex-1">
                    <p className={`text-[11px] font-black uppercase tracking-wide ${bulkTagMarkDone ? 'text-emerald-500' : (isDark ? 'text-slate-300' : 'text-slate-700')}`}>
                      Označit jako doplněno (odebrat z fronty „K doplnění")
                    </p>
                    <p className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                      Vědomá volba: „víc už k tomu nemám" — badge zmizí.
                    </p>
                  </div>
                </label>

                {/* Akce */}
                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => setBulkTagOpen(false)}
                    className={`flex-1 py-3 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all ${isDark ? 'bg-white/5 hover:bg-white/10 text-slate-400' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}
                  >
                    Zrušit
                  </button>
                  <button
                    onClick={applyBulkTag}
                    disabled={bulkTagMistakes.size === 0 && !bulkTagText.trim() && !bulkTagNotes.trim()}
                    className="flex-1 py-3 rounded-xl text-[11px] font-black uppercase tracking-widest bg-gradient-to-r from-amber-500 to-amber-600 text-white shadow-lg shadow-amber-500/30 hover:shadow-amber-500/50 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Aplikovat na {selectedTradeIds.size}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {selectedTrade && (
        <TradeDetailModal
          trade={selectedTrade}
          accountName={getAccountName(selectedTrade.accountId)}
          theme={theme}
          onClose={handleCloseDetail}
          startInEditMode={wizardMode}
          onSaved={handleWizardAdvance}
          onDelete={() => { onDelete(selectedTrade.id); setSelectedTrade(null); }}
          emotions={emotions}
          onUpdateTrade={(updates) => onUpdateTrade?.(selectedTrade.id, updates)}
          pnlDisplayMode={pnlDisplayMode}
          accounts={accounts}
          initialBalance={initialBalance}
          user={user}
          exchangeRates={exchangeRates}
          onPrev={() => {
            const idx = sortedTrades.findIndex(t => t.id === selectedTrade.id);
            if (idx > 0) setSelectedTrade(sortedTrades[idx - 1]);
          }}
          onNext={() => {
            const idx = sortedTrades.findIndex(t => t.id === selectedTrade.id);
            if (idx < sortedTrades.length - 1) setSelectedTrade(sortedTrades[idx + 1]);
          }}
          hasPrev={sortedTrades.findIndex(t => t.id === selectedTrade.id) > 0}
          hasNext={sortedTrades.findIndex(t => t.id === selectedTrade.id) < sortedTrades.length - 1}
          allTrades={allTrades.length > 0 ? allTrades : trades}
        />
      )}
    </div>
  );
};

export default TradeHistory;
