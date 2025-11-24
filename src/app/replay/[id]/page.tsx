"use client";

import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import { createChart, ColorType, CandlestickSeries } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { Play, Pause, SkipForward, SkipBack } from "lucide-react";
import { useParams, useSearchParams } from "next/navigation";

export default function ReplayPage() {
    const params = useParams();
    const searchParams = useSearchParams();

    // Trade Details from URL
    const tradeEntry = parseFloat(searchParams.get("entry") || "0");
    const tradeExit = parseFloat(searchParams.get("exit") || "0");
    const tradeSide = searchParams.get("side") || "LONG";
    const tradeTime = parseInt(searchParams.get("time") || "0"); // UNIX timestamp in seconds

    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<any>(null);
    const seriesRef = useRef<any>(null);

    const [historyData, setHistoryData] = useState<any[]>([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [loading, setLoading] = useState(true);
    const [timeframe, setTimeframe] = useState("15m");

    // Fetch Data
    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                // Fetch data for NQ=F from a recent time (e.g., last 2 days)
                // Yahoo Finance 15m data is only available for the last 60 days
                const endTime = Math.floor(Date.now() / 1000);
                // Adjust lookback based on timeframe
                let lookbackDays = 5;
                if (timeframe === "1m") lookbackDays = 1; // 1m data is limited
                if (timeframe === "1d") lookbackDays = 365; // Daily data goes further back

                const startTime = endTime - (86400 * lookbackDays);

                const res = await fetch(`/api/history?symbol=NQ=F&from=${startTime}&to=${endTime}&interval=${timeframe}`);
                const data = await res.json();

                if (data.candles && data.candles.length > 0) {
                    setHistoryData(data.candles);

                    // Try to find the trade time in the data
                    let initialIndex = Math.floor(data.candles.length / 2);
                    if (tradeTime > 0) {
                        // Find closest candle
                        const foundIndex = data.candles.findIndex((c: any) => c.time >= tradeTime);
                        if (foundIndex !== -1) {
                            initialIndex = Math.max(0, foundIndex - 5); // Start slightly before trade
                        }
                    }
                    setCurrentIndex(initialIndex);
                } else {
                    console.error("No candles found:", data);
                    setHistoryData([]);
                }
            } catch (e) {
                console.error("Failed to fetch history", e);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [timeframe]); // Re-fetch when timeframe changes

    // Initialize Chart
    useEffect(() => {
        if (!chartContainerRef.current || historyData.length === 0) return;

        // Clean up previous chart if exists (safely)
        if (chartRef.current) {
            try {
                chartRef.current.remove();
            } catch (e) {
                // Ignore disposal errors
            }
            chartRef.current = null;
        }

        const chart = createChart(chartContainerRef.current, {
            layout: { background: { type: ColorType.Solid, color: "#0f172a" }, textColor: "#94a3b8" },
            grid: { vertLines: { color: "#1e293b" }, horzLines: { color: "#1e293b" } },
            width: chartContainerRef.current.clientWidth,
            height: 500,
            timeScale: { timeVisible: true, secondsVisible: false },
            localization: {
                locale: 'cs-CZ',
                timeFormatter: (timestamp: number) => {
                    return new Date(timestamp * 1000).toLocaleString('cs-CZ', {
                        timeZone: 'Europe/Prague',
                        hour: '2-digit',
                        minute: '2-digit',
                        day: '2-digit',
                        month: '2-digit',
                    });
                }
            },
        });

        const series = chart.addSeries(CandlestickSeries, {
            upColor: "#10b981", downColor: "#ef4444", borderVisible: false, wickUpColor: "#10b981", wickDownColor: "#ef4444",
        });

        chartRef.current = chart;
        seriesRef.current = series;

        // Add Price Lines if trade details exist
        if (tradeEntry > 0) {
            series.createPriceLine({
                price: tradeEntry,
                color: tradeSide === "LONG" ? '#10b981' : '#ef4444',
                lineWidth: 2,
                lineStyle: 2, // Dashed
                axisLabelVisible: true,
                title: 'ENTRY',
            });
        }
        if (tradeExit > 0) {
            series.createPriceLine({
                price: tradeExit,
                color: tradeSide === "LONG" ? '#ef4444' : '#10b981', // TP is opposite color usually, or just Green for TP
                lineWidth: 2,
                lineStyle: 2, // Dashed
                axisLabelVisible: true,
                title: 'EXIT',
            });
        }

        // Initial Data
        const initialData = historyData.slice(0, currentIndex + 1);
        series.setData(initialData as any);

        const handleResize = () => chart.applyOptions({ width: chartContainerRef.current!.clientWidth });
        window.addEventListener("resize", handleResize);
        return () => {
            window.removeEventListener("resize", handleResize);
            if (chartRef.current) {
                try {
                    chartRef.current.remove();
                } catch (e) {
                    // Ignore
                }
                chartRef.current = null;
            }
        };
    }, [historyData]); // Re-run when data loads

    // Playback Logic
    useEffect(() => {
        let interval: any;
        if (isPlaying) {
            interval = setInterval(() => {
                setCurrentIndex((prev) => {
                    if (prev >= historyData.length - 1) {
                        setIsPlaying(false);
                        return prev;
                    }
                    return prev + 1;
                });
            }, 500); // Faster playback
        }
        return () => clearInterval(interval);
    }, [isPlaying, historyData]);

    // Update Chart on Index Change
    useEffect(() => {
        if (!seriesRef.current || historyData.length === 0) return;

        if (historyData[currentIndex]) {
            const dataSlice = historyData.slice(0, currentIndex + 1);
            seriesRef.current.setData(dataSlice as any);

            // Markers logic
            const markers = [];
            // Show Entry Marker if we passed the trade time
            const currentCandleTime = historyData[currentIndex].time;

            if (tradeTime > 0 && currentCandleTime >= tradeTime) {
                markers.push({
                    time: tradeTime, // Ideally matches exactly, or use currentCandleTime if close
                    position: tradeSide === "LONG" ? "belowBar" : "aboveBar",
                    color: tradeSide === "LONG" ? "#10b981" : "#ef4444",
                    shape: tradeSide === "LONG" ? "arrowUp" : "arrowDown",
                    text: tradeSide,
                });
            }

            // Check if setMarkers exists before calling (defensive coding)
            if (typeof seriesRef.current.setMarkers === 'function') {
                // Note: Markers need exact time match usually, so this might be tricky if tradeTime doesn't align with candle time
                // We'll try to find the exact candle time for the marker
                const exactCandle = historyData.find((c: any) => Math.abs(c.time - tradeTime) < 300); // within 5 mins
                if (exactCandle) {
                    markers[0].time = exactCandle.time;
                    seriesRef.current.setMarkers(markers as any);
                }
            }
        }
    }, [currentIndex, historyData]);

    const handleStepForward = () => setCurrentIndex((prev) => Math.min(prev + 1, historyData.length - 1));
    const handleStepBack = () => setCurrentIndex((prev) => Math.max(prev - 1, 0));

    // Focus on Trade Logic (Find candle closest to trade time)
    const handleFocusTrade = () => {
        if (historyData.length === 0 || tradeTime === 0) return;

        const foundIndex = historyData.findIndex((c: any) => c.time >= tradeTime);
        if (foundIndex !== -1) {
            // Focus slightly before the trade to give context
            setCurrentIndex(Math.max(0, foundIndex - 5));
        } else {
            // Fallback if not found (e.g. timeframe mismatch or date out of range)
            setCurrentIndex(Math.floor(historyData.length * 0.8));
        }
    };

    // Dynamic Trade Logic (Robust Loop)
    let tradeStatus = "WAITING";
    let currentPnL = 0;
    let duration = "0 min";
    let entryIndex = -1;
    let exitIndex = -1;

    if (historyData.length > 0 && tradeTime > 0) {
        // Find start index
        entryIndex = historyData.findIndex((c: any) => c.time >= tradeTime);

        if (entryIndex !== -1 && currentIndex >= entryIndex) {
            tradeStatus = "OPEN";

            // Iterate from entry to current index to check for exit
            for (let i = entryIndex; i <= currentIndex; i++) {
                const candle = historyData[i];
                const high = candle.high;
                const low = candle.low;

                // Check for Exit (TP/SL)
                if (tradeSide === "LONG") {
                    if (high >= tradeExit) {
                        tradeStatus = "CLOSED (TP)";
                        exitIndex = i;
                        break; // Stop checking once closed
                    }
                } else { // SHORT
                    if (low <= tradeExit) {
                        tradeStatus = "CLOSED (TP)";
                        exitIndex = i;
                        break;
                    }
                }
            }

            // Calculate P&L and Duration based on status
            const currentCandle = historyData[currentIndex];
            const currentPrice = currentCandle.close;

            if (tradeStatus === "OPEN") {
                const diff = tradeSide === "LONG" ? currentPrice - tradeEntry : tradeEntry - currentPrice;
                currentPnL = diff * 20; // NQ $20/point

                const diffSeconds = currentCandle.time - tradeTime;
                duration = `${Math.floor(diffSeconds / 60)} min`;
            } else {
                // CLOSED
                currentPnL = Math.abs(tradeExit - tradeEntry) * 20; // Max profit
                // Duration is fixed to exit time
                const exitCandle = historyData[exitIndex];
                const diffSeconds = exitCandle.time - tradeTime;
                duration = `${Math.floor(diffSeconds / 60)} min`;
            }
        }
    }

    // Helper for display
    const currentPriceDisplay = historyData[currentIndex] ? historyData[currentIndex].close : 0;

    if (loading) return <div className="flex h-screen items-center justify-center bg-slate-950 text-white">Načítám data z trhu...</div>;

    return (
        <div className="flex h-screen bg-slate-950 text-slate-200 font-sans">
            <Sidebar />
            <div className="flex flex-1 flex-col overflow-hidden">
                <Topbar />
                <main className="flex-1 overflow-y-auto p-6">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h1 className="text-2xl font-bold text-white">Replay Obchodu (Live Data)</h1>
                            <div className="flex items-center space-x-2 mt-1">
                                <p className="text-slate-400 text-sm">NQ=F • Yahoo Finance</p>
                                <div className="flex bg-slate-900 rounded border border-slate-800 p-1">
                                    {["1m", "2m", "5m", "15m", "1h", "1d"].map((tf) => (
                                        <button
                                            key={tf}
                                            onClick={() => setTimeframe(tf)}
                                            className={`px-2 py-0.5 text-xs rounded ${timeframe === tf ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"}`}
                                        >
                                            {tf}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                        <div className="flex space-x-2 bg-slate-900 p-2 rounded-lg border border-slate-800">
                            <button onClick={handleFocusTrade} className="p-2 hover:bg-slate-800 rounded text-blue-400 hover:text-blue-300" title="Zaostřit na obchod">
                                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="22" y1="12" x2="18" y2="12"></line><line x1="6" y1="12" x2="2" y2="12"></line><line x1="12" y1="6" x2="12" y2="2"></line><line x1="12" y1="22" x2="12" y2="18"></line></svg>
                            </button>
                            <div className="w-px bg-slate-800 mx-2"></div>
                            <button onClick={handleStepBack} className="p-2 hover:bg-slate-800 rounded text-slate-400 hover:text-white"><SkipBack className="w-5 h-5" /></button>
                            <button onClick={() => setIsPlaying(!isPlaying)} className="p-2 hover:bg-slate-800 rounded text-emerald-400 hover:text-emerald-300">
                                {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                            </button>
                            <button onClick={handleStepForward} className="p-2 hover:bg-slate-800 rounded text-slate-400 hover:text-white"><SkipForward className="w-5 h-5" /></button>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                        {/* Chart Area */}
                        <div className="lg:col-span-3 rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-sm relative">
                            <div ref={chartContainerRef} className="w-full h-[500px]" />
                            <div className="absolute top-4 left-4 bg-slate-800/80 p-2 rounded text-xs text-slate-300">
                                Svíčka: {currentIndex + 1} / {historyData.length}
                            </div>
                        </div>

                        {/* Trade Details Panel */}
                        <div className="lg:col-span-1 space-y-4">
                            <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
                                <div className="flex justify-between items-center mb-4">
                                    <h3 className="text-lg font-semibold text-white">Detaily Obchodu</h3>
                                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${tradeStatus === "OPEN" ? "bg-blue-500/20 text-blue-400 animate-pulse" : tradeStatus.includes("CLOSED") ? "bg-emerald-500/20 text-emerald-400" : "bg-slate-700 text-slate-400"}`}>
                                        {tradeStatus}
                                    </span>
                                </div>

                                <div className="space-y-3">
                                    <div className="flex justify-between">
                                        <span className="text-slate-400">Vstup</span>
                                        <span className="font-mono text-white">{tradeEntry > 0 ? tradeEntry.toFixed(2) : "---"}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-400">Cíl (TP)</span>
                                        <span className="font-mono text-white">{tradeExit > 0 ? tradeExit.toFixed(2) : "---"}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-400">Aktuální Cena</span>
                                        <span className="font-mono text-blue-300">{currentPriceDisplay.toFixed(2)}</span>
                                    </div>

                                    <div className="border-t border-slate-800 my-2"></div>

                                    <div className="flex justify-between items-center">
                                        <span className="text-slate-400">P&L (Live)</span>
                                        <span className={`text-2xl font-bold ${currentPnL > 0 ? "text-emerald-400" : currentPnL < 0 ? "text-rose-400" : "text-slate-400"}`}>
                                            {currentPnL > 0 ? "+" : ""}{currentPnL.toFixed(2)}
                                        </span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-400">Trvání</span>
                                        <span className="text-white">{duration}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
                                <h3 className="text-sm font-semibold text-slate-400 mb-2">Poznámka</h3>
                                <p className="text-sm text-slate-300 italic">"Breakout nad VWAP, silný volume. Výstup na TP1."</p>
                            </div>
                        </div>
                    </div>
                </main>
            </div>
        </div>
    );
}
