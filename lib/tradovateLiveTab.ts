export type TradovateLiveTab = 'connections' | 'overview' | 'risk' | 'accounts' | 'orders' | 'events';

const LIVE_TABS = new Set<TradovateLiveTab>([
  'connections',
  'overview',
  'risk',
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

export const tradovateLiveTabHref = (currentHref: string, tab: TradovateLiveTab): string => {
  const url = new URL(currentHref);
  url.searchParams.set('page', 'live');
  url.searchParams.set('tab', tab);
  return `${url.pathname}${url.search}${url.hash}`;
};
