"use client";

import { Bell, Search, Plus, Menu, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Trade } from "@/db/schema";
import AddTradeModal from "./AddTradeModal";
import { useDashboard } from "./DashboardContext";

interface TopbarProps {
    onMenuClick?: () => void;
}

export default function Topbar({ onMenuClick }: TopbarProps) {
    const [balance, setBalance] = useState(0);
    const [notifications, setNotifications] = useState<Trade[]>([]);
    const [showNotifications, setShowNotifications] = useState(false);
    const [isAddTradeOpen, setIsAddTradeOpen] = useState(false);
    const [accounts, setAccounts] = useState<any[]>([]);
    const { selectedAccountId, setSelectedAccountId } = useDashboard();

    useEffect(() => {
        fetchAccounts();
    }, []);

    // Re-fetch balance when account changes or generally (simplified for now)
    useEffect(() => {
        fetchBalance();
    }, [selectedAccountId, accounts]); // Dependency on selectedAccountId and accounts

    const fetchAccounts = async () => {
        try {
            const res = await fetch('/api/accounts');
            if (res.ok) {
                const data = await res.json();
                setAccounts(data);
                // Optionally set default account here if none selected
                if (!selectedAccountId && data.length > 0) {
                    // setSelectedAccountId(data[0].id.toString()); // Or keep null for "All Accounts"
                }
            }
        } catch (e) {
            console.error("Failed to fetch accounts", e);
        }
    };

    const fetchBalance = async () => {
        try {
            // In a real app, we'd have an endpoint for balance that accepts accountId
            // For now, let's just fetch trades and sum up (inefficient but works for prototype)
            // Or better: fetch account details if an account is selected.

            if (accounts.length === 0) { // Ensure accounts are loaded before calculating balance
                setBalance(0);
                return;
            }

            const res = await fetch('/api/trades'); // We should filter by account in API
            if (res.ok) {
                const trades = await res.json();
                const filteredTrades = selectedAccountId
                    ? trades.filter((t: any) => t.accountId?.toString() === selectedAccountId)
                    : trades;

                const totalPnL = filteredTrades.reduce((acc: number, t: any) => acc + (t.pnl || 0), 0);

                // Add initial balance(s)
                let initialTotal = 0;
                if (selectedAccountId) {
                    const acc = accounts.find(a => a.id.toString() === selectedAccountId);
                    initialTotal = acc ? acc.initialBalance : 0;
                } else {
                    initialTotal = accounts.reduce((acc, a) => acc + a.initialBalance, 0);
                }

                setBalance(initialTotal + totalPnL);
            }
        } catch (error) {
            console.error("Failed to fetch balance", error);
        }
    };

    return (
        <header className="flex h-16 items-center justify-between border-b border-slate-800 bg-slate-950 px-6">
            <div className="flex items-center gap-4">
                <button onClick={onMenuClick} className="lg:hidden p-2 text-slate-400 hover:text-white">
                    <Menu className="w-6 h-6" />
                </button>

                {/* Account Selector */}
                <div className="relative group">
                    <button className="flex items-center gap-2 text-sm font-medium text-slate-300 hover:text-white px-3 py-1.5 rounded-lg hover:bg-slate-800 transition-colors">
                        {selectedAccountId
                            ? accounts.find(a => a.id.toString() === selectedAccountId)?.name
                            : "Všechny Účty"}
                        <ChevronDown className="w-4 h-4 text-slate-500" />
                    </button>
                    {/* Dropdown */}
                    <div className="absolute top-full left-0 mt-1 w-48 bg-slate-900 border border-slate-800 rounded-xl shadow-xl overflow-hidden hidden group-hover:block z-50">
                        <button
                            onClick={() => setSelectedAccountId(null)}
                            className={`w-full text-left px-4 py-2 text-sm hover:bg-slate-800 ${!selectedAccountId ? "text-emerald-400 font-medium" : "text-slate-300"}`}
                        >
                            Všechny Účty
                        </button>
                        {accounts.map(acc => (
                            <button
                                key={acc.id}
                                onClick={() => setSelectedAccountId(acc.id.toString())}
                                className={`w-full text-left px-4 py-2 text-sm hover:bg-slate-800 ${selectedAccountId === acc.id.toString() ? "text-emerald-400 font-medium" : "text-slate-300"}`}
                            >
                                {acc.name}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="relative hidden md:block">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                        type="text"
                        placeholder="Hledat..."
                        className="h-9 w-64 rounded-lg border border-slate-800 bg-slate-900 pl-9 pr-4 text-sm text-slate-200 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                    />
                </div>
            </div>

            <div className="flex items-center gap-4">
                <div className="hidden sm:block text-right">
                    <div className="text-xs text-slate-500">Celkový Zůstatek</div>
                    <div className="font-mono text-lg font-bold text-white">${balance.toFixed(2)}</div>
                </div>

                <div className="relative">
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
                        <div className="absolute right-0 top-12 w-80 bg-slate-900 border border-slate-800 rounded-lg shadow-xl overflow-hidden z-50">
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

                <button
                    onClick={() => setIsAddTradeOpen(true)}
                    className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 transition-colors shadow-lg shadow-emerald-900/20"
                >
                    <Plus className="h-4 w-4" />
                    <span className="hidden sm:inline">Přidat Obchod</span>
                </button>
            </div>

            <AddTradeModal isOpen={isAddTradeOpen} onClose={() => setIsAddTradeOpen(false)} onTradeAdded={fetchBalance} />
        </header>
    );
}
