const APP_STORAGE_PREFIXES = [
  'alphatrade_',
  'trader_',
  'tradovate-',
  'tradesyncer-',
  'active_coach_session',
  'daily-focus-',
];

/** Remove only AlphaTrade-owned browser data; never erase unrelated origin storage. */
export function clearAppStorage(): void {
  const keysToRemove: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key && APP_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix))) keysToRemove.push(key);
  }
  keysToRemove.forEach(key => localStorage.removeItem(key));
}
