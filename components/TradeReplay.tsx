
import React, { useEffect, useRef, useState } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickData, Time } from 'lightweight-charts';
import { Trade } from '../types';
import { X, Play, Pause, RotateCcw, FastForward, Settings2 } from 'lucide-react';

interface TradeReplayProps {
    trade: Trade;
    theme: 'dark' | 'light' | 'oled';
    onClose: () => void;
}

const TradeReplay: React.FC<TradeReplayProps> = ({ trade, theme, onClose }) => {
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const baselineSeriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);

    const [isPlaying, setIsPlaying] = useState(false);
    const [playbackSpeed, setPlaybackSpeed] = useState(1);
    const [progress, setProgress] = useState(0);
    const [allData, setAllData] = useState<CandlestickData[]>([]);

    const isDark = theme !== 'light';

    // Mock data generator for NQ-like price action
    const generateMockData = (trade: Trade) => {
        const data: CandlestickData[] = [];
        const startTime = new Date(trade.date).getTime() / 1000 - 3600; // 1h before trade
        let currentPrice = parseFloat(String(trade.entryPrice || 18000));

        const direction = trade.direction || 'Long';
        const entry = currentPrice;
        let tp = parseFloat(String(trade.takeProfit));
        let sl = parseFloat(String(trade.stopLoss));

        // Default R:R if missing
        if (!tp || isNaN(tp)) tp = direction === 'Long' ? entry + 50 : entry - 50;
        if (!sl || isNaN(sl)) sl = direction === 'Long' ? entry - 25 : entry + 25;

        const isWin = trade.pnl >= 0;
        const targetPrice = isWin ? tp : sl;

        // 1. Pre-trade consolidation (60 mins)
        let volatility = 2.0;
        for (let i = 0; i < 60; i++) {
            const time = (startTime + i * 60) as Time;
            const open = currentPrice;

            // Random walk with mean reversion to entry
            const change = (Math.random() - 0.5) * volatility * 2;
            const close = open + change + (entry - open) * 0.05;

            const high = Math.max(open, close) + Math.random() * volatility;
            const low = Math.min(open, close) - Math.random() * volatility;

            data.push({ time, open, high, low, close });
            currentPrice = close;
        }

        // 2. The Trade (variable length)
        // Wins often take longer (trend), losses can be sharp reversals
        const tradeSteps = isWin ? 60 + Math.floor(Math.random() * 60) : 20 + Math.floor(Math.random() * 40);
        volatility = 4.0;

        for (let i = 0; i < tradeSteps; i++) {
            const time = (startTime + (60 + i) * 60) as Time;
            const open = currentPrice;

            // Trend component towards result
            const remainingSteps = tradeSteps - i;
            const distToTarget = targetPrice - currentPrice;
            // Non-linear trend?
            const trend = distToTarget / remainingSteps;

            // Noise component
            const noise = (Math.random() - 0.5) * volatility * 3;

            let close = open + trend + noise;

            // Ensure we don't overshoot hard unless it's the end
            if (i < tradeSteps - 1) {
                // Damping if we are getting too close too early
                if (Math.abs(targetPrice - close) < 5) close = open;
            } else {
                // Ensure we hit the target at the very end
                close = targetPrice;
            }

            const high = Math.max(open, close) + Math.random() * volatility;
            const low = Math.min(open, close) - Math.random() * volatility;

            data.push({ time, open, high, low, close });
            currentPrice = close;
        }

        // 3. Post-trade (few candles to show what happened after)
        for (let i = 0; i < 15; i++) {
            const time = (startTime + (60 + tradeSteps + i) * 60) as Time;
            const open = currentPrice;
            const change = (Math.random() - 0.5) * volatility * 2;
            let close = open + change;
            // Reversal after hit?
            if (i < 3) close = open + (entry - targetPrice) * 0.1; // Pullback

            const high = Math.max(open, close) + Math.random() * volatility;
            const low = Math.min(open, close) - Math.random() * volatility;
            data.push({ time, open, high, low, close });
            currentPrice = close;
        }

        return data;
    };

    useEffect(() => {
        if (!chartContainerRef.current) return;

        const chart = createChart(chartContainerRef.current, {
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
        });

        const series = (chart as any).addCandlestickSeries({
            upColor: '#10b981',
            downColor: '#f43f5e',
            borderVisible: false,
            wickUpColor: '#10b981',
            wickDownColor: '#f43f5e',
        });

        // Add Baseline Series for PnL Zone Visualization
        const direction = trade.direction || 'Long';
        const entryPrice = parseFloat(String(trade.entryPrice || 0));

        const baselineSeries = (chart as any).addBaselineSeries({
            baseValue: { type: 'price', price: entryPrice },
            topLineColor: 'rgba(16, 185, 129, 0.4)',
            topFillColor1: 'rgba(16, 185, 129, 0.2)',
            topFillColor2: 'rgba(16, 185, 129, 0.05)',
            bottomLineColor: 'rgba(244, 63, 94, 0.4)',
            bottomFillColor1: 'rgba(244, 63, 94, 0.05)',
            bottomFillColor2: 'rgba(244, 63, 94, 0.2)',
        });

        // Reverse colors for Short
        if (direction === 'Short') {
            baselineSeries.applyOptions({
                topLineColor: 'rgba(244, 63, 94, 0.4)',
                topFillColor1: 'rgba(244, 63, 94, 0.2)',
                topFillColor2: 'rgba(244, 63, 94, 0.05)',
                bottomLineColor: 'rgba(16, 185, 129, 0.4)',
                bottomFillColor1: 'rgba(16, 185, 129, 0.05)',
                bottomFillColor2: 'rgba(16, 185, 129, 0.2)',
            });
        }

        const initialData = generateMockData(trade);
        setAllData(initialData);
        series.setData(initialData);

        const baselineData = initialData.map(d => ({ time: d.time, value: d.close }));
        baselineSeries.setData(baselineData);

        // Add Entry, SL, TP Lines
        // entryPrice is already defined above

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
        baselineSeriesRef.current = baselineSeries;

        const handleResize = () => {
            chart.applyOptions({ width: chartContainerRef.current?.clientWidth });
        };

        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            chart.remove();
        };
    }, [trade, isDark]);
    useEffect(() => {
        if (!isPlaying || !seriesRef.current || allData.length === 0) return;

        const interval = setInterval(() => {
            setProgress(prev => {
                const next = prev + 1;
                if (next >= allData.length) {
                    setIsPlaying(false);
                    return prev;
                }
                const candle = allData[next];
                seriesRef.current?.update(candle);
                baselineSeriesRef.current?.update({ time: candle.time, value: candle.close });
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
            baselineSeriesRef.current?.setData([{ time: allData[0].time, value: allData[0].close }]);
        }
    };

    return (
        <div className="fixed inset-0 z-[200] bg-black/90 backdrop-blur-2xl flex items-center justify-center p-4 animate-in fade-in duration-300">
            <div className={`w-full max-w-6xl aspect-video rounded-[32px] overflow-hidden flex flex-col border ${isDark ? 'bg-[#0f172a] border-slate-700/50' : 'bg-white border-slate-200'} shadow-2xl`}>

                {/* Header */}
                <div className="h-16 shrink-0 border-b border-slate-700/30 flex items-center justify-between px-6">
                    <div className="flex items-center gap-4">
                        <div className="p-2 rounded-xl bg-blue-500/10 text-blue-500">
                            <FastForward size={20} />
                        </div>
                        <div>
                            <h3 className="font-black tracking-tight text-white uppercase text-sm">{trade.instrument} - REPLAY</h3>
                            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{new Date(trade.date).toLocaleDateString()}</p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1 bg-slate-800/50 p-1 rounded-xl border border-white/5 mr-4">
                            <button
                                onClick={handleReset}
                                className="p-2 text-slate-400 hover:text-white transition-colors"
                                title="Reset"
                            >
                                <RotateCcw size={16} />
                            </button>
                            <div className="w-px h-4 bg-slate-700 mx-1"></div>
                            <button
                                onClick={() => setIsPlaying(!isPlaying)}
                                className={`p-2 rounded-lg transition-all ${isPlaying ? 'bg-amber-500 text-white' : 'text-slate-400 hover:text-white'}`}
                            >
                                {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                            </button>
                            <div className="w-px h-4 bg-slate-700 mx-1"></div>
                            <span className="text-[10px] font-black text-slate-500 px-2 min-w-[40px] text-center">{playbackSpeed}x</span>
                        </div>
                        <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-all text-slate-500 hover:text-white">
                            <X size={24} />
                        </button>
                    </div>
                </div>

                {/* Chart */}
                <div className="flex-1 relative overflow-hidden" ref={chartContainerRef}>
                    {/* Overlay for "Under Construction" */}
                    <div className="absolute top-4 left-4 z-10">
                        <span className="px-3 py-1 bg-blue-500/20 text-blue-400 text-[10px] font-black uppercase tracking-widest rounded-full border border-blue-500/30 backdrop-blur-md">
                            Beta Replay Engine
                        </span>
                    </div>
                </div>

                {/* Footer / Info */}
                <div className="h-14 border-t border-slate-700/30 flex items-center justify-between px-8 bg-black/20">
                    <div className="flex gap-8">
                        <div className="flex flex-col">
                            <span className="text-[8px] font-black uppercase text-slate-500">Entry</span>
                            <span className="text-xs font-black font-mono text-blue-400">${trade.entryPrice}</span>
                        </div>
                        <div className="flex flex-col">
                            <span className="text-[8px] font-black uppercase text-slate-500">Current PnL</span>
                            <span className={`text-xs font-black font-mono ${trade.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                {trade.pnl >= 0 ? '+' : ''}${trade.pnl}
                            </span>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-black text-slate-500 uppercase">Live Data Sourcing:</span>
                        <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-500 text-[9px] font-black border border-emerald-500/20">MNQ/NQ OK</span>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default TradeReplay;
