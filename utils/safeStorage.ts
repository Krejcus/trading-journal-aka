/**
 * Safe LocalStorage helper — zabrání pádu appky při:
 *   - QuotaExceededError (kvóta plná, např. po nahrání velkých obrázků)
 *   - Safari Private Mode (starší verze házely výjimky)
 *   - jiné prohlížečové výjimky (cookies blocked, sandbox apod.)
 *
 * Při quota exceeded: pokusí se uvolnit místo evikcí největšího cached klíče
 * (`alphatrade_*` prefix) a retry-ne jednou. Pokud i poté selže, jen logne,
 * nepropíská chybu nahoru — appka pokračuje.
 */
export function safeSetItem(key: string, value: any): void {
    try {
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
        localStorage.setItem(key, stringValue);
    } catch (e: any) {
        if (e?.name === 'QuotaExceededError' || e?.code === 22) {
            console.warn(`[safeStorage] Kvóta plná pro klíč: ${key}. Evikuji největší cache…`);
            try {
                // Najdi největší alphatrade_ klíč (kromě toho co se snažíme uložit)
                let largestKey: string | null = null;
                let largestSize = 0;
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (!k || k === key || !k.startsWith('alphatrade_')) continue;
                    const len = (localStorage.getItem(k) || '').length;
                    if (len > largestSize) { largestSize = len; largestKey = k; }
                }
                if (largestKey) {
                    localStorage.removeItem(largestKey);
                    console.warn(`[safeStorage] Evikuvón ${largestKey} (${(largestSize / 1024).toFixed(1)} KB)`);
                    // Retry jednou
                    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
                    localStorage.setItem(key, stringValue);
                }
            } catch (retryErr) {
                console.error(`[safeStorage] Stále selhalo po evikci, vzdávám to:`, retryErr);
            }
        } else {
            // Jiná chyba (Safari Private Mode, sandbox, cookies blocked) — jen log
            console.warn(`[safeStorage] Nelze zapsat do localStorage (${key}):`, e?.message || e);
        }
    }
}

/**
 * Safe LocalStorage čtení — vrátí null místo throw při výjimce.
 */
export function safeGetItem(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch (e: any) {
        console.warn(`[safeStorage] Nelze přečíst z localStorage (${key}):`, e?.message || e);
        return null;
    }
}

/**
 * Safe LocalStorage smazání — vrátí false místo throw při výjimce.
 */
export function safeRemoveItem(key: string): boolean {
    try {
        localStorage.removeItem(key);
        return true;
    } catch (e: any) {
        console.warn(`[safeStorage] Nelze smazat z localStorage (${key}):`, e?.message || e);
        return false;
    }
}
