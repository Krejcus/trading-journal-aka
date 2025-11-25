"use client";

import { useEffect, useState } from "react";
import { Trade } from "@/db/schema";

export default function QuickStats() {
    const [stats, setStats] = useState({
        avgRR: 0,
        profitFactor: 0,
        maxDrawdown: 0
    });

    useEffect(() => {
        const fetchStats = async () => {
            try {
                const res = await fetch('/api/trades');
                const trades: Trade[] = await res.json();

                if (Array.isArray(trades) && trades.length > 0) {
                    // Avg R:R (Approximated as Avg Win / Avg Loss)
                    const wins = trades.filter(t => t.pnl && t.pnl > 0).map(t => t.pnl!);
                    const losses = trades.filter(t => t.pnl && t.pnl < 0).map(t => Math.abs(t.pnl!));

                    const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
                    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 1; // Avoid div by 0

                    const avgRR = avgLoss > 0 ? avgWin / avgLoss : avgWin;

                    // Profit Factor
                    const grossProfit = wins.reduce((a, b) => a + b, 0);
                    const grossLoss = losses.reduce((a, b) => a + b, 0);
                    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

                    // Max Drawdown
                    let balance = 100000;
                    let peak = 100000;
                    let maxDD = 0;

                    // Sort trades by time
                    const sortedTrades = [...trades].sort((a, b) => a.entryTime - b.entryTime);

                    for (const trade of sortedTrades) {
                        if (trade.pnl) {
                            balance += trade.pnl;
                            if (balance > peak) peak = balance;

                            const dd = (peak - balance) / peak * 100;
                            if (dd > maxDD) maxDD = dd;
                        }
                    }

                    setStats({
                        avgRR,
                        profitFactor,
                        maxDrawdown: maxDD
                    });
                }
            } catch (e) {
                console.error(e);
            }
        };
        fetchStats();
    }, []);

    return (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 h-full flex flex-col">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Rychlý Přehled</h3>
                <div className="drag-handle cursor-move p-1 hover:bg-slate-800 rounded text-slate-500">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="9" r="1" /><circle cx="9" cy="15" r="1" /><circle cx="15" cy="9" r="1" /><circle cx="15" cy="15" r="1" /></svg>
                </div>
            </div>
            <div className="space-y-4 flex-1">
                <div className="flex justify-between items-center">
                    <span className="text-slate-300">Avg R:R (Win/Loss)</span>
                    <span className="text-white font-mono">1:{stats.avgRR.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center">
                    <span className="text-slate-300">Profit Factor</span>
                    <span className={`font-mono ${stats.profitFactor >= 1.5 ? "text-emerald-400" : stats.profitFactor >= 1 ? "text-blue-400" : "text-rose-400"}`}>
                        {stats.profitFactor.toFixed(2)}
                    </span>
                </div>
                <div className="flex justify-between items-center">
                    <span className="text-slate-300">Max Drawdown</span>
                    <span className="text-rose-400 font-mono">-{stats.maxDrawdown.toFixed(2)}%</span>
                </div>
            </div>
        </div>
    );
}
