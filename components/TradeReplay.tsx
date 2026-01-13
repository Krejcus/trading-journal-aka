import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickData, Time, CandlestickSeries, BaselineSeries } from 'lightweight-charts';
import { Trade } from '../types';
import ChartToolbar, { DrawingTool } from './ChartToolbar';
import { InteractiveOverlay } from './InteractiveOverlay';
import { DrawingObject } from '../types';
import { storageService } from '../services/storageService';
import { X, Play, Pause, RotateCcw, FastForward, Settings2, Square, ArrowRight, Maximize2, Eraser } from 'lucide-react';
import { aggregateCandles } from '../utils/candleUtils';
import { PlaybackWidget } from './PlaybackWidget';

// Cache bust 2026-01-11
interface TradeReplayProps {
    trade: Trade;
    theme: 'dark' | 'light' | 'oled';
    onClose: () => void;
    embedded?: boolean;
    minimal?: boolean;
}

const TradeReplay: React.FC<TradeReplayProps> = ({ trade, theme, onClose, embedded = false, minimal = false }) => {
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const tpSeriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
    const slSeriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
    const chartContainer2Ref = useRef<HTMLDivElement>(null);
    const chart2Ref = useRef<IChartApi | null>(null);
    const series2Ref = useRef<ISeriesApi<"Candlestick"> | null>(null);
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
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [containerReady, setContainerReady] = useState(false);
    const [chartReady, setChartReady] = useState(false);
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, drawingId: string } | null>(null);
    const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
    const [dragMode, setDragMode] = useState<'move' | 'resize-p1' | 'resize-p2' | null>(null);
    const [dragStart, setDragStart] = useState<{ time: number; price: number } | null>(null);
    const [initialDrawingState, setInitialDrawingState] = useState<DrawingObject | null>(null);
    const [crosshairValues, setCrosshairValues] = useState<{ open: string, high: string, low: string, close: string, date: string } | null>(null);
    const [activeLayout, setActiveLayout] = useState<'single' | 'split'>('single');
    const [mainTimeframe, setMainTimeframe] = useState<'1m' | '5m' | '15m' | '1h' | '4h' | 'D'>('15m');
    const [secondaryTimeframe, setSecondaryTimeframe] = useState<'5m' | '15m' | '1h'>('15m');
    const [isFetchingMore, setIsFetchingMore] = useState(false);

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
        if (!Array.isArray(filteredData) || filteredData.length === 0) return [];
        return aggregateCandles(filteredData, secondaryTimeframe);
    }, [filteredData, secondaryTimeframe]);

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

            if (Array.isArray(secondaryData) && secondaryData.length > 0) {
                try { series.setData(secondaryData); } catch (e) { }
            }

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
            }
        };
    }, [activeLayout, isDark, containerReady]);

    // Update Chart 2 Data
    useEffect(() => {
        if (chart2Ref.current && series2Ref.current && Array.isArray(secondaryData) && secondaryData.length > 0) {
            series2Ref.current.setData(secondaryData);
        }
    }, [secondaryData, activeLayout]);

    // Handle Resize for Chart 2
    useEffect(() => {
        const handleResize = () => {
            if (chartContainer2Ref.current && chart2Ref.current) {
                chart2Ref.current.applyOptions({
                    width: chartContainer2Ref.current.clientWidth,
                    height: chartContainer2Ref.current.clientHeight
                });
            }
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Force re-render overlay when chart moves
    useEffect(() => {
        if (!chartRef.current) return;
        const timeScale = chartRef.current.timeScale();

        const handleTimeRangeChange = () => {
            setChartRevision(r => r + 1);
        };

        timeScale.subscribeVisibleTimeRangeChange(handleTimeRangeChange);
        return () => timeScale.unsubscribeVisibleTimeRangeChange(handleTimeRangeChange);
    }, [chartReady]);

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

        return () => observer.disconnect();
    }, []);

    // 1. Fetch Data Effect (Independent of Chart)
    useEffect(() => {
        const fetchData = async () => {
            if (!trade.date || !trade.instrument) return;

            setIsLoading(true);
            setError(null);

            try {
                const exitTimeRaw = new Date(trade.date).getTime() / 1000;
                // Initial range: much smaller for fast load
                const daysToFetch = (mainTimeframe === '1m' || mainTimeframe === '5m') ? 1 : 3;
                const from = new Date((exitTimeRaw - daysToFetch * 24 * 3600) * 1000).toISOString();
                const to = new Date((exitTimeRaw + 1 * 24 * 3600) * 1000).toISOString();

                const response = await fetch(`/api/candles?instrument=${encodeURIComponent(trade.instrument)}&from=${from}&to=${to}`);

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
                        priceOffsetRef.current = priceOffset;
                    }

                    const validData = rawData.map((d: any) => ({
                        time: (d.time + timeOffset) as Time,
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

    const loadMorePast = useCallback(async () => {
        if (isFetchingMore || allData.length === 0 || !trade.instrument) return;

        setIsFetchingMore(true);
        try {
            const firstTime = allData[0].time as number;
            const timeOffset = -new Date().getTimezoneOffset() * 60;
            // Fetch in chunks of 7 days for 1m/5m, or 30 days for higher TF
            const daysToFetch = (mainTimeframe === '1m' || mainTimeframe === '5m') ? 7 : 30;

            const to = new Date((firstTime - timeOffset - 1) * 1000).toISOString();
            const from = new Date((firstTime - timeOffset - daysToFetch * 24 * 3600) * 1000).toISOString();

            const response = await fetch(`/api/candles?instrument=${encodeURIComponent(trade.instrument)}&from=${from}&to=${to}`);
            if (response.ok) {
                const rawData = await response.json();
                if (Array.isArray(rawData) && rawData.length > 0) {
                    const priceOffset = priceOffsetRef.current;
                    const validData = rawData.map((d: any) => ({
                        time: (d.time + timeOffset) as Time,
                        open: d.open + priceOffset,
                        high: d.high + priceOffset,
                        low: d.low + priceOffset,
                        close: d.close + priceOffset
                    }));

                    setAllData(prev => {
                        // Use a Map for O(N) deduplication by time
                        const map = new Map();
                        [...validData, ...prev].forEach(d => map.set(d.time, d));
                        return Array.from(map.values()).sort((a, b) => (a.time as number) - (b.time as number));
                    });
                }
            }
        } catch (err) {
            console.error("Failed to load more data:", err);
        } finally {
            // Artificial delay to prevent spamming
            setTimeout(() => setIsFetchingMore(false), 500);
        }
    }, [isFetchingMore, allData, trade.instrument, mainTimeframe]);

    // 2. Initialize Chart Effect
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

        const handleVisibleRangeChange = () => {
            const range = chart.timeScale().getVisibleRange();
            if (!range || isFetchingMore || allData.length === 0) return;

            const firstTime = allData[0].time as number;
            // Trigger when visible range is within 25% of the start of available data
            if ((range.from as number) < firstTime + (allData[allData.length - 1].time as number - firstTime) * 0.25) {
                loadMorePast();
            }
        };

        chart.subscribeCrosshairMove(handleCrosshairMove);
        chart.timeScale().subscribeVisibleTimeRangeChange(handleVisibleRangeChange);

        return () => {
            window.removeEventListener('resize', handleResize);
            chart.unsubscribeCrosshairMove(handleCrosshairMove);
            chart.timeScale().unsubscribeVisibleTimeRangeChange(handleVisibleRangeChange);
            chart.remove();
            chartRef.current = null;
            seriesRef.current = null;
            tpSeriesRef.current = null;
            slSeriesRef.current = null;
            setChartReady(false);
        };
    }, [trade, isDark, containerReady, loadMorePast, allData, isFetchingMore]);

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


            // chartRef.current?.timeScale().fitContent(); // Removed to prevent auto-centering
        }
    }, [chartReady, allData, filteredData]);

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
                    <div className="hidden md:flex items-center gap-1">
                        {['1m', '5m', '15m', '1h', '4h', 'D'].map((tf) => (
                            <button
                                key={tf}
                                onClick={() => {
                                    if (activeLayout === 'split') {
                                        setSecondaryTimeframe(tf as any);
                                    } else {
                                        setMainTimeframe(tf as any);
                                    }
                                }}
                                className={`
                                    px-2 py-1 rounded text-xs font-medium transition-colors
                                    ${((activeLayout === 'split' ? secondaryTimeframe : mainTimeframe) === tf)
                                        ? (isDark ? 'text-blue-400 bg-blue-500/10' : 'text-blue-600 bg-blue-50')
                                        : (isDark ? 'text-slate-500 hover:text-slate-300 hover:bg-white/5' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100')}
                                `}
                            >
                                {tf}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Center/Right: Actions */}
                <div className="flex items-center gap-2">
                    {!minimal && (
                        <>
                            {/* Jump Buttons (Compact) */}
                            <button
                                onClick={() => {
                                    if (!chartRef.current || !Array.isArray(allData) || allData.length === 0) return;
                                    const timeOffset = -new Date().getTimezoneOffset() * 60;
                                    const exitTimeRaw = new Date(trade.date).getTime() / 1000;
                                    const durationSeconds = (trade.durationMinutes || 0) * 60;
                                    const entryTimeRaw = exitTimeRaw - durationSeconds;
                                    const rangeStart = (entryTimeRaw + timeOffset - 3600) as Time;
                                    const rangeEnd = (entryTimeRaw + timeOffset + 3600) as Time;
                                    chartRef.current.timeScale().setVisibleRange({ from: rangeStart, to: rangeEnd });
                                }}
                                className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${isDark ? 'text-slate-400 hover:text-white hover:bg-white/5 border border-white/10' : 'text-slate-600 hover:text-black hover:bg-slate-50 border border-slate-200 shadow-sm'}`}
                            >
                                Trade
                            </button>

                            <div className="w-px h-5 bg-slate-700/20"></div>

                            {/* Layout Toggle */}
                            <div className={`flex items-center rounded p-0.5 border ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-slate-100 border-slate-200'}`}>
                                <button
                                    onClick={() => setActiveLayout('single')}
                                    className={`p-1 rounded ${activeLayout === 'single' ? (isDark ? 'bg-slate-600 text-white' : 'bg-white shadow text-black') : 'text-slate-400'}`}
                                    title="Single View"
                                >
                                    <Square size={14} />
                                </button>
                                <button
                                    onClick={() => setActiveLayout('split')}
                                    className={`p-1 rounded ${activeLayout === 'split' ? (isDark ? 'bg-slate-600 text-white' : 'bg-white shadow text-black') : 'text-slate-400'}`}
                                    title="Split View"
                                >
                                    <div className="flex gap-0.5">
                                        <div className="w-1.5 h-3 border border-current rounded-[1px]"></div>
                                        <div className="w-1.5 h-3 border border-current rounded-[1px]"></div>
                                    </div>
                                </button>
                            </div>

                            <div className="w-px h-5 bg-slate-700/20"></div>
                        </>
                    )}

                    {!embedded && (
                        <button onClick={onClose} className={`p-2 rounded-full transition-all ml-2 ${isDark ? 'hover:bg-white/10 text-slate-500 hover:text-white' : 'hover:bg-slate-100 text-slate-400 hover:text-black'}`}>
                            <X size={20} />
                        </button>
                    )}
                </div>
            </div>



            {/* Main Content Area: Toolbar + Charts */}
            <div
                className={`flex-1 flex flex-row overflow-hidden ${isDark ? 'bg-[#0f172a]' : 'bg-white'}`}
            >

                {/* Fixed Left Toolbar */}
                {!minimal && (
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
                )}

                {/* Charts Grid */}
                <div className={`flex-1 relative ${activeLayout === 'split' ? 'grid grid-cols-2 gap-1' : ''}`}>

                    {/* Chart 1 Wrapper */}
                    <div className="relative w-full h-full" style={{ cursor: activeTool === 'cursor' ? 'default' : 'crosshair' }}>
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
                        <div className="relative w-full h-full border-l border-slate-700/50 bg-[#0f172a]">
                            <div className="absolute top-4 right-4 z-[40] flex gap-1 bg-slate-900/80 p-1 rounded-lg border border-slate-700/50 backdrop-blur-md">
                                {(['5m', '15m', '1h'] as const).map(tf => (
                                    <button
                                        key={tf}
                                        onClick={() => setSecondaryTimeframe(tf)}
                                        className={`px-2 py-1 text-[9px] font-black uppercase rounded ${secondaryTimeframe === tf ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-white hover:bg-white/5'}`}
                                    >
                                        {tf}
                                    </button>
                                ))}
                            </div>
                            <div className="absolute inset-0 z-0" ref={chartContainer2Ref} />

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
            </div>

            {/* Footer - Optional for embedded if too cramped */}
            <div className="h-10 md:h-14 border-t border-slate-700/30 flex items-center justify-between px-4 md:px-8 bg-black/20 text-[10px]">
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
            </div>

            {/* Replay Widget */}
            {!minimal && (
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
            )}
        </div>
    );

    if (embedded) {
        return <div className={wrapperClasses}>{content}</div>;
    }

    return (
        <div className={wrapperClasses}>
            {content}
        </div>
    );
};

export default TradeReplay;
