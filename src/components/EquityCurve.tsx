"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { useEffect, useState } from 'react';
import { Trade } from '@/db/schema';

export default function EquityCurve() {
    const [data, setData] = useState<any[]>([]);

    useEffect(() => {
        const fetchTrades = async () => {
            try {
                const res = await fetch('/api/trades');
                const trades: Trade[] = await res.json();

                if (Array.isArray(trades)) {
                    // Sort by time ascending
                    const sortedTrades = trades.sort((a, b) => a.entryTime - b.entryTime);

                    let cumulativePnL = 0;
                    const chartData = sortedTrades.map(t => {
                        cumulativePnL += t.pnl || 0;
                        return {
                            name: new Date(t.entryTime * 1000).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' }),
                            value: cumulativePnL
                        };
                    });

                    // If no trades, show empty state or starting point
                    if (chartData.length === 0) {
                        setData([{ name: 'Start', value: 0 }]);
                    } else {
                        setData(chartData);
                    }
                }
            } catch (error) {
                console.error("Failed to fetch trades for equity curve", error);
            }
        };

        fetchTrades();
    }, []);

    return (
        <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                    data={data}
                    margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
                >
                    <defs>
                        <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                    <XAxis
                        dataKey="name"
                        stroke="#64748b"
                        fontSize={12}
                        tickLine={false}
                        axisLine={false}
                    />
                    <YAxis
                        stroke="#64748b"
                        fontSize={12}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(value) => `$${value}`}
                    />
                    <Tooltip
                        contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#f8fafc' }}
                        itemStyle={{ color: '#10b981' }}
                        formatter={(value: number) => [`$${value.toLocaleString()}`, 'P&L']}
                    />
                    <Area
                        type="monotone"
                        dataKey="value"
                        stroke="#10b981"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#colorValue)"
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
}
