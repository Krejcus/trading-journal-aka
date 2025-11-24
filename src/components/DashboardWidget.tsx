"use client";

import { ReactNode } from "react";

interface DashboardWidgetProps {
    title?: string;
    children: ReactNode;
    className?: string;
    headerAction?: ReactNode;
}

export default function DashboardWidget({ title, children, className = "", headerAction }: DashboardWidgetProps) {
    return (
        <div className={`bg-slate-900 border border-slate-800 rounded-xl flex flex-col h-full overflow-hidden relative ${className}`}>
            {(title || headerAction) && (
                <div className="flex justify-between items-center p-4 pb-2 shrink-0">
                    {title && <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">{title}</h3>}
                    <div className="flex items-center gap-2">
                        {headerAction}
                        <div className="drag-handle cursor-move p-1 hover:bg-slate-800 rounded text-slate-500 transition-colors">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="9" cy="9" r="1" />
                                <circle cx="9" cy="15" r="1" />
                                <circle cx="15" cy="9" r="1" />
                                <circle cx="15" cy="15" r="1" />
                            </svg>
                        </div>
                    </div>
                </div>
            )}
            <div className="flex-1 min-h-0 relative">
                {children}
            </div>
        </div>
    );
}
