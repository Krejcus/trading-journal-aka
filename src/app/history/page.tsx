"use client";

import DashboardLayout from "@/components/DashboardLayout";
import { Play, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Trade } from "@/db/schema";

export default function HistoryPage() {
    const [trades, setTrades] = useState<Trade[]>([]);
    const [loading, setLoading] = useState(true);

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

    useEffect(() => {
        fetchTrades();
    }, []);

    const formatDate = (timestamp: number) => {
        return new Date(timestamp * 1000).toLocaleDateString('cs-CZ');
    };

    const formatTime = (timestamp: number) => {
        return new Date(timestamp * 1000).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
    };

    const deleteTrade = async (id: number) => {
        if (!confirm("Opravdu chcete smazat tento obchod?")) return;

        try {
            const res = await fetch(`/api/trades/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setTrades(trades.filter(t => t.id !== id));
            }
        } catch (error) {
            console.error("Failed to delete trade", error);
        }
    };

    return (
        <DashboardLayout>
            <div className="p-6">
                <h1 className="text-2xl font-bold text-white mb-6">Historie Obchodů</h1>

                <div className="rounded-lg border border-slate-800 bg-slate-900 overflow-hidden">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-slate-950 text-slate-400 uppercase">
                            <tr>
                                <th className="px-6 py-3">Datum</th>
                                <th className="px-6 py-3">Čas</th>
                                <th className="px-6 py-3">Symbol</th>
                                <th className="px-6 py-3">Směr</th>
                                <th className="px-6 py-3">Vstup</th>
                                <th className="px-6 py-3">Výstup</th>
                                <th className="px-6 py-3">P&L</th>
                                <th className="px-6 py-3">Stav</th>
                                <th className="px-6 py-3 text-right">Akce</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                            {loading ? (
                                <tr>
                                    <td colSpan={9} className="px-6 py-8 text-center text-slate-500">Načítám historii...</td>
                                </tr>
                            ) : trades.length === 0 ? (
                                <tr>
                                    <td colSpan={9} className="px-6 py-8 text-center text-slate-500">Zatím žádné obchody v historii.</td>
                                </tr>
                            ) : (
                                trades.map((trade) => (
                                    <tr key={trade.id} className="hover:bg-slate-800/50 transition-colors">
                                        <td className="px-6 py-4 font-medium text-white">{formatDate(trade.entryTime)}</td>
                                        <td className="px-6 py-4 text-slate-400">{formatTime(trade.entryTime)}</td>
                                        <td className="px-6 py-4 font-bold text-blue-400">{trade.symbol}</td>
                                        <td className={`px-6 py-4 font-bold ${trade.side === "LONG" ? "text-emerald-400" : "text-rose-400"}`}>
                                            {trade.side}
                                        </td>
                                        <td className="px-6 py-4 font-mono text-slate-300">{trade.entryPrice.toFixed(2)}</td>
                                        <td className="px-6 py-4 font-mono text-slate-300">{trade.exitPrice ? trade.exitPrice.toFixed(2) : "-"}</td>
                                        <td className={`px-6 py-4 text-right font-bold ${trade.pnl && trade.pnl > 0 ? "text-emerald-400" : trade.pnl && trade.pnl < 0 ? "text-rose-400" : "text-slate-400"}`}>
                                            {trade.pnl ? `${trade.pnl > 0 ? "+" : ""}${trade.pnl.toFixed(2)}` : "-"}
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className={`px-2 py-1 rounded text-xs font-bold ${trade.status === "WIN" ? "bg-emerald-500/20 text-emerald-400" : trade.status === "LOSS" ? "bg-rose-500/20 text-rose-400" : "bg-blue-500/20 text-blue-400"}`}>
                                                {trade.status}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-right flex justify-end gap-2">
                                            <Link
                                                href={`/replay/${trade.id}?entry=${trade.entryPrice}&exit=${trade.exitPrice || 0}&side=${trade.side}&time=${trade.entryTime}`}
                                                className="inline-flex items-center justify-center p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                                                title="Přehrát obchod"
                                            >
                                                <Play className="w-4 h-4" />
                                            </Link>
                                            <button
                                                onClick={() => deleteTrade(trade.id)}
                                                className="inline-flex items-center justify-center p-2 rounded hover:bg-rose-900/30 text-slate-400 hover:text-rose-400 transition-colors"
                                                title="Smazat obchod"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </DashboardLayout>
    );
}
