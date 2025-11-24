"use client";

import { useEffect, useState } from "react";
import { Trade } from "@/db/schema";

export default function RecentTrades() {
    const [trades, setTrades] = useState<Trade[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchTrades = async () => {
            try {
                const res = await fetch('/api/trades');
                const data = await res.json();
                if (Array.isArray(data)) {
                    setTrades(data);
                }
            } catch (error) {
                console.error("Failed to fetch trades", error);
            } finally {
                setLoading(false);
            }
        };

        fetchTrades();
        const interval = setInterval(fetchTrades, 5000); // Poll every 5s
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden h-full flex flex-col">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center shrink-0">
                <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold text-white">Poslední Obchody</h3>
                    <div className="drag-handle cursor-move p-1 hover:bg-slate-800 rounded text-slate-500">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="9" r="1" /><circle cx="9" cy="15" r="1" /><circle cx="15" cy="9" r="1" /><circle cx="15" cy="15" r="1" /></svg>
                    </div>
                </div>
                <button className="text-sm text-blue-400 hover:text-blue-300 font-medium">Zobrazit Vše</button>
            </div>
            <div className="p-0 flex-1 overflow-auto">
                <table className="w-full text-left text-sm">
                    <thead className="bg-slate-950/50 text-slate-400 uppercase text-xs sticky top-0">
                        <tr>
                            <th className="px-6 py-3 font-medium">Symbol</th>
                            <th className="px-6 py-3 font-medium">Směr</th>
                            <th className="px-6 py-3 font-medium">Vstup</th>
                            <th className="px-6 py-3 font-medium">Výstup</th>
                            <th className="px-6 py-3 font-medium text-right">P&L</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                        {loading ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-8 text-center text-slate-500">Načítám obchody...</td>
                            </tr>
                        ) : trades.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-8 text-center text-slate-500">Zatím žádné obchody.</td>
                            </tr>
                        ) : (
                            trades.map((trade) => (
                                <tr key={trade.id} className="hover:bg-slate-800/50 transition-colors">
                                    <td className="px-6 py-4 font-bold text-white">{trade.symbol}</td>
                                    <td className={`px-6 py-4 font-bold ${trade.side === "LONG" ? "text-emerald-400" : "text-rose-400"}`}>
                                        {trade.side}
                                    </td>
                                    <td className="px-6 py-4 text-slate-300">{trade.entryPrice.toFixed(2)}</td>
                                    <td className="px-6 py-4 text-slate-300">{trade.exitPrice ? trade.exitPrice.toFixed(2) : "-"}</td>
                                    <td className={`px-6 py-4 text-right font-bold ${trade.pnl && trade.pnl > 0 ? "text-emerald-400" : trade.pnl && trade.pnl < 0 ? "text-rose-400" : "text-slate-400"}`}>
                                        {trade.pnl ? `${trade.pnl > 0 ? "+" : ""}$${trade.pnl.toFixed(2)}` : "OPEN"}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
