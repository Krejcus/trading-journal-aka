export type TradovateLiveTab = 'connections' | 'overview' | 'accounts' | 'orders' | 'events';

const LIVE_TABS = new Set<TradovateLiveTab>([
  'connections',
  'overview',
  'accounts',
  'orders',
  'events',
]);

export const tradovateLiveTabFromSearch = (search: string): TradovateLiveTab => {
  const params = new URLSearchParams(search);
  if (params.get('open') === 'mac-companion-pairing') return 'connections';

  const requestedTab = params.get('tab');
  return requestedTab && LIVE_TABS.has(requestedTab as TradovateLiveTab)
    ? requestedTab as TradovateLiveTab
    : 'overview';
};
