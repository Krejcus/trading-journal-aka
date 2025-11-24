"use client";

import { useState, useEffect } from "react";
import { Responsive, WidthProvider } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { debounce } from "lodash";

const ResponsiveGridLayout = WidthProvider(Responsive);

interface DashboardGridProps {
    children: React.ReactNode[];
}

const defaultLayouts = {
    lg: [
        { i: "balance", x: 0, y: 0, w: 3, h: 4 },
        { i: "pnl", x: 3, y: 0, w: 3, h: 4 },
        { i: "winrate", x: 6, y: 0, w: 3, h: 4 },
        { i: "quick-stats", x: 9, y: 0, w: 3, h: 4 },
        { i: "equity", x: 0, y: 4, w: 6, h: 8 },
        { i: "calendar", x: 6, y: 4, w: 3, h: 8 },
        { i: "active-position", x: 9, y: 4, w: 3, h: 14 },
        { i: "trades", x: 0, y: 12, w: 9, h: 6 },
    ],
};

export default function DashboardGrid({ children }: DashboardGridProps) {
    const [layouts, setLayouts] = useState(defaultLayouts);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        const savedLayouts = localStorage.getItem("dashboardLayouts");
        if (savedLayouts) {
            try {
                setLayouts(JSON.parse(savedLayouts));
            } catch (e) {
                console.error("Failed to parse layouts", e);
            }
        }
    }, []);

    const handleLayoutChange = (layout: any, layouts: any) => {
        setLayouts(layouts);
        saveLayouts(layouts);
    };

    const saveLayouts = debounce((layouts: any) => {
        localStorage.setItem("dashboardLayouts", JSON.stringify(layouts));
    }, 1000);

    if (!mounted) return null;

    return (
        <ResponsiveGridLayout
            className="layout"
            layouts={layouts}
            breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
            cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
            rowHeight={30}
            draggableHandle=".drag-handle"
            onLayoutChange={handleLayoutChange}
            isDraggable={true}
            isResizable={true}
            margin={[24, 24]}
        >
            {children}
        </ResponsiveGridLayout>
    );
}
