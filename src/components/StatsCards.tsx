"use client";

import { ArrowUpRight, ArrowDownRight, Wallet, TrendingUp, Activity, Clock } from "lucide-react";
import { useEffect, useState } from "react";
import { Trade } from "@/db/schema";

export function BalanceWidget() {
    const [balance, setBalance] = useState(100000); // Initial balance
    const [monthlyRoi, setMonthlyRoi] = useState(0);

    useEffect(() => {
        const fetchStats = async () => {
            try {
                const res = await fetch('/api/trades');
                const trades: Trade[] = await res.json();
                if (Array.isArray(trades)) {
                    const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
                    setBalance(100000 + totalPnL);

                    // Simple ROI for now
                    setMonthlyRoi((totalPnL / 100000) * 100);
                }
            } catch (e) {
                console.error(e);
            }
        };
        fetchStats();
    }, []);

    return (
        <div className="h-full flex flex-col justify-between p-6">
            <div className="absolute top-0 right-0 p-4 opacity-10">
                <Wallet className="w-16 h-16 text-blue-500" />
            </div>
            <div>
                <div className="flex justify-between items-start mb-2">
                    <p className="text-slate-400 text-sm font-medium">Celkový Zůstatek</p>
                </div>
                <h3 className="text-3xl font-bold text-white">${balance.toLocaleString()}</h3>
            </div>
            <div className={`flex items-center mt-2 text-sm font-medium ${monthlyRoi >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {monthlyRoi >= 0 ? <ArrowUpRight className="w-4 h-4 mr-1" /> : <ArrowDownRight className="w-4 h-4 mr-1" />}
                <span>{monthlyRoi >= 0 ? "+" : ""}{monthlyRoi.toFixed(2)}% celkem</span>
            </div>
        </div>
    );
}

export function PnlWidget() {
    const [dailyPnL, setDailyPnL] = useState(0);
    const [lastTradeTime, setLastTradeTime] = useState<string | null>(null);

    useEffect(() => {
        const fetchStats = async () => {
            try {
                const res = await fetch('/api/trades');
                const trades: Trade[] = await res.json();
                if (Array.isArray(trades)) {
                    const today = new Date().toISOString().split('T')[0];
                    const todaysTrades = trades.filter(t => new Date(t.entryTime * 1000).toISOString().split('T')[0] === today);

                    const pnl = todaysTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
                    setDailyPnL(pnl);

                    if (trades.length > 0) {
                        const lastTrade = trades.sort((a, b) => b.entryTime - a.entryTime)[0];
                        setLastTradeTime(new Date(lastTrade.entryTime * 1000).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }));
                    }
                }
            } catch (e) {
                console.error(e);
            }
        };
        fetchStats();
    }, []);

    return (
        <div className="h-full flex flex-col justify-between p-6">
            <div className="absolute top-0 right-0 p-4 opacity-10">
                <TrendingUp className="w-16 h-16 text-emerald-500" />
            </div>
            <div>
                <div className="flex justify-between items-start mb-2">
                    <p className="text-slate-400 text-sm font-medium">Denní P&L</p>
                </div>
                <h3 className={`text-3xl font-bold ${dailyPnL >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {dailyPnL >= 0 ? "+" : ""}${dailyPnL.toLocaleString()}
                </h3>
            </div>
            <div className="flex items-center mt-2 text-slate-400 text-sm">
                <Clock className="w-4 h-4 mr-1" />
                <span>Poslední obchod: {lastTradeTime || "--:--"}</span>
            </div>
        </div>
    );
}

export function WinRateWidget() {
    const [winRate, setWinRate] = useState(0);

    useEffect(() => {
        const fetchStats = async () => {
            try {
                const res = await fetch('/api/trades');
                const trades: Trade[] = await res.json();
                if (Array.isArray(trades) && trades.length > 0) {
                    const wins = trades.filter(t => t.status === "WIN").length;
                    setWinRate(Math.round((wins / trades.length) * 100));
                }
            } catch (e) {
                console.error(e);
            }
        };
        fetchStats();
    }, []);

    return (
        <div className="h-full flex flex-col justify-between p-6">
            <div className="absolute top-0 right-0 p-4 opacity-10">
                <Activity className="w-16 h-16 text-purple-500" />
            </div>
            <div>
                <div className="flex justify-between items-start mb-2">
                    <p className="text-slate-400 text-sm font-medium">Win Rate (Celkový)</p>
                </div>
                <h3 className="text-3xl font-bold text-white">{winRate}%</h3>
            </div>
            <div className="mt-2 w-full bg-slate-800 rounded-full h-1.5">
                <div className={`h-1.5 rounded-full ${winRate >= 50 ? "bg-emerald-500" : "bg-rose-500"}`} style={{ width: `${winRate}%` }}></div>
            </div>
        </div>
    );
}
