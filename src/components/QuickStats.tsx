"use client";

export default function QuickStats() {
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
                    <span className="text-slate-300">Avg R:R</span>
                    <span className="text-white font-mono">1:2.5</span>
                </div>
                <div className="flex justify-between items-center">
                    <span className="text-slate-300">Profit Factor</span>
                    <span className="text-emerald-400 font-mono">2.1</span>
                </div>
                <div className="flex justify-between items-center">
                    <span className="text-slate-300">Max Drawdown</span>
                    <span className="text-rose-400 font-mono">-1.2%</span>
                </div>
            </div>
        </div>
    );
}
