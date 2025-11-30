"use client";

import { LayoutDashboard, History, Settings, LineChart, ChevronLeft, ChevronRight, Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const navItems = [
    { name: "Přehled", href: "/", icon: LayoutDashboard },
    { name: "Historie", href: "/history", icon: History },
    { name: "Analytika", href: "/analytics", icon: LineChart },
    { name: "Nastavení", href: "/settings", icon: Settings },
];

interface SidebarProps {
    isOpen?: boolean;
    onClose?: () => void;
}

export default function Sidebar({ isOpen = false, onClose }: SidebarProps) {
    const pathname = usePathname();
    const [isCollapsed, setIsCollapsed] = useState(false);

    return (
        <>
            {/* Mobile Backdrop */}
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/50 z-40 lg:hidden backdrop-blur-sm"
                    onClick={onClose}
                />
            )}

            {/* Sidebar Container */}
            <div className={`
                fixed inset-y-0 left-0 z-50 bg-slate-900 border-r border-slate-800 transition-transform duration-300 lg:translate-x-0 lg:static lg:h-screen lg:flex lg:flex-col
                ${isOpen ? "translate-x-0" : "-translate-x-full"}
                ${isCollapsed ? "w-20" : "w-64"}
            `}>
                <div className={`flex h-16 items-center border-b border-slate-800 px-4 ${isCollapsed ? "justify-center" : "justify-between"}`}>
                    {!isCollapsed && (
                        <h1 className="text-xl font-bold text-emerald-400 tracking-wider">TRADER<span className="text-white">PRO</span></h1>
                    )}
                    <button
                        onClick={() => setIsCollapsed(!isCollapsed)}
                        className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-colors hidden lg:block"
                    >
                        {isCollapsed ? <Menu className="w-6 h-6" /> : <ChevronLeft className="w-5 h-5" />}
                    </button>
                    {/* Mobile Close Button */}
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-colors lg:hidden ml-auto"
                    >
                        <ChevronLeft className="w-6 h-6" />
                    </button>
                </div>

                <nav className="flex-1 space-y-1 px-2 py-4">
                    {navItems.map((item) => {
                        const isActive = pathname === item.href;
                        return (
                            <Link
                                key={item.name}
                                href={item.href}
                                onClick={() => onClose && onClose()} // Close on mobile nav
                                className={`group flex items-center rounded-md px-2 py-2 text-sm font-medium transition-colors ${isActive
                                    ? "bg-slate-800 text-emerald-400"
                                    : "text-slate-400 hover:bg-slate-800 hover:text-white"
                                    } ${isCollapsed ? "justify-center" : ""}`}
                                title={isCollapsed ? item.name : ""}
                            >
                                <item.icon
                                    className={`h-5 w-5 flex-shrink-0 ${isActive ? "text-emerald-400" : "text-slate-400 group-hover:text-white"} ${!isCollapsed ? "mr-3" : ""}`}
                                />
                                {!isCollapsed && item.name}
                            </Link>
                        );
                    })}
                </nav>

                <div className="p-4 border-t border-slate-800">
                    <div className={`flex items-center ${isCollapsed ? "justify-center" : ""}`}>
                        <div className="h-8 w-8 rounded-full bg-emerald-500 flex items-center justify-center text-slate-900 font-bold shrink-0">
                            FK
                        </div>
                        {!isCollapsed && (
                            <div className="ml-3 overflow-hidden">
                                <p className="text-sm font-medium text-white truncate">Filip Krejca</p>
                                <p className="text-xs text-slate-500 truncate">Pro Trader</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}
