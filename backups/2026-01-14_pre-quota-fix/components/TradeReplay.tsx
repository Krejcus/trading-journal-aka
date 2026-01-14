import React, { useEffect, useRef, useState, useMemo, useCallback, useImperativeHandle } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickData, Time, CandlestickSeries, BaselineSeries } from 'lightweight-charts';
import { Trade } from '../types';
import ChartToolbar, { DrawingTool } from './ChartToolbar';
import { InteractiveOverlay } from './InteractiveOverlay';
import { DrawingObject } from '../types';
import { storageService } from '../services/storageService';
import { X, Play, Pause, RotateCcw, FastForward, Settings2, Square, Columns, ArrowRight, Maximize2, Eraser, Database, Pin, PinOff, Target, Star, ChevronDown } from 'lucide-react';
import { aggregateCandles } from '../utils/candleUtils';
import { PlaybackWidget } from './PlaybackWidget';

// Cache bust 2026-01-11
interface TradeReplayProps {
    trade: Trade;
    theme: 'dark' | 'light' | 'oled';
    onClose: () => void;
    embedded?: boolean;
    minimal?: boolean;
    onUpdateTrade?: (updates: Partial<Trade>) => void;
    initialLayout?: 'single' | 'split';
    initialMainTimeframe?: '1m' | '5m' | '15m' | '1h' | '4h' | 'D' | 'W';
    initialSecondaryTimeframe?: '1m' | '5m' | '15m' | '1h' | '4h' | 'D' | 'W';
}

export interface TradeReplayRef {
    goToTrade: () => void;
}

