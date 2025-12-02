"use client";

import DashboardLayout from "@/components/DashboardLayout";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell, PieChart, Pie, Legend } from "recharts";
import { useEffect, useState } from "react";
import { Trade } from "@/db/schema";

export default function AnalyticsPage() {
    const [trades, setTrades] = useState<Trade[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchTrades = async () => {
            try {
                const res = await fetch('/api/trades');
                const data = await res.json();
                if (Array.isArray(data)) {
                    // Sort by time ascending for equity curve
                    setTrades(data.sort((a, b) => a.entryTime - b.entryTime));
                }
            } catch (error) {
                console.error("Failed to fetch trades", error);
            } finally {
                setLoading(false);
            }
        };

        fetchTrades();
    }, []);

    // --- Data Processing ---

    // 1. Equity Curve
    let cumulativePnL = 0;
    const equityData = trades.map(t => {
        cumulativePnL += t.pnl || 0;
        return {
            name: new Date(t.entryTime * 1000).toLocaleDateString(),
            value: cumulativePnL
        };
    });

    // 2. Win Rate
    const wins = trades.filter(t => t.status === "WIN").length;
    const losses = trades.filter(t => t.status === "LOSS").length;
    const winRateData = [
        { name: "Wins", value: wins },
        { name: "Losses", value: losses },
    ];

    // 3. PnL by Day of Week
    const days = ["Neděle", "Pondělí", "Úterý", "Středa", "Čtvrtek", "Pátek", "Sobota"];
    const pnlByDayMap = new Array(7).fill(0);
    trades.forEach(t => {
        const day = new Date(t.entryTime * 1000).getDay();
        pnlByDayMap[day] += t.pnl || 0;
    });
    const pnlByDayData = days.map((day, index) => ({
        name: day,
        value: pnlByDayMap[index]
    })).filter((_, i) => i !== 0 && i !== 6); // Filter out weekends if desired, or keep them

    // 4. PnL by Hour
    const pnlByHourMap = new Array(24).fill(0);
    trades.forEach(t => {
        const hour = new Date(t.entryTime * 1000).getHours();
        pnlByHourMap[hour] += t.pnl || 0;
    });
    const pnlByHourData = pnlByHourMap.map((val, index) => ({
        name: `${index}:00`,
        value: val
    }));

    // Stats
    const totalTrades = trades.length;
    const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
    const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const avgWin = wins > 0 ? trades.filter(t => t.status === "WIN").reduce((sum, t) => sum + (t.pnl || 0), 0) / wins : 0;
    const avgLoss = losses > 0 ? Math.abs(trades.filter(t => t.status === "LOSS").reduce((sum, t) => sum + (t.pnl || 0), 0) / losses) : 0;
    const profitFactor = avgLoss > 0 ? (avgWin * wins) / (avgLoss * losses) : 0;


    return (
        <DashboardLayout>
            <div className="p-6">
                <h1 className="text-2xl font-bold text-white mb-6">Analytický Dashboard</h1>

                {/* Key Metrics */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
                    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
                        <p className="text-sm text-slate-400">Celkový P&L</p>
                        <p className={`text-2xl font-bold ${totalPnL >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                            {totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)}
                        </p>
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
                        <p className="text-sm text-slate-400">Win Rate</p>
                        <p className="text-2xl font-bold text-blue-400">{winRate}%</p>
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
                        <p className="text-sm text-slate-400">Profit Factor</p>
                        <p className="text-2xl font-bold text-white">{profitFactor.toFixed(2)}</p>
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
                        <p className="text-sm text-slate-400">Počet Obchodů</p>
                        <p className="text-2xl font-bold text-white">{totalTrades}</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                    {/* Equity Curve */}
                    <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
                        <h3 className="text-lg font-semibold text-white mb-4">Vývoj Účtu (Equity)</h3>
                        <div className="h-[300px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={equityData}>
                                    <defs>
                                        <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                                            <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                                    <XAxis dataKey="name" stroke="#64748b" />
                                    <YAxis stroke="#64748b" />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#fff' }}
                                    />
                                    <Area type="monotone" dataKey="value" stroke="#10b981" fillOpacity={1} fill="url(#colorValue)" />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Win/Loss Ratio */}
                    <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
                        <h3 className="text-lg font-semibold text-white mb-4">Poměr Výher/Ztrát</h3>
                        <div className="h-[300px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <PieChart>
                                    <Pie
                                        data={winRateData}
                                        cx="50%"
                                        cy="50%"
                                        innerRadius={60}
                                        outerRadius={80}
                                        paddingAngle={5}
                                        dataKey="value"
                                    >
                                        {winRateData.map((entry, index) => (
                                            <Cell key={`cell-${index}`} fill={entry.name === "Wins" ? "#10b981" : "#ef4444"} />
                                        ))}
                                    </Pie>
                                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#fff' }} />
                                    <Legend />
                                </PieChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* PnL by Day */}
                    <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
                        <h3 className="text-lg font-semibold text-white mb-4">P&L podle Dne v Týdnu</h3>
                        <div className="h-[300px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={pnlByDayData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                                    <XAxis dataKey="name" stroke="#64748b" />
                                    <YAxis stroke="#64748b" />
                                    <Tooltip
                                        cursor={{ fill: '#1e293b' }}
                                        contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#fff' }}
                                    />
                                    <Bar dataKey="value">
                                        {pnlByDayData.map((entry, index) => (
                                            <Cell key={`cell-${index}`} fill={entry.value >= 0 ? "#10b981" : "#ef4444"} />
                                        ))}
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* PnL by Hour */}
                    <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
                        <h3 className="text-lg font-semibold text-white mb-4">P&L podle Hodiny</h3>
                        <div className="h-[300px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={pnlByHourData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                                    <XAxis dataKey="name" stroke="#64748b" />
                                    <YAxis stroke="#64748b" />
                                    <Tooltip
                                        cursor={{ fill: '#1e293b' }}
                                        contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#fff' }}
                                    />
                                    <Bar dataKey="value">
                                        {pnlByHourData.map((entry, index) => (
                                            <Cell key={`cell-${index}`} fill={entry.value >= 0 ? "#10b981" : "#ef4444"} />
                                        ))}
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </div>
            </div>
        </DashboardLayout>
    );
}
