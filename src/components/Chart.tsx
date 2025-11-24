"use client";

import { useEffect, useRef, memo } from 'react';

function ChartComponent() {
    const container = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!container.current) return;

        const script = document.createElement("script");
        script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
        script.type = "text/javascript";
        script.async = true;
        script.innerHTML = `
      {
        "autosize": true,
        "symbol": "CME_MINI:NQ1!",
        "interval": "15",
        "timezone": "Etc/UTC",
        "theme": "dark",
        "style": "1",
        "locale": "en",
        "enable_publishing": false,
        "backgroundColor": "rgba(15, 23, 42, 1)",
        "gridColor": "rgba(30, 41, 59, 1)",
        "hide_top_toolbar": false,
        "hide_legend": false,
        "save_image": false,
        "calendar": false,
        "hide_volume": true,
        "support_host": "https://www.tradingview.com"
      }`;

        // Clear previous content to prevent duplicates
        container.current.innerHTML = "";
        container.current.appendChild(script);
    }, []);

    return (
        <div className="h-[500px] w-full" ref={container}>
            <div className="tradingview-widget-container" style={{ height: "100%", width: "100%" }}>
                <div className="tradingview-widget-container__widget" style={{ height: "calc(100% - 32px)", width: "100%" }}></div>
            </div>
        </div>
    );
}

export default memo(ChartComponent);
