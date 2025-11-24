"use client";

import { TrendingUp, TrendingDown, XCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

export default function ActivePosition() {
    const [position, setPosition] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    const fetchSignal = async () => {
        try {
            const res = await fetch('/api/trades');
            const data = await res.json();

            if (Array.isArray(data)) {
                // Find the latest OPEN trade
                const openTrade = data.find((t: any) => t.status === 'OPEN');

                if (openTrade) {
                    setPosition({
                        symbol: openTrade.symbol,
                        side: openTrade.side,
                        size: openTrade.size || 1,
                        entryPrice: openTrade.entryPrice,
                        currentPrice: openTrade.entryPrice, // Mock current price for now
                        pnl: openTrade.pnl || 0,
                        roi: 0
                    });
                } else {
                    setPosition(null);
                }
            }
        } catch (e) {
            console.error("Failed to fetch active position", e);
            setPosition(null);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchSignal();
        const interval = setInterval(fetchSignal, 5000); // Poll every 5 seconds
        return () => clearInterval(interval);
    }, []);

    if (loading) return <div className="p-6 text-slate-400">Načítám...</div>;
    if (!position) return (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Aktivní Pozice</h2>
            <div className="text-center text-slate-500 py-8">
                <p>Žádná aktivní pozice</p>
                <p className="text-xs mt-2">Čekám na signál...</p>
            </div>
        </div>
    );

    const isProfit = position.pnl >= 0;

    return (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-white">Aktivní Pozice</h2>
                <span className={`px-2 py-1 rounded text-xs font-bold ${position.side === "LONG" ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}>
                    {position.side}
                </span>
            </div>

            <div className="space-y-4">
                <div className="flex justify-between items-center">
                    <span className="text-slate-400">Symbol</span>
                    <span className="text-white font-medium">{position.symbol}</span>
                </div>
                <div className="flex justify-between items-center">
                    <span className="text-slate-400">Velikost</span>
                    <span className="text-white font-medium">{position.size} Kontraktů</span>
                </div>
                <div className="flex justify-between items-center">
                    <span className="text-slate-400">Vstupní Cena</span>
                    <span className="text-white font-medium">{position.entryPrice.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center">
                    <span className="text-slate-400">Aktuální Cena</span>
                    <span className="text-white font-medium">{position.currentPrice.toFixed(2)}</span>
                </div>

                <div className="border-t border-slate-800 pt-4 mt-4">
                    <div className="flex justify-between items-end">
                        <span className="text-slate-400 mb-1">Nerealizované P&L</span>
                        <div className="text-right">
                            <div className={`text-2xl font-bold ${isProfit ? "text-emerald-400" : "text-red-400"}`}>
                                {isProfit ? "+" : ""}${position.pnl.toFixed(2)}
                            </div>
                            <div className={`text-sm ${isProfit ? "text-emerald-500" : "text-red-500"}`}>
                                {isProfit ? "+" : ""}{position.roi}%
                            </div>
                        </div>
                    </div>
                </div>

                <button className="w-full mt-6 flex items-center justify-center space-x-2 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-slate-900">
                    <XCircle className="h-4 w-4" />
                    <span>Uzavřít Pozici</span>
                </button>
            </div>
        </div>
    );
}
