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
    const result: ScrapedData = {
        success: false,
        symbol: (document.title.split(' ')[0] || "Unknown").replace(/[^a-zA-Z0-9!]/g, ''),
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

                if (node.children) {
                    for (const child of Array.from(node.children)) queue.push(child);
                }
            }
        }

        const elementsWithText = allNodes.filter(el => (el as HTMLElement).innerText && (el as HTMLElement).innerText.length < 50);
        const inputs = allNodes.filter(el => el.tagName === 'INPUT' && ((el as HTMLInputElement).type === 'text' || (el as HTMLInputElement).type === 'number')) as HTMLInputElement[];

        const findValueWithContext = (labelKeywords: string[], contextKeywords: string[] = []): number | null => {
            for (const labelEl of elementsWithText) {
                const txt = (labelEl as HTMLElement).innerText.toLowerCase();
                if (!labelKeywords.some(kw => txt.includes(kw))) continue;

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

                const nearbyInput = inputs.find(inp => {
                    const inpRect = inp.getBoundingClientRect();
                    return Math.abs(labelRect.top - inpRect.top) < 30 &&
                        inpRect.left > labelRect.left &&
                        inpRect.left < labelRect.left + 350;
                });

                if (nearbyInput && nearbyInput.value) {
                    const val = nearbyInput.value.trim().replace(',', '.');
                    const parsed = parseFloat(val);
                    if (!isNaN(parsed)) return parsed;
                }
            }
            return null;
        };

        result.data.risk = findValueWithContext(["risk", "riziko"], ["account", "účet"]);
        result.data.entry = findValueWithContext(["entry", "vstup", "vstupní"]);
        result.data.tp = findValueWithContext(["price", "cena"], ["profit", "zisk", "target", "cíl"]);
        result.data.sl = findValueWithContext(["price", "cena"], ["stop", "ztráta", "loss"]);

        const directionHeader = elementsWithText.find(el => {
            const t = (el as HTMLElement).innerText.toLowerCase();
            return t.includes("long position") || t.includes("short position") || t.includes("dlouhá pozice") || t.includes("krátká pozice");
        });

        if (directionHeader) {
            const t = (directionHeader as HTMLElement).innerText.toLowerCase();
            result.data.direction = (t.includes("short") || t.includes("krátká")) ? "SHORT" : "LONG";
        } else {
            const fullText = document.body.innerText.toLowerCase();
            result.data.direction = (fullText.includes("short position") || fullText.includes("krátká pozice")) ? "SHORT" : "LONG";
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
