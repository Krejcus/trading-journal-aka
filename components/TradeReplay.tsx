import React, { useEffect, useRef, useState, useMemo } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickData, Time, CandlestickSeries, BaselineSeries } from 'lightweight-charts';
import { Trade } from '../types';
import ChartToolbar, { DrawingTool } from './ChartToolbar';
import { storageService } from '../services/storageService';
import { X, Play, Pause, RotateCcw, FastForward, Settings2 } from 'lucide-react';
import { aggregateCandles } from '../utils/candleUtils';

interface TradeReplayProps {
    trade: Trade;
    theme: 'dark' | 'light' | 'oled';
    onClose: () => void;
}

const TradeReplay: React.FC<TradeReplayProps & { embedded?: boolean }> = ({ trade, theme, onClose, embedded = false }) => {
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const tpSeriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
    const slSeriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);

    const [activeTool, setActiveTool] = useState<DrawingTool>('cursor');

    // Drawing State
    interface DrawingObject {
        id: string;
        type: 'line' | 'rect' | 'text';
        p1: { time: number | Time; price: number };
        p2?: { time: number | Time; price: number }; // Optional for text
        text?: string;
    }


    const [drawings, setDrawings] = useState<DrawingObject[]>(trade.drawings || []);
    const [currentDrawing, setCurrentDrawing] = useState<Partial<DrawingObject> | null>(null);
    const [chartRevision, setChartRevision] = useState(0);
    const [isSaving, setIsSaving] = useState(false);

    // Auto-save drawings
    useEffect(() => {
        // Skip first render if matches initial prop
        if (JSON.stringify(drawings) === JSON.stringify(trade.drawings)) return;

        const timer = setTimeout(async () => {
            setIsSaving(true);
            try {
                await storageService.updateTradeDrawings(trade.id, drawings);
                // console.log("Drawings saved");
            } catch (err) {
                console.error("Failed to save drawings", err);
            } finally {
                setIsSaving(false);
            }
        }, 1000); // 1s debounce

        return () => clearTimeout(timer);
    }, [drawings, trade.id]);

    // Force re-render overlay when chart moves
    // ... existing effect for chartRevision


    // Force re-render overlay when chart moves


    const [magnetMode, setMagnetMode] = useState(false);

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
        if (magnetMode && allData.length > 0) {
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

    const handleMouseDown = (e: React.MouseEvent) => {
        if (activeTool === 'cursor' || activeTool === 'eraser') return;

        const coords = getChartCoordinates(e);
        if (!coords) return;

        if (activeTool === 'text') {
            const text = prompt("Zadejte text poznámky:");
            if (text) {
                setDrawings(prev => [...prev, {
                    id: crypto.randomUUID(),
                    type: 'text',
                    p1: coords,
                    text
                }]);
                setActiveTool('cursor'); // Reset to cursor after text
            }
            return;
        }

        // Start Line/Rect
        setCurrentDrawing({
            id: crypto.randomUUID(),
            type: activeTool,
            p1: coords,
            p2: coords
        });
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!currentDrawing) return;

        const coords = getChartCoordinates(e);
        if (!coords) return;

        setCurrentDrawing(prev => prev ? ({ ...prev, p2: coords }) : null);
    };

    const handleMouseUp = () => {
        if (!currentDrawing) return;

        if (currentDrawing.p1 && currentDrawing.p2) {
            // Validate minimal size?
            setDrawings(prev => [...prev, currentDrawing as DrawingObject]);
        }
        setCurrentDrawing(null);
        // Optional: Reset to cursor? Or keep tool active for multiple lines?
        // Let's keep tool active for multiple lines/rects.
    };

    // Shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            if (e.key === 'Escape') setActiveTool('cursor');
            if (e.key.toLowerCase() === 't') setActiveTool(e.shiftKey ? 'text' : 'line');
            if (e.key.toLowerCase() === 'r') setActiveTool('rect');
            if (e.key === 'Delete' || e.key === 'Backspace') {
                // Remove last drawing for now
                setDrawings(prev => prev.slice(0, -1));
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    const [isPlaying, setIsPlaying] = useState(false);
    const [playbackSpeed, setPlaybackSpeed] = useState(1);
    const [progress, setProgress] = useState(0);
    const [allData, setAllData] = useState<CandlestickData[]>([]);

    const isDark = theme !== 'light';

    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [containerReady, setContainerReady] = useState(false);
    const [chartReady, setChartReady] = useState(false);

    // Multi-Chart State
    const [activeLayout, setActiveLayout] = useState<'single' | 'split'>('single');
    const [secondaryTimeframe, setSecondaryTimeframe] = useState<'5m' | '15m' | '1h'>('15m');

    const chartContainer2Ref = useRef<HTMLDivElement>(null);
    const chart2Ref = useRef<IChartApi | null>(null);
    const series2Ref = useRef<ISeriesApi<"Candlestick"> | null>(null);

    // Derived Data
    const secondaryData = useMemo(() => {
        if (allData.length === 0) return [];
        return aggregateCandles(allData, secondaryTimeframe);
    }, [allData, secondaryTimeframe]);

    // Init Chart 2
    useEffect(() => {
        if (activeLayout === 'single' || !chartContainer2Ref.current) {
            if (chart2Ref.current) {
                chart2Ref.current.remove();
                chart2Ref.current = null;
                series2Ref.current = null;
            }
            return;
        }

        if (chart2Ref.current) return; // Already init

        const container = chartContainer2Ref.current;
        const width = container.clientWidth;
        const height = container.clientHeight;

        const chart = createChart(container, {
            layout: { background: { color: 'transparent' }, textColor: isDark ? '#94a3b8' : '#475569' },
            grid: {
                vertLines: { color: isDark ? 'rgba(30, 41, 59, 0.5)' : 'rgba(226, 232, 240, 0.5)' },
                horzLines: { color: isDark ? 'rgba(30, 41, 59, 0.5)' : 'rgba(226, 232, 240, 0.5)' },
            },
            timeScale: {
                borderColor: isDark ? 'rgba(30, 41, 59, 0.5)' : 'rgba(226, 232, 240, 0.5)',
                timeVisible: true,
                secondsVisible: false,
            },
            width,
            height
        });

        const series = chart.addSeries(CandlestickSeries, {
            upColor: '#10b981', downColor: '#f43f5e', borderVisible: false, wickUpColor: '#10b981', wickDownColor: '#f43f5e'
        });

        chart2Ref.current = chart;
        series2Ref.current = series;

        // Sync Logic
        if (chartRef.current) {
            const mainTimeScale = chartRef.current.timeScale();
            const subTimeScale = chart.timeScale();

            const syncHandler = () => {
                const timeRange = mainTimeScale.getVisibleRange();
                if (timeRange) {
                    subTimeScale.setVisibleRange(timeRange);
                }
            };
            mainTimeScale.subscribeVisibleTimeRangeChange(syncHandler);
        }
    }, [activeLayout, isDark, containerReady]);

    // Update Chart 2 Data
    useEffect(() => {
        if (chart2Ref.current && series2Ref.current && secondaryData.length > 0) {
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
            setAllData([]); // Reset data

            try {
                // Determine instrument for API
                // Fetch data around EXIT time (trade.date)
                // We might need to fetch a wider range if trade is long?
                // Currently fetching data for the day of exit.
                const response = await fetch(`/api/candles?instrument=${encodeURIComponent(trade.instrument)}&date=${encodeURIComponent(trade.date)}`);

                if (!response.ok) {
                    const errData = await response.json();
                    throw new Error(errData.details || 'Failed to fetch candle data');
                }

                const rawData = await response.json();

                if (Array.isArray(rawData) && rawData.length > 0) {
                    // 1. Calculate Offset for Futures vs Spot correction
                    let priceOffset = 0;

                    // CRITICAL FIX: trade.date is EXIT time.
                    // Calculate Entry Time: Exit Time - Duration
                    const exitTimeRaw = new Date(trade.date).getTime() / 1000;
                    const durationSeconds = (trade.durationMinutes || 0) * 60;
                    const entryTime = exitTimeRaw - durationSeconds;

                    const entryPrice = parseFloat(String(trade.entryPrice || 0));

                    // Timezone correction: Shift chart time to match user's local wall clock
                    // getTimezoneOffset returns minutes (e.g. -60 for GMT+1). We want seconds to ADD.
                    // So we invert sign and multiply by 60.
                    const timeOffset = -new Date().getTimezoneOffset() * 60;

                    // Robust Candle Search & Timezone Auto-Detection:
                    // We need to decide if `entryTime` is UTC or Local-as-UTC.
                    // We check which assumption aligns better with the fetched (UTC) candles.

                    let bestCandle = null;
                    let minDiff = Infinity;
                    let detectedIsLocal = false; // Flag to determine format

                    // Case A: Assume Stored Time is UTC
                    // We look for candle matching `entryTime` directly.
                    let minDiffUtc = Infinity;
                    let bestCandleUtc = null;

                    rawData.forEach((d: any) => {
                        const diff = Math.abs(d.time - entryTime);
                        if (diff < minDiffUtc) {
                            minDiffUtc = diff;
                            bestCandleUtc = d;
                        }
                    });

                    // Case B: Assume Stored Time is Local-as-UTC
                    // To match a UTC candle, we must UNSHIFT the entryTime (subtract offset)
                    // Or compare `entryTime` (Local) vs `d.time + offset` (Local).
                    // Let's compare in UTC space: `entryTime - timeOffset` vs `d.time`.
                    const entryTimeAsLocalDesc = entryTime; // It technically "looks" like local time
                    const entryTimeTrueUtc = entryTimeAsLocalDesc - timeOffset;

                    let minDiffLocal = Infinity;
                    let bestCandleLocal = null;

                    rawData.forEach((d: any) => {
                        const diff = Math.abs(d.time - entryTimeTrueUtc);
                        if (diff < minDiffLocal) {
                            minDiffLocal = diff;
                            bestCandleLocal = d;
                        }
                    });

                    // Decision: Which error is smaller?
                    // We assume valid trades will be reasonably close.
                    if (minDiffLocal < minDiffUtc) {
                        // It's Local-as-UTC
                        bestCandle = bestCandleLocal;
                        minDiff = minDiffLocal;
                        detectedIsLocal = true;
                        // console.log("Detected Local-as-UTC storage");
                    } else {
                        // It's UTC
                        bestCandle = bestCandleUtc;
                        minDiff = minDiffUtc;
                        detectedIsLocal = false;
                        // console.log("Detected UTC storage");
                    }

                    // Accept matches within 4 hours
                    if (bestCandle && minDiff < 4 * 3600 && entryPrice) {
                        priceOffset = entryPrice - (bestCandle as any).close;
                        console.log(`Auto-calibration: Found candle (Diff: ${minDiff}s). Offset: ${priceOffset}. Format: ${detectedIsLocal ? 'Local' : 'UTC'}`);
                    }

                    const validData = rawData.map((d: any) => ({
                        time: (d.time + timeOffset) as Time, // Shift to visual local time
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
    }, [trade]); // Only depends on trade

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
                background: { color: 'transparent' },
                textColor: isDark ? '#94a3b8' : '#475569',
            },
            grid: {
                vertLines: { color: isDark ? 'rgba(30, 41, 59, 0.5)' : 'rgba(226, 232, 240, 0.5)' },
                horzLines: { color: isDark ? 'rgba(30, 41, 59, 0.5)' : 'rgba(226, 232, 240, 0.5)' },
            },
            crosshair: {
                mode: 0,
            },
            timeScale: {
                borderColor: isDark ? 'rgba(30, 41, 59, 0.5)' : 'rgba(226, 232, 240, 0.5)',
                timeVisible: true,
                secondsVisible: false,
            },
            width: width,
            height: height,
        });

        const series = chart.addSeries(CandlestickSeries, {
            upColor: '#10b981',
            downColor: '#f43f5e',
            borderVisible: false,
            wickUpColor: '#10b981',
            wickDownColor: '#f43f5e',
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

        return () => {
            window.removeEventListener('resize', handleResize);
            chart.remove();
            chartRef.current = null;
            seriesRef.current = null;
            tpSeriesRef.current = null;
            slSeriesRef.current = null;
            setChartReady(false);
        };
    }, [trade, isDark, containerReady]);

    // 3. Sync Data Effect
    useEffect(() => {
        if (chartReady && seriesRef.current && allData.length > 0) {
            seriesRef.current.setData(allData);

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
            if (allData.length > 0) {
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

            chartRef.current?.timeScale().fitContent();
        }
    }, [chartReady, allData]);

    // Handle replay logic
    useEffect(() => {
        if (!isPlaying || !seriesRef.current || allData.length === 0) return;

        const interval = setInterval(() => {
            setProgress(prev => {
                const next = prev + 1;
                if (next >= allData.length) {
                    setIsPlaying(false);
                    return prev;
                }
                seriesRef.current?.update(allData[next]);
                return next;
            });
        }, 1000 / playbackSpeed);

        return () => clearInterval(interval);
    }, [isPlaying, playbackSpeed, allData]);

    const handleReset = () => {
        setIsPlaying(false);
        setProgress(0);
        if (seriesRef.current && allData.length > 0) {
            seriesRef.current.setData([allData[0]]);
        }
    };

    // Render logic
    const containerClasses = embedded
        ? `w-full h-full flex flex-col ${isDark ? 'bg-[#0f172a]' : 'bg-white'}`
        : `w-full max-w-6xl aspect-video rounded-[32px] overflow-hidden flex flex-col border ${isDark ? 'bg-[#0f172a] border-slate-700/50' : 'bg-white border-slate-200'} shadow-2xl`;

    const wrapperClasses = embedded
        ? "w-full h-full"
        : "fixed inset-0 z-[200] bg-black/90 backdrop-blur-2xl flex items-center justify-center p-4 animate-in fade-in duration-300";

    const content = (
        <div className={containerClasses}>
            {/* Header */}
            <div className="h-12 md:h-16 shrink-0 border-b border-slate-700/30 flex items-center justify-between px-4 md:px-6">
                <div className="flex items-center gap-2 md:gap-4">
                    <div className="p-1.5 md:p-2 rounded-xl bg-blue-500/10 text-blue-500">
                        <FastForward size={16} className="md:w-5 md:h-5" />
                    </div>
                    <div>
                        <h3 className="font-black tracking-tight text-white uppercase text-xs md:text-sm">{trade.instrument} - REPLAY</h3>
                        <p className="text-[8px] md:text-[10px] text-slate-500 font-bold uppercase tracking-widest">{new Date(trade.date).toLocaleDateString()}</p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 bg-slate-800/50 p-1 rounded-xl border border-white/5">
                        {/* Layout Toggle - NEW */}
                        <div className="flex items-center bg-slate-900/50 rounded-lg p-0.5 border border-white/5 mr-2">
                            <button
                                onClick={() => setActiveLayout('single')}
                                className={`px-2 py-1 text-[9px] font-black uppercase rounded transition-all ${activeLayout === 'single' ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'text-slate-500 hover:text-white'}`}
                            >
                                SINGLE
                            </button>
                            <button
                                onClick={() => setActiveLayout('split')}
                                className={`px-2 py-1 text-[9px] font-black uppercase rounded transition-all ${activeLayout === 'split' ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'text-slate-500 hover:text-white'}`}
                            >
                                SPLIT
                            </button>
                        </div>

                        <button
                            onClick={handleReset}
                            className="p-1.5 md:p-2 text-slate-400 hover:text-white transition-colors"
                            title="Reset"
                        >
                            <RotateCcw size={14} className="md:w-4 md:h-4" />
                        </button>
                        <div className="w-px h-3 md:h-4 bg-slate-700 mx-0.5 md:mx-1"></div>
                        <button
                            onClick={() => setIsPlaying(!isPlaying)}
                            className={`p-1.5 md:p-2 rounded-lg transition-all ${isPlaying ? 'bg-amber-500 text-white' : 'text-slate-400 hover:text-white'}`}
                        >
                            {isPlaying ? <Pause size={16} className="md:w-[18px] md:h-[18px]" /> : <Play size={16} className="md:w-[18px] md:h-[18px]" />}
                        </button>
                        <div className="w-px h-3 md:h-4 bg-slate-700 mx-0.5 md:mx-1"></div>
                        <button
                            onClick={() => setPlaybackSpeed(s => s === 1 ? 5 : (s === 5 ? 10 : 1))}
                            className="text-[9px] md:text-[10px] font-black text-slate-500 px-1 md:px-2 min-w-[30px] md:min-w-[40px] text-center hover:text-white cursor-pointer"
                        >
                            {playbackSpeed}x
                        </button>
                    </div>
                    {!embedded && (
                        <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-all text-slate-500 hover:text-white ml-2">
                            <X size={24} />
                        </button>
                    )}
                </div>
            </div>

            {/* Quick Navigation Toolbar */}
            <div className={`h-8 border-b ${isDark ? 'border-slate-700/30' : 'border-slate-200'} flex items-center justify-center gap-2 bg-black/10`}>
                <button
                    onClick={() => {
                        if (!chartRef.current || allData.length === 0) return;
                        // Recalculate times (logic duplicated - should refactor, but kept inline for safety)
                        const timeOffset = -new Date().getTimezoneOffset() * 60;
                        // Approximate check if stored as Local or UTC (simplified: if trade.entry matches candle => Local)
                        // Ideally we'd store the 'detectedIsLocal' in a ref to reuse here. 
                        // For "Jump To" features, getting close is usually enough.
                        // Let's assume we use the SHIFTED entry time we calculated for the box.

                        const exitTimeRaw = new Date(trade.date).getTime() / 1000;
                        const durationSeconds = (trade.durationMinutes || 0) * 60;
                        const entryTimeRaw = exitTimeRaw - durationSeconds;

                        // Best guess without robust check again: Apply offset
                        // If it lands on empty space, scrollToTime handles it gracefully usually.
                        const targetTime = (entryTimeRaw + timeOffset) as Time;

                        // Use scrollToTime or setVisibleRange
                        // Create a range of e.g. 2 hours around entry
                        const rangeStart = (entryTimeRaw + timeOffset - 3600) as Time;
                        const rangeEnd = (entryTimeRaw + timeOffset + 3600) as Time;

                        chartRef.current.timeScale().setVisibleRange({ from: rangeStart, to: rangeEnd });
                    }}
                    className="px-3 py-1 bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 text-[9px] font-black uppercase rounded-lg transition-colors"
                >
                    Jump to Entry
                </button>
                <div className="w-px h-3 bg-slate-700/50"></div>
                <button
                    onClick={() => {
                        if (!chartRef.current || allData.length === 0) return;
                        const timeOffset = -new Date().getTimezoneOffset() * 60;

                        const exitTimeRaw = new Date(trade.date).getTime() / 1000;
                        const targetTime = (exitTimeRaw + timeOffset) as Time;

                        const rangeStart = (exitTimeRaw + timeOffset - 3600) as Time;
                        const rangeEnd = (exitTimeRaw + timeOffset + 3600) as Time;

                        chartRef.current.timeScale().setVisibleRange({ from: rangeStart, to: rangeEnd });
                    }}
                    className="px-3 py-1 bg-purple-500/10 hover:bg-purple-500/20 text-purple-500 text-[9px] font-black uppercase rounded-lg transition-colors"
                >
                    Jump to Exit
                </button>
                <div className="w-px h-3 bg-slate-700/50"></div>
                <button
                    onClick={() => {
                        if (!chartRef.current) return;
                        chartRef.current.timeScale().fitContent();
                    }}
                    className="px-3 py-1 bg-slate-500/10 hover:bg-slate-500/20 text-slate-500 hover:text-slate-300 text-[9px] font-black uppercase rounded-lg transition-colors"
                >
                    Fit Trade
                </button>
            </div>

            {/* Main Content Area: Toolbar + Chart */}
            <div className="flex-1 relative overflow-hidden bg-[#0f172a]">

                {/* Floating Toolbar */}
                <div className="absolute top-4 left-4 z-[40]">
                    <ChartToolbar
                        activeTool={activeTool}
                        onToolChange={setActiveTool}
                        onClearAll={() => setDrawings([])}
                        theme={theme}
                        magnetMode={magnetMode}
                        onToggleMagnet={() => setMagnetMode(m => !m)}
                    />
                </div>

                {/* Chart Container Wrapper */}
                <div className="absolute inset-0 z-0" style={{ cursor: activeTool === 'cursor' ? 'default' : 'crosshair' }}>
                    <div className="absolute inset-0" ref={chartContainerRef} />

                    {/* SVG Drawing Overlay */}
                    <svg
                        className="absolute inset-0 z-10 w-full h-full pointer-events-none"
                        style={{ pointerEvents: activeTool !== 'cursor' ? 'auto' : 'none' }}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                    >
                        {/* Render Saved Drawings */}
                        {drawings.map(d => {
                            if (!chartRef.current || !seriesRef.current) return null;
                            const timeScale = chartRef.current.timeScale();
                            const series = seriesRef.current;

                            const x1 = timeScale.timeToCoordinate(d.p1.time as Time);
                            const y1 = series.priceToCoordinate(d.p1.price);

                            // If p2 exists (line/rect)
                            if (d.p2) {
                                const x2 = timeScale.timeToCoordinate(d.p2.time as Time);
                                const y2 = series.priceToCoordinate(d.p2.price);

                                if (x1 === null || y1 === null || x2 === null || y2 === null) return null;

                                if (d.type === 'line') {
                                    return <line key={d.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke={isDark ? '#3b82f6' : '#2563eb'} strokeWidth="2" />;
                                } else if (d.type === 'rect') {
                                    const width = x2 - x1;
                                    const height = y2 - y1;
                                    return (
                                        <rect
                                            key={d.id}
                                            x={Math.min(x1, x2)}
                                            y={Math.min(y1, y2)}
                                            width={Math.abs(width)}
                                            height={Math.abs(height)}
                                            fill={isDark ? 'rgba(59, 130, 246, 0.1)' : 'rgba(37, 99, 235, 0.1)'}
                                            stroke={isDark ? '#3b82f6' : '#2563eb'}
                                            strokeWidth="2"
                                        />
                                    );
                                }
                            } else if (d.type === 'text') {
                                if (x1 === null || y1 === null) return null;
                                return (
                                    <text key={d.id} x={x1} y={y1} fill={isDark ? '#fff' : '#000'} fontSize="12" fontWeight="bold">
                                        {d.text || 'Text'}
                                    </text>
                                );
                            }
                            return null;
                        })}

                        {/* Render Current (In-Progress) Drawing */}
                        {currentDrawing && (() => {
                            if (!chartRef.current || !seriesRef.current) return null;
                            const timeScale = chartRef.current.timeScale();
                            const series = seriesRef.current;

                            const start = currentDrawing.p1;
                            const end = currentDrawing.p2 || start; // If p2 not set yet (click), use start

                            const x1 = timeScale.timeToCoordinate(start.time as Time);
                            const y1 = series.priceToCoordinate(start.price);
                            const x2 = timeScale.timeToCoordinate(end.time as Time);
                            const y2 = series.priceToCoordinate(end.price);

                            if (x1 === null || y1 === null || x2 === null || y2 === null) return null;

                            if (currentDrawing.type === 'line') {
                                return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={isDark ? '#3b82f6' : '#2563eb'} strokeWidth="2" strokeDasharray="5,5" />;
                            } else if (currentDrawing.type === 'rect') {
                                return (
                                    <rect
                                        x={Math.min(x1, x2)}
                                        y={Math.min(y1, y2)}
                                        width={Math.abs(x2 - x1)}
                                        height={Math.abs(y2 - y1)}
                                        fill={isDark ? 'rgba(59, 130, 246, 0.1)' : 'rgba(37, 99, 235, 0.1)'}
                                        stroke={isDark ? '#3b82f6' : '#2563eb'}
                                        strokeWidth="2"
                                        strokeDasharray="5,5"
                                    />
                                );
                            }
                            return null;
                        })()}
                    </svg>

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
                    <div className={`w-2 h-2 rounded-full ${isLoading ? 'bg-amber-500 animate-pulse' : (allData.length > 0 ? 'bg-emerald-500' : 'bg-slate-500')}`}></div>
                    <span className="font-bold uppercase tracking-wider text-[8px] md:text-[9px]">{isLoading ? 'Fetching Data...' : (allData.length > 0 ? 'Dukascopy Data' : 'No Data')}</span>
                </div>
            </div>
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
