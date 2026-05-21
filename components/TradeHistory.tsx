import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
  Share2, Check, Copy, LayoutGrid, List
} from 'lucide-react';

import TradeDetailModal from './TradeDetailModal';
import ImageZoomModal from './ImageZoomModal';
import ConfirmationModal from './ConfirmationModal';

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
  pnlDisplayMode?: PnLDisplayMode;
  initialBalance?: number;
  user: User;
  exchangeRates: ExchangeRates;
}

const TradeHistory: React.FC<TradeHistoryProps> = ({
  trades, accounts, onDelete, onClear, theme, emotions, onUpdateTrade,
  pnlDisplayMode = 'usd', initialBalance, user, exchangeRates, allTrades = [],
  viewMode
}) => {
  const isDark = theme !== 'light';
  const targetCurrency = user.currency || 'USD';

  const formatValue = (val: number, mode: PnLDisplayMode = pnlDisplayMode, bal?: number, rr?: number, sign: boolean = true) => {
    return formatPnL(val, mode, bal, rr, sign, targetCurrency, exchangeRates);
  };

  // Get account phase for a trade (account is source of truth, not trade.phase)
  const getTradePhase = (trade: Trade): string | null => {
    const account = accounts.find(a => a.id === trade.accountId);
    if (account?.type === 'Backtest') return 'Backtesting';
    return account?.phase || trade.phase || null;
  };

  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const [zoomImage, setZoomImage] = useState<{ images: string[]; index: number } | null>(null);

  // --- MULTI-SELECT STATE ---
  const [selectedTradeIds, setSelectedTradeIds] = useState<Set<string | number>>(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);

  // --- INFINITE SCROLL STATE ---
  const PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // --- LAZY SCREENSHOT CACHE ---
  const [screenshotCache, setScreenshotCache] = useState<Map<string, { screenshot?: string; screenshots?: string[] }>>(new Map());
  // Ref mirror of screenshotCache — avoids stale closure in stable callbacks
  const screenshotCacheRef = useRef<Map<string, { screenshot?: string; screenshots?: string[] }>>(new Map());
  const loadingScreenshotsRef = useRef<Set<string>>(new Set());
  // Tracks IDs we've already attempted to fetch (even if no screenshot was found)
  // This prevents re-fetching "no screenshot" trades every time the cache updates
  const fetchedIdsRef = useRef<Set<string>>(new Set());
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
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

  // Sync selectedTrade when trades prop changes (e.g., after drawing update)
  useEffect(() => {
    if (selectedTrade) {
      const updated = trades.find(t => t.id === selectedTrade.id);
      if (updated && JSON.stringify(updated) !== JSON.stringify(selectedTrade)) {
        setSelectedTrade(updated);
      }
    }
  }, [trades, selectedTrade]);

  // Ensure trades are always sorted by date (newest first) for consistent display and navigation
  const sortedTrades = useMemo(() =>
    [...trades].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [trades]
  );

  // Visible slice for rendering
  const visibleTrades = useMemo(() =>
    sortedTrades.slice(0, visibleCount),
    [sortedTrades, visibleCount]
  );
  const hasMore = visibleCount < sortedTrades.length;

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
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  }, []); // Stable — no state deps, uses refs

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
        <button
          onClick={() => {
            if (isMultiSelectMode) {
              clearSelection();
            } else {
              setIsMultiSelectMode(true);
            }
          }}
          className={`px-4 py-2 rounded-lg font-bold text-sm transition-all ${
            isMultiSelectMode
              ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
              : theme === 'light'
                ? 'bg-slate-100 text-slate-500 border border-slate-200 hover:bg-slate-200'
                : 'bg-slate-700/50 text-slate-300 border border-slate-600/30 hover:bg-slate-600/50'
          }`}
        >
          {isMultiSelectMode ? 'Zrušit výběr' : 'Vybrat více'}
        </button>

        {isMultiSelectMode && (
          <>
            <button
              onClick={toggleSelectAll}
              className={`px-4 py-2 rounded-lg font-bold text-sm transition-all ${theme === 'light' ? 'bg-slate-100 text-slate-500 border border-slate-200 hover:bg-slate-200' : 'bg-slate-700/50 text-slate-300 border border-slate-600/30 hover:bg-slate-600/50'}`}
            >
              {selectedTradeIds.size === visibleTrades.length ? 'Zrušit vše' : 'Vybrat vše'}
            </button>

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

      {viewMode === 'grid' ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {visibleTrades.map((trade) => {
            const status = trade.executionStatus || (trade.isValid === false ? 'Invalid' : 'Valid');
            const isMissed = status === 'Missed';
            const isBE = Math.abs(trade.pnl) <= 0.01;
            const isWin = trade.pnl > 0.01;

            let glowClass = isWin
              ? 'neon-border-green neon-glow-green'
              : isBE
                ? 'neon-border-amber neon-glow-amber'
                : 'neon-border-red neon-glow-red';
            if (isMissed) glowClass = 'border-l-4 border-blue-500 opacity-60 grayscale-[0.3]';

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

            const tradeAccount = accounts.find(a => a.id === trade.accountId);
            // Find group trades using same logic as TradeDetailModal (groupId + fuzzy)
            const allTradesList = allTrades.length > 0 ? allTrades : trades;
            let groupTrades: Trade[] = [];
            if (trade.groupId) {
              groupTrades = allTradesList.filter(t => t.groupId === trade.groupId);
            }
            if (groupTrades.length <= 1) {
              const fuzzy = allTradesList.filter(t => t.instrument === trade.instrument && t.timestamp === trade.timestamp && t.direction === trade.direction);
              if (fuzzy.length > 1) groupTrades = fuzzy;
            }
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

                <div className="absolute top-2 right-4 opacity-5 pointer-events-none">
                  <span className="text-[8px] font-mono font-bold tracking-widest uppercase">System.Alpha.v4.0</span>
                </div>
                <div className="absolute bottom-2 left-4 opacity-5 pointer-events-none">
                  <span className="text-[8px] font-mono font-bold tracking-widest uppercase">LOG_ID_{tradeHex}</span>
                </div>

                <div className="flex-1 flex flex-col justify-between p-6 min-w-0 relative z-10">
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 mb-1">
                      <span className={`px-2 py-0.5 rounded-md text-[7px] font-black uppercase border tracking-tighter ${isMissed ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' :
                        isWin ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border-rose-500/20'
                        }`}>
                        {isMissed ? 'MISSED' : trade.direction}
                      </span>
                      <div className="flex items-center gap-1.5 bg-slate-500/5 px-2 py-0.5 rounded border border-white/5">
                        <Calendar size={8} className="text-slate-500" />
                        <span className="text-[9px] font-mono font-bold text-slate-500">{formatTradeDate(trade.date).date}</span>
                      </div>
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

                    <h3 className={`text-2xl font-black uppercase tracking-tighter truncate leading-none ${theme !== 'light' ? 'text-white group-hover:text-trade-accent' : 'text-slate-900'} transition-colors duration-300`}>
                      {trade.instrument}
                    </h3>

                    <div className={`flex items-center gap-1.5 mt-1.5 px-2.5 py-1.5 rounded-lg border flex-wrap ${isGroupTrade
                        ? 'bg-blue-500/5 border-blue-500/15'
                        : theme !== 'light' ? 'bg-white/[0.03] border-white/5' : 'bg-slate-50 border-slate-200'
                      }`}>
                      <Terminal size={12} className={isGroupTrade ? 'text-blue-400' : 'text-slate-500'} />
                      {isCombinedCard && masterAcc ? (
                        <>
                          <span className={`text-[11px] font-black uppercase tracking-wide truncate max-w-[140px] ${theme !== 'light' ? 'text-slate-300' : 'text-slate-700'}`}>
                            {masterAcc.name}
                          </span>
                          <ArrowRight size={10} className="text-blue-400/60" />
                          <span className="text-[9px] font-black text-blue-400 uppercase tracking-wider">
                            {copyCount} {copyCount === 1 ? 'copy' : 'copies'}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className={`text-[11px] font-black uppercase tracking-wide truncate max-w-[140px] ${theme !== 'light' ? 'text-slate-300' : 'text-slate-700'}`}>
                            {getAccountName(trade.accountId)}
                          </span>
                          {isMasterCard && (
                            <span className="px-1.5 py-0.5 bg-blue-600/20 text-blue-400 rounded text-[7px] font-black tracking-widest border border-blue-500/30">MASTER</span>
                          )}
                          {isCopyCard && (
                            <span className="px-1.5 py-0.5 bg-purple-600/20 text-purple-400 rounded text-[7px] font-black tracking-widest border border-purple-500/30">COPY</span>
                          )}
                        </>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {(trade.emotions || []).slice(0, 3).map(eId => {
                        const e = getEmotionDetails(eId);
                        return <span key={eId} className="text-[8px] font-black uppercase text-blue-500/60 bg-blue-500/5 px-2 py-0.5 rounded border border-blue-500/10">{e.label}</span>;
                      })}
                    </div>
                  </div>

                  <div className="flex items-end justify-between mt-6 md:mt-0">
                    <div className="flex flex-col">
                      <span className={`text-3xl md:text-4xl font-black tracking-tighter leading-none font-mono ${pnlColor}`}>
                        {formatValue(
                          trade.pnl,
                          pnlDisplayMode,
                          accounts.find(a => a.id === trade.accountId)?.initialBalance || 0,
                          trade.riskAmount ? trade.pnl / trade.riskAmount : undefined
                        )}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[9px] font-black uppercase text-slate-500 group-hover:text-blue-500 transition-all duration-300 group-hover:translate-x-1">
                      Audit <ChevronRight size={14} className="text-blue-500/50" />
                    </div>
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
                        className={`w-full h-full object-cover transition-all duration-1000 group-hover/img:scale-105 ${isImageLoaded ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}`}
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
                {visibleTrades.map((trade) => {
                  const status = trade.executionStatus || (trade.isValid === false ? 'Invalid' : 'Valid');
                  const isMissed = status === 'Missed';
                  const isBE = Math.abs(trade.pnl) <= 0.01;
                  const isWin = trade.pnl > 0.01;
                  const pnlColor = isMissed
                    ? 'text-blue-400'
                    : isBE
                      ? 'text-amber-500'
                      : (isWin ? 'text-emerald-500' : 'text-rose-500');
                  const tableScreenshot = getScreenshot(trade);
                  const tblAllTrades = allTrades.length > 0 ? allTrades : trades;
                  let tblGroup: Trade[] = [];
                  if (trade.groupId) {
                    tblGroup = tblAllTrades.filter(t => t.groupId === trade.groupId);
                  }
                  if (tblGroup.length <= 1) {
                    const fuzzy = tblAllTrades.filter(t => t.instrument === trade.instrument && t.timestamp === trade.timestamp && t.direction === trade.direction);
                    if (fuzzy.length > 1) tblGroup = fuzzy;
                  }
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
                          <span className={`text-sm font-black uppercase tracking-tight ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>{trade.instrument}</span>
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
                            trade.riskAmount ? (trade.pnl / trade.riskAmount) : undefined
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

      {selectedTrade && (
        <TradeDetailModal
          trade={selectedTrade}
          accountName={getAccountName(selectedTrade.accountId)}
          theme={theme}
          onClose={() => setSelectedTrade(null)}
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
