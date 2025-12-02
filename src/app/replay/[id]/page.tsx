"use client";

import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import { createChart, ColorType, CandlestickSeries } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { Play, Pause, SkipBack, SkipForward, Target } from "lucide-react";
import Link from "next/link";
import DashboardLayout from "@/components/DashboardLayout";
import { useParams, useSearchParams } from "next/navigation";

export default function ReplayPage() {
    const params = useParams();
    // const searchParams = useSearchParams(); // No longer needed for details

    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<any>(null);
    const seriesRef = useRef<any>(null);

    const [trade, setTrade] = useState<any>(null);
    const [historyData, setHistoryData] = useState<any[]>([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [loading, setLoading] = useState(true);
    const [timeframe, setTimeframe] = useState("15m");
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);

    // Fetch Trade Details
    useEffect(() => {
        const fetchTrade = async () => {
            try {
                const res = await fetch(`/api/trades/${params.id}`);
                if (res.ok) {
                    const data = await res.json();
                    setTrade(data);
                } else {
                    console.error("Trade not found");
                }
            } catch (e) {
                console.error("Failed to fetch trade", e);
            }
        };
        if (params.id) fetchTrade();
    }, [params.id]);

    // Fetch History Data (Dependent on Trade)
    useEffect(() => {
        const fetchData = async () => {
            if (!trade) return; // Wait for trade data

            setLoading(true);
            try {
                // Fetch data for NQ=F from a recent time (e.g., last 2 days)
                // Yahoo Finance 15m data is only available for the last 60 days
                const endTime = Math.floor(Date.now() / 1000);
                // Adjust lookback based on timeframe
                let lookbackDays = 5;
                if (timeframe === "1m") lookbackDays = 1; // 1m data is limited
                if (timeframe === "1d") lookbackDays = 365; // Daily data goes further back

                // Ensure we cover the trade time
                const tradeTime = trade.entryTime;
                const startTime = tradeTime - (86400 * lookbackDays); // Start before trade

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
    }, [timeframe, trade]); // Re-fetch when timeframe or trade changes

    // Derived Trade Details
    const tradeEntry = trade?.entryPrice || 0;
    const tradeExit = trade?.exitPrice || 0;
    const tradeSide = trade?.side || "LONG";
    const tradeTime = trade?.entryTime || 0;
    const tradeSL = trade?.slPrice || 0;
    const tradeTP = trade?.tpPrice || 0;

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
                color: '#3b82f6', // Blue for Exit
                lineWidth: 2,
                lineStyle: 2, // Dashed
                axisLabelVisible: true,
                title: 'EXIT',
            });
        }
        if (tradeSL > 0) {
            series.createPriceLine({
                price: tradeSL,
                color: '#ef4444', // Red for SL
                lineWidth: 1,
                lineStyle: 0, // Solid
                axisLabelVisible: true,
                title: 'SL',
            });
        }
        if (tradeTP > 0) {
            series.createPriceLine({
                price: tradeTP,
                color: '#10b981', // Green for TP
                lineWidth: 1,
                lineStyle: 0, // Solid
                axisLabelVisible: true,
                title: 'TP',
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
    }, [historyData, tradeEntry, tradeExit, tradeSL, tradeTP, tradeSide]); // Re-run when data or trade details load

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
                    if (tradeExit > 0 && high >= tradeExit) {
                        tradeStatus = "CLOSED (TP)";
                        exitIndex = i;
                        break; // Stop checking once closed
                    }
                } else { // SHORT
                    if (tradeExit > 0 && low <= tradeExit) {
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

    if (loading) return <div className="flex h-screen items-center justify-center bg-slate-950 text-white">Načítám data z trhu...</div>;

    return (
        <DashboardLayout>
            <div className="p-6">
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                            {trade?.symbol} <span className={`text-sm px-2 py-0.5 rounded ${tradeSide === "LONG" ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"}`}>{tradeSide}</span>
                        </h1>
                        <p className="text-slate-400 text-sm">
                            {new Date(tradeTime * 1000).toLocaleString()}
                        </p>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="flex bg-slate-800 rounded-lg p-1">
                            {["1m", "5m", "15m", "1h", "4h", "1d"].map((tf) => (
                                <button
                                    key={tf}
                                    onClick={() => setTimeframe(tf)}
                                    className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${timeframe === tf ? "bg-slate-700 text-white shadow" : "text-slate-400 hover:text-white"}`}
                                >
                                    {tf}
                                </button>
                            ))}
                        </div>
                        <Link href="/" className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg transition-colors">
                            Zpět na přehled
                        </Link>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                    {/* Chart Section */}
                    <div className="lg:col-span-3 space-y-4">
                        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg relative group">
                            {/* Chart Container */}
                            <div ref={chartContainerRef} className="w-full h-[500px]" />

                            {/* Playback Controls Overlay */}
                            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-slate-800/90 backdrop-blur px-4 py-2 rounded-full border border-slate-700 shadow-xl opacity-0 group-hover:opacity-100 transition-opacity">
                                <button onClick={handleStepBack} className="p-2 hover:bg-slate-700 rounded-full text-slate-300 hover:text-white"><SkipBack className="w-5 h-5" /></button>
                                <button onClick={() => setIsPlaying(!isPlaying)} className="p-2 hover:bg-emerald-600 bg-emerald-500 rounded-full text-white shadow-lg transition-colors">
                                    {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
                                </button>
                                <button onClick={handleStepForward} className="p-2 hover:bg-slate-700 rounded-full text-slate-300 hover:text-white"><SkipForward className="w-5 h-5" /></button>
                                <div className="w-px h-6 bg-slate-700 mx-2" />
                                <button onClick={handleFocusTrade} className="p-2 hover:bg-slate-700 rounded-full text-slate-300 hover:text-white" title="Centrovat na obchod"><Target className="w-5 h-5" /></button>
                            </div>
                        </div>
                    </div>

                    {/* Trade Details Sidebar */}
                    <div className="space-y-6">
                        {/* PnL Card */}
                        <div className={`bg-slate-900 border border-slate-800 rounded-xl p-6 ${tradeStatus.includes("CLOSED") ? (currentPnL > 0 ? "border-emerald-500/50 bg-emerald-500/5" : "border-rose-500/50 bg-rose-500/5") : ""}`}>
                            <div className="text-sm text-slate-400 mb-1">Aktuální P&L</div>
                            <div className={`text-4xl font-bold font-mono ${currentPnL >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                                {currentPnL >= 0 ? "+" : ""}{currentPnL.toFixed(2)} USD
                            </div>
                            <div className="mt-4 flex items-center justify-between text-sm">
                                <span className="text-slate-400">Stav:</span>
                                <span className={`font-bold px-2 py-0.5 rounded ${tradeStatus === "OPEN" ? "bg-blue-500/20 text-blue-400" : tradeStatus.includes("WIN") || currentPnL > 0 ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"}`}>
                                    {tradeStatus}
                                </span>
                            </div>
                        </div>

                        {/* Stats Grid */}
                        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
                            <h3 className="font-semibold text-white border-b border-slate-800 pb-2">Detaily Obchodu</h3>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <div className="text-xs text-slate-500">Vstup</div>
                                    <div className="font-mono text-slate-200">{tradeEntry}</div>
                                </div>
                                <div>
                                    <div className="text-xs text-slate-500">Výstup</div>
                                    <div className="font-mono text-slate-200">{tradeExit || "-"}</div>
                                </div>
                                <div>
                                    <div className="text-xs text-slate-500">Stop Loss</div>
                                    <div className="font-mono text-rose-400">{tradeSL || "-"}</div>
                                </div>
                                <div>
                                    <div className="text-xs text-slate-500">Take Profit</div>
                                    <div className="font-mono text-emerald-400">{tradeTP || "-"}</div>
                                </div>
                                <div>
                                    <div className="text-xs text-slate-500">Trvání</div>
                                    <div className="font-mono text-slate-200">{duration}</div>
                                </div>
                                <div>
                                    <div className="text-xs text-slate-500">Velikost</div>
                                    <div className="font-mono text-slate-200">{trade?.size} Lot</div>
                                </div>
                            </div>
                        </div>

                        {/* Notes */}
                        {trade?.notes && (
                            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
                                <h3 className="font-semibold text-white mb-2">Poznámky</h3>
                                <p className="text-slate-400 text-sm leading-relaxed">
                                    {trade.notes}
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </DashboardLayout>
    );
}
