import { useSyncExternalStore } from 'react';
import { useCompactViewport } from '../utils/useCompactViewport';
export type LiveLayout = 'mobile' | 'full';
export const LIVE_LAYOUT_KEY = 'alphatrade_live_layout_device_v1';
const eventName = 'alphatrade:live-layout';
let transientLayout: LiveLayout = 'mobile';
export const readLiveLayout = (): LiveLayout => {
  try { const stored = localStorage.getItem(LIVE_LAYOUT_KEY); return stored === 'full' ? 'full' : stored === 'mobile' ? 'mobile' : transientLayout; } catch { return transientLayout; }
};
export const setLiveLayout = (value: LiveLayout) => {
  transientLayout = value;
  try { localStorage.setItem(LIVE_LAYOUT_KEY, value); } catch { /* Storage may be unavailable in private mode. */ }
  window.dispatchEvent(new Event(eventName));
};
const subscribe = (listener: () => void) => {
  window.addEventListener('storage', listener);
  window.addEventListener(eventName, listener);
  return () => { window.removeEventListener('storage', listener); window.removeEventListener(eventName, listener); };
};
export function useLiveLayout() {
  const narrow = useCompactViewport();
  const layout = useSyncExternalStore(subscribe, readLiveLayout, () => 'mobile' as const);
  return { narrow, layout, compact: narrow && layout === 'mobile', setLayout: setLiveLayout };
}
