"use client";

import { Bell, Search } from "lucide-react";

export default function Topbar() {
    return (
        <div className="flex h-16 items-center justify-between border-b border-slate-800 bg-slate-900 px-6">
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
                    <span className="text-lg font-bold text-white">$50,240.00</span>
                </div>
                <div className="relative">
                    <button className="rounded-full bg-slate-800 p-2 text-slate-400 hover:text-white">
                        <Bell className="h-5 w-5" />
                        <span className="absolute top-0 right-0 h-2 w-2 rounded-full bg-red-500"></span>
                    </button>
                </div>
            </div>
        </div>
    );
}
