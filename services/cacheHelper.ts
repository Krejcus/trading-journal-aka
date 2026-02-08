import { get, set } from 'idb-keyval';
import type { Trade } from '../types';
import { getUserId } from './storageService';

// Helper function to add a new trade to IndexedDB cache
// This is used by real-time sync to ensure cache stays consistent
export async function addTradeToCache(trade: Trade): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;

    const localKey = `alphatrade_trades_${userId}`;
    const cachedTrades: Trade[] = await get(localKey) || [];

    // Check if trade already exists
    const existsIndex = cachedTrades.findIndex(t => t.id === trade.id);

    if (existsIndex >= 0) {
        // Update existing
        cachedTrades[existsIndex] = trade;
        console.log(`[Cache] Updated trade ${trade.id} in IndexedDB cache`);
    } else {
        // Add new at beginning (newest first)
        cachedTrades.unshift(trade);
        console.log(`[Cache] Added trade ${trade.id} to IndexedDB cache`);
    }

    await set(localKey, cachedTrades);
}
