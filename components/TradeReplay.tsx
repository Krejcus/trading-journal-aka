
import React, { useEffect, useRef, useState } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickData, Time } from 'lightweight-charts';
import { Trade } from '../types';
import { X, Play, Pause, RotateCcw, FastForward, Settings2 } from 'lucide-react';

interface TradeReplayProps {
    trade: Trade;
    theme: 'dark' | 'light' | 'oled';
    onClose: () => void;
}

const TradeReplay: React.FC<TradeReplayProps & { embedded?: boolean }> = ({ trade, theme, onClose, embedded = false }) => {
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

    const [isPlaying, setIsPlaying] = useState(false);
    const [playbackSpeed, setPlaybackSpeed] = useState(1);
    const [progress, setProgress] = useState(0);
    const [allData, setAllData] = useState<CandlestickData[]>([]);

    const isDark = theme !== 'light';

    // Mock data generator for NQ-like price action
    const generateMockData = (trade: Trade) => {
        const data: CandlestickData[] = [];
        const startTime = new Date(trade.date).getTime() / 1000 - 3600; // 1h before trade
        let currentPrice = parseFloat(String(trade.entryPrice || 15000));
        const isWin = trade.pnl >= 0;
        const targetPrice = isWin ? parseFloat(String(trade.takeProfit || currentPrice + 100)) : parseFloat(String(trade.stopLoss || currentPrice - 100));

        // 1. Pre-trade consolidation (60 mins)
        for (let i = 0; i < 60; i++) {
            const time = (startTime + i * 60) as Time;
            const open = currentPrice;
            const range = 5;
            const high = open + Math.random() * range;
            const low = open - Math.random() * range;
            const close = open + (Math.random() - 0.5) * range;
            data.push({ time, open, high, low, close });
            currentPrice = close;
        }

        // 2. The Trade (variable length)
        const tradeSteps = 120;
        for (let i = 0; i < tradeSteps; i++) {
            const time = (startTime + (60 + i) * 60) as Time;
            const open = currentPrice;
            // Bias towards target
            const bias = (targetPrice - currentPrice) / (tradeSteps - i);
            const noise = 15;
            const close = open + bias + (Math.random() * noise) - (noise / 2); // Simple random walk with bias
            const high = Math.max(open, close) + Math.random() * 5;
            const low = Math.min(open, close) - Math.random() * 5;
            data.push({ time, open, high, low, close });
            currentPrice = close;
        }

        return data;
    };

    useEffect(() => {
        if (!chartContainerRef.current) return;

        const container = chartContainerRef.current;
        const width = container.clientWidth;
        const height = container.clientHeight;

        // CRITICAL: Prevent crash if dimensions are invalid (common in modern modals on mount)
        if (width <= 0 || height <= 0) {
            console.warn('TradeReplay: Invalid container dimensions', { width, height });
            // Retry once after a short delay if this happens on initial mount
            const timer = setTimeout(() => {
                if (container.clientWidth > 0 && container.clientHeight > 0) {
                    // This will trigger a re-run if we add dimensions to the dependency array or force update
                    // But for now let's just use window resize or manual trigger
                    window.dispatchEvent(new Event('resize'));
                }
            }, 100);
            return () => clearTimeout(timer);
        }

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

        const series = (chart as any).addCandlestickSeries({
            upColor: '#10b981',
            downColor: '#f43f5e',
            borderVisible: false,
            wickUpColor: '#10b981',
            wickDownColor: '#f43f5e',
        });

        const initialData = generateMockData(trade);
        setAllData(initialData);
        series.setData(initialData);

        // Add Entry, SL, TP Lines
        const entryPrice = parseFloat(String(trade.entryPrice || 0));
        const slPrice = parseFloat(String(trade.stopLoss || 0));
        const tpPrice = parseFloat(String(trade.takeProfit || 0));

        if (entryPrice) {
            series.createPriceLine({
                price: entryPrice,
                color: '#3b82f6',
                lineWidth: 2,
                lineStyle: 0,
                axisLabelVisible: true,
                title: 'ENTRY',
            });
        }

        if (slPrice) {
            series.createPriceLine({
                price: slPrice,
                color: '#f43f5e',
                lineWidth: 1,
                lineStyle: 1,
                axisLabelVisible: true,
                title: 'SL',
            });
        }

        if (tpPrice) {
            series.createPriceLine({
                price: tpPrice,
                color: '#10b981',
                lineWidth: 1,
                lineStyle: 1,
                axisLabelVisible: true,
                title: 'TP',
            });
        }

        chartRef.current = chart;
        seriesRef.current = series;

        const handleResize = () => {
            if (chartContainerRef.current && chartRef.current) {
                chartRef.current.applyOptions({
                    width: chartContainerRef.current.clientWidth,
                    height: chartContainerRef.current.clientHeight
                });
            }
        };

        window.addEventListener('resize', handleResize);

        // Use a ResizeObserver for more reliable layout tracking in dynamic containers
        const observer = new ResizeObserver(handleResize);
        observer.observe(container);

        return () => {
            window.removeEventListener('resize', handleResize);
            observer.disconnect();
            chart.remove();
        };
    }, [trade, isDark]);

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

            {/* Chart */}
            <div className="flex-1 relative overflow-hidden" ref={chartContainerRef}>
                {/* Overlay for "Under Construction" */}
                {/* <div className="absolute top-4 left-4 z-10">
                    <span className="px-3 py-1 bg-blue-500/20 text-blue-400 text-[10px] font-black uppercase tracking-widest rounded-full border border-blue-500/30 backdrop-blur-md">
                        Beta Replay
                    </span>
                </div> */}
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
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                    <span className="font-bold uppercase tracking-wider text-[8px] md:text-[9px]">Simulated Data</span>
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