const TradeReplay = React.forwardRef<TradeReplayRef, TradeReplayProps>(({
    trade, theme, onClose, embedded = false, minimal = false, onUpdateTrade,
    initialLayout = 'single', initialMainTimeframe = '1m', initialSecondaryTimeframe = '15m'
}, ref) => {
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const tpSeriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
    const slSeriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
    const chartContainer2Ref = useRef<HTMLDivElement>(null);
    const chart2Ref = useRef<IChartApi | null>(null);
    const series2Ref = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const tpSeries2Ref = useRef<ISeriesApi<"Baseline"> | null>(null);
    const slSeries2Ref = useRef<ISeriesApi<"Baseline"> | null>(null);
    const cleanupRef = useRef<(() => void) | null>(null);
    const subDurationRef = useRef<number>(240 * 60); // Default 4 hours
    const isSyncingRef = useRef<boolean>(false);
    const priceOffsetRef = useRef<number>(0);
    const [activeTool, setActiveTool] = useState<DrawingTool>('cursor');
    const [drawings, setDrawings] = useState<DrawingObject[]>(trade.drawings || []);
    const [past, setPast] = useState<DrawingObject[][]>([]);
    const [future, setFuture] = useState<DrawingObject[][]>([]);
    const [magnetMode, setMagnetMode] = useState(false);
    const [hoverPrice, setHoverPrice] = useState<number | null>(null);
    const [hoverTime, setHoverTime] = useState<number | null>(null);
    const [chartRevision, setChartRevision] = useState(0);
    const [isSaving, setIsSaving] = useState(false);

    // Replay & Basic State
    const [allData, setAllData] = useState<CandlestickData[]>([]);
    const [isReplayMode, setIsReplayMode] = useState(false);
    const [playbackTime, setPlaybackTime] = useState<number | null>(null);
    const [isReplayPlaying, setIsReplayPlaying] = useState(false);
    const [replaySpeed, setReplaySpeed] = useState(1000); // Default 1s
    const [isCutToolActive, setIsCutToolActive] = useState(false);
    const isDark = theme !== 'light';
    const [isLoading, setIsLoading] = useState(true); // Default to true to prevent overlay flash
    const [error, setError] = useState<string | null>(null);
    const [priceOffset, setPriceOffset] = useState<number>(0);
    const [detectedIsLocal, setDetectedIsLocal] = useState<boolean>(true);
    const [containerReady, setContainerReady] = useState(false);
    const [chartReady, setChartReady] = useState(false);
    const [chart2Ready, setChart2Ready] = useState(false);
    const [saveToast, setSaveToast] = useState(false);
    const [isFixingView, setIsFixingView] = useState(false);
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, drawingId: string } | null>(null);
    const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
    const [dragMode, setDragMode] = useState<'move' | 'resize-p1' | 'resize-p2' | null>(null);
    const [dragStart, setDragStart] = useState<{ time: number; price: number } | null>(null);
    const [initialDrawingState, setInitialDrawingState] = useState<DrawingObject | null>(null);
    const [crosshairValues, setCrosshairValues] = useState<{ open: string, high: string, low: string, close: string, date: string } | null>(null);
    const [activeLayout, setActiveLayout] = useState<'single' | 'split'>(trade.miniViewLayout || initialLayout);
    const [mainTimeframe, setMainTimeframe] = useState<'1m' | '5m' | '15m' | '1h' | '4h' | 'D' | 'W'>(initialMainTimeframe as any);
    const [secondaryTimeframe, setSecondaryTimeframe] = useState<'1m' | '5m' | '15m' | '1h' | '4h' | 'D' | 'W'>((trade.miniViewSecondaryTimeframe || initialSecondaryTimeframe) as any);

    useEffect(() => {
        // Preference: if user just toggled in modal (prop changed), follow that.
        // Otherwise use pin from DB.
        setActiveLayout(initialLayout);
    }, [initialLayout]);


    // Helper to get saved main tf if meaningful (usually main tf is dynamic based on user selection, but we are not saving main timeframe specifically in database as a separate pinned field other than implied? 
    // Wait, we didn't add miniViewMainTimeframe to updates. We only added secondary.
    // But let's fix secondary at least.

    useEffect(() => {
        if (trade.miniViewSecondaryTimeframe) {
            setSecondaryTimeframe(trade.miniViewSecondaryTimeframe as any);
        } else if (initialSecondaryTimeframe) {
            setSecondaryTimeframe(initialSecondaryTimeframe);
        }
    }, [initialSecondaryTimeframe, trade.miniViewSecondaryTimeframe]);

    const [activeChart, setActiveChart] = useState<'main' | 'secondary'>('main');
    const [showTfDropdown, setShowTfDropdown] = useState(false);
    const [favoriteTimeframes, setFavoriteTimeframes] = useState<string[]>(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('favoriteTimeframes');
            return saved ? JSON.parse(saved) : ['1m', '5m', '15m', '1h', '4h', 'D'];
        }
        return ['1m', '5m', '15m', '1h', '4h', 'D'];
    });

    useEffect(() => {
        localStorage.setItem('favoriteTimeframes', JSON.stringify(favoriteTimeframes));
    }, [favoriteTimeframes]);

    const allTimeframes = ['1m', '5m', '15m', '1h', '4h', 'D', 'W'];

    const [liveDrawing, setLiveDrawing] = useState<DrawingObject | null>(null);

    const toggleFavorite = (tf: string) => {
        setFavoriteTimeframes(prev =>
            prev.includes(tf) ? prev.filter(t => t !== tf) : [...prev, tf]
        );
    };

    const currentTf = activeChart === 'main' ? mainTimeframe : secondaryTimeframe;
    const setTf = (tf: any) => {
        if (activeChart === 'main') setMainTimeframe(tf);
        else setSecondaryTimeframe(tf);
        setShowTfDropdown(false);
    };

    const [isFetchingMore, setIsFetchingMore] = useState(false);
    const [allSecondaryData, setAllSecondaryData] = useState<CandlestickData[]>([]);
    const [isSecondaryLoading, setIsSecondaryLoading] = useState(false);

    const allDataRef = useRef<any[]>([]);
    useEffect(() => { allDataRef.current = allData; }, [allData]);

    const allSecondaryDataRef = useRef<any[]>([]);
    useEffect(() => { allSecondaryDataRef.current = allSecondaryData; }, [allSecondaryData]);

    const isLocalTimeRef = useRef<boolean>(false);
    const [hasInitialCentered, setHasInitialCentered] = useState(false);

    // Ref for latest drawings to use in cleanup
    const drawingsRef = useRef<DrawingObject[]>(drawings);
    useEffect(() => {
        drawingsRef.current = drawings;
    }, [drawings]);

    const saveDrawingsImmediately = useCallback(async (toSave: DrawingObject[]) => {
        setIsSaving(true);
        try {
            await storageService.updateTradeDrawings(trade.id, toSave);
            // Also update the trade object in memory if possible (though it's a prop)
            // trade.drawings = toSave; 
        } catch (err) {
            console.error("Failed to save drawings immediately", err);
        } finally {
            setIsSaving(false);
        }
    }, [trade.id]);

    // Auto-save drawings (Debounced for dragging)
    useEffect(() => {
        // Skip first render if matches initial prop
        if (JSON.stringify(drawings) === JSON.stringify(trade.drawings)) return;

        const timer = setTimeout(async () => {
            saveDrawingsImmediately(drawings);
        }, 1000); // 1s debounce

        return () => {
            clearTimeout(timer);
        };
    }, [drawings, saveDrawingsImmediately, trade.drawings]);

    // Save on unmount if changed
    useEffect(() => {
        return () => {
            if (JSON.stringify(drawingsRef.current) !== JSON.stringify(trade.drawings)) {
                storageService.updateTradeDrawings(trade.id, drawingsRef.current).catch(console.error);
            }
        };
    }, [trade.id, trade.drawings]);

    // Force re-render overlay when chart moves
    // ... existing effect for chartRevision

    // Drawing Handlers
    const getChartCoordinates = (e: React.MouseEvent) => {
        if (!chartRef.current || !seriesRef.current || !chartContainerRef.current) return null;

        const rect = chartContainerRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const timeScale = chartRef.current.timeScale();
        const series = seriesRef.current;

        const time = timeScale.coordinateToTime(x);
        const price = series.coordinateToPrice(y);

        if (time === null || price === null) return null;

        // Magnet Mode Logic
        if (magnetMode && Array.isArray(allData) && allData.length > 0) {
            // Find closest candle in time
            // Assuming time is a timestamp (seconds)
            const t = time as number;

            // Simple linear search or binary search (linear is fine for < 5000 candles usually)
            // Ideally binary search for performance
            // For now, let's just find closest in viewed range? 
            // Or just iterate. 
            let closest = null;
            let minDiff = Infinity;

            // Optimization: Only search if mouse is somewhat close to a candle?
            // Actually, we can just find the closest candle by time index if we had it.
            // Let's just iterate allData for now, or a subset if possible.
            // Since allData is the source, let's iterate.

            // To make it fast:
            // 1. Bisect to find index of `time`.
            // 2. Check neighbours.

            let bestCandle = null;
            // Simple loop for now.
            // If array large, this might lag. But replay data is usually one day (~1440 mins).
            for (const d of allData) {
                const diff = Math.abs((d.time as number) - t);
                if (diff < minDiff) {
                    minDiff = diff;
                    bestCandle = d;
                }
            }

            if (bestCandle && minDiff < (trade.instrument?.includes('Crypto') ? 300 : 300)) { // Snap if within 5 mins?
                // Snap Price to O/H/L/C closest to mouse price
                const prices = [bestCandle.open, bestCandle.high, bestCandle.low, bestCandle.close];
                const closestPrice = prices.reduce((prev, curr) =>
                    Math.abs(curr - price) < Math.abs(prev - price) ? curr : prev
                );

                // Snap Time to candle time
                return { time: bestCandle.time, price: closestPrice };
            }
        }

        return { time, price };
    };

    // --- Undo/Redo Logic ---
    const recordAction = useCallback((newDrawings: DrawingObject[]) => {
        setPast(prev => [...prev, drawings]);
        setFuture([]);
        setDrawings(newDrawings);
    }, [drawings]);

    const handleUndo = useCallback(() => {
        if (past.length === 0) return;
        const previous = past[past.length - 1];
        const newPast = past.slice(0, past.length - 1);
        setPast(newPast);
        setFuture(prev => [drawings, ...prev]);
        setDrawings(previous);
    }, [past, drawings]);

    const handleRedo = useCallback(() => {
        if (future.length === 0) return;
        const next = future[0];
        const newFuture = future.slice(1);
        setPast(prev => [...prev, drawings]);
        setFuture(newFuture);
        setDrawings(next);
    }, [future, drawings]);

    // Update setDrawings usage to record history when appropriate
    const updateDrawingsWithHistory = useCallback((updated: DrawingObject[]) => {
        recordAction(updated);
        // Save immediately for actions that are considered "complete" (like deletion or context menu changes)
        saveDrawingsImmediately(updated);
    }, [recordAction, saveDrawingsImmediately]);

    const handleContextMenu = (e: React.MouseEvent, drawingId: string) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = chartContainerRef.current?.getBoundingClientRect();
        if (rect) {
            setContextMenu({
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
                drawingId
            });
        }
    };

    // Close menu on click anywhere
    useEffect(() => {
        const closeMenu = () => setContextMenu(null);
        window.addEventListener('click', closeMenu);
        return () => window.removeEventListener('click', closeMenu);
    }, []);

    // --- Advanced Interaction Logic ---

    // Interaction Handlers

    // Shortcuts



    // Keyboard Handling (Delete / Escape)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (selectedDrawingId) {
                    updateDrawingsWithHistory(drawings.filter(d => d.id !== selectedDrawingId));
                    setSelectedDrawingId(null);
                }
            } else if (e.key === 'Escape') {
                if (selectedDrawingId) {
                    setSelectedDrawingId(null);
                } else if (activeTool !== 'cursor') {
                    setActiveTool('cursor');
                }
                setDragMode(null);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedDrawingId, activeTool]);

    // Crosshair Legend State

    // Derived Data (Filtered for Replay)
    const filteredData = useMemo(() => {
        if (!isReplayMode || playbackTime === null) return allData;
        return allData.filter(d => (d.time as number) <= playbackTime);
    }, [allData, isReplayMode, playbackTime]);

    const secondaryData = useMemo(() => {
        if (!activeLayout || activeLayout === 'single') return [];
        // If same timeframe, use main buffer
        if (secondaryTimeframe === mainTimeframe) {
            if (!isReplayMode || playbackTime === null) return allData;
            return allData.filter(d => (d.time as number) <= playbackTime);
        }
        // Otherwise use secondary HTF buffer
        if (!Array.isArray(allSecondaryData) || allSecondaryData.length === 0) return [];
        if (!isReplayMode || playbackTime === null) return allSecondaryData;
        return allSecondaryData.filter(d => (d.time as number) <= playbackTime);
    }, [allData, allSecondaryData, isReplayMode, playbackTime, secondaryTimeframe, mainTimeframe, activeLayout]);

    // Init Chart 2
    useEffect(() => {
        if (activeLayout === 'single' || !chartContainer2Ref.current) {
            if (chart2Ref.current) {
                chart2Ref.current.remove();
                chart2Ref.current = null;
                series2Ref.current = null;
            }
            // Ensure main chart resizes when back to single
            setTimeout(() => {
                if (chartRef.current && chartContainerRef.current) {
                    chartRef.current.applyOptions({
                        width: chartContainerRef.current.clientWidth,
                        height: chartContainerRef.current.clientHeight
                    });
                }
            }, 50);
            return;
        }

        if (chart2Ref.current) return;

        let timer: any = null;

        timer = setTimeout(() => {
            if (!chartContainer2Ref.current) return;
            const container = chartContainer2Ref.current;
            const width = container.clientWidth;
            const height = container.clientHeight;

            if (width === 0 || height === 0) return;

            const chart = createChart(container, {
                layout: {
                    background: { color: isDark ? '#131722' : '#ffffff' },
                    textColor: isDark ? '#d1d4dc' : '#131722',
                },
                grid: { vertLines: { visible: false }, horzLines: { visible: false } },
                timeScale: {
                    borderColor: isDark ? '#2a2e39' : '#e0e3eb',
                    timeVisible: true,
                    secondsVisible: false,
                },
                width,
                height
            });

            if (chartRef.current && chartContainerRef.current) {
                chartRef.current.applyOptions({
                    width: chartContainerRef.current.clientWidth,
                    height: chartContainerRef.current.clientHeight
                });
            }

            const series = chart.addSeries(CandlestickSeries, {
                upColor: '#cfd8dc', downColor: '#2962ff',
                borderVisible: true, borderColor: '#cfd8dc',
                wickUpColor: '#cfd8dc', wickDownColor: '#2962ff',
            });

            chart2Ref.current = chart;
            series2Ref.current = series;

            // TP/SL Series for Chart 2
            const tpSeries2 = chart.addSeries(BaselineSeries, {
                baseValue: { type: 'price', price: parseFloat(String(trade.entryPrice || 0)) },
                topLineColor: 'rgba(16, 185, 129, 1)',
                topFillColor1: 'rgba(16, 185, 129, 0.2)',
                topFillColor2: 'rgba(16, 185, 129, 0.2)',
                bottomLineColor: 'rgba(16, 185, 129, 1)',
                bottomFillColor1: 'rgba(16, 185, 129, 0.2)',
                bottomFillColor2: 'rgba(16, 185, 129, 0.2)',
                lastValueVisible: false,
                priceLineVisible: false,
            });

            const slSeries2 = chart.addSeries(BaselineSeries, {
                baseValue: { type: 'price', price: parseFloat(String(trade.entryPrice || 0)) },
                topLineColor: 'rgba(244, 63, 94, 1)',
                topFillColor1: 'rgba(244, 63, 94, 0.2)',
                topFillColor2: 'rgba(244, 63, 94, 0.2)',
                bottomLineColor: 'rgba(244, 63, 94, 1)',
                bottomFillColor1: 'rgba(244, 63, 94, 0.2)',
                bottomFillColor2: 'rgba(244, 63, 94, 0.2)',
                lastValueVisible: false,
                priceLineVisible: false,
            });

            tpSeries2Ref.current = tpSeries2;
            slSeries2Ref.current = slSeries2;

            // Price Lines for Chart 2
            const entryPrice = parseFloat(String(trade.entryPrice || 0));
            const slPrice = parseFloat(String(trade.stopLoss || 0));
            const tpPrice = parseFloat(String(trade.takeProfit || 0));

            if (entryPrice) {
                series.createPriceLine({
                    price: entryPrice, color: '#3b82f6', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: 'ENTRY',
                });
            }
            if (slPrice) {
                series.createPriceLine({
                    price: slPrice, color: '#f43f5e', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: 'SL',
                });
            }
            if (tpPrice) {
                series.createPriceLine({
                    price: tpPrice, color: '#10b981', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: 'TP',
                });
            }

            if (Array.isArray(secondaryData) && secondaryData.length > 0) {
                try { series.setData(secondaryData); } catch (e) { }
            }

            setChart2Ready(true);

            if (chartRef.current) {
                const mainTimeScale = chartRef.current.timeScale();
                const subTimeScale = chart.timeScale();

                // 1. Initial Sync Alignment
                const mainRange = mainTimeScale.getVisibleRange();
                if (mainRange?.to) {
                    const to = mainRange.to as number;
                    subTimeScale.setVisibleRange({
                        from: (to - subDurationRef.current) as Time,
                        to: to as Time
                    });
                }
            }
        }, 50);

        return () => {
            if (timer) clearTimeout(timer);
            if (cleanupRef.current) {
                cleanupRef.current();
                cleanupRef.current = null;
            }
            if (chart2Ref.current) {
                chart2Ref.current.remove();
                chart2Ref.current = null;
                series2Ref.current = null;
                tpSeries2Ref.current = null;
                slSeries2Ref.current = null;
                setChart2Ready(false);
            }
        };
    }, [activeLayout, isDark, containerReady, trade.id, trade.entryPrice, trade.stopLoss, trade.takeProfit]);

    // Update Chart 2 Data
    useEffect(() => {
        if (chart2Ref.current && series2Ref.current && Array.isArray(secondaryData) && chart2Ready) {
            series2Ref.current.setData(secondaryData);
        }
    }, [secondaryData, chart2Ready]);

    // Fetch Secondary Data
    useEffect(() => {
        const fetchSecondary = async () => {
            if (activeLayout !== 'split' || !trade.date || !trade.instrument || secondaryTimeframe === mainTimeframe) return;

            setIsSecondaryLoading(true);
            try {
                const exitTimeRaw = new Date(trade.date).getTime() / 1000;
                const exitTimeRounded = Math.floor(exitTimeRaw / 60) * 60;

                // Fetch more for HTF
                let daysToFetch = 3;
                if (secondaryTimeframe === '5m') daysToFetch = 5;
                if (secondaryTimeframe === '15m') daysToFetch = 15;
                if (secondaryTimeframe === '1h') daysToFetch = 60;
                if (secondaryTimeframe === '4h' || secondaryTimeframe === 'D' || secondaryTimeframe === 'W') daysToFetch = 500;

                const from = new Date((exitTimeRounded - daysToFetch * 24 * 3600) * 1000).toISOString();
                const to = new Date((exitTimeRounded + 1 * 24 * 3600) * 1000).toISOString();

                const url = `/api/candles?instrument=${encodeURIComponent(trade.instrument)}&from=${from}&to=${to}&timeframe=${secondaryTimeframe}`;
                const res = await fetch(url);
                if (res.ok) {
                    const rawData = await res.json();
                    if (Array.isArray(rawData)) {
                        const timeOffset = -new Date().getTimezoneOffset() * 60;
                        const currentPriceOffset = priceOffset;
                        const isLocal = detectedIsLocal;

                        const valid = rawData.map((d: any) => ({
                            time: (d.time + (isLocal ? 0 : timeOffset)) as Time,
                            open: d.open + priceOffset,
                            high: d.high + priceOffset,
                            low: d.low + priceOffset,
                            close: d.close + priceOffset
                        }));
                        setAllSecondaryData(valid);
                    }
                }
            } finally {
                setIsSecondaryLoading(false);
            }
        };
        fetchSecondary();
    }, [trade.instrument, trade.date, secondaryTimeframe, activeLayout, mainTimeframe, priceOffset, detectedIsLocal]);

    // Handle Resize for both charts
    useEffect(() => {
        const obs = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                if (width === 0 || height === 0) continue;

                if (entry.target === chartContainerRef.current && chartRef.current) {
                    chartRef.current.applyOptions({ width, height });
                }
                if (entry.target === chartContainer2Ref.current && chart2Ref.current) {
                    chart2Ref.current.applyOptions({ width, height });
                }
            }
        });

        if (chartContainerRef.current) obs.observe(chartContainerRef.current);
        if (chartContainer2Ref.current) obs.observe(chartContainer2Ref.current);

        return () => obs.disconnect();
    }, [chartReady, chart2Ready, activeLayout]);

    useEffect(() => {
        if (!chartRef.current) return;
        const timeScale = chartRef.current.timeScale();

        const handleTimeRangeChange = () => {
            setChartRevision(r => r + 1);
        };

        timeScale.subscribeVisibleTimeRangeChange(handleTimeRangeChange);
        return () => timeScale.unsubscribeVisibleTimeRangeChange(handleTimeRangeChange);
    }, [chartReady]);

    // Force re-render overlay when chart 2 moves
    useEffect(() => {
        if (!chart2Ref.current) return;
        const timeScale = chart2Ref.current.timeScale();

        const handleTimeRangeChange = () => {
            setChartRevision(r => r + 1);
        };

        timeScale.subscribeVisibleTimeRangeChange(handleTimeRangeChange);
        return () => timeScale.unsubscribeVisibleTimeRangeChange(handleTimeRangeChange);
    }, [activeLayout]);

    // Monitor container size
    useEffect(() => {
        if (!chartContainerRef.current) return;
        const container = chartContainerRef.current;

        const checkSize = () => {
            if (container.clientWidth > 0 && container.clientHeight > 0) {
                setContainerReady(true);
            }
        };

        checkSize();
        const observer = new ResizeObserver(checkSize);
        observer.observe(container);

        const handleWheel = (e: WheelEvent) => {
            const chart = chartRef.current;
            if (!chart) return;

            const target = e.currentTarget as HTMLElement;
            const rect = target.getBoundingClientRect();
            const x = e.clientX - rect.left;

            // If mouse is over the right price scale area (approx 70px)
            if (x > rect.width - 70) {
                e.preventDefault();
                e.stopPropagation(); // CRITICAL: Stop charting library from seeing this

                const priceScale = chart.priceScale('right');
                const range = priceScale.getVisibleRange();
                if (!range) return;

                const diff = (range.to - range.from);
                const zoomFactor = e.deltaY > 0 ? 1.05 : 0.95;
                const newDiff = diff * zoomFactor;
                const center = (range.to + range.from) / 2;

                const newFrom = center - newDiff / 2;
                const newTo = center + newDiff / 2;

                // Use autoscaleInfoProvider on the series to force the scale
                // We keep priceScale in autoScale mode, but feed it a constrained range
                const series = seriesRef.current;
                if (series) {
                    series.applyOptions({
                        autoscaleInfoProvider: () => ({
                            priceRange: {
                                minValue: newFrom,
                                maxValue: newTo,
                            },
                        }),
                    });
                }
            }
        };

        // Use capture: true to get the event BEFORE lightweight-charts captures it on its VPC canvas
        container.addEventListener('wheel', handleWheel, { passive: false, capture: true });

        return () => {
            observer.disconnect();
            container.removeEventListener('wheel', handleWheel, { capture: true });
        };
    }, [trade.id]);

    // Monitor container 2 size & wheel
    useEffect(() => {
        if (activeLayout !== 'split' || !chartContainer2Ref.current) return;
        const container = chartContainer2Ref.current;

        const handleWheel = (e: WheelEvent) => {
            const chart = chart2Ref.current;
            if (!chart) return;

            const target = e.currentTarget as HTMLElement;
            const rect = target.getBoundingClientRect();
            const x = e.clientX - rect.left;

            if (x > rect.width - 70) {
                e.preventDefault();
                e.stopPropagation();

                const priceScale = chart.priceScale('right');
                const range = priceScale.getVisibleRange();
                if (!range) return;

                const diff = (range.to - range.from);
                const zoomFactor = e.deltaY > 0 ? 1.05 : 0.95;
                const newDiff = diff * zoomFactor;
                const center = (range.to + range.from) / 2;

                const newFrom = center - newDiff / 2;
                const newTo = center + newDiff / 2;

                const series2 = series2Ref.current;
                if (series2) {
                    series2.applyOptions({
                        autoscaleInfoProvider: () => ({
                            priceRange: {
                                minValue: newFrom,
                                maxValue: newTo,
                            },
                        }),
                    });
                }
            }
        };

        container.addEventListener('wheel', handleWheel, { passive: false, capture: true });
        return () => container.removeEventListener('wheel', handleWheel, { capture: true });
    }, [activeLayout, chart2Ready, trade.id]);

    // 1. Fetch Data Effect (Independent of Chart)
    useEffect(() => {
        const fetchData = async () => {
            if (!trade.date || !trade.instrument) return;

            setIsLoading(true);
            setError(null);

            try {
                const exitTimeRaw = new Date(trade.date).getTime() / 1000;
                // Round to nearest minute to ensure cache consistency
                const exitTimeRounded = Math.floor(exitTimeRaw / 60) * 60;

                // Initial range: much smaller for fast load
                const daysToFetch = (mainTimeframe === '1m' || mainTimeframe === '5m') ? 1 : 3;

                // Use rounded times for API requests
                const from = new Date((exitTimeRounded - daysToFetch * 24 * 3600) * 1000).toISOString();
                const to = new Date((exitTimeRounded + 1 * 24 * 3600) * 1000).toISOString();

                const response = await fetch(`/api/candles?instrument=${encodeURIComponent(trade.instrument)}&from=${from}&to=${to}&timeframe=${mainTimeframe}`);

                if (!response.ok) {
                    const errData = await response.json();
                    throw new Error(errData.details || 'Failed to fetch candle data');
                }

                const rawData = await response.json();

                if (Array.isArray(rawData) && rawData.length > 0) {
                    let priceOffset = 0;
                    const durationSeconds = (trade.durationMinutes || 0) * 60;
                    const entryTimeRaw = exitTimeRaw - durationSeconds;
                    const entryPrice = parseFloat(String(trade.entryPrice || 0));

                    const timeOffset = -new Date().getTimezoneOffset() * 60;

                    let bestCandle = null;
                    let minDiff = Infinity;
                    let detectedIsLocal = false;

                    for (const d of rawData) {
                        const t = d.time;
                        const diffLocal = Math.abs(t - entryTimeRaw);
                        const diffUtc = Math.abs(t - (entryTimeRaw + timeOffset));

                        if (diffLocal < minDiff) {
                            minDiff = diffLocal; bestCandle = d; detectedIsLocal = true;
                        }
                        if (diffUtc < minDiff) {
                            minDiff = diffUtc; bestCandle = d; detectedIsLocal = false;
                        }
                    }

                    if (bestCandle && minDiff < 4 * 3600 && entryPrice) {
                        priceOffset = entryPrice - (bestCandle as any).close;
                        setPriceOffset(priceOffset);
                        priceOffsetRef.current = priceOffset; // Sync ref
                    }

                    setDetectedIsLocal(detectedIsLocal);
                    isLocalTimeRef.current = detectedIsLocal; // Sync ref

                    const validData = rawData.map((d: any) => ({
                        time: (d.time + (detectedIsLocal ? 0 : timeOffset)) as Time,
                        open: d.open + priceOffset,
                        high: d.high + priceOffset,
                        low: d.low + priceOffset,
                        close: d.close + priceOffset
                    }));

                    setAllData(validData);
                } else {
                    setError('No data found for this period');
                }
            } catch (err: any) {
                console.error("Replay data fetch error:", err);
                setError(err.message || "Failed to load historical data");
            } finally {
                setIsLoading(false);
            }
        };

        fetchData();
    }, [trade.id, trade.instrument, trade.date, trade.durationMinutes, trade.entryPrice, mainTimeframe]);

    const handleGoToTrade = useCallback(() => {
        const chart = chartRef.current;
        const currentData = allDataRef.current;
        if (!chart || !currentData.length) return;

        const exitTimeRaw = new Date(trade.date).getTime() / 1000;
        const durationMinutes = trade.durationMinutes || 0;
        const durationSeconds = durationMinutes * 60;
        const entryTimeRaw = exitTimeRaw - durationSeconds;
        const timeOffset = -new Date().getTimezoneOffset() * 60;

        const isLocal = isLocalTimeRef.current;
        const visualEntry = isLocal ? entryTimeRaw : (entryTimeRaw + timeOffset);
        const visualExit = isLocal ? exitTimeRaw : (exitTimeRaw + timeOffset);

        // Calculate a nice range (1 hour before, 2x duration or at least 2 hours after)
        const buffer = Math.max(7200, durationSeconds * 3);

        if (trade.miniViewRange) {
            chart.timeScale().setVisibleRange(trade.miniViewRange as any);
        } else {
            chart.timeScale().setVisibleRange({
                from: (visualEntry - 3600) as Time,
                to: (visualExit + buffer) as Time,
            });
        }

        // If split view, center both
        if (chart2Ref.current) {
            if (trade.miniViewSecondaryRange) {
                chart2Ref.current.timeScale().setVisibleRange(trade.miniViewSecondaryRange as any);
            } else {
                chart2Ref.current.timeScale().setVisibleRange({
                    from: (visualEntry - 3600) as Time,
                    to: (visualExit + buffer) as Time,
                });
            }
        }
    }, [trade.date, trade.durationMinutes, trade.miniViewRange, trade.miniViewSecondaryRange]);

    const [hasSavedView, setHasSavedView] = useState(!!trade.miniViewRange);
    useEffect(() => { setHasSavedView(!!trade.miniViewRange); }, [trade.miniViewRange]);

    useImperativeHandle(ref, () => ({
        goToTrade: handleGoToTrade
    }));


    const handleSaveView = async () => {
        setIsFixingView(true);
        try {
            const updates: Partial<Trade> = {};

            // Save Main Chart Range
            if (chartRef.current) {
                const range = chartRef.current.timeScale().getVisibleRange();
                if (range) {
                    updates.miniViewRange = { from: range.from as number, to: range.to as number };
                }
            }

            // Save Layout
            updates.miniViewLayout = activeLayout;

            // Save Secondary Chart Range & Timeframe
            if (activeLayout === 'split') {
                updates.miniViewSecondaryTimeframe = secondaryTimeframe;
                if (chart2Ref.current) {
                    const range2 = chart2Ref.current.timeScale().getVisibleRange();
                    if (range2) {
                        updates.miniViewSecondaryRange = { from: range2.from as number, to: range2.to as number };
                    }
                }
            }

            await storageService.updateTrade(trade.id, updates);

            // Immediate update for parent component
            onUpdateTrade?.(updates);

            // Show Toast
            setSaveToast(true);
            setHasSavedView(true);
            setTimeout(() => setSaveToast(false), 2000);

        } catch (err) {
            console.error("Failed to fix view:", err);
        } finally {
            setIsFixingView(false);
        }
    };

    const handleClearView = async () => {
        setIsFixingView(true);
        try {
            const updates = {
                miniViewRange: undefined,
                miniViewLayout: undefined,
                miniViewSecondaryRange: undefined,
                miniViewSecondaryTimeframe: undefined
            };
            await storageService.updateTrade(trade.id, updates);
            onUpdateTrade?.(updates);
            setHasSavedView(false);
            handleGoToTrade();
        } catch (err) {
            console.error("Failed to clear view:", err);
        } finally {
            setIsFixingView(false);
        }
    };

    // Auto-center on first load
    useEffect(() => {
        if (!isLoading && allData.length > 0 && chartReady && !hasInitialCentered) {
            const timer = setTimeout(() => {
                if (minimal && (trade.miniViewRange || trade.miniViewSecondaryRange) && chartRef.current) {
                    if (trade.miniViewRange) chartRef.current.timeScale().setVisibleRange(trade.miniViewRange as any);
                    if (trade.miniViewSecondaryRange && chart2Ref.current) {
                        chart2Ref.current.timeScale().setVisibleRange(trade.miniViewSecondaryRange as any);
                    }
                } else {
                    handleGoToTrade();
                }
                setHasInitialCentered(true);
            }, 100);
            return () => clearTimeout(timer);
        }
    }, [isLoading, allData.length, chartReady, hasInitialCentered, handleGoToTrade, minimal, trade.miniViewRange]);

    const loadMorePast = useCallback(async (target: 'main' | 'secondary' = 'main') => {
        if (isFetchingMore) return;

        const isMain = target === 'main';
        const currentData = isMain ? allDataRef.current : allSecondaryDataRef.current;
        if (currentData.length === 0 || !trade.instrument) return;

        setIsFetchingMore(true);
        try {
            const firstTime = currentData[0].time as number;
            const timeOffset = -new Date().getTimezoneOffset() * 60;
            const tf = isMain ? mainTimeframe : secondaryTimeframe;

            // Adjust chunks based on timeframe
            let daysToFetch = (tf === '1m' || tf === '5m') ? 2 : 30;
            if (tf === '4h' || tf === 'D') daysToFetch = 180;

            const firstTimeRounded = Math.floor(firstTime / 60) * 60;
            const to = new Date((firstTimeRounded - timeOffset - 1) * 1000).toISOString();
            const from = new Date((firstTimeRounded - timeOffset - daysToFetch * 24 * 3600) * 1000).toISOString();

            // Cache-Only for scrollback to ensure speed and prevent jumping
            const response = await fetch(`/api/candles?instrument=${encodeURIComponent(trade.instrument)}&from=${from}&to=${to}&timeframe=${tf}&cacheOnly=true`);
            if (response.ok) {
                const rawData = await response.json();
                if (Array.isArray(rawData) && rawData.length > 0) {
                    const priceOffset = priceOffsetRef.current;
                    const isLocal = isLocalTimeRef.current;
                    const validData = rawData.map((d: any) => ({
                        time: (d.time + (isLocal ? 0 : timeOffset)) as Time,
                        open: d.open + priceOffset,
                        high: d.high + priceOffset,
                        low: d.low + priceOffset,
                        close: d.close + priceOffset
                    }));

                    if (isMain) {
                        setAllData(prev => {
                            const map = new Map();
                            [...validData, ...prev].forEach(d => map.set(d.time, d));
                            return Array.from(map.values()).sort((a, b) => (a.time as number) - (b.time as number));
                        });
                    } else {
                        setAllSecondaryData(prev => {
                            const map = new Map();
                            [...validData, ...prev].forEach(d => map.set(d.time, d));
                            return Array.from(map.values()).sort((a, b) => (a.time as number) - (b.time as number));
                        });
                    }
                }
            }
        } catch (err) {
            console.error("Failed to load more data:", err);
        } finally {
            setTimeout(() => setIsFetchingMore(false), 800);
        }
    }, [trade.instrument, mainTimeframe, secondaryTimeframe, isFetchingMore]);

    // Initial fetch should ALSO be fast, but we might allow it a bit more leeway? 
    // Actually, let's keep it normal for the very first load to ensure we have AT LEAST the trade area.
    useEffect(() => {
        if (!containerReady || !chartContainerRef.current) return;

        // Prevent double init
        if (chartRef.current) {
            chartRef.current.remove();
        }

        const container = chartContainerRef.current;
        const width = container.clientWidth;
        const height = container.clientHeight;

        const chart = createChart(container, {
            layout: {
                background: { color: isDark ? '#131722' : '#ffffff' },
                textColor: isDark ? '#d1d4dc' : '#131722',
            },
            grid: {
                vertLines: { visible: false },
                horzLines: { visible: false },
            },
            crosshair: {
                mode: 0,
                vertLine: { visible: false, labelVisible: true },
                horzLine: { visible: false, labelVisible: true },
            },
            timeScale: {
                borderColor: isDark ? '#2a2e39' : '#e0e3eb',
                timeVisible: true,
                secondsVisible: false,
            },
            width: width,
            height: height,
        });

        const series = chart.addSeries(CandlestickSeries, {
            upColor: '#cfd8dc', // Grey for Bullish
            downColor: '#2962ff', // Blue for Bearish
            borderVisible: true,
            borderColor: '#cfd8dc',
            wickUpColor: '#cfd8dc',
            wickDownColor: '#2962ff',
        });

        // Initialize Baseline Series for RRR Boxes
        const tpSeries = chart.addSeries(BaselineSeries, {
            baseValue: { type: 'price', price: parseFloat(String(trade.entryPrice || 0)) },
            topLineColor: 'rgba(16, 185, 129, 1)',
            topFillColor1: 'rgba(16, 185, 129, 0.2)',
            topFillColor2: 'rgba(16, 185, 129, 0.2)',
            bottomLineColor: 'rgba(16, 185, 129, 1)',
            bottomFillColor1: 'rgba(16, 185, 129, 0.2)',
            bottomFillColor2: 'rgba(16, 185, 129, 0.2)',
            lastValueVisible: false,
            priceLineVisible: false,
        });

        const slSeries = chart.addSeries(BaselineSeries, {
            baseValue: { type: 'price', price: parseFloat(String(trade.entryPrice || 0)) },
            topLineColor: 'rgba(244, 63, 94, 1)',
            topFillColor1: 'rgba(244, 63, 94, 0.2)',
            topFillColor2: 'rgba(244, 63, 94, 0.2)',
            bottomLineColor: 'rgba(244, 63, 94, 1)',
            bottomFillColor1: 'rgba(244, 63, 94, 0.2)',
            bottomFillColor2: 'rgba(244, 63, 94, 0.2)',
            lastValueVisible: false,
            priceLineVisible: false,
        });

        // Add lines...
        const entryPrice = parseFloat(String(trade.entryPrice || 0));
        const slPrice = parseFloat(String(trade.stopLoss || 0));
        const tpPrice = parseFloat(String(trade.takeProfit || 0));

        if (entryPrice) {
            series.createPriceLine({
                price: entryPrice, color: '#3b82f6', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: 'ENTRY',
            });
        }
        if (slPrice) {
            series.createPriceLine({
                price: slPrice, color: '#f43f5e', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: 'SL',
            });
        }
        if (tpPrice) {
            series.createPriceLine({
                price: tpPrice, color: '#10b981', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: 'TP',
            });
        }

        chartRef.current = chart;
        seriesRef.current = series;
        tpSeriesRef.current = tpSeries;
        slSeriesRef.current = slSeries;
        setChartReady(true); // Signal ready

        const handleResize = () => {
            if (chartContainerRef.current && chartRef.current) {
                chartRef.current.applyOptions({
                    width: chartContainerRef.current.clientWidth,
                    height: chartContainerRef.current.clientHeight
                });
            }
        };

        window.addEventListener('resize', handleResize);

        // Crosshair Legend Handler
        const handleCrosshairMove = (param: any) => {
            if (!param.point || !seriesRef.current) {
                setCrosshairValues(null);
                return;
            }

            const data = param.seriesData.get(series);
            if (data) {
                const open = data.open !== undefined ? data.open.toFixed(2) : '';
                const high = data.high !== undefined ? data.high.toFixed(2) : '';
                const low = data.low !== undefined ? data.low.toFixed(2) : '';
                const close = data.close !== undefined ? data.close.toFixed(2) : '';
                // Date formatting
                const dateStr = new Date((data.time as number) * 1000).toLocaleString();
                setCrosshairValues({ open, high, low, close, date: dateStr });
            }
        };

        chart.subscribeCrosshairMove(handleCrosshairMove);

        return () => {
            window.removeEventListener('resize', handleResize);
            chart.unsubscribeCrosshairMove(handleCrosshairMove);
            chart.remove();
            chartRef.current = null;
            seriesRef.current = null;
            tpSeriesRef.current = null;
            slSeriesRef.current = null;
            setChartReady(false);
        };
    }, [trade.id, trade.instrument, trade.entryPrice, trade.stopLoss, trade.takeProfit, isDark, containerReady]); // Stabilized dependencies

    // 2.5 Separate TimeRange Subscription for BOTH charts
    useEffect(() => {
        if (!chartReady || !chartRef.current) return;

        const handleVisibleRangeChange1 = () => {
            const chart = chartRef.current;
            if (!chart) return;
            const range = chart.timeScale().getVisibleRange();
            const currentData = allDataRef.current;
            if (!range || isFetchingMore || currentData.length === 0) return;

            const firstTime = currentData[0].time as number;
            if ((range.from as number) < firstTime + (currentData[currentData.length - 1].time as number - firstTime) * 0.25) {
                loadMorePast('main');
            }
        };

        chartRef.current.timeScale().subscribeVisibleTimeRangeChange(handleVisibleRangeChange1);

        const handleVisibleRangeChange2 = () => {
            const chart = chart2Ref.current;
            if (!chart) return;
            const range = chart.timeScale().getVisibleRange();
            const currentData = allSecondaryDataRef.current;
            if (!range || isFetchingMore || currentData.length === 0) return;

            const firstTime = currentData[0].time as number;
            if ((range.from as number) < firstTime + (currentData[currentData.length - 1].time as number - firstTime) * 0.25) {
                loadMorePast('secondary');
            }
        };

        if (chart2Ref.current) {
            chart2Ref.current.timeScale().subscribeVisibleTimeRangeChange(handleVisibleRangeChange2);
        }

        return () => {
            chartRef.current?.timeScale().unsubscribeVisibleTimeRangeChange(handleVisibleRangeChange1);
            chart2Ref.current?.timeScale().unsubscribeVisibleTimeRangeChange(handleVisibleRangeChange2);
        };
    }, [chartReady, activeLayout, loadMorePast, isFetchingMore]);

    // 3. Sync Data Effect
    useEffect(() => {
        if (chartReady && seriesRef.current && filteredData.length > 0) {
            seriesRef.current.setData(filteredData);

            // Re-calculate Visual Times based on the heuristic determined during fetch
            // We need to pass the determined 'isLocalStored' flag from fetch to here.
            // Since we can't easily pass state between decoupled effects without another state ref, 
            // we'll re-run the simple heuristic logic or store it in a ref.

            // Re-running heuristic for display sync (fast enough)
            const exitTimeRaw = new Date(trade.date).getTime() / 1000;
            const durationSeconds = (trade.durationMinutes || 0) * 60;
            const entryTimeRaw = exitTimeRaw - durationSeconds;

            const timeOffset = -new Date().getTimezoneOffset() * 60;

            // Quick check: matches candles better with or without offset?
            // (Simulated check using the first data point if available, or just use a ref)
            // Better: Store the detected offset in a State/Ref from the fetch effect.
            // For now, let's use the `visualOffset` stored in the `priceOffset` variable or similar? No.
            // Let's rely on validData's time alignment.

            // Actually, we can just use the START and END of the RRR box relative to the chart's time scale.
            // We determined 'shift' during fetch.
            // Let's assume we need to verify again or just standard logic:

            // HACK: We can't easily share the "decision" from the async fetch 
            // without a new state variable. Let's add `isLocalTime` state.

            // Fallback for now: Check logic again.
            // If we assume the chart data `d.time` is ALREADY shifted to Local Correctly (it is).
            // Then we just need to know if `entryTimeRaw` is ALREADY Local.

            // Heuristic:
            // If entryTimeRaw is close to d.time (which is Local), then entryTimeRaw is Local.
            // If entryTimeRaw + OFFSET is close to d.time, then entryTimeRaw is UTC.

            let isLocalStored = false;
            if (Array.isArray(allData) && allData.length > 0) {
                const midCandle = allData[Math.floor(allData.length / 2)];
                const candleTime = midCandle.time as number;

                // Compare distance to a candle (any candle in range)? No.
                // We fetched data for the specific day.
                // Finding closest candle again.
                let minDiffLocal = Infinity;
                let minDiffUtc = Infinity;

                allData.forEach(d => {
                    const t = d.time as number; // This is Visual Local Time
                    const diffLocal = Math.abs(t - entryTimeRaw); // Assume stored is Local
                    const diffUtc = Math.abs(t - (entryTimeRaw + timeOffset)); // Assume stored is UTC (so we add offset to match visual)

                    if (diffLocal < minDiffLocal) minDiffLocal = diffLocal;
                    if (diffUtc < minDiffUtc) minDiffUtc = diffUtc;
                });

                if (minDiffLocal < minDiffUtc) isLocalStored = true;
            } else if (detectedIsLocal !== undefined) {
                // Fallback to detected state if allData not yet available or mapped
                isLocalStored = detectedIsLocal;
            }

            const shiftedEntryTime = isLocalStored ? entryTimeRaw : (entryTimeRaw + timeOffset);
            const shiftedExitTime = isLocalStored ? exitTimeRaw : (exitTimeRaw + timeOffset);

            const tpPrice = parseFloat(String(trade.takeProfit || 0));
            const slPrice = parseFloat(String(trade.stopLoss || 0));

            const tpData: any[] = [];
            const slData: any[] = [];

            allData.forEach(d => {
                const t = d.time as number;
                if (t >= shiftedEntryTime && t <= shiftedExitTime) {
                    if (tpPrice) tpData.push({ time: t, value: tpPrice });
                    if (slPrice) slData.push({ time: t, value: slPrice });
                }
            });

            if (tpSeriesRef.current && tpData.length > 0) tpSeriesRef.current.setData(tpData);
            if (slSeriesRef.current && slData.length > 0) slSeriesRef.current.setData(slData);

            // Sync with Chart 2 as well
            if (chart2Ready) {
                // Secondary chart needs its own data filtered for its aggregates
                const secondaryTpData: any[] = [];
                const secondarySlData: any[] = [];

                allSecondaryData.forEach(d => {
                    const t = d.time as number;
                    if (t >= shiftedEntryTime && t <= shiftedExitTime) {
                        if (tpPrice) secondaryTpData.push({ time: t, value: tpPrice });
                        if (slPrice) secondarySlData.push({ time: t, value: slPrice });
                    }
                });

                if (tpSeries2Ref.current && secondaryTpData.length > 0) tpSeries2Ref.current.setData(secondaryTpData);
                if (slSeries2Ref.current && secondarySlData.length > 0) slSeries2Ref.current.setData(secondarySlData);
            }


            // chartRef.current?.timeScale().fitContent(); // Removed to prevent auto-centering
        }
    }, [chartReady, allData, filteredData, chart2Ready, allSecondaryData]);

    // 4. Vertical Resize Sync Loop (Fix for Y-axis lag)
    useEffect(() => {
        if (!chartReady || !seriesRef.current || !trade.entryPrice) return;

        let lastY: number | null = null;
        let rafId: number;

        const syncLoop = () => {
            if (seriesRef.current) {
                const currentY = seriesRef.current.priceToCoordinate(parseFloat(String(trade.entryPrice)));
                if (currentY !== null && lastY !== null && Math.abs(currentY - lastY) > 0.5) {
                    setChartRevision(r => r + 1);
                }
                lastY = currentY;
            }
            rafId = requestAnimationFrame(syncLoop);
        };

        rafId = requestAnimationFrame(syncLoop);
        return () => cancelAnimationFrame(rafId);
    }, [chartReady, trade.entryPrice]);

    // Bar-by-Bar Replay Loop
    useEffect(() => {
        if (!isReplayMode || playbackTime === null || !isReplayPlaying) return;

        const interval = setInterval(() => {
            setPlaybackTime(prev => {
                if (prev === null) return null;
                const currentIndex = allData.findIndex(d => (d.time as number) === prev);
                if (currentIndex !== -1 && currentIndex < allData.length - 1) {
                    return allData[currentIndex + 1].time as number;
                }
                setIsReplayPlaying(false);
                return prev;
            });
        }, replaySpeed);

        return () => clearInterval(interval);
    }, [isReplayPlaying, isReplayMode, playbackTime, allData, replaySpeed]);

    const stepForward = () => {
        setPlaybackTime(prev => {
            if (prev === null && allData.length > 0) return allData[0].time as number;
            const idx = allData.findIndex(d => (d.time as number) === prev);
            if (idx !== -1 && idx < allData.length - 1) return allData[idx + 1].time as number;
            return prev;
        });
    };

    const stepBackward = () => {
        setPlaybackTime(prev => {
            if (prev === null) return null;
            const idx = allData.findIndex(d => (d.time as number) === prev);
            if (idx > 0) return allData[idx - 1].time as number;
            return prev;
        });
    };

    const handleCut = (time: number) => {
        setPlaybackTime(time);
        setIsReplayMode(true);
        setIsCutToolActive(false);
        setActiveTool('cursor');
    };

    // Keyboard Shortcuts (Moved here to avoid "Cannot access before initialization" for replay state/hooks)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            // Replay Shortcuts (Priority)
            if (isReplayMode) {
                if (e.key === ' ') {
                    e.preventDefault();
                    setIsReplayPlaying(prev => !prev);
                    return;
                }
                if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    stepForward();
                    return;
                }
                if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    stepBackward();
                    return;
                }
            }

            // Undo/Redo Shortcuts
            if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
                e.preventDefault();
                if (e.shiftKey) {
                    handleRedo();
                } else {
                    handleUndo();
                }
                return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key === 'y') {
                e.preventDefault();
                handleRedo();
                return;
            }

            // Tools Shortcuts
            if (e.key.toLowerCase() === 't') setActiveTool(e.shiftKey ? 'text' : 'line');
            if (e.key.toLowerCase() === 'r') setActiveTool('rect');
        };

        window.addEventListener('keydown', handleKeyDown, true); // Use capture to intercept early
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [handleUndo, handleRedo, isReplayMode, isReplayPlaying, stepForward, stepBackward]);

    // Render logic
    const containerClasses = embedded
        ? `w-full h-full flex flex-col ${isDark ? 'bg-[#0f172a]' : 'bg-white'}`
        : `w-full h-full flex flex-col ${isDark ? 'bg-[#0f172a]' : 'bg-white'}`; // Removed max-w-6xl, aspect-video, and shadow-2xl

    const wrapperClasses = embedded
        ? "w-full h-full"
        : "fixed inset-0 z-[200] bg-black/95 backdrop-blur-3xl flex items-center justify-center animate-in fade-in duration-300"; // Removed p-4

    const content = (
        <div className={containerClasses}>
            {/* Header */}
            <div className={`h-12 md:h-14 shrink-0 border-b flex items-center justify-between px-2 md:px-4 z-50 ${isDark ? 'border-slate-800 bg-[#131722]' : 'border-slate-200 bg-white'}`}>
                {/* Left: Symbol & Timeframes */}
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <div className={`p-1.5 rounded-lg ${isDark ? 'bg-blue-500/10 text-blue-500' : 'bg-blue-100 text-blue-600'}`}>
                            <FastForward size={16} />
                        </div>
                        <div className="flex flex-col">
                            <h3 className={`font-bold tracking-tight uppercase text-xs sm:text-sm ${isDark ? 'text-[#d1d4dc]' : 'text-slate-900'}`}>
                                {trade.instrument}
                            </h3>
                            <span className="text-[10px] text-slate-500 font-mono">{new Date(trade.date).toLocaleDateString()}</span>
                        </div>
                    </div>

                    <div className="w-px h-6 bg-slate-700/20 hidden sm:block"></div>

                    {/* Timeframes */}
                    <div className="hidden md:flex items-center gap-3">
                        {/* Timeframe Selector */}
                        <div className="flex items-center gap-1 relative">
                            <div className="flex gap-1">
                                {allTimeframes.filter(tf => favoriteTimeframes.includes(tf)).map((tf) => (
                                    <button
                                        key={tf}
                                        onClick={() => setTf(tf)}
                                        className={`
                                            px-2 py-1 rounded-lg text-[10px] font-bold transition-all
                                            ${(currentTf === tf)
                                                ? (isDark ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-900 border border-slate-200')
                                                : (isDark ? 'text-slate-500 hover:text-slate-300 hover:bg-white/5' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100')}
                                        `}
                                    >
                                        {tf}
                                    </button>
                                ))}
                            </div>

                            <div className="relative">
                                <button
                                    onClick={(e) => { e.stopPropagation(); setShowTfDropdown(!showTfDropdown); }}
                                    className={`p-1 rounded-lg transition-colors ${isDark ? 'text-slate-400 hover:bg-white/5' : 'text-slate-500 hover:bg-slate-100'}`}
                                >
                                    <ChevronDown size={14} className={`transition-transform duration-200 ${showTfDropdown ? 'rotate-180' : ''}`} />
                                </button>

                                {showTfDropdown && (
                                    <div className={`absolute top-full left-0 mt-2 w-40 py-2 rounded-xl shadow-2xl border z-[100] animate-in fade-in slide-in-from-top-2 duration-200 ${isDark ? 'bg-[#1e222d] border-slate-700' : 'bg-white border-slate-200'}`}>
                                        {allTimeframes.map(tf => (
                                            <div
                                                key={tf}
                                                className={`flex items-center justify-between px-3 py-1.5 cursor-pointer group hover:bg-blue-500/10 transition-colors`}
                                                onClick={() => setTf(tf)}
                                            >
                                                <span className={`text-xs font-bold ${currentTf === tf ? 'text-blue-500' : (isDark ? 'text-slate-300' : 'text-slate-700')}`}>{tf}</span>
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        toggleFavorite(tf);
                                                    }}
                                                    className={`p-1 rounded hover:bg-blue-500/20 transition-colors ${favoriteTimeframes.includes(tf) ? 'text-amber-500' : 'text-slate-400 opacity-0 group-hover:opacity-100'}`}
                                                >
                                                    <Star size={12} fill={favoriteTimeframes.includes(tf) ? "currentColor" : "none"} />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>

                    </div>
                </div>

                {/* Center/Right: Actions */}
                <div className="flex items-center gap-2">
                    {!minimal && (
                        <button
                            onClick={() => setActiveLayout(prev => prev === 'single' ? 'split' : 'single')}
                            className={`flex items-center gap-2 px-3 py-2 rounded-xl border transition-all active:scale-95 group ${activeLayout === 'split' ? 'bg-amber-500/10 border-amber-500/20 text-amber-500' : 'bg-slate-500/10 text-slate-500 hover:bg-slate-600 hover:text-white'}`}
                            title={activeLayout === 'split' ? "Switch to Single View" : "Switch to Split View"}
                        >
                            {activeLayout === 'split' ? <Square size={16} /> : <Columns size={16} />}
                            <span className="font-bold text-[10px] uppercase tracking-wider hidden lg:inline">{activeLayout === 'split' ? 'Single' : 'Split'}</span>
                        </button>
                    )}

                    {!embedded && (
                        <button onClick={onClose} className={`p-2 rounded-full transition-all ml-2 ${isDark ? 'hover:bg-white/10 text-slate-500 hover:text-white' : 'hover:bg-slate-100 text-slate-400 hover:text-black'}`}>
                            <X size={20} />
                        </button>
                    )}
                </div>
            </div>



            {/* Main Content Area: Toolbar + Charts */}
            < div
                className={`flex-1 flex flex-row overflow-hidden ${isDark ? 'bg-[#0f172a]' : 'bg-white'}`}
            >

                {/* Fixed Left Toolbar */}
                {
                    !minimal && (
                        <div className="shrink-0 z-[40]">
                            <ChartToolbar
                                activeTool={activeTool}
                                onToolChange={setActiveTool}
                                onClearAll={() => updateDrawingsWithHistory([])}
                                theme={theme}
                                magnetMode={magnetMode}
                                onToggleMagnet={() => setMagnetMode(m => !m)}
                                onUndo={handleUndo}
                                onRedo={handleRedo}
                                canUndo={past.length > 0}
                                canRedo={future.length > 0}
                            />
                        </div>
                    )
                }

                {/* Charts Grid */}
                <div className={`flex-1 relative ${activeLayout === 'split' ? 'grid grid-cols-2 gap-2 p-1' : ''}`}>

                    {/* Chart 1 Wrapper */}
                    <div
                        onClick={() => setActiveChart('main')}
                        className={`relative w-full h-full transition-all duration-300 ${activeLayout === 'split' && activeChart === 'main' ? 'ring-2 ring-blue-500/50 rounded-xl overflow-hidden shadow-[0_0_20px_rgba(59,130,246,0.15)] z-[45]' : (activeLayout === 'split' ? 'opacity-90' : '')}`}
                        style={{ cursor: activeTool === 'cursor' ? 'default' : 'crosshair' }}
                    >
                        {/* OHLC Legend Overlay */}
                        <div className={`absolute top-2 left-4 z-[30] flex gap-3 text-[10px] font-mono pointer-events-none select-none ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                            <span className={isDark ? 'text-white font-bold' : 'text-black font-bold'}>{trade.instrument}</span>
                            <span className="opacity-50">•</span>
                            <span className="opacity-50">{mainTimeframe}</span>
                            {crosshairValues && (
                                <>
                                    <span className="opacity-50">|</span>
                                    <span className="text-emerald-500">O<span className={isDark ? 'text-slate-200' : 'text-slate-800'}> {crosshairValues.open}</span></span>
                                    <span className="text-rose-500">H<span className={isDark ? 'text-slate-200' : 'text-slate-800'}> {crosshairValues.high}</span></span>
                                    <span className="text-rose-500">L<span className={isDark ? 'text-slate-200' : 'text-slate-800'}> {crosshairValues.low}</span></span>
                                    <span className="text-blue-500">C<span className={isDark ? 'text-slate-200' : 'text-slate-800'}> {crosshairValues.close}</span></span>
                                </>
                            )}
                            {isFetchingMore && (
                                <div className="ml-4 flex items-center gap-2 animate-pulse text-blue-500 font-bold uppercase tracking-widest">
                                    <div className="w-2 h-2 rounded-full bg-blue-500" />
                                    Loading more...
                                </div>
                            )}
                        </div>

                        <div className="absolute inset-0 z-0">
                            <div className="absolute inset-0 outline-none" ref={chartContainerRef} tabIndex={0} />

                            {/* Interactive Drawing Overlay */}
                            <InteractiveOverlay
                                drawings={drawings}
                                onUpdateDrawings={updateDrawingsWithHistory}
                                activeTool={activeTool}
                                onToolComplete={() => setActiveTool('cursor')}
                                chart={chartRef.current}
                                series={seriesRef.current}
                                theme={theme}
                                magnetMode={magnetMode}
                                allData={allData || []}
                                onContextMenu={handleContextMenu}
                                hoverPrice={hoverPrice}
                                hoverTime={hoverTime}
                                timeframe={mainTimeframe}
                                onCut={handleCut}
                                isReplayMode={isReplayMode}
                                liveDrawing={liveDrawing}
                                onLiveDrawingChange={setLiveDrawing}
                                onHoverUpdate={(p, t) => {
                                    setHoverPrice(p);
                                    setHoverTime(t);
                                }}
                            />

                            {/* Context Menu */}
                            {contextMenu && (
                                <div
                                    className={`absolute z-50 p-2 rounded-lg shadow-xl border flex flex-col gap-1 min-w-[150px] ${isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-700'}`}
                                    style={{ top: contextMenu.y, left: contextMenu.x }}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <div className="text-[10px] bg-slate-500/10 px-2 py-1 rounded">
                                        Color
                                    </div>
                                    <div className="flex gap-1 px-1">
                                        {['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ffffff', '#000000'].map(c => (
                                            <button
                                                key={c}
                                                className="w-4 h-4 rounded-full border border-slate-500/20 hover:scale-110 transition-transform"
                                                style={{ backgroundColor: c }}
                                                onClick={() => {
                                                    updateDrawingsWithHistory(drawings.map(d => d.id === contextMenu.drawingId ? { ...d, color: c } : d));
                                                    setContextMenu(null);
                                                }}
                                            />
                                        ))}
                                    </div>

                                    <div className="h-px bg-slate-500/20 my-1" />

                                    <div className="text-[10px] bg-slate-500/10 px-2 py-1 rounded">
                                        Line Width
                                    </div>
                                    <div className="flex gap-1 px-1">
                                        {[1, 2, 4].map(w => (
                                            <button
                                                key={w}
                                                className={`flex-1 h-6 flex items-center justify-center rounded hover:bg-slate-500/10 text-xs font-bold`}
                                                onClick={() => {
                                                    updateDrawingsWithHistory(drawings.map(d => d.id === contextMenu.drawingId ? { ...d, lineWidth: w } : d));
                                                    setContextMenu(null);
                                                }}
                                            >
                                                {w}px
                                            </button>
                                        ))}
                                    </div>

                                    <div className="h-px bg-slate-500/20 my-1" />

                                    <button
                                        className="text-left px-2 py-1.5 rounded text-xs text-red-500 hover:bg-red-500/10 flex items-center gap-2"
                                        onClick={() => {
                                            updateDrawingsWithHistory(drawings.filter(d => d.id !== contextMenu.drawingId));
                                            setContextMenu(null);
                                        }}
                                    >
                                        <Eraser size={12} />
                                        Delete
                                    </button>
                                </div>
                            )}


                            {/* Overlays (Loading, Error) */}
                            {!isLoading && allData.length === 0 && (
                                <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-auto rounded-xl">
                                    <div className="bg-[#1e222d] border border-white/10 p-6 rounded-2xl max-w-[280px] text-center shadow-2xl">
                                        <div className="w-12 h-12 bg-blue-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                                            <Database className="text-blue-500" size={24} />
                                        </div>
                                        <h3 className="text-sm font-black text-white uppercase tracking-tight mb-2">Chybějící Data</h3>
                                        <p className="text-slate-400 text-[10px] leading-relaxed mb-6">
                                            Tahle historie není v databázi. <br />Zkuste v <b>Nastavení {'>'} Cache</b> <br />tlačítko <b>"6 Měsíců"</b> pro vyplnění mezer.
                                        </p>
                                        <button
                                            onClick={onClose}
                                            className="w-full py-3 bg-white text-black font-black uppercase text-[9px] tracking-widest rounded-lg hover:bg-slate-200 transition-colors"
                                        >
                                            Zavřít graf
                                        </button>
                                    </div>
                                </div>
                            )}

                            {isLoading && (
                                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 backdrop-blur-sm pointer-events-none">
                                    <div className="flex flex-col items-center gap-2">
                                        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                                        <span className="text-[10px] font-black uppercase text-blue-400">Loading Data...</span>
                                    </div>
                                </div>
                            )}
                            {error && (
                                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 backdrop-blur-sm pointer-events-none">
                                    <div className="flex flex-col items-center gap-2 text-rose-500">
                                        <span className="text-xl">⚠️</span>
                                        <span className="text-[10px] font-black uppercase">{error}</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Chart 2 Container */}
                    {activeLayout === 'split' && (
                        <div
                            onClick={() => setActiveChart('secondary')}
                            className={`relative w-full h-full border-l border-slate-700/50 bg-[#0f172a] transition-all duration-300 ${activeChart === 'secondary' ? 'ring-2 ring-blue-500/50 rounded-xl overflow-hidden shadow-[0_0_20px_rgba(59,130,246,0.15)] z-[45]' : 'opacity-90'}`}
                        >
                            <div className="absolute inset-0 z-0" ref={chartContainer2Ref} />

                            {/* OHLC Legend Overlay for Chart 2 */}
                            <div className={`absolute top-2 left-4 z-[30] flex gap-3 text-[10px] font-mono pointer-events-none select-none ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                                <span className={isDark ? 'text-white font-bold' : 'text-black font-bold'}>{trade.instrument}</span>
                                <span className="opacity-50">•</span>
                                <span className="opacity-50">{secondaryTimeframe}</span>
                            </div>

                            {/* Chart 2 Drawing Overlay */}
                            <InteractiveOverlay
                                drawings={drawings}
                                onUpdateDrawings={updateDrawingsWithHistory}
                                activeTool={activeTool}
                                onToolComplete={() => setActiveTool('cursor')}
                                chart={chart2Ref.current}
                                series={series2Ref.current}
                                theme={theme}
                                magnetMode={magnetMode}
                                allData={secondaryData || []}
                                onContextMenu={handleContextMenu}
                                hoverPrice={null}
                                hoverTime={null}
                                timeframe={secondaryTimeframe}
                                isReplayMode={isReplayMode}
                                liveDrawing={liveDrawing}
                                onLiveDrawingChange={setLiveDrawing}
                                onHoverUpdate={(p, t) => {
                                    setHoverPrice(p);
                                    setHoverTime(t);
                                }}
                            />

                            {isLoading && (
                                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 pointer-events-none">
                                    <div className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin"></div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div >

            {/* Footer - Optional for embedded if too cramped */}
            < div className="h-10 md:h-14 border-t border-slate-700/30 flex items-center justify-between px-4 md:px-8 bg-black/20 text-[10px]" >
                <div className="flex gap-4 md:gap-8">
                    <div className="flex flex-col">
                        <span className="text-[8px] font-black uppercase text-slate-500">Entry</span>
                        <span className="font-black font-mono text-blue-400">${trade.entryPrice}</span>
                    </div>
                    <div className="flex flex-col">
                        <span className="text-[8px] font-black uppercase text-slate-500">Close</span>
                        <span className={`font-black font-mono ${trade.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${trade.exitPrice}</span>
                    </div>
                </div>
                <div className="flex items-center gap-2 opacity-50">
                    <div className={`w-2 h-2 rounded-full ${isLoading ? 'bg-amber-500 animate-pulse' : (Array.isArray(allData) && allData.length > 0 ? 'bg-emerald-500' : 'bg-slate-500')}`}></div>
                    <span className="font-bold uppercase tracking-wider text-[8px] md:text-[9px]">{isLoading ? 'Fetching Data...' : (Array.isArray(allData) && allData.length > 0 ? 'Dukascopy Data' : 'No Data')}</span>
                </div>
            </div >

            {/* Replay Widget */}
            {
                !minimal && (
                    <PlaybackWidget
                        isReplayMode={isReplayMode}
                        onToggleReplay={setIsReplayMode}
                        isPlaying={isReplayPlaying}
                        onPlayPause={() => setIsReplayPlaying(!isReplayPlaying)}
                        onStepBack={stepBackward}
                        onStepForward={stepForward}
                        speed={replaySpeed}
                        onSpeedChange={setReplaySpeed}
                        onActivateCutTool={() => {
                            setIsCutToolActive(true);
                            setActiveTool('scissors' as any);
                        }}
                        currentTimeframe="1m"
                        onTimeframeChange={() => { }}
                        isCutToolActive={isCutToolActive}
                    />
                )
            }
        </div >
    );

    if (embedded) {
        return (
            <div className={wrapperClasses}>
                {content}
                {minimal && (
                    <div className="absolute top-4 right-4 flex gap-2 z-[60]">
                        <button
                            onClick={handleGoToTrade}
                            className={`p-2 rounded-xl border backdrop-blur-md transition-all active:scale-95 flex items-center gap-2 group ${isDark ? 'bg-blue-600/20 border-blue-500/20 text-blue-400 hover:bg-blue-600 hover:text-white' : 'bg-blue-50 border-blue-200 text-blue-600 hover:bg-blue-600 hover:text-white'}`}
                            title="Vycentrovat na obchod"
                        >
                            <Target size={14} />
                        </button>
                        <button
                            onClick={hasSavedView ? handleClearView : handleSaveView}
                            disabled={isFixingView}
                            className={`p-2 rounded-xl border backdrop-blur-md transition-all active:scale-95 flex items-center gap-2 group ${hasSavedView
                                ? (isDark ? 'bg-amber-600/20 border-amber-500/20 text-amber-400' : 'bg-amber-50 border-amber-200 text-amber-600')
                                : (isDark ? 'bg-blue-500/10 border-blue-500/20 text-blue-400 hover:bg-blue-600 hover:text-white' : 'bg-white/80 border-slate-200 text-slate-600 hover:text-slate-900')}`}
                            title={hasSavedView ? "Zrušit fixaci pozice" : "Zafixovat aktuální pozici"}
                        >
                            {hasSavedView ? <PinOff size={14} /> : <Pin size={14} />}
                        </button>
                    </div>
                )}
                {/* Save Toast Feedback */}
                {saveToast && (
                    <div className="absolute top-20 left-1/2 -translate-x-1/2 z-[200] bg-blue-600 text-white px-8 py-4 rounded-2xl shadow-[0_20px_50px_rgba(37,99,235,0.4)] font-black uppercase text-xs tracking-widest animate-in fade-in zoom-in slide-in-from-top-10 duration-500 flex items-center gap-4 border border-white/20 backdrop-blur-md">
                        <Pin size={20} className="animate-bounce" />
                        <span className="drop-shadow-sm">Pohled zafixován</span>
                        <div className="absolute bottom-0 left-0 h-1 bg-white/30 animate-progress w-full"></div>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className={wrapperClasses}>
            {content}
            {/* Save Toast Feedback */}
            {saveToast && (
                <div className="absolute top-20 left-1/2 -translate-x-1/2 z-[200] bg-blue-600 text-white px-8 py-4 rounded-2xl shadow-[0_20px_50px_rgba(37,99,235,0.4)] font-black uppercase text-xs tracking-widest animate-in fade-in zoom-in slide-in-from-top-10 duration-500 flex items-center gap-4 border border-white/20 backdrop-blur-md">
                    <Pin size={20} className="animate-bounce" />
                    <span className="drop-shadow-sm">Pohled zafixován</span>
                    <div className="absolute bottom-0 left-0 h-1 bg-white/30 animate-progress w-full"></div>
                </div>
            )}
        </div>
    );
});

export default TradeReplay;
