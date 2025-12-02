"use client";

import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import { useState } from "react";
import { DashboardProvider } from "./DashboardContext";

interface DashboardLayoutProps {
    children: React.ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);

    return (
        <DashboardProvider>
            <div className="flex h-screen bg-slate-950 text-slate-200 font-sans">
                <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
                <div className="flex flex-1 flex-col overflow-hidden">
                    <Topbar onMenuClick={() => setIsSidebarOpen(true)} />
                    <main className="flex-1 overflow-y-auto bg-slate-950">
                        {children}
                    </main>
                </div>
            </div>
        </DashboardProvider>
    );
}
