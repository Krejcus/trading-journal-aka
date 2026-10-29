/** `chart` = živý graf přes celou obrazovku (jen desktop, výchozí po kliku na LIVE). */
export type TradovateLiveTab = 'chart' | 'connections' | 'overview' | 'risk' | 'accounts' | 'orders' | 'events';

const LIVE_TABS = new Set<TradovateLiveTab>([
  'chart',
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

/**
 * Smí se teď přepnout záložka LIVE? Při čekající změně konfigurace desk
 * záložky drží — kromě odchodu z grafu na přehled: DISARM a kill musí být
 * dosažitelné vždy (INV-UI-02). Do grafu se nevstupuje během zapínání
 * kopírky, jeho vrstva by zakryla potvrzovací dialogy i přehled.
 */
export const liveTabNavigationAllowed = (
  current: TradovateLiveTab,
  next: TradovateLiveTab,
  state: { configMutationPending: boolean; armFlowActive: boolean },
): boolean => {
  if (current === 'chart' && next === 'overview') return true;
  if (next === 'chart' && (state.armFlowActive || state.configMutationPending)) return false;
  return !state.configMutationPending;
};

/**
 * Záložka při otevření LIVE: deep link (`requestedTab`) má přednost, na
 * desktopu pak graf (Filip 29. 10.: klik na LIVE = rovnou graf), jinak
 * záložka z adresy, výchozí přehled. Telefon a nativní aplikace graf nemají.
 */
export const initialLiveTab = (input: {
  requestedTab: TradovateLiveTab | null;
  search: string;
  chartAvailable: boolean;
}): TradovateLiveTab => {
  if (input.requestedTab && (input.requestedTab !== 'chart' || input.chartAvailable)) return input.requestedTab;
  if (input.chartAvailable) return 'chart';
  const fromSearch = tradovateLiveTabFromSearch(input.search);
  return fromSearch === 'chart' ? 'overview' : fromSearch;
};
