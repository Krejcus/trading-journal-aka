export interface ScrapedData {
    success: boolean;
    symbol: string;
    data: {
        risk?: number | null;
        entry?: number | null;
        tp?: number | null;
        sl?: number | null;
        direction?: 'LONG' | 'SHORT';
    };
    trace: string[];
}

export function scrapeTradingView(): ScrapedData {
    // Extract symbol: on FX Replay the page title starts with "FX", so we look inside iframes
    let rawSymbol = '';
    
    if (window.location.hostname.includes('fxreplay.com')) {
        // Try to get a proper ticker from the TradingView iframe
        try {
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of Array.from(iframes)) {
                const doc = iframe.contentDocument;
                if (!doc) continue;
                // Look for TV's symbol element inside the iframe
                const symbolEl = doc.querySelector('.chart-widget-header__symbol, [class*="symbol"], [class*="ticker"]');
                if (symbolEl && symbolEl.textContent) {
                    rawSymbol = symbolEl.textContent.trim().split(' ')[0].replace(/[^a-zA-Z0-9!]/g, '');
                    break;
                }
                // Fallback: parse iframe's page title (first segment before " · " or space)
                if (doc.title && !doc.title.toLowerCase().includes('tradingview') && !doc.title.toLowerCase().includes('fx replay')) {
                    const fromTitle = doc.title.split(' · ')[0].split(' - ')[0].split(' ')[0];
                    if (fromTitle && fromTitle.length > 1) {
                        rawSymbol = fromTitle.replace(/[^a-zA-Z0-9!]/g, '');
                        break;
                    }
                }
            }
        } catch (e) { /* Ignore CORS */ }
        // If nothing found, keep rawSymbol as '' so TradeForm keeps the user's current value
    } else {
        rawSymbol = document.title.split(' ')[0] || 'Unknown';
    }

    const result: ScrapedData = {
        success: false,
        symbol: rawSymbol.replace(/[^a-zA-Z0-9!]/g, ''),
        data: {},
        trace: []
    };

    try {
        const allNodes: Element[] = [];
        const queue: Element[] = [document.body];
        let processedCount = 0;
        const maxNodes = 4000;

        while (queue.length > 0 && processedCount < maxNodes) {
            const node = queue.shift();
            if (!node || node.id === 'alpha-bridge-v2-host') continue;

            if (node.nodeType === 1) {
                processedCount++;
                allNodes.push(node);

                if (node.shadowRoot) {
                    for (const child of Array.from(node.shadowRoot.children)) queue.push(child);
                }

                if (node.tagName === 'IFRAME') {
                    try {
                        const iframeDoc = (node as HTMLIFrameElement).contentDocument;
                        if (iframeDoc && iframeDoc.body) {
                            queue.push(iframeDoc.body);
                        }
                    } catch (e) {
                        // Ignore CORS issues with cross-origin iframes
                    }
                }

                if (node.children) {
                    for (const child of Array.from(node.children)) queue.push(child);
                }
            }
        }

        const elementsWithText = allNodes.filter(el => (el as HTMLElement).innerText && (el as HTMLElement).innerText.length < 50);
        const inputs = allNodes.filter(el => el.tagName === 'INPUT' && ((el as HTMLInputElement).type === 'text' || (el as HTMLInputElement).type === 'number')) as HTMLInputElement[];

            const findValueWithContext = (labelKeywords: string[], contextKeywords: string[] = []): number | null => {
                for (const labelEl of elementsWithText) {
                    const txt = (labelEl as HTMLElement).innerText.toLowerCase().trim();
                    // Zpřesněné hledání labelů
                    if (!labelKeywords.some(kw => txt === kw || txt === kw + ":" || txt.startsWith(kw))) continue;

                    const labelRect = labelEl.getBoundingClientRect();
                    if (labelRect.height === 0) continue;

                    if (contextKeywords.length > 0) {
                        const headerContext = elementsWithText.filter(el => {
                            const r = el.getBoundingClientRect();
                            return r.bottom < labelRect.top && r.bottom > labelRect.top - 150 &&
                                Math.abs(r.left - labelRect.left) < 150;
                        });
                        const combinedContext = headerContext.map(h => (h as HTMLElement).innerText.toLowerCase()).join(" ");
                        if (!contextKeywords.some(kw => combinedContext.includes(kw))) continue;
                    }

                    // Hledání nejbližšího inputu - FX Replay & TV layout
                    const nearbyInputs = inputs.filter(inp => {
                        const inpRect = inp.getBoundingClientRect();
                        const labelCenter = labelRect.top + labelRect.height / 2;
                        const inpCenter = inpRect.top + inpRect.height / 2;
                        
                        // Extrémně zpřísněná vertikální tolerance na úroveň stejného řádku
                        return Math.abs(labelCenter - inpCenter) < 15 &&
                            inpRect.left > labelRect.left - 20 &&
                            inpRect.left < labelRect.left + 500;
                    });
                    
                    // Seřadit lokální inputy zleva doprava
                    nearbyInputs.sort((a,b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

                    if (nearbyInputs.length > 0 && nearbyInputs[0].value) {
                        const val = nearbyInputs[0].value.trim().replace(/,/g, '').replace(/!/g, ''); // Fix FX Replay format e.g. "22,232.2!"
                        const parsed = parseFloat(val);
                        if (!isNaN(parsed)) return parsed;
                    }
                }
                return null;
            };

            // Extrakce hodnot primárně podle přesných, unikátních TV/FXR textů
            result.data.risk = findValueWithContext(["risk", "riziko", "risk in %"]) || findValueWithContext(["risk", "riziko"], ["account", "účet"]);
            result.data.entry = findValueWithContext(["entry price", "vstupní cena", "entry", "vstup"]);
            // FX Replay = "Price" under "Profit level" / TV = "Price" next to "Profit"
            result.data.tp = findValueWithContext(["price", "cena"], ["profit level", "profit", "zisk", "target", "cíl"]);
            // FX Replay = "Price" under "Stop level" / TV = "Price" next to "Stop"
            result.data.sl = findValueWithContext(["price", "cena"], ["stop level", "stop", "ztráta", "loss"]);

        const directionHeader = elementsWithText.find(el => {
            const t = (el as HTMLElement).innerText.toLowerCase();
            return t.includes("long position") || t.includes("short position") || t.includes("dlouhá pozice") || t.includes("krátká pozice");
        });

        if (directionHeader) {
            const t = (directionHeader as HTMLElement).innerText.toLowerCase();
            result.data.direction = (t.includes("short") || t.includes("krátká")) ? "SHORT" : "LONG";
        } else {
            // Backup search for FX Replay which might not have "Position" in the UI header but just LONG/SHORT buttons
            const fullText = document.body.innerText.toLowerCase();
            result.data.direction = (fullText.includes("short position") || fullText.includes("krátká pozice") || document.querySelector('.tv-dialog__section--title')?.textContent?.toLowerCase().includes("short")) ? "SHORT" : "LONG";
        }

        if (result.data.risk) result.trace.push(`R:${result.data.risk}`);
        if (result.data.entry) result.trace.push(`E:${result.data.entry}`);
        if (result.data.sl) result.trace.push(`SL:${result.data.sl}`);
        if (result.data.tp) result.trace.push(`TP:${result.data.tp}`);

        result.success = result.trace.length > 0;
    } catch (e) {
        console.error("Alpha Bridge Scraper Error:", e);
    }

    return result;
}
