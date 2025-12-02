"use client";

import { createContext, useContext, useState, ReactNode } from "react";

interface DashboardContextType {
    selectedAccountId: string | null; // null = All Accounts
    setSelectedAccountId: (id: string | null) => void;
}

const DashboardContext = createContext<DashboardContextType | undefined>(undefined);

export function DashboardProvider({ children }: { children: ReactNode }) {
    const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

    return (
        <DashboardContext.Provider value={{ selectedAccountId, setSelectedAccountId }}>
            {children}
        </DashboardContext.Provider>
    );
}

export function useDashboard() {
    const context = useContext(DashboardContext);
    if (context === undefined) {
        throw new Error("useDashboard must be used within a DashboardProvider");
    }
    return context;
}
