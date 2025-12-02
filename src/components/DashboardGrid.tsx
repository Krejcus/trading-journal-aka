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
        { i: "equity", x: 0, y: 4, w: 8, h: 8 },
        { i: "calendar", x: 8, y: 4, w: 4, h: 8 },
        { i: "trades", x: 0, y: 12, w: 12, h: 6 },
    ],
    xxs: [
        { i: "balance", x: 0, y: 0, w: 1, h: 4 },
        { i: "pnl", x: 0, y: 4, w: 1, h: 4 },
        { i: "winrate", x: 0, y: 8, w: 1, h: 4 },
        { i: "quick-stats", x: 0, y: 12, w: 1, h: 4 },
        { i: "equity", x: 0, y: 16, w: 1, h: 8 },
        { i: "calendar", x: 0, y: 24, w: 1, h: 8 },
        { i: "trades", x: 0, y: 32, w: 1, h: 8 },
    ]
};

export default function DashboardGrid({ children }: DashboardGridProps) {
    const [layouts, setLayouts] = useState(defaultLayouts);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        const savedLayouts = localStorage.getItem("dashboardLayouts");
        if (savedLayouts) {
            try {
                // Merge saved layouts with default mobile layouts if missing
                const parsed = JSON.parse(savedLayouts);
                if (!parsed.xxs) parsed.xxs = defaultLayouts.xxs;
                setLayouts(parsed);
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
            cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 1 }}
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
