"use client";

import { Bell, Search, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Trade } from "@/db/schema";
import AddTradeModal from "./AddTradeModal";

export default function Topbar() {
    const [balance, setBalance] = useState(100000);
    const [notifications, setNotifications] = useState<Trade[]>([]);
    const [showNotifications, setShowNotifications] = useState(false);
    const [isAddTradeOpen, setIsAddTradeOpen] = useState(false);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const res = await fetch('/api/trades');
                const trades: Trade[] = await res.json();
                if (Array.isArray(trades)) {
                    // Calculate Balance
                    const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
                    setBalance(100000 + totalPnL);

                    // Notifications (Last 5 closed trades)
                    const closedTrades = trades
                        .filter(t => t.status === "WIN" || t.status === "LOSS")
                        .sort((a, b) => b.exitTime! - a.exitTime!)
                        .slice(0, 5);
                    setNotifications(closedTrades);
                }
            } catch (e) {
                console.error(e);
            }
        };
        fetchData();
    }, []);

    return (
        <div className="flex h-16 items-center justify-between border-b border-slate-800 bg-slate-900 px-6 relative z-20">
            <div className="flex items-center">
                <div className="relative">
                    <span className="absolute inset-y-0 left-0 flex items-center pl-3">
                        <Search className="h-4 w-4 text-slate-500" />
                    </span>
                    <input
                        type="text"
                        placeholder="Hledat symbol..."
                        className="rounded-md border border-slate-700 bg-slate-800 py-1.5 pl-10 pr-4 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                </div>
            </div>
            <div className="flex items-center space-x-6">
                <div className="flex flex-col items-end">
                    <span className="text-xs text-slate-400">Stav účtu</span>
                    <span className={`text-lg font-bold ${balance >= 100000 ? "text-emerald-400" : "text-rose-400"}`}>
                        ${balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </span>
                </div>
                <div className="relative">
                    <button
                        onClick={() => setIsAddTradeOpen(true)}
                        className="rounded-full bg-emerald-600 p-2 text-white hover:bg-emerald-500 transition-colors mr-2"
                        title="Přidat Obchod"
                    >
                        <Plus className="h-5 w-5" />
                    </button>

                    <button
                        onClick={() => setShowNotifications(!showNotifications)}
                        className="rounded-full bg-slate-800 p-2 text-slate-400 hover:text-white relative"
                    >
                        <Bell className="h-5 w-5" />
                        {notifications.length > 0 && (
                            <span className="absolute top-0 right-0 h-2 w-2 rounded-full bg-emerald-500"></span>
                        )}
                    </button>

                    {showNotifications && (
                        <div className="absolute right-0 top-12 w-80 bg-slate-900 border border-slate-800 rounded-lg shadow-xl overflow-hidden">
                            <div className="p-3 border-b border-slate-800 font-semibold text-sm text-slate-300">
                                Poslední aktivita
                            </div>
                            <div className="max-h-64 overflow-y-auto">
                                {notifications.length === 0 ? (
                                    <div className="p-4 text-center text-slate-500 text-sm">Žádná nová oznámení</div>
                                ) : (
                                    notifications.map((trade) => (
                                        <div key={trade.id} className="p-3 border-b border-slate-800/50 hover:bg-slate-800 transition-colors flex justify-between items-center">
                                            <div>
                                                <div className="font-bold text-white text-sm">{trade.symbol} <span className={`text-xs ${trade.side === "LONG" ? "text-emerald-400" : "text-rose-400"}`}>{trade.side}</span></div>
                                                <div className="text-xs text-slate-400">{new Date(trade.exitTime! * 1000).toLocaleTimeString()}</div>
                                            </div>
                                            <div className={`font-mono text-sm font-bold ${trade.pnl! > 0 ? "text-emerald-400" : "text-rose-400"}`}>
                                                {trade.pnl! > 0 ? "+" : ""}{trade.pnl?.toFixed(2)}
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
            <AddTradeModal
                isOpen={isAddTradeOpen}
                onClose={() => setIsAddTradeOpen(false)}
                onTradeAdded={() => window.location.reload()}
            />
        </div>
    );
}
